// Shadow mode (spec §10.9, D-60): which eligibility logic decides, and which one
// is being tried beside it.
//
// ENGINES lists every engine version this release ships. The database
// (eligibility_logic_versions) says which one is ACTIVE — its results are stored,
// shown and acted on — and which one, if any, is in SHADOW. A release that adds a
// new version puts it in SHADOW (syncLogicVersions, at start-up): from then on
// every stored evaluation (refreshEligibility) runs both, and each disagreement
// is kept in eligibility_shadow_log. The shadow result is never shown, stored or
// acted on. The new version can be promoted only after 7 days in shadow with no
// disagreement, or once HR has approved every disagreement (promotionState).
//
// Adding a version: write the engine (same contract as engine.ts `evaluate`,
// returning its own logicVersion) and add it to ENGINES. Nothing else.

import { appendAudit } from '../../lib/audit.js';
import { riyadhDate } from '../../lib/dates.js';
import { describeError, logger, type LogFields } from '../../lib/logger.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { ENGINE_LOGIC_VERSION, evaluate, type EngineFacts, type EngineInput, type EngineResult } from './engine.js';

export type Engine = (facts: EngineFacts, input: EngineInput) => EngineResult;

/** Every engine version this release ships, by logic version. */
export const ENGINES = new Map<number, Engine>([[ENGINE_LOGIC_VERSION, evaluate]]);

/** Spec §10.9: a version with no disagreement is promotable after this many days in shadow. */
export const SHADOW_MIN_DAYS = 7;

export interface Logic {
  version: number;
  engine: Engine;
  shadow: { version: number; engine: Engine } | null;
}

const warned = new Set<string>();
const warnOnce = (key: string, msg: string, fields: LogFields) => {
  if (warned.has(key)) return;
  warned.add(key);
  logger.error(msg, fields);
};

/**
 * The ACTIVE logic and the SHADOW one, as this release can run them. If the
 * database names an ACTIVE version this release does not ship (a release rolled
 * back after a promotion), the most recently promoted version it does ship
 * decides, and the error is logged; a SHADOW version not shipped is not run.
 */
export async function currentLogic(tx: DbClient): Promise<Logic> {
  const rows = await tx.eligibilityLogicVersion.findMany({ where: { status: { in: ['ACTIVE', 'SHADOW'] } }, select: { version: true, status: true } });
  const wanted = rows.find((r) => r.status === 'ACTIVE')?.version ?? ENGINE_LOGIC_VERSION;
  let version = wanted;
  if (!ENGINES.has(wanted)) {
    // The last version that was ACTIVE and that this release still ships — never an unpromoted candidate.
    const promoted = await tx.eligibilityLogicVersion.findMany({ where: { promotedAt: { not: null } }, orderBy: { promotedAt: 'desc' }, select: { version: true } });
    version = promoted.find((p) => ENGINES.has(p.version))?.version ?? ENGINE_LOGIC_VERSION;
    warnOnce(`active:${wanted}`, 'eligibility logic: the ACTIVE version is not in this release; the last promoted one it ships decides', { active: wanted, using: version });
  }
  const s = rows.find((r) => r.status === 'SHADOW')?.version;
  const shadowEngine = s !== undefined && s !== version ? ENGINES.get(s) : undefined;
  return { version, engine: ENGINES.get(version)!, shadow: shadowEngine ? { version: s!, engine: shadowEngine } : null };
}

/**
 * Runs the SHADOW logic on the same facts and keeps a disagreement (spec §10.9).
 * Never changes the outcome: a failing shadow engine is itself a finding (ERROR).
 */
export async function compareShadow(
  tx: DbClient, logic: Logic, employeeId: number, facts: EngineFacts, input: EngineInput, active: EngineResult, event: string,
) {
  if (!logic.shadow) return;
  let candidate: { status: string; reasons: unknown[] };
  try {
    const r = logic.shadow.engine(facts, input);
    candidate = { status: r.status, reasons: r.reasons };
  } catch (e) {
    logger.error('eligibility logic: the shadow version failed', { version: logic.shadow.version, employeeId, ...describeError(e) });
    candidate = { status: 'ERROR', reasons: [{ code: 'ENGINE_ERROR', message: (e as Error).message ?? String(e) }] };
  }
  if (candidate.status === active.status) return;
  await tx.eligibilityShadowLog.createMany({
    data: [{
      logicVersion: logic.shadow.version, employeeId, evalDate: input.date, activeVersion: logic.version,
      activeStatus: active.status, candidateStatus: candidate.status,
      activeReasons: active.reasons as object[], candidateReasons: candidate.reasons as object[], event,
    }],
    skipDuplicates: true, // one finding per version, nurse, day and pair of outcomes
  });
}

