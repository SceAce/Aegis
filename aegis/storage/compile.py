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

from typing import Any

from aegis.memory import forget as memory_forget
from aegis.observer import pipeline
from aegis.paths import AEGIS_DIR
from aegis.storage.store import append_episode, load_episodes, now_iso

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
        "experience": {
            "rows": len(experience),
            "with_success": sum(1 for e in experience if e.n_ok > 0),
            "vetoable": sum(1 for e in experience if e.n_ok == 0 and e.condition and e.n_fail >= 2),
        },
        # Deliberately no cells/problems/habits: nothing here was generated from
        # prose, so there is nothing to sanitise.
        "sources": ["observer-event-stream"],
    }
