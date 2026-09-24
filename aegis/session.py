"""Persistent interactive session on the execution channel.

Why this exists
---------------
One-shot execution (`aegis_pwn`) cannot debug. The arithmetic is decisive: the
pwn_2 exploit needs ~240 s of heap exhaustion to reach an interesting state
(recorded in runs/20260922T122052_pwn_2.md, where a loop of `timeout 240 python3
exp.py` actually hit the timeout). Inspecting that state one-shot means
re-running the whole setup per look. Ten looks is forty minutes of pure
re-execution. No amount of prompt guidance changes that arithmetic.

The historical objection to interactive sessions was real but misdiagnosed. The
23 recorded timeouts were dominated by pwntools scripts (10) and gdb (4) hanging
— but the *cause* was structural:

    harness: subprocess.run(cmd, timeout=T)   # waits for exit
    target:  gdb ./pwn                        # waits for input
                                              # -> mutual wait until T

The harness waited on a process that was waiting on the harness. tmux removes
that by construction: `send-keys` types and returns; `capture-pane`/file reads
are snapshots that never block. A program may sit at a prompt forever and we
still return within a bounded time.

Design
------
tmux owns the PTY (battle-tested, no custom pty fork/select loop), and
`pipe-pane` streams the session's output into a file. That combination gives the
robustness of tmux *and* offset-based incremental reads, so there is no screen
scraping and no scrollback limit.

Two things this must never become:
  * a bypass — every command entering the session is guard-checked, exactly like
    `aegis_pwn`, so the integrity rules still apply
  * a hang — `read()` has a hard deadline and returns partial output plus an
    explicit "still busy" marker rather than blocking or erroring

Terminal noise is stripped because the alternative is unreadable: the login
shell here is zsh with per-character syntax highlighting, so the raw stream is
thousands of colour escapes per command.
"""

from __future__ import annotations

import re
import shlex
import subprocess
from dataclasses import dataclass, field

from aegis.dockerutil import Channel, pick, ssh_argv, ssh_env
from aegis.store import append_issue

def clean(text: str) -> str:
    """Strip terminal decoration. Keeps \n and \t only.

    Delegates to the shared stripper so sessions and one-shot output are cleaned
    identically — the login shell here is zsh with per-character highlighting,
    and pwninit emits escapes unconditionally.
    """
    from aegis.util import strip_ansi

    return strip_ansi(text)


