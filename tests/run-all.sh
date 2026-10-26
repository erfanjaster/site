#!/usr/bin/env bash
# FORGE INFINITE — full test suite.
#   bash tests/run-all.sh          (boots its own dev server on :8099)
set -u
cd "$(dirname "$0")/.."
PORT="${PORT:-8099}"
BASE="http://127.0.0.1:$PORT"

echo "════════════════════════════════════════════════════════════"
echo " FORGE INFINITE — test suite"
echo "════════════════════════════════════════════════════════════"

echo; echo "▸ PHP lint (every file)"
LINT_FAIL=0
for f in $(find htdocs/api htdocs/jobs tests -name '*.php' 2>/dev/null); do
  if ! php -l "$f" >/dev/null 2>&1; then echo "   ✗ $f"; php -l "$f"; LINT_FAIL=1; fi
done
[ $LINT_FAIL -eq 0 ] && echo "   ✓ all PHP files parse"

echo; echo "▸ ES module syntax (every file)"
JS_FAIL=0
for f in htdocs/js/*.js; do
  cp "$f" /tmp/_chk.mjs
  if ! node --check /tmp/_chk.mjs >/dev/null 2>&1; then echo "   ✗ $f"; node --check /tmp/_chk.mjs; JS_FAIL=1; fi
done
[ $JS_FAIL -eq 0 ] && echo "   ✓ all JS modules parse"

echo; echo "▸ Build the single-file demo (no server, no CORS)"
node tools/build-demo-single-file.mjs || { echo "   ✗ build failed"; exit 1; }
echo "   ✓ forge-infinite-demo.html built"

echo; echo "▸ Install database (fresh) + compliance assertions"
php htdocs/api/db_install.php --force --seed-loadtest || exit 1

echo; echo "▸ Boot dev server on :$PORT"
# NOTE: do not pkill by pattern here — the pattern matches this script's own
# command line and would kill the run. Use a port check instead.
if command -v fuser >/dev/null 2>&1; then fuser -k "$PORT/tcp" >/dev/null 2>&1 || true; fi
sleep 1
nohup php -d expose_php=0 -S "127.0.0.1:$PORT" dev-router.php > /tmp/fi-server.log 2>&1 &
SRV=$!
disown $SRV 2>/dev/null || true
for i in $(seq 1 20); do
  sleep 0.5
  if php -r 'exit(@fsockopen("127.0.0.1", (int)$argv[1]) ? 0 : 1);' "$PORT" 2>/dev/null; then break; fi
done
if ! php -r 'exit(@fsockopen("127.0.0.1", (int)$argv[1]) ? 0 : 1);' "$PORT" 2>/dev/null; then
  echo "   ✗ server failed to start"; tail -20 /tmp/fi-server.log; exit 1
fi
echo "   ✓ server up (pid $SRV)"
trap 'kill $SRV >/dev/null 2>&1 || true' EXIT

FAILS=0
run() {
  echo; echo "▸ $1"; shift
  "$@" || FAILS=$((FAILS+1))
}
run "Client unit tests (balance, formatting, content, compliance)" node tests/client.test.mjs
run "Offline demo engine (browser-only preview build)" node tests/demo.test.mjs
run "Single-file demo build (zero external requests)" node tests/singlefile.test.mjs
run "Server end-to-end tests (auth, economy, anti-cheat, payments)" php tests/e2e.php "$BASE"
run "30-day balance playthrough (pacing vs the GDD)" php tests/playthrough.php "$BASE"

echo; echo "▸ Load test (informational — capacity estimate)"
php tests/load.php "$BASE" 50 30 20 | tail -14

echo; echo "════════════════════════════════════════════════════════════"
if [ $LINT_FAIL -ne 0 ] || [ $JS_FAIL -ne 0 ]; then echo " RESULT: lint failures — fix before shipping"; exit 1; fi
if [ $FAILS -eq 0 ]; then echo " RESULT: ✅ all suites passed"; else echo " RESULT: ❌ $FAILS suite(s) failed"; fi
echo "════════════════════════════════════════════════════════════"
exit $FAILS
