"""CLI-level invariants. These are about the shell contract, not the harness logic.

The one under test here is the exit status: `aegis observer thoughts | head -80`
is normal, documented use, and a reader closing the pipe early must not make the
harness look like it crashed. That matters more than usual for this project —
the tool output is the audit trail, and an operator who sees a traceback at the
bottom of an audit cannot tell a real crash from a pager quitting.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from aegis import paths


def _seed_thoughts(n: int = 400) -> Path:
    """Write enough native `thought` events that a truncated pipe really breaks.

    Output has to clear the pipe buffer (64K) before the command finishes, or the
    failing write lands in the interpreter's exit flush — outside `main()`, where
    no guard can help. Small fixtures would pass against unfixed code.
    """
    if not os.environ.get("AEGIS_STATE_DIR"):
        # Same reasoning as run_all's own note: a fixture seeded into the live
        # `.aegis/` would masquerade as the newest session and leak a fake world
        # into the operator's run. Refuse rather than pollute.
        raise RuntimeError("run tests via tests/run_all.py — refusing to seed into the live .aegis/")
    d = Path(paths.AEGIS_DIR) / "observer"
    d.mkdir(parents=True, exist_ok=True)
    path = d / "events-cli-test.jsonl"
    with path.open("w", encoding="utf-8") as fh:
        for i in range(1, n + 1):
            fh.write(
                json.dumps(
                    {
                        "v": 1,
                        "seq": i,
                        "ts": "2026-01-01T00:00:00.000Z",
                        "worker": "pi",
                        "session": "cli-test",
                        "kind": "thought",
                        "data": {"text": f"第 {i} 段思考：" + "堆风水推理 " * 40},
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    return path


def _run_cli(argv: list[str], *, close_stdout_early: bool) -> tuple[int, bytes, bytes]:
    env = dict(os.environ)
    code = (
        "import sys; sys.argv=['aegis']+sys.argv[1:];"
        "from aegis.cli.main import main; sys.exit(main())"
    )
    if not close_stdout_early:
        p = subprocess.run(
            [sys.executable, "-c", code, *argv], capture_output=True, env=env, timeout=120
        )
        return p.returncode, p.stdout, p.stderr

    r, w = os.pipe()
    p = subprocess.Popen(
        [sys.executable, "-c", code, *argv], stdout=w, stderr=subprocess.PIPE, env=env
    )
    os.close(w)
    os.read(r, 256)  # take a little, then hang up like `head` does
    os.close(r)
    err = p.stderr.read()
    p.wait(timeout=120)
    p.stderr.close()
    return p.returncode, b"", err


def test_truncated_pipe_exits_clean() -> None:
    """`| head` must exit 0 with no traceback. A crash report here is a false
    alarm in the audit trail, which is the one place we cannot afford one."""
    _seed_thoughts()
    rc, _, err = _run_cli(["observer", "thoughts", "--limit", "400"], close_stdout_early=True)
    assert rc == 0, f"truncated pipe exited {rc}; stderr={err[-800:]!r}"
    assert b"Traceback" not in err, err[-800:]
    assert b"BrokenPipeError" not in err, err[-800:]


def test_untruncated_pipe_still_works() -> None:
    """The guard must not swallow the normal path: same command, read to EOF,
    still exits 0 and still prints the whole audit."""
    _seed_thoughts()
    rc, out, err = _run_cli(["observer", "thoughts", "--limit", "400"], close_stdout_early=False)
    assert rc == 0, err[-800:]
    assert "思考".encode() in out, out[:400]
    assert len(out) > 65536, f"fixture too small to exercise the pipe: {len(out)} bytes"


def test_only_broken_pipe_is_swallowed() -> None:
    """Scope check. A bare `except:` around dispatch would turn every harness bug
    into a silent exit 0 — the failure mode this project keeps having to undo."""
    import importlib

    # `aegis.cli.main` is shadowed by the function re-exported in
    # `aegis/cli/__init__.py`, so reach the module through importlib.
    cli = importlib.import_module("aegis.cli.main")

    def boom() -> int:
        raise ValueError("harness bug")

    original = cli.cmd_doctor
    cli.cmd_doctor = boom  # type: ignore[assignment]
    try:
        try:
            cli.main(["doctor"])
        except ValueError:
            pass  # correct: a real bug is not hidden
        else:
            raise AssertionError("main() swallowed a non-pipe exception")
    finally:
        cli.cmd_doctor = original  # type: ignore[assignment]
