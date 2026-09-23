# API Map

## 1. Current state (V03)

### 1.1 Running API — `server/src/index.ts` (Express, port 3001, prefix `/api`)

| Method | Endpoint | Purpose | Auth | Permission | Request | Response | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| GET | `/api/health` | DB liveness | none | — | — | `{status, db}` / 503 | |
| POST | `/api/auth/login` | Password login | none | — | `{email, password}` | `{user, token, csrfToken, expiresIn}` + refresh/CSRF cookies | No rate limit; email only |
| POST | `/api/auth/refresh` | Rotate refresh, new access token | refresh cookie | Origin + CSRF double-submit | — | same as login | Reuse → family revoked |
| POST | `/api/auth/logout` | Revoke session | refresh cookie | none | — | 204 | Not CSRF-checked (low risk: only revokes) |
| GET | `/api/auth/me` | Current identity | Bearer | any | — | `{user}` | |
| GET | `/api/bootstrap` | **Every row of 12 tables** | Bearer | any authenticated | — | `{departments, units, …, auditEntries}` | Exposes salaries, contact emails, all credentials to EMPLOYEE role (violates R15/R16) |
| GET | `/api/:entity` | List a table | Bearer | any authenticated | — | array | 12 entities: departments, units, positions, employees, contracts, credential-categories, credential-templates, credential-requirements, credentials, shift-assignments, notifications, audit-entries |
| POST | `/api/:entity` | Create row | Bearer | HR_ADMIN, SYSTEM_ADMIN, DEVELOPER | raw model JSON | row | No validation, no business rules, client-supplied ids. 405 for notifications/audit-entries |
| PUT | `/api/:entity/:id` | Update row | Bearer | same | partial JSON | row | Any column, incl. `status`, `salary`, `deletedAt` |
| DELETE | `/api/:entity/:id` | Hard delete row | Bearer | same | — | 204 | Hard delete, whereas the UI soft-deletes |

**Effective route count:** 5 fixed + 12 list + 30 write routes (10 writable entities × 3). Prisma error codes map to 404/409/400; internal errors never echo messages (keep this).

### 1.2 Reference API — `backend/` (NestJS, port 3000, never running)

| Method | Endpoint | Purpose | Permission |
| :--- | :--- | :--- | :--- |
| GET | `/api/v1/roles/matrix` | Static role matrix | authenticated |
| GET | `/api/v1/roles/me` | Own assignments + effective roles | authenticated |
| GET | `/api/v1/roles/assignments?userId&role&scopeType&isActive&unitId` | List assignments | HR_ADMIN, SYSTEM_ADMIN (+PAM) |
| GET | `/api/v1/roles/assignments/:id` | One assignment (implemented by filtering the full list) | same |
| POST | `/api/v1/roles/assignments` + `Idempotency-Key` | Grant → 201, or 202 PENDING_APPROVAL | same |
| PATCH | `/api/v1/roles/assignments/:id` | Change scope/reason/expiry; → SYSTEM needs approval | same |
| DELETE | `/api/v1/roles/assignments/:id` `{reason}` | Revoke | same |
| GET | `'/../admin/approvals'` *(malformed path)* | Pending approvals | same |
| POST | `'/../admin/approvals/:id/approve'`, `/reject` | Four-eyes decision | same |
| POST | `'/../admin/pam/elevate'`, GET `/status` | PAM | SYSTEM_ADMIN |

### 1.3 Reference API — `wave1a-kit/` (NestJS, never running)

| Method | Endpoint | Purpose | Permission |
| :--- | :--- | :--- | :--- |
| GET | `/api/v1/units?departmentId&includeInactive` | List units | authenticated |
| GET | `/api/v1/units/summary` | Totals by department | authenticated |
| PUT | `/api/v1/units/bed-capacity/bulk` + `Idempotency-Key` | Bulk bed update | HR_ADMIN, SYSTEM_ADMIN |
| POST | `/api/v1/units/import` + `Idempotency-Key` | CSV import, dry-run default | HR_ADMIN, SYSTEM_ADMIN |
| PUT | `/api/v1/units/:id/bed-capacity` | Single update | HR_ADMIN, SYSTEM_ADMIN |
| GET | `/api/v1/units/:id/bed-history` | Bed log | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR |

