from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import time

from aegis.compile import compile_from_store, compile_run
from aegis.dockerutil import discover
from aegis.dockerutil import pick as pick_channel
from aegis.dockerutil import probe_tools, push_to_remote, pwn_exec, sync_to_container
from aegis.guard import refuse_reason
from aegis.gitutil import restore_challenge
from aegis.intervene import Kind, decide, render
from aegis.paths import (
    CONTAINER,
    PI_SCRIPT,
    PWN_START,
    RAM_TOOLS_PATH,
    ROM_PATH,
    ROOT,
    challenge_dir,
    infer_kind,
    list_challenges,
)
from aegis.store import (
    _portable_technique,
    active_denies,
    add_observation,
    append_episode,
    append_issue,
    build_bundle,
    clear_current,
    current_fingerprint,
    load_current,
    now_iso,
    ram_blob,
    save_current,
)
from aegis.writeup import list_writeups, write_writeup


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aegis", description="Aegis demo harness")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", help="Check pi / channels / git / challenges")
    sub.add_parser("list", help="List challenges and runs")

    p_start = sub.add_parser(
        "start", help="Prepare one challenge: git restore + reset-sync + pwninit + current"
    )
    p_start.add_argument("challenge")
    p_start.add_argument("--hint", action="append", default=[], help="Human hint (repeatable)")

    p_run = sub.add_parser("run", help="Non-interactive: pi -p on one challenge")
    p_run.add_argument("challenge")
    p_run.add_argument("--timeout", type=int, default=1800)
    p_run.add_argument("--hint", action="append", default=[], help="Human hint (repeatable)")

    p_finish = sub.add_parser("finish", help="Write WP, compile memory, restore test/")
    p_finish.add_argument("--status", default="solved", choices=["solved", "failed", "timeout"])
    p_finish.add_argument("--chain", default="")
    p_finish.add_argument("--stuck", default="")
    p_finish.add_argument("--extra", default="")
    p_finish.add_argument("--elapsed", type=float, default=None)
    p_finish.add_argument(
        "--verified",
        default="local",
        choices=["flag", "local", "none"],
        help="flag = a flag / remote-verifiable outcome was obtained; local = ran locally only. "
        "Cells from an unverified run are stored OFF.",
    )

    p_note = sub.add_parser("note", help="Append an episode (called from Pi tool)")
    p_note.add_argument("--kind", required=True)
    p_note.add_argument("--text", required=True)
    p_note.add_argument("--technique", default="")
    p_note.add_argument("--condition", default="")

    p_recall = sub.add_parser("recall", help="Dump compiled RAM blob")
    p_recall.add_argument("--kind", default="")

    p_pwn = sub.add_parser("pwn", help="Run one command on the execution channel (one-shot)")
    p_pwn.add_argument("command")
    p_pwn.add_argument("--timeout", type=int, default=20)
    p_pwn.add_argument("--channel", default="", help="container | remote (default: auto)")

    p_env = sub.add_parser("env", help="Show execution channel(s) and available tools")
    p_env.add_argument("--probe", action="store_true", help="Probe installed tools (one round trip)")
    p_env.add_argument("--json", action="store_true")

    p_deny = sub.add_parser("deny", help="Check a command against tool-level refusals (no exec)")
    p_deny.add_argument("command")

    p_ram = sub.add_parser("ram", help="Print ROM+RAM text for the Pi extension")
    p_ram.add_argument("--kind", default="")
    p_ram.add_argument(
        "--no-experience",
        action="store_true",
        help=(
            "Print ROM + TOOLS only, without the activated experience column. "
            "This is the control arm of the experience experiment: the agent "
            "keeps every convention, tool and guard rule, and only the "
            "activated experience is withheld."
        ),
    )

    p_hint = sub.add_parser("hint", help="Inject a human hint into the current challenge (RAM)")
    p_hint.add_argument("text")

    p_obs = sub.add_parser(
        "observe",
        help="Record something THIS run has seen; only this feeds the fingerprint",
    )
    p_obs.add_argument("text")
    p_obs.add_argument(
        "--tag",
        action="append",
        default=[],
        help="Mechanism tag, repeatable (glibc2.27 / hooks_dead / thread_arena / exit_group ...)",
    )
    p_obs.add_argument("--kind", default="observe")

    p_compile = sub.add_parser("compile", help="Re-run automatic experience compile for a challenge")
    p_compile.add_argument("challenge")

    p_wiki = sub.add_parser("wiki", help="Fetch CTF Wiki (raw) and compile mechanism-level experience")
    p_wiki.add_argument("action", choices=["fetch", "list", "compile"])
    p_wiki.add_argument("--limit", type=int, default=0, help="compile at most N new pages (0 = all)")
    p_wiki.add_argument("--force", action="store_true", help="recompile pages already done")

    p_kb = sub.add_parser(
        "kb",
        help="Consult the knowledge base (CTF Wiki). This is reference material, not verified experience",
    )
    p_kb.add_argument("query", help="What you want to look up")
    p_kb.add_argument("-k", type=int, default=6, help="max items (default 6)")

    p_iv = sub.add_parser(
        "intervene",
        help="Decide whether memory should intervene at this trigger point",
    )
    p_iv.add_argument(
        "--trigger",
        default="observe",
        choices=["opening", "observe", "refuse", "repeat", "stuck"],
    )
    p_iv.add_argument("--trajectory", default="", help="Recent trajectory text (for the LLM layer)")
    p_iv.add_argument("--llm", action="store_true", help="Enable the LLM intervention layer")
    p_iv.add_argument("--json", action="store_true", help="Emit the decision record as JSON")

    p_expl = sub.add_parser("explain", help="Why did (or didn't) a cell activate? Reads status.json")
    p_expl.add_argument("--tau", type=float, default=None)
    p_expl.add_argument("--top", type=int, default=12)

    p_mig = sub.add_parser("migrate", help="Convert schema-1 atlas cells to structured predicates")
    p_mig.add_argument("--dry-run", action="store_true")
    p_mig.add_argument("--no-llm", action="store_true", help="Skip the LLM residue pass")

    p_shell = sub.add_parser(
        "shell",
        help="Persistent interactive session on the channel (for gdb/r2 and adaptive debugging)",
    )
    p_shell.add_argument(
        "action",
        choices=["start", "send", "read", "capture", "panes", "interrupt", "reset", "stop", "status"],
        help="send = type a line and read; read = drain new output only",
    )
    p_shell.add_argument("text", nargs="?", default="", help="for action=send")
    p_shell.add_argument("--timeout", type=float, default=20.0)
    p_shell.add_argument("--channel", default="")
    p_shell.add_argument(
        "--pane",
        default="",
        help="tmux pane id (%%0, %%%%1, ...) for send/capture/interrupt; default = active pane",
    )

    sub.add_parser("purge", help="Drop non-portable cells (raw addresses / chunk sizes) from the atlas")

    p_docker = sub.add_parser(
        "docker", help="Ensure the fallback docker container is up (idempotent)"
    )
    p_docker.add_argument("--rebuild", action="store_true", help="Force-rebuild the image")
    p_docker.add_argument(
        "action",
        nargs="?",
        default="up",
        choices=["up", "status"],
        help="up = start.sh; status = inspect only",
    )

    args = parser.parse_args(argv)
    handlers = {
        "doctor": cmd_doctor,
        "list": cmd_list,
        "start": lambda: cmd_start(args.challenge, args.hint),
        "run": lambda: cmd_run(args.challenge, args.timeout, args.hint),
        "hint": lambda: cmd_hint(args.text),
        "observe": lambda: cmd_observe(args.text, args.tag, args.kind),
        "finish": lambda: cmd_finish(
            args.status, args.chain, args.stuck, args.extra, args.elapsed, args.verified
        ),
        "purge": cmd_purge,
        "note": lambda: cmd_note(args.kind, args.text, args.technique, args.condition),
        "recall": lambda: cmd_recall(args.kind),
        "pwn": lambda: cmd_pwn(args.command, args.timeout, args.channel),
        "env": lambda: cmd_env(args.probe, args.json),
        "deny": lambda: cmd_deny(args.command),
        "ram": lambda: cmd_ram(args.kind, args.no_experience),
        "compile": lambda: cmd_compile(args.challenge),
        "wiki": lambda: cmd_wiki(args.action, args.limit, args.force),
        "kb": lambda: cmd_kb(args.query, args.k),
        "intervene": lambda: cmd_intervene(args.trigger, args.trajectory, args.llm, args.json),
        "explain": lambda: cmd_explain(args.tau, args.top),
        "migrate": lambda: cmd_migrate(args.dry_run, not args.no_llm),
        "shell": lambda: cmd_shell(args.action, args.text, args.timeout, args.channel, args.pane),
        "docker": lambda: cmd_docker(args.action, args.rebuild),
    }
    return handlers[args.cmd]()


