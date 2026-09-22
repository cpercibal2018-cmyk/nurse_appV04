#!/bin/bash
# ops/backup/scripts/restore-drill.sh
# End-to-end restore drill with timed evidence output.
#
# Purpose (specification Section 10.6 / task B-21): demonstrate that the
# corrected backup scripts actually restore, that the audit hash chain survives,
# and that the elapsed time fits the 4-hour RTO.
#
# Output: gate1-evidence.md (Markdown) + a summary on stdout.

set -euo pipefail

: "${RESTORE_PARENT:?}"; : "${RESTORE_PORT:?}"; : "${DB_NAME:?}"
PGBIN="${PGBIN:-/usr/lib/postgresql/15/bin}"
SOCK_DIR="${RESTORE_PARENT}/sock"
EVIDENCE="${EVIDENCE_FILE:-gate1-evidence.md}"
RTO_MINUTES="${RTO_MINUTES:-240}"

start_epoch=$(date +%s)
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "=== Gate 1 restore drill ==="
echo "Started: ${started_at}"

# Recovery target:
#   - If TARGET_TIME is supplied by the caller, use it verbatim. This is what
#     makes the "rows after the target" check a real test: the caller inserts
#     marker rows AFTER that instant and proves they are absent post-restore.
#   - Otherwise default to 30 seconds ago, which simply gives the backup a
#     moment to settle while still exercising WAL replay.
if [ -n "${TARGET_TIME:-}" ]; then
  echo "Recovery target (caller-supplied): ${TARGET_TIME}"
else
  TARGET_TIME="$(date -u -d '30 seconds ago' '+%Y-%m-%d %H:%M:%S+00')"
  echo "Recovery target: ${TARGET_TIME}"
fi

# ── 1. Restore ──────────────────────────────────────────────────────────────
bash scripts/restore-database.sh "${TARGET_TIME}"
restore_epoch=$(date +%s)
restore_seconds=$((restore_epoch - start_epoch))

# ── 2. Verification queries on the restored instance ────────────────────────
q() { "${PGBIN}/psql" -U postgres -h "${SOCK_DIR}" -p "${RESTORE_PORT}" -d "${DB_NAME}" -tAc "$1"; }

echo "--- verification ---"
emp_restored=$(q "SELECT count(*) FROM employees")
ctr_restored=$(q "SELECT count(*) FROM contracts")
cred_restored=$(q "SELECT count(*) FROM credentials")
audit_restored=$(q "SELECT count(*) FROM audit_entries")
units=$(q "SELECT count(*) FROM nursing_units WHERE deleted_at IS NULL")
beds=$(q "SELECT coalesce(sum(bed_count),0) FROM nursing_units WHERE deleted_at IS NULL")
broken=$(q "SELECT count(*) FROM (SELECT previous_hash, lag(hash) OVER (ORDER BY id) AS expected FROM audit_entries) x WHERE previous_hash IS DISTINCT FROM expected")
latest=$(q "SELECT coalesce(max(created_at)::text,'none') FROM audit_entries")
past_target=$(q "SELECT count(*) FROM audit_entries WHERE created_at > '${TARGET_TIME}'::timestamptz")

echo "employees=${emp_restored} contracts=${ctr_restored} credentials=${cred_restored} audit=${audit_restored}"
echo "units=${units} beds=${beds}"
echo "broken_chain_links=${broken}  rows_after_target=${past_target}"

# ── 3. Integrity checks ─────────────────────────────────────────────────────
# Rows written after the target time must NOT exist in the restored database —
# that is what proves PITR stopped at the right point.
status="PASS"
reasons=()
[ "${broken}" = "0" ] || { status="FAIL"; reasons+=("audit chain has ${broken} broken link(s)"); }
[ "${past_target}" = "0" ] || { status="FAIL"; reasons+=("${past_target} row(s) exist beyond the recovery target"); }
[ "${units}" = "47" ] || { status="FAIL"; reasons+=("expected 47 units, found ${units}"); }
[ "${beds}" = "582" ] || { status="FAIL"; reasons+=("expected 582 beds, found ${beds}"); }
[ "${audit_restored}" -gt 0 ] || { status="FAIL"; reasons+=("no audit entries restored"); }

