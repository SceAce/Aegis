#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AEGIS_BASE="$BASE_DIR/Pi_Agent_base"
SEED_DEFAULT="$BASE_DIR/knowledge/sql-injection-reference.json"
PROXY_DEFAULT="http://127.0.0.1:7897"
TASK_ID=""
SESSION_ID=""
SEED_FILE=""
PROXY=""
PREPARE=0
COMPILE_FILE=""
MODEL_PROXY=0

usage() {
	cat <<'EOF'
Usage:
  ./run-ram-test.sh [options] [-- pi-options...]

Starts an interactive Aegis Pi session in the caller's current directory.
The caller's current directory is the task workspace.

Options:
  --task-id ID       Explicit safe task/session id; default ram-test-<uuid>
  --session-id ID    Resume/create this Pi session id; defaults to task id
  --seed FILE        Inject a bounded, unverified RAM reference JSON
  --sql-wiki         Use the committed SQL reference seed
  --compile FILE.md  Compile Markdown to a bounded seed under runtime/seed-cache
  --prepare-sql-wiki Fetch the bounded CTF Wiki SQL page through the local proxy
  --proxy URL        Proxy used only by --prepare-sql-wiki
  --proxy-model      Also export the proxy for this Pi process (opt-in)
  --no-seed          Do not inject a RAM reference
  --help             Show this help

All remaining arguments after `--` are passed to run-pi.sh.
EOF
}

safe_id() {
	[[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "invalid id: $1" >&2; exit 2; }
}

while (($#)); do
	case "$1" in
		--task-id) TASK_ID="${2:-}"; shift 2 ;;
		--session-id) SESSION_ID="${2:-}"; shift 2 ;;
		--seed) SEED_FILE="${2:-}"; shift 2 ;;
		--sql-wiki) SEED_FILE="$SEED_DEFAULT"; shift ;;
		--prepare-sql-wiki) PREPARE=1; shift ;;
		--compile) COMPILE_FILE="${2:-}"; shift 2 ;;
		--proxy) PROXY="${2:-}"; shift 2 ;;
		--proxy-model) MODEL_PROXY=1; shift ;;
		--no-seed) SEED_FILE=""; shift ;;
		--help|-h) usage; exit 0 ;;
		--) shift; break ;;
		*) echo "unknown launcher option: $1 (use -- before Pi options)" >&2; exit 2 ;;
	esac
done

if [[ -z "$TASK_ID" ]]; then TASK_ID="ram-test-$(uuidgen | tr '[:upper:]' '[:lower:]')"; fi
safe_id "$TASK_ID"
if [[ -n "$SESSION_ID" ]]; then safe_id "$SESSION_ID"; else SESSION_ID="$TASK_ID"; fi

if ((PREPARE)); then
	PROXY="${PROXY:-$PROXY_DEFAULT}"
	mkdir -p "$BASE_DIR/Pi_Agent_base/runtime/dev/wiki-fetch"
	curl --proxy "$PROXY" --location --fail --silent --show-error --max-time 25 --max-filesize 300000 \
		'https://ctf-wiki.org/web/sqli/' \
		-o "$BASE_DIR/Pi_Agent_base/runtime/dev/wiki-fetch/sql-injection.html"
	echo "Fetched bounded source page to ignored runtime/dev/wiki-fetch/sql-injection.html" >&2
	SEED_FILE="$SEED_DEFAULT"
fi
if [[ -n "$COMPILE_FILE" ]]; then
	[[ -f "$COMPILE_FILE" ]] || { echo "Markdown source not found: $COMPILE_FILE" >&2; exit 2; }
	[[ "$COMPILE_FILE" = /* ]] || COMPILE_FILE="$(cd "$(dirname "$COMPILE_FILE")" && pwd)/$(basename "$COMPILE_FILE")"
	SEED_FILE="$AEGIS_BASE/runtime/seed-cache/$(basename "${COMPILE_FILE%.*}").seed.json"
	mkdir -p "$AEGIS_BASE/runtime/seed-cache"
	node "$BASE_DIR/compile-document-seed.mjs" --input "$COMPILE_FILE" --output "$SEED_FILE" >&2
fi
if [[ -n "$SEED_FILE" ]]; then
	[[ -f "$SEED_FILE" ]] || { echo "seed file not found: $SEED_FILE" >&2; exit 2; }
fi

ATTEMPT="$AEGIS_BASE/runtime/ram-pilot/$TASK_ID"
mkdir -p "$ATTEMPT/ram" "$ATTEMPT/projections" "$ATTEMPT/experiences"
export AEGIS_TASK_ID="$TASK_ID"
export AEGIS_EVENT_LOG="$ATTEMPT/events.jsonl"
export AEGIS_RAM_DIR="$ATTEMPT/ram"
export AEGIS_HANDOFF_FILE="$ATTEMPT/ram/handoff.json"
export AEGIS_PROJECTION_DIR="$ATTEMPT/projections"
export AEGIS_EXPERIENCE_DIR="$ATTEMPT/experiences"
if [[ -n "$SEED_FILE" ]]; then export AEGIS_RAM_SEED_FILE="$(cd "$(dirname "$SEED_FILE")" && pwd)/$(basename "$SEED_FILE")"; else unset AEGIS_RAM_SEED_FILE; fi
if ((MODEL_PROXY)); then export HTTP_PROXY="${PROXY:-$PROXY_DEFAULT}" HTTPS_PROXY="${PROXY:-$PROXY_DEFAULT}" ALL_PROXY="${PROXY:-$PROXY_DEFAULT}"; fi

printf 'Aegis RAM test\n  workspace: %s\n  task/session: %s\n  attempt: %s\n  seed: %s\n' "$PWD" "$SESSION_ID" "$ATTEMPT" "${AEGIS_RAM_SEED_FILE:-none}" >&2
exec "$AEGIS_BASE/run-pi.sh" --provider maxapi --model deepseek-v4.1-flash --thinking high --session-id "$SESSION_ID" "$@"
