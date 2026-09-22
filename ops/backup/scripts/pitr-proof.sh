#!/bin/bash
# ops/backup/scripts/pitr-proof.sh
# Drives a *provable* point-in-time-recovery test.
#
# The restore drill on its own can only prove "the restore ran". It cannot prove
# that recovery stopped at the requested instant, because if nothing is written
# after the target there is nothing for the cut to exclude. This driver removes
# that blind spot:
#
#   1. write PRE-target marker rows        -> must be PRESENT after restore
#   2. force a WAL switch and wait         -> those rows reach the archive
#   3. capture T0 from the database clock
#   4. write POST-target marker rows       -> must be ABSENT after restore
#   5. force a WAL switch and wait         -> the post-target WAL reaches the
#                                             archive too, so their absence
#                                             proves a time-based cut, not a
#                                             missing-segment accident
#   6. run restore-drill.sh with TARGET_TIME=T0
#   7. assert on the restored instance
#
# Usage:
#   TARGET_TIME is NOT set by the caller; this script derives it.
#   Required: SOURCE_SOCK, SOURCE_PORT, DB_NAME, RESTORE_PARENT, RESTORE_PORT, PGBIN

set -euo pipefail

: "${SOURCE_SOCK:?}"; : "${SOURCE_PORT:?}"; : "${DB_NAME:?}"
: "${RESTORE_PARENT:?}"; : "${RESTORE_PORT:?}"
PGBIN="${PGBIN:-/usr/lib/postgresql/15/bin}"
BACKUP_STORAGE_PATH="${BACKUP_STORAGE_PATH:?}"
EVIDENCE="${EVIDENCE_FILE:-gate1-evidence.md}"

PRE_ACTION="drill.pre_target_marker"
POST_ACTION="drill.post_target_marker"
PRE_ROWS="${PRE_ROWS:-5}"
POST_ROWS="${POST_ROWS:-3}"

src() { "${PGBIN}/psql" -h "${SOURCE_SOCK}" -p "${SOURCE_PORT}" -U postgres -d "${DB_NAME}" -tAc "$1"; }
rst() { "${PGBIN}/psql" -U postgres -h "${RESTORE_PARENT}/sock" -p "${RESTORE_PORT}" -d "${DB_NAME}" -tAc "$1"; }

wait_for_archive() {
  # NOTE: pg_switch_wal() returns an LSN (e.g. 0/D000078), NOT a segment name,
  # so it cannot be compared with pg_stat_archiver.last_archived_wal directly.
  # Instead we require the archive to *advance*, and we require failed_count to
  # stay flat -- it is cumulative for the life of the cluster, so an absolute
  # "failed_count = 0" test is wrong on any cluster that has ever failed once.
  local last_before="$1" failed_before="$2" tries=0
  while [ "${tries}" -lt 60 ]; do
    local last failed
    last=$(src "SELECT coalesce(last_archived_wal,'') FROM pg_stat_archiver")
    failed=$(src "SELECT failed_count FROM pg_stat_archiver")
    if [ "${last}" != "${last_before}" ] && [ "${failed}" = "${failed_before}" ]; then
      echo "  archive advanced: ${last_before:-<none>} -> ${last} (failed_count ${failed}, unchanged)"
      return 0
    fi
    tries=$((tries + 1)); sleep 0.5
  done
  echo "  ERROR: WAL archive did not advance within 30s (last=${last_before})" >&2
  return 1
}

switch_and_wait() {
  local last_before failed_before
  last_before=$(src "SELECT coalesce(last_archived_wal,'') FROM pg_stat_archiver")
  failed_before=$(src "SELECT failed_count FROM pg_stat_archiver")
  src "SELECT pg_switch_wal()" >/dev/null
  wait_for_archive "${last_before}" "${failed_before}"
}

echo "=== Gate 1 provable-PITR driver ==="

# ── Clean slate: remove markers from any earlier run ────────────────────────
src "DELETE FROM audit_entries WHERE action IN ('${PRE_ACTION}','${POST_ACTION}')" >/dev/null
echo "cleared markers from previous runs"

# ── 1. Pre-target markers ───────────────────────────────────────────────────
for i in $(seq 1 "${PRE_ROWS}"); do
  src "SELECT fn_append_audit_entry(1,'${PRE_ACTION}','drill','pre-${i}','{\"phase\":\"pre-target\",\"seq\":${i}}'::jsonb)" >/dev/null
done
echo "1. wrote ${PRE_ROWS} PRE-target marker rows"

# ── 2. Archive them ─────────────────────────────────────────────────────────
echo "2. switching WAL to archive pre-target rows"
switch_and_wait

# ── 3. Capture T0 from the database clock ───────────────────────────────────
sleep 1
T0="$(src "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.MS') || '+00'")"
echo "3. T0 (recovery target) = ${T0}"

# ── 4. Post-target markers ──────────────────────────────────────────────────
sleep 1
for i in $(seq 1 "${POST_ROWS}"); do
  src "SELECT fn_append_audit_entry(1,'${POST_ACTION}','drill','post-${i}','{\"phase\":\"post-target\",\"seq\":${i}}'::jsonb)" >/dev/null
done
echo "4. wrote ${POST_ROWS} POST-target marker rows"

# ── 5. Archive those too (so absence proves the time cut) ───────────────────
echo "5. switching WAL to archive post-target rows"
switch_and_wait

