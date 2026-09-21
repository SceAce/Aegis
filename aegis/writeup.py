from __future__ import annotations

from pathlib import Path

from aegis.paths import RUNS_DIR, ensure_dirs
from aegis.store import now_iso


def write_writeup(
    *,
    challenge: str,
    status: str,
    elapsed_s: float,
    chain: str,
    stuck: str,
    extra: str = "",
) -> Path:
    ensure_dirs()
    stamp = now_iso().replace(":", "").replace("-", "").replace("+", "p")[:15]
    path = RUNS_DIR / f"{stamp}_{challenge}.md"
    body = "\n".join(
        [
            f"# {challenge}",
            f"- time: {now_iso()}",
            f"- elapsed_s: {elapsed_s:.1f}",
            f"- status: {status}",
            f"- stuck: {stuck.strip() or '-'}",
            f"- chain: {chain.strip() or '-'}",
            f"- notes: {extra.strip() or '-'}",
            "",
        ]
    )
    path.write_text(body, encoding="utf-8")
    return path


def list_writeups() -> list[Path]:
    if not RUNS_DIR.is_dir():
        return []
    return sorted(RUNS_DIR.glob("*.md"))
