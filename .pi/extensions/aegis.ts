/**
 * Temporary Pi extension for the Aegis demo.
 * Injects ROM/RAM, blocks workspace pollution, wraps memory + docker tools.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
const UV = process.env.UV || join(homedir(), ".local", "bin", "uv");

function aegis(args: string[]): string {
	const bin = existsSync(UV) ? UV : "uv";
	const r = spawnSync(bin, ["run", "--project", ROOT, "aegis", ...args], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 90_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	const chunks = [r.stdout || "", r.stderr || ""];
	if (r.error) chunks.push(String(r.error));
	if (r.signal) chunks.push(`signal=${r.signal}`);
	return chunks.join("").trimEnd();
}

function currentChallenge(): string | null {
	const env = (process.env.AEGIS_CHALLENGE || "").trim();
	if (env) return env;
	const named = env ? join(ROOT, ".aegis", `run-${env}.json`) : "";
	const p = join(ROOT, ".aegis", "current.json");
	for (const path of [named, p].filter(Boolean)) {
		if (!existsSync(path)) continue;
		try {
			const data = JSON.parse(readFileSync(path, "utf8")) as { challenge?: string };
			if (data.challenge) return data.challenge;
		} catch {
			/* ignore */
		}
	}
	return null;
}

function isForbidden(abs: string): string | null {
	const rel = relative(ROOT, resolve(abs));
	if (rel.startsWith("..")) {
		// outside repo is ok for /tmp, but not for sibling challenge dumps
		return null;
	}
	const n = rel.replaceAll("\\", "/");
	if (n === "runs" || n.startsWith("runs/") || n === ".aegis" || n.startsWith(".aegis/")) {
		return `blocked path: ${n}`;
	}
	// The operator's design notes, experiment logs and test fixtures. A run that
	// reads them can see which arm it is in and what the expected solution is,
	// which is exactly what the experiment is trying to measure.
	if (n === "docs" || n.startsWith("docs/") || n === "tests" || n.startsWith("tests/")) {
		return `blocked path: ${n}`;
	}
	const base = n.split("/").pop() ?? n;
	if (["架构.md", "框架.md", "README.md", "Deepseek_AGENTS.md"].includes(base)) {
		return `blocked doc: ${base}`;
	}
	// Our pi fork. It is a vendored dependency with its own git; a run reading or
	// editing it could read the observer that is recording it.
	if (n === "vendor" || n.startsWith("vendor/")) {
		return `blocked path: ${n}`;
	}
	const cur = currentChallenge();
	if (n.startsWith("test/")) {
		const rest = n.slice("test/".length);
		const other = rest.split("/")[0];
		if (cur && other && other !== cur) {
			return `blocked other challenge: ${other}`;
		}
	}
	return null;
}

