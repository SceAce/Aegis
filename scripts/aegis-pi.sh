#!/usr/bin/env bash
#
# Launch the Aegis pi FORK, not the upstream checkout.
#
# Why this exists: `~/My_github/pi/pi-test.sh` runs that directory's own source.
# Running it loads the UPSTREAM pi, whose native Observer does not exist, so the
# whole memory loop would silently receive zero events and the run would look
# like "experience had no effect" for the wrong reason.
#
# It prefers the BUILT bundle over running from source. The source path goes
# through tsx, which transpiles the monorepo on every start; that is the
# difference between a responsive TUI and one that stutters. The built entry is
# the shipped one (`bin.pi` = dist/bundle/cli.js) and starts as plain node.
#
# Usage:
#   scripts/aegis-pi.sh --approve --provider deepseek --model deepseek-flash "读 manual/pwn_1/TASK.md 并照做"
#
# Environment:
#   AEGIS_STATE_DIR   where the Observer writes (default: <repo>/.aegis)
#   AEGIS_CHALLENGE   current challenge id (drives guard scoping)
#   AEGIS_PI_SOURCE=1 force the tsx/source path (for the experimental CLI)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI="$ROOT/vendor/pi"
BUNDLE="$PI/packages/coding-agent/dist/bundle/cli.js"
SRC_CLI="$PI/packages/coding-agent/src/experimental/cli.ts"

if [ ! -f "$SRC_CLI" ]; then
  echo "vendor/pi is missing its source. Rebuild it with:" >&2
  echo "  git clone --depth 1 file://\$HOME/My_github/pi vendor/pi" >&2
  exit 1
fi

# The fork is a clone of the same commit, so its dependency tree is identical.
# Linking beats reinstalling 281M, and it cannot silently drift: a real
# `npm install --ignore-scripts` in vendor/pi overrides the link.
if [ ! -e "$PI/node_modules" ]; then
  if [ -d "$HOME/My_github/pi/node_modules" ]; then
    ln -s "$HOME/My_github/pi/node_modules" "$PI/node_modules"
  else
    echo "no node_modules to link; run: (cd vendor/pi && npm install --ignore-scripts)" >&2
    exit 1
  fi
fi

export AEGIS_STATE_DIR="${AEGIS_STATE_DIR:-$ROOT/.aegis}"

# Generated model data is gitignored upstream, so a fresh clone lacks it and
# startup dies with ERR_MODULE_NOT_FOUND on providers/data/*.json. Copy it from
# the upstream checkout when present; it is small and regenerated upstream.
DATA="$PI/packages/ai/src/providers/data"
UPSTREAM_DATA="$HOME/My_github/pi/packages/ai/src/providers/data"
if [ ! -d "$DATA" ] && [ -d "$UPSTREAM_DATA" ]; then
  cp -R "$UPSTREAM_DATA" "$DATA"
fi

# Assert the observer is actually present on whichever path we take. A silent
# fallback to an observer-less pi is the failure this whole script exists to
# prevent, so both paths are checked rather than assumed.
observer_in_bundle() {
  # The bundle is chunked, so grepping cli.js alone reports a false negative.
  grep -ql "aegis-observer" "$BUNDLE" 2>/dev/null && return 0
  grep -rlq "aegis-observer" "$PI/packages/coding-agent/dist/bundle/chunks" 2>/dev/null
}

if [ "${AEGIS_PI_SOURCE:-0}" != "1" ] && [ -f "$BUNDLE" ]; then
  if ! observer_in_bundle; then
    echo "REFUSING to start: the built bundle has no observer." >&2
    echo "It is stale. Rebuild:  (cd vendor/pi && npm run build:offline)" >&2
    echo "Or run from source:    AEGIS_PI_SOURCE=1 $0 ..." >&2
    exit 1
  fi
  exec node "$BUNDLE" "$@"
fi

if [ ! -f "$PI/packages/coding-agent/src/extensions/observer/index.ts" ]; then
  echo "the fork has no observer extension; refusing to start" >&2
  exit 1
fi

exec "$PI/node_modules/.bin/tsx" --tsconfig "$PI/tsconfig.json" "$SRC_CLI" "$@"
