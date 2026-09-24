"""Structured fingerprint of the CURRENT world.

The old pipeline extracted cues with substring tests (`"2.27" in blob`) and then
scored items by set overlap. Two failures followed:

  * "container glibc 2.44, tcache key 2.27-ish" yielded BOTH glibc2.44 and
    glibc2.27, i.e. mutually exclusive worlds at once.
  * "ubuntu 18.04" and "glibc=2.27" never normalised to the same value, so a
    cell written under one spelling could not match a hint written in the other.

Both are parse bugs, not scoring bugs. Versions therefore enter the fingerprint
only through an *anchored* pattern (`glibc 2.27`, `libc-2.27`, `ubuntu 18.04`)
or an explicit --tag; a bare number is never a cue.

A Fingerprint is the thing predicates are evaluated against. It is deliberately
small: only fields a cell may require.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace

# glibc 2.27 / libc-2.27 / libc.so.6 (2.27) / glibc=2.27 / glibc >= 2.34
_GLIBC = re.compile(r"(?:glibc|libc|ld)[\s=_:/-]*(?:so\.\d[\s()]*)?(?:>=|<=|>|<|=)?\s*(\d+)\.(\d+)", re.I)
# ubuntu 18.04 / ubuntu18.04 / 18.04 LTS   (only with a distro anchor, never bare)
_UBUNTU = re.compile(r"(?:ubuntu|u?buntu)[\s=_:/-]*(\d{2})\.(\d{2})", re.I)
_UBUNTU_LTS = re.compile(r"\b(\d{2})\.(\d{2})\s*(?:lts|ubuntu)", re.I)

# Ubuntu release -> shipped glibc. Factual, single-source-of-truth mapping.
UBUNTU_GLIBC: dict[tuple[int, int], tuple[int, int]] = {
    (14, 4): (2, 19),
    (16, 4): (2, 23),
    (18, 4): (2, 27),
    (20, 4): (2, 31),
    (22, 4): (2, 35),
    (24, 4): (2, 39),
}

# Threshold tags derived from a concrete version. Never hand-tagged.
def version_tags(g: tuple[int, int]) -> set[str]:
    out = {f"glibc{g[0]}.{g[1]}"}
    out.add("glibc>=2.34" if g >= (2, 34) else "glibc<2.34")
    out.add("glibc>=2.32" if g >= (2, 32) else "glibc<2.32")  # safe-linking
    return out


def implied_by_version(g: tuple[int, int]) -> set[str]:
    """What the version alone forces. No technique guessing."""
    tags = version_tags(g)
    tags.add("hooks_dead" if g >= (2, 34) else "hooks_alive")
    tags.add("safe_linking" if g >= (2, 32) else "no_safe_linking")
    tags.add("ptmalloc")
    return tags


# Tags a Fingerprint may carry beyond the structured fields above.
KNOWN_TAGS = {
    "hooks_alive",
    "hooks_dead",
    "main_arena",
    "thread_arena",
    "exit_group",
    "exit_flush",
    "tcache",
    "fastbin",
    "unsorted_bin",
    "calloc",
    "safe_linking",
    "no_safe_linking",
    "tcache_key_random",
    "no_free",
    "no_show",
    "full_relro",
    "partial_relro",
    "canary",
    "nx",
    "non_pie",
    "pie",
    "fsop",
    "wide_vtable",
    "house_of_apple",
    "house_of_orange",
    "house_of_force",
    "house_of_einherjar",
    "house_of_lore",
    "house_of_roman",
    "house_of_pig",
    "unsorted_bin_attack",
    "large_bin_attack",
    "tcache_poison",
    "fastbin_poison",
    "got_overwrite",
    "top_chunk",
    "heap_leak",
    "libc_leak",
    "short_read",
    "unlink",
    "arena_exhaust",
    "off_by_one",
    "use_after_free",
    "overlap",
    "ptmalloc",
}


@dataclass(frozen=True)
class Fingerprint:
    """The observed world. None means "not observed", which is NOT the same as
    "observed to be false" — predicates must distinguish the two."""

    glibc: tuple[int, int] | None = None
    hooks: str | None = None  # alive | dead
    exit: str | None = None  # flush | group
    arena: str | None = None  # main | thread
    alloc: frozenset[str] = frozenset()
    tags: frozenset[str] = frozenset()
    observed: bool = False

    # ---------------------------------------------------------------- queries

    def has(self, key: str) -> bool:
        """Is this mechanism tag true of the current world?

        Returns False both for "false" and "unknown"; callers that need the
        distinction use `known()`.
        """
        if key == "exit_group":
            return self.exit == "group"
        if key == "exit_flush":
            return self.exit == "flush"
        if key == "hooks_dead":
            return self.hooks == "dead"
        if key == "hooks_alive":
            return self.hooks == "alive"
        if key == "thread_arena":
            return self.arena == "thread"
        if key == "main_arena":
            return self.arena == "main"
        if key in ("glibc<2.34", "glibc>=2.34", "glibc<2.32", "glibc>=2.32"):
            if self.glibc is None:
                return False
            return key in version_tags(self.glibc)
        if key == "ptmalloc":
            return True  # the only allocator this system has ever seen
        return key in self.all

    def known(self, key: str) -> bool:
        """Do we know the truth value of this tag?"""
        if key in ("exit_group", "exit_flush"):
            return self.exit is not None
        if key in ("hooks_dead", "hooks_alive"):
            return self.hooks is not None
        if key in ("thread_arena", "main_arena"):
            return self.arena is not None
        if key.startswith("glibc") and ("2.3" in key or "2.4" in key or "2.5" in key):
            return self.glibc is not None
        return key in self.all or key in self.tags or key in self.expanded

    def get(self, key: str) -> object | None:
        if key == "glibc":
            return self.glibc
        if key == "hooks":
            return self.hooks
        if key == "exit":
            return self.exit
        if key == "arena":
            return self.arena
        if key == "alloc":
            return self.alloc
        return None

    @property
    def all(self) -> frozenset[str]:
        """Every tag this fingerprint asserts, structured fields included."""
        out: set[str] = set(self.tags)
        out |= set(self.alloc)
        if self.glibc is not None:
            out |= version_tags(self.glibc)
        if self.hooks:
            out.add(f"hooks_{self.hooks}")
        if self.exit:
            out.add(f"exit_{self.exit}")
        if self.arena:
            out.add(f"{self.arena}_arena")
        # `alloc` is a set of primitives; a cell may name any of them as a
        # requirement, and `has()` consults `self.all` for tags it does not
        # special-case. Both directions must therefore be covered.
        out |= set(self.alloc)
        return frozenset(out)

    @property
    def expanded(self) -> frozenset[str]:
        """Closure under factual implication (version -> derivable tags)."""
        out = set(self.all)
        if self.glibc is not None:
            out |= implied_by_version(self.glibc)
        return frozenset(out)

    def merge(self, other: Fingerprint) -> Fingerprint:
        """Later observations win on scalar fields; tags accumulate."""
        return Fingerprint(
            glibc=other.glibc or self.glibc,
            hooks=other.hooks or self.hooks,
            exit=other.exit or self.exit,
            arena=other.arena or self.arena,
            alloc=frozenset(self.alloc | other.alloc),
            tags=frozenset(self.tags | other.tags),
            observed=self.observed or other.observed,
        )


def parse_version(text: str) -> tuple[int, int] | None:
    m = _GLIBC.search(text)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    m = _UBUNTU.search(text)
    if m:
        rel = (int(m.group(1)), int(m.group(2)))
        return UBUNTU_GLIBC.get(rel, rel if rel[0] >= 2 else None)
    m = _UBUNTU_LTS.search(text)
    if m:
        rel = (int(m.group(1)), int(m.group(2)))
        return UBUNTU_GLIBC.get(rel, rel if rel[0] >= 2 else None)
    return None


def _norm_distro_to_glibc(v: tuple[int, int]) -> tuple[int, int]:
    """ubuntu 18.04 -> 2.27. Distinguish distro releases from libc versions."""
    return UBUNTU_GLIBC.get(v, v)


def parse(texts: list[str], tags: list[str] | None = None) -> Fingerprint:
    """Build a Fingerprint from raw observation text + explicit tags.

    Explicit tags win over text inference (the agent tagging `glibc2.27` is
    asserting harder than a sentence that happens to mention a number).
    """
    tags = [str(t).strip().lower() for t in (tags or []) if str(t).strip()]
    explicit = [t for t in tags if t in KNOWN_TAGS or t.startswith("glibc")]

    glibc: tuple[int, int] | None = None
    for t in tags:  # explicit first
        v = parse_version(t)
        if v:
            glibc = _norm_distro_to_glibc(v)
            break
    if glibc is None:
        blob = " ".join(" ".join(str(t).split()) for t in texts if t)
        v = parse_version(blob)
        if v:
            glibc = _norm_distro_to_glibc(v)

    blob = " ".join(" ".join(str(t).split()).lower() for t in texts if t)
    tagset = set(tags)

    def has(*subs: str) -> bool:
        return any(s in blob for s in subs) or any(s in tagset for s in subs)

    hooks = None
    if has("hooks_dead", "hooks dead", "hook removed", "no __free_hook", "hook 失效", "hooks 失效"):
        hooks = "dead"
    elif has("hooks_alive", "hooks alive", "hook 还在", "hooks exist"):
        hooks = "alive"
    elif glibc is not None:
        hooks = "dead" if glibc >= (2, 34) else "alive"  # derivable, not guessed

    ex = None
    if has("exit_group", "syscall exit", "no stdio flush", "raw exit"):
        ex = "group"
    elif has("exit_flush", "flush_all", "_io_cleanup", "exit triggers", "exit flush", "stdio flush"):
        ex = "flush"

    arena = None
    if has("thread_arena", "thread arena", "pthread"):
        arena = "thread"
    elif has("main_arena", "main arena"):
        arena = "main"

    alloc: set[str] = set()
    for key in ("tcache", "fastbin", "unsorted_bin", "calloc", "tcache_key_random"):
        if has(key):
            alloc.add(key)
    if has("safe_linking") or has("no_safe_linking"):
        alloc.add("safe_linking" if has("safe_linking") and not has("no_safe_linking") else "no_safe_linking")
    elif glibc is not None:
        # Derived from the version, and recorded in `tags` rather than `alloc`:
        # `alloc` means "primitives this target offers", and a cell that
        # requires `safe_linking` is asking about a capability, not a version
        # fact. Writing the derived value into `alloc` made a 2.27 hint assert
        # `no_safe_linking`, which then correctly failed cells that need it —
        # for a reason the agent never observed.
        pass

    known = tagset | {t for t in KNOWN_TAGS if has(t)}
    # `observed` must mean "we parsed something out of this", not "parse() was
    # called". An empty hint list and an empty observation list are a cold
    # start, and the caller keys the opening-measurements path off this flag.
    observed = bool(glibc or hooks or ex or arena or alloc or known or any(str(t).strip() for t in texts))
    fp = Fingerprint(
        glibc=glibc,
        hooks=hooks,
        exit=ex,
        arena=arena,
        alloc=frozenset(alloc),
        tags=frozenset(known),
        observed=observed,
    )
    return fp


EMPTY = Fingerprint(observed=False)
