"""Guard regression tests.

Written after auditing 43 recorded harness issues (23 timeout / 18 refused).

The finding: 5 of the 18 refusals were FALSE, and every one came from matching
`gdb` as a bare substring. A false refusal is not a neutral event — it hides the
information the agent was probing for, so the agent probes again, is refused
again, and the run burns down in a loop. The recorded evidence shows exactly
that: four consecutive `command -v gdb` / `which pwnx` probes, all refused.

So these tests assert BOTH directions. A guard that only gets stricter is not an
improvement.

Run: uv run --no-sync python tests/test_guard.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aegis.policy.guard import refuse_reason  # noqa: E402

# (command, should_be_refused, expected_key_or_None)
CASES: list[tuple[str, bool, str | None]] = [
    # ---- environment probing: these MUST be allowed -----------------------
    # Every one of these was refused in a real run.
    ("command -v gdb", False, None),
    ("command -v patchelf", False, None),
    ("which pwnx gdb patchelf", False, None),
    ("grep -a SIGSEGV /tmp/gdbout.txt", False, None),
    ("tr -cd '\\11\\12\\15\\40-\\176' < /tmp/gdbout.txt", False, None),
    ("ls -la /tmp/gdbout.txt", False, None),
    ("cat /tmp/gdbout.txt | head -40", False, None),
    ("sed -n '80,220p' /tmp/gdbout.txt", False, None),
    ("ls /opt", False, None),
    ("ls -d /glibc-all-in-one", False, None),
    ("cat /proc/sys/kernel/core_pattern", False, None),
    ("ulimit -c", False, None),
    # ---- legitimate libc inspection (readelf/strings are fine) ------------
    ("readelf -sW /usr/lib/libc.so.6 | grep -E ' system$'", False, None),
    ("strings /usr/lib/libc.so.6 | grep -oE 'GLIBC_2\\.[0-9]+'", False, None),
    ("ldd ./chall", False, None),
    ("/lib/x86_64-linux-gnu/libc.so.6", False, None),
    # ---- legitimate challenge work ---------------------------------------
    ("objdump -d ./chall", False, None),
    ("objdump -d --start-address=0x400000 ./chall", False, None),
    ("ROPgadget --binary ./chall --only 'pop|ret'", False, None),
    ("checksec file ./chall --no-banner --color never -o json", False, None),
    ("pwnx gadgets ./chall --grep 'pop rdi' --first", False, None),
    ("pwnx run ./chall", False, None),
    ("timeout 10 ./chall", False, None),
    ("file ./chall", False, None),
    ("strings -n 5 ./chall", False, None),
    ("patchelf --set-interpreter ./ld.so ./chall", False, None),
    # batch debugger is the sanctioned form
    ("gdb -q -batch -ex 'b *0x400a1c' -ex run ./chall", False, None),
    ("NO_COLOR=1 gdb -q -batch -ex quit ./chall", False, None),
    ("gdb --batch -x script.gdb ./chall", False, None),
    # ---- things that MUST still be refused --------------------------------
    ("gdb ./chall", True, "interactive"),
    ("gdb -q ./chall", True, "interactive"),
    ("timeout 30 gdb ./chall", True, "interactive"),
    ("bash", True, "interactive"),
    ("bash -i", True, "interactive"),
    ("python3 exp.py", False, None),  # a script is fine
    ('python3 -c "p.interactive()"', True, "interactive"),
    ('python3 -c "p.sendline(b\'x\'); p.interactive()"', True, "interactive"),
    # libc disassembly: QEMU times out and drops docker exec
    ("objdump -d /usr/lib/libc.so.6", True, "libc_disasm"),
    ("ROPgadget --binary /usr/lib/libc.so.6", True, "libc_disasm"),
    ("ropper -f /lib/x86_64-linux-gnu/libc.so.6", True, "libc_disasm"),
    ("gdb /usr/lib/libc.so.6", True, "libc_debug"),
    # shared container
    ("docker compose down", True, "docker_down"),
    ("docker-compose stop", True, "docker_down"),
    ("./stop.sh", True, "docker_down"),
    # memory peeking
    ("cat .aegis/atlas.json", True, "memory_peek"),
    ("ls runs/", True, "memory_peek"),
    ("cat lessons.json", True, "memory_peek"),
    # network writeups
    ("curl https://example.com/wp.md", True, "writeup_fetch"),
    ("wget http://foo/bar", True, "writeup_fetch"),
]


def test_guard_matrix():
    failures = []
    for cmd, want_refuse, want_key in CASES:
        reason = refuse_reason(cmd)
        got_refuse = bool(reason)
        got_key = reason.split("(")[1].split(")")[0] if reason else None
        if got_refuse != want_refuse:
            failures.append(
                f"{'FALSE REFUSAL' if got_refuse else 'MISSED'}: {cmd!r} -> "
                f"{got_key if got_refuse else 'allowed'}"
            )
        elif want_key and got_key != want_key:
            failures.append(f"WRONG KEY: {cmd!r} -> {got_key}, wanted {want_key}")
    assert not failures, "\n".join(failures)


def test_no_false_refusal_on_probing():
    """The specific regression that cost the most time.

    `gdb` appears in `gdbout.txt` and in `command -v gdb`. Neither runs a
    debugger. Four recorded refusals came from this one substring test.
    """
    for cmd in (
        "command -v gdb",
        "which gdb",
        "grep -a SIGSEGV /tmp/gdbout.txt",
        "ls -la /tmp/gdbout.txt",
        "tr -cd a < /tmp/gdbout.txt",
    ):
        assert refuse_reason(cmd) is None, f"false refusal on {cmd!r}"


def test_interactive_still_caught():
    """Tightening must not open a hole: a bare debugger still hangs."""
    for cmd in ("gdb ./chall", "gdb -q ./chall", "bash", "bash -i"):
        assert refuse_reason(cmd), f"should be refused: {cmd!r}"


def test_libc_readelf_is_allowed():
    """The refusal message tells the agent to use readelf. It must work."""
    for cmd in (
        "readelf -sW /usr/lib/libc.so.6 | grep -E ' system$'",
        "strings /usr/lib/libc.so.6 | head",
    ):
        assert refuse_reason(cmd) is None, f"refused the sanctioned fallback: {cmd!r}"


def test_other_challenge_covers_every_channel_path():
    """A challenge is reachable under several roots; all must be guarded.

    Regression: the guard knew only `test/` and `/work/aegis/` (docker). When
    the remote host became the primary channel, `cat ~/Tmp/aegis/pwn_2/exp.py`
    was ALLOWED — so one run could read another run's exploit.
    """
    from aegis.paths import REMOTE_USER
    from aegis.storage.store import save_current

    save_current({"challenge": "pwn_1", "kind": "pwn"})
    foreign = [
        "cat test/pwn_2/exp.py",
        "cat /work/aegis/pwn_2/exp.py",
        "cat ~/Tmp/aegis/pwn_2/exp.py",
        f"cat /home/{REMOTE_USER}/Tmp/aegis/pwn_2/exp.py",
        "cat $HOME/Tmp/aegis/pwn_2/exp.py",
    ]
    for cmd in foreign:
        assert refuse_reason(cmd), f"other-challenge access allowed: {cmd}"


def test_own_challenge_is_allowed_on_every_path():
    """The guard must not refuse the agent's own working directory.

    Regression: `_other_challenge` compared against active_challenge(), which
    reads only AEGIS_CHALLENGE. Invoked from the CLI that is unset, so the
    current challenge looked foreign and its own directory was refused.
    """
    from aegis.paths import REMOTE_USER
    from aegis.storage.store import save_current

    save_current({"challenge": "pwn_1", "kind": "pwn"})
    own = [
        "cat test/pwn_1/exp.py",
        "cat /work/aegis/pwn_1/exp.py",
        "cat ~/Tmp/aegis/pwn_1/exp.py",
        f"ls /home/{REMOTE_USER}/Tmp/aegis/pwn_1",
        "ls -la",
        "ls ~/Tmp/aegis",
    ]
    for cmd in own:
        assert refuse_reason(cmd) is None, f"own challenge refused: {cmd}"


def test_channel_endpoint_is_not_the_models_to_drive():
    """The harness owns the channel; reaching it directly skips its guarantees.

    Going around `aegis_pwn` means no file sync, no login environment, no
    timeout — and the guard cannot see what runs on the far side, so a command
    refused locally would sail through there. The endpoint address was also
    sitting in the model-facing docs, which invited exactly this.
    """
    from aegis.paths import CONTAINER, REMOTE_HOST

    for cmd in (
        f"ssh {REMOTE_HOST} 'ls /tmp'",
        f"sshpass -p x ssh hack@{REMOTE_HOST} ls",
        f"scp ./exp.py hack@{REMOTE_HOST}:/tmp",
        f"docker exec {CONTAINER} bash -lc 'ls'",
        f"docker cp ./x {CONTAINER}:/work",
    ):
        assert refuse_reason(cmd), f"channel bypass allowed: {cmd}"


def test_ssh_challenges_stay_reachable():
    """The rule must not break ssh-based CTF targets.

    Only the harness's own endpoint is refused. A challenge served over ssh is
    a legitimate thing to connect to.
    """
    for cmd in (
        "ssh user@challenge.ctf.sh -p 2222",
        "ssh -i key.pem ctf@10.0.0.5",
        "nc pwn.challenge.ctf.show 28203",
        "ssh-keygen -t rsa -f ./k",
        "docker exec some-other-box ls",
    ):
        assert refuse_reason(cmd) is None, f"legitimate target refused: {cmd}"


def test_file_content_heredoc_is_data_not_commands():
    """Writing an exploit that MENTIONS interactive() must not be refused.

    Regression: a real run lost two turns because `cat > exp.py <<'EOF' ...
    io.interactive() ... EOF` was refused — the body is file content, and
    nothing interactive was going to execute.
    """
    write = "cat > exp.py <<'EOF'\nfrom pwn import *\nio.interactive()\nEOF"
    assert refuse_reason(write) is None, refuse_reason(write)

    # A body fed to an interpreter IS executed and must still be inspected.
    assert refuse_reason("python3 - <<PY\ns=s.replace(1, 'io.interactive()')\nPY")


def test_shell_scripts_are_not_interactive_shells():
    """`bash script.sh` runs to completion; only a bare shell blocks."""
    assert refuse_reason("bash setup.sh") is None
    assert refuse_reason("bash -c 'ls'") is None
    assert refuse_reason("bash")  # bare: reads the terminal
    assert refuse_reason("bash -i")


def test_file_heredoc_is_not_a_weaken_protection_bypass():
    """Writing a mitigation-disabling script is allowed; running it is not.

    The guard sees a file write, not execution, so the tree/channel scan is the
    thing that must catch it — verified separately in test_integrity.
    """
    write = "cat > exp.py <<'EOF'\ncontext.aslr = False\nEOF"
    assert refuse_reason(write) is None
    # The interpreter form is execution and stays refused.
    assert refuse_reason("python3 - <<PY\nimport os\nos.system('setarch -R ./pwn')\nPY")


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
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