### 1.4 Specified but never implemented (spec v2.8.7)

`/api/v1/positions` (CRUD), `/api/v1/departments`, `/api/v1/credential-templates` (CRUD), `/api/v1/credential-categories` (CRUD), `/api/v1/credential-requirements` (CRUD + `/bulk`), `/api/v1/workforce/onboard`, `/api/v1/workforce/invitations`, `/api/v1/workforce/publish`, evidence `/:evidenceId/download`, `/api/v1/auth/register`, `/api/v1/push/register|unregister|devices`, `/api/v1/fhir/Practitioner/:id`, `/api/v1/fhir/PractitionerRole/:id`. Tracker B-23 records a route disagreement (`/api/v1/positions` vs `/api/v1/workforce/positions`).

### 1.5 Duplicates and conflicts

| Issue | Detail |
| :--- | :--- |
| Two prefixes | Running `/api/…` vs spec/reference `/api/v1/…` |
| Two unit APIs | Generic `PUT /api/units/:id` (running) vs `/api/v1/units/*` (kit) |
| Generic vs domain | Every write goes through generic CRUD, so business rules (onboarding atomicity, overlap, publication gate, waiver limits) can be bypassed by calling the API directly |
| Mock API | `app/src/lib/api/roles.api.ts` simulates the NestJS roles API in localStorage |

---

## 2. V04 API (single, authoritative)

### 2.1 Conventions

