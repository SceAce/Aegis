"""Role-flip tests: the same capability family, opposite verdicts.

SameCapRisk-Bench (arXiv:2606.10388) calls these "role-flip units": two skills
that share a capability family but swap helpful/risky roles across paired
queries. They are the sharpest test of whether a retrieval layer is doing
*judgement* or only *similarity* — a similarity ranker scores the pair nearly
equally, so it cannot get both right.

pwn_1 and pwn_2 are a natural role-flip pair, which is why this suite uses
**real recorded cells** rather than synthetic fixtures.

They are read from `tests/fixtures/roleflip_cells.json` — a frozen snapshot —
and NOT from `.aegis/atlas.json`. The atlas is the user's accumulated memory and
gets wiped between experiment rounds, so a suite that read it would fail on a
clean slate (and on anyone else's checkout) while saying nothing about the code.
The fixture is still real recorded data, just pinned to a snapshot.

Run: UV_CACHE_DIR=/tmp/uvcache uv run --no-sync python -m pytest tests/ -q
  or: uv run --no-sync python tests/test_roleflip.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aegis.policy.activate import activate, harmful_sibling_rate  # noqa: E402
from aegis.core.fingerprint import parse as parse_fp  # noqa: E402
from aegis.core.predicate import is_applicable  # noqa: E402
from aegis.storage.store import _normalise_cell  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "roleflip_cells.json"


def _cells() -> list[dict]:
    """Frozen role-flip cells, normalised exactly as the live atlas would be.

    Going through `_normalise_cell` matters: it computes `_cues`, which is what
    activation scores against. A hand-rolled copy here could drift from the
    runtime shape and the tests would keep passing against a shape nothing
    produces.
    """
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return [_normalise_cell(c) for c in raw["cells"]]


def _cell(tech_fragment: str) -> dict:
    for c in _cells():
        if tech_fragment.lower() in c["technique"].lower():
            return c
    raise AssertionError(f"cell not found: {tech_fragment}")


# --------------------------------------------------------------- fingerprints

FP_PWN2 = parse_fp(["环境是 ubuntu 18.04", "thread arena, glibc 2.27, exit_group"], ["glibc2.27", "thread_arena", "exit_group"])
FP_PWN1 = parse_fp(
    [
        "container libc glibc 2.44",
        "hooks dead, exit triggers flush",
        "tcache key randomized; safe-linking present; allocate uses calloc",
    ],
    ["glibc2.44", "hooks_dead", "tcache", "calloc", "tcache_key_random", "safe_linking"],
)
FP_COLD = parse_fp([], [])


# ------------------------------------------------------------------- parsing


def test_version_parse_is_anchored():
    """A bare '2.27' next to a 2.44 claim must not produce two worlds."""
    fp = parse_fp(["container glibc 2.44, tcache key 2.27-ish"], [])
    assert fp.glibc == (2, 44), fp.glibc


def test_ubuntu_normalises_to_glibc():
    """`ubuntu 18.04` and `glibc 2.27` must land on the same fingerprint value."""
    a = parse_fp(["环境是 ubuntu 18.04"], [])
    b = parse_fp(["glibc 2.27"], [])
    assert a.glibc == b.glibc == (2, 27)


def test_derived_tags_not_guessed():
    fp = parse_fp(["glibc 2.44"], [])
    assert fp.hooks == "dead"  # >= 2.34 removes the hooks
    assert fp.has("glibc>=2.34")
    assert not fp.has("glibc<2.34")


def test_unobserved_is_not_false():
    fp = parse_fp(["glibc 2.27"], [])
    assert fp.has("exit_group") is False
    assert fp.known("exit_group") is False


# ---------------------------------------------------------------- role flips


ROLE_FLIPS = [
    # (fingerprint, must-apply technique, must-not-apply technique)
    (FP_PWN2, "short-read size loop -> heap overflow", "tcache poison _IO_list_all -> fake FILE"),
    (FP_PWN2, "thread arena exhaustion -> new heap below arena", "House of Apple 2 wide_vtable"),
    (FP_PWN2, "overflow into thread arena -> fastbin poison", "unlink arbitrary write"),
    (FP_PWN1, "tcache poison _IO_list_all -> fake FILE", "short-read size loop -> heap overflow"),
    (FP_PWN1, "House of Apple 2 wide_vtable", "thread arena exhaustion -> new heap below arena"),
    (FP_PWN1, "adjacent tcache next XOR -> heap leak", "House of Force to libc"),
]


def test_role_flips():
    """Each pair must get opposite verdicts on the same fingerprint."""
    failures = []
    for fp, want_on, want_off in ROLE_FLIPS:
        on_cell = _cell(want_on)
        off_cell = _cell(want_off)
        on_ok, on_why = is_applicable(on_cell, fp)
        off_ok, off_why = is_applicable(off_cell, fp)
        if not on_ok:
            failures.append(f"[{fp.glibc}] EXPECTED APPLICABLE: {want_on!r} -> {on_why}")
        if off_ok:
            failures.append(f"[{fp.glibc}] EXPECTED NOT APPLICABLE: {want_off!r}")
    assert not failures, "\n".join(failures)


def test_no_cross_contamination_pwn2():
    """pwn_2 must not see pwn_1's glibc-2.44 chain."""
    bundle = activate(cells=_cells(), problems=[], habits=[], fp=FP_PWN2)
    text = " ".join(str(c.get("technique")) for c in bundle["cells"])
    for banned in ("House of Apple", "_IO_wfile_jumps", "tcache poison", "glibc 2.44"):
        assert banned.lower() not in text.lower(), f"leaked: {banned}"