# Compare against the source database (passed in as expected counts)
if [ -n "${EXPECTED_AUDIT:-}" ] && [ "${audit_restored}" != "${EXPECTED_AUDIT}" ]; then
  status="FAIL"; reasons+=("audit rows ${audit_restored} != source ${EXPECTED_AUDIT}")
fi
if [ -n "${EXPECTED_EMPLOYEES:-}" ] && [ "${emp_restored}" != "${EXPECTED_EMPLOYEES}" ]; then
  status="FAIL"; reasons+=("employees ${emp_restored} != source ${EXPECTED_EMPLOYEES}")
fi

elapsed=$(( $(date +%s) - start_epoch ))
elapsed_min=$(( elapsed / 60 ))

if [ "${elapsed_min}" -gt "${RTO_MINUTES}" ]; then
  status="FAIL"; reasons+=("elapsed ${elapsed_min}m exceeds RTO ${RTO_MINUTES}m")
fi

# ── 4. Evidence record ──────────────────────────────────────────────────────
{
  echo "# Gate 1 Restore Drill — Evidence Record"
  echo
  echo "**Run at:** ${started_at}  "
  echo "**PostgreSQL:** $("${PGBIN}/postgres" --version)  "
  echo "**Recovery target:** ${TARGET_TIME}  "
  echo "**Result:** **${status}**"
  echo
  echo "| Check | Value | Expected | Result |"
  echo "| :--- | :--- | :--- | :--- |"
  echo "| Employees restored | ${emp_restored} | ${EXPECTED_EMPLOYEES:-source} | $([ -z "${EXPECTED_EMPLOYEES:-}" ] || [ "${emp_restored}" = "${EXPECTED_EMPLOYEES}" ] && echo PASS || echo FAIL) |"
  echo "| Contracts restored | ${ctr_restored} | source | — |"
  echo "| Credentials restored | ${cred_restored} | source | — |"
  echo "| Audit entries restored | ${audit_restored} | ${EXPECTED_AUDIT:-source} | $([ -z "${EXPECTED_AUDIT:-}" ] || [ "${audit_restored}" = "${EXPECTED_AUDIT}" ] && echo PASS || echo FAIL) |"
  echo "| Nursing units | ${units} | 47 | $([ "${units}" = "47" ] && echo PASS || echo FAIL) |"
  echo "| Total beds | ${beds} | 582 | $([ "${beds}" = "582" ] && echo PASS || echo FAIL) |"
  echo "| Broken audit chain links | ${broken} | 0 | $([ "${broken}" = "0" ] && echo PASS || echo FAIL) |"
  echo "| Rows after recovery target | ${past_target} | 0 | $([ "${past_target}" = "0" ] && echo PASS || echo FAIL) |"
  echo "| Elapsed (restore) | ${restore_seconds}s | — | — |"
  echo "| Elapsed (total drill) | ${elapsed}s (${elapsed_min}m) | ≤ ${RTO_MINUTES}m | $([ "${elapsed_min}" -le "${RTO_MINUTES}" ] && echo PASS || echo FAIL) |"
  echo "| Latest audit row | ${latest} | ≤ target | $([ "${past_target}" = "0" ] && echo PASS || echo FAIL) |"
  echo
  if [ "${#reasons[@]}" -gt 0 ]; then
    echo "**Failure reasons**"
    echo
    for r in "${reasons[@]}"; do echo "- ${r}"; done
    echo
  fi
  echo "## Commands executed"
  echo
  echo '```'
  echo "TARGET_TIME=${TARGET_TIME}"
  echo "bash scripts/restore-database.sh \"\${TARGET_TIME}\""
  echo '```'
  echo
  echo "## Sign-off"
  echo
  echo "| Role | Name | Date |"
  echo "| :--- | :--- | :--- |"
  echo "| Operator (ran the drill) | | |"
  echo "| Reviewer (verified evidence) | | |"
} > "${EVIDENCE}"

echo
echo "=== Drill ${status} in ${elapsed}s (${elapsed_min}m) ==="
if [ "${#reasons[@]}" -gt 0 ]; then printf ' - %s\n' "${reasons[@]}"; fi
echo "Evidence written to ${EVIDENCE}"

[ "${status}" = "PASS" ] || exit 1
