#!/usr/bin/env bash
# Installs Agent Cloud Studio for the current user — no root needed except,
# if you agree, to install the bubblewrap sandbox.
#
#   curl -fsSL https://raw.githubusercontent.com/Jineggegg/agent-studio/main/packaging/install.sh | bash
#
# Options (after `| bash -s --`):
#   --version <x.y.z>   install this release instead of the newest one
#   --port <n>          listen on this port (default 7420)
#   --no-service        do not install or start the background service
#   --yes               answer yes to every question (installing bubblewrap uses sudo)
#   --no                answer no to every question
#   --dir <path>        install here (default ~/.local/share/agent-studio)
#   --bin-dir <path>    put the `agent-studio` command here (default ~/.local/bin)
#
# What it does: downloads the release and a private copy of Node.js, checks
# both against their published SHA-256 sums, unpacks them under --dir, writes
# the `agent-studio` command, and starts the server as a user service
# (systemd or launchd). It listens on 127.0.0.1 only. Your data lives in
# ~/.agent-studio; settings in ~/.config/agent-studio/env.
set -euo pipefail

REPO=Jineggegg/agent-studio
NODE_VERSION=24.21.0
NODE_MIRROR=${AGENT_STUDIO_NODE_MIRROR:-https://nodejs.org/dist}
INSTALL_DIR=${AGENT_STUDIO_INSTALL_DIR:-$HOME/.local/share/agent-studio}
BIN_DIR=${AGENT_STUDIO_BIN_DIR:-$HOME/.local/bin}
CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/agent-studio
VERSION=${AGENT_STUDIO_VERSION:-}
PORT=
SERVICE=1
ANSWER=${AGENT_STUDIO_ANSWER:-ask}

# ---- output -------------------------------------------------------------------

if [ -t 1 ]; then BOLD=$(printf '\033[1m') DIM=$(printf '\033[2m') RESET=$(printf '\033[0m'); else BOLD='' DIM='' RESET=''; fi
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
note() { printf '    %s\n' "$*"; }
fail() {
  printf '\nagent-studio install: %s\n' "$*" >&2
  exit 1
}

# Questions are read from the terminal, so they work when this script arrives through a pipe.
ask() {
  case $ANSWER in yes) return 0 ;; no) return 1 ;; esac
  if [ ! -r /dev/tty ]; then return 1; fi
  printf '%s [y/N] ' "$1" >/dev/tty
  local reply
  read -r reply </dev/tty || return 1
  case $reply in y | Y | yes | YES | Yes) return 0 ;; *) return 1 ;; esac
}

usage() {
  cat <<'USAGE'
Installs Agent Cloud Studio for the current user.

  curl -fsSL https://raw.githubusercontent.com/Jineggegg/agent-studio/main/packaging/install.sh | bash -s -- [options]

  --version <x.y.z>   install this release instead of the newest one
  --port <n>          listen on this port (default 7420)
  --no-service        do not install or start the background service
  --yes / --no        answer every question yes / no (installing bubblewrap uses sudo)
  --dir <path>        install here (default ~/.local/share/agent-studio)
  --bin-dir <path>    put the `agent-studio` command here (default ~/.local/bin)
USAGE
}

while [ $# -gt 0 ]; do
  case $1 in
    --version) VERSION=${2:?--version needs a value}; shift 2 ;;
    --port) PORT=${2:?--port needs a value}; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    --yes | -y) ANSWER=yes; shift ;;
    --no) ANSWER=no; shift ;;
    --dir) INSTALL_DIR=${2:?--dir needs a value}; shift 2 ;;
    --bin-dir) BIN_DIR=${2:?--bin-dir needs a value}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) fail "Unknown option $1 (see --help)." ;;
  esac
done
VERSION=${VERSION#v}
case $PORT in '' | *[!0-9]*) [ -z "$PORT" ] || fail "--port must be a number." ;; esac

# ---- the system ---------------------------------------------------------------

[ "$(id -u)" != 0 ] || fail "Run this as the user who will use the Studio, not as root. It asks before using sudo."

