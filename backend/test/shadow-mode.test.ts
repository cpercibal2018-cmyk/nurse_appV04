// Shadow mode (spec §10.9, D-60): a new eligibility logic version runs beside the
// active one on every stored evaluation, never changes the outcome, keeps each
// disagreement, and is promoted only by the §10.9 criteria. A test engine version
// is registered in this process only; other test files never run it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { evaluate } from '../src/modules/eligibility/engine.js';
import { currentLogic, ENGINES, promotionState, SHADOW_MIN_DAYS, syncLogicVersions } from '../src/modules/eligibility/logic.js';
import { refreshEligibility } from '../src/modules/eligibility/state.service.js';
import type { Db } from '../src/lib/prisma.js';
import { fastPasswords, makeNurse, makeOrg, makeUser, openDb, signIn, TEST_URL, testEnv, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;

/** A version number no other run used: leftovers of earlier runs are retired first. */
const V = 1000 + Math.floor(Math.random() * 1_000_000);
/** Nurses the candidate logic judges differently, and ones it fails on. */
const flip = new Set<number>();
const crash = new Set<number>();

describeDb('eligibility shadow mode (spec §10.9)', () => {
  let db: Db;
  const mine: number[] = [];
  let resolveReevaluated: (out: { done: number; failed: number }) => void = () => undefined;
  const makeApp = () => createApp({
    env: testEnv(), db, passwords: fastPasswords, throttleNamespace: uniq('app') + ':',
    logic: {
      // Only this file's nurses: the shared test database holds everyone else's.
      reevaluate: async (d, refresh) => {
        for (const id of mine) await d.$transaction((tx) => refresh(tx, id));
        return { done: mine.length, failed: 0 };
      },
      onReevaluated: (out) => resolveReevaluated(out),
    },
  });

  beforeAll(async () => {
    db = openDb();
    ENGINES.set(V, (facts, input) => {
      if (facts.employee && crash.has(facts.employee.id)) throw new Error('candidate bug');
      const r = evaluate(facts, input);
      return { ...r, logicVersion: V, status: facts.employee && flip.has(facts.employee.id) ? 'INELIGIBLE' : r.status };
    });
    // Start from the released state: version 1 ACTIVE, nothing in shadow.
    await db.$transaction(async (tx) => {
      await tx.eligibilityLogicVersion.updateMany({ where: { version: { not: 1 }, status: { not: 'RETIRED' } }, data: { status: 'RETIRED', retiredAt: new Date() } });
      await tx.eligibilityLogicVersion.update({ where: { version: 1 }, data: { status: 'ACTIVE', retiredAt: null, retiredById: null } });
    });
  });

  afterAll(async () => {
    ENGINES.delete(V);
    await db.$transaction(async (tx) => {
      await tx.eligibilityLogicVersion.updateMany({ where: { version: V, status: { not: 'RETIRED' } }, data: { status: 'RETIRED', retiredAt: new Date() } });
      await tx.eligibilityLogicVersion.update({ where: { version: 1 }, data: { status: 'ACTIVE', retiredAt: null, retiredById: null } });
    });
    for (const id of mine) await db.$transaction((tx) => refreshEligibility(tx, id, 'TEST_CLEANUP'));
    await db.$disconnect();
  });

  it('a new version in the release starts in shadow; the active one still decides', async () => {
    const added = await syncLogicVersions(db);
    expect(added).toContainEqual({ version: V, status: 'SHADOW' });
    expect(await syncLogicVersions(db)).toEqual([]); // idempotent
    const logic = await currentLogic(db);
    expect(logic.version).toBe(1);
    expect(logic.shadow?.version).toBe(V);
    expect(await db.auditEntry.count({ where: { action: 'ELIGIBILITY_LOGIC_REGISTERED', resourceId: String(V) } })).toBe(1);
  });

  it('keeps a disagreement once, never changes the stored result, and records a failing shadow as ERROR', async () => {
    const { unitA: unit } = await makeOrg(db);
    const [a, b, c] = [await makeNurse(db, unit.id), await makeNurse(db, unit.id), await makeNurse(db, unit.id)];
    mine.push(a.emp.id, b.emp.id, c.emp.id);
    flip.add(b.emp.id);
    crash.add(c.emp.id);

    for (const n of [a, b, b, c]) await db.$transaction((tx) => refreshEligibility(tx, n.emp.id, 'TEST'));
    expect(await db.eligibilityShadowLog.count({ where: { employeeId: a.emp.id } })).toBe(0);
    const [fb] = await db.eligibilityShadowLog.findMany({ where: { employeeId: b.emp.id, logicVersion: V } });
    expect(await db.eligibilityShadowLog.count({ where: { employeeId: b.emp.id } })).toBe(1);
    expect(fb).toMatchObject({ activeVersion: 1, candidateStatus: 'INELIGIBLE', event: 'TEST', decision: null });
    expect(fb!.activeStatus).not.toBe('INELIGIBLE');
    const stateB = await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: b.emp.id } });
    expect(stateB).toMatchObject({ status: fb!.activeStatus, logicVersion: 1 });
    expect(await db.eligibilityShadowLog.findFirst({ where: { employeeId: c.emp.id } })).toMatchObject({ candidateStatus: 'ERROR' });

    await expect(db.eligibilityShadowLog.delete({ where: { id: fb!.id } })).rejects.toThrow(/cannot be deleted/);
  });

  it('promotion follows §10.9: undecided and failed findings block; approved ones or 7 quiet days allow', async () => {
    const app = makeApp();
    const hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    const { dept } = await makeOrg(db);
    const deptHr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'DEPARTMENT', scopeIds: [dept.id] }] })).email);
    const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);

    const overview = await hr.get('/eligibility/logic');
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ active: 1, shadow: { version: V, promotable: false, undecided: 2, errors: 1 } });
    expect((await sa.get('/eligibility/logic')).status).toBe(200);
    expect((await sa.post(`/eligibility/logic/${V}/promote`, { reason: 'A System Admin cannot promote' })).status).toBe(403);

    const findings = await hr.get(`/eligibility/logic/${V}/findings`);
    const flipped = findings.body.items.find((f: { candidateStatus: string }) => f.candidateStatus === 'INELIGIBLE');
    const failed = findings.body.items.find((f: { candidateStatus: string }) => f.candidateStatus === 'ERROR');
    expect(flipped.employee.jobNumber).toBeTruthy();

    const blocked = await hr.post(`/eligibility/logic/${V}/promote`, { reason: 'Promote with open findings' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('LOGIC_NOT_PROMOTABLE');

    expect((await deptHr.post(`/eligibility/logic/findings/${flipped.id}/decision`, { decision: 'APPROVED', note: 'Department HR is not enough' })).body.error.code).toBe('SCOPE_NOT_COVERED');
    expect((await hr.post(`/eligibility/logic/findings/${failed.id}/decision`, { decision: 'APPROVED', note: 'Approve a crash — refused' })).body.error.code).toBe('FINDING_IS_ERROR');
    expect((await hr.post(`/eligibility/logic/findings/${flipped.id}/decision`, { decision: 'APPROVED', note: 'short' })).body.error.code).toBe('VALIDATION_FAILED');
    const ok = await hr.post(`/eligibility/logic/findings/${flipped.id}/decision`, { decision: 'APPROVED', note: 'The new rule is right for this nurse' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ decision: 'APPROVED' });
    expect((await hr.post(`/eligibility/logic/findings/${flipped.id}/decision`, { decision: 'REJECTED', note: 'Changing my mind later' })).body.error.code).toBe('FINDING_DECIDED');
    await expect(db.eligibilityShadowLog.update({ where: { id: flipped.id }, data: { decisionNote: 'rewritten by hand afterwards' } })).rejects.toThrow(/cannot be changed once decided/);

    // A failure of the new logic can only be rejected, and a rejection blocks for good.
    await hr.post(`/eligibility/logic/findings/${failed.id}/decision`, { decision: 'REJECTED', note: 'The new logic crashed for this nurse' });
    expect((await promotionState(db, V)).blocker).toMatch(/rejected/);

    // Without findings: only after 7 days in shadow.
    const W = V + 1;
    ENGINES.set(W, (facts, input) => ({ ...evaluate(facts, input), logicVersion: W }));
    try {
      await syncLogicVersions(db);
      expect((await db.eligibilityLogicVersion.findUniqueOrThrow({ where: { version: V } })).status).toBe('RETIRED'); // superseded
      expect((await promotionState(db, W)).blocker).toMatch(/after 7 days/);
      await db.eligibilityLogicVersion.update({ where: { version: W }, data: { shadowSince: new Date(Date.now() - SHADOW_MIN_DAYS * 86_400_000) } });
      expect(await promotionState(db, W)).toMatchObject({ promotable: true, findings: 0 });

      const reevaluated = new Promise<{ done: number; failed: number }>((r) => { resolveReevaluated = r; });
      const promoted = await hr.post(`/eligibility/logic/${W}/promote`, { reason: 'Seven days in shadow without a disagreement' });
      expect(promoted.status).toBe(200);
      expect(promoted.body).toMatchObject({ active: W, retired: 1, reevaluation: 'started' });
      await reevaluated;
      expect((await currentLogic(db)).version).toBe(W);
      expect((await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: mine[0]! } })).logicVersion).toBe(W);
      expect(await db.auditEntry.findFirst({ where: { action: 'ELIGIBILITY_LOGIC_PROMOTED', resourceId: String(W) } })).toMatchObject({ priority: 'HIGH' });
    } finally {
      ENGINES.delete(W);
      await db.$transaction(async (tx) => {
        await tx.eligibilityLogicVersion.updateMany({ where: { version: W }, data: { status: 'RETIRED', retiredAt: new Date() } });
        await tx.eligibilityLogicVersion.update({ where: { version: 1 }, data: { status: 'ACTIVE', retiredAt: null, retiredById: null } });
      });
    }
  });

  it('an ACTIVE version this release does not ship falls back to the last promoted one it ships', async () => {
    const X = V + 2;
    await db.$transaction(async (tx) => {
      await tx.eligibilityLogicVersion.update({ where: { version: 1 }, data: { status: 'RETIRED' } });
      await tx.eligibilityLogicVersion.create({ data: { version: X, status: 'ACTIVE', promotedAt: new Date() } });
    });
    try {
      const logic = await currentLogic(db);
      expect(logic.version).toBe(1);
      expect(logic.engine).toBe(evaluate);
    } finally {
      await db.$transaction(async (tx) => {
        await tx.eligibilityLogicVersion.update({ where: { version: X }, data: { status: 'RETIRED', retiredAt: new Date() } });
        await tx.eligibilityLogicVersion.update({ where: { version: 1 }, data: { status: 'ACTIVE', retiredAt: null, retiredById: null } });
      });
    }
  });

  it('retiring the version in shadow stops it, audited; the database allows one ACTIVE and one SHADOW', async () => {
    const Y = V + 3;
    ENGINES.set(Y, (facts, input) => ({ ...evaluate(facts, input), logicVersion: Y }));
    try {
      await syncLogicVersions(db);
      await expect(db.eligibilityLogicVersion.create({ data: { version: Y + 1, status: 'SHADOW', shadowSince: new Date() } })).rejects.toThrow();
      await expect(db.eligibilityLogicVersion.create({ data: { version: Y + 1, status: 'ACTIVE' } })).rejects.toThrow();
      const hr = await signIn(makeApp(), (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      expect((await hr.post(`/eligibility/logic/${Y}/retire`, { reason: 'Withdrawn before review' })).status).toBe(200);
      expect((await currentLogic(db)).shadow).toBeNull();
      expect(await db.auditEntry.count({ where: { action: 'ELIGIBILITY_LOGIC_RETIRED', resourceId: String(Y) } })).toBe(1);
      expect((await request(makeApp()).get('/api/v1/eligibility/logic')).status).toBe(401);
    } finally {
      ENGINES.delete(Y);
    }
  });
});
