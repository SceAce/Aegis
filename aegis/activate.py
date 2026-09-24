"""Sparse activation of compiled experience — schema 2.

Scoring is ACT-R's three-term equation, not two:

    A_i = B_i + S_i - P * M_i

    B   base-level practice   0.8 * ln(1 + n), weighted by evidence tier
    S   spreading activation  sum over cue overlap, with a fan penalty so a
                              cue wired to many cells contributes less
    M   partial mismatch      count of `optional` conditions not met

The third term is what the previous two-term implementation was missing. It had
only "fully applicable" vs "-inf", so a mechanism-level cell written under one
challenge could never light up on another. With M, absence of a *soft* cue costs
score without vetoing; absence of a *required* cue still vetoes.

Three further corrections over the previous version:

  * Wiki-sourced cells can never enter the strategy column. They are background
    reference, consulted on demand (see aegis/knowledge.py).
  * `local`-verified successes stay ON. They are real evidence, ranked below
    `flag` by B's tier weight, instead of being rewritten to OFF (which turned
    our own working exploit into a prohibition).
  * `unobserved:<field>` and `conflict` are distinct drop reasons. Only the
    latter is evidence that the cell's world contradicts ours.
"""

from __future__ import annotations

import math
from typing import Any

from aegis.fingerprint import Fingerprint
from aegis.predicate import check_forbids, check_requires, is_applicable

TAU_DEFAULT = 0.9
P_MISMATCH = 0.55
FAN_BASE = 1.0

# How much each evidence tier is worth. wiki = 0 by construction: an article
# saying "this works" is not this system having seen it work.
TIER_WEIGHT = {
    "flag": 1.0,
    "local": 0.6,
    "wiki": 0.0,
    "none": 0.0,
}

K_CELLS = 6
K_PROBLEMS = 4
K_HABITS = 3
K_REFERENCE = 2


def _tier(cell: dict[str, Any]) -> str:
    t = str(cell.get("evidence") or "").strip()
    if t in TIER_WEIGHT:
        return t
    # Legacy fallback: infer from source.
    src = str(cell.get("source") or "")
    if src.startswith("ctf-wiki:"):
        return "wiki"
    return "none"


def _cues(cell: dict[str, Any]) -> set[str]:
    """Mechanism tags this cell is about, for spreading activation."""
    out: set[str] = set()
    for tag in cell.get("_cues") or ():
        out.add(str(tag))
    out |= {str(f) for f in (cell.get("forbids") or [])}
    return out


def fan_counts(cells: list[dict[str, Any]]) -> dict[str, int]:
    """How many cells each cue is wired to. Used for S_ji = S - ln(fan_j)."""
    fan: dict[str, int] = {}
    for c in cells:
        for t in _cues(c):
            fan[t] = fan.get(t, 0) + 1
    return fan


def score(
    cell: dict[str, Any],
    fp: Fingerprint,
    fan: dict[str, int],
) -> tuple[float, str]:
    """(activation, reason). reason == 'ok' means eligible."""
    # Wiki is checked FIRST. An article saying "this fails on >=2.26" is not
    # evidence about this target, so it must not become a prohibition — and
    # checking the veto before this produced exactly that: a wiki cell whose
    # `forbids_version` fired reported `forbidden:*`, which the caller routes
    # into the prohibition list, bypassing "wiki is never an instruction".
    if _tier(cell) == "wiki":
        return float("-inf"), "wiki-not-strategy"

    ok, why = check_requires(cell.get("requires") or {}, fp)
    if not ok:
        return float("-inf"), why

    bad, which = check_forbids(cell.get("forbids") or [], fp, cell.get("forbids_version") or {})
    if bad:
        # A matched veto is not "not applicable" — it means the world is the
        # one this cell says breaks it. That is a prohibition, handled by the
        # caller, and it must never be silently dropped.
        return float("-inf"), f"forbidden:{which}"

    B = 0.8 * math.log(1 + max(1, int(cell.get("n") or 1)))
    B *= TIER_WEIGHT.get(_tier(cell), 0.0)

    fp_tags = fp.expanded | fp.all
    overlap = _cues(cell) & set(fp_tags)
    S = FAN_BASE * sum(1.0 / (1.0 + math.log(1 + fan.get(t, 0))) for t in overlap)

    soft = [str(o) for o in (cell.get("optional") or [])]
    miss = sum(1 for o in soft if not fp.has(o))
    M = P_MISMATCH * miss

    return B + S - M, "ok"


