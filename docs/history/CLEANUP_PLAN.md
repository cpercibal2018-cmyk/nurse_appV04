# Cleanup Plan

> **Historical (stage-1 analysis of V03, 2026-09-22).** Kept for traceability; it describes V03 and the plan for V04, not V04 as built. For V04 see [docs/README.md](../README.md). Content unchanged since it was retired in commit 12, except that relative links were adjusted for the move.

## 1. Principles

1. **V03 is never destroyed.** V04 is built in a new repository (D-2). V03 is tagged `v03-final` and left intact as the archive. "ARCHIVE" = stays in V03, not copied to V04. "DELETE" = not copied to V04, because it has no unique value (it also stays in V03 history).
2. **Migrate before removing.** For every item below, the column *Unique content → destination* answers the brief's question: "Does this file contain unique business logic, security logic, data definitions, database logic, UI behavior, or documentation that exists nowhere else?"
3. **No action on UNKNOWN items** until they are resolved.
4. **Nothing is removed before the V04 feature that replaces it passes its validation step** (§5).

## 2. Actions by item

### 2.1 Frontend (`app/`)

| Item | Action | Unique content → destination | Precondition |
| :--- | :--- | :--- | :--- |
| `src/lib/store.tsx` | MERGE, then not carried | Rules E1–E10, C4–C5, D1–D4, L-rules (as-is), W1–W6, S1, S3 → backend services; session slice → `frontend` auth store; persisted-state migration code → dropped (no localStorage data model in V04) | Each rule has a backend test |
| `src/lib/contracts.ts` | MERGE | → `backend/src/modules/contracts/rules.ts`; PDF pre-check copy → `frontend/src/lib/pdf-check.ts` | rules tests pass |
| `src/lib/eligibility.ts` | MERGE (dead code) | Per-template waiver and shift-date checks → engine | engine tests pass |
| `src/lib/kpi.ts` | MERGE or DELETE | Per D-11 → `backend/src/modules/workforce/kpi.ts` | D-11 answered |
| `src/lib/roster.ts` | MERGE partial | Shift types/times → config; coverage colours → frontend; **staffing factor dropped** (D-16) | D-16 answered |
| `src/lib/hijri.ts`, `i18n.tsx` | KEEP (move) | → backend `lib/hijri.ts` (storage) + frontend `lib/` (display) | — |
| `src/lib/api.ts` | MERGE | Token/CSRF/refresh mechanics → `services/http.ts`; `syncWrite` and generic CRUD dropped | — |
| `src/lib/api/roles.api.ts` | MERGE | Validation rules already in backend reference → `users/role-rules.ts`; localStorage mock dropped | RBAC tests pass |
| `src/data/seed.ts` | MERGE | → `backend/prisma/seed-data/*` (organisation, positions, catalog, demo) | seed runs |
| `src/main.tsx` | MERGE partial | Bootstrap kept; **browser residency check deleted** (wrong and ineffective, R-1) | — |
| `src/App.tsx`, `components/*` | MERGE | Routing + layout; add role-aware nav | — |
| `src/modules/**` (except below) | MERGE | Screens re-pointed at domain APIs; business checks removed from pages | per-module |
| `src/modules/workforce/WorkforceRoutes.tsx` | DELETE | none (5-line wrapper) | — |
| `src/modules/admin/AdminModule.tsx` | REFERENCE → DELETE | Static descriptions → `docs/DEPLOYMENT.md` / `SYSTEM_SPECIFICATION.md` | docs written |
| `src/modules/observability/ObservabilityPage.tsx` | DELETE (for now) | Layout idea only; values were hard-coded | — |
| `scripts/verify-employee-fields.mjs` | MERGE | The 212 checks are re-expressed as backend/frontend tests (sections 1–6, 8–11, 13–16 → backend; 7 → hijri test; 12, 18 → dropped with localStorage; 17 → http client test; 19–20 → dropped with the seed snapshot) | V04 suite covers each listed section |
| `scripts/export-seed-data.mjs` | DELETE | none (exists only for cross-package seed) | single seed exists |
| `scripts/check-bundle-size.mjs` | DELETE | superseded by the kit version | kit version in CI |
| `public/logo.jpg` | DELETE | none (no references) | — |
| `public/logo-light.jpg`, `logo-dark.jpg` | KEEP | — | — |
| `README.md` | DELETE | Coverage claims are inaccurate; architecture notes superseded | — |
| `vite.config.js` | MERGE | Drop `allowedHosts: true`, `hmr.clientPort: 443` | — |
| `package.json` | MERGE | Add missing ESLint devDeps or drop the `lint` script | — |
| `Dockerfile`, `.env.example`, `.dockerignore`, `index.html`, tsconfigs | MERGE | — | — |

### 2.2 Backend (`server/`)

