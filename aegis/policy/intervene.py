"""Memory as intervention, not as retrieval.

The failure this module addresses (Wu et al., arXiv:2607.08716, "Remember When
It Matters") is *behavioral state decay*: information is present but no longer
controls behaviour. Their finding is that memory for long-horizon agents is an
**intervention policy**, and that the null action must be explicit:

    Selective intervention beats passive bank exposure, always-on injection,
    advisor-only guidance, and general retrieval.

The previous harness had only "inject at start" or "inject nothing", and the
second case was not a decision — it was an accident of the similarity gate.

Three states here:

    SILENT   nothing constrains the next action. Recorded and counted, and it
             is the expected state most of the time.
    REMIND   a stored item applies and should shape the next decision.
    FORBID   the world matches a cell that says "this breaks here" -> the
             matching commands are refused at the tool layer.

The deterministic layer decides applicability (predicates). The LLM layer, when
enabled, decides only *whether now is the moment* and how to phrase it — a
judgement about the trajectory, which predicates cannot see. That split keeps
the veto path non-LLM: a hallucinated intervention can waste tokens, but it can
never disable a working technique.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from aegis.core.fingerprint import Fingerprint


class Kind(str, Enum):
    SILENT = "silent"
    REMIND = "remind"
    FORBID = "forbid"


TRIGGERS = (
    "opening",  # session start
    "observe",  # a new observation changed the fingerprint
    "refuse",  # a command was refused / timed out
    "repeat",  # the agent is retrying a pattern it already tried
    "stuck",  # no progress for N steps
)


@dataclass
class Intervention:
    kind: Kind
    trigger: str
    reason: str = ""
    cells: list[dict[str, Any]] = field(default_factory=list)
    forbid: list[dict[str, Any]] = field(default_factory=list)
    habits: list[dict[str, Any]] = field(default_factory=list)
    message: str = ""
    llm_used: bool = False

    def as_row(self) -> dict[str, Any]:
        """Compact record for episodes.jsonl."""
        return {
            "intervention": self.kind.value,
            "trigger": self.trigger,
            "reason": self.reason,
            "cells": [str(c.get("technique") or "")[:80] for c in self.cells],
            "forbid": [str(c.get("technique") or "")[:80] for c in self.forbid],
            "llm_used": self.llm_used,
        }


def _why_text(c: dict[str, Any]) -> str:
    """Human-readable failure reason: what actually fired, then the rest."""
    matched = [str(m) for m in (c.get("_matched") or [])]
    if matched:
        return ", ".join(matched)
    why = str(c.get("why") or "")
    if why.startswith("matched:") or why == "applicable":
        return "相同条件下上次没打通"
    bits = [str(f) for f in (c.get("forbids") or [])]
    for k, v in (c.get("forbids_version") or {}).items():
        bits.append(f"{k}{v}" if k == "glibc" else f"{k}={v}")
    return ", ".join(bits) or str(c.get("legacy_condition") or "条件匹配")


def _cell_line(c: dict[str, Any]) -> str:
    tech = str(c.get("technique") or "")
    req = c.get("requires") or {}
    bits = []
    for k, v in req.items():
        if k == "glibc":
            bits.append(f"glibc{v}")  # spec carries its own operator
        elif isinstance(v, list):
            bits.append(f"{k}={'/'.join(map(str, v))}")
        else:
            bits.append(f"{k}={v}")
    cond = ", ".join(bits) or "always"
    tier = c.get("evidence") or "?"
    return f"- [{c.get('state', 'on')}·{tier}] {tech}  @ {cond}"


def render(iv: Intervention) -> str:
    """The injected text. Short by construction: it lands at the context tail."""
    if iv.kind is Kind.SILENT:
        return ""
    # A playbook-derived intervention carries its own rendering; the legacy
    # cell/habit path below is kept for the old bundle shape.
    if iv.message:
        return iv.message.strip()
    L: list[str] = []
    if iv.kind is Kind.FORBID:
        L.append("## 禁止尝试（当前世界与这些失败条件匹配）")
        for c in iv.forbid:
            L.append(f"- 不要 {c.get('technique')}  （因为 {_why_text(c)}）")
        L.append("")
    if iv.cells:
        L.append("## 现在适用（条件与当前世界一致）")
        L.extend(_cell_line(c) for c in iv.cells)
        L.append("")
    if iv.habits:
        L.append("## 先量这些")
        for h in iv.habits:
            L.append(f"- {h.get('observe')}")
        L.append("")
    return "\n".join(L).strip()


# ------------------------------------------------------------------ decision


def decide_from_playbook(
    trigger: str,
    playbook: Any,
    *,
    prev_activated: set[str] | None = None,
) -> Intervention:
    """三态介入，输入是**经验**，不是已空的 atlas 列。

    The previous input was the atlas column, which is empty since the memory store
    was rebuilt — so this always returned SILENT. That looked like "memory has
    nothing to say" rather than "the source is gone", which is the failure mode
    this project keeps running into.

    SILENT is still an explicit decision: with no applicable experience it is the
    *correct* answer, not an accident of a gate.
    """
    if trigger not in TRIGGERS:
        trigger = "observe"

    vetoes = list(getattr(playbook, "vetoes", []) or [])
    guidance = list(getattr(playbook, "guidance", []) or [])

    # A veto outranks a reminder: a technique that never worked in this world is
    # the thing worth saying, even if something else did work.
    if vetoes:
        return Intervention(
            kind=Kind.FORBID,
            trigger=trigger,
            reason="experience recorded no success for these in this world",
            forbid=[
                {"technique": v.action, "condition": ",".join(v.condition), "n": v.n}
                for v in vetoes
            ],
            message=playbook.render(),
        )
    if guidance:
        return Intervention(
            kind=Kind.REMIND,
            trigger=trigger,
            reason="experience has successes in this world",
            cells=[
                {"technique": g.action, "condition": ",".join(g.condition),
                 "n_ok": g.n_ok, "n": g.n}
                for g in guidance
            ],
            message=playbook.render(),
        )
    return Intervention(kind=Kind.SILENT, trigger=trigger, reason="no applicable experience")



def refine(iv: Intervention, trajectory: str) -> Intervention:
    """Public entry to the LLM layer.

    The layer may only suppress or trim what was already selected. It can never
    add an item, and it is never consulted for a FORBID — a hallucinated
    intervention may waste tokens, but it must never be able to switch off a
    technique that works.
    """
    return _llm_refine(iv, trajectory)


def _llm_refine(iv: Intervention, trajectory: str) -> Intervention:
    """Let the LLM suppress or trim a REMIND. It cannot add items."""
    from aegis.llm import chat_json

    items = [
        {"i": i, "technique": c.get("technique"), "requires": c.get("requires"), "state": c.get("state")}
        for i, c in enumerate(iv.cells)
    ]
    user = json.dumps(
        {"trigger": iv.trigger, "items": items, "trajectory_tail": trajectory[-2500:]},
        ensure_ascii=False,
    )
    try:
        data = chat_json(LLM_SYS, user, timeout=45)
    except Exception:
        return iv  # deterministic result stands

    if not bool(data.get("intervene", True)):
        return Intervention(kind=Kind.SILENT, trigger=iv.trigger, reason="llm-suppressed", llm_used=True)

    picks = [i for i in (data.get("pick") or []) if isinstance(i, int) and 0 <= i < len(iv.cells)][:3]
    if not picks:
        picks = list(range(min(3, len(iv.cells))))
    iv.cells = [iv.cells[i] for i in picks]
    text = str(data.get("text") or "").strip()
    iv.llm_used = True
    if text:
        iv.message = text[:400]
    return iv
