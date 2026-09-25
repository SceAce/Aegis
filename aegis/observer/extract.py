"""Observer —— 公共黑板的唯一写入者。

两条硬约束（来自设计，不是风格）：

1. **记忆由 Observer 从 worker 的事件日志里机械抽取，不由 LLM 写入。**
   所以本模块只做字段提取与机械配对，**不做语义解释**。
   上一轮的假阳性来自"让 LLM 从散文里再抽一次结构"；这条路被去掉了。

2. **记忆不驱动行动。** 本模块产出的任何东西都不得进入 worker 的上下文，
   也不得出现在 system prompt 里。只有从记忆**提纯**出来的「经验」才允许
   影响行为（见 distill）。这条是可以用测试断言的，不靠自觉。

数据来源：worker 自己写的 JSONL 日志。目前只有一个 adapter（Pi 会话日志）。
换 worker（Codex / DSH）时只加 adapter，Observer 与下游都不变。
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from aegis.core.events import Event

__all__ = [
    "CUSTOM_PREFIX",
    "SESSIONS_ROOT",
    "SUPPORTED_SESSION_VERSION",
    "Event",
    "Experience",
    "MemoryRecord",
    "build_memory",
    "discover_sessions",
    "distill",
    "observe",
    "portable",
    "read_pi_session",
]

# Pi 会话文件的 header.version。格式变了必须**大声失败**，不能静默按旧格式解析 ——
# 静默误解析正是上一轮"世界模型解析反了"的根因。
SUPPORTED_SESSION_VERSION = 3

SESSIONS_ROOT = Path.home() / ".pi" / "agent" / "sessions"

# Observer 认得的自定义 entry 前缀（扩展用它把结构化事件写进同一个会话文件）。
CUSTOM_PREFIX = "aegis."


# --------------------------------------------------------------------- memory


@dataclass(frozen=True)
class MemoryRecord:
    """一次动作 + 它的结果。**具体、无解释**。

    这里存的是"发生了什么"，不是"这意味着什么"。后者属于经验层。
    """

    worker: str
    session: str
    seq: int
    ts: str
    tool: str
    action: str
    ok: bool | None
    out_chars: int
    out_digest: str
    condition: tuple[str, ...] = ()


@dataclass(frozen=True)
class Experience:
    """从记忆提纯出来的**可迁移**判据：条件 -> 动作 -> 结果分布。

    与记忆的区别：动作被去掉了本题数字（见 portable），条件只保留机制标签。
    所以它才配驱动行为；记忆不配。
    """

    condition: tuple[str, ...]
    action: str
    n_ok: int
    n_fail: int

    @property
    def n(self) -> int:
        return self.n_ok + self.n_fail


# --------------------------------------------------------------------- adapter


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for blk in content:
        if isinstance(blk, dict) and blk.get("type") == "text":
            parts.append(str(blk.get("text") or ""))
        elif isinstance(blk, str):
            parts.append(blk)
    return "".join(parts)


def _digest(text: str) -> str:
    return "sha1:" + hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()[:12]


def _action_of(tool: str, args: Any) -> str:
    """把一次调用压成一行**具体**的动作描述（记忆层，可以带本题细节）。"""
    if not isinstance(args, dict):
        return f"{tool} {str(args)[:200]}"
    if tool == "aegis_pwn":
        return f"pwn: {str(args.get('command') or '')[:200]}"
    if tool == "aegis_shell":
        act = str(args.get("action") or "send")
        txt = str(args.get("text") or "")[:160]
        return f"shell[{act}]: {txt}"
    if tool == "aegis_observe":
        tags = ",".join(str(t) for t in (args.get("tags") or []))
        return f"observe: {str(args.get('text') or '')[:120]} tags={tags}"
    if tool in ("read", "write", "edit"):
        return f"{tool}: {args.get('path') or args.get('file_path') or ''}"
    if tool == "bash":
        return f"bash: {str(args.get('command') or '')[:200]}"
    return f"{tool}: {json.dumps(args, ensure_ascii=False)[:200]}"


def read_pi_session(path: Path) -> Iterator[Event]:
    """Pi 会话 JSONL -> 归一化事件流。

    只认三种东西：worker 的 toolCall、对应的 toolResult、扩展写的结构化 entry。
    assistant 的散文与 thinking **不进记忆**（它们是解释，不是事件）。
    """
    session = path.stem
    seq = 0
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            # 一行坏了不该让整条流失败；但也绝不假装它不存在。
            seq += 1
            yield Event("pi", session, seq, "", "note", data={"malformed": raw[:200]})
            continue

        etype = entry.get("type")

        if etype == "session":
            version = entry.get("version")
            if version != SUPPORTED_SESSION_VERSION:
                raise RuntimeError(
                    f"Pi session format v{version} is not v{SUPPORTED_SESSION_VERSION}; "
                    "the Observer adapter must be updated instead of guessing."
                )
            continue

        if etype == "custom":
            data = entry.get("data")
            if not isinstance(data, dict):
                continue
            ctype = str(entry.get("customType") or "")
            if not ctype.startswith(CUSTOM_PREFIX):
                continue
            seq += 1
            yield Event(
                "pi",
                session,
                seq,
                str(entry.get("timestamp") or ""),
                str(data.get("kind") or "note"),
                tool=data.get("tool") or None,
                call_id=data.get("callId") or None,
                data=data,
            )
            continue

        if etype != "message":
            continue

        msg = entry.get("message")
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        ts = str(entry.get("timestamp") or msg.get("timestamp") or "")

        if role == "assistant":
            for blk in msg.get("content") or []:
                if isinstance(blk, dict) and blk.get("type") == "toolCall":
                    seq += 1
                    name = str(blk.get("name") or "?")
                    yield Event(
                        "pi",
                        session,
                        seq,
                        ts,
                        "action",
                        tool=name,
                        call_id=str(blk.get("id") or "") or None,
                        data={"args": blk.get("arguments")},
                    )
        elif role == "toolResult":
            seq += 1
            text = _text_of(msg.get("content"))
            yield Event(
                "pi",
                session,
                seq,
                ts,
                "outcome",
                tool=str(msg.get("toolName") or "?"),
                call_id=str(msg.get("toolCallId") or "") or None,
                ok=not bool(msg.get("isError")),
                data={
                    "text": text,
                    "chars": len(text),
                    "digest": _digest(text),
                },
            )


# ---------------------------------------------------------------------- memory


#: Tools whose arguments carry a structured world observation.
_OBSERVE_TOOLS = ("aegis_observe", "aegis_note")

#: Tags that cannot both hold in one world.
#:
#: Observations accumulate per session, but a session that first probed a
#: container (glibc 2.44) and then a remote host (2.27) would otherwise produce a
#: condition of "hooks_alive AND hooks_dead" — a world that never existed, which
#: matches nothing and silently qualifies experience for the wrong target. A
#: later observation supersedes an earlier, contradictory one.
_EXCLUSIVE: tuple[frozenset[str], ...] = (
    frozenset({"hooks_alive", "hooks_dead"}),
    frozenset({"main_arena", "thread_arena"}),
    frozenset({"exit_group", "exit_flush"}),
    frozenset({"safe_linking", "no_safe_linking"}),
    frozenset({"pie", "non_pie"}),
    frozenset({"full_relro", "partial_relro"}),
    frozenset({"tcache", "no_tcache"}),
)
_GLIBC_TAG = re.compile(r"^glibc\d+\.\d+$")


def reconcile(world: set[str], asserted: set[str]) -> set[str]:
    """Fold new observations into a world, letting the newer one win a conflict.

    Only contradicts what was *asserted now*; a conflict between two older tags
    with nothing new said about it is left alone, because there is no basis to
    choose between them.
    """
    out = set(world) | set(asserted)
    for group in _EXCLUSIVE:
        present = out & group
        if len(present) > 1:
            fresh = present & asserted
            if fresh:
                out -= present - fresh

    versions = {t for t in out if _GLIBC_TAG.match(t)}
    if len(versions) > 1:
        fresh = versions & asserted
        if fresh:
            out -= versions - fresh
    return out


def observed_tags(tool: str, args: Any) -> set[str]:
    """World tags a call asserts, from its **structured** arguments.

    Only declared tags count. Nothing here parses prose: recovering a world model
    from free text is what produced `no pthread` -> `arena=thread` before, and an
    injected wrong world is worse than no world.
    """
    if tool not in _OBSERVE_TOOLS or not isinstance(args, dict):
        return set()
    raw = args.get("tags")
    if not isinstance(raw, (list, tuple)):
        return set()
    return {str(t).strip() for t in raw if str(t).strip()}


def build_memory(events: list[Event]) -> list[MemoryRecord]:
    """机械配对 action 与 outcome，并给每条动作附上**当时已观测到的世界**。

    The condition is the set of tags observed *before* the action ran, so a later
    observation cannot retroactively explain an earlier attempt. Records with an
    empty condition are kept: "we tried this knowing nothing" is information.
    """
    outcomes: dict[str, Event] = {}
    for e in events:
        if e.kind == "outcome" and e.call_id:
            outcomes[e.call_id] = e

    records: list[MemoryRecord] = []
    world: set[str] = set()
    for e in events:
        if e.kind == "observation":
            raw = (e.data or {}).get("tags")
            if isinstance(raw, (list, tuple)):
                fresh = {str(t).strip() for t in raw if str(t).strip()}
                world = reconcile(world, fresh)
            continue
        if e.kind != "action":
            continue

        tool = str(e.tool or "?")
        args = (e.data or {}).get("args")
        out = outcomes.get(e.call_id or "")
        text = str((out.data or {}).get("text") or "") if out else ""
        records.append(
            MemoryRecord(
                worker=e.worker,
                session=e.session,
                seq=e.seq,
                ts=e.ts,
                tool=tool,
                action=_action_of(tool, args),
                # `ok` is the tool-level signal carried on the outcome event. It
                # records "the tool did not fail", NOT "the goal advanced" —
                # whether a run advanced is decided by the criterion.
                ok=None if out is None else out.ok,
                out_chars=len(text),
                out_digest=str((out.data or {}).get("digest") or "") if out else "",
                condition=tuple(sorted(world)),
            )
        )
        # An observation takes effect for the NEXT action, not this one.
        world = reconcile(world, observed_tags(tool, args))
    return records


# -------------------------------------------------------------------- distill

_HEX = re.compile(r"\b0x[0-9a-fA-F]+\b")
_HEXNAME = re.compile(r"\b[0-9a-fA-F]{16,}\b")  # sha256 之类的 artifact 名
_ABS = re.compile(r"(?:/[\w.\-]+){2,}")  # 绝对路径
_CHAL = re.compile(r"\b(?:pwn|re|cp|crypto|misc)_\d+\b", re.I)
_NUM = re.compile(r"\b\d{2,}\b")
_WS = re.compile(r"\s+")


def portable(action: str) -> str:
    """把动作里的**本题细节**抹掉，只留下可迁移的形状。

    记忆可以具体（带地址、路径、artifact 名），经验不行 —— 经验要跨题。
    实测这条一开始漏了三类，会让"同一条经验"按题分裂成很多条：
    64 位 hex artifact 名、绝对路径、题名（`pwn_1`）。
    """
    s = _CHAL.sub("<challenge>", action)
    s = _ABS.sub("<path>", s)
    s = _HEX.sub("<addr>", s)
    s = _HEXNAME.sub("<hex>", s)
    s = _NUM.sub("<n>", s)
    return _WS.sub(" ", s).strip()[:160]


def distill(records: list[MemoryRecord], condition: tuple[str, ...] = ()) -> list[Experience]:
    """记忆 -> 经验：按（可迁移动作）计数，不做任何生成。

    这里不调 LLM。一次成功与一次失败都只是 +1，所以不可能凭空长出经验。
    """
    agg: dict[tuple[tuple[str, ...], str], list[int]] = {}
    for r in records:
        # An observation is not a technique. Counting `observe: ... tags=...` as
        # experience would pad the playbook with the act of measuring, which is
        # not something to recommend doing again -- it is the precondition.
        if r.tool in _OBSERVE_TOOLS:
            continue
        key = (r.condition or condition, portable(r.action))
        slot = agg.setdefault(key, [0, 0])
        if r.ok is True:
            slot[0] += 1
        elif r.ok is False:
            slot[1] += 1
    return [
        Experience(condition=cond, action=act, n_ok=ok, n_fail=fail)
        for (cond, act), (ok, fail) in sorted(agg.items(), key=lambda kv: -(kv[1][0] + kv[1][1]))
    ]


# --------------------------------------------------------------------- discovery


def discover_sessions(cwd: Path, root: Path = SESSIONS_ROOT) -> list[Path]:
    """找出属于某个工作目录的所有 worker 会话日志（按时间排序）。

    按 header.cwd 匹配而不是按目录名猜 —— 目录名的转义规则是 Pi 的实现细节。
    """
    if not root.is_dir():
        return []
    want = str(cwd.resolve())
    found: list[tuple[str, Path]] = []
    for p in root.glob("*/*.jsonl"):
        try:
            with p.open("r", encoding="utf-8", errors="replace") as fh:
                head = fh.readline()
            entry = json.loads(head)
        except (OSError, json.JSONDecodeError):
            continue
        if entry.get("type") == "session" and entry.get("cwd") == want:
            found.append((str(entry.get("timestamp") or ""), p))
    return [p for _, p in sorted(found)]


def observe(cwd: Path, root: Path = SESSIONS_ROOT) -> tuple[list[Event], list[MemoryRecord]]:
    """跑一遍 Observer：读全部会话日志 -> 事件流 + 记忆 + 经验。"""
    events: list[Event] = []
    for path in discover_sessions(cwd, root):
        events.extend(read_pi_session(path))
    return events, build_memory(events)
