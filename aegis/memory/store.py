"""Append-only storage for Observer-extracted memory.

One JSONL for raw records, one for compaction results, one for the audit trail.
Reads are tolerant (a bad line is skipped and reported); writes are atomic for
whole-file rewrites and plain appends for growth.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable

from aegis.observer.extract import MemoryRecord

MEMORY_DIR = "memory"
RECORDS_FILE = "records.jsonl"
AGGREGATES_FILE = "aggregates.jsonl"
FORGOTTEN_FILE = "forgotten.jsonl"


def _dir(state_dir: Path) -> Path:
    d = state_dir / MEMORY_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def records_path(state_dir: Path) -> Path:
    return _dir(state_dir) / RECORDS_FILE


def aggregate_path(state_dir: Path) -> Path:
    return _dir(state_dir) / AGGREGATES_FILE


def forgotten_path(state_dir: Path) -> Path:
    return _dir(state_dir) / FORGOTTEN_FILE


def _row(record: MemoryRecord) -> dict[str, Any]:
    return {
        "worker": record.worker,
        "session": record.session,
        "seq": record.seq,
        "ts": record.ts,
        "tool": record.tool,
        "action": record.action,
        "ok": record.ok,
        "out_chars": record.out_chars,
        "out_digest": record.out_digest,
        "condition": list(record.condition),
    }


def _record(row: dict[str, Any]) -> MemoryRecord:
    return MemoryRecord(
        worker=str(row.get("worker") or ""),
        session=str(row.get("session") or ""),
        seq=int(row.get("seq") or 0),
        ts=str(row.get("ts") or ""),
        tool=str(row.get("tool") or ""),
        action=str(row.get("action") or ""),
        ok=(None if row.get("ok") is None else bool(row["ok"])),
        out_chars=int(row.get("out_chars") or 0),
        out_digest=str(row.get("out_digest") or ""),
        condition=tuple(str(c) for c in (row.get("condition") or [])),
    )


def append(state_dir: Path, records: Iterable[MemoryRecord]) -> int:
    """Append raw records. Returns how many were written."""
    rows = list(records)
    if not rows:
        return 0
    path = records_path(state_dir)
    with path.open("a", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(_row(r), ensure_ascii=False) + "\n")
    return len(rows)


def load(state_dir: Path) -> list[MemoryRecord]:
    """All retained raw records. A malformed line is skipped, never guessed at."""
    path = records_path(state_dir)
    if not path.is_file():
        return []
    out: list[MemoryRecord] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(_record(json.loads(line)))
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return out


def load_aggregates(state_dir: Path) -> list[dict[str, Any]]:
    return _load_rows(aggregate_path(state_dir))


def load_forgotten(state_dir: Path) -> list[dict[str, Any]]:
    return _load_rows(forgotten_path(state_dir))


def _load_rows(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    out: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


def append_rows(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    rows = list(rows)
    if not rows:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    return len(rows)


def rewrite_records(state_dir: Path, records: list[MemoryRecord]) -> None:
    """Replace the raw store atomically (tmp + rename)."""
    path = records_path(state_dir)
    tmp = path.with_suffix(f".tmp-{os.getpid()}")
    with tmp.open("w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(_row(r), ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def stats(state_dir: Path) -> dict[str, int]:
    records = load(state_dir)
    return {
        "records": len(records),
        "sessions": len({r.session for r in records}),
        "aggregates": len(load_aggregates(state_dir)),
        "forgotten": len(load_forgotten(state_dir)),
    }
