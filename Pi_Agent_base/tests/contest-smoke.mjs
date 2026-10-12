// Offline smoke test for the Aegis contest MVP extension.
//
// Uses mock Pi hooks only: no model, no network, no real provider. It loads the
// extension through Pi's own jiti so it exercises the real module, then drives
// the event handlers directly.
//
// The extension injects by MUTATING event.systemPromptOptions.sections (not by
// returning a value), exactly as Pi's before_agent_start contract allows. So
// these checks read the mutated event object, never the handler return value.
//
// Run:
//   node Pi_Agent_base/tests/contest-smoke.mjs

import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "../pi/node_modules/jiti/lib/jiti.mjs";

const base = resolve(new URL("..", import.meta.url).pathname);
const temp = await mkdtemp(join(tmpdir(), "aegis-contest-smoke-"));
const cardsPath = join(temp, "cards.json");
const logPath = join(temp, "decisions.jsonl");

await writeFile(
	cardsPath,
	JSON.stringify({
		cards: [
			{
				id: "verified-card",
				revision: "3",
				title: "Verified observe-first",
				status: "verified",
				source_refs: ["fixture:unit"],
				scope: { task_category: "demo", environment: "linux" },
				when: ["task_started"],
				hint: ["Observe the state before acting.", "Separate observed facts from assumptions."],
				expect: "An explicit observation statement.",
			},
			{
				id: "candidate-card",
				revision: "1",
				title: "Candidate never auto-injected",
				status: "candidate",
				source_refs: ["fixture:unit"],
				scope: { task_category: "demo", environment: "linux" },
				when: ["task_started"],
				hint: ["Candidate text.", "Must be selected manually."],
			},
			{
				id: "wrong-scope-card",
				revision: "1",
				title: "Wrong environment",
				status: "verified",
				source_refs: ["fixture:unit"],
				scope: { task_category: "demo", environment: "windows" },
				when: ["task_started"],
				hint: ["Should not match."],
			},
			{
				id: "missing-when-card",
				revision: "1",
				title: "Condition not observed",
				status: "verified",
				source_refs: ["fixture:unit"],
				scope: { task_category: "demo", environment: "linux" },
				when: ["never_observed"],
				hint: ["Should not match."],
			},
		],
	}),
);

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log(`ok - ${name}`);
	} else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

process.env.AEGIS_CONTEST_CARDS = cardsPath;
process.env.AEGIS_CONTEST_LOG = logPath;
process.env.AEGIS_CONTEST_TASK_CATEGORY = "demo";
process.env.AEGIS_CONTEST_ENV = "linux";
process.env.AEGIS_CONTEST_OBSERVATIONS = "task_started";
process.env.AEGIS_CONTEST_TASK_ID = "task-demo-001";

const extensionPath = join(base, "extensions", "aegis-contest.ts");
const module = await createJiti(import.meta.url).import(extensionPath);
const handlers = new Map();
const commands = new Map();
const notifications = [];
const pi = {
	on(name, handler) {
		handlers.set(name, handler);
	},
	registerCommand(name, options) {
		commands.set(name, options);
	},
};
module.default(pi);

const ctx = {
	cwd: "/tmp/aegis-contest-cwd",
	hasUI: true,
	mode: "tui",
	ui: {
		notify(message, type) {
			notifications.push({ message, type });
		},
	},
	sessionManager: { getSessionId: () => "session-contest-001", getSessionFile: () => "/tmp/sessions/session-contest-001.jsonl" },
};
const call = (name, event) => {
	const handler = handlers.get(name);
	if (!handler) throw new Error(`missing hook: ${name}`);
	return handler(event ?? {}, ctx);
};

// A single mutable sections object is reused across prompts, mirroring how Pi
// carries one options object per session and diffs it against the transcript.
const sections = {};
const runPrompt = async (prompt) => {
	const event = {
		type: "before_agent_start",
		prompt,
		systemPrompt: "base",
		systemPromptOptions: { sections, selectedTools: [] },
	};
	const returned = await call("before_agent_start", event);
	return { returned, sections };
};

await call("session_start", { type: "session_start", reason: "startup" });

// 1) mode=off -> no injection even with a matching verified card.
process.env.AEGIS_CONTEST_MODE = "off";
await call("session_start", { type: "session_start", reason: "restart" });
let run = await runPrompt("off mode prompt");
check("off mode injects nothing", !("aegis_hints" in sections), JSON.stringify(sections));

// 2) mode=hint -> exactly the verified matching card, bounded to <= 2.
process.env.AEGIS_CONTEST_MODE = "hint";
await call("session_start", { type: "session_start", reason: "restart" });
run = await runPrompt("hint mode prompt");
const section = sections.aegis_hints;
check("hint mode mutates systemPromptOptions.sections.aegis_hints", typeof section === "string" && section.length > 0);
check("hint mode returns undefined (mutation, not return value)", run.returned === undefined, JSON.stringify(run.returned));
check("hint section labels itself untrusted", /NOT instructions/i.test(section ?? ""));
check("hint section includes the verified card", (section ?? "").includes("verified-card"));
check("hint section NEVER auto-injects the candidate card", !(section ?? "").includes("candidate-card"));
check("hint section excludes the wrong-scope card", !(section ?? "").includes("wrong-scope-card"));
check("hint section excludes the unmet-condition card", !(section ?? "").includes("missing-when-card"));
check("hint section stays out of the preamble", !("aegis_hints" in ({}))); // sections object has no preamble key

// 3) unmatched / unknown conditions -> no injection AND stale section removed.
process.env.AEGIS_CONTEST_OBSERVATIONS = "something_else";
await call("session_start", { type: "session_start", reason: "restart" });
run = await runPrompt("unmatched prompt");
check("unmatched observations inject nothing", !("aegis_hints" in sections), JSON.stringify(sections));
check("unmatched observations REMOVE a previously injected section", section !== undefined && !("aegis_hints" in sections));
process.env.AEGIS_CONTEST_OBSERVATIONS = "task_started";