def _pwn_status() -> tuple[bool, str]:
    proc = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Status}} {{.Config.Image}}", CONTAINER],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return False, proc.stderr.strip() or "container pwn not found"
    return True, proc.stdout.strip()


def cmd_docker(action: str, rebuild: bool) -> int:
    if action == "status":
        ok, msg = _pwn_status()
        print(msg)
        return 0 if ok and msg.startswith("running") else 1
    if not PWN_START.is_file():
        print(f"missing {PWN_START}", file=sys.stderr)
        return 1
    cmd = [str(PWN_START)]
    if rebuild:
        cmd.append("--rebuild")
    print(f"+ {' '.join(cmd)}")
    proc = subprocess.run(cmd, check=False)
    if proc.returncode != 0:
        return proc.returncode
    ok, msg = _pwn_status()
    print("pwn:", msg)
    return 0 if ok else 1


def cmd_doctor() -> int:
    ok = True

    def check(label: str, cond: bool, hint: str = "") -> None:
        nonlocal ok
        mark = "ok" if cond else "MISSING"
        extra = f"  ({hint})" if hint and not cond else ""
        print(f"[{mark}] {label}{extra}")
        if not cond:
            ok = False

    check("git repo", (ROOT / ".git").is_dir(), str(ROOT))
    check("uv", shutil.which("uv") is not None)
    check("pi-test.sh", PI_SCRIPT.is_file(), str(PI_SCRIPT))
    check("ROM", ROM_PATH.is_file())
    check("RAM tools", RAM_TOOLS_PATH.is_file())
    chals = list_challenges()
    check(f"test/ challenges ({len(chals)})", len(chals) > 0, ",".join(chals))

    # The execution channel is what actually matters; docker is only a fallback.
    channels = discover()
    chosen = pick_channel()
    # A dead *fallback* is a warning, not a failure: as long as one channel
    # works the harness is usable, and failing doctor on the unused one would
    # just teach people to ignore it.
    for name, ch in channels.items():
        label = f"channel {name} ({ch.kind}:{ch.target})"
        if ch.name == chosen.name:
            check(label + " <- in use", ch.available, ch.detail)
        elif ch.available:
            check(label, True)
        else:
            print(f"[warn] {label} unavailable ({ch.detail[:80]})")
    if not chosen.available:
        check("any usable channel", False, "start the container or check the remote host")

    print()
    print("challenges:", ", ".join(chals) or "(none)")
    print(f"channel:    {chosen.label()}  workdir={chosen.dir_for('<id>')}")
    print("model: deepseek / deepseek-flash")
    print("after accept: you push; harness only commits locally when asked")
    return 0 if ok else 1


