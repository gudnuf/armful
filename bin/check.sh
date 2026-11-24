#!/usr/bin/env bash
# Every check armful has, in one run, on the synthetic fixture only.
#   bin/check.sh
# Prints one line per suite, `ok <suite>` or `FAIL <suite>` (with the tail of its log),
# keeps going after a failure, and exits 1 if any suite failed.
#
# Environment:
#   ARMFUL_PY          the Python for test/build_site.test.py, which needs numpy and Pillow
#                      (default python3), e.g. ARMFUL_PY="uv run --with numpy --with pillow python3"
#   ARMFUL_CHROME_LOCK a lockfile path: set it to serialise headless Chrome on a shared machine.
#                      The Chrome suites then run, all together, under `lockf` (macOS/BSD) or
#                      `flock` (Linux) on it. Unset (or "none"): no lock, they run directly.
#   CHROME             the Chrome binary (see test/cdp.mjs)
# Chrome suites that do not exist yet are skipped with a note.
set -uo pipefail
cd "$(dirname "$0")/.."

LOGS="$(mktemp -d "${TMPDIR:-/tmp}/armful-check.XXXXXX")"
trap 'rm -rf "$LOGS"' EXIT
read -r -a PY <<< "${ARMFUL_PY:-python3}"
CHROME_SUITES=(tokens wall panel hold previewer home cls csp door a11y)

# run <name> <command...>: one ok/FAIL line, the log tail on failure
run() {
  local name="$1"; shift
  if "$@" > "$LOGS/$name.log" 2>&1; then
    echo "ok $name"
  else
    echo "FAIL $name"
    tail -n 30 "$LOGS/$name.log" | sed 's/^/    /'
    return 1
  fi
}

# the Chrome suites, one after another; called under the lock
chrome_suites() {
  local failed=0 s
  for s in "${CHROME_SUITES[@]}"; do
    if [ -f "test/$s.test.mjs" ]; then run "$s" node --test "test/$s.test.mjs" || failed=1
    else echo "skip $s (test/$s.test.mjs not written yet)"; fi
  done
  return "$failed"
}
if [ "${1:-}" = "--chrome-suites" ]; then chrome_suites; exit; fi

failed=0
run guard bash test/guard.test.sh || failed=1
run fixture node --test test/fixture.test.mjs || failed=1
run build_site "${PY[@]}" -I test/build_site.test.py || failed=1
run build node --test test/build.test.mjs || failed=1
run gate node --test test/gate.test.mjs || failed=1

LOCK="${ARMFUL_CHROME_LOCK:-}"
if [ -n "$LOCK" ] && [ "$LOCK" != "none" ]; then
  mkdir -p "$(dirname "$LOCK")"
  if command -v lockf >/dev/null 2>&1; then lockf "$LOCK" bash "$0" --chrome-suites || failed=1
  elif command -v flock >/dev/null 2>&1; then flock "$LOCK" bash "$0" --chrome-suites || failed=1
  else echo "check: ARMFUL_CHROME_LOCK is set but neither lockf nor flock exists" >&2; failed=1; fi
else
  chrome_suites || failed=1
fi

run no-private bin/check-no-private.sh || failed=1
run no-private-history bin/check-no-private.sh --history HEAD || failed=1

if [ "$failed" = 0 ]; then echo "all ok"; else echo "some checks FAILED"; fi
exit "$failed"
