#!/bin/bash
# ops/backup/scripts/failure-drill.sh [--crash] [--rpo] [--all]
#
# Failure injection for Gate 1. The restore drill proves "we can go back in
# time"; this proves the two things a restore drill cannot:
#
#   --crash  Durability and atomicity under an unclean kill.
#            The server is SIGKILLed (real power-loss shape: no checkpoint, no
#            clean shutdown) and we assert:
#              * every transaction that returned COMMIT is still present
#              * a transaction that had NOT committed is rolled back in full
#              * the audit hash chain is still unbroken
#              * crash recovery actually ran (not a clean shutdown in disguise)
#
#   --rpo    Recovery Point Objective, measured black-box rather than asserted.
#            A marker is committed, we wait for the WAL segment containing it to
#            appear in the ENCRYPTED archive (no forced switches -- those would
#            cheat the measurement), then we actually restore to that commit's
#            timestamp and confirm the marker is there. The elapsed time is the
#            real RPO, compared against archive_timeout.
#
# All probe rows are scoped by a per-run tag, and NOTHING is ever deleted from
# audit_entries: removing rows from the middle of a hash chain breaks the chain,
# which is precisely what this drill is supposed to be checking.
#
# Output: gate1-failure-evidence.md + a summary on stdout. Non-zero on failure.

set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${KIT_DIR}"

ROOT="${ROOT:-/home/user/gate1-drill}"
RESTORE_PARENT="${RESTORE_PARENT:-/home/user/gate1-restore}"
SOURCE_PORT="${SOURCE_PORT:-5515}"
RESTORE_PORT="${RESTORE_PORT:-5516}"
DB_NAME="${DB_NAME:-nurseapp}"
PGBIN="${PGBIN:-/usr/lib/postgresql/15/bin}"
SOURCE_SOCK="${SOURCE_SOCK:-${ROOT}/sock}"
PGDATA="${ROOT}/pgdata"
BACKUP_STORAGE_PATH="${BACKUP_STORAGE_PATH:-${ROOT}/backup}"
BACKUP_GPG_HOME="${BACKUP_GPG_HOME:-${ROOT}/gpg-restore}"
EVIDENCE="${EVIDENCE_FAILURE_FILE:-${ROOT}/gate1-failure-evidence.md}"

TXNS="${TXNS:-100}"
RPO_MAX_WAIT="${RPO_MAX_WAIT:-420}"   # seconds to wait for the archive

DO_CRASH=0; DO_RPO=0
case "${1:---all}" in
  --crash) DO_CRASH=1 ;;
  --rpo)   DO_RPO=1 ;;
  --all|"") DO_CRASH=1; DO_RPO=1 ;;
  *) echo "usage: failure-drill.sh [--crash|--rpo|--all]" >&2; exit 2 ;;
esac

q() { "${PGBIN}/psql" -U postgres -h "${SOURCE_SOCK}" -p "${SOURCE_PORT}" -d "${DB_NAME}" -tAc "$1"; }
qq() { # quiet, never fails the script
  "${PGBIN}/psql" -U postgres -h "${SOURCE_SOCK}" -p "${SOURCE_PORT}" -d "${DB_NAME}" -tAc "$1" 2>/dev/null || echo ""
}

# ── Preconditions ───────────────────────────────────────────────────────────
if [ ! -f "${PGDATA}/postmaster.pid" ]; then
  echo "ERROR: no running source cluster at ${PGDATA}." >&2
  echo "       Start one first:  bash scripts/rebuild.sh --clean" >&2
  exit 1
fi
"${PGBIN}/psql" -U postgres -h "${SOURCE_SOCK}" -p "${SOURCE_PORT}" -d "${DB_NAME}" -q -f sql/40_tx_probe.sql

