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

from aegis.fingerprint import Fingerprint


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


def decide(
    *,
    trigger: str,
    bundle: dict[str, Any],
    prev_activated: set[str] | None = None,
    trajectory: str = "",
    use_llm: bool = False,
) -> Intervention:
    """Pick the intervention for this trigger point.

    Deterministic by default. The LLM is consulted only for REMIND phrasing when
    there is something to remind about — never for FORBID, and never to invent
    an item that the gate did not clear.
    """
    prev = prev_activated or set()
    admit = [c for c in bundle.get("cells") or [] if str(c.get("technique")) not in prev]
    forbid = list(bundle.get("forbid") or [])
    habits = list(bundle.get("habits") or []) if trigger == "opening" else []

    if forbid:
        return Intervention(
            kind=Kind.FORBID,
            trigger=trigger,
            reason=f"{len(forbid)} matched failure condition(s)",
            forbid=forbid,
            cells=admit[:3],
            habits=habits,
        )

    if admit:
        iv = Intervention(
            kind=Kind.REMIND,
            trigger=trigger,
            reason=f"{len(admit)} newly applicable cell(s)",
            cells=admit[:4],
            habits=habits,
        )
        if use_llm:
            iv = _llm_refine(iv, trajectory)
        iv.message = render(iv)
        return iv

    if habits:
        iv = Intervention(kind=Kind.REMIND, trigger=trigger, reason="opening measurements", habits=habits)
        iv.message = render(iv)
        return iv

    # Explicit null action. Not "we found nothing to say" — the correct choice.
    return Intervention(kind=Kind.SILENT, trigger=trigger, reason="no applicable state")


LLM_SYS = """You are the memory agent for a security task. You are NOT the solver.
You receive: items that already passed a deterministic applicability check, the
recent trajectory, and the trigger that fired.

Decide ONLY whether to surface these items now.

Rules:
- Silence is a valid and often correct answer. Do not remind for the sake of it.
- Intervene only when a stored item is likely to change the very next action.
- Never add facts, techniques, addresses, or advice that are not in the items.
- Never restate what the trajectory already shows.
- Prefer a short reminder of a constraint about to be violated, or a failed
  approach about to be retried, over general guidance.

Return one JSON object:
{"intervene": bool, "pick": [int], "text": str}
  pick: indices of the items worth surfacing (max 3)
  text: <= 300 chars, imperative, object-level. Empty if intervene is false.
"""


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
