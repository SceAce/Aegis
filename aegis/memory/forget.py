"""Forgetting: bounded memory, on evidence, with a trail.

Two disciplines, both carried over from the design that was measured to work:

1. **Evidence-driven, not time-driven.** Security knowledge does not become false
   because it is old; it becomes false because the target changed. So elapsed
   time is never itself a reason to drop a record. The reason here is "already
   folded into an aggregate" or "its condition was refuted".

2. **Forgetting leaves a trail.** Silent loss of a record, a condition or a
   refusal is more expensive than an error: nothing downstream can then tell
   "never observed" from "observed, then dropped". Every drop writes an audit row.

Why forget at all: memory is concrete and unbounded, and an unbounded record set
is what pushes a future reader toward summarising it loosely — i.e. toward the
hallucination the design is trying to avoid. Compaction keeps the statistics and
drops the raw rows.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from aegis.memory.store import (
    append_rows,
    forgotten_path,
    load,
    load_aggregates,
    rewrite_records,
)
from aegis.observer.extract import MemoryRecord, portable

#: Keep this many most-recent sessions raw. Older sessions are compacted.
KEEP_SESSIONS = 8
#: Hard cap on retained raw records; compact oldest sessions until under it.
MAX_RECORDS = 4000


@dataclass
class ForgetPlan:
    """What to keep, what to fold away, and why."""

    keep: list[MemoryRecord] = field(default_factory=list)
    compact: list[MemoryRecord] = field(default_factory=list)
    refuted: list[MemoryRecord] = field(default_factory=list)
    reasons: dict[str, int] = field(default_factory=dict)

    @property
    def dropped(self) -> int:
        return len(self.compact) + len(self.refuted)


def aggregate(records: list[MemoryRecord]) -> list[dict]:
    """Fold records into counts. No generation, so nothing can be invented."""
    agg: dict[tuple[tuple[str, ...], str], dict] = {}
    for r in records:
        key = (r.condition, portable(r.action))
        row = agg.setdefault(
            key,
            {
                "v": 1,
                "condition": list(r.condition),
                "action": key[1],
                "n_ok": 0,
                "n_fail": 0,
                "sessions": [],
            },
        )
        if r.ok is True:
            row["n_ok"] += 1
        elif r.ok is False:
            row["n_fail"] += 1
        if r.session and r.session not in row["sessions"]:
            row["sessions"].append(r.session)
    return sorted(agg.values(), key=lambda r: -(r["n_ok"] + r["n_fail"]))


def _session_order(records: list[MemoryRecord]) -> list[str]:
    """Distinct sessions in first-appearance order (= append/chronological order)."""
    seen: list[str] = []
    for r in records:
        if r.session and r.session not in seen:
            seen.append(r.session)
    return seen


def plan(
    records: list[MemoryRecord],
    *,
    keep_sessions: int = KEEP_SESSIONS,
    max_records: int = MAX_RECORDS,
    refuted_conditions: set[str] | None = None,
) -> ForgetPlan:
    """Decide what to forget. Pure: it reads nothing and writes nothing."""
    refuted = set(refuted_conditions or ())
    out = ForgetPlan()

    # 1. Evidence-driven drop: a record whose world condition was refuted is not
    #    knowledge about the current world any more.
    survivors: list[MemoryRecord] = []
    for r in records:
        if refuted and any(c in refuted for c in r.condition):
            out.refuted.append(r)
        else:
            survivors.append(r)
    if out.refuted:
        out.reasons["refuted-condition"] = len(out.refuted)

    # 2. Bound the raw set: keep the most recent sessions, compact the rest.
    order = _session_order(survivors)
    old = set(order[: max(0, len(order) - keep_sessions)])
    if old:
        kept: list[MemoryRecord] = []
        for r in survivors:
            if r.session in old:
                out.compact.append(r)
            else:
                kept.append(r)
        out.reasons["compacted-old-session"] = len(out.compact)
        survivors = kept

    # 3. Hard cap, so a single enormous session cannot grow without bound.
    while len(survivors) > max_records:
        order = _session_order(survivors)
        if not order:
            break
        oldest = order[0]
        rest: list[MemoryRecord] = []
        for r in survivors:
            if r.session == oldest:
                out.compact.append(r)
            else:
                rest.append(r)
        out.reasons["capacity"] = out.reasons.get("capacity", 0) + (len(survivors) - len(rest))
        survivors = rest

    out.keep = survivors
    return out


def refute(state_dir: Path, condition: str, reason: str) -> None:
    """Mark a world condition as refuted. Evidence, not expiry."""
    from aegis.util import now_iso

    append_rows(
        state_dir / "memory" / "refuted.jsonl",
        [{"condition": condition, "reason": reason, "ts": now_iso()}],
    )


def refuted(state_dir: Path) -> set[str]:
    path = state_dir / "memory" / "refuted.jsonl"
    if not path.is_file():
        return set()
    out: set[str] = set()
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        import json

        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict) and row.get("condition"):
            out.add(str(row["condition"]))
    return out


def apply(state_dir: Path, p: ForgetPlan) -> dict:
    """Carry out a plan: write the audit trail first, then rewrite the store.

    Audit before mutation on purpose: if the process dies mid-way, the record of
    what was about to be dropped survives the drop.
    """
    from aegis.util import now_iso

    ts = now_iso()
    audit: list[dict] = []
    for r in p.compact:
        audit.append({"ts": ts, "why": "compacted", "session": r.session, "action": r.action})
    for r in p.refuted:
        audit.append({"ts": ts, "why": "refuted-condition", "session": r.session,
                      "action": r.action, "condition": list(r.condition)})
    append_rows(forgotten_path(state_dir), audit)

    if p.compact:
        append_rows(state_dir / "memory" / "aggregates.jsonl", aggregate(p.compact))
    rewrite_records(state_dir, p.keep)

    return {
        "kept": len(p.keep),
        "compacted": len(p.compact),
        "refuted": len(p.refuted),
        "aggregates": len(load_aggregates(state_dir)),
        "reasons": dict(p.reasons),
    }


def run(state_dir: Path, **kwargs) -> dict:
    """Plan and apply in one step, using the recorded refutations."""
    records = load(state_dir)
    p = plan(records, refuted_conditions=refuted(state_dir), **kwargs)
    return apply(state_dir, p)
