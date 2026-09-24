"""CTF Wiki as a consultable knowledge base — deliberately NOT experience.

Decision (user, 2026-09): the wiki is the *foundation of knowledge*, not
experience. The point of keeping it is to cut the cost of looking things up and
of re-deriving basic mechanism: the agent asks a question, gets the relevant
paragraph, and does not have to reason from scratch.

That means three design rules, all of which the previous implementation broke:

  1. A wiki article saying "this technique works" is evidence about the
     literature, not about this target. Wiki-derived items therefore never
     enter the strategy column (evidence tier `wiki` has B-weight 0 in
     activate.py).
  2. The wiki is **pull**, not push. It is retrieved when the agent asks for it,
     never injected at session start. Dumping it into RAM is what produced the
     "malloc(0) -> minimum chunk" noise that crowded out real cells.
  3. Retrieval is by scored match over compiled items, so an answer is a short
     list of mechanism statements plus the source page — not a wall of prose.

Storage is the same atlas (so wiki knowledge benefits from the migration and
from any future recompiles), but reads go through `lookup()` which ignores the
activation tier rules on purpose: the wiki is allowed to answer even when it
could not instruct.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from aegis.fingerprint import KNOWN_TAGS, Fingerprint
from aegis.paths import AEGIS_DIR, WIKI_DIR, WIKI_DONE_PATH, ensure_dirs
from aegis.store import ATOMIC_TAGS, append_issue, now_iso, save_lesson

WIKI_REPO = "https://github.com/ctf-wiki/ctf-wiki.git"
WIKI_SPARSE = ["docs/zh/docs/pwn/linux/user-mode/heap"]

WIKI_SYS = """You compile ONE CTF-Wiki article into reference knowledge for a pwn agent.

The assistant message MUST be a single JSON object. No markdown, no commentary.

This is a KNOWLEDGE BASE, not a lesson log. Extract what the article teaches as
mechanism statements a reader can act on:
- technique: the mechanism, <=80 chars, at most one "->".
- requires: the glibc / allocator / exit conditions under which it holds.
- forbids: conditions under which the article says it fails or is patched.
- tags: mechanism tags for retrieval.
- summary: ONE sentence (<=160 chars) a reader can use without opening the page.

Never put example addresses, offsets, or challenge names in a technique.
Use the closed tag vocabulary; unknown tags are discarded.

