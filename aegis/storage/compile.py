"""Compile a run into memory and experience. **Mechanical: no LLM.**

The previous version asked a model to re-extract structure from write-up prose.
That was the source of the false positives the audit measured, and it directly
contradicted the rule this project settled on: memory is extracted by the
Observer, not written by a model. `README.md` already said the quiet part out
loud — asking an LLM to generate structure and then throwing that structure away
with a regex at runtime is the biggest waste in the old design.

Compiling is now arithmetic:

    event stream --Observer--> memory records --count--> experience

Nothing is generated, so nothing can be invented. A run that produced no events
produces no experience and says so, rather than producing plausible-looking
cells.

Evidence discipline lives in `pipeline.sync(evidence=...)`: a run downgraded to
`none` (for example one that solved by weakening a mitigation) still lands in
memory — auditable — but cannot count as a success.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from aegis.core.criterion import STRONG_EXEC_MARKER
from aegis.memory import forget as memory_forget
from aegis.observer import pipeline
from aegis.paths import AEGIS_DIR
from aegis.storage.store import append_episode, append_issue, load_episodes, now_iso

VERIFY_LEVELS = ("flag", "local", "none", "wiki")


def compile_run(
    *,
    challenge: str,
    status: str,
    chain: str,
    stuck: str,
    elapsed_s: float,
    extra: str = "",
    verified: str = "local",
    since: str | None = None,
) -> dict[str, Any]:
    """Record the verdict, then fold this run's events into memory + experience."""
    verified = verified if verified in VERIFY_LEVELS else "none"

    # The verdict is what the run *claims*. It is recorded verbatim as a claim:
    # whether it held is decided against the blackboard's requirement/stage task,
    # not by this string. Keeping the claim is useful — a claim that keeps being
    # wrong is itself a signal — but nothing downstream treats it as authority.
    append_episode(
        challenge=challenge,
        kind="verdict",
        status=status,
        chain=chain,
        stuck=stuck,
        elapsed_s=elapsed_s,
        verified=verified,
        condition=f"verified={verified}",
    )

    # The criterion is evaluated against the run that just ended, so the weak
    # branch can be corroborated before the tier is fixed.
    return _fold(
        challenge=challenge,
        status=status,
        verified=verified,
        run_session=pipeline.current_session(AEGIS_DIR),
    )


def compile_from_store(challenge: str, verified: str = "local") -> dict[str, Any]:
    """Re-fold a challenge that already finished. Idempotent: `sync` de-dupes."""
    verdict: dict[str, Any] = {}
    for row in load_episodes(challenge):
        if row.get("kind") == "verdict":
            verdict = row
    seen = str(verdict.get("verified") or verified)
    return _fold(
        challenge=challenge,
        status=str(verdict.get("status") or "unknown"),
        verified=seen if seen in VERIFY_LEVELS else "none",
    )


def _fold(
    *, challenge: str, status: str, verified: str, run_session: str | None = None
) -> dict[str, Any]:
    # Audit the scripts BEFORE folding them in. A conclusive finding means the
    # run did not demonstrate what it claims, so its records must not be able to
    # count as successes — and that has to be decided here, at the point where
    # the evidence tier is chosen, not left to a later reader.
    archive = archive_scripts(challenge)
    audit_findings = _audit(challenge, Path(archive["path"]))
    if any(f.conclusive for f in audit_findings) and verified != "none":
        append_issue(
            "solve_audit",
            f"verified downgraded from {verified!r} to 'none': "
            + "; ".join(f.line() for f in audit_findings if f.conclusive),
            challenge=challenge,
        )
        verified = "none"

    # The weak criterion branch ("the target process is gone") is not proof on its
    # own: an agent that never ran the target also has no target process alive. It
    # is only credible when the archived scripts actually contain an exploit — so
    # the audit gate below is what makes relaxing the standard safe. Kept here, at
    # the point the evidence tier is chosen, for the same reason as the audit.
    branch = _execution_branch(challenge, run_session)
    if branch == "weak" and verified != "none":
        if not _corroborated(challenge, Path(archive["path"])):
            append_issue(
                "solve_audit",
                "verified downgraded to 'none': the run satisfied only the weak "
                "criterion branch (target process gone), and the archived scripts "
                "do not show an exploit reaching the target",
                challenge=challenge,
            )
            verified = "none"

    report = pipeline.sync(AEGIS_DIR, evidence=verified, reason=f"{challenge}/{status}")
    forgotten = memory_forget.run(AEGIS_DIR)
    experience = pipeline.experience(AEGIS_DIR)

    return {
        "challenge": challenge,
        "status": status,
        "verified": verified,
        "compiled_at": now_iso(),
        "memory": report,
        "forgotten": forgotten,
        "criterion_branch": branch,
        "archive": {k: v for k, v in archive.items() if k != "path"},
        "audit": [
            {"rule": f.rule, "detail": f.detail, "where": f.where, "conclusive": f.conclusive}
            for f in audit_findings
        ],
        "experience": {
            "rows": len(experience),
            "with_success": sum(1 for e in experience if e.n_ok > 0),
            "vetoable": sum(1 for e in experience if e.n_ok == 0 and e.condition and e.n_fail >= 2),
        },
        # Deliberately no cells/problems/habits: nothing here was generated from
        # prose, so there is nothing to sanitise.
        "sources": ["observer-event-stream"],
    }


