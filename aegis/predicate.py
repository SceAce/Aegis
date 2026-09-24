"""Deterministic predicate evaluation of a cell against a Fingerprint.

A cell declares three things, and the distinction between them is the whole
point of this module:

    requires   all must hold, else the cell is not applicable      (hard gate)
    forbids    any that holds forces the cell OFF / prohibited     (hard veto)
    optional   absence only costs activation score                 (soft)

The old code collapsed all three into "no tag overlap -> -inf". That conflated
two very different situations:

    * the cell's conditions are *contradicted* by the world   (must not inject)
    * the cell's conditions are merely *not yet observed*     (may still inject)

A mechanism-level cell with no challenge numbers in it should survive the
second case. That is what `optional` is for.
"""

from __future__ import annotations

import re
from typing import Any

from aegis.fingerprint import Fingerprint

_VER = re.compile(r"^(>=|<=|!=|>|<|=)?\s*(\d+)\.(\d+)$")


def normalize_ver_spec(spec: str) -> str | None:
    """Coerce a version spec to canonical form, or None if unusable.

    Models write "glibc==2.26", "=>=2.31" and "=<2.29" often enough that
    rejecting them loses real knowledge. A chain of str.replace calls is not
    enough — replacing "=>" inside "=>=2.31" leaves ">==" — so the operator
    characters are collected and rebuilt instead.
    """
    s = str(spec).strip()
    s = re.sub(r"^(?:glibc|libc)\s*", "", s, flags=re.I).strip()
    s = s.replace("≥", ">=").replace("≤", "<=")
    m = re.match(r"^([<>=!]*)\s*(\d+)\.(\d+)\s*$", s)
    if not m:
        return None
    raw, major, minor = m.group(1), m.group(2), m.group(3)
    if "!" in raw:
        op = "!="
    elif ">" in raw and "=" in raw:
        op = ">="
    elif "<" in raw and "=" in raw:
        op = "<="
    elif ">" in raw:
        op = ">"
    elif "<" in raw:
        op = "<"
    else:
        op = "="
    return f"{op}{major}.{minor}"


def _parse_ver(spec: str) -> tuple[str, tuple[int, int]] | None:
    s = normalize_ver_spec(spec)
    if s is None:
        return None
    m = _VER.match(s)
    if not m:
        return None
    return (m.group(1) or "=", (int(m.group(2)), int(m.group(3))))


def _ver_ok(got: tuple[int, int], spec: str) -> bool:
    p = _parse_ver(spec)
    if p is None:
        # An unusable spec must not silently pass. Treat as "cannot evaluate"
        # and let the caller decide; here that means not satisfied.
        return False
    op, want = p
    if op == ">=":
        return got >= want
    if op == "<=":
        return got <= want
    if op == ">":
        return got > want
    if op == "<":
        return got < want
    if op == "!=":
        return got != want
    # "=" matches to the same minor series, so 2.27 matches 2.27.x
    return got == want or (got[0] == want[0] and got[1] == want[1])


def check_requires(requires: dict[str, Any], fp: Fingerprint) -> tuple[bool, str]:
    """All required conditions hold? Returns (ok, reason-if-not)."""
    for key, want in (requires or {}).items():
        if key == "glibc":
            specs = want if isinstance(want, (list, tuple)) else [want]
            if fp.glibc is None:
                return False, "unobserved:glibc"
            if not any(_ver_ok(fp.glibc, str(s)) for s in specs):
                return False, "version"
            continue

        got = fp.get(key)
        if got is None:
            # A scalar field we have not observed. For hooks/exit/arena we can
            # often derive the value from glibc, in which case get() would have
            # returned it. Otherwise it is genuinely unknown.
            if fp.known(str(want)) or key in ("hooks", "exit", "arena"):
                return False, f"unobserved:{key}"
            return False, f"unobserved:{key}"

        if key == "alloc":
            wanted = {str(w) for w in (want if isinstance(want, (list, tuple)) else [want])}
            if not wanted <= set(got):  # type: ignore[arg-type]
                return False, "alloc"
            continue

        wanted = want if isinstance(want, (list, tuple)) else [want]
        if str(got) not in {str(w) for w in wanted}:
            return False, "conflict"
    return True, "ok"


