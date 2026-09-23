# Legacy Repository Inventory — nurse_appV03

> **Historical (stage-1 analysis of V03, 2026-09-22).** Kept for traceability; it describes V03 and the plan for V04, not V04 as built. For V04 see [docs/README.md](../README.md). Content unchanged since it was retired in commit 12, except that relative links were adjusted for the move.

| | |
| :--- | :--- |
| **Source** | https://github.com/cpercibal2018-cmyk/nurse_appV03.git |
| **Commit analysed** | `de82bfb` (main, 2026-09-23 00:40 +0300) — 37 commits. Branch `arena/01a0c533-nurse-appv03` is fully contained in `main`. |
| **Local clone** | `C:\WebApp_project\Local_Repo\app` (not modified by this analysis, apart from a fast-forward of `main` to `origin/main`) |
| **Analysis date** | 2026-09-23 |
| **Size** | 160 tracked files, 48,989 lines (41,683 excluding lockfiles and images). 16,965 of those lines are two versions of one specification document. TypeScript/TSX: 10,545 lines; `.mjs` 1,238; shell 1,593; SQL 542; Python 2,482. |

Classification codes used throughout (defined in the brief): **KEEP · MERGE · REFERENCE · ARCHIVE · DELETE · UNKNOWN**. *ARCHIVE* means "not carried into the V04 source tree; remains available in the V03 repository (tagged) as history." Nothing is deleted from V03 itself.

---

## 1. What this repository actually is

The history (`git log`) shows three distinct layers laid on top of each other:

| Layer | Period (commits) | What it produced | Runs? |
| :--- | :--- | :--- | :--- |
| **1. Specification workspace** | `fb74999` → `8287a22` | A 8,096-line spec (v2.8.6) + a 5-script Python patch chain that rewrites it into v2.8.7 (rev 2.8.7c), reviews, decision packs, a backup/PITR drill kit | Patch chain: yes (verified, see §9). Spec is documentation. |
| **2. Reference code kits** | `75251ef` and earlier | `backend/` (NestJS role-matrix module + 34-model Prisma schema) and `wave1a-kit/` (NestJS drop-in files) | **No.** Written against an application package that "was not available in this workspace" (wave1a-kit/README.md:97). `backend/` uses a mock auth guard that always returns `true`. |
| **3. Runnable demo application** | `4129af1` → `de82bfb` | `app/` (React/Vite/antd, business logic in a Zustand store) + `server/` (Express + Prisma, 14 models, generic CRUD, real JWT auth) + `docker-compose.yml` | **Yes.** `app`: `tsc -b` exit 0, test suite 212/212 pass. `server`: `tsc --noEmit` exit 0. Both Prisma schemas validate. |

**Consequence for V04:** There are three backend implementations (Express `server/`, NestJS `backend/`, NestJS `wave1a-kit/backend`), four schema definitions (two Prisma schemas, `gate1-kit/sql/*.sql`, and SQL embedded in the spec), and business rules in two places (the frontend store and the spec). Only the Express + React pair is wired together and running.

---

## 2. Top-level inventory

