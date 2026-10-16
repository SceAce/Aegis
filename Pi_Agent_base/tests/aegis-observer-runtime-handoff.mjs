// A3/A4 -- REAL AgentSessionRuntime short-session handoff.
//
// The existing `aegis-observer-outcome-command` test proves the /aegis switch
// COMMAND path with an INJECTED `newSession` seam; it explicitly does NOT swap
// the real runtime. This test closes that gap: it builds a real
// `AgentSessionRuntime` (via `createAgentSessionRuntime` +
// `createAgentSessionServices` + `createAgentSessionFromServices`), wires the
// command context's `newSession` to `runtime.newSession`, and proves:
//
//   1. The LLM's `aegis_switch_session` proposal stages a handoff, and applying
//      it (manual command OR post-settle Host helper) actually replaces the
//      session with a distinct session file while keeping the SAME episode,
//      authorization, budget, goal and board.
//   2. `handoff.completed` is recorded EXACTLY ONCE per switch (the new
//      session's `session_start` owns it; the old `withSession` callback must
//      not double-write), and the staged file is retired only after success.
//   3. A cancelled switch leaves the request staged and records no completion
//      (no fake success).
//   4. A creation failure leaves the request staged and records no completion.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-observer-runtime-handoff.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";

import { projectBoard } from "../memory/board.mjs";
import { projectState } from "../memory/state.mjs";
import { applyStagedHandoff } from "../session/handoff-host.mjs";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVER_PATH = join(BASE_DIR, "extensions", "aegis-observer.ts");

let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

function makeFauxModelDetails(model) {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		api: model.api,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		baseUrl: model.baseUrl,
	};
}

