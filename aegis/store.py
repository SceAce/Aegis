from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aegis.paths import (
    ATLAS_PATH,
    CURRENT_PATH,
    EPISODES_PATH,
    ISSUES_PATH,
    SEARCH_PATH,
    ensure_dirs,
)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _read_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def load_current() -> dict[str, Any] | None:
    data = _read_json(CURRENT_PATH, None)
    return data if isinstance(data, dict) else None


def save_current(data: dict[str, Any]) -> None:
    ensure_dirs()
    _write_json(CURRENT_PATH, data)


def clear_current() -> None:
    if CURRENT_PATH.exists():
        CURRENT_PATH.unlink()


def append_episode(**row: Any) -> None:
    ensure_dirs()
    row.setdefault("ts", now_iso())
    _append_jsonl(EPISODES_PATH, row)


def append_issue(kind: str, message: str, **extra: Any) -> None:
    ensure_dirs()
    row = {"ts": now_iso(), "kind": kind, "message": message, **extra}
    _append_jsonl(ISSUES_PATH, row)


def load_atlas() -> dict[str, Any]:
    data = _read_json(ATLAS_PATH, {"cells": []})
    if not isinstance(data, dict):
        return {"cells": []}
    data.setdefault("cells", [])
    return data


def save_atlas(data: dict[str, Any]) -> None:
    _write_json(ATLAS_PATH, data)


def load_search() -> dict[str, Any]:
    data = _read_json(SEARCH_PATH, {"rules": []})
    if not isinstance(data, dict):
        return {"rules": []}
    data.setdefault("rules", [])
    return data


def save_search(data: dict[str, Any]) -> None:
    _write_json(SEARCH_PATH, data)


def upsert_cell(*, technique: str, condition: str, state: str, source: str) -> None:
    atlas = load_atlas()
    cells: list[dict[str, Any]] = atlas["cells"]
    for cell in cells:
        if cell.get("technique") == technique and cell.get("condition") == condition:
            cell["state"] = state
            cell["n"] = int(cell.get("n", 0)) + 1
            cell["updated"] = now_iso()
            cell["source"] = source
            save_atlas(atlas)
            return
    cells.append(
        {
            "technique": technique,
            "condition": condition,
            "state": state,
            "n": 1,
            "source": source,
            "updated": now_iso(),
        }
    )
    save_atlas(atlas)


def upsert_search_rule(*, when: str, action: str, target: str, source: str) -> None:
    store = load_search()
    rules: list[dict[str, Any]] = store["rules"]
    for rule in rules:
        if rule.get("when") == when and rule.get("action") == action and rule.get("target") == target:
            rule["n"] = int(rule.get("n", 0)) + 1
            rule["updated"] = now_iso()
            save_search(store)
            return
    rules.append(
        {
            "when": when,
            "action": action,
            "target": target,
            "n": 1,
            "source": source,
            "updated": now_iso(),
        }
    )
    save_search(store)


def ram_blob(kind: str | None = None) -> str:
    """Small enough to dump into the prompt. Demo scale: inject the whole atlas."""
    atlas = load_atlas()
    search = load_search()
    cells = atlas.get("cells") or []
    rules = search.get("rules") or []
    if kind:
        cells = [c for c in cells if kind in str(c.get("condition", ""))]
        rules = [r for r in rules if r.get("when") == kind]
    lines = ["# 已编译经验（按条件点亮/熄灭，不是 WP 全文）", ""]
    if not cells and not rules:
        lines.append("（还没有跨题经验）")
        return "\n".join(lines)
    if cells:
        lines.append("## 策略格子")
        for c in cells:
            lines.append(
                f"- [{c.get('state')}] {c.get('technique')}  @ {c.get('condition')}  (n={c.get('n')})"
            )
        lines.append("")
    if rules:
        lines.append("## 搜索控制")
        for r in rules:
            lines.append(f"- {r.get('action')} `{r.get('target')}` when {r.get('when')} (n={r.get('n')})")
    return "\n".join(lines)