RUN_TAG="run-$(date -u +%Y%m%d%H%M%S)"
fsync_on=$(q "SHOW fsync")
fpw_on=$(q "SHOW full_page_writes")
sync_commit=$(q "SHOW synchronous_commit")
archive_timeout=$(q "SELECT (setting::int * CASE unit WHEN 'min' THEN 60 WHEN 'h' THEN 3600 WHEN 'd' THEN 86400 ELSE 1 END) FROM pg_settings WHERE name='archive_timeout'")

echo "=== Gate 1 failure-injection drill ==="
echo "run tag: ${RUN_TAG}"
echo "fsync=${fsync_on}  full_page_writes=${fpw_on}  synchronous_commit=${sync_commit}  archive_timeout=${archive_timeout}"
echo

crash_status="SKIPPED"; rpo_status="SKIPPED"
crash_reasons=(); rpo_reasons=()
crash_cells=""; rpo_cells=""
committed=0; survived=0; uncommitted=0; breaks=0; survived_audit=0
recovery_line=0; audit_before=0
rpo_seconds=""; target=""; found=""; found_term=""

# ════════════════════════════════════════════════════════════════════════════
# PHASE 1 — CRASH DURABILITY AND ATOMICITY
# ════════════════════════════════════════════════════════════════════════════
if [ "${DO_CRASH}" = "1" ]; then
  echo "── phase 1: unclean kill ──"
  audit_before=$(q "SELECT count(*) FROM audit_entries")

  # 1a. Committed work. Each transaction writes one probe row AND one audit
  #     entry, so the hash chain is exercised by the crash too. psql exits 0
  #     only if every transaction COMMITted, so "confirmed" is unambiguous.
  SQLFILE="$(mktemp)"
  for i in $(seq 1 "${TXNS}"); do
    printf 'BEGIN;\n'
    printf "INSERT INTO tx_probe(payload, note) VALUES ('tx-%04d', '%s');\n" "$i" "${RUN_TAG}"
    printf "DO \$\$ BEGIN PERFORM fn_append_audit_entry(1,'probe.tx','tx_probe','%s-%04d','{\"durability\":true}'::jsonb); END \$\$;\n" "${RUN_TAG}" "$i"
    printf 'COMMIT;\n'
  done > "${SQLFILE}"
  "${PGBIN}/psql" -U postgres -h "${SOURCE_SOCK}" -p "${SOURCE_PORT}" -d "${DB_NAME}" \
    -q -v ON_ERROR_STOP=1 -f "${SQLFILE}"
  committed=$(q "SELECT count(*) FROM tx_probe WHERE note='${RUN_TAG}'")
  audit_after=$(q "SELECT count(*) FROM audit_entries")
  echo "  1a. ${committed} transactions confirmed COMMIT by the client"
  echo "      audit entries appended: ${audit_before} -> ${audit_after}"
  rm -f "${SQLFILE}"

  # 1b. An open transaction that must NOT survive. It writes a row and then
  #     parks in pg_sleep, so at kill time the row exists in shared buffers and
  #     in WAL, but the transaction has not committed.
  HOLDFILE="$(mktemp)"
  cat > "${HOLDFILE}" <<SQL