def test_no_cross_contamination_pwn1():
    """pwn_1 must not see pwn_2's thread-arena chain."""
    bundle = activate(cells=_cells(), problems=[], habits=[], fp=FP_PWN1)
    text = " ".join(str(c.get("technique")) for c in bundle["cells"])
    for banned in ("thread arena exhaustion", "fastbin poison", "short-read size loop", "House of Force"):
        assert banned.lower() not in text.lower(), f"leaked: {banned}"


def test_cold_start_injects_no_strategy():
    """With no observation, only opening habits — not last run's chain."""
    bundle = activate(
        cells=_cells(),
        problems=[],
        habits=[{"when": "starting a heap pwn", "observe": "identify actual libc version"}],
        fp=FP_COLD,
    )
    assert bundle["cold_start"] is True
    assert bundle["cells"] == [], bundle["cells"]
    assert bundle["habits"], "opening measurements should still be offered"


def test_prohibition_reason_names_only_what_fired():
    """A prohibition must state the condition that actually matched.

    Regression: the renderer printed every condition the cell carried, so a
    FSOP cell read "because exit_group, glibc=2.44" while the fingerprint was
    glibc 2.27. The agent reads these reasons to decide what to avoid, so a
    condition that did not fire is misinformation.
    """
    from aegis.policy.activate import _fired_conditions

    cell = _cell("fake FILE placed in libc near _IO_list_all")
    fv = cell.get("forbids_version") or {}
    assert fv.get("glibc") == "=2.44", f"fixture drift: {fv}"

    fired = _fired_conditions(cell, FP_PWN2)  # glibc 2.27 + exit_group
    assert "exit_group" in fired, fired
    assert not any("2.44" in f for f in fired), f"a condition that did not fire: {fired}"

    # And the prohibition row exposes exactly that list.
    bundle = activate(cells=_cells(), problems=[], habits=[], fp=FP_PWN2)
    row = next((c for c in bundle["forbid"] if "strtol" in str(c.get("technique"))), None)
    assert row is not None, "expected this cell to be a prohibition on pwn_2"
    assert row.get("_matched") == fired, (row.get("_matched"), fired)


def test_condition_rendering_has_no_double_operator():
    """A glibc spec carries its own operator; do not add another.

    Regression: the renderer used `f"{k}={v}"`, so a correct stored
    `{"glibc": ">=2.34"}` appeared in every writeup and prompt line as
    `glibc=>=2.34`. The fix now lives in `storage.store._fmt_req`, which renders
    the requirement column the worker sees.
    """
    from aegis.storage.store import _fmt_req

    got = _fmt_req({"glibc": ">=2.34", "hooks": "dead"})
    assert "glibc>=2.34" in got, got
    assert "glibc=>=" not in got, got
    assert "hooks=dead" in got, got
    assert _fmt_req({}) == "always"


def test_llm_version_specs_are_normalised():
    """Models emit `glibc==2.26` and `=>=2.31`; both must be coerced, not kept.

    The wiki path normalised these from the start; the challenge-compile path
    did not, so malformed specs could reach the atlas and never match a
    fingerprint.
    """
    from aegis.core.predicate import normalize_ver_spec

    assert normalize_ver_spec("glibc==2.26") == "=2.26"
    assert normalize_ver_spec("=>=2.31") == ">=2.31"
    assert normalize_ver_spec("=<2.29") == "<=2.29"
    assert normalize_ver_spec("2.27") == "=2.27"
    assert normalize_ver_spec("garbage") is None


