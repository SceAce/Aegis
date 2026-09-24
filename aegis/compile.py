from __future__ import annotations

from typing import Any

from aegis.fingerprint import KNOWN_TAGS
from aegis.guard import DENY_KEYS
from aegis.llm import chat_json
from aegis.paths import infer_kind
from aegis.store import (
    ATOMIC_TAGS,
    _portable_technique,
    append_episode,
    append_issue,
    load_episodes,
    load_issues,
    now_iso,
    save_lesson,
    upsert_cell,
    upsert_search_rule,
)


def _cond_from(req: dict, forbids: list[str], fv: dict) -> str:
    """Human-readable rendering of the predicates, for WP readability only.

    A glibc spec already carries its operator ("=2.27", ">=2.34"), so it is
    rendered bare — `f"{k}={v}"` produced the nonsense `glibc=>=2.34` in every
    writeup.
    """
    bits = []
    for k, v in (req or {}).items():
        if k == "glibc":
            bits.append(f"glibc{v}")
        elif isinstance(v, list):
            bits.append(f"{k}={'/'.join(map(str, v))}")
        else:
            bits.append(f"{k}={v}")
    for f in forbids or []:
        bits.append(f"!{f}")
    for k, v in (fv or {}).items():
        bits.append(f"!glibc{v}" if k == "glibc" else f"!{k}={v}")
    return ", ".join(bits) or "always"

VERIFY_LEVELS = ("flag", "local", "none", "wiki")

COMPILE_SYS = """You compile ONE CTF attempt into portable memory for a future agent.
The assistant message content MUST be a single JSON object. No chain-of-thought, no markdown.

A cell is a MECHANISM plus the CONDITIONS under which it holds. The conditions are
structured predicates, not prose, because a future run evaluates them against a
fingerprint of its own world.

For each cell emit:
  technique  <=80 chars, at most one "->". Never an address, offset or chunk size.
  requires   every clause must hold for the cell to apply. Use ONLY these keys:
               "glibc":  "=2.27" | ">=2.34" | "<2.29" ...
               "hooks":  "alive" | "dead"
               "exit":   "flush" | "group"
               "arena":  "main" | "thread"
               "alloc":  a list from [tcache, fastbin, unsorted_bin, calloc, safe_linking, tcache_key_random]
             Omit a key when the cell does not depend on it. Never guess.
  forbids    list of mechanism tags that, if TRUE of the target, make the cell fail.
             Use for conditions that actively defeat the technique (e.g. "exit_group").
  forbids_version
             use when the *library version* is what defeats it, e.g. {"glibc": ">=2.34"}
             for "hooks are gone from 2.34 on". Do NOT invert this into requires.
  optional   mechanism tags that merely make the cell more likely to matter.
             Their absence costs relevance but never applicability.
  state      "on" = the technique achieved the run's verified outcome.
             "off" = it failed; the predicates must say under what world it fails.
  summary    ONE sentence (<=160 chars) a future reader can act on.

An OFF cell must be a TECHNIQUE THAT FAILED, phrased as something an agent could
try ("X -> Y"), with the blocking condition in forbids/forbids_version. Do NOT put
a refuted hypothesis in cells: "calloc consumes tcache bins" is a claim the run
disproved, and storing it OFF makes the next agent read "do not: calloc consumes
tcache bins", which is meaningless. Disproved claims belong in problems.

A run that disabled a protection (ASLR/NX/canary/RELRO/seccomp) to succeed proves
nothing about the target and MUST NOT yield an "on" cell. If the notes say the
chain depended on a weakened mitigation, record it as "off" with that dependency
in forbids, so the next run is told not to rely on it.

Examples of BAD vs GOOD:
  BAD  technique: "overwrite qword_0x602038 with system@plt"     (address)
  GOOD technique: "fastbin index check bypassed via borrowed size byte -> fake chunk near GOT"
  BAD  requires: {"glibc": "2.44", "notes": "calloc zeroes fd"}
  GOOD requires: {"glibc": "=2.44"}, optional: ["calloc", "tcache"]

Every harness issue (timeout/refused/docker) MUST appear in problems with the fix used.
skip is a short operational rule the next agent can follow (or empty).
deny: ONE key from this closed list when the skip is enforceable as a tool refusal, else "".
  Allowed: libc_disasm, libc_debug, interactive, writeup_fetch, kb, docker_down,
  memory_peek, other_challenge, gdb_library_path.
habits: what to measure at the START of a similar task, phrased as a mechanism trigger.

Schema:
{
  "problems": [{"problem": str, "solution": str, "skip": str, "deny": str, "condition": str}],
  "cells": [{"technique": str, "requires": {}, "forbids": [str], "forbids_version": {},
             "optional": [str], "state": "on"|"off", "summary": str}],
  "habits": [{"when": str, "observe": str}]
}
"""


