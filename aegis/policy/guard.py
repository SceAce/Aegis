"""Tool-level refusals.

A skip that only appears as prose is ignored. Every rule here is a predicate
over the command string, so the model cannot "decide to try anyway".

Design rule learned from 43 recorded harness issues (23 timeout / 18 refused):
a refusal that fires on a *legitimate* command is far more expensive than one
that misses. A false refusal does not just block one command — it hides the
information the agent was probing for, so the agent probes again, gets refused
again, and burns the run in a loop. 5 of the 18 recorded refusals were false,
and every one of them came from matching `gdb` as a substring: `command -v gdb`,
`grep SIGSEGV /tmp/gdbout.txt`, `tr -cd ... < /tmp/gdbout.txt`.

So each rule below matches a *shape of invocation*, never a bare word.

ALWAYS_KEYS fire on every run (harness physics).
LEARNED_KEYS fire only when the current activation column listed them.
"""

from __future__ import annotations

import re
import shlex
from typing import Any, Callable, Iterable, Iterator

DENY_KEYS = (
    "libc_disasm",
    "libc_debug",
    "interactive",
    "writeup_fetch",
    "gdb_library_path",
    "kb",
    "docker_down",
    "memory_peek",
    "design_docs",
    "other_challenge",
    "weaken_protection",
    "channel_bypass",
)

ALWAYS_KEYS = frozenset(
    {
        "libc_disasm",
        "libc_debug",
        "interactive",
        "writeup_fetch",
        "kb",
        "docker_down",
        "memory_peek",
        # Design notes, experiment logs and test fixtures are the operator's,
        # not the run's: reading them reveals the arm and the expected solution.
        "design_docs",
        "other_challenge",
        # Always on: this is integrity, not learned behaviour. A chain that
        # disabled a mitigation is a false positive, and f+ is the metric the
        # whole design ranks first.
        "weaken_protection",
        # The channel (sync, login shell, venv, timeout, integrity gate) is the
        # harness's job. Driving it directly skips all of that and puts
        # credentials in the transcript for no benefit.
        "channel_bypass",
    }
)
LEARNED_KEYS = frozenset(set(DENY_KEYS) - ALWAYS_KEYS)

# Do not match "glibc-2.27" as the system libc.
LIBC_MARK = ("libc.so", "/usr/lib/libc", "/lib/x86_64-linux-gnu/libc", "ld-linux", "ld.so")
DISASM = ("objdump", "ropgadget", "ropper", "rizin", "radare2")
DEBUG = ("gdb", "lldb", "gdbserver", "pwndbg")

# Tokens that mean "we are only asking whether this exists", not "run it".
_QUERY_TOKENS = ("command -v", "command -V", "which ", "type ", "hash ", "whereis ")

# A debugger invocation is interactive when it will wait for a terminal. These
# are the flags that make it non-interactive instead.
_BATCH_FLAGS = ("-batch", "--batch", "-ex quit", "-x ", "--command=", "-batch-silent")

# Shell constructs that can feed a debugger without a tty.
_REDIRECT = re.compile(r"(<|<<|<<<|\|)")

# Quoted text is DATA. Splitting a command on `|` without stripping quotes turns
# a grep pattern like "launching|tmux|gdb|error" into a segment whose first word
# is `gdb`, which then looks like a debugger invocation — a false refusal that
# hit a real run.
_QUOTED = re.compile(r"'[^']*'|\"[^\"]*\"")


def _unquoted(low: str) -> str:
    """Drop quoted segments so separators inside them are not separators."""
    return _QUOTED.sub(" ", low)


def _channel_bypass(low: str) -> bool:
    """Is the model driving the execution channel itself?

    The harness owns the channel: file sync, the login-shell preamble, the
    venv, the timeout, and the integrity gate. Reaching the endpoint directly
    skips every one of those, and the guard cannot see what runs on the far
    side — a command that is refused locally would sail through there.

    Only the harness's OWN endpoint is refused. An ssh- or docker-based CTF
    *service* is a legitimate target, so those stay reachable.
    """
    from aegis.paths import CONTAINER, REMOTE_HOST, REMOTE_USER

    host = REMOTE_HOST.lower()
    user_at_host = f"{REMOTE_USER}@{REMOTE_HOST}".lower()
    container = CONTAINER.lower()

    for segment in re.split(r"[;&|]+", low):
        seg = segment.strip()
        try:
            parts = shlex.split(seg)
        except ValueError:
            parts = seg.split()
        while parts and re.match(r"^[a-z_][a-z0-9_]*=", parts[0]):
            parts = parts[1:]
        if not parts:
            continue
        prog = parts[0].rsplit("/", 1)[-1]

        if prog in ("ssh", "sshpass", "scp", "sftp", "autossh"):
            if host and host in seg:
                return True
            if user_at_host and user_at_host in seg:
                return True
            continue

        if prog == "docker":
            # Only the harness container matters; other images are the user's
            # business, not a bypass.
            if container in seg and any(v in seg for v in ("exec", "run", "attach", "cp", "compose")):
                return True
    return False