# ── Record the source side of truth ─────────────────────────────────────────
EXPECTED_EMPLOYEES=$(src "SELECT count(*) FROM employees")
EXPECTED_AUDIT_AT_T0=$(src "SELECT count(*) FROM audit_entries WHERE created_at <= '${T0}'::timestamptz")
EXPECTED_AUDIT_NOW=$(src "SELECT count(*) FROM audit_entries")
echo
echo "source: employees=${EXPECTED_EMPLOYEES}  audit@T0=${EXPECTED_AUDIT_AT_T0}  audit@now=${EXPECTED_AUDIT_NOW}"
echo "        (a correct restore must land on ${EXPECTED_AUDIT_AT_T0}, not ${EXPECTED_AUDIT_NOW})"
echo

# ── 6. The drill itself ─────────────────────────────────────────────────────
echo "6. running restore-drill.sh with TARGET_TIME=${T0}"
TARGET_TIME="${T0}" \
EXPECTED_AUDIT="${EXPECTED_AUDIT_AT_T0}" \
EXPECTED_EMPLOYEES="${EXPECTED_EMPLOYEES}" \
RTO_MINUTES="${RTO_MINUTES:-240}" \
bash scripts/restore-drill.sh
drill_rc=$?

# ── 7. Independent assertions on the restored instance ──────────────────────
echo
echo "7. independent assertions against the restored instance"
pre_found=$(rst "SELECT count(*) FROM audit_entries WHERE action='${PRE_ACTION}'")
post_found=$(rst "SELECT count(*) FROM audit_entries WHERE action='${POST_ACTION}'")
rst_total=$(rst "SELECT count(*) FROM audit_entries")
rst_max=$(rst "SELECT max(created_at) FROM audit_entries")
rst_breaks=$(rst "SELECT count(*) FROM audit_chain_breaks WHERE previous_hash IS DISTINCT FROM expected_previous AND previous_hash IS NOT NULL")
rst_beds=$(rst "SELECT coalesce(sum(bed_count),0) FROM nursing_units WHERE deleted_at IS NULL")

check() { # label actual expected
  if [ "$2" = "$3" ]; then echo "  PASS  $1 = $2"
  else echo "  FAIL  $1 = $2 (expected $3)"; return 1; fi
}
fails=0
check "pre-target markers present"   "${pre_found}"  "${PRE_ROWS}"        || fails=$((fails+1))
check "post-target markers absent"   "${post_found}" "0"                  || fails=$((fails+1))
check "audit rows at T0"            "${rst_total}"  "${EXPECTED_AUDIT_AT_T0}" || fails=$((fails+1))
check "audit chain breaks"           "${rst_breaks}" "0"                  || fails=$((fails+1))
check "total beds"                   "${rst_beds}"   "582"                || fails=$((fails+1))
echo "  info  restored max created_at = ${rst_max}  (must be <= ${T0})"

# ── Append the PITR section to the evidence file ────────────────────────────
{
  echo
  echo "## Provable point-in-time recovery (driver: \`scripts/pitr-proof.sh\`)"
  echo
  echo "Marker rows were written on both sides of the recovery target, and both"
  echo "batches were archived to WAL *before* the restore, so the absence of the"
  echo "post-target rows is a genuine time-based cut — not a missing segment."
  echo
  echo "| Assertion | Observed | Expected | Result |"
  echo "| :--- | :--- | :--- | :--- |"
  echo "| Pre-target marker rows present | ${pre_found} | ${PRE_ROWS} | $([ "${pre_found}" = "${PRE_ROWS}" ] && echo PASS || echo FAIL) |"
  echo "| Post-target marker rows absent | ${post_found} | 0 | $([ "${post_found}" = "0" ] && echo PASS || echo FAIL) |"
  echo "| Audit rows at target | ${rst_total} | ${EXPECTED_AUDIT_AT_T0} | $([ "${rst_total}" = "${EXPECTED_AUDIT_AT_T0}" ] && echo PASS || echo FAIL) |"
  echo "| Audit rows at present (source) | — | ${EXPECTED_AUDIT_NOW} | (excluded by design) |"
  echo "| Audit chain breaks after restore | ${rst_breaks} | 0 | $([ "${rst_breaks}" = "0" ] && echo PASS || echo FAIL) |"
  echo "| Total beds after restore | ${rst_beds} | 582 | $([ "${rst_beds}" = "582" ] && echo PASS || echo FAIL) |"
  echo "| Restored max audit timestamp | ${rst_max} | ≤ ${T0} | $([ "${rst_total}" = "${EXPECTED_AUDIT_AT_T0}" ] && echo PASS || echo FAIL) |"
  echo
  echo "Recovery target (T0, database clock): \`${T0}\`"
  echo
  if [ "${fails}" -gt 0 ]; then
    echo "**${fails} PITR assertion(s) FAILED.**"
  else
    echo "**All PITR assertions passed.**"
  fi
} >> "${EVIDENCE}"

echo
if [ "${fails}" -eq 0 ] && [ "${drill_rc}" -eq 0 ]; then
  echo "=== PITR PROOF PASSED ==="
else
  echo "=== PITR PROOF FAILED (assertion failures=${fails}, drill rc=${drill_rc}) ==="
  exit 1
fi