| Path | Type | Lines | What it is | Classification |
| :--- | :--- | ---: | :--- | :--- |
| `app/` | Frontend | 8,437 | React 18 / Vite 5 / TS / antd 5 / Zustand / React Query / i18next. **The only frontend.** Contains most business logic. | **MERGE** → `frontend/` (see §3) |
| `server/` | Backend (Express) | 2,065 | Express 4 + Prisma 5, 14 models, JWT/bcrypt/refresh rotation/CSRF, generic CRUD. **The running backend.** | **MERGE** → `backend/` (base lineage for V04 auth + app skeleton) |
| `backend/` | Backend (NestJS) | 2,021 | Reference: role-matrix CRUD, four-eyes, PAM, audit service, 34-model schema, V50 SQL | **MERGE** (logic + schema concepts) → V04 `backend/` |
| `wave1a-kit/` | Reference kit (NestJS) | 2,417 | 12 "Wave 1A" drop-in files: worker leases, idempotency, residency check, bulk bed capacity, eligibility-state tx, auditor, tests, CI | **MERGE** (selected logic) / **ARCHIVE** (rest) |
| `gate1-kit/` | Ops tooling | 2,296 | PostgreSQL 15 WAL archiving, encrypted base backup, PITR restore, failure drill, systemd timer, drill SQL fixtures | **KEEP** → `ops/backup/` |
| `gate1-drill/` | Evidence | 185 | Logs + public key + signed-off evidence from the executed 2026-09-18 drill | **ARCHIVE** (keep in V03; reference from `docs/DEPLOYMENT.md`) |
| `uploads/` | Spec source | 8,096 | Untouched v2.8.6 specification (input to patch chain) | **ARCHIVE** |
| `scripts/` | Tooling | 136 | `setup-prisma-stubs.mjs` — writes `any`-typed fake Prisma clients into `node_modules` for a sandbox without network access | **DELETE** |
| `*.py` (7 files) | Patch chain | 2,482 | Spec patch chain + replay + verifier + review annotator | **ARCHIVE** (§9) |
| Root `*.md` (18 files) | Documentation | 13,225 | Spec, reviews, analyses, decision packs, role matrix, summaries | See §6 |
| `docker-compose.yml` | Runtime | 54 | db + api + web (dev/demo topology) | **MERGE** → V04 `docker-compose.yml` |
| `docker-compose.full-spec.yml` | Reference | 146 | Spec topology: proxy · api · worker · db · redis (references files that do not exist, e.g. `deploy/nginx.conf`) | **REFERENCE** → content into `docs/DEPLOYMENT.md` |
| `.env.example` (root) | Config | 103 | Production-shaped env list. **Contains a residency error** (see §8, conflict R-1) | **MERGE** (corrected) |
| `.gitignore`, `.gitattributes` | Config | 44 | Secrets/backup exclusions; LF pin for seed snapshot | **MERGE** |

---

## 3. `app/` — frontend (the running UI)