def _execution_branch(challenge: str, session: str | None) -> str:
    """Which criterion branch this run reached, from its own event stream."""
    if not session:
        return ""
    from aegis.core.criterion import Criterion, execution_branch
    from aegis.observer.native import read_native_events

    need, next_marker = _markers_for(challenge)
    criterion = Criterion(need=need, next=next_marker)
    events = [e for e in read_native_events(AEGIS_DIR) if e.session == session]
    found = execution_branch(events, criterion)
    return str(found["branch"]) if found else ""


#: Tokens a **worked** exploit has and the pwninit scaffold does not. The scaffold
#: is not empty — it already writes `binary = "pwn"`, `ELF(binary)`, `process(binary)`
#: and a pile of send/recv lambdas — so "the script mentions the target" is true of
#: a file the agent never touched. That is a false positive in the one gate that
#: makes the weak criterion safe, so the gate also requires a token that only
#: appears once someone actually builds a payload.
_EXPLOIT_TOKENS = (
    "p64(",
    "flat(",
    "ROP(",
    "one_gadget",
    "system(",
    "execve",
    "tcache",
    "__free_hook",
    "__malloc_hook",
)


def _corroborated(challenge: str, directory: Path) -> bool:
    """Do the archived scripts show an exploit that **reaches** the target?

    Mechanical and deliberately conservative, because this is what makes the weak
    criterion branch (`TARGET_GONE=yes`) safe: the weak branch is satisfied by a
    run that never touched the target, so something has to show the target was
    actually driven.

    Two requirements, and the second is the one that matters:

      1. the target's name appears, and
      2. the file carries a token the untouched scaffold does not.

    It does **not** judge whether the exploit is correct — that is what the audit
    rules are for. It separates "there is a script that drives the target" from
    "there is a file, possibly the template `aegis start` left behind".
    """
    from aegis.paths import challenge_dir

    target = ""
    try:
        from aegis.policy.audit import detect_target

        target = detect_target(challenge_dir(challenge)) or ""
    except Exception:
        target = ""
    name = Path(target).name or challenge.rsplit("_", 1)[0]
    if not name:
        return False
    for path in sorted(directory.glob("**/*")):
        if not path.is_file():
            continue
        if path.name == "MANIFEST.txt":
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if len(text.strip()) < 40:
            continue
        names_target = (
            f"./{name}" in text
            or f"/{name}" in text
            or f"'{name}'" in text
            or f'"{name}"' in text
        )
        if names_target and any(token in text for token in _EXPLOIT_TOKENS):
            return True
    return False


def _audit(challenge: str, directory: Path) -> list:
    """Static audit of the scripts this run left behind. Never fatal.

    Audits the archived copy: `cmd_finish` wipes `test/<ch>` right after this, so
    the archive is what survives and what a later `aegis audit` will read.
    """
    from aegis.paths import challenge_dir
    from aegis.policy import audit

    try:
        target = audit.detect_target(challenge_dir(challenge))
        findings = audit.audit_challenge(directory, marker=_marker_for(challenge), target=target)
    except Exception:
        # An audit that breaks must not take the run down; it degrades to "no
        # audit", which is the same state as before it existed.
        return []
    for finding in findings:
        append_issue("solve_audit", finding.line(), challenge=challenge)
    return findings


