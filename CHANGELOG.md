# Changelog

All notable changes to the AIGH Nursing Workforce Management System. Versions follow [Semantic Versioning](https://semver.org/); while the version is `0.y.z` the system is in development and runs demonstration data only.

## [Unreleased]

### Fixed
- Production start-up now also refuses a database login that may `TRUNCATE` any table (`backend/src/lib/db-role.ts`). Before, only `ops/db/verify.sql` caught that grant; the API and worker would still have started.

## [0.1.0] - Architecture Baseline Reset (2026-09-27)

### Added
- Consolidated monorepo baseline (Express 5, Prisma 7, React 19, PostgreSQL 15).
- Unified `/api/v1` API, single-schema Prisma migration chain, and role-based access control.
- Pure eligibility evaluation engine, database-level audit chaining, and background jobs.
- The version at the foot of the sidebar and in the FHIR `CapabilityStatement`, both read from `package.json`.

### Changed
- Reset application versioning to 0.1.0 (SemVer development baseline). The packages were numbered `4.0.0` ("V04"); no code, schema or migration changed with the number.
- `.env.example` lists every setting the backend reads (added `TELEGRAM_UPDATES`, `TELEGRAM_WEBHOOK_SECRET`, `SCFHS_DRIVER`, `SCFHS_API_URL`, `SCFHS_API_KEY`, `BADGE_SIMULATOR`).

### Superseded
- V03 (`nurse_appV03`) and its database `nurseapp` are superseded by this system. They were never part of this repository, so nothing was removed from it; what V04 dropped from V03 while being rebuilt is recorded in [docs/CLEANUP_REPORT.md](docs/CLEANUP_REPORT.md).
