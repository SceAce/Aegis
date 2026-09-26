"""How a run's outcome is judged: the criterion, the script audit, and the trail.

These cover the three false-positive holes found on a real pwn_1 run:

  * the criterion matched the blackboard's own JSON at seq 3, before the agent
    had done anything;
  * the criterion matched `cat TASK.md`, because the task file documents the
    marker;
  * a run's problem list was the same sync line eighteen times, burying every
    real harness problem.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from aegis.core.criterion import Criterion, find_criterion
from aegis.core.events import Event


def _out(seq: int, tool: str, text: str) -> Event:
    return Event(worker="pi", session="s", seq=seq, ts="", kind="outcome", tool=tool, data={"text": text})


PROOF = "=== SHELL OUTPUT ===\nPWNED_MARKER\nuid=1000(hack)\nPARENT_PROC=pwn\n=== END ==="


# ------------------------------------------------------------------ criterion


def test_criterion_ignores_non_execution_tools() -> None:
    """Reading a thing is not proof about the thing.

    Regression: a real run's criterion fired at seq 3 — on `aegis_board(read)`,
    whose output is the board JSON, which contains the marker because the user
    put it there.
    """
    events = [_out(1, "aegis_board", PROOF), _out(2, "read", PROOF), _out(3, "aegis_kb", PROOF)]
    assert find_criterion(events, Criterion(need="PWNED_MARKER", next="PARENT_PROC=pwn")) is None
    assert find_criterion(events, Criterion(need="PWNED_MARKER")) is None


def test_criterion_requires_printed_not_mentioned() -> None:
    """`cat TASK.md` contains the marker inside `echo PWNED_MARKER; ...`.

    Same run: the second false positive was a bash command printing the task
    file. A proof arrives on its own line; a mention is preceded by `echo`.
    """
    mentioned = _out(1, "bash", "echo PWNED_MARKER; id; echo PARENT_PROC=$(cat /proc/$$/stat)")
    assert find_criterion([mentioned], Criterion(need="PWNED_MARKER")) is None
    quoted = _out(2, "bash", '  "marker": "PWNED_MARKER",')
    assert find_criterion([quoted], Criterion(need="PWNED_MARKER")) is None


def test_criterion_accepts_a_real_proof() -> None:
    assert find_criterion([_out(1, "aegis_pwn", PROOF)], Criterion(need="PWNED_MARKER")) == 1
    assert (
        find_criterion([_out(1, "aegis_pwn", PROOF)], Criterion(need="PWNED_MARKER", next="PARENT_PROC=pwn"))
        == 1
    )


def test_criterion_requires_both_markers_in_one_outcome() -> None:
    """Splitting the evidence across two outputs would let a spliced success pass."""
    events = [_out(1, "aegis_pwn", "PWNED_MARKER"), _out(2, "aegis_pwn", "PARENT_PROC=pwn")]
    assert find_criterion(events, Criterion(need="PWNED_MARKER", next="PARENT_PROC=pwn")) is None


# ---------------------------------------------------------------------- audit


CHEAT = """import subprocess
subprocess.run(["sh", "-c", "echo PWNED_MARKER"])
print(open("/flag").read())
"""

REAL = """from pwn import *
p = process("./pwn")
p.sendline(b"echo PWNED_MARKER; echo PARENT_PROC=$(cat /proc/$$/stat)")
print(p.recvline())
"""


def test_audit_finds_a_direct_flag_read() -> None:
    from aegis.policy import audit

    findings = audit.audit_script(CHEAT, marker="PWNED_MARKER", target="pwn", where="solve.py")
    rules = {f.rule for f in findings}
    assert "direct_flag_read" in rules
    assert any(f.conclusive for f in findings), "reading /flag must invalidate the run"


def test_audit_passes_a_real_exploit() -> None:
    from aegis.policy import audit

    findings = audit.audit_script(REAL, marker="PWNED_MARKER", target="pwn", where="solve.py")
    assert findings == [], [f.line() for f in findings]


def test_audit_self_printed_marker_is_advisory_only() -> None:
    """A script that prints the marker without driving the target is suspicious,
    not proven guilty: unusual-but-honest scripts would trip it too, and erasing
    real work is its own kind of expensive mistake."""
    from aegis.policy import audit

    text = 'print("PWNED_MARKER")\n'
    findings = audit.audit_script(text, marker="PWNED_MARKER", target="pwn", where="x.py")
    assert [f.rule for f in findings] == ["self_printed_marker"]
    assert not any(f.conclusive for f in findings)


def test_audit_skips_hidden_dirs_and_detects_the_target() -> None:
    from aegis.policy import audit

    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "pwn").write_bytes(b"\x7fELF" + b"\x00" * 60)
        (d / "solve.py").write_text(REAL, encoding="utf-8")
        (d / ".pwninit-backups").mkdir()
        (d / ".pwninit-backups" / "old.py").write_text(CHEAT, encoding="utf-8")

        assert audit.detect_target(d) == "pwn"
        findings = audit.audit_challenge(d, marker="PWNED_MARKER", target="pwn")
        assert findings == [], "a backup directory is not the agent's work"


# ------------------------------------------------------------- issue collapsing


def test_repeated_issues_collapse_to_a_count() -> None:
    """One fact eighteen times buries every other problem in the writeup."""
    from aegis.storage import store

    with tempfile.TemporaryDirectory() as td:
        original = store.ISSUES_PATH
        store.ISSUES_PATH = Path(td) / "issues.jsonl"
        try:
            for _ in range(18):
                store.append_issue("sync", "preserved channel-side files", challenge="pwn_1")
            store.append_issue("channel", "fell back", challenge="pwn_1")
            rows = store.load_issues("pwn_1")
            assert len(rows) == 2, rows
            by_kind = {r["kind"]: r for r in rows}
            assert by_kind["sync"]["n"] == 18
            assert by_kind["channel"]["n"] == 1
        finally:
            store.ISSUES_PATH = original


# -------------------------------------------------------------------- archive


def test_archive_keeps_scripts_and_skips_the_binary() -> None:
    """`cmd_finish` runs `git clean -fd` on the challenge dir, so the archived
    copy is the only evidence of what the run actually executed."""
    import aegis.paths as paths
    from aegis.channel import dockerutil
    from aegis.storage import compile as compile_mod

    # This test is about the *local* copy path. The channel pull is exercised by
    # `test_archive_distinguishes_empty_from_unreadable`; here it is stubbed so the
    # suite never reaches the network.
    original_pull = dockerutil.fetch_artifacts
    dockerutil.fetch_artifacts = lambda *a, **k: {
        "readable": True,
        "copied": 0,
        "source": "stub",
        "detail": "stub",
        "truncated": [],
    }

    with tempfile.TemporaryDirectory() as td:
        state = Path(td) / "state"
        challenge = Path(td) / "test" / "pwn_1"
        challenge.mkdir(parents=True)
        (challenge / "pwn").write_bytes(b"\x7fELF" + b"\x00" * 60)
        (challenge / "solve.py").write_text(REAL, encoding="utf-8")

        # `archive_scripts` imports these from `paths` at call time, so patching
        # the module attributes is what takes effect.
        old_state, old_dir = paths.AEGIS_DIR, paths.challenge_dir
        paths.AEGIS_DIR = state
        paths.challenge_dir = lambda name: challenge
        try:
            report = compile_mod.archive_scripts("pwn_1")
        finally:
            paths.AEGIS_DIR, paths.challenge_dir = old_state, old_dir
            dockerutil.fetch_artifacts = original_pull

        dest = Path(report["path"])
        names = sorted(p.name for p in dest.iterdir())
        assert "solve.py" in names
        assert "pwn" not in names, "the binary is already in git; do not copy it"
        assert "MANIFEST.txt" in names
        assert "process(" in (dest / "solve.py").read_text(encoding="utf-8")


def test_weak_branch_accepts_an_in_place_execve_proof() -> None:
    """A real exploit can be invisible to the strong marker.

    An in-place one_gadget `execve("/bin/sh")` makes the shell **be** the former
    target process: its parent is the exploit script and `pwn` is gone from
    `/proc` entirely. A real pwn_3 run was refused for exactly this, so the
    ancestry branch exists — reported separately from `strong`, because it is only
    credible once the script audit corroborates it (`storage.compile._fold`).
    """
    from aegis.core.criterion import execution_branch

    criterion = Criterion(need="PWNED_MARKER", next="PARENT_PROC=pwn")
    strong = _out(1, "aegis_pwn", PROOF)
    weak = _out(
        2,
        "aegis_pwn",
        "PWNED_MARKER\nuid=1000(hack)\nPARENT_PROC=python3\n"
        "TARGET_GONE=yes\nORIGIN=python3>bash>sshd>",
    )
    self_started = _out(3, "aegis_pwn", "PWNED_MARKER\nuid=1000(hack)\nPARENT_PROC=python3\nTARGET_GONE=no")

    assert execution_branch([strong], criterion)["branch"] == "strong"
    assert execution_branch([weak], criterion)["branch"] == "weak"
    # Never ran the target, or started a shell by hand: not a proof either way.
    assert execution_branch([self_started], criterion) is None
    assert execution_branch([_out(4, "read", weak.data["text"])], criterion) is None


def test_weak_branch_still_needs_the_marker_in_the_same_outcome() -> None:
    """`TARGET_GONE=yes` alone must not certify: an agent that never touched the
    target also has no target process alive."""
    from aegis.core.criterion import execution_branch

    criterion = Criterion(need="PWNED_MARKER", next="PARENT_PROC=pwn")
    assert execution_branch([_out(1, "aegis_pwn", "TARGET_GONE=yes\nuid=1000")], criterion) is None
    assert execution_branch([_out(2, "aegis_pwn", "PWNED_MARKER\nTARGET_GONE=yes")], criterion)


# ------------------------------------------------------- evidence archive


def test_archive_distinguishes_empty_from_unreadable() -> None:
    """An archive built only from `test/<ch>` is empty for a remote run, and an
    empty archive makes the script audit silently vacuous — a pwn_3 run made 82
    `aegis_pwn` calls, wrote nothing locally, and left `files: 0`.

    The report must separate "the host has no scripts" (evidence) from "we could
    not look" (the absence of evidence), because `_fold` treats them differently.
    """
    from aegis import paths
    from aegis.channel import dockerutil
    from aegis.storage import compile as compile_mod

    class _Down:
        available = False
        kind = "ssh"
        target = ""
        detail = "host unreachable"
        name = "remote"

        def label(self) -> str:
            return "ssh (unavailable)"

        def dir_for(self, challenge: str) -> str:
            return f"/w/{challenge}"

    with tempfile.TemporaryDirectory() as td:
        dest = Path(td)
        report = dockerutil.fetch_artifacts("pwn_1", dest, channel=_Down())
        assert report["readable"] is False, report
        assert report["copied"] == 0
        assert "host unreachable" in str(report["detail"])

    # And the report the archive returns carries that flag through.
    original = dockerutil.fetch_artifacts
    dockerutil.fetch_artifacts = lambda *a, **k: {
        "readable": False,
        "copied": 0,
        "source": "ssh (unavailable)",
        "detail": "host unreachable",
        "truncated": [],
    }
    try:
        report = compile_mod.archive_scripts("pwn_1", stamp="TEST_ARCHIVE")
    finally:
        dockerutil.fetch_artifacts = original
    try:
        assert report["readable"] is False
        manifest = (Path(report["path"]) / "MANIFEST.txt").read_text()
        assert "host_readable: False" in manifest, manifest
        assert "exec_host:" in manifest
    finally:
        import shutil

        shutil.rmtree(Path(paths.AEGIS_DIR) / "artifacts" / "TEST_ARCHIVE_pwn_1", ignore_errors=True)
