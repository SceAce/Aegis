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

LAUNCH_DIR="$(pwd -P)"
LABEL=""
MODE="new"           # new | resume
ENTRY="source"       # source | bundle
WORKSPACE=""
USE_CWD=0
MODEL=""
PROVIDER=""
THINKING=""
TASK_ID=""
SEED_FILE=""
KNOWLEDGE_DIR=""
KNOWLEDGE_OVERRIDE=0
WEB_SEARCH="${AEGIS_WEB_SEARCH:-on}"
SEARCH_DENY="${AEGIS_SEARCH_DENY:-}"
AGENT_DIR_OVERRIDE=""
ISOLATE_AGENT=0
SCRIPT_CONFIG_OVERRIDE=""
ACTION_MODE=""          # normal (default) | auto
TOOLS=""                # comma list of coding tools (Aegis tools are always on)
ATTACH=()
MAX_ATTACH_BYTES=536870912
MCP_MODE="off"       # off | filtered | all
DRY_RUN=0
LIST=0
CONSOLE_MODE=1
MAX_AUTO_ROTATIONS=""
MAX_CONTINUATIONS=""
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
  --here              use the CURRENT directory as the workspace (no isolation).
                      Use this when the challenge files already sit in a folder.
  --tools LIST        coding tools the model may call, comma separated
                      (read,ls,grep,find,glob,bash,write,edit). Aegis control
                      tools (propose/knowledge/review/...) are always on.
                      Default: read,bash,edit,write
  --action-mode normal|auto
                      authorization for registered script actions. `normal`
                      (default) requires an explicit per-call grant, so a model
                      call is REFUSED; `auto` is a user-granted default path for
                      this run and is recorded with every intent. It is still not
                      a verification result.
  --script-config PATH
                      script roster for aegis_execute (default: the experiment's
                      roster.json, else $AEGIS_HOME/tools/roster.json, else the
                      repository roster.json). Registers tools; see
                      aegis-register-tool.mjs.
  --console           (default) start the resident Aegis Console Host. One
                      process owns the Pi SDK runtime for this label and manages
                      the short Sessions of the same Task/Episode.
  --cli               do NOT use the console: launch the single Pi CLI run.
                      This is the pre-phase-3 behaviour (no Host lifecycle, no
                      automatic Session rotation) and is not the default.
  --max-auto-rotations N
                      trusted Host bound for automatic Session rotations
                      (0-8, default 3). Frozen for the run; the model can never
                      change it.
  --max-continuations N
                      trusted Host bound for total Session generations
                      (1-64, default 12).
  --attach PATH       copy a file or directory into the workspace before launch.
                      Repeatable. An existing destination is never overwritten.
  --max-attach-bytes N
                      refuse attachments larger than N bytes in total
                      (default 536870912 = 512 MiB).
  --resume            reuse an existing <label> instead of refusing
  --bundle            launch the built bundle (run-pi.sh) instead of source
  --model PROVIDER/MODEL
  --provider NAME     provider id (only with --model omitted)
  --thinking LEVEL    off|minimal|low|medium|high|xhigh|max (clamped to the model)
  --task-id ID        explicit task id (default: the label)
  --seed FILE         inject one bounded, unverified RAM reference
  --knowledge DIR     knowledge root (default: $AEGIS_HOME/knowledge; there is no
                      repository fallback)
  --agent-dir DIR     Pi agent dir (auth/models/settings). Default:
                      $AEGIS_HOME/agent, i.e. your normal credentials.
  --isolate-agent     use a private, empty agent dir for this run. You will have
                      to authenticate inside it first; credentials are never
                      copied for you.
  --web-search        enable the DeepSeek technique search (default: on; it needs a
                      DeepSeek key in AEGIS_HOME/agent/auth.json or DEEPSEEK_API_KEY)
  --no-web-search     disable web search for this run
  --search-block LIST local BLOCKLIST, not a query: comma-separated challenge/
                      target tokens that must NEVER appear in a search query or
                      result (in addition to the auto-derived target)
  --search-deny LIST  alias for --search-block (kept for compatibility)
  --mcp               start MCP servers, EXCEPT browser automation. Driving a page
                      (finding selectors, waiting for UI) costs more time than it
                      saves on most tasks, so browsers are disabled by default and
                      the rest (e.g. rea/IDA) are enabled. Implemented as a derived
                      agent dir with those servers set to enabled:false; your global
                      mcp.json is untouched.
  --mcp-all           start EVERY configured MCP server, browsers included.
  --dry-run           print the resolved configuration and exit
  --list              list existing experiments and exit
  -h, --help          this help

