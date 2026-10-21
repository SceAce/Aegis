#!/usr/bin/env bash
# Aegis experiment launcher.
#
#   ./run-experiment.sh ram-001
#
# One positional label is enough. Every path the run needs is derived from it,
# the workspace is created for you, and the resolved values are recorded so the
# run can be reproduced. Nothing is guessed silently: `--dry-run` prints exactly
# what would be exported before anything starts.
#
# Layout (default root $AEGIS_HOME/experiments):
#
#   <root>/<label>/run.json        resolved parameters + repo revision
#   <root>/<label>/workspace/      the task workspace (cwd for the session)
#   <root>/<label>/runtime/        event log, RAM, projections, experiences
#   <root>/<label>/sessions/       Pi sessions
#   <root>/<label>/server/         Pi server state
#   <root>/<label>/agent/          only with --isolate-agent
#
# Credentials are NOT experiment state. The agent directory (auth.json,
# models.json, settings.json, mcp.json) defaults to $AEGIS_HOME/agent and is
# shared, because isolating it would leave every run unauthenticated. Sessions,
# server state and the event log stay per-experiment.
#
# Isolation rules kept from run-aegis.sh:
#   * never reads or writes ~/.pi
#   * an existing experiment is NEVER overwritten; use --resume or a new label
#   * no credentials are written into run.json or printed
set -euo pipefail
umask 077

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AEGIS_BASE="$BASE_DIR/Pi_Agent_base"
AEGIS_HOME="${AEGIS_HOME:-${HOME:-$BASE_DIR}/.Aegis}"
EXPERIMENTS_ROOT="${AEGIS_EXPERIMENTS_ROOT:-$AEGIS_HOME/experiments}"

LABEL=""
MODE="new"           # new | resume
ENTRY="source"       # source | bundle
WORKSPACE=""
MODEL=""
PROVIDER=""
THINKING=""
TASK_ID=""
SEED_FILE=""
KNOWLEDGE_DIR=""
AGENT_DIR_OVERRIDE=""
ISOLATE_AGENT=0
DRY_RUN=0
LIST=0
PASSTHROUGH=()

usage() {
	cat <<'USAGE'
Aegis experiment launcher

Usage:
  ./run-experiment.sh <label> [options] [-- <extra aegis args>]

The label is the only required argument. Everything else is derived:
workspace, event log, RAM, projections, experiences, sessions and server state
all live under $AEGIS_HOME/experiments/<label>.

Options:
  --workspace DIR     use DIR as the task workspace (default: <label>/workspace)
  --resume            reuse an existing <label> instead of refusing
  --bundle            launch the built bundle (run-pi.sh) instead of source
  --model PROVIDER/MODEL
  --provider NAME     provider id (only with --model omitted)
  --thinking LEVEL    off|minimal|low|medium|high|max
  --task-id ID        explicit task id (default: the label)
  --seed FILE         inject one bounded, unverified RAM reference
  --knowledge DIR     knowledge root (default: $AEGIS_HOME/knowledge if present,
                      else the repository knowledge/)
  --agent-dir DIR     Pi agent dir (auth/models/settings). Default:
                      $AEGIS_HOME/agent, i.e. your normal credentials.
  --isolate-agent     use a private, empty agent dir for this run. You will have
                      to authenticate inside it first; credentials are never
                      copied for you.
  --dry-run           print the resolved configuration and exit
  --list              list existing experiments and exit
  -h, --help          this help

Behaviour worth knowing:
  * An existing label is refused unless --resume is given. Reusing an event log
    by accident would mix Episodes and corrupt independence counts.
  * Sessions, server state and the event log are per-experiment; credentials
    and model settings are shared unless --isolate-agent is given.
  * --dry-run changes nothing on disk except creating the experiment directory
    only when it does not exist yet; with --list nothing is created at all.
USAGE
}

die() {
	printf 'run-experiment: %s\n' "$1" >&2
	exit "${2:-2}"
}