const BASH_DENY = [
	/\bkb\b/,
	/docker\s+compose\s+(down|stop)/,
	/docker-compose\s+(down|stop)/,
	/\.\/stop\.sh/,
	/\bp\.interactive\s*\(/,
];

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		let ram = "";
		try {
			// AEGIS_NO_MEMORY=1 is the control arm of the experience experiment.
			// It drops ONLY the activated experience column: ROM, the tool
			// cheatsheet and every guard rule stay in place, so the two arms
			// differ in exactly one variable.
			ram = process.env.AEGIS_NO_MEMORY
				? aegis(["ram", "--no-experience"]).trim()
				: aegis(["ram"]).trim();
		} catch (err) {
			ram = `(aegis ram failed: ${String(err)})`;
		}
		// Answer "which tools exist, and where am I" once, up front. The agent
		// used to spend turns on `command -v gdb; which pwnx`, and the guard
		// refused those probes — so it probed again and burned the run.
		// The channel workdir is already part of this output, so there is no
		// second call and no hard-coded path here.
		let env = "";
		try {
			env = aegis(["env"]).trim();
		} catch {
			/* env output is a convenience, not a requirement */
		}
		const cur = currentChallenge();
		const where = cur
			? `当前题目: test/${cur}（写操作只许落在这个目录；执行通道见上）`
			: "没有 current challenge：先在仓库根目录执行 uv run aegis start <id>";
		const tail = [ram, env, where].filter(Boolean).join("\n\n");
		return {
			systemPrompt: `${event.systemPrompt}\n\n${tail}`,
		};
	});

	pi.on("tool_call", async (event) => {
		const name = event.toolName;
		const input = event.input as Record<string, unknown>;
		if (name === "read" || name === "write" || name === "edit") {
			const p = String(input.path ?? "");
			if (p) {
				const reason = isForbidden(resolve(ROOT, p));
				if (reason) return { block: true, reason };
			}
		}
		if (name === "bash") {
			const cmd = String(input.command ?? "");
			try {
				const out = aegis(["deny", cmd]);
				if (out.startsWith("REFUSED")) {
					return { block: true, reason: out };
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("REFUSED")) return { block: true, reason: msg };
			}
			for (const re of BASH_DENY) {
				if (re.test(cmd)) {
					return { block: true, reason: `blocked command matching ${re}` };
				}
			}
		}
		return undefined;
	});

	pi.registerTool({
		name: "aegis_pwn",
		label: "Aegis Pwn",
		description:
			"Run a bash command on the x86 execution channel. 'remote' (native x86 host: pwntools, one_gadget, " +
			"ropper, radare2, glibc-all-in-one) is the default; 'container' (local docker, QEMU-emulated, " +
			"5-10x slower, fewer tools) is the fallback. Omit `channel` to use the default. " +
			"libc objdump/gdb, interactive shells, writeup downloads, and reading .aegis/ are REFUSED at the tool layer — " +
			"do not retry a refused command. On timeout, narrow the command; do not retry it unchanged.",
		parameters: Type.Object({
			command: Type.String({
				description:
					"Command. The working directory is the challenge dir on the active channel " +
					"(see the 执行通道 block in the system prompt); multi-line scripts, quotes, " +
					"pipes and heredocs all work.",
			}),
			timeout: Type.Optional(Type.Number({ description: "Seconds, default 20, max 300" })),
			channel: Type.Optional(
				Type.String({ description: "container | remote (omit for the default channel)" }),
			),
		}),
		async execute(_id, params) {
			const timeout = String(params.timeout ?? 20);
			const args = ["pwn", params.command, "--timeout", timeout];
			if (params.channel) args.push("--channel", params.channel);
			try {
				const out = aegis(args);
				return { content: [{ type: "text", text: out || "(no output)" }], details: {} };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: msg }], details: { error: true } };
			}
		},
	});

	pi.registerTool({
		name: "aegis_shell",
		label: "Aegis Shell (persistent)",
		description:
			"Persistent interactive shell on the execution channel — use this for DYNAMIC DEBUGGING. " +
			"It keeps state across calls: a program or gdb can sit at a prompt and the next call picks it up. " +
			"Use it whenever you need to look at something and THEN decide, e.g. debug a heap layout: " +
			"aegis_shell('gdb -q ./pwn') then aegis_shell('break *0x...'), aegis_shell('run'), aegis_shell('x/8gx $rsp'). " +
			"For commands where you already know the output you want (file/checksec/readelf), aegis_pwn is cheaper. " +
			"NEVER run a bare `gdb` through aegis_pwn — it will be refused, because one-shot cannot host a terminal.",
		parameters: Type.Object({
			action: Type.String({
				description:
					"send (type a line and read) | read (drain new output) | capture (snapshot a pane) | " +
					"panes (list panes) | interrupt (Ctrl-C) | reset | stop | status",
			}),
			text: Type.Optional(Type.String({ description: "The line to type, for action=send" })),
			timeout: Type.Optional(Type.Number({ description: "Seconds to wait for output, default 20" })),
			pane: Type.Optional(
				Type.String({
					description:
						"tmux pane id (%0, %1, ...) for send/capture/interrupt. Use when debugging an exp " +
						"script: gdb.attach() opens gdb in a second pane, and you drive it with pane=%1",
				}),
			),
		}),
		async execute(_id, params) {
			const args = ["shell", params.action];
			if (params.text !== undefined && params.text !== "") args.push(params.text);
			if (params.timeout) args.push("--timeout", String(params.timeout));
			if (params.pane) args.push("--pane", params.pane);
			try {
				const out = aegis(args);
				return { content: [{ type: "text", text: out || "(no output)" }], details: {} };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: msg }], details: { error: true } };
			}
		},
	});

	pi.registerTool({
		name: "aegis_note",
		label: "Aegis Note",
		description:
			"Record a success, failure, localization trick, or cost. Use this during the solve, not only at the end.",
		parameters: Type.Object({
			kind: Type.String({ description: "success | fail | trick | cost | observe" }),
			text: Type.String({ description: "Short note" }),
			technique: Type.Optional(Type.String()),
			condition: Type.Optional(Type.String({ description: "e.g. glibc=2.23, kind=pwn" })),
		}),
		async execute(_id, params) {
			const args = ["note", "--kind", params.kind, "--text", params.text];
			if (params.technique) args.push("--technique", params.technique);
			if (params.condition) args.push("--condition", params.condition);
			const out = aegis(args);
			return { content: [{ type: "text", text: out.trim() }], details: {} };
		},
	});

	pi.registerTool({
		name: "aegis_kb",
		label: "Aegis Knowledge Base",
		description:
			"Look up background knowledge in the CTF Wiki knowledge base (ptmalloc2 internals, heap techniques). " +
			"This is REFERENCE material, not verified experience: it tells you how a mechanism works, not that it " +
			"works on this target. Use it to save lookup and understanding time instead of reading whole articles.",
		parameters: Type.Object({
			query: Type.String({ description: "What you want to look up, e.g. 'tcache poisoning'" }),
			k: Type.Optional(Type.Number({ description: "Max items, default 6" })),
		}),
		async execute(_id, params) {
			try {
				const out = aegis(["kb", params.query, "-k", String(params.k ?? 6)]);
				return { content: [{ type: "text", text: out || "(no match)" }], details: {} };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: msg }], details: { error: true } };
			}
		},
	});

	pi.registerTool({
		name: "aegis_intervene",
		label: "Aegis Intervene",
		description:
			"Ask memory whether anything stored applies right now, given the recent trajectory. " +
			"Returns REMIND (an item applies), FORBID (a stored failure condition matches this world), " +
			"or SILENT (nothing applies — the correct and expected answer most of the time). " +
			"Use it after a significant observation, after a refused or timed-out command, or when stuck.",
		parameters: Type.Object({
			trigger: Type.String({ description: "observe | refuse | repeat | stuck" }),
			trajectory: Type.Optional(
				Type.String({ description: "Recent relevant trajectory text (what you just tried)" }),
			),
			llm: Type.Optional(
				Type.Boolean({
					description: "Enable the LLM intervention layer (judges timing/wording; cannot add items)",
				}),
			),
		}),
		async execute(_id, params) {
			const args = ["intervene", "--trigger", params.trigger];
			if (params.trajectory) args.push("--trajectory", params.trajectory);
			if (params.llm) args.push("--llm");
			try {
				const out = aegis(args);
				return { content: [{ type: "text", text: out || "SILENT" }], details: {} };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: msg }], details: { error: true } };
			}
		},
	});

	pi.registerTool({
		name: "aegis_observe",
		label: "Aegis Observe",
		description:
			"Record what THIS run has actually seen (container libc, arena layout, exit path, available primitives). Only observations feed the experience fingerprint — past writeups are never used as the current world. Call it as soon as you learn something about the target.",
		parameters: Type.Object({
			text: Type.String({ description: "What you observed" }),
			tags: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Mechanism tags: glibc2.27 | glibc2.44 | hooks_alive | hooks_dead | thread_arena | exit_group | tcache | fastbin | fsop | calloc",
				}),
			),
		}),
		async execute(_id, params) {
			const args = ["observe", params.text];
			for (const t of params.tags ?? []) args.push("--tag", t);
			const out = aegis(args);
			return { content: [{ type: "text", text: out.trim() }], details: {} };
		},
	});

	pi.registerTool({
		name: "aegis_recall",
		label: "Aegis Recall",
		description: "Load compiled strategy cells and search-control rules (not raw writeups).",
		parameters: Type.Object({
			kind: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const args = ["recall"];
			if (params.kind) args.push("--kind", params.kind);
			const out = aegis(args);
			return { content: [{ type: "text", text: out }], details: {} };
		},
	});

	pi.registerTool({
		name: "aegis_finish",
		label: "Aegis Finish",
		description:
			"End the current challenge. Pass an honest one-line chain and where time was spent. " +
			"You do NOT write memory and you do NOT declare success: the Observer records what " +
			"happened from the event stream, and the blackboard's requirement/stage task decides " +
			"whether it counted. Read the board first (aegis_board action=read).",
		parameters: Type.Object({
			status: Type.String({ description: "solved | failed" }),
			chain: Type.String({ description: "One-line method chain" }),
			stuck: Type.String({ description: "Where time was spent" }),
			extra: Type.Optional(Type.String()),
			verified: Type.Optional(
				Type.String({
					description:
						"ADVISORY ONLY, recorded as a claim and not authoritative. 'flag' if you believe " +
						"you obtained the real/remote outcome; 'local' if it only ran locally; 'none' if it " +
						"never worked. Whether it counted is decided against the board, not by this field.",
				}),
			),
		}),
		async execute(_id, params) {
			const args = [
				"finish",
				"--status",
				params.status,
				"--chain",
				params.chain,
				"--stuck",
				params.stuck,
			];
			if (params.extra) args.push("--extra", params.extra);
			if (params.verified) args.push("--verified", params.verified);
			const out = aegis(args);
			return { content: [{ type: "text", text: out }], details: {} };
		},
	});

	pi.registerCommand("aegis-status", {
		description: "Show Aegis current challenge and runs",
		handler: async (_args, ctx) => {
			try {
				const out = aegis(["list"]);
				ctx.ui.notify(out.slice(0, 500), "info");
			} catch (err) {
				ctx.ui.notify(String(err), "error");
			}
		},
	});
}