Console controls (default entry):
  <text>       send a prompt to the current Task/Episode
  /status      Host state: session id/file, Task/Episode, work-unit/hold, budget
  /pause       stop dispatching; the current Session is kept
  /resume      clear a pause/block after recovery checks
  /stop        dispose the Session, release the lease and exit
  /quit        alias for /stop          /help  list the controls
  Ctrl-D closes the console. The console is line-oriented; Pi's interactive TUI
  is not used by this entry.

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
		--here) USE_CWD=1; shift ;;
		--tools)
			[[ $# -ge 2 ]] || { printf -- '--tools needs a comma-separated list\n' >&2; exit 2; }
			TOOLS="$2"
			shift 2
			;;
		--action-mode)
			[[ $# -ge 2 ]] || { printf -- '--action-mode needs normal or auto\n' >&2; exit 2; }
			ACTION_MODE="$2"
			shift 2
			;;
		--script-config)
			[[ $# -ge 2 ]] || { printf -- '--script-config needs a path\n' >&2; exit 2; }
			SCRIPT_CONFIG_OVERRIDE="$2"
			shift 2
			;;
		--attach)
			[[ $# -ge 2 ]] || { printf -- '--attach needs a path\n' >&2; exit 2; }
			ATTACH+=("$2")
			shift 2
			;;
		--max-attach-bytes)
			[[ $# -ge 2 ]] || { printf -- '--max-attach-bytes needs a value\n' >&2; exit 2; }
			MAX_ATTACH_BYTES="${2:-}"
			shift 2
			;;
		--resume) MODE="resume"; shift ;;
		--console) CONSOLE_MODE=1; shift ;;
		--cli) CONSOLE_MODE=0; shift ;;
		--max-auto-rotations)
			[[ $# -ge 2 ]] || { printf -- '--max-auto-rotations needs a value\n' >&2; exit 2; }
			MAX_AUTO_ROTATIONS="$2"
			shift 2
			;;
		--max-continuations)
			[[ $# -ge 2 ]] || { printf -- '--max-continuations needs a value\n' >&2; exit 2; }
			MAX_CONTINUATIONS="$2"
			shift 2
			;;
		--bundle) ENTRY="bundle"; shift ;;
		--model) MODEL="${2:-}"; shift 2 ;;
		--provider) PROVIDER="${2:-}"; shift 2 ;;
		--thinking) THINKING="${2:-}"; shift 2 ;;
		--task-id) TASK_ID="${2:-}"; shift 2 ;;
		--seed) SEED_FILE="${2:-}"; shift 2 ;;
		--knowledge) KNOWLEDGE_DIR="${2:-}"; KNOWLEDGE_OVERRIDE=1; shift 2 ;;
		--web-search) WEB_SEARCH="on"; shift ;;
		--no-web-search) WEB_SEARCH="off"; shift ;;
		--search-block | --search-deny) SEARCH_DENY="${2:-}"; shift 2 ;;
		--agent-dir) AGENT_DIR_OVERRIDE="${2:-}"; shift 2 ;;
		--isolate-agent) ISOLATE_AGENT=1; shift ;;
		--mcp) MCP_MODE="filtered"; shift ;;
		--mcp-all) MCP_MODE="all"; shift ;;
		--no-mcp) MCP_MODE="off"; shift ;;
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
[[ "$WEB_SEARCH" =~ ^(on|off)$ ]] || die "--web-search value must be on or off"
[[ "$SEARCH_DENY" != *'"'* && "$SEARCH_DENY" != *$'\n'* ]] || die "--search-block must not contain quotes or newlines"
if [[ -n "$THINKING" && ! "$THINKING" =~ ^(off|minimal|low|medium|high|xhigh|max)$ ]]; then
	die "--thinking must be one of off|minimal|low|medium|high|xhigh|max"
fi
if [[ -n "$TOOLS" && ! "$TOOLS" =~ ^[a-z0-9_,]+$ ]]; then
	die "--tools must be a comma-separated list of tool ids"
fi
for pair in "max-auto-rotations:${MAX_AUTO_ROTATIONS}" "max-continuations:${MAX_CONTINUATIONS}"; do
	name="${pair%%:*}"
	value="${pair#*:}"
	[[ -z "$value" || "$value" =~ ^[0-9]+$ ]] || die "--$name must be a whole number"
done

for f in "$AEGIS_BASE/run-aegis.sh" "$AEGIS_BASE/run-pi.sh" "$AEGIS_BASE/agent/ROM.md"; do
	[[ -f "$f" ]] || die "missing required file: ${f#"$BASE_DIR"/}" 1
done

if [[ "$ENTRY" == "bundle" ]]; then
	[[ -f "$AEGIS_BASE/pi/packages/coding-agent/dist/bundle/cli.js" ]] ||
		die "run-pi.sh needs the pi bundle; build it with ./install.sh --build-bundle" 1
fi

