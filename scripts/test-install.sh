#!/usr/bin/env bash
# Installs a packaged release the way a user would and checks that it works.
# Run after `npm run build && node scripts/package-release.mjs`:
#
#   scripts/test-install.sh [--service] [--release-dir dist-release]
#
# Everything happens under a throwaway HOME, on its own port. The installer
# downloads its own Node.js unless AGENT_STUDIO_NODE is set. With --service the
# background service is installed (systemd for the user, or launchd), checked
# and removed again — use it only on a machine where that is fine (CI).
set -euo pipefail

RELEASE_DIR=dist-release
SERVICE=0
while [ $# -gt 0 ]; do
  case $1 in
    --service) SERVICE=1; shift ;;
    --release-dir) RELEASE_DIR=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
RELEASE_DIR=$(cd "$RELEASE_DIR" && pwd)
[ -f "$RELEASE_DIR/SHA256SUMS" ] || { echo "No release in $RELEASE_DIR; run scripts/package-release.mjs first." >&2; exit 2; }

PORT=${TEST_PORT:-7493}
FILES_PORT=${TEST_FILES_PORT:-7494}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/agent-studio-test-install.XXXXXX")
TEST_HOME=$WORK/home
mkdir -p "$TEST_HOME"
SERVER_PID=
FILES_PID=

cleanup() {
  if [ "$SERVICE" = 1 ]; then
    HOME=$TEST_HOME AGENT_STUDIO_SERVICE_NAME=agent-studio-test "$TEST_HOME/.local/bin/agent-studio" service uninstall >/dev/null 2>&1 || true
  fi
  [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null || true
  [ -z "$FILES_PID" ] || kill "$FILES_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

check() { printf '  ✓ %s\n' "$*"; }
die() {
  printf '  ✗ %s\n' "$*" >&2
  [ ! -f "$WORK/server.log" ] || { echo '--- server log' >&2; tail -n 40 "$WORK/server.log" >&2; }
  exit 1
}

wait_for_health() {
  for _ in $(seq 1 80); do
    if curl -fs "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok"'; then return 0; fi
    sleep 0.5
  done
  return 1
}

if curl -fs -m 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "Something already answers on port $PORT; set TEST_PORT to a free port." >&2
  exit 2
fi

# The release files, served the way GitHub serves them.
(cd "$RELEASE_DIR" && exec python3 -m http.server "$FILES_PORT" --bind 127.0.0.1) >"$WORK/files.log" 2>&1 &
FILES_PID=$!
for _ in $(seq 1 40); do curl -fs "http://127.0.0.1:$FILES_PORT/SHA256SUMS" >/dev/null 2>&1 && break; sleep 0.25; done

run_studio() {
  env HOME="$TEST_HOME" AGENT_STUDIO_SERVICE_NAME=agent-studio-test "$TEST_HOME/.local/bin/agent-studio" "$@"
}

echo "Installing from $RELEASE_DIR"
installer_flags=(--no --port "$PORT")
[ "$SERVICE" = 1 ] || installer_flags+=(--no-service)
env HOME="$TEST_HOME" AGENT_STUDIO_SERVICE_NAME=agent-studio-test AGENT_STUDIO_RELEASE_BASE="http://127.0.0.1:$FILES_PORT" \
  bash "$RELEASE_DIR/install.sh" "${installer_flags[@]}" >"$WORK/install.log" 2>&1 || { cat "$WORK/install.log" >&2; die "the installer failed"; }
check "the installer finished"

VERSION=$(sed -n 's/.*agent-studio-\(.*\)\.tar\.gz$/\1/p' "$RELEASE_DIR/SHA256SUMS")
[ "$(run_studio version)" = "$VERSION" ] || die "agent-studio version does not say $VERSION"
check "agent-studio version: $VERSION"

# A release whose archive does not match its sum is refused, and nothing is replaced.
cp -R "$RELEASE_DIR" "$WORK/tampered"
printf 'x' >>"$WORK/tampered/agent-studio-$VERSION.tar.gz"
TAMPERED_PORT=$((FILES_PORT + 10))
(cd "$WORK/tampered" && exec python3 -m http.server "$TAMPERED_PORT" --bind 127.0.0.1) >"$WORK/tampered-files.log" 2>&1 &
TAMPERED_PID=$!
for _ in $(seq 1 40); do curl -fs "http://127.0.0.1:$TAMPERED_PORT/SHA256SUMS" >/dev/null 2>&1 && break; sleep 0.25; done
if env HOME="$WORK/other-home" AGENT_STUDIO_RELEASE_BASE="http://127.0.0.1:$TAMPERED_PORT" bash "$RELEASE_DIR/install.sh" --no --no-service >"$WORK/tampered.log" 2>&1; then
  die "a tampered archive was installed"
fi
grep -q 'does not match its published SHA-256 sum' "$WORK/tampered.log" || die "a tampered archive was refused for the wrong reason: $(tail -n 2 "$WORK/tampered.log")"
[ ! -e "$WORK/other-home/.local/share/agent-studio/current" ] || die "a tampered archive left an installation behind"
kill "$TAMPERED_PID" 2>/dev/null || true
check "a tampered archive is refused"

if [ "$SERVICE" = 1 ]; then
  wait_for_health || die "the service did not answer on port $PORT"
  check "the background service answers"
else
  # exec all the way down, so that the process to stop afterwards is the server itself.
  (exec env HOME="$TEST_HOME" AGENT_STUDIO_SERVICE_NAME=agent-studio-test "$TEST_HOME/.local/bin/agent-studio" start) >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  wait_for_health || die "the server did not answer on port $PORT"
  check "the server answers on 127.0.0.1:$PORT"
fi

TOKEN=$(run_studio setup-token) || die "agent-studio setup-token failed"
[ "${#TOKEN}" -ge 16 ] || die "no setup token"
check "a one-time setup token is waiting"
run_studio status | grep -q 'first-run setup is pending' || die "agent-studio status does not report the pending setup"
check "agent-studio status reports the pending setup"
curl -fs "http://127.0.0.1:$PORT/" | grep -q '<title>' || die "the web client is not served"
check "the web client is served"
# Only loopback is listened on.
if curl -fs -m 2 "http://$(hostname -I 2>/dev/null | awk '{ print $1 }'):$PORT/api/health" >/dev/null 2>&1; then
  die "the server answers on a non-loopback address"
fi
check "nothing answers outside loopback"

# The terminal's prebuilt binary for this platform loads.
APP=$TEST_HOME/.local/share/agent-studio/current
NODE=$TEST_HOME/.local/share/agent-studio/runtime/current/bin/node
[ -x "$NODE" ] || NODE=$(command -v node)
(cd "$APP" && "$NODE" --input-type=module -e "
  const { spawn } = await import('@lydell/node-pty');
  const shell = spawn('/bin/sh', ['-c', 'echo terminal-works'], {});
  let seen = '';
  shell.onData((data) => { seen += data; });
  shell.onExit(() => process.exit(seen.includes('terminal-works') ? 0 : 1));
") || die "the terminal binary does not work"
check "the terminal binary works"

if [ "$SERVICE" = 1 ]; then
  run_studio service restart >/dev/null
  sleep 2
  wait_for_health || die "the service did not come back after a restart"
  check "the service restarts"
  run_studio service uninstall >/dev/null
  if curl -fs -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then die "the service still runs after uninstall"; fi
  check "the service is removed"
fi
echo "Install test passed."
