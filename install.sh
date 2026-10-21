#!/usr/bin/env bash
# Aegis installer / preflight.
#
# Default behaviour is CHECK ONLY: no network, no clone, no npm install, no
# build, and no writes outside $AEGIS_HOME. Actions with side effects are
# opt-in:
#
#   --clone-pi        clone the Pi fork into Pi_Agent_base/pi (network)
#   --install-deps    npm install inside the embedded pi repo (network)
#   --build-bundle    build the pi bundle that run-pi.sh requires (CPU, no network)
#   --smoke           run the offline smoke checks
#
# One-shot install for a fresh checkout:  ./install.sh --all
#
# The script never reads, writes or migrates ~/.pi, and never prints secrets.
set -euo pipefail
umask 077

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$BASE_DIR/Pi_Agent_base/pi"
OBSERVER="$BASE_DIR/Pi_Agent_base/extensions/aegis-observer.ts"
ROM_FILE="$BASE_DIR/Pi_Agent_base/agent/ROM.md"
CLI="$PI_DIR/packages/coding-agent/src/cli.ts"
SOURCE_RESOLVER="$PI_DIR/packages/coding-agent/src/experimental/source-resolver.ts"
BUNDLE="$PI_DIR/packages/coding-agent/dist/bundle/cli.js"
MIN_NODE="22.19.0"

# Aegis calls ctx.ui.setTopBar()/setSidebar(), which only exist on the Aegis
# fork branch below. Cloning the fork's default branch (main = upstream pi)
# would make every session_start throw, so the ref is part of the contract.
PI_REMOTE="${AEGIS_PI_REMOTE:-https://github.com/SceAce/pi.git}"
DEFAULT_PI_REF="feat/aegis-shell-layout"
PI_REF="${AEGIS_PI_REF:-$DEFAULT_PI_REF}"

CLONE_PI=0
INSTALL_DEPS=0
BUILD_BUNDLE=0
SMOKE=0
AEGIS_HOME="${AEGIS_HOME:-${HOME:-$BASE_DIR}/.Aegis}"

usage() {
	cat <<'USAGE'
Aegis installer / preflight

Usage:
  ./install.sh [options]

One-shot install of a fresh checkout:
  ./install.sh --all

Options:
  --home PATH           Aegis state root (default: $AEGIS_HOME or ~/.Aegis)
  --clone-pi            clone the Pi fork into Pi_Agent_base/pi (needs network)
  --pi-remote URL       Pi fork URL (default: https://github.com/SceAce/pi.git)
  --pi-ref REF          Pi branch/ref to check out (default: feat/aegis-shell-layout)
  --install-deps        run `npm install` in the embedded pi repo (needs network)
  --build-bundle        build the pi bundle used by run-pi.sh
  --smoke               run offline smoke checks after setup
  --all                 --clone-pi --install-deps --build-bundle --smoke
  -h, --help            show this help

Pi source:
  pi/ is a separate repository (it has its own history and a large
  node_modules), so it is not tracked here. It is cloned from

      $AEGIS_PI_REMOTE  (default https://github.com/SceAce/pi.git)

  at the ref $AEGIS_PI_REF (default feat/aegis-shell-layout), because that
  branch carries the top-bar/sidebar extension slots Aegis requires. The
  default HTTPS URL clones anonymously; pass --pi-remote with your SSH URL
  (git@github.com:SceAce/pi.git) if you prefer SSH.

Default (no flags) only verifies prerequisites and creates the Aegis state
directory skeleton. It never touches ~/.pi and never prints credentials.

Exit codes:
  0  ready
  1  a required file is missing
  2  an unsatisfied host prerequisite or bad argument
  3  a requested action failed
USAGE
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--home)
			[[ $# -ge 2 ]] || { printf -- '--home needs a value\n' >&2; exit 2; }
			AEGIS_HOME="$2"
			shift 2
			;;
		--pi-remote)
			[[ $# -ge 2 ]] || { printf -- '--pi-remote needs a value\n' >&2; exit 2; }
			PI_REMOTE="$2"
			shift 2
			;;
		--pi-ref)
			[[ $# -ge 2 ]] || { printf -- '--pi-ref needs a value\n' >&2; exit 2; }
			PI_REF="$2"
			shift 2
			;;
		--clone-pi) CLONE_PI=1; shift ;;
		--install-deps) INSTALL_DEPS=1; shift ;;
		--build-bundle) BUILD_BUNDLE=1; shift ;;
		--smoke) SMOKE=1; shift ;;
		--all) CLONE_PI=1; INSTALL_DEPS=1; BUILD_BUNDLE=1; SMOKE=1; shift ;;
		-h | --help) usage; exit 0 ;;
		*) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
	esac