EXP_DIR="$EXPERIMENTS_ROOT/$LABEL"
# A resumed run keeps the model/provider it was created with unless the operator
# overrides them. Reading them back from run.json (not re-deriving) means
# `--resume` does not silently fall back to a different provider/auth store.
if [[ "$MODE" == "resume" && (-z "$MODEL" || -z "$PROVIDER") && -f "$EXP_DIR/run.json" ]]; then
	resolved="$(node -e '
		const fs = require("node:fs");
		try {
			const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
			process.stdout.write(`${run.provider ?? ""}\t${run.model ?? ""}`);
		} catch { process.stdout.write("\t"); }
	' "$EXP_DIR/run.json" 2>/dev/null || printf '\t')"
	saved_provider="${resolved%%$'\t'*}"
	saved_model="${resolved#*$'\t'}"
	[[ -z "$PROVIDER" && -n "$saved_provider" ]] && PROVIDER="$saved_provider"
	[[ -z "$MODEL" && -n "$saved_model" ]] && MODEL="$saved_model"
fi
if [[ "$MODE" == "resume" && -z "$THINKING" && -f "$EXP_DIR/run.json" ]]; then
	THINKING="$(node -e '
		const fs = require("node:fs");
		try {
			const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
			process.stdout.write(typeof run.thinking === "string" ? run.thinking : "");
		} catch { process.stdout.write(""); }
	' "$EXP_DIR/run.json" 2>/dev/null || true)"
fi
if [[ "$MODE" == "resume" && -z "$TOOLS" && -f "$EXP_DIR/run.json" ]]; then
	TOOLS="$(node -e '
		const fs = require("node:fs");
		try {
			const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
			process.stdout.write(Array.isArray(run.tools) ? run.tools.join(",") : "");
		} catch { process.stdout.write(""); }
	' "$EXP_DIR/run.json" 2>/dev/null || true)"
fi
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
if ((USE_CWD)); then
	[[ -z "$WORKSPACE" ]] || die "--here and --workspace are mutually exclusive"
	WORKSPACE="$LAUNCH_DIR"
else
	WORKSPACE="${WORKSPACE:-$EXP_DIR/workspace}"
fi
RUNTIME_DIR="$EXP_DIR/runtime"
RAM_DIR="$RUNTIME_DIR/ram"
PROJECTION_DIR="$RUNTIME_DIR/projections"
EXPERIENCE_DIR="$RUNTIME_DIR/experiences"
EVENT_LOG="$RUNTIME_DIR/events.jsonl"
HANDOFF_FILE="$RAM_DIR/handoff.json"
SESSION_DIR="$EXP_DIR/sessions"
SERVER_DIR="$EXP_DIR/server"

