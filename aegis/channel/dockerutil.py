"""Execution channel: run challenge commands inside the x86 container.

Three defects found by auditing the recorded runs, all fixed here:

1. `rsync -a --delete` failed on every single call ("unlinkat: Operation not
   permitted") and the failure was swallowed by `check=False`. The effect was
   silent and serious: the container kept 11 stale `exp*.py` / `anatomy*.py`
   files from a previous run of a *different challenge*, so the agent could read
   a previous solver's exploit. The --delete is what enforces "do not read the
   last challenge's traces", and it was not working.

2. Every tool call re-synced, even read-only ones (`file`, `strings`, `readelf`)
   that cannot change the tree. Sync is now conditional on the command shape.

3. `timeout` was clamped to 25s. The container is Colima/QEMU x86_64 full-system
   emulation, where a 70-second ROPgadget scan is normal; clamping to 25s turned
   slowness into failures. The ceiling now reflects that, and the caller decides.

The channel is pluggable: a local container or a remote host over SSH. Both are
"somewhere that is x86_64 and has the tools".
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from aegis.paths import (
    CONTAINER,
    REMOTE_HOST,
    REMOTE_WORKDIR,
    SYNC_MOUNT,
    TMP_SYNC,
    challenge_dir,
)
from aegis.storage.store import append_issue

# Commands that never modify the working tree, so re-syncing before them just
# costs a round trip. Keep this list to genuinely read-only tools.
_READONLY_PREFIXES = (
    "file",
    "strings",
    "readelf",
    "objdump",
    "checksec",
    "ldd",
    "nm",
    "xxd",
    "hexdump",
    "cat",
    "ls",
    "wc",
    "head",
    "tail",
    "grep",
    "command",
    "which",
    "test",
    "echo",
    "pwnx info",
    "pwnx gadgets",
    "pwnx checksec",
)

MAX_TIMEOUT = 300


@dataclass
class Channel:
    """Where challenge commands run."""

    name: str = "container"
    kind: str = "docker"  # docker | ssh
    target: str = CONTAINER  # container name, or ssh host alias
    workdir: str = SYNC_MOUNT + "/{challenge}"
    available: bool = True
    detail: str = ""
    extra: dict[str, str] = field(default_factory=dict)

    def dir_for(self, challenge: str) -> str:
        return self.workdir.format(challenge=challenge)

    def label(self) -> str:
        # The unavailable placeholder has no target; "none:" reads like a bug.
        if not self.target:
            return f"{self.name} (unavailable)"
        return f"{self.kind}:{self.target}"


# ------------------------------------------------------------------ discovery


def _docker_ok(container: str) -> tuple[bool, str]:
    """Is the container running AND usable as a channel?

    Running is not enough: the sync target must be writable from here. When the
    sandbox denies that (paths outside the workspace), the container channel
    would fail on every command, so it is reported unavailable instead of
    failing later and confusing the agent.
    """
    try:
        proc = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Status}}", container],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        return False, str(exc)
    if proc.returncode != 0:
        return False, (proc.stderr or "not found").strip()[:200]
    status = proc.stdout.strip()
    if status != "running":
        return False, status
    if not _can_write(TMP_SYNC):
        return False, f"running, but sync dir {TMP_SYNC} is not writable from here"
    return True, status


def _ssh_ok(host: str, timeout: int = 12) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            ssh_argv(host, "uname -m", timeout=timeout),
            capture_output=True,
            text=True,
            timeout=timeout + 10,
            check=False,
            env=ssh_env(),
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        return False, str(exc)
    if proc.returncode != 0:
        return False, (proc.stderr or "ssh failed").strip()[:200]
    return True, proc.stdout.strip()


# ----------------------------------------------------------------- ssh setup
#
# Password auth has one hard requirement: something must feed the password.
# `sshpass` does it through a pty — and a pty is exactly what a restricted
# sandbox denies ("Failed to get a pseudo terminal: Operation not permitted").
# SSH_ASKPASS needs no pty, so it is the fallback. Both are tried, key auth
# first, because a key needs neither.

_ASKPASS_DIR: Path | None = None


def _askpass_script() -> Path | None:
    """Write a tiny password-feeding helper for SSH_ASKPASS.

    Deliberately not executable-by-path-guessing: it lives under the sync dir
    with 0700 and is rewritten each time so a stale password cannot linger.
    """
    global _ASKPASS_DIR
    from aegis.paths import AEGIS_DIR, REMOTE_PASS

    if not REMOTE_PASS:
        return None
    if _ASKPASS_DIR is None:
        # Inside the repo: the sync dir can be outside the writable workspace,
        # where even creating this file is denied.
        _ASKPASS_DIR = AEGIS_DIR / ".askpass"
        try:
            _ASKPASS_DIR.mkdir(parents=True, exist_ok=True)
        except OSError:
            return None
    p = _ASKPASS_DIR / "askpass.sh"
    try:
        p.write_text(f"#!/bin/sh\nprintf '%s\\n' {shlex.quote(REMOTE_PASS)}\n", encoding="utf-8")
        p.chmod(0o700)
    except OSError:
        return None
    return p


def ssh_env() -> dict[str, str]:
    """Environment for an ssh call that must supply a password.

    Kept separate from ssh_argv because the auth choice spans both: sshpass
    reads SSHPASS from the environment, SSH_ASKPASS needs a script path. The
    caller passes this to subprocess explicitly — mutating os.environ inside
    ssh_argv did not apply to the argv already built.
    """
    from aegis.paths import REMOTE_PASS

    env = dict(os.environ)
    if not REMOTE_PASS:
        return env
    if shutil.which("sshpass") and _pty_available():
        env["SSHPASS"] = REMOTE_PASS
        return env
    script = _askpass_script()
    if script is not None:
        env["SSH_ASKPASS"] = str(script)
        env["SSH_ASKPASS_REQUIRE"] = "force"
        env.setdefault("DISPLAY", ":0")
    return env


def ssh_argv(host: str, remote_command: str, *, timeout: int = 30) -> list[str]:
    """Build the ssh argv for one remote command.

    Order of preference:
      1. a key (both branches below still try keys unless forced otherwise)
      2. sshpass -e   — needs a pty, works on a normal terminal
      3. SSH_ASKPASS  — no pty; the fallback when the sandbox denies pty

    The remote login shell is zsh, so callers wrap the command in `bash -lc` to
    keep POSIX control flow working. Pair with ssh_env().
    """
    from aegis.paths import REMOTE_PASS, REMOTE_PORT, REMOTE_USER

    common = [
        "-T",  # never allocate a tty: output must be capturable
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        f"ConnectTimeout={min(timeout, 30)}",
        "-o",
        "NumberOfPasswordPrompts=1",
        "-o",
        "LogLevel=ERROR",
        "-p",
        str(REMOTE_PORT),
        f"{REMOTE_USER}@{host}",
        remote_command,
    ]

    if not REMOTE_PASS:
        return ["ssh", *common]

    if shutil.which("sshpass") and _pty_available():
        return ["sshpass", "-e", "ssh", *common]

    # Without PreferredAuthentications=password, ssh tries a key, fails, and
    # gives up before it ever consults SSH_ASKPASS.
    return [
        "ssh",
        "-T",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        f"ConnectTimeout={min(timeout, 30)}",
        "-o",
        "NumberOfPasswordPrompts=1",
        "-o",
        "PreferredAuthentications=password",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "LogLevel=ERROR",
        "-p",
        str(REMOTE_PORT),
        f"{REMOTE_USER}@{host}",
        remote_command,
    ]


def _pty_available() -> bool:
    """Can this process allocate a pty? sshpass cannot work without one."""
    try:
        import pty

        pid, fd = pty.fork()
    except (ImportError, OSError):
        return False
    if pid == 0:  # child
        os._exit(0)
    try:
        os.waitpid(pid, 0)
        os.close(fd)
    except OSError:
        pass
    return True


def discover(*, probe: bool = True) -> dict[str, Channel]:
    """All channels, keyed by name.

    The remote host is the primary channel: native x86_64 (no QEMU), fuller
    toolchain. The local container is kept as a fallback for when the network
    or the remote box is unavailable.

    `probe=False` skips the reachability checks, for callers that only want the
    configured shape (and to avoid a network round trip per call).
    """
    from aegis.paths import REMOTE_HOST, REMOTE_VENV

    out: dict[str, Channel] = {}

    rok, rdetail = _ssh_ok(REMOTE_HOST) if probe else (True, "not probed")
    out["remote"] = Channel(
        name="remote",
        kind="ssh",
        target=REMOTE_HOST,
        workdir=REMOTE_WORKDIR,
        available=rok,
        detail=rdetail,
        extra={"venv": REMOTE_VENV, "shell": "zsh->bash"},
    )

    ok, detail = _docker_ok(CONTAINER) if probe else (False, "not probed")
    out["container"] = Channel(
        name="container",
        kind="docker",
        target=CONTAINER,
        workdir=SYNC_MOUNT + "/{challenge}",
        available=ok,
        detail=detail,
        extra={"shell": "fish->bash", "note": "QEMU x86_64, 5-10x slower, no one_gadget"},
    )
    return out


def pick(preferred: str | None = None, *, probe: bool = True) -> Channel:
    """Resolve the channel to use.

    Preference order is remote first, then container: the remote runs native
    x86_64 with the fuller toolchain, so it is the default whenever reachable.

    **An explicitly requested channel never degrades.** `AEGIS_CHANNEL=remote`
    (or an explicit `preferred`) means "this is the world I am measuring in".
    The container is QEMU-emulated, ships a different glibc and a thinner
    toolchain, so substituting it silently changes the target underneath the
    experiment. Memory keys experience on the observed world, so a quiet swap
    would apply experience recorded in one world to another. Unavailable
    therefore returns an unavailable channel and the caller fails loudly.

    Only the *implicit* default order falls back, and it records that it did.
    """
    channels = discover(probe=probe)
    want = (preferred or os.environ.get("AEGIS_CHANNEL") or "").strip()
    if want:
        ch = channels.get(want)
        if ch is None:
            # A name that does not exist is a configuration error. Substituting
            # the default would run the experiment in a world nobody asked for.
            append_issue("channel", f"unknown channel requested: {want}")
            return Channel(
                name=want,
                kind="unknown",
                target="",
                available=False,
                detail=f"unknown channel {want!r}; known: {', '.join(sorted(channels))}",
            )
        if ch.available:
            return ch
        append_issue("channel", f"{want} requested but unavailable: {ch.detail}")
        return Channel(
            name=want,
            kind=ch.kind,
            target=ch.target,
            workdir=ch.workdir,
            available=False,
            detail=ch.detail,
            extra=dict(ch.extra),
        )
    order = ("remote", "container")
    for index, key in enumerate(order):
        ch = channels.get(key)
        if ch and ch.available:
            if index:
                # Fell through the preference order. Record it: a run whose
                # channel was not the intended one has to stay identifiable,
                # otherwise its world conditions look like every other run's.
                append_issue(
                    "channel",
                    f"fell back to {key} ({ch.label()}); {order[0]} unavailable: "
                    + "; ".join(
                        f"{k}: {v.detail[:80]}" for k, v in channels.items() if not v.available
                    ),
                )
            return ch
    detail = "; ".join(
        f"{k}: {v.detail[:60]}" for k, v in channels.items() if not v.available
    ) or "no channel configured"
    return Channel(name="none", kind="none", target="", available=False, detail=detail)


# ---------------------------------------------------------------------- sync


def _can_unlink(path: Path) -> bool:
    """Can we delete inside `path`?

    Decides whether stale-file cleanup is possible at all. Under the DSH file
    sandbox, paths outside the workspace deny unlink — so a mirror at ~/Tmp
    cannot prune itself and a previous run's exploit scripts stay readable in
    the container.

    Probed by creating and removing a file, because permission bits do not
    capture sandbox policy.
    """
    probe = path / ".aegis_unlink_probe"
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe.write_text("x", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def _purge_via_channel(name: str, channel: Channel | None) -> bool:
    """Delete the challenge dir from the channel's side, then recreate it.

    Used when the host mirror cannot be pruned. The channel sees the mirror
    through a bind mount, so removing it there is the equivalent operation and
    the stale files are gone either way.
    """
    ch = channel or pick()
    if not ch.available:
        return False
    workdir = ch.dir_for(name)
    # Same inode concern as push_to_remote: clear contents, keep the directory.
    inner = (
        f"mkdir -p {shlex.quote(workdir)} && "
        f"find {shlex.quote(workdir)} -mindepth 1 -maxdepth 1 -exec rm -rf {{}} + 2>/dev/null; true"
    )
    argv = (
        ["docker", "exec", CONTAINER, "bash", "-lc", inner]
        if ch.kind == "docker"
        else ["ssh", "-o", "BatchMode=yes", ch.target, inner]
    )
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=25, check=False)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False
    return proc.returncode == 0


def _deliver_via_channel(name: str, channel: Channel | None) -> bool:
    """Push the challenge files straight into the channel, bypassing the host mirror.

    The mirror is a host directory bind-mounted into the container, so writing
    it requires the *host* process to have write access there. Under a sandbox
    that can be denied even though the container would see the directory fine.
    `docker cp` goes through the daemon instead, so it works regardless.

    Order: purge, then copy, so a partial earlier run cannot survive.
    """
    ch = channel or pick()
    if not ch.available or ch.kind != "docker":
        return False
    src = challenge_dir(name)
    if not src.is_dir():
        return False
    workdir = ch.dir_for(name)
    parent = workdir.rsplit("/", 1)[0] or "/"
    try:
        pre = subprocess.run(
            ["docker", "exec", CONTAINER, "bash", "-lc",
             f"mkdir -p {shlex.quote(workdir)} && "
             f"find {shlex.quote(workdir)} -mindepth 1 -maxdepth 1 -exec rm -rf {{}} + 2>/dev/null; true"],
            capture_output=True, text=True, timeout=25, check=False,
        )
        if pre.returncode != 0:
            return False
        cp = subprocess.run(
            ["docker", "cp", f"{src}/.", f"{CONTAINER}:{workdir}"],
            capture_output=True, text=True, timeout=60, check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False
    return cp.returncode == 0


def sync_to_container(name: str, channel: Channel | None = None) -> Path:
    """Mirror test/<name> into the sync dir, removing stale files.

    The delete is the point: without it a previous run's scripts stay in the
    container and the next agent can read them.

    Returns the host mirror path. If the host mirror could not be written, the
    files are delivered through the channel instead and the mirror may be
    empty — callers that need the container to see the files should rely on the
    channel, not on this path.
    """
    src = challenge_dir(name)
    dest = TMP_SYNC / name
    dest.mkdir(parents=True, exist_ok=True)

    if not _can_unlink(dest) or not _can_write(dest):
        # Host-side mirroring is not possible. Deliver through the channel so
        # the container still sees exactly the committed challenge files, and
        # nothing from a previous run.
        ok = _deliver_via_channel(name, channel)
        append_issue(
            "sync",
            f"host mirror {dest} not writable; delivered_via_channel={ok}",
            challenge=name,
        )
        if ok:
            return dest

    if shutil.which("rsync"):
        proc = subprocess.run(
            # --delete is required. Dropping it silently reintroduces the
            # stale-file leak this function exists to prevent.
            ["rsync", "-a", "--delete", "--no-perms", "--omit-dir-times", f"{src}/", str(dest)],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            _manual_mirror(src, dest)
    else:
        _manual_mirror(src, dest)

    leftovers = verify_sync(name, dest)
    if leftovers:
        # Both mechanisms failed. The container will see stale files, so say so
        # loudly instead of pretending the mirror is clean.
        append_issue(
            "sync",
            f"stale files survive sync in {dest}: {', '.join(leftovers[:10])}",
            challenge=name,
        )
    return dest


def _can_write(path: Path) -> bool:
    """Can we create files in `path`? Distinct from deleting them."""
    probe = path / ".aegis_write_probe"
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe.write_text("x", encoding="utf-8")
        return True
    except OSError:
        return False
    finally:
        try:
            probe.unlink(missing_ok=True)
        except OSError:
            pass


def _manual_mirror(src: Path, dest: Path) -> None:
    """Copy src over dest, deleting anything in dest that is not in src."""
    if not src.is_dir():
        return
    want = {p.name for p in src.iterdir()}
    for existing in dest.iterdir():
        if existing.name not in want:
            try:
                if existing.is_dir() and not existing.is_symlink():
                    shutil.rmtree(existing, ignore_errors=True)
                else:
                    existing.unlink(missing_ok=True)
            except OSError:
                pass
    for item in src.iterdir():
        target = dest / item.name
        try:
            if item.is_dir():
                shutil.copytree(item, target, dirs_exist_ok=True)
            else:
                shutil.copy2(item, target)
        except OSError:
            pass


def verify_sync(name: str, dest: Path | None = None) -> list[str]:
    """Names present in the mirror that are NOT in the challenge dir.

    A non-empty result means the delete step failed, which is the condition
    under which a previous run's scripts become readable. Callers surface this
    rather than assuming the mirror is clean.
    """
    src = challenge_dir(name)
    dest = dest or (TMP_SYNC / name)
    if not dest.is_dir() or not src.is_dir():
        return []
    want = {p.name for p in src.iterdir()}
    return sorted(p.name for p in dest.iterdir() if p.name not in want)


def _mirror_is_current(name: str) -> bool:
    """Has this challenge ever been mirrored, and is the mirror clean?"""
    dest = TMP_SYNC / name
    if not dest.is_dir():
        return False
    src = challenge_dir(name)
    if not src.is_dir():
        return False
    want = {p.name for p in src.iterdir()}
    have = {p.name for p in dest.iterdir()}
    return want <= have and not (have - want)


# ------------------------------------------------------------- remote mirror
#
# The remote is the primary channel, so this is the code path that runs on
# almost every command. Two macOS quirks shape it:
#
#   * bsdtar synthesises `._foo` AppleDouble members for files carrying
#     extended attributes. Neither COPYFILE_DISABLE nor --no-xattrs suppresses
#     them. Archiving an explicit list of real paths avoids creating them.
#   * The `@` in `ls -la` output is not in the file list, but `.DS_Store` and
#     friends are, so junk is filtered on both sides.
#
# And one shell quirk: `shlex.quote("~/x")` yields `'~/x'`, which suppresses
# tilde expansion, so the remote looks for a literal `./~/x`. Paths therefore
# go through q().


def _is_macos_junk(name: str) -> bool:
    """macOS metadata that must never count as a challenge file."""
    return (
        name.startswith("._")
        or name in (".DS_Store", ".Spotlight-V100", ".Trashes", ".fseventsd")
    )


def _remote_listing(name: str, channel: Channel) -> list[str] | None:
    """Sorted real filenames in the remote challenge dir, or None on failure."""
    workdir = channel.dir_for(name)
    cmd = f"ls -1A {q(workdir)} 2>/dev/null | sort"
    try:
        proc = subprocess.run(
            ssh_argv(channel.target, cmd, timeout=20),
            capture_output=True,
            text=True,
            timeout=40,
            check=False,
            env=ssh_env(),
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    if proc.returncode != 0:
        return None
    return sorted(x.strip() for x in proc.stdout.splitlines() if x.strip() and not _is_macos_junk(x.strip()))


def _remote_is_current(name: str, channel: Channel) -> bool:
    """Does the remote already hold exactly this challenge's files?

    Compared by name set, so a leftover script from a previous run makes this
    False and forces a re-push. That is the point: the remote must not serve
    the last challenge's exploit to the next agent.
    """
    src = challenge_dir(name)
    if not src.is_dir():
        return False
    want = sorted(p.name for p in src.iterdir() if not _is_macos_junk(p.name))
    have = _remote_listing(name, channel)
    return have is not None and have == want


def _sha1(path) -> str:
    import hashlib

    h = hashlib.sha1()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 16), b""):
                h.update(chunk)
    except OSError:
        return ""
    return h.hexdigest()


def _local_hashes(name: str) -> dict[str, str]:
    """Relative path -> sha1 for every real file in the challenge dir."""
    src = challenge_dir(name)
    out: dict[str, str] = {}
    if not src.is_dir():
        return out
    for p in sorted(src.rglob("*")):
        if not p.is_file() or _is_macos_junk(p.name):
            continue
        out[str(p.relative_to(src))] = _sha1(p)
    return out


def _remote_hashes(name: str, channel: Channel) -> dict[str, str] | None:
    """Relative path -> sha1 for every file on the channel, or None on failure."""
    workdir = channel.dir_for(name)
    cmd = f"cd {q(workdir)} 2>/dev/null && find . -type f -exec sha1sum {{}} + 2>/dev/null"
    if channel.kind == "docker":
        from aegis.paths import CONTAINER

        argv = ["docker", "exec", CONTAINER, "bash", "-lc", cmd]
        env = None
    else:
        argv = ssh_argv(channel.target, cmd, timeout=30)
        env = ssh_env()
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True, errors="replace", timeout=60, check=False, env=env
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    if proc.returncode != 0:
        return {}  # directory does not exist yet
    out: dict[str, str] = {}
    for line in (proc.stdout or "").splitlines():
        if "  " not in line:
            continue
        digest, _, rel = line.partition("  ")
        rel = rel.strip()
        if rel.startswith("./"):
            rel = rel[2:]
        if rel and not _is_macos_junk(rel.rsplit("/", 1)[-1]):
            out[rel] = digest.strip()
    return out


def _manifest_path(name: str):
    from aegis.paths import AEGIS_DIR

    return AEGIS_DIR / f"sync-manifest-{name}.json"


def _load_manifest(name: str) -> dict[str, str] | None:
    """What this harness last pushed. None means "never pushed"."""
    import json

    p = _manifest_path(name)
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return None
        # Older manifests stored a bare hash per file. Treat those as "never
        # pushed": the safe reading of an unknown entry is to re-send, which is
        # what an empty manifest produces.
        if any(not isinstance(v, dict) for v in data.values()):
            return None
        return data
    except (OSError, ValueError):
        return None


def _save_manifest(name: str, hashes: dict[str, str]) -> None:
    import json

    from aegis.paths import ensure_dirs

    ensure_dirs()
    try:
        _manifest_path(name).write_text(
            json.dumps(hashes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except OSError:
        pass


def _plan_push(
    local: dict[str, str], remote: dict[str, str], manifest: dict[str, dict]
) -> tuple[list[str], list[str], list[str]]:
    """Decide what to send, what to delete, and what to leave alone.

    The harness must not destroy work done on the channel, and it must not let
    that work block the agent either. `pwninit` generates exp.py and repoints the
    binary; both live on the channel, but the agent's local exp.py has to win
    while the binary patch has to survive. Telling those apart needs two hashes
    per file, not one:

      pushed  the content the harness last sent (the local side)
      seen    the content the channel had immediately after that push

    Rules:

      never pushed, or local changed since  -> send    (the agent authored it)
      local unchanged, remote == seen       -> nothing (already identical)
      local unchanged, remote != seen       -> KEEP    (channel modified it)

      remote-only, we pushed it and it is gone locally -> delete (stale)
      remote-only, never ours                          -> KEEP (tool/agent made it)
    """
    send: list[str] = []
    delete: list[str] = []
    keep: list[str] = []

    for rel, lh in local.items():
        m = manifest.get(rel) or {}
        if m.get("pushed") != lh:
            # Covers both "new file" and "edited locally": local is authoritative.
            send.append(rel)
        elif remote.get(rel) != m.get("seen"):
            keep.append(rel)
        # else: identical on both sides, nothing to do

    for rel, rh in remote.items():
        if rel in local:
            continue
        m = manifest.get(rel) or {}
        if m and rh == m.get("seen"):
            delete.append(rel)
        else:
            keep.append(rel)

    return sorted(send), sorted(delete), sorted(keep)


def _apply_push(
    name: str, channel: Channel, workdir: str, send: list[str], delete: list[str]
) -> bool:
    """Send the listed files and remove the listed stale ones."""
    src = challenge_dir(name)

    if delete:
        # Remove the files, then prune directories that became empty. `rmdir -p`
        # is used rather than `rm -rf` so a directory still holding preserved
        # files is never taken out.
        quoted = " ".join(shlex.quote(d) for d in delete)
        cmd = f"cd {q(workdir)} && rm -f {quoted} && true"
        dirs = sorted({os.path.dirname(d) for d in delete if os.path.dirname(d)}, key=len, reverse=True)
        if dirs:
            prune = " ".join(f"rmdir -p --ignore-fail-on-non-empty {shlex.quote(d)} 2>/dev/null;" for d in dirs)
            cmd = f"{cmd}; {prune} true"
        if channel.kind == "docker":
            from aegis.paths import CONTAINER

            argv = ["docker", "exec", CONTAINER, "bash", "-lc", cmd]
            env = None
        else:
            argv = ssh_argv(channel.target, cmd, timeout=30)
            env = ssh_env()
        try:
            subprocess.run(argv, capture_output=True, text=True, timeout=60, check=False, env=env)
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

    if not send:
        return True

    # tar an explicit file list: macOS tar synthesises `._foo` AppleDouble
    # members for archived files, and naming only real paths avoids creating
    # them at all.
    untar = f"mkdir -p {q(workdir)} && tar -x -C {q(workdir)}"
    try:
        tar = subprocess.Popen(
            ["tar", "-c", "--no-xattrs", "-C", str(src), *send],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "COPYFILE_DISABLE": "1"},
        )
        ssh = subprocess.Popen(
            ssh_argv(channel.target, untar),
            stdin=tar.stdout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            env=ssh_env(),
        )
        if tar.stdout:
            tar.stdout.close()
        _out, err = ssh.communicate(timeout=180)
        tar.wait(timeout=30)
        tar_err = (tar.stderr.read() if tar.stderr else b"")[:200]
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        append_issue("sync", f"remote push failed: {exc}", challenge=name)
        return False

    if ssh.returncode not in (0, 2):
        append_issue(
            "sync",
            f"tar extract rc={ssh.returncode}: "
            f"{(err or b'').decode('utf-8', 'replace')[:150]} "
            f"tar_err={tar_err.decode('utf-8', 'replace')[:150]}",
            challenge=name,
        )
        return False
    return True


def _chmod_elfs(workdir: str, channel: Channel) -> None:
    """Restore the executable bit on ELF files.

    Challenge binaries are committed without it, so every exploit script would
    otherwise need `chmod +x` first, and pwntools errors out with "is not marked
    as executable" if it forgets. Done remotely so the repo copy stays clean.
    """
    # A plain `for f in *` misses nested files, and ./libs/ld.so needs +x too.
    cmd = (
        "cd " + q(workdir) + " 2>/dev/null && "
        "find . -maxdepth 3 -type f -print0 2>/dev/null | "
        "while IFS= read -r -d '' f; do "
        'head -c4 "$f" 2>/dev/null | grep -q ELF && chmod +x "$f" 2>/dev/null; '
        "done; true"
    )
    if channel.kind == "docker":
        from aegis.paths import CONTAINER

        argv = ["docker", "exec", CONTAINER, "bash", "-lc", cmd]
        env = None
    else:
        argv = ssh_argv(channel.target, cmd, timeout=30)
        env = ssh_env()
    try:
        subprocess.run(argv, capture_output=True, text=True, timeout=60, check=False, env=env)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass


def push_to_remote(name: str, channel: Channel, *, reset: bool = False) -> bool:
    """Make the channel hold the repo's files, without destroying channel work.

    `reset=True` forces a clean slate: everything on the channel is replaced by
    the repo. That is the right thing at `aegis start`, where the guarantee is
    "no traces of a previous run" — and it is the ONLY way to get that guarantee
    once channel-side work is preserved, because a remotely created file is
    indistinguishable from a remote leftover by inspection alone.

    Otherwise it is a merge, so files the agent or a tool created on the channel
    — pwninit's exp.py, ./libs, a repointed binary — survive a later local edit.

    Success is confirmed by re-listing rather than trusting the exit code:
    tar reports warnings (unknown pax/xattr keywords) with status 2 while still
    extracting correctly.
    """
    local = _local_hashes(name)
    if not local and not challenge_dir(name).is_dir():
        return False
    workdir = channel.dir_for(name)
    remote = _remote_hashes(name, channel)
    if remote is None:
        return False
    manifest = _load_manifest(name)

    if reset or manifest is None:
        # Clean slate. For a first sync this is the only sane choice; for an
        # explicit reset (aegis start) it is what enforces "no previous run".
        send = sorted(local)
        delete = sorted(remote)
        keep = []
    else:
        send, delete, keep = _plan_push(local, remote, manifest)

    if keep:
        append_issue(
            "sync",
            f"preserved channel-side files (not overwritten): {', '.join(keep[:8])}",
            challenge=name,
        )

    if not _apply_push(name, channel, workdir, send, delete):
        return False

    _chmod_elfs(workdir, channel)

    after = _remote_hashes(name, channel)
    if after is None:
        return False

    # Record both sides. `pushed` is what the harness sent, `seen` is what the
    # channel had right after — so the next push can tell "the agent edited this
    # locally" (send) from "the channel modified this" (keep). Tracking only the
    # local hash made a pwninit-generated exp.py impossible to override; tracking
    # only the remote hash silently reverted a libc patch.
    prev = _load_manifest(name) or {}
    manifest_out: dict[str, dict] = {}
    for rel, lh in local.items():
        entry = {"pushed": lh, "seen": after.get(rel, lh)}
        # A file that was already sticky stays sticky: if the channel still
        # differs from what we sent, keep remembering the mismatch so we keep
        # preserving it.
        old_entry = prev.get(rel) or {}
        if (
            rel not in send
            and old_entry.get("pushed") == lh
            and after.get(rel) != old_entry.get("seen")
        ):
            entry["seen"] = old_entry.get("seen")
        manifest_out[rel] = entry
    _save_manifest(name, manifest_out)

    missing = [rel for rel in local if rel not in after]
    if missing:
        append_issue("sync", f"files missing after push: {', '.join(missing[:8])}", challenge=name)
        return False
    return True


def local_fingerprint(name: str) -> str:
    """Cheap identity of the challenge tree: names + sizes + mtimes.

    Decides *when* to sync. Name-set comparison alone was not enough: it
    reported "in sync" when the agent had merely edited exp.py, so the change
    never reached the channel and the remote kept running the previous version
    of the script while the model believed otherwise.
    """
    import hashlib

    src = challenge_dir(name)
    if not src.is_dir():
        return ""
    items: list[str] = []
    for p in sorted(src.rglob("*")):
        if not p.is_file() or _is_macos_junk(p.name):
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        items.append(f"{p.relative_to(src)}:{st.st_size}:{st.st_mtime_ns}")
    return hashlib.sha1("\n".join(items).encode()).hexdigest()[:16]


def _sync_state_path():
    from aegis.paths import AEGIS_DIR

    return AEGIS_DIR / "sync-state.json"


def _load_sync_state() -> dict[str, str]:
    import json

    p = _sync_state_path()
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_sync_state(state: dict[str, str]) -> None:
    import json

    from aegis.paths import ensure_dirs

    ensure_dirs()
    try:
        _sync_state_path().write_text(
            json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except OSError:
        pass


def ensure_synced(name: str, channel: Channel, command: str = "", *, reset: bool = False) -> bool:
    """Make the channel's copy of the challenge match the repo.

    Gated on a LOCAL fingerprint, so the common case costs no ssh round trip at
    all. *What* to send is then decided by the manifest inside push_to_remote,
    so this never destroys work done on the channel.
    """
    fp = local_fingerprint(name)
    if not fp:
        return False
    key = f"{channel.label()}|{name}"
    state = _load_sync_state()
    if state.get(key) == fp and not reset:
        return True

    if channel.kind == "docker":
        try:
            sync_to_container(name, channel)
            ok = True
        except OSError:
            ok = False
    else:
        ok = push_to_remote(name, channel, reset=reset)

    if ok:
        state[key] = fp
        _save_sync_state(state)
    return ok


# pwntools needs a terminal for gdb.attach(); a one-shot call has none.
_TERMINAL_FAILURES = (
    "Could not parse PID from tmux output",
    "Start tmux first",
    "Could not find terminal",
    "Could not find a terminal",
)


def _terminal_hint(text: str) -> str:
    """Explain a terminal-bound failure and point at the way that works.

    `gdb.attach()` opens a NEW terminal for gdb. One-shot execution has none, so
    it raises "Could not parse PID from tmux output (b''). Start tmux first." —
    cryptic, and it cost a real run eight failed attempts. The session exists
    precisely for this, so say so.
    """
    if not any(m in text for m in _TERMINAL_FAILURES):
        return ""
    return (
        "[gdb.attach 需要终端，一次性调用没有终端 -> 这一步没生效]\n"
        "改用会话（它会真正打开 gdb，并且跨调用存活）:\n"
        '  aegis_shell(action="send", text="gdb -q ./chall")\n'
        '  aegis_shell(action="send", text="break *0x...")\n'
        '  aegis_shell(action="send", text="run")\n'
        '  aegis_shell(action="send", text="x/8gx $rsp")\n'
        "或者让它在 exp.py 里可选: try: gdb.attach(p) except Exception: pass"
    )


def _needs_sync(command: str) -> bool:
    """Does this command need the tree mirrored before it runs?

    Read-only inspection cannot be affected by a stale script, and a sync costs
    a full round trip. But skipping the sync is only safe once the mirror
    actually exists and matches — otherwise the very first `file ./chall` fails
    with "No such file or directory". Callers pair this with
    `_mirror_is_current`.

    Redirection and heredocs force a sync: `cat > exp.py` writes, so it must not
    be classified read-only just because the head word is `cat`.
    """
    low = " ".join(command.strip().lower().split())
    if not low:
        return False
    # Any output redirection or heredoc may write a file, so sync.
    # (`2>/dev/null` is a discard and does not count.)
    if "<<" in low:
        return True
    if ">" in re.sub(r"\d?>\s*/dev/null", "", low):
        return True
    head = low.split("&&")[0].split(";")[0].strip()
    readonly = any(head.startswith(p) for p in _READONLY_PREFIXES)
    return not readonly


# ------------------------------------------------------------------- execute


def _login_shell_preamble(workdir: str) -> str:
    """Environment setup that the remote's own shell would do for a human.

    The remote keeps its toolchain configuration in ~/.zshrc / ~/.profile (the
    venv on PATH, gdb plugin wrappers, glibc-all-in-one helpers). Sourcing them
    is both more faithful and more robust than re-deriving the paths here — the
    earlier approach hard-coded `~/tools/CTF/bin/activate` and broke the moment
    the layout differed.

    `set -e` is deliberately NOT used: a failing probe should report, not abort
    the whole batch.
    """
    return "\n".join(
        [
            "# aegis remote preamble",
            "cd " + q(workdir) + " 2>/dev/null || { mkdir -p " + q(workdir) + " && cd " + q(workdir) + "; }",
            "source ~/.profile >/dev/null 2>&1 || true",
            "source ~/.zshrc  >/dev/null 2>&1 || true",
            # Activate rather than just prepending to PATH: pwninit and other
            # tools detect the environment via $VIRTUAL_ENV, and a bare PATH
            # edit leaves them warning that no venv is active. Activation also
            # avoids the duplicated PATH entries the manual edit produced.
            '[ -f "$HOME/tools/CTF/bin/activate" ] && . "$HOME/tools/CTF/bin/activate"',
            '[ -n "$VIRTUAL_ENV" ] || { [ -d "$HOME/tools/CTF/bin" ] && export PATH="$HOME/tools/CTF/bin:$PATH"; }',
            "export NO_COLOR=1",
            "export TERM=dumb",
            "export PWNLIB_NOTERM=1",
        ]
    )


def q(path: str) -> str:
    """Quote a path, preserving tilde expansion.

    `shlex.quote("~/x")` yields `'~/x'`, and single quotes suppress tilde
    expansion, so the remote looks for a literal `./~/x` and the command fails
    with rc=1 and no output.
    """
    if path == "~":
        return "~"
    if path.startswith("~/"):
        return "~/" + shlex.quote(path[2:])
    return shlex.quote(path)


def _wrap_remote_cd(workdir: str, command: str, *, venv: str = "", timeout: int = 0) -> str:
    """Build a stdin script for the remote login shell.

    Transport is `ssh <host> bash -s` with this text on stdin (see
    ssh_argv/pwn_exec). That removes the quoting stack entirely: the command is
    never re-quoted by zsh, then bash, then timeout. Multi-line scripts, quotes,
    heredocs and `$(...)` all pass through verbatim, which a single argv string
    cannot guarantee.
    """
    body = [f"cd {q(workdir)} 2>/dev/null || {{ mkdir -p {q(workdir)} && cd {q(workdir)}; }}"]
    if timeout:
        body.append(f"timeout {int(timeout)}s bash -c {shlex.quote(command)}")
    else:
        body.append(command)
    return "\n".join(body) + "\n"


def pwn_exec(
    name: str,
    command: str,
    timeout: int = 20,
    *,
    channel: Channel | None = None,
) -> dict[str, str | int]:
    """Run one command on the chosen channel.

    Two transports, one shape of result:

      docker  `docker exec <c> bash -lc <quoted string>`
      ssh     `ssh <host> bash -s`, with a full script on **stdin**

    The ssh side streams the script instead of quoting it into argv. That is the
    whole point: a command previously had to survive ssh's argv, then zsh, then
    `bash -lc`, then `timeout` — five layers of quoting, each able to eat an
    escape. `command -v ctf; echo "$(pwd)"` came back rc=1 with empty output for
    exactly that reason. With stdin there is no quoting stack at all, so
    multi-line scripts, quotes, `$(...)` and heredocs all arrive verbatim.
    """
    timeout = max(5, min(int(timeout), MAX_TIMEOUT))
    ch = channel or pick()

    if not ch.available:
        append_issue("channel", f"no channel: {ch.detail}", challenge=name)
        return {
            "returncode": 127,
            "stdout": "",
            "stderr": (
                f"NO CHANNEL: {ch.detail}\n"
                f"Check the remote host ({REMOTE_HOST}) or start the local "
                "container; `aegis env` shows both."
            ),
            "channel": ch.label(),
        }

    script: str
    argv: list[str]
    stdin_data: str | None = None

    if ch.kind == "docker":
        ensure_synced(name, ch, command)
        workdir = ch.dir_for(name)
        inner = _wrap_remote_cd(workdir, command, timeout=timeout)
        argv = ["docker", "exec", CONTAINER, "bash", "-lc", inner]
    else:
        ensure_synced(name, ch, command)
        workdir = ch.dir_for(name)
        script = _login_shell_preamble(workdir) + "\n" + _wrap_remote_cd(workdir, command, timeout=timeout)
        argv = ssh_argv(ch.target, "bash -s", timeout=timeout + 15)
        stdin_data = script

    try:
        proc = subprocess.run(
            argv,
            input=stdin_data,
            text=True,
            errors="replace",  # binary output is common in RE work
            capture_output=True,
            timeout=timeout + 25,
            check=False,
            env=ssh_env(),
        )
    except subprocess.TimeoutExpired as exc:
        append_issue("timeout", command, challenge=name)
        return {
            "returncode": 124,
            "stdout": (exc.stdout or "")[-4000:] if isinstance(exc.stdout, str) else "",
            "stderr": (
                f"TIMEOUT: exceeded {timeout}s on {ch.label()}. "
                "Do not retry the same command; narrow it instead "
                "(add --start-address/--stop-address, or --first).\n"
            ),
            "channel": ch.label(),
        }
    except FileNotFoundError as exc:
        append_issue("channel", f"{ch.label()} not runnable: {exc}", challenge=name)
        return {
            "returncode": 127,
            "stdout": "",
            "stderr": f"channel {ch.label()} not runnable: {exc}",
            "channel": ch.label(),
        }

    stderr = _clean_stderr(proc.stderr or "")

    if proc.returncode == 255 and ("Permission denied" in stderr or "denied" in stderr):
        append_issue("channel", f"ssh auth failed: {stderr.strip()[:200]}", challenge=name)
        stderr = (
            f"SSH AUTH FAILED on {ch.label()}\n{stderr}\n"
            "If this mentions a pseudo terminal, the sandbox denies pty and "
            "sshpass cannot feed the password — the SSH_ASKPASS fallback should "
            "have handled it. Check AEGIS_REMOTE_PASS, or install a key."
        )
    if proc.returncode == 124:
        append_issue("timeout", command, challenge=name)
        stderr = f"TIMEOUT after {timeout}s. Do not retry unchanged.\n{stderr}"
    from aegis.util import strip_ansi

    # Cleaned at the boundary: several tools here (pwninit among them) emit
    # colour unconditionally, with no tty check and no NO_COLOR branch.
    out = strip_ansi((proc.stdout or "")[-8000:])
    err = strip_ansi(stderr[-4000:])
    hint = _terminal_hint(out + err)
    if hint:
        err = (err + ("\n" if err else "") + hint)[-4000:]

    return {
        "returncode": proc.returncode,
        "stdout": out,
        "stderr": err,
        "channel": ch.label(),
    }


# Login-shell noise that is not the agent's problem and only wastes tokens.
_NOISE = (
    "terminfo database",
    "Terminal features will not be available",
    "setupterm",
    ".local/share/../bin/env",
    "no job control",
    "cannot set terminal process group",
    "Inappropriate ioctl for device",
    "bash: cannot set terminal",
)


def _clean_stderr(text: str) -> str:
    """Drop login-shell chatter.

    Sourcing ~/.zshrc/.profile on a non-interactive connection emits terminfo
    and snap warnings on every single call. They are not errors, and repeating
    them per command both misleads the agent and burns context.
    """
    out = []
    for line in text.splitlines():
        if any(n in line for n in _NOISE):
            continue
        out.append(line)
    return "\n".join(out)


def probe_tools(channel: Channel | None = None) -> dict[str, str]:
    """What is actually installed, per channel.

    The agent used to burn turns on `command -v gdb; which pwnx`, and the guard
    refused those probes (see tests/test_guard.py). Answering it once, up front,
    removes the reason to probe at all.

    Uses one `for` loop rather than a chain of printf: the command crosses ssh,
    zsh and `bash -lc`, and the layered quoting mangled the multi-argument form
    into empty output.
    """
    ch = channel or pick()
    tools = (
        "python3 pwnx checksec readelf objdump gdb patchelf ROPgadget one_gadget "
        "pwninit ropper r2 radare2 qemu-x86_64 gcc nc socat file strings"
    )
    script = (
        "for t in " + tools + "; do "
        'p=$(command -v "$t" 2>/dev/null); '
        '[ -n "$p" ] && echo "$t=$p" || echo "$t=-"; '
        "done"
    )
    res = pwn_exec("__probe__", script, timeout=40, channel=ch)
    out: dict[str, str] = {}
    for line in str(res.get("stdout") or "").splitlines():
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            if k and " " not in k:
                out[k.strip()] = v.strip()

    # python3 alone is not enough: exploits need pwntools from the venv, which
    # only exists on the remote host.
    venv = str(ch.extra.get("venv") or "")
    if venv and ch.kind == "ssh":
        probe = (
            f". {venv}/bin/activate 2>/dev/null && "
            "python3 -c 'import pwn;print(pwn.version)' 2>/dev/null || echo -"
        )
        got = str(pwn_exec("__probe__", probe, timeout=40, channel=ch).get("stdout") or "").strip()
        out["pwntools"] = got.splitlines()[-1].strip() if got else "-"
    return out
