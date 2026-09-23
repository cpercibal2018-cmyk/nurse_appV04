# V04 Architecture Plan

## 1. Goals

1. **Server-side business rules.** V03 enforces most rules in the browser store (`app/src/lib/store.tsx`) and exposes a generic CRUD API that bypasses them. V04 enforces every rule in backend services and database constraints. The frontend displays and collects data only.
2. **One of everything:** frontend, backend, schema, migration chain, API, RBAC, eligibility engine, workforce logic, audit path, specification.
3. **No invented requirements.** Items marked NOT ESTABLISHED in `FEATURE_MASTER_INVENTORY.md` get no module, no table and no seeded values.
4. **Readable by a new developer:** feature → folder is obvious; no historical code in the tree.

## 2. Repository layout

```
nurse_appV04/
├─ backend/                      Express + TypeScript + Prisma (the only API)
│  ├─ prisma/
│  │  ├─ schema.prisma           the only schema
│  │  ├─ migrations/             the only migration chain (Prisma Migrate + hand-written SQL)
│  │  ├─ seed.ts                 the only seed (reference data always, demo data on SEED_DEMO=true)
│  │  └─ seed-data/              organisation.ts · positions.ts · credential-catalog.ts · demo.ts
│  ├─ src/
│  │  ├─ config/                 env.ts (zod-validated), residency.ts
│  │  ├─ middleware/             authenticate.ts · authorize.ts · validate.ts · idempotency.ts · errors.ts · request-id.ts
│  │  ├─ lib/                    prisma.ts · audit.ts (fn_append_audit_entry wrapper) · dates.ts · hijri.ts · storage.ts · worker-lease.ts · http-errors.ts · logger.ts (JSON, no PII)
│  │  ├─ modules/
│  │  │  ├─ auth/                routes · service · tokens · schemas
│  │  │  ├─ users/               accounts + role assignments (RBAC data)
│  │  │  ├─ administration/      approvals (four-eyes) · pam · break-glass
│  │  │  ├─ workforce/           departments · units · bed capacity · positions · coverage targets · kpi
│  │  │  ├─ nurses/              employee master · onboarding
│  │  │  ├─ contracts/           rules.ts · service · routes
│  │  │  ├─ credentials/         catalog · requirements · credentials · documents · lifecycle
│  │  │  ├─ eligibility/         engine.ts (pure) · state.service.ts · waivers
│  │  │  ├─ scheduling/          assignments · pool · publish · coverage · auto-generate
│  │  │  ├─ attendance/          events · gaps
│  │  │  ├─ notifications/       service · scan rules
│  │  │  └─ audit/               query · verify
│  │  ├─ jobs/                   scheduler.ts + one file per job (runs under worker leases)
│  │  ├─ app.ts                  express app assembly (no listen)
│  │  └─ server.ts               residency check → listen
│  └─ test/                      integration tests (supertest + real PostgreSQL)
├─ frontend/                     React + Vite + TypeScript (the only UI)
│  ├─ public/                    logo-light.jpg · logo-dark.jpg
│  └─ src/
│     ├─ components/             shared presentational components
│     ├─ layouts/                AppLayout (role-aware navigation)
│     ├─ modules/<domain>/       pages + components + api.ts (React Query hooks) per domain
│     ├─ services/http.ts        the only HTTP client (auth, CSRF, refresh)
│     ├─ hooks/                  useAuth, usePermissions
│     ├─ types/                  API DTO types
│     └─ lib/                    i18n · hijri (display) · format · pdf-check (picker pre-check)
├─ ops/
│  ├─ backup/                    gate1-kit (WAL archive, base backup, PITR restore, drill, systemd)
│  └─ db/grants.sql              runtime / migration / backup / audit_reader privileges (spec §10.7)
├─ docs/                         the authoritative documentation set (§8)
├─ .github/workflows/ci.yml
├─ docker-compose.yml            db + api + web for development
├─ .env.example                  one, corrected
├─ package.json                  npm workspaces: backend, frontend (scripts only)
└─ README.md
```

**No `agency/` module** (NOT ESTABLISHED). **No `shared/` package.** The only logic both sides need is Hijri conversion (~30 lines on `Intl`) and a PDF pre-check. The backend is authoritative for both; the frontend copies exist only to give instant form feedback. They are small and documented as display helpers, which costs less than adding a third package to build. Revisit if more shared logic appears (decision D-12).

## 3. Backend design

