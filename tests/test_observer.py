"""Observer invariants.

These tests exist to pin the two claims the design rests on, so that a later
refactor cannot quietly undo them:

  1. Memory is extracted **mechanically** from worker logs. If a parser change
     starts inventing or dropping events, these tests fail.
  2. Memory **never drives action**. The prompt-assembly path must not be able
     to reach the Observer at all. That is asserted structurally, not by
     convention.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from aegis import observer as obs


def _fake_session(path: Path, *, version: int = obs.SUPPORTED_SESSION_VERSION) -> None:
    """A minimal but real-shaped Pi session: one toolCall + its toolResult."""
    header = {
        "type": "session",
        "version": version,
        "id": "test-session",
        "timestamp": "2026-01-01T00:00:00.000Z",
        "cwd": str(Path.cwd()),
    }
    assistant = {
        "type": "message",
        "id": "m1",
        "timestamp": "2026-01-01T00:00:01.000Z",
        "message": {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "thinking out loud — must NOT become memory"},
                {"type": "thinking", "thinking": "secret reasoning"},
                {
                    "type": "toolCall",
                    "id": "call_1",
                    "name": "aegis_pwn",
                    "arguments": {"command": "objdump -d --start-address=0x1337 ./pwn"},
                },
            ],
        },
    }
    result = {
        "type": "message",
        "id": "m2",
        "timestamp": "2026-01-01T00:00:02.000Z",
        "message": {
            "role": "toolResult",
            "toolCallId": "call_1",
            "toolName": "aegis_pwn",
            "isError": False,
            "content": [{"type": "text", "text": "disassembly ... uid=0(root) ..."}],
        },
    }
    path.write_text(
        "\n".join(json.dumps(e) for e in (header, assistant, result)) + "\n",
        encoding="utf-8",
    )


def test_version_guard_fails_loudly() -> None:
    """An unknown session format must raise, never be parsed on a guess."""
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "s.jsonl"
        _fake_session(p, version=999)
        try:
            list(obs.read_pi_session(p))
        except RuntimeError as exc:
            assert "v999" in str(exc)
            return
        raise AssertionError("unknown session version was accepted silently")


def test_action_outcome_pairing() -> None:
    """One toolCall must produce exactly one memory record, with its outcome."""
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "s.jsonl"
        _fake_session(p)
        events = list(obs.read_pi_session(p))
        assert [e.kind for e in events] == ["action", "outcome"], [e.kind for e in events]
        mem = obs.build_memory(events)
        assert len(mem) == 1, mem
        assert mem[0].tool == "aegis_pwn"
        assert mem[0].ok is True
        assert mem[0].out_chars > 0


def test_prose_and_thinking_never_become_memory() -> None:
    """The model's narration is not an event. Memory is what happened, not what
    it said about what happened."""
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "s.jsonl"
        _fake_session(p)
        mem = obs.build_memory(list(obs.read_pi_session(p)))
        blob = json.dumps([m.__dict__ for m in mem], ensure_ascii=False)
        assert "thinking out loud" not in blob
        assert "secret reasoning" not in blob


def test_memory_is_concrete_experience_is_portable() -> None:
    """Memory keeps this-challenge detail; experience strips it so it can cross
    challenges. This is the fix for 'addresses leaked into the criteria table'."""
    concrete = "objdump -d --start-address=0x1337 /Users/x/Aegis/test/pwn_1/exp.py"
    portable = obs.portable(concrete)
    assert "0x1337" not in portable, portable
    assert "/Users/" not in portable, portable
    assert "pwn_1" not in portable, portable
    assert "objdump" in portable, portable


def test_distill_is_arithmetic_only() -> None:
    """Experience is counting. Same input -> same output, and no row can appear
    that was not counted from memory."""
    records = [
        obs.MemoryRecord("pi", "s", 1, "", "t", "pwn: do x", True, 1, "d"),
        obs.MemoryRecord("pi", "s", 2, "", "t", "pwn: do x", False, 1, "d"),
        obs.MemoryRecord("pi", "s", 3, "", "t", "pwn: do y", True, 1, "d"),
    ]
    exp = obs.distill(records)
    by = {e.action: e for e in exp}
    assert by["pwn: do x"].n_ok == 1 and by["pwn: do x"].n_fail == 1
    assert by["pwn: do y"].n_ok == 1 and by["pwn: do y"].n_fail == 0
    assert len(exp) == 2


def test_criterion_is_mechanical() -> None:
    """The success standard is external text, checked by literal match."""
    events = [
        obs.Event("pi", "s", 1, "", "action", tool="aegis_pwn"),
        obs.Event("pi", "s", 2, "", "outcome", tool="aegis_pwn",
                  data={"text": "PWNED_MARKER\nuid=0(root) gid=0(root)"}),
    ]
    assert obs.find_criterion(events, obs.Criterion(need="PWNED_MARKER", next="uid=0(root)")) == 2
    assert obs.find_criterion(events, obs.Criterion(need="PWNED_MARKER", next="uid=1000")) is None
    assert obs.find_criterion(events, obs.Criterion(need="", next="")) is None


def test_memory_cannot_drive_action() -> None:
    """STRUCTURAL invariant: the prompt-assembly path must not reach the Observer.

    `ram_blob` decides what the worker sees. If it ever mentions the observer,
    memory has become a behaviour input, which the design forbids. Only
    distilled experience may reach the worker.

    Checked on the *rendering functions* rather than the whole module, because
    store.py is also where memory will legitimately be persisted — writing
    memory to disk is fine, rendering it into the prompt is not.
    """
    import inspect

    from aegis.policy import intervene
    from aegis.storage import store

    for fn in (store.ram_blob, intervene.render, intervene.decide):
        src = inspect.getsource(fn)
        assert "observer" not in src, f"{fn.__module__}.{fn.__name__} reached into memory"


def test_observer_view_never_returns_prompt_text() -> None:
    """The Observer's own output is for humans/audit. It must not be shaped as
    prompt material — no system-prompt headers, no 'inject' framing."""
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "s.jsonl"
        _fake_session(p)
        mem = obs.build_memory(list(obs.read_pi_session(p)))
        for row in mem:
            text = json.dumps(row.__dict__, ensure_ascii=False)
            assert "<system" not in text.lower()
            assert "aegis ram" not in text.lower()
