"""Protection-integrity checks: a chain that disabled a mitigation is not a chain.

The failure this guards against is a **false positive**, which is the thing the
whole architecture ranks first (`架构.md` §0.1: 压 f+ > 提覆盖 > 降成本). The
concrete shape:

    checksec says ASLR is on. The agent then turns it off locally — sets
    /proc/sys/kernel/randomize_va_space, wraps the target in `setarch -R`, or
    flips `context.aslr = False` in pwntools — gets a shell, and reports
    "solved, local".

That result is worthless twice over:

  * It does not transfer. The remote has ASLR on, so the chain cannot work
    there. Storing it as an ON cell teaches the next run a technique that is
    really "first, disable the mitigation".
  * It corrupts the measurement. `verified=local` is supposed to mean "it
    genuinely worked", and this makes it mean "it worked after I changed the
    question".

The same applies to NX, canary, RELRO and seccomp: patching them away locally
proves nothing about the target.

Two enforcement points, because one is not enough:

  1. **The guard** refuses the commands outright. Necessary but insufficient:
     the agent writes `exp.py` and runs `python3 exp.py`, so the guard sees a
     filename, not the trick inside it.
  2. **Content scanning** of the challenge's own scripts, before they run and
     again at `finish`. This is what actually catches the scripted version.

Reads are always allowed. `cat /proc/sys/kernel/randomize_va_space` and
`context.aslr` are *observations*, and observations are what this system wants.
Only mutation is refused.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

# --------------------------------------------------------------------- rules
#
# Each entry: (id, compiled regex, human explanation).
# Patterns are written to match a MUTATION. A bare mention of
# randomize_va_space, or `setarch x86_64` without -R, must not match.


@dataclass(frozen=True)
class Finding:
    rule: str
    mitigation: str
    where: str
    detail: str

    def line(self) -> str:
        return f"[{self.mitigation}] {self.detail}  ({self.where})"


_RULES: list[tuple[str, re.Pattern[str], str, str]] = [
    # ---- ASLR: writing the sysctl ----------------------------------------
    (
        "aslr_sysctl_write",
        re.compile(
            r"(?:\d?>\s*/proc/sys/kernel/randomize_va_space)"
            r"|(?:tee\s+/proc/sys/kernel/randomize_va_space)"
            r"|(?:sysctl\s+(?:-w|--write)\s+\S*randomize_va_space\s*=\s*0)"
            r"|(?:sysctl\s+\S*randomize_va_space\s*=\s*0)",
            re.I,
        ),
        "ASLR",
        "关闭 ASLR（写 randomize_va_space）",
    ),
    # ---- ASLR: per-process disable ---------------------------------------
    (
        "aslr_setarch",
        re.compile(
            r"setarch\s+(?:[^\s|;&]*\s+)*?(?:-R|--addr-no-randomize)\b"
            r"|(?:^|[\s|;&])(?:linux32|linux64)\s+(?:[^\s|;&]*\s+)*?(?:-R|--addr-no-randomize)\b",
            re.I,
        ),
        "ASLR",
        "关闭 ASLR（setarch -R / --addr-no-randomize）",
    ),
    (
        "aslr_pwntools",
        re.compile(r"\baslr\s*=\s*(?:False|0)\b", re.I),
        "ASLR",
        "关闭 ASLR（pwntools context.aslr = False）",
    ),
    (
        "aslr_personality",
        re.compile(
            r"ADDR_NO_RANDOMIZE"
            r"|personality\s*\(\s*(?:0x\w+|ADDR_NO_RANDOMIZE)",
            re.I,
        ),
        "ASLR",
        "关闭 ASLR（personality(ADDR_NO_RANDOMIZE)）",
    ),
    (
        "aslr_ulimit_stack",
        re.compile(r"ulimit\s+(?:-s|--stack)\s+unlimited", re.I),
        "ASLR",
        "削弱栈随机化（ulimit -s unlimited）",
    ),
    # ---- NX ---------------------------------------------------------------
    (
        "nx_execstack",
        re.compile(
            r"execstack\s+(?:[^\s|;&]*\s+)*?(?:-s|--set-execstack)\b"
            r"|patchelf\s+[^\n|;&]*--clear-execstack",
            re.I,
        ),
        "NX",
        "关闭 NX（execstack -s / patchelf --clear-execstack）",
    ),
    # ---- binary self-patching --------------------------------------------
    (
        "binary_patch_mitigation",
        re.compile(
            r"patchelf\s+[^\n|;&]*--(?:no-)?(?:pie|now|relro|execstack)\b"
            r"|(?:sed|perl|python3?)\s+[^\n|;&]*\bELF\b[^\n|;&]*\b(?:write|patch)\b",
            re.I,
        ),
        "ELF flags",
        "改写题目二进制的保护标志（PIE/RELRO/NX）",
    ),
    # ---- seccomp ----------------------------------------------------------
    (
        "seccomp_disable",
        re.compile(
            # The write may be spelled before or after the path, and may go
            # through tee instead of a redirect.
            r"\d?>\s*/proc/sys/kernel/seccomp"
            r"|/proc/sys/kernel/seccomp[^\n|;&]*\d?>"
            r"|tee\s+/proc/sys/kernel/seccomp"
            r"|sysctl\s+(?:-w|--write)\s+\S*seccomp\S*\s*=\s*0",
            re.I,
        ),
        "seccomp",
        "关闭 seccomp",
    ),
]

# A read is not a mutation. These suppress a match on the same line.
# A read is not a mutation. Note `sysctl -w` is explicitly NOT read-only:
# treating it as one let `sysctl -w kernel.randomize_va_space=0` through.
_READ_ONLY = re.compile(
    r"^\s*(?:cat|less|head|tail|xxd|od|grep|strings|stat|file)\b"
    # `sysctl <name>` reads; `sysctl <name>=<value>` and `sysctl -w` write.
    r"|^\s*sysctl\s+(?!-w\b|--write\b)(?=[^=]*$)"
    r"|context\.aslr\s*$",
    re.I,
)


def scan_text(text: str, where: str = "text") -> list[Finding]:
    """Find mitigation-weakening mutations inside a command or a file body."""
    if not text:
        return []
    findings: list[Finding] = []
    seen: set[str] = set()
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # Strip a trailing comment so an explanation of the trick is not a hit.
        code = line.split("#", 1)[0]
        if not code.strip():
            continue
        if _READ_ONLY.match(code):
            continue
        for rule_id, pat, mitigation, detail in _RULES:
            if rule_id in seen:
                continue
            if pat.search(code):
                findings.append(
                    Finding(rule=rule_id, mitigation=mitigation, where=f"{where}:{lineno}", detail=detail)
                )
                seen.add(rule_id)
    return findings


def scan_command(command: str) -> list[Finding]:
    """Findings in a shell command line."""
    return scan_text(command, where="command")


SCRIPT_SUFFIXES = (".py", ".sh", ".sage", ".rb", ".pl")


def scan_tree(root: Path, *, max_bytes: int = 200_000) -> list[Finding]:
    """Scan the challenge's own scripts, which is where the trick usually hides.

    The guard inspects commands, so `python3 exp.py` looks innocent; the
    `context.aslr = False` is one line inside the file. This is the check that
    actually closes that gap.
    """
    if not root.is_dir():
        return []
    findings: list[Finding] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in SCRIPT_SUFFIXES:
            continue
        try:
            if path.stat().st_size > max_bytes:
                continue
            body = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        findings.extend(scan_text(body, where=path.name))
    return findings


def summarise(findings: list[Finding]) -> str:
    """One short block explaining what was found and why it invalidates a solve."""
    if not findings:
        return ""
    by_mit = sorted({f.mitigation for f in findings})
    lines = [
        "检测到通过**削弱本地保护**来打通的做法，这不算打通：",
        "",
    ]
    for f in findings[:8]:
        lines.append(f"  - {f.line()}")
    if len(findings) > 8:
        lines.append(f"  … 另有 {len(findings) - 8} 处")
    lines += [
        "",
        f"涉及: {', '.join(by_mit)}",
        "",
        "为什么不算：关掉 ASLR/NX 之后拿到的 shell 依赖的是**我们改过的环境**，不是题目本身。",
        "远程没有这些改动，所以这条链上不了远程；把它当成经验存下来，只会教下一轮",
        "「先关保护再打」。本地验证的「通」必须是题目原样下的通。",
        "",
        "要恢复确定性调试，用 `gdb -batch`（它只影响那一次调试会话），",
        "不要在 exp 里改保护，也不要改 /proc 或 /sys。",
    ]
    return "\n".join(lines)
