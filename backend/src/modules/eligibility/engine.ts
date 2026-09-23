// The one eligibility engine (architecture plan §3 "Eligibility engine
// contract"; spec §6.1). PURE: no database, no clock — every fact and both
// dates are passed in, so every clinical rule is unit-tested directly.
//
// Checks, in the spec §6.1 order (rule L4):
//   1. employee exists, not deleted, Active
//   2. position is schedulable
//   3. an Approved or Active contract covers the date
//   4. applicable requirements exist            — decision D-4: when none, ALLOW
//                                                  with an informational reason
//   5. each required template: verified (Valid/ExpiringSoon), issued by the date
//      and not expired on it (D-15: dates, not status alone) — else grace (L8,
//      §6.1.1) — else a waiver for THAT template (L9, §6.1.2, D-15) — else a
//      TRANSITION requirement before its deadline warns (L10, §6.1.1.1)
//   6. caller scope — enforced by the calling service, not here.
//
// Outcome (L5 + §6.1.1.1): INELIGIBLE if anything blocks; otherwise
// ELIGIBLE_WITH_GRACE if a grace window is used; otherwise
// ELIGIBLE_WITH_POLICY_WARNING if a transition requirement is unmet; else ELIGIBLE.

import { addDays, type IsoDate } from '../../lib/dates.js';

export const ENGINE_LOGIC_VERSION = 1;

export type EligibilityStatus = 'ELIGIBLE' | 'ELIGIBLE_WITH_GRACE' | 'ELIGIBLE_WITH_POLICY_WARNING' | 'INELIGIBLE';
export type Severity = 'BLOCK' | 'WARN' | 'INFO';

export type ReasonCode =
  | 'EMPLOYEE_NOT_FOUND' | 'EMPLOYEE_DELETED' | 'EMPLOYEE_NOT_ACTIVE'
  | 'POSITION_NOT_SCHEDULABLE'
  | 'NO_CONTRACT_COVERAGE'
  | 'UNIT_NOT_ASSIGNED' | 'NO_REQUIREMENTS_CONFIGURED'
  | 'CREDENTIAL_MISSING' | 'CREDENTIAL_NOT_VERIFIED' | 'CREDENTIAL_EXPIRED' | 'CREDENTIAL_NOT_YET_ISSUED'
  | 'CREDENTIAL_EXPIRY_UNKNOWN' | 'CREDENTIAL_SUSPENDED' | 'CREDENTIAL_REVOKED'
  | 'GRACE_ACTIVE' | 'WAIVER_ACTIVE' | 'POLICY_TRANSITION_WARNING';

export interface Reason {
  code: ReasonCode;
  severity: Severity;
  message: string;
  templateId?: number;
  templateCode?: string;
  /** Grace end date, waiver expiry or transition deadline, when relevant. */
  until?: string;
  credentialId?: number;
}

export interface EngineFacts {
  employee: { id: number; status: string; deletedAt: Date | null; unitId: number | null; positionCode: string } | null;
  position: { code: string; isSchedulable: boolean } | null;
  contracts: Array<{ status: string; startDate: IsoDate; endDate: IsoDate }>;
  /** Every requirement for the employee's unit (the engine applies position precedence). */
  requirements: Array<{ id: number; templateId: number; unitId: number; positionCode: string | null; policyStatus: 'MANDATORY' | 'TRANSITION' | 'OPTIONAL'; transitionDeadline: IsoDate | null }>;
  templates: Map<number, { id: number; code: string; name: string; hasExpiry: boolean; gracePeriodDays: number }>;
  credentials: Array<{
    id: number; templateId: number;
    status: 'PendingVerification' | 'Valid' | 'ExpiringSoon' | 'Expired' | 'Suspended' | 'Revoked';
    issueDate: IsoDate | null; expiryDate: IsoDate | null;
    /** Renewal in progress (lifecycle label OnProcess): staged data or a document awaiting review. */
    renewalInProgress: boolean;
    /** The expiry cycle a grace window was already used for (L8 no-stacking), if any. */
    graceCycleId: string | null;
  }>;
  waivers: Array<{ id: number; templateId: number; createdAt: Date; expiresAt: Date }>;
}

export interface EngineInput {
  /** The calendar day being evaluated (a shift date, or today for the materialized state). */
  date: IsoDate;
  /** Today in Asia/Riyadh — spec §6.1.1.1 judges transition deadlines against CURRENT_DATE. */
  today: IsoDate;
  /** The evaluation instant — waivers are judged against it (spec §6.1.2: expiry_date > now). */
  now: Date;
}

export interface GraceUse { credentialId: number; templateId: number; cycleId: string; graceEndDate: IsoDate }

export interface EngineResult {
  status: EligibilityStatus;
  reasons: Reason[];
  /** Grace windows this result relies on — the state service must record them (L8: "never silent"). */
  graceUsed: GraceUse[];
  logicVersion: number;
}

