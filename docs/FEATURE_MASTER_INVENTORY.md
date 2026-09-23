# Feature Master Inventory — nurse_appV03 → V04

Every capability found in the repository, where it lives, how real it is, and which business rules it carries. Evidence is file:line in the V03 clone (`C:\WebApp_project\Local_Repo\app`). "Spec" = `AIGH_Nursing_Workforce_Management_System_v2_8_7.md` (rev 2.8.7c).

## Status legend

| Code | Meaning |
| :--- | :--- |
| **RUN** | Works end-to-end in the running app and is enforced/persisted by the Express server |
| **CLIENT** | Works in the browser (Zustand store) only. Not enforced by the server; persisted only as a raw row via generic CRUD, or not persisted at all |
| **REF** | Exists as reference code (`backend/` NestJS or `wave1a-kit/`); never executed against this app |
| **SPEC** | Specified in the spec (with or without sample code); no implementation in the repo |
| **DISPLAY** | A screen shows text/tables describing the feature; no working logic |
| **NOT ESTABLISHED** | No requirement exists anywhere in the repository. **REQUIREMENT NOT ESTABLISHED** — V04 must not invent it |

---

## 1. Authentication

| Capability | Status | Where | Notes |
| :--- | :--- | :--- | :--- |
| Login (email + password, bcrypt) | **RUN** | `server/src/index.ts:134-152` | Constant-time user-enumeration defence (dummy hash compare). |
| Login (demo / standalone) | CLIENT | `app/src/lib/store.tsx:326-348` | **Any password; role derived from email substring.** In API mode the UI is marked authenticated *before* the server answers, and a server rejection is only logged — the user stays in the UI on seed data. **Security defect.** |
| Access token (HS256 JWT, 15 min, memory only) | **RUN** | `server/src/auth.ts:37-80`, `app/src/lib/api.ts:13-17` | Algorithm pinned; constant-time signature check. |
| Refresh token rotation + reuse detection (family revoke) | **RUN** | `server/src/index.ts:157-193` | Stored as SHA-256 hash; HttpOnly cookie scoped to `/api/auth`, 7 days. |
| Session restore after reload | **RUN** | `store.tsx:355-369`, `api.ts:66-84` (single-flight refresh) | |
| CSRF double-submit + Origin check | **RUN** (refresh only) | `auth.ts:166-189` | Applied only to `/api/auth/refresh`. Data writes rely on Bearer header (not cookie-authenticated), so CSRF is not needed there. |
| Logout (revoke session, clear cookies) | **RUN** | `index.ts:196-207` | |
| `/api/auth/me` | **RUN** | `index.ts:210` | |
| Login by username, attempt limits | SPEC | Spec §3.3 | Not implemented (email only, no rate limit). |
| Session limits "1 h validity, 24 h absolute" | SPEC | Spec §3.3 | **Conflict C-10** with implemented 15 min / 7 d. |
| Password change (verify current, revoke all sessions) | SPEC | Spec §3.3 | Not implemented. |
| Password reset / forgot password | **NOT ESTABLISHED** | — | Spec mentions none. |
| Account invitation / claim | SPEC | Spec §8.1 ("Claim invited account"), spec `@Post('invitations')` | Not implemented. |
| Account activation / deactivation | Partial | `User.isActive` checked at login/refresh (`index.ts:143,183`) | No endpoint or UI to change it. |
| SSO, MFA for privileged accounts | SPEC (planned) | Spec §3.5 | Gated on IdP decision (U1). |
| Break-glass root account | SPEC + REF model | Spec §3.6, `backend/prisma/schema.prisma:569` `BreakGlassEvent`, `.env.example` `BREAK_GLASS_*` | UI: DISPLAY only (`AdminModule.tsx:151`). No login path, siren or 4 h revocation implemented. |
| KSA residency startup check | REF / CLIENT | `wave1a-kit/.../residency.check.ts` (correct); `app/src/main.tsx:222-243` (browser, **wrong allowlist**) | **Conflict R-1.** A browser cannot verify database residency. |

## 2. User management, roles, permissions