| Concern | Choice | Reason |
| :--- | :--- | :--- |
| Runtime | Node **22 LTS** (not 20) | Spec §0.2 names Node 20, but Node 20 reached end-of-life in April 2026 (decision D-13) |
| HTTP | Express 5 | Brief requirement; async error propagation built in |
| ORM | Prisma (stable major pinned at implementation, no RC) | Brief requirement |
| Validation | zod schemas per route | Replaces class-validator DTOs; one schema = types + runtime check |
| Auth | Port of `server/src/auth.ts` (HS256 pinned, bcrypt, rotating refresh with family revocation, CSRF double-submit + Origin on refresh) | Already correct and tested in V03; add login rate limiting, password change, session absolute limit (D-6) |
| Authorization | `authorize(permission)` middleware + `scope` object passed to services | One implementation. Effective roles read fresh from `role_assignments` per request (R9); SYSTEM_ADMIN requires active PAM (R13) |
| Permissions | Static table `permissions.ts` (area × action → roles) derived from spec §8.1 | Readable; testable; mirrored in RBAC.md |
| Transactions | Services receive `tx` (Prisma interactive transaction) for every write; audit + eligibility refresh use the same `tx` | A1, L6 |
| Audit | `lib/audit.ts` → `SELECT fn_append_audit_entry(...)` on the caller's `tx` | One write path; serialized chain (A3) |
| Documents | `lib/storage.ts` interface: `LocalDiskStorage` (dev), `S3CompatibleStorage` (later); checksum + PDF check server-side; download streams only CLEAN | D1–D4; vault/ClamAV per D-10 |
| Jobs | `jobs/` run in the API process in development and in a separate worker process (`node dist/jobs/worker.js`) in production; each wrapped in `withLease` (V49) | Spec §10.2 wants a separate worker; the lease makes both modes safe |
| Residency | kit `residency.check.ts` in `config/residency.ts`, called before `listen` | R-1, spec §8.3 |
| Redis | **Not used** | Spec §9.3 makes Redis non-authoritative. RBAC reads the DB every request; nothing in scope needs a cache |
| Logging | JSON logs with `X-Request-Id`; no PII in logs | Spec §9.2 intent; `request_logs` table deferred |

### Module rules

- A module exposes `routes.ts` (HTTP) and `service.ts` (logic). Other modules call its **service**, never its routes or its tables directly. Exceptions: `audit` and `eligibility.state.refresh`, which every mutating module calls.
- Pure rule functions (`contracts/rules.ts`, `eligibility/engine.ts`, `users/role-rules.ts`) take plain data and return decisions. They are the unit-test surface and have no Prisma import.

### Eligibility engine contract

```
evaluate(facts: {employee, position, contracts, requirements, credentials, waivers, date}) → {status, reasons[]}
```

This implements spec §6.1 order (L4) exactly, with grace (L8), waivers per template (L9) and transitions (L10). `state.service.refresh(employeeId, event, tx)` loads facts and upserts `eligibility_states`. Callers: onboarding, contract create/transition, credential verify/suspend/revoke/expire, position change, requirement change, waiver create/expire, daily job. Publication calls `evaluate` directly for the shift date (L7).

## 4. Frontend design

| Concern | Choice |
| :--- | :--- |
| Stack | React 19, Vite 8, TypeScript strict, antd **6** (retained family: every V03 screen uses antd; v6 supports React 19 natively, v5 needs a compatibility patch), react-router **8** (declarative mode), i18next (en/ar + RTL retained). *Implementation note (commit 4): majors moved from the draft's React 18 / antd 5 / router 6 because those were superseded when V04 started.* |
| Server state | React Query hooks in `modules/<domain>/api.ts`; mutations show server errors (no optimistic fire-and-forget) |
| Client state | Zustand only for session (user, roles, scopes) and UI preferences (theme, language) |
| Auth | `services/http.ts` (from V03 `api.ts`): in-memory access token, CSRF header, single-flight refresh. Login waits for the server; no email-based role guessing |
| Access UI | `usePermissions()` derived from `/auth/me`; navigation and buttons hidden when not permitted. **Never the enforcement point** |
| Standalone demo mode | **Removed** (D-1). The app always needs the API |
| Bundle | Route-level lazy loading; the signed-in shell, login form and 404 page are lazy too. Fail-closed budget gate in CI. *Commit 4 fixed a gate defect:* the kit version chose entry files by name (`index-*`, `vendor-react-*`) and missed shared chunks loaded at startup; it now counts exactly what `index.html` loads (module script + modulepreloads). Budgets unchanged (200 KB gz initial, 150 KB gz per chunk) |

Pages carried over, re-pointed at domain endpoints: Login, Dashboard, Nurses (list, onboarding, detail/edit), Contracts (create, renew, transitions, documents), Credentials (catalog, requirements, records, my credentials, verification queue: **new**), Eligibility (states, details, waivers), Workforce (departments, units + bed grid + CSV, positions + assignment, coverage targets: **new**, KPI), Scheduling (week/month board, pool, auto-generate, publish, coverage), Attendance (gaps view), Notifications, Audit (+ verify), Administration (accounts, role assignments, approvals, PAM).

**Porting order (commit 4 implementation note):** V03 pages read and write the browser store that enforced business rules, so each page is ported in the commit that delivers its backend module (5–9). Commit 4 ships the shell (layout, routing, HTTP client, session, i18n/RTL, login, dashboard health) and one scaffold page per module stating what it will contain.