BEGIN;
INSERT INTO tx_probe(payload, note) VALUES ('UNCOMMITTED-must-not-survive', 'atomicity-${RUN_TAG}');
SELECT pg_sleep(600);
COMMIT;
SQL
  "${PGBIN}/psql" -U postgres -h "${SOURCE_SOCK}" -p "${SOURCE_PORT}" -d "${DB_NAME}" \
    -v ON_ERROR_STOP=1 -f "${HOLDFILE}" >/dev/null 2>&1 &
  hold_pid=$!
  waited=0
  while [ "${waited}" -lt 30 ]; do
    parked=$(qq "SELECT count(*) FROM pg_stat_activity WHERE state='active' AND query LIKE '%pg_sleep%'")
    [ "${parked:-0}" -ge 1 ] 2>/dev/null && break
    waited=$((waited + 1)); sleep 0.5
  done
  echo "  1b. uncommitted transaction open (session parked in pg_sleep)"

  # 1c. Pull the plug. SIGKILL the postmaster: no checkpoint, no clean shutdown.
  pm_pid="$(head -1 "${PGDATA}/postmaster.pid")"
  kill -9 "${pm_pid}"
  waited=0
  while kill -0 "${pm_pid}" 2>/dev/null && [ "${waited}" -lt 20 ]; do sleep 0.5; waited=$((waited+1)); done
  wait "${hold_pid}" 2>/dev/null || true
  rm -f "${HOLDFILE}"
  # The process is confirmed dead; clear its stale pid file so pg_ctl starts
  # cleanly instead of warning that another server might be running.
  if ! kill -0 "${pm_pid}" 2>/dev/null; then rm -f "${PGDATA}/postmaster.pid"; fi
  echo "  1c. SIGKILLed postmaster pid ${pm_pid} (no checkpoint, no clean shutdown)"

  # 1d. Restart. This must trigger automatic crash recovery.
  "${PGBIN}/pg_ctl" -D "${PGDATA}" -l "${ROOT}/postgres.log" start -w -t 120 >/dev/null
  recovery_line=$(grep -c "automatic recovery in progress" "${ROOT}/postgres.log" || true)
  : "${recovery_line:=0}"
  echo "  1d. restarted; crash-recovery messages in log: ${recovery_line}"

  # 1e. Assertions
  survived=$(q "SELECT count(*) FROM tx_probe WHERE note='${RUN_TAG}'")
  survived_audit=$(q "SELECT count(*) FROM audit_entries WHERE resource_id LIKE '${RUN_TAG}-%'")
  uncommitted=$(q "SELECT count(*) FROM tx_probe WHERE note='atomicity-${RUN_TAG}'")
  breaks=$(q "SELECT count(*) FROM audit_chain_breaks WHERE previous_hash IS DISTINCT FROM expected_previous AND previous_hash IS NOT NULL")

  c_ok=1
  [ "${survived}" = "${committed}" ]  || { c_ok=0; crash_reasons+=("durability: ${survived} rows survived, ${committed} were confirmed committed"); }
  [ "${survived}" != "0" ]            || { c_ok=0; crash_reasons+=("nothing survived: the drill did not commit anything before the kill"); }
  [ "${uncommitted}" = "0" ]          || { c_ok=0; crash_reasons+=("atomicity: ${uncommitted} uncommitted row(s) survived the crash"); }
  [ "${breaks}" = "0" ]               || { c_ok=0; crash_reasons+=("audit chain has ${breaks} broken link(s) after crash recovery"); }
  [ "${recovery_line}" -ge 1 ]        || { c_ok=0; crash_reasons+=("no crash-recovery message in the log; the kill did not test what it claims to"); }
  [ "${fsync_on}" = "on" ]            || { c_ok=0; crash_reasons+=("fsync is '${fsync_on}'; durability claims are not meaningful"); }
  crash_status=$([ "${c_ok}" = "1" ] && echo PASS || echo FAIL)

  echo "  1e. survived=${survived}/${committed}  uncommitted_survived=${uncommitted}  chain_breaks=${breaks}"
  echo "  --> phase 1 ${crash_status}"

  crash_cells="| Transactions confirmed COMMIT | ${committed} | — | — |
| Committed rows present after SIGKILL | ${survived} | ${committed} | $([ "${survived}" = "${committed}" ] && echo PASS || echo FAIL) |
| Uncommitted rows rolled back | ${uncommitted} | 0 | $([ "${uncommitted}" = "0" ] && echo PASS || echo FAIL) |
| Audit entries for committed work | ${survived_audit} | ${committed} | $([ "${survived_audit}" = "${committed}" ] && echo PASS || echo FAIL) |
| Audit chain breaks after crash | ${breaks} | 0 | $([ "${breaks}" = "0" ] && echo PASS || echo FAIL) |
| Crash recovery triggered | ${recovery_line} message(s) | ≥ 1 | $([ "${recovery_line}" -ge 1 ] && echo PASS || echo FAIL) |
| fsync | ${fsync_on} | on | $([ "${fsync_on}" = "on" ] && echo PASS || echo FAIL) |
| full_page_writes | ${fpw_on} | on | $([ "${fpw_on}" = "on" ] && echo PASS || echo FAIL) |"
  echo
