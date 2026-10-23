#!/usr/bin/env bash
# Aegis Web Console launcher (local, loopback only).
#
#   ./run-experiment-web.sh                 # http://127.0.0.1:7800
#   ./run-experiment-web.sh --port 7801
#
# The web server is a thin adapter: every active task runs in its OWN Experiment
# Host child process (`run-experiment.sh ... -- --control stdio`), which owns the
# experiment lease, the EventLog writer, the Pi SDK runtime, the Observer and the
# execution gates. The server itself never writes task events and never creates
# an agent runtime.
set -euo pipefail
umask 077

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AEGIS_BASE="$BASE_DIR/Pi_Agent_base"
AEGIS_HOME="${AEGIS_HOME:-${HOME:-$BASE_DIR}/.Aegis}"
ENTRY="$AEGIS_BASE/console-web/entry.mjs"
RESOLVER="$AEGIS_BASE/pi/packages/coding-agent/src/experimental/source-resolver.ts"

[[ -f "$ENTRY" ]] || { printf 'missing web entry: %s\n' "$ENTRY" >&2; exit 1; }
[[ -f "$RESOLVER" ]] || { printf 'missing Pi source resolver: %s\n' "$RESOLVER" >&2; exit 1; }
mkdir -p "$AEGIS_HOME"
AEGIS_HOME="$(cd "$AEGIS_HOME" && pwd -P)"
export AEGIS_HOME

exec node --import "$RESOLVER" "$ENTRY" "$@"
