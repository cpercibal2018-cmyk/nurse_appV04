# Duplicate Implementation Map

> **Historical (stage-1 analysis of V03, 2026-09-22).** Kept for traceability; it describes V03 and the plan for V04, not V04 as built. For V04 see [docs/README.md](../README.md). Content unchanged since it was retired in commit 12, except that relative links were adjusted for the move.

For every feature with more than one implementation: where each lives, which one actually runs, which is more complete, how they conflict, and what V04 does. Paths are relative to the V03 clone. V04 paths refer to the target layout in `V04_ARCHITECTURE_PLAN.md`. Conflict IDs (C-n) and rule IDs are defined in `FEATURE_MASTER_INVENTORY.md`.

**Legend — "Runs?":** ✅ executed by the running app · ❌ never executed · 💀 dead code (no callers)

## 1. Summary

| Feature | # impls | Currently used | Most complete | Authoritative V04 | Action |
| :--- | :-: | :--- | :--- | :--- | :--- |
| Backend application | 3 | `server/` (Express) | `backend/` (NestJS, but mock auth) | `backend/` (Express, new) | Consolidate: Express skeleton from `server/`, domain logic ported from NestJS code |
| Prisma schema / DDL | 4 | `server/prisma/schema.prisma` | `backend/prisma/schema.prisma` | `backend/prisma/schema.prisma` (new) | Merge (DATABASE_CONSOLIDATION.md) |
| Authentication | 2 | `server/src/auth.ts` + `index.ts` | same | `backend/src/modules/auth` | Consolidate (port server; remove client mock login) |
| RBAC | 4 | `server` WRITE_ROLES + client checks | `backend/.../roles.*` | `backend/src/modules/users` + `middleware/authorize.ts` | Merge |
| Eligibility engine | 4 | `store.tsx` `refreshEligibility` | Spec §6.1 (+ dead `eligibility.ts`) | `backend/src/modules/eligibility/engine.ts` | Rewrite to spec; migrate tests |
| Audit | 5 | client `store.tsx` chain | gate1 SQL `fn_append_audit_entry` | DB function + `backend/src/modules/audit` | Merge |
| Residency check | 3 | `app/src/main.tsx` (wrong) | `wave1a-kit/.../residency.check.ts` | `backend/src/config/residency.ts` | Merge kit version; delete browser copy |
| Contract rules | 3 | `store.tsx` + `ContractsPage.tsx` + `contracts.ts` | `contracts.ts` + store | `backend/src/modules/contracts/rules.ts` | Consolidate |
| Bed capacity bulk / CSV | 2 | `store.tsx` | `wave1a-kit` service | `backend/src/modules/workforce` | Merge kit version |
| Unit capacity grid UI | 2 | `app/.../UnitCapacityGrid.tsx` | app (kit imports a missing `apiFetch`) | `frontend/src/modules/workforce/UnitCapacityPage.tsx` | Consolidate |
| API client | 2 | `app/src/lib/api.ts` + `lib/api/roles.api.ts` (mock) | `api.ts` | `frontend/src/services/http.ts` + per-module services | Consolidate |
| Seed data | 4 | `seed.ts` → `seed-data.json`; inline copies in `store.tsx` and `server/prisma/seed.ts` | `seed.ts` | `backend/prisma/seed.ts` (+ `seed-data/`) | Consolidate |
| Bundle-size gate | 2 | `app/scripts/check-bundle-size.mjs` | `wave1a-kit/scripts/…` (fails closed) | `frontend/scripts/check-bundle-size.mjs` | Keep kit version |
| Types (Employee, Contract, …) | 3 | `store.tsx` types | backend Prisma types | Prisma-generated (backend) + `frontend/src/types` (API DTOs) | Consolidate |
| Role-assignment UI data | 2 | localStorage mock | NestJS service | backend API | Replace mock |
| Onboarding | 3 | `store.tsx:556` | V36b SQL function (atomic) | `backend/src/modules/nurses/onboarding.service.ts` | Merge; conflict C-1 |
| Hash function for audit | 3 | client `simpleHash` | SQL SHA-256 | SQL SHA-256 | Consolidate; conflict C-12 |
| Specification | 2 versions + 6 derived docs | — | v2.8.7 (rev 2.8.7c) | `docs/reference/` + condensed docs | Consolidate |

