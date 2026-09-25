"""Session tests: the capability one-shot execution cannot provide.

The decisive fact, from this project's own run records
(runs/20260922T122052_pwn_2.md): the pwn_2 setup needs ~240 s of heap
exhaustion, and the recorded loop `timeout 240 python3 exp.py` actually hit the
timeout. Inspecting that state one-shot means re-running the setup per look, so
adaptive debugging is arithmetically impossible without a session.

Two properties matter most here, and neither is about the transport:

  1. **State survives across harness invocations.** Every CLI call is a separate
     process; a session rebuilt per call would carry nothing.
  2. **The session is not a bypass.** Commands entering it are guard-checked
     with the same rules as anything else — including the integrity rules — so
     the relaxed `interactive` rule is the ONLY thing that changes.

Run: uv run --no-sync python tests/test_session.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aegis.policy.guard import refuse_reason  # noqa: E402
from aegis.channel.session import clean  # noqa: E402

# ------------------------------------------------------------ output hygiene


def test_strips_ansi_escapes():
    """The login shell here is zsh with per-character highlighting.

    Raw, one command produces thousands of colour escapes and the real output is
    unreadable. Stripping is not cosmetic.
    """
    raw = "\x1b[32me\x1b[32mc\x1b[32mh\x1b[39mo\x1b[12C\x1b[?1l\x1b>\x1b[?2004l\nHELLO\n"
    out = clean(raw)
    assert "\x1b" not in out, repr(out)
    assert "HELLO" in out, repr(out)


def test_strips_osc_and_control_bytes():
    raw = "\x1b]0;title\x07visible\x00\x08text\rmore\r\n"
    out = clean(raw)
    assert "visible" in out and "text" in out
    assert "\x07" not in out and "\x00" not in out and "\r" not in out
    assert "\n" in out, "newlines must survive"


def test_keeps_ordinary_output_intact():
    plain = "pwndbg> x/4gx $rsp\n0x7ffd: 0x1 0x2\n"
    assert clean(plain) == plain


# ------------------------------------------------------- guard context split


def test_session_relaxes_only_the_interactive_rule():
    """`gdb ./pwn` hangs a one-shot call but is the point of a session.

    The relaxation must be surgical: everything else still applies, or the
    session becomes a way around the integrity rules.
    """
    assert refuse_reason("gdb ./pwn") is not None, "one-shot gdb must be refused"
    assert refuse_reason("gdb ./pwn", session=True) is None, "session gdb must be allowed"


def test_session_still_enforces_integrity():
    for cmd in (
        "setarch -R ./pwn",
        "context.aslr = False",
        "echo 0 > /proc/sys/kernel/randomize_va_space",
    ):
        assert refuse_reason(cmd, session=True) is not None, f"session allowed: {cmd}"


def test_session_still_blocks_channel_bypass():
    from aegis.paths import REMOTE_HOST

    assert refuse_reason(f"ssh {REMOTE_HOST} ls", session=True) is not None


def test_session_still_blocks_other_challenge():
    from aegis.storage.store import save_current

    save_current({"challenge": "pwn_1", "kind": "pwn"})
    assert refuse_reason("cat test/pwn_2/exp.py", session=True) is not None


def test_session_blocks_libc_disasm():
    assert refuse_reason("objdump -d /usr/lib/libc.so.6", session=True) is not None


# ------------------------------------------------------------- live channel


def _live():
    """A usable channel and a started session, or None (test is skipped)."""
    try:
        from aegis.channel.dockerutil import pick
        from aegis.channel.session import get

        ch = pick()
        if not ch.available:
            return None
        sess = get("pwn_1", ch)
        return sess if sess.started else None
    except Exception:
        return None


def test_state_persists_within_a_session():
    """cd and shell variables must survive between commands."""
    sess = _live()
    if sess is None:
        return
    sess.run("cd /tmp")
    sess.run("AEGIS_PROBE=alive")
    out = sess.run('echo "pwd=$(pwd) probe=$AEGIS_PROBE"')
    assert "pwd=/tmp" in out, out
    assert "probe=alive" in out, out


def test_output_is_readable_not_escape_soup():
    sess = _live()
    if sess is None:
        return
    out = sess.run("echo AEGIS_CLEAN_PROBE")
    assert "AEGIS_CLEAN_PROBE" in out, out
    assert "\x1b" not in out, f"escapes leaked: {out!r}"


def test_state_persists_across_processes():
    """The property that makes the feature worth having.

    Every CLI invocation is a fresh process. Two separate `Session` objects —
    simulating two invocations — must see the same shell.
    """
    from aegis.channel.dockerutil import pick
    from aegis.channel.session import Session

    ch = pick()
    if not ch.available:
        return

    first = Session(challenge="pwn_1", channel=ch)
    if not first.start(reset=True)[0]:
        return
    first.run("cd /tmp && ACROSS=carried")

    # A brand-new object, as a later process would build.
    second = Session(challenge="pwn_1", channel=ch)
    assert second.start(reset=False)[0], "failed to re-attach"
    out = second.run('echo "across=$ACROSS dir=$(pwd)"')
    assert "across=carried" in out, f"state lost across processes: {out!r}"


def test_reset_recovers_a_wedged_session():
    """A session stuck in a program must be recoverable."""
    sess = _live()
    if sess is None:
        return
    sess.run("cat", timeout=3)  # blocks on stdin, like a wedged debugger
    ok, _ = sess.reset()
    assert ok, "reset failed"
    out = sess.run("echo AEGIS_AFTER_RESET")
    assert "AEGIS_AFTER_RESET" in out, out


def test_busy_command_does_not_block_forever():
    """A long job must return partial output, not hang the run.

    This is what structurally replaces the old deadlock: `subprocess.run` waited
    for a process that waited on us, and 10 of the 23 recorded timeouts were
    exactly that.
    """
    sess = _live()
    if sess is None:
        return
    import time

    sess.reset()  # start from a known shell: a stale program would eat the input
    t0 = time.time()
    out = sess.run("sleep 30; echo NEVER_IN_TIME", timeout=3)
    elapsed = time.time() - t0
    assert elapsed < 12, f"blocked for {elapsed:.1f}s despite a 3s budget"
    assert "仍在运行" in out, f"unfinished work not marked: {out!r}"
    assert "sleep" in out, out
    sess.reset()


# ------------------------------------------------- exp-script debugging


def test_pdb_can_drive_a_script():
    """Debugging the *script* needs a session: pdb is a REPL.

    This is the case the model hits constantly — the leak returns empty, the
    offset is wrong, the script dies at recvline — and one-shot cannot host it.
    """
    sess = _live()
    if sess is None:
        return
    sess.reset()
    sess.run("printf 'x = 41\\nx + 1\\n' > /tmp/probe_pdb.py")
    sess.send("python3 -m pdb /tmp/probe_pdb.py", settle=1.2)
    out = sess.read(timeout=10)
    # The banner is a better signal than the prompt: the prompt can land in the
    # next read, while "> file(line)<module>()" only appears once pdb is live.
    assert "probe_pdb.py(1)" in out, f"pdb did not start: {out!r}"
    sess.send("break 2", settle=0.6)
    sess.send("continue", settle=1.0)
    out = sess.capture() + sess.read(timeout=6)
    assert "probe_pdb.py(2)" in out or "x + 1" in out, f"breakpoint not hit: {out!r}"
    sess.send("quit", settle=0.6)
    sess.interrupt()


def test_panes_reports_where_things_run():
    """`gdb.attach()` opens gdb in a second pane; the model must be able to see it.

    Without pane reporting the split is invisible and the debugger is
    unreachable — the script "hangs" from the model's point of view.
    """
    sess = _live()
    if sess is None:
        return
    sess.reset()
    rows = sess.panes()
    assert rows, "no panes reported for a live session"
    assert all(r["id"].startswith("%") for r in rows), rows
    assert any(r["command"] in ("bash", "sh") for r in rows), rows


def test_capture_reads_a_pane():
    sess = _live()
    if sess is None:
        return
    sess.reset()
    sess.run("echo AEGIS_PANE_PROBE")
    out = sess.capture()
    assert "AEGIS_PANE_PROBE" in out, out
    assert "\x1b" not in out, "capture must be ANSI-stripped too"


def test_sync_catches_edits_not_just_new_files():
    """A modified script must reach the channel.

    Regression: the freshness check compared only the *name set*, so editing
    exp.py left the remote running the previous version while the model believed
    the change had landed. Silent and very confusing — the model would debug a
    script the remote never received.
    """
    from aegis.channel.dockerutil import ensure_synced, local_fingerprint, pick

    ch = pick()
    if not ch.available:
        return
    import pathlib as _pl

    f = _pl.Path(__file__).resolve().parent.parent / "test" / "pwn_1" / "exp.py"
    before = local_fingerprint("pwn_1")
    ensure_synced("pwn_1", ch, "echo hi")
    original = f.read_text(encoding="utf-8") if f.is_file() else ""
    try:
        f.write_text(original + "\n# aegis fingerprint probe\n", encoding="utf-8")
        after = local_fingerprint("pwn_1")
        assert after != before, "fingerprint did not change after an edit"
        assert ensure_synced("pwn_1", ch, "echo hi") is True
    finally:
        if original:
            f.write_text(original, encoding="utf-8")
        elif f.is_file():
            f.unlink()


def test_unchanged_tree_costs_no_round_trip():
    """The freshness decision must be local when nothing changed.

    Re-checking over ssh cost ~0.22s of a 0.6s call, on every command.
    """
    from aegis.channel.dockerutil import ensure_synced, pick

    ch = pick()
    if not ch.available:
        return
    import time

    ensure_synced("pwn_1", ch, "echo hi")
    t0 = time.time()
    for _ in range(5):
        ensure_synced("pwn_1", ch, "echo hi")
    per = (time.time() - t0) / 5
    assert per < 0.05, f"unchanged sync cost {per:.3f}s/call; expected ~0"


def _run_all() -> int:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL  {fn.__name__}\n        {exc}")
        except Exception as exc:
            failed += 1
            print(f"  ERROR {fn.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