def _channel_bypass_message() -> str:
    return (
        "REFUSED (channel_bypass): 执行通道由 harness 管，不要自己连。\n\n"
        "直接 `ssh` 到通道主机（或 `docker exec` 进容器）会跳过：\n"
        "  - 题目文件的同步与陈旧文件清理\n"
        "  - 登录环境（虚拟环境、PATH、pwntools）\n"
        "  - 超时管理与输出捕获\n"
        "  - 工具层对远端行为的检查\n\n"
        "正确做法：把要跑的命令原样交给 `aegis_pwn`，例如\n"
        "  aegis_pwn(\"checksec --file=./pwn\")\n"
        "它会在当前通道里执行并把输出原样返回。换通道用 `AEGIS_CHANNEL=container`。"
    )


def _weaken_findings(low: str):
    """Mitigation-weakening mutations in this command (see aegis/integrity.py)."""
    from aegis.policy.integrity import scan_command

    return scan_command(low)


def _weaken_message(low: str) -> str:
    from aegis.policy.integrity import scan_command, summarise

    found = scan_command(low)
    body = summarise(found)
    return (
        "REFUSED (weaken_protection): 不允许通过关闭本地保护来打通。\n\n" + body
    )


def _slash_fetch(low: str) -> bool:
    if "://" not in low:
        return False
    return any(t in low for t in ("curl ", "wget ", "httpie", "fetch "))


def _challenge_path_prefixes() -> list[str]:
    """Every path prefix under which a challenge directory can appear.

    Derived from the configured channels rather than hard-coded, because the
    same challenge is reachable as `test/<n>` in the repo, `/work/aegis/<n>` in
    the docker container, and `~/Tmp/aegis/<n>` on the remote host. A guard that
    knows only the docker path lets the remote case through silently — which is
    exactly what happened when the remote became the primary channel.

    Returned lower-cased: refuse_reason() normalises the command with .lower()
    before matching, so a `$HOME` prefix would never match otherwise.
    """
    from aegis.paths import REMOTE_WORKDIR, REMOTE_USER, SYNC_MOUNT

    prefixes = ["test/"]

    for template in (SYNC_MOUNT + "/{challenge}", REMOTE_WORKDIR):
        prefix = template.split("{challenge}")[0]
        if not prefix:
            continue
        prefixes.append(prefix)
        # The remote path is written with a tilde; commands may spell it out.
        if prefix.startswith("~/"):
            rest = prefix[2:].rstrip("/")
            prefixes.append(f"$home/{rest}/")
            prefixes.append(f"${{home}}/{rest}/")
            prefixes.append(f"/home/{REMOTE_USER}/{rest}/")
    return sorted({p.lower() for p in prefixes if p}, key=len, reverse=True)


def _current_challenge_name() -> str:
    """The challenge this run is working on.

    `active_challenge()` reads only AEGIS_CHALLENGE, which is set for the Pi
    session but not when the CLI is invoked directly. Falling back to the saved
    run state matters: with an empty name every path looks like someone else's,
    so the guard refused the agent's OWN challenge directory.
    """
    from aegis.storage.store import active_challenge

    env = active_challenge()
    if env:
        return env
    try:
        from aegis.storage.store import load_current

        return str((load_current() or {}).get("challenge") or "")
    except Exception:
        return ""


def _other_challenge(low: str) -> bool:
    """Is the command touching a challenge directory that is not the current one?

    Own-challenge access stays allowed; the point is to stop one run from
    reading another run's exploit, on whichever channel it lives.
    """
    prefixes = _challenge_path_prefixes()
    if not any(p in low for p in prefixes):
        return False
    try:
        from aegis.paths import list_challenges

        cur = _current_challenge_name()
        for name in list_challenges():
            if name == cur:
                continue
            if any((p + name) in low for p in prefixes):
                return True
    except Exception:
        return False
    return False