def cmd_list() -> int:
    print("challenges:")
    for name in list_challenges():
        print(f"  {name}  kind={infer_kind(name)}")
    print("writeups (time-sorted):")
    for p in list_writeups():
        print(f"  {p.name}")
    cur = load_current()
    print("current:", json.dumps(cur, ensure_ascii=False) if cur else "(none)")
    return 0


def _detect_challenge_binary(challenge: str, ch) -> str:
    """The题目 binary to hand to pwninit.

    Names are not reliable (pwn_1's is a sha256), so it is detected: the first
    ELF at the top level that is not a shared library.
    """
    from aegis.dockerutil import pwn_exec

    probe = (
        "for f in *; do "
        "[ -f \"$f\" ] || continue; "
        "case \"$f\" in libc*|ld-*|*.so|*.so.*) continue;; esac; "
        "head -c4 \"$f\" 2>/dev/null | grep -q ELF && { echo \"$f\"; break; }; "
        "done"
    )
    res = pwn_exec(challenge, probe, timeout=30, channel=ch)
    return str(res.get("stdout") or "").strip().splitlines()[-1].strip() if res.get("stdout") else ""


def _bootstrap_challenge(challenge: str, ch) -> str:
    """Run the challenge's preparation tool on the channel.

    `pwninit` is the project's prep step: it restores the executable bit, runs
    checksec, generates a starter exp.py, and can repoint ld/libc. Doing it here
    rather than leaving it to the agent means the first thing the agent sees is
    a prepared challenge, and the checksec facts it would otherwise spend turns
    discovering are already on screen.

    Failures are reported, never fatal: a challenge that pwninit cannot handle
    is still solvable, just without the head start.
    """
    if infer_kind(challenge) != "pwn":
        return ""
    from aegis.dockerutil import pwn_exec

    binary = _detect_challenge_binary(challenge, ch)
    if not binary:
        print("prep: no ELF binary found; skipping pwninit", file=sys.stderr)
        return ""
    print(f"prep: pwninit {binary}")
    # `2>&1` so the two streams arrive interleaved in their real order:
    # captured separately, checksec's block (which pwninit sends to stderr)
    # lands after the progress lines and reads as if it belonged to the end.
    res = pwn_exec(challenge, f"pwninit {shlex.quote(binary)} 2>&1", timeout=120, channel=ch)
    # Both streams: pwninit routes checksec through stderr, and the protection
    # summary is the most valuable thing this step produces — printing only
    # stdout left two bare separator lines where the facts should be.
    text = str(res.get("stdout") or "").strip()
    if text:
        print(text)
    extra = str(res.get("stderr") or "").strip()
    if extra:
        print(extra)
    if int(res.get("returncode") or 0) != 0:
        print(f"prep: pwninit 退出码 {res.get('returncode')}", file=sys.stderr)
    return text


def _protection_facts(prep_output: str) -> dict[str, str]:
    """Map a checksec block onto mechanism tags the fingerprint understands.

    Only tags the fingerprint actually knows are emitted, so a checksec version
    that prints something new cannot silently poison the world model.
    """
    text = prep_output or ""
    low = text.lower()
    out: dict[str, str] = {}
    # Case-insensitive on purpose. The pwntools checksec banner capitalises its
    # values ("Canary Found", "PIE Enabled") while older checksec output uses
    # lower case ("Canary found", "PIE enabled"). Matching case-sensitively
    # silently dropped both tags, so the fingerprint claimed we had not observed
    # a canary or PIE that checksec had just printed.
    if "full relro" in low or "partial relro" in low:
        out["full_relro"] = "Full RELRO" if "full relro" in low else "Partial"
    # "No canary found" contains "canary found", so the negative must be tested
    # first or an unprotected binary would be recorded as canary-protected.
    if "no canary" not in low and "canary found" in low:
        out["canary"] = "found"
    if "nx enabled" in low:
        out["nx"] = "enabled"
    if "no pie" in low:
        out["non_pie"] = "no-pie"
    elif "pie enabled" in low:
        out["pie"] = "enabled"
    return out