| Path | Lines | Content | Classification | Notes |
| :--- | ---: | :--- | :--- | :--- |
| `src/lib/store.tsx` | 1,160 | Zustand store: **all** client state + business rules (onboarding, contract guards, eligibility, waivers, publication, bed capacity, CSV import, attachments, audit chain, mock login) | **MERGE** | Rules move to backend services; UI state stays in the frontend. Single most important file in the repo. |
| `src/lib/contracts.ts` | 161 | Contract period rules (coverage statuses, overlap, renewal eligibility, renewal prefill), PDF acceptance (magic bytes, 10 MB) | **MERGE** | Becomes shared backend rule module; the picker keeps a UI copy of the PDF check. |
| `src/lib/eligibility.ts` | 67 | `checkEligibility()` — **zero callers** (dead code). Stricter than the live engine (checks expiry date, per-template waivers). | **MERGE** | Its rules are input to the V04 engine; the file itself is dead. |
| `src/lib/kpi.ts` | 197 | Ada'a Nurse-to-Bed KPI A (ICU/ER/OR codes 1–4) and KPI B (QFR-55) | **MERGE** → backend `workforce` | Thresholds cite an external MoH card **not present in the repo** — see FEATURE inventory rule K-1. |
| `src/lib/roster.ts` | 68 | Shift types (M/E/N times), **hard-coded staffing factor** `M 0.14 / E 0.11 / N 0.10 × beds`, coverage colours | **MERGE** (shift types) / factor = conflict | Spec §2.9 L813 requires *configured* per-unit/per-shift targets. |
| `src/lib/hijri.ts` | 98 | Gregorian → Umm al-Qura via `Intl` `islamic-umalqura` | **KEEP** (shared, used by both UI display and backend storage) | Spec §4.2 names `Intl` as "the only basis accepted". |
| `src/lib/i18n.tsx` | 122 | en/ar resources + RTL switch | **KEEP** | |
| `src/lib/api.ts` | 120 | Fetch client: in-memory JWT, CSRF double-submit, single-flight refresh, `syncWrite` fire-and-forget | **MERGE** | Keep the auth mechanics; drop fire-and-forget writes and generic CRUD calls. |
| `src/lib/api/roles.api.ts` | 461 | **Third RBAC implementation**: localStorage mock of role assignments, four-eyes, revoke; writes a **second audit log** to `localStorage['aigh_audit_log']` | **MERGE** (validation rules) | Replaced by real API calls. |
| `src/data/seed.ts` | 165 | Departments (5), units (47 / 582 beds), positions (16), credential categories (5) / templates (16), 8 demo employees, 8 contracts, 6 requirements, bed log | **MERGE** → backend seed | Source of `server/prisma/seed-data.json`. |
| `src/main.tsx` | 64 | Bootstrap + **third residency check** (allowlist includes `me-central-1`) | **MERGE** (bootstrap) / residency code **DELETE** | Residency is a server concern; this copy contradicts the spec. |
| `src/App.tsx` | 83 | 16 lazy routes + ProtectedRoute | **MERGE** | |
| `src/components/AppLayout.tsx` | 245 | Sidebar (no role filtering), theme, language, preload | **MERGE** | V04 adds role-aware navigation. |
| `src/components/PageSkeleton.tsx` | 10 | Loading skeleton | **KEEP** | |
| `src/modules/auth/LoginPage.tsx` | 101 | Login form, logo | **MERGE** | |
| `src/modules/dashboard/DashboardPage.tsx` | 266 | KPIs, gauges, counts | **MERGE** | |
| `src/modules/workforce/WorkforcePage.tsx` | 377 | Employee list, onboarding form (field order per spec §3.1), view/edit | **MERGE** → `modules/nurses` | |
| `src/modules/workforce/WorkforceRoutes.tsx` | 5 | One-line wrapper around WorkforcePage (only used for preload) | **DELETE** | |
| `src/modules/workforce/DepartmentsPage.tsx` | 113 | Department CRUD | **MERGE** → `modules/workforce` | |
| `src/modules/workforce/PositionsPage.tsx` | 202 | Position directory + HR-only Position Assignment | **MERGE** | Only UI screen with a role check (`HR_ADMIN` only; store also allows `DEVELOPER`). |
| `src/modules/workforce/UnitCapacityGrid.tsx` | 181 | Unit list, bed capacity edit, bulk edit, CSV import (dry-run) | **MERGE** | Duplicate of `wave1a-kit/frontend/.../UnitCapacityGrid.tsx` (273 lines, API-based but imports a non-existent `apiFetch`). |
| `src/modules/contracts/ContractsPage.tsx` | 711 | Create / Renew / approve / status change, contract copy PDF upload + versioning, view copy | **MERGE** | Re-implements the overlap check already in the store (duplicate logic, L192/L235). |
| `src/modules/credentials/CredentialsModule.tsx` | 250 | Catalog view, requirements CRUD, credential entry + PDF evidence | **MERGE** | |
| `src/modules/credentials/MyCredentialsPage.tsx` | 160 | Employee self-service credentials | **MERGE** | Matches `credential.employeeId === currentUser.id` — conflates user id and employee id (no link exists in any schema). |
| `src/modules/eligibility/EligibilityModule.tsx` | 154 | State table, refresh, details, emergency waiver form | **MERGE** | Waiver `waivedBy` hard-coded to `1`; no authority check. |
| `src/modules/scheduling/SchedulingModule.tsx` | 322 | Week board / month calendar, assign, auto-generate, publish | **MERGE** | Auto-generate ignores `isSchedulable`; coverage counts Draft + Published together. |
| `src/modules/kpi/NursingKpiPage.tsx` | 237 | Ada'a KPI page | **MERGE** | |
| `src/modules/notifications/NotificationsModule.tsx` | 84 | List + mark read + demo "generate" buttons | **MERGE** | No scan exists; notifications are seeded or added by demo buttons. |
| `src/modules/audit/AuditModule.tsx` | 85 | Audit list + client-side chain-link check | **MERGE** | |
| `src/modules/observability/ObservabilityPage.tsx` | 132 | Health vitals — **static hard-coded values** from the store | **MERGE** (layout) | Values must come from real metrics or be removed. |
| `src/modules/admin/AdminModule.tsx` | 271 | Tabs: Backup/PITR, Privilege separation, PAM & Four-Eyes, FHIR, PDPL — **static display text/tables** | **REFERENCE** | Describes spec features; no functioning logic. |
| `src/modules/admin/RoleMatrixPage.tsx` + `components/*` | 500 | Role assignments CRUD UI, grant drawer, revoke modal, pending approvals | **MERGE** → `modules/administration` | |
| `scripts/verify-employee-fields.mjs` | 639 | **The app's only test suite** (20 sections, 212 checks): onboarding, contracts, Hijri, PDF, migration, seed drift | **MERGE** → V04 tests (re-targeted at backend services) | No tests for eligibility, RBAC, scheduling, KPI. |
| `scripts/export-seed-data.mjs` | 113 | Generates `server/prisma/seed-data.json` from `seed.ts` | **DELETE** after consolidation | V04 has one seed in the backend, so no cross-package snapshot is needed. |
| `scripts/check-bundle-size.mjs` | 60 | Bundle gate — **exits 0 when there is no build** | **MERGE** with wave1a version | wave1a version fails closed (correct). |
| `public/logo-light.jpg`, `logo-dark.jpg` | — | Logos (favicon + login use light; sidebar uses dark) | **KEEP** | |
| `public/logo.jpg` | 400 | Original logo — **no remaining references** (verified by search of `index.html` and `src/`) | **DELETE** (duplicate asset) | |
| `index.html`, `vite.config.js`, `tsconfig*.json`, `package.json`, `Dockerfile`, `.env.example`, `.dockerignore` | — | Build config | **MERGE** | `vite.config.js` has `allowedHosts: true`, `hmr.clientPort: 443` (arena preview settings) — remove. `package.json` `lint` script references ESLint which is not a dependency. |
| `README.md` | 250 | App README with coverage claims ("Full implementation of 39 specification sections") that overstate what runs | **DELETE** (superseded by V04 docs) | |