const COVERING_CONTRACT = new Set(['Approved', 'Active']);
const VERIFIED = new Set(['Valid', 'ExpiringSoon']);

/** The expiry cycle identity used for L8 no-stacking: one grace window per expiry date. */
export const graceCycleOf = (credentialId: number, expiryDate: IsoDate) => `${credentialId}:${expiryDate}`;

export function evaluate(facts: EngineFacts, input: EngineInput): EngineResult {
  const reasons: Reason[] = [];
  const graceUsed: GraceUse[] = [];
  const block = (code: ReasonCode, message: string, extra: Partial<Reason> = {}) => reasons.push({ code, severity: 'BLOCK', message, ...extra });
  const done = (): EngineResult => {
    const status: EligibilityStatus = reasons.some((r) => r.severity === 'BLOCK') ? 'INELIGIBLE'
      : graceUsed.length > 0 ? 'ELIGIBLE_WITH_GRACE'
      : reasons.some((r) => r.code === 'POLICY_TRANSITION_WARNING') ? 'ELIGIBLE_WITH_POLICY_WARNING'
      : 'ELIGIBLE';
    return { status, reasons, graceUsed: status === 'INELIGIBLE' ? [] : graceUsed, logicVersion: ENGINE_LOGIC_VERSION };
  };

  // 1. Employee exists, not deleted, Active. Nothing else is meaningful otherwise.
  const emp = facts.employee;
  if (!emp) { block('EMPLOYEE_NOT_FOUND', 'The employee does not exist'); return done(); }
  if (emp.deletedAt) { block('EMPLOYEE_DELETED', 'The employee record is deleted'); return done(); }
  if (emp.status !== 'Active') { block('EMPLOYEE_NOT_ACTIVE', `Employee status is ${emp.status}, not Active`); return done(); }

  // 2. Schedulable position (DON, DEPUTY_DON, ADMIN are not, regardless of credentials).
  if (!facts.position?.isSchedulable) block('POSITION_NOT_SCHEDULABLE', `Position ${emp.positionCode} is not schedulable`);

  // 3. An Approved or Active contract covers the date (inclusive range).
  const covered = facts.contracts.some((c) => COVERING_CONTRACT.has(c.status) && c.startDate <= input.date && input.date <= c.endDate);
  if (!covered) block('NO_CONTRACT_COVERAGE', `No approved or active contract covers ${input.date}`);

  // 4. Applicable requirements. Without a unit none can apply.
  // REQUIREMENT NOT ESTABLISHED: the spec does not say what an Unassigned
  // employee's eligibility is; V04 blocks (a nurse is never cleared without
  // any credential check) — recorded for the owner's decision.
  if (emp.unitId === null) {
    block('UNIT_NOT_ASSIGNED', 'The employee has no unit, so no credential rules can be applied');
    return done();
  }
  const applicable = applicableRequirements(facts.requirements, emp.unitId, emp.positionCode);
  if (applicable.length === 0) {
    // Decision D-4 (owner, 2026-09-23): allow, but never silently.
    reasons.push({ code: 'NO_REQUIREMENTS_CONFIGURED', severity: 'INFO', message: `No credential requirements are configured for this unit and position (${emp.positionCode}); no credential was checked` });
    return done();
  }

  // 5. Each required template.
  for (const req of applicable) {
    const tpl = facts.templates.get(req.templateId);
    const label = tpl ? `${tpl.name} (${tpl.code})` : `template #${req.templateId}`;
    const refs = { templateId: req.templateId, templateCode: tpl?.code };
    const held = facts.credentials.filter((c) => c.templateId === req.templateId);

    // 5a. Verified and in date on the evaluated day.
    if (held.some((c) => isValidOn(c, tpl?.hasExpiry ?? true, input.date))) continue;

    // 5b. Grace (L8, §6.1.1): expired, within window, renewal in progress,
    //     not suspended/revoked, not a second window for another expiry.
    const grace = graceFor(held, tpl?.gracePeriodDays ?? 0, input.date);
    if (grace) {
      graceUsed.push({ credentialId: grace.credential.id, templateId: req.templateId, cycleId: grace.cycleId, graceEndDate: grace.end });
      reasons.push({ code: 'GRACE_ACTIVE', severity: 'WARN', message: `${label} expired on ${grace.credential.expiryDate}; renewal in progress — grace until ${grace.end}`, ...refs, until: grace.end, credentialId: grace.credential.id });
      continue;
    }

    // 5c. A waiver for THIS template, live at the evaluation instant (L9, D-15).
    const waiver = facts.waivers.find((w) => w.templateId === req.templateId && w.createdAt <= input.now && input.now < w.expiresAt);
    if (waiver) {
      reasons.push({ code: 'WAIVER_ACTIVE', severity: 'INFO', message: `Waiver active for ${label} until ${waiver.expiresAt.toISOString()}`, ...refs, until: waiver.expiresAt.toISOString() });
      continue;
    }

    // 5d. TRANSITION before its deadline warns; after it, it is MANDATORY (L10).
    const inTransition = req.policyStatus === 'TRANSITION' && req.transitionDeadline !== null && input.today <= req.transitionDeadline;
    if (inTransition) {
      reasons.push({ code: 'POLICY_TRANSITION_WARNING', severity: 'WARN', message: `New requirement ${label} will become mandatory on ${req.transitionDeadline}. Please upload evidence.`, ...refs, until: req.transitionDeadline! });
      continue;
    }

    const why = failure(held, tpl?.hasExpiry ?? true, input.date);
    block(why.code, `${label}: ${why.message}`, { ...refs, ...(why.credentialId ? { credentialId: why.credentialId } : {}) });
  }

  return done();
}

