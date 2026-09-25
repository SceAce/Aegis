"""成果标准 —— 取代「独立裁判」。

## 为什么不要独立裁判

一个单独存在的裁判，边界最难划：它得回答"这算不算成果"。这个判断在日常生活里
几乎无法事先写清楚，而凡是写不清楚的东西，最后都会退化成"谁嗓门大谁说了算"——
上一轮就是模型自己给自己发 `verified`。

## 改成什么

成果标准 = **用户需求** + **下一阶段目标**，各写成一个**可逐字核对的短标记**。

    Criterion(need="PWNED_MARKER", next="uid=0(root)")

要求短，是因为**短到能逐字核对的标准才不会被叙事糊过去**；一段散文式的验收标准
等于没有标准。判定边界因此不是一个实体，而是这两段文字本身。

## 职责划分（关键）

* 标准由**外部**给出 —— 用户写 `need`，下游（下一个阶段）写 `next`。
  **生产者不许写自己的标准**，否则它可以写一个必然满足的标准。
* 核对由 Observer **机械**执行（`find_criterion`），不做解释、不调 LLM。
* 父 agent 判断子任务成功与否，依据的是「黑板上的用户需求或阶段任务是否被满足」，
  而不是"工具退出码是不是 0"。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Protocol


class _HasOutcome(Protocol):
    """Just enough of an event for the criterion check: kind + observed text."""

    kind: str
    seq: int
    data: dict[str, Any]


@dataclass(frozen=True)
class Criterion:
    """成果标准 = 用户需求 + 下一阶段目标，各一个可逐字核对的标记。"""

    need: str  # 用户需求的可核对形式，如 "PWNED_MARKER"
    next: str = ""  # 下一阶段目标的可核对形式，如 "uid=0(root)"

    def as_row(self) -> dict[str, str]:
        return {"need": self.need, "next": self.next}

    def is_empty(self) -> bool:
        return not self.need.strip() and not self.next.strip()


def find_criterion(events: Iterable[_HasOutcome], criterion: Criterion) -> int | None:
    """返回第一条同时满足 need 与 next 的 outcome 的 seq；没有则 None。

    纯字面匹配，没有判断、没有 LLM。标准本身是外部给的，这里只负责核对。
    """
    pats = [p for p in (criterion.need, criterion.next) if p.strip()]
    if not pats:
        return None
    for e in events:
        if e.kind != "outcome":
            continue
        text = str((e.data or {}).get("text") or "")
        if all(p in text for p in pats):
            return e.seq
    return None
