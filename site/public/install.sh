#!/usr/bin/env bash
#
# Talos one-line installer.
#
#   curl -fsSL https://talos.allensaji.dev/install.sh | bash
#
# Or, with a custom target dir:
#
#   curl -fsSL https://talos.allensaji.dev/install.sh | TALOS_DIR=$HOME/code/talos bash
#
# Requires: git, node (>= 22), pnpm (>= 9). The script will fail fast with a
# clear message if any of these are missing.

set -euo pipefail

TALOS_DIR="${TALOS_DIR:-$HOME/.local/share/talos}"
TALOS_REPO="${TALOS_REPO:-https://github.com/Allen-Saji/talos.git}"
TALOS_BRANCH="${TALOS_BRANCH:-main}"

PREFIX="[talos:install]"

log()  { printf '%s %s\n' "$PREFIX" "$*"; }
fail() { printf '%s ERROR: %s\n' "$PREFIX" "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 not found on PATH; install $1 and re-run"
}

require git
require node
require pnpm

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node 22+ required (you have $(node -v))"
fi

if [ -d "$TALOS_DIR/.git" ]; then
  log "found existing checkout at $TALOS_DIR; updating"
  git -C "$TALOS_DIR" fetch --quiet origin "$TALOS_BRANCH"
  git -C "$TALOS_DIR" checkout --quiet "$TALOS_BRANCH"
  git -C "$TALOS_DIR" pull --ff-only --quiet
else
  log "cloning $TALOS_REPO into $TALOS_DIR"
  git clone --quiet --branch "$TALOS_BRANCH" "$TALOS_REPO" "$TALOS_DIR"
fi

cd "$TALOS_DIR"

log "installing dependencies"
pnpm install --frozen-lockfile --silent

log "building"
pnpm build > /dev/null

log "linking globally so 'talos' is on PATH"
if pnpm link --global > /dev/null 2>&1; then
  log "linked"
else
  log "global link failed (often needs sudo); to link manually:"
  log "  cd $TALOS_DIR && pnpm link --global"
fi

cat <<EOF

$PREFIX done.

  installed at: $TALOS_DIR

  next:
    talos init       # bootstrap config, wallet, KeeperHub OAuth
    talos repl       # interactive chat after init
    talos doctor     # diagnose any misconfig

  docs: https://talos.allensaji.dev/docs/get-started/overview

EOF