@dataclass
class Session:
    """A tmux-backed persistent shell on one channel."""

    challenge: str
    channel: Channel
    name: str = ""
    offset: int = 0
    log: str = ""
    fifo: str = ""
    started: bool = False
    history: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.name = f"aegis_{self.challenge}"
        base = f"/tmp/aegis_sess"
        self.log = f"{base}/{self.name}.out"

    # ------------------------------------------------------------- transport

    def _sh(self, script: str, timeout: int = 30) -> str:
        """Run a small control script on the channel (never blocks on tmux)."""
        if self.channel.kind == "docker":
            from aegis.paths import CONTAINER

            argv = ["docker", "exec", CONTAINER, "bash", "-lc", script]
            env = None
        else:
            argv = ssh_argv(self.channel.target, script, timeout=timeout)
            env = ssh_env()
        try:
            proc = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                # gdb and friends emit raw bytes; a strict decode would raise
                # instead of returning the output.
                errors="replace",
                timeout=timeout + 15,
                check=False,
                env=env,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return ""
        return proc.stdout or ""

    # ---------------------------------------------------------------- lifecycle

    def start(self, *, reset: bool = False) -> tuple[bool, str]:
        """Attach to a live session, or create one.

        Reuse is the point, not an optimisation: each harness invocation is a
        separate process, so a session that were rebuilt per call would carry no
        state at all and the whole feature would be pointless. `reset=True` is
        the explicit escape hatch from a wedged session.

        An explicit bash is started rather than the login shell: this box's zsh
        has syntax highlighting enabled, which colours the typed command
        character by character and buries real output in escapes. bash also
        matches the rule that everything here is POSIX.
        """
        if not reset and self.alive():
            # Re-attach without replaying history: start reading from the end of
            # whatever the session has already produced.
            self.started = True
            self.offset = self._size()
            return True, ""

        base = self.log.rsplit("/", 1)[0]
        kill = f"tmux kill-session -t {shlex.quote(self.name)} 2>/dev/null; "
        script = (
            f"mkdir -p {base}; "
            f"{kill}"
            f"rm -f {shlex.quote(self.log)}; "
            f"tmux new-session -d -s {shlex.quote(self.name)} -x 220 -y 50 "
            f"\"bash --norc --noprofile -i\"; "
            f"sleep 0.5; "
            f"tmux pipe-pane -t {shlex.quote(self.name)} -o "
            f"\"cat >> {shlex.quote(self.log)}\"; "
            f"sleep 0.3; "
            f"tmux ls 2>&1 | head -3"
        )
        out = self._sh(script, timeout=40)
        self.started = self.name in out
        self.offset = 0
        self.history = []
        if not self.started:
            append_issue("session", f"tmux start failed: {out.strip()[:200]}", challenge=self.challenge)
            return False, out

        # Quieten the prompt and make output colourless. NO_COLOR + TERM=dumb
        # are what stop tools emitting colour in the first place.
        self.send("export TERM=dumb NO_COLOR=1 PS1='' PS2='' PROMPT_COMMAND=", settle=0.4)
        self.send("bind 'set enable-bracketed-paste off' 2>/dev/null", settle=0.4)

        # Land in the challenge directory with the toolchain on PATH, so a
        # session starts where `aegis_pwn` would. Only ~/.profile is sourced:
        # ~/.zshrc is zsh syntax and re-setting PS1 from it reintroduces the
        # prompt noise we just removed.
        workdir = self.channel.dir_for(self.challenge)
        self.send(f"cd {workdir} 2>/dev/null || mkdir -p {workdir} && cd {workdir}", settle=0.5)
        self.send("[ -f ~/.profile ] && . ~/.profile 2>/dev/null; true", settle=0.6)
        self.send("[ -d ~/tools/CTF/bin ] && export PATH=$HOME/tools/CTF/bin:$PATH; true", settle=0.3)
        self.send("export PS1='' PS2='' PROMPT_COMMAND=; TERM=dumb; NO_COLOR=1", settle=0.3)
        self.read()
        return True, ""

    def alive(self) -> bool:
        out = self._sh(
            f"tmux has-session -t {shlex.quote(self.name)} 2>/dev/null && echo YES || echo NO"
        )
        return "YES" in out

    def stop(self) -> None:
        self._sh(f"tmux kill-session -t {shlex.quote(self.name)} 2>/dev/null; true")
        self.started = False

    def reset(self) -> tuple[bool, str]:
        """Tear down and rebuild — the escape hatch from a wedged session."""
        return self.start(reset=True)

    # -------------------------------------------------------------- interaction

    def send(self, text: str, settle: float = 0.0) -> None:
        """Type a line into the session.

        `-l` sends the text literally, so quotes, `$`, `;` and backticks are not
        reinterpreted by tmux on the way in. The newline is a separate Enter.
        """
        payload = shlex.quote(text)
        script = (
            f"tmux send-keys -t {shlex.quote(self.name)} -l {payload}; "
            f"tmux send-keys -t {shlex.quote(self.name)} Enter"
        )
        self._sh(script)
        self.history.append(text)
        if settle:
            import time

            time.sleep(settle)

    def _size(self) -> int:
        out = self._sh(f"stat -c %s {shlex.quote(self.log)} 2>/dev/null || echo 0")
        try:
            return int(out.strip().splitlines()[-1])
        except (ValueError, IndexError):
            return 0

    def read(self, *, idle: float = 0.45, timeout: float = 20.0) -> str:
        """Return only what is new since the last read.

        Bounded by `timeout` and settled by `idle`: output that stops growing for
        `idle` seconds is treated as a completed response. This is what makes an
        interactive program usable — a shell command finishes and goes quiet,
        and so does a gdb prompt, while a long-running job simply returns
        "still busy" and can be polled again instead of blocking the run.
        """
        import time

        deadline = time.time() + timeout
        last_size = -1
        quiet_since = time.time()
        while time.time() < deadline:
            size = self._size()
            if size != last_size:
                last_size = size
                quiet_since = time.time()
            elif size > self.offset and (time.time() - quiet_since) >= idle:
                break
            elif size == self.offset and (time.time() - quiet_since) >= idle:
                break
            time.sleep(0.15)

        size = self._size()
        if size <= self.offset:
            self._busy = time.time() >= deadline
            return ""
        out = self._sh(
            f"SZ=$(stat -c %s {shlex.quote(self.log)} 2>/dev/null || echo 0); "
            f"[ \"$SZ\" -gt {self.offset} ] && tail -c +$(({self.offset}+1)) {shlex.quote(self.log)} || true",
            timeout=30,
        )
        self.offset = min(size, self.offset + len(out.encode("utf-8", "replace")))
        self._busy = time.time() >= deadline
        return clean(out)

    def foreground(self) -> str:
        """What is actually running in the pane (bash, gdb, the challenge, ...).

        Without this the model cannot tell a shell prompt from a program's
        prompt, and a shell command typed while a program is waiting goes into
        that program. Reporting it makes the state legible.
        """
        out = self._sh(
            f"tmux display-message -p -t {shlex.quote(self.name)} "
            f"'#{{pane_current_command}}' 2>/dev/null"
        )
        return out.strip().splitlines()[-1].strip() if out.strip() else ""

    SHELLS = ("bash", "sh", "zsh", "fish", "dash")

    @property
    def at_shell(self) -> bool:
        fg = self.foreground()
        return (not fg) or fg in self.SHELLS

    @property
    def busy(self) -> bool:
        return bool(getattr(self, "_busy", False))

    # -------------------------------------------------------------------- run

    def run(self, command: str, *, timeout: float = 20.0) -> str:
        """Send a command and return its output, marking an unfinished one.

        The marker matters: an unfinished command must not look like an empty
        result, or the model will conclude "no output" and move on.
        """
        from aegis.guard import refuse_reason

        refused = refuse_reason(command, session=True)
        if refused:
            # The session must not become the new bypass: the same guard that
            # applies to aegis_pwn applies here.
            append_issue("refused", command, challenge=self.challenge)
            return refused
        self.send(command)
        out = self.read(timeout=timeout)

        # Where did we end up? `busy` alone is the wrong test: it only records
        # that the deadline was hit, so a still-running `sleep` looked finished.
        # The foreground process is the real signal — if it is not a shell,
        # something is still executing and the next command will be eaten by it.
        fg = self.foreground()
        if fg and fg not in self.SHELLS:
            out += (
                f"\n[仍在运行: {fg} — 你现在在这个程序里，不是 shell。"
                "发给它的输入会被它吃掉，要回 shell 先发 Ctrl-C（aegis_shell 的 "
                "interrupt）或让它自己退出。可以先 read() 看它的后续输出。]"
            )
        elif self.busy:
            out += "\n[超时：输出停了但没能确认命令结束，可再 read() 一次。]"
        return out

    # ------------------------------------------------------------ pane routing
    #
    # `gdb.attach()` with `context.terminal = ['tmux','splitw','-h']` opens gdb
    # in a NEW pane, which is exactly the two-context situation debugging an
    # exp script needs (script driving the target + debugger inspecting it).
    # The main pane is followed incrementally through the log file; other panes
    # are snapshotted with capture-pane, because a pane created later has no
    # pipe-pane attached.

    def panes(self) -> list[dict[str, str]]:
        out = self._sh(
            f"tmux list-panes -t {shlex.quote(self.name)} "
            f"-F '#{{pane_id}}|#{{pane_current_command}}|#{{pane_width}}x#{{pane_height}}|#{{pane_active}}' 2>/dev/null"
        )
        rows = []
        for line in out.splitlines():
            parts = line.strip().split("|")
            if len(parts) == 4 and parts[0].startswith("%"):
                rows.append(
                    {"id": parts[0], "command": parts[1], "size": parts[2], "active": parts[3] == "1"}
                )
        return rows

    def _resolve_pane(self, pane: str | None) -> str:
        """Default to the main pane; accept '%1' or a bare index."""
        if pane:
            return pane if pane.startswith("%") else f"%{pane}"
        for row in self.panes():
            if row["active"]:
                return row["id"]
        return "%0"

    def capture(self, pane: str | None = None, *, lines: int = 200) -> str:
        """Snapshot one pane (no log-file needed)."""
        target = self._resolve_pane(pane)
        out = self._sh(
            f"tmux capture-pane -p -t {shlex.quote(target)} -S -{int(lines)} 2>/dev/null",
            timeout=30,
        )
        return clean(out)

    def send_to(self, pane: str | None, text: str, *, settle: float = 0.0) -> None:
        """Type a line into a specific pane."""
        target = self._resolve_pane(pane)
        script = (
            f"tmux send-keys -t {shlex.quote(target)} -l {shlex.quote(text)}; "
            f"tmux send-keys -t {shlex.quote(target)} Enter"
        )
        self._sh(script)
        self.history.append(f"[{target}] {text}")
        if settle:
            import time

            time.sleep(settle)

    def interrupt_pane(self, pane: str | None = None) -> None:
        target = self._resolve_pane(pane)
        self._sh(f"tmux send-keys -t {shlex.quote(target)} C-c")

    def interrupt(self) -> str:
        """Send Ctrl-C — back to the shell from a program or a stuck prompt."""
        self._sh(f"tmux send-keys -t {shlex.quote(self.name)} C-c")
        import time

        time.sleep(0.8)
        return self.read(timeout=8)


_SESSIONS: dict[tuple[str, str], Session] = {}


def get(challenge: str, channel: Channel | None = None) -> Session:
    """The session for this challenge on the active channel, started on demand."""
    ch = channel or pick()
    key = (ch.label(), challenge)
    sess = _SESSIONS.get(key)
    if sess is None:
        sess = Session(challenge=challenge, channel=ch)
        # start() attaches when a live session already exists, which is the
        # normal case: the previous harness invocation left it running.
        sess.start(reset=False)
        _SESSIONS[key] = sess
    return sess
