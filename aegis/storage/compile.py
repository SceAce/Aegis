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

    return _fold(challenge=challenge, status=status, verified=verified)


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


def _fold(*, challenge: str, status: str, verified: str) -> dict[str, Any]:
    # Audit the scripts BEFORE folding them in. A conclusive finding means the
    # run did not demonstrate what it claims, so its records must not be able to
    # count as successes — and that has to be decided here, at the point where
    # the evidence tier is chosen, not left to a later reader.
    archive = archive_scripts(challenge)
    audit_findings = _audit(challenge, archive)
    if any(f.conclusive for f in audit_findings) and verified != "none":
        append_issue(
            "solve_audit",
            f"verified downgraded from {verified!r} to 'none': "
            + "; ".join(f.line() for f in audit_findings if f.conclusive),
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


def archive_scripts(challenge: str, *, stamp: str | None = None) -> Path:
    """Copy the run's scripts out of `test/<ch>` before restore wipes them.

    `cmd_finish` ends with `restore_challenge`, which runs `git clean -fd` so the
    NEXT run cannot read the previous solution. That is right, but it also
    destroys the only evidence of what this run actually executed — and with it
    any chance to audit or re-read the exploit.

    The copy lands under `.aegis/artifacts/`, which is blocked from the agent
    exactly like the rest of `.aegis`: the evidence is preserved without leaking.
    """
    import shutil

    from aegis.paths import AEGIS_DIR, challenge_dir

    source = challenge_dir(challenge)
    stamp = stamp or now_iso().replace(":", "").replace("-", "").replace("+", "p")[:15]
    dest = AEGIS_DIR / "artifacts" / f"{stamp}_{challenge}"
    dest.mkdir(parents=True, exist_ok=True)
    copied = 0
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
                copied += 1
            except OSError:
                continue
    (dest / "MANIFEST.txt").write_text(
        f"challenge: {challenge}\narchived: {now_iso()}\nfiles: {copied}\n",
        encoding="utf-8",
    )
    return dest


def _marker_for(challenge: str) -> str:
    """The proof marker declared on the blackboard, if any."""
    from aegis.blackboard import store as board_store

    try:
        board = board_store.load(AEGIS_DIR)
    except Exception:
        return ""
    for requirement in board.requirements:
        if requirement.marker:
            return requirement.marker
    return ""