def _prohibition_row(cell: dict[str, Any], fp: Fingerprint, sim: float, why: str) -> dict[str, Any]:
    """Rank a prohibition by how *specifically* it applies to this world.

    Ordering (highest first):
      3  a veto fired on an explicit failure condition  — the strongest claim
      2  a veto fired on a version/scalar condition
      1  the cell is affirmatively applicable (world matches its description)
      0  otherwise
    Ties break on cue overlap, so a prohibition about tcache outranks one about
    large bins when the fingerprint is about tcache.
    """
    vforbid = cell.get("forbids_version") or {}
    veto_fired = any(fp.has(str(f)) for f in (cell.get("forbids") or []))
    vfired = False
    for k, v in vforbid.items():
        if k == "glibc" and fp.glibc is not None:
            from aegis.predicate import _ver_ok

            specs = v if isinstance(v, (list, tuple)) else [v]
            vfired = vfired or any(_ver_ok(fp.glibc, str(s)) for s in specs)
        elif k in ("hooks", "exit", "arena") and str(getattr(fp, k, None)) == str(v):
            vfired = True
        elif v is True and fp.has(str(k)):
            vfired = True

    if veto_fired:
        rank, label = 3, "veto"
    elif vfired:
        rank, label = 2, "veto-version"
    elif why == "ok":
        rank, label = 1, "applicable"
    else:
        rank, label = 0, why
    rank += 1 if _tier(cell) == "flag" else 0
    # Record ONLY the conditions that actually fired. A cell may carry several
    # (e.g. forbids=[exit_group] plus a glibc=2.44 veto); showing all of them
    # told the agent to avoid a technique "because glibc=2.44" while it was
    # working on 2.27, which is both confusing and wrong.
    return {
        "A": float(rank),
        "_overlap": int(sim),
        "_matched": _fired_conditions(cell, fp),
        "why": label,
        **cell,
    }


def _fired_conditions(cell: dict[str, Any], fp: Fingerprint) -> list[str]:
    """Which of the cell's failure conditions are true of this world?"""
    from aegis.predicate import _ver_ok

    fired: list[str] = []
    for f in cell.get("forbids") or []:
        if fp.has(str(f)):
            fired.append(str(f))
    for k, v in (cell.get("forbids_version") or {}).items():
        if k == "glibc":
            if fp.glibc is None:
                continue
            specs = v if isinstance(v, (list, tuple)) else [v]
            if any(_ver_ok(fp.glibc, str(s)) for s in specs):
                fired.append(f"glibc{v}")
        elif k in ("hooks", "exit", "arena"):
            if str(getattr(fp, k, None)) == str(v):
                fired.append(f"{k}={v}")
        elif v is True and fp.has(str(k)):
            fired.append(str(k))
    return fired


def is_prohibition(cell: dict[str, Any], fp: Fingerprint) -> tuple[bool, str]:
    """Does this cell apply AND declare a veto? -> force into the OFF list."""
    if str(cell.get("state") or "on") != "off":
        return False, ""
    if not fp.observed:
        return False, ""
    # Same rule as the strategy column: an unverified article is reference
    # material, never an instruction and never a prohibition. This path is
    # reached directly by tests and callers, so the guard belongs here too.
    if _tier(cell) == "wiki":
        return False, ""

    # Tag vetoes.
    for f in cell.get("forbids") or []:
        if fp.has(str(f)):
            return True, str(f)

    # Version/scalar vetoes. These must be evaluated on their own terms: a
    # `forbids_version` of {"glibc": ">=2.34"} fires only when the world IS
    # >=2.34, never as a side effect of the cell being applicable.
    for k, v in (cell.get("forbids_version") or {}).items():
        if k == "glibc":
            if fp.glibc is None:
                continue
            from aegis.predicate import _ver_ok

            specs = v if isinstance(v, (list, tuple)) else [v]
            if any(_ver_ok(fp.glibc, str(s)) for s in specs):
                return True, f"glibc{v}"
            continue
        if k in ("hooks", "exit", "arena"):
            if str(getattr(fp, k, None)) == str(v):
                return True, f"{k}={v}"
            continue
        if v is True and fp.has(str(k)):
            return True, str(k)

    # An OFF cell with no veto of its own is a prohibition only when it is
    # affirmatively applicable — i.e. we are in the world it describes.
    #
    # `unlink arbitrary write` (OFF, fv={glibc: =2.27}) is the case that
    # matters: on 2.27 the version veto fires above. On 2.44 it must NOT be a
    # prohibition, and previously it was, via this fallback.
    if (cell.get("forbids") or {}) or (cell.get("forbids_version") or {}):
        return False, ""

    # A cell with NO conditions at all has nothing to match, so "the condition
    # matched" is vacuous rather than evidence. Such cells come from runs where
    # the compiler could not state a discriminating condition; treating them as
    # prohibitions fired on every world the moment any observation existed
    # (including a bare checksec), which told the agent not to try things for no
    # stated reason.
    if not (cell.get("requires") or {}):
        return False, ""

    ok, _ = is_applicable(cell, fp)
    return (ok, "condition-match") if ok else (False, "")


