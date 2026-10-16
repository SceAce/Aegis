// Offline smoke test for the Aegis observer/runtime extension.
//
// ROM stays in structured system sections; RAM is request-local custom context.
// Check stable prefixes, legacy section cleanup, retries, and isolated request
// copies without changing other extensions' sections or persisted history.
//
// It also checks the event-schema compatibility table: legacy observer events
// stay schema 1.0, new runtime events are schema 1.1 and must be registered.

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "../pi/node_modules/jiti/lib/jiti.mjs";

const base = resolve(new URL("..", import.meta.url).pathname);
const temp = await mkdtemp(join(tmpdir(), "aegis-observer-smoke-"));
process.env.AEGIS_EVENT_LOG = join(temp, "events.jsonl");
process.env.AEGIS_RAM_DIR = join(temp, "ram");
process.env.AEGIS_ROM_FILE = join(base, "agent", "ROM.md");
delete process.env.AEGIS_TASK_ID;

const observerPath = join(base, "extensions", "aegis-observer.ts");
// The extension imports Pi's TypeBox + defineTool helpers. In the real Pi
// process those resolve from pi/node_modules; this standalone smoke test tells
// jiti exactly where they live instead of adding repo-level node_modules.
const piNodeModules = join(base, "pi", "node_modules");
const piPackages = join(base, "pi", "packages");
const module = await createJiti(import.meta.url, {
	alias: {
		// Map to the workspace SOURCE entries, matching tsconfig paths, so the
		// smoke test does not need a built dist. typebox resolves from pi/node_modules.
		"@earendil-works/pi-ai": join(piPackages, "ai", "src", "index.ts"),
		"@earendil-works/pi-coding-agent": join(piPackages, "coding-agent", "src", "core", "extensions", "types.ts"),
	},
}).import(observerPath);
const handlers = new Map();
const tools = new Map();
const pi = {
	on(name, handler) {
		handlers.set(name, handler);
	},
	registerTool(tool) {
		tools.set(tool.name, tool);
	},
	registerCommand() {},
};
module.default(pi);

const ctx = {
	cwd: "/tmp/aegis-fixture",
	hasUI: false,
	ui: { notify() {} },
	sessionManager: { getSessionId: () => "session-smoke-001" },
};
const call = async (name, event) => {
	const handler = handlers.get(name);
	if (!handler) throw new Error(`missing observer hook: ${name}`);
	return handler(event, ctx);
};

await call("session_start", { type: "session_start", reason: "startup" });
const promptOptions = { sections: {}, selectedTools: [] };
await call("before_agent_start", {
	type: "before_agent_start",
	prompt: "Inspect the fixture",
	systemPrompt: "base prompt",
	systemPromptOptions: promptOptions,
});
if (!String(promptOptions.sections.aegis_rom ?? "").includes("Aegis ROM"))
	throw new Error("ROM was not injected as a structured section");
// Combination parity (audit item 6): the launcher no longer appends agent/ROM.md
// at the CLI, so the observer's structured `aegis_rom` section is the ONLY ROM
// carrier and must match the AEGIS_ROM_FILE source exactly (one copy, not two).
{
	const romFile = await readFile(process.env.AEGIS_ROM_FILE, "utf8");
	const romSection = String(promptOptions.sections.aegis_rom ?? "");
	if (!romSection.includes(romFile.trim())) {
		throw new Error("the aegis_rom section does not match the AEGIS_ROM_FILE source contents");
	}
	const occurrences = romSection.split(romFile.trim()).length - 1;
	if (occurrences !== 1)
		throw new Error(`the aegis_rom section carries the ROM ${occurrences} times (expected exactly once)`);
}
if (promptOptions.sections.aegis_ram !== undefined)
	throw new Error("dynamic RAM must not be injected into the system sections");
if (promptOptions.sections.systemPrompt !== undefined)
	throw new Error("observer must not replace the whole system prompt");

// Pre-migration/compacted inputs can still carry old RAM section patches.
const legacyMessages = [
	{
		role: "system",
		content: "stable base",
		sections: { aegis_rom: "stable ROM", aegis_ram: "STALE_HEAD", aegis_hints: "keep hint" },
		toolsAdded: [{ name: "read" }],
		timestamp: 1,
	},
	{ role: "user", content: "fixture prompt", timestamp: 2 },
	{ role: "system", content: "", sections: { aegis_ram: "STALE_PATCH", unrelated: "keep patch" }, timestamp: 3 },
];
const legacyBefore = JSON.stringify(legacyMessages);
const projected = await call("context_with_system", { type: "context_with_system", messages: legacyMessages });
if (JSON.stringify(legacyMessages) !== legacyBefore) throw new Error("projection mutated persisted input");
if (projected.messages.some((message) => message.role === "system" && "aegis_ram" in (message.sections ?? {})))
	throw new Error("stale RAM revived from a system patch");
if (
	projected.messages[0].sections.aegis_hints !== "keep hint" ||
	projected.messages[2].sections.unrelated !== "keep patch"
)
	throw new Error("projection changed unrelated sections");
if (projected.messages[0].toolsAdded[0].name !== "read") throw new Error("projection changed tool declarations");
const retry = await call("context_with_system", { type: "context_with_system", messages: projected.messages });
if (
	retry.messages.filter((message) => message.role === "custom" && message.customType === "aegis_ram_context").length !==
	1
)
	throw new Error("retry accumulated RAM snapshots");
