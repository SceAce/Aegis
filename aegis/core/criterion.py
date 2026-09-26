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
    tool: str | None


#: Tools whose output can constitute evidence. A tool that only *reads* something
#: cannot produce proof of exploitation: the marker lives in the task file and on
#: the blackboard, so `cat TASK.md` and `aegis_board(read)` both echo it. Matching
#: those made the criterion fire at seq 3 of a real run — on the board's own JSON,
#: before the agent had done anything.
EXECUTION_TOOLS = ("aegis_pwn", "bash", "aegis_shell")


#: Weaker execution proof: the challenge process is no longer in the process
#: table. This is what "the binary execve'd *into* the shell" looks like from
#: inside the shell — an in-place one_gadget (`execve("/bin/sh")`) makes the shell
#: BE the former target process, so its parent is the exploit script and the
#: target name is gone from `/proc` entirely. A real pwn_3 run was refused for
#: exactly this reason.
#:
#: It is NOT proof on its own: an agent that never ran the target at all also has
#: no `pwn` process alive. It is only credible corroborated by the script audit
#: (`storage.compile`), which is why it is kept separate from `next` rather than
#: folded into it.
WEAK_EXEC_MARKER = "TARGET_GONE=yes"

#: Strong execution proof: the shell descends directly from the target.
STRONG_EXEC_MARKER = "PARENT_PROC=pwn"


@dataclass(frozen=True)
class Criterion:
    """成果标准 = 用户需求 + 下一阶段目标，各一个可逐字核对的标记。

    Both literals must appear in the **same execution outcome**. A marker alone is
    not proof: for a local challenge the exploited shell runs as the same uid as
    the agent, so nothing on disk can be a secret. What distinguishes a real
    exploit is that the shell descends from the target process — which is why the
    required proof reports its parent process name (see `manual/<ch>/TASK.md`).
    """

    need: str  # 用户需求的可核对形式，如 "PWNED_MARKER"
    next: str = ""  # 下一阶段目标的可核对形式，如 "PARENT_PROC=pwn"

    def as_row(self) -> dict[str, str]:
        return {"need": self.need, "next": self.next}

    def is_empty(self) -> bool:
        return not self.need.strip() and not self.next.strip()


def execution_branch(events: Iterable[_HasOutcome], criterion: Criterion) -> dict[str, Any] | None:
    """Which execution outproof matched: `strong`, `weak`, or nothing.

    `strong` is `need` + `next` (the shell's parent is the target). `weak` is
    `need` + `WEAK_EXEC_MARKER` (the target process is gone because it *became*
    the shell). The weak branch must be corroborated by the script audit before
    the run can be certified — see `aegis.storage.compile._fold`.
    """
    if criterion.is_empty():
        return None
    for e in events:
        if e.kind != "outcome" or getattr(e, "tool", None) not in EXECUTION_TOOLS:
            continue
        text = str((e.data or {}).get("text") or "")
        if criterion.need and not _printed(text, criterion.need):
            continue
        if not criterion.next:
            # A criterion carrying only the user requirement: the requirement is
            # the whole standard, so its marker alone is the strong branch.
            return {"seq": e.seq, "branch": "strong"}
        if _printed(text, criterion.next):
            return {"seq": e.seq, "branch": "strong"}
        if _printed(text, WEAK_EXEC_MARKER):
            return {"seq": e.seq, "branch": "weak"}
    return None


def _printed(text: str, needle: str) -> bool:
    """Does `needle` stand at the start of a line in this output?

    A proof is something the shell **prints**; a mention is not a proof. Both
    kinds of false positive seen in a real run disappear under this rule:

      * `cat manual/<ch>/TASK.md` contains `echo PWNED_MARKER; id; ...` — the
        marker is preceded by `echo`, not at a line start.
      * the blackboard JSON contains `"marker": "PWNED_MARKER"` — same reason
        (and reading tools are excluded anyway).

    While a real proof, produced by `echo PWNED_MARKER`, arrives on its own line.
    """
    for line in text.splitlines():
        # Tolerate a shell prompt prefix and surrounding whitespace.
        stripped = line.strip().lstrip("$#").strip()
        if stripped == needle or stripped.startswith(needle + " "):
            return True
    return False


def find_criterion(events: Iterable[_HasOutcome], criterion: Criterion) -> int | None:
    """返回第一条同时满足 need 与 next 的**执行类** outcome 的 seq；没有则 None。

    纯匹配，没有判断、没有 LLM。三处收紧都是刻意的，各自堵住一类实测到的假阳性：

    1. **只认执行类工具**（`aegis_pwn` / `bash` / `aegis_shell`）。
       读黑板、读文件、查 wiki 的输出一律不算 —— 那些地方本来就有 marker 原文。
       实测：收紧前第一次命中在 seq 3，那是**读黑板 JSON**。
    2. **必须是"打印出来"而不是"被提到"**（见 `_printed`）。
       实测：`bash: cat manual/pwn_1/TASK.md` 里就有 `echo PWNED_MARKER`。
    3. **两个标记必须在同一条输出里**，否则等于给"拼接出来的成功"开门。
    """
    found = execution_branch(events, criterion)
    return None if found is None else int(found["seq"])
