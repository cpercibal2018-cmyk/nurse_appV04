# Deployment and operations

How to run V04 and what must be settled before production. **Production runs on Google Cloud in Dammam (`me-central2`, D-49)**: the API, worker, web server (nginx) and ClamAV as containers on one Compute Engine VM, PostgreSQL 15 on a second VM, releases through GitHub Actions with a manual approval. The Google Cloud setup and the release pipeline are in [ops/gcp/README.md](../ops/gcp/README.md); this guide covers the settings, jobs, database, backups and monitoring that apply however the processes are run.

> **Production prerequisites are still open.** With `NODE_ENV=production` the API starts only with `UPLOAD_SCANNER=clamav` and a reachable `CLAMAV_HOST` configured (D-10, [§2.1](#21-malware-scanner-clamav)); [§6](#6-known-gaps-before-production) lists what else must be settled first.

## 1. Requirements

| Component | Version / note |
| :--- | :--- |
| Node.js | 22 LTS or newer (`engines` in `package.json`; CI uses 22) |
| PostgreSQL | 15 (extensions `btree_gist`, `pgcrypto` — created by the first migration) |
| Reverse proxy | TLS termination; serves the frontend and forwards `/api/v1` to the API on the **same origin** (the refresh cookie, CSRF and `Origin` checks assume it) |
| ClamAV | `clamd` 1.x reachable over TCP from the API, ≥ 2 GB RAM, signatures updated by `freshclam` (spec §5.3.2). See §2.1 |
| Hosting | Inside the Kingdom (spec §8.3). The API and worker refuse to start outside the configured KSA region allowlist |

## 2. Configuration

Every backend setting is in [`.env.example`](../.env.example) and is validated at start-up (`backend/src/config/env.ts`); a bad value stops the process with a clear message.

| Setting | Default | Production note |
| :--- | :--- | :--- |
| `NODE_ENV` | development | `production` |
| `PORT` | 3001 | Behind the proxy |
| `CORS_ORIGIN` | http://localhost:5173 | The public app origin |
| `DATABASE_URL` | — | Required. In production the `nurseapp_runtime` login ([ops/db](../ops/db/README.md)) |
| `MIGRATION_DATABASE_URL` | — (falls back to `DATABASE_URL`) | The `nurseapp_migration` login; read only by `prisma migrate deploy`, set only where releases run |
| `JWT_SECRET` | — | Required, ≥ 32 characters of random data (spec §3.4). Rotating it signs everyone out |
| `ACCESS_TOKEN_TTL_SECONDS` / `SESSION_IDLE_SECONDS` / `SESSION_ABSOLUTE_SECONDS` | 900 / 3600 / 86400 | D-6 |
| `BCRYPT_ROUNDS` | 12 | 10–15 |
| `LOGIN_THROTTLE_WINDOW_SECONDS` / `_MAX_PER_ACCOUNT` / `_MAX_PER_CLIENT` | 900 / 5 / 20 | D-23. Counted in the database (`login_throttle`, D-46), so they hold across any number of API instances and restarts |
| `STORAGE_DIR` | ./storage | Persistent, backed-up volume; never served directly |
| `UPLOAD_MAX_SIZE_BYTES` | 10485760 | Spec §5.1.5 |
| `UPLOAD_SCANNER` | dev-magic-bytes | `clamav` — production refuses anything else (D-10, §2.1) |
| `CLAMAV_HOST` / `CLAMAV_PORT` | — / 3310 | The `clamd` TCP endpoint; the host is required with `clamav` |
| `CLAMAV_TIMEOUT_MS` | 30000 | Per `clamd` call (spec §5.3.2) |
| `CLAMAV_MAX_SIGNATURE_AGE_HOURS` | 48 | Older signatures log `clamav signatures are stale` (spec §5.3.2 rule 7) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | — / 587 / false | The hospital relay (D-47); empty = e-mail off. STARTTLS is required on 587; `true` for implicit TLS on 465 (§2.2) |
| `SMTP_USER` / `SMTP_PASS` | — | The relay's service account; the password from the deployment secrets |
| `SMTP_FROM` / `SMTP_REPLY_TO` | — | Sender (required with `SMTP_HOST`) and a monitored HR mailbox |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | true | Verify the relay certificate; `false` is refused in production |
| `SMTP_RETRY_MAX` / `SMTP_RETRY_DELAY_SECONDS` | 8 / 60 | Spec §7.2 |
| `APP_BASE_URL` | `CORS_ORIGIN` | The public app URL used in e-mail links |
| `BREAK_GLASS_ALERT_EMAILS` | — | Comma-separated: the CEO and IT Director (spec §3.6) |
| `TRUST_PROXY` | false | `true` behind the proxy, so login limits and session history see the client address |
| `JOBS_MODE` | in-process | `worker` on the API in production (§3) |
| `DATA_RESIDENCY_REGION` / `PDPL_ALLOWED_REGIONS` | local / local | A KSA region id and its allowlist; `local` is refused in production. Never `me-south-1` (Bahrain) or `me-central-1` (UAE) |
| `DEMO_PASSWORD` | — | Development fixtures only (`npm run fixtures:demo`); never set in production |

### 2.1 Malware scanner (ClamAV)

Every upload (credential evidence and contract copies) goes: size and type checks → magic bytes → **`clamd` scan** → storage → database row. The API streams the bytes to `clamd` with `INSTREAM` inside the upload request (`backend/src/lib/scanner.ts`), so a file is written to `STORAGE_DIR` only after `clamd` reports it clean:

| `clamd` result | Response | What is kept |
| :--- | :--- | :--- |
| `OK` | 201; document `CLEAN`; the `DOCUMENT_UPLOADED` audit names the engine and signature version | File and row |
| `… FOUND` | 422 `UPLOAD_INFECTED` | **Nothing stored.** A HIGH audit entry `DOCUMENT_REJECTED_INFECTED` (file name, size, SHA-256, signature) and an error log line `malware detected in upload` |
| Error, timeout, unreachable, or **no signature database loaded** | Retried — 3 attempts in total — then 503 `SCANNER_UNAVAILABLE` | Nothing stored; error log `upload scan failed; upload refused`. The user uploads again later |

**Deliberate deviation from the spec — owner decision [D-43](V04_ARCHITECTURE_PLAN.md#9a-decision-record-2026-09-23).** Spec §5.3.2 describes an asynchronous quarantine queue (`PENDING` → `SCANNING` → `CLEAN` / `INFECTED` / `SCAN_FAILED`, a quarantine area and a scan worker). It is not built and should not be: the uploader gets an immediate answer instead of a later silent deletion, unscanned bytes never reach persistent storage, and there is no worker that could crash and leave files stuck pending. With files capped at `UPLOAD_MAX_SIZE_BYTES` the synchronous scan meets the spec's rules — nothing unscanned is stored or served, infected files are not kept, every rejection is audited.

**Operating `clamd`:**

- Run `clamd` on a host the API reaches (a separate host or container is fine; nothing else should reach port 3310). For a local trial: `docker compose --profile clamav up -d clamav`.
- `StreamMaxLength` in `clamd.conf` must be at least `UPLOAD_MAX_SIZE_BYTES` (clamd's default is 25 MB; the upload limit is 10 MB).
- `freshclam` must update the signatures at least daily; it needs outbound HTTPS to the ClamAV mirrors (or a hospital mirror). Signatures that are only old (older than `CLAMAV_MAX_SIGNATURE_AGE_HOURS`) do not stop uploads, but every scan logs an error until they are refreshed — alert on it (§7). A `clamd` with **no** official signature database (its `VERSION` reply has no database number) is treated as misconfigured: uploads are refused with `SCANNER_UNAVAILABLE`, because such a scanner reports almost everything as clean.
- **Go-live check** — from the API host, before enabling uploads: [`ops/clamav/go-live-check.sh`](../ops/clamav/go-live-check.sh) `clamav.internal 3310`. It talks to `clamd` the way the API does (bash only, no `clamdscan` or `nc`) and exits non-zero unless all five checks pass:

  | Check | Passes when | Typical fix when it fails |
  | :--- | :--- | :--- |
  | Reachable | `PING` → `PONG` | Firewall between the API and the scanner host, host name or port |
  | Signatures | `VERSION` carries a database number, dated within 24 h (`CHECK_MAX_AGE_HOURS`) | Run / enable `freshclam`; allow its outbound HTTPS or configure the internal mirror |
  | Detection | The standalone EICAR file is `FOUND` under an official name — no `.UNOFFICIAL` suffix | The official database is not loaded (see Signatures) |
  | Clean | A small PDF → `OK` | — |
  | Size limit | A file of `UPLOAD_MAX_SIZE_BYTES` → `OK` | Raise `StreamMaxLength` in `clamd.conf` |

  Then upload one real document through the app and confirm it is accepted. (A PDF with the EICAR string inside it may or may not be flagged by the official signatures, which match the standalone test file; the rejection path itself is covered by the automated tests.)

### 2.2 E-mail (hospital SMTP relay)

Every in-app notification is also e-mailed to the recipient's account address, and a break-glass sign-in e-mails each `BREAK_GLASS_ALERT_EMAILS` address (spec §3.6). Notifications are an outbox (D-47): a new row is `PENDING`, and the **e-mail dispatcher** — in the worker (or the API with `JOBS_MODE=in-process`), every 60 seconds under a 10-minute lease (spec §7.2) — sends it through the relay:

| Outcome | Row becomes |
| :--- | :--- |
| Relay accepted it | `SENT` |
| Relay refused or unreachable | stays `PENDING`, retried every `SMTP_RETRY_DELAY_SECONDS`; after `SMTP_RETRY_MAX` attempts `FAILED`, with the relay's error in `email_last_error` and an error log `e-mail delivery failed; giving up` |
| E-mail off (`SMTP_HOST` empty) or the recipient deactivated | `SKIPPED` |

Delivery is at-least-once: a crash after the relay accepted a message but before the row is updated sends it again, with the same `Message-ID`. Each message is plain text + HTML (UTF-8, English and Arabic), has no external images, and links only to `APP_BASE_URL`. Notifications stored before this release keep their status and are never e-mailed.

**Prerequisites from hospital IT:** the relay host and port, a service account, the sender and reply-to addresses, the relay's CA certificate if it is not publicly trusted (then set `NODE_EXTRA_CA_CERTS`), and — because production runs on Google Cloud (D-49) while the relay is on the hospital network — **private connectivity from the Google Cloud project to the relay** (Cloud VPN or Interconnect), with the relay allowing that source range.

**Go-live checklist** (spec §7.3): send one notification to a staging mailbox and check it in Outlook and on a phone (Arabic renders, From / Reply-To correct); run the expiry scan and confirm the e-mail arrives within about a minute; stop the relay and confirm retries and `FAILED` after the last attempt, then restart it and confirm new mail flows; sign in with the break-glass account and confirm the CEO and IT Director e-mails arrive.

## 3. Processes and background jobs

| Process | Command | Notes |
| :--- | :--- | :--- |
| API | `npm run start -w backend` (`node dist/server.js`) | Runs the jobs itself only when `JOBS_MODE=in-process` |
| Worker | `npm run worker -w backend` (`node dist/jobs/worker.js`) | No HTTP listener; runs the scheduler. Start exactly one in production and set `JOBS_MODE=worker` on the API |
| Frontend | `npm run build -w frontend` → `frontend/dist/` | Static files served by the proxy; the build fails if the bundle budget is exceeded |

| `JOBS_MODE` on the API | Use |
| :--- | :--- |
| `in-process` | Development: one process does everything |
| `worker` | Production: the separate worker runs the jobs (spec §10.2) |
| `off` | Maintenance; nothing runs. Missed periods run when jobs are next enabled |

**Job schedule (Asia/Riyadh, independent of the server time zone):** `daily-transition` 00:05, `expiry-scan` 06:00, `consistency-audit` 03:00 (re-evaluates a random sample of nurses' eligibility — 1%, at least 50 — and corrects any drift, spec §10.8), `attendance-alerts` every 15 minutes. Running two workers by mistake is safe (leases and unique run keys), but wasteful. A System Admin sees run history and can start a job from **Administration → Jobs**.

## 4. Release procedure

In production the **Deploy** workflow does these steps with container images after a reviewer approves ([ops/gcp/README.md §8](../ops/gcp/README.md#8-a-release)). By hand, on any server:

```bash
npm ci
npm run build                       # backend (prisma generate + tsc) and frontend (with bundle gate)
npm run db:deploy -w backend        # prisma migrate deploy as nurseapp_migration — never db push; there is no seed
psql -U <owner> -d <database> -f ops/db/02_grants.sql   # re-apply role privileges (ops/db/README.md)
psql -U postgres -d <database> -v ON_ERROR_STOP=1 -f ops/db/verify.sql   # every check PASS, or stop here
# restart the API and the worker
curl -fsS https://<host>/api/v1/health   # 200 {"status":"ok","database":"up"}; 503 when the database is down
```

After a release, a System Admin should open **Audit → Verify chain** (expected: intact) and **Administration → Jobs** (expected: recent runs completed).

**First release after commit 10b:** the reminder job sends each record's current milestone once under the new milestone keys (D-39); contracts that already ended without a renewal get one "Contract ended" notice.

### Go-live preparation (before creating the production database)

Owner decision 2026-09-24: the two safety nets of the database-first migration ([DATABASE_MIGRATION.md](DATABASE_MIGRATION.md)) are retired **before** the production database is created, so production never carries them. If go-live is not scheduled by **2026-10-24**, do it then anyway.

1. Fresh backup of the development database `nurseapp_v04` (`pg_dump -Fc`) — the new rollback point.
2. A migration drops `credential_templates.field_defs_legacy` (remove it from `schema.prisma` and from `presentTemplate` in `credentials/fields.ts`); full test suite; applied to the development and test databases. In a fresh database the column is always empty, so it protects nothing in production.
3. The owner deletes `C:\WebApp_project\Local_Repo\backups\nurseapp_v04_pre-db-first.dump` and `nurseapp_test_pre-db-first.dump` (development data only; deleting files is the owner's step).
4. Keep the Git tag `pre-db-first` (code only, no data).
5. Record the date and decision in [DATABASE_MIGRATION.md §8](DATABASE_MIGRATION.md#8-follow-up-after-the-final-report).

**Status 2026-09-24:** steps 1, 2, 4 and 5 done at the owner's request (backup `nurseapp_v04_pre-go-live_2026-09-24.dump`; migration `20260926090000_drop_field_defs_legacy`). Step 3 done by the owner the same day: both `pre-db-first` dumps deleted; `backups\` holds only the new dump. Go-live preparation is complete.

Then the production database is created as below.

### First installation (empty database)

1. Database roles ([ops/db/README.md](../ops/db/README.md)): `01_roles.sql` as a superuser, set the four passwords with `\password`, `02_grants.sql` as the database owner; `DATABASE_URL` = `nurseapp_runtime`, `MIGRATION_DATABASE_URL` = `nurseapp_migration`. The API and worker refuse to start in production while `DATABASE_URL` can change the schema.
2. `npm run db:deploy -w backend`, then `02_grants.sql` again, then `verify.sql` as the superuser (every check PASS) — the structure only; the database holds no data and no accounts.
3. `npm run bootstrap -w backend` in an interactive terminal on the server — creates the first System Admin and a hospital-wide HR Admin (two people, so approvals work) and optionally the break-glass account. It refuses to run once any account exists.
4. The HR Admin signs in, opens **Administration → Hospital baseline import**, previews the hospital's baseline file (the reference is `backend/prisma/baseline/aigh-baseline.json`) and requests the import; the System Admin elevates (PAM) and approves it. It is applied in one transaction or not at all.
5. Credential requirements (the hospital's credential policy), accounts, employees and contracts are then entered through the application.

Never run the demo fixtures on a production database; the command refuses `NODE_ENV=production` and any database with accounts.

## 5. Backups and restore

The scripts, their environment contract and the verified drill are in [`ops/backup/README.md`](../ops/backup/README.md): WAL archiving, an encrypted nightly base backup, point-in-time restore and a restore drill.

**Schedule (D-40):** nightly at **01:00 Asia/Riyadh (22:00 UTC)**, as spec §10.6 says. `aigh-backup.timer` names the `Asia/Riyadh` time zone, so it is right whatever the host clock; `crontab.example` has one line for a UTC host and one for a Riyadh host — use exactly one. It does not collide with the application jobs (00:05 and 06:00 Riyadh).

## 6. Known gaps before production

| Gap | Effect | What is needed |
| :--- | :--- | :--- |
| **Database roles: to be applied on each server** (spec §10.7) | [`ops/db`](../ops/db/README.md) holds the roles, grants and a read-only check (`verify.sql`), all tested in CI; the open spec items are decided (D-44, D-45). The API and worker **refuse to start in production** until `DATABASE_URL` is a data-only login | On each server: the README steps 1–5 (a DBA, about 15 minutes), `verify.sql` all PASS, then switch the URLs |
| **Prisma CLI advisories** | `npm audit`: 4 high-severity advisories in the Prisma CLI's bundled dependencies (`mysql2`, `deepmerge-ts`). The CLI is a development/migration tool; the running API uses `@prisma/client` with the PostgreSQL adapter and does not load the MySQL driver. npm's suggested "fix" downgrades to Prisma 6 (breaking) and was **not** applied | Run migrations from the CI/release host rather than installing dev tools on the runtime host; upgrade Prisma when a patched release exists; re-run `npm audit` at every release |
| **`pg` 9 not yet usable** | Inside an interactive transaction Prisma 7.10's query interpreter reads the relations of a multi-relation `include` concurrently on the transaction's single `pg` client ([prisma/prisma#29407](https://github.com/prisma/prisma/issues/29407)). `pg` 8 queues the queries (results are correct) but prints its "client is already executing a query" deprecation, which `pg` 9 turns into a failure. The application's own code issues transaction queries one at a time | Stay on `pg` 8 until a Prisma release with the fix; then upgrade both together and run the full test suite |
| **No SMS** | E-mail (§2.2), registration by invitation and password reset (D-50) are built; all need the relay and the private link from Google Cloud. SMS (the break-glass alert by text, D-48) is not built yet | The hospital SMS gateway's API details (D-48) |
| **No badge feed** (D-33) | Attendance gaps and alerts only work once events are loaded into `attendance_events` | The PACS interface contract |
| **Google Cloud not yet provisioned; no blue/green** (spec §10.4) | Images, the app-VM runtime and the Deploy workflow are built and tested locally ([ops/gcp](../ops/gcp/README.md)); the project, network, VMs, load balancer and HA VPN to the hospital do not exist yet. A release briefly restarts the containers (no blue/green) | The cloud administrator runs ops/gcp/README.md §1–§7; blue/green if the brief restart is not acceptable |

## 7. Monitoring

| Signal | Where |
| :--- | :--- |
| Liveness and database | `GET /api/v1/health` |
| Logs | One JSON line per event on stdout with `requestId`; no personal data. Every response carries `X-Request-Id` |
| Background jobs | `job_runs` (Administration → Jobs); the `worker_lease_status` view shows lease holders and heartbeats |
| Audit integrity | `GET /api/v1/audit/verify` (Audit page); the `audit_chain_breaks` view must be empty |
| Malware scanner | Error log lines `malware detected in upload`, `upload scan failed; upload refused` and `clamav signatures are stale`; HIGH audit `DOCUMENT_REJECTED_INFECTED` |
| Break-glass use | CRITICAL in-app notification and e-mail to every System Admin; e-mail to `BREAK_GLASS_ALERT_EMAILS`; `break_glass_events` |
| Business health | Administration → Jobs → **System health** (`GET /api/v1/system/health/business`): eligibility drift found and corrected by the daily consistency audit, jobs that are late or failed, e-mail backlog and failures. System Admins also get an in-app notice on any day drift is corrected |
| E-mail delivery | Error log `e-mail delivery failed; giving up`. Backlog: `SELECT email_status, count(*), min(created_at) FROM notifications WHERE created_at > now() - interval '1 day' GROUP BY 1` — a growing `PENDING` count or old `min` means the relay or the worker is down; the same for `email_outbox.status` |