def test_unconditional_off_cell_is_not_a_prohibition():
    """A cell with no conditions has nothing to match, so it forbids nothing.

    Regression: recording the checksec result as an observation set
    `observed=True`, and an OFF cell with empty `requires` then matched
    vacuously — producing "do not try X" for a technique whose only stated
    condition was nothing at all. It fired on every world the moment any
    observation existed.

    Real setup output was enough to trigger it: `aegis start` runs pwninit,
    whose checksec block is recorded as an observation.
    """
    from aegis.policy.activate import is_prohibition
    from aegis.core.fingerprint import parse

    unconditional = {
        "technique": "some technique with no stated condition",
        "state": "off",
        "requires": {},
        "forbids": [],
        "forbids_version": {},
        "optional": [],
        "n": 1,
        "evidence": "local",
    }
    # Even a world where we know something (checksec protections only).
    fp = parse(["checksec: Full RELRO, Canary found, NX enabled, No PIE"], ["full_relro", "canary", "nx", "non_pie"])
    assert fp.glibc is None
    hit, why = is_prohibition(unconditional, fp)
    assert hit is False, f"vacuous prohibition fired: {why}"

    # A cell that DOES state a matching condition still becomes a prohibition.
    conditional = dict(unconditional, technique="t -> x", requires={"glibc": "=2.27"})
    fp2 = parse(["glibc 2.27"], ["glibc2.27"])
    assert is_prohibition(conditional, fp2)[0] is True


def test_cold_start_forbids_nothing():
    """Nothing is forbidden in a world we have not looked at.

    Regression: unconditional OFF cells (empty `requires`) evaluated as
    applicable on an all-None fingerprint, so a cold start produced six
    prohibitions derived from no observation at all.
    """
    bundle = activate(cells=_cells(), problems=[], habits=[], fp=FP_COLD)
    assert bundle["forbid"] == [], bundle["forbid"]


def test_cold_intervention_is_not_forbid():
    """The cold-start intervention must be opening measurements, not a veto."""
    from aegis.policy.intervene import Kind, decide

    bundle = activate(
        cells=_cells(),
        problems=[],
        habits=[{"when": "start of a heap pwn", "observe": "libc version in container"}],
        fp=FP_COLD,
    )
    iv = decide(trigger="opening", bundle=bundle)
    assert iv.kind is not Kind.FORBID, iv.forbid


# ------------------------------------------------------------ tier behaviour


def test_wiki_never_becomes_strategy():
    """A wiki cell can never be an instruction, only reference."""
    wiki = [c for c in _cells() if c.get("evidence") == "wiki"]
    assert wiki, "expected wiki cells in the atlas"
    bundle = activate(cells=wiki, problems=[], habits=[], fp=FP_PWN2)
    assert bundle["cells"] == [], f"wiki leaked into strategy: {bundle['cells'][:3]}"
    assert bundle["reference"], "wiki should still be offered as reference"
    assert len(bundle["reference"]) <= 2


def test_local_success_stays_on():
    """A locally-verified working chain is evidence, not a prohibition."""
    cell = _cell("House of Apple 2 wide_vtable")
    assert cell["state"] == "on"
    assert cell["evidence"] == "local"
    ok, why = is_applicable(cell, FP_PWN1)
    assert ok, why


def test_off_cell_matching_becomes_prohibition():
    """An OFF cell whose condition matches is a prohibition, not silence.

    Ranking matters: on pwn_1 the veto-firing cells (exit_group kills FSOP)
    must outrank unrelated 2.44 failures, or the agent gets a list of things
    that were never going to work anyway.
    """
    bundle = activate(cells=_cells(), problems=[], habits=[], fp=FP_PWN1)
    forbid = [str(c.get("technique")) for c in bundle["forbid"]]
    assert forbid, "expected prohibitions on pwn_1"
    joined = " ".join(forbid[:4]).lower()
    assert "_io_list_all" in joined, forbid
    assert not any("free(null)" in f.lower() for f in forbid), forbid


def test_prohibition_is_world_specific():
    """The same OFF cell must be a prohibition in one world and not another.

    `__free_hook/__malloc_hook overwrite` is OFF because the hooks were removed
    in glibc 2.34. It is therefore a *prohibition* on 2.44 (do not try it here),
    while on 2.27 the hooks still exist and the cell's failure condition does
    not match — so it must not be forbidden there.
    """
    from aegis.policy.activate import is_prohibition

    hook = _cell("__free_hook/__malloc_hook overwrite")
    assert is_prohibition(hook, FP_PWN1)[0] is True, "should be forbidden on 2.44"
    assert is_prohibition(hook, FP_PWN2)[0] is False, "must not be forbidden on 2.27"