def _memory_path(low: str) -> bool:
    for token in (
        ".aegis",
        "runs/",
        "lessons.json",
        "atlas.json",
        "search.json",
        "activation.json",
    ):
        if token in low:
            return True
    return False


# The harness's own design notes, experiment logs and test data.
#
# These are for the human operator, never the run. A run that reads them can see
# the experiment it is part of: which arm it is in, what the expected solution
# is, and the frozen experience of earlier challenges. Any of those invalidates
# the measurement, and unlike `runs/` they are ordinary readable files with no
# other thing standing between the model and them.
_DESIGN_TOKENS = (
    "docs/",
    "tests/",
    # Our pi fork: a vendored dependency with its own git. A run must not read
    # the observer extension that is recording it.
    "vendor/",
    # The root design docs. The extension blocks these by basename for the
    # read/write/edit tools, but a bash command only consults this predicate —
    # so `cat 架构.md` sailed through while `read 架构.md` was refused. Same
    # class of gap as the `_KB` filename that the `kb` rule used to swallow.
    "架构.md",
    "框架.md",
    "readme.md",
    "deepseek_agents.md",
)


def _design_path(low: str) -> bool:
    return any(t in low for t in _DESIGN_TOKENS)


_HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
_FILE_WRITE = re.compile(r"(?:^|[;&|]\s*)(?:cat|tee)\b[^;|&]*?>{1,2}\s*\S+\s*$")


def strip_file_heredocs(command: str) -> str:
    """Drop heredoc bodies that are being written INTO A FILE.

    `cat > exp.py <<'EOF' ... io.interactive() ... EOF` writes data. Refusing it
    because the data mentions `interactive()` blocks an ordinary way to author
    an exploit — and that is what happened in a real run.

    Only file writes are stripped. `python3 - <<EOF` feeds an interpreter, so
    its body IS executed and must still be inspected.
    """
    lines = command.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m = _HEREDOC.search(line)
        if m and _FILE_WRITE.search(line[: m.start()]):
            delim = m.group(2)
            out.append(line)
            i += 1
            while i < len(lines) and lines[i].strip() != delim:
                i += 1
            i += 1  # skip the delimiter itself
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


def _mentions_debugger(low: str) -> bool:
    """Is a debugger being *invoked* (not merely named or queried)?

    `command -v gdb`, `which gdb`, `grep gdb out.txt` all name gdb without
    running it. Only the first word of a pipeline segment counts as an
    invocation, unless a query token is present.
    """
    raw = _unquoted(low)
    if any(q in raw for q in _QUERY_TOKENS):
        return False
    for segment in re.split(r"[;&|]+", raw):
        segment = segment.strip()
        if not segment:
            continue
        try:
            parts = shlex.split(segment)
        except ValueError:
            parts = segment.split()
        # skip leading env assignments: `NO_COLOR=1 gdb ...`
        while parts and re.match(r"^[a-z_][a-z0-9_]*=", parts[0]):
            parts = parts[1:]
        if not parts:
            continue
        prog = parts[0].rsplit("/", 1)[-1]
        if prog in DEBUG:
            return True
        # `timeout 30 gdb ...`, `sudo gdb ...`, `env gdb ...`
        if prog in ("timeout", "sudo", "env", "nice", "stdbuf", "time"):
            for tok in parts[1:]:
                if re.match(r"^\d+[smhd]?$", tok) or tok in ("-k", "--kill-after"):
                    continue
                if tok.rsplit("/", 1)[-1] in DEBUG:
                    return True
                if not tok.startswith("-"):
                    break
    return False


def _gdb_interactive(low: str) -> bool:
    """Interactive debugger = will block waiting for a terminal.

    Replaces a bare `"gdb" in low` test, which refused `command -v gdb` and
    `grep ... /tmp/gdbout.txt` (the substring `gdb` appears in the filename).
    """
    if not _mentions_debugger(low):
        return False
    if any(f in low for f in _BATCH_FLAGS):
        return False
    return True


