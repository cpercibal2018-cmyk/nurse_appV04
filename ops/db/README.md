# Database roles (spec §10.7)

Four login roles replace the single database owner that V04 used everywhere. The API can read and write data but can no longer change the schema, truncate tables, rewrite audit history or read the migration journal.

| Role | Used by | Can | Cannot |
| :--- | :--- | :--- | :--- |
| `nurseapp_migration` | `prisma migrate deploy` (release step only) | Owns every table, view, type and function; alters the schema | — (as owner it also has data access; see *Adaptations*) |
| `nurseapp_runtime` | API and worker (`DATABASE_URL`) | `SELECT`/`INSERT`/`UPDATE`/`DELETE` on data; sequences | `CREATE`/`ALTER`/`DROP`, `TRUNCATE`; `UPDATE`/`DELETE` on `audit_entries`; `DELETE` on `break_glass_events`; `UPDATE` on `request_audit_log` (D-52); the migration journal |
| `nurseapp_backup` | `pg_basebackup`, `pg_dump` (`DB_BACKUP_USER` in [ops/backup](../backup/README.md)) | Read everything (`pg_read_all_data`); replication | Write anything |
| `nurseapp_audit_reader` | Compliance and audit queries | Read `audit_entries`, `audit_chain_breaks`, `idempotency_keys`, and the security-event tables `break_glass_events`, `privileged_sessions` (D-45), and the request log `request_audit_log` (D-52) | Any business table; any write |

The **database owner** (the login that created the database, `aigh` in development) keeps provisioning rights and runs `02_grants.sql`; it is never used by the running application.

## Files

| File | Run by | When |
| :--- | :--- | :--- |
| [`01_roles.sql`](01_roles.sql) | a **superuser**, connected to the application database | Once per PostgreSQL server |
| [`02_grants.sql`](02_grants.sql) | the **database owner**, connected to the database | After `01_roles.sql`, and again after **every** `prisma migrate deploy` |
| [`verify.sql`](verify.sql) | a **superuser**, connected to the database | After setting up, and after every release — read-only; prints PASS / FAIL / WARN per rule and exits non-zero on any FAIL |

Both are idempotent. [`backend/test/db-roles.test.ts`](../../backend/test/db-roles.test.ts) runs them on brand-new databases with uniquely named roles and checks every line of the table above (it runs in CI, whose login is a superuser; locally it is skipped unless the test login may create roles).

## Setting up (existing database, e.g. `nurseapp_v04`)

```powershell
# 1. As the superuser — creates the roles (no passwords yet)
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -d nurseapp_v04 -f ops\db\01_roles.sql

# 2. Still as the superuser, set each password at the hidden prompt
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -d nurseapp_v04
#    \password nurseapp_migration
#    \password nurseapp_runtime
#    \password nurseapp_backup
#    \password nurseapp_audit_reader
#    \q

# 3. As the database owner — hands the objects to the migration role and grants the rest
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U aigh -d nurseapp_v04 -f ops\db\02_grants.sql

# 4. As the superuser — confirm; every row must read PASS ("all checks passed", exit code 0)
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -d nurseapp_v04 -v ON_ERROR_STOP=1 -f ops\db\verify.sql
```

Then, in `backend/.env` (step 5), and restart the API and the worker:

```
DATABASE_URL=postgresql://nurseapp_runtime:<runtime password>@localhost:5432/nurseapp_v04
MIGRATION_DATABASE_URL=postgresql://nurseapp_migration:<migration password>@localhost:5432/nurseapp_v04
```

**Production refuses to start until this is done.** With `NODE_ENV=production` the API and the worker check the login they connect as, and stop with `DatabaseRoleError` if it is a superuser, owns the tables, can create objects in `public` or can rewrite `audit_entries` (`backend/src/lib/db-role.ts`). The check is by capability, not by name. After the switch, run `verify.sql` once more: check 11 turns WARN while any API or worker session is still connected as the owner.

Without `MIGRATION_DATABASE_URL`, migrations use `DATABASE_URL` — which, once it is the runtime role, can no longer migrate. Passwords with `@ : / ? # %` must be URL-encoded. Roles are per server; grants are per database — repeat step 3 (and set the URLs) for each database, e.g. `nurseapp_test` if the tests should also run as these roles (they do not need to: the test suite creates its own databases).

## Fresh installation

`01_roles.sql` → passwords → `02_grants.sql` on the empty database (it creates the two extensions) → `prisma migrate deploy` with `MIGRATION_DATABASE_URL` → `02_grants.sql` again → `verify.sql` → bootstrap as the runtime role. [DEPLOYMENT.md §4](../../docs/DEPLOYMENT.md#first-installation-empty-database) lists the full order.

## After every migration

```
npm run db:deploy -w backend        # as nurseapp_migration (MIGRATION_DATABASE_URL)
psql -U <owner> -d <database> -f ops/db/02_grants.sql
psql -U postgres -d <database> -v ON_ERROR_STOP=1 -f ops/db/verify.sql
```

New tables are usable by the runtime at once (default privileges); re-running `02_grants.sql` re-applies the table-specific refusals (audit, journal) to anything a migration recreated.

## Adaptations from the spec (documented, not silently chosen)

| Spec §10.7 says | V04 does | Why |
| :--- | :--- | :--- |
| Migration role gets `GRANT ALL` and "no runtime data access" | Migration role **owns** the objects, so it has data access | PostgreSQL lets only an object's owner `ALTER`/`DROP` it; a grant cannot give that. Mitigation: its credentials live only in the release step, never in the API's environment |
| `nurseapp_owner` provisions | The existing database owner (`aigh` in development) provisions; superuser only for `01_roles.sql` | Same separation, no fifth login |
| No `INSERT` on `employees`; onboarding only through `fn_onboard_employee_with_contract` | **Not applied — decided D-44** | V04 has no such function: onboarding creates the employee and first contract in one application transaction (contract-first, tested). Revoking `INSERT` would break onboarding. The owner decided to keep application onboarding and not build the database function (D-44) |
| `trg_contract_status_guard` | **Not added** | V04 already enforces both: contract status is the `ContractStatus` enum, and `chk_contracts_dates` (end after start) comes from the first migration |
| Audit reader also reads `audit_batches`, `audit_snapshots`, `scfhs_verification_log`, `grace_period_log`, `push_delivery_log` | `audit_entries`, `audit_chain_breaks`, `idempotency_keys`, plus `break_glass_events` and `privileged_sessions` (**D-45**) | The others do not exist in V04. The owner decided the audit reader also reads the two security-event tables, read-only (D-45) |
| — | `DELETE` on `break_glass_events` refused for the runtime | Matches the existing no-delete trigger (R18); `UPDATE` stays because the daily job sets the end time |
| — | `UPDATE` on `request_audit_log` refused for the runtime (D-52) | Matches its no-update trigger; `DELETE` stays for the 365-day retention purge |
| — | `CONNECT` stays open to `PUBLIC` | Not in the spec; revoking it is a possible hardening step |