def test_prohibition_ranking_prefers_specific_vetoes():
    """Veto-firing prohibitions outrank merely-applicable ones.

    `_IO_list_all ... House of Apple` is forbidden because this world exits via
    exit_group (stdio is never flushed), which is a *specific* reason. That must
    sort above an unrelated OFF cell that happens to share the version.
    """
    bundle = activate(cells=_cells(), problems=[], habits=[], fp=FP_PWN2)
    rows = bundle["forbid"]
    assert rows, "expected prohibitions on pwn_2"
    top = rows[0]
    assert top["A"] >= 2.0, f"top prohibition should be a veto, got {top}"
    assert top["why"] in ("veto", "veto-version"), top["why"]


# ------------------------------------------------------------------- metrics


def test_hsr_is_measured_before_the_gate():
    """HSR must be measured on the similarity ranking, or it is identically 0."""
    cells = _cells()
    fp = FP_PWN2
    # similarity-only top-k by raw cue overlap
    topk = sorted(cells, key=lambda c: len(set(c["_cues"]) & (fp.expanded | fp.all)), reverse=True)[:6]
    hsr = harmful_sibling_rate(topk, fp)
    assert 0.0 <= hsr <= 1.0
    # If this is 0, the similarity ranking is doing the predicates' job and the
    # metric is not telling us anything.
    assert hsr > 0.0, "expected at least one harmful sibling in a naive top-6"


def test_metrics_recorded_in_bundle():
    bundle = activate(cells=_cells(), problems=[], habits=[], fp=FP_PWN2)
    assert "hsr_at_k" in bundle
    assert isinstance(bundle["hsr_at_k"], float)
    assert bundle["dropped"], "drop reasons must be observable"


# ---------------------------------------------------------------- predicates


def test_forbidden_beats_requirement():
    """A matched veto wins even when requirements are satisfied."""
    fp = parse_fp(["glibc 2.44, hooks dead, exit_group"], ["glibc2.44", "hooks_dead", "exit_group"])
    cell = _cell("House of Apple 2 wide_vtable")
    ok, why = is_applicable(cell, fp)
    assert not ok
    assert why.startswith("forbidden:"), why


def test_optional_does_not_veto():
    """A missing soft cue costs score, never applicability."""
    cell = _cell("short-read size loop -> heap overflow")
    assert cell["optional"], "expected an optional cue"
    fp = parse_fp(["glibc 2.27"], ["glibc2.27"])  # no_free NOT observed
    ok, why = is_applicable(cell, fp)
    assert ok, why


def test_wiki_is_never_a_prohibition():
    """An article's "fails on >=2.26" is not evidence about this target.

    Regression: `score` checked the veto BEFORE the wiki tier, so a wiki cell
    whose `forbids_version` fired reported `forbidden:*` — which the caller
    routes into the prohibition list. A wiki line about 32-bit MALLOC_ALIGNMENT
    thereby told a 64-bit run "do not do this".
    """
    from aegis.policy.activate import is_prohibition, score, _tier

    wiki = {
        "technique": "rely on 8-byte MALLOC_ALIGNMENT on 32-bit glibc",
        "state": "off",
        "requires": {},
        "forbids": [],
        "forbids_version": {"glibc": ">=2.26"},
        "optional": [],
        "evidence": "wiki",
        "n": 1,
    }
    assert _tier(wiki) == "wiki"
    fp = FP_PWN2  # glibc 2.27
    assert score(wiki, fp, {})[1] == "wiki-not-strategy", score(wiki, fp, {})
    assert is_prohibition(wiki, fp)[0] is False, "wiki became a prohibition"


def test_prohibition_reason_for_condition_match():
    """A condition-match prohibition must not repeat its requirements.

    Regression: with no veto to name, the renderer fell back to the cell's
    `condition` — so a cell requiring glibc=2.27 read as "avoid this because it
    needs glibc 2.27", which is the opposite of the point.
    """
    from aegis.storage.store import _why_fired

    row = {"why": "matched:condition-match", "forbids": [], "forbids_version": {}, "requires": {"glibc": "=2.27"}}
    got = _why_fired(row)
    assert "2.27" not in got, got
    assert "没打通" in got, got


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