# Credentials and model settings are user configuration, not experiment state, so
# they are shared by default. MCP is the one thing that is NOT shared: Pi has no
# global switch and a project-level .pi/mcp.json only applies to a trusted
# project, which we must not grant on the user's behalf. Instead the launcher
# derives an agent dir that links the real credential files and ships an empty
# mcp.json, so no MCP process starts while auth keeps working.
SHARED_AGENT_DIR="$AEGIS_HOME/agent"
if [[ -n "$AGENT_DIR_OVERRIDE" ]]; then
	AGENT_MODE="explicit"
	AGENT_DIR="$AGENT_DIR_OVERRIDE"
	[[ "$AGENT_DIR" = /* ]] || AGENT_DIR="$PWD/$AGENT_DIR"
elif ((ISOLATE_AGENT)); then
	AGENT_MODE="isolated"
	AGENT_DIR="$EXP_DIR/agent"
elif [[ "$MCP_MODE" == "off" ]]; then
	AGENT_MODE="derived-no-mcp"
	AGENT_DIR="$EXP_DIR/agent"
elif [[ "$MCP_MODE" == "filtered" ]]; then
	# MCP on, but browser automation off: driving a page costs more time than it
	# saves on most tasks, so it is opt-in via --mcp-all.
	AGENT_MODE="derived-mcp-filtered"
	AGENT_DIR="$EXP_DIR/agent"
else
	AGENT_MODE="shared"
	AGENT_DIR="$SHARED_AGENT_DIR"
fi

if [[ -z "$TASK_ID" ]]; then
	TASK_ID="$LABEL"
fi
[[ "$TASK_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "invalid --task-id '$TASK_ID'"

if [[ -z "$KNOWLEDGE_DIR" ]]; then
	# The knowledge base lives with the Aegis state home. There is deliberately no
	# repository fallback: a stale checkout must not shadow the operator's corpus.
	KNOWLEDGE_DIR="$AEGIS_HOME/knowledge"
fi
[[ "$KNOWLEDGE_DIR" = /* ]] || KNOWLEDGE_DIR="$PWD/$KNOWLEDGE_DIR"
if [[ ! -d "$KNOWLEDGE_DIR" ]]; then
	if ((KNOWLEDGE_OVERRIDE)); then
		die "knowledge directory not found: $KNOWLEDGE_DIR"
	fi
	mkdir -p "$KNOWLEDGE_DIR" || die "could not create knowledge directory: $KNOWLEDGE_DIR"
	printf 'run-experiment: created empty knowledge directory %s\n' "$KNOWLEDGE_DIR" >&2
fi

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

# --- MCP --------------------------------------------------------------------
# Pi has no global MCP switch, and a project-level .pi/mcp.json is honoured only
# for a TRUSTED project. Granting trust on the operator's behalf is a security
# decision this launcher must not make, so "no MCP by default" is implemented by
# deriving an agent dir: symlink the real credential/config files (Pi writes them
# with writeFileSync, so links survive) and ship an empty mcp.json.
MCP_NOTE=""
AUTH_WARNING=""
LINKED_FILES=()

# Browser-ish MCP servers are matched by NAME or by COMMAND/ARGS. Override the
# pattern with AEGIS_MCP_BROWSER_PATTERN if a server is misclassified.
MCP_BROWSER_PATTERN="${AEGIS_MCP_BROWSER_PATTERN:-firefox|zen|chrom|playwright|puppeteer|selenium|webdriver|browser}"

# Emit a mcp.json where browser servers are disabled, and report which ones.
# Kept in node so the JSON is parsed rather than pattern-matched in text.
filter_mcp_config() {
	local source="$1" target="$2" pattern="$3"
	node -e '
		const fs = require("node:fs");
		const [source, target, pattern] = process.argv.slice(1);
		let raw = { mcpServers: {} };
		try { raw = JSON.parse(fs.readFileSync(source, "utf8")); } catch { }
		const servers = raw && typeof raw.mcpServers === "object" && raw.mcpServers ? raw.mcpServers : {};
		const re = new RegExp(pattern, "i");
		const out = {};
		const disabled = [];
		for (const [name, entry] of Object.entries(servers)) {
			const haystack = [name, entry?.command, ...(Array.isArray(entry?.args) ? entry.args : []), entry?.url]
				.filter((v) => typeof v === "string").join(" ");
			if (re.test(haystack)) {
				out[name] = { ...entry, enabled: false };
				disabled.push(name);
			} else {
				out[name] = entry;
			}
		}
		fs.writeFileSync(target, JSON.stringify({ mcpServers: out }, null, 2) + "\n", { mode: 0o600 });
		process.stdout.write(disabled.join(","));
	' "$source" "$target" "$pattern"
}

if [[ "$AGENT_MODE" == "derived-no-mcp" || "$AGENT_MODE" == "derived-mcp-filtered" ]]; then
	[[ -d "$SHARED_AGENT_DIR" ]] ||
		die "shared agent dir does not exist: $SHARED_AGENT_DIR
  create it or point at one with --agent-dir" 1
	for name in auth.json models.json settings.json models-store.json; do
		src="$SHARED_AGENT_DIR/$name"
		[[ -f "$src" ]] || continue
		ln -sfn "$src" "$AGENT_DIR/$name"
		LINKED_FILES+=("$name")
	done
	if [[ ${#LINKED_FILES[@]} -eq 0 ]]; then
		AUTH_WARNING="no credential files found in $SHARED_AGENT_DIR; the model will start unauthenticated"
	fi
	if [[ "$AGENT_MODE" == "derived-no-mcp" ]]; then
		# An empty server map is the whole override; a resumed run keeps whatever it
		# already has so an operator edit is not clobbered.
		if [[ ! -f "$AGENT_DIR/mcp.json" ]]; then
			printf '{\n  "mcpServers": {}\n}\n' >"$AGENT_DIR/mcp.json"
		fi
		MCP_NOTE="off (derived agent dir, empty mcp.json)"
	else
		# Regenerate every run: the roster of servers may have changed since the
		# experiment was created, and this file is derived, not authored.
		DISABLED_MCP="$(filter_mcp_config "$SHARED_AGENT_DIR/mcp.json" "$AGENT_DIR/mcp.json" "$MCP_BROWSER_PATTERN")"
		if [[ -n "$DISABLED_MCP" ]]; then
			MCP_NOTE="on, browser servers disabled: $(echo "$DISABLED_MCP" | tr ',' ' ')"
		else
			MCP_NOTE="on (no browser server matched)"
		fi
	fi
elif [[ "$AGENT_MODE" == "shared" ]]; then
	[[ -d "$AGENT_DIR" ]] || die "shared agent dir does not exist: $AGENT_DIR
  create it or point at one with --agent-dir" 1
	if [[ ! -f "$AGENT_DIR/auth.json" ]]; then
		AUTH_WARNING="no auth.json in $AGENT_DIR; the model will start unauthenticated"
	fi
	MCP_NOTE="on, ALL servers including browsers (shared agent dir)"
elif [[ "$AGENT_MODE" == "isolated" ]]; then
	MCP_NOTE="on (isolated agent dir; authenticate first)"
else
	MCP_NOTE="on (explicit agent dir)"
fi

# --- export the run's environment -----------------------------------------
# Script roster: what aegis_execute may run. An explicit flag wins; otherwise the
# experiment's own roster, then the shared tools roster, then the repo one. The
# file is validated by the registry at load time, so an invalid roster is
# reported rather than silently ignored.
if [[ -n "$SCRIPT_CONFIG_OVERRIDE" ]]; then
	SCRIPT_CONFIG="$SCRIPT_CONFIG_OVERRIDE"
	[[ "$SCRIPT_CONFIG" = /* ]] || SCRIPT_CONFIG="$LAUNCH_DIR/$SCRIPT_CONFIG"
	[[ -f "$SCRIPT_CONFIG" ]] || die "script roster not found: $SCRIPT_CONFIG"
elif [[ -f "$EXP_DIR/roster.json" ]]; then
	SCRIPT_CONFIG="$EXP_DIR/roster.json"
elif [[ -f "$AEGIS_HOME/tools/roster.json" ]]; then
	SCRIPT_CONFIG="$AEGIS_HOME/tools/roster.json"
elif [[ -f "$BASE_DIR/roster.json" ]]; then
	SCRIPT_CONFIG="$BASE_DIR/roster.json"
else
	SCRIPT_CONFIG=""
fi

export AEGIS_HOME
export AEGIS_TASK_ID="$TASK_ID"
export AEGIS_EVENT_LOG="$EVENT_LOG"
export AEGIS_RAM_DIR="$RAM_DIR"
export AEGIS_HANDOFF_FILE="$HANDOFF_FILE"
export AEGIS_PROJECTION_DIR="$PROJECTION_DIR"
export AEGIS_EXPERIENCE_DIR="$EXPERIENCE_DIR"
export AEGIS_KNOWLEDGE_DIR="$KNOWLEDGE_DIR"
export AEGIS_WEB_SEARCH="$WEB_SEARCH"
if [[ -n "$SEARCH_DENY" ]]; then
	export AEGIS_SEARCH_DENY="$SEARCH_DENY"
fi
export AEGIS_PI_AGENT_DIR="$AGENT_DIR"
export AEGIS_PI_SESSION_DIR="$SESSION_DIR"
export AEGIS_PI_SERVER_DIR="$SERVER_DIR"
# --- Experiment Console Host contract --------------------------------------
# One resident Host owns the Pi SDK runtime for this label. The values below are
# the TRUSTED, frozen Host policy: the model can never set or widen them.
export AEGIS_EXPERIMENT_LABEL="$LABEL"
if ((CONSOLE_MODE)); then
	# The scoped-Intent start gate is part of the Console Host contract. The
	# legacy single-CLI entry (--cli) keeps its historical optional-Intent
	# behaviour, so the gate is bound only for the Host.
	export AEGIS_WORK_START_GATE="${AEGIS_WORK_START_GATE:-on}"
else
	unset AEGIS_WORK_START_GATE
fi
WORK_START_GATE_STATE="${AEGIS_WORK_START_GATE:-off}"
export AEGIS_CONSOLE_MAX_AUTO_ROTATIONS="${MAX_AUTO_ROTATIONS:-${AEGIS_CONSOLE_MAX_AUTO_ROTATIONS:-3}}"
export AEGIS_CONSOLE_MAX_CONTINUATIONS="${MAX_CONTINUATIONS:-${AEGIS_CONSOLE_MAX_CONTINUATIONS:-12}}"
if [[ -n "$TOOLS" ]]; then export AEGIS_CONSOLE_TOOLS="$TOOLS"; else unset AEGIS_CONSOLE_TOOLS; fi
TOOL_ARGS=()
[[ -n "$TOOLS" ]] && TOOL_ARGS=(--tools "$TOOLS")
THINKING_ARGS=()
[[ -n "$THINKING" ]] && THINKING_ARGS=(--thinking "$THINKING")
if [[ -n "$PROVIDER" ]]; then export AEGIS_CONSOLE_PROVIDER="$PROVIDER"; fi
if [[ -n "$MODEL" ]]; then export AEGIS_CONSOLE_MODEL="$MODEL"; fi
if [[ -n "$SCRIPT_CONFIG" ]]; then
	export AEGIS_SCRIPT_CONFIG="$SCRIPT_CONFIG"
else
	unset AEGIS_SCRIPT_CONFIG
fi
# Tool catalog: documentation for general CLIs. Exported so aegis_toolbox reads the
# same file, and its tool directories are put on PATH so the model's bash calls
# actually resolve. PATH visibility is NOT authorization (see Pi_Agent_base/AGENTS.md).
TOOL_CATALOG="${AEGIS_TOOL_CATALOG:-$AEGIS_HOME/tools/catalog.json}"
if [[ -f "$TOOL_CATALOG" ]]; then
	export AEGIS_TOOL_CATALOG="$TOOL_CATALOG"
	CATALOG_PATHS="$(node -e '
		const fs = require("node:fs");
		try {
			const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
			const dirs = new Set();
			for (const t of c.tools ?? []) {
				if (typeof t.executable === "string" && t.executable.includes("/")) dirs.add(t.executable.slice(0, t.executable.lastIndexOf("/")));
			}
			process.stdout.write([...dirs].join(":"));
		} catch { process.stdout.write(""); }
	' "$TOOL_CATALOG" 2>/dev/null)"
	if [[ -n "$CATALOG_PATHS" ]]; then
		PATH="$CATALOG_PATHS:$PATH"
		export PATH
	fi
fi

if [[ -n "$ACTION_MODE" ]]; then
	[[ "$ACTION_MODE" =~ ^(normal|auto)$ ]] || die "--action-mode must be normal or auto"
	export AEGIS_ACTION_MODE="$ACTION_MODE"
fi
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
# JSON-safe optional values (a bare expansion would be ambiguous with the
# ``:-null`` fallback that the other optional fields use).
RUN_PROVIDER_JSON="null"
[[ -n "$PROVIDER" ]] && RUN_PROVIDER_JSON="\"$PROVIDER\""
RUN_MODEL_JSON="null"
[[ -n "$MODEL" ]] && RUN_MODEL_JSON="\"$MODEL\""
RUN_THINKING_JSON="null"
[[ -n "$THINKING" ]] && RUN_THINKING_JSON="\"$THINKING\""
RUN_TOOLS_JSON="null"
if [[ -n "$TOOLS" ]]; then
	RUN_TOOLS_JSON="$(node -e '
		const list = String(process.argv[1]).split(",").map((v) => v.trim()).filter(Boolean);
		process.stdout.write(JSON.stringify(list));
	' "$TOOLS")"
fi
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
  "mcp": "$MCP_MODE",
  "provider": $RUN_PROVIDER_JSON,
  "model": $RUN_MODEL_JSON,
  "tools": $RUN_TOOLS_JSON,
  "thinking": $RUN_THINKING_JSON,
  "console": {
    "entry": "$([[ $CONSOLE_MODE -eq 1 ]] && echo console || echo cli)",
    "max_auto_rotations": "$AEGIS_CONSOLE_MAX_AUTO_ROTATIONS",
    "max_continuations": "$AEGIS_CONSOLE_MAX_CONTINUATIONS",
    "work_start_gate": "$WORK_START_GATE_STATE"
  },
  "work_cycle": {
    "repeat_limit": ${AEGIS_WORK_CYCLE_REPEAT_LIMIT:-3},
    "action_window": ${AEGIS_WORK_CYCLE_ACTION_WINDOW:-8},
    "min_distinct_routes": ${AEGIS_WORK_CYCLE_MIN_DISTINCT_ROUTES:-4},
    "context_pressure_percent": ${AEGIS_WORK_CYCLE_CONTEXT_PERCENT:-85}
  },
  "seed_file": ${SEED_FILE:+\"$SEED_FILE\"}${SEED_FILE:-null},
  "web_search": "$WEB_SEARCH",
  "search_deny": ${SEARCH_DENY:+\"$SEARCH_DENY\"}${SEARCH_DENY:-null},
  "note": "derived parameters only; no credentials are stored here"
}
JSON
else
	printf 'run-experiment: resuming %s (run.json kept from %s)\n' "$LABEL" \
		"$(sed -n 's/.*"created_at": *"\([^"]*\)".*/\1/p' "$RUN_JSON" | head -1)"
fi

# --- attachments -----------------------------------------------------------
# Copying is explicit and non-destructive: an existing destination is refused
# rather than merged, so a re-run cannot silently overwrite challenge files.
ATTACH_SUMMARY=()
if (( ${#ATTACH[@]} )); then
	((USE_CWD)) && die "--attach is pointless with --here: the files are already the workspace" 2
	[[ "$MAX_ATTACH_BYTES" =~ ^[0-9]+$ ]] || die "--max-attach-bytes must be a whole number"

	resolved=()
	total_kb=0
	for src in "${ATTACH[@]}"; do
		[[ -n "$src" ]] || die "--attach needs a non-empty path"
		[[ "$src" = /* ]] || src="$LAUNCH_DIR/$src"
		[[ -e "$src" ]] || die "attachment not found: $src"
		[[ -L "$src" ]] && die "attachment is a symlink, refusing to follow it: $src"
		src="$(cd "$(dirname "$src")" && pwd -P)/$(basename "$src")"
		resolved+=("$src")
		size_kb="$(du -sk "$src" 2>/dev/null | awk '{print $1}')"
		total_kb=$((total_kb + ${size_kb:-0}))
		name="$(basename "$src")"
		[[ -e "$WORKSPACE/$name" ]] && die "workspace already contains '$name'; refusing to overwrite it"
	done
	if (( total_kb * 1024 > MAX_ATTACH_BYTES )); then
		die "attachments total $((total_kb)) KiB ($((total_kb * 1024)) bytes), above --max-attach-bytes ($MAX_ATTACH_BYTES bytes)"
	fi

	if ((DRY_RUN)); then
		printf '  attach     (dry run, not copied)\n'
		for src in "${resolved[@]}"; do printf '             %s -> %s\n' "$src" "$WORKSPACE/$(basename "$src")"; done
	else
		for src in "${resolved[@]}"; do
			name="$(basename "$src")"
			cp -R "$src" "$WORKSPACE/$name" || die "failed to copy $src"
			ATTACH_SUMMARY+=("$src")
			printf '  attach     %s -> %s\n' "$src" "$WORKSPACE/$name"
		done
		printf '  attached   %s item(s), %s KiB\n' "${#ATTACH_SUMMARY[@]}" "$total_kb"
	fi
fi

# Record where the copied files came from. Derived data is rebuildable, but the
# provenance of an experiment's inputs is not: it says what the run actually saw.
if (( ${#ATTACH_SUMMARY[@]} )); then
	{
		printf '\n  "attachments": [\n'
		for i in "${!ATTACH_SUMMARY[@]}"; do
			printf '    "%s"%s\n' "${ATTACH_SUMMARY[$i]}" "$([[ $i -lt $((${#ATTACH_SUMMARY[@]} - 1)) ]] && echo ,)"
		done
		printf '  ]\n'
	} >"$EXP_DIR/attachments.json"
fi

# --- summary ---------------------------------------------------------------
printf 'Aegis experiment: %s%s\n' "$LABEL" "$([[ "$MODE" == "resume" ]] && echo ' (resume)')"
printf '  entry      %s\n' "$([[ $CONSOLE_MODE -eq 1 ]] && echo 'Aegis Console Host (resident, source SDK)' || echo "$([[ "$ENTRY" == bundle ]] && echo 'run-pi.sh (bundle)' || echo 'run-aegis.sh (source)')")"
if ((CONSOLE_MODE)); then
	printf '  console    max_auto_rotations=%s max_continuations=%s work_start_gate=%s\n' \
		"$AEGIS_CONSOLE_MAX_AUTO_ROTATIONS" "$AEGIS_CONSOLE_MAX_CONTINUATIONS" "$WORK_START_GATE_STATE"
fi
printf '  workspace  %s\n' "$WORKSPACE"

# The default workspace is a fresh, empty directory. If the operator launched from
# a folder that already holds files, they will otherwise be surprised when the
# model reports an empty workspace, so say it before the session starts.
if [[ "$WORKSPACE" != "$LAUNCH_DIR" ]]; then
	workspace_items="$(find "$WORKSPACE" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
	launch_items="$(find "$LAUNCH_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
	if [[ "$workspace_items" == "0" && "$launch_items" != "0" && ${#ATTACH[@]} -eq 0 ]]; then
		printf '\n  NOTE: the workspace is EMPTY. Files in %s are not visible to this run.\n' "$LAUNCH_DIR" >&2
		printf '        To work on those files: %s %s --here\n' "$0" "$LABEL" >&2
		printf '        Or point at another folder:  %s %s --workspace DIR\n' "$0" "$LABEL" >&2
		printf '        Or copy files in:            %s %s --attach PATH\n' "$0" "$LABEL" >&2
	fi
fi
printf '  events     %s\n' "$EVENT_LOG"
printf '  ram        %s\n' "$RAM_DIR"
printf '  knowledge  %s\n' "$KNOWLEDGE_DIR"
printf '  search     %s%s\n' "$WEB_SEARCH" "$([[ "$WEB_SEARCH" == on ]] && echo ' - DeepSeek Search (technique/CVE only; target denylist)' || echo ' - disabled')"
printf '  agent      %s (%s)\n' "$AGENT_DIR" "$AGENT_MODE"
printf '  mcp        %s%s\n' "$MCP_MODE" "${MCP_NOTE:+ - $MCP_NOTE}"
if [[ -n "$SCRIPT_CONFIG" ]]; then
	printf '  scripts    %s\n' "$SCRIPT_CONFIG"
else
	printf '  scripts    (none registered: aegis_execute will refuse; see aegis-register-tool.mjs)\n'
fi
if [[ -f "$TOOL_CATALOG" ]]; then
	printf '  toolbox    %s\n' "$TOOL_CATALOG"
else
	printf '  toolbox    (no catalog: aegis_toolbox will report nothing; see docs/TOOL_CATALOG.md)\n'
fi
printf '  action     %s%s\n' "${ACTION_MODE:-normal (default)}" "$([[ "${ACTION_MODE:-normal}" == normal ]] && echo ' - aegis_execute needs a per-call grant, so model calls are refused' || echo ' - user-granted default path for this run')"
if [[ -n "$AUTH_WARNING" ]]; then
	printf '  warning    %s\n' "$AUTH_WARNING" >&2
fi
printf '  task id    %s\n' "$TASK_ID"
[[ -n "$SEED_FILE" ]] && printf '  seed       %s\n' "$SEED_FILE"
[[ -n "$MODEL" ]] && printf '  model      %s\n' "$MODEL"
printf '  tools      %s\n' "${TOOLS:-read,bash,edit,write (default)} + Aegis tools"
[[ -n "$THINKING" ]] && printf '  thinking   %s\n' "$THINKING"
printf '  recorded   %s\n' "$RUN_JSON"

if ((DRY_RUN)); then
	printf '\ndry run: nothing started. Environment that would be exported:\n'
	printf '  AEGIS_HOME=%s\n  AEGIS_TASK_ID=%s\n  AEGIS_EVENT_LOG=%s\n  AEGIS_RAM_DIR=%s\n' \
		"$AEGIS_HOME" "$TASK_ID" "$EVENT_LOG" "$RAM_DIR"
	printf '  AEGIS_KNOWLEDGE_DIR=%s\n  AEGIS_PI_AGENT_DIR=%s\n' "$KNOWLEDGE_DIR" "$AGENT_DIR"
	if ((CONSOLE_MODE)); then
		printf '  AEGIS_EXPERIMENT_LABEL=%s\n  AEGIS_WORK_START_GATE=%s\n' "$LABEL" "$WORK_START_GATE_STATE"
		printf '  AEGIS_CONSOLE_MAX_AUTO_ROTATIONS=%s\n  AEGIS_CONSOLE_MAX_CONTINUATIONS=%s\n' \
			"$AEGIS_CONSOLE_MAX_AUTO_ROTATIONS" "$AEGIS_CONSOLE_MAX_CONTINUATIONS"
	fi
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
if ((CONSOLE_MODE)) && ((MANAGEMENT_FIRST)); then
	# `auth`/`config`/`install`... manage Pi itself; they do not start an agent
	# run and must not create a Console Host.
	exec "$AEGIS_BASE/run-aegis.sh" "${ARGS[@]}"
fi
if ((CONSOLE_MODE)); then
	# The Experiment Console Host is the ONLY writer of this EventLog, and the
	# order is part of the contract: the entry acquires the per-label ownership
	# BEFORE it creates the Pi SDK runtime / binds the initial Session (binding
	# makes the Observer append `session.started`). A second console on the same
	# label is refused without creating or binding anything. Do not start a second
	# Pi CLI on this label.
	CONSOLE_ENTRY="$AEGIS_BASE/session/experiment-console-entry.mjs"
	SOURCE_RESOLVER="$AEGIS_BASE/pi/packages/coding-agent/src/experimental/source-resolver.ts"
	[[ -f "$CONSOLE_ENTRY" ]] || die "missing console entry: ${CONSOLE_ENTRY#"$BASE_DIR"/}" 1
	[[ -f "$SOURCE_RESOLVER" ]] || die "missing Pi source resolver: ${SOURCE_RESOLVER#"$BASE_DIR"/}" 1
	(( ${#PASSTHROUGH[@]} )) && exec node --import "$SOURCE_RESOLVER" "$CONSOLE_ENTRY" \
		--label "$LABEL" --task-id "$TASK_ID" --workspace "$WORKSPACE" \
		--event-log "$EVENT_LOG" --handoff "$HANDOFF_FILE" --session-dir "$SESSION_DIR" \
		--agent-dir "$AGENT_DIR" "${TOOL_ARGS[@]}" "${THINKING_ARGS[@]}" "${PASSTHROUGH[@]}"
	exec node --import "$SOURCE_RESOLVER" "$CONSOLE_ENTRY" \
		--label "$LABEL" --task-id "$TASK_ID" --workspace "$WORKSPACE" \
		--event-log "$EVENT_LOG" --handoff "$HANDOFF_FILE" --session-dir "$SESSION_DIR" \
		--agent-dir "$AGENT_DIR" "${TOOL_ARGS[@]}" "${THINKING_ARGS[@]}"
fi
if [[ "$ENTRY" == "bundle" ]]; then
	printf 'run-experiment: --bundle is not used by the console entry; use --cli to run the bundled CLI\n' >&2
	exec "$AEGIS_BASE/run-pi.sh" "${ARGS[@]}"
fi
exec "$AEGIS_BASE/run-aegis.sh" "${ARGS[@]}"