done

ok() { printf '  ok    %s\n' "$1"; }
warn() { printf '  warn  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; }
step() { printf '\n%s\n' "$1"; }

# --- version comparison (no GNU sort -V on macOS) --------------------------
version_ge() {
	local have="$1" want="$2" i
	local -a a b
	IFS=. read -r -a a <<<"$have"
	IFS=. read -r -a b <<<"$want"
	for i in 0 1 2; do
		local x="${a[$i]:-0}" y="${b[$i]:-0}"
		x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
		x="${x:-0}"; y="${y:-0}"
		if ((10#$x > 10#$y)); then return 0; fi
		if ((10#$x < 10#$y)); then return 1; fi
	done
	return 0
}

RC=0

# --- host prerequisites ----------------------------------------------------
step "Host prerequisites"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
	fail "Node.js not found (need >= $MIN_NODE)"
	RC=2
else
	NODE_VERSION="$("$NODE_BIN" -v | sed 's/^v//')"
	if version_ge "$NODE_VERSION" "$MIN_NODE"; then
		ok "node $NODE_VERSION >= $MIN_NODE"
	else
		fail "node $NODE_VERSION is older than $MIN_NODE"
		RC=2
	fi
fi

if command -v npm >/dev/null 2>&1; then
	ok "npm $(npm -v)"
else
	fail "npm not found"
	RC=2
fi

if command -v git >/dev/null 2>&1; then
	ok "git $(git --version | awk '{print $3}')"
else
	warn "git not found (only needed to update or inspect history)"
fi

# --- repository files ------------------------------------------------------
step "Repository files"

# Only Aegis-owned files are checked here. Everything under pi/ is verified by
# the "Embedded pi repository" section, AFTER a possible clone, otherwise a
# fresh checkout would report not-ready even when the clone succeeds.
missing=0
for f in \
	"$OBSERVER" \
	"$ROM_FILE" \
	"$BASE_DIR/Pi_Agent_base/run-aegis.sh" \
	"$BASE_DIR/Pi_Agent_base/run-pi.sh" \
	"$BASE_DIR/install.sh"; do
	if [[ -f "$f" ]]; then
		ok "${f#"$BASE_DIR"/}"
	else
		fail "missing ${f#"$BASE_DIR"/}"
		missing=1
	fi
done
if ((missing)); then
	RC=1
fi

# --- embedded pi repo ------------------------------------------------------
step "Embedded pi repository"

# Aegis requires the fork branch that adds ctx.ui.setTopBar()/setSidebar().
# Verify it in the checked-out tree so a wrong ref fails loudly here instead of
# throwing inside every session_start later.
pi_has_shell_slots() {
	[[ -f "$PI_DIR/packages/coding-agent/src/core/extensions/types.ts" ]] || return 1
	grep -q 'setTopBar' "$PI_DIR/packages/coding-agent/src/core/extensions/types.ts" 2>/dev/null
}

pi_is_repo() {
	[[ -d "$PI_DIR/.git" || -f "$PI_DIR/.git" ]]
}

# Cloning is a prerequisite of --install-deps and --build-bundle, so request it
# implicitly rather than failing on a missing tree.
if ! pi_is_repo; then
	if ((INSTALL_DEPS || BUILD_BUNDLE)); then CLONE_PI=1; fi
fi

if ((CLONE_PI)) && ! pi_is_repo; then
	if [[ -e "$PI_DIR" ]] && [[ -n "$(ls -A "$PI_DIR" 2>/dev/null)" ]]; then
		# Never delete a directory we did not create.
		fail "$PI_DIR exists and is not empty but is not a git repo; refusing to overwrite"
		printf '      move it aside manually, then re-run with --clone-pi\n' >&2
		RC=1
	else
		step "Cloning Pi ($PI_REF)"
		printf '  from %s\n' "$PI_REMOTE"
		mkdir -p "$(dirname "$PI_DIR")"
		if git clone --branch "$PI_REF" --depth 1 "$PI_REMOTE" "$PI_DIR"; then
			ok "cloned $PI_REF"
		else
			fail "git clone failed (check network access and that the ref exists)"
			printf '      remote: %s\n      ref:    %s\n' "$PI_REMOTE" "$PI_REF" >&2
			rm -rf "$PI_DIR" 2>/dev/null || true
			RC=3
		fi
	fi
fi

if pi_is_repo; then
	ok "pi repo present"
	pi_files_ok=1
	for f in "$CLI" "$SOURCE_RESOLVER"; do
		if [[ -f "$f" ]]; then
			ok "${f#"$BASE_DIR"/}"
		else
			fail "missing ${f#"$BASE_DIR"/}"
			pi_files_ok=0
		fi
	done
	((pi_files_ok)) || RC=1
	if pi_has_shell_slots; then
		ok "Aegis shell slots present (setTopBar/setSidebar)"
	else
		CURRENT_REF="$(git -C "$PI_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
		fail "this pi checkout lacks the Aegis shell slots (ctx.ui.setTopBar/setSidebar)"
		printf '      checked out: %s   (ref requested: %s)\n' "$CURRENT_REF" "$PI_REF" >&2
		if [[ "$CURRENT_REF" == "$PI_REF" ]]; then
			printf '      that ref itself lacks the slots, so Aegis cannot run on it.\n' >&2
			printf '      try a ref that carries them (default: %s).\n' "$DEFAULT_PI_REF" >&2
		else
			printf '      the checkout is on the wrong branch. Aegis needs a branch that\n' >&2
			printf '      adds setTopBar/setSidebar; main (upstream pi) does not.\n' >&2
			printf '      fix: git -C Pi_Agent_base/pi fetch --depth 1 origin %s\n' "$PI_REF" >&2
			printf '           git -C Pi_Agent_base/pi checkout -B %s FETCH_HEAD\n' "$PI_REF" >&2
		fi
		RC=1
	fi
	if [[ ! -d "$PI_DIR/node_modules" ]]; then
		warn "pi dependencies are not installed (run with --install-deps)"
	fi
	if [[ -f "$BUNDLE" ]]; then
		ok "pi bundle present"
	else
		warn "pi bundle missing; run-pi.sh will refuse to start (run with --build-bundle)"
	fi
else
	fail "embedded pi repo not found at Pi_Agent_base/pi"
	cat <<NOTE

  Aegis runs on Pi, but pi/ is a separate repository and is intentionally not
  tracked here (its own history, large node_modules). Install it with:

      ./install.sh --all

  or clone it yourself and re-run the checks:

      git clone --branch $PI_REF $PI_REMOTE Pi_Agent_base/pi

  The branch matters: $PI_REF carries the top-bar/sidebar extension slots that
  Aegis calls at session start. The fork's default branch (main) does not.

NOTE
	RC=1
fi

# --- Aegis state home ------------------------------------------------------
step "Aegis state home"

if [[ "$AEGIS_HOME" != /* ]]; then
	AEGIS_HOME="$(pwd -P)/$AEGIS_HOME"
fi
if [[ -e "$AEGIS_HOME" && ! -d "$AEGIS_HOME" ]]; then
	fail "AEGIS_HOME exists but is not a directory: $AEGIS_HOME"
	RC=2
else
	mkdir -p "$AEGIS_HOME/agent" "$AEGIS_HOME/sessions" "$AEGIS_HOME/server" \
		"$AEGIS_HOME/runtime/ram" "$AEGIS_HOME/knowledge" 2>/dev/null || {
		fail "cannot create AEGIS_HOME skeleton under $AEGIS_HOME"
		RC=2
	}
	if [[ -d "$AEGIS_HOME" ]]; then
		chmod 700 "$AEGIS_HOME" 2>/dev/null || true
		ok "home: $AEGIS_HOME"
		for sub in agent sessions server runtime runtime/ram knowledge; do
			[[ -d "$AEGIS_HOME/$sub" ]] && ok "  $sub/"
		done
		ok "isolated from ~/.pi (Aegis never reads or writes it)"
	fi
fi

# --- optional actions ------------------------------------------------------
if ((INSTALL_DEPS)); then
	step "Installing pi dependencies (network)"
	if [[ ! -d "$PI_DIR" ]]; then
		fail "pi repo is missing; cannot install dependencies"
		RC=3
	else
		if (cd "$PI_DIR" && npm install --no-audit --no-fund); then
			ok "npm install completed"
		else
			fail "npm install failed"
			RC=3
		fi
	fi
fi

if ((BUILD_BUNDLE)); then
	step "Building the pi bundle"
	MODEL_DATA_DIR="$PI_DIR/packages/ai/src/providers/data"
	if [[ ! -d "$PI_DIR/node_modules" ]]; then
		fail "pi dependencies are missing; run with --install-deps first"
		RC=3
	else
		# The provider model data is generated, not tracked (it is .gitignored),
		# and `build:offline` refuses to run without it. A fresh clone therefore
		# needs one network hydration pass first.
		if [[ ! -d "$MODEL_DATA_DIR" ]] || [[ -z "$(ls -A "$MODEL_DATA_DIR" 2>/dev/null)" ]]; then
			step "Hydrating pi model data (network)"
			if (cd "$PI_DIR" && npm run hydrate:model-data); then
				ok "model data hydrated"
			else
				fail "npm run hydrate:model-data failed (needs network access)"
				printf '      the bundle is only needed by run-pi.sh; run-aegis.sh does not need it\n' >&2
				RC=3
			fi
		fi
		if ((RC != 3)) && (cd "$PI_DIR" && npm run build:offline); then
			if [[ -f "$BUNDLE" ]]; then
				ok "bundle built: packages/coding-agent/dist/bundle/cli.js"
			else
				fail "build reported success but the bundle is missing"
				RC=3
			fi
		elif ((RC != 3)); then
			fail "npm run build:offline failed"
			printf '      the bundle is only needed by run-pi.sh; run-aegis.sh does not need it\n' >&2
			RC=3
		fi
	fi
fi

if ((SMOKE)); then
	step "Offline smoke checks"
	run_smoke() {
		local label="$1"
		shift
		if (cd "$BASE_DIR" && "$@" >/dev/null 2>&1); then
			ok "$label"
		else
			fail "$label"
			RC=3
		fi
	}
	if [[ -f "$BASE_DIR/Pi_Agent_base/tests/aegis-human-hint.mjs" ]]; then
		run_smoke "human hint projection" node Pi_Agent_base/tests/aegis-human-hint.mjs
	fi
	if [[ -f "$BASE_DIR/Pi_Agent_base/tests/aegis-runtime-core-smoke.mjs" ]]; then
		run_smoke "runtime core" node Pi_Agent_base/tests/aegis-runtime-core-smoke.mjs
	fi
	if [[ -f "$BASE_DIR/Pi_Agent_base/tests/aegis-module-layout.mjs" ]]; then
		run_smoke "module layout" node Pi_Agent_base/tests/aegis-module-layout.mjs
	fi
	if [[ -d "$PI_DIR/node_modules" && -f "$BASE_DIR/Pi_Agent_base/tests/observer-smoke.mjs" ]]; then
		if pi_has_shell_slots; then
			run_smoke "observer extension" node \
				--import "./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts" \
				Pi_Agent_base/tests/observer-smoke.mjs
		else
			warn "observer smoke skipped: pi checkout lacks the Aegis shell slots"
		fi
	fi
fi

# --- summary ---------------------------------------------------------------
step "Next steps"
if ((RC == 0)); then
	cat <<'NEXT'
  Ready. Start Aegis with isolated state:

      ./Pi_Agent_base/run-aegis.sh                 # source entry (default)
      ./Pi_Agent_base/run-aegis.sh --model <p/m>   # pick a model
      ./Pi_Agent_base/run-pi.sh                    # built-bundle entry

  Credentials live in $AEGIS_HOME/agent (Pi auth config) or environment
  variables. Do not commit them.

  Inside a session, task guidance can be injected at runtime:

      /aegis hint <text>    # reaches the next provider request
      /aegis hint clear     # retire it (audit events are kept)
      /aegis hint           # show the current hint

NEXT
	printf 'Aegis installer: ready (%s)\n' "$AEGIS_HOME"
	exit 0
fi

printf 'Aegis installer: not ready (see FAIL lines above)\n' >&2
exit "$RC"