def activate(
    *,
    cells: list[dict[str, Any]],
    problems: list[dict[str, Any]],
    habits: list[dict[str, Any]],
    fp: Fingerprint,
    current: str = "",
    tau: float = TAU_DEFAULT,
    k_cells: int = K_CELLS,
    k_problems: int = K_PROBLEMS,
    k_habits: int = K_HABITS,
    k_reference: int = K_REFERENCE,
) -> dict[str, Any]:
    """Assemble the activated column for one fingerprint."""
    fan = fan_counts(cells)
    dropped: dict[str, int] = {}
    keep: list[tuple[float, dict[str, Any]]] = []
    prohibitions: list[dict[str, Any]] = []
    reference: list[tuple[float, dict[str, Any]]] = []
    pre_gate_top: list[tuple[float, dict[str, Any]]] = []

    for c in cells:
        # Similarity-only ranking, for the HSR metric: what WOULD have been
        # surfaced if the gate did not exist.
        sim = len(_cues(c) & (fp.expanded | fp.all))
        pre_gate_top.append((float(sim), c))

        a, why = score(c, fp, fan)
        is_off = str(c.get("state") or "on") == "off"

        if a < tau:
            if why == "wiki-not-strategy":
                # Wiki is a knowledge base, not experience: keep it as
                # consultable reference rather than discarding it.
                reference.append((sim, c))
                dropped["wiki-reference"] = dropped.get("wiki-reference", 0) + 1
                continue
            if why.startswith("forbidden:") and is_off:
                prohibitions.append(_prohibition_row(c, fp, sim, why))
                continue
            key = "below-tau" if why == "ok" else why
            dropped[key] = dropped.get(key, 0) + 1
            continue

        if is_off:
            prohibitions.append(_prohibition_row(c, fp, sim, why))
        else:
            keep.append((a, {"A": round(a, 3), "why": why, **c}))

    # OFF cells whose condition matches are prohibitions even when they also
    # score positive — the negative-memory push.
    #
    # Ranking matters here: sorting alphabetically let wiki trivia and
    # unrelated failures fill the k_cells slots. A prohibition is only useful
    # if it is *about this world*, so rank by (a) whether a veto actually
    # fired, then (b) cue overlap, then (c) evidence tier.
    seen_tech = {str(p.get("technique")) for p in prohibitions}
    for c in cells:
        if str(c.get("state") or "on") != "off":
            continue
        if str(c.get("technique")) in seen_tech:
            continue
        if _tier(c) == "wiki":
            continue  # an unverified article is not a prohibition
        if not fp.observed:
            # Nothing is forbidden in a world we have not looked at. Firing
            # vetoes here would tell the agent not to try things for reasons
            # that have nothing to do with this target.
            continue
        hit, which = is_prohibition(c, fp)
        if not hit:
            continue
        sim = len(_cues(c) & (fp.expanded | fp.all))
        prohibitions.append(_prohibition_row(c, fp, sim, f"matched:{which}"))
        seen_tech.add(str(c.get("technique")))

    keep.sort(key=lambda x: x[0], reverse=True)
    keep = keep[:k_cells]
    prohibitions.sort(key=lambda r: (float(r.get("A") or 0.0), int(r.get("_overlap") or 0)), reverse=True)
    prohibitions = prohibitions[:k_cells]
    for p in prohibitions:
        # `_overlap` is a ranking scratch value with no meaning afterwards.
        # `_matched` is KEPT: the renderers read it to state *which* failure
        # condition fired, and it doubles as the diagnostic record of why a
        # technique was ruled out for this world.
        p.pop("_overlap", None)
    reference.sort(key=lambda x: x[0], reverse=True)
    reference = reference[:k_reference]

    # problems / habits: same gate, no tier requirement (they are operational).
    probs: list[tuple[float, dict[str, Any]]] = []
    for p in problems:
        body = " ".join(str(p.get(k) or "") for k in ("problem", "solution", "skip"))
        tags = {t for t in (p.get("tags") or [])}
        cell_like = {
            "requires": p.get("requires") or {},
            "forbids": p.get("forbids") or [],
            "optional": p.get("optional") or [],
            "n": p.get("n") or 1,
            "evidence": p.get("evidence") or "local",
            "forbids_tags": tags,
            "_cues": tags,
            "state": "on",
        }
        a, why = score(cell_like, fp, fan)
        if a < tau:
            # Operational problems are useful even on a cold start: they are
            # about the harness, not about the target's mechanism.
            if p.get("_operational"):
                probs.append((0.5, {"A": 0.5, "why": "operational", **p}))
                continue
            dropped["problem-" + ("below-tau" if why == "ok" else why)] = (
                dropped.get("problem-" + ("below-tau" if why == "ok" else why), 0) + 1
            )
            continue
        probs.append((a, {"A": round(a, 3), "why": why, **p}))
    probs.sort(key=lambda x: x[0], reverse=True)
    probs = probs[:k_problems]

    hab: list[tuple[float, dict[str, Any]]] = []
    for h in habits:
        text = f"{h.get('when') or ''} {h.get('observe') or ''}"
        if _opening_hint(text):
            # "Measure the real libc first" is exactly what to do with no
            # fingerprint: not a fallback, the designed opening move. It must
            # bypass the gate, because on a cold start there is nothing to
            # evaluate a predicate against.
            hab.append((1.0 if not fp.observed else 0.7, {"A": 0.7, "why": "opening", **h}))
            continue
        tags = {t for t in (h.get("tags") or [])}
        cell_like = {
            "requires": h.get("requires") or {},
            "forbids": h.get("forbids") or [],
            "optional": h.get("optional") or [],
            "n": h.get("n") or 1,
            "evidence": h.get("evidence") or "local",
            "_cues": tags,
            "state": "on",
        }
        a, why = score(cell_like, fp, fan)
        if a < tau:
            # A habit with no structured predicate is a cold-start suggestion.
            # Keep it only while we still know nothing.
            if not fp.observed and not tags and not (h.get("requires") or {}):
                hab.append((0.6, {"A": 0.6, "why": "opening-unstructured", **h}))
            continue
        hab.append((a, {"A": round(a, 3), "why": why, **h}))
    hab.sort(key=lambda x: x[0], reverse=True)
    hab = hab[:k_habits]

    src_mix: dict[str, int] = {}
    for _a, row in keep + probs:
        s = str(row.get("source") or row.get("challenge") or "?")
        src_mix[s] = src_mix.get(s, 0) + 1

    denies: list[str] = []
    for _a, p in probs:
        d = str(p.get("deny") or "").strip()
        if d and d not in denies:
            denies.append(d)

    pre_gate_top.sort(key=lambda x: x[0], reverse=True)
    top_k_sim = [c for _s, c in pre_gate_top[:k_cells]]
    hsr = harmful_sibling_rate(top_k_sim, fp)

    return {
        "fingerprint": {
            "glibc": fp.glibc,
            "hooks": fp.hooks,
            "exit": fp.exit,
            "arena": fp.arena,
            "alloc": sorted(fp.alloc),
            "tags": sorted(fp.tags),
            "observed": fp.observed,
        },
        "cold_start": not fp.observed,
        "tau": tau,
        "cells": [r for _a, r in keep],
        "forbid": prohibitions,
        "problems": [r for _a, r in probs],
        "habits": [r for _a, r in hab],
        "reference": [r for _a, r in reference],
        "denies": denies,
        "dropped": dropped,
        "source_mix": src_mix,
        "current": current,
        "hsr_at_k": round(hsr, 3),
    }


def harmful_sibling_rate(topk: list[dict[str, Any]], fp: Fingerprint) -> float:
    """HSR@k — of the cells similarity alone would surface, how many does the
    gate reject?

    Measured BEFORE the gate on purpose. After the gate it is identically zero.
    A high value means the similarity ranking is not doing the judgement and the
    predicates are doing all the work: recall is being thrown away.
    (cf. SameCapRisk-Bench, arXiv:2606.10388: recall@3 0.85-0.89 comes with
    harmful-sibling rate 0.35-0.37.)
    """
    if not topk:
        return 0.0
    bad = 0
    for c in topk:
        if _tier(c) == "wiki":
            continue
        ok, _ = is_applicable(c, fp)
        if not ok:
            bad += 1
    return bad / len(topk)


OPENING_MARKERS = (
    "actual libc",
    "real libc",
    "libc version",
    "runtime libc",
    "真实 libc",
    "input parser",
    "exit path",
    "how the process exits",
    "map each action",
    "identify the allocator",
    "which arena",
)


def _opening_hint(text: str) -> bool:
    b = " ".join(str(text).split()).lower()
    return any(m in b for m in OPENING_MARKERS)
