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

from aegis.guard import refuse_reason  # noqa: E402
from aegis.integrity import scan_command, scan_text, scan_tree  # noqa: E402

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


def test_none_verification_forces_cell_off():
    """`none` + solved must not stay ON.

    Regression: cmd_finish downgrades a weakened run to verified='none', but
    _sanitize only demoted on status != solved, so the cell stayed ON and the
    library learned "disable ASLR" as a technique.
    """
    from aegis.compile import _sanitize

    for verified, status in (("none", "solved"), ("none", "failed")):
        data = _sanitize(
            {"cells": [{"technique": "t -> x", "state": "on", "requires": {}}]},
            kind="pwn",
            verified=verified,
            status=status,
        )
        cell = data["cells"][0]
        assert cell["state"] == "off", f"{verified}/{status} stayed ON"
        assert cell["evidence"] == "none", cell["evidence"]


def test_local_success_still_stays_on():
    """The integrity rule must not undo the earlier fix.

    A genuinely local-only success is weaker evidence, not invalid evidence.
    """
    from aegis.compile import _sanitize

    data = _sanitize(
        {"cells": [{"technique": "t -> x", "state": "on", "requires": {}}]},
        kind="pwn",
        verified="local",
        status="solved",
    )
    cell = data["cells"][0]
    assert cell["state"] == "on"
    assert cell["evidence"] == "local"


def test_wiki_never_an_instruction():
    from aegis.compile import _sanitize

    data = _sanitize(
        {"cells": [{"technique": "t -> x", "state": "on", "requires": {}}]},
        kind="pwn",
        verified="wiki",
        status="solved",
    )
    assert data["cells"][0]["state"] == "off"


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
