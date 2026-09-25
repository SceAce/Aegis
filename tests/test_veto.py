"""Learned vetoes: experience promoted to a tool-layer refusal.

The bar is deliberately high. `guard.py`'s own header says a false refusal costs
more than a missed one, because it hides the information the run was probing for
and the agent then burns turns re-probing. So these tests are mostly about what
must NOT be refused.
"""

from __future__ import annotations

from aegis.observer.extract import Experience
from aegis.policy import veto
from aegis.policy.guard import refuse_reason


def test_command_word_is_extracted_only_when_safe() -> None:
    assert veto.command_word("pwn: ROPgadget --binary ./pwn") == "ROPgadget"
    assert veto.command_word("bash: r2 ./pwn") is None  # too short
    # Shell plumbing: refusing any of these stops the run, not a technique.
    assert veto.command_word("pwn: cd <path> && timeout <n> python3 exp.py") is None
    assert veto.command_word("pwn: <addr> nonsense") is None
    assert veto.command_word("write: <path>/<challenge>/exp.py") is None


def test_veto_needs_failures_without_success_and_a_real_world() -> None:
    world = {"glibc2.27"}
    ok = Experience(condition=("glibc2.27",), action="pwn: ROPgadget --binary ./pwn", n_ok=0, n_fail=3)
    assert [v.pattern for v in veto.build([ok], world)] == ["ROPgadget"]

    has_success = Experience(condition=("glibc2.27",), action="pwn: ropper --file ./pwn", n_ok=1, n_fail=9)
    too_few = Experience(condition=("glibc2.27",), action="pwn: radare2 ./pwn", n_ok=0, n_fail=1)
    unconditional = Experience(condition=(), action="pwn: seccomp-tools dump ./pwn", n_ok=0, n_fail=9)
    other_world = Experience(condition=("glibc2.44",), action="pwn: one_gadget ./libc", n_ok=0, n_fail=9)

    got = {v.pattern for v in veto.build([has_success, too_few, unconditional, other_world], world)}
    assert got == set(), got


def test_never_veto_covers_the_essentials() -> None:
    """A record must not be able to take away the ability to run the exploit."""
    for word in ("python3", "objdump", "readelf", "cat", "chmod"):
        exp = Experience(condition=("glibc2.27",), action=f"pwn: {word} ./pwn", n_ok=0, n_fail=9)
        assert veto.build([exp], {"glibc2.27"}) == [], f"{word} was auto-vetoed"


def test_refusal_matches_command_position_not_mention() -> None:
    """`grep ROPgadget notes.txt` mentions the word; it must not be refused."""
    v = veto.Veto(pattern="ROPgadget", why="test", condition=("glibc2.27",), n_fail=3)

    assert refuse_reason("ROPgadget --binary ./pwn", learned=[v]) is not None
    assert refuse_reason("ls && ROPgadget --binary ./pwn", learned=[v]) is not None
    assert refuse_reason("ls; ROPgadget ./pwn", learned=[v]) is not None

    assert refuse_reason("grep ROPgadget notes.txt", learned=[v]) is None
    assert refuse_reason('echo "ROPgadget is slow"', learned=[v]) is None
    assert refuse_reason("python3 -c 'import ROPgadget'", learned=[v]) is None


def test_no_learned_vetoes_on_a_cold_start() -> None:
    """Nothing is refused before anything has been observed."""
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as td:
        assert veto.from_state(Path(td)) == []


def test_veto_message_is_explainable() -> None:
    """A refusal the run cannot understand is worse than no refusal: the agent
    cannot tell what to do instead."""
    v = veto.Veto(pattern="ROPgadget", why="Observed 3 failures and no success", condition=("glibc2.27",), n_fail=3)
    msg = v.reason()
    assert "learned_veto" in msg
    assert "ROPgadget" in msg
    assert "glibc2.27" in msg
    assert "0/3" in msg
