#!/usr/bin/env bash
# Post-deploy checks against a live armful site.
#   bin/smoke.sh <base-url> <slug>
#   e.g. ARMFUL_PASSWORD="$(cat <your local passphrase file>)" ARMFUL_EXPECT_FILES=<file count> bin/smoke.sh https://armful.photos <slug>
# The slug may also come from $ARMFUL_SLUG. The password is read ONLY from $ARMFUL_PASSWORD
# (never an argument; it reaches curl on stdin, never argv); without it the
# right-password checks are skipped. $ARMFUL_EXPECT_FILES, if set, is the file count
# data.json must hold. One `ok`/`FAIL` line per check; exit 1 if any failed.
set -uo pipefail
BASE="${1:?usage: bin/smoke.sh <base-url> <slug>}"; BASE="${BASE%/}"
SLUG="${2:-${ARMFUL_SLUG:-}}"
[ -n "$SLUG" ] || { echo "usage: bin/smoke.sh <base-url> <slug> (or set ARMFUL_SLUG)" >&2; exit 2; }
command -v curl >/dev/null || { echo "smoke: needs curl" >&2; exit 2; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/armful-smoke.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
failed=0
check() { if [ "$2" = 0 ]; then echo "ok $1"; else echo "FAIL $1${3:+: $3}"; failed=1; fi; }
# get <name> <path> [curl args...]: headers -> $TMP/<name>.h, body -> $TMP/<name>.b, prints the status
get() {
  local name="$1" path="$2"; shift 2
  curl -s --path-as-is --max-time 20 -D "$TMP/$name.h" -o "$TMP/$name.b" -w '%{http_code}' "$@" "$BASE$path"
}
hdr() { grep -i "^$2:" "$TMP/$1.h" | head -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
isjson() { node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1" 2>/dev/null; }

s=$(get home /); r=$( [ "$s" = 200 ] && [ -z "$(hdr home x-robots-tag)" ]; echo $?)
check "home: 200, indexable (no X-Robots-Tag)" "$r" "status $s, X-Robots-Tag '$(hdr home x-robots-tag)'"

s=$(get bare "/$SLUG"); r=$( [ "$s" = 301 ] && [ "$(hdr bare location)" = "/$SLUG/" ]; echo $?)
check "/$SLUG: 301 to /$SLUG/" "$r" "status $s, Location '$(hdr bare location)'"

s=$(get door "/$SLUG/"); r=$( [ "$s" = 401 ] && hdr door x-robots-tag | grep -qi noindex; echo $?)
check "/$SLUG/: 401 door, X-Robots-Tag noindex" "$r" "status $s, X-Robots-Tag '$(hdr door x-robots-tag)'"

s=$(get nocookie "/$SLUG/data.json"); r=$( [ "$s" = 401 ] && ! isjson "$TMP/nocookie.b"; echo $?)
check "/$SLUG/data.json without a cookie: 401, not JSON" "$r" "status $s"

s=$(get enc "/$SLUG%2Fdata.json"); check "/$SLUG%2Fdata.json: not 200" "$( [ "$s" != 200 ]; echo $?)" "status $s"
s=$(get dbl "//$SLUG/data.json"); check "//$SLUG/data.json: not 200" "$( [ "$s" != 200 ]; echo $?)" "status $s"

s=$(get wrong "/$SLUG/__gate" -X POST --data-urlencode "p=not-the-password-$RANDOM$RANDOM" --data-urlencode "to=")
check "wrong password: 401" "$( [ "$s" = 401 ]; echo $?)" "status $s"

if [ -z "${ARMFUL_PASSWORD:-}" ]; then
  echo "skip right password, data.json with the cookie (set ARMFUL_PASSWORD to run them)"
else
  s=$(printf '%s' "$ARMFUL_PASSWORD" | get right "/$SLUG/__gate" -X POST --data-urlencode "p@-" --data-urlencode "to=" -c "$TMP/jar")
  r=$( [ "$s" = 303 ] && grep -q "armful_$SLUG" "$TMP/jar"; echo $?)
  check "right password: 303 and the cookie" "$r" "status $s"
  s=$(get data "/$SLUG/data.json" -b "$TMP/jar")
  n=$(node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Array.isArray(d.files) ? d.files.length : -1)' "$TMP/data.b" 2>/dev/null || echo -1)
  r=$( [ "$s" = 200 ] && [ "$n" -ge 0 ] && { [ -z "${ARMFUL_EXPECT_FILES:-}" ] || [ "$n" = "$ARMFUL_EXPECT_FILES" ]; }; echo $?)
  check "data.json with the cookie: 200, \"files\" holds $n${ARMFUL_EXPECT_FILES:+ (want $ARMFUL_EXPECT_FILES)}" "$r" "status $s"
fi

if [ "$failed" = 0 ]; then echo "smoke: all ok"; else echo "smoke: FAILED"; fi
exit "$failed"
