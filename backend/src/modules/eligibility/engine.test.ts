// Engine unit tests from the specification's own rules and acceptance tables:
// §6.1 (check order, L4/L5), §5.1.4 (requirement precedence), §6.1.1 grace
// acceptance criteria (L8), §6.1.1.1 transition acceptance criteria (L10),
// §6.1.2 waiver acceptance criteria (L9), decisions D-4 and D-15.

import { describe, expect, it } from 'vitest';
import { evaluate, graceCycleOf, type EngineFacts, type EngineInput } from './engine.js';

const TPL = {
  SCFHS: { id: 1, code: 'SCFHS', name: 'SCFHS License', hasExpiry: true, gracePeriodDays: 30 },
  BLS: { id: 2, code: 'BLS', name: 'BLS', hasExpiry: true, gracePeriodDays: 0 },
  IQAMA: { id: 3, code: 'IQAMA', name: 'Iqama', hasExpiry: true, gracePeriodDays: 0 },
  COMP: { id: 4, code: 'COMP', name: 'Core competency', hasExpiry: false, gracePeriodDays: 0 },
};
const UNIT = 10;
const SHIFT = '2026-10-01';
const input: EngineInput = { date: SHIFT, today: '2026-09-23', now: new Date('2026-09-23T08:00:00Z') };

type Cred = EngineFacts['credentials'][number];
const cred = (templateId: number, over: Partial<Cred> = {}): Cred => ({
  id: templateId * 100, templateId, status: 'Valid', issueDate: '2025-01-01', expiryDate: '2027-01-01', renewalInProgress: false, graceCycleId: null, ...over,
});
const req = (templateId: number, over: Partial<EngineFacts['requirements'][number]> = {}) => ({
  id: templateId, templateId, unitId: UNIT, positionCode: null, policyStatus: 'MANDATORY' as const, transitionDeadline: null, ...over,
});