def cmd_start(challenge: str, hints: list[str] | None = None) -> int:
    if challenge not in list_challenges():
        print(f"unknown challenge: {challenge}", file=sys.stderr)
        return 2
    restore_challenge(challenge)
    # Push through the channel abstraction, not the legacy local mirror: the
    # primary channel is the remote host, and its workdir is not the docker
    # path. Failures are reported rather than raised, so `start` still records
    # the run and the agent can see why the files are missing.
    ch = pick_channel()
    pushed = True
    if not ch.available:
        pushed = False
        print(f"WARNING: no execution channel ({ch.detail})", file=sys.stderr)
    elif ch.kind == "ssh":
        # reset=True: a new run must not inherit anything the previous one left
        # on the channel. Mid-run syncs are merges and preserve channel work.
        pushed = push_to_remote(challenge, ch, reset=True)
    else:
        try:
            sync_to_container(challenge, ch)
        except OSError as exc:
            pushed = False
            print(f"WARNING: sync failed: {exc}", file=sys.stderr)
    if ch.available and not pushed:
        print(
            f"WARNING: could not mirror test/{challenge} to {ch.label()}; "
            "commands may see missing or stale files",
            file=sys.stderr,
        )
    prep_output = ""
    if ch.available and pushed:
        # Only after a successful reset push: the prep tool must see the
        # pristine challenge, not a half-synced directory.
        prep_output = _bootstrap_challenge(challenge, ch)
    hints = [h.strip() for h in (hints or []) if h.strip()]
    save_current(
        {
            "challenge": challenge,
            "kind": infer_kind(challenge),
            "started_at": now_iso(),
            "t0": time.time(),
            "hints": hints,
            "observations": [],
            "fingerprint": [],
        }
    )
    for text in hints:
        append_episode(challenge=challenge, kind="hint", text=text)

    # The prep tool's checksec block is an observation of the target, made by
    # the harness on the agent's behalf. Recording it means protection-based
    # cells can activate immediately instead of the agent spending a turn
    # rediscovering facts the setup already printed.
    facts = _protection_facts(prep_output)
    if facts:
        try:
            add_observation(
                "pwninit/checksec: " + ", ".join(f"{k}={v}" for k, v in facts.items()),
                tags=list(facts),
            )
        except RuntimeError:
            pass
    print(f"started {challenge}")
    print(f"host:    {ROOT / 'test' / challenge}")
    print(f"channel: {ch.label()}")
    print(f"workdir: {ch.dir_for(challenge)}")
    if hints:
        print("hints:")
        for text in hints:
            print(f"  - {text}")
    # Print the entry point that actually exists. There is no `pi` binary here:
    # the agent is a source checkout driven through pi-test.sh, so a hint saying
    # `pi --approve ...` failed with "command not found".
    print("下一步（二选一）:")
    print(f"  # A. 交互式，能实时看它在干什么")
    print(
        f"  AEGIS_CHALLENGE={challenge} {PI_SCRIPT} --approve "
        f"--provider deepseek --model deepseek-flash \\"
    )
    print(f"      \"Solve test/{challenge}. Follow the ROM. Call aegis_finish when done.\"")
    print()
    print(f"  # B. 非交互一键（自动 start + finish + 编译）")
    print(f"  uv run aegis run {challenge} --timeout 1800")
    return 0


def cmd_hint(text: str) -> int:
    cur = load_current()
    if not cur:
        print("no current challenge; run aegis start <id> first", file=sys.stderr)
        return 2
    text = text.strip()
    if not text:
        print("empty hint", file=sys.stderr)
        return 2
    hints = list(cur.get("hints") or [])
    hints.append(text)
    cur["hints"] = hints
    save_current(cur)
    append_episode(challenge=cur.get("challenge"), kind="hint", text=text)
    print(f"hint recorded ({len(hints)} total)")
    return 0


def cmd_observe(text: str, tags: list[str] | None, kind: str) -> int:
    try:
        row = add_observation(text, kind=kind, tags=tags or [])
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    fp = current_fingerprint()

    print(f"observed [{row['kind']}]: {row['text'][:80]}")
    if row["tags"]:
        print("tags: " + ", ".join(row["tags"]))
    print("fingerprint: " + _fmt_fp(fp))

    # Observation changes the world, so the activated column changes NOW — not
    # at the next session start. The old harness left the agent running on a
    # stale column for the rest of the run.
    prev = _activated_techniques()
    bundle = build_bundle()
    iv = decide(trigger="observe", bundle=bundle, prev_activated=prev)
    bundle["_iv"] = iv.as_row()
    from aegis.store import _write_json
    from aegis.paths import AEGIS_DIR

    _write_json(AEGIS_DIR / "activation.json", bundle)
    append_episode(challenge=(load_current() or {}).get("challenge"), kind="intervention", **iv.as_row())

    if iv.kind is Kind.SILENT:
        print("intervention: SILENT (no stored experience applies to this world)")
    else:
        print(f"\nintervention: {iv.kind.value.upper()} ({iv.reason})\n")
        print(render(iv))
    return 0


def _fmt_fp(fp) -> str:
    bits = []
    if fp.glibc:
        bits.append(f"glibc{fp.glibc[0]}.{fp.glibc[1]}")
    for k in ("hooks", "exit", "arena"):
        v = getattr(fp, k)
        if v:
            bits.append(f"{k}={v}")
    if fp.alloc:
        bits.append("alloc=" + ",".join(sorted(fp.alloc)))
    # Protection tags (checksec) are observations too; without showing them the
    # fingerprint looks empty while the column is clearly not cold.
    known = sorted(fp.tags)
    if known:
        bits.append("tags=" + ",".join(known))
    return "  ".join(bits) or "(none — cold start)"