/**
 * Spec §5.1.4: a requirement with position NULL applies to every position in
 * the unit; a position-specific requirement overrides the unit-wide one for the
 * same template. OPTIONAL requirements never gate eligibility.
 */
export function applicableRequirements(all: EngineFacts['requirements'], unitId: number, positionCode: string) {
  const inUnit = all.filter((r) => r.unitId === unitId && (r.positionCode === null || r.positionCode === positionCode));
  const byTemplate = new Map<number, EngineFacts['requirements'][number]>();
  for (const r of inUnit) {
    const current = byTemplate.get(r.templateId);
    if (!current || (current.positionCode === null && r.positionCode !== null)) byTemplate.set(r.templateId, r);
  }
  return [...byTemplate.values()].filter((r) => r.policyStatus !== 'OPTIONAL').sort((a, b) => a.templateId - b.templateId);
}

type HeldCredential = EngineFacts['credentials'][number];

function isValidOn(c: HeldCredential, hasExpiry: boolean, date: IsoDate): boolean {
  if (!VERIFIED.has(c.status)) return false;
  if (c.issueDate !== null && c.issueDate > date) return false;
  if (c.expiryDate === null) return !hasExpiry;
  return date <= c.expiryDate; // the expiry date is the last valid day
}

function graceFor(held: HeldCredential[], graceDays: number, date: IsoDate) {
  if (graceDays <= 0) return null;
  for (const c of held) {
    if (c.status === 'Suspended' || c.status === 'Revoked' || c.status === 'PendingVerification') continue;
    if (!c.expiryDate || !(c.expiryDate < date)) continue;
    const end = addDays(c.expiryDate, graceDays);
    if (date > end) continue;
    if (!c.renewalInProgress) continue;
    const cycleId = graceCycleOf(c.id, c.expiryDate);
    // No stacking: a grace window already used for a different (earlier) expiry
    // and never closed by a completed renewal forbids a new one.
    if (c.graceCycleId !== null && c.graceCycleId !== cycleId) continue;
    return { credential: c, cycleId, end };
  }
  return null;
}

/** The most useful single explanation for an unmet requirement. */
function failure(held: HeldCredential[], hasExpiry: boolean, date: IsoDate): { code: ReasonCode; message: string; credentialId?: number } {
  if (held.length === 0) return { code: 'CREDENTIAL_MISSING', message: 'no credential on record' };
  const pick = (status: HeldCredential['status']) => held.find((c) => c.status === status);
  const revoked = pick('Revoked');
  if (revoked && held.every((c) => c.status === 'Revoked' || c.status === 'Suspended')) return { code: 'CREDENTIAL_REVOKED', message: 'credential revoked', credentialId: revoked.id };
  const suspended = pick('Suspended');
  if (suspended && held.every((c) => c.status === 'Revoked' || c.status === 'Suspended')) return { code: 'CREDENTIAL_SUSPENDED', message: 'credential suspended', credentialId: suspended.id };
  const verified = held.filter((c) => VERIFIED.has(c.status) || c.status === 'Expired');
  const future = verified.find((c) => c.issueDate !== null && c.issueDate > date);
  if (future) return { code: 'CREDENTIAL_NOT_YET_ISSUED', message: `issued ${future.issueDate}, after ${date}`, credentialId: future.id };
  const expired = verified.find((c) => c.expiryDate !== null && c.expiryDate < date);
  if (expired) return { code: 'CREDENTIAL_EXPIRED', message: `expired on ${expired.expiryDate}`, credentialId: expired.id };
  const noExpiry = verified.find((c) => c.expiryDate === null && hasExpiry);
  if (noExpiry) return { code: 'CREDENTIAL_EXPIRY_UNKNOWN', message: 'no expiry date recorded', credentialId: noExpiry.id };
  const pending = pick('PendingVerification');
  if (pending) return { code: 'CREDENTIAL_NOT_VERIFIED', message: 'awaiting HR verification', credentialId: pending.id };
  return { code: 'CREDENTIAL_MISSING', message: 'no valid credential on record' };
}