function facts(over: Partial<EngineFacts> = {}): EngineFacts {
  return {
    employee: { id: 1, status: 'Active', deletedAt: null, unitId: UNIT, positionCode: 'SN' },
    position: { code: 'SN', isSchedulable: true },
    contracts: [{ status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31' }],
    requirements: [req(1), req(2)],
    templates: new Map(Object.values(TPL).map((t) => [t.id, t])),
    credentials: [cred(1), cred(2)],
    waivers: [],
    ...over,
  };
}
const codes = (f: EngineFacts, i: EngineInput = input) => evaluate(f, i).reasons.map((r) => r.code);

describe('§6.1 check order (L4, L5)', () => {
  it('a fully compliant nurse is ELIGIBLE with no reasons', () => {
    expect(evaluate(facts(), input)).toMatchObject({ status: 'ELIGIBLE', reasons: [] });
  });

  it('1. a missing, deleted or non-Active employee is INELIGIBLE and nothing else is evaluated', () => {
    expect(codes(facts({ employee: null }))).toEqual(['EMPLOYEE_NOT_FOUND']);
    expect(codes(facts({ employee: { ...facts().employee!, deletedAt: new Date() } }))).toEqual(['EMPLOYEE_DELETED']);
    expect(codes(facts({ employee: { ...facts().employee!, status: 'Suspended' } }))).toEqual(['EMPLOYEE_NOT_ACTIVE']);
  });

  it('2. a non-schedulable position blocks regardless of credentials', () => {
    const r = evaluate(facts({ position: { code: 'DON', isSchedulable: false } }), input);
    expect(r.status).toBe('INELIGIBLE');
    expect(r.reasons.map((x) => x.code)).toEqual(['POSITION_NOT_SCHEDULABLE']);
  });

  it('3. the contract must be Approved or Active and cover the SHIFT date, inclusive', () => {
    expect(codes(facts({ contracts: [{ status: 'Draft', startDate: '2026-01-01', endDate: '2026-12-31' }] }))).toEqual(['NO_CONTRACT_COVERAGE']);
    expect(codes(facts({ contracts: [{ status: 'Active', startDate: '2026-01-01', endDate: '2026-09-30' }] }))).toEqual(['NO_CONTRACT_COVERAGE']);
    expect(codes(facts({ contracts: [{ status: 'Approved', startDate: '2026-10-01', endDate: '2026-10-01' }] }))).toEqual([]);
    for (const status of ['Expired', 'Suspended', 'Terminated', 'Superseded', 'PendingApproval']) {
      expect(codes(facts({ contracts: [{ status, startDate: '2026-01-01', endDate: '2026-12-31' }] }))).toEqual(['NO_CONTRACT_COVERAGE']);
    }
  });

  it('4. no applicable requirement → ELIGIBLE with an explicit NO_REQUIREMENTS_CONFIGURED reason (decision D-4)', () => {
    const r = evaluate(facts({ requirements: [] }), input);
    expect(r.status).toBe('ELIGIBLE');
    expect(r.reasons).toEqual([expect.objectContaining({ code: 'NO_REQUIREMENTS_CONFIGURED', severity: 'INFO' })]);
    // OPTIONAL-only and other-unit requirements do not count as configured.
    expect(codes(facts({ requirements: [req(1, { policyStatus: 'OPTIONAL' }), req(2, { unitId: 99 })] }))).toEqual(['NO_REQUIREMENTS_CONFIGURED']);
  });

  it('4. an Unassigned employee is blocked (REQUIREMENT NOT ESTABLISHED — conservative choice)', () => {
    expect(codes(facts({ employee: { ...facts().employee!, unitId: null } }))).toEqual(['UNIT_NOT_ASSIGNED']);
  });

  it('reports every blocking reason, not only the first', () => {
    const r = evaluate(facts({ position: { code: 'SN', isSchedulable: false }, contracts: [], credentials: [cred(1)] }), input);
    expect(r.reasons.map((x) => x.code)).toEqual(['POSITION_NOT_SCHEDULABLE', 'NO_CONTRACT_COVERAGE', 'CREDENTIAL_MISSING']);
  });
});

describe('5. credentials are checked against the shift date, not status alone (D-15, fixes V03 C-4)', () => {
  it('a "Valid" credential whose expiry is before the shift date is INELIGIBLE', () => {
    const r = evaluate(facts({ credentials: [cred(1, { expiryDate: '2026-09-30' }), cred(2)] }), input);
    expect(r.status).toBe('INELIGIBLE');
    expect(r.reasons[0]).toMatchObject({ code: 'CREDENTIAL_EXPIRED', templateCode: 'SCFHS' });
  });

  it('the expiry date itself is the last valid day', () => {
    expect(evaluate(facts({ credentials: [cred(1, { expiryDate: SHIFT }), cred(2)] }), input).status).toBe('ELIGIBLE');
  });

  it('a credential issued after the shift date does not count', () => {
    expect(codes(facts({ credentials: [cred(1, { issueDate: '2026-10-02' }), cred(2)] }))).toEqual(['CREDENTIAL_NOT_YET_ISSUED']);
  });

  it('only Valid and ExpiringSoon are verified', () => {
    expect(evaluate(facts({ credentials: [cred(1, { status: 'ExpiringSoon' }), cred(2)] }), input).status).toBe('ELIGIBLE');
    expect(codes(facts({ credentials: [cred(1, { status: 'PendingVerification' }), cred(2)] }))).toEqual(['CREDENTIAL_NOT_VERIFIED']);
    expect(codes(facts({ credentials: [cred(1, { status: 'Suspended' }), cred(2)] }))).toEqual(['CREDENTIAL_SUSPENDED']);
    expect(codes(facts({ credentials: [cred(1, { status: 'Revoked' }), cred(2)] }))).toEqual(['CREDENTIAL_REVOKED']);
  });

  it('a template with expiry needs an expiry date; a template without expiry does not', () => {
    expect(codes(facts({ credentials: [cred(1, { expiryDate: null }), cred(2)] }))).toEqual(['CREDENTIAL_EXPIRY_UNKNOWN']);
    expect(evaluate(facts({ requirements: [req(4)], credentials: [cred(4, { expiryDate: null })] }), input).status).toBe('ELIGIBLE');
  });

  it('any one valid credential for the template is enough (e.g. an old expired one plus its renewal)', () => {
    expect(evaluate(facts({ credentials: [cred(1, { id: 1, status: 'Expired', expiryDate: '2025-01-01' }), cred(1, { id: 2 }), cred(2)] }), input).status).toBe('ELIGIBLE');
  });
});

describe('§5.1.4 requirement scoping', () => {
  it('a unit-wide requirement applies to every position; a position-specific one only to that position', () => {
    expect(codes(facts({ requirements: [req(3, { positionCode: 'SN' })], credentials: [] }))).toEqual(['CREDENTIAL_MISSING']);
    expect(codes(facts({ requirements: [req(3, { positionCode: 'CN' })], credentials: [] }))).toEqual(['NO_REQUIREMENTS_CONFIGURED']);
  });

  it('a position-specific rule overrides the unit-wide rule for the same template', () => {
    const r = [req(1), req(1, { id: 11, positionCode: 'SN', policyStatus: 'OPTIONAL' })];
    expect(codes(facts({ requirements: r, credentials: [] }))).toEqual(['NO_REQUIREMENTS_CONFIGURED']);
    const other = [req(1), req(1, { id: 11, positionCode: 'CN', policyStatus: 'OPTIONAL' })];
    expect(codes(facts({ requirements: other, credentials: [] }))).toEqual(['CREDENTIAL_MISSING']);
  });
});

describe('§6.1.1 grace acceptance criteria (L8)', () => {
  const expired = (over: Partial<Cred> = {}) => cred(1, { status: 'Expired', expiryDate: '2026-09-20', renewalInProgress: true, ...over });

  it('"Eligibility with grace": only expired credential, within window, renewal in progress → ELIGIBLE_WITH_GRACE', () => {
    const r = evaluate(facts({ credentials: [expired(), cred(2)] }), input);
    expect(r.status).toBe('ELIGIBLE_WITH_GRACE');
    expect(r.reasons).toEqual([expect.objectContaining({ code: 'GRACE_ACTIVE', until: '2026-10-20' })]);
    expect(r.graceUsed).toEqual([{ credentialId: 100, templateId: 1, cycleId: graceCycleOf(100, '2026-09-20'), graceEndDate: '2026-10-20' }]);
  });

  it('a stored "Valid" status past its expiry also qualifies for grace', () => {
    expect(evaluate(facts({ credentials: [expired({ status: 'Valid' }), cred(2)] }), input).status).toBe('ELIGIBLE_WITH_GRACE');
  });

  it('the window is inclusive of expiry + grace days, and closed after it ("Grace expiry")', () => {
    expect(evaluate(facts({ credentials: [expired(), cred(2)] }), { ...input, date: '2026-10-20' }).status).toBe('ELIGIBLE_WITH_GRACE');
    expect(codes(facts({ credentials: [expired(), cred(2)] }), { ...input, date: '2026-10-21' })).toEqual(['CREDENTIAL_EXPIRED']);
  });

  it('no renewal in progress → no grace', () => {
    expect(codes(facts({ credentials: [expired({ renewalInProgress: false }), cred(2)] }))).toEqual(['CREDENTIAL_EXPIRED']);
  });

  it('grace_period_days = 0 (the default) → no grace', () => {
    expect(codes(facts({ credentials: [cred(1), cred(2, { status: 'Expired', expiryDate: '2026-09-20', renewalInProgress: true })] }))).toEqual(['CREDENTIAL_EXPIRED']);
  });

  it('"Suspension/revocation overrides grace"', () => {
    expect(codes(facts({ credentials: [expired({ status: 'Suspended' }), cred(2)] }))).toEqual(['CREDENTIAL_SUSPENDED']);
    expect(codes(facts({ credentials: [expired({ status: 'Revoked' }), cred(2)] }))).toEqual(['CREDENTIAL_REVOKED']);
  });

  it('"No stacking": a grace window already used for an earlier expiry blocks a new one', () => {
    const stacked = expired({ graceCycleId: graceCycleOf(100, '2025-09-20') });
    expect(codes(facts({ credentials: [stacked, cred(2)] }))).toEqual(['CREDENTIAL_EXPIRED']);
    // The same cycle may keep using its own window.
    expect(evaluate(facts({ credentials: [expired({ graceCycleId: graceCycleOf(100, '2026-09-20') }), cred(2)] }), input).status).toBe('ELIGIBLE_WITH_GRACE');
  });

  it('grace never hides another blocking reason, and reports no grace use when INELIGIBLE', () => {
    const r = evaluate(facts({ contracts: [], credentials: [expired(), cred(2)] }), input);
    expect(r.status).toBe('INELIGIBLE');
    expect(r.graceUsed).toEqual([]);
  });
});

describe('§6.1.1.1 transition acceptance criteria (L10)', () => {
  const transition = (deadline: string) => req(3, { policyStatus: 'TRANSITION', transitionDeadline: deadline });

  it('"Transition mode": missing credential → ELIGIBLE_WITH_POLICY_WARNING with the deadline', () => {
    const r = evaluate(facts({ requirements: [req(1), req(2), transition('2026-12-31')] }), input);
    expect(r.status).toBe('ELIGIBLE_WITH_POLICY_WARNING');
    expect(r.reasons).toEqual([expect.objectContaining({ code: 'POLICY_TRANSITION_WARNING', until: '2026-12-31' })]);
    expect(r.reasons[0]!.message).toMatch(/will become mandatory on 2026-12-31/);
  });

  it('the deadline day itself still warns; the deadline is judged against today (CURRENT_DATE)', () => {
    expect(evaluate(facts({ requirements: [transition('2026-09-23')], credentials: [] }), input).status).toBe('ELIGIBLE_WITH_POLICY_WARNING');
  });

  it('"Hard deadline enforcement": deadline yesterday → INELIGIBLE', () => {
    expect(codes(facts({ requirements: [transition('2026-09-22')], credentials: [] }))).toEqual(['CREDENTIAL_MISSING']);
  });

  it('a transition requirement that is met gives no warning', () => {
    expect(evaluate(facts({ requirements: [transition('2026-12-31')], credentials: [cred(3)] }), input).status).toBe('ELIGIBLE');
  });
});

describe('§6.1.2 waiver acceptance criteria (L9, D-15)', () => {
  const waiver = (templateId: number, hoursLeft: number) => ({
    id: 1, templateId, createdAt: new Date(input.now.getTime() - 3600_000), expiresAt: new Date(input.now.getTime() + hoursLeft * 3600_000),
  });

  it('"Waiver grants eligibility": an ineligible nurse with a waiver for the missing template → ELIGIBLE', () => {
    const r = evaluate(facts({ credentials: [cred(2)], waivers: [waiver(1, 24)] }), input);
    expect(r.status).toBe('ELIGIBLE');
    expect(r.reasons).toEqual([expect.objectContaining({ code: 'WAIVER_ACTIVE', templateCode: 'SCFHS' })]);
  });

  it('"Automatic expiry": at the expiry instant the nurse reverts to INELIGIBLE', () => {
    const w = waiver(1, 24);
    expect(codes(facts({ credentials: [cred(2)], waivers: [w] }), { ...input, now: w.expiresAt })).toEqual(['CREDENTIAL_MISSING']);
  });

  it('a waiver covers only its own template (C-3)', () => {
    expect(codes(facts({ credentials: [], waivers: [waiver(1, 24)] }))).toEqual(['WAIVER_ACTIVE', 'CREDENTIAL_MISSING']);
  });

  it('a waiver never covers a missing contract or an unschedulable position (C-3)', () => {
    const r = evaluate(facts({ contracts: [], credentials: [cred(2)], waivers: [waiver(1, 24)] }), input);
    expect(r.status).toBe('INELIGIBLE');
    expect(r.reasons.map((x) => x.code)).toEqual(['NO_CONTRACT_COVERAGE', 'WAIVER_ACTIVE']);
  });

  it('a waiver not yet started does not apply', () => {
    const future = { ...waiver(1, 24), createdAt: new Date(input.now.getTime() + 60_000) };
    expect(codes(facts({ credentials: [cred(2)], waivers: [future] }))).toEqual(['CREDENTIAL_MISSING']);
  });
});

describe('outcome precedence', () => {
  it('grace + transition warning → ELIGIBLE_WITH_GRACE, with both reasons', () => {
    const r = evaluate(facts({
      requirements: [req(1), req(3, { policyStatus: 'TRANSITION', transitionDeadline: '2026-12-31' })],
      credentials: [cred(1, { status: 'Expired', expiryDate: '2026-09-20', renewalInProgress: true })],
    }), input);
    expect(r.status).toBe('ELIGIBLE_WITH_GRACE');
    expect(r.reasons.map((x) => x.code)).toEqual(['GRACE_ACTIVE', 'POLICY_TRANSITION_WARNING']);
  });
});
