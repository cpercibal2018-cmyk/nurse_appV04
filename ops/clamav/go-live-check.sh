#!/bin/bash
# ops/clamav/go-live-check.sh [host] [port]
#
# Go-live check for the upload malware scanner (docs/DEPLOYMENT.md §2.1;
# spec §5.3.2; decisions D-10, D-43). Run it FROM THE API HOST, against the
# production clamd, before enabling uploads:
#
#   ./ops/clamav/go-live-check.sh clamav.internal 3310
#
# It talks to clamd exactly the way the API does (TCP, zVERSION / zINSTREAM),
# so it needs only bash — no clamdscan, no nc. It proves, in order:
#
#   1. reachable     clamd answers PING from this host
#   2. signatures    the OFFICIAL database is loaded (VERSION carries a database
#                    number) and is fresh (dated within CHECK_MAX_AGE_HOURS).
#                    Without it the API refuses every upload (SCANNER_UNAVAILABLE).
#   3. detection     the standalone EICAR test file is reported FOUND, under an
#                    official name (no ".UNOFFICIAL" suffix — that suffix means a
#                    local signature file, not the official database)
#   4. clean         a harmless file is reported OK
#   5. size limit    a file of exactly UPLOAD_MAX_SIZE_BYTES is accepted
#                    (clamd.conf StreamMaxLength must be at least that)
#
# Environment (optional):
#   CHECK_MAX_AGE_HOURS    default 24 — stricter than the API's 48 h alert, so a
#                          host that passes today does not alert tomorrow
#   UPLOAD_MAX_SIZE_BYTES  default 10485760 — must match the API's setting
#   CLAMAV_TIMEOUT_SECONDS default 30
#
# Exit code 0 only if every check passes. Nothing is written anywhere except a
# temporary directory that is removed on exit.

set -euo pipefail

HOST="${1:-${CLAMAV_HOST:-}}"
PORT="${2:-${CLAMAV_PORT:-3310}}"
MAX_AGE_HOURS="${CHECK_MAX_AGE_HOURS:-24}"
MAX_BYTES="${UPLOAD_MAX_SIZE_BYTES:-10485760}"
TIMEOUT="${CLAMAV_TIMEOUT_SECONDS:-30}"

if [[ -z "$HOST" ]]; then
  echo "usage: $0 <clamd-host> [port]   (or set CLAMAV_HOST / CLAMAV_PORT)" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILED=0
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILED=1; }

# Sends the payload file to clamd and prints the reply without its NUL terminator.
clamd_send() {
  # clamd may answer and close before the upload ends (size limit), so read
  # the reply even when the write fails.
  timeout "$TIMEOUT" bash -c 'exec 3<>"/dev/tcp/$0/$1" || exit; cat "$2" >&3 2>/dev/null; tr -d "\000" <&3' "$HOST" "$PORT" "$1" 2>/dev/null || true
}

# Writes a zINSTREAM payload for the given file: one length-prefixed chunk + terminator.
instream_payload() {
  local file="$1" out="$2" len hex
  len=$(stat -c %s "$file")
  hex=$(printf '%08x' "$len")
  {
    printf 'zINSTREAM\0'
    printf "\\x${hex:0:2}\\x${hex:2:2}\\x${hex:4:2}\\x${hex:6:2}"
    cat "$file"
    printf '\0\0\0\0'
  } > "$out"
}

echo "clamd go-live check: $HOST:$PORT (upload limit $MAX_BYTES bytes, signatures ≤ $MAX_AGE_HOURS h old)"

# 1. reachable
printf 'zPING\0' > "$TMP/ping"
reply=$(clamd_send "$TMP/ping")
if [[ "$reply" == "PONG" ]]; then pass "reachable: PING → PONG"; else fail "reachable: PING → '${reply:-no answer}' (firewall, host or port?)"; fi

# 2. signatures
printf 'zVERSION\0' > "$TMP/version"
reply=$(clamd_send "$TMP/version")
IFS=/ read -r engine dbver dbdate <<< "$reply"
if [[ "$engine" != ClamAV* ]]; then
  fail "signatures: VERSION → '${reply:-no answer}'"
elif [[ ! "${dbver:-}" =~ ^[1-9][0-9]*$ ]]; then
  fail "signatures: '$reply' has no database number — the official signatures are not loaded (run freshclam on the scanner host). The API refuses uploads in this state"
else
  if db_epoch=$(date -d "$dbdate" +%s 2>/dev/null); then
    age_h=$(( ( $(date +%s) - db_epoch ) / 3600 ))
    if (( age_h <= MAX_AGE_HOURS )); then
      pass "signatures: $engine, database $dbver, $age_h h old ($dbdate)"
    else
      fail "signatures: database $dbver is $age_h h old ($dbdate) — freshclam is not updating (outbound HTTPS to the mirror?)"
    fi
  else
    fail "signatures: cannot read the database date in '$reply'"
  fi
fi

# 3. detection — EICAR assembled at run time so this script itself is not flagged.
printf '%s%s%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$' 'EICAR-STANDARD-ANTIVIRUS' '-TEST-FILE!$H+H*' > "$TMP/eicar"
instream_payload "$TMP/eicar" "$TMP/eicar.in"
reply=$(clamd_send "$TMP/eicar.in")
if [[ "$reply" =~ ^stream:\ (.+)\ FOUND$ ]]; then
  name="${BASH_REMATCH[1]}"
  if [[ "$name" == *.UNOFFICIAL ]]; then
    fail "detection: EICAR found as '$name' — a local signature, not the official database"
  else
    pass "detection: EICAR → $name FOUND"
  fi
else
  fail "detection: EICAR → '${reply:-no answer}' (expected FOUND)"
fi

# 4. clean
printf '%%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%%%EOF\n' > "$TMP/clean.pdf"
instream_payload "$TMP/clean.pdf" "$TMP/clean.in"
reply=$(clamd_send "$TMP/clean.in")
if [[ "$reply" == "stream: OK" ]]; then pass "clean: small PDF → OK"; else fail "clean: small PDF → '${reply:-no answer}'"; fi

# 5. size limit
head -c "$MAX_BYTES" /dev/zero > "$TMP/big"
instream_payload "$TMP/big" "$TMP/big.in"
reply=$(clamd_send "$TMP/big.in")
if [[ "$reply" == "stream: OK" ]]; then
  pass "size limit: $MAX_BYTES bytes → OK"
elif [[ "$reply" == *"size limit exceeded"* ]]; then
  fail "size limit: $MAX_BYTES bytes → '$reply' (raise StreamMaxLength in clamd.conf to at least UPLOAD_MAX_SIZE_BYTES)"
else
  fail "size limit: $MAX_BYTES bytes → '${reply:-no answer}'"
fi

if (( FAILED )); then
  echo "RESULT: FAILED — do not enable uploads in production until every check passes."
  exit 1
fi
echo "RESULT: PASSED — now upload one real document through the app and confirm it is accepted (DEPLOYMENT.md §2.1)."