Removed pages: Observability (static values) and the Admin display tabs (Backup/PITR, Privilege separation, FHIR, PDPL static text). Their content moves into `docs/DEPLOYMENT.md` / `docs/SYSTEM_SPECIFICATION.md`. Observability returns when real metrics exist.

## 5. Data

See `DATABASE_CONSOLIDATION.md` (26 models, Prisma Migrate, constraints in migration SQL, one seed). Local dev and CI use PostgreSQL **15** (spec target; drill verified on 15.19). `docker-compose.yml` moves from `postgres:16` to `postgres:15`.

## 6. Scope of V04 (proposal)

| In V04 | Deferred (stays in spec, own migration later) | Not established — not built |
| :--- | :--- | :--- |
| Auth (+ password change, rate limit, own login/session history — D-22), accounts, scoped role assignments, four-eyes, PAM | SSO, MFA (IdP undecided) | Password reset; username login (D-21) |
| Nurse master + contract-first onboarding | Invitation/claim flow (needs SMTP) | Agency workforce |
| Contracts with transition map, documents | — | Leave, absence, attendance states |
| Credentials incl. verification, renewal, suspend/revoke, expiry job | SCFHS sync (U3), ClamAV/vault (D-10) | Overtime, mandatory rest, fatigue |
| Eligibility engine + state + grace + waivers + transitions | Consistency auditor, shadow mode | Acuity, skill mix, mandatory posts |
| Workforce: depts, units, beds (bulk/CSV), positions, coverage targets, KPI (D-11) | Observability metrics | Staffing-ratio enforcement |
| Scheduling: draft, pool, auto-generate, publish, coverage | Demotion notifications to supervisors beyond in-app | |
| Attendance: event ingest + gap query | Feed integration (B-15) | |
| Notifications: in-app + daily scan (N1–N4) | SMTP delivery (adapter present, disabled by default), push | Approval notification rules |
| Audit: single chain + verify; security events | Request log table, PDPL encryption/crypto-shredding (B-07/B-18) | |
| Break-glass: minimal per D-9 | Split-credential ceremony (operational) | |
| Idempotency on onboarding/bulk/publish; worker leases | FHIR, exit package, migration bridge | |

## 7. Commit sequence (stage 2, after approval)

Follows the brief; each commit builds.

| # | Commit | Contents | Build gate |
| :-: | :--- | :--- | :--- |
| 1 | V04 architecture skeleton | workspaces, backend/ frontend/ empty apps, lint/tsconfig, docker-compose (pg15), CI skeleton, docs moved in | `npm run build` both |
| 2 | Database consolidation | schema, `0001_init` migration with SQL constraints/trigger/audit fn, seed (reference + demo) | `prisma validate`, `migrate deploy` twice (drift check), seed twice (idempotent) |
| 3 | Backend consolidation | app/server, config, residency, errors, request-id, prisma, audit lib, health | server starts; health 200 |
| 4 | Frontend consolidation | layout, routing, http client, i18n, login shell, module scaffolds with existing pages ported | `vite build`, bundle gate |
| 5 | Authentication and RBAC | auth, users, role assignments, approvals, PAM, authorize middleware, permissions table | auth + RBAC integration tests |
| 6 | Clinical eligibility | credentials (catalog, requirements, records, documents, lifecycle), engine, state, waivers, grace | engine unit tests from spec acceptance tables |
| 7 | Workforce | departments, units, bed bulk/CSV, positions, coverage targets, nurses + onboarding, contracts | integration tests |
| 8 | Scheduling and attendance | roster, pool, publish, coverage, auto-generate, attendance events/gaps | integration tests |
| 9 | Notifications and audit | scan job, notification API, audit query/verify, jobs + leases, break-glass | job tests with leases |
| 10 | Tests | end-to-end scenarios from brief Phase 15 "Business logic" list | full suite |
| 11 | Documentation | final authoritative doc set | link check |
| 12 | Cleanup | remove anything temporary, CLEANUP_REPORT.md | full validation matrix |

## 8. Documentation set (final)

`docs/SYSTEM_SPECIFICATION.md` · `ARCHITECTURE.md` · `DATABASE.md` · `RBAC.md` · `CLINICAL_ELIGIBILITY.md` · `WORKFORCE.md` · `API.md` · `DEPLOYMENT.md` · `MIGRATION.md` · `CLEANUP_REPORT.md`, plus `docs/reference/AIGH_Nursing_Workforce_Management_System_v2_8_7.md` (verbatim spec for traceability; every condensed doc cites its sections). The seven analysis reports produced now fold into these and are then retired (they describe V03, not V04).

## 9a. Decision record (2026-09-23)