| Capability | Status | Where | Notes |
| :--- | :--- | :--- | :--- |
| Roles SYSTEM_ADMIN, HR_ADMIN, SUPERVISOR, EMPLOYEE | RUN (single role per user) | `server/prisma/schema.prisma:167` `User.role String` | Spec §8.1: 4 roles, EMPLOYEE implicit. |
| `DEVELOPER` full-access role | RUN | `server/src/auth.ts:118`, `seed.ts:12`, `store.tsx:334` (commit `edb9718`) | **Not in spec.** Conflicts with four-eyes / PAM / separation of duties. **Conflict C-8.** |
| Role enforcement on API | RUN (coarse) | `server/src/index.ts:240-266` | Only rule: writes require HR_ADMIN / SYSTEM_ADMIN / DEVELOPER. Reads of **every** table (incl. salary, emails) open to any authenticated user via `/api/bootstrap` and `GET /api/:entity`. **Violates spec §8.1 "Default access is denied" and field suppression.** |
| Scoped role assignments (SYSTEM / DEPARTMENT / UNIT + scopeIds, expiry, reason) | REF + CLIENT mock | `backend/.../roles.service.ts`; `app/src/lib/api/roles.api.ts` (localStorage) | Not persisted server-side in the running app. |
| Grant role rules | REF + CLIENT | `roles.service.ts:963-1054`, `roles.api.ts:174-270` | BR-R1…R7 below. |
| Revoke role rules | REF + CLIENT | `roles.service.ts:1108-1143`, `roles.api.ts:280-320` | BR-R8, R9. |
| Role expiry sweep | REF | `roles.service.ts:1146` | Needs a scheduled job. |
| Four-eyes approval | REF + CLIENT | `admin-approval.service.ts`, `roles.api.ts:385-455` | BR-R10…R12. |
| PAM just-in-time elevation (SYSTEM_ADMIN dormant) | REF | `pam.service.ts`, `roles.guard.ts:249-255` | BR-R13. UI: DISPLAY (`AdminModule.tsx:122`). |
| Position never confers a role | CLIENT (by omission) + REF warning | `store.tsx:674-709` (audit records `authRoleGranted: null`), `roles.service.ts:987-991` | BR-R14. |
| Role matrix screen | CLIENT | `app/src/modules/admin/RoleMatrixPage.tsx` | |
| Role-aware navigation | **Missing** | `AppLayout.tsx` shows all 16 menu items to every role | Only `PositionsPage` checks a role. |
| Link User ↔ Employee | **Missing** | Neither Prisma schema links a login user to an employee | Required for any "own record" rule (spec §8.1 Employee column). `MyCredentialsPage.tsx:18` compares `employeeId` with `currentUser.id`, which only works by coincidence. |
| DB privilege separation (owner / migration / runtime / backup / audit_reader) | SPEC | Spec §10.7, `.env.example` | DISPLAY in `AdminModule.tsx:67`. |

## 3. Nurse master (employee registry)

| Capability | Status | Where | Notes |
| :--- | :--- | :--- | :--- |
| Employee list / search / filter | CLIENT (data RUN) | `WorkforcePage.tsx:55` | |
| Onboarding form (field order per spec §3.1 table) | CLIENT | `WorkforcePage.tsx:220-285` | First/Middle/Last, Job Number, Job Title, File No., Rank/Grade, Nationality, Job Post (city), Actual Work Place, Specialty, contract Start/End (+Hijri), Marital Status, Salary SAR, Unit (default Unassigned), Position (default SN), Contact email. |
| Onboarding guards | CLIENT | `store.tsx:556-653` | BR-E1…E8. Server accepts any row via generic `POST /api/employees`. |
| Atomic onboarding (employee + contract + audit) | CLIENT (sequential fire-and-forget writes) / SPEC (DB function) | `store.tsx:642-650`; spec §3.1; `wave1a-kit/.../V36b_*.sql` | Two independent HTTP writes; failure of one leaves the other. **Conflict C-1** on resulting contract status. |
| Full Name derived | CLIENT + REF trigger | `store.tsx:586`; `backend/prisma/migrations/V50_*.sql:33-54` | BR-E3. |
| Edit employee | CLIENT | `store.tsx:654-657`, `WorkforcePage.tsx:105-120` | No guards server-side; UI re-derives name. |
| Soft delete | CLIENT | `store.tsx:658-662` (`deletedAt`) | |
| Position assignment (HR only, audited) | CLIENT | `store.tsx:679-712`, `PositionsPage.tsx` | BR-E9, BR-R14. |
| Professional info / licences / certifications | via Credentials (§5) | | |
| Employment status field | CLIENT | `Employee.status` default `'Active'`; never changed by any flow | Spec §6.1 step 1 requires "is Active". |

## 4. Credentials

