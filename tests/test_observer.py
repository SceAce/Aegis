"""Observer invariants.

These tests exist to pin the two claims the design rests on, so that a later
refactor cannot quietly undo them:

  1. Memory is extracted **mechanically** from worker logs. If a parser change
     starts inventing or dropping events, these tests fail.
  2. Memory **never drives action**. The prompt-assembly path must not be able
     to reach the Observer at all. That is asserted structurally, not by
     convention.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from aegis import observer as obs


def _fake_session(path: Path, *, version: int = obs.SUPPORTED_SESSION_VERSION) -> None:
    """A minimal but real-shaped Pi session: one toolCall + its toolResult."""
    header = {
        "type": "session",
        "version": version,
        "id": "test-session",
        "timestamp": "2026-01-01T00:00:00.000Z",
        "cwd": str(Path.cwd()),
    }
    assistant = {
        "type": "message",
        "id": "m1",
        "timestamp": "2026-01-01T00:00:01.000Z",
        "message": {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "thinking out loud — must NOT become memory"},
                {"type": "thinking", "thinking": "secret reasoning"},
                {
                    "type": "toolCall",
                    "id": "call_1",
                    "name": "aegis_pwn",
                    "arguments": {"command": "objdump -d --start-address=0x1337 ./pwn"},
                },
            ],
        },
    }
    result = {
        "type": "message",
        "id": "m2",
        "timestamp": "2026-01-01T00:00:02.000Z",
        "message": {
            "role": "toolResult",
            "toolCallId": "call_1",
            "toolName": "aegis_pwn",
            "isError": False,
            "content": [{"type": "text", "text": "disassembly ... uid=0(root) ..."}],
        },
    }
    path.write_text(
        "\n".join(json.dumps(e) for e in (header, assistant, result)) + "\n",
        encoding="utf-8",
    )


def test_version_guard_fails_loudly() -> None:
    """An unknown session format must raise, never be parsed on a guess."""
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "s.jsonl"
        _fake_session(p, version=999)
        try:
            list(obs.read_pi_session(p))
        except RuntimeError as exc:
            assert "v999" in str(exc)
            return
        raise AssertionError("unknown session version was accepted silently")


def test_action_outcome_pairing() -> None:
    """One toolCall must produce exactly one memory record, with its outcome."""
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "s.jsonl"
        _fake_session(p)
        events = list(obs.read_pi_session(p))
        assert [e.kind for e in events] == ["action", "outcome"], [e.kind for e in events]
        mem = obs.build_memory(events)
        assert len(mem) == 1, mem
        assert mem[0].tool == "aegis_pwn"
        assert mem[0].ok is True
        assert mem[0].out_chars > 0


def test_prose_and_thinking_never_become_memory() -> None:
    """The model's narration is not an event. Memory is what happened, not what
    it said about what happened."""
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "s.jsonl"
        _fake_session(p)
        mem = obs.build_memory(list(obs.read_pi_session(p)))
        blob = json.dumps([m.__dict__ for m in mem], ensure_ascii=False)
        assert "thinking out loud" not in blob
        assert "secret reasoning" not in blob


def test_memory_is_concrete_experience_is_portable() -> None:
    """Memory keeps this-challenge detail; experience strips it so it can cross
    challenges. This is the fix for 'addresses leaked into the criteria table'."""
    concrete = "objdump -d --start-address=0x1337 /Users/x/Aegis/test/pwn_1/exp.py"
    portable = obs.portable(concrete)
    assert "0x1337" not in portable, portable
    assert "/Users/" not in portable, portable
    assert "pwn_1" not in portable, portable
    assert "objdump" in portable, portable


def test_distill_is_arithmetic_only() -> None:
    """Experience is counting. Same input -> same output, and no row can appear
    that was not counted from memory."""
    records = [
        obs.MemoryRecord("pi", "s", 1, "", "t", "pwn: do x", True, 1, "d"),
        obs.MemoryRecord("pi", "s", 2, "", "t", "pwn: do x", False, 1, "d"),
        obs.MemoryRecord("pi", "s", 3, "", "t", "pwn: do y", True, 1, "d"),
    ]
    exp = obs.distill(records)
    by = {e.action: e for e in exp}
    assert by["pwn: do x"].n_ok == 1 and by["pwn: do x"].n_fail == 1
    assert by["pwn: do y"].n_ok == 1 and by["pwn: do y"].n_fail == 0
    assert len(exp) == 2


def test_criterion_is_mechanical() -> None:
    """The success standard is external text, checked by literal match."""
    events = [
        obs.Event("pi", "s", 1, "", "action", tool="aegis_pwn"),
        obs.Event("pi", "s", 2, "", "outcome", tool="aegis_pwn",
                  data={"text": "PWNED_MARKER\nuid=0(root) gid=0(root)"}),
    ]
    assert obs.find_criterion(events, obs.Criterion(need="PWNED_MARKER", next="uid=0(root)")) == 2
    assert obs.find_criterion(events, obs.Criterion(need="PWNED_MARKER", next="uid=1000")) is None
    assert obs.find_criterion(events, obs.Criterion(need="", next="")) is None


def test_contradictory_observations_do_not_merge() -> None:
    """A world must stay self-consistent.

    Regression found on real data: a session that probed a container (glibc 2.44)
    and then a remote host (2.27) accumulated "hooks_alive AND hooks_dead" and two
    glibc versions at once. That world never existed, matches nothing useful, and
    would qualify experience for the wrong target.
    """
    from aegis.observer.extract import reconcile

    world = reconcile(set(), {"glibc2.44", "hooks_dead", "thread_arena"})
    world = reconcile(world, {"glibc2.27", "hooks_alive", "main_arena"})
    assert world == {"glibc2.27", "hooks_alive", "main_arena"}, world

    # Nothing new asserted: no basis to choose, so leave the conflict alone.
    assert reconcile({"hooks_alive", "hooks_dead"}, set()) == {"hooks_alive", "hooks_dead"}


def test_conditions_come_only_from_structured_tags() -> None:
    """The world is never recovered from prose.

    Free text once produced `no pthread` -> `arena=thread`: an injected wrong
    world is worse than no world, because the run has to spend time disproving
    the premise it was handed.
    """
    from aegis.observer.extract import observed_tags

    assert observed_tags("aegis_observe", {"text": "binary is single-threaded (no pthread)"}) == set()
    assert observed_tags("aegis_observe", {"tags": ["main_arena"]}) == {"main_arena"}
    assert observed_tags("bash", {"tags": ["main_arena"]}) == set()


def test_reasoning_is_recorded_but_never_becomes_memory() -> None:
    """`thought` exists so a human can audit the model's reasoning.

    It must never reach memory or experience: an explanation is not an
    observation, and prose in the criteria table is exactly what this design
    removed. Recording it is safe *because* the memory pipeline only pairs
    `action` with `outcome`.
    """
    events = [
        obs.Event("pi", "s", 1, "", "thought", data={"part": "thinking", "text": "先量 libc 版本"}),
        obs.Event("pi", "s", 2, "", "action", tool="aegis_pwn", call_id="c1",
                  data={"args": {"command": "readelf -sW ./pwn"}}),
        obs.Event("pi", "s", 3, "", "outcome", tool="aegis_pwn", call_id="c1", ok=True,
                  data={"text": "symbols"}),
    ]
    memory = obs.build_memory(events)
    assert [m.tool for m in memory] == ["aegis_pwn"], memory

    experience = obs.distill(memory)
    assert experience, "the action should still distil"
    assert all("先量" not in e.action for e in experience), experience


def test_playbook_never_sees_raw_memory() -> None:
    """STRUCTURAL: the behaviour path consumes `Experience`, never `MemoryRecord`.

    This is the boundary the whole design rests on — memory is a record, only
    distilled counts may steer. Checked on the AST rather than on raw text so
    that prose *describing* the rule (docstrings, comments) does not count as
    violating it; only an actual reference does.
    """
    import ast

    src = (Path(__file__).resolve().parent.parent / "aegis" / "policy" / "playbook.py").read_text(
        encoding="utf-8"
    )
    tree = ast.parse(src)

    used: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            used.add(node.id)
        elif isinstance(node, ast.Attribute):
            used.add(node.attr)

    offenders = used & {"MemoryRecord", "build_memory", "memory_store", "load"}
    assert not offenders, f"playbook referenced raw memory via {sorted(offenders)}"


def test_raw_memory_detail_cannot_reach_the_prompt() -> None:
    """FUNCTIONAL: the behaviour path sees portable actions, not raw records.

    Memory is allowed to be concrete (addresses, absolute paths, artifact
    hashes). None of that may reach a worker, because it is meaningless on the
    next target and would crowd out the portable part.
    """
    from aegis.policy.playbook import build

    records = [
        obs.MemoryRecord(
            worker="pi",
            session="s1",
            seq=1,
            ts="T",
            tool="aegis_pwn",
            action="pwn: run 0xdeadbeef from /Users/x/secret/exp.py",
            ok=True,
            out_chars=1,
            out_digest="sha1:deadbeefcafe",
            condition=(),
        )
    ]
    text = build(obs.distill(records), set()).render()
    assert "0xdeadbeef" not in text, text
    assert "/Users/x/secret" not in text, text
    assert "deadbeefcafe" not in text, text
    assert "run" in text, "the portable part should survive"


def test_experience_drives_behaviour() -> None:
    """Experience *is* allowed to influence behaviour — that is its whole job.

    Guidance needs a positive record; a veto needs failures with zero successes
    under a condition that actually holds now.
    """
    from aegis.policy.playbook import build

    world = {"glibc2.27", "tcache"}
    good = obs.Experience(condition=("glibc2.27",), action="tcache poison -> write", n_ok=3, n_fail=1)
    bad = obs.Experience(condition=("glibc2.27",), action="hooks overwrite", n_ok=0, n_fail=2)
    elsewhere = obs.Experience(condition=("glibc2.44",), action="fsop", n_ok=5, n_fail=0)

    pb = build([good, bad, elsewhere], world)
    assert [e.action for e in pb.guidance] == ["tcache poison -> write"]
    assert [e.action for e in pb.vetoes] == ["hooks overwrite"]
    assert "fsop" not in pb.render(), "experience from another world was applied"


def test_veto_needs_a_nonempty_condition() -> None:
    """An unconditional failure proves nothing about any world, so it must not
    become a 'do not try'. Losing a working technique to a vague record is the
    expensive kind of mistake (`guard.py`'s own warning about false refusals)."""
    from aegis.policy.playbook import build

    vague = obs.Experience(condition=(), action="pwn: something", n_ok=0, n_fail=5)
    pb = build([vague], {"glibc2.27"})
    assert pb.vetoes == []


def test_observer_view_never_returns_prompt_text() -> None:
    """The Observer's own output is for humans/audit. It must not be shaped as
    prompt material — no system-prompt headers, no 'inject' framing."""
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "s.jsonl"
        _fake_session(p)
        mem = obs.build_memory(list(obs.read_pi_session(p)))
        for row in mem:
            text = json.dumps(row.__dict__, ensure_ascii=False)
            assert "<system" not in text.lower()
            assert "aegis ram" not in text.lower()


def test_a_tag_its_own_text_disproves_is_dropped() -> None:
    """A world tag is a *key*. Every conditional experience row is keyed on the
    exact version string, so one wrong digit silently disables all of them: a real
    run declared `glibc2.44` while its own observation text said
    `Ubuntu GLIBC 2.43-2ubuntu2.4`, and 0 of 205 experience rows applied. The run
    then looks like "experience does not transfer" when the cause was a typo.

    So a self-contradictory tag is dropped and reported. Dropping it is not
    deriving the world from prose — every other tag is still taken only from
    structured arguments, and a tag the text *agrees* with is kept."""
    from aegis.observer.extract import contradictory_glibc, observed_tags

    text = "checksec: /lib/x86_64-linux-gnu/libc.so.6 -> Ubuntu GLIBC 2.43-2ubuntu2.4"

    conflict = contradictory_glibc({"glibc2.44"}, text)
    assert conflict == ("glibc2.44", "glibc2.43"), conflict

    dropped = observed_tags("aegis_observe", {"tags": ["glibc2.44", "tcache"], "text": text})
    assert dropped == {"tcache"}, dropped

    agreed = observed_tags("aegis_observe", {"tags": ["glibc2.43", "tcache"], "text": text})
    assert agreed == {"glibc2.43", "tcache"}, agreed


def test_contradiction_check_does_not_invent_a_world() -> None:
    """The guard must stay narrow, or it becomes the prose-to-world parser the
    design forbids. No version in the text -> the tag stands; several declared
    versions -> the guard abstains rather than picking one."""
    from aegis.observer.extract import contradictory_glibc, observed_tags

    assert contradictory_glibc({"glibc2.44"}, "no version mentioned here") is None
    assert contradictory_glibc({"glibc2.44", "glibc2.27"}, "GLIBC 2.43") is None
    assert (
        observed_tags("aegis_observe", {"tags": ["glibc2.44"], "text": "no version here"})
        == {"glibc2.44"}
    )


def test_contradicted_tag_is_dropped_at_the_write_site() -> None:
    """The drop has to hold on every path that can read the tag.

    `observed_tags` covers the event stream, but `current_fingerprint` also reads
    the `fingerprint` list written by `add_observation`, and `experience_playbook`
    falls back to it when the stream has no tags. Dropping the tag only in
    `observed_tags` left the wrong version alive on that fallback — and would have
    made `aegis observe`'s own "the tag was dropped" warning a lie.
    """
    import os

    from aegis.storage import store

    # `AEGIS_DIR` is resolved once at import of `aegis.paths`, so the dir cannot
    # be swapped here — this test depends on run_all's temp state dir, and must
    # refuse to write the live one (same reason as tests/test_cli.py).
    assert os.environ.get("AEGIS_STATE_DIR"), "run tests via tests/run_all.py"

    store.save_current({"challenge": "pwn_x", "observations": [], "fingerprint": []})
    row = store.add_observation(
        "checksec: libc.so.6 -> Ubuntu GLIBC 2.43-2ubuntu2.4",
        tags=["glibc2.44", "tcache"],
    )
    assert row["tags"] == ["tcache"], row["tags"]
    fp = store.current_fingerprint().all
    assert "glibc2.44" not in fp, fp
    assert "glibc2.43" in fp, fp
