#!/usr/bin/env bash
set -euo pipefail

# Aegis contest MVP launcher (source-only).
#
# The built Pi bundle (packages/coding-agent/dist/bundle/cli.js) is intentionally
# NOT required and NOT used here: this checkout has no bundle, so the only
# honest path is Pi's own source entry point, Pi_Agent_base/pi/pi-test.sh.
#
# This launcher:
#   * uses AEGIS_CONTEST_WORKSPACE when set, else the caller's current
#     directory (pwd -P) captured before any cd; it refuses the Aegis checkout
#     (root, its descendants, and any ancestor such as $HOME or / that exposes
#     it) and chdirs into the workspace before exec,
#   * sets `umask 077` so every NEW private dir/file is owner-only, and warns
#     (never chmods) about pre-existing group/world-accessible state,
#   * isolates all mutable Pi state under $HOME/.Aegis (agent/sessions/server),
#     never $HOME/.pi,
#   * disables extension discovery, MCP, skills, prompt templates, themes, and
#     context files, and loads ONLY the aegis-contest extension,
#   * does NOT pass --append-system-prompt: the Observer injects the stable ROM
#     as the structured `aegis_rom` section on every request. Appending
#     agent/ROM.md at the CLI would add the SAME text a second time (an
#     `addendum` section) in the real launch combination, so the launcher no
#     longer duplicates it. ROM_FILE is still exported as AEGIS_ROM_FILE, which
#     is the single source the Observer reads,
#   * pins the tool set with --tools read,bash,edit,write,aegis_propose,
#     aegis_switch_session,aegis_observe,aegis_execute,aegis_submit_candidate
#     so inherited settings cannot silently change the
#     controlled comparison, and so the Observer's proposal/handoff control
#     tools are actually reachable (they were previously hidden by --tools),
#   * keeps each task's runtime audit in its OWN task-scoped directory
#     (<CONTEST_DIR>/tasks/<task_id>/{events.jsonl,ram/,handoff.json}) so two
#     tasks can never share one event/episode log or overwrite each other's RAM
#     or staged handoff,
#   * requires an anonymous AEGIS_CONTEST_TASK_ID for every task (rejects empty
#     or path-like values) so every run is attributable and archived,
#   * defaults to `off` (record only) and accepts `hint` (inject up to 2 cards),
#   * persists a real Pi session per task (does NOT pass --no-session) under the
#     isolated session dir, so each task leaves an archivable transcript,
#   * accepts NO Pi passthrough arguments at all (not even after `--`): off and
#     hint run the SAME model/provider/tools/resources/session/extension set,
#     so short aliases (-ne/-e/-nt/-t) and `--` cannot break the comparison,
#   * clears inherited PI_* experiment-state variables before exec so a nested
#     Pi session cannot leak a different model/provider/reasoning level in, then
#     sets PI_OFFLINE=1 and PI_SKIP_VERSION_CHECK=1 so Pi's automatic update /
#     version / model-catalog network checks are disabled (provider calls for the
#     pinned relay model remain allowed),
#   * never reads, prints, or writes credentials; it only pins the relay model.
#
# Authoritative contest sources are the Pi session JSONL, the aegis-contest
# metadata log, and the externally recorded result. The aegis-observer runtime
# extension IS loaded alongside aegis-contest: it now injects its stable ROM
# and per-request RAM through Pi's STRUCTURED prompt sections (`aegis_rom`,
# `aegis_ram`) instead of returning a full systemPrompt, so the contest
# extension's `aegis_hints` section composes cleanly in the same request.
# Observer events are the runtime audit chain; the contest metadata log and the
# external result remain the authoritative contest evidence.
#
# It does NOT build anything, does NOT call any network, and does NOT modify the
# Pi fork or the existing credential/config files. The workspace cwd is NOT an
# OS sandbox: high-risk tasks must additionally be isolated in a container or
# run under a low-privilege account by the operator.