---

## 4. `server/` — running Express backend

| Path | Lines | Content | Classification |
| :--- | ---: | :--- | :--- |
| `src/auth.ts` | 189 | HS256 JWT on `node:crypto` (alg pinned, constant-time compare), `requireAuth`, `requireRole`, `WRITE_ROLES`, refresh/CSRF cookie options, double-submit CSRF, Origin check | **MERGE** → `backend/src/modules/auth` + `middleware` |
| `src/index.ts` | 269 | CORS, login (bcrypt, timing-safe user enumeration), refresh rotation with **family revocation on reuse**, logout, `/me`, `/bootstrap` (returns every table to any authenticated user), generic CRUD `/api/:entity` for 12 entities, safe error mapping | **MERGE** (auth + error handling) / generic CRUD **DELETE** |
| `prisma/schema.prisma` | 191 | 14 models; dates as `String`; almost no FK relations; no enums | **MERGE** → V04 schema |
| `prisma/seed.ts` | 123 | Seeds from snapshot + inline credentials/shifts + 6 demo users (password `demo1234`) | **MERGE** |
| `prisma/seed-data.json` | 1,223 | Generated snapshot of `app/src/data/seed.ts` | **DELETE** (after data moves into V04 seed) |
| `package.json`, `tsconfig.json`, `Dockerfile`, `.env.example`, `.dockerignore` | — | Build config. Dockerfile runs `prisma db push` + seed **on every boot** | **MERGE** (replace `db push` with `migrate deploy`; seed not on boot) |

---

## 5. `backend/` and `wave1a-kit/` — NestJS reference code

### 5.1 `backend/`

