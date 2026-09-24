from __future__ import annotations

from pathlib import Path
from typing import Any

from aegis.paths import RUNS_DIR, ensure_dirs
from aegis.store import load_issues, now_iso


def write_writeup(
    *,
    challenge: str,
    status: str,
    elapsed_s: float,
    chain: str,
    stuck: str,
    extra: str = "",
    compiled: dict[str, Any] | None = None,
    since: str | None = None,
) -> Path:
    ensure_dirs()
    stamp = now_iso().replace(":", "").replace("-", "").replace("+", "p")[:15]
    path = RUNS_DIR / f"{stamp}_{challenge}.md"
    lines = [
        f"# {challenge}",
        f"- time: {now_iso()}",
        f"- elapsed_s: {elapsed_s:.1f}",
        f"- status: {status}",
        f"- verified: {(compiled or {}).get('verified') or '-'}",
        f"- stuck: {stuck.strip() or '-'}",
        f"- chain: {chain.strip() or '-'}",
        f"- notes: {extra.strip() or '-'}",
    ]
    issues = load_issues(challenge)
    if since:
        # Only this round's harness problems; do not replay every past round.
        issues = [r for r in issues if str(r.get("ts") or "") >= since]
    if issues:
        lines.append("- problems:")
        for row in issues:
            msg = " ".join(str(row.get("message") or "").split())
            if len(msg) > 180:
                msg = msg[:177] + "..."
            lines.append(f"  - [{row.get('kind')}] {msg}")
    else:
        lines.append("- problems: (none recorded by harness)")
    if compiled:
        if compiled.get("error"):
            lines.append(f"- compile_error: {compiled['error']}")
        for item in compiled.get("problems") or []:
            lines.append(f"- lesson_problem: {item.get('problem')}")
            if item.get("solution"):
                lines.append(f"  lesson_solution: {item.get('solution')}")
        for cell in compiled.get("cells") or []:
            lines.append(
                f"- lesson_cell: [{cell.get('state')}] {cell.get('technique')} @ {cell.get('condition')}"
            )
        for habit in compiled.get("habits") or []:
            lines.append(f"- lesson_habit: when {habit.get('when')}: {habit.get('observe')}")
    lines.append("")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def list_writeups() -> list[Path]:
    if not RUNS_DIR.is_dir():
        return []
    return sorted(RUNS_DIR.glob("*.md"))