# All NEW state created below must be owner-only. This applies to mkdir and to
# files created by Pi in those directories (sessions, logs). Existing files are
# checked and warned about, never rewritten/chmod-ed.
umask 077

# Capture the caller's physical directory BEFORE any cd: this is the default
# task workspace when AEGIS_CONTEST_WORKSPACE is not set.
CALLER_PWD="$(pwd -P)"

# This script lives at <Pi_Agent_base>/contest/run.sh, so the base is one level up.
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# The whole Aegis checkout root (parent of Pi_Agent_base) is off-limits, not
# just Pi_Agent_base itself.
CHECKOUT_ROOT="$(cd "$BASE_DIR/.." && pwd -P)"
PI_TEST="$BASE_DIR/pi/pi-test.sh"
SELF="$BASE_DIR/contest/run.sh"
AEGIS_HOME="${AEGIS_HOME:-$HOME/.Aegis}"
CONFIG_DIR="$AEGIS_HOME"
AGENT_DIR="$CONFIG_DIR/agent"
SESSION_DIR="$CONFIG_DIR/sessions"
SERVER_DIR="$CONFIG_DIR/server"
CONTEST="$BASE_DIR/extensions/aegis-contest.ts"
OBSERVER="$BASE_DIR/extensions/aegis-observer.ts"
ROM_FILE="$BASE_DIR/agent/ROM.md"
RUNTIME_DIR="$AEGIS_HOME/runtime"
CONTEST_DIR="$RUNTIME_DIR/contest"
CARDS_FILE="${AEGIS_CONTEST_CARDS:-$CONTEST_DIR/cards.json}"
CONTEST_LOG="${AEGIS_CONTEST_LOG:-$CONTEST_DIR/decisions.jsonl}"
MODE="off"
SHOW_HELP=0
# Batch C: verify-first action mode (auto/normal) and human target scope.
# AEGIS_ACTION_MODE=auto lets declared read/observe actions and registered
# scripts run inside the user-given workspace WITHOUT a per-call approval.
# normal (default) requires an explicit human approval before a side effect.
ACTION_MODE="${AEGIS_ACTION_MODE:-normal}"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--off)
			MODE="off"
			shift
			;;
		--hint)
			MODE="hint"
			shift
			;;
		-h | --help)
			SHOW_HELP=1
			shift
			;;
		--)
			printf 'error: refusing "--" passthrough: Pi options are not accepted at all for a contest run.\n' >&2
			printf '       off/hint must use the fixed model/provider/tools/resources set; this task would be unfit for A/B.\n' >&2
			printf '       Run "%s --help" for usage.\n' "$(basename "$0")" >&2
			exit 2
			;;
		--*)
			printf 'error: refusing unknown Pi option "%s": contest runs accept no Pi passthrough flags.\n' "$1" >&2
			printf '       off/hint must use the fixed model/provider/tools/resources set; this task would be unfit for A/B.\n' >&2
			printf '       Run "%s --help" for usage.\n' "$(basename "$0")" >&2
			exit 2
			;;
		-*)
			printf 'error: refusing unknown Pi short option "%s": contest runs accept no Pi passthrough flags.\n' "$1" >&2
			printf '       off/hint must use the fixed model/provider/tools/resources set; this task would be unfit for A/B.\n' >&2
			printf '       Run "%s --help" for usage.\n' "$(basename "$0")" >&2
			exit 2
			;;
		*)
			printf 'error: unexpected argument "%s": contest runs accept no positional arguments.\n' "$1" >&2
			printf '       Run "%s --help" for usage.\n' "$(basename "$0")" >&2
			exit 2
			;;
	esac
done

if [[ "$SHOW_HELP" -eq 1 ]]; then
	cat <<EOF
Aegis contest MVP launcher (source-only, isolated, offline-safe)

One-line start from an EXTERNAL directory (the workspace defaults to pwd -P):
  AEGIS_CONTEST_TASK_ID=<anonymous-id> $SELF [--off|--hint]