| Item | Action | Unique content → destination | Precondition |
| :--- | :--- | :--- | :--- |
| `src/auth.ts` | MERGE | → `modules/auth/tokens.ts`, `middleware/authenticate.ts`, CSRF/Origin helpers | auth tests pass |
| `src/index.ts` | MERGE partial | Login/refresh/logout/me, error mapping (`serverError`, `writeError`), prototype-safe lookup idea → V04; `/bootstrap` and generic CRUD **not carried** | domain endpoints exist |
| `prisma/schema.prisma` | MERGE | → V04 schema (§ DATABASE_CONSOLIDATION) | V04 migrate passes |
| `prisma/seed.ts` | MERGE | Users, credentials, shifts → `seed-data/demo.ts` | — |
| `prisma/seed-data.json` | DELETE | Generated copy | single seed exists |
| `Dockerfile` | MERGE | Replace `db push` + seed-on-boot with `migrate deploy` | — |
| `package.json`, `tsconfig.json`, `.env.example`, `.dockerignore` | MERGE | — | — |

### 2.3 NestJS reference (`backend/`, `wave1a-kit/`)

| Item | Action | Unique content → destination |
| :--- | :--- | :--- |
| `backend/prisma/schema.prisma` | MERGE | → V04 schema |
| `backend/prisma/migrations/V50_employee_hr_fields.sql` | MERGE | CHECKs + trigger → `0001_init` SQL |
| `backend/src/modules/roles/*` | MERGE | → `modules/users/role-assignment.service.ts`, `role-rules.ts`, zod schemas |
| `backend/src/modules/admin-approval/*`, `pam/*` | MERGE | → `modules/administration` |
| `backend/src/common/guards/roles.guard.ts` | MERGE | → `middleware/authorize.ts` |
| `backend/src/modules/audit/audit.service.ts` | DELETE | Superseded by SQL write path (P14) |
| `backend/src/modules/redis/*` | ARCHIVE | Redis not used (§3 plan) |
| `backend/src/{main,app.module}.ts`, `prisma/prisma.service.ts`, decorators, `package.json`, `tsconfig.json` | ARCHIVE | Framework wiring |
| `backend/README.md` | REFERENCE | Endpoint and acceptance list → `docs/API.md`, `docs/RBAC.md` |
| `wave1a-kit/backend/src/common/worker-lease/*`, `V49_worker_leases.sql`, `tests/worker-lease.spec.ts` | MERGE | → `backend/src/lib/worker-lease.ts` + migration + test |
| `wave1a-kit/backend/src/common/idempotency/*` | MERGE | → `middleware/idempotency.ts` |
| `wave1a-kit/backend/src/modules/config/residency.check.ts` + spec | MERGE | → `config/residency.ts` + test |
| `wave1a-kit/backend/src/modules/workforce/*` | MERGE | → `modules/workforce/bed-capacity.service.ts` |
| `wave1a-kit/backend/src/modules/eligibility/eligibility-state.service.ts` | MERGE | → `modules/eligibility/state.service.ts` |
| `wave1a-kit/backend/src/modules/observability/consistency-auditor.worker.ts` | ARCHIVE | Deferred feature; design in spec §10.8 |
| `wave1a-kit/backend/src/modules/notifications/notification.worker.ts` | DELETE | Placeholders only; schedule/lease keys captured in plan |
| `wave1a-kit/backend/prisma/migrations/V36b_*.sql` | REFERENCE | Guards (position active, date order) → onboarding service; SQL function not used (D-17) |
| `wave1a-kit/backend/tests/csrf-guard-order.e2e-spec.ts` | REFERENCE | Cases (valid token, missing token, foreign Origin, refresh after reload) → V04 auth tests |
| `wave1a-kit/frontend/.../UnitCapacityGrid.tsx` | DELETE | UX of "Baseline 582 → Configured N" folded into the V04 grid |
| `wave1a-kit/scripts/check-bundle-size.mjs` | KEEP | → `frontend/scripts/` |
| `wave1a-kit/scripts/verify-kit.mjs` | ARCHIVE | Kit-specific |
| `wave1a-kit/ci/ci.yml` | MERGE | → `.github/workflows/ci.yml` (with scripts that exist) |
| `wave1a-kit/README.md` | ARCHIVE | Its "remaining wiring" list is resolved by this plan |

### 2.4 Operations

| Item | Action | Unique content → destination | Precondition |
| :--- | :--- | :--- | :--- |
| `gate1-kit/` (scripts, systemd, README) | KEEP → `ops/backup/` | Production backup/PITR tooling | **Resolve UNKNOWN:** re-check defects G1–G8 from `ANALYSIS_2026-09-21.md` §5 against current scripts; record status in `docs/DEPLOYMENT.md` |
| `gate1-kit/sql/10_audit_chain.sql` | MERGE | `fn_append_audit_entry` + `audit_chain_breaks` → `0001_init` (hash per D-7). Drill copy stays in `ops/backup/sql/` for the synthetic database | — |
| `gate1-kit/sql/20–40_*.sql` | KEEP (drill fixtures) | → `ops/backup/sql/` | — |
| `gate1-drill/` | ARCHIVE | Evidence of the 2026-09-18 drill; cited from `DEPLOYMENT.md` by V03 tag + path | — |
| `docker-compose.yml` | MERGE | → V04 compose (pg 15, `migrate deploy`, no seed-on-boot) | — |
| `docker-compose.full-spec.yml` | REFERENCE | → production topology section of `DEPLOYMENT.md` | — |
| `.env.example` (root) | MERGE | One V04 `.env.example`; **residency comment corrected**; unused keys (Redis, push, SCFHS, PDPL keys) moved to a "deferred features" block | — |
| `.gitignore`, `.gitattributes` | MERGE | Secrets/backup rules kept; seed-snapshot LF rule dropped | — |
| `scripts/setup-prisma-stubs.mjs` | DELETE | none — sandbox workaround that hides type errors | — |