| ID | Decision | Effect on the spec / plan |
| :--- | :--- | :--- |
| D-1 | **Remove** offline demo mode | Frontend always requires the API |
| D-2 | ~~Local only for now~~ — **superseded 2026-09-23:** the owner asked to sync to `https://github.com/cpercibal2018-cmyk/nurse_appV04` (branch `main`); local working copy `C:\WebApp_project\Local_Repo\nurse_appV04` | No V03 tag yet |
| D-3 (C-1) | Onboarding creates a **Draft** contract | **Spec §3.1 amended:** onboarding is atomic (employee + Draft contract + audit); coverage starts only after HR approval (rule C2). Recorded in SYSTEM_SPECIFICATION as a deliberate deviation |
| D-4 (C-2) | **Allow** when no requirement is configured | **Spec §6.1 check 4 amended:** absence of rules is not blocking. The engine adds an informational reason `NO_REQUIREMENTS_CONFIGURED` so the gap stays visible, never silent |
| D-5 (C-8) | **Remove** `DEVELOPER` role | One seeded demo user per real role |
| D-11 (K1) | **Keep** the Ada'a KPI page | Thresholds marked "source not in repository — verify against MoH Ada'a card" in WORKFORCE.md and on the page |
| D-16 (C-5) | **Remove** staffing formula | `CoverageTarget` configured by HR; unset = "unspecified" |
| D-18 (C-7) | **Corrected during implementation:** requirement `unit` is **required**, `position` null = every position in the unit | Spec §5.1.4 states "a unit (required)"; the earlier recommendation (null unit = all units) came from the V03 NestJS schema and contradicted the spec. Matches V03 app behaviour |
| C-17 (new) | Accepted upload types | Contract copy: PDF only (V03 decision, commit `1508316`). Credential evidence: PDF, JPEG, PNG, WebP (spec §5.3.2 allowlist) |
| All others | Recommendations in §9 adopted (D-6…D-10, D-12…D-15, D-17, D-19, D-20) | Can be revisited at any commit |
| D-21 (2026-09-23) | **Login by email only** | **Spec §3.3 amended:** "Login accepts username or email" becomes "Login accepts the account email". No username field is added. Recorded in SYSTEM_SPECIFICATION as a deliberate amendment |
| D-22 (2026-09-23) | **Build own login/session history** (spec §3.3) | Added to V04 scope for commit 9: IP address and user-agent columns on `refresh_sessions` (migration), `GET /api/v1/auth/sessions` (own sessions only), and a self-service page. Moves from "not in scope" to "In V04" |
| D-23 (2026-09-23) | **Confirmed** the commit 5 implementation choices | Login attempt limits (5 per account / 20 per client per 15 min, configurable); account scope = linked employee's unit, unlinked accounts need system-wide scope; R5 windows 90/365 days (source: V03 reference, accepted by the owner); HR provisions accounts with an initial password until email invitations exist |
| D-24 (2026-09-23) | **Two-person approval for credential catalog changes only** (R10 "modifying global eligibility rules" = the hospital-wide catalog) | Creating or changing a credential type (grace days, expiry handling, tracked fields, activity, name, category) is queued; a **different system-wide** HR/System Admin approves and it executes as the approver. The request needs a reason (≥ 10 chars) and shows before → after; an approval is refused (`TEMPLATE_CHANGED_SINCE_REQUEST`) if the type changed after the request. Unit requirements apply immediately (existing audit + affected-employee count). The break-glass account applies catalog changes at once, as spec §3.6 exempts it from four-eyes |
| D-25 (2026-09-23) | **Credential catalog is hospital-wide only** | Only system-wide HR Admins / System Admins create or change credential types, and only they see catalog approval requests; unit-scoped HR manages requirements for their own units |
| D-26 (2026-09-23) | **No action on one's own credential** — all five blocked | Verify, approve renewal, reject renewal, suspend/revoke, and waive are refused when the credential belongs to the acting person, whatever their role |
| D-27 (2026-09-23) | **A nurse with no unit is blocked** (`UNIT_NOT_ASSIGNED`) | Spec §6.1 is silent; confirmed as the V04 rule |
| D-28 (2026-09-23) | **System Admins cannot issue waivers** (spec §6.1.2 literal) | Supervisor or HR Admin only. The break-glass account acts as System Admin, so it cannot issue waivers either |
| D-29 (2026-09-23) | **Contract transition map** | Draft → submit → PendingApproval → approve → Approved (future) / Active (covers today), or return → Draft. Approved/Active → suspend or terminate. Suspended → reinstate (Approved/Active by date, overlap re-checked). Terminated is final. Expired only by the daily job; Superseded not set by hand |
| D-30 (2026-09-23) | **A contract is approved by a different HR person** | The creator and the submitter cannot approve it (`SELF_APPROVAL_FORBIDDEN`); stored in the new `contracts.created_by_id` / `submitted_by_id` columns (migration `20260923120000_contract_actors`) |
| D-31 (2026-09-23) | **Shift times = V03's**: Morning 07:00–15:00, Evening 15:00–23:00, Night 23:00–07:00 (next day), Asia/Riyadh | Kept in one file (`backend/src/config/shifts.ts`) so they can change; used by attendance gaps |
| D-32 (2026-09-23) | **Home unit only** — no floating | A nurse is drafted and published only in their own unit: the engine checks the home unit's credential rules, so floating would skip the target unit's rules. A unit move demotes future published shifts. Floating needs an engine change first |
| D-33 (2026-09-23) | **Attendance: gap view now, badge feed later** | Events list and gap view built; the PACS ingest endpoint waits for its contract (auth, format, delivery — B-15) |

