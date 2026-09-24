from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import os

from aegis.paths import (
    AEGIS_DIR,
    ATLAS_PATH,
    CURRENT_PATH,
    EPISODES_PATH,
    ISSUES_PATH,
    LESSONS_PATH,
    SEARCH_PATH,
    ensure_dirs,
    run_state_path,
)

# Tags usable as a hard veto. Closed on purpose: a wrong veto silently deletes
# a technique that works, so vetoes stay a small, reviewed vocabulary.
ATOMIC_TAGS = frozenset(
    {
        "exit_group",
        "exit_flush",
        "hooks_dead",
        "hooks_alive",
        "thread_arena",
        "main_arena",
        "safe_linking",
        "no_safe_linking",
        "tcache_key_random",
        "no_free",
        "no_show",
        "full_relro",
        "canary",
        "non_pie",
        "pie",
        "tcache",
        "fastbin",
        "unsorted_bin",
        "calloc",
    }
)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _read_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def active_challenge() -> str | None:
    env = os.environ.get("AEGIS_CHALLENGE", "").strip()
    return env or None


def load_current() -> dict[str, Any] | None:
    ch = active_challenge()
    if ch:
        data = _read_json(run_state_path(ch), None)
        if isinstance(data, dict):
            return data
    data = _read_json(CURRENT_PATH, None)
    return data if isinstance(data, dict) else None


def save_current(data: dict[str, Any]) -> None:
    ensure_dirs()
    ch = str(data.get("challenge") or "")
    if ch:
        _write_json(run_state_path(ch), data)
    _write_json(CURRENT_PATH, data)


def clear_current() -> None:
    cur = load_current()
    ch = active_challenge() or (str(cur.get("challenge")) if cur else "")
    if ch:
        p = run_state_path(ch)
        if p.exists():
            p.unlink()
    pointer = _read_json(CURRENT_PATH, None)
    if isinstance(pointer, dict) and pointer.get("challenge") == ch:
        CURRENT_PATH.unlink(missing_ok=True)


def append_episode(**row: Any) -> None:
    ensure_dirs()
    row.setdefault("ts", now_iso())
    _append_jsonl(EPISODES_PATH, row)


def append_issue(kind: str, message: str, **extra: Any) -> dict[str, Any]:
    ensure_dirs()
    row = {"ts": now_iso(), "kind": kind, "message": message, **extra}
    _append_jsonl(ISSUES_PATH, row)
    return row


def load_issues(challenge: str | None = None) -> list[dict[str, Any]]:
    if not ISSUES_PATH.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in ISSUES_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        if challenge and row.get("challenge") != challenge:
            continue
        rows.append(row)
    return rows


def load_episodes(challenge: str | None = None) -> list[dict[str, Any]]:
    if not EPISODES_PATH.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in EPISODES_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        if challenge and row.get("challenge") != challenge:
            continue
        rows.append(row)
    return rows