function readEvents(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function lastUserText(messages) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (!message || message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content.map((part) => part?.text || "").join(" ")
					: "";
		// The real provider also sees request-local RAM as user-role context; the
		// deterministic faux dispatcher must select the human prompt, not RAM.
		if (text.startsWith("<aegis_ram>\n")) continue;
		return text;
	}
	return "";
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-runtime-handoff-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	const eventLog = join(base, "events.jsonl");
	const ramDir = join(base, "ram");
	const handoffFile = join(ramDir, "handoff.json");
	const cancelExtPath = join(base, "cancel-ext.ts");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	writeFileSync(
		cancelExtPath,
		`export default function (pi) {\n\tpi.on("session_before_switch", async () => (process.env.AEGIS_TEST_CANCEL_SWITCH === "1" ? { cancel: true } : undefined));\n}\n`,
	);

	process.env.AEGIS_EVENT_LOG = eventLog;
	process.env.AEGIS_RAM_DIR = ramDir;
	process.env.AEGIS_HANDOFF_FILE = handoffFile;
	process.env.AEGIS_ROM_FILE = join(BASE_DIR, "agent", "ROM.md");
	process.env.AEGIS_TASK_ID = "task-runtime-handoff";
	delete process.env.AEGIS_TEST_CANCEL_SWITCH;

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-runtime", name: "FauxRuntime" }] });
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(base, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, makeFauxModelDetails(model));

	// The factory is called once per session (including every replacement), so it
	// recreates a fresh resource loader => a fresh Observer extension instance.
	const createRuntime = async ({ cwd: sessionCwd, agentDir: sessionAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: sessionCwd,
			agentDir: sessionAgentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				additionalExtensionPaths: [OBSERVER_PATH, cancelExtPath],
			},
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model,
			tools: ["read", "aegis_propose", "aegis_switch_session"],
		});
		return { ...result, services, diagnostics: services.diagnostics };
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.create(cwd, sessionDir),
	});

	let rebindCount = 0;
	const bindSession = async () => {
		const session = runtime.session;
		await session.bindExtensions({
			mode: "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtime.newSession(options),
				fork: async (entryId, options) => {
					const result = await runtime.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
				reload: async () => {
					await session.reload();
				},
			},
		});
		rebindCount += 1;
	};
	runtime.setRebindSession(bindSession);
	await bindSession();
	check("the initial real runtime session is bound", rebindCount === 1);

	const captured = [];
	let turn = 0;
	function responder(ctx) {
		captured.push(ctx.messages);
		turn += 1;
		const text = lastUserText(ctx.messages);
		if (turn === 1 && text.includes("breadcrumb")) {
			return fauxAssistantMessage([fauxToolCall("aegis_propose", { kind: "intent", text: "handoff-breadcrumb" })]);
		}
		if (turn === 1 && text.includes("hand over")) {
			return fauxAssistantMessage([
				fauxToolCall("aegis_switch_session", { reason: "context budget is nearly exhausted" }),
			]);
		}
		return fauxAssistantMessage("ok");
	}
	function resetTurn() {
		turn = 0;
	}
	function queue(n) {
		resetTurn();
		faux.setResponses(Array.from({ length: n }, () => responder));
	}

	// ---- Phase 0: start an episode and leave a board breadcrumb ---------------
	queue(1);
	await runtime.session.prompt("Start the runtime handoff task.");
	queue(2);
	await runtime.session.prompt("Propose a breadcrumb.");
	const startedState = projectState(readEvents(eventLog));
	const episodeId = Object.keys(startedState.episodes)[0];
	check(
		"an episode was opened for the task",
		typeof episodeId === "string" &&
			startedState.episodes[episodeId].goal.description === "Start the runtime handoff task.",
		JSON.stringify(startedState.episodes),
	);
	check(
		"the model's intent proposal is on the board (breadcrumb preserved)",
		projectBoard(readEvents(eventLog)).nodes.some((node) => node.text.includes("handoff-breadcrumb")),
	);

	// ---- Phase 1: MANUAL /aegis switch through the real runtime --------------
	queue(2);
	await runtime.session.prompt("Please hand over to a fresh session.");
	check("the LLM proposal staged a handoff file", existsSync(handoffFile), handoffFile);
	const stagedManual = JSON.parse(readFileSync(handoffFile, "utf8"));
	check(
		"the staged handoff points at the live episode",
		stagedManual.episode_id === episodeId,
		JSON.stringify(stagedManual),
	);
	const settled = readEvents(eventLog)
		.filter((e) => e.event_type === "agent.settled")
		.pop();
	check(
		"the Observer signaled a ready handoff at settle (thin Host trigger)",
		settled?.payload?.handoff_ready === true && settled?.payload?.handoff_request_id === stagedManual.request_id,
		JSON.stringify(settled?.payload),
	);

	const beforeManual = runtime.session;
	const beforeManualFile = beforeManual.sessionFile;
	const beforeManualId = beforeManual.sessionId;
	queue(1); // the continuation prompt on the replacement
	await runtime.session.prompt("/aegis switch");

	check("manual switch replaced the session object", runtime.session !== beforeManual);
	check(
		"manual switch opened a DISTINCT session file",
		typeof runtime.session.sessionFile === "string" && runtime.session.sessionFile !== beforeManualFile,
		`${beforeManualFile} -> ${runtime.session.sessionFile}`,
	);
	check("manual switch changed the session id", runtime.session.sessionId !== beforeManualId);

	let events = readEvents(eventLog);
	const manualCompletions = events.filter(
		(e) => e.event_type === "handoff.completed" && e.payload?.request_id === stagedManual.request_id,
	);
	check(
		"manual switch recorded handoff.completed exactly once",
		manualCompletions.length === 1,
		`count=${manualCompletions.length}`,
	);
	check(
		"the completion was written by the NEW session via the runtime",
		manualCompletions[0]?.source?.kind === "runtime" &&
			manualCompletions[0]?.payload?.to_session === runtime.session.sessionId,
		JSON.stringify(manualCompletions[0]?.payload),
	);
	check(
		"the staged handoff was retired only AFTER success",
		!existsSync(handoffFile) && existsSync(`${handoffFile}.applied.json`),
	);

	const manualState = projectState(events);
	check(
		"the SAME episode survived the switch",
		manualState.episodes[episodeId]?.status === "open",
		JSON.stringify(manualState.episodes[episodeId]),
	);
	check(
		"both sessions are linked to the one episode (session != episode)",
		(manualState.episodes[episodeId]?.sessions || []).length >= 2,
		JSON.stringify(manualState.episodes[episodeId]?.sessions),
	);
	check(
		"the original goal was not overwritten by the continuation",
		manualState.episodes[episodeId]?.goal?.description === "Start the runtime handoff task.",
	);
	check(
		"the board breadcrumb survived the switch",
		projectBoard(events).nodes.some((node) => node.text.includes("handoff-breadcrumb")),
	);

	const newTranscript = JSON.stringify(runtime.session.messages);
	check(
		"the replacement delivered the continuation user message",
		newTranscript.includes("[Aegis] continuing episode"),
	);
	const newUserTexts = runtime.session.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: (message.content || []).map((part) => part?.text || "").join(" "),
		);
	check(
		"the replacement did NOT replay the old session's USER prompt",
		!newUserTexts.some((text) => text.includes("Start the runtime handoff task.")),
		JSON.stringify(newUserTexts),
	);
	const continuationRequests = captured.slice(-1)[0] || [];
	check(
		"the continuation request carried the preserved goal + board in RAM",
		JSON.stringify(continuationRequests).includes("Start the runtime handoff task.") &&
			JSON.stringify(continuationRequests).includes("handoff-breadcrumb"),
		"RAM did not carry goal/breadcrumb",
	);

	// ---- Phase 2: AUTO (Host helper) switch through the real runtime ---------
	queue(2);
	await runtime.session.prompt("Please hand over to a fresh session again.");
	const stagedAuto = JSON.parse(readFileSync(handoffFile, "utf8"));
	const beforeAuto = runtime.session;
	const beforeAutoFile = beforeAuto.sessionFile;
	queue(1); // helper continuation prompt
	const autoResult = await applyStagedHandoff({
		eventLogPath: eventLog,
		handoffPath: handoffFile,
		runtime,
		taskId: process.env.AEGIS_TASK_ID,
	});
	check("the Host helper applied the staged handoff", autoResult.applied === true, JSON.stringify(autoResult));
	check(
		"the helper switch replaced the session with a distinct file",
		runtime.session !== beforeAuto && runtime.session.sessionFile !== beforeAutoFile,
		JSON.stringify({ before: beforeAutoFile, after: runtime.session.sessionFile }),
	);
	events = readEvents(eventLog);
	const autoCompletions = events.filter(
		(e) => e.event_type === "handoff.completed" && e.payload?.request_id === stagedAuto.request_id,
	);
	check(
		"the helper switch recorded handoff.completed exactly once",
		autoCompletions.length === 1,
		`count=${autoCompletions.length}`,
	);
	check(
		"the helper switch retired the staged file",
		!existsSync(handoffFile) && existsSync(`${handoffFile}.applied.json`),
	);

	// ---- Phase 3: a cancelled switch must NOT fake success -------------------
	queue(2);
	await runtime.session.prompt("Please hand over to a fresh session one final time.");
	const stagedCancel = JSON.parse(readFileSync(handoffFile, "utf8"));
	const beforeCancel = runtime.session;
	const completionsBeforeCancel = readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length;
	process.env.AEGIS_TEST_CANCEL_SWITCH = "1";
	resetTurn();
	faux.setResponses([]);
	await runtime.session.prompt("/aegis switch");
	delete process.env.AEGIS_TEST_CANCEL_SWITCH;
	check("a cancelled switch did not replace the session", runtime.session === beforeCancel);
	check("a cancelled switch left the request staged", existsSync(handoffFile), handoffFile);
	check(
		"a cancelled switch recorded NO completion",
		readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length === completionsBeforeCancel,
	);
	check(
		"a cancelled switch did not retire the staged file",
		!existsSync(`${handoffFile}.applied.json`) ||
			JSON.parse(readFileSync(`${handoffFile}.applied.json`, "utf8")).request_id !== stagedCancel.request_id,
	);

	// ---- Phase 4: a creation failure must NOT fake success -------------------
	const completionsBeforeFailure = readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length;
	const failure = await applyStagedHandoff({
		eventLogPath: eventLog,
		handoffPath: handoffFile,
		runtime: {
			newSession: async () => {
				throw new Error("boom");
			},
		},
		taskId: process.env.AEGIS_TASK_ID,
	});
	check(
		"a creation failure is reported, not swallowed",
		failure.applied === false && failure.reason === "boom",
		JSON.stringify(failure),
	);
	check("a creation failure left the request staged", existsSync(handoffFile));
	check(
		"a creation failure recorded NO completion",
		readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length === completionsBeforeFailure,
	);

	// ---- Global invariants ---------------------------------------------------
	events = readEvents(eventLog);
	const totalCompletions = events.filter((e) => e.event_type === "handoff.completed");
	check(
		"every successful switch produced exactly one completion (2 total)",
		totalCompletions.length === 2,
		`count=${totalCompletions.length}`,
	);
	const finalState = projectState(events);
	check(
		"one episode, not a new one per session",
		Object.keys(finalState.episodes).length === 1,
		JSON.stringify(Object.keys(finalState.episodes)),
	);
	check(
		"no board node was created by request.projected/handoff bookkeeping",
		projectBoard(events).byType.Fact.length === 0 && projectBoard(events).byType.Refuted.length === 0,
	);

	await runtime.dispose();
	rmSync(base, { recursive: true, force: true });

	if (failures > 0) {
		console.log(`\naegis-observer-runtime-handoff FAILED: ${failures} assertion(s)`);
		process.exit(1);
	}
	console.log("\naegis-observer-runtime-handoff ok");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