fi

# ════════════════════════════════════════════════════════════════════════════
# PHASE 2 — MEASURED RPO
# ════════════════════════════════════════════════════════════════════════════
if [ "${DO_RPO}" = "1" ]; then
  echo "── phase 2: measured RPO (no forced WAL switches) ──"

  # Preflight: confirm archiving is actually live BEFORE measuring it. Without
  # this, a stalled archiver shows up only as a timeout minutes later, with no
  # indication of why. A forced switch here does not corrupt the measurement
  # that follows, because the measurement starts at a fresh marker commit.
  pre_before=$(q "SELECT coalesce(last_archived_wal,'') FROM pg_stat_archiver")
  q "SELECT pg_switch_wal()" >/dev/null
  pre_ok=0; pre_waited=0
  while [ "${pre_waited}" -lt 60 ]; do
    pre_now=$(q "SELECT coalesce(last_archived_wal,'') FROM pg_stat_archiver")
    [ "${pre_now}" != "${pre_before}" ] && { pre_ok=1; break; }
    sleep 1; pre_waited=$((pre_waited + 1))
  done
  if [ "${pre_ok}" != "1" ]; then
    pre_fail=$(q "SELECT coalesce(last_failed_wal,'none') FROM pg_stat_archiver")
    pre_failed_count=$(q "SELECT failed_count FROM pg_stat_archiver")
    echo "  PREFLIGHT FAIL: WAL archiving is not working."
    echo "    last_archived_wal = ${pre_before:-<none>} (not advancing)"
    echo "    last_failed_wal   = ${pre_fail}"
    echo "    failed_count      = ${pre_failed_count}"
    echo "    Check postgres.log for 'archive command failed'. A common cause is an"
    echo "    archive_command that depends on environment variables the postmaster"
    echo "    did not inherit at startup."
    rpo_status="FAIL"
    rpo_reasons+=("archiving preflight failed: last_archived_wal stuck at '${pre_before:-none}', last_failed_wal='${pre_fail}'")
    rpo_seconds=0; target=""; found=""; found_term=""
    echo "  --> phase 2 FAIL (preflight)"
    echo
  else
  echo "  preflight OK: archiving advanced ${pre_before:-<none>} -> ${pre_now}"

  # 2a. Commit a marker and pin its exact WAL position and commit time.
  marker="rpo-marker-${RUN_TAG}"
  q "INSERT INTO tx_probe(payload, note) VALUES ('${marker}','rpo-${RUN_TAG}')" >/dev/null
  committed_at="$(q "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.MS') || '+00'")"

  # TERMINATOR COMMIT -- this matters more than it looks.
  # recovery_target_time stops at the first commit record whose timestamp is at
  # or after the target. If the marker is the LAST commit before an idle period,
  # there is no such record, so recovery replays forward forever and never
  # reaches the target: a point-in-time recovery to a quiet moment hangs until
  # it times out. A real system is never idle for long, but a maintenance window
  # can be. Committing a terminator a couple of seconds later gives recovery a
  # record to stop on, and lets us assert the marker is present AND the
  # terminator is absent -- the same two-sided proof the restore drill uses.
  sleep 2
  terminator="${marker}-terminator"
  q "INSERT INTO tx_probe(payload, note) VALUES ('${terminator}','rpo-term-${RUN_TAG}')" >/dev/null
  lsn_insert="$(q "SELECT pg_current_wal_insert_lsn()")"
  sleep 0.3
  lsn_now="$(q "SELECT pg_current_wal_lsn()")"
  seg_now="$(q "SELECT pg_walfile_name('${lsn_now}'::pg_lsn)")"
  echo "  2a. marker '${marker}' committed at ${committed_at}"
  echo "      WAL segment that must reach the archive: ${seg_now}"

  # 2b. Wait for the segment to appear in the ENCRYPTED archive. No
  #     pg_switch_wal() here: forcing a switch would measure the switch, not the
  #     archive_timeout bound the RPO claim actually rests on.
  t0=$(date +%s)
  archived_at=""
  waited=0
  while [ "${waited}" -lt "${RPO_MAX_WAIT}" ]; do
    if [ -f "${BACKUP_STORAGE_PATH}/wal/${seg_now}.gpg" ]; then
      archived_at=$(date +%s); break
    fi
    sleep 1; waited=$((waited + 1))
  done

  r_ok=1
  if [ -z "${archived_at}" ]; then
    r_ok=0
    rpo_seconds=$((RPO_MAX_WAIT + 1))
    rpo_reasons+=("WAL segment ${seg_now} did not reach the encrypted archive within ${RPO_MAX_WAIT}s")
    echo "  2b. segment never reached the archive within ${RPO_MAX_WAIT}s"
  else
    rpo_seconds=$((archived_at - t0))
    echo "  2b. segment archived after ${rpo_seconds}s (${seg_now}.gpg)"

    # 2c. Prove recoverability, not just file presence: restore to the commit
    #     time and confirm the marker is actually in the restored database.
    target="$(date -u -d "${committed_at} + 1 second" '+%Y-%m-%d %H:%M:%S+00')"
    echo "  2c. restoring to ${target} to confirm the marker is recoverable"
    if bash scripts/restore-database.sh "${target}" >/dev/null 2>&1; then
      found=$("${PGBIN}/psql" -U postgres -h "${RESTORE_PARENT}/sock" -p "${RESTORE_PORT}" \
        -d "${DB_NAME}" -tAc "SELECT count(*) FROM tx_probe WHERE payload='${marker}'" 2>/dev/null || echo "query-failed")
      found_term=$("${PGBIN}/psql" -U postgres -h "${RESTORE_PARENT}/sock" -p "${RESTORE_PORT}" \
        -d "${DB_NAME}" -tAc "SELECT count(*) FROM tx_probe WHERE payload='${terminator}'" 2>/dev/null || echo "query-failed")
    else
      found="restore-failed"; found_term="restore-failed"
    fi
    echo "  2d. marker present in restored database: ${found}   terminator (must be absent): ${found_term}"
    [ "${found}" = "1" ]      || { r_ok=0; rpo_reasons+=("marker not recoverable: restore to ${target} returned '${found}'"); }
    [ "${found_term}" = "0" ]  || { r_ok=0; rpo_reasons+=("post-target terminator row WAS recovered (${found_term}); recovery did not stop at the target"); }
  fi

  [ "${rpo_seconds}" -le "${archive_timeout}" ] || { r_ok=0; rpo_reasons+=("observed RPO ${rpo_seconds}s exceeds archive_timeout ${archive_timeout}s"); }
  rpo_status=$([ "${r_ok}" = "1" ] && echo PASS || echo FAIL)
  echo "  --> phase 2 ${rpo_status}"
  echo

  rpo_cells="| Marker committed at | ${committed_at} | — | — |