def _activated_techniques() -> set[str]:
    """Techniques in the column as of the last evaluation, for delta detection."""
    import json as _json

    from aegis.paths import AEGIS_DIR

    p = AEGIS_DIR / "activation.json"
    if not p.is_file():
        return set()
    try:
        data = _json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return set()
    out = {str(c.get("technique") or "") for c in (data.get("cells") or [])}
    out |= {str(c.get("technique") or "") for c in (data.get("forbid") or [])}
    return out


def cmd_note(kind: str, text: str, technique: str, condition: str) -> int:
    cur = load_current() or {}
    append_episode(
        challenge=cur.get("challenge"),
        kind=kind,
        text=text,
        technique=technique,
        condition=condition,
    )
    print("noted")
    return 0


def cmd_recall(kind: str) -> int:
    print(ram_blob(kind or None))
    act = ROOT / ".aegis" / "activation.json"
    if act.is_file():
        print("\n# activation dump:", act)
    return 0


def cmd_wiki(action: str, limit: int, force: bool) -> int:
    from aegis.wiki import compile_all, fetch, list_pages

    if action == "fetch":
        path = fetch()
        pages = list_pages()
        print(f"wiki at {path}")
        print(f"heap pages: {len(pages)}")
        for p in pages:
            print(f"  {p.relative_to(path)}")
        return 0
    if action == "list":
        pages = list_pages()
        if not pages:
            print("no pages; run: uv run aegis wiki fetch")
            return 1
        for p in pages:
            print(p)
        print(f"total {len(pages)}")
        return 0
    stats = compile_all(limit=limit, force=force)
    print(json.dumps(stats, ensure_ascii=False))
    return 0 if stats["fail"] == 0 else 1


def cmd_compile(challenge: str) -> int:
    try:
        data = compile_from_store(challenge)
    except Exception as exc:
        print(f"compile failed: {exc}", file=sys.stderr)
        return 1
    if data.get("error"):
        print(f"compile error: {data['error']}", file=sys.stderr)
        return 1
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


def cmd_ram(kind: str, no_experience: bool = False) -> int:
    rom = ROM_PATH.read_text(encoding="utf-8") if ROM_PATH.is_file() else ""
    tools = RAM_TOOLS_PATH.read_text(encoding="utf-8") if RAM_TOOLS_PATH.is_file() else ""
    cur = load_current() or {}
    k = kind or cur.get("kind") or ""
    parts = [rom.strip(), tools.strip()]
    hints = [str(h) for h in (cur.get("hints") or []) if str(h).strip()]
    if hints:
        parts.append("# 人类 Hint（本题，优先于猜测）\n" + "\n".join(f"- {h}" for h in hints))
    # Activated experience goes LAST: attention is strongest at head and tail,
    # the middle of a long context is a dead zone.
    #
    # --no-experience keeps ROM + TOOLS + hints and drops only this last column.
    # Withholding the whole blob instead would also remove the working
    # conventions and the tool cheatsheet, which are not the variable under test.
    if not no_experience:
        parts.append(ram_blob(k or None))
    print("\n\n".join(p for p in parts if p))
    return 0


def cmd_deny(command: str) -> int:
    refused = refuse_reason(command, active_denies())
    if refused:
        print(refused)
        return 2
    print("ok")
    return 0


def _integrity_findings(challenge: str):
    """Mitigation-weakening tricks hidden in this challenge's own scripts.

    The guard sees `python3 exp.py` and nothing else, so the `context.aslr =
    False` one line inside the file would sail past it. Scanning the tree is
    what actually closes that gap.
    """
    from aegis.integrity import scan_tree

    try:
        return scan_tree(challenge_dir(challenge))
    except OSError:
        return []


def _script_names_in(command: str) -> list[str]:
    """Script files the command is about to run."""
    import re as _re

    out = []
    for tok in _re.findall(r"[\w./~-]+\.(?:py|sh|sage|rb|pl)\b", command):
        name = tok.strip()
        if name and name not in out:
            out.append(name)
    return out


def _remote_script_findings(challenge: str, ch, command: str):
    """Scan scripts that exist only on the channel.

    The tree scan looks at the repo copy, but a script can be authored directly
    on the channel (a heredoc into exp.py, or `cat > x.py` inside a session).
    Those files never appear locally, so scanning only the repo let a
    mitigation-disabling script run unexamined — the exact hole the integrity
    rules exist to close.
    """
    from aegis.dockerutil import pwn_exec
    from aegis.integrity import scan_text

    names = _script_names_in(command)
    if not names:
        return []
    quoted = " ".join(shlex.quote(n) for n in names[:5])
    res = pwn_exec(challenge, f"for f in {quoted}; do echo '<<<AEGIS:'\"$f\"'>>>'; cat \"$f\" 2>/dev/null; done", timeout=30, channel=ch)
    text = str(res.get("stdout") or "")
    found = []
    for chunk in text.split("<<<AEGIS:"):
        if not chunk.strip():
            continue
        name, _, body = chunk.partition(">>>")
        found.extend(scan_text(body, where=name.strip() or "channel"))
    return found


def _refuse_if_weakened(challenge: str, ch=None, command: str = "") -> bool:
    """Block execution while the challenge's scripts weaken a mitigation.

    Returns True when the command must not run. Refusing here (rather than only
    recording at finish) means the agent cannot spend the rest of the run
    building on an invalid result.

    Scans BOTH the repo copy and any script the command is about to run on the
    channel, because a script authored on the channel is invisible to a scan of
    the repo.
    """
    from aegis.integrity import summarise

    found = _integrity_findings(challenge)
    if ch is not None and command:
        try:
            found = found + _remote_script_findings(challenge, ch, command)
        except Exception:
            pass
    if not found:
        return False
    append_issue(
        "weaken_protection",
        "; ".join(f.line() for f in found[:6]),
        challenge=challenge,
    )
    print("REFUSED (weaken_protection): 检测到 exp 脚本里关闭了本地保护。\n")
    print(summarise(found))
    return True


