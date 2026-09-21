from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

from aegis.compile import compile_run
from aegis.dockerutil import pwn_exec, sync_to_container
from aegis.gitutil import restore_challenge
from aegis.paths import (
    CONTAINER,
    PI_SCRIPT,
    PWN_START,
    RAM_TOOLS_PATH,
    ROM_PATH,
    ROOT,
    infer_kind,
    list_challenges,
)
from aegis.store import (
    append_episode,
    append_issue,
    clear_current,
    load_current,
    now_iso,
    ram_blob,
    save_current,
)
from aegis.writeup import list_writeups, write_writeup


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aegis", description="Aegis demo harness")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", help="Check pi / docker / git / challenges")
    sub.add_parser("list", help="List challenges and runs")

    p_start = sub.add_parser("start", help="Prepare one challenge (restore + sync + current)")
    p_start.add_argument("challenge")

    p_run = sub.add_parser("run", help="Non-interactive: pi -p on one challenge")
    p_run.add_argument("challenge")
    p_run.add_argument("--timeout", type=int, default=1800)

    p_finish = sub.add_parser("finish", help="Write WP, compile memory, restore test/")
    p_finish.add_argument("--status", default="solved", choices=["solved", "failed", "timeout"])
    p_finish.add_argument("--chain", default="")
    p_finish.add_argument("--stuck", default="")
    p_finish.add_argument("--extra", default="")
    p_finish.add_argument("--elapsed", type=float, default=None)

    p_note = sub.add_parser("note", help="Append an episode (called from Pi tool)")
    p_note.add_argument("--kind", required=True)
    p_note.add_argument("--text", required=True)
    p_note.add_argument("--technique", default="")
    p_note.add_argument("--condition", default="")

    p_recall = sub.add_parser("recall", help="Dump compiled RAM blob")
    p_recall.add_argument("--kind", default="")

    p_pwn = sub.add_parser("pwn", help="Run a command in the x86 container")
    p_pwn.add_argument("command")
    p_pwn.add_argument("--timeout", type=int, default=20)

    p_ram = sub.add_parser("ram", help="Print ROM+RAM text for the Pi extension")
    p_ram.add_argument("--kind", default="")

    args = parser.parse_args(argv)
    handlers = {
        "doctor": cmd_doctor,
        "list": cmd_list,
        "start": lambda: cmd_start(args.challenge),
        "run": lambda: cmd_run(args.challenge, args.timeout),
        "finish": lambda: cmd_finish(args.status, args.chain, args.stuck, args.extra, args.elapsed),
        "note": lambda: cmd_note(args.kind, args.text, args.technique, args.condition),
        "recall": lambda: cmd_recall(args.kind),
        "pwn": lambda: cmd_pwn(args.command, args.timeout),
        "ram": lambda: cmd_ram(args.kind),
    }
    return handlers[args.cmd]()


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
    docker = shutil.which("docker")
    check("docker CLI", docker is not None)
    colima = shutil.which("colima")
    running = False
    if colima:
        running = subprocess.run(["colima", "status"], capture_output=True).returncode == 0
    check("colima running", running, str(PWN_START))
    pwn = False
    if docker and running:
        ps = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", CONTAINER],
            capture_output=True,
            text=True,
        )
        pwn = ps.stdout.strip() == "true"
    check("container pwn", pwn, "start with ~/Tools/pwn/start.sh")
    print()
    print("challenges:", ", ".join(chals) or "(none)")
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


def cmd_start(challenge: str) -> int:
    if challenge not in list_challenges():
        print(f"unknown challenge: {challenge}", file=sys.stderr)
        return 2
    restore_challenge(challenge)
    sync_to_container(challenge)
    save_current(
        {
            "challenge": challenge,
            "kind": infer_kind(challenge),
            "started_at": now_iso(),
            "t0": time.time(),
        }
    )
    print(f"started {challenge}")
    print(f"host:  {ROOT / 'test' / challenge}")
    print(f"docker: /work/aegis/{challenge}")
    print("pi:")
    print(
        f"  pi --approve --provider deepseek --model deepseek-flash "
        f"\"Solve test/{challenge}. Call aegis_finish when done.\""
    )
    return 0


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
    return 0


def cmd_ram(kind: str) -> int:
    rom = ROM_PATH.read_text(encoding="utf-8") if ROM_PATH.is_file() else ""
    tools = RAM_TOOLS_PATH.read_text(encoding="utf-8") if RAM_TOOLS_PATH.is_file() else ""
    cur = load_current() or {}
    k = kind or cur.get("kind") or ""
    blob = "\n\n".join([rom.strip(), tools.strip(), ram_blob(k or None)])
    print(blob)
    return 0


def cmd_pwn(command: str, timeout: int) -> int:
    cur = load_current()
    if not cur:
        print("no current challenge; run aegis start <id>", file=sys.stderr)
        return 2
    try:
        result = pwn_exec(cur["challenge"], command, timeout=timeout)
    except subprocess.TimeoutExpired:
        append_issue("timeout", command, challenge=cur["challenge"])
        print("TIMEOUT")
        return 124
    except FileNotFoundError:
        append_issue("docker", "docker binary not found")
        print("docker not found", file=sys.stderr)
        return 1
    print(result["stdout"], end="")
    if result["stderr"]:
        print(result["stderr"], file=sys.stderr, end="")
    return int(result["returncode"])


def cmd_finish(status: str, chain: str, stuck: str, extra: str, elapsed: float | None) -> int:
    cur = load_current()
    if not cur:
        print("no current challenge", file=sys.stderr)
        return 2
    challenge = cur["challenge"]
    elapsed_s = elapsed if elapsed is not None else max(0.0, time.time() - float(cur.get("t0", time.time())))
    path = write_writeup(
        challenge=challenge,
        status=status,
        elapsed_s=elapsed_s,
        chain=chain,
        stuck=stuck,
        extra=extra,
    )
    compile_run(
        challenge=challenge,
        status=status,
        chain=chain,
        stuck=stuck,
        elapsed_s=elapsed_s,
    )
    restore_challenge(challenge)
    clear_current()
    print(f"writeup: {path}")
    print(f"restored test/{challenge}")
    return 0


def cmd_run(challenge: str, timeout: int) -> int:
    if cmd_start(challenge) != 0:
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
            cmd_finish("failed" if proc.returncode else "solved", "", "agent did not call aegis_finish", "", elapsed)
            append_issue("finish", "aegis_finish was not called; harness finalized", challenge=challenge)
        return proc.returncode
    except subprocess.TimeoutExpired:
        elapsed = time.time() - t0
        append_issue("timeout", f"pi -p exceeded {timeout}s", challenge=challenge)
        if load_current():
            cmd_finish("timeout", "", f"pi -p timeout {timeout}s", "", elapsed)
        return 124


if __name__ == "__main__":
    raise SystemExit(main())