Usage:
  AEGIS_CONTEST_WORKSPACE=<external-task-dir> \\
  AEGIS_CONTEST_TASK_ID=<anonymous-id> $SELF [--off|--hint]
  $SELF --help

Modes:
  --off    record only, never inject a hint   (default)
  --hint   inject at most 2 matched hint cards into the next request

Action mode (verify-first actions; separate from --off/--hint):
  AEGIS_ACTION_MODE=normal  (default) side-effecting registered scripts need an
                            explicit human approval before they run.
  AEGIS_ACTION_MODE=auto    user-granted: declared observe actions and
                            registered scripts run inside the workspace without a
                            per-call approval. auto is NOT a verification result
                            and the workspace is NOT an OS sandbox.
  AEGIS_SCRIPT_CONFIG       optional JSON path ({"scripts":[...]}) of
                            human-reviewed script registrations. ABSENT means the
                            script runtime stays UNCONFIGURED; the launcher never
                            registers a contest/remote script itself.
  AEGIS_ALLOW_NETWORK=1     only then may a registered network action run. With no
                            remote configuration the runtime never accesses the
                            network.

Required:
  AEGIS_CONTEST_TASK_ID   anonymous task id (e.g. task-007). Must be non-empty
                          and contain no '/', '\\\\', or '..' (no paths).

Workspace:
  AEGIS_CONTEST_WORKSPACE optional. When unset, the caller's current directory
                          (pwd -P, captured before any cd) is used. The Aegis
                          checkout root, its descendants, and any ancestor that
                          exposes it (e.g. \$HOME or /) are refused as a cwd;
                          the cwd is NOT an OS sandbox.

Environment:
  AEGIS_CONTEST_CARDS         card JSON path (default: $CARDS_FILE)
  AEGIS_CONTEST_LOG           decision log path (default: $CONTEST_LOG)
  AEGIS_CONTEST_TASK_CATEGORY deterministic task category for matching
  AEGIS_CONTEST_ENV           deterministic environment label
  AEGIS_CONTEST_OBSERVATIONS  comma-separated confirmed observations
  AEGIS_CONTEST_GUARD=1       also block out-of-cwd recursive rm (narrow)

