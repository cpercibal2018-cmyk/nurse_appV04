# Deployment and operations

How to run V04 and what must be settled before production. The production topology in the reference spec (§2.2, §10) describes containers and blue/green releases; **V04 has no container images yet** (only a development database in `docker-compose.yml`), so this guide describes plain Node processes behind a reverse proxy.

> **Production is not possible yet.** The API refuses to start with `NODE_ENV=production` because no malware scanner exists for uploads (D-10). See [§6](#6-known-gaps-before-production) for this and the other prerequisites.

## 1. Requirements

| Component | Version / note |
| :--- | :--- |
| Node.js | 22 LTS or newer (`engines` in `package.json`; CI uses 22) |
| PostgreSQL | 15 (extensions `btree_gist`, `pgcrypto` — created by the first migration) |
| Reverse proxy | TLS termination; serves the frontend and forwards `/api/v1` to the API on the **same origin** (the refresh cookie, CSRF and `Origin` checks assume it) |
| Hosting | Inside the Kingdom (spec §8.3). The API and worker refuse to start outside the configured KSA region allowlist |

## 2. Configuration

Every backend setting is in [`.env.example`](../.env.example) and is validated at start-up (`backend/src/config/env.ts`); a bad value stops the process with a clear message.

| Setting | Default | Production note |
| :--- | :--- | :--- |
| `NODE_ENV` | development | `production` |
| `PORT` | 3001 | Behind the proxy |
| `CORS_ORIGIN` | http://localhost:5173 | The public app origin |
| `DATABASE_URL` | — | Required |
| `JWT_SECRET` | — | Required, ≥ 32 characters of random data (spec §3.4). Rotating it signs everyone out |
| `ACCESS_TOKEN_TTL_SECONDS` / `SESSION_IDLE_SECONDS` / `SESSION_ABSOLUTE_SECONDS` | 900 / 3600 / 86400 | D-6 |
| `BCRYPT_ROUNDS` | 12 | 10–15 |
| `LOGIN_THROTTLE_WINDOW_SECONDS` / `_MAX_PER_ACCOUNT` / `_MAX_PER_CLIENT` | 900 / 5 / 20 | D-23; see the single-instance limit in §6 |
| `STORAGE_DIR` | ./storage | Persistent, backed-up volume; never served directly |
| `UPLOAD_MAX_SIZE_BYTES` | 10485760 | Spec §5.1.5 |
| `UPLOAD_SCANNER` | dev-magic-bytes | Production refuses both current values (§6) |
| `TRUST_PROXY` | false | `true` behind the proxy, so login limits and session history see the client address |
| `JOBS_MODE` | in-process | `worker` on the API in production (§3) |
| `DATA_RESIDENCY_REGION` / `PDPL_ALLOWED_REGIONS` | local / local | A KSA region id and its allowlist; `local` is refused in production. Never `me-south-1` (Bahrain) or `me-central-1` (UAE) |
| `DEMO_PASSWORD` | — | Development fixtures only (`npm run fixtures:demo`); never set in production |

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

**Job schedule (Asia/Riyadh, independent of the server time zone):** `daily-transition` 00:05, `expiry-scan` 06:00, `attendance-alerts` every 15 minutes. Running two workers by mistake is safe (leases and unique run keys), but wasteful. A System Admin sees run history and can start a job from **Administration → Jobs**.

## 4. Release procedure

```bash
npm ci
npm run build                       # backend (prisma generate + tsc) and frontend (with bundle gate)
npm run db:deploy -w backend        # prisma migrate deploy — never db push; there is no seed
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

**Status 2026-09-24:** steps 1, 2, 4 and 5 done at the owner's request (backup `nurseapp_v04_pre-go-live_2026-09-24.dump`; migration `20260926090000_drop_field_defs_legacy`). Step 3 — the owner deleting the two `pre-db-first` dumps — is open.

Then the production database is created as below.

### First installation (empty database)

1. `npm run db:deploy -w backend` — the structure only; the database holds no data and no accounts.
2. `npm run bootstrap -w backend` in an interactive terminal on the server — creates the first System Admin and a hospital-wide HR Admin (two people, so approvals work) and optionally the break-glass account. It refuses to run once any account exists.
3. The HR Admin signs in, opens **Administration → Hospital baseline import**, previews the hospital's baseline file (the reference is `backend/prisma/baseline/aigh-baseline.json`) and requests the import; the System Admin elevates (PAM) and approves it. It is applied in one transaction or not at all.
4. Credential requirements (the hospital's credential policy), accounts, employees and contracts are then entered through the application.

Never run the demo fixtures on a production database; the command refuses `NODE_ENV=production` and any database with accounts.

## 5. Backups and restore

The scripts, their environment contract and the verified drill are in [`ops/backup/README.md`](../ops/backup/README.md): WAL archiving, an encrypted nightly base backup, point-in-time restore and a restore drill.

**Schedule (D-40):** nightly at **01:00 Asia/Riyadh (22:00 UTC)**, as spec §10.6 says. `aigh-backup.timer` names the `Asia/Riyadh` time zone, so it is right whatever the host clock; `crontab.example` has one line for a UTC host and one for a Riyadh host — use exactly one. It does not collide with the application jobs (00:05 and 06:00 Riyadh).

## 6. Known gaps before production

| Gap | Effect | What is needed |
| :--- | :--- | :--- |
| **No malware scanner** (D-10) | The API will not start in production | A ClamAV adapter behind `UPLOAD_SCANNER=clamav` (spec §5.3) |
| **Database roles and grants** (spec §10.7) | One owner role is used everywhere; the runtime could alter the schema. The audit table is still append-only by trigger | Write `ops/db/grants.sql` (runtime, migration, backup, audit-reader roles) and connect the API with the runtime role |
| **Login limits are in memory** (`lib/throttle.ts`) | Correct for one API process. With several API instances, each counts separately, so the limits multiply | Run a single API instance, or move the counters to the database |
| **Prisma CLI advisories** | `npm audit`: 4 high-severity advisories in the Prisma CLI's bundled dependencies (`mysql2`, `deepmerge-ts`). The CLI is a development/migration tool; the running API uses `@prisma/client` with the PostgreSQL adapter and does not load the MySQL driver. npm's suggested "fix" downgrades to Prisma 6 (breaking) and was **not** applied | Run migrations from the CI/release host rather than installing dev tools on the runtime host; upgrade Prisma when a patched release exists; re-run `npm audit` at every release |
| **`pg` 9 not yet usable** | Inside an interactive transaction Prisma 7.10's query interpreter reads the relations of a multi-relation `include` concurrently on the transaction's single `pg` client ([prisma/prisma#29407](https://github.com/prisma/prisma/issues/29407)). `pg` 8 queues the queries (results are correct) but prints its "client is already executing a query" deprecation, which `pg` 9 turns into a failure. The application's own code issues transaction queries one at a time | Stay on `pg` 8 until a Prisma release with the fix; then upgrade both together and run the full test suite |
| **No SMTP / SMS** | Reminders are in-app only; the break-glass alert does not reach the CEO and IT Director (spec §3.6); no password reset or invitation e-mails | An SMTP (and SMS) decision (spec §7.2) |
| **No badge feed** (D-33) | Attendance gaps and alerts only work once events are loaded into `attendance_events` | The PACS interface contract |
| **Renewal picker capped at 500** | `GET /contracts/renewable` lists at most 500 in-scope employees, ordered by job number, without search | Add search / pagination before a hospital-wide HR Admin has more than 500 employees in scope |
| **No container images or blue/green** (spec §10.4) | Deployment is manual (§4) | Dockerfiles and a pipeline, when the hosting decision is made |

## 7. Monitoring

| Signal | Where |
| :--- | :--- |
| Liveness and database | `GET /api/v1/health` |
| Logs | One JSON line per event on stdout with `requestId`; no personal data. Every response carries `X-Request-Id` |
| Background jobs | `job_runs` (Administration → Jobs); the `worker_lease_status` view shows lease holders and heartbeats |
| Audit integrity | `GET /api/v1/audit/verify` (Audit page); the `audit_chain_breaks` view must be empty |
| Break-glass use | CRITICAL in-app notification to every System Admin; `break_glass_events` |