while (($#)); do
	case "$1" in
		--workspace) WORKSPACE="${2:-}"; shift 2 ;;
		--resume) MODE="resume"; shift ;;
		--bundle) ENTRY="bundle"; shift ;;
		--model) MODEL="${2:-}"; shift 2 ;;
		--provider) PROVIDER="${2:-}"; shift 2 ;;
		--thinking) THINKING="${2:-}"; shift 2 ;;
		--task-id) TASK_ID="${2:-}"; shift 2 ;;
		--seed) SEED_FILE="${2:-}"; shift 2 ;;
		--knowledge) KNOWLEDGE_DIR="${2:-}"; shift 2 ;;
		--agent-dir) AGENT_DIR_OVERRIDE="${2:-}"; shift 2 ;;
		--isolate-agent) ISOLATE_AGENT=1; shift ;;
		--dry-run) DRY_RUN=1; shift ;;
		--list) LIST=1; shift ;;
		-h | --help) usage; exit 0 ;;
		--) shift; PASSTHROUGH=("$@"); break ;;
		-*) usage >&2; die "unknown option: $1" ;;
		*)
			[[ -z "$LABEL" ]] || die "only one label is accepted (got '$LABEL' and '$1')"
			LABEL="$1"
			shift
			;;
	esac
done

if ((LIST)); then
	if [[ ! -d "$EXPERIMENTS_ROOT" ]]; then
		printf 'no experiments yet under %s\n' "$EXPERIMENTS_ROOT"
		exit 0
	fi
	printf 'experiments under %s\n' "$EXPERIMENTS_ROOT"
	for dir in "$EXPERIMENTS_ROOT"/*/; do
		[[ -d "$dir" ]] || continue
		name="$(basename "$dir")"
		created="?"
		if [[ -f "$dir/run.json" ]]; then
			created="$(sed -n 's/.*"created_at": *"\([^"]*\)".*/\1/p' "$dir/run.json" | head -1)"
		fi
		events="none"
		[[ -f "$dir/runtime/events.jsonl" ]] && events="$(wc -l <"$dir/runtime/events.jsonl" | tr -d ' ') events"
		printf '  %-28s %-22s %s\n' "$name" "${created:--}" "$events"
	done
	exit 0
fi