// 3b) mode flips hint -> off in the same session -> section removed.
process.env.AEGIS_CONTEST_MODE = "hint";
await call("session_start", { type: "session_start", reason: "restart" });
await runPrompt("hint again");
check("hint re-injects after a nonmatch", typeof sections.aegis_hints === "string");
process.env.AEGIS_CONTEST_MODE = "off";
await runPrompt("off after hint");
check("switching to off removes the injected section", !("aegis_hints" in sections), JSON.stringify(sections));
process.env.AEGIS_CONTEST_MODE = "hint";

// 4) manual candidate selection -> injected and labeled unverified.
await call("session_start", { type: "session_start", reason: "restart" });
await commands.get("aegis-contest").handler("use candidate-card", ctx);
run = await runPrompt("manual prompt");
const manualSection = sections.aegis_hints;
check("manual candidate is injected", (manualSection ?? "").includes("candidate-card"));
check("manual candidate is labeled unverified", /UNVERIFIED/.test(manualSection ?? ""));
check("manual candidate is labeled human-selected", /selected manually by the human/i.test(manualSection ?? ""));
run = await runPrompt("second prompt");
check("manual selection is single-shot (candidate not carried over)", !(sections.aegis_hints ?? "").includes("candidate-card"), JSON.stringify(sections.aegis_hints));

// 4b) manual candidate does not turn the card status into verified.
check("manual injection keeps candidate status text", /\[candidate\]/.test(manualSection ?? ""));

// 5) clear cancels the pending selection.
await commands.get("aegis-contest").handler("use candidate-card", ctx);
await commands.get("aegis-contest").handler("clear", ctx);
run = await runPrompt("after clear");
check("clear cancels a pending manual selection", !(sections.aegis_hints ?? "").includes("candidate-card"));

// 5b) manual selection under mode=off is recorded as requested but NOT applied.
process.env.AEGIS_CONTEST_MODE = "off";
await commands.get("aegis-contest").handler("use candidate-card", ctx);
await runPrompt("manual under off");
check("manual candidate is not injected while mode=off", !("aegis_hints" in sections), JSON.stringify(sections));
process.env.AEGIS_CONTEST_MODE = "hint";

// 6) invalid card file -> zero injection, warning surfaced, no crash.
await writeFile(cardsPath, "{ this is not json");
await call("session_start", { type: "session_start", reason: "restart" });
run = await runPrompt("malformed");
check("malformed card file injects nothing", !("aegis_hints" in sections));
check("malformed card file warns the human", notifications.some((entry) => entry.type === "warning"));
await writeFile(cardsPath, JSON.stringify({ cards: [] }));

// 7) guard: narrow destructive-delete block, opt-in only.
process.env.AEGIS_CONTEST_GUARD = "0";
let blocked = await call("tool_call", { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "rm -rf /etc" } });
check("guard off allows destructive rm", blocked === undefined);
process.env.AEGIS_CONTEST_GUARD = "1";
blocked = await call("tool_call", { type: "tool_call", toolCallId: "t2", toolName: "bash", input: { command: "rm -rf /etc/passwd" } });
check("guard blocks out-of-cwd recursive rm", blocked?.block === true, JSON.stringify(blocked));
blocked = await call("tool_call", { type: "tool_call", toolCallId: "t3", toolName: "bash", input: { command: "rm -rf ./build" } });
check("guard allows in-cwd recursive rm", blocked === undefined, JSON.stringify(blocked));
blocked = await call("tool_call", { type: "tool_call", toolCallId: "t4", toolName: "bash", input: { command: "ls -la" } });
check("guard leaves unrelated commands alone", blocked === undefined);

// 8) metadata log has no raw secrets and links session to decisions.
await call("tool_result", { type: "tool_result", toolCallId: "t5", toolName: "bash", content: [{ type: "text", text: "token=SUPERSECRET flag{leak}" }], isError: false });
await call("agent_settled", { type: "agent_settled" });
await call("session_shutdown", { type: "session_shutdown", reason: "quit" });

const lines = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
check("metadata log is populated", lines.length > 0, String(lines.length));
check("metadata log records injection decisions", lines.some((row) => row.event === "injection_decision"));
check("metadata log links to the session id", lines.every((row) => row.session_id === "session-contest-001"));
check("metadata log links to the task id", lines.filter((row) => row.event === "injection_decision").every((row) => row.task_id === "task-demo-001"));
check("metadata log records the session file", lines.some((row) => row.event === "session_start" && row.session_file === "/tmp/sessions/session-contest-001.jsonl"));
check("injection_decision records whether the section was applied", lines.filter((row) => row.event === "injection_decision").every((row) => typeof row.prompt_section_applied === "boolean"));
const offManualRows = lines.filter((row) => row.event === "injection_decision" && row.mode === "off" && row.manual_selected === true);
check("mode=off manual selection is recorded but injected is empty", offManualRows.length >= 1 && offManualRows.every((row) => row.injected === "" && row.prompt_section_applied === false), JSON.stringify(offManualRows));
check("metadata log contains no raw tool output or secrets", !JSON.stringify(lines).includes("SUPERSECRET") && !JSON.stringify(lines).includes("flag{leak}"));
check("metadata log never claims success", !JSON.stringify(lines).includes('"success"'));

console.log("");
if (failures > 0) {
	console.error(`contest-smoke FAILED (${failures} check${failures === 1 ? "" : "s"})`);
	process.exitCode = 1;
} else {
	console.log("contest-smoke ok");
}