| Path | Content | Classification | Why |
| :--- | :--- | :--- | :--- |
| `prisma/schema.prisma` (746 lines, 34 models, 18 enums) | The most complete data model: scoped role assignments, approvals, PAM, audit, idempotency, bed log, credentials with vault fields, eligibility state, waivers, notifications with delivery status, device tokens, shifts, coverage alert log, attendance events, break-glass, encryption keys, worker leases, observability, FHIR mapping, request log, migration bridge | **MERGE** | Primary input for the V04 schema (see DATABASE_CONSOLIDATION.md). Validates with Prisma 5.22. |
| `prisma/migrations/V50_employee_hr_fields.sql` | HR fields, marital-status CHECK, salary ≥ 0 CHECK, full-name trigger, Hijri shape CHECK | **MERGE** | Only real migration file in the repo. |
| `src/modules/roles/roles.service.ts` | Grant (self-grant block, SYSTEM scope ⇔ empty scopeIds, expiry max 90 d SUPERVISOR / 365 d others, scope coverage, four-eyes 202, duplicate check, audit in tx), update, revoke (no self-revoke, last SYSTEM_ADMIN protected), expiry sweep | **MERGE** | Richest RBAC logic in the repo. |
| `src/modules/admin-approval/admin-approval.service.ts` | Four-eyes: `SELECT … FOR UPDATE`, PENDING precondition, self-approval 403, execute in same tx | **MERGE** | |
| `src/modules/pam/pam.service.ts` | JIT elevation 1–4 h, reason ≥ 10 chars, auto-revoke on expiry | **MERGE** | Duration conflicts with `.env.example` (see conflicts). |
| `src/modules/audit/audit.service.ts` | SHA-256(prevHash + JSON) chain, **no lock** (concurrent writers can fork the chain) | **MERGE** (concept) | V04 uses the SQL `fn_append_audit_entry` path instead. |
| `src/common/guards/roles.guard.ts` | Fresh-DB role check, implicit EMPLOYEE, SYSTEM_ADMIN requires active PAM | **MERGE** | |
| `src/modules/roles/roles.controller.ts` | `/api/v1/roles/*` + approvals + PAM. **Mock `JwtAuthGuard` returns `true`**; routes declared as `'/../admin/…'` (not valid Nest paths) | **MERGE** (endpoint design only) | |
| `src/modules/roles/dto/grant-role.dto.ts` | class-validator DTOs (reason ≥ 20 / revoke ≥ 10 / approve ≥ 5) | **MERGE** (as zod schemas) | |
| `src/modules/redis/redis.service.ts` | Best-effort cache invalidation | **ARCHIVE** | Redis is not required for V04 scope (see architecture plan decision). |
| `src/app.module.ts`, `main.ts`, `prisma/prisma.service.ts`, decorators, module | NestJS wiring | **ARCHIVE** | Framework-specific. |
| `README.md` | Endpoint/acceptance description; claims "any password" demo accounts (stale) | **REFERENCE** | |
| `package.json`, `tsconfig.json` | NestJS deps; no `prisma/seed.ts` exists though `seed` script references it | **ARCHIVE** | |

### 5.2 `wave1a-kit/`

| Path | Content | Classification |
| :--- | :--- | :--- |
| `backend/src/common/worker-lease/*` + `prisma/migrations/V49_worker_leases.sql` | Row-based job leases with heartbeat and crash takeover (race-free conditional upsert) | **MERGE** (needed once V04 has scheduled jobs) |
| `backend/src/common/idempotency/*` | Lease-aware idempotency guard/interceptor/cleanup, PII-minimal replay | **MERGE** (for onboarding / bulk / publish endpoints) |
| `backend/src/modules/config/residency.check.ts` + `tests/residency.check.spec.ts` | Fail-closed KSA residency startup check (deny me-south-1, me-central-1) | **MERGE** — matches spec §8.3 |
| `backend/src/modules/workforce/*` (controller, DTOs, bulk service) | Bulk bed capacity (per-row result, one log row per change), CSV import (dry-run default, never deletes) | **MERGE** |
| `backend/src/modules/eligibility/eligibility-state.service.ts` | Transaction-aware state refresh | **MERGE** |
| `backend/src/modules/observability/consistency-auditor.worker.ts` | 1 % daily drift sample, null-safe | **MERGE** (later phase) |
| `backend/src/modules/notifications/notification.worker.ts` | Lease-wrapped daily scan — **job bodies are placeholders** (`SELECT 1`) | **REFERENCE** |
| `backend/prisma/migrations/V36b_harden_onboarding_function.sql` | SECURITY DEFINER onboarding fn (search_path pinned, chained audit, creates **Approved** contract) | **MERGE** — but see conflict C-1 |
| `backend/tests/worker-lease.spec.ts`, `csrf-guard-order.e2e-spec.ts` | Lease semantics; guard ordering (Nest-specific) | **MERGE** (lease test) / **REFERENCE** (CSRF e2e intent) |
| `frontend/src/modules/workforce/UnitCapacityGrid.tsx` | API-based grid; imports non-existent `apiFetch` | **MERGE** (UX ideas) — duplicate of app version |
| `scripts/check-bundle-size.mjs` | Fail-closed bundle gate | **KEEP** (replaces app copy) |
| `scripts/verify-kit.mjs` | Static checks of the kit (44/44 pass) | **ARCHIVE** |
| `ci/ci.yml` | CI fragment (Node 20 / PG 15, migrate twice, tests, bundle gate) — references npm scripts that do not exist | **MERGE** → `.github/workflows/ci.yml` |
| `README.md` | Task → file map, install order | **REFERENCE** |