| Capability | Status | Where | Notes |
| :--- | :--- | :--- | :--- |
| Catalog: 5 categories, 16 templates, tracked field definitions | RUN (seeded, read-only in UI) | `seed.ts:84-116`; spec §5.1 | Templates 6–16 have `fields: []` in seed; spec §5.1 table defines their fields (e.g. EMP_CONTRACT: Contract ID, Contracting Agency, Start, Expiry). |
| Template / category CRUD | SPEC | spec `@Controller('api/v1/credential-templates')` etc. | No UI or API. |
| Credential requirements (template × unit × position, MANDATORY/TRANSITION/OPTIONAL) | CLIENT CRUD | `store.tsx:938-946`, `CredentialsModule.tsx:200-210` | Not persisted (no `syncWrite`). UI requires a unit; backend schema allows `unitId = null` = all units. |
| Record credential + PDF evidence | CLIENT | `CredentialsModule.tsx:45-66`, `store.tsx:862-933` | Created as `PendingVerification`. |
| Employee self-submission | CLIENT | `MyCredentialsPage.tsx` | |
| **Verification (PendingVerification → Valid)** | **Missing** | No action anywhere | Only seeded credentials are ever `Valid`. Spec §5.2 lifecycle not implemented. |
| Expiry-driven status (Valid → ExpiringSoon → Expired) | **Missing** | No code derives status from `expiryDate` | A credential past expiry but stored `Valid` still counts as valid (BR-L4 violated). |
| Renewal staging (pending data, approve/reject) | SPEC | §5.2 | |
| Suspension / revocation | SPEC | §5.2 | Statuses exist in the type; no action. |
| Evidence versioning (append-only), PDF magic bytes, 10 MB cap, scan gate | CLIENT | `contracts.ts:170-228`, `store.tsx:73-89, 887-933` | BR-D1…D4. Bytes are held in memory only and lost on reload; "scan" is simulated as CLEAN. |
| Secure vault, signed URLs 30 s, ClamAV quarantine | SPEC | §5.3 | |
| SCFHS nightly sync, circuit breaker, STALE 48 h | SPEC | §5.4 | Gated on U3 agreement. `syncStatus` is a stored label only. |

## 5. Clinical eligibility

Four implementations exist and **disagree**: see DUPLICATE_IMPLEMENTATION_MAP §2.

| Capability | Status | Where |
| :--- | :--- | :--- |
| Eligibility calculation (live) | CLIENT | `store.tsx:1026-1076` `refreshEligibility` |
| Eligibility calculation (dead, stricter) | CLIENT, **no callers** | `app/src/lib/eligibility.ts` |
| Canonical engine + materialized state + tx refresh | SPEC + REF | Spec §6.1; `wave1a-kit/.../eligibility-state.service.ts`; `backend` model `EmployeeEligibilityState` |
| Grace periods | CLIENT (seeded list only) / SPEC | `store.tsx:1078-1080`; spec §6.1.1 |
| Emergency waivers (72 h) | CLIENT | `store.tsx:1082-1094`, `EligibilityModule.tsx:20-36` |
| Policy transitions (TRANSITION + deadline) | SPEC | `EligibilityModule.tsx:93` (text only); spec §6.1.1.1 |
| Eligibility refresh triggers | CLIENT, partial | Called on onboarding and waiver creation only. **Not** on contract status change, credential add/update, position change. |
| Daily transition, consistency auditor, shadow mode | SPEC + REF | §6.1, §10.8–10.9; `consistency-auditor.worker.ts` |
| Eligibility notifications | SPEC | §6.1.1 ("never silent") |

Spec order of checks (§6.1) and what the live engine does:

| # | Spec check | Live engine (`store.tsx:1026`) |
| :--- | :--- | :--- |
| 1 | Employee exists, not deleted, **Active** | Exists only; status ignored |
| 2 | Position **schedulable** | **Not checked** |
| 3 | Approved/Active contract covers the **shift date** | Checks *today*, not shift date |
| 4 | Applicable requirements exist; **if none → block with explanation** | Requirements filtered by `unitId === employee.unitId` only; **none → ELIGIBLE** |
| 5 | Each required template: Valid/ExpiringSoon, **issued by and not expired on the shift date**, or within grace | Status only; dates ignored |
| 6 | Caller scope authorises nurse + unit | Not checked |
| Waiver | Per nurse **per template**, overrides that credential only | Any active waiver for the employee waives **all** missing items, including missing contract |
| Grace | Per template, conditions in §6.1.1 | Only applied when *nothing* is missing |

## 6. Workforce (organisation, capacity, staffing)