### 2.5 Specification, patches and documents

| Item | Action | Unique content → destination |
| :--- | :--- | :--- |
| `AIGH_Nursing_Workforce_Management_System_v2_8_7.md` | REFERENCE → `docs/reference/` (verbatim) | Condensed into the authoritative doc set |
| `uploads/…v2_8_6.md` | ARCHIVE | Superseded; fully reproduced into v2.8.7 by the chain |
| `patch_v287.py`, `patch2…patch5_v287.py`, `replay_v287.py`, `verify_integration.py`, `annotate_review_closure.py` | ARCHIVE | Effect fully captured in v2.8.7 (replay SHA-256 identical, verified 2026-09-23). No runtime dependency |
| `PATCH_APPLY_README.md` | DELETE | Refers to `.patch`/`.bundle` files not in the repo |
| `AIGH_v2_8_6_review_analysis.md`, `AIGH_v2_8_7_integration_verification.md` | ARCHIVE | Closed findings are in v2.8.7 |
| `AIGH_v2_8_7_remediation_tracker.md` | REFERENCE | Open items B-02…B-26 → `docs/MIGRATION.md` "open programme items" |
| `AIGH_Phase1_Execution_Plan_U1_Unblock.md`, `AIGH_U1/U2/U3_*.md` | REFERENCE (programme docs, outside code repo) | U2's undecided rules → `CLINICAL_ELIGIBILITY.md` "Not established"; U1/U3 → `DEPLOYMENT.md` dependencies |
| `ANALYSIS*.md` (4), `WEBAPP_SUMMARY.md` | ARCHIVE | Superseded by the V04 reports |
| `ROLE_MATRIX.md` | MERGE → `docs/RBAC.md` | — |
| `ROLE_MATRIX_CRUD_PROPOSAL.md` | ARCHIVE | Implemented design |
| `RUN_LOCALLY.md`, root `README.md` | MERGE → V04 `README.md` / `DEPLOYMENT.md` | Stale "any password" note corrected |

## 3. Counts

Tallied from the rows of §2 (a row may cover a group of files; the leading word of the Action column counts):

| Action | Rows |
| :--- | :-: |
| KEEP (moved as-is) | 5 |
| MERGE (incl. "MERGE partial" / "MERGE or DELETE") | 38 |
| REFERENCE (incl. "REFERENCE → …") | 8 |
| ARCHIVE | 11 |
| DELETE | 12 |
| UNKNOWN | 1 (gate1-kit defect status, precondition on the KEEP row) |

## 4. Root of V04 (target)

Only: `backend/`, `frontend/`, `ops/`, `docs/`, `.github/`, `docker-compose.yml`, `.env.example`, `.gitignore`, `.gitattributes`, `package.json`, `package-lock.json`, `README.md`. No scripts, analyses, patches or evidence at root.

## 5. Order and safety gates

1. **Freeze V03:** tag `v03-final` on `de82bfb` (needs your go-ahead; pushing a tag is outward-facing).
2. **Create V04 repository** (D-2) with these seven reports in `docs/`.
3. **Build V04 per the commit sequence** (architecture plan §7). V03 is not modified at any point.
4. **Validate V04** against the Phase 15 matrix: frontend install/build/tsc/imports/routes/bundle; backend install/tsc/start/prisma validate/generate/migrate/seed; DB constraints (overlap, 72 h waiver, bed range, duplicate job number, double-booking); security (auth, RBAC matrix tests per role, validation, CSRF on refresh, password hashing, token rotation/reuse, audit rows for every mutation, no PII in logs, no unscoped reads); business scenarios (nurse creation, credential management, eligibility, expired licence, missing credential, training requirement, staffing target, assignment, roster, attendance gap, coverage, break-glass, audit trail).
5. **Write `CLEANUP_REPORT.md`** with the 13 sections the brief requires.
6. **Archive V03 on GitHub** (read-only) only after you accept V04. This is your action.

## 6. Risks

| Risk | Mitigation |
| :--- | :--- |
| A rule that lived only in UI code is lost | Every rule has an ID in `FEATURE_MASTER_INVENTORY.md` §15; stage-2 tests reference rule IDs; `CLEANUP_REPORT.md` lists each ID with its test |
| D-4 (block when no requirements) makes most nurses ineligible in a fresh install | Demo seed carries illustrative requirements; production needs the U2 policy memo, stated in DEPLOYMENT.md |
| gate1-kit defects unresolved | UNKNOWN until re-verified; ops tooling is not declared production-ready before that |
| Scope creep from spec-only features | §6 scope table of the architecture plan is the contract; anything else needs a new decision |