Controlled-comparison rule:
  contest runs accept NO Pi passthrough flags (not even after \`--\`). off/hint
  receive the SAME model/provider/tools/resources/session/extension set. Short
  aliases (-ne, -e, -nt, -t) and inherited PI_* variables cannot change the
  controlled conditions because unknown args are refused and PI_* experiment
  state is cleared before exec. The launcher then pins the extension set to
  aegis-observer + aegis-contest, and pins --tools
  read,bash,edit,write,aegis_propose,aegis_switch_session,aegis_observe,
  aegis_execute,aegis_submit_candidate, so an inherited
  settings file cannot change the comparison and the Observer control tools
  remain reachable. The ROM is NOT appended at the CLI: the Observer injects it
  as the structured aegis_rom section, so the real launch does not duplicate it.

Authoritative sources:
  A contest result is judged from the Pi session JSONL, the aegis-contest
  metadata log, and the externally recorded result only. The aegis-observer
  extension is loaded for the runtime Event/RAM audit chain (its ROM/RAM are
  injected as structured sections alongside the contest hints); the contest
  metadata log and the external result remain the authoritative contest
  evidence.

Notes:
  Each task gets its own runtime audit directory under
  $CONTEST_DIR/tasks/<task_id>/ (events.jsonl, ram/, handoff.json); tasks never
  share an event/episode log.
  New files/dirs are created owner-only (umask 077). Pre-existing group/world-
  accessible session/runtime state is reported as a warning and is NOT chmod-ed.
  All Pi state stays under $CONFIG_DIR; nothing is written to \$HOME/.pi.
  PI_OFFLINE=1 and PI_SKIP_VERSION_CHECK=1 disable Pi's automatic update /
  version / model-catalog network checks; provider calls for the pinned relay
  model are still made.
  Credentials are never read, printed, or modified by this script.
  The workspace cwd is NOT an OS sandbox; use a container/low-priv account for
  high-risk tasks.
EOF
	exit 0
fi

# --- Enforce the anonymous task id (P0: every task is attributable). ---
TASK_ID="${AEGIS_CONTEST_TASK_ID:-}"
if [[ -z "$TASK_ID" ]]; then
	printf 'error: AEGIS_CONTEST_TASK_ID is required for every contest task (anonymous id, e.g. task-007).\n' >&2
	printf '       Run "%s --help" for usage.\n' "$(basename "$0")" >&2
	exit 2
fi
case "$TASK_ID" in
	*/* | *\\* | *..*)
		printf 'error: AEGIS_CONTEST_TASK_ID must not contain path separators or ".." (got: %s).\n' "$TASK_ID" >&2
		exit 2
		;;
esac
export AEGIS_CONTEST_TASK_ID="$TASK_ID"

# --- Resolve the task workspace: explicit env, else the caller's cwd. ---
# P0: the checkout root, its descendants, and any ancestor that exposes them
# (e.g. $HOME or /) are refused because such a cwd reaches checkout/config.
WORKSPACE="${AEGIS_CONTEST_WORKSPACE:-$CALLER_PWD}"
if [[ ! -d "$WORKSPACE" ]]; then
	printf 'error: AEGIS_CONTEST_WORKSPACE must be an existing directory (got: %s).\n' "$WORKSPACE" >&2
	exit 2
fi
WORKSPACE_REAL="$(cd "$WORKSPACE" && pwd -P)"
# The "$WORKSPACE_REAL" == "/" case is explicit because the ancestor glob
# below cannot match when the candidate is the filesystem root.
if [[ "$WORKSPACE_REAL" == "$CHECKOUT_ROOT" || \
	"$WORKSPACE_REAL" == "$CHECKOUT_ROOT"/* || \
	"$CHECKOUT_ROOT" == "$WORKSPACE_REAL"/* || \
	"$WORKSPACE_REAL" == "/" ]]; then
	printf 'error: refusing to run inside the Aegis checkout: %s\n' "$WORKSPACE_REAL" >&2
	printf '       The checkout root (%s), its descendants, and ancestors that expose it are not a task workspace.\n' "$CHECKOUT_ROOT" >&2
	printf '       Set AEGIS_CONTEST_WORKSPACE to an external directory; the cwd is NOT a sandbox.\n' >&2
	exit 2
fi
export AEGIS_CONTEST_WORKSPACE="$WORKSPACE_REAL"

# --- Clear inherited PI_* experiment state; our own values are set below. ---
for var in \
	PI_MODEL PI_PROVIDER PI_REASONING_LEVEL PI_EXPERIMENTAL \
	PI_SESSION_ID PI_SESSION_FILE PI_OFFLINE PI_SKIP_VERSION_CHECK \
	PI_CACHE_RETENTION PI_PLUGIN_API PI_CODING_AGENT; do
	unset "$var" 2>/dev/null || true
done
# Disable Pi's automatic update / version / model-catalog network checks. The
# pinned relay model calls are still allowed; this is not a network sandbox.
export PI_OFFLINE=1
export PI_SKIP_VERSION_CHECK=1

if [[ ! -f "$PI_TEST" ]]; then
	printf 'Pi source entry point is missing: %s\n' "$PI_TEST" >&2
	exit 1
fi
for required in "$CONTEST" "$OBSERVER" "$ROM_FILE"; do
	if [[ ! -f "$required" ]]; then
		printf 'Aegis file is missing: %s\n' "$required" >&2
		exit 1
	fi
done

# Report (never fix) pre-existing group/world-accessible private state.
warn_insecure() {
	local label="$1" path="$2"
	[[ -e "$path" ]] || return 0
	local found
	found="$(find "$path" \( -perm -g+r -o -perm -g+w -o -perm -g+x -o -perm -o+r -o -perm -o+w -o -perm -o+x \) -print -quit 2>/dev/null || true)"
	if [[ -n "$found" ]]; then
		printf 'warning: %s already has group/world-accessible permissions: %s\n' "$label" "$found" >&2
		printf 'warning: NOT chmod-ing pre-existing state; move it aside or "chmod 700" it yourself before a real contest.\n' >&2
	fi
}

for dir in "$AGENT_DIR" "$SESSION_DIR" "$SERVER_DIR" "$RUNTIME_DIR" "$CONTEST_DIR"; do
	warn_insecure "private dir" "$dir"
done

mkdir -p "$AGENT_DIR" "$SESSION_DIR" "$SERVER_DIR" "$RUNTIME_DIR" "$CONTEST_DIR"

# Task-scoped runtime audit: every task gets its own append-only event log, RAM
# dir and staged handoff file. Sharing one events.jsonl across tasks would mix
# independent Event/Episode chains and let one task read or overwrite another's
# RAM/handoff. TASK_ID is validated above (no '/', '\\', or '..').
TASK_RUNTIME_DIR="$CONTEST_DIR/tasks/$TASK_ID"
if [[ -e "$TASK_RUNTIME_DIR" && ! -d "$TASK_RUNTIME_DIR" ]]; then
	printf 'error: task runtime path exists but is not a directory: %s\n' "$TASK_RUNTIME_DIR" >&2
	exit 2
fi
mkdir -p "$TASK_RUNTIME_DIR" "$TASK_RUNTIME_DIR/ram"
warn_insecure "task runtime dir" "$TASK_RUNTIME_DIR"

# Reject a task-scoped runtime path that escapes the contest dir via a symlink.
TASK_RUNTIME_REAL="$(cd "$TASK_RUNTIME_DIR" && pwd -P)"
if [[ "$TASK_RUNTIME_REAL" != "$CONTEST_DIR"/* ]]; then
	printf 'error: refusing task runtime dir outside the contest runtime: %s\n' "$TASK_RUNTIME_REAL" >&2
	exit 2
fi

export AEGIS_HOME
export PI_CODING_AGENT_DIR="$AGENT_DIR"
export PI_CODING_AGENT_SESSION_DIR="$SESSION_DIR"
export PI_SERVER_DIR="$SERVER_DIR"
export AEGIS_ROM_FILE="$ROM_FILE"
export AEGIS_EVENT_LOG="$TASK_RUNTIME_DIR/events.jsonl"
export AEGIS_RAM_DIR="$TASK_RUNTIME_DIR/ram"
export AEGIS_HANDOFF_FILE="$TASK_RUNTIME_DIR/ram/handoff.json"
export AEGIS_TASK_ID="$TASK_ID"
export AEGIS_CONTEST_MODE="$MODE"
export AEGIS_CONTEST_CARDS="$CARDS_FILE"
export AEGIS_CONTEST_LOG="$CONTEST_LOG"
export AEGIS_ACTION_MODE="$ACTION_MODE"
# The task workspace is the user-given target the observe/execute actions are
# bounded to. It is NOT claimed to be an OS sandbox.
export AEGIS_WORKSPACE="$WORKSPACE_REAL"

# Show the task, group, and authorized workspace, never a secret.
printf 'Aegis contest: task_id=%s mode=%s workspace=%s cards=%s\n' "$TASK_ID" "$MODE" "$WORKSPACE_REAL" "$CARDS_FILE" >&2

# The workspace is now the ONLY cwd the agent gets. It is not a sandbox.
cd "$WORKSPACE_REAL"

exec "$PI_TEST" \
	--no-extensions \
	--no-mcp \
	--no-approve \
	--no-context-files \
	--no-skills \
	--no-prompt-templates \
	--no-themes \
	--session-dir "$SESSION_DIR" \
	-e "$OBSERVER" \
	-e "$CONTEST" \
	--tools read,bash,edit,write,aegis_propose,aegis_switch_session,aegis_observe,aegis_execute,aegis_submit_candidate \
	--provider relay \
	--model deepseek-v4.1-flash