/**
 * Makes the table match what this release ships (run at start-up by the API and
 * the worker). A shipped version newer than the ACTIVE one with no row yet
 * starts in SHADOW, replacing an older SHADOW version; an older one is recorded
 * RETIRED. Safe to run concurrently and repeatedly.
 */
export async function syncLogicVersions(db: Db, now = new Date()) {
  const added: Array<{ version: number; status: string }> = [];
  for (const version of [...ENGINES.keys()].sort((a, b) => a - b)) {
    try {
      await db.$transaction(async (tx) => {
        if (await tx.eligibilityLogicVersion.findUnique({ where: { version } })) return;
        const active = await tx.eligibilityLogicVersion.findFirst({ where: { status: 'ACTIVE' } });
        const status = !active ? 'ACTIVE' : version > active.version ? 'SHADOW' : 'RETIRED';
        if (status === 'SHADOW') {
          const old = await tx.eligibilityLogicVersion.updateMany({ where: { status: 'SHADOW' }, data: { status: 'RETIRED', retiredAt: now, note: `Superseded by version ${version}` } });
          if (old.count > 0) logger.warn('eligibility logic: a newer version replaces the one in shadow', { version });
        }
        await tx.eligibilityLogicVersion.create({
          data: { version, status, shadowSince: status === 'SHADOW' ? now : null, promotedAt: status === 'ACTIVE' ? now : null, retiredAt: status === 'RETIRED' ? now : null },
        });
        await appendAudit(tx, { actorUserId: null, action: 'ELIGIBILITY_LOGIC_REGISTERED', resource: 'eligibility_logic', resourceId: String(version), changes: { status }, priority: 'HIGH' });
        added.push({ version, status });
      });
    } catch (e) {
      // Another process registered it first (unique version, one SHADOW): nothing to do.
      if (!(await db.eligibilityLogicVersion.findUnique({ where: { version } }))) throw e;
    }
  }
  for (const a of added) logger.info('eligibility logic registered', a);
  return added;
}

export interface PromotionState {
  daysInShadow: number;
  findings: number;
  undecided: number;
  approved: number;
  rejected: number;
  errors: number;
  promotable: boolean;
  /** Why not, in words, when it is not promotable. */
  blocker: string | null;
}

/** Spec §10.9 promotion criteria for a version in SHADOW. */
export async function promotionState(tx: DbClient, version: number, now = new Date()): Promise<PromotionState> {
  const row = await tx.eligibilityLogicVersion.findUnique({ where: { version } });
  const groups = await tx.eligibilityShadowLog.groupBy({ by: ['decision'], where: { logicVersion: version }, _count: { _all: true } });
  const count = (d: string | null) => groups.find((g) => g.decision === d)?._count._all ?? 0;
  const errors = await tx.eligibilityShadowLog.count({ where: { logicVersion: version, candidateStatus: 'ERROR' } });
  const [undecided, approved, rejected] = [count(null), count('APPROVED'), count('REJECTED')];
  const findings = undecided + approved + rejected;
  const daysInShadow = row?.shadowSince ? Math.floor((now.getTime() - row.shadowSince.getTime()) / 86_400_000) : 0;
  let blocker: string | null = null;
  if (row?.status !== 'SHADOW') blocker = 'This version is not in shadow';
  else if (rejected > 0) blocker = `${rejected} disagreement(s) were rejected: this version cannot be promoted — retire it`;
  else if (errors > 0) blocker = `The new logic failed on ${errors} evaluation(s): it cannot be promoted — retire it`;
  else if (undecided > 0) blocker = `${undecided} disagreement(s) still need an HR decision`;
  else if (findings === 0 && daysInShadow < SHADOW_MIN_DAYS) blocker = `No disagreement so far; promotable after ${SHADOW_MIN_DAYS} days in shadow (day ${daysInShadow})`;
  return { daysInShadow, findings, undecided, approved, rejected, errors, promotable: blocker === null, blocker };
}

/** After a promotion: every live nurse's stored state is recalculated under the new logic. */
export async function reevaluateAll(db: Db, refresh: (tx: DbClient, employeeId: number) => Promise<unknown>) {
  const nurses = await db.employee.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' } });
  let done = 0;
  let failed = 0;
  for (const n of nurses) {
    try {
      await db.$transaction((tx) => refresh(tx, n.id));
      done++;
    } catch (e) {
      failed++;
      logger.error('eligibility re-evaluation after promotion failed for a nurse', { employeeId: n.id, ...describeError(e) });
    }
  }
  return { done, failed };
}

/** The input for a stored evaluation of today. */
export const todayInput = (now: Date): EngineInput => ({ date: riyadhDate(now), today: riyadhDate(now), now });