---

## 6. Documentation files (root and elsewhere)

| File | Lines | What it is | Classification | Useful content to extract |
| :--- | ---: | :--- | :--- | :--- |
| `AIGH_Nursing_Workforce_Management_System_v2_8_7.md` | 8,869 | **The specification, rev 2.8.7c.** Generated by the patch chain; byte-reproducible. | **REFERENCE** (authoritative requirements source) | Condensed into `SYSTEM_SPECIFICATION.md`, `RBAC.md`, `CLINICAL_ELIGIBILITY.md`, `WORKFORCE.md`, `DATABASE.md`, `DEPLOYMENT.md`. Kept verbatim under `docs/reference/` for traceability. |
| `uploads/AIGH_…_v2_8_6.md` | 8,096 | Prior spec version (patch-chain input) | **ARCHIVE** | None beyond v2.8.7. |
| `AIGH_v2_8_6_review_analysis.md` | 283 | Independent review F-01…F-32 with closure notes | **ARCHIVE** | Closed findings already in v2.8.7. |
| `AIGH_v2_8_7_integration_verification.md` | 170 | Proof the patch chain integrates all findings | **ARCHIVE** | — |
| `AIGH_v2_8_7_remediation_tracker.md` | 174 | Open work list B-01…B-26 + decision gates U1–U3 | **REFERENCE** | Open items → `MIGRATION.md` / cleanup risks. |
| `AIGH_Phase1_Execution_Plan_U1_Unblock.md` | 200 | Hosting-decision plan, Gate 1 sandbox | **REFERENCE** | Programme doc — belongs outside the code repo. |
| `AIGH_U1_Hosting_Decision_Pack.md` | 149 | CIO decision memo | **REFERENCE** | Same. |
| `AIGH_U2_Credential_Policy_Workshop_Pack.md` | 183 | Credential rules **not yet decided** for PRACTITIONER, NS, DON, DEPUTY_DON, ADMIN | **REFERENCE** | Listed as REQUIREMENT NOT ESTABLISHED in `CLINICAL_ELIGIBILITY.md`. |
| `AIGH_U3_SCFHS_Integration_Request.md` | 139 | SCFHS integration request letters (ar/en) | **REFERENCE** | Programme doc. |
| `ANALYSIS.md`, `ANALYSIS_2026-09-19.md`, `-20.md`, `-21.md` | 2,013 | Successive repository reviews by earlier sessions | **ARCHIVE** | `-21` §5 lists open gate1-kit defects G1–G8 — check status when moving `gate1-kit` (see CLEANUP_PLAN). |
| `WEBAPP_SUMMARY.md` | 204 | Build summary of the demo app | **ARCHIVE** | — |
| `ROLE_MATRIX.md` | 118 | Readable role matrix extracted from spec §8 | **MERGE** → `docs/RBAC.md` | |
| `ROLE_MATRIX_CRUD_PROPOSAL.md` | 472 | Design proposal that became `backend/` roles module | **ARCHIVE** | Implemented design; rules captured in RBAC.md. |
| `PATCH_APPLY_README.md` | 122 | Instructions for `.patch`/`.bundle` files that **are not in the repo** | **DELETE** (obsolete) | — |
| `RUN_LOCALLY.md` | 91 | Run instructions; says "any password works" (stale — seed uses `demo1234`) | **MERGE** → `README.md` / `DEPLOYMENT.md` | |
| `README.md` (root) | 38 | Workspace README (describes the spec workspace, not the app) | **DELETE** (replaced) | |
| `backend/README.md`, `wave1a-kit/README.md`, `gate1-kit/README.md`, `app/README.md` | — | Per-package READMEs | `gate1-kit/README.md` **KEEP**; others see above | |

