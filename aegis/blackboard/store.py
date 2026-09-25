"""公共黑板 —— 阶段、任务与需求的唯一真相源。

## 谁写

**Observer 是唯一写入者。** Agent 只能"提议"（声明任务、认领、报告、下判决），
写入经过 Observer。所以被观察的东西改不了黑板 —— 这是上一轮"模型自己给自己
发 `verified`"的结构性修法。

原生 pi 扩展（`vendor/pi/.../extensions/observer/index.ts`）在进程内维护它；
Python 侧主要**读**，只在人/CLI 明确要求时写（`aegis need`）。

## 形状

与扩展里的 `Blackboard` 一一对应，同一份 JSON、同一个 schema 号。
版本不匹配就报错，不猜 —— 静默按旧格式解析正是上一轮世界模型解析反了的根因。

## 写安全

tmp + rename 原子写；损坏则改名 `.corrupt-<ts>` 保留证据并返回空板，
绝不让一次半截写把系统变成每次启动都崩。
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

#: Must match `BOARD_SCHEMA` in the pi extension.
BOARD_SCHEMA = 1

BLACKBOARD_FILE = "blackboard.json"


def board_path(state_dir: Path) -> Path:
    return state_dir / BLACKBOARD_FILE


@dataclass
class Requirement:
    """用户需求。由**外部**给出，不由生产者写。"""

    id: str
    text: str
    marker: str = ""
    by: str = "user"
    ts: str = ""


@dataclass
class Task:
    """阶段任务。父 agent 拆解下派，子 agent 认领回报。"""

    id: str
    text: str
    parent: str = ""
    marker: str = ""
    state: str = "open"  # open | claimed | reported | accepted | rejected
    owner: str = ""
    report: str = ""
    verdict: dict[str, Any] = field(default_factory=dict)
    ts: str = ""


@dataclass
class Blackboard:
    schema: int = BOARD_SCHEMA
    run: str = ""
    requirements: list[Requirement] = field(default_factory=list)
    tasks: list[Task] = field(default_factory=list)
    facts: list[dict[str, Any]] = field(default_factory=list)
    updated: str = ""

    def open_tasks(self) -> list[Task]:
        return [t for t in self.tasks if t.state not in ("accepted",)]

    def unresolved_tasks(self) -> list[Task]:
        return [t for t in self.tasks if t.state not in ("accepted", "rejected")]

    def to_row(self) -> dict[str, Any]:
        row = asdict(self)
        row["schema"] = self.schema
        return row


def _empty() -> Blackboard:
    return Blackboard()


def load(state_dir: Path) -> Blackboard:
    """Read the board. Corrupt file -> rename aside and start empty."""
    path = board_path(state_dir)
    if not path.is_file():
        return _empty()
    try:
        row = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        try:
            path.rename(path.with_suffix(f".corrupt-{int(os.times().elapsed)}"))
        except OSError:
            pass
        return _empty()

    schema = int(row.get("schema") or 0)
    if schema != BOARD_SCHEMA:
        raise RuntimeError(
            f"blackboard schema v{schema} != v{BOARD_SCHEMA}; refusing to guess at the shape"
        )
    return Blackboard(
        schema=schema,
        run=str(row.get("run") or ""),
        requirements=[Requirement(**{k: v for k, v in r.items() if k in Requirement.__dataclass_fields__}) for r in row.get("requirements") or []],
        tasks=[Task(**{k: v for k, v in t.items() if k in Task.__dataclass_fields__}) for t in row.get("tasks") or []],
        facts=list(row.get("facts") or []),
        updated=str(row.get("updated") or ""),
    )


def save(state_dir: Path, board: Blackboard) -> None:
    """Atomic write (tmp + rename). Only the Observer/human CLI should call this."""
    state_dir.mkdir(parents=True, exist_ok=True)
    from aegis.util import now_iso

    board.updated = now_iso()
    path = board_path(state_dir)
    tmp = path.with_suffix(f".tmp-{os.getpid()}")
    tmp.write_text(json.dumps(board.to_row(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
