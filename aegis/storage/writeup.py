from __future__ import annotations

from pathlib import Path
from typing import Any

from aegis.paths import RUNS_DIR, ensure_dirs
from aegis.storage.store import load_issues, now_iso


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
        # Compilation is mechanical now: events -> memory -> experience. There
        # are no generated cells to render, so report the counts instead. A run
        # that produced no events says so here rather than looking empty.
        if compiled.get("error"):
            lines.append(f"- compile_error: {compiled['error']}")
        mem = compiled.get("memory") or {}
        exp = compiled.get("experience") or {}
        if mem:
            lines.append(
                f"- memory: {mem.get('records_new', 0)} new / {mem.get('records_total', 0)} total"
                f"  sessions={mem.get('sessions', 0)}  evidence={mem.get('evidence')}"
                f"  trusted={mem.get('trusted')}"
            )
        if exp:
            lines.append(
                f"- experience: rows={exp.get('rows', 0)}"
                f"  with_success={exp.get('with_success', 0)}"
                f"  vetoable={exp.get('vetoable', 0)}"
            )
        forgotten = compiled.get("forgotten") or {}
        if forgotten and forgotten.get("dropped"):
            lines.append(
                f"- forgotten: compacted={forgotten.get('compacted', 0)}"
                f" refuted={forgotten.get('refuted', 0)}"
                f" reasons={forgotten.get('reasons')}"
            )
    lines.append("")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def list_writeups() -> list[Path]:
    if not RUNS_DIR.is_dir():
        return []
    return sorted(RUNS_DIR.glob("*.md"))
