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
| GET | `/api/v1/approvals?status=PENDING` | Four-eyes queue (role grants/updates; credential-type changes — visible to system-wide admins only) | HR, SA | backend |
| POST | `/api/v1/approvals/:id/approve` · `/reject` | Decide `{reason}` | HR, SA; approver ≠ initiator (R11) | backend |
| POST | `/api/v1/pam/elevate` · GET `/api/v1/pam/status` · POST `/api/v1/pam/end` | JIT elevation | users holding SA | backend |
| POST | `/api/v1/break-glass/activate` | Siren (R18) | break-glass account only | spec §3.6 — **scope decision D-9** |

**Implemented in commit 5 (notes):**
- Every route under `/api/v1` except health and `/auth/login|refresh|logout` passes one `authenticate` step; an anonymous caller gets 401 for any path, known or not.
- State-changing requests need `X-CSRF-Token` equal to the session's token (bound into the access token as a hash) and `Origin` equal to the app origin (spec §3.4 CsrfGuard).
- `[I]` responses carry identifiers only (`POST /users` → `{id}`; `POST /role-assignments` → `{status:'GRANTED', id}` or 202 `{status:'PENDING_APPROVAL', requestId}`), so stored idempotent responses hold no personal data.
- Four-eyes approval executes the stored action **as the approver**: every grant rule (R2–R6) is re-checked for them, inside the approval's transaction.

### 2.4 Workforce (`modules/workforce`) — implemented in commit 7

"System-wide" = an HR_ADMIN / SYSTEM_ADMIN assignment with SYSTEM scope. The organisation structure is one hospital-wide configuration (same principle as the credential catalog, D-25); bed counts and coverage targets follow unit scope.

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/departments?includeInactive` | List (active by default) | EMP | spec §2.9 |
| POST · PATCH | `/api/v1/departments`, `/:id` | Create / update / deactivate — refused while it has active units (W1) | HR, SA — system-wide | W1 |
| GET | `/api/v1/units?departmentId&includeInactive` | List | EMP | spec §2.9 |
| GET | `/api/v1/units/summary` | Live bed totals by department, active units (W3: the seeded 582 is not a constant) | EMP | kit |
| POST · PATCH | `/api/v1/units`, `/:id` | Create (initial beds logged) / rename / move department / deactivate — refused while it has active employees (W2) | HR, SA — system-wide | W2 |
| PUT | `/api/v1/units/:id/bed-capacity` | `{bedCount 0–500, reason}` → `UPDATED`/`UNCHANGED`; one log row per change (W4) | HR, SA — unit in scope | W4 |
| PUT | `/api/v1/units/bed-capacity/bulk` **[I]** | `{rows:[{unitCode, bedCount}], reason}` → per-row `UPDATED`/`UNCHANGED`/`REJECTED` (unknown code, out of scope, bad value, duplicate); applied rows commit together (W5) | HR, SA — rows outside scope rejected | W5 |
| POST | `/api/v1/units/import` **[I]** | `{csv, dryRun=true}`; header `unit_code,name,department_code,beds[,description]`; RFC 4180 quotes; ≤ 500 rows; never deletes or deactivates | HR, SA — system-wide | kit |
| GET | `/api/v1/units/:id/bed-history` | Log with actor name | HR, SA, SUP — unit in scope | W4 |
| GET | `/api/v1/positions?includeInactive` · `/:code` | Directory | EMP | spec §3.1.1 |
| POST · PATCH | `/api/v1/positions`, `/:code` | Create / update (tier from the §3.1.1 list) / deactivate — refused while held by active employees (W6). A schedulability change re-evaluates holders (L6) | HR, SA — system-wide | W6, W7 |
| GET · PUT | `/api/v1/coverage-targets?unitId` | `{unitId, shiftType, minimumStaff 0–999 \| null}`; `null` removes the target ("unspecified", never zero — W8) | read EMP; write HR, SA — unit in scope | spec §6.3 |
| GET | `/api/v1/kpi/nurse-to-bed?date&shift` | KPI A (ICU/ER/OR codes 1–4, averaged) and B (hospital-wide). Nurses = Published assignments on that date/shift; beds = active units. Response carries `thresholdSource` (card not in repository) | HR, SA, SUP | V03 `kpi.ts` — **D-11** |

### 2.5 Nurses (`modules/nurses`) — implemented in commit 7

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/employees?unitId&unassigned&positionCode&q&page&pageSize` | List | HR/SA scoped → `view: FULL`; SUP scoped → `view: BASELINE` (identity, unit, position, job title, specialty, status, hire date — salary, marital status, nationality, file no., rank, contact email, job post and work place suppressed) | spec §8.1 |
| GET | `/api/v1/employees/me` · `/:id` | Own profile (FULL) · one record, shaped by viewer | EMP own; HR, SUP scoped | spec §8.1 |
| POST | `/api/v1/employees/onboard` **[I]** | Employee + **Draft** contract (Hijri dates converted by the server) + HIGH audit + eligibility state in one transaction → `{employeeId, contractId}`. Defaults: Unassigned, position SN (E6). Job number unique regardless of case (E1) | HR, SA — unit in scope; Unassigned needs system-wide | spec §3.1, **D-3**, D-17 |
| PATCH | `/api/v1/employees/:id` | Source fields E1–E8 (not position); a unit move re-evaluates eligibility; salary values are not copied into the audit trail | HR, SA — old and new unit in scope | spec §3.1 |
| POST | `/api/v1/employees/:id/position` | `{positionCode, reason}`; rejects inactive/unchanged; HIGH audit from → to; re-evaluates eligibility | **HR_ADMIN only** (E9), scoped | E9 |
| DELETE | `/api/v1/employees/:id` | Soft delete, body `{reason ≥ 10}`; history kept; eligibility becomes INELIGIBLE; not on one's own record | HR, SA — scoped | spec |
| — | `PATCH /api/v1/employees/me` (own phone, spec §3.3) | **Not built:** the schema has no phone column | — | REQUIREMENT NOT ESTABLISHED |

