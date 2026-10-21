#!/usr/bin/env bash
set -euo pipefail
umask 077

# This entry point keeps every Pi-owned mutable file below AEGIS_HOME.
# It intentionally runs the built bundle so source changes cannot be used
# accidentally without an explicit offline rebuild.

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$BASE_DIR/pi"
BUNDLE="$PI_DIR/packages/coding-agent/dist/bundle/cli.js"
OBSERVER="$BASE_DIR/extensions/aegis-observer.ts"
ROM_FILE="$BASE_DIR/agent/ROM.md"
CALLER_PWD="$(pwd -P)"
AEGIS_HOME="${AEGIS_HOME:-${HOME:-$BASE_DIR}/.Aegis}"
if [[ "$AEGIS_HOME" != /* ]]; then AEGIS_HOME="$CALLER_PWD/$AEGIS_HOME"; fi

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

mkdir -p "$AEGIS_HOME"
AEGIS_HOME="$(cd "$AEGIS_HOME" && pwd -P)"
CONFIG_DIR="$AEGIS_HOME/agent"
AGENT_DIR="${AEGIS_PI_AGENT_DIR:-$CONFIG_DIR}"
SESSION_DIR="${AEGIS_PI_SESSION_DIR:-$AEGIS_HOME/sessions}"
SERVER_DIR="${AEGIS_PI_SERVER_DIR:-$AEGIS_HOME/server}"
RUNTIME_DIR="$AEGIS_HOME/runtime"
EVENT_LOG="${AEGIS_EVENT_LOG:-$RUNTIME_DIR/events.jsonl}"
RAM_DIR="${AEGIS_RAM_DIR:-$RUNTIME_DIR/ram}"
mkdir -p "$AGENT_DIR" "$SESSION_DIR" "$SERVER_DIR" "$RUNTIME_DIR" "$RAM_DIR" "$(dirname "$EVENT_LOG")"

export AEGIS_HOME
# Knowledge lives in the Aegis home now (the repository copy is deprecated). Only
# set it when the directory exists, so an explicit AEGIS_KNOWLEDGE_DIR always wins
# and a missing tree never turns into a silently empty knowledge base.
if [[ -z "${AEGIS_KNOWLEDGE_DIR:-}" && -d "$AEGIS_HOME/knowledge" ]]; then
	export AEGIS_KNOWLEDGE_DIR="$AEGIS_HOME/knowledge"
fi
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
