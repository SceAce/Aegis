#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AEGIS_BASE="$BASE_DIR/Pi_Agent_base"
TASK_ID=""
SESSION_ID=""
SEED_FILE=""
PROXY=""
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
  --seed FILE        Inject one bounded, unverified RAM reference JSON
  --compile FILE.md  Compile Markdown under knowledge/documents for reuse
  --proxy URL        Proxy used by the Pi process with --proxy-model
  --proxy-model      Also export the proxy for this Pi process (opt-in)
  --no-seed          Do not inject a RAM reference
  --help             Show this help

Local knowledge under knowledge/ is recalled automatically. The LLM can refine
selection with aegis_knowledge. --no-seed disables only the explicit seed file.
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

if [[ -n "$COMPILE_FILE" ]]; then
	[[ -f "$COMPILE_FILE" ]] || { echo "Markdown source not found: $COMPILE_FILE" >&2; exit 2; }
	[[ "$COMPILE_FILE" = /* ]] || COMPILE_FILE="$(cd "$(dirname "$COMPILE_FILE")" && pwd)/$(basename "$COMPILE_FILE")"
	SEED_FILE="$BASE_DIR/knowledge/documents/$(basename "${COMPILE_FILE%.*}").seed.json"
	mkdir -p "$BASE_DIR/knowledge/documents"
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
export AEGIS_KNOWLEDGE_DIR="${AEGIS_KNOWLEDGE_DIR:-$BASE_DIR/knowledge}"
if [[ -n "$SEED_FILE" ]]; then export AEGIS_RAM_SEED_FILE="$(cd "$(dirname "$SEED_FILE")" && pwd)/$(basename "$SEED_FILE")"; else unset AEGIS_RAM_SEED_FILE; fi
if ((MODEL_PROXY)); then
	PROXY="${PROXY:-http://127.0.0.1:7897}"
	export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" ALL_PROXY="$PROXY"
fi

printf 'Aegis RAM test\n  workspace: %s\n  task/session: %s\n  attempt: %s\n  seed: %s\n' "$PWD" "$SESSION_ID" "$ATTEMPT" "${AEGIS_RAM_SEED_FILE:-none}" >&2
exec "$AEGIS_BASE/run-pi.sh" --provider maxapi --model deepseek-v4.1-flash --thinking high --session-id "$SESSION_ID" "$@"
