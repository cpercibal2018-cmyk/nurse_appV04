# Gate 1 Sandbox — Backup, PITR and Restore Drill

Executable environment for Gate 1 of `AIGH_Phase1_Execution_Plan_U1_Unblock.md`.

This kit exists to replace assertion with evidence: it builds a real PostgreSQL
cluster, encrypts real WAL, takes a real base backup, restores it to a chosen
instant, and emits a signed-off evidence record. Everything below was **executed**,
not just written — including the failures, which are documented in
[Defects found by running this kit](#6-defects-found-by-running-this-kit).

---

## 1. Prerequisites

PostgreSQL 15 client + server binaries. The deployment target is **PostgreSQL 15**
(`PGDG trixie-pgdg`, verified on 15.19):

```bash
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg
echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt trixie-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update && apt-get install -y postgresql-15 postgresql-client-15
```

No Docker or Podman is required or used. This kit runs a plain local cluster so
it can execute on a host where containers are unavailable.

---

## 2. Environment contract

Set these once. `<ROOT>` is the sandbox root (e.g. `/home/user/gate1-drill`).

| Variable | Required | Meaning |
| :--- | :--- | :--- |
| `PGBIN` | yes | Directory holding the PG 15 binaries, e.g. `/usr/lib/postgresql/15/bin` |
| `BACKUP_STORAGE_PATH` | yes | Backup root; `full/` and `wal/` are created beneath it |
| `BACKUP_ENCRYPTION_KEY_PATH` | yes (backup host) | ASCII-armoured **public** key used to encrypt |
| `BACKUP_LOG_FILE` | recommended | Append-only log for backup, archive and restore events |
| `GNUPGHOME` | yes (backup host) | Keyring holding the **public** key only |
| `BACKUP_GPG_HOME` | yes (restore host) | Keyring holding the **private** key |
| `RESTORE_PARENT` | yes (restore) | Restore root; `pgdata/`, `sock/` and a **transient** `unpack/` created beneath it. `unpack/` holds the decrypted archive and is removed by an `EXIT` trap on every path, so it does not outlive the run |
| `RESTORE_PORT` | yes (restore) | Port for the recovery instance — must differ from the source |
| `ALLOW_UNVERIFIED_BACKUP` | no (default unset) | Escape hatch for `restore-database.sh` only: set to `1` to restore a base backup whose `.meta.json` is missing. Without it the script **fails closed**, because on a recovery path "cannot verify" must not silently mean "assume fine". Logged loudly; never script it into a drill |
| `BACKUP_RETENTION_DAYS` | no (default 30) | Age in days after which a base backup is pruned. The **newest** backup is never pruned, whatever this is set to: a misconfigured `0`, or a job broken for longer than the threshold, must not be able to delete the last restorable backup. A sidecar is only ever removed together with the archive it describes |
| `WAL_RETENTION_ENABLED` | no (default 1) | Set to `0` to skip WAL pruning entirely. Pruning is **base-backup-aware**: it removes archived segments strictly before the `wal_start_segment` of the *oldest retained* base backup, and nothing else. If that floor is unknown it prunes nothing and says so — it never guesses |
| `WAL_PRUNE_DRY_RUN` | no (default 0) | Set to `1` to log exactly which segments pruning would remove, and remove none |
| `GATE1_LOCK_FILE` | no (default `${BACKUP_STORAGE_PATH}/.gate1.lock`) | `flock(1)` file shared by `nightly-backup.sh`, `restore-database.sh` and `rebuild.sh --clean` (which wipes the directory this file lives in, sparing the file itself), so a backup cannot prune the archive out from under a restore that is already replaying it. A run that cannot get the lock is **refused** (exit 1), not queued. If `flock(1)` is absent both warn and proceed unlocked — no backup is worse than an unlocked one |
| `RTO_MINUTES` | no (default 240) | RTO budget asserted by the drill |
| `EVIDENCE_FILE` | no (default `gate1-evidence.md`) | Where the evidence record is written |
| `EXPECTED_EMPLOYEES` | no | Source row count to compare against after restore |
| `EXPECTED_AUDIT` | no | Source audit row count as of the recovery target |
| `SOURCE_SOCK`, `SOURCE_PORT`, `DB_NAME` | yes (PITR driver) | Source cluster connection |

`GNUPGHOME` and `BACKUP_GPG_HOME` are deliberately **different keyrings**. That
separation is the point: the backup host can encrypt but cannot decrypt.

---

## 3. Run order

```bash
export PGBIN=/usr/lib/postgresql/15/bin
export ROOT=/home/user/gate1-drill
export DB_NAME=nurseapp SOURCE_SOCK=$ROOT/sock SOURCE_PORT=5515
export RESTORE_PARENT=/home/user/gate1-restore RESTORE_PORT=5516
export BACKUP_STORAGE_PATH=$ROOT/backup BACKUP_LOG_FILE=$ROOT/backup.log
export BACKUP_ENCRYPTION_KEY_PATH=$ROOT/backup.pub
export GNUPGHOME=$ROOT/gpg-backup BACKUP_GPG_HOME=$ROOT/gpg-restore
export EVIDENCE_FILE=$ROOT/gate1-evidence.md RTO_MINUTES=240
mkdir -p $RESTORE_PARENT

# 1. Two keyrings: public on the backup host, private on the restore host
bash scripts/setup-gpg.sh "$ROOT"

# 2. Cluster with wal_level=replica, archive_mode=on, archive_timeout=300
#    + schema + synthetic workforce data
bash scripts/setup-cluster.sh

# 3. Base backup, encrypted and checksummed
bash scripts/nightly-backup.sh

# 4. Exercise WAL archiving
$PGBIN/psql -h $SOURCE_SOCK -p $SOURCE_PORT -U postgres -d $DB_NAME -tAc "SELECT pg_switch_wal()"

# 5. Restore + PITR proof + evidence record
bash scripts/pitr-proof.sh
```

`pitr-proof.sh` writes `gate1-evidence.md` and exits non-zero on any failed
assertion, so it is usable as a gate in CI or a change-approval run.

### The short path

`scripts/restore-drill.sh` on its own will restore and verify, choosing a
recovery target of "30 seconds ago". It is the timing/verification harness.

`scripts/pitr-proof.sh` wraps it and is the **recommended** entry point, because
it is the only one that can actually *prove* the time cut — see below.

---

## 4. Why `pitr-proof.sh` exists

A restore drill that only checks "the database came back" proves very little. In
particular, a default "recover to 30 seconds ago" drill has a blind spot: if
nothing is written during those 30 seconds, then "no rows after the target" is
vacuously true, and the drill would pass identically on a system that ignored the
target time completely.

The driver removes that blind spot by:

1. writing **pre-target** marker rows (must be **present** after restore);
2. forcing a WAL switch and waiting for the archive to advance;
3. capturing `T0` from the **database clock**;
4. writing **post-target** marker rows (must be **absent** after restore);
5. forcing a second WAL switch, so the post-target WAL is archived *too* — the
   absence of those rows therefore proves a genuine time-based cut, not an
   accident of a missing segment;
6. restoring to `T0` and asserting independently against the restored instance.

`restore-drill.sh` accepts a caller-supplied `TARGET_TIME` for exactly this
reason; without it the driver could not place markers on both sides of the cut.

---

## 5. Latest verified result

Cold-start run `bash scripts/rebuild.sh --clean`, 2026-09-18, PostgreSQL 15.19 —
no cluster, no keyrings, no backups present at the start; **9 seconds to a full
evidence record**. Authoritative record: `gate1-drill/gate1-evidence.md` in the V03 repository (archived evidence, commit de82bfb).

| Assertion | Observed | Expected | Result |
| :--- | :--- | :--- | :--- |
| Employees restored | 120 | 120 | PASS |
| Audit entries at target | 245 | 245 | PASS |
| Audit entries at present (source) | — | 248 | excluded by design |
| Pre-target marker rows present | 5 | 5 | PASS |
| **Post-target marker rows absent** | **0** | **0** | **PASS** |
| Broken audit chain links | 0 | 0 | PASS |
| Nursing units / total beds | 47 / 582 | 47 / 582 | PASS |
| Rows after recovery target | 0 | 0 | PASS |
| Elapsed (total drill) | 3 s | ≤ 240 min | PASS |
| WAL archive failures during run | 0 | 0 | PASS |

Recovery landed on `2026-09-18 10:37:55.313013+00`, i.e. **1.57 seconds before**
the recovery target of `10:37:56.887+00`, with zero rows beyond it. WAL archive
`failed_count` was **0** throughout — a clean cluster with the fixed
`archive_command` never fails a switch.

> **Caveat on the timing figure.** 3 seconds is a small-cluster figure: 47 units,
> 582 beds, 120 employees, 480 credentials. PostgreSQL restore time is dominated
> by data volume and fsync throughput, so this does **not** demonstrate the
> production RTO. It demonstrates that the *procedure* completes correctly and
> that the RTO harness measures the right thing. Re-run against a
> production-sized copy before signing Gate 1 on RTO grounds.

---

## 6. Defects found by running this kit

Every one of these was invisible on paper and only surfaced on execution.

| # | Defect | Impact | Fix |
| :--- | :--- | :--- | :--- |
| 1 | `gpg --list-packets` exits non-zero without the private key; `set -o pipefail` propagated that | Every correctly-encrypted file was rejected — **WAL archiving failed outright** (`failed_count=12`, empty archive) | Capture packets with `\|\| true`, then grep the packet list |
| 2 | Assumed `pg_switch_wal()` returns a WAL segment name | It returns an **LSN** (`0/D000078`), so waiting on it would spin and time out | Wait for `last_archived_wal` to *advance*, and for `failed_count` to stay flat |
| 3 | Waiting on absolute `failed_count = 0` | `failed_count` is cumulative for the life of the cluster and never resets, so any cluster that ever failed once could never pass | Compare against the pre-switch value |
| 4 | Recovery-instance readiness probe omitted `-U postgres` | Connected as the OS user, failed 120× at 2 s, then reported a **false** "recovery did not reach the target time" after burning 4 minutes | Added `-U postgres` |
| 5 | Drill target inherited `archive_mode=on` | On promotion the restore instance tried to archive its own timeline-2 history file back into the archive it was recovering from | Start the recovery instance with `-c archive_mode=off` |
| 6 | `set -u` + caller-supplied `TARGET_TIME` | Impossible to test the past-target cut (the script always overwrote the target) | Honour a caller-supplied `TARGET_TIME`, else default to 30 s ago |
| 7 | **`archive_command` depended on environment variables inherited from whoever started postgres** | After a restart from a shell without `GNUPGHOME` / `BACKUP_ENCRYPTION_KEY_PATH` — a crash restart, a reboot into a maintenance shell, a service unit missing an `EnvironmentFile` — **every archive attempt failed while the database still reported itself healthy**. `failed_count` climbed to 9, the archive froze, and the RPO guarantee became unbounded with no alert. Nobody would find out until the day a restore was needed | Bake every path into the `archive_command` itself so it is self-sufficient; fail-fast archiving preflight in the drill |
| 8 | **`recovery_target_time` only stops at a commit record at or after the target** | Recovering to a *quiet* moment — where no later commit exists — replays forward forever and never reaches the target. Observed twice: the restore hung for the full 240 s timeout and reported a false failure. In production this turns a PITR to a quiet point into an outage | Anchor the target with a *terminator* commit a few seconds later, and assert the marker is present **and** the terminator absent. Also a runbook warning: a PITR target must be followed by known activity |
| 9 | A restore instance from a previous run was not stopped before its data directory was deleted | The old postmaster logged `data directory lock file is invalid` and died messily, leaving the port possibly bound and breaking the *next* restore for reasons that look unrelated | Stop any instance found in the restore directory before wiping it |
| 10 | `SHOW archive_timeout` returns `5min`, not an integer | Every numeric comparison against the bound failed with `integer expression expected` | Read `pg_settings` and convert the unit |
| 11 | A stalled archiver surfaced only as a 420 s mystery timeout | Slow, confusing diagnosis | Fail-fast preflight: force one switch, wait 60 s, print `last_archived_wal` / `last_failed_wal` / `failed_count` on failure |
| 12 | **`archive_command` / `restore_command` pointed at `${PWD}/scripts/…` and executed the script directly** | Two independent failures on the same generated line. (a) `${PWD}` is expanded by *setup-cluster.sh*, not by postgres, so what got baked into `postgresql.conf` was whatever directory the operator happened to be standing in — `rebuild.sh` had to `cd` to the kit root merely to make archiving work at all. (b) PostgreSQL runs both commands through `/bin/sh`, which requires the executable bit; the scripts were committed `100644`, so from a fresh `git clone` **every** archive and every replay attempt failed with `Permission denied` (reproduced: `sh -c` on a 644 copy → exit 126) while postgres still reported itself healthy — defect 7's silent-RPO-loss failure mode, reintroduced by a different route, and invisible to every drill that ran from a working copy which still had the bit | Derive `SCRIPTS_DIR` from `BASH_SOURCE` exactly as `failure-drill.sh` / `rebuild.sh` already did for `KIT_DIR`; invoke through `bash "…"` so the executable bit becomes irrelevant to recovery; commit the scripts `100755` |

Defect 4 is the instructive one: the pipeline was working the entire time. The
drill reported failure because the **harness** was broken, not the backup. That
is the argument for measuring independently rather than trusting a single
self-reported exit code.

---

## 7. File map

| Path | Role |
| :--- | :--- |
| `sql/10_audit_chain.sql` | Canonical audit schema, serialized append function, chain-break view |
| `sql/20_org_structure.sql` | Nursing units / bed capacity (runtime configuration) |
| `sql/30_synthetic_workforce.sql` | Synthetic employees, contracts, credentials |
| `scripts/setup-gpg.sh` | Creates the two separated keyrings |
| `scripts/setup-cluster.sh` | `initdb`, cluster config, schema and data load |
| `scripts/wal-archive.sh` | `archive_command` — encrypt then store; refuses to archive an unencrypted file |
| `scripts/wal-restore.sh` | `restore_command` — decrypt; returns non-zero **without** creating `%p` when a segment is missing |
| `scripts/nightly-backup.sh` | Encrypted base backup + metadata sidecar; envelope-checked, then the recorded SHA-256 is **read back off storage** before the plaintext is deleted. Also records the backup's own WAL start segment (from `backup_label`, while the plaintext still exists), prunes expired backups **without ever removing the newest**, and prunes `wal/` back to the oldest retained backup's floor. Holds `GATE1_LOCK_FILE` |
| `scripts/restore-database.sh` | Verify the recorded SHA-256, *then* decrypt, unpack, configure recovery, promote; removes the decrypted `unpack/` on every exit path. Takes `GATE1_LOCK_FILE` first, so a backup cannot prune the archive out from under a restore in progress — and a **refused** run is a no-op: it disarms that cleanup trap before exiting, so it cannot delete the `unpack/` of the run that holds the lock |
| `scripts/restore-drill.sh` | Timed restore + verification + evidence record |
| `scripts/pitr-proof.sh` | Provable PITR driver (recommended entry point) |
| `scripts/rebuild.sh` | One-command cold rebuild. `--clean` wipes the regenerable state — including the contents of `${BACKUP_STORAGE_PATH}`, where `GATE1_LOCK_FILE` lives — so the wipe takes that lock for its own duration, is refused if held, **never unlinks the lock file itself** (spared by inode, not by name), and releases the lock before the sub-scripts run |
| `scripts/failure-drill.sh` | Crash durability + measured RPO (`--crash`, `--rpo`, `--all`) |
| `sql/40_tx_probe.sql` | Probe table for client-confirmed transactions |

---

## 8. Footprint and persistence

The two cluster data directories are ~290 MB, almost entirely preallocated 16 MB
WAL segments. They are **regenerable by design** and are not worth carrying
between sessions, so this kit ships without them: the retained state is the
scripts, the encrypted backup set (~6 MB), the keyrings and the evidence record
— about 8 MB in total — and `scripts/rebuild.sh --clean` recreates the rest in
seconds. Keeping it small also avoids silently losing files to a workspace
snapshot size limit, which is a real hazard at 300 MB.

`wal/` used to be the exception to "regenerable by design": nothing ever pruned it, so
it grew for as long as the cluster ran — with `archive_timeout=300`, up to ~4.6 GB/day
of timeout-forced segments alone, with no ceiling. A full archive volume makes
`archive_command` fail, PostgreSQL then retains WAL in `pg_wal` on the primary, *that*
fills, and the primary stops accepting writes. `nightly-backup.sh` step 7 now bounds it:
segments strictly before the oldest retained backup's `wal_start_segment` are removed,
segments from it forward are kept, and `*.history`, `*.backup` and any in-flight
`*.gpg.tmp.<pid>` are never touched. `GATE1_LOCK_FILE` is a zero-byte file created
beside `full/` and `wal/`.

After a run, free the bulk with:

```bash
$PGBIN/pg_ctl -D $ROOT/pgdata stop -m fast
$PGBIN/pg_ctl -D $RESTORE_PARENT/pgdata stop -m fast
rm -rf $ROOT/pgdata $ROOT/sock $RESTORE_PARENT
```

---

## 9. Failure injection

The restore drill proves *we can go back in time*. `failure-drill.sh` proves the
two things a restore drill structurally cannot:

```bash
bash scripts/failure-drill.sh --all     # needs a live cluster; takes ~5 minutes
```

**Phase 1 — durability and atomicity under SIGKILL.** The postmaster is killed
with `SIGKILL`: no checkpoint, no clean shutdown, the shape of a real power loss.
It asserts that every transaction the client was told had `COMMIT`ted is still
present, that a transaction which had *not* committed is rolled back in full,
that the audit hash chain is still unbroken, and that crash recovery genuinely
ran — rather than the test quietly passing because the shutdown was clean.

**Phase 2 — measured RPO.** A marker is committed, and we wait for the WAL
segment containing it to reach the encrypted archive. **No WAL switches are
forced**: forcing one would close the segment immediately and measure the switch
instead of the `archive_timeout` bound that the RPO claim actually rests on.
Recoverability is then confirmed by performing a real restore to the marker's
commit time — not by asserting that a file merely exists on disk.

Measured 2026-09-18 on PostgreSQL 15.19, with `GNUPGHOME` and
`BACKUP_ENCRYPTION_KEY_PATH` deliberately **unset** in the invoking shell (the
condition that used to break archiving):

| Check | Value | Expected | Result |
| :--- | :--- | :--- | :--- |
| Transactions confirmed COMMIT | 100 | — | — |
| Committed rows present after SIGKILL | 100 | 100 | PASS |
| Uncommitted rows rolled back | 0 | 0 | PASS |
| Audit chain breaks after crash | 0 | 0 | PASS |
| Crash recovery triggered | 1 message | ≥ 1 | PASS |
| Time commit → encrypted archive | **298 s** | ≤ 300 s | PASS |
| Marker recoverable by restore | 1 | 1 | PASS |
| Terminator after target absent | 0 | 0 | PASS |

> **RPO is a property of `archive_timeout`, not of the backup script.** With
> `archive_timeout = 300`, a commit landing just after a segment switch is not
> recoverable for up to five minutes. That is the real bound, and 298 s is what
> it looks like in practice. Shortening the RPO means shortening
> `archive_timeout` — at the cost of more, smaller segments.

---

## 10. Re-verification

```bash
cd /home/user && python3 verify_integration.py           # expect 38/38 integrated
cd /home/user/wave1a-kit && node scripts/verify-kit.mjs .  # Wave 1A kit checks
cd ops/backup && bash scripts/pitr-proof.sh          # expect "PITR PROOF PASSED"
cd ops/backup && bash scripts/failure-drill.sh --all  # expect "Failure drill PASS"
```

The drill is idempotent: it clears marker rows from previous runs, and
`restore-database.sh` drops and rebuilds the restore cluster each time — but only
*after* the backup's recorded SHA-256 has verified against the object in storage, so a
corrupt or truncated backup costs one failed attempt rather than the previous restore
tree. The source cluster is never modified except for the explicitly-labelled marker rows.

A run is also **exclusive**: `nightly-backup.sh` and `restore-database.sh` take
`GATE1_LOCK_FILE` and refuse (exit 1) rather than queue if another kit run holds it, so
a backup cannot apply retention and prune `wal/` while a restore is replaying from it.
`rebuild.sh --clean` takes the same lock for the duration of its wipe, because that wipe
deletes the directory the lock file lives in — and deleting a lock file does not release
it, so an unlocked wipe would leave the holder holding a stale inode while the next run
locked a fresh file, with exclusion silently gone. For the same reason the wipe deletes the
*contents* of the backup tree and **spares the lock file**: a holder that unlinks its own
lock re-opens that hole from inside the critical section, because every later run then
creates and acquires a brand-new inode at the same path. The lock file is identified **by
inode** (`find -samefile`), not by name — `-path` and `-name` are *glob* patterns, so a
storage path containing `[`, `]`, `*` or `?` would silently stop matching it. And since
`-samefile` errors out when its argument is missing, which is exactly the state when
`flock(1)` is absent and nothing ever created the lock file, that match is guarded on the
file existing so the fail-open path still wipes the whole tree. A **refused** run is always a no-op:
`restore-database.sh` disarms its `unpack/` cleanup trap before refusing, since leaving it
armed would delete the working directory of the run that holds the lock.
Each backup run prunes `wal/` back to the oldest *retained* backup's WAL start segment,
which means the archive is bounded by `BACKUP_RETENTION_DAYS` rather than growing for as
long as the cluster runs. To see what a given run would prune without pruning it, set
`WAL_PRUNE_DRY_RUN=1` and read the log.

---

## 8. Automated Scheduling (systemd timer / cron)

To run `nightly-backup.sh` automatically every night at 02:00 (Asia/Riyadh time),
systemd unit files are provided in `ops/backup/systemd/`:

```bash
# Install and enable the systemd timer:
sudo cp ops/backup/systemd/aigh-backup.service /etc/systemd/system/
sudo cp ops/backup/systemd/aigh-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aigh-backup.timer

# Verify the schedule:
systemctl list-timers aigh-backup.timer
```

For environments using traditional cron, see `ops/backup/systemd/crontab.example`.
