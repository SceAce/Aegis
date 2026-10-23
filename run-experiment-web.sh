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
#
# The browser app lives in the nested Aegis-pocket repository and reuses its
# vendored modules (preact, htm, marked, dompurify). Install them from that
# repository's lockfile with:
#
#   ./install.sh --install-web-deps      (or: ./install.sh --all)
#
# Contract, security boundaries and controls: docs/WEBUI_CONSOLE.md
set -euo pipefail
umask 077

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AEGIS_BASE="$BASE_DIR/Pi_Agent_base"
AEGIS_HOME="${AEGIS_HOME:-${HOME:-$BASE_DIR}/.Aegis}"
ENTRY="$AEGIS_BASE/console-web/entry.mjs"
RESOLVER="$AEGIS_BASE/pi/packages/coding-agent/src/experimental/source-resolver.ts"
UI_DIR="$AEGIS_BASE/UI/Aegis-pocket"

die() {
	printf 'aegis-web: %s\n' "$1" >&2
	exit "${2:-1}"
}

[[ -f "$ENTRY" ]] || die "missing web entry: ${ENTRY#"$BASE_DIR"/}"
[[ -f "$RESOLVER" ]] || die "missing Pi source resolver: ${RESOLVER#"$BASE_DIR"/} (the embedded pi checkout is incomplete)"
[[ -f "$UI_DIR/web/aegis/index.html" ]] ||
	die "missing web UI at ${UI_DIR#"$BASE_DIR"/}
  fetch it with: ./install.sh --clone-ui --install-web-deps"

# Fail closed here instead of serving a page whose modules 404: the browser app
# imports Pocket's vendored modules through the Aegis server.
missing=()
for mod in preact htm marked dompurify; do
	[[ -d "$UI_DIR/node_modules/$mod" ]] || missing+=("$mod")
done
if [[ ${#missing[@]} -gt 0 ]]; then
	die "web UI dependencies are missing (${missing[*]})
  install them from the UI lockfile:  ./install.sh --install-web-deps
  (the command-line entries ./run-experiment.sh and --cli do not need them)"
fi

mkdir -p "$AEGIS_HOME"
AEGIS_HOME="$(cd "$AEGIS_HOME" && pwd -P)"
export AEGIS_HOME

exec node --import "$RESOLVER" "$ENTRY" "$@"
