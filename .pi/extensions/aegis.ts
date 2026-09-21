/**
 * Temporary Pi extension for the Aegis demo.
 * Injects ROM/RAM, blocks workspace pollution, wraps memory + docker tools.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
const UV = process.env.UV || join(homedir(), ".local", "bin", "uv");

function aegis(args: string[]): string {
	const bin = existsSync(UV) ? UV : "uv";
	return execFileSync(bin, ["run", "--project", ROOT, "aegis", ...args], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 60_000,
	});
}

function currentChallenge(): string | null {
	const p = join(ROOT, ".aegis", "current.json");
	if (!existsSync(p)) return null;
	try {
		const data = JSON.parse(readFileSync(p, "utf8")) as { challenge?: string };
		return data.challenge ?? null;
	} catch {
		return null;
	}
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
	const base = n.split("/").pop() ?? n;
	if (["架构.md", "框架.md", "README.md", "Deepseek_AGENTS.md"].includes(base)) {
		return `blocked doc: ${base}`;
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
			ram = aegis(["ram"]).trim();
		} catch (err) {
			ram = `(aegis ram failed: ${String(err)})`;
		}
		const cur = currentChallenge();
		const tail = [
			ram,
			cur ? `当前题目: test/${cur} （只许在这个目录里写；容器路径 /work/aegis/${cur}）` : "没有 current challenge：先在仓库根目录执行 uv run aegis start <id>",
		].join("\n\n");
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
			for (const re of BASH_DENY) {
				if (re.test(cmd)) {
					return { block: true, reason: `blocked command matching ${re}` };
				}
			}
			if (/\bkb\b/.test(cmd)) {
				return { block: true, reason: "kb is disabled in this demo" };
			}
		}
		return undefined;
	});

	pi.registerTool({
		name: "aegis_pwn",
		label: "Aegis Pwn",
		description:
			"Run a bash command inside the x86 pwn container for the current challenge. Always prefer this over running the binary on the ARM host.",
		parameters: Type.Object({
			command: Type.String({ description: "Command, cwd is /work/aegis/<challenge>" }),
			timeout: Type.Optional(Type.Number({ description: "Seconds, default 20" })),
		}),
		async execute(_id, params) {
			const timeout = String(params.timeout ?? 20);
			try {
				const out = aegis(["pwn", params.command, "--timeout", timeout]);
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
			"End the current challenge: write a short time-sorted WP, compile memory, git-restore test/<id>. chain example: strcpy存在溢出->修改返回地址为system->getshell",
		parameters: Type.Object({
			status: Type.String({ description: "solved | failed" }),
			chain: Type.String({ description: "One-line method chain" }),
			stuck: Type.String({ description: "Where time was spent" }),
			extra: Type.Optional(Type.String()),
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