OS=$(uname -s)
ARCH=$(uname -m)
case $OS in
  Linux) PLATFORM_OS=linux ;;
  Darwin) PLATFORM_OS=darwin ;;
  *) fail "This installer supports Linux and macOS (on Windows, use WSL). This system is $OS." ;;
esac
case $ARCH in
  x86_64 | amd64) PLATFORM_ARCH=x64 ;;
  aarch64 | arm64) PLATFORM_ARCH=arm64 ;;
  *) fail "This installer supports x86-64 and ARM64 processors. This one is $ARCH." ;;
esac
WSL=0
if [ "$PLATFORM_OS" = linux ] && grep -qi microsoft /proc/version 2>/dev/null; then WSL=1; fi

for tool in tar uname mkdir; do command -v "$tool" >/dev/null 2>&1 || fail "\`$tool\` is needed."; done
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 --proto '=https,http' -o "$2" "$1"; }
  fetch_text() { curl -fsSL --retry 3 "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
  fetch_text() { wget -q -O - "$1"; }
else
  fail "curl or wget is needed."
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is needed to check downloads."
fi

# The sum listed for <file> in a SHA256SUMS-style list must match the file.
verify() {
  local file=$1 sums=$2 expected actual
  expected=$(awk -v name="$(basename "$file")" '$2 == name || $2 == "*" name { print $1 }' "$sums" | head -n 1)
  [ -n "$expected" ] || fail "$(basename "$file") is not listed in $(basename "$sums")."
  actual=$(sha256 "$file")
  [ "$actual" = "$expected" ] || fail "$(basename "$file") does not match its published SHA-256 sum. Nothing was installed."
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/agent-studio-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# ---- which release ------------------------------------------------------------

if [ -n "${AGENT_STUDIO_RELEASE_BASE:-}" ]; then
  # A folder with the release files (used by tests and mirrors).
  BASE=${AGENT_STUDIO_RELEASE_BASE%/}
  if [ -z "$VERSION" ]; then
    fetch "$BASE/SHA256SUMS" "$WORK/SHA256SUMS"
    VERSION=$(sed -n 's/.*agent-studio-\(.*\)\.tar\.gz$/\1/p' "$WORK/SHA256SUMS" | head -n 1)
  fi
else
  if [ -z "$VERSION" ]; then
    step "Finding the newest release"
    # Pre-releases count: the API lists every release, newest first.
    VERSION=$(fetch_text "https://api.github.com/repos/$REPO/releases?per_page=20" |
      awk -F'"' '/"tag_name":/ { tag = $4 } /"name": "agent-studio-.*\.tar\.gz"/ && tag != "" { print tag; exit }')
    VERSION=${VERSION#v}
    [ -n "$VERSION" ] || fail "No release with an installable package was found on github.com/$REPO."
  fi
  BASE=https://github.com/$REPO/releases/download/v$VERSION
fi
[ -n "$VERSION" ] || fail "Could not tell which version to install."
ARCHIVE=agent-studio-$VERSION.tar.gz

step "Downloading Agent Cloud Studio $VERSION"
fetch "$BASE/SHA256SUMS" "$WORK/SHA256SUMS"
fetch "$BASE/$ARCHIVE" "$WORK/$ARCHIVE"
verify "$WORK/$ARCHIVE" "$WORK/SHA256SUMS"
note "checked against SHA256SUMS"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if gh attestation verify "$WORK/$ARCHIVE" -R "$REPO" >/dev/null 2>&1; then
    note "build provenance verified (built by this repository's release workflow)"
  else
    note "could not verify build provenance with gh; the SHA-256 check passed"
  fi
fi

# ---- Node.js ------------------------------------------------------------------

node_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' >/dev/null 2>&1
}

mkdir -p "$INSTALL_DIR/runtime" "$INSTALL_DIR/releases"
if [ -n "${AGENT_STUDIO_NODE:-}" ]; then
  node_ok "$AGENT_STUDIO_NODE" || fail "AGENT_STUDIO_NODE ($AGENT_STUDIO_NODE) is not Node.js 22.13 or newer."
else
  NODE_NAME=node-v$NODE_VERSION-$PLATFORM_OS-$PLATFORM_ARCH
  NODE_HOME=$INSTALL_DIR/runtime/$NODE_NAME
  if [ ! -x "$NODE_HOME/bin/node" ]; then
    step "Downloading Node.js $NODE_VERSION (a private copy; your system's Node is not touched)"
    fetch "$NODE_MIRROR/v$NODE_VERSION/SHASUMS256.txt" "$WORK/SHASUMS256.txt"
    fetch "$NODE_MIRROR/v$NODE_VERSION/$NODE_NAME.tar.gz" "$WORK/$NODE_NAME.tar.gz"
    verify "$WORK/$NODE_NAME.tar.gz" "$WORK/SHASUMS256.txt"
    tar -xzf "$WORK/$NODE_NAME.tar.gz" -C "$WORK"
    rm -rf "$NODE_HOME"
    mv "$WORK/$NODE_NAME" "$NODE_HOME"
  fi
  node_ok "$NODE_HOME/bin/node" || fail "The downloaded Node.js does not run on this system."
  ln -sfn "$NODE_NAME" "$INSTALL_DIR/runtime/current"
fi

# ---- the release --------------------------------------------------------------

step "Installing into $INSTALL_DIR"
tar -xzf "$WORK/$ARCHIVE" -C "$WORK"
[ -f "$WORK/agent-studio-$VERSION/bin/agent-studio" ] || fail "The package does not look like an Agent Cloud Studio release."
rm -rf "$INSTALL_DIR/releases/$VERSION"
mv "$WORK/agent-studio-$VERSION" "$INSTALL_DIR/releases/$VERSION"
ln -sfn "releases/$VERSION" "$INSTALL_DIR/current"

mkdir -p "$BIN_DIR"
cat >"$BIN_DIR/agent-studio" <<EOF
#!/bin/sh
# Written by the Agent Cloud Studio installer. Runs the release that is current.
AGENT_STUDIO_INSTALL_DIR='$INSTALL_DIR' exec '$INSTALL_DIR/current/bin/agent-studio' "\$@"
EOF
chmod 755 "$BIN_DIR/agent-studio"
STUDIO=$BIN_DIR/agent-studio
[ -z "${AGENT_STUDIO_NODE:-}" ] || export AGENT_STUDIO_NODE

# Settings: created once, never overwritten. The port given now is written in.
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/env" ]; then
  cat >"$CONFIG_DIR/env" <<'EOF'
# Agent Cloud Studio settings: one AGENT_STUDIO_NAME=value per line.
# Every setting is described in docs/configuration.md. After a change, run
#   agent-studio service restart
#
# AGENT_STUDIO_PORT=7420
# AGENT_STUDIO_PUBLIC_ORIGINS=https://studio.example.com
EOF
  chmod 600 "$CONFIG_DIR/env"
fi
if [ -n "$PORT" ]; then
  grep -v '^AGENT_STUDIO_PORT=' "$CONFIG_DIR/env" >"$WORK/env" || true
  printf 'AGENT_STUDIO_PORT=%s\n' "$PORT" >>"$WORK/env"
  cat "$WORK/env" >"$CONFIG_DIR/env"
fi
# A Node.js named for this installation is remembered, so the service uses it too.
if [ -n "${AGENT_STUDIO_NODE:-}" ]; then
  grep -v '^AGENT_STUDIO_NODE=' "$CONFIG_DIR/env" >"$WORK/env" || true
  printf 'AGENT_STUDIO_NODE=%s\n' "$AGENT_STUDIO_NODE" >>"$WORK/env"
  cat "$WORK/env" >"$CONFIG_DIR/env"
fi
setting() { sed -n "s/^$1=//p" "$CONFIG_DIR/env" | tail -n 1; }
LISTEN_PORT=$(setting AGENT_STUDIO_PORT)
LISTEN_PORT=${LISTEN_PORT:-7420}

# ---- the sandbox (Linux) ------------------------------------------------------

sandbox_works() {
  bwrap --bind / / --unshare-pid --proc /proc --die-with-parent -- true >/dev/null 2>&1
}

install_package() {
  local package=$1
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y "$package"
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y "$package"
  elif command -v yum >/dev/null 2>&1; then sudo yum install -y "$package"
  elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --noconfirm "$package"
  elif command -v zypper >/dev/null 2>&1; then sudo zypper --non-interactive install "$package"
  elif command -v apk >/dev/null 2>&1; then sudo apk add "$package"
  else return 1
  fi
}

SANDBOX=off
if [ "$PLATFORM_OS" = linux ]; then
  step "Checking the agent sandbox (bubblewrap)"
  if ! command -v bwrap >/dev/null 2>&1; then
    note "Without bubblewrap, commands that agents run are not sandboxed and Codex stays switched off."
    if ask "    Install bubblewrap now (uses sudo)?"; then
      install_package bubblewrap || note "Could not install it automatically; install the \`bubblewrap\` package yourself."
    fi
  fi
  if command -v bwrap >/dev/null 2>&1; then
    if sandbox_works; then
      SANDBOX=on
    elif [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] && [ -d /etc/apparmor.d ]; then
      # Ubuntu 23.10 and later let only programs with an AppArmor profile use user namespaces.
      note "This system allows user namespaces only to programs with an AppArmor profile."
      if ask "    Add a profile that lets bubblewrap use them (writes /etc/apparmor.d/bwrap, uses sudo)?"; then
        printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' '' \
          "profile bwrap $(command -v bwrap) flags=(unconfined) {" '  userns,' '  include if exists <local/bwrap>' '}' |
          sudo tee /etc/apparmor.d/bwrap >/dev/null
        sudo apparmor_parser -r /etc/apparmor.d/bwrap || true
        if sandbox_works; then SANDBOX=on; fi
      fi
    fi
  fi
  if [ "$SANDBOX" = on ]; then
    note "the sandbox works"
  else
    note "the sandbox is off — see docs/guides/operations.md (\"The sandbox is off\") to turn it on later"
  fi
else
  note "macOS has no sandbox for agents; Codex stays switched off unless you allow it (see SECURITY.md)."
fi

# ---- the service --------------------------------------------------------------

HEALTH=http://127.0.0.1:$LISTEN_PORT/api/health
running() { fetch_text "$HEALTH" 2>/dev/null | grep -q '"ok"'; }

STARTED=0
if [ "$SERVICE" = 1 ]; then
  step "Starting the background service"
  if "$STUDIO" service install; then
    for _ in $(seq 1 60); do
      if running; then STARTED=1; break; fi
      sleep 0.5
    done
    [ "$STARTED" = 1 ] || note "The service did not answer at $HEALTH yet. Look at \`agent-studio service logs\`."
  else
    note "Start it yourself with: agent-studio start"
    if [ "$WSL" = 1 ]; then
      note "On WSL, a background service needs systemd: add \"[boot]\" / \"systemd=true\" to /etc/wsl.conf, then run \`wsl --shutdown\` from Windows."
    fi
  fi
fi

# ---- done ---------------------------------------------------------------------

printf '\n%sAgent Cloud Studio %s is installed.%s\n\n' "$BOLD" "$VERSION" "$RESET"
if [ "$STARTED" = 1 ]; then
  TOKEN=$("$STUDIO" setup-token 2>/dev/null | head -n 1) || TOKEN=
  printf '  Open      http://127.0.0.1:%s   (on this machine)\n' "$LISTEN_PORT"
  if [ -n "$TOKEN" ]; then
    printf '  Token     %s   (once, to create the owner account)\n' "$TOKEN"
  fi
else
  printf '  Start     agent-studio start\n'
  printf '  Open      http://127.0.0.1:%s, with the one-time token the server prints\n' "$LISTEN_PORT"
fi
printf '  Manage    agent-studio service status | restart | logs\n'
printf '  Settings  %s/env\n' "$CONFIG_DIR"
DATA_DIR=$(setting AGENT_STUDIO_DATA_DIR)
printf '  Data      %s\n' "${DATA_DIR:-$HOME/.agent-studio}"
# shellcheck disable=SC2016 # the line to copy keeps $PATH as it is
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\n  %s is not on your PATH. Add this line to your shell profile:\n      export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" ;;
esac
printf '\n  %sNext: sign in to the agent CLIs you use (claude, codex) or add an API key under Settings → Models.\n' "$DIM"
printf '  To reach the Studio from your phone, see docs/deployment/remote-access.md.%s\n\n' "$RESET"
