from __future__ import annotations

import shutil
import subprocess

from aegis.paths import CONTAINER, TMP_SYNC, challenge_dir
from aegis.store import append_issue


def sync_to_container(name: str) -> Path:
    src = challenge_dir(name)
    dest = TMP_SYNC / name
    dest.mkdir(parents=True, exist_ok=True)
    if shutil.which("rsync"):
        subprocess.run(
            ["rsync", "-a", "--delete", f"{src}/", str(dest)],
            check=False,
        )
    else:
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(src, dest)
    return dest


def container_work(name: str) -> str:
    return f"/work/aegis/{name}"


def pwn_exec(name: str, command: str, timeout: int = 20) -> dict[str, str | int]:
    sync_to_container(name)
    inner = f"cd {container_work(name)} && {command}"
    proc = subprocess.run(
        ["docker", "exec", CONTAINER, "bash", "-lc", inner],
        text=True,
        capture_output=True,
        timeout=timeout + 5,
        check=False,
    )
    if proc.returncode != 0 and "Cannot connect" in (proc.stderr or ""):
        append_issue("docker", proc.stderr.strip(), challenge=name)
    return {
        "returncode": proc.returncode,
        "stdout": proc.stdout[-8000:],
        "stderr": proc.stderr[-4000:],
    }