def save_lesson(challenge: str, data: dict[str, Any]) -> None:
    ensure_dirs()
    lock_path = LESSONS_PATH.with_suffix(".json.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as lock:
        try:
            import fcntl

            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        except Exception:
            pass
        blob = _read_json(LESSONS_PATH, {"lessons": []})
        if not isinstance(blob, dict):
            blob = {"lessons": []}
        lessons: list[dict[str, Any]] = blob.setdefault("lessons", [])
        lessons.append({"challenge": challenge, **data})
        _write_json(LESSONS_PATH, blob)


def load_lessons(challenge: str | None = None) -> list[dict[str, Any]]:
    blob = _read_json(LESSONS_PATH, {"lessons": []})
    lessons = blob.get("lessons") if isinstance(blob, dict) else []
    if not isinstance(lessons, list):
        return []
    latest: dict[str, dict[str, Any]] = {}
    for row in lessons:
        if not isinstance(row, dict):
            continue
        name = str(row.get("challenge") or "")
        if challenge and name != challenge:
            continue
        latest[name or f"anon-{len(latest)}"] = row
    return list(latest.values())


def load_atlas() -> dict[str, Any]:
    data = _read_json(ATLAS_PATH, {"cells": []})
    if not isinstance(data, dict):
        return {"cells": []}
    data.setdefault("cells", [])
    return data


def save_atlas(data: dict[str, Any]) -> None:
    _write_json(ATLAS_PATH, data)


def load_search() -> dict[str, Any]:
    data = _read_json(SEARCH_PATH, {"rules": []})
    if not isinstance(data, dict):
        return {"rules": []}
    data.setdefault("rules", [])
    return data


def save_search(data: dict[str, Any]) -> None:
    _write_json(SEARCH_PATH, data)


def upsert_cell(
    *,
    technique: str,
    condition: str,
    state: str,
    source: str,
    requires: dict[str, Any] | None = None,
    forbids: list[str] | None = None,
    forbids_version: dict[str, Any] | None = None,
    optional: list[str] | None = None,
    evidence: str = "local",
    summary: str = "",
) -> None:
    """Insert or bump a cell. `n` is the ACT-R base-level practice count.

    Identity is the technique alone (not technique+condition): the same
    mechanism seen twice under different prose is one practised cell, not two
    unfamiliar ones. Bumping n is what makes a repeatedly confirmed technique
    outrank a one-off.
    """
    atlas = load_atlas()
    cells: list[dict[str, Any]] = atlas["cells"]
    for cell in cells:
        if cell.get("technique") == technique:
            cell["state"] = state
            cell["n"] = int(cell.get("n") or 0) + 1
            cell["updated"] = now_iso()
            cell["source"] = source
            cell["schema"] = 2
            if requires:
                cell["requires"] = requires
            if forbids:
                cell["forbids"] = forbids
            if forbids_version:
                cell["forbids_version"] = forbids_version
            if optional:
                cell["optional"] = optional
            cell["evidence"] = evidence
            if summary:
                cell["summary"] = summary
            if condition:
                cell["condition"] = condition
            save_atlas(atlas)
            return
    cells.append(
        {
            "schema": 2,
            "technique": technique,
            "condition": condition,
            "requires": requires or {},
            "forbids": forbids or [],
            "forbids_version": forbids_version or {},
            "optional": optional or [],
            "state": state,
            "evidence": evidence,
            "summary": summary,
            "n": 1,
            "source": source,
            "updated": now_iso(),
        }
    )
    save_atlas(atlas)


def upsert_search_rule(*, when: str, action: str, target: str, source: str, bump: bool = True) -> None:
    store = load_search()
    rules: list[dict[str, Any]] = store["rules"]
    for rule in rules:
        if rule.get("when") == when and rule.get("action") == action and rule.get("target") == target:
            if bump:
                rule["n"] = int(rule.get("n", 0)) + 1
            rule["updated"] = now_iso()
            save_search(store)
            return
    rules.append(
        {
            "when": when,
            "action": action,
            "target": target,
            "n": 1,
            "source": source,
            "updated": now_iso(),
        }
    )
    save_search(store)


def _portable_technique(text: str) -> bool:
    """A cell must survive a target change: mechanism level, no raw address."""
    from aegis.predicate import _parse_ver  # noqa: F401  (kept for API stability)
    from aegis.util import nonportable

    t = text.strip()
    if not t:
        return False
    if t.count("->") >= 2 or len(t) > 96:
        return False
    return not nonportable(t)


def _normalise_cell(cell: dict[str, Any]) -> dict[str, Any]:
    """Put a raw stored cell into the canonical schema-2 shape.

    Extracted from `_atlas_cells` so a caller working from a *frozen* snapshot
    (the test fixtures) gets exactly the same shape and the same computed
    `_cues` as a caller reading the live atlas. Without this the two paths could
    silently diverge and the tests would pass against a shape the runtime never
    produces.
    """
    return {
        "schema": int(cell.get("schema") or 1),
        "technique": str(cell.get("technique") or ""),
        "requires": cell.get("requires") or {},
        "forbids": list(cell.get("forbids") or []),
        "forbids_version": dict(cell.get("forbids_version") or {}),
        "optional": list(cell.get("optional") or []),
        "tags": list(cell.get("tags") or []),
        "state": str(cell.get("state") or "on"),
        "evidence": str(cell.get("evidence") or ""),
        "n": int(cell.get("n") or 1),
        "source": str(cell.get("source") or ""),
        "legacy_condition": str(cell.get("condition") or ""),
        "_cues": _cell_cues(cell),
    }


def _atlas_cells() -> list[dict[str, Any]]:
    """Canonical cell store, schema 2.

    atlas carries the practice count n (ACT-R base level) and the structured
    predicates. Cells written by an older version are passed through with
    whatever fields they have; `score` tolerates missing predicates.
    """
    return [
        _normalise_cell(cell)
        for cell in (load_atlas().get("cells") or [])
        if isinstance(cell, dict)
    ]


def _cell_cues(cell: dict[str, Any]) -> list[str]:
    """Mechanism tags for cue overlap, from structured fields when present."""
    out: set[str] = {str(t) for t in (cell.get("tags") or [])}
    out |= {str(t) for t in (cell.get("optional") or [])}
    out |= {str(f) for f in (cell.get("forbids") or [])}
    out |= {str(k) for k in (cell.get("forbids_version") or {})}
    req = cell.get("requires") or {}
    for k, v in req.items():
        if k == "glibc":
            specs = v if isinstance(v, (list, tuple)) else [v]
            for s in specs:
                from aegis.predicate import _parse_ver

                p = _parse_ver(str(s))
                if p:
                    out.add(f"glibc{p[1][0]}.{p[1][1]}")
        elif k == "alloc":
            vals = v if isinstance(v, (list, tuple)) else [v]
            out |= {str(x) for x in vals}
        elif k in ("hooks", "exit", "arena"):
            out.add(f"hooks_{v}" if k == "hooks" else (f"exit_{v}" if k == "exit" else f"{v}_arena"))
    if not out and cell.get("condition"):
        from aegis.activate_legacy import extract_cues

        out |= extract_cues(str(cell.get("condition")))
    return sorted(out)


def _lesson_units() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Mechanism-level problems and habits, deduped across runs.

    Content is reused, but it is NOT a fingerprint source (see run_fingerprint).
    """
    problems: dict[str, dict[str, Any]] = {}
    habits: dict[str, dict[str, Any]] = {}
    for lesson in load_lessons():
        src = str(lesson.get("challenge") or "")
        for p in lesson.get("problems") or []:
            if not isinstance(p, dict):
                continue
            key = " ".join(str(p.get("problem") or "").lower().split())[:120]
            if not key:
                continue
            row = problems.setdefault(
                key,
                {
                    "problem": p.get("problem"),
                    "solution": p.get("solution"),
                    "skip": p.get("skip"),
                    "deny": p.get("deny") or "",
                    "condition": p.get("condition") or "",
                    "source": src,
                    "n": 0,
                },
            )
            row["n"] += 1
            if not row.get("deny") and p.get("deny"):
                row["deny"] = p["deny"]
        for h in lesson.get("habits") or []:
            if not isinstance(h, dict):
                continue
            key = " ".join(str(h.get("when") or "").lower().split())[:60] + "|" + " ".join(
                str(h.get("observe") or "").lower().split()
            )[:80]
            if key.strip("|"):
                habits.setdefault(
                    key,
                    {
                        "when": h.get("when"),
                        "observe": h.get("observe"),
                        "source": src,
                        "n": 1,
                    },
                )
    return list(problems.values()), list(habits.values())


def run_fingerprint() -> set[str]:
    """Legacy view: the set of tags in the current fingerprint."""
    fp = current_fingerprint()
    return set(fp.all)


def current_fingerprint():
    """Structured fingerprint from: human hints, explicit current.fingerprint,
    and observations recorded in THIS run.

    Deliberately excluded: kind=pwn (a category, not a world), another
    challenge's numbers, and this challenge's own past lessons (feeding those
    back is copying the answer key, not transfer).
    """
    from aegis.fingerprint import parse

    cur = load_current() or {}
    texts = [str(h) for h in (cur.get("hints") or [])]
    texts += [str(x) for x in (cur.get("fingerprint") or [])]
    tags: list[str] = []
    for obs in cur.get("observations") or []:
        if not isinstance(obs, dict):
            continue
        texts.append(str(obs.get("text") or ""))
        tags += [str(t) for t in (obs.get("tags") or [])]
    fp = parse(texts, tags)
    return fp


def add_observation(
    text: str,
    kind: str = "observe",
    tags: list[str] | None = None,
) -> dict[str, Any]:
    """Record what THIS run has actually seen. Only this feeds the fingerprint."""
    cur = load_current()
    if not cur:
        raise RuntimeError("no current challenge; run aegis start <id> first")
    row = {
        "ts": now_iso(),
        "kind": kind,
        "text": text.strip(),
        "tags": [t.strip() for t in (tags or []) if t.strip()],
    }
    obs = cur.setdefault("observations", [])
    obs.append(row)
    if row["tags"]:
        fp = cur.setdefault("fingerprint", [])
        for t in row["tags"]:
            if t not in fp:
                fp.append(t)
    save_current(cur)
    append_episode(
        challenge=cur.get("challenge"),
        kind=kind,
        text=row["text"],
        condition="tags=" + ",".join(row["tags"]),
    )
    return row


def refresh_activation() -> dict[str, Any]:
    """Recompute the column for THIS challenge and persist denies for the guard."""
    ram_blob()
    data = _read_json(AEGIS_DIR / "activation.json", {})
    return data if isinstance(data, dict) else {}


def active_denies() -> list[str]:
    data = refresh_activation()
    if str(data.get("challenge") or "") not in {active_challenge() or "", str((load_current() or {}).get("challenge") or "")}:
        return []
    return [str(k) for k in (data.get("denies") or []) if str(k).strip()]


def build_bundle() -> dict[str, Any]:
    """Compute and persist the activated column for the current challenge."""
    from aegis.activate import activate

    cur = load_current() or {}
    ch = str(cur.get("challenge") or "")
    fp = current_fingerprint()
    problems, habits = _lesson_units()
    bundle = activate(
        cells=_atlas_cells(),
        problems=problems,
        habits=habits,
        fp=fp,
        current=ch,
    )
    learned = {str(p.get("deny") or "") for p in bundle["problems"]} - {""}
    learned |= {str(k) for k in (bundle.get("denies") or []) if str(k).strip()}
    bundle["denies"] = sorted(learned)
    bundle["challenge"] = ch
    _write_json(AEGIS_DIR / "activation.json", bundle)

    # The internal ledger is the memory agent's private status field: it is
    # never shown to the action agent (Wu et al. 2607.08716 §3.2). It lives
    # here so `aegis recall --explain` and the growth audit can read it.
    _write_json(
        AEGIS_DIR / "status.json",
        {
            "challenge": ch,
            "ts": now_iso(),
            "fingerprint": bundle["fingerprint"],
            "dropped": bundle["dropped"],
            "source_mix": bundle["source_mix"],
            "hsr_at_k": bundle.get("hsr_at_k", 0.0),
            "tau": bundle.get("tau"),
            "counts": {
                "cells": len(bundle.get("cells") or []),
                "forbid": len(bundle.get("forbid") or []),
                "problems": len(bundle.get("problems") or []),
                "habits": len(bundle.get("habits") or []),
                "reference": len(bundle.get("reference") or []),
            },
        },
    )
    return bundle


def ram_blob(kind: str | None = None) -> str:
    """Assemble the activated column. The full stores stay on disk.

    Only decision-relevant text reaches the model: hard constraints, applicable
    cells, and opening measurements. Counts and drop reasons go to status.json.
    """
    cur = load_current() or {}
    ch = str(cur.get("challenge") or "")
    bundle = build_bundle()

    L: list[str] = []
    f = bundle.get("fingerprint") or {}
    if not f.get("observed"):
        L.append("# 经验（冷启动：尚无观测，只注入开局要量的量）")
    else:
        bits = []
        if f.get("glibc"):
            bits.append(f"glibc{f['glibc'][0]}.{f['glibc'][1]}")
        for key in ("hooks", "exit", "arena"):
            if f.get(key):
                bits.append(f"{key}={f[key]}")
        if f.get("alloc"):
            bits.append("alloc=" + ",".join(f["alloc"]))
        L.append("# 经验（按当前世界稀疏激活）")
        if bits:
            L.append("- 当前世界: " + "  ".join(bits))
    L.append("")

    if bundle["forbid"]:
        L.append("## 禁止尝试（OFF 格子，条件与当前世界匹配 → 硬约束）")
        for c in bundle["forbid"]:
            L.append(f"- 不要 {c.get('technique')}  （因为 {_why_fired(c)}）")
        L.append("")
    if bundle["denies"]:
        L.append("## 工具层拒绝（命中即 REFUSED，不要重试）")
        for k in bundle["denies"]:
            L.append(f"- {k}")
        L.append("")
    skips = [str(p.get("skip")) for p in bundle["problems"] if str(p.get("skip") or "").strip()]
    if skips:
        L.append("## 硬跳过")
        for s in skips:
            L.append(f"- SKIP {s}")
        L.append("")
    if bundle["habits"]:
        L.append("## 开局先量" if bundle["cold_start"] else "## 适用习惯")
        for h in bundle["habits"]:
            L.append(f"- when {h.get('when')}: {h.get('observe')}")
        L.append("")
    if bundle["cells"]:
        L.append("## 策略格子（机制层，条件与当前世界一致）")
        for c in bundle["cells"]:
            tier = c.get("evidence") or "?"
            req = _fmt_req(c.get("requires"))
            L.append(f"- [A={c['A']}][{tier}] {c.get('technique')}  @ {req}")
        L.append("")
    if bundle["problems"]:
        L.append("## 问题与解法（机制层）")
        for p in bundle["problems"]:
            L.append(f"- {p.get('problem')}")
            if p.get("solution"):
                L.append(f"  解法: {p.get('solution')}")
        L.append("")
    if bundle.get("reference"):
        L.append("## 背景参考（CTF Wiki，未在本系统验证；需要更多细节用 aegis_kb 查）")
        for c in bundle["reference"]:
            L.append(f"- {c.get('technique')}  @ {_fmt_req(c.get('requires'))}")
        L.append("")

    if not any(
        [
            bundle["cells"],
            bundle["problems"],
            bundle["habits"],
            bundle["forbid"],
            bundle.get("reference"),
        ]
    ):
        L.append("（无适用经验 — 先用 aegis_observe 记下 libc / arena / 退出路径）")
    return "\n".join(L)


def _why_fired(c: dict[str, Any]) -> str:
    """Why this prohibition applies: the conditions that actually fired.

    Showing every condition the cell carries told the agent to avoid a FSOP
    technique "because glibc=2.44" while it was working on 2.27 — a reason that
    is both confusing and false for this world.
    """
    matched = [str(m) for m in (c.get("_matched") or [])]
    if matched:
        return ", ".join(matched)
    # A cell matched by its positive conditions rather than by a veto. There is
    # no failing condition to name, so repeating `requires` as if it were the
    # cause was actively misleading — it read as "avoid this because it needs
    # glibc 2.27".
    why = str(c.get("why") or "")
    if why.startswith("matched:") or why == "applicable":
        return "相同条件下上次没打通"
    bits = [str(f) for f in (c.get("forbids") or [])]
    for k, v in (c.get("forbids_version") or {}).items():
        bits.append(f"{k}{v}" if k == "glibc" else f"{k}={v}")
    return ", ".join(bits) or str(c.get("legacy_condition") or "条件匹配")


def _fmt_req(req: Any) -> str:
    if not isinstance(req, dict) or not req:
        return "always"
    bits = []
    for k, v in req.items():
        if k == "glibc":
            bits.append(f"glibc{v}")  # spec already carries its operator
        elif isinstance(v, list):
            bits.append(f"{k}={'/'.join(map(str, v))}")
        else:
            bits.append(f"{k}={v}")
    return ", ".join(bits)