def cmd_pwn(command: str, timeout: int, channel: str = "") -> int:
    from aegis.dockerutil import pick

    cur = load_current()
    if not cur:
        print("no current challenge; run aegis start <id>", file=sys.stderr)
        return 2
    challenge = cur["challenge"]
    refused = refuse_reason(command, active_denies())
    if refused:
        append_issue("refused", command, challenge=challenge)
        print(refused)
        return 0
    ch = pick(channel or None)
    # Integrity gate: a script that turns a mitigation off invalidates whatever
    # it produces, so stop before running anything from that tree. Done after
    # picking the channel so channel-side scripts can be examined too.
    if _refuse_if_weakened(challenge, ch, command):
        return 0
    if not ch.available:
        append_issue("channel", f"{ch.label()} unavailable: {ch.detail}", challenge=challenge)
        print(f"NO CHANNEL ({ch.label()}): {ch.detail}", file=sys.stderr)
        print("Start the container, or set AEGIS_REMOTE=<ssh-alias>.", file=sys.stderr)
        return 0
    try:
        result = pwn_exec(challenge, command, timeout=timeout, channel=ch)
    except FileNotFoundError:
        append_issue("docker", "docker binary not found", challenge=challenge)
        print("ERROR: docker not found")
        return 0
    code = int(result["returncode"])
    if code in (124, 137) or "TIMEOUT" in str(result.get("stderr", "")):
        append_issue("timeout", command, challenge=challenge)
    print(result["stdout"], end="")
    if result["stderr"]:
        print(result["stderr"], end="" if str(result["stderr"]).endswith("\n") else "\n")
    # Always 0 so Pi does not turn a timeout into "Connection error".
    return 0


def cmd_env(probe: bool, as_json: bool) -> int:
    """Show the execution channel and what tools it actually has.

    The agent used to spend turns on `command -v gdb; which pwnx` probes — and
    those probes were refused (see tests/test_guard.py). Answering once, up
    front, removes the reason to probe.
    """
    import json as _json

    from aegis.dockerutil import discover, pick, probe_tools

    channels = discover()
    chosen = pick()
    data: dict[str, Any] = {
        "channels": {
            k: {"kind": v.kind, "target": v.target, "available": v.available, "detail": v.detail}
            for k, v in channels.items()
        },
        "chosen": chosen.label(),
        "workdir": chosen.dir_for(str((load_current() or {}).get("challenge") or "<id>")),
    }
    if probe and chosen.available:
        data["tools"] = probe_tools(chosen)
    if as_json:
        print(_json.dumps(data, ensure_ascii=False, indent=2))
        return 0

    print("# 执行通道")
    for k, v in channels.items():
        mark = "OK " if v.available else "-- "
        star = " <- 当前" if v.name == chosen.name else ""
        print(f"  {mark}{k:10} {v.kind}:{v.target}{star}")
        if not v.available:
            print(f"      {v.detail[:90]}")
    if chosen.available:
        print(f"  工作目录: {data['workdir']}")
    else:
        print("  工作目录: (无可用通道 — 远端开机后重试)")
    if probe and chosen.available:
        print()
        print("# 可用工具")
        for name, path in sorted(data.get("tools", {}).items()):
            print(f"  {'OK ' if path != '-' else '-- '}{name:14} {'' if path == '-' else path}")
        missing = [n for n, p in data.get("tools", {}).items() if p == "-"]
        if missing:
            print()
            print("  缺失: " + ", ".join(missing))
            print("  需要时走另一条通道（AEGIS_CHANNEL=remote）或先装。")
    if len(channels) < 2:
        print()
        print("提示: 只发现一条通道。要加远程，设 AEGIS_REMOTE=<ssh 别名>（~/.ssh/config 里已有的）。")
    return 0


def cmd_purge() -> int:
    from aegis.store import load_atlas, save_atlas

    atlas = load_atlas()
    keep, drop = [], []
    for cell in atlas.get("cells") or []:
        tech = str(cell.get("technique") or "")
        (keep if _portable_technique(tech) else drop).append(cell)
    atlas["cells"] = keep
    save_atlas(atlas)
    print(f"purged {len(drop)} non-portable cells; kept {len(keep)}")
    for c in drop:
        print(f"  - [{c.get('source')}] {c.get('technique')}")
    return 0


def cmd_kb(query: str, k: int) -> int:
    """Consult the knowledge base. Pull-only, never auto-injected."""
    from aegis.wiki import lookup, render_lookup

    fp = current_fingerprint()
    items = lookup(query, fp=fp if fp.observed else None, k=max(1, min(k, 20)))
    print(render_lookup(items, query))
    return 0


