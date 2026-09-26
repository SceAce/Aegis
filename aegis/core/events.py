"""归一化事件 —— 领域模型，供所有 worker adapter 产出、所有下游消费。

为什么独立成一层：换 worker（pi / Codex / DSH）时只换 adapter，事件形状不变。
所以「事件」是领域概念，不是某个 adapter 的私产。

`kind` 只允许下面几种。任何**语义解释**都不属于事件层 —— 事件记录"发生了什么"，
"这意味着什么"属于经验层，"这算不算成功"属于成果标准。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

#: Allowed event kinds. Kept closed so downstream can switch exhaustively.
KINDS = ("action", "outcome", "observation", "goal", "note", "boundary", "thought")


@dataclass(frozen=True)
class Event:
    """worker 流程里发生的一件事，已归一化。"""

    worker: str
    session: str
    seq: int
    ts: str
    kind: str  # one of KINDS
    tool: str | None = None
    call_id: str | None = None
    #: Tool-level success for `outcome` events. None means "not an outcome" or
    #: "unknown" — deliberately distinct so callers cannot confuse "did not fail"
    #: with "not applicable". NOTE: this is a *tool* signal, not a goal signal.
    #: Whether the run advanced is decided by the criterion, never by this flag.
    ok: bool | None = None
    data: dict[str, Any] = field(default_factory=dict)