| WAL segment | ${seg_now} | — | — |
| Time commit → encrypted archive | ${rpo_seconds}s | ≤ ${archive_timeout}s | $([ "${rpo_seconds}" -le "${archive_timeout}" ] && echo PASS || echo FAIL) |
| Restore target used | ${target:-not attempted} | — | — |
| Marker recoverable by restore | ${found:-not attempted} | 1 | $([ "${found:-x}" = "1" ] && echo PASS || echo FAIL) |
| Terminator after target absent | ${found_term:-not attempted} | 0 | $([ "${found_term:-x}" = "0" ] && echo PASS || echo FAIL) |
| archive_timeout (the enforceable bound) | ${archive_timeout}s | — | — |"
  fi
fi

# ════════════════════════════════════════════════════════════════════════════
# EVIDENCE
# ════════════════════════════════════════════════════════════════════════════
overall="PASS"
[ "${crash_status}" = "FAIL" ] && overall="FAIL"
[ "${rpo_status}" = "FAIL" ] && overall="FAIL"

{
  echo "# Gate 1 Failure-Injection — Evidence Record"
  echo
  echo "**Run at:** $(date -u +%Y-%m-%dT%H:%M:%SZ)  "
  echo "**Run tag:** \`${RUN_TAG}\`  "
  echo "**PostgreSQL:** $("${PGBIN}/postgres" --version)  "
  echo "**Host settings:** fsync=${fsync_on}, full_page_writes=${fpw_on}, synchronous_commit=${sync_commit}, archive_timeout=${archive_timeout}  "
  echo "**Result:** **${overall}**"
  echo
  echo "The restore drill answers *can we go back in time?* This drill answers the"
  echo "two questions a restore drill cannot: *does confirmed work survive the"
  echo "machine dying?* and *how much work can the archive actually lose?*"
  echo
  if [ "${DO_CRASH}" = "1" ]; then
    echo "## Phase 1 — Durability and atomicity under SIGKILL"
    echo
    echo "The postmaster was killed with SIGKILL: no checkpoint, no clean shutdown,"
    echo "the shape of a real power loss. Automatic crash recovery then ran on restart."
    echo "Every probe row is scoped to run tag \`${RUN_TAG}\`; no audit rows were"
    echo "deleted at any point, since removing rows from the middle of a hash chain"
    echo "would itself break the chain this phase is checking."
    echo
    echo "| Check | Value | Expected | Result |"
    echo "| :--- | :--- | :--- | :--- |"
    echo "${crash_cells}"
    echo
    echo "**Phase 1 result: ${crash_status}**"
    if [ "${#crash_reasons[@]}" -gt 0 ]; then
      for r in "${crash_reasons[@]}"; do echo "- ${r}"; done
    fi
    echo
  fi
  if [ "${DO_RPO}" = "1" ]; then
    echo "## Phase 2 — Measured RPO"
    echo
    echo "No WAL switches were forced during this measurement. Forcing a switch would"
    echo "close the segment immediately and measure the switch rather than the"
    echo "\`archive_timeout\` bound, which is the thing the RPO claim rests on."
    echo "Recoverability was confirmed by performing a real restore to the marker's"
    echo "commit time, not by asserting that a file exists on disk."
    echo
    echo "| Check | Value | Expected | Result |"
    echo "| :--- | :--- | :--- | :--- |"
    echo "${rpo_cells}"
    echo
    echo "**Phase 2 result: ${rpo_status}**"
    if [ "${#rpo_reasons[@]}" -gt 0 ]; then
      for r in "${rpo_reasons[@]}"; do echo "- ${r}"; done
    fi
    echo
  fi
  echo "## Sign-off"
  echo
  echo "| Role | Name | Date |"
  echo "| :--- | :--- | :--- |"
  echo "| Operator (ran the drill) | | |"
  echo "| Reviewer (verified evidence) | | |"
} > "${EVIDENCE}"

echo "=== Failure drill ${overall} ==="
if [ "${#crash_reasons[@]}" -gt 0 ]; then printf ' - crash: %s\n' "${crash_reasons[@]}"; fi
if [ "${#rpo_reasons[@]}" -gt 0 ]; then printf ' - rpo:   %s\n' "${rpo_reasons[@]}"; fi
echo "Evidence written to ${EVIDENCE}"

[ "${overall}" = "PASS" ] || exit 1
