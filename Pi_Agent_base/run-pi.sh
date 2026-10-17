#!/usr/bin/env bash
set -euo pipefail

# This entry point keeps every Pi-owned mutable file below Pi_Agent_base.
# It intentionally runs the built bundle so source changes cannot be used
# accidentally without an explicit offline rebuild.

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$BASE_DIR/pi"
BUNDLE="$PI_DIR/packages/coding-agent/dist/bundle/cli.js"
CONFIG_DIR="$BASE_DIR/config"
AGENT_DIR="${AEGIS_PI_AGENT_DIR:-$CONFIG_DIR/agent}"
SESSION_DIR="${AEGIS_PI_SESSION_DIR:-$CONFIG_DIR/sessions}"
SERVER_DIR="${AEGIS_PI_SERVER_DIR:-$CONFIG_DIR/server}"
OBSERVER="$BASE_DIR/extensions/aegis-observer.ts"
ROM_FILE="$BASE_DIR/agent/ROM.md"
RUNTIME_DIR="$BASE_DIR/runtime"
EVENT_LOG="${AEGIS_EVENT_LOG:-$RUNTIME_DIR/events.jsonl}"
RAM_DIR="${AEGIS_RAM_DIR:-$RUNTIME_DIR/ram}"

if [[ ! -f "$BUNDLE" ]]; then
	printf 'Pi bundle is missing. Build it with:\n  cd %q && npm run build:offline\n' "$PI_DIR" >&2
	exit 1
fi

if [[ ! -f "$OBSERVER" || ! -f "$ROM_FILE" ]]; then
	printf 'Aegis Pi observer or ROM is missing under %q.\n' "$BASE_DIR" >&2
	exit 1
fi

# BSD find is available on macOS. Ignore generated output and dependencies;
# any remaining newer source file means the checked-in bundle is stale.
STALE_SOURCE="$(find "$PI_DIR/packages" -type f \
	-not -path '*/dist/*' \
	-not -path '*/node_modules/*' \
	-newer "$BUNDLE" \
	-print -quit)"
if [[ -n "$STALE_SOURCE" ]]; then
	printf 'Pi source is newer than the built bundle. Rebuild before running:\n  cd %q && npm run build:offline\n' "$PI_DIR" >&2
	exit 1
fi

mkdir -p "$AGENT_DIR" "$SESSION_DIR" "$SERVER_DIR" "$RUNTIME_DIR" "$RAM_DIR" "$(dirname "$EVENT_LOG")"

export PI_CODING_AGENT_DIR="$AGENT_DIR"
export PI_CODING_AGENT_SESSION_DIR="$SESSION_DIR"
export PI_SERVER_DIR="$SERVER_DIR"
export AEGIS_EVENT_LOG="$EVENT_LOG"
export AEGIS_ROM_FILE="$ROM_FILE"
export AEGIS_RAM_DIR="$RAM_DIR"

# Pi requires management commands to be the first CLI argument. These commands
# do not start an agent run, so they do not need the observer extension.
case "${1:-}" in
	install | remove | uninstall | update | list | config | auth)
		exec node "$BUNDLE" "$@"
		;;
esac

exec node "$BUNDLE" --extension "$OBSERVER" "$@"
