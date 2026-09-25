from __future__ import annotations

import subprocess

from aegis.paths import ROOT, challenge_dir
from aegis.storage.store import append_issue


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def restore_challenge(name: str) -> None:
    """Put test/<name> back to the last committed snapshot and drop leftover files."""
    rel = f"test/{name}"
    path = challenge_dir(name)
    if not path.exists() and _git("ls-files", "--error-unmatch", rel).returncode != 0:
        append_issue("git", f"{rel} is not in git; cannot restore", challenge=name)
        return
    checkout = _git("checkout", "--", rel)
    if checkout.returncode != 0:
        append_issue("git", checkout.stderr.strip() or "git checkout failed", challenge=name)
    clean = _git("clean", "-fd", "--", rel)
    if clean.returncode != 0:
        append_issue("git", clean.stderr.strip() or "git clean failed", challenge=name)