def _interactive_shell(low: str) -> bool:
    """pwntools interactive(), or a shell/gdb that will wait on a tty."""
    if "p.interactive" in low or "interactive()" in low or ".interactive(" in low:
        return True
    if _gdb_interactive(low):
        return True
    # A bare interactive shell with no input redirection will hang the harness.
    for segment in re.split(r"[;&|]+", _unquoted(low)):
        segment = segment.strip()
        try:
            parts = shlex.split(segment)
        except ValueError:
            parts = segment.split()
        while parts and re.match(r"^[a-z_][a-z0-9_]*=", parts[0]):
            parts = parts[1:]
        if not parts:
            continue
        prog = parts[0].rsplit("/", 1)[-1]
        if prog in ("bash", "sh", "zsh", "fish") and not _REDIRECT.search(segment):
            args = parts[1:]
            # `bash -i` is interactive. A bare `bash` with nothing to do reads
            # from the terminal and blocks. Everything else — `bash -c '...'`,
            # `bash script.sh` — runs to completion, and refusing a script just
            # because it is executed through bash was a false refusal.
            if "-i" in args:
                return True
            positional = [a for a in args if not a.startswith("-")]
            if not positional and "-c" not in args:
                return True
    return False


def _libc_tool(low: str, tools: tuple[str, ...]) -> bool:
    """Is `tools` being run *against* a libc?

    Requires both a libc marker and an actual invocation of the tool, so
    `readelf -sW /usr/lib/libc.so.6` stays legal (readelf is in neither list)
    while `objdump -d libc.so.6` is refused.
    """
    if not any(m in low for m in LIBC_MARK):
        return False
    for segment in re.split(r"[;&|]+", _unquoted(low)):
        try:
            parts = shlex.split(segment.strip())
        except ValueError:
            parts = segment.split()
        while parts and re.match(r"^[a-z_][a-z0-9_]*=", parts[0]):
            parts = parts[1:]
        if parts and parts[0].rsplit("/", 1)[-1] in tools:
            return True
    return False


RULES: list[tuple[str, Callable[[str], bool], str]] = [
    (
        "libc_disasm",
        lambda s: _libc_tool(s, DISASM),
        "REFUSED (libc_disasm): do not objdump/ROPgadget/ropper libc.so. "
        "QEMU x86 times out and drops docker exec. "
        "Use: readelf -sW /usr/lib/libc.so.6 | grep -E ' system$| __libc_system'",
    ),
    (
        "libc_debug",
        lambda s: _libc_tool(s, DEBUG),
        "REFUSED (libc_debug): do not gdb libc.so. Use readelf/pwnx on the challenge binary.",
    ),
    (
        "interactive",
        _interactive_shell,
        "REFUSED (interactive): 一次性调用里跑交互式程序会死锁——harness 等进程退出，"
        "而进程在等输入。\n\n"
        "分两种情况：\n"
        "  * **已知要问什么**（跑一次、看固定输出）→ 用 `gdb -batch -ex ... -ex quit`，"
        "或直接 `timeout 10 ./chall`。快、可复现。\n"
        "  * **还不知道要看什么**（要停下来看了再决定）→ 用 **`aegis_shell`**：\n"
        "      aegis_shell(\"gdb -q ./pwn\")      # 进会话\n"
        "      aegis_shell(\"break *0x400a1c\")   # 设断点\n"
        "      aegis_shell(\"run\")               # 跑到断点\n"
        "      aegis_shell(\"x/8gx $rsp\")        # 看内存，再决定下一步\n"
        "    会话跨调用存活，程序可以停在提示符上等你。这正是一次性调用做不到的。",
    ),
    (
        "gdb_library_path",
        lambda s: _mentions_debugger(s) and ("--library-path" in s or "library-path" in s),
        "REFUSED (gdb_library_path): gdb --library-path does not work here. "
        "Use glibc-all-in-one + patchelf, then run the patched binary.",
    ),
    (
        "writeup_fetch",
        _slash_fetch,
        "REFUSED (writeup_fetch): do not pull writeups off the network during a run. "
        "Work from observations; a WP may be replayed offline as a hint.",
    ),
    (
        "kb",
        # `kb` as a command word only. The previous pattern used `[^a-z]` for the
        # boundaries, which also matches `_` and `.` — so a filename like
        # `MEMORY.md`'s predecessor `HEAP_KB.md` was refused as if it were the
        # `kb` command. That is the expensive kind of false refusal: it silently
        # hides the run's own memory file from it.
        lambda s: bool(re.search(r"(?:^|[\s;&|])kb(?:\s|$)", s)),
        "REFUSED (kb): the kb knowledge base is disabled in this demo.",
    ),
    (
        "docker_down",
        lambda s: ("docker compose down" in s)
        or ("docker-compose down" in s)
        or ("docker compose stop" in s)
        or ("docker-compose stop" in s)
        or ("./stop.sh" in s),
        "REFUSED (docker_down): the pwn container is shared. Never stop it.",
    ),
    (
        "memory_peek",
        _memory_path,
        "REFUSED (memory_peek): .aegis/ and runs/ are not readable from inside a run. "
        "Experience reaches you only through the activated column.",
    ),
    (
        "design_docs",
        _design_path,
        "REFUSED (design_docs): docs/ and tests/ hold the operator's design notes, "
        "experiment logs and test fixtures, and vendor/ holds the pi fork that records "
        "this run. Reading them would show you the experiment you are part of, so they "
        "are out of scope for a run.",
    ),
    (
        "other_challenge",
        _other_challenge,
        "REFUSED (other_challenge): only the current challenge directory is in scope.",
    ),
    (
        "weaken_protection",
        lambda s: bool(_weaken_findings(s)),
        "",  # message is built from the findings
    ),
    (
        "channel_bypass",
        _channel_bypass,
        "",  # static message; nothing to interpolate
    ),
]