def check_forbids(forbids: Any, fp: Fingerprint, version_forbids: Any = None) -> tuple[bool, str]:
    """Any forbidden condition present? Returns (forbidden, which).

    `forbids` is a list of tags. `version_forbids` is a mapping for conditions
    expressed as a version or scalar equality, e.g. {"glibc": ">=2.34"} on an
    OFF cell means "dead from 2.34 on".

    Both forms say the same thing: the world matches the condition the cell
    says defeats it.
    """
    if isinstance(forbids, dict):
        # Legacy shape: a single mapping carrying both kinds.
        version_forbids = {**(forbids if version_forbids is None else version_forbids)}
        forbids = []

    for f in forbids or []:
        if fp.has(str(f)):
            return True, str(f)

    for key, want in (version_forbids or {}).items():
        if key == "glibc":
            if fp.glibc is None:
                continue  # cannot veto on an unobserved version
            specs = want if isinstance(want, (list, tuple)) else [want]
            if any(_ver_ok(fp.glibc, str(s)) for s in specs):
                return True, f"glibc{want}"
        elif key in ("hooks", "exit", "arena"):
            if str(getattr(fp, key, None)) == str(want):
                return True, f"{key}={want}"
        elif want is True:
            if fp.has(str(key)):
                return True, str(key)
        elif fp.has(str(want)):
            return True, str(want)
    return False, ""


def is_applicable(cell: dict[str, Any], fp: Fingerprint) -> tuple[bool, str]:
    """The gate. (applicable, reason).

    Vetoes are checked FIRST. A cell that both requires `exit=flush` and forbids
    `exit_group` describes a world where it works (stdio flushed) and a world
    where it is destroyed (raw exit_group). On a world with exit_group both
    clauses are "false", so a requires-first order would report a bland
    `conflict` and lose the fact that this is a *known failure mode* — which is
    what the prohibition list needs to say.

    Reasons are stable strings so they can be counted as metrics:
      ok | forbidden:<tag> | version | conflict | alloc | unobserved:<field>
    """
    bad, which = check_forbids(cell.get("forbids") or [], fp, cell.get("forbids_version") or {})
    if bad:
        return False, f"forbidden:{which}"

    # A cell with no requirements at all is unconditional. On an OFF cell that
    # is a claim like "this always fails", which is almost never what the run
    # meant — more often the migration simply could not parse a discriminating
    # condition. Do not let such a cell act as a prohibition on an unknown
    # world; require that we actually know something.
    if not (cell.get("requires") or {}) and not fp.observed:
        return False, "unobserved:any"

    ok, why = check_requires(cell.get("requires") or {}, fp)
    if not ok:
        return False, why
    return True, "ok"


def is_prohibition(cell: dict[str, Any], fp: Fingerprint) -> bool:
    """An OFF cell that *does* apply is a prohibition, not silence.

    This is the negative-memory push: the agent is never going to ask "where did
    I fail before", so matching failures are forced into the context.
    """
    if str(cell.get("state") or "on") != "off":
        return False
    return is_applicable(cell, fp)[0]


def required_tags(cell: dict[str, Any]) -> set[str]:
    """Mechanism tags a cell asserts, for cue-overlap scoring."""
    out: set[str] = set()
    req = cell.get("requires") or {}
    for k, v in req.items():
        if k == "glibc":
            specs = v if isinstance(v, (list, tuple)) else [v]
            for s in specs:
                p = _parse_ver(str(s))
                if p:
                    op, ver = p
                    out.add(f"glibc{ver[0]}.{ver[1]}")
        elif k in ("hooks", "exit", "arena"):
            out.add(f"{v}_{'group' if v == 'group' else v}" if k == "exit" else f"{v}")
        else:
            vals = v if isinstance(v, (list, tuple)) else [v]
            out |= {str(x) for x in vals}
    out |= {str(f) for f in (cell.get("forbids") or [])}
    return out
