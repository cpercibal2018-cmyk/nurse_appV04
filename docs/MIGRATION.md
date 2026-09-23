# Migration from V03

How V04 replaces `nurse_appV03`, what happens to V03's data, and where each open V03 programme item stands.

## 1. Data

**No data migration is required.** V03 has no production data: its server re-seeded the database on every container start (`prisma db push` + seed), and the browser store held demo data only ([DATABASE_CONSOLIDATION.md §7](history/DATABASE_CONSOLIDATION.md#7-data-migration-from-v03)). V04 starts from an empty database ([DATABASE_ARCHITECTURE.md §7](DATABASE_ARCHITECTURE.md#7-how-data-enters-the-database)):

- **Hospital baseline** (5 departments, 47 units / 582 beds, 16 positions, the credential catalogue) is entered through the four-eyes baseline import from `backend/prisma/baseline/aigh-baseline.json` and is then HR's to change in the app.
- **Demo data** (V03's fictional employees, contracts, credentials, one account per role) is a development fixture (`npm run fixtures:demo`), never production. The V04 seed that used to load both was retired by the database-first migration ([DATABASE_MIGRATION.md](DATABASE_MIGRATION.md)); its content is in [SEED_DATA_INVENTORY.md](SEED_DATA_INVENTORY.md).

**If a V03 database must be preserved after all,** that is a new requirement (not established). It would need a one-time export → validate → import through the V04 services (so every rule, audit entry and eligibility state is produced), not a table copy. Real employees are otherwise entered through onboarding; there is no bulk employee import (REQUIREMENT NOT ESTABLISHED — only units have a CSV import).

## 2. What changed for users

| V03 | V04 |
| :--- | :--- |
| Standalone demo mode without a server | Removed (D-1); the app always uses the API |
| `DEVELOPER` all-access role | Removed (D-5); one demo user per real role |
| Login by username or email | Email only (D-21) |
| Rules enforced in the browser; generic CRUD API | Every rule in backend services and database constraints; domain endpoints under `/api/v1` ([API.md appendix A](API.md#appendix-a--v03-api-historical)) |
| Onboarding created an Approved contract (spec) / Draft (V03 later) | Draft, approved by a second HR person (D-3, D-30) |
| HR drafted rosters | Scoped Supervisors draft and publish (D-14) |
| Staffing requirement formula `beds × 0.14 / 0.11 / 0.10` | Removed; coverage targets entered per unit and shift (D-16) |
| Waivers covered every check; status alone decided validity | Waiver per credential type; dates checked against the shift date (D-15) — some V03 demo nurses change eligibility |
| Observability page and static admin tabs (Backup, PDPL, FHIR text) | Removed; content lives in this documentation |

## 3. The V03 repository

The V03 repository (`C:\WebApp_project\Local_Repo\app`, repo `nurse_appV03`) is **left untouched** and stays the historical record until V04 has been validated in the hospital environment. Nothing in V04 depends on it. What each V03 file became is recorded in [CLEANUP_PLAN.md](history/CLEANUP_PLAN.md) and [DUPLICATE_IMPLEMENTATION_MAP.md](history/DUPLICATE_IMPLEMENTATION_MAP.md); tagging V03 (`v03-final`) and making it read-only is the owner's action (D-2).

## 4. Open programme items (V03 remediation tracker)

The V03 remediation tracker (`AIGH_v2_8_7_remediation_tracker.md` in the V03 repository, Part B) listed B-01…B-26. Their status in V04:

| ID | Item | Status in V04 |
| :--- | :--- | :--- |
| B-01 | Units and beds as runtime configuration | **Done** — configurable; live bed totals (W3) |
| B-02 | Pin Node 20 in engines, CI and image | **Superseded** by D-13: Node ≥ 22; CI on Node 22 / PostgreSQL 15. No runtime image exists yet |
| B-03 | HTTPS browser test of the refresh cookie (reload, rotation, replay, logout) | Rotation, replay rejection and logout are covered by backend tests; **the HTTPS browser evidence is still open** |
| B-04 | CSRF on every mutating endpoint | **Done** — enforced centrally in `authenticate` for every state-changing request (header bound to the token + `Origin`); tested |
| B-05 | Database privilege separation; contract lifecycle as the runtime role | **Open** — grants not written ([DEPLOYMENT.md §6](DEPLOYMENT.md#6-known-gaps-before-production)). Contract transitions are enforced by the service's transition map, not a database guard function |
| B-06 | Canonical audit DDL in the migration chain; single write path | **Done** — `fn_append_audit_entry` in `init`; append-only trigger. Post-restore check not re-run on V04 |
| B-07 | V35 PDPL encryption, processing register, data-subject requests | **Deferred** (not built) |
| B-08 | Idempotency with minimal replay payloads | **Done** — `[I]` endpoints store identifier-only responses; expired keys purged daily |
| B-09 | Eligibility refresh in the caller's transaction; publish-time re-validation | **Done** |
| B-10 | Worker leases for every job | **Done** for the three V04 jobs. The other V03 jobs (SMTP queue, SCFHS sync, backup monitor, quarantine scan) do not exist in V04 |
| B-11 | Hardened onboarding SQL function | **Superseded** by D-17 (one Prisma transaction) |
| B-12 | Four-eyes (row lock, PENDING precondition, transactional execution, partial unique index) | **Done** |
| B-13 | Consistency auditor | **Deferred** (spec §10.8) |
| B-14 | FHIR adapter | **Deferred** |
| B-15 | Time-zone-safe coverage-gap query; PACS feed contract | Gap query and alerts **done**; feed contract **open** (D-33) |
| B-16 | SSO / MFA | **Deferred** (identity provider not chosen) |
| B-17 | 72-hour waiver limit at the database; expiry reverts eligibility | **Done** (`chk_waiver_max_window`; engine judges waivers at the evaluation instant) |
| B-18 | Key management, pepper rotation, DPO sign-off | **Open** |
| B-19 | Bundle gate in CI; entry < 200 KB gz | **Done** — about 173 KB gz |
| B-20 | Reverse proxy configuration, TLS, HTTPS-only exposure | **Open** (not in the repository) |
| B-21 | Backup scripts on real PostgreSQL 15 with a timed restore drill | Verified by the backup kit ([ops/backup/README.md](../ops/backup/README.md) §5); the schedule is 01:00 Riyadh (D-40, [DEPLOYMENT.md §5](DEPLOYMENT.md#5-backups-and-restore)) |
| B-22 | Decide `archive_timeout` (RPO) | **Open** — owner decision; the kit uses 300 s |
| B-23 | Positions route `/api/v1/positions` | **Done** |
| B-24 | Bulk bed capacity, CSV import, configuration grid | **Done** |
| B-25 | Fail-closed KSA residency check | **Done** |
| B-26 | KSA sandbox and hosting decision sprint | **Open** (organisational) |

**Decision gates** from the tracker (Part D), still open: **U1 hosting** (unblocks B-05, B-07, B-18, B-20 and production), **U2 credential policy and position rules** (Director of Nursing — the real credential requirements and grace windows), **U3 SCFHS agreement**.
