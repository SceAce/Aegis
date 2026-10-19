#!/usr/bin/env bash
set -euo pipefail

# Run the checked-in Pi sources with Aegis isolated state. No build, install,
# bundle fallback, network setup, or user-default Pi directory is used here.
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$BASE_DIR/pi"
CLI="$PI_DIR/packages/coding-agent/src/cli.ts"
SOURCE_RESOLVER="$PI_DIR/packages/coding-agent/src/experimental/source-resolver.ts"
OBSERVER="$BASE_DIR/extensions/aegis-observer.ts"
ROM_FILE="$BASE_DIR/agent/ROM.md"
AEGIS_HOME="${AEGIS_HOME:-$HOME/.Aegis}"
AEGIS_CTF_VENV="${AEGIS_CTF_VENV:-/Users/scemac/Tools/PyVenv/CTF}"
CONFIG_DIR="${AEGIS_HOME}/agent"
RUNTIME_DIR="${AEGIS_HOME}/runtime"
AGENT_DIR="${AEGIS_PI_AGENT_DIR:-$CONFIG_DIR}"
SESSION_DIR="${AEGIS_PI_SESSION_DIR:-${AEGIS_HOME}/sessions}"
SERVER_DIR="${AEGIS_PI_SERVER_DIR:-${AEGIS_HOME}/server}"
EVENT_LOG="${AEGIS_EVENT_LOG:-$RUNTIME_DIR/events.jsonl}"
RAM_DIR="${AEGIS_RAM_DIR:-$RUNTIME_DIR/ram}"

for file in "$CLI" "$SOURCE_RESOLVER" "$OBSERVER" "$ROM_FILE"; do
	if [[ ! -f "$file" ]]; then
		printf 'Required Aegis/Pi source is missing: %s\n' "$file" >&2
		exit 1
	fi
done

if ! command -v node >/dev/null 2>&1; then
	printf 'Node.js is required to run Pi from source.\n' >&2
	exit 1
fi

mkdir -p "$AGENT_DIR" "$SESSION_DIR" "$SERVER_DIR" "$RUNTIME_DIR" "$RAM_DIR" "$(dirname "$EVENT_LOG")"

export AEGIS_HOME
if [[ -x "$AEGIS_CTF_VENV/bin/python" ]]; then
	PATH="$AEGIS_CTF_VENV/bin:$PATH"
	export PATH
	export AEGIS_CTF_VENV
fi
export PI_CODING_AGENT_DIR="$AGENT_DIR"
export PI_CODING_AGENT_SESSION_DIR="$SESSION_DIR"
export PI_SERVER_DIR="$SERVER_DIR"
export AEGIS_EVENT_LOG="$EVENT_LOG"
export AEGIS_ROM_FILE="$ROM_FILE"
export AEGIS_RAM_DIR="$RAM_DIR"
export AEGIS_TUI_SHELL="${AEGIS_TUI_SHELL:-1}"
export AEGIS_TUI_AUTOSTART="${AEGIS_TUI_AUTOSTART:-0}"

# Keep Pi management commands first, as required by the CLI. Normal launches
# always load the Aegis observer extension.
case "${1:-}" in
	install | remove | uninstall | update | list | config | auth)
		exec node --import "$SOURCE_RESOLVER" "$CLI" "$@"
		;;
esac

exec node --import "$SOURCE_RESOLVER" "$CLI" --extension "$OBSERVER" "$@"
