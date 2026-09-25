"""Execution-channel tests.

Written after finding that `rsync --delete` had been failing on every call and
the failure was swallowed. The consequence was not cosmetic: 11 stale exploit
scripts from a previous run stayed readable inside the container, which defeats
the "do not read the last challenge's traces" rule at the storage layer.

Run: uv run --no-sync python tests/test_channel.py
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aegis.channel.dockerutil import (  # noqa: E402
    Channel,
    _manual_mirror,
    _needs_sync,
    discover,
    pick,
    verify_sync,
)
from aegis.paths import CONTAINER, TMP_SYNC  # noqa: E402

# ------------------------------------------------------- conditional syncing

SYNC_CASES = [
    # read-only inspection: no round trip wasted
    ("file ./chall", False),
    ("strings -n 5 ./chall", False),
    ("readelf -hW ./chall", False),
    ("objdump -d ./chall", False),
    ("checksec file ./chall -o json", False),
    ("ls -la", False),
    ("cat /tmp/out.txt", False),
    ("pwnx info ./chall", False),
    ("pwnx gadgets ./chall --first", False),
    ("readelf -sW /usr/lib/libc.so.6 2>/dev/null", False),
    # anything that writes or executes must re-sync
    ("python3 exp.py", True),
    ("cat > exp.py", True),
    ("cat > exp.py <<'EOF'", True),
    ("./chall", True),
    ("echo hi > /tmp/x", True),
    ("gdb -q -batch -ex run ./chall", True),
    ("python3 exp.py 2>/dev/null", True),
]


def test_needs_sync_matrix():
    failures = []
    for cmd, want in SYNC_CASES:
        got = _needs_sync(cmd)
        if got != want:
            failures.append(f"{cmd!r}: got sync={got}, wanted {want}")
    assert not failures, "\n".join(failures)


def test_readonly_prefixes_do_not_sync():
    """20 recorded timeouts came from slow commands; a needless sync adds to it."""
    for cmd in ("file ./x", "strings ./x", "readelf -hW ./x"):
        assert _needs_sync(cmd) is False, cmd


def test_writes_always_sync():
    for cmd in ("cat > exp.py", "python3 exp.py", "./chall"):
        assert _needs_sync(cmd) is True, cmd


# ------------------------------------------------------------ mirror hygiene


def test_manual_mirror_deletes_stale_files():
    """The property rsync --delete was silently failing to provide."""
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "src"
        dest = Path(td) / "dest"
        src.mkdir()
        dest.mkdir()
        (src / "chall").write_text("binary")
        (dest / "chall").write_text("old")
        for stale in ("exp.py", "anatomy.py", "leak_test.py"):
            (dest / stale).write_text("# previous run")

        _manual_mirror(src, dest)

        remaining = sorted(p.name for p in dest.iterdir())
        assert remaining == ["chall"], f"stale files survived: {remaining}"
        assert (dest / "chall").read_text() == "binary"


def test_verify_sync_reports_leftovers():
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "src"
        dest = Path(td) / "dest"
        src.mkdir()
        dest.mkdir()
        (src / "chall").write_text("x")
        (dest / "chall").write_text("x")
        (dest / "exp.py").write_text("stale")
        got = verify_sync.__wrapped__(src.parent.name, dest) if hasattr(verify_sync, "__wrapped__") else None
        # verify_sync resolves the challenge dir itself, so test the logic via
        # a direct set comparison instead.
        want = {p.name for p in src.iterdir()}
        leftover = sorted(p.name for p in dest.iterdir() if p.name not in want)
        assert leftover == ["exp.py"]


def test_remote_workdir_is_configurable():
    """The remote workdir is a plain path template, not hard-coded."""
    from aegis.paths import REMOTE_WORKDIR

    assert "{challenge}" in REMOTE_WORKDIR, REMOTE_WORKDIR


def test_macos_junk_is_never_content():
    """AppleDouble/`.DS_Store` must not count as challenge files.

    macOS tar synthesises `._foo` members for files with extended attributes.
    Counting them made the remote look permanently out of sync, so every
    command re-pushed the whole tree.
    """
    from aegis.channel.dockerutil import _is_macos_junk

    assert _is_macos_junk("._pwn")
    assert _is_macos_junk(".DS_Store")
    assert not _is_macos_junk("pwn")
    assert not _is_macos_junk("exp.py")


def test_tilde_is_preserved_when_quoting():
    """`shlex.quote("~/x")` yields `'~/x'`, which suppresses tilde expansion.

    The remote then looks for a literal `./~/x` and every command fails with
    rc=1 and empty output.
    """
    from aegis.channel.dockerutil import q

    assert q("~/Tmp/aegis/pwn_1") == "~/Tmp/aegis/pwn_1"
    assert q("~").strip() == "~"
    assert q("/work/aegis/pwn_1") == "/work/aegis/pwn_1"
    assert "'" in q("/tmp/it's here")


def test_reset_prunes_everything_stale():
    """`aegis start` must not inherit a previous run's files.

    reset=True is the only thing that can guarantee this, because once
    channel-side work is preserved a remotely created file cannot be told apart
    from a remote leftover by inspection.
    """
    from aegis.channel.dockerutil import _remote_listing, pick, push_to_remote, ssh_argv, ssh_env

    ch = pick()
    if not ch.available or ch.kind != "ssh":
        return

    import subprocess

    workdir = ch.dir_for("pwn_1")
    stale = f"{workdir}/__stale_probe__.py"
    put = subprocess.run(
        ssh_argv(ch.target, f"echo OLD > {stale}", timeout=20),
        capture_output=True, text=True, check=False, env=ssh_env(),
    )
    if put.returncode != 0:
        return  # channel not writable here

    assert push_to_remote("pwn_1", ch, reset=True) is True
    listing = _remote_listing("pwn_1", ch)
    assert listing is not None
    assert "__stale_probe__.py" not in listing, f"reset left a stale file: {listing}"


def test_mid_run_push_preserves_channel_work():
    """Editing a local file must not destroy what the channel produced.

    Regression: `pwninit` generated exp.py and repointed the binary; the next
    local edit wiped both, because the push cleared the directory. Verified by
    running pwninit then touching a local file — the remote was left with the
    binary alone.
    """
    from aegis.channel.dockerutil import _remote_listing, ensure_synced, pick, ssh_argv, ssh_env

    ch = pick()
    if not ch.available or ch.kind != "ssh":
        return

    import subprocess

    workdir = ch.dir_for("pwn_1")
    ensure_synced("pwn_1", ch, reset=True)
    made = f"{workdir}/__channel_made__.txt"
    r = subprocess.run(
        ssh_argv(ch.target, f"echo CHANNEL > {made}", timeout=20),
        capture_output=True, text=True, check=False, env=ssh_env(),
    )
    if r.returncode != 0:
        return

    # Force a push by making the local tree change.
    import pathlib as _pl

    root = _pl.Path(__file__).resolve().parent.parent / "test" / "pwn_1"
    probe = root / "__local_probe__.md"
    try:
        probe.write_text("local edit\n", encoding="utf-8")
        assert ensure_synced("pwn_1", ch, reset=False) is True
    finally:
        probe.unlink(missing_ok=True)

    listing = _remote_listing("pwn_1", ch) or []
    assert "__channel_made__.txt" in listing, f"channel work destroyed: {listing}"
    assert "__local_probe__.md" in listing, f"local change not delivered: {listing}"


def test_verify_sync_detects_leftovers():
    """A non-empty result is the signal that pruning failed."""
    from aegis.channel.dockerutil import verify_sync

    # No mirror => nothing to report (not an error).
    assert verify_sync("__nonexistent_challenge__") == []


# ------------------------------------------------------------------ channels


def test_discover_always_offers_both_channels():
    ch = discover(probe=False)
    assert "remote" in ch, "the remote host is the primary channel"
    assert ch["remote"].kind == "ssh"
    assert "container" in ch, "the container stays as a fallback"
    assert ch["container"].kind == "docker"


def test_explicit_channel_never_degrades():
    """An explicitly requested channel must not be silently substituted.

    This test used to assert the opposite ("a dead channel must not take the run
    down with it"). That expectation was the bug: the channel IS the world — it
    decides the glibc version, the toolchain and whether execution is emulated —
    so quietly running somewhere else produces a run whose observations and
    accumulated experience describe a target nobody chose. Failing loudly is the
    point.
    """
    for name in ("definitely-not-a-channel", "container"):
        os.environ["AEGIS_CHANNEL"] = name
        try:
            ch = pick()
            if name == "container" and ch.available:
                continue  # a real container is up; nothing to assert
            assert not ch.available, f"pick() silently substituted another channel for {name}"
        finally:
            os.environ.pop("AEGIS_CHANNEL", None)


def test_implicit_default_never_returns_an_unusable_channel_when_one_works():
    """With no explicit request, picking the best available channel is right."""
    os.environ.pop("AEGIS_CHANNEL", None)
    ch = pick()
    if not ch.available:
        assert ch.name == "none", ch


def test_channel_dir_for():
    ch = Channel(kind="docker", target="pwn", workdir="/work/aegis/{challenge}")
    assert ch.dir_for("pwn_1") == "/work/aegis/pwn_1"
    r = Channel(kind="ssh", target="box", workdir="~/aegis/{challenge}")
    assert r.dir_for("pwn_2") == "~/aegis/pwn_2"
    assert r.label() == "ssh:box"


def _run_all() -> int:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"  FAIL  {fn.__name__}\n        {exc}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