def compile_run(
    *,
    challenge: str,
    status: str,
    chain: str,
    stuck: str,
    elapsed_s: float,
    extra: str = "",
    verified: str = "local",
    since: str | None = None,
) -> dict[str, Any]:
    kind = infer_kind(challenge)
    verified = verified if verified in VERIFY_LEVELS else "local"
    append_episode(
        challenge=challenge,
        kind="verdict",
        status=status,
        chain=chain,
        stuck=stuck,
        elapsed_s=elapsed_s,
        verified=verified,
        condition="kind=" + kind,
    )
    return _compile_body(
        challenge=challenge,
        kind=kind,
        status=status,
        chain=chain,
        stuck=stuck,
        extra=extra,
        elapsed_s=elapsed_s,
        verified=verified,
        since=since,
    )


def compile_from_store(challenge: str, verified: str = "local") -> dict[str, Any]:
    """Re-compile an already finished challenge from episodes + issues."""
    verdict: dict[str, Any] = {}
    for row in load_episodes(challenge):
        if row.get("kind") == "verdict":
            verdict = row
    kind = infer_kind(challenge)
    if verdict.get("verified") in VERIFY_LEVELS:
        verified = str(verdict["verified"])
    return _compile_body(
        challenge=challenge,
        kind=kind,
        status=str(verdict.get("status") or "solved"),
        chain=str(verdict.get("chain") or ""),
        stuck=str(verdict.get("stuck") or ""),
        extra="",
        elapsed_s=float(verdict.get("elapsed_s") or 0),
        verified=verified,
        since=None,
    )


def _compile_body(
    *,
    challenge: str,
    kind: str,
    status: str,
    chain: str,
    stuck: str,
    extra: str,
    elapsed_s: float,
    verified: str,
    since: str | None,
) -> dict[str, Any]:
    evidence = _evidence(
        challenge=challenge,
        kind=kind,
        status=status,
        chain=chain,
        stuck=stuck,
        extra=extra,
        elapsed_s=elapsed_s,
        verified=verified,
        since=since,
    )
    try:
        data = chat_json(COMPILE_SYS, evidence)
    except Exception as exc:
        append_issue("compile", str(exc), challenge=challenge)
        data = {"problems": [], "cells": [], "habits": [], "error": str(exc)}
    data = _sanitize(data, kind=kind, verified=verified, status=status)
    data["verified"] = verified
    save_lesson(challenge, data)
    _apply(challenge, kind, data)
    return data


def _evidence(**kv: Any) -> str:
    import json

    challenge = kv["challenge"]
    since = kv.get("since")
    issues = _since(load_issues(challenge), since)
    notes = [
        e for e in _since(load_episodes(challenge), since) if e.get("kind") != "verdict"
    ]
    return json.dumps(
        {
            "challenge": challenge,
            "kind": kv["kind"],
            "status": kv["status"],
            "verified": kv.get("verified"),
            "elapsed_s": kv["elapsed_s"],
            "chain": kv["chain"],
            "stuck": kv["stuck"],
            "extra": kv["extra"],
            "this_round_only": bool(since),
            "harness_issues": issues[-20:],
            "agent_notes": notes[-30:],
        },
        ensure_ascii=False,
        indent=2,
    )


def _since(rows: list[dict[str, Any]], since: str | None) -> list[dict[str, Any]]:
    if not since:
        return rows
    return [r for r in rows if str(r.get("ts") or "") >= since]


