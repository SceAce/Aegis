"""Memory storage and forgetting.

Forgetting has to be bounded (an unbounded record set is what pushes a future
reader toward summarising loosely — the hallucination the design avoids) and it
has to leave a trail (nothing downstream can otherwise tell "never observed" from
"observed, then dropped").
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from aegis.memory import forget, store
from aegis.observer import pipeline
from aegis.observer.extract import MemoryRecord


def _rec(session: str, seq: int, *, action: str = "pwn: do x", ok: bool | None = True,
         condition: tuple[str, ...] = ()) -> MemoryRecord:
    return MemoryRecord(
        worker="pi", session=session, seq=seq, ts="T", tool="aegis_pwn",
        action=action, ok=ok, out_chars=1, out_digest="d", condition=condition,
    )


def test_world_tags_are_scoped_to_the_current_run() -> None:
    """Experience is gated on THIS run's observations, not on history.

    Without scoping, the previous challenge's final world would qualify
    experience for the next one before it had measured anything — the new run
    would start out believing it was in a world nobody had observed for it.
    """
    import time

    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        obs_dir = d / "observer"
        obs_dir.mkdir(parents=True)

        def write(session: str, rows: list[dict]) -> None:
            (obs_dir / f"events-{session}.jsonl").write_text(
                "\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8"
            )

        def event(session: str, seq: int, kind: str, tool: str, call_id: str, data: dict, ok=None) -> dict:
            return {"v": 1, "seq": seq, "ts": "T", "worker": "pi", "session": session,
                    "kind": kind, "tool": tool, "callId": call_id, "ok": ok, "data": data}

        write("old", [
            event("old", 1, "action", "aegis_observe", "o1", {"args": {"tags": ["glibc2.27", "hooks_alive"]}}),
            event("old", 2, "outcome", "aegis_observe", "o1", {"text": "ok"}, ok=True),
        ])
        time.sleep(0.05)
        write("new", [
            event("new", 3, "action", "aegis_board", "b1", {"args": {"action": "read"}}),
            event("new", 4, "outcome", "aegis_board", "b1", {"text": "{}"}, ok=True),
        ])

        assert pipeline.current_session(d) == "new"
        assert pipeline.world_tags(d) == set(), "an earlier session's world leaked in"
        assert pipeline.world_tags(d, session="old") == {"glibc2.27", "hooks_alive"}


def test_store_roundtrip() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        assert store.load(d) == []
        assert store.append(d, [_rec("s1", 1), _rec("s1", 2)]) == 2
        got = store.load(d)
        assert [(r.session, r.seq) for r in got] == [("s1", 1), ("s1", 2)]
        assert store.stats(d)["records"] == 2


def test_sync_is_idempotent() -> None:
    """Re-reading the event stream must not double-count."""
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        obs_dir = d / "observer"
        obs_dir.mkdir(parents=True)
        rows = [
            {"v": 1, "seq": 1, "ts": "T", "worker": "pi", "session": "s1", "kind": "action",
             "tool": "aegis_pwn", "callId": "c1", "data": {"args": {"command": "x"}}},
            {"v": 1, "seq": 2, "ts": "T", "worker": "pi", "session": "s1", "kind": "outcome",
             "tool": "aegis_pwn", "callId": "c1", "ok": True, "data": {"text": "ok"}},
        ]
        (obs_dir / "events-s1.jsonl").write_text(
            "\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8"
        )
        first = pipeline.sync(d)
        second = pipeline.sync(d)
        assert first["records_new"] == 1
        assert second["records_new"] == 0, "sync double-counted on re-read"
        assert second["records_total"] == 1


def test_forget_keeps_recent_sessions_and_compacts_old() -> None:
    records = [_rec(f"s{i}", j) for i in range(10) for j in range(3)]
    p = forget.plan(records, keep_sessions=3)
    assert {r.session for r in p.keep} == {"s7", "s8", "s9"}
    assert len(p.compact) == 21
    assert p.reasons.get("compacted-old-session") == 21


def test_forget_capacity_bounds_a_single_large_session() -> None:
    records = [_rec("s1", j) for j in range(5)] + [_rec("s2", j) for j in range(5)]
    p = forget.plan(records, keep_sessions=8, max_records=6)
    assert len(p.keep) <= 6
    assert {r.session for r in p.keep} == {"s2"}, "newest session should survive"
    assert "capacity" in p.reasons


def test_refuted_condition_is_forgotten_on_evidence() -> None:
    """Evidence-driven, not time-driven: a contradicted world is what expires a
    record, not age."""
    records = [
        _rec("s1", 1, condition=("glibc2.27",)),
        _rec("s1", 2, condition=("glibc2.44",)),
    ]
    p = forget.plan(records, refuted_conditions={"glibc2.27"})
    assert len(p.refuted) == 1
    assert p.refuted[0].condition == ("glibc2.27",)
    assert [r.condition for r in p.keep] == [("glibc2.44",)]


def test_forgetting_leaves_a_trail() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        store.append(d, [_rec(f"s{i}", j) for i in range(10) for j in range(2)])
        report = forget.run(d, keep_sessions=2)
        assert report["compacted"] == 16
        assert report["kept"] == 4

        # The audit survives the mutation.
        trail = store.load_forgotten(d)
        assert len(trail) == 16
        assert {row["why"] for row in trail} == {"compacted"}

        # Raw store shrank, statistics did not disappear.
        assert len(store.load(d)) == 4
        aggs = store.load_aggregates(d)
        assert aggs, "compaction must preserve counts, not just delete"
        assert sum(a["n_ok"] + a["n_fail"] for a in aggs) == 16


def test_aggregate_is_counting_only() -> None:
    """No row may appear that was not counted from records."""
    rows = forget.aggregate([
        _rec("s1", 1, action="pwn: a", ok=True),
        _rec("s1", 2, action="pwn: a", ok=False),
    ])
    assert len(rows) == 1
    assert rows[0]["n_ok"] == 1 and rows[0]["n_fail"] == 1
