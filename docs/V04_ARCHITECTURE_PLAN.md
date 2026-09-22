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
│  │  ├─ lib/                    prisma.ts · audit.ts (fn_append_audit_entry wrapper) · dates.ts · hijri.ts · storage.ts · worker-lease.ts · http-errors.ts
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
| Stack | React 18, Vite, TypeScript strict, antd 5 (retained: every V03 screen uses it; a rewrite gains nothing), react-router 6, i18next (en/ar + RTL retained) |
| Server state | React Query hooks in `modules/<domain>/api.ts`; mutations show server errors (no optimistic fire-and-forget) |
| Client state | Zustand only for session (user, roles, scopes) and UI preferences (theme, language) |
| Auth | `services/http.ts` (from V03 `api.ts`): in-memory access token, CSRF header, single-flight refresh. Login waits for the server; no email-based role guessing |
| Access UI | `usePermissions()` derived from `/auth/me`; navigation and buttons hidden when not permitted. **Never the enforcement point** |
| Standalone demo mode | **Removed** (D-1). The app always needs the API |
| Bundle | Route-level lazy loading kept; fail-closed budget gate (kit version) in CI |

Pages carried over, re-pointed at domain endpoints: Login, Dashboard, Nurses (list, onboarding, detail/edit), Contracts (create, renew, transitions, documents), Credentials (catalog, requirements, records, my credentials, verification queue: **new**), Eligibility (states, details, waivers), Workforce (departments, units + bed grid + CSV, positions + assignment, coverage targets: **new**, KPI), Scheduling (week/month board, pool, auto-generate, publish, coverage), Attendance (gaps view), Notifications, Audit (+ verify), Administration (accounts, role assignments, approvals, PAM).

Removed pages: Observability (static values) and the Admin display tabs (Backup/PITR, Privilege separation, FHIR, PDPL static text). Their content moves into `docs/DEPLOYMENT.md` / `docs/SYSTEM_SPECIFICATION.md`. Observability returns when real metrics exist.

## 5. Data

See `DATABASE_CONSOLIDATION.md` (26 models, Prisma Migrate, constraints in migration SQL, one seed). Local dev and CI use PostgreSQL **15** (spec target; drill verified on 15.19). `docker-compose.yml` moves from `postgres:16` to `postgres:15`.

## 6. Scope of V04 (proposal)

| In V04 | Deferred (stays in spec, own migration later) | Not established — not built |
| :--- | :--- | :--- |
| Auth (+ password change, rate limit), accounts, scoped role assignments, four-eyes, PAM | SSO, MFA (IdP undecided) | Password reset |
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
| D-2 | **Local only for now**: `C:\WebApp_project\Local_Repo\nurse_appV04` with local git; no GitHub repo, no V03 tag yet | Revisit before first push |
| D-3 (C-1) | Onboarding creates a **Draft** contract | **Spec §3.1 amended:** onboarding is atomic (employee + Draft contract + audit); coverage starts only after HR approval (rule C2). Recorded in SYSTEM_SPECIFICATION as a deliberate deviation |
| D-4 (C-2) | **Allow** when no requirement is configured | **Spec §6.1 check 4 amended:** absence of rules is not blocking. The engine adds an informational reason `NO_REQUIREMENTS_CONFIGURED` so the gap stays visible, never silent |
| D-5 (C-8) | **Remove** `DEVELOPER` role | One seeded demo user per real role |
| D-11 (K1) | **Keep** the Ada'a KPI page | Thresholds marked "source not in repository — verify against MoH Ada'a card" in WORKFORCE.md and on the page |
| D-16 (C-5) | **Remove** staffing formula | `CoverageTarget` configured by HR; unset = "unspecified" |
| All others | Recommendations in §9 adopted (D-6…D-10, D-12…D-15, D-17…D-20) | Can be revisited at any commit |

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