---

## 2. Detail by feature

### 2.1 Backend application

| | `server/` | `backend/` | `wave1a-kit/backend/` |
| :--- | :--- | :--- | :--- |
| Framework | Express 4 | NestJS 10 | NestJS 10 |
| Runs? | ✅ (docker-compose `api`) | ❌ (auth guard is a stub returning `true`; routes `'/../admin/…'` are malformed) | ❌ (imports modules that don't exist: `identity/guards/*`, `workforce.service`, `grace-period.service`, `prisma.module`) |
| Scope | Auth + generic CRUD over 12 tables | Role matrix, four-eyes, PAM, audit | Leases, idempotency, residency, bulk capacity, eligibility state, auditor |
| Strengths | Real, tested auth; safe error mapping; prototype-safe entity lookup | Domain rules for RBAC | Operational patterns |
| Weakness | No domain logic; any HR_ADMIN can write any column of any row; reads unscoped | Not runnable | Not runnable; model names (`nursingUnit`, `idempotencyKey.key_actorId`) match neither schema |

**V04:** One Express + TypeScript backend (the brief's target stack). Start from `server/`'s auth, error handling and app wiring. Port NestJS *logic* (services are plain TypeScript classes, portable with minor edits) into Express modules. NestJS decorators, DI modules and guards are not carried over.

### 2.2 Database schema

| | `server/prisma` | `backend/prisma` | `gate1-kit/sql` | Spec SQL |
| :--- | :--- | :--- | :--- | :--- |
| Models / tables | 14 | 34 + 18 enums | 9 tables + audit fn + view | V31–V50 fragments |
| IDs | Int (no autoincrement on most) | UUID | SERIAL / INTEGER | INTEGER |
| Dates | `String` | `DateTime` / `@db.Date` | `DATE` / `TIMESTAMPTZ` | same |
| Relations | 2 (Unit→Dept, Session→User) | Full FKs | FKs | FKs |
| Runs? | ✅ (`db push`) | ❌ | ✅ drill only | ❌ |

**V04:** single `backend/prisma/schema.prisma` + Prisma Migrate. See DATABASE_CONSOLIDATION.md.

### 2.3 Authentication

| | Server (`auth.ts`, `index.ts`) | Client (`store.tsx:326`) |
| :--- | :--- | :--- |
| Mechanism | bcrypt, JWT, rotating refresh, CSRF | Email substring → role, any password |
| Runs? | ✅ | ✅ (standalone mode, and *also* in API mode before the server answers) |

**V04:** server only. The frontend waits for the server response and takes the user and role from it. Standalone "demo mode" is removed (decision D-1).

### 2.4 RBAC — four implementations

| # | Where | What it checks | Runs? |
| :-: | :--- | :--- | :--- |
| 1 | `server/src/auth.ts:106-118` | `requireRole(WRITE_ROLES)` on every write | ✅ |
| 2 | `app/src/lib/store.tsx:682, 776, 892-896` + `PositionsPage.tsx:44` | HR_ADMIN/DEVELOPER for position assignment and contract copy; owner-or-admin for evidence | ✅ (client only — bypassable by calling the API directly) |
| 3 | `app/src/lib/api/roles.api.ts` | Grant/revoke/approve validation (mirrors #4) over localStorage | ✅ (mock data) |
| 4 | `backend/src/modules/roles/*`, `admin-approval`, `pam`, `roles.guard.ts` | Scoped assignments, four-eyes, PAM | ❌ |

**Conflicts:** #1 lets HR_ADMIN write rosters while spec gives that to Supervisor (C-9). #1/#2 include DEVELOPER (C-8). #1 has one role per user; #4 has many scoped assignments. #2 and #3 use `currentUser.id` (a user id) as an employee id.

**V04:** #4's model and rules (R1–R17) implemented once in `backend/src/modules/users/role-assignment.service.ts`. One authorization middleware (`middleware/authorize.ts`) resolves effective roles + scopes per request from the database. The frontend only *hides* what the server forbids and never decides access.

### 2.5 Eligibility — four implementations

| # | Where | Runs? | Behaviour |
| :-: | :--- | :--- | :--- |
| 1 | `app/src/lib/store.tsx:1026-1076` | ✅ | Contract covers *today*; requirements = same unit (position null or equal); status Valid/ExpiringSoon only; any waiver waives everything; grace only if nothing missing; **no requirements → ELIGIBLE** |
| 2 | `app/src/lib/eligibility.ts` | 💀 | Contract covers given date; expiry ≥ date; per-template waiver; per-template grace. Requirements passed in by caller |
| 3 | `wave1a-kit/.../eligibility-state.service.ts` | ❌ | Persistence + tx only; delegates to an `EligibilityEngine` that doesn't exist in the repo |
| 4 | Spec §6.1 / §6.1.1 / §6.1.1.1 / §6.1.2 | — | Full ordered algorithm (rule L4) |

**Conflicts:** C-2, C-3, C-4, plus #1 ignores employee status and position schedulability.
**V04:** one engine implementing #4 (`backend/src/modules/eligibility/engine.ts`, pure function over loaded facts) + `state.service.ts` (#3's tx-aware persistence). Used by pool queries, draft assignment, publication, and refresh triggers. The frontend only displays results. Test cases from spec §6 acceptance tables become unit tests.

### 2.6 Audit — five implementations

| # | Where | Hash | Persisted? | Runs? |
| :-: | :--- | :--- | :--- | :--- |
| 1 | `store.tsx:283, 952` | 32-bit JS hash + `Date.now()` | localStorage | ✅ |
| 2 | `roles.api.ts:255` | none | `localStorage['aigh_audit_log']` | ✅ |
| 3 | `server` `AuditEntry` model | — | table exists; **nothing writes it** (API refuses writes) | ✅ (empty) |
| 4 | `backend/.../audit.service.ts` | SHA-256(prev + JSON), no lock | DB | ❌ |
| 5 | `gate1-kit/sql/10_audit_chain.sql` `fn_append_audit_entry` | SHA-256 incl. unstored `clock_timestamp()`, advisory-locked | DB | ✅ in drill |

**V04:** #5's design (single SQL write path, transaction-scoped advisory lock), adjusted so the hash covers only stored columns (including `created_at`), which makes content re-verifiable (resolves C-12 technically; see decision D-7). `audit.service.ts` calls it inside the caller's transaction (A1). Delete #1–#4.

### 2.7 Contract rules — three places

| # | Where | Checks |
| :-: | :--- | :--- |
| 1 | `app/src/lib/contracts.ts` | Coverage statuses, overlap, renewable, renewal period, PDF acceptance |
| 2 | `store.tsx:719-855` | Employee exists, dates, overlap on add + update, attachment gate |
| 3 | `ContractsPage.tsx:132-141, 183-194, 232-238` | Repeats overlap and dates before calling the store |

**V04:** `backend/src/modules/contracts/rules.ts` (from #1) + `contracts.service.ts` (from #2) + DB exclusion constraint. The page keeps only form validation (required fields). Add a status transition map (missing everywhere today, rule C2).

### 2.8 Bed capacity bulk update and CSV import

| | `store.tsx:452-529` | `wave1a-kit/.../workforce-bulk-capacity.service.ts` |
| :--- | :--- | :--- |
| Bulk rows | ✅ per-row results, log per change | ✅ same + one transaction + audit |
| CSV | Updates existing units only; header optional; column guessing `parts[3] || parts[1]` | Required header, creates new units, validates department, rejects duplicates in file, dry-run default |

**V04:** kit version, adapted to the V04 schema.

### 2.9 Frontend API clients and data layer

| # | Where | Pattern |
| :-: | :--- | :--- |
| 1 | `app/src/lib/api.ts` | fetch + JWT + CSRF + generic `create/update/remove(entity)` + fire-and-forget `syncWrite` |
| 2 | `app/src/lib/api/roles.api.ts` | React Query hooks over localStorage |
| 3 | `store.tsx` `hydrateFromApi` | One `/api/bootstrap` call loads every table |

**V04:** one HTTP client (`frontend/src/services/http.ts`, auth mechanics from #1). Per-module React Query hooks call real domain endpoints (`modules/*/api.ts`). Zustand keeps only session + UI preferences. No bootstrap-everything call: it violates field-level scoping (R15/R16). No fire-and-forget writes: the UI shows server errors.

### 2.10 Seed data

| # | Where | Content |
| :-: | :--- | :--- |
| 1 | `app/src/data/seed.ts` | Master data + 8 employees + 8 contracts + requirements + bed log |
| 2 | `server/prisma/seed-data.json` | Generated copy of #1 (drift-checked by test [20]) |
| 3 | `server/prisma/seed.ts` | Users (6) + 3 credentials + 2 shifts (inline) |
| 4 | `store.tsx:857-861, 976-979, 1020-1025, 1078-1080, 964-968, 948-951` | Credentials, shifts, eligibility states, grace, notifications, audit (inline, partly duplicating #3) |

**V04:** `backend/prisma/seed.ts` with data files split into **reference data** (departments, units, positions, credential catalog: the hospital baseline, spec §2.9/§5.1) and **demo data** (employees, contracts, credentials, users), guarded so demo data never loads in production (`SEED_DEMO=true`).

### 2.11 Residency check

| # | Where | Allowlist | Correct? |
| :-: | :--- | :--- | :--- |
| 1 | `app/src/main.tsx:222` | me-central-1, me-central-2 | ❌ (me-central-1 = UAE; runs in a browser where it cannot see the DB) |
| 2 | `wave1a-kit/.../residency.check.ts` | me-jeddah-1, me-riyadh-1, me-central-2, ksa-onprem; deny me-south-1, me-central-1 | ✅ matches spec L5464-5468 |
| 3 | `.env.example:57` comment | "me-central-1 ONLY" | ❌ |

**V04:** #2 in `backend/src/config/residency.ts`, called before `listen()`, with its tests.

### 2.12 Specification and documentation

| Topic | Documents covering it |
| :--- | :--- |
| Role matrix | spec §8, `ROLE_MATRIX.md`, `ROLE_MATRIX_CRUD_PROPOSAL.md`, `backend/README.md`, `AdminModule.tsx`/`RoleMatrixPage.tsx` text |
| Repository status | `ANALYSIS.md`, `ANALYSIS_2026-09-19/20/21.md`, `WEBAPP_SUMMARY.md`, `app/README.md`, `AIGH_v2_8_7_integration_verification.md` |
| Run instructions | `RUN_LOCALLY.md`, `app/README.md`, `backend/README.md`, root `README.md` |
| Spec | v2.8.6, v2.8.7 |

**V04:** the documentation set listed in the brief (Phase 10). Historical docs stay in V03.

---

## 3. Items that looked duplicated but are not

| Item | Why it is not a duplicate |
| :--- | :--- |
| `logo-light.jpg` / `logo-dark.jpg` | Theme variants, both referenced. (`logo.jpg` is an unreferenced duplicate → DELETE.) |
| `docker-compose.yml` vs `docker-compose.full-spec.yml` | Different purposes (dev stack vs spec production topology). V04 keeps one compose for dev; production topology is documented in `DEPLOYMENT.md`. |
| `gate1-kit/sql/*` vs Prisma schema | gate1 SQL builds a synthetic drill database for restore testing, not the app schema. Only `fn_append_audit_entry` is shared. It moves into a Prisma migration, and the drill fixtures stay in `ops/backup/`. |
| `hijri.ts` used by UI and by storage | One implementation, two call sites. In V04 the backend computes the stored Hijri value; the frontend formats for display. Same `Intl` basis. |
