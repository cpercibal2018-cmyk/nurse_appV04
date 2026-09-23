// The permission table: which authorization roles may perform which operation
// (spec §8.1 matrix, docs/API_MAP.md "Permission" column). Default deny (R15):
// an operation not listed here cannot be authorized. EMPLOYEE is implicit for
// every active user and is never stored (R1); `EMPLOYEE` below means "any
// authenticated user", with record scope limited to their own data.
//
// Each later domain module adds its permissions here, so this file is the one
// place to read who can do what.

import type { AppRole } from '../../generated/prisma/client.js';

export type EffectiveRole = AppRole | 'EMPLOYEE';

export const PERMISSIONS = {
  // Accounts — spec §8.1 "Provision and administer within assigned scope".
  'accounts.read': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'accounts.write': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  // Role assignments and four-eyes approvals (R2–R12).
  'roles.read': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'roles.write': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'approvals.read': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'approvals.decide': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  // Reference data every signed-in user may read.
  'matrix.read': ['EMPLOYEE'],
  'workforce.read': ['EMPLOYEE'], // departments, units (API_MAP §2.4)

  // Credentials and eligibility — spec §8.1 Credentials row, §5.1.4, §6.1.
  'credentials.catalog.read': ['EMPLOYEE'],
  'credentials.catalog.write': ['HR_ADMIN', 'SYSTEM_ADMIN'], // system-wide scope enforced in the service
  'requirements.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],
  'requirements.write': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'credentials.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'], // supervisors get the compliance view
  'credentials.manage': ['HR_ADMIN', 'SYSTEM_ADMIN'], // record, verify, suspend, revoke, renewal decisions
  'credentials.self': ['EMPLOYEE'], // own submission, evidence, alerts
  'eligibility.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],
  'waivers.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],
  // Spec §6.1.2: "only users with the Supervisor or HR_Admin role can issue a waiver".
  'waivers.write': ['SUPERVISOR', 'HR_ADMIN'],
} as const satisfies Record<string, readonly EffectiveRole[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Spec §8.1 table, served read-only by GET /roles/matrix. */
export const ACCESS_MATRIX = {
  columns: ['HR Admin / System Admin', 'Supervisor / Scheduler', 'Employee'],
  rows: [
    { area: 'Accounts', cells: ['Provision and administer within assigned scope', 'No account administration by default', 'Claim invited account; own password'] },
    { area: 'Employee Master', cells: ['Maintain source fields within scope', 'Assigned-unit baseline/compliance view; private fields suppressed', 'Own profile; phone update'] },
    { area: 'Contracts', cells: ['Scoped create, approval, renewal, termination', 'Scoped reduced read view', 'Own reduced read view'] },
    { area: 'Credentials', cells: ['Scoped upload, review, validity decisions', 'Scoped compliance view; no evidence downloads', 'Own submission, evidence, alerts'] },
    { area: 'Scheduling', cells: ['Coverage/read view by default', 'Scoped draft and publish', 'Published personal/home-unit view'] },
    { area: 'Notifications', cells: ['Own recipient rows', 'Own recipient rows', 'Own recipient rows'] },
  ],
  source: 'Specification §8.1',
} as const;
