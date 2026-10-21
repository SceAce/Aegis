#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run the checked-in Pi sources with Aegis isolated state. No build, install,
# bundle fallback, network setup, or user-default Pi directory is used here.
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$BASE_DIR/pi"
CLI="$PI_DIR/packages/coding-agent/src/cli.ts"
SOURCE_RESOLVER="$PI_DIR/packages/coding-agent/src/experimental/source-resolver.ts"
OBSERVER="$BASE_DIR/extensions/aegis-observer.ts"
ROM_FILE="$BASE_DIR/agent/ROM.md"
AEGIS_HOME="${AEGIS_HOME:-${HOME:-$BASE_DIR}/.Aegis}"
AEGIS_CTF_VENV="${AEGIS_CTF_VENV:-}"

for file in "$CLI" "$SOURCE_RESOLVER" "$OBSERVER" "$ROM_FILE"; do
	if [[ ! -f "$file" ]]; then
		printf 'Required Aegis/Pi source is missing: %s\n' "$file" >&2
		exit 1
	fi
done

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
	printf 'Node.js is required to run Pi from source.\n' >&2
	exit 1
fi

mkdir -p "$AEGIS_HOME"
AEGIS_HOME="$(cd "$AEGIS_HOME" && pwd -P)"
CONFIG_DIR="$AEGIS_HOME/agent"
RUNTIME_DIR="$AEGIS_HOME/runtime"
AGENT_DIR="${AEGIS_PI_AGENT_DIR:-$CONFIG_DIR}"
SESSION_DIR="${AEGIS_PI_SESSION_DIR:-$AEGIS_HOME/sessions}"
SERVER_DIR="${AEGIS_PI_SERVER_DIR:-$AEGIS_HOME/server}"
EVENT_LOG="${AEGIS_EVENT_LOG:-$RUNTIME_DIR/events.jsonl}"
RAM_DIR="${AEGIS_RAM_DIR:-$RUNTIME_DIR/ram}"
mkdir -p "$AGENT_DIR" "$SESSION_DIR" "$SERVER_DIR" "$RUNTIME_DIR" "$RAM_DIR" "$(dirname "$EVENT_LOG")"

export AEGIS_HOME
# Knowledge lives ONLY in the Aegis home. There is no repository fallback: a
# stale checkout must never be consulted or shadow the operator's local corpus.
if [[ -z "${AEGIS_KNOWLEDGE_DIR:-}" ]]; then
	export AEGIS_KNOWLEDGE_DIR="$AEGIS_HOME/knowledge"
fi
# Web search is a knowledge-gap fallback. It is on by default when a DeepSeek
# key is available in the default agent config; the tool itself fails closed
# when no key is configured. Set AEGIS_WEB_SEARCH=off to disable it.
export AEGIS_WEB_SEARCH="${AEGIS_WEB_SEARCH:-on}"
if [[ -n "$AEGIS_CTF_VENV" ]]; then
	if [[ ! -x "$AEGIS_CTF_VENV/bin/python" ]]; then
		printf 'AEGIS_CTF_VENV must contain an executable bin/python: %s\n' "$AEGIS_CTF_VENV" >&2
		exit 2
	fi
	AEGIS_CTF_VENV="$(cd "$AEGIS_CTF_VENV" && pwd -P)"
	PATH="$AEGIS_CTF_VENV/bin:$PATH"
	export PATH AEGIS_CTF_VENV
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
		exec "$NODE_BIN" --import "$SOURCE_RESOLVER" "$CLI" "$@"
		;;
esac

exec "$NODE_BIN" --import "$SOURCE_RESOLVER" "$CLI" --extension "$OBSERVER" "$@"