---

## 7. Scripts, patches, generated and temporary files

| File | Classification | Reason |
| :--- | :--- | :--- |
| `patch_v287.py`, `patch2_v287.py` … `patch5_v287.py` | **ARCHIVE** | They edit the *spec document* only (113 patches). Verified this session: `python replay_v287.py` rebuilds v2.8.7 with SHA-256 `8a45e282…` = committed file, so their entire effect is already captured in v2.8.7. No application code depends on them. |
| `replay_v287.py`, `verify_integration.py` (38/38 ok), `annotate_review_closure.py` | **ARCHIVE** | Tooling for the patch chain. |
| `scripts/setup-prisma-stubs.mjs` | **DELETE** | Sandbox workaround that writes fake `any` typings into `node_modules`; masks real type errors. |
| `app/scripts/export-seed-data.mjs`, `server/prisma/seed-data.json` | **DELETE** (after merge) | Exist only because frontend and backend each had a seed. |
| `gate1-drill/*.log`, `backup.pub`, evidence `.md` | **ARCHIVE** | Execution evidence of a past drill. |
| Generated/ignored (`node_modules/`, `dist/`, `*.tsbuildinfo`, `vite.config.d.ts`, drill backups) | Not tracked | `.gitignore` already excludes them. |

---

## 8. Configuration conflicts found in the inventory

| ID | Where | Conflict |
| :--- | :--- | :--- |
| **R-1** | `.env.example:57` says storage region "`me-central-1` ONLY"; `app/src/main.tsx:223` allowlists `me-central-1`; `wave1a-kit/.../residency.check.ts` **denies** `me-central-1` (UAE); spec v2.8.7 L5468: "NEVER include non-KSA regions: AWS me-south-1 is Bahrain, me-central-1 is the UAE." | Spec + kit agree; `.env.example` and `main.tsx` are wrong. |
| **R-2** | `.env.example` `PAM_ELEVATION_TTL_MINUTES=60`; `backend` PamService 1–4 h default 2 h; spec §8.1 "limited window (e.g., 2 hours)" | Value not fixed by spec. |
| **R-3** | Access-token/session lifetimes: `server` 15 min access + 7 day refresh; spec §3.3 "one hour of validity, 24-hour absolute boundary" | Conflict. |
| **R-4** | Ports: `server` 3001, `backend` 3000; docker-compose uses 3001 | Cosmetic. |
| **R-5** | `server/Dockerfile` runs `prisma db push` + seed on **every boot** (wipes and reseeds data) | Unsafe beyond demo. |
| **R-6** | `app/vite.config.js` `allowedHosts: true`, `hmr.clientPort: 443` | Preview-environment settings. |

---

## 9. Verification performed during this inventory

| Check | Result |
| :--- | :--- |
| `git fetch` / fast-forward | `main` was 3 behind origin; fast-forwarded to `de82bfb`. Working tree clean before and after. |
| `app`: `npx tsc -b` | exit 0 |
| `app`: `node scripts/verify-employee-fields.mjs` | 212 passed, 0 failed |
| `server`: `npx tsc --noEmit` | exit 0 |
| `server/prisma/schema.prisma` validate | valid (14 models) |
| `backend/prisma/schema.prisma` validate | valid (34 models, 18 enums) |
| `python replay_v287.py` | 113 patches applied; rebuilt SHA-256 identical to committed v2.8.7 |
| `python verify_integration.py` | 38/38 findings present |
| `node wave1a-kit/scripts/verify-kit.mjs` | 44/44 static checks pass |
| Not run | `backend/` build (no `node_modules`), Docker stack, any database-backed test. No PostgreSQL instance was started. |

## 10. UNKNOWN items

| Item | Why unknown |
| :--- | :--- |
| gate1-kit defects G1–G8 (`ANALYSIS_2026-09-21.md` §5) | Later commits (`af72273`, `de82bfb`) touched gate1-kit (systemd timer = G5). Which of G1–G8 remain open was not re-verified; must be checked before `gate1-kit` is declared production tooling. |