### 2.6 Contracts (`modules/contracts`) — implemented in commit 7

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/contracts?employeeId&status&page&pageSize` | List | HR/SA scoped → FULL; SUP scoped → REDUCED (identifiers, employee/position, unit, status, dates) | spec §4.1 |
| GET | `/api/v1/contracts/me` · `/:id` | Own (REDUCED) · one, shaped by viewer | EMP own; HR, SUP scoped | spec §4.1 |
| GET | `/api/v1/contracts/creatable` · `/renewable` | New-contract picker (no Approved/Active contract, C10) · renewal picker with the C8 prefill | HR, SA scoped | C8, C10 |
| POST | `/api/v1/contracts` **[I]** | `{employeeId, startDate, endDate}` → Draft; refused if the employee already has an Approved/Active contract (use renewal) | HR, SA scoped; not own | C5, C6, C10 |
| POST | `/api/v1/contracts/:id/renew` **[I]** | From the employee's latest contract; dates default to the C8 prefill → Draft | HR, SA scoped; not own | C8 |
| POST | `/api/v1/contracts/:id/transition` | `{action, reason?}` per the D-29 map: `submit` (needs a CLEAN copy, C11), `return`\*, `approve` (Active if it covers today, else Approved; overlap checked, C4), `suspend`\*, `reinstate`\*, `terminate`\*. \* reason required. Expired only by the daily job; Superseded never by hand. Returns `{status, eligibility}` | HR, SA scoped; not own; **approver ≠ creator and ≠ submitter (D-30)** | spec §4.2, D-29, D-30 |
| POST | `/api/v1/contracts/:id/documents` | Contract copy: raw PDF body, `X-File-Name`; ≤ 10 MB; magic bytes (D1–D3) | HR, SA scoped; not own | D1–D3 |
| GET | `/api/v1/contracts/:id/documents` · `/:docId` | Versions · download (CLEAN only, audited, `nosniff`) | HR scoped; EMP own; **never SUP** (D5) | D4, D5 |

### 2.7 Credentials (`modules/credentials`) — implemented in commit 6

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/credential-categories` · `/api/v1/credential-templates?includeInactive` | Catalog | EMP | spec §5.1 |
| POST · PATCH | `/api/v1/credential-templates`, `/:id` | Template admin (fields, `gracePeriodDays` 0–90, activity) with `reason` (≥ 10). **202** `{status: PENDING_APPROVAL, requestId}` — applied only when a second system-wide admin approves via `/approvals/:id/approve` (D-24); break-glass → 201/200 `{status: APPLIED, template}`. Grace/expiry/activity changes re-evaluate holders | HR, SA — **system-wide scope only** (D-25) | spec §5.1, §6.1.1, R10 |
| GET | `/api/v1/credential-requirements?unitId&position&templateId` | Rules | HR, SA, SUP | spec §5.1.4 |
| POST · PUT · DELETE | `/api/v1/credential-requirements`, `/:id` | Rule CRUD; re-evaluates the unit in the same transaction; `{affectedEmployees}` | HR (unit in scope), SA | spec §5.1.4 |
| POST | `/api/v1/credential-requirements/bulk` | `{items[]}` in one transaction → `{created, updated, affectedEmployees}` | HR (scoped), SA | spec §5.1.4 |
| GET | `/api/v1/credentials?employeeId&templateId&status&queue=review` | List (review queue = pending verification, staged renewal or pending document) | HR/SA full (scoped); SUP compliance view (no tracking data, pending values or evidence) | spec §5.2, §8.1 |
| GET | `/api/v1/credentials/:id` | One record, shaped by viewer | owner, HR/SA scoped, SUP scoped | spec §5.2 |
| POST | `/api/v1/credentials` · `/api/v1/credentials/me` | Record → PendingVerification; tracking data validated against template fields | HR (scoped) · EMP own | spec §5.1.5 |
| GET | `/api/v1/credentials/me` · `/me/requirements` | Own records · rules that apply to me | EMP | spec §8.1 |
| POST | `/api/v1/credentials/:id/verify` `{documentId?}` | PendingVerification → Valid/ExpiringSoon/Expired by date; approves evidence | HR (scoped), not own | spec §5.2 |
| POST | `/api/v1/credentials/:id/suspend` · `/revoke` `{reason}` | L3; closes grace | HR (scoped), not own | spec §5.2 |
| POST | `/api/v1/credentials/:id/renewal` | Stage replacement data | EMP own, HR (scoped) | spec §5.2 |
| POST | `/api/v1/credentials/:id/renewal/approve` `{documentId?}` · `/renewal/reject` `{reason}` | Promote or discard; approval completes grace, rejection closes it | HR (scoped), not own | spec §5.2, §6.1.1 |
| POST | `/api/v1/credentials/:id/documents` | Raw body = file, `Content-Type` = its type, `X-File-Name`; PDF/JPEG/PNG/WebP, ≤ 10 MB, magic bytes must match | EMP own, HR (scoped) | spec §5.1.5 |
| GET | `/api/v1/credentials/:id/documents` · `/:docId` | Versions · download (CLEAN only, audited, `nosniff`) | EMP own, HR (scoped); **never SUP** (D5) | spec §5.2, §5.3.2 |

### 2.8 Eligibility (`modules/eligibility`) — implemented in commit 6

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/eligibility?unitId&status` | Materialized states with reasons | HR, SA, SUP (scoped) | spec §6.1 |
| GET | `/api/v1/eligibility/me` · `/:employeeId` | One stored state | EMP own; HR, SUP (scoped) | spec §6.1 |
| GET | `/api/v1/eligibility/:employeeId/evaluate?date=YYYY-MM-DD` | Live engine result for a day, not stored (the path publication will use, L7) | HR, SA, SUP (scoped) | spec §6.1 |
| POST | `/api/v1/eligibility/:employeeId/refresh` | Recalculate and store one nurse | HR, SA (scoped) | spec §6.1 |
| GET · POST | `/api/v1/waivers?employeeId&active`, `/api/v1/waivers` | List / create `{employeeId, templateId, reason, expiresAt}` (≤ 72 h, HIGH audit) | read HR, SA, SUP; **create SUP or HR only** (spec §6.1.2 — System Admin gets 403), scoped, not own | spec §6.1.2 |

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