def cmd_intervene(trigger: str, trajectory: str, use_llm: bool, as_json: bool) -> int:
    bundle = build_bundle()
    prev = _activated_techniques() if trigger != "opening" else set()
    iv = decide(trigger=trigger, bundle=bundle, prev_activated=prev, trajectory=trajectory, use_llm=use_llm)
    append_episode(challenge=(load_current() or {}).get("challenge"), kind="intervention", **iv.as_row())
    if as_json:
        import json as _json

        print(_json.dumps({**iv.as_row(), "message": iv.message}, ensure_ascii=False, indent=2))
        return 0
    if iv.kind is Kind.SILENT:
        print(f"SILENT ({iv.reason}) — no injection")
        return 0
    print(f"{iv.kind.value.upper()} ({iv.reason})")
    print()
    print(iv.message or render(iv))
    return 0


def cmd_explain(tau: float | None, top: int) -> int:
    """Show why each near-threshold cell did or did not activate."""
    from aegis.activate import fan_counts, score, _tier
    from aegis.predicate import is_applicable
    from aegis.paths import AEGIS_DIR
    from aegis.store import _atlas_cells, current_fingerprint

    fp = current_fingerprint()
    cells = _atlas_cells()
    fan = fan_counts(cells)
    tau_v = tau if tau is not None else 0.9

    print("# 指纹")
    print("  " + _fmt_fp(fp))
    print(f"  expanded: {', '.join(sorted(fp.expanded)) or '(none)'}")
    print()

    rows = []
    for c in cells:
        a, why = score(c, fp, fan)
        rows.append((a, why, c))
    rows.sort(key=lambda r: r[0], reverse=True)

    print(f"# 激活分（tau={tau_v}；只显示前 {top}）")
    for a, why, c in rows[:top]:
        mark = "ON " if a >= tau_v else "off"
        tier = _tier(c)
        print(f"  {mark} A={a:6.2f}  [{c['state']}/{tier}] {c['technique'][:58]}")
        print(f"        why={why}  req={c.get('requires')} forbids={c.get('forbids') or []}")

    st = AEGIS_DIR / "status.json"
    if st.is_file():
        import json as _json

        data = _json.loads(st.read_text(encoding="utf-8"))
        print()
        print("# 上次装配（status.json，不注入模型）")
        print(f"  hsr@k = {data.get('hsr_at_k')}")
        for k, v in sorted((data.get("dropped") or {}).items()):
            print(f"  dropped {k} = {v}")

    ok, why = (False, "")
    if cells:
        ok, why = is_applicable(cells[0], fp)
    return 0


def cmd_migrate(dry_run: bool, llm_residue: bool) -> int:
    from aegis.migrate import migrate_atlas

    r = migrate_atlas(dry_run=dry_run, llm_residue=llm_residue)
    if r.get("error"):
        print(r["error"], file=sys.stderr)
        return 1
    print(f"{'[dry-run] ' if dry_run else ''}migrated {r['migrated']}  skipped {r['skipped']}")
    print("field coverage: " + ", ".join(f"{k}={v}" for k, v in sorted(r["field_coverage"].items())))
    print(f"residue (rules could not parse): {r['residue_count']}")
    if r.get("llm"):
        print(f"llm residue pass: {r['llm']}")
    if not dry_run:
        from aegis.paths import AEGIS_DIR

        print(f"schema-1 backup: {AEGIS_DIR / 'atlas.schema1.json'}")
    return 0


def _needs_sync_for_shell(text: str) -> bool:
    """Only re-sync for commands that read or run local files."""
    from aegis.dockerutil import _needs_sync

    return _needs_sync(text) or any(
        k in text for k in ("pdb", "python3 ", "exp", "./", "bash ", "sh ")
    )


def cmd_shell(
    action: str, text: str, timeout: float, channel: str = "", pane: str = ""
) -> int:
    """Drive the persistent session.

    A session is what makes adaptive debugging possible: the pwn_2 setup needs
    ~240s of heap exhaustion, so inspecting that state one-shot means re-running
    it per look. Here the program can be left waiting at a prompt and picked up
    by the next invocation.
    """
    from aegis.session import get as get_session

    cur = load_current()
    if not cur:
        print("no current challenge; run aegis start <id> first", file=sys.stderr)
        return 2
    challenge = cur["challenge"]
    ch = pick_channel(channel or None)

    if action == "stop":
        sess = get_session(challenge, ch)
        sess.stop()
        print("session stopped")
        return 0

    if action == "status":
        from aegis.session import Session

        probe = Session(challenge=challenge, channel=ch)
        live = probe.alive()
        print(f"session  : {probe.name}")
        print(f"channel  : {ch.label()}")
        print(f"alive    : {live}")
        if live:
            print(f"log      : {probe.log}")
            print(f"bytes    : {probe._size()}")
        return 0

    if not ch.available:
        # `label()` is empty-ish for an unreachable channel; the detail says why.
        print(f"执行通道不可用：{ch.detail or ch.label()}", file=sys.stderr)
        print("远端开机后重试：`aegis env` 看通道状态。", file=sys.stderr)
        return 1
    sess = get_session(challenge, ch)
    if not sess.started:
        print(f"会话启动失败（通道 {ch.label()}）：{sess.log}", file=sys.stderr)
        return 1

    if action == "reset":
        ok, detail = sess.reset()
        print("session reset" if ok else f"reset failed: {detail}")
        return 0 if ok else 1

    if action == "start":
        print(f"session ready: {sess.name} on {ch.label()}")
        print(f"workdir: {ch.dir_for(challenge)}")
        return 0

    if action == "read":
        out = sess.read(timeout=timeout)
        print(out if out.strip() else "(没有新输出)")
        return 0

    if action == "interrupt":
        if pane:
            sess.interrupt_pane(pane)
            print(f"Ctrl-C 已发送到 {pane}")
            return 0
        out = sess.interrupt()
        print(out if out.strip() else "(Ctrl-C 已发送)")
        return 0

    if action == "panes":
        rows = sess.panes()
        if not rows:
            print("(没有 pane — 会话可能没在跑)")
            return 0
        print(f"{'pane':6} {'前台进程':22} {'尺寸':10} active")
        for r in rows:
            print(f"{r['id']:6} {r['command'][:22]:22} {r['size']:10} {'*' if r['active'] else ''}")
        print()
        print("用 --pane <id> 把命令送给某个 pane（比如 gdb 那个）。")
        return 0

    if action == "capture":
        out = sess.capture(pane or None)
        print(out if out.strip() else "(pane 为空)")
        return 0

    # action == send
    if not text.strip():
        print("send 需要一条命令", file=sys.stderr)
        return 2
    # The session must see what the agent just wrote. Without this, a freshly
    # created exp.py is invisible to `python3 -m pdb exp.py` inside the session.
    from aegis.dockerutil import ensure_synced

    if _needs_sync_for_shell(text):
        ensure_synced(challenge, ch, text)
    if pane:
        # Target a specific pane: this is how gdb opened by `gdb.attach` is
        # driven, since it lives in its own pane with no pipe-pane log.
        sess.send_to(pane, text)
        import time as _t

        _t.sleep(0.6)
        out = sess.capture(pane)
        print(out if out.strip() else "(没有输出)")
        return 0

    out = sess.run(text, timeout=timeout)
    print(out if out.strip() else "(没有输出)")
    return 0


