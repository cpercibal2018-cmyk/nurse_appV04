# Database-first migration

How V04 stopped defining hospital data in TypeScript and made PostgreSQL the only place it lives. Approved by the owner on 2026-09-23 as recommendations **P1–P10** of the migration audit; recorded as decision D-42 in the [decision record](V04_ARCHITECTURE_PLAN.md#9a-decision-record-2026-09-23). The original seed is preserved in full in [SEED_DATA_INVENTORY.md](SEED_DATA_INVENTORY.md).

## 1. Old and new architecture

| | Before (up to tag `pre-db-first`) | After |
| :--- | :--- | :--- |
| Hospital structure and catalogue | TypeScript arrays in `backend/prisma/seed-data/*.ts`, inserted by `npx prisma db seed` | Rows in PostgreSQL, entered through the **baseline import** (four-eyes, one transaction) or the ordinary screens |
| First accounts | Only the demo seed created users; an empty database had no way in | `npm run bootstrap` creates the first System Admin and a hospital-wide HR Admin, once, with passwords from a hidden prompt |
| Demo accounts and fictional staff | `SEED_DEMO=true` on the same seed command | A separate development-only fixture command under `backend/test/fixtures/` |
| Credential field definitions | A JSON array on each credential type | `credential_template_fields`, one row per field, with database constraints |
| KPI critical areas | A unit-code map in `kpi.ts` | `units.critical_area`, set by HR |
| Position replacement (AHN → ACTING_HEAD) | A text column without a foreign key | A self-referencing foreign key |
| Credential categories | Seed only; no API | `POST` / `PATCH /credential-categories`, four-eyes |
| Onboarding default position (rule E6) | `'SN'` hard-coded in the service and the form | Still rule E6, served by `GET /employees/onboarding-defaults`; if the hospital has no SN position, a position must be chosen |
| CI | Migrate, seed twice, test | Migrate, test — tests build brand-new databases and never need a seed |

**Unchanged by design:** roles and permissions stay in code (P2 — security logic under review and test, not editable rows); beds stay a capacity count per unit with a history log (P3 — nothing needs bed-level rows); requirements get no effective-date or policy-version fields (P5 — not established until the hospital credential policy, U2); "Unassigned" was already `employees.unit_id = NULL`, never a magic id.

## 2. Steps (commits)

| # | Commit | What |
| :-: | :--- | :--- |
| 0 | tag `pre-db-first` (`1e89613`) | Rollback point, pushed; `pg_dump` of the development and test databases in `C:\WebApp_project\Local_Repo\backups\` |
| 1 | `d0f5c1b` | [SEED_DATA_INVENTORY.md](SEED_DATA_INVENTORY.md), generated from the seed files |
| 2 | `0f195fd` | Migration `20260924100000_database_first_master_data`; field definitions read and written relationally; KPI from `critical_area` |
| 3 | `6421356` | Category API with four-eyes; E6 default from the server |
| 4 | `03caabf` | Bootstrap command and the fresh-database test harness |
| 5 | `5ebc770` | Baseline import (preview, request, approve, apply), the baseline file, the Import screen |
| 6 | `4eb5901` | Frontend: categories, unit KPI area, positions chosen from the database |
| 7 | `2dc0d7b` | Demo data as a fixture; CI without seed |
| 8 | this document | Documentation |
| 9 | cleanup | `seed.ts`, `seed-data/*`, the Prisma seed setting, the `db:seed` script and the `SEED_DEMO*` settings removed (replaced by `DEMO_PASSWORD` for fixtures) |

## 3. Data mapping

| Seed source (`backend/prisma/seed-data/`) | Now | Checked by |
| :--- | :--- | :--- |
| `organisation.ts` — 5 departments | `baseline/aigh-baseline.json` → `departments` | Import test: 5 |
| `organisation.ts` — 47 units, 582 beds, (implicit) initial bed log | Baseline file → `units` + one `bed_capacity_logs` row per unit | Import test: 47, 582, 47 log rows |
| `kpi.ts` unit-code map (11 units) | Baseline file `criticalArea` → `units.critical_area`; the migration filled existing databases | Import test: 11; migration: ICU 6 / ER 4 / OR 1 on the development database |
| `positions.ts` — 16 positions, AHN/CI deprecated | Baseline file → `positions` (`is_active`, `replaced_by` FK) | Import test: 16, 2 replacements |
| `credential-catalog.ts` — 5 categories | Baseline file → `credential_categories` | Import test: 5 |
| `credential-catalog.ts` — 16 types, 68 fields | Baseline file → `credential_templates` + `credential_template_fields` | Import test: 16 / 68; migration on the development database: 68 JSON = 68 rows, 0 mismatches, order kept |
| `demo.ts` — 8 employees, 8 contracts, 6 requirements, 7 credentials, 5 accounts, 3 grants | `backend/test/fixtures/demo/demo-data.ts` (identical people and requirements; defects fixed: statuses from dates, required tracked fields filled, 3006's contract Expired instead of a hand-set Superseded, creator ≠ approver) | Fixture test |

**Intentionally not imported into any real database:** the 8 demo employees, their contracts and credentials, the 6 illustrative requirements and the 5 demo accounts. They load only through the fixture command on a development database.

## 4. Import process

1. A hospital-wide HR Admin or System Admin opens **Administration → Hospital baseline import** and chooses the file (the reference file or the hospital's own, same format).
2. **Preview** validates the file with the same rules as the create endpoints and classifies every row by code: *create*, *unchanged* (identical), *conflict* (exists with different values) or *rejected* (invalid, duplicated in the file, or referring to a department / category / successor that exists nowhere).
3. **Request** is possible only with no conflict and no rejection, and needs a reason. It becomes a `BASELINE_IMPORT` approval request; nothing is written yet.
4. A **second** hospital-wide administrator approves in Approvals. The file is checked again against the database as it is now; if anything changed, the approval is refused (`BASELINE_CHANGED_SINCE_REQUEST`) and nothing is written.
5. It is applied in the approval's single transaction: departments, units with their first bed-log row, positions (successors set in a second pass), categories, types and fields; one HIGH audit entry `BASELINE_IMPORTED` with the file hash and the codes created.

The import never changes an existing record — conflicts are resolved through the ordinary screens, which have their own approvals and audit — and the same file twice creates nothing.

## 5. Rollback

- **Code:** revert the commits above, or reset to tag `pre-db-first`.
- **Database:** Prisma has no down migrations. The migration adds a table, a column and a foreign key, and keeps the field-definition JSON as `field_defs_legacy` — but the old code reads a column named `field_defs`, so older code does **not** run against the migrated schema. To go back, restore the `pg_dump` taken before the migration (or rename the column back and delete the migration's row from `_prisma_migrations` on a development database).
- The seed files remain retrievable from the tag and are recorded in [SEED_DATA_INVENTORY.md](SEED_DATA_INVENTORY.md).
- V03's database (`nurseapp`) was never touched.

## 6. Validation

| Check | Result |
| :--- | :--- |
| Migration on the development database | Applied; 68 field definitions copied, 0 mismatches, original order kept; KPI areas carried over |
| Full test suite on a database migrated but **never seeded** | 310 / 310 — no test depended on seeded rows |
| Fresh database, migrations only | Empty: 0 accounts, 0 departments, units, positions, credential types (`bootstrap.test.ts`) |
| Bootstrap | Creates exactly the System Admin, hospital-wide HR Admin and break-glass account; audited without passwords; refuses a second run (mutation-checked) |
| Empty database through the API alone | Administrators create a department, unit, position, category, credential type; HR onboards a nurse (position required without SN), a second person approves the contract, a verified credential makes the nurse eligible, RBAC denies the audit log to HR, audit chain intact (`database-first.test.ts` A) |
| Baseline import | Reproduces 5 / 47 / 582 / 16 / 5 / 16 / 68 exactly, 47 bed-log rows, 11 KPI areas, 2 replacements; self-approval refused; second run creates nothing; bad files and invalid rows write nothing; a conflict arising after the request rolls the whole import back (mutation-checked) |
| Demo fixtures | Load only into an empty development database; statuses follow dates; only 2004 and 3005 eligible; the demo login works |
| Final regression (after the seed was removed) | `npm ci` ✓ · `prisma generate` ✓ · `prisma validate` ✓ · `prisma format --check` ✓ · `migrate deploy` on both databases: no pending ✓ · drift: none ✓ · `npx prisma db seed`: "No seed command configured" ✓ · typecheck ✓ · backend **313 / 313** (21 files, including the three brand-new-database suites) · frontend **35 / 35** · build ✓ · bundle **173.37 KB gz** / 200 · documentation links **107 / 107** · built API: health 200, anonymous import 401 |

## 7. Remaining references to the old seed values

Final search for `SEED_DEMO`, `DEMO_*`, `DEPARTMENTS`, `UNITS`, `POSITIONS`, `CREDENTIAL_CATEGORIES`, `CREDENTIAL_TEMPLATES`, `ER_MAIN`, `ICU_MAIN`, `INP_WARDS`, `admin@aigh.sa`, `breakglass@aigh.sa`, `demo1234` (application code, tests, docs, ops; `node_modules`, builds and the generated client excluded):

| Where | Classification | Why it stays |
| :--- | :--- | :--- |
| `backend/prisma/baseline/aigh-baseline.json` | **MIGRATION / import reference file** | Hospital data as a data file, loaded only through the four-eyes import |
| `backend/prisma/migrations/20260924100000_database_first_master_data/migration.sql` | **MIGRATION** | Carries the former KPI unit-code map onto existing databases; applied migrations never change |
| `backend/test/fixtures/demo/*` | **TEST FIXTURE** | Development-only demo data and its guarded loader |
| `ops/backup/sql/20_org_structure.sql` | **TEST FIXTURE** (backup drill) | Synthetic tables of the backup/PITR drill's own throwaway cluster; the application never reads it |
| `.env.example` | **DOCUMENTATION** | Names the demo logins the fixture creates |
| `docs/SEED_DATA_INVENTORY.md`, this document, `docs/V04_ARCHITECTURE_PLAN.md` §2 | **DOCUMENTATION** | Record of the original seed and the original design |
| `docs/history/*`, `docs/reference/*` | **LEGACY** | V03 analysis and the verbatim specification |
| Application code (`backend/src`, `frontend/src`) | — | **No occurrence.** `demo1234` occurs nowhere except V03 history. Nothing must be removed |

The JSON column `credential_templates.field_defs_legacy` is deliberately **kept** (unread) as a rollback reference; dropping it is a separate, owner-approved migration once the database-first setup has been accepted in the hospital environment.

## 8. Follow-up (after the final report)

| Item | Outcome |
| :--- | :--- |
| No screen to create a credential type with its fields | **Done.** Credentials → Catalog: *Add credential type*, and *Edit* now covers name, category, description, expiry, upload, grace, display order, status and the tracked fields (add, remove, reorder, issue/expiry flags). Both go to a second system-wide administrator (D-24); an edit sends only what changed (`frontend/src/modules/credentials/catalogForm.ts`, unit-tested). |
| Defect found while testing it | A change to a type's **fields** could never be approved: the re-check compared the stored request (jsonb, keys re-sorted by PostgreSQL) with the live value by `JSON.stringify`, so it always reported `TEMPLATE_CHANGED_SINCE_REQUEST`. Fixed with a key-order-insensitive comparison (`backend/src/lib/same.ts`), also used by the baseline import; covered by an API test through the approval. |
| GitHub CI | Green on every migration commit up to `8474a54`, and on `24bfa14`. |
| First browser check (HR Admin, 2026-09-23) | Add credential type, category edit and a new requirement all worked; each catalog change became a pending approval. It revealed that one field could be marked as **both** issue and expiry date (every credential would expire the day it was issued). Now refused by the form, the API (`VALIDATION_FAILED`), again when an older request is approved (`FIELD_DEFINITIONS_INVALID`), and by the database (`chk_template_fields_not_issue_and_expiry`). |
| `field_defs_legacy` and the `pre-db-first` dumps | Kept for now. Owner decision (2026-09-24): retire both during **go-live preparation, before the production database is created** (fallback date 2026-10-24) — steps in [DEPLOYMENT.md §4](DEPLOYMENT.md#go-live-preparation-before-creating-the-production-database). |
| First accounts on the development database | Done by the owner with `npm run bootstrap -w backend`: System Admin, HR Admin, break-glass. |
| Four-eyes in the browser (2026-09-24) | System Admin elevated, approved the category change (#2, executed) and rejected the invalid credential type (#1, nothing written); audit chain intact. The Approvals screen no longer offers Approve/Reject on one's own request (`a715701`). |
| Withdrawing one's own request | Owner decision: allowed. The initiator may withdraw a `PENDING` request — audited `APPROVAL_WITHDRAWN`, never executed, row-locked against a concurrent decision (merged in `3863f1f`, migration `20260925200000_approval_withdrawal`). |
| Leaked development password | A scratch script with the `aigh` database URL was committed in `2dc0d7b` (public repository; removed in `a9b5505`). The owner changed the password on 2026-09-24; dot-prefixed scratch scripts are now git-ignored (`9b95471`). The old value remains in Git history but no longer opens anything. |
