"""Schema-1 cue extraction, kept only as a fallback for unmigrated cells.

This module is the OLD approach and exists purely so that a cell which has not
been migrated yet still contributes cue overlap instead of silently scoring
zero. New code must not call it; the structured fingerprint and predicates in
`fingerprint.py` / `predicate.py` replace it.

Known defect, deliberately not fixed here (fixing it would mean keeping a
second parser alive): a bare "2.27" anywhere in the text yields glibc2.27.
Migration is the fix.
"""

from __future__ import annotations


def _has(blob: str, *subs: str) -> bool:
    return any(s in blob for s in subs)


def extract_cues(*texts: str) -> set[str]:
    b = " ".join(" ".join(str(t).split()).lower() for t in texts if t)
    t: set[str] = set()
    if _has(b, "18.04", "ubuntu 18", "ubuntu18"):
        t.add("ubuntu18")
    if _has(b, "16.04", "ubuntu 16", "ubuntu16"):
        t.add("ubuntu16")
    if _has(b, "2.23"):
        t.add("glibc2.23")
    if _has(b, "2.27"):
        t.add("glibc2.27")
    if _has(b, "2.44", "2.43", "2.42", "2.41", "2.40", "2.39", "2.38", "2.37", "2.36", "2.35"):
        t.add("glibc2.44")
    if _has(b, ">=2.34", ">= 2.34"):
        t.add("glibc>=2.34")
    if _has(b, "<2.34", "< 2.34", "pre-2.34", "before 2.34"):
        t.add("glibc<2.34")
    if _has(b, "hooks_dead", "hooks dead", "hook removed", "no __free_hook", "hooks 失效"):
        t.add("hooks_dead")
    elif _has(b, "hooks_alive", "hooks alive", "hook 还在"):
        t.add("hooks_alive")
    if _has(b, "thread arena", "thread_arena", "pthread", "heap_max"):
        t.add("thread_arena")
    if _has(b, "main_arena", "main arena") and "thread" not in b:
        t.add("main_arena")
    if _has(b, "exit_group", "syscall exit"):
        t.add("exit_group")
    if _has(b, "flush_all", "_io_cleanup", "exit triggers", "exit flush"):
        t.add("exit_flush")
    if _has(b, "tcache_key", "tcache key"):
        t.add("tcache_key_random")
    if _has(b, "safe-link", "safe_linking", "safe linking"):
        t.add("safe_linking")
    if _has(b, "unsorted bin attack"):
        t.add("unsorted_bin_attack")
    elif _has(b, "unsorted"):
        t.add("unsorted_bin")
    if _has(b, "calloc"):
        t.add("calloc")
    if _has(b, "ptmalloc"):
        t.add("ptmalloc")
    if _has(b, "house of apple", "_io_wfile_jumps"):
        t.add("house_of_apple")
        t.add("fsop")
    if _has(b, "fsop", "_io_str_jumps", "wide_vtable", "wide vtable"):
        t.add("fsop")
    if _has(b, "_io_list_all", "io_list_all"):
        t.add("io_list_all")
    if _has(b, "house of orange"):
        t.add("house_of_orange")
        t.add("top_chunk")
    if _has(b, "house of force"):
        t.add("house_of_force")
    if _has(b, "tcache poison", "tcache poisoning"):
        t.add("tcache_poison")
    if _has(b, "fastbin poison", "fastbin attack"):
        t.add("fastbin_poison")
    if _has(b, "got overwrite", "got-adjacent", "system@plt", "overwrite got"):
        t.add("got_overwrite")
    if _has(b, "top chunk", "top_chunk"):
        t.add("top_chunk")
    if _has(b, "heap leak", "leak heap"):
        t.add("heap_leak")
    if _has(b, "libc leak", "leak libc"):
        t.add("libc_leak")
    if _has(b, "short read", "short-read"):
        t.add("short_read")
    if _has(b, "unlink"):
        t.add("unlink")
    if _has(b, "exhaust", "grow_heap", "new_heap", "64mb"):
        t.add("arena_exhaust")
    return t