def _sanitize(data: dict[str, Any], *, kind: str, verified: str, status: str = "solved") -> dict[str, Any]:
    problems = []
    for item in data.get("problems") or []:
        if not isinstance(item, dict):
            continue
        problem = str(item.get("problem") or "").strip()
        if not problem:
            continue
        deny = str(item.get("deny") or "").strip()
        if deny not in DENY_KEYS:
            deny = ""
        problems.append(
            {
                "problem": problem[:240],
                "solution": str(item.get("solution") or "").strip()[:240],
                "skip": str(item.get("skip") or "").strip()[:160],
                "deny": deny,
                "condition": str(item.get("condition") or "").strip()[:120],
            }
        )
    cells = []
    dropped: list[dict[str, str]] = []
    for item in data.get("cells") or []:
        if not isinstance(item, dict):
            continue
        tech = str(item.get("technique") or "").strip()
        if not tech or tech.count("->") >= 2 or len(tech) > 80:
            continue
        if not _portable_technique(tech):
            # Addresses and challenge chunk sizes belong in episodes, not atlas.
            dropped.append({"technique": tech, "why": "nonportable"})
            continue

        state = str(item.get("state") or "on").strip()
        if state not in {"on", "off"}:
            state = "on"

        # Evidence discipline.
        #
        # The old rule was `verified != flag -> off`, which turned our own
        # working exploit (uid=0 root shell, reliable 3/3) into a prohibition
        # for the next run. `local` is weaker evidence than `flag`, not the
        # absence of evidence. Tier weighting in activate.py handles the
        # difference; erasing the success does not.
        #
        # Only a run that never worked may be stored OFF.
        # Evidence discipline. The four levels are not a ladder to be averaged,
        # they decide whether a cell may be an instruction at all:
        #
        #   flag   the target itself confirmed it        -> ON,  tier flag
        #   local  it genuinely worked, locally          -> ON,  tier local
        #   none   it never worked, or it was invalidated -> OFF
        #   wiki   an article says it works              -> OFF (not an instruction)
        #
        # `none` must force OFF even when status is "solved": that combination
        # is exactly what a solve-by-weakening-protections looks like after
        # cmd_finish downgrades it, and letting it stay ON stored "disable ASLR"
        # as a technique for the next run.
        evidence = "wiki" if verified == "wiki" else ("flag" if verified == "flag" and status == "solved" else verified)
        if evidence not in VERIFY_LEVELS:
            evidence = "none"

        if state == "on":
            if status != "solved":
                state = "off"
            elif evidence in ("none", "wiki"):
                state = "off"

        req = item.get("requires") if isinstance(item.get("requires"), dict) else {}
        req = {k: v for k, v in req.items() if v not in (None, "", [], {})}
        # Same coercion the wiki path applies: models write `glibc==2.26` and
        # `=>=2.31`, and an unnormalised spec silently never matches.
        from aegis.predicate import normalize_ver_spec

        if isinstance(req.get("glibc"), str):
            norm = normalize_ver_spec(req["glibc"])
            if norm:
                req["glibc"] = norm
            else:
                req.pop("glibc")
        fb = [str(f) for f in (item.get("forbids") or []) if str(f) in ATOMIC_TAGS]
        fv = item.get("forbids_version") if isinstance(item.get("forbids_version"), dict) else {}
        fv = {k: v for k, v in fv.items() if v not in (None, "", [], {})}
        if isinstance(fv.get("glibc"), str):
            norm = normalize_ver_spec(fv["glibc"])
            if norm:
                fv["glibc"] = norm
            else:
                fv.pop("glibc")
        opt = sorted({str(o) for o in (item.get("optional") or []) if str(o) in KNOWN_TAGS})

        cond = str(item.get("condition") or "").strip() or _cond_from(req, fb, fv)
        cells.append(
            {
                "schema": 2,
                "technique": tech,
                "requires": req,
                "forbids": fb,
                "forbids_version": fv,
                "optional": opt,
                "state": state,
                "evidence": evidence,
                "condition": cond[:160],  # retained for readability only
                "summary": str(item.get("summary") or "").strip()[:200],
            }
        )
    habits = []
    for item in data.get("habits") or []:
        if not isinstance(item, dict):
            continue
        observe = str(item.get("observe") or "").strip()
        if not observe or len(observe) > 160:
            continue
        habits.append(
            {
                "when": str(item.get("when") or kind).strip()[:80],
                "observe": observe,
            }
        )
    out: dict[str, Any] = {
        "problems": problems,
        "cells": cells,
        "habits": habits,
        "compiled_at": now_iso(),
    }
    if dropped:
        out["dropped_cells"] = dropped
    if data.get("error"):
        out["error"] = str(data["error"])
    return out


def _apply(challenge: str, kind: str, data: dict[str, Any]) -> None:
    for cell in data.get("cells") or []:
        upsert_cell(
            technique=cell["technique"],
            condition=cell.get("condition") or "",
            state=cell["state"],
            source=challenge,
            requires=cell.get("requires") or {},
            forbids=cell.get("forbids") or [],
            forbids_version=cell.get("forbids_version") or {},
            optional=cell.get("optional") or [],
            evidence=cell.get("evidence") or "local",
            summary=cell.get("summary") or "",
        )
    for item in data.get("problems") or []:
        if item.get("skip"):
            upsert_search_rule(
                when=kind,
                action="skip",
                target=item["skip"],
                source=challenge,
                bump=True,
            )
    for habit in data.get("habits") or []:
        upsert_search_rule(
            when=habit["when"],
            action="focus",
            target=habit["observe"],
            source=challenge,
            bump=True,
        )
