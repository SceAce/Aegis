"""Static checks on the pi extension's wiring.

The Python side cannot exercise the extension's TypeScript, so the one contract
that is easy to break and invisible from here gets checked statically: an async
helper used without `await`.
"""

from __future__ import annotations

from pathlib import Path

EXTENSION = Path(__file__).resolve().parent.parent / ".pi" / "extensions" / "aegis.ts"


def test_every_aegis_call_is_awaited() -> None:
    """`aegis()` returns a Promise, and a Promise is an object.

    Regression, and it crashed a live run: `aegis()` used to be `spawnSync` and
    returned a string. Making it async (so the guard check stopped blocking the
    event loop) left SEVEN call sites passing a variable — `aegis(args)` — which
    a search for the literal `aegis([` did not match, so they were reported as
    "all awaited" and shipped.

    The promise then reached the TUI as tool output and pi died with
    `TypeError: Expected a string, got object` inside `stripAnsi`, mid-run, with
    the transcript showing a stack trace instead of the challenge.

    The check is deliberately broad — any `aegis(` occurrence must be awaited —
    because the narrow version is exactly what missed this.
    """
    src = EXTENSION.read_text(encoding="utf-8")
    offenders: list[str] = []
    for number, line in enumerate(src.splitlines(), 1):
        if "aegis(" not in line:
            continue
        # The definition itself, and any use that is awaited, are fine.
        if "function aegis(" in line or "await aegis(" in line:
            continue
        offenders.append(f"{number}: {line.strip()}")
    assert not offenders, "un-awaited aegis() call(s): " + " ; ".join(offenders)


def test_extension_tools_return_string_text() -> None:
    """Tool results must be text, not a promise or an object.

    A tool returning a non-string in `content[].text` crashes pi's renderer
    rather than failing the tool, which turns a bug into a dead session.
    """
    import re

    src = EXTENSION.read_text(encoding="utf-8")
    offenders: list[str] = []
    for number, line in enumerate(src.splitlines(), 1):
        match = re.search(r"text:\s*(.+?)\s*[,}]", line)
        if not match:
            continue
        expr = match.group(1)
        if "aegis(" in expr and "await" not in expr:
            offenders.append(f"{number}: {line.strip()}")
    assert not offenders, "tool text built from an un-awaited promise: " + " ; ".join(offenders)
