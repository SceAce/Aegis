from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# State dir. `AEGIS_STATE_DIR` exists so the regression suite can point at a
# throwaway directory. Without it, tests called `save_current()` against the
# REAL `.aegis/`, overwriting `current.json` — and with it `t0`, `hints` and
# `observations` — of whatever experiment round was running. Running the suite
# mid-run destroyed that round's timing, which is the only measurement we have.
AEGIS_DIR = (
    Path(os.environ["AEGIS_STATE_DIR"])
    if os.environ.get("AEGIS_STATE_DIR")
    else (ROOT / ".aegis")
)
RUNS_DIR = ROOT / "runs"
TEST_DIR = ROOT / "test"
ROM_PATH = ROOT / "rom" / "ROM.md"
RAM_TOOLS_PATH = ROOT / "ram" / "TOOLS.md"
CURRENT_PATH = AEGIS_DIR / "current.json"
EPISODES_PATH = AEGIS_DIR / "episodes.jsonl"
ATLAS_PATH = AEGIS_DIR / "atlas.json"
SEARCH_PATH = AEGIS_DIR / "search.json"
ISSUES_PATH = AEGIS_DIR / "issues.jsonl"
LESSONS_PATH = AEGIS_DIR / "lessons.json"
RAW_DIR = ROOT / "raw"
WIKI_DIR = RAW_DIR / "ctf-wiki"
WIKI_DONE_PATH = AEGIS_DIR / "wiki_done.json"

# Legacy mirror for the local docker channel. Kept so the container path still
# works, but the remote host is the primary channel (see REMOTE_* below).
TMP_SYNC = Path(os.environ.get("AEGIS_SYNC_DIR") or (Path.home() / "Tmp" / "aegis"))
CONTAINER = "pwn"
SYNC_MOUNT = os.environ.get("AEGIS_SYNC_MOUNT", "/work/aegis")

# ---- primary channel: the remote x86_64 host -------------------------------
#
# Runs native x86_64 (no QEMU emulation) and carries the fuller toolchain:
# one_gadget, radare2, glibc-all-in-one, IDA, and pwntools 4.15 in ~/tools/CTF.
# Reached with `hack.sh`, i.e. sshpass + a password.
#
# Two environment quirks that shape the code:
#   * The login shell is zsh, which is NOT POSIX-compatible (`X=1`, `if`, `for`
#     and heredocs all differ). Every call must go through `bash -lc`.
#   * sshpass needs a pty, which some sandboxes deny. ssh_argv() therefore
#     falls back to SSH_ASKPASS, which needs no pty.
# Address must match ~/.local/bin/hack, which is the thing that actually reaches
# the host. It used to be 172.168.10.152; that address now times out, so every
# probe fell back to the container and silently changed the target's libc.
REMOTE_HOST = os.environ.get("AEGIS_REMOTE", "100.110.69.75")
REMOTE_USER = os.environ.get("AEGIS_REMOTE_USER", "hack")
REMOTE_PASS = os.environ.get("AEGIS_REMOTE_PASS", "hack")
REMOTE_WORKDIR = os.environ.get("AEGIS_REMOTE_WORKDIR", "~/Tmp/aegis/{challenge}")
REMOTE_VENV = os.environ.get("AEGIS_REMOTE_VENV", "~/tools/CTF")
REMOTE_PORT = int(os.environ.get("AEGIS_REMOTE_PORT", "22"))

# The launcher for the agent session.
#
# It MUST be ours. Upstream's `pi-test.sh` runs the upstream source, whose native
# Observer does not exist — so a run started through it feeds the memory loop
# zero events and looks like "experience had no effect" for entirely the wrong
# reason. `scripts/aegis-pi.sh` runs the fork and refuses to start if the
# Observer is missing or its build is stale.
#
# AEGIS_PI overrides it, for pointing at a differently built pi.
PI_SCRIPT = Path(os.environ.get("AEGIS_PI") or (ROOT / "scripts" / "aegis-pi.sh"))
PWN_START = Path.home() / "Tools" / "pwn" / "start.sh"

FORBIDDEN_READ_NAMES = {
    "架构.md",
    "框架.md",
    "README.md",
    "Deepseek_AGENTS.md",
}
FORBIDDEN_PREFIXES = (
    ".aegis",
    "runs",
)


def run_state_path(challenge: str) -> Path:
    return AEGIS_DIR / f"run-{challenge}.json"


def ensure_dirs() -> None:
    AEGIS_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    # TMP_SYNC is the *container* channel's mirror root. The remote (ssh) channel
    # never reads or writes it, so failing to create it must not take down a
    # remote run — that coupling made `aegis start` abort on a remote-only host
    # whose home is not writable, with a traceback that named the wrong channel.
    # The container path checks writability itself and reports its own reason.
    try:
        TMP_SYNC.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass


def challenge_dir(name: str) -> Path:
    return TEST_DIR / name


def list_challenges() -> list[str]:
    if not TEST_DIR.is_dir():
        return []
    return sorted(p.name for p in TEST_DIR.iterdir() if p.is_dir() and not p.name.startswith("."))


def infer_kind(name: str) -> str:
    lower = name.lower()
    if lower.startswith("pwn"):
        return "pwn"
    if lower.startswith("re"):
        return "re"
    if lower.startswith("cp") or lower.startswith("crypto"):
        return "crypto"
    return "misc"