- **Prefix `/api/v1`** (the spec's convention). No compatibility requirement exists for `/api/*`: the V04 frontend is rebuilt in the same repository, so the old routes are dropped rather than aliased.
- **Auth:** `Authorization: Bearer <access JWT>` on everything except health, login and refresh. The refresh cookie is scoped to `/api/v1/auth`.
- **Authorization:** middleware `authorize(permission)` resolves effective roles + scopes from `role_assignments` (fresh read per request, R9). The service layer then filters rows by scope. The "Scope" column below is the row filter.
- **Validation:** every body/query validated with a zod schema; unknown fields rejected.
- **Errors:** `{error: {code, message, details?}}`. Stable codes (`CONTRACT_PERIOD_OVERLAP`, `POSITION_NOT_ACTIVE`, `SELF_APPROVAL_FORBIDDEN`, …) carried over from V03 messages.
- **Idempotency-Key** (UUID v4) required where marked **[I]**.
- **Audit:** every mutation writes an audit row in the same transaction (A1).
- **Pagination:** list endpoints accept `?page&pageSize` (default 50, max 200) and return `{items, total}`.
- **Date windows** are bounded to 94 days (S6).

Role shorthand: **SA** SYSTEM_ADMIN (requires active PAM elevation, R13) · **HR** HR_ADMIN · **SUP** SUPERVISOR · **EMP** any authenticated user (implicit EMPLOYEE) · *own* = records linked to the caller's `User.employeeId`.

### 2.2 Platform & auth

| Method | Endpoint | Purpose | Permission | Request → Response | Source |
| :--- | :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/health` | Liveness + DB | public | → `{status, db}` | server |
| POST | `/api/v1/auth/login` | Login | public (rate-limited per account and per client) | `{email, password}` → `{token, csrfToken, expiresIn}` + `nurseapp_refresh` (HttpOnly, path `/api/v1/auth`) and `nurseapp_csrf` cookies; 429 `TOO_MANY_ATTEMPTS` + `Retry-After` | server |
| POST | `/api/v1/auth/refresh` | Rotate (atomic consume; replay → family revoked, `SESSION_REVOKED`) | cookie + Origin + CSRF double-submit | → `{token, csrfToken, expiresIn}` | server |
| POST | `/api/v1/auth/logout` | Revoke | cookie | → 204 | server |
| GET | `/api/v1/auth/me` | Identity, stored grants (SA marked `dormant` until PAM), effective roles, PAM and break-glass state | EMP | → `{user{id,email,displayName,employeeId,isBreakGlass}, roles[], effectiveRoles[], pam, breakGlass}` | server + backend `roles/me` |
| POST | `/api/v1/auth/password` | Change own password; revokes all sessions | EMP | `{currentPassword, newPassword}` → 204 | spec §3.3 (new) |

### 2.3 Users & roles (`modules/users`)

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/users` | List accounts | HR (scoped), SA | spec §8.1 Accounts |
| POST | `/api/v1/users` **[I]** | Provision account (optionally linked to an employee) | HR (scoped), SA | spec §8.1 |
| PATCH | `/api/v1/users/:id` | Activate/deactivate, relink employee | HR (scoped), SA | new |
| GET | `/api/v1/roles/matrix` | Static matrix §8.1–8.2 | EMP | backend |
| GET | `/api/v1/role-assignments?userId&role&scopeType&active&unitId` | List | HR (within scope), SA | backend |
| POST | `/api/v1/role-assignments` **[I]** | Grant → 201, or 202 `{status:'PENDING_APPROVAL', requestId}` | HR, SA (R2–R7, R10) | backend |
| PATCH | `/api/v1/role-assignments/:id` | Scope/reason/expiry | HR, SA | backend |
| POST | `/api/v1/role-assignments/:id/revoke` | Revoke `{reason}` (POST, not DELETE-with-body) | HR, SA (R2, R8) | backend |
| GET | `/api/v1/approvals?status=PENDING` | Four-eyes queue | HR, SA | backend |
| POST | `/api/v1/approvals/:id/approve` · `/reject` | Decide `{reason}` | HR, SA; approver ≠ initiator (R11) | backend |
| POST | `/api/v1/pam/elevate` · GET `/api/v1/pam/status` · POST `/api/v1/pam/end` | JIT elevation | users holding SA | backend |
| POST | `/api/v1/break-glass/activate` | Siren (R18) | break-glass account only | spec §3.6 — **scope decision D-9** |

**Implemented in commit 5 (notes):**
- Every route under `/api/v1` except health and `/auth/login|refresh|logout` passes one `authenticate` step; an anonymous caller gets 401 for any path, known or not.
- State-changing requests need `X-CSRF-Token` equal to the session's token (bound into the access token as a hash) and `Origin` equal to the app origin (spec §3.4 CsrfGuard).
- `[I]` responses carry identifiers only (`POST /users` → `{id}`; `POST /role-assignments` → `{status:'GRANTED', id}` or 202 `{status:'PENDING_APPROVAL', requestId}`), so stored idempotent responses hold no personal data.
- Four-eyes approval executes the stored action **as the approver**: every grant rule (R2–R6) is re-checked for them, inside the approval's transaction.

### 2.4 Workforce (`modules/workforce`)

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/departments` | List | EMP | server generic → domain |
| POST · PATCH | `/api/v1/departments`, `/:id` | Create / update / deactivate (W1) | HR, SA | server generic + store guard |
| GET | `/api/v1/units?departmentId&includeInactive` | List | EMP | kit |
| POST · PATCH | `/api/v1/units`, `/:id` | Create / update / deactivate (W2) | HR, SA | server generic + store |
| GET | `/api/v1/units/summary` | Bed totals by department | EMP | kit |
| PUT | `/api/v1/units/:id/bed-capacity` | Single change `{bedCount, reason}` (W4) | HR, SA | kit |
| PUT | `/api/v1/units/bed-capacity/bulk` **[I]** | Bulk (W5) → per-row results | HR, SA | kit |
| POST | `/api/v1/units/import` **[I]** | CSV `{csv, dryRun=true}` | HR, SA | kit |
| GET | `/api/v1/units/:id/bed-history` | Log | HR, SA, SUP (scoped) | kit |
| GET | `/api/v1/positions` · `/:code` | Directory | EMP | spec |
| POST · PATCH | `/api/v1/positions`, `/:code` | Create / update / deactivate (W6) | HR, SA | spec + store |
| GET · PUT | `/api/v1/coverage-targets?unitId` | Configured minimums (W8) | read EMP; write HR, SA | spec §6.3 (new) |
| GET | `/api/v1/kpi/nurse-to-bed?date&shift` | Ada'a KPI A/B | HR, SA, SUP | app `kpi.ts` — **K1 decision** |

### 2.5 Nurses (`modules/nurses`)

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/employees?unitId&positionCode&q` | List | HR (scoped, all fields); SUP (assigned units, private fields suppressed: salary, marital status, nationality… — list in RBAC.md); EMP → own only | spec §8.1 |
| GET | `/api/v1/employees/:id` | Detail | same field rules | spec §8.1 |
| POST | `/api/v1/employees/onboard` **[I]** | Contract-first atomic onboarding: employee + contract + (optional) contract copy + audit | HR (scoped), SA | store `addEmployee` + V36b — **C-1** |
| PATCH | `/api/v1/employees/:id` | Update source fields (E1–E8) | HR (scoped), SA | store |
| PATCH | `/api/v1/employees/me` | Own phone (spec §3.3) | EMP | spec |
| POST | `/api/v1/employees/:id/position` | Position assignment (E9) | HR (scoped). SA? (store allowed DEVELOPER only) | store |
| DELETE | `/api/v1/employees/:id` | Soft delete (`deletedAt`) | HR, SA | store |

### 2.6 Contracts (`modules/contracts`)

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/contracts?employeeId&status` | List | HR (full); SUP (reduced view, scoped); EMP own (reduced) | spec §4.1 |
| GET | `/api/v1/contracts/renewable` · `/creatable` | Employee pickers (C7, C10) | HR | ContractsPage filters |
| POST | `/api/v1/contracts` **[I]** | Create (C4, C5, C9, C11) — multipart with PDF | HR | store `addContract` + page |
| POST | `/api/v1/contracts/:id/renew` **[I]** | Renewal from prior (C7, C8) | HR | ContractsPage |
| POST | `/api/v1/contracts/:id/transition` | `{to, reason}` via transition map (C1–C3) | HR | new (V03 had free dropdown) |
| POST | `/api/v1/contracts/:id/documents` | Add contract-copy version (D1–D3) | HR | store `attachContractCopy` |
| GET | `/api/v1/contracts/:id/documents/:version/download` | Stream if CLEAN (D4) | HR; EMP own | store getter |

### 2.7 Credentials (`modules/credentials`)

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/credential-catalog` | Categories + templates | EMP | spec |
| POST · PATCH | `/api/v1/credential-templates`, `/:id` | Template admin (incl. `gracePeriodDays`) | HR, SA | spec |
| GET · POST · PATCH · DELETE | `/api/v1/credential-requirements`, `/:id` | Requirement rules (changing *global* rules → four-eyes? R10) | HR, SA | store + spec |
| GET | `/api/v1/credentials?employeeId&status&expiringWithinDays` | List | HR (scoped); SUP compliance view (no ids/pending/downloads, D5); EMP own | spec §5.2 |
| POST | `/api/v1/credentials` | Record credential + evidence (multipart) → PendingVerification | HR (scoped); EMP own | store |
| POST | `/api/v1/credentials/:id/documents` | New evidence version | HR; EMP own | store |
| POST | `/api/v1/credentials/:id/verify` | PendingVerification → Valid | HR (scoped) | spec §5.2 (**missing in V03**) |
| POST | `/api/v1/credentials/:id/renewal` · `/renewal/approve` · `/renewal/reject` | Staged renewal | EMP own (submit); HR (decide) | spec §5.2 |
| POST | `/api/v1/credentials/:id/suspend` · `/revoke` | Validity decision (L3) | HR | spec §5.2 |
| GET | `/api/v1/credentials/:id/documents/:version/download` | If CLEAN | HR; EMP own; **never SUP** | spec |

### 2.8 Eligibility (`modules/eligibility`)

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/eligibility?unitId&status` | Materialized states | HR, SUP (scoped) | store |
| GET | `/api/v1/eligibility/:employeeId?date` | State + reasons, or a live check for a shift date | HR, SUP (scoped); EMP own | spec §6.1 |
| POST | `/api/v1/eligibility/refresh` | Recalculate `{employeeIds?}` | HR, SA | store `refreshAll` |
| GET · POST | `/api/v1/waivers`, `/api/v1/waivers` | List / create (L9) | SUP (scoped), HR | store `addWaiver` |

### 2.9 Scheduling (`modules/scheduling`)

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/roster?unitId&from&to` (≤ 94 days) | Board | SUP (scoped, drafts + published); HR read; EMP → published own/home-unit only (S2) | SchedulingModule |
| GET | `/api/v1/roster/pool?unitId&date&shift` | Eligible candidates | SUP (scoped) | spec §6.1 |
| POST | `/api/v1/shift-assignments` | Draft assignment (S1 + engine check) | SUP (scoped) — **C-9** | store |
| DELETE | `/api/v1/shift-assignments/:id` | Remove draft / cancel published | SUP (scoped) | store |
| POST | `/api/v1/roster/auto-generate` | Draft fill (dry-run default) | SUP (scoped) | SchedulingModule |
| POST | `/api/v1/roster/publish` **[I]** | `{unitId, from, to}` → one transaction, engine re-validation (L7, S3) → `{published, blocked[]}` | SUP (scoped) — **C-9** | store + spec §6.2 |
| GET | `/api/v1/coverage?unitId&from&to` | Draft and published counts vs targets (S4, S5) | SUP, HR | spec §6.3 |

### 2.10 Attendance (`modules/attendance`)

| Method | Endpoint | Purpose | Permission | Source |
| :--- | :--- | :--- | :--- | :--- |
| POST | `/api/v1/attendance/events` | Ingest clock events (feed) | service credential — **integration contract not established** (B-15) | spec §14.2 |
| GET | `/api/v1/attendance/events?employeeId&from&to` | List | HR, SUP (scoped); EMP own | spec |
| GET | `/api/v1/attendance/gaps?unitId&date` | Published shifts without clock-in after 15 min | SUP, HR | spec §14.2 |

### 2.11 Notifications & audit

| Method | Endpoint | Purpose | Permission | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/notifications?unread` | Own notifications only (N2) | EMP | spec §7 |
| POST | `/api/v1/notifications/:id/read` | Acknowledge own | EMP (recipient only) | store |
| GET | `/api/v1/audit?resource&resourceId&actor&action&from&to` | Search | SA; HR scoped? (**REQUIREMENT NOT ESTABLISHED** — spec defines an `audit_reader` DB role only) | AuditModule |
| GET | `/api/v1/audit/verify?limit` | Chain check (`audit_chain_breaks`) | SA | gate1 |

### 2.12 Removed from V03

| Removed | Replaced by |
| :--- | :--- |
| `GET /api/bootstrap` | Per-module list endpoints with scope + field filtering |
| `GET/POST/PUT/DELETE /api/:entity[/:id]` (all 47 routes) | Domain endpoints above |
| Hard `DELETE` of employees/contracts/units | Soft delete / deactivate / status transitions |
| localStorage roles mock | `/api/v1/role-assignments`, `/api/v1/approvals` |

Scheduled jobs (no HTTP): contract/credential daily scan (N1), credential status transition by date, contract Active → Expired by end date, eligibility daily transition (L6), grace expiry (L8), waiver expiry, role-assignment expiry (R5), PAM expiry (R13), idempotency cleanup. Each runs under a worker lease.