_BY_KEY = {k: (pred, msg) for k, pred, msg in RULES}


# Rules that exist only because one-shot execution cannot host a terminal.
# Inside a session these are the intended usage, not violations.
_ONESHOT_ONLY = frozenset({"interactive"})


def refuse_reason(
    command: str,
    extra: Iterable[str] = (),
    *,
    session: bool = False,
    learned: Iterable[Any] = (),
) -> str | None:
    """Would this command be refused?

    `session=True` relaxes exactly the rules that exist because a one-shot call
    has no terminal. `gdb ./pwn` hangs a one-shot invocation (the harness waits
    for a process that waits for input) but is the whole point of a session.

    Everything else still applies — including the integrity rules — so the
    session cannot become a way around them.
    """
    # Strip file-content heredocs BEFORE normalising whitespace: the
    # normalisation collapses newlines, which destroys the heredoc structure
    # that the stripping relies on.
    command = strip_file_heredocs(command)
    low = " ".join(command.lower().split())
    if not low:
        return None
    for key, pred, msg in RULES:
        if key not in ALWAYS_KEYS:
            continue
        if session and key in _ONESHOT_ONLY:
            continue
        try:
            if pred(low):
                if key == "weaken_protection":
                    return _weaken_message(low)
                if key == "channel_bypass":
                    return _channel_bypass_message()
                return msg
        except Exception:
            continue
    extra_set = {str(k) for k in extra}
    for key in extra_set:
        if key in ALWAYS_KEYS:
            continue
        entry = _BY_KEY.get(key)
        if entry and entry[0](low):
            if key == "weaken_protection":
                return _weaken_message(low)
            if key == "channel_bypass":
                return _channel_bypass_message()
            return entry[1]

    # Learned vetoes: command words that never succeeded in this world, derived
    # from recorded experience by `policy.veto`. Matched at a **command position**
    # only — start of the command, or after a separator. NOT after a plain space,
    # because `grep ROPgadget notes.txt` merely mentions the word, and refusing a
    # mention is exactly the false refusal that hides information from the run.
    # (The `kb` rule needed the same narrowing after `[^a-z]` swallowed
    # `HEAP_KB.md` and hid the run's own memory file from it.)
    for pattern, reason in _learned_items(learned):
        # `low` is already lower-cased, so the pattern must be too.
        if re.search(r"(?:^|[;&|()])[ \t]*" + re.escape(pattern.lower()) + r"(?:[ \t]|$)", low):
            return reason
    return None


def _learned_items(learned: Iterable[Any]) -> Iterator[tuple[str, str]]:
    """Normalise learned vetoes to (pattern, message).

    Accepts plain strings and objects carrying `.pattern` / `.reason()` so this
    module stays a pure predicate with no dependency on `policy.veto`.
    """
    for item in learned:
        if isinstance(item, str):
            if item:
                yield item, f"REFUSED (learned_veto): '{item}' is a recorded failure in this world."
            continue
        pattern = str(getattr(item, "pattern", "") or "")
        if not pattern:
            continue
        reason = getattr(item, "reason", None)
        yield pattern, (reason() if callable(reason) else f"REFUSED (learned_veto): '{pattern}'")


def skip_rule_from_command(command: str) -> str:
    low = " ".join(strip_file_heredocs(command).lower().split())
    for key, pred, _msg in RULES:
        try:
            if pred(low):
                return key
        except Exception:
            continue
    compact = " ".join(command.split())
    if len(compact) > 160:
        compact = compact[:157] + "..."
    return "timed-out/failed tool pattern: " + compact