def archive_scripts(challenge: str, *, stamp: str | None = None) -> dict[str, Any]:
    """Copy the run's scripts out of the **execution host** before restore wipes them.

    `cmd_finish` ends with `restore_challenge`, which runs `git clean -fd` so the
    NEXT run cannot read the previous solution. That is right, but it also
    destroys the only evidence of what this run actually executed — and with it
    any chance to audit or re-read the exploit.

    Copying only `test/<ch>` was not enough, and that was not visible until a run
    that never wrote locally: a pwn_3 run made 82 `aegis_pwn` + 27 `aegis_shell`
    calls and **zero** local writes, so the archive came out `files: 0` and the
    audit inspected nothing. An empty archive and an unreadable host must not look
    the same — the first is evidence, the second is the absence of it — so the
    report carries `readable` separately.

    Returns a report; `path` is the directory (`_audit` reads it).
    """
    import shutil

    from aegis.channel import dockerutil
    from aegis.paths import AEGIS_DIR, challenge_dir

    source = challenge_dir(challenge)
    stamp = stamp or now_iso().replace(":", "").replace("-", "").replace("+", "p")[:15]
    dest = AEGIS_DIR / "artifacts" / f"{stamp}_{challenge}"
    dest.mkdir(parents=True, exist_ok=True)

    local = 0
    if source.is_dir():
        for path in sorted(source.iterdir()):
            if not path.is_file():
                continue
            # Skip the challenge binary itself: it is already in git, and copying
            # it would bloat the archive for no gain.
            try:
                with path.open("rb") as handle:
                    if handle.read(4) == b"\x7fELF":
                        continue
            except OSError:
                continue
            try:
                shutil.copy2(path, dest / path.name)
                local += 1
            except OSError:
                continue

    try:
        remote = dockerutil.fetch_artifacts(challenge, dest)
    except Exception as exc:  # a broken pull must not take the run down
        remote = {"readable": False, "copied": 0, "source": "?", "detail": f"{type(exc).__name__}: {exc}"}

    files = sorted(p.name for p in dest.iterdir() if p.is_file() and p.name != "MANIFEST.txt")
    report = {
        "path": str(dest),
        "files": len(files),
        "local": local,
        "readable": bool(remote.get("readable")),
        "source": str(remote.get("source") or ""),
        "detail": str(remote.get("detail") or ""),
        "truncated": list(remote.get("truncated") or []),
    }
    (dest / "MANIFEST.txt").write_text(
        f"challenge: {challenge}\n"
        f"archived: {now_iso()}\n"
        f"files: {len(files)}\n"
        f"local_copies: {local}\n"
        f"exec_host: {report['source']}\n"
        f"host_readable: {report['readable']}\n"
        f"detail: {report['detail']}\n"
        f"names: {', '.join(files) or '(none)'}\n",
        encoding="utf-8",
    )
    if not report["readable"]:
        append_issue(
            "evidence_archive",
            f"could not read the execution host ({report['source']}: {report['detail']}); "
            f"the script audit has {len(files)} local file(s) only",
            challenge=challenge,
        )
    for name in report["truncated"]:
        append_issue(
            "evidence_archive",
            f"{name} exceeded the pull cap and was archived truncated; "
            "an audit of a truncated script is not conclusive",
            challenge=challenge,
        )
    return report


def _marker_for(challenge: str) -> str:
    """The proof marker declared on the blackboard, if any."""
    return _markers_for(challenge)[0]


def _markers_for(challenge: str) -> tuple[str, str]:
    """(user requirement marker, next-stage marker) as declared on the blackboard.

    The standard is authored **outside** the producer, so both come from the board
    when present. The `next` marker falls back to the protocol constant the manual
    prints, because nothing declares a stage task for the single-worker demo runs
    and an empty marker would silently accept any `PWNED_MARKER` line.
    """
    from aegis.blackboard import store as board_store

    need = ""
    next_marker = STRONG_EXEC_MARKER
    try:
        board = board_store.load(AEGIS_DIR)
    except Exception:
        return need, next_marker
    for requirement in board.requirements:
        if requirement.marker:
            need = requirement.marker
            break
    for task in board.tasks:
        if task.marker:
            next_marker = task.marker
            break
    return need, next_marker
