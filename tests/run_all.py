"""Run every test module. No pytest dependency: the suite is self-contained.

Each test gets a wall-clock budget. That is not a nicety here: this suite drives
interactive sessions, so a test that wedges would otherwise hang the whole run
instead of reporting which one hung — which is itself the failure we care about.
"""
from __future__ import annotations

import importlib.util
import os
import signal
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULES = [
    "test_observer.py",
    "test_memory.py",
    "test_blackboard.py",
    "test_integrity.py",
    "test_guard.py",
    "test_channel.py",
    "test_session.py",
    "test_roleflip.py",
]

# Per-test budget. Session tests legitimately wait on a remote shell, so this is
# generous; it exists to convert a hang into a named failure.
#
# 45s turned out too tight to be a signal. One session start over ssh costs
# ~10-15s (probe + sync + tmux), so a test doing three operations lands right on
# the boundary: measured runs had session tests PASS at 45.0s and HANG at 45.1s
# from network jitter alone. A budget that flips on unchanged code is not
# measuring the code. 120s still names a genuine wedge while leaving room for
# the ssh round trips these tests actually need.
BUDGET_S = 120


class _Timeout(Exception):
    pass


def _alarm(_sig, _frm):
    raise _Timeout()


def main() -> int:
    # Isolate state BEFORE any test module imports aegis.paths.
    #
    # Regression: test_guard / test_session call `save_current({"challenge":
    # "pwn_1", ...})`, which used to write the operator's real `.aegis/`. A test
    # run during an experiment round silently reset that round's current.json,
    # discarding t0/hints/observations — so verifying the code destroyed the
    # data. The suite now runs against a throwaway dir.
    _state = tempfile.TemporaryDirectory(prefix="aegis-test-state-")
    os.environ["AEGIS_STATE_DIR"] = _state.name

    total = failed = 0
    have_alarm = hasattr(signal, "SIGALRM")
    if have_alarm:
        signal.signal(signal.SIGALRM, _alarm)
    for name in MODULES:
        path = HERE / name
        print(f"\n=== {name} ===")
        spec = importlib.util.spec_from_file_location(name[:-3], path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        fns = [v for k, v in sorted(vars(mod).items()) if k.startswith("test_") and callable(v)]
        for fn in fns:
            total += 1
            if have_alarm:
                signal.alarm(BUDGET_S)
            try:
                fn()
                print(f"  PASS  {fn.__name__}")
            except _Timeout:
                failed += 1
                print(f"  HANG  {fn.__name__}  (>{BUDGET_S}s — a wedged session?)")
            except AssertionError as exc:
                failed += 1
                print(f"  FAIL  {fn.__name__}\n        {exc}")
            except Exception as exc:
                failed += 1
                print(f"  ERROR {fn.__name__}: {type(exc).__name__}: {exc}")
            finally:
                if have_alarm:
                    signal.alarm(0)
    print(f"\n{'=' * 40}\n{total - failed}/{total} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