[[ -n "$LABEL" ]] || {
	usage >&2
	die "a label is required, e.g. ./run-experiment.sh ram-001"
}
[[ "$LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "invalid label '$LABEL': use letters, digits, dot, dash, underscore"
[[ "$LABEL" == *..* ]] && die "invalid label '$LABEL': '..' is not allowed"

for f in "$AEGIS_BASE/run-aegis.sh" "$AEGIS_BASE/run-pi.sh" "$AEGIS_BASE/agent/ROM.md"; do
	[[ -f "$f" ]] || die "missing required file: ${f#"$BASE_DIR"/}" 1
done

if [[ "$ENTRY" == "bundle" ]]; then
	[[ -f "$AEGIS_BASE/pi/packages/coding-agent/dist/bundle/cli.js" ]] ||
		die "run-pi.sh needs the pi bundle; build it with ./install.sh --build-bundle" 1
fi

EXP_DIR="$EXPERIMENTS_ROOT/$LABEL"
if [[ -d "$EXP_DIR" ]]; then
	if [[ "$MODE" != "resume" ]]; then
		die "experiment '$LABEL' already exists at $EXP_DIR
  continue it with:  ./run-experiment.sh $LABEL --resume
  or start a new one: ./run-experiment.sh $LABEL-$(date +%H%M)"
	fi
else
	[[ "$MODE" == "resume" ]] && die "--resume was given but '$LABEL' does not exist at $EXP_DIR"
fi

# --- derive paths ----------------------------------------------------------
mkdir -p "$EXP_DIR"
EXP_DIR="$(cd "$EXP_DIR" && pwd -P)"
WORKSPACE="${WORKSPACE:-$EXP_DIR/workspace}"
RUNTIME_DIR="$EXP_DIR/runtime"
RAM_DIR="$RUNTIME_DIR/ram"
PROJECTION_DIR="$RUNTIME_DIR/projections"
EXPERIENCE_DIR="$RUNTIME_DIR/experiences"
EVENT_LOG="$RUNTIME_DIR/events.jsonl"
HANDOFF_FILE="$RAM_DIR/handoff.json"
SESSION_DIR="$EXP_DIR/sessions"
SERVER_DIR="$EXP_DIR/server"

# Credentials and model settings are user configuration, not experiment state.
# Isolating them by default makes every run start unauthenticated, so the
# default is the shared Aegis agent dir; --isolate-agent opts into a private
# empty one (the user then authenticates inside it).
if [[ -n "$AGENT_DIR_OVERRIDE" ]]; then
	AGENT_MODE="explicit"
	AGENT_DIR="$AGENT_DIR_OVERRIDE"
	[[ "$AGENT_DIR" = /* ]] || AGENT_DIR="$PWD/$AGENT_DIR"
elif ((ISOLATE_AGENT)); then
	AGENT_MODE="isolated"
	AGENT_DIR="$EXP_DIR/agent"
else
	AGENT_MODE="shared"
	AGENT_DIR="$AEGIS_HOME/agent"
fi

if [[ -z "$TASK_ID" ]]; then
	TASK_ID="$LABEL"
fi
[[ "$TASK_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "invalid --task-id '$TASK_ID'"

if [[ -z "$KNOWLEDGE_DIR" ]]; then
	# Match what the runtime would do, but prefer the Aegis home when it exists,
	# so a wiki built with build-ctf-wiki-memory.mjs is actually found.
	if [[ -d "$AEGIS_HOME/knowledge" ]]; then
		KNOWLEDGE_DIR="$AEGIS_HOME/knowledge"
	else
		KNOWLEDGE_DIR="$BASE_DIR/knowledge"
	fi
fi
[[ "$KNOWLEDGE_DIR" = /* ]] || KNOWLEDGE_DIR="$PWD/$KNOWLEDGE_DIR"
[[ -d "$KNOWLEDGE_DIR" ]] || die "knowledge directory not found: $KNOWLEDGE_DIR"

if [[ -n "$SEED_FILE" ]]; then
	[[ "$SEED_FILE" = /* ]] || SEED_FILE="$PWD/$SEED_FILE"
	[[ -f "$SEED_FILE" ]] || die "seed file not found: $SEED_FILE"
fi

if [[ -n "$WORKSPACE" ]]; then
	[[ "$WORKSPACE" = /* ]] || WORKSPACE="$PWD/$WORKSPACE"
fi

for f in "$WORKSPACE" "$RUNTIME_DIR" "$RAM_DIR" "$PROJECTION_DIR" "$EXPERIENCE_DIR" \
	"$SESSION_DIR" "$SERVER_DIR"; do
	[[ -d "$f" ]] || mkdir -p "$f"
done
# The agent dir is only created when this run owns it. A shared or explicit dir
# must already exist: creating an empty one would silently drop the credentials.
if [[ "$AGENT_MODE" != "shared" ]]; then
	[[ -d "$AGENT_DIR" ]] || mkdir -p "$AGENT_DIR"
fi
chmod 700 "$EXP_DIR" 2>/dev/null || true

AUTH_WARNING=""
if [[ "$AGENT_MODE" == "shared" ]]; then
	[[ -d "$AGENT_DIR" ]] || die "shared agent dir does not exist: $AGENT_DIR
  create it or point at one with --agent-dir" 1
	if [[ ! -f "$AGENT_DIR/auth.json" ]]; then
		AUTH_WARNING="no auth.json in $AGENT_DIR; the model will start unauthenticated"
	fi
fi

# --- export the run's environment -----------------------------------------
export AEGIS_HOME
export AEGIS_TASK_ID="$TASK_ID"
export AEGIS_EVENT_LOG="$EVENT_LOG"
export AEGIS_RAM_DIR="$RAM_DIR"
export AEGIS_HANDOFF_FILE="$HANDOFF_FILE"
export AEGIS_PROJECTION_DIR="$PROJECTION_DIR"
export AEGIS_EXPERIENCE_DIR="$EXPERIENCE_DIR"
export AEGIS_KNOWLEDGE_DIR="$KNOWLEDGE_DIR"
export AEGIS_PI_AGENT_DIR="$AGENT_DIR"
export AEGIS_PI_SESSION_DIR="$SESSION_DIR"
export AEGIS_PI_SERVER_DIR="$SERVER_DIR"
if [[ -n "$SEED_FILE" ]]; then
	export AEGIS_RAM_SEED_FILE="$SEED_FILE"
else
	unset AEGIS_RAM_SEED_FILE
fi
[[ -n "$THINKING" ]] && export AEGIS_THINKING_LEVEL="$THINKING"

# --- record the resolved configuration ------------------------------------
REPO_REV="unknown"
if git -C "$BASE_DIR" rev-parse --short HEAD >/dev/null 2>&1; then
	REPO_REV="$(git -C "$BASE_DIR" rev-parse HEAD)"
fi
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_JSON="$EXP_DIR/run.json"
if [[ ! -f "$RUN_JSON" ]]; then
	cat >"$RUN_JSON" <<JSON
{
  "schema_version": "aegis-experiment-1",
  "label": "$LABEL",
  "task_id": "$TASK_ID",
  "created_at": "$NOW",
  "repo_revision": "$REPO_REV",
  "entry": "$ENTRY",
  "workspace": "$WORKSPACE",
  "paths": {
    "event_log": "$EVENT_LOG",
    "ram_dir": "$RAM_DIR",
    "projection_dir": "$PROJECTION_DIR",
    "experience_dir": "$EXPERIENCE_DIR",
    "session_dir": "$SESSION_DIR",
    "server_dir": "$SERVER_DIR",
    "agent_dir": "$AGENT_DIR",
    "knowledge_dir": "$KNOWLEDGE_DIR"
  },
  "agent_mode": "$AGENT_MODE",
  "seed_file": ${SEED_FILE:+\"$SEED_FILE\"}${SEED_FILE:-null},
  "note": "derived parameters only; no credentials are stored here"
}
JSON
else
	printf 'run-experiment: resuming %s (run.json kept from %s)\n' "$LABEL" \
		"$(sed -n 's/.*"created_at": *"\([^"]*\)".*/\1/p' "$RUN_JSON" | head -1)"
fi

# --- summary ---------------------------------------------------------------
printf 'Aegis experiment: %s%s\n' "$LABEL" "$([[ "$MODE" == "resume" ]] && echo ' (resume)')"
printf '  entry      %s\n' "$([[ "$ENTRY" == bundle ]] && echo 'run-pi.sh (bundle)' || echo 'run-aegis.sh (source)')"
printf '  workspace  %s\n' "$WORKSPACE"
printf '  events     %s\n' "$EVENT_LOG"
printf '  ram        %s\n' "$RAM_DIR"
printf '  knowledge  %s\n' "$KNOWLEDGE_DIR"
printf '  agent      %s (%s)\n' "$AGENT_DIR" "$AGENT_MODE"
if [[ -n "$AUTH_WARNING" ]]; then
	printf '  warning    %s\n' "$AUTH_WARNING" >&2
fi
printf '  task id    %s\n' "$TASK_ID"
[[ -n "$SEED_FILE" ]] && printf '  seed       %s\n' "$SEED_FILE"
[[ -n "$MODEL" ]] && printf '  model      %s\n' "$MODEL"
printf '  recorded   %s\n' "$RUN_JSON"

if ((DRY_RUN)); then
	printf '\ndry run: nothing started. Environment that would be exported:\n'
	printf '  AEGIS_HOME=%s\n  AEGIS_TASK_ID=%s\n  AEGIS_EVENT_LOG=%s\n  AEGIS_RAM_DIR=%s\n' \
		"$AEGIS_HOME" "$TASK_ID" "$EVENT_LOG" "$RAM_DIR"
	printf '  AEGIS_KNOWLEDGE_DIR=%s\n  AEGIS_PI_AGENT_DIR=%s\n' "$KNOWLEDGE_DIR" "$AGENT_DIR"
	printf '  cwd=%s\n' "$WORKSPACE"
	exit 0
fi

# --- launch ---------------------------------------------------------------
ARGS=()

# run-aegis.sh routes install/remove/update/list/config/auth only when the
# management command is the FIRST argument. Injecting --model in front of it
# silently turns "auth check" into a chat prompt, so management subcommands are
# passed through untouched.
MANAGEMENT_FIRST=0
if (( ${#PASSTHROUGH[@]} )); then
	case "${PASSTHROUGH[0]}" in
		install | remove | uninstall | update | list | config | auth) MANAGEMENT_FIRST=1 ;;
	esac
fi

if ((MANAGEMENT_FIRST)); then
	printf '  note       management command passed through without model flags\n'
	ARGS=("${PASSTHROUGH[@]}")
else
	[[ -n "$MODEL" ]] && ARGS+=(--model "$MODEL")
	[[ -n "$PROVIDER" ]] && ARGS+=(--provider "$PROVIDER")
	if [[ -n "$THINKING" ]]; then
		ARGS+=(--thinking "$THINKING")
	fi
	(( ${#PASSTHROUGH[@]} )) && ARGS+=("${PASSTHROUGH[@]}")
fi

cd "$WORKSPACE"
if [[ "$ENTRY" == "bundle" ]]; then
	exec "$AEGIS_BASE/run-pi.sh" "${ARGS[@]}"
fi
exec "$AEGIS_BASE/run-aegis.sh" "${ARGS[@]}"