### Implementation notes — commit 5 (authentication and RBAC)

| Topic | What was built | Status |
| :--- | :--- | :--- |
| **Timestamp bug found and fixed** | Prisma 7.10's pg adapter sends Dates without an offset; on a PostgreSQL server whose time zone is not UTC (e.g. Asia/Riyadh) every Prisma-written timestamp was stored 3 h early while `now()` was right. Every connection now pins `TimeZone=UTC` (`lib/prisma.ts`); a regression test forces an Asia/Riyadh connection. CI's UTC container could never have shown it | Fixed; affects every later commit |
| Login attempt limits | Per account and per client, fixed window, in memory (single API process) | Spec §3.3 requires limits but gives no numbers. Defaults 5/15 min per account, 20/15 min per client; configurable. **Confirmed by the owner (D-23)** |
| CSRF | Session-bound: `sha256(csrfToken)` is a claim in the access token; mutations compare the header to it and require the app `Origin`. Refresh (cookie-authenticated) uses Origin + double-submit cookie | Meets spec §3.4 without a schema change |
| Sessions (D-6) | 15 min access; refresh idle 1 h; absolute 24 h copied through every rotation; logout / password change / deactivation revoke the family so live access tokens stop at once | As decided |
| Password rule | 12–72 characters (spec §3.2) **and** ≤ 72 bytes UTF-8, because bcrypt ignores bytes beyond 72 (a long Arabic password would be silently truncated) | Byte limit is a technical necessity, not a policy |
| Accounts | HR provisions accounts with an initial password; the invitation/claim flow (spec §3.2) stays deferred until SMTP exists (§6). A scoped HR admin administers accounts whose linked employee is in scope; unlinked accounts need system-wide scope | **Confirmed (D-23)** |
| R5 expiry windows | 90 days SUPERVISOR, 365 others | Source is the V03 NestJS reference, not the spec — **accepted by the owner (D-23)** |
| PAM | Reason ≥ 10 chars, 1–4 h, default 2 h (V03 reference values; spec says "e.g., 2 hours") | Expired elevations are ignored at once; cleanup job in commit 9 |
| Break-glass (D-9) | Siren on successful sign-in of the flagged account: irrevocable event, HIGH audit, CRITICAL in-app notification to System Admins; root access without PAM/four-eyes; session and access end at 4 h. Failed attempts on it are audited HIGH | SMS/email to CEO + IT Director not built (no SMTP/SMS) |
| Workforce reads | `GET /departments`, `GET /units` brought forward from commit 7 (the role-assignment scope picker needs them); read-only | Writes stay in commit 7 |

**Commit 5 validation (2026-09-23)** found and fixed five defects, each reproduced by a failing test first: logout lacked the CSRF check (spec §3.4 "all state-changing requests"); login lacked an Origin check (login CSRF); deactivating an account could remove the last System Admin, bypassing R8; R8 counted assignments held by deactivated accounts; an administrator could re-link their own account to another employee. API responses now also carry `Cache-Control: no-store`.

### Implementation notes — commit 6 (credentials and clinical eligibility)