Schema:
{
  "items": [{
    "technique": str,
    "requires": {"glibc": str, "hooks": str, "exit": str, "arena": str, "alloc": [str]},
    "forbids": [str],
    "tags": [str],
    "summary": str
  }]
}
"""

MAX_CHARS = 9000


# ---------------------------------------------------------------- retrieval


def lookup(
    query: str,
    *,
    fp: Fingerprint | None = None,
    k: int = 6,
) -> list[dict[str, Any]]:
    """Find wiki items relevant to a free-text query. Pull-only.

    Scores by tag coverage + term overlap. Falls back to substring matching on
    the technique/summary so a query phrased in Chinese or with a typo still
    reaches something.
    """
    items = _wiki_items()
    if not items:
        return []

    q = " ".join(str(query).split()).lower()
    q_tags = {t for t in KNOWN_TAGS if t in q}
    q_terms = {w for w in re.findall(r"[a-z0-9_]{3,}", q)}
    q_cjk = {w for w in re.findall(r"[\u4e00-\u9fff]{2,}", q)}

    scored: list[tuple[float, dict[str, Any]]] = []
    for it in items:
        tags = {str(t) for t in (it.get("tags") or [])} | set(it.get("optional") or [])
        tech = str(it.get("technique") or "")
        summ = str(it.get("summary") or "")
        body = (tech + " " + summ).lower()

        s = 2.0 * len(tags & q_tags)
        s += 0.5 * len({t for t in q_terms if t in body})
        s += 1.5 * len({t for t in q_cjk if t in body})
        # A wiki item that is *inapplicable to the current world* is still worth
        # showing, but ranks below one that applies — knowledge vs instruction.
        if fp is not None:
            if _matches_world(it, fp):
                s += 1.0
        if s <= 0:
            continue
        scored.append((s, it))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [it for _s, it in scored[:k]]


def _matches_world(item: dict[str, Any], fp: Fingerprint) -> bool:
    req = item.get("requires") or {}
    g = req.get("glibc")
    if g and fp.glibc is not None:
        from aegis.predicate import _ver_ok  # single implementation

        specs = g if isinstance(g, (list, tuple)) else [g]
        if not any(_ver_ok(fp.glibc, str(s)) for s in specs):
            return False
    for f in item.get("forbids") or []:
        if fp.has(str(f)):
            return False
    return True


def _wiki_items() -> list[dict[str, Any]]:
    """All wiki-sourced items from the atlas."""
    from aegis.store import load_atlas

    out = []
    for c in load_atlas().get("cells") or []:
        if str(c.get("source") or "").startswith("ctf-wiki:") or c.get("evidence") == "wiki":
            out.append(c)
    return out


def render_lookup(items: list[dict[str, Any]], query: str = "") -> str:
    if not items:
        return f"（wiki 中没有匹配 “{query}” 的条目）"
    L = [f"# CTF Wiki 参考（查询：{query}）", ""]
    L.append("这是知识库，不是本系统验证过的经验。用于减少查资料和理解的时间。")
    L.append("")
    for it in items:
        src = str(it.get("source") or "").replace("ctf-wiki:", "")
        page = src.rsplit("/", 1)[-1].removesuffix(".md")
        L.append(f"- **{it.get('technique')}**  @ {_fmt_req(it.get('requires'))}")
        if it.get("summary"):
            L.append(f"  {it['summary']}")
        if it.get("forbids"):
            L.append(f"  失效条件: {', '.join(map(str, it['forbids']))}")
        L.append(f"  出处: {page}")
    return "\n".join(L)


def _fmt_req(req: Any) -> str:
    if not isinstance(req, dict) or not req:
        return "无特别条件"
    bits = []
    for k, v in req.items():
        if k == "glibc":
            # The spec already carries its operator ("=2.26", ">=2.31").
            bits.append(f"glibc{v}")
        elif isinstance(v, list):
            bits.append(f"{k}={'/'.join(map(str, v))}")
        else:
            bits.append(f"{k}={v}")
    return ", ".join(bits)


# ------------------------------------------------------------------ ingest


def fetch() -> Path:
    ensure_dirs()
    WIKI_DIR.parent.mkdir(parents=True, exist_ok=True)
    if (WIKI_DIR / ".git").is_dir():
        subprocess.run(["git", "-C", str(WIKI_DIR), "pull", "--ff-only"], check=False)
        return WIKI_DIR
    subprocess.run(
        ["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", WIKI_REPO, str(WIKI_DIR)],
        check=True,
    )
    subprocess.run(["git", "-C", str(WIKI_DIR), "sparse-checkout", "set", *WIKI_SPARSE], check=True)
    return WIKI_DIR


def list_pages() -> list[Path]:
    if not WIKI_DIR.is_dir():
        return []
    pages = [p for p in WIKI_DIR.rglob("*.md") if "user-mode/heap" in str(p).replace("\\", "/")]

    def rank(p: Path) -> tuple[int, str]:
        s = str(p).replace("\\", "/")
        if "/implementation/" in s:
            return (2, s)
        if any(k in s for k in ("overview", "introduction", "structure", "heapoverflow")):
            return (0, s)
        return (1, s)

    return sorted(pages, key=rank)


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(WIKI_DIR))
    except ValueError:
        return str(path)


def _load_done() -> set[str]:
    if not WIKI_DONE_PATH.is_file():
        return set()
    try:
        return set(json.loads(WIKI_DONE_PATH.read_text(encoding="utf-8")).get("done") or [])
    except json.JSONDecodeError:
        return set()


def _save_done(done: set[str]) -> None:
    AEGIS_DIR.mkdir(parents=True, exist_ok=True)
    WIKI_DONE_PATH.write_text(
        json.dumps({"done": sorted(done)}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def _excerpt(path: Path) -> str:
    text = path.read_text(encoding="utf-8", errors="replace")
    return text if len(text) <= MAX_CHARS else text[:MAX_CHARS] + "\n\n[truncated]\n"


def compile_page(path: Path) -> dict[str, Any]:
    """Compile one article into knowledge items. Always evidence=wiki, never ON."""
    from aegis.llm import chat_json

    rel = _rel(path)
    source = "ctf-wiki:" + rel
    user = json.dumps({"source": source, "title": path.stem, "article": _excerpt(path)}, ensure_ascii=False)
    try:
        data = chat_json(WIKI_SYS, user)
    except Exception as exc:
        append_issue("wiki-compile", str(exc), challenge=source)
        return {"error": str(exc), "items": 0}

    cells = []
    for it in data.get("items") or []:
        if not isinstance(it, dict):
            continue
        tech = str(it.get("technique") or "").strip()
        if not tech or len(tech) > 96 or tech.count("->") >= 2:
            continue
        req = it.get("requires") if isinstance(it.get("requires"), dict) else {}
        req = {k: v for k, v in req.items() if v not in (None, "", [], {})}
        if "glibc" in req:
            from aegis.predicate import normalize_ver_spec

            spec = req["glibc"]
            spec = normalize_ver_spec(spec) if not isinstance(spec, (list, tuple)) else None
            if spec:
                req["glibc"] = spec
            else:
                req.pop("glibc")  # unusable spec: drop the clause, keep the item
        tags = sorted({str(t) for t in (it.get("tags") or []) if str(t) in KNOWN_TAGS})
        cells.append(
            {
                "schema": 2,
                "technique": tech,
                "requires": req,
                "forbids": [str(f) for f in (it.get("forbids") or []) if str(f) in ATOMIC_TAGS],
                "optional": tags,
                "tags": tags,
                "summary": str(it.get("summary") or "").strip()[:200],
                # Knowledge, not experience. Never ON, never injected as strategy.
                "state": "reference",
                "evidence": "wiki",
                "n": 1,
            }
        )

    lesson = {
        "problems": [],
        "cells": cells,
        "habits": [],
        "verified": "wiki",
        "source": source,
        "compiled_at": now_iso(),
    }
    save_lesson(source, lesson)
    _upsert_wiki(cells, source)
    return {"items": len(cells), "source": source}


def _upsert_wiki(cells: list[dict[str, Any]], source: str) -> None:
    from aegis.store import load_atlas, save_atlas

    atlas = load_atlas()
    existing = {(str(c.get("technique")), str(c.get("source"))) for c in atlas.get("cells") or []}
    added = 0
    for c in cells:
        key = (str(c.get("technique")), source)
        if key in existing:
            continue
        atlas["cells"].append({**c, "source": source, "updated": now_iso()})
        added += 1
    if added:
        save_atlas(atlas)


def compile_all(*, limit: int = 0, force: bool = False) -> dict[str, int]:
    pages = list_pages()
    done = set() if force else _load_done()
    ok = fail = skip = 0
    for path in pages:
        rel = _rel(path)
        if rel in done:
            skip += 1
            continue
        if limit and ok + fail >= limit:
            break
        print(f"compile {rel}")
        data = compile_page(path)
        if data.get("error"):
            fail += 1
            print(f"  error: {data['error']}")
        else:
            ok += 1
            done.add(rel)
            print(f"  items={data.get('items', 0)}")
            _save_done(done)
    return {"ok": ok, "fail": fail, "skip": skip, "total": len(pages)}
