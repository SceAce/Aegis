"""Migrate legacy (schema 1) cells to structured predicates (schema 2).

Legacy cells carry a natural-language `condition` string that the old
`activate.extract_cues` re-parsed with substring tests. We replace that with
requires / forbids / optional, derived by rules first and the LLM only for the
residue.

Design choices:

  * `n` and `state` are preserved. Migration must not lose practice counts, or
    the ACT-R base level resets and every cell looks equally unpracticed.
  * Rules cover the version/hook/exit/arena vocabulary exhaustively, because
    that vocabulary is closed. Everything else lands in `optional`, which is
    the safe default: it can only cost score, never veto.
  * Migration is idempotent (`schema == 2` short-circuits) and reversible
    (`schema1` snapshot is written once).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from aegis.fingerprint import UBUNTU_GLIBC, parse_version
from aegis.paths import AEGIS_DIR, ATLAS_PATH, LESSONS_PATH

SCHEMA = 2

# ---------------------------------------------------------------- tag lexicon

# Mechanism tags we can detect in prose. Closed vocabulary on purpose.
_TAG_PATTERNS: list[tuple[str, str]] = [
    ("hooks_dead", r"hooks?\s*(?:dead|removed|gone|失效)|no\s+__\w+_hook|__free_hook\s*(?:removed|dead)|hook\s*(?:removed|dead)"),
    ("hooks_alive", r"hooks?\s*(?:alive|present|exist|还在)|__free_hook\s*(?:alive|works)"),
    ("thread_arena", r"thread[_\s-]?arena|pthread|non-?main\s+arena"),
    ("main_arena", r"main[_\s-]?arena(?!\s*(?:separated|unmapped))"),
    ("exit_group", r"exit_group|raw\s+exit|syscall\s+exit|stdio\s+never\s+flush"),
    ("exit_flush", r"exit\s*(?:flush|triggers)|flush_all|_io_cleanup|stdio\s+flush"),
    ("tcache", r"\btcache\b"),
    ("fastbin", r"\bfastbin"),
    ("unsorted_bin", r"unsorted[_\s-]?bin"),
    ("calloc", r"\bcalloc\b"),
    ("safe_linking", r"safe[_\s-]?link"),
    ("tcache_key_random", r"tcache[_\s-]?key"),
    ("no_free", r"no\s+free|without\s+free|free\s+(?:is\s+)?not\s+(?:imported|available)"),
    ("no_show", r"no\s+show|no\s+leak|without\s+show"),
    ("full_relro", r"full\s*relro"),
    ("canary", r"\bcanary\b"),
    ("non_pie", r"non-?pie|no\s+pie"),
    ("fsop", r"\bfsop\b|\b_io_(?:wfile|str|file)_jumps\b|wide[_\s-]?vtable"),
    ("house_of_apple", r"house\s+of\s+apple"),
    ("house_of_orange", r"house\s+of\s+orange"),
    ("house_of_force", r"house\s+of\s+force"),
    ("unsorted_bin_attack", r"unsorted[_\s-]?bin\s+attack"),
    ("tcache_poison", r"tcache\s+poison"),
    ("fastbin_poison", r"fastbin\s+(?:poison|attack)"),
    ("top_chunk", r"top[_\s-]?chunk"),
    ("heap_leak", r"heap\s+leak"),
    ("libc_leak", r"libc\s+leak"),
    ("unlink", r"\bunlink\b"),
    ("off_by_one", r"off[_\s-]?by[_\s-]?one"),
    ("use_after_free", r"use[_\s-]?after[_\s-]?free|\buaf\b"),
    ("got_overwrite", r"got\s+overwrite|overwrite\s+got|got-?adjacent"),
    ("overlap", r"overlap"),
    ("arena_exhaust", r"arena\s+exhaust|grow_heap|new_heap|64\s*mb"),
    ("short_read", r"short[_\s-]?read"),
]

# A version mention in a condition is a hard requirement.
_VER_SIMPLE = re.compile(r"(?:glibc|libc)[\s=_:/-]*(?:>=|<=|>|<|=)?\s*(\d+)\.(\d+)", re.I)
_VER_CMP = re.compile(r"(?:glibc|libc)\s*(>=|<=|>|<)\s*(\d+)\.(\d+)", re.I)
_VER_RANGE = re.compile(r"(?:before|prior to|earlier than|<)\s*(\d+)\.(\d+)", re.I)

# Phrases that mark a version threshold as an upper bound.
_UPPER_HINTS = ("before", "prior to", "earlier than", "not patched", "unpatched", "older than", "<=")
_LOWER_HINTS = ("at least", "or later", "or newer", ">=", "and above", "onwards")


def _detect_tags(text: str) -> set[str]:
    low = text.lower()
    out: set[str] = set()
    for tag, pat in _TAG_PATTERNS:
        if re.search(pat, low, re.I):
            out.add(tag)
    return out


def split_condition(condition: str, technique: str = "", state: str = "on") -> dict[str, Any]:
    """Rule-based split of a legacy condition string into predicates.

    `state` matters: on an OFF cell the condition text describes *why it
    failed*. "glibc 2.27 unlink checks" on an OFF cell is not a requirement for
    the technique — it is the counter-condition that killed it. Those must land
    in `forbids`, or the cell can never become a prohibition, and the negative
    memory silently disappears.

    This was a real defect: `unlink arbitrary write` (OFF, pwn_2) migrated with
    only `requires={glibc:=2.27}` and `optional=[unlink]`, so on pwn_2 — the
    exact world where it failed — it evaluated as applicable.
    """
    text = " ".join(str(condition or "").split())
    low = text.lower()
    requires: dict[str, Any] = {}
    forbids: list[str] = []
    vforbid: dict[str, Any] = {}
    optional: list[str] = []
    is_off = str(state) == "off"

    # ---- version ---------------------------------------------------------
    vcmp = _VER_CMP.search(text)
    if vcmp:
        op, a, b = vcmp.group(1), int(vcmp.group(2)), int(vcmp.group(3))
        requires["glibc"] = f"{op}{a}.{b}"
    elif (vm := _VER_SIMPLE.search(text)):
        # "before 2.29" / "not patched (before 2.29)" -> upper bound
        if any(h in low for h in _UPPER_HINTS):
            requires["glibc"] = f"<{vm.group(1)}.{vm.group(2)}"
        elif any(h in low for h in _LOWER_HINTS):
            requires["glibc"] = f">={vm.group(1)}.{vm.group(2)}"
        else:
            requires["glibc"] = f"={vm.group(1)}.{vm.group(2)}"

    # ---- scalar mechanism fields ----------------------------------------
    tags = _detect_tags(text)

    if "hooks_dead" in tags:
        requires["hooks"] = "dead"
    elif "hooks_alive" in tags:
        requires["hooks"] = "alive"

    if "exit_group" in tags:
        # exit_group means stdio is NEVER flushed: that is a veto on FSOP cells,
        # and a requirement for cells that exist because of it.
        forbids.append("exit_flush")
        if "flush" not in low:
            requires["exit"] = "group"
        else:
            forbids.append("exit_group")
    elif "exit_flush" in tags:
        requires["exit"] = "flush"

    if "thread_arena" in tags:
        requires["arena"] = "thread"
    elif "main_arena" in tags:
        requires["arena"] = "main"

    # ---- allocator primitives -------------------------------------------
    alloc = {t for t in tags if t in {"tcache", "fastbin", "unsorted_bin", "calloc", "safe_linking", "tcache_key_random"}}
    # "no free" style observations are context, not requirements
    for t in ("no_free", "no_show"):
        if t in tags:
            optional.append(t)

    if alloc:
        requires["alloc"] = sorted(alloc)

    # ---- technique-derived vetoes ---------------------------------------
    blob = (technique + " " + text).lower()
    if re.search(r"fsop|_io_list_all|_io_wfile|wide[_\s-]?vtable|house\s+of\s+apple", blob):
        forbids.append("exit_group")
    if "safe_link" in blob or "ptr>>12" in blob.replace(" ", ""):
        requires.setdefault("alloc", [])
        if isinstance(requires["alloc"], list):
            requires["alloc"] = sorted(set(requires["alloc"]) | {"safe_linking"})

    # ---- everything else is optional ------------------------------------
    reserved = set()
    for v in requires.values():
        if isinstance(v, list):
            reserved |= {str(x) for x in v}
        else:
            reserved.add(str(v))
    reserved |= set(forbids)
    optional = sorted({t for t in tags if t not in reserved and t not in ("hooks_dead", "hooks_alive", "exit_group", "exit_flush", "thread_arena", "main_arena")})

    # de-dup alloc in optional
    if isinstance(requires.get("alloc"), list):
        optional = [o for o in optional if o not in set(requires["alloc"])]

    # ---- OFF cells: the condition names what KILLED it -------------------
    #
    # A veto from a rule is safe (closed vocabulary). Inferring a veto from
    # free prose is not, so only cells that are already OFF get this treatment.
    #
    # The subtlety: on an OFF cell the version in the text is the *cause*, not
    # a requirement. "glibc>=2.34" on the __free_hook cell means "the hooks are
    # gone from 2.34 on, so this is dead there" — a version veto. Inverting it
    # into `requires: glibc<2.34` reaches the same verdict by accident while
    # saying something false ("this needs an old glibc"), and it would migrate
    # wrong the moment the polarity is not a clean inversion.
    if is_off:
        if "glibc" in requires:
            vforbid["glibc"] = requires.pop("glibc")
        for t in list(optional):
            if t in _VETO_AS_CAUSE:
                vforbid[t] = True
                optional.remove(t)

    return {
        "requires": requires,
        "forbids": sorted(set(forbids)),
        "forbids_version": vforbid,
        "optional": optional,
        "unparsed": text if not (requires or forbids or optional) else "",
    }


# Tags that, on an OFF cell, name the mechanism that defeated it rather than a
# capability it needs. Kept deliberately short: a false veto silently deletes a
# technique that works, which is worse than a missed veto.
_VETO_AS_CAUSE = {
    "safe_linking",
    "tcache_key_random",
    "full_relro",
    "canary",
    "non_pie",
    "exit_flush",
}


def _evidence_for(source: str, by_challenge: dict[str, dict]) -> str:
    """flag | local | wiki | none, from the lesson that produced this cell."""
    if str(source).startswith("ctf-wiki:"):
        return "wiki"
    lesson = by_challenge.get(source) or {}
    v = str(lesson.get("verified") or "").strip()
    if v in ("flag", "local", "wiki"):
        return v
    return "local" if source.startswith("pwn") else "none"


def migrate_atlas(*, dry_run: bool = False, llm_residue: bool = True) -> dict[str, Any]:
    """Convert every schema-1 cell in atlas.json to schema 2."""
    if not ATLAS_PATH.is_file():
        return {"error": "no atlas", "migrated": 0}

    atlas = json.loads(ATLAS_PATH.read_text(encoding="utf-8"))
    cells = atlas.get("cells") or []

    lessons_blob = json.loads(LESSONS_PATH.read_text(encoding="utf-8")) if LESSONS_PATH.is_file() else {"lessons": []}
    by_challenge: dict[str, dict] = {}
    for les in lessons_blob.get("lessons") or []:
        by_challenge[str(les.get("challenge") or "")] = les

    migrated = skipped = 0
    stats: dict[str, int] = {}
    residue: list[dict[str, str]] = []
    out: list[dict[str, Any]] = []

    for cell in cells:
        if not isinstance(cell, dict):
            continue
        if int(cell.get("schema") or 1) >= SCHEMA:
            skipped += 1
            out.append(cell)
            continue

        tech = str(cell.get("technique") or "")
        cond = str(cell.get("condition") or "")
        state = str(cell.get("state") or "on")
        parts = split_condition(cond, tech, state)
        if parts["unparsed"] and len(parts["unparsed"]) > 40:
            residue.append({"technique": tech, "condition": parts["unparsed"]})

        new = dict(cell)
        new["schema"] = SCHEMA
        new["requires"] = parts["requires"]
        new["forbids"] = parts["forbids"]
        if parts["forbids_version"]:
            new["forbids_version"] = parts["forbids_version"]
        new["optional"] = parts["optional"]
        new["evidence"] = _evidence_for(str(cell.get("source") or ""), by_challenge)
        new["legacy_condition"] = cond  # keep for audit; not used by scoring
        out.append(new)
        migrated += 1
        for k in parts["requires"]:
            stats[k] = stats.get(k, 0) + 1

    if not dry_run:
        backup = AEGIS_DIR / "atlas.schema1.json"
        if not backup.is_file():
            backup.write_text(json.dumps(atlas, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        atlas["cells"] = out
        atlas["schema"] = SCHEMA
        ATLAS_PATH.write_text(json.dumps(atlas, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    result: dict[str, Any] = {
        "migrated": migrated,
        "skipped": skipped,
        "field_coverage": stats,
        "residue_count": len(residue),
        "residue": residue[:25],
        "dry_run": dry_run,
    }

    if residue and llm_residue and not dry_run:
        result["llm"] = _llm_refine_residue(residue)
    return result


def _llm_refine_residue(residue: list[dict[str, str]]) -> dict[str, Any]:
    """Ask the LLM only for condition text the rules could not parse.

    Deliberately narrow: the LLM proposes optional tags, never a veto. A wrong
    veto silently deletes a working technique, so vetoes stay rule-only.
    """
    from aegis.llm import chat_json

    system = (
        "You convert leftover CTF condition text into MECHANISM TAGS.\n"
        "Return a single JSON object. No markdown, no commentary.\n"
        "Tags must be one of: tcache, fastbin, unsorted_bin, calloc, safe_linking, "
        "hooks_alive, hooks_dead, exit_group, exit_flush, thread_arena, main_arena, "
        "no_free, no_show, full_relro, canary, non_pie, top_chunk, overlap, short_read, "
        "got_overwrite, unlink, arena_exhaust, off_by_one, use_after_free.\n"
        "If nothing applies, return an empty list. Do NOT invent tags.\n"
        'Schema: {"items":[{"index":int,"tags":[str]}]}'
    )
    user = json.dumps(
        {"items": [{"index": i, "technique": r["technique"], "condition": r["condition"]} for i, r in enumerate(residue)]},
        ensure_ascii=False,
    )
    try:
        data = chat_json(system, user)
    except Exception as exc:
        return {"error": str(exc), "applied": 0}

    from aegis.fingerprint import KNOWN_TAGS
    atlas = json.loads(ATLAS_PATH.read_text(encoding="utf-8"))
    by_tech: dict[str, dict] = {}
    for c in atlas.get("cells") or []:
        by_tech.setdefault(str(c.get("technique") or ""), c)

    applied = 0
    for item in data.get("items") or []:
        idx = item.get("index")
        if not isinstance(idx, int) or not (0 <= idx < len(residue)):
            continue
        tech = residue[idx]["technique"]
        cell = by_tech.get(tech)
        if not cell:
            continue
        add = sorted({str(t) for t in (item.get("tags") or []) if str(t) in KNOWN_TAGS})
        if add:
            cell["optional"] = sorted(set(cell.get("optional") or []) | set(add))
            applied += 1

    if applied:
        ATLAS_PATH.write_text(json.dumps(atlas, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"applied": applied}