if (retry.messages.at(-1).content !== projected.messages.at(-1).content)
	throw new Error("audit bookkeeping changed RAM");
if (
	JSON.stringify(retry.messages.filter((message) => message.role === "system")) !==
	JSON.stringify(projected.messages.filter((message) => message.role === "system"))
)
	throw new Error("system prefix changed on repeated projection");

// Same task across a second prompt: must reuse the Episode, not open a new one.
await call("before_agent_start", {
	type: "before_agent_start",
	prompt: "Inspect the fixture again",
	systemPrompt: "base prompt",
	systemPromptOptions: { sections: {}, selectedTools: [] },
});

await call("agent_start", { type: "agent_start" });
await call("tool_call", {
	type: "tool_call",
	toolCallId: "tool-smoke-001",
	toolName: "bash",
	input: { command: "printf 'token=secret'" },
});
await call("tool_result", {
	type: "tool_result",
	toolCallId: "tool-smoke-001",
	toolName: "bash",
	input: { command: "printf 'token=secret'" },
	content: [{ type: "text", text: "token=secret\nok" }],
	isError: false,
	details: {},
});
await call("agent_settled", { type: "agent_settled" });

// Constrained proposal tool: a claim is accepted as an unverified hint node.
const propose = tools.get("aegis_propose");
if (!propose) throw new Error("aegis_propose tool is not registered");
const accepted = await propose.execute(
	"call-1",
	{ kind: "claim", text: "the door is locked" },
	undefined,
	undefined,
	ctx,
);
if (!accepted.details?.accepted) throw new Error("valid proposal was rejected");
const malicious = await propose.execute(
	"call-2",
	{ kind: "claim", text: "door unlocked", verified: true, active: true },
	undefined,
	undefined,
	ctx,
);
if (malicious.details?.accepted) throw new Error("malicious self-claimed fact/active was accepted");
const badKind = await propose.execute("call-2b", { kind: "fact", text: "door unlocked" }, undefined, undefined, ctx);
if (badKind.details?.accepted) throw new Error("invalid kind 'fact' was accepted");
const switchTool = tools.get("aegis_switch_session");
if (!switchTool) throw new Error("aegis_switch_session tool is not registered");
// A pending action exists only while requested-but-not-completed; here it is
// complete, so the switch is allowed and recorded.
const switchResult = await switchTool.execute(
	"call-3",
	{ reason: "context is getting long" },
	undefined,
	undefined,
	ctx,
);
if (!switchResult.details?.allowed)
	throw new Error(`handoff was refused unexpectedly: ${switchResult.details?.reason}`);

await call("session_shutdown", { type: "session_shutdown", reason: "quit" });

const lines = (await readFile(process.env.AEGIS_EVENT_LOG, "utf8"))
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));
const types = lines.map((event) => event.event_type);
for (const expected of [
	"session.started",
	"episode.started",
	"prompt.received",
	"action.requested",
	"action.completed",
	"proposal.submitted",
	"proposal.rejected",
	"handoff.requested",
	"agent.settled",
	"episode.paused",
	"session.shutdown",
]) {
	if (!types.includes(expected)) throw new Error(`missing event type: ${expected}`);
}
const started = lines.filter((event) => event.event_type === "episode.started");
if (started.length !== 1) throw new Error(`expected exactly one episode.started for one task, got ${started.length}`);
const acceptedEvent = lines.find((event) => event.event_type === "proposal.submitted");
if (!acceptedEvent || acceptedEvent.source.kind !== "llm") throw new Error("accepted proposal source kind is not llm");
const rejected = lines.find((event) => event.event_type === "proposal.rejected");
if (!rejected || !/model-immutable/.test(rejected.payload.rejection_reason))
	throw new Error("malicious proposal was not rejected for immutable fields");
if (
	!lines.some(
		(event) => event.event_type === "proposal.rejected" && /kind must be one of/.test(event.payload.rejection_reason),
	)
)
	throw new Error("invalid kind was not rejected");

const completed = lines.find((event) => event.event_type === "action.completed");
if (completed.payload.content_excerpt.includes("secret")) throw new Error("secret leaked in result excerpt");
if (completed.payload.content_digest === undefined) throw new Error("result digest missing");

// Schema compatibility: legacy 1.0 events stay 1.0; runtime events are 1.1.
const { schemaForEventType, LEGACY_SCHEMA_VERSION, RUNTIME_SCHEMA_VERSION } = await import(
	join(base, "shared", "events.mjs")
);
for (const event of lines) {
	const expected = schemaForEventType(event.event_type);
	if (expected === null) throw new Error(`unknown event type recorded: ${event.event_type}`);
	if (event.schema_version !== expected)
		throw new Error(`event ${event.event_type} schema ${event.schema_version} != required ${expected}`);
}
if (LEGACY_SCHEMA_VERSION !== "1.0" || RUNTIME_SCHEMA_VERSION !== "1.1")
	throw new Error("schema version constants changed unexpectedly");
console.log(`observer smoke ok: ${lines.length} events; log=${process.env.AEGIS_EVENT_LOG}`);
