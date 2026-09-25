"""经验产生的**工具层**拒绝。

软提示 vs 硬拒绝的区别是根本的：提示词里的「不要试」是可以被无视的，工具层拒绝
不行。但 `guard.py` 的文件头写着「误拒比漏拒贵得多」—— 误拒不只是挡一条命令，
它把 agent 想探测的信息藏起来了，于是 agent 再探、再被拒，把整个 run 烧在循环里。

所以一条经验要升级成硬拒绝，门槛设得很高，而且要能解释清楚：

  1. 该做法在**当前世界**下从**未成功过**（n_ok == 0）
  2. 失败次数达到阈值
  3. 条件是**非空**的（无条件的失败说明不了任何世界的规律）
  4. 能从中取出一个**可安全匹配的命令词** —— 不是裸词、不是 `<占位符>`、
     不是 `cd`/`timeout`/`python3` 这类一旦拒掉就会毁掉整轮的词

第 4 条会让自动拒绝变得**罕见**，这是刻意的：宁可漏拒，不可误拒。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from aegis.observer.extract import Experience
from aegis.policy.playbook import applies

#: How many observed failures, with zero successes, justify a hard refusal.
VETO_MIN_FAILS = 3
#: Shorter command words are too likely to be substrings of something else.
MIN_PATTERN_LEN = 4

#: Command words that must never be auto-refused. Blocking any of these does not
#: stop one technique, it stops the run: the agent cannot run its exploit, read
#: its output, or pause a command.
NEVER_VETO = frozenset(
    {
        "cd", "timeout", "python", "python3", "python2", "bash", "sh", "zsh",
        "cat", "ls", "echo", "printf", "tee", "head", "tail", "wc", "grep",
        "sed", "awk", "find", "file", "chmod", "cp", "mv", "rm", "mkdir",
        "readelf", "strings", "nm", "ldd", "checksec", "objdump", "gdb",
        "pwntools", "pwninit", "patchelf", "one_gadget", "seccomp-tools",
        "sudo", "env", "export", "source", "which", "test",
    }
)

#: A command word: starts with a letter, no shell metacharacters, no placeholders.
_WORD = re.compile(r"^[A-Za-z][A-Za-z0-9_.+-]*$")
#: Normalised actions look like "pwn: <command>", "bash: <command>".
_ACTION_HEAD = re.compile(r"^(?:pwn|bash):\s*(\S+)")


@dataclass(frozen=True)
class Veto:
    """A refusal derived from experience, with its reason kept for the message."""

    pattern: str
    why: str
    condition: tuple[str, ...]
    n_fail: int

    def reason(self) -> str:
        cond = ",".join(self.condition)
        return (
            f"REFUSED (learned_veto): '{self.pattern}' never succeeded in this world "
            f"(0/{self.n_fail}) @ {cond}. {self.why} "
            "This is a recorded negative experience, not a guess; if you believe the "
            "world changed, observe it again with aegis_observe."
        )


def command_word(action: str) -> str | None:
    """The command word at the head of a normalised action, if it is safe to match."""
    m = _ACTION_HEAD.match(action.strip())
    if not m:
        return None
    word = m.group(1).lstrip("./")
    if not _WORD.match(word) or len(word) < MIN_PATTERN_LEN:
        return None
    if word.lower() in NEVER_VETO:
        return None
    return word


def build(
    experiences: list[Experience],
    world: set[str],
    *,
    min_fails: int = VETO_MIN_FAILS,
) -> list[Veto]:
    """Experiences that justify a hard refusal, for a world we have observed.

    Pure: no IO. Returns an empty list far more often than not, which is the
    intended bias.
    """
    out: list[Veto] = []
    seen: set[str] = set()
    for e in experiences:
        if e.n_ok != 0 or not e.condition or e.n_fail < min_fails:
            continue
        if not applies(e, world):
            continue
        word = command_word(e.action)
        if not word or word in seen:
            continue
        seen.add(word)
        out.append(
            Veto(
                pattern=word,
                why=f"Observed {e.n_fail} failures and no success on: {e.action}",
                condition=e.condition,
                n_fail=e.n_fail,
            )
        )
    out.sort(key=lambda v: v.n_fail, reverse=True)
    return out


def patterns(vetoes: list[Veto]) -> list[str]:
    return [v.pattern for v in vetoes]


def from_state(state_dir, fingerprint_tags=()) -> list[Veto]:
    """Vetoes for the world observed in `state_dir`. Reads experience only."""
    from aegis.observer import pipeline

    world = set(pipeline.world_tags(state_dir)) or {str(t) for t in fingerprint_tags}
    return build(pipeline.experience(state_dir), world)
