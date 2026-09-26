"""Pipeline: event stream -> memory -> experience. All mechanical.

Re-running this must not double-count, so records are de-duplicated on
`(session, seq)` — the event stream is append-only and a run is re-read every
time the column is rebuilt.

This is the only place the two stores meet. Downstream (`policy/playbook.py`)
receives `Experience` only; it never sees a `MemoryRecord`.
"""

from __future__ import annotations

from pathlib import Path

from aegis.memory import store as memory_store
from aegis.observer.extract import Event, Experience, MemoryRecord, build_memory, distill
from aegis.observer.native import event_files, read_native_events


def collect(state_dir: Path) -> tuple[list[Event], list[MemoryRecord]]:
    """Read the native event stream and pair it into memory records."""
    events = list(read_native_events(state_dir))
    return events, build_memory(events)


def _key(record: MemoryRecord) -> tuple[str, int]:
    return (record.session, record.seq)


#: Evidence tiers whose records may produce positive experience.
TRUSTED_EVIDENCE = ("flag", "local")


def sync(state_dir: Path, *, evidence: str = "local", reason: str = "") -> dict:
    """Fold the event stream into the memory store, without double-counting.

    `evidence` decides whether this batch may produce **positive** experience:

        flag / local  -> yes; the run genuinely worked
        none / wiki   -> no; the records are still stored (auditable), but their
                         outcomes are neutralised to ok=None so they can never
                         count as a success

    This is where the old "a chain that weakened a mitigation must not teach a
    technique" rule now lives. It matters because `none` is exactly what a solve
    by disabling ASLR looks like after `cmd_finish` downgrades it — and storing
    that as a success would teach the next run to disable ASLR first.

    The neutralised records stay in memory rather than being deleted: the run
    happened, and a future reader must be able to see it.
    """
    _, fresh = collect(state_dir)
    if evidence not in TRUSTED_EVIDENCE:
        fresh = [
            MemoryRecord(
                worker=r.worker,
                session=r.session,
                seq=r.seq,
                ts=r.ts,
                tool=r.tool,
                action=r.action,
                ok=None,  # neutralised: contributes neither success nor failure
                out_chars=r.out_chars,
                out_digest=r.out_digest,
                condition=r.condition,
            )
            for r in fresh
        ]

    existing = memory_store.load(state_dir)
    seen = {_key(r) for r in existing}
    new = [r for r in fresh if _key(r) not in seen]
    if new:
        memory_store.append(state_dir, new)
    return {
        "events": len(fresh),
        "records_total": len(existing) + len(new),
        "records_new": len(new),
        "sessions": len({r.session for r in existing + new}),
        "evidence": evidence,
        "trusted": evidence in TRUSTED_EVIDENCE,
        "reason": reason,
    }


def experience(state_dir: Path) -> list[Experience]:
    """All experience derivable from stored memory. Counting only — no LLM."""
    return distill(memory_store.load(state_dir))


def current_session(state_dir: Path) -> str | None:
    """The newest session stream — i.e. the run in progress, or the last one.

    By file mtime: a session's file is written as it runs, so the newest one is
    the live run.
    """
    files = event_files(state_dir)
    if not files:
        return None
    newest = max(files, key=lambda path: path.stat().st_mtime)
    stem = newest.stem
    return stem[len("events-") :] if stem.startswith("events-") else stem


def world_tags(state_dir: Path, session: str | None = None) -> set[str]:
    """World tags observed **in the current run**, for gating experience.

    Scoped to one session on purpose. Reading every stream ever written would let
    the previous challenge's final world qualify experience for the next one
    before it had measured anything — the run would start already believing it
    was in a world nobody had observed. "Only observed things drive action" has
    to mean *this* run's observations.

    Reads both shapes: a dedicated `observation` event, and an `aegis_observe`
    *action* (the pi extension records observations as tool calls, not as a
    separate event kind). Missing the second shape made the world look empty
    while records were clearly conditional, which silently disabled guidance.

    Within the run, a later observation supersedes a contradictory earlier one
    rather than unioning: a tag the run has already left must not keep qualifying
    experience.
    """
    from aegis.observer.extract import observed_tags, reconcile

    scope = session if session is not None else current_session(state_dir)
    tags: set[str] = set()
    for e in read_native_events(state_dir):
        if scope is not None and e.session != scope:
            continue
        if e.kind == "observation":
            raw = (e.data or {}).get("tags")
            if isinstance(raw, (list, tuple)):
                tags = reconcile(tags, {str(t).strip() for t in raw if str(t).strip()})
        elif e.kind == "action":
            tags = reconcile(tags, observed_tags(str(e.tool or ""), (e.data or {}).get("args")))
    return tags
