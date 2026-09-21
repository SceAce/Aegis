from __future__ import annotations

from aegis.paths import infer_kind
from aegis.store import append_episode, upsert_cell, upsert_search_rule


def compile_run(
    *,
    challenge: str,
    status: str,
    chain: str,
    stuck: str,
    elapsed_s: float,
) -> None:
    """Demo compiler: one cell + optional skip/focus from stuck notes. Not the full atlas algebra."""
    kind = infer_kind(challenge)
    state = "on" if status == "solved" else "off"
    append_episode(
        challenge=challenge,
        kind="verdict",
        status=status,
        chain=chain,
        stuck=stuck,
        elapsed_s=elapsed_s,
        condition=f"kind={kind}",
    )
    if chain.strip():
        upsert_cell(
            technique=chain.strip(),
            condition=f"kind={kind}",
            state=state,
            source=challenge,
        )
    if stuck.strip():
        upsert_search_rule(
            when=kind,
            action="focus",
            target=stuck.strip()[:200],
            source=challenge,
        )
    if status != "solved" and elapsed_s >= 600:
        upsert_search_rule(
            when=kind,
            action="skip",
            target="full-binary-bruteforce-before-strings",
            source=challenge,
        )
