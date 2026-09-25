"""Integrity tests: a chain that disabled a mitigation is not a chain.

The rule being enforced, in the project's own terms (`架构.md` §0.1):

    可实现准确率 ≤ 1 − 裁判的假阳性率 f+

A solve obtained by turning ASLR off locally is a **false positive**. It does not
transfer to the remote, and storing it as an ON cell teaches the next run
"first, disable the mitigation" — which is precisely the failure the whole
architecture ranks above coverage and cost.

Two enforcement points are tested here, because one is not enough:
  * the guard refuses the command outright
  * content scanning catches the same trick inside `exp.py`, which the guard
    cannot see (it only receives the command string)

Run: uv run --no-sync python tests/test_integrity.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aegis.policy.guard import refuse_reason  # noqa: E402
from aegis.policy.integrity import scan_command, scan_text, scan_tree  # noqa: E402

# --------------------------------------------------------------- detection


MUST_FLAG = [
    # ASLR, every spelling that reaches a real system
    "echo 0 > /proc/sys/kernel/randomize_va_space",
    "sysctl -w kernel.randomize_va_space=0",
    "sysctl kernel.randomize_va_space=0",
    "tee /proc/sys/kernel/randomize_va_space <<< 0",
    "setarch -R ./pwn",
    "setarch $(uname -m) -R ./pwn",
    "setarch x86_64 --addr-no-randomize ./exp.py",
    "context.aslr = False",
    "pwnlib.context.aslr=False",
    "ulimit -s unlimited",
    # NX
    "execstack -s ./pwn",
    "patchelf --clear-execstack ./pwn",
    # ELF mitigation flags
    "patchelf --no-pie ./pwn",
    # seccomp
    "echo 0 > /proc/sys/kernel/seccomp/actions_avail",
]

MUST_ALLOW = [
    # Observing a protection is exactly what this system wants.
    "cat /proc/sys/kernel/randomize_va_space",
    "sysctl kernel.randomize_va_space",
    "sysctl -a | grep randomize",
    "context.aslr",
    "ulimit -s",
    "execstack -q ./pwn",
    # Legitimate analysis
    "checksec --file=./pwn",
    "readelf -hW ./pwn",
    "gdb -q -batch -ex run ./pwn",
    "setarch x86_64 ./pwn",
    # Ordinary solving
    "python3 exp.py",
    "timeout 30 python3 exp.py",
    "ROPgadget --binary ./pwn | grep 'pop rdi'",
    "# setarch -R is NOT used here",
]


def test_detects_every_aslr_disable_spelling():
    missed = [c for c in MUST_FLAG if not scan_text(c)]
    assert not missed, "failed to detect: " + "; ".join(missed)


def test_reads_are_never_flagged():
    """Observation must stay allowed — the system runs on observations."""
    wrong = [c for c in MUST_ALLOW if scan_text(c)]
    assert not wrong, "false positive on: " + "; ".join(wrong)


def test_guard_refuses_the_command_form():
    for cmd in ("setarch -R ./pwn", "context.aslr = False", "ulimit -s unlimited"):
        reason = refuse_reason(cmd)
        assert reason, f"guard allowed: {cmd}"
        assert "weaken_protection" in reason, reason


def test_guard_allows_observation_form():
    for cmd in (
        "cat /proc/sys/kernel/randomize_va_space",
        "checksec --file=./pwn",
        "python3 exp.py",
    ):
        assert refuse_reason(cmd) is None, f"guard refused an observation: {cmd}"


# ------------------------------------------------------------ file scanning


def test_scan_tree_finds_trick_inside_a_script():
    """The gap the guard cannot close: it sees `python3 exp.py`, not the file.

    This is the case that matters most, because it is how the trick actually
    gets used — nobody types `setarch -R` on the command line when pwntools
    offers `context.aslr = False`.
    """
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "exp.py").write_text(
            "from pwn import *\ncontext.log_level='error'\ncontext.aslr = False\np = process('./chall')\n",
            encoding="utf-8",
        )
        found = scan_tree(root)
        assert found, "scripted ASLR disable was not detected"
        assert any("ASLR" in f.mitigation for f in found), found
        assert any("exp.py" in f.where for f in found), found


def test_scan_tree_ignores_legitimate_scripts():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "exp.py").write_text(
            "from pwn import *\n"
            "context.log_level = 'error'\n"
            "print('ASLR state:', open('/proc/sys/kernel/randomize_va_space').read())\n"
            "p = process('./chall')\n",
            encoding="utf-8",
        )
        assert scan_tree(root) == [], "a legitimate script was flagged"


def test_scan_tree_finds_shell_script_trick():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "run.sh").write_text("#!/bin/sh\necho 0 | tee /proc/sys/kernel/randomize_va_space\n", encoding="utf-8")
        assert scan_tree(root), "shell-script form not detected"


def test_scan_tree_reports_location():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "sub").mkdir()
        (root / "sub" / "helper.py").write_text("x = 1\ncontext.aslr = False\n", encoding="utf-8")
        found = scan_tree(root)
        assert found, "nested script not scanned"
        assert "helper.py:2" in found[0].where, found[0].where


# ------------------------------------------------ evidence-tier consequence
#
# The rule: a run that solved by weakening a mitigation is a false positive and
# must not teach the next run a technique. It used to live in `compile._sanitize`
# as an ON/OFF decision over generated cells. Compilation is now arithmetic over
# Observer events, so the same rule lives in `pipeline.sync(evidence=...)`: an
# untrusted run's records are still stored (auditable) but their outcomes are
# neutralised so they cannot count as a success.


def _native_stream(state, session: str = "s1") -> None:
    """A minimal native event stream: one tool call that succeeded."""
    import json

    d = state / "observer"
    d.mkdir(parents=True, exist_ok=True)
    rows = [
        {"v": 1, "seq": 1, "ts": "T", "worker": "pi", "session": session, "kind": "action",
         "tool": "aegis_pwn", "callId": "c1", "data": {"args": {"command": "do the thing"}}},
        {"v": 1, "seq": 2, "ts": "T", "worker": "pi", "session": session, "kind": "outcome",
         "tool": "aegis_pwn", "callId": "c1", "ok": True, "data": {"text": "it worked"}},
    ]
    (d / f"events-{session}.jsonl").write_text(
        "\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8"
    )


def _experience_after(evidence: str):
    import tempfile
    from pathlib import Path as _P

    from aegis.memory import store as memory_store
    from aegis.observer import pipeline

    tmp = tempfile.TemporaryDirectory()
    state = _P(tmp.name)
    _native_stream(state)
    pipeline.sync(state, evidence=evidence, reason="test")
    return pipeline.experience(state), memory_store.load(state), tmp


def test_untrusted_evidence_cannot_produce_positive_experience():
    """`none` must not teach a technique.

    Regression: cmd_finish downgrades a weakened run to verified='none', but the
    row still looked solved, so it stayed a success and the library learned
    "disable ASLR first".
    """
    exp, stored, tmp = _experience_after("none")
    try:
        assert stored, "an untrusted run should still be recorded (auditable)"
        assert exp, "records should still distil into rows"
        assert all(e.n_ok == 0 for e in exp), "an untrusted run taught a success"
    finally:
        tmp.cleanup()


def test_local_success_still_counts():
    """The integrity rule must not undo the other fix: a genuinely local-only
    success is weaker evidence, not invalid evidence."""
    exp, _stored, tmp = _experience_after("local")
    try:
        assert any(e.n_ok > 0 for e in exp), "a local success was dropped entirely"
    finally:
        tmp.cleanup()


def test_wiki_evidence_cannot_produce_experience():
    """An article saying "this works" is not this system having seen it work."""
    exp, _stored, tmp = _experience_after("wiki")
    try:
        assert all(e.n_ok == 0 for e in exp), "wiki content became a recorded success"
    finally:
        tmp.cleanup()


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
