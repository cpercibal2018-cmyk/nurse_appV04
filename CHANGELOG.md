# Changelog

All notable changes to the AIGH Nursing Workforce Management System. Versions follow [Semantic Versioning](https://semver.org/); while the version is `0.y.z` the system is in development and runs demonstration data only.

## [Unreleased]

### Added
- **Guidelines** (side menu, every signed-in user): the user manual inside the application — what each screen is for, every task in one template (purpose, who, before you start, steps, system result, approval, next step, common problems, related), 25 workflows drawn as images, the complete hospital workflow, troubleshooting and a quick reference; search; "Only tasks for my roles"; light, dark, Arabic interface (the guide's text is English). Every task is labelled Implemented, Partially implemented or Planned and is traced to the code in [docs/GUIDELINES_COVERAGE.md](docs/GUIDELINES_COVERAGE.md). A "?" beside the title of twelve pages opens the matching section.
- The same content as [docs/USER_MANUAL.md](docs/USER_MANUAL.md), workflow images in `docs/generated/flows/`, and a printable PDF (`docs/generated/AIGH_Nursing_Workforce_User_Manual_V04.pdf`, also downloadable from the Guidelines page), built by `npm run docs:manual` (dev dependency `pdfkit`).
- VPS: `REDIRECT_HOSTS` in `/etc/nurseapp/deploy.env` (space-separated, in double quotes: bash reads the file) — names such as the bare domain and `www` that permanently redirect to `https://SITE_HOST`, each with its own certificate (`ops/vps/Caddyfile`, `deploy.sh edge`). Empty by default: nothing changes.
- VPS: `monitor.sh --test-alert` sends one test alert to the recipients in `/etc/nurseapp/monitor.env` without running the checks, and exits 1 with the reason if nothing could be sent (`ops/vps/README.md`). The VPS test checks it against its test mail server.
- **Credentials → Records → Record credential for a nurse** (HR Admin, System Admin): HR records a licence or certificate on a nurse's behalf — search the nurse in scope, choose the type, fill in its fields; the Evidence panel then opens for the upload. Uses the existing `POST /credentials` (scoped, audited, starts Pending verification). Before, only the nurse could add a credential on screen. The Guidelines, the manual and the coverage matrix say so.

### Changed
- **A contract renewal needs valid credentials** (owner decision, 2026-10-02). For a nurse who has had a contract before — a renewal, or a new contract after the old one ended — the contract is neither created nor approved while a required (MANDATORY) credential of their unit and position is missing, expired, not verified, suspended or revoked, or while they have no unit. The refusal (`CREDENTIALS_BLOCK_RENEWAL`) lists the credentials. Only credential reasons count — the ended contract does not, so it can always be renewed once the credentials are in order; grace, waivers and transition periods pass; a first contract is not checked (`backend/src/modules/contracts/service.ts`). The Guidelines, `docs/USER_MANUAL.md`, the PDF manual and the contract flow image say so.

### Fixed
- VPS monitoring sent a false "FAILING: containers" e-mail (then "RECOVERED") on every deploy: while colours switch, the old colour's containers stop before `ACTIVE` names the new one. `deploy.sh release` and `rollback` now leave a marker (`/srv/nurseapp/DEPLOYING`, removed on every exit); the containers check skips while it is younger than 30 minutes. The site check still reports a real outage during a deploy.
- VPS: every release left its three images behind (about 1 GB each time). After two days of releases the server held 38 images, 25 GB of them unused, so the disk would eventually fill. `deploy.sh release` now keeps the live and the previous release (a rollback needs it) and removes the older `nurseapp/*` images. A restart, or a deploy of the release that is already live, keeps the earlier release as the rollback target (before, it recorded the live release itself as "previous", and the cleanup then removed the real previous release); `deploy.sh rollback` always starts the colour that is not live, and refuses when there is no earlier release.
- `verify-install.sh` reported the firewall as FAILED ("unexpected open port: 172.17.0.1") on a correct installation: it read the address in the containers' PostgreSQL rule (`172.17.0.1 5432/tcp`) as a port. The check now reads the port of such rules; a really unexpected port, or PostgreSQL open to more than the containers, still fails.
- A restore of a VPS backup could not start: Ubuntu keeps `postgresql.conf`, `pg_hba.conf` and `pg_ident.conf` in `/etc/postgresql/15/main`, outside the data directory, so the base backup does not contain them (found by the first restore drill). `ops/backup/scripts/restore-database.sh` now writes minimal ones when they are missing — local-socket, peer authentication only.
- VPS backups could not start: every release left `/opt/nurseapp` readable by root only (`nurseapp-release` runs with `umask 077`), so PostgreSQL's `archive_command` and the nightly backup — both run as `postgres` — could not read `ops/backup/scripts`. `nurseapp-release`, `deploy.sh load` (which travels with every release, so a server with the older `nurseapp-release` is fixed too) and `setup-backup.sh` now make the released scripts readable (`u=rwX,go=rX`; they are repository files, no secrets). `ops/vps/test/run.sh` fails if a release leaves them root-only.
- The links in the invitation, password-reset and sign-in e-mail change e-mails were plain text (not clickable, and broken up beside the Arabic text). They are now a real button with the address underneath, once, between the English and Arabic text (`backend/src/lib/email-templates.ts`; the three messages pass the address as `link`). Tests fail if a link turns back into plain text.
- `ops/vps/db-init.sh` with a `DB_NAME` other than `nurseapp_v04` now also lets the containers reach that database in `pg_hba.conf`. Before, the first release stopped at its migrations ("no pg_hba.conf entry").
- `ops/vps/setup-host.sh` comments out provider lines above the `Include` in `/etc/ssh/sshd_config` that silently kept root and password sign-in on (found on UltaHost), and now stops unless `sshd -T` reports keys only and no root sign-in. On a host without an IPv6 route, `apt` uses IPv4 only (a mirror's IPv6 address had timed out mid-install).
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