def cmd_finish(
    status: str,
    chain: str,
    stuck: str,
    extra: str,
    elapsed: float | None,
    verified: str = "local",
) -> int:
    cur = load_current()
    if not cur:
        print("no current challenge", file=sys.stderr)
        return 2
    challenge = cur["challenge"]
    elapsed_s = elapsed if elapsed is not None else max(0.0, time.time() - float(cur.get("t0", time.time())))

    # Integrity gate, authoritative pass. `cmd_pwn` already blocks execution
    # while the tree weakens a mitigation, but a script could have been written
    # between the last run and now, so re-check before recording anything.
    findings = _integrity_findings(challenge)
    if findings:
        from aegis.integrity import summarise

        append_issue(
            "weaken_protection",
            "; ".join(f.line() for f in findings[:6]),
            challenge=challenge,
        )
        print(summarise(findings))
        if verified != "none":
            print(
                f"\nverified 从 {verified!r} 降级为 'none'："
                "链依赖了被我们关掉的保护，不能记成打通。\n"
            )
            verified = "none"

    compiled = compile_run(
        challenge=challenge,
        status=status,
        chain=chain,
        stuck=stuck,
        elapsed_s=elapsed_s,
        extra=extra,
        verified=verified,
        since=str(cur.get("started_at") or "") or None,
    )
    path = write_writeup(
        challenge=challenge,
        status=status,
        elapsed_s=elapsed_s,
        chain=chain,
        stuck=stuck,
        extra=extra,
        compiled=compiled,
        since=str(cur.get("started_at") or "") or None,
    )
    restore_challenge(challenge)
    clear_current()
    print(f"writeup: {path}")
    print(f"restored test/{challenge}")
    return 0


def cmd_run(challenge: str, timeout: int, hints: list[str] | None = None) -> int:
    if cmd_start(challenge, hints) != 0:
        return 2
    if not PI_SCRIPT.is_file():
        append_issue("pi", f"missing {PI_SCRIPT}")
        print("pi-test.sh not found", file=sys.stderr)
        return 1
    prompt = (
        f"Solve the CTF challenge in test/{challenge} only. "
        "Use aegis_pwn for anything that must run on x86. "
        "Use aegis_note for successes, failures, and localization tricks. "
        "When done (or stuck), call aegis_finish with a one-line chain "
        "like strcpy存在溢出->修改返回地址为system->getshell and say where time was spent. "
        "Do not read other challenges, runs/, .aegis/, or architecture docs."
    )
    env = os.environ.copy()
    env["AEGIS_CHALLENGE"] = challenge
    cmd = [
        str(PI_SCRIPT),
        "--approve",
        "--provider",
        "deepseek",
        "--model",
        "deepseek-flash",
        "-p",
        prompt,
    ]
    t0 = time.time()
    try:
        proc = subprocess.run(
            cmd,
            cwd=ROOT,
            env=env,
            timeout=timeout,
            check=False,
        )
        elapsed = time.time() - t0
        if load_current():
            # Agent forgot aegis_finish — still snapshot what we can.
            cmd_finish(
                "failed" if proc.returncode else "solved",
                "",
                "agent did not call aegis_finish",
                "",
                elapsed,
                "none",
            )
            append_issue("finish", "aegis_finish was not called; harness finalized", challenge=challenge)
        return proc.returncode
    except subprocess.TimeoutExpired:
        elapsed = time.time() - t0
        append_issue("timeout", f"pi -p exceeded {timeout}s", challenge=challenge)
        if load_current():
            cmd_finish("timeout", "", f"pi -p timeout {timeout}s", "", elapsed, "none")
        return 124


if __name__ == "__main__":
    raise SystemExit(main())
