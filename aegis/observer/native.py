"""Adapter for the **native** observer stream written by the pi fork.

The pi extension (`vendor/pi/packages/coding-agent/src/extensions/observer`)
writes one JSONL per session using an **Aegis-owned** schema:

    {"v":1,"seq":1,"ts":"...","worker":"pi","session":"...",
     "kind":"action","tool":"aegis_pwn","callId":"...","ok":true,"data":{...}}

Why not read pi's own session log: that format is internal and versioned, and
parsing it couples this side to pi's migrations. Reading a format we own is the
whole reason the observer was made native.

A version we do not know is an error, never a guess.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

from aegis.core.events import Event

#: Native event schema version we can read.
SUPPORTED_EVENT_SCHEMA = 1

OBSERVER_SUBDIR = "observer"
EVENT_GLOB = "events-*.jsonl"


def event_files(state_dir: Path) -> list[Path]:
    """All native event streams under a state dir, oldest first."""
    d = state_dir / OBSERVER_SUBDIR
    if not d.is_dir():
        return []
    return sorted(d.glob(EVENT_GLOB))


def read_native_events(state_dir: Path) -> Iterator[Event]:
    """Native event JSONL -> normalized `Event` stream."""
    for path in event_files(state_dir):
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                row = json.loads(raw)
            except json.JSONDecodeError:
                yield Event("pi", path.stem, 0, "", "note", data={"malformed": raw[:200]})
                continue

            version = row.get("v")
            if version != SUPPORTED_EVENT_SCHEMA:
                raise RuntimeError(
                    f"native event schema v{version} is not v{SUPPORTED_EVENT_SCHEMA}; "
                    "update this adapter instead of guessing at the shape."
                )

            kind = str(row.get("kind") or "note")
            data = dict(row.get("data") or {})
            # The extension records a tool call's arguments under `input`. Rename
            # it to `args` so both adapters (native and session-log) hand
            # downstream the same shape — a normalised event is the whole point of
            # having adapters at all.
            if kind == "action" and "args" not in data and "input" in data:
                data["args"] = data.pop("input")

            yield Event(
                worker=str(row.get("worker") or "pi"),
                session=str(row.get("session") or path.stem),
                seq=int(row.get("seq") or 0),
                ts=str(row.get("ts") or ""),
                kind=kind,
                tool=(str(row["tool"]) if row.get("tool") else None),
                call_id=(str(row["callId"]) if row.get("callId") else None),
                ok=(bool(row["ok"]) if row.get("ok") is not None else None),
                data=data,
            )
