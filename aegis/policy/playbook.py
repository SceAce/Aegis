"""经验 → 行为。这是**唯一**允许影响 worker 的通道。

边界（用测试钉住，不靠自觉）：

    记忆（MemoryRecord） ──蒸馏──> 经验（Experience） ──本模块──> worker
         │                                                    ▲
         └────────────── 永远到不了这里 ──────────────────────┘

本模块只接受 `Experience`。它不 import `MemoryRecord`、也不 import
`build_memory` —— 一旦它开始读原始记录，记忆就变成行为输入了，那正是设计禁止的。

两种形态：

* **软**：把这个世界上成功率高的做法写进提示词。
* **硬**：同一世界下**从未成功过**的做法 → 明确的「不要试」。

硬拒绝的门槛刻意保守。`guard.py` 的文件头写着「误拒比漏拒贵得多」：
误拒不只是挡一条命令，它把 agent 想探测的信息藏起来了，于是 agent 再探、再被拒，
把整个 run 烧在循环里。所以一条经验要变成"不要试"，必须同时满足：

  1. 它的条件是**非空**的（无条件的失败说明不了任何世界的规律）
  2. 条件被**当前世界**满足（不是"可能成立"）
  3. 从**未成功过**（n_ok == 0）且失败次数达到阈值
"""

from __future__ import annotations

from dataclasses import dataclass, field

from aegis.observer.extract import Experience

#: How many observed failures, with zero successes, turn a technique into a "do not try".
VETO_MIN_FAILS = 2
#: Max guidance lines rendered.
K_GUIDANCE = 6
#: Max veto lines rendered.
K_VETO = 4
#: Max world-independent lines rendered in the weak tier.
K_WEAK = 4


@dataclass
class Playbook:
    """What experience says about *this* world. Nothing here comes from raw memory."""

    guidance: list[Experience] = field(default_factory=list)
    vetoes: list[Experience] = field(default_factory=list)
    #: World-independent counts, kept separate and rendered last. See `_weak`.
    weak: list[Experience] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not self.guidance and not self.vetoes and not self.weak

    @staticmethod
    def _ratio(e: Experience) -> float:
        return e.n_ok / e.n if e.n else 0.0

    def render(self) -> str:
        L: list[str] = []
        if self.guidance:
            L.append("## 经验（由记忆提纯；记忆本身不进提示词）")
            for e in self.guidance:
                cond = ",".join(e.condition) or "无特别条件"
                L.append(f"- [{e.n_ok}/{e.n}] {e.action}  @ {cond}")
            L.append("")
        if self.vetoes:
            L.append("## 不要试（同一世界下从未成功过）")
            for e in self.vetoes:
                cond = ",".join(e.condition)
                L.append(f"- {e.action}  @ {cond}  （0/{e.n}）")
            L.append("")
        if self.weak:
            # Labelled as weak on purpose. These rows were recorded before the run
            # had observed anything, so they say nothing about this world — a
            # reader (and the agent) must be able to tell them from world-matched
            # experience, or "no condition" silently becomes "always true".
            L.append("## 经验（无世界条件，弱证据 —— 仅供参考）")
            for e in self.weak:
                L.append(f"- [{e.n_ok}/{e.n}] {e.action}")
            L.append("")
        return "\n".join(L)


def applies(experience: Experience, world: set[str]) -> bool:
    """Does this experience's stated world hold now?

    An unconditional experience (empty condition) is not "applicable" in the
    strong sense — it carries no world information — so it is not admitted here.
    It goes to `_weak` instead of being dropped.
    """
    if not experience.condition:
        return False
    return set(experience.condition) <= world


def _weak(experience: Experience, world: set[str]) -> bool:
    """World-independent experience: no condition, so no world can be required.

    Dropping these outright was wrong, and the real data says so: an agent acts
    before it observes, so most records are recorded with an empty condition — a
    pwn_3 run had 114 of its 120 records that way (its observations all landed at
    seq 423+). Excluding them meant "experience drives behaviour" almost never
    fired, and that is a property of the rule, not of the data.

    Demoted rather than promoted: rendered last and labelled, never world-matched,
    and never able to become a veto (`vetoes` requires a non-empty condition).
    They are also shown on a cold start, where they are all there is — but under
    the weak heading, not as if this world had been measured.
    """
    del world  # deliberately not part of the test
    return not experience.condition


def build(
    experiences: list[Experience],
    world: set[str],
    *,
    k_guidance: int = K_GUIDANCE,
    k_veto: int = K_VETO,
    k_weak: int = K_WEAK,
    veto_min_fails: int = VETO_MIN_FAILS,
) -> Playbook:
    """Select guidance and vetoes for one world. Pure: no IO, no LLM."""
    live = [e for e in experiences if applies(e, world)]

    guidance = [e for e in live if e.n_ok > 0]
    guidance.sort(key=lambda e: (Playbook._ratio(e), e.n), reverse=True)

    vetoes = [
        e
        for e in live
        if e.n_ok == 0 and e.condition and e.n_fail >= veto_min_fails
    ]
    vetoes.sort(key=lambda e: e.n_fail, reverse=True)

    weak = [e for e in experiences if _weak(e, world) and e.n_ok > 0]
    weak.sort(key=lambda e: e.n_ok, reverse=True)

    return Playbook(
        guidance=guidance[:k_guidance],
        vetoes=vetoes[:k_veto],
        weak=weak[:k_weak],
    )