| Topic | What was built | Status |
| :--- | :--- | :--- |
| Template PATCH defect | A partial update filled omitted fields with their create defaults (`.partial()` keeps zod defaults), so changing grace days also cleared the tracked fields | Found while building D-24; fixed and covered by a test |
| Engine | `modules/eligibility/engine.ts`, pure: spec §6.1 order; D-4 (no rules → ELIGIBLE + `NO_REQUIREMENTS_CONFIGURED`); D-15 (dates checked against the evaluated day; waiver per template); §5.1.4 position-specific rule overrides unit-wide; grace §6.1.1; transitions §6.1.1.1; 33 unit tests from the acceptance tables, mutation-checked | As specified |
| New status | `ELIGIBLE_WITH_POLICY_WARNING` added (spec §6.1.1.1 names it; the consolidated schema lacked it). Migration `20260923060000_credential_review_and_policy_warning` also adds `document_versions.review_status` and `credentials.latest_evidence_id` (spec §5.1.5) | Schema gap closed |
| Materialized state | Refreshed inside the transaction of every credential, requirement, template and waiver change (L6); status changes audited | Date passage (expiries, waiver ends, deadlines) and stored-status transitions (Valid → ExpiringSoon → Expired) need the daily job — **commit 9**. The engine checks dates itself, so eligibility is never wrong in the meantime; only the stored snapshot and the stored credential status can lag |
| Grace log | Grace activation/completion/closure are HIGH audit events, as DATABASE_CONSOLIDATION decided — no separate `grace_period_log` table (the spec's acceptance wording names one) | Deviation, documented |
| Grace no-stacking | A grace window is tied to one expiry cycle (`graceCycleId`); approval clears it; rejection or suspension/revocation closes it so re-submitting cannot reopen it | Conservative reading of "no stacking" |
| Uploads (D-10) | Magic-byte + size checks; development marks CLEAN; downloads CLEAN-only and audited. **Production refuses to start** (`UPLOAD_SCANNER`) until a ClamAV adapter exists | As decided in D-10 — production is blocked until a scanner is built |
| Unassigned employee | No unit → no rule can apply → **blocked** (`UNIT_NOT_ASSIGNED`) rather than cleared without any credential check | **Confirmed (D-27)** |
| Separation of duties | Nobody verifies, suspends, revokes or decides the renewal of their own credential, or waives their own credential | **Confirmed (D-26)** |
| Catalog scope | Only system-wide HR/System Admins change templates (one hospital catalog); scoped HR manages rules for their units | **Confirmed (D-25)** |
| Waiver authority | Spec §6.1.2 read literally: Supervisor or HR Admin only; **System Admin receives 403** | **Confirmed (D-28)** |
| Transition deadline | Judged against today (spec: `CURRENT_DATE`), not the shift date | Spec literal |
| R10 "modifying global eligibility rules" | Four-eyes on every credential-type (catalog) change; unit requirements apply immediately | **Decided (D-24)** — built as a follow-up to commit 6 |

### Implementation notes — commit 7 (workforce, employees, contracts)

| Topic | What was built | Status |
| :--- | :--- | :--- |
| Organisation scope | Departments, unit create/move/deactivate, positions and CSV import need **system-wide** HR/SA; bed counts and coverage targets follow **unit scope**; bed history is readable by scoped Supervisors | Interpretation (same principle as D-25) — **owner to confirm** |
| W1–W8 | Deactivation guards (W1, W2, W6); beds 0–500 with reason and one log row per change (W4); bulk per-row results committed together (W5); schedulability change re-evaluates holders; coverage target `null` = unspecified (W8) | As specified |
| CSV import | V03 kit behaviour (dry run default, never deletes) plus RFC 4180 quoting, BOM handling and case-insensitive code matching (V03 split on every comma) | Improved port |
| Onboarding | Employee + Draft contract + HIGH audit + eligibility state in one transaction (D-3, D-17); Hijri dates converted by the server, not taken from the browser | As decided |
| **REQUIREMENT NOT ESTABLISHED** — Supervisor private fields | The spec says "private fields suppressed" without a list. Suppressed: salary, marital status, nationality, file no., rank/grade, contact email, job post, actual work place. Shown: name, job number, unit, position, job title, specialty, status, hire date | **Owner to confirm the list** |
| Own contract / own record | Nobody creates, renews, transitions or uploads to their **own** contract, or deletes their own employee record (`SELF_ACTION_FORBIDDEN`) — the D-26 principle applied to contracts | Extension of D-26 — **owner to confirm** |
| **CONFLICT — renewal timing (C7 vs spec §4.2)** | V03 (`contracts.ts:130-147`, rule C7) allowed renewal only after all Approved/Active coverage had ended, which forces a gap between contracts. Spec §4.2 says an Approved future period may sit next to the current one ("approval does not supersede the current contract"; C12). **V04 follows the spec:** renewal is allowed any time; the approval overlap check (C4) and the database constraint prevent overlap | **Owner to confirm** |
| C11 contract copy | V03 required the PDF on the create form. V04 creates the Draft first and requires a CLEAN copy before **submit** — the copy is still mandatory before approval | Same rule, different step |
| Own phone update (spec §3.3) | Not built: the employee schema has no phone column | **REQUIREMENT NOT ESTABLISHED** |
| KPI (D-11) | Ported engine; response and page state that the Ada'a card is not in the repository. Unit → area map is V03's (by unit code). Beds count **active** units only (V03 counted inactive critical units in KPI A) | Kept per D-11; thresholds unverified |
| Stored status lag | Approved → Active at start date and Active → Expired at end date need the daily job (commit 9). The engine treats Approved and Active alike for coverage (C12), so eligibility is correct meanwhile | Same pattern as commit 6 |

### Implementation notes — commit 8 (scheduling and attendance)

| Topic | What was built | Status |
| :--- | :--- | :--- |
| Who schedules (D-14) | Only scoped Supervisors draft, auto-fill, cancel and publish; HR / System Admin read the board and coverage | As decided |
| Live eligibility (L7) | Board, pool, auto-fill and publish all run the engine for the shift date; facts are loaded once per nurse per request | As specified |
| Publication (S3, L8) | One transaction, advisory lock per unit; INELIGIBLE stays Draft with reasons; grace/waiver reliance stored on the assignment, returned and audited | As specified |
| Revalidation (§6.2) | Built into `refreshEligibility`, so every change that refreshes a nurse re-checks their future published shifts; invalid → Draft + HIGH audit + supervisor notice | As specified. Date passage (a credential expiring tomorrow) needs the daily job — **commit 9** |
| Auto-fill | V03 filled to the removed bed formula (D-16); V04 fills to configured targets only. **Heuristics, not policy:** one auto-filled shift per nurse per day, fewest shifts first. Manual drafting can still give a nurse two shifts in a day (only S1 applies) | Rest/fatigue rules **REQUIREMENT NOT ESTABLISHED** |
| Past dates | Drafting and publishing refuse shift dates before today | Implementation safeguard |
| Coverage | Eligible, non-cancelled assignments counted per status; shortage = target − published eligible; never blocks (S4) | As specified |
| **Spec issue — early clock-in** | Spec §14.2's query counts only clock-ins **at or after** the shift start, so a nurse who badges in at 06:50 for 07:00 shows as MISSING. Kept literal (test documents it) | **Owner to confirm** — recommend counting clock-ins from a set time before the start |
| Gap alerts | On-demand view only; the 15-minute worker and "Critical Coverage Alert" push are **commit 9** | Planned |
| API map correction | §2.10 said "after 15 min"; the spec says 30 minutes. The map now says 30 | Corrected |

### Implementation notes — commit 9 (notifications, audit, jobs, own sessions)

| Topic | What was built | Status |
| :--- | :--- | :--- |
| Scheduler | One minute tick; each period is a unique `job_runs.run_key` (completed once, failed/stuck retried up to 5 attempts, missed days run on next start — N4); `worker_leases` stops two processes running one job | Spec §10.3 lease + run history. `JOBS_MODE=in-process` (default, development), `worker` for production with `npm run worker`, `off` |
| Daily transition | Everything date-driven that commits 6–8 left to "the daily job": contract and credential statuses, grace closure (+ HR notice), PAM and break-glass expiry, idempotency purge, full eligibility refresh (which demotes invalid future published shifts) | As specified. First run on the dev data corrected the three V03 credentials stored as Valid with past expiry dates |
| **REQUIREMENT NOT ESTABLISHED** — reminder milestones | Spec §7.1 names the event key (record + expiry date + milestone) but not the milestones. V04 sends one notice on entering the window (90 days contracts, 60 days credentials) and one when a credential has expired | **Owner to confirm** (e.g. add 30/14/7-day reminders) |
| Email | Notifications are stored with `emailStatus = SKIPPED`: SMTP is not decided (spec §7.2 worker not built); unregistered employees receive nothing yet | Deferred with SMTP |
| Coverage alerts | Spec §14.2 "push notification" is an in-app CRITICAL notice to the unit's supervisors; suppression is provable (one per assignment via the unique event key) | Push channel not built |
| Role expiry | Expired role assignments stop working at once (queries filter on `expiresAt`); no separate "expired" audit row is written | As built in commit 5 |
| Audit reading | System Admin only (D-20), search + chain verification; HR audit access still **REQUIREMENT NOT ESTABLISHED** | As decided |
| Own session history (D-22) | `refresh_sessions.ip_address` / `user_agent` (migration `20260923180000_session_meta_and_job_runs`), `GET /auth/sessions`, Sign-in history page | Done |

### Proposals received with the D-24…D-28 decisions — not adopted yet

The owner's notes for D-24…D-28 also suggested features beyond those decisions. None is specified, so each is **REQUIREMENT NOT ESTABLISHED** until the owner schedules it:

| Proposal | Note |
| :--- | :--- |
| Route a lone HR Admin's own credential to hospital-wide HR automatically | Today any other in-scope HR Admin or a System Admin can act; there is no routing engine |
| Employee "report status change" button (self-report → under review, pause shifts, HR ticket) | New workflow; needs definition of the "under review" effect on eligibility |
| In-app "request a new credential type" form for unit HR | New workflow; D-25 currently means asking hospital-wide HR outside the app |
| Primary-source verification APIs, HRIS sync | The examples given (Nursys, US state boards, AHA, Workday) are US systems; the Saudi equivalent would be SCFHS. No integration is specified |
| SMS / e-mail expiry reminders at 90/60/30/14 days | Spec §9 defines in-app notifications; SMTP/SMS are deferred (§6). Reminder schedule not specified |
| E-mail alerts to CNO / HR Director / IT Security on break-glass use | Break-glass already sounds an in-app CRITICAL alert to System Admins (R18); named recipients and e-mail are not specified |

## 9. Decisions required before stage 2

Each row names the conflict it resolves, my recommendation, and the consequence. **Nothing below is assumed. Stage 2 starts only once these are answered.**

| ID | Question | Options | Recommendation | Consequence of recommendation |
| :--- | :--- | :--- | :--- | :--- |
| **D-1** | Keep the standalone (no-backend) demo mode? | Keep / remove | **Remove** | Removes the second copy of every rule; a demo needs `docker compose up` |
| **D-2** | Where does V04 live? | New GitHub repo `nurse_appV04` / branch in V03 | **New repo**; tag V03 `v03-final` and leave V03 read-only as the archive | Clean history; V03 remains the historical record. Creating the GitHub repo is your action or needs your go-ahead |
| **D-3** (C-1) | Contract created by onboarding | **Approved** (spec §3.1, atomic contract-first) / **Draft** (V03 since `bb8ecfd`) | Your call. If Draft: amend spec §3.1 in `SYSTEM_SPECIFICATION.md` | Approved: onboarded nurse can be eligible immediately. Draft: HR approval step first, nurse ineligible until then |
| **D-4** (C-2) | Eligibility when no requirement is configured | Block (spec + U2 pack) / eligible (V03 behaviour) | **Block** (spec's explicit safety rule) | Until the U2 credential policy is signed, every nurse in a unit/position without rules is INELIGIBLE. Demo seed must include illustrative requirements |
| **D-5** (C-8) | `DEVELOPER` full-access role | Keep / remove | **Remove.** Seed one demo user per role instead | Four-eyes, PAM and separation of duties cannot be bypassed |
| **D-6** (C-10) | Session lifetimes | Spec: 1 h validity, 24 h absolute / V03: 15 min access + 7 d refresh | **15 min access token, 1 h idle, 24 h absolute** (satisfies spec) | Users re-login daily |
| **D-7** (C-12) | Audit hash formula | gate1 (unstored timestamp) / backend JSON / new | **SQL function hashing stored columns incl. `created_at`** | Chain linkage *and* content verifiable |
| **D-8** (C-13) | Id type | Int / UUID | **Int autoincrement** (running system, spec SQL, gate1, "numeric account identifiers" §3.3) | Matches all executed code; non-guessable ids are not a spec requirement |
| **D-9** | Break-glass depth in V04 | None / minimal / full | **Minimal:** dedicated account flag, activation writes `break_glass_events` + HIGH audit + CRITICAL in-app notification to SA users, session hard-capped at 4 h. SMS/email to CEO + IT Director **not** built until SMTP/SMS decided | Rule R18 partially met; documented gap |
| **D-10** | Upload scanning without ClamAV | Keep V03 simulation (magic bytes → CLEAN) in dev only / require ClamAV | **Dev: magic-byte check marks CLEAN; production config refuses to start without a scanner** | D4 honoured in production; dev usable |
| **D-11** (K1) | Ada'a KPI thresholds | Keep with a source citation / remove | **Keep only if you can provide the MoH Ada'a indicator card** (reference into `docs/WORKFORCE.md`) | Otherwise the KPI page is removed |
| **D-12** | Shared code package | none / `shared/` workspace | **None** (see §2) | Two ~30-line display helpers exist in both packages, documented |
| **D-13** | Runtime versions | Spec: Node 20 / PG 15 | **Node 22 LTS, PostgreSQL 15** | Spec §0.2/§11.4 amended for Node |
| **D-14** (C-9) | Who drafts and publishes rosters | Spec: scoped Supervisor; HR read by default / V03: HR only | **Spec** | HR needs a Supervisor assignment to publish |
| **D-15** (C-3, C-4) | Waiver and credential-date semantics | Spec / V03 live engine | **Spec** (per-template waiver; dates checked against shift date) | Some V03 demo nurses change eligibility |
| **D-16** (C-5) | Staffing requirement formula `beds × 0.14/0.11/0.10` | Keep as default / remove | **Remove.** Coverage targets are entered per unit/shift; absent = "unspecified" | Roster shows "target not set" until HR configures targets |
| **D-17** | Onboarding atomicity mechanism | Spec: SECURITY DEFINER SQL function + runtime INSERT revoked / Prisma transaction | **Prisma interactive transaction** (brief: Prisma is the authoritative access layer); DB constraints still enforce uniqueness/overlap | Deviation from spec's "Bulletproof Rule" wording; documented in SYSTEM_SPECIFICATION |
| **D-18** (C-7) | Requirement nulls | null = all units / unit required | **null = all** for both unit and position | HR can express hospital-wide rules |
| **D-19** (C-16) | Unique contact email | yes / no | **No** (not established) | — |
| **D-20** | Audit read access for HR | SA only / HR scoped | Not established. **SA only** until decided | HR cannot browse audit |
