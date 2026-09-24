# API

The single V04 HTTP API. Every business rule behind these endpoints is enforced in the backend services and database; the frontend only calls them. Section numbers (§2.x) are cited from code comments, so they stay stable.

- Who may call what: [RBAC.md](RBAC.md) (generated from `backend/src/modules/users/permissions.ts` and checked by a test).
- Owner decisions (D-n) referenced below: [V04_ARCHITECTURE_PLAN.md §9a](V04_ARCHITECTURE_PLAN.md#9a-decision-record-2026-09-23).
- The V03 endpoints this API replaced: [Appendix A](#appendix-a--v03-api-historical).

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
| GET | `/api/v1/health` | Liveness + DB | public | → 200 `{status: ok, database: up}` · 503 `{status: degraded, database: down}` | server |
| POST | `/api/v1/auth/login` | Login | public (rate-limited per account and per client) | `{email, password}` → `{token, csrfToken, expiresIn}` + `nurseapp_refresh` (HttpOnly, path `/api/v1/auth`) and `nurseapp_csrf` cookies; 429 `TOO_MANY_ATTEMPTS` + `Retry-After` | server |
| POST | `/api/v1/auth/refresh` | Rotate (atomic consume; replay → family revoked, `SESSION_REVOKED`) | cookie + Origin + CSRF double-submit | → `{token, csrfToken, expiresIn}` | server |
| POST | `/api/v1/auth/logout` | Revoke the whole session family; clears both cookies | cookie + Origin + CSRF double-submit | → 204 | server |
| POST | `/api/v1/auth/password-reset/request` | "Forgot password?" (D-50) | public (Origin check; per-address and per-client limits) | `{email}` → always 202 `{accepted: true}`: a 30-minute link is e-mailed only to an active **staff** account (no HR / Supervisor / System Admin assignment, not break-glass); nothing reveals whether the address exists. 429 + `Retry-After` | D-50 |
| POST | `/api/v1/auth/password-reset/complete` | Set a new password with the e-mailed link | public (Origin check; per-client limit) | `{token, password 12–72}` → 204; signs out every session of the account and clears its sign-in lockout. Invalid, used, expired or superseded link (or a staff link after a promotion) → 400 `PASSWORD_RESET_INVALID` | D-50 |
| POST | `/api/v1/auth/invitations/preview` | Registration step 1 (spec §3.2) | public (Origin check; per-client limit) | `{token, jobNumber}` → `{fullName, jobNumber, unit, unitAr, position, positionAr, emailHint, expiresAt}` (e-mail masked); any bad token / Job Number → 400 `INVITATION_INVALID`; 429 + `Retry-After` | spec §3.2 |
| POST | `/api/v1/auth/invitations/claim` | Registration step 2: create the account | public (Origin check; per-client limit) | `{token, jobNumber, email, password 12–72}` → 201 `{userId}`; exactly one account per invitation and per employee, staff self-service role only; any mismatch → 400 `INVITATION_INVALID` | spec §3.2 |
| GET | `/api/v1/auth/me` | Identity, stored grants (SA marked `dormant` until PAM), effective roles, PAM and break-glass state | EMP | → `{user{id,email,displayName,employeeId,isBreakGlass}, roles[], effectiveRoles[], pam, breakGlass}` | server + backend `roles/me` |
| GET | `/api/v1/auth/sessions` | Own sign-in history: one entry per session family — signed in / last active, sign-in and last IP and browser, current, active (**D-22**, commit 9) | EMP (own only) | → `{items[]}` | spec §3.3 |
| POST | `/api/v1/auth/password` | Change own password; revokes all sessions | EMP | `{currentPassword, newPassword}` → 204 | spec §3.3 (new) |

### 2.3 Users & roles (`modules/users`)

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/users` | List accounts | HR (scoped), SA | spec §8.1 Accounts |
| POST | `/api/v1/users` **[I]** | Provision account (optionally linked to an employee) | HR (scoped), SA | spec §8.1 |
| POST | `/api/v1/users/:id/password-reset` | HR-assisted reset (D-50): e-mails a 24-hour link to the **account's own** address (never returned) → 202 `{email, expiresAt}`. Any active account in scope; 403 `SELF_ACTION_FORBIDDEN` (own account — use change password) · `BREAK_GLASS_ACCOUNT_PROTECTED`; 409 `ACCOUNT_INACTIVE` · `EMAIL_OFF` | HR (scoped), SA (`accounts.write`) | D-50 |
| POST | `/api/v1/employees/:id/invitations` | Invite the employee to register: e-mails a single-use 72-hour link to the contact e-mail (the token is never returned); revokes earlier open invitations. 409 `EMPLOYEE_HAS_ACCOUNT` · `NO_CURRENT_CONTRACT` · `CONTACT_EMAIL_INVALID` · `EMAIL_IN_USE` · `EMAIL_OFF` → `{id, email, expiresAt}` | HR (scoped), SA (`accounts.write`) | spec §3.2 |
| GET | `/api/v1/employees/:id/invitations` | Invitation history: `OPEN` / `CLAIMED` / `REVOKED` / `EXPIRED` (never the token) | HR (scoped), SA (`accounts.read`) | spec §3.2 |
| PATCH | `/api/v1/users/:id` | Activate/deactivate, relink employee | HR (scoped), SA | new |
| GET | `/api/v1/roles/matrix` | Static matrix §8.1–8.2 | EMP | backend |
| GET | `/api/v1/role-assignments?userId&role&scopeType&active&unitId` | List | HR (within scope), SA | backend |
| POST | `/api/v1/role-assignments` **[I]** | Grant → 201, or 202 `{status:'PENDING_APPROVAL', requestId}` | HR, SA (R2–R7, R10) | backend |
| PATCH | `/api/v1/role-assignments/:id` | Scope/reason/expiry | HR, SA | backend |
| POST | `/api/v1/role-assignments/:id/revoke` | Revoke `{reason}` (POST, not DELETE-with-body) | HR, SA (R2, R8) | backend |
| GET | `/api/v1/approvals?status=PENDING` | Four-eyes queue (role grants/updates; credential-type changes — visible to system-wide admins only) | HR, SA | backend |
| POST | `/api/v1/approvals/:id/approve` · `/reject` | Decide `{reason}` | HR, SA; approver ≠ initiator (R11); both decisions check request scope (catalog: system-wide) | backend |
| POST | `/api/v1/approvals/:id/withdraw` | Initiator withdraws their own pending request with `{reason}`; returns terminal `WITHDRAWN` status and never executes the payload | HR, SA; initiator only; row-locked against concurrent approval/rejection | backend |
| POST | `/api/v1/pam/elevate` · GET `/api/v1/pam/status` · POST `/api/v1/pam/end` | JIT elevation | users holding SA | backend |
| POST | `/api/v1/break-glass/activate` | Siren (R18) | break-glass account only | spec §3.6 — **scope decision D-9** |
| POST | `/api/v1/admin/baseline-import/preview` | `{file}` → per-row CREATE / UNCHANGED / CONFLICT / REJECTED report, totals (beds, fields), `canImport`; writes nothing | `baseline.import` — hospital-wide scope | **D-42** (P7) |
| POST | `/api/v1/admin/baseline-import` | `{file, reason ≥ 10}` → **202** `{status: PENDING_APPROVAL, requestId, report}`; refused with any conflict or rejection (`BASELINE_NOT_IMPORTABLE`) or nothing new (`NOTHING_TO_IMPORT`). A second hospital-wide admin approves via `/approvals/:id/approve`; the file is re-checked (`BASELINE_CHANGED_SINCE_REQUEST`) and applied in one transaction. Break-glass → 201 applied | `baseline.import` — hospital-wide scope | **D-42** (P7) |

**Implemented in commit 5 (notes):**
- Every route under `/api/v1` except health, `/auth/login|refresh|logout` and `/auth/invitations/preview|claim` and `/auth/password-reset/request|complete` passes one `authenticate` step; an anonymous caller gets 401 for any path, known or not.
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
| POST · PATCH | `/api/v1/units`, `/:id` | Create (initial beds logged) / rename / move department / set `criticalArea` (ICU / ER / OR / null) / deactivate — refused while it has active employees (W2) | HR, SA — system-wide | W2 |
| PUT | `/api/v1/units/:id/bed-capacity` | `{bedCount 0–500, reason}` → `UPDATED`/`UNCHANGED`; one log row per change (W4) | HR, SA — unit in scope | W4 |
| PUT | `/api/v1/units/bed-capacity/bulk` **[I]** | `{rows:[{unitCode, bedCount}], reason}` → per-row `UPDATED`/`UNCHANGED`/`REJECTED` (unknown code, out of scope, bad value, duplicate); applied rows commit together (W5) | HR, SA — rows outside scope rejected | W5 |
| POST | `/api/v1/units/import` **[I]** | `{csv, dryRun=true}`; header `unit_code,name,department_code,beds[,description]`; RFC 4180 quotes; ≤ 500 rows; never deletes or deactivates | HR, SA — system-wide | kit |
| GET | `/api/v1/units/:id/bed-history` | Log with actor name | HR, SA, SUP — unit in scope | W4 |
| GET | `/api/v1/positions?includeInactive` · `/:code` | Directory | EMP | spec §3.1.1 |
| POST · PATCH | `/api/v1/positions`, `/:code` | Create / update (tier from the §3.1.1 list) / deactivate — refused while held by active employees (W6). A schedulability change re-evaluates holders (L6) | HR, SA — system-wide | W6, W7 |
| GET · PUT | `/api/v1/coverage-targets?unitId` | `{unitId, shiftType, minimumStaff 0–999 \| null}`; `null` removes the target ("unspecified", never zero — W8) | read EMP; write HR, SA — unit in scope | spec §6.3 |
| GET | `/api/v1/kpi/nurse-to-bed?date&shift` | KPI A (units whose `criticalArea` is ICU/ER/OR — set per unit by HR; codes 1–4, averaged) and B (hospital-wide). Nurses = Published assignments on that date/shift; beds = active units. Response carries `thresholdSource` (card not in repository) | HR, SA, SUP | V03 `kpi.ts` — **D-11** |

### 2.5 Nurses (`modules/nurses`) — implemented in commit 7

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/employees?unitId&unassigned&positionCode&q&page&pageSize` | List | HR/SA scoped → `view: FULL`; SUP scoped → `view: BASELINE` (identity, unit, position, job title, specialty, status, hire date, contact email, mobile phone, actual work place — salary, marital status, nationality, file no., rank, job post and emergency contact phone suppressed) | spec §8.1, **D-36** |
| GET | `/api/v1/employees/onboarding-defaults` | Rule E6 defaults: `{unitId: null, positionCode}` — the default position only if the hospital has it active, else `null` (onboarding then requires a position: `POSITION_REQUIRED`) | HR, SA | E6, **D-42** (P4) |
| GET | `/api/v1/employees/me` · `/:id` | Own profile (FULL) · one record, shaped by viewer | EMP own; HR, SUP scoped | spec §8.1 |
| POST | `/api/v1/employees/onboard` **[I]** | Employee + **Draft** contract (Hijri dates converted by the server) + HIGH audit + eligibility state in one transaction → `{employeeId, contractId}`. Defaults: Unassigned, position SN (E6). Job number unique regardless of case (E1) | HR, SA — unit in scope; Unassigned needs system-wide | spec §3.1, **D-3**, D-17 |
| PATCH | `/api/v1/employees/:id` | Source fields E1–E8 and the two phones (not position); a unit move re-evaluates eligibility; salary and emergency-phone values are not copied into the audit trail | HR, SA — old and new unit in scope | spec §3.1, D-35 |
| POST | `/api/v1/employees/:id/position` | `{positionCode, reason}`; rejects inactive/unchanged; HIGH audit from → to; re-evaluates eligibility | **HR_ADMIN only** (E9), scoped | E9 |
| DELETE | `/api/v1/employees/:id` | Soft delete, body `{reason ≥ 10}`; history kept; eligibility becomes INELIGIBLE; not on one's own record | HR, SA — scoped | spec |
| PATCH | `/api/v1/employees/me/contact` | Own `primaryPhone` / `emergencyContactPhone` only (E.164 `+` 8–15 digits; separators removed; `null` clears); any other field → 400 `VALIDATION_FAILED`; audited `EMPLOYEE_CONTACT_UPDATED` | EMP own record (no permission; `NO_EMPLOYEE_RECORD` if unlinked) | spec §3.3, **D-35** |

### 2.6 Contracts (`modules/contracts`) — implemented in commit 7

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/contracts?employeeId&status&page&pageSize` | List | HR/SA scoped → FULL; SUP scoped → REDUCED (identifiers, employee/position, unit, status, dates) | spec §4.1 |
| GET | `/api/v1/contracts/me` · `/:id` | Own (REDUCED) · one, shaped by viewer | EMP own; HR, SUP scoped | spec §4.1 |
| GET | `/api/v1/contracts/creatable` · `/renewable` | New-contract picker (no Approved/Active contract, C10) · renewal picker with the C8 prefill. `?q=` searches job number or name (case-insensitive) across the whole scope; `?limit=` 1–50 (default 20); `total` counts every match | HR, SA scoped | C8, C10 |
| POST | `/api/v1/contracts` **[I]** | `{employeeId, startDate, endDate}` → Draft; refused if the employee already has an Approved/Active contract (use renewal) | HR, SA scoped; not own | C5, C6, C10 |
| POST | `/api/v1/contracts/:id/renew` **[I]** | From the employee's latest contract; dates default to the C8 prefill → Draft | HR, SA scoped; not own | C8 |
| POST | `/api/v1/contracts/:id/transition` | `{action, reason?}` per the D-29 map: `submit` (needs a CLEAN copy, C11), `return`\*, `approve` (Active if it covers today, else Approved; overlap checked, C4), `suspend`\*, `reinstate`\*, `terminate`\*. \* reason required. Expired only by the daily job; Superseded never by hand. Returns `{status, eligibility}` | HR, SA scoped; not own; **approver ≠ creator and ≠ submitter (D-30)** | spec §4.2, D-29, D-30 |
| POST | `/api/v1/contracts/:id/documents` | Contract copy: raw PDF body, `X-File-Name`; ≤ 10 MB; magic bytes; malware scan — 422 `UPLOAD_INFECTED`, 503 `SCANNER_UNAVAILABLE` (D1–D3) | HR, SA scoped; not own | D1–D3 |
| GET | `/api/v1/contracts/:id/documents` · `/:docId` | Versions · download (CLEAN only, audited, `nosniff`) | HR scoped; EMP own; **never SUP** (D5) | D4, D5 |

### 2.7 Credentials (`modules/credentials`) — implemented in commit 6

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/credential-categories` · `/api/v1/credential-templates?includeInactive` | Catalog | EMP | spec §5.1 |
| POST · PATCH | `/api/v1/credential-templates`, `/:id` | Template admin (fields, `gracePeriodDays` 0–90, activity) with `reason` (≥ 10). **202** `{status: PENDING_APPROVAL, requestId}` — applied only when a second system-wide admin approves via `/approvals/:id/approve` (D-24); break-glass → 201/200 `{status: APPLIED, template}`. Grace/expiry/activity changes re-evaluate holders | HR, SA — **system-wide scope only** (D-25) | spec §5.1, §6.1.1, R10 |
| POST · PATCH | `/api/v1/credential-categories`, `/:code` | Create / change a category `{code, name, description?, displayOrder, reason ≥ 10}` → **202** pending approval by a second system-wide admin (`CATEGORY_CHANGED_SINCE_REQUEST` if it changed meanwhile); break-glass → applied | HR, SA — **system-wide scope only** | **D-42** (P8) |
| GET | `/api/v1/credential-requirements?unitId&position&templateId` | Rules filtered to caller's units (out-of-scope `unitId` returns an empty list) | HR, SA, SUP — scoped | spec §5.1.4 |
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
| POST | `/api/v1/credentials/:id/documents` | Raw body = file, `Content-Type` = its type, `X-File-Name`; PDF/JPEG/PNG/WebP, ≤ 10 MB, magic bytes must match; malware scan — 422 `UPLOAD_INFECTED`, 503 `SCANNER_UNAVAILABLE` | EMP own, HR (scoped) | spec §5.1.5 |
| GET | `/api/v1/credentials/:id/documents` · `/:docId` | Versions · download (CLEAN only, audited, `nosniff`) | EMP own, HR (scoped); **never SUP** (D5) | spec §5.2, §5.3.2 |

### 2.8 Eligibility (`modules/eligibility`) — implemented in commit 6

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/eligibility?unitId&status` | Materialized states with reasons | HR, SA, SUP (scoped) | spec §6.1 |
| GET | `/api/v1/eligibility/me` · `/:employeeId` | One stored state | EMP own; HR, SUP (scoped) | spec §6.1 |
| GET | `/api/v1/eligibility/:employeeId/evaluate?date=YYYY-MM-DD` | Live engine result for a day, not stored (the path publication will use, L7) | HR, SA, SUP (scoped) | spec §6.1 |
| POST | `/api/v1/eligibility/:employeeId/refresh` | Recalculate and store one nurse | HR, SA (scoped) | spec §6.1 |
| GET · POST | `/api/v1/waivers?employeeId&active`, `/api/v1/waivers` | List / create `{employeeId, templateId, reason, expiresAt}` (≤ 72 h, HIGH audit) | read HR, SA, SUP; **create SUP or HR only** (spec §6.1.2 — System Admin gets 403), scoped, not own | spec §6.1.2 |

### 2.9 Scheduling (`modules/scheduling`) — implemented in commit 8

Eligibility in every response is the **live engine for the shift date** (L7), not the stored snapshot. A nurse is scheduled only in their **home unit** (D-32). Windows are 1–94 days (S6).

| Method | Endpoint | Purpose | Permission / scope | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/roster?unitId&from&to` | Board: non-cancelled assignments with live eligibility, and coverage per date × shift | HR, SA, SUP — unit in scope (read) | spec §6.2 |
| GET | `/api/v1/roster/me?from&to` | Own published shifts (any unit) + home-unit published schedule with notes (S2) | EMP | spec §6.2 |
| GET | `/api/v1/roster/pool?unitId&date&shiftType` | Home-unit candidates not already in that slot, ranked by live eligibility, with their other shifts that day | SUP — unit in scope | spec §6.1 |
| POST | `/api/v1/shift-assignments` | `{employeeId, unitId, shiftDate, shiftType, notes?}` → Draft (+ live eligibility). Refused: other unit (`NOT_HOME_UNIT`), past date, same slot twice (S1, `SHIFT_SLOT_TAKEN`) | **SUP only** — unit in scope (D-14) | S1 |
| DELETE | `/api/v1/shift-assignments/:id` | Draft → deleted; Published → Cancelled with body `{reason}` (HIGH audit) | SUP — unit in scope | spec §6.2 |
| POST | `/api/v1/roster/auto-generate` | `{unitId, from, to, dryRun=true}`: drafts up to each configured target from eligible home-unit nurses; unset targets reported (D-16); at most one auto-filled shift per nurse per day; fewest shifts first | SUP — unit in scope | V03 board (formula removed) |
| POST | `/api/v1/roster/publish` **[I]** | `{unitId, from, to}` → one transaction, per-unit advisory lock; each draft re-validated (L7, S3); ineligible stays Draft with reasons → `{published, blocked[], reliedOnGraceOrWaiver[]}`; reliance also stored as `eligibilityAtPublish` and in the HIGH audit (L8) | SUP — unit in scope | spec §6.2 |
| GET | `/api/v1/coverage?unitId&from&to` | Per date × shift: target (`null` = unspecified), draft and published `{total, eligible}`, `publishedShortage` (warning only, S4) | HR, SA, SUP — scoped | spec §6.3 |
| — | Revalidation (no endpoint) | Every eligibility refresh (credential, contract, position, requirement, waiver, unit move, deletion) re-checks the nurse's future published shifts; an invalid one returns to Draft, HIGH audit `ASSIGNMENT_DEMOTED`, COVERAGE notice to the unit's supervisors | — | spec §6.2 |

### 2.10 Attendance (`modules/attendance`) — implemented in commit 8 (read side)

| Method | Endpoint | Purpose | Permission | Source |
| :--- | :--- | :--- | :--- | :--- |
| POST | `/api/v1/attendance/events` | Ingest from the badge system (PACS) | **Not built** — integration contract not established (B-15, **D-33**) | spec §14.2 |
| GET | `/api/v1/attendance/events?employeeId\|unitId&from&to` | Clock events (≤ 94 days) | HR, SA, SUP — scoped | spec §14.2 |
| GET | `/api/v1/attendance/me?from&to` | Own clock events | EMP | spec |
| GET | `/api/v1/attendance/gaps?unitId&date` | Published shifts of a unit/date vs clock-ins: `UPCOMING`, `PENDING`, `MISSING` (no clock-in from **30 min before** the start — D-38 — and **30 min** passed since the start), `PRESENT`, `INELIGIBLE_ON_DUTY` (clocked in, engine blocks today). Shift times from D-31 | HR, SA, SUP — scoped | spec §14.2 (30 min; the earlier "15 min" in this map was wrong); response has `gapMinutes`, `earlyClockInMinutes` |

### 2.11 Notifications, audit and jobs — implemented in commit 9

| Method | Endpoint | Purpose | Permission | Source |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/notifications?unread&page&pageSize` | Own notifications with the unread count | EMP (own only, N2) | spec §7.1 |
| POST | `/api/v1/notifications/:id/read` · `/read-all` | Acknowledge own; another user's id is 404 | EMP (recipient only) | spec §7.1 |
| GET | `/api/v1/audit?resource&resourceId&actor&action&priority&from&to&page` | Search, newest first; BIGINT ids as strings; actor names resolved | **SA only (D-20)** | spec §9.1 |
| GET | `/api/v1/audit/verify` | Chain check (`audit_chain_breaks` view: link and content) | SA | spec §9.1, A3 |
| GET | `/api/v1/admin/jobs` | Jobs, schedules and last 10 runs each | SA | plan "Jobs" |
| GET | `/api/v1/system/health/business` | Business health: `{status: HEALTHY \| ATTENTION, issues[], eligibility {lastAuditAt, lastChecked, lastDrifted, checked7d, drifts7d, driftRate7d, recentDrifts[]}, jobs[] {lastCompletedAt, ageMinutes, stale, lastAttemptFailed}, email {pendingOver15Minutes, failedLast24Hours, lastSentAt}}` | SA (`jobs.read`) | spec §10.8 |
| POST | `/api/v1/admin/jobs/:name/run` | Run now under its own run key (never consumes the scheduled period); HIGH audit | SA | plan "Jobs" |

**Scheduled jobs** (`backend/src/jobs/`; in the API process when `JOBS_MODE=in-process`, in `npm run worker` when `worker`). Each run is a unique `job_runs.run_key`, taken under a worker lease (spec §10.3):

| Job | When (Asia/Riyadh) | Does | Source |
| :--- | :--- | :--- | :--- |
| `daily-transition` | 00:05 daily (catches up if missed) | Contracts Approved→Active / →Expired; stored credential status by date; closes ended grace windows (HIGH audit + HR notice); removes expired PAM; ends expired break-glass; purges spent idempotency keys; re-evaluates every live nurse (demotes invalid future published shifts; TRANSITION policy notice) | spec §6.1, §6.1.1, §6.1.1.1, §6.2, §5.2, R13, R18 |
| `expiry-scan` | 06:00 daily | Credentials at 60 / 30 / 14 / 7 days, contracts at 90 / 30 / 14 / 7 days before the last valid day, both once expired (current milestone only). Credentials → employee; + unit Supervisor from 14; + scoped HR from 7. Contracts → employee + scoped HR from 90; + Supervisor from 14; none once a later contract is Approved/Active. Key = record + expiry date + milestone | spec §7.1 (N1, N3, N4); **D-39 overrides N2** |
| `attendance-alerts` | every 15 minutes | Shifts under way: not clocked in 30 min after the start, or clocked in while ineligible → CRITICAL notice to the unit's supervisors, once per assignment | spec §14.2 |

### 2.12 Removed from V03

| Removed | Replaced by |
| :--- | :--- |
| `GET /api/bootstrap` | Per-module list endpoints with scope + field filtering |
| `GET/POST/PUT/DELETE /api/:entity[/:id]` (all 47 routes) | Domain endpoints above |
| Hard `DELETE` of employees/contracts/units | Soft delete / deactivate / status transitions |
| localStorage roles mock | `/api/v1/role-assignments`, `/api/v1/approvals` |

Scheduled jobs (no HTTP): contract/credential daily scan (N1), credential status transition by date, contract Active → Expired by end date, eligibility daily transition (L6), grace expiry (L8), waiver expiry, role-assignment expiry (R5), PAM expiry (R13), idempotency cleanup. Each runs under a worker lease.

## Appendix A — V03 API (historical)

Kept from the stage-1 analysis for traceability; none of these endpoints exists in V04.

### A.0 Current state (V03)

### A.1 Running API — `server/src/index.ts` (Express, port 3001, prefix `/api`)

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

### A.2 Reference API — `backend/` (NestJS, port 3000, never running)

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

### A.3 Reference API — `wave1a-kit/` (NestJS, never running)

| Method | Endpoint | Purpose | Permission |
| :--- | :--- | :--- | :--- |
| GET | `/api/v1/units?departmentId&includeInactive` | List units | authenticated |
| GET | `/api/v1/units/summary` | Totals by department | authenticated |
| PUT | `/api/v1/units/bed-capacity/bulk` + `Idempotency-Key` | Bulk bed update | HR_ADMIN, SYSTEM_ADMIN |
| POST | `/api/v1/units/import` + `Idempotency-Key` | CSV import, dry-run default | HR_ADMIN, SYSTEM_ADMIN |
| PUT | `/api/v1/units/:id/bed-capacity` | Single update | HR_ADMIN, SYSTEM_ADMIN |
| GET | `/api/v1/units/:id/bed-history` | Bed log | HR_ADMIN, SYSTEM_ADMIN, SUPERVISOR |

### A.4 Specified but never implemented (spec v2.8.7)

`/api/v1/positions` (CRUD), `/api/v1/departments`, `/api/v1/credential-templates` (CRUD), `/api/v1/credential-categories` (CRUD), `/api/v1/credential-requirements` (CRUD + `/bulk`), `/api/v1/workforce/onboard`, `/api/v1/workforce/invitations`, `/api/v1/workforce/publish`, evidence `/:evidenceId/download`, `/api/v1/auth/register`, `/api/v1/push/register|unregister|devices`, `/api/v1/fhir/Practitioner/:id`, `/api/v1/fhir/PractitionerRole/:id`. Tracker B-23 records a route disagreement (`/api/v1/positions` vs `/api/v1/workforce/positions`).

### A.5 Duplicates and conflicts

| Issue | Detail |
| :--- | :--- |
| Two prefixes | Running `/api/…` vs spec/reference `/api/v1/…` |
| Two unit APIs | Generic `PUT /api/units/:id` (running) vs `/api/v1/units/*` (kit) |
| Generic vs domain | Every write goes through generic CRUD, so business rules (onboarding atomicity, overlap, publication gate, waiver limits) can be bypassed by calling the API directly |
| Mock API | `app/src/lib/api/roles.api.ts` simulates the NestJS roles API in localStorage |

---
