# Roles, scopes and access (RBAC)

Who may do what in V04, and where each rule is enforced. The specification's access model is §8.1–8.2 of the [reference specification](reference/AIGH_Nursing_Workforce_Management_System_v2_8_7.md); rule IDs (R1…) are from the [rule register](FEATURE_MASTER_INVENTORY.md#15-business-rule-register); owner decisions (D-n) are in the [decision record](V04_ARCHITECTURE_PLAN.md#9a-decision-record-2026-09-23).

Three layers decide every request, in this order:

1. **Authentication** (`middleware/authenticate.ts`) — every route except `GET /health` and `POST /auth/login|refresh|logout` needs a valid access token; an anonymous caller gets 401 for any path.
2. **Permission** (`middleware/authorize.ts` + `modules/users/permissions.ts`) — the route names one permission; the caller's *effective* roles must include a role the permission lists. Default deny (R15).
3. **Record scope and response fields** (each module's service) — the rows the caller may touch, and which fields they see. A browser-supplied id never establishes access (R15).

Roles and scopes are read from the database on every request, so a revocation applies to the next request (R9).

## 1. Roles

| Role | Stored? | Meaning |
| :--- | :--- | :--- |
| `EMPLOYEE` | **No** — implicit for every active account (R1) | Self-service: own profile and phones, own contracts (read), own credentials, own roster and attendance, own notifications, own sessions |
| `SUPERVISOR` | Role assignment | Scoped unit view; drafts and publishes rosters (D-14); issues waivers |
| `HR_ADMIN` | Role assignment | Maintains employees, contracts, credentials, organisation within scope; issues waivers |
| `SYSTEM_ADMIN` | Role assignment, **dormant** | Counts only during an active PAM elevation (R13). Audit, jobs, administration |

A position or job title never confers a role (R14, spec §8.2): DON, NS, ACTING_HEAD and the rest need an explicit assignment.

## 2. Scopes

Every assignment has a scope type: `SYSTEM` (hospital-wide, no ids), `DEPARTMENT` (department ids) or `UNIT` (unit ids) — R3, enforced by `chk_role_assignments_scope`. A department scope covers every unit in the department.

| Rule | Effect |
| :--- | :--- |
| Granting (R6) | The granter must cover the scope they grant; only a system-wide HR Admin or an elevated System Admin grants `SYSTEM` scope |
| One active assignment per user + role + scope type (R7) | Partial unique index `role_assignments_active_key` |
| Expiry windows (R5, D-23) | Supervisor ≤ 90 days, others ≤ 365 days. Source: V03 reference, accepted by the owner |
| Last System Admin (R8) | Cannot be revoked or deactivated |
| Account scope (D-23) | An account is "in scope" through its linked employee's unit; unlinked accounts need system-wide scope |
| **Hospital-wide configuration** (D-25, D-34) | Credential catalog, departments, unit create/move/deactivate, positions and the unit CSV import need **system-wide** HR / System Admin. Bed counts, coverage targets and credential requirements follow unit scope |

## 3. Permission table

Generated from `backend/src/modules/users/permissions.ts`. **`backend/test/docs.test.ts` fails if this table and the code differ.** `EMPLOYEE` means any signed-in user; the service then limits them to their own records.

| Permission | Roles | Guards |
| :--- | :--- | :--- |
| `accounts.read` | HR_ADMIN, SYSTEM_ADMIN | List accounts |
| `accounts.write` | HR_ADMIN, SYSTEM_ADMIN | Provision, activate/deactivate, relink accounts |
| `roles.read` | HR_ADMIN, SYSTEM_ADMIN | List role assignments |
| `roles.write` | HR_ADMIN, SYSTEM_ADMIN | Grant, update, revoke role assignments |
| `approvals.read` | HR_ADMIN, SYSTEM_ADMIN | Four-eyes queue |
| `approvals.decide` | HR_ADMIN, SYSTEM_ADMIN | Approve / reject a request |
| `matrix.read` | EMPLOYEE | The §8.1 access matrix (read-only) |
| `workforce.read` | EMPLOYEE | Departments, units, positions, coverage targets, bed summary |
| `workforce.write` | HR_ADMIN, SYSTEM_ADMIN | Organisation changes (system-wide scope in the service except beds and targets) |
| `workforce.bedHistory` | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR | Bed change log of a unit in scope |
| `kpi.read` | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR | Nurse-to-bed KPI |
| `employees.read` | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR | Employee list and records (Supervisor: baseline view) |
| `employees.write` | HR_ADMIN, SYSTEM_ADMIN | Onboard, edit, soft-delete |
| `employees.position` | HR_ADMIN | Position change (E9) — System Admin excluded |
| `contracts.read` | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR | Contract list and records |
| `contracts.manage` | HR_ADMIN, SYSTEM_ADMIN | Create, renew, transition, upload contract copies |
| `roster.read` | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR | Roster board, pool, coverage |
| `roster.write` | SUPERVISOR | Draft, generate, publish (D-14) |
| `attendance.read` | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR | Clock events and the gap view |
| `audit.read` | SYSTEM_ADMIN | Audit search and chain verification (D-20) |
| `jobs.read` | SYSTEM_ADMIN | Background job runs |
| `jobs.run` | SYSTEM_ADMIN | Run a job now |
| `credentials.catalog.read` | EMPLOYEE | Credential types and categories |
| `credentials.catalog.write` | HR_ADMIN, SYSTEM_ADMIN | Credential type changes (system-wide, four-eyes — D-24, D-25) |
| `requirements.read` | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR | Unit credential requirements |
| `requirements.write` | HR_ADMIN, SYSTEM_ADMIN | Add / change / remove requirements in scope |
| `credentials.read` | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR | Credential records (Supervisor: compliance view) |
| `credentials.manage` | HR_ADMIN, SYSTEM_ADMIN | Record, verify, suspend, revoke, renewal decisions |
| `credentials.self` | EMPLOYEE | Own submission, evidence and renewal |
| `eligibility.read` | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR | Eligibility states in scope |
| `waivers.read` | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR | Waiver list |
| `waivers.write` | SUPERVISOR, HR_ADMIN | Issue a waiver (spec §6.1.2; System Admin excluded — D-28) |

### Routes with no permission (own records only)

These routes are open to any signed-in user; the service limits them to the caller's own records, or to a record the caller reaches through scope. The list is enforced by `backend/test/route-matrix.test.ts` (a new unchecked route fails the test):

- Auth: `GET /auth/me`, `GET /auth/sessions`, `POST /auth/password`
- PAM: `GET /pam/status`, `POST /pam/elevate` (needs a System Admin assignment), `POST /pam/end`
- Employees: `GET /employees/me`, `PATCH /employees/me/contact` (own phones — D-35), `GET /employees/:id` (own, or scoped HR / Supervisor)
- Contracts: `GET /contracts/me`, `GET /contracts/:id`, its documents (own, or scoped staff)
- Credentials: `GET /credentials/:id`, `POST /credentials/:id/renewal`, evidence upload / list / download (own, or scoped staff)
- Eligibility: `GET /eligibility/me`, `GET /eligibility/:id` (own, or scoped staff)
- Roster and attendance: `GET /roster/me`, `GET /attendance/me`
- Notifications: `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` (own rows only)

## 4. What each role sees (response fields)

| Record | HR Admin / System Admin (scoped) | Supervisor (scoped) | Employee (own) |
| :--- | :--- | :--- | :--- |
| Employee | Every field | **Baseline (D-36):** name, job number, unit, position, job title, specialty, status, hire date, contact email, mobile phone, actual work place. Hidden: salary, marital status, nationality, rank/grade, file number, job post location, emergency contact phone | Every field; may edit only the two phone numbers (D-35) |
| Contract | Full record and documents | Reduced read view (spec §8.1) | Own reduced view |
| Credential | Full record, tracking data, evidence | Compliance view: no tracking data (identity numbers), no pending values, **no evidence downloads** (spec §5.2, D5) | Own record and evidence |
| Emergency contact phone | Yes | **Never** | Yes |
| Audit trail | System Admin only (D-20); HR access is REQUIREMENT NOT ESTABLISHED | No | No |

## 5. Separation of duties

| Control | Rule | Enforced in |
| :--- | :--- | :--- |
| Four-eyes (R10–R12) | Promoting to System Admin, granting HR Admin with `SYSTEM` scope, upgrading an HR scope to `SYSTEM`, and **every credential type change** (D-24) are queued as `PENDING`; a **different** administrator approves; the action executes as the approver, re-checked, in the approval's transaction. Catalog requests are visible to system-wide admins only | `administration/approvals.ts`, `users/role-assignments.ts`, `credentials/catalog.ts` |
| No self-grant (R2) | Nobody grants, updates or revokes their own role | `users/role-assignments.ts` |
| No action on one's own credential (D-26) | Verify, approve/reject renewal, suspend/revoke, waive — refused on the actor's own credential, whatever their role | `credentials/records.ts`, `eligibility/service.ts` |
| Contract approval (D-30) | The creator and the submitter cannot approve (`SELF_APPROVAL_FORBIDDEN`) | `contracts/service.ts` |
| Own contract and own record (D-37) | Nobody creates, renews, transitions or uploads to their own contract, or deletes their own employee record (`SELF_ACTION_FORBIDDEN`). Basis cited by the owner: CBAHI HRM standards, NCA Essential Cybersecurity Controls, MHRSD / Saudi Labor Law (Qiwa) — control numbers to be added by the owner's compliance team | `contracts/service.ts`, `nurses/service.ts` |
| Own account link | An administrator cannot re-link their own account to another employee | `users/accounts.ts` |

## 6. Privileged access

**PAM (R13).** System Admin assignments are dormant. The holder elevates with a reason (≥ 10 characters) for 1–4 hours (default 2); elevation ends early on `POST /pam/end`. Expired elevations are ignored at once and removed and audited by the daily job.

**Break-glass (R18, spec §3.6, D-9).** One flagged account. A successful sign-in writes an irrevocable `break_glass_events` row (delete is rejected by trigger), a HIGH audit entry and a CRITICAL in-app notification to every System Admin. The session has root access without PAM or four-eyes and ends after 4 hours. It still **cannot issue waivers** (D-28). **Not built:** the SMS / e-mail alert to the CEO and IT Director (no SMTP/SMS decided).

## 7. Open access questions

| Item | Status |
| :--- | :--- |
| HR read access to the audit trail | REQUIREMENT NOT ESTABLISHED (D-20: System Admin only until decided) |
| Cross-unit read for Nurse Educators (spec §8.2) | Needs an explicit scope grant; no special role exists |
| Four-eyes for "changing security encryption keys" (spec §8.1) | No key-management feature exists in V04, so nothing to gate |