| Capability | Status | Where | Notes |
| :--- | :--- | :--- | :--- |
| Departments CRUD + deactivate guard | CLIENT (writes synced) | `store.tsx:399-418`, `DepartmentsPage.tsx` | BR-W1. |
| Units CRUD + deactivate guard | CLIENT | `store.tsx:420-439`, `UnitCapacityGrid.tsx` | BR-W2. |
| Seeded baseline 5 departments / 47 units / 582 beds | RUN (seed) | `seed.ts:1-66`; spec §2.9 | BR-W3. Baseline is editable configuration, not a constant (tracker B-01). |
| Bed capacity edit + log | CLIENT (log not persisted) | `store.tsx:440-451` | BR-W4. |
| Bulk bed capacity | CLIENT / REF | `store.tsx:452-490`; `wave1a-kit/.../workforce-bulk-capacity.service.ts` | BR-W5. |
| CSV unit import (dry-run default) | CLIENT (updates existing only) / REF (creates + updates) | `store.tsx:491-529`; kit service | Kit version is more complete (creates units, validates department). |
| Position directory (16 codes; AHN, CI deprecated) + deactivate guard | CLIENT | `store.tsx:534-553`, `PositionsPage.tsx` | BR-W6, W7. |
| Staffing requirement per unit × shift | CLIENT (**hard-coded formula**) | `roster.ts:256-261` `beds × {M 0.14, E 0.11, N 0.10}`, min 1 | **Conflict C-5**: spec §2.9 L813 and §6.3 require *configured* targets; "missing targets are shown as unspecified (not as zero)". Formula is **REQUIREMENT NOT ESTABLISHED**. |
| Nurse-to-bed KPIs (Ada'a KPI A ICU/ER/OR, KPI B QFR-55) | CLIENT | `kpi.ts`, `NursingKpiPage.tsx`, `DashboardPage.tsx` | Thresholds (e.g. ICU ≤1.5 beds/nurse = Standard; hospital-wide <6 Standard) cite an external MoH card **not in the repository**. Keep only with a documented source — rule K-1. Critical-area mapping by unit code (`kpi.ts:327`) is local configuration. |
| Staffing ratios as enforcement | **NOT ESTABLISHED** | Spec L813: bed count "does not automatically enforce a nurse-to-bed ratio" | Informational only. |
| Mandatory posts | **NOT ESTABLISHED** | — | |
| Skill mix | **NOT ESTABLISHED** | — | |
| Acuity | **NOT ESTABLISHED** | — | |
| Hospital structure: Unassigned sentinel unit id 0 | CLIENT | `seed.ts:16`, `store.tsx:569` | Must become `unitId NULL` in V04 (a sentinel `0` cannot be a foreign key). |

## 7. Scheduling / roster

| Capability | Status | Where | Notes |
| :--- | :--- | :--- | :--- |
| Shift types M 07–15, E 15–23, N 23–07 | CLIENT | `roster.ts:246-250` | Spec schema has `ShiftType` enum Morning/Evening/Night; the times come from code only — treat as configuration. |
| Week board / month calendar | CLIENT | `SchedulingModule.tsx` | |
| Manual assignment (Draft) + double-booking check | CLIENT | `SchedulingModule.tsx:72-81` | BR-S1. DB unique in backend schema: `(unitId, shiftType, shiftDate, employeeId)` — does **not** stop the same nurse in two units on the same shift. |
| Auto-generate drafts | CLIENT | `SchedulingModule.tsx:84-113` | Pool = not deleted and not INELIGIBLE; **ignores `isSchedulable`**, requirements of the destination unit, and rest/overtime (none established). |
| Publish with eligibility gate | CLIENT | `store.tsx:990-1018` | BR-S3. Fail-open when no state row exists; waiver not per template. |
| Server-side publish in one transaction, re-validation, demotion to draft on later change | SPEC | §6.2 | |
| Coverage monitoring | CLIENT | `SchedulingModule.tsx:61-68`, `kpi.ts:462-493` | **Conflict C-6**: board counts Draft + Published; KPI counts Published only; spec §6.3 wants them *reported separately*, against configured minimums, 94-day window bound. |
| Employee sees only published personal/home-unit schedule | SPEC | §6.2 | Not implemented (all roles see the full board). |
| Who may draft/publish | SPEC: scoped Supervisor | §8.1 | **Conflict C-9**: server `WRITE_ROLES` excludes SUPERVISOR, so a Supervisor cannot persist a roster in API mode. |
| Rest requirements / fatigue / overtime | **NOT ESTABLISHED** | UI subtitle claims "fatigue, leave and coverage rules enforced" (`SchedulingModule.tsx:135`) — false | |

## 8. Attendance

| Capability | Status | Where | Notes |
| :--- | :--- | :--- | :--- |
| Clock events (IN/OUT/BREAK) from badge/PACS feed | SPEC + REF model | `backend` `AttendanceEvent`; spec §14.2 | Integration-dependent (tracker B-15). |
| Missing clock-in gap detection (15 min window, Asia/Riyadh) | SPEC | `AdminModule.tsx:218` (display), spec §14.2 | |
| Attendance states, absence, leave | **NOT ESTABLISHED** | — | |
| Overtime | **NOT ESTABLISHED** | — | |
| Mandatory rest | **NOT ESTABLISHED** | — | |
| Coverage impact of attendance | **NOT ESTABLISHED** | — | |

## 9. Contracts

| Capability | Status | Where | Notes |
| :--- | :--- | :--- | :--- |
| 8 statuses (Draft, PendingApproval, Approved, Active, Expired, Suspended, Terminated, Superseded) | CLIENT (+ enum in REF) | `store.tsx:39` | |
| Create contract for existing employee (not Approved/Active employees only) | CLIENT | `ContractsPage.tsx:85-100, 176-217` | BR-C1…C6. |
| Renew contract (prefill day after prior end, same length) | CLIENT | `contracts.ts:130-168`, `ContractsPage.tsx:100-165` | BR-C7, C8. |
| Overlap exclusion (Approved/Active) | CLIENT (twice) / SPEC SQL | `store.tsx:734-743, 835-849`; `ContractsPage.tsx:192, 233`; spec §4.2 GiST constraint | BR-C4. |
| Status transitions | CLIENT — **free dropdown, any → any** | `ContractsPage.tsx:222-247` | Spec §4.2: approving a period covering today makes it Active; future stays Approved. Not automated. No state machine. |
| Contract copy PDF (required on create/renew, versioned) | CLIENT | `store.tsx:773-823`, `ContractsPage.tsx` | BR-D1…D4. |
| Hijri dates stored alongside Gregorian | CLIENT + REF CHECK | `store.tsx:632, 750`; `V50_*.sql:62-76` | BR-C9. |
| Expiry → Expired status transition | **Missing** | Nothing moves an Active contract to Expired when `endDate` passes | Coverage logic still works (date-bounded), but the stored status is wrong. |
| Access: HR full; Supervisor reduced; Employee own | SPEC | §4.1 | Not enforced. |
| Concurrent secondary contracts | Explicitly **not supported** | Spec §4.2 | Keep. |

## 10. Agency workforce

| Capability | Status |
| :--- | :--- |
| Agency nurses, assignment, rates, agency eligibility, agency credential validation | **NOT ESTABLISHED.** The only mention is the "Contracting Agency" field on the `EMP_CONTRACT` credential template (spec L2508). No module, model, rule or screen. V04 will not create an agency module until requirements are provided. |

## 11. Notifications

| Capability | Status | Where | Notes |
| :--- | :--- | :--- | :--- |
| Notification list, mark read | CLIENT | `NotificationsModule.tsx`, `store.tsx:964-974` | Mark-read not persisted (server marks notifications read-only). |
| Recipient model | **Missing** in running schema | `server/prisma/schema.prisma:140` has no recipient | Backend schema has `employeeId`. Spec §7.1 needs recipient per user. |
| Daily scan 06:00 Asia/Riyadh: contracts 90 d, credentials 60 d + expired, dedup event key | SPEC + REF skeleton | §7.1; `notification.worker.ts` (bodies are `SELECT 1`) | BR-N1…N4. |
| SMTP queue, retries, delivery health | SPEC | §7.2–7.5 | |
| Push (FCM / hospital gateway), device tokens | SPEC | §7.6 | |
| Eligibility / grace notifications | SPEC | §6.1.1 | |
| Staffing (coverage gap) notifications | SPEC | `CoverageAlertLog` model; §14.2 | |
| Approval notifications (four-eyes) | **NOT ESTABLISHED** as a notification rule | | |
| Break-glass alert to CEO + IT Director | SPEC | §3.6 | |

## 12. Audit

| Capability | Status | Where | Notes |
| :--- | :--- | :--- | :--- |
| Domain audit hash chain | CLIENT (32-bit non-crypto hash + `Date.now()`) | `store.tsx:283-291, 952-962` | Browser-local. **Never written to the database** — server marks `audit-entries` read-only and has no writer. In API mode, hydration *replaces* local entries with the (empty) server table only if non-empty. |
| Second client audit log | CLIENT | `roles.api.ts:255` `localStorage['aigh_audit_log']` | Duplicate; not shown in Audit screen. |
| `fn_append_audit_entry` (advisory-lock serialised, SHA-256) | REF SQL (executed in gate1 drill) | `gate1-kit/sql/10_audit_chain.sql:25-63` | Hash includes `clock_timestamp()` which is **not stored**, so content cannot be re-verified — only linkage. |
| AuditService (SHA-256 prev+JSON, no lock) | REF | `backend/.../audit.service.ts` | Concurrent writers can fork the chain. |
| Chain verification | CLIENT + SQL view | `AuditModule.tsx:19-25`; `audit_chain_breaks` view | |
| Append-only (runtime cannot UPDATE/DELETE) | RUN (API refuses writes) / SPEC (DB grants) | `index.ts:62`; §10.7 | |
| Request-level audit (X-Request-Id, PII redaction) | SPEC + REF model | §9.2; `RequestLog` | |
| Security events (login success/failure, refresh reuse) | **Missing** | Login audit only in client store; reuse detection not audited | |
| PDPL encryption of PII in audit, crypto-shredding | SPEC + REF model | §8.3; `UserEncryptionKey` | |

## 13. Administration

| Capability | Status | Where |
| :--- | :--- | :--- |
| Role matrix view and assignment CRUD | CLIENT | `RoleMatrixPage.tsx` |
| Master data: departments, units, positions | CLIENT | workforce pages |
| Master data: credential templates/categories | SPEC | — |
| System configuration (runtime) | **Missing** | Env vars only |
| Backup/PITR status, privilege separation, PAM, FHIR, PDPL tabs | DISPLAY | `AdminModule.tsx` |
| Observability vitals | DISPLAY (hard-coded values `store.tsx:1096-1103`) | `ObservabilityPage.tsx` |
| Backup / WAL archive / PITR restore / failure drill | **RUN (ops scripts, executed 2026-09-18)** | `gate1-kit/` |

## 14. Other specified capabilities (not requested in the brief, found in spec)

| Capability | Status | Recommendation |
| :--- | :--- | :--- |
| FHIR R4 Practitioner / PractitionerRole | SPEC + DISPLAY | Defer (tracker B-14, needs HIS agreement) |
| Data portability / exit package | SPEC + DISPLAY | Defer |
| Legacy migration bridge (staging, BLOCK/WARN) | SPEC + REF model | Defer until a legacy data source is identified |
| Idempotency keys | REF | Include for onboarding / bulk / publish |
| Worker leases | REF + SQL | Include with the first scheduled job |
| i18n English/Arabic + RTL | RUN (client) | Keep |
| Bundle budget (200 KB gz entry / 150 KB chunk) | RUN (lenient) / REF (strict) | Keep strict version |

---

## 15. Business rule register

IDs are referenced by the other reports. **Source** is where the rule is established. Rules are only listed when the repository establishes them.

### Roles & access (R)

| ID | Rule | Source |
| :--- | :--- | :--- |
| R1 | EMPLOYEE is implicit, never granted | spec §8, `roles.service.ts:966` |
| R2 | No self-grant; no self-update; no self-revoke | `roles.service.ts:967,1061,1111` |
| R3 | SYSTEM scope ⇔ empty scopeIds; DEPARTMENT/UNIT need ≥1 scopeId | `roles.service.ts:969-972` |
| R4 | Grant reason ≥ 20 chars; revoke reason ≥ 10; approval reason ≥ 5 | `grant-role.dto.ts` |
| R5 | Assignment expiry must be future; max 90 days SUPERVISOR, 365 days others | `roles.service.ts:974-980` (source of 90/365 not in spec — implementation choice) |
| R6 | Granter must cover the requested scope; only SYSTEM_ADMIN or system-wide HR_ADMIN may grant SYSTEM scope | `roles.service.ts:883-913` |
| R7 | One active assignment per user + role + scopeType | partial unique, `backend/README.md:55` |
| R8 | Cannot revoke the last SYSTEM_ADMIN | `roles.service.ts:1115-1120` |
| R9 | Revocation takes effect on the next request (fresh DB read, no cached permission) | `roles.guard.ts:237`, spec §8.1 |
| R10 | Four-eyes for: promoting to SYSTEM_ADMIN, HR_ADMIN with SYSTEM scope, upgrading HR_ADMIN scope to SYSTEM; spec also names "modifying global eligibility rules" and "changing encryption keys" | spec §8.1, `roles.service.ts:994,1069` |
| R11 | Approver ≠ initiator; only PENDING requests can be approved; approval executes in the same transaction; one PENDING request per initiator + action | `admin-approval.service.ts` |
| R12 | Every elevation / approval audited with initiator and approver | spec, `backend/README.md:155` |
| R13 | SYSTEM_ADMIN is dormant: requires active PAM elevation with reason; auto-revoked at expiry | spec §8.1, `roles.guard.ts:249` |
| R14 | Position title never confers a role (DON, DEPUTY_DON, ADMIN, NS, ACTING_HEAD included) | spec §8.2 |
| R15 | Default deny; server-evaluated scope; a browser-supplied id never establishes access | spec §4.1, §8.1 |
| R16 | Access matrix per area × role (Accounts, Employee Master, Contracts, Credentials, Scheduling, Notifications) | spec §8.1 table |
| R17 | Same checks apply to exports, document versions, reports, background actions | spec §8.2 |
| R18 | Break-glass: bypasses PAM and four-eyes; irrevocable event row; alert CEO + IT Director; session ≤ 4 h | spec §3.6 |

### Employee master (E)

| ID | Rule | Source |
| :--- | :--- | :--- |
| E1 | Job Number required, unique (case-insensitive in client), **no format rule**; the retired `AIGH-XXXX` pattern must not be reintroduced | spec §3.1, V50 SQL |
| E2 | First and Last Name required; Middle optional | spec §3.1 |
| E3 | Full Name = First + Middle + Last, derived, never typed; no double space when Middle is empty | spec §3.1, V50 trigger |
| E4 | Position must exist and be active | `store.tsx:559`, V36b |
| E5 | Unit must exist and be active, or the employee is Unassigned | `store.tsx:569` |
| E6 | Onboarding defaults: Unit = Unassigned, Position = SN | commit `4f51b22`, `seed.ts:23` |
| E7 | Marital Status ∈ {Single, Married, Others}; Salary ≥ 0 (SAR) | V50 CHECKs |
| E8 | File No. not unique, may be blank | spec §3.1 table row 6 |
| E9 | Position assignment is HR_ADMIN only, rejects inactive/unchanged positions, audited with from/to | `store.tsx:679-712` |
| E10 | Onboarding is contract-first and atomic (employee + contract + audit, full rollback) | spec §3.1 |

### Contracts (C)

| ID | Rule | Source |
| :--- | :--- | :--- |
| C1 | Draft / PendingApproval provide no coverage | spec §4.2 |
| C2 | Approving a period that covers today → Active immediately; a future period stays Approved until its start | spec §4.2 |
| C3 | Expired / Suspended / Terminated / Superseded provide no coverage | spec §4.2 |
| C4 | No overlapping Approved/Active periods per employee (inclusive dates); DB exclusion constraint is final authority; service returns `CONTRACT_PERIOD_OVERLAP` first | spec §4.2 |
| C5 | End must be after start; employee must exist and not be soft-deleted (`EMPLOYEE_NOT_FOUND`) | spec §4.2 |
| C6 | No concurrent secondary contracts; no silent superseding | spec §4.2 |
| C7 | Renewal allowed only when no current/future Approved/Active coverage remains and the latest contract is Expired/Suspended/Terminated/Superseded or a lapsed coverage status | `contracts.ts:130-147` |
| C8 | Renewal prefill: starts day after previous end, same length, editable | spec §4.2 "Renewal entry" |
| C9 | Gregorian dates authoritative; Umm al-Qura equivalent stored at entry via `Intl` `islamic-umalqura` | spec §4.2 |
| C10 | "Create Contract" list offers only employees with no Approved/Active contract | commits `bb8ecfd`, `5faef89` |
| C11 | Contract copy PDF required on create and renew | commit `1508316` |
| C12 | An Approved future period can satisfy eligibility for shifts inside it | spec §4.2 |

### Documents (D)

| ID | Rule | Source |
| :--- | :--- | :--- |
| D1 | PDF only: `.pdf` name, `application/pdf` type, bytes start with `%PDF-` | `contracts.ts:206-228`, spec §5.3.2 |
| D2 | Max 10 MB; empty file rejected | `contracts.ts:181` |
| D3 | Versions append; historical bytes never overwritten | spec §5.3.1 |
| D4 | Nothing is downloadable unless scan status is CLEAN | spec §5.3.2 |
| D5 | Supervisors never download evidence | spec §8.1 |

### Credentials & eligibility (L)

| ID | Rule | Source |
| :--- | :--- | :--- |
| L1 | Stored statuses: PendingVerification, Valid, ExpiringSoon, Expired, Suspended, Revoked; lifecycle labels Active / Subject to Renew (≤60 d) / OnProcess / Expired | spec §5.2 |
| L2 | Unexpired verified credential stays usable during renewal | spec §5.2 |
| L3 | Suspension/revocation invalidates eligibility immediately | spec §5.2 |
| L4 | Eligibility order: exists+Active → schedulable position → contract covers shift date → requirements exist (else **block**) → each required template valid on shift date (issued by, not expired) or in grace → caller scope | spec §6.1 |
| L5 | Outcomes: ELIGIBLE, ELIGIBLE_WITH_GRACE, INELIGIBLE with reasons | spec §6.1 |
| L6 | Refresh state in the same transaction as contract/credential/position/waiver changes; daily transition for date passage | spec §6.1 |
| L7 | Publication re-validates against the engine, not the snapshot | spec §6.1–6.2 |
| L8 | Grace: per template `grace_period_days` (0–90, default 0); only when expired, within window, renewal in progress, not suspended/revoked; no stacking; never silent (audit + HR notification); on expiry/rejection revert and demote future published assignments to draft | spec §6.1.1 |
| L9 | Waiver: Supervisor or HR_ADMIN; one nurse + one template; ≤ 72 h; expiry in future; high-priority audit with justification; overrides that credential only | spec §6.1.2 |
| L10 | Policy status TRANSITION with `transition_deadline`: nurse stays eligible and receives a "Policy Warning" notification until the deadline; after it the requirement is treated as MANDATORY and blocks eligibility | spec §6.1.1.1 (L4684-4699) |

### Workforce (W) and scheduling (S)

| ID | Rule | Source |
| :--- | :--- | :--- |
| W1 | Department cannot be deactivated while it has active units | `store.tsx:414` |
| W2 | Unit cannot be deactivated while it has active employees | `store.tsx:435` |
| W3 | Seeded baseline 5 depts / 47 units / 582 beds is configuration, not a constant | spec §2.9, tracker B-01 |
| W4 | Bed count integer 0–500; every change logged with actor, reason, before, after | `store.tsx:443`, gate1 SQL `chk_bed_count_range` |
| W5 | Bulk update: per-row result (UPDATED/UNCHANGED/REJECTED), one log row per changed unit, atomic batch | kit service |
| W6 | Position cannot be deactivated while held by active employees | `store.tsx:549` |
| W7 | NS = Nursing Supervisor (not Nurse Specialist); DON/DEPUTY_DON/ADMIN non-schedulable | spec §3.1.1, U2 pack |
| W8 | Coverage targets are configured per unit per shift; missing target = "unspecified", not zero | spec L813, §6.3 |
| S1 | A nurse cannot hold the same shift on the same date twice | `SchedulingModule.tsx:74` |
| S2 | Draft vs Published; employees see only published personal/home-unit schedules | spec §6.2 |
| S3 | Publication blocked for INELIGIBLE nurses unless a waiver covers the gap | `store.tsx:1001-1009`, spec §6.2 |
| S4 | Shortage is a warning; it does not bypass credential checks and does not block publication | spec §6.3 |
| S5 | Coverage counts eligible, non-cancelled assignments; draft and published reported separately | spec §6.3 |
| S6 | Date-window operations bounded to 94 days | spec §6.3 |

### Notifications (N) and audit (A)

| ID | Rule | Source |
| :--- | :--- | :--- |
| N1 | Daily scan 06:00 Asia/Riyadh; contracts 90-day window; credentials 60-day window + already expired — **amended by D-39:** credentials 60/30/14/7, contracts 90/30/14/7, both + expired, with escalation | spec §7.1 |
| N2 | Recipients: employee + scoped active HR users; acknowledgement per recipient only | spec §7.1 |
| N3 | Dedup key = record id + expiry date + milestone | spec §7.1 |
| N4 | Window queries catch up after missed runs | spec §7.1 |
| A1 | Domain mutation and audit row commit in the same transaction | spec §9.1 |
| A2 | Audit is append-only; runtime role cannot UPDATE/DELETE | spec §9.1, §10.7 |
| A3 | Hash chain with a single serialized write path | spec §9.1, gate1 SQL |
| K1 | Ada'a KPI thresholds | **External source, not in repo — needs a citation or removal** |

---

## 16. Conflict register

Conflicts are **not resolved here**. Each needs a decision (see `V04_ARCHITECTURE_PLAN.md` §9).

| ID | Conflict | Side A | Side B |
| :--- | :--- | :--- | :--- |
| **C-1** | Contract status created by onboarding | Spec §3.1 + V36b SQL: **Approved**, atomic | Running app (commit `bb8ecfd` "onboard creates Draft"): **Draft**; employee appears in Create Contract until HR approves |
| **C-2** | Eligibility when no requirement is configured | Spec §6.1 + U2 pack: **block scheduling** | Live engine: **ELIGIBLE** |
| **C-3** | Waiver scope | Spec §6.1.2: per template | Live engine: any waiver waives everything (incl. missing contract) |
| **C-4** | Credential date checks | Spec §6.1 + dead `eligibility.ts`: expiry vs shift date | Live engine: status only |
| **C-5** | Staffing requirement | Spec: configured per unit/shift, unspecified if missing | Code: `beds × 0.14/0.11/0.10`, min 1 |
| **C-6** | Coverage counting | Spec §6.3: separate draft/published, eligible only | Board: draft+published together; KPI: published only |
| **C-7** | Requirement scoping | Backend schema: `unitId`/`positionCode` null = all | App: unit required; `position null` = all positions in unit |
| **C-8** | `DEVELOPER` role | Spec: 4 roles, four-eyes, PAM | Running app: full-access DEVELOPER bypasses all role checks |
| **C-9** | Who writes the roster | Spec §8.1: scoped Supervisor drafts and publishes; HR read by default | Server: only HR_ADMIN / SYSTEM_ADMIN / DEVELOPER can write |
| **C-10** | Session lifetimes | Spec §3.3: 1 h validity, 24 h absolute | Server: 15 min access, 7 d refresh |
| **C-11** | PAM window | Spec: "e.g., 2 hours" | `.env.example`: 60 min; PamService: 1–4 h, default 2 |
| **C-12** | Audit hash algorithm | gate1 SQL (includes unstored timestamp) | backend AuditService (JSON, no lock); client 32-bit hash |
| **C-13** | Identifier type | Server, gate1 SQL, V36b, spec §3.3 "numeric account identifiers": **integer** | `backend` schema: **UUID** |
| **C-14** | Residency allowlist | Spec + kit: deny me-central-1 | `.env.example`, `main.tsx`: allow me-central-1 |
| **C-15** | Unassigned employee | App: sentinel `unitId = 0` | Backend schema: `unitId` required FK (no unassigned state) |
| **C-16** | Onboarding contract email uniqueness | Backend schema: `contactEmail @unique` | Server/app: not unique |
