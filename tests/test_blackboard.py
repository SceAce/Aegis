"""Blackboard and native-event-adapter invariants.

The blackboard is the only channel between agents, and the native event stream is
how memory is fed. Both fail loudly rather than guessing, and these tests pin
that: a silent mis-read is what produced the previous round's wrong world model.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from aegis import observer as obs
from aegis.blackboard import store as bb
from aegis.observer import native


def test_board_roundtrip() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        board = bb.load(d)
        assert board.schema == bb.BOARD_SCHEMA
        assert board.requirements == [] and board.tasks == []

        board.requirements.append(bb.Requirement(id="need-001", text="get a shell", marker="PWNED_MARKER"))
        board.tasks.append(bb.Task(id="task-001", text="leak libc", owner="child"))
        bb.save(d, board)

        again = bb.load(d)
        assert [r.id for r in again.requirements] == ["need-001"]
        assert again.requirements[0].marker == "PWNED_MARKER"
        assert [t.id for t in again.tasks] == ["task-001"]
        assert [t.id for t in again.open_tasks()] == ["task-001"]


def test_board_schema_mismatch_fails_loudly() -> None:
    """A board from another schema must raise, not be interpreted loosely."""
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        bb.board_path(d).write_text(json.dumps({"schema": 99}), encoding="utf-8")
        try:
            bb.load(d)
        except RuntimeError as exc:
            assert "v99" in str(exc)
            return
        raise AssertionError("a foreign blackboard schema was accepted")


def test_board_recovers_from_corruption() -> None:
    """A truncated board must not brick the run: quarantine it, start empty."""
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        bb.board_path(d).write_text("{not valid json", encoding="utf-8")
        board = bb.load(d)
        assert board.requirements == [] and board.tasks == []
        assert list(d.glob("*.corrupt*")), "corrupt board was deleted instead of kept as evidence"


def test_verdict_states_are_distinct() -> None:
    """accepted leaves the open list, rejected does not count as unresolved.

    'rejected' must stay distinguishable from 'accepted': conflating "not done"
    with "done wrong" is how a failed path silently becomes the recorded answer.
    """
    board = bb.Blackboard(
        tasks=[
            bb.Task(id="a", text="x", state="accepted"),
            bb.Task(id="b", text="y", state="rejected"),
            bb.Task(id="c", text="z", state="open"),
        ]
    )
    assert [t.id for t in board.open_tasks()] == ["b", "c"]
    assert [t.id for t in board.unresolved_tasks()] == ["c"]


def _write_native(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")


def test_native_events_roundtrip() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_native(
            d / "observer" / "events-s1.jsonl",
            [
                {"v": 1, "seq": 1, "ts": "T", "worker": "pi", "session": "s1", "kind": "action",
                 "tool": "aegis_pwn", "callId": "c1", "data": {"input": {"command": "checksec"}}},
                {"v": 1, "seq": 2, "ts": "T", "worker": "pi", "session": "s1", "kind": "outcome",
                 "tool": "aegis_pwn", "callId": "c1", "ok": True, "data": {"text": "NX enabled"}},
            ],
        )
        events = list(native.read_native_events(d))
        assert [e.kind for e in events] == ["action", "outcome"]
        assert events[0].tool == "aegis_pwn"
        assert events[1].ok is True

        memory = obs.build_memory(events)
        assert len(memory) == 1 and memory[0].ok is True


def test_native_event_schema_mismatch_fails_loudly() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_native(d / "observer" / "events-s1.jsonl", [{"v": 7, "seq": 1, "kind": "action"}])
        try:
            list(native.read_native_events(d))
        except RuntimeError as exc:
            assert "v7" in str(exc)
            return
        raise AssertionError("a foreign native event schema was accepted")
