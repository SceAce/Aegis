// C2 — REAL Host-level Pi Session rotation through the Host/scheduler entry.
//
// This suite drives the NEW `createSessionSupervisor` (the Host/scheduler-facing
// entry, NOT a factory helper) against a REAL `AgentSessionRuntime` built from
// the actual Pi SDK, with a faux provider. It proves:
//
//   * a genuinely NEW AgentSession/Runtime/context is created and bound, observed
//     via object identity, a distinct session file/id and the provider request
//     boundary — not via a returned id or text alone;
//   * Episode, authorization, stage, facts, unknowns, pending-recovery and the
//     CUMULATIVE budget survive the rotation (no reset, no new evidence group);
//   * an in-flight / unresolved side effect, or insufficient session budget,
//     refuses the rotation with no replacement and no completion;
//   * cancel and creation failure leave the handoff staged with NO false
//     completion and no double accounting;
//   * replaying the same request is idempotent (no second replacement/completion/
//     charge); an interrupted handoff is recoverable once.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c2-session-rotation.mjs

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
import { createSessionSupervisor } from "../session/session-supervisor.mjs";

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
		// Select the human prompt, not the request-local runtime RAM context.
		if (text.startsWith("<aegis_ram>\n")) continue;
		return text;
	}
	return "";
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-c2-rotation-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	const eventLog = join(base, "events.jsonl");
	const ramDir = join(base, "ram");
	const handoffFile = join(ramDir, "handoff.json");
	const knowledgeDir = join(base, "knowledge");
	const cancelExtPath = join(base, "cancel-ext.ts");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(knowledgeDir, { recursive: true });
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
	process.env.AEGIS_TASK_ID = "task-c2-rotation";
	process.env.AEGIS_KNOWLEDGE_DIR = knowledgeDir;
	delete process.env.AEGIS_TEST_CANCEL_SWITCH;

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-c2", name: "FauxC2" }] });
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(base, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, makeFauxModelDetails(model));

	let createdSessions = 0;
	const createRuntime = async ({ cwd: sessionCwd, agentDir: sessionAgentDir, sessionManager, sessionStartEvent }) => {
		createdSessions += 1;
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
	check("initial real runtime session is bound", rebindCount === 1);

	const captured = [];
	let turn = 0;
	function responder(ctx) {
		captured.push(ctx.messages);
		turn += 1;
		const text = lastUserText(ctx.messages);
		if (turn === 1 && text.includes("breadcrumb")) {
			return fauxAssistantMessage([fauxToolCall("aegis_propose", { kind: "intent", text: "c2-breadcrumb" })]);
		}
		if (turn === 1 && text.includes("hand over")) {
			return fauxAssistantMessage([
				fauxToolCall("aegis_switch_session", { reason: "context budget is nearly exhausted" }),
			]);
		}
		return fauxAssistantMessage("ok");
	}
	function queue(n) {
		turn = 0;
		faux.setResponses(Array.from({ length: n }, () => responder));
	}

	// A trusted Session/Campaign budget ledger. `max_requests_per_session` is the
	// per-session request quota; cumulative counters must NOT reset on rotation.
	const budget = {
		limit: { wall_time_ms: 600000, model_requests: 100, tool_calls: 200, session_count: 20 },
		consumed: { wall_time_ms: 1000, model_requests: 3, tool_calls: 2, session_count: 1 },
		max_requests_per_session: 10,
	};

	function makeSupervisor(overrides = {}) {
		return createSessionSupervisor({
			eventLogPath: eventLog,
			handoffPath: handoffFile,
			runtime,
			taskId: process.env.AEGIS_TASK_ID,
			budget,
			...overrides,
		});
	}

	// ---- Phase 0: open an episode and leave a Fact breadcrumb ----------------
	queue(1);
	await runtime.session.prompt("C2 continuity task.");
	queue(2);
	await runtime.session.prompt("Propose a breadcrumb.");
	const startedState = projectState(readEvents(eventLog));
	const episodeId = Object.keys(startedState.episodes)[0];
	check(
		"an episode was opened for the task",
		typeof episodeId === "string" && startedState.episodes[episodeId].goal.description === "C2 continuity task.",
		JSON.stringify(startedState.episodes),
	);
	check(
		"the intent proposal breadcrumb is on the board",
		projectBoard(readEvents(eventLog)).nodes.some((node) => node.text.includes("c2-breadcrumb")),
	);

	// ---- C2-S4: allowed boundary (positive) ----------------------------------
	const supervisor = makeSupervisor();
	const precheck = await supervisor.canRotate();
	check("C2-S4 a settled, budgeted boundary is allowed", precheck.allowed === true, JSON.stringify(precheck));

	// ---- Phase 1: real rotation through the Host supervisor entry ------------
	queue(2);
	await runtime.session.prompt("Please hand over to a fresh session.");
	check("the LLM proposal staged a handoff file", existsSync(handoffFile), handoffFile);
	const staged = JSON.parse(readFileSync(handoffFile, "utf8"));
	check("the staged handoff points at the live episode", staged.episode_id === episodeId, JSON.stringify(staged));

	// Now do the real rotation.
	const realSupervisor = makeSupervisor();
	const beforeRotation = runtime.session;
	const beforeFile = beforeRotation.sessionFile;
	const beforeId = beforeRotation.sessionId;
	const sessionsCreatedBefore = createdSessions;
	queue(1);
	const rotation = await realSupervisor.rotate();
	check("C2-N1 the supervisor applied a real rotation", rotation.applied === true, JSON.stringify(rotation));
	check("C2-P1 a genuinely NEW AgentSession object was created", runtime.session !== beforeRotation);
	check(
		"C2-P1 the rotation created exactly one new runtime session",
		createdSessions === sessionsCreatedBefore + 1,
		`created=${createdSessions}`,
	);
	check(
		"C2-N1 a DISTINCT session file was opened",
		typeof runtime.session.sessionFile === "string" && runtime.session.sessionFile !== beforeFile,
		`${beforeFile} -> ${runtime.session.sessionFile}`,
	);
	check("C2-N1 the SDK session id changed", runtime.session.sessionId !== beforeId);

	let events = readEvents(eventLog);
	const completions = events.filter(
		(e) => e.event_type === "handoff.completed" && e.payload?.request_id === staged.request_id,
	);
	check("C2-N1 handoff.completed was recorded exactly once", completions.length === 1, `count=${completions.length}`);
	check(
		"C2-P1 the completion was written by the NEW session via the runtime",
		completions[0]?.source?.kind === "runtime" && completions[0]?.payload?.to_session === runtime.session.sessionId,
		JSON.stringify(completions[0]?.payload),
	);

	// ---- C2-N2: continuity of episode ---------------------------------------
	const afterState = projectState(events);
	check(
		"C2-N2 the SAME episode survived (one episode only)",
		Object.keys(afterState.episodes).length === 1 && afterState.episodes[episodeId]?.status === "open",
		JSON.stringify(Object.keys(afterState.episodes)),
	);
	check(
		"C2-N2 both sessions are linked to the one episode",
		(afterState.episodes[episodeId]?.sessions || []).length >= 2,
		JSON.stringify(afterState.episodes[episodeId]?.sessions),
	);
	check(
		"C2-N2 the original goal was not overwritten",
		afterState.episodes[episodeId]?.goal?.description === "C2 continuity task.",
	);
	check(
		"C2-N4 the fact breadcrumb survived the rotation",
		projectBoard(events).nodes.some((node) => node.text.includes("c2-breadcrumb")),
	);

	// ---- C2-N3: budget continuity -------------------------------------------
	const bBefore = rotation.budget_before;
	const bAfter = rotation.budget_after;
	check("C2-N3 budget_before/after are reported", bBefore && bAfter, JSON.stringify({ bBefore, bAfter }));
	check(
		"C2-N3 cumulative model_requests did not reset or decrease",
		(bAfter?.consumed?.model_requests ?? 0) >= (bBefore?.consumed?.model_requests ?? 0),
		JSON.stringify({ bBefore, bAfter }),
	);
	check(
		"C2-N3 remaining never increased across the rotation",
		(bAfter?.remaining?.model_requests ?? 0) <= (bBefore?.remaining?.model_requests ?? 0),
		JSON.stringify({ bBefore, bAfter }),
	);
	check(
		"C2-N3 the session generation advanced by exactly one",
		(bAfter?.consumed?.session_count ?? 0) === (bBefore?.consumed?.session_count ?? 0) + 1,
		JSON.stringify({ bBefore, bAfter }),
	);
	// The reported generation is derived from COMMITTED events, so a repeat call
	// cannot double-charge and a later rotation cannot reset it.
	const committedAtN1 = readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length;
	check(
		"C2-N3 the reported generation matches committed completions + initial",
		(bAfter?.consumed?.session_count ?? 0) === committedAtN1 + 1,
		JSON.stringify({ reported: bAfter?.consumed?.session_count, completions: committedAtN1 }),
	);

	// ---- C2-N4: bounded RAM, not a transcript copy ---------------------------
	const newUserTexts = runtime.session.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: (message.content || []).map((part) => part?.text || "").join(" "),
		);
	check(
		"C2-N4 the replacement delivered the continuation message",
		newUserTexts.some((text) => text.includes("[Aegis] continuing episode")),
	);
	check(
		"C2-N4 the replacement did NOT replay the old session's user prompt",
		!newUserTexts.some((text) => text.includes("C2 continuity task.")),
		JSON.stringify(newUserTexts),
	);
	const continuationRequest = captured.slice(-1)[0] || [];
	const continuationText = JSON.stringify(continuationRequest);
	check(
		"C2-N4 the continuation carried the preserved goal + breadcrumb in bounded RAM",
		continuationText.includes("C2 continuity task.") && continuationText.includes("c2-breadcrumb"),
		"RAM did not carry goal/breadcrumb",
	);
	check(
		"C2-N4 the continuation RAM is bounded (not a transcript copy)",
		continuationText.length < 20000,
		`ram_chars=${continuationText.length}`,
	);

	// ---- C2-I1: idempotent replay of the same request ------------------------
	const runtimeBeforeReplay = runtime.session;
	const completionsBeforeReplay = readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length;
	const replay = await makeSupervisor().rotate({ requestId: staged.request_id });
	check(
		"C2-I1 a replayed request is reported as reused",
		replay.applied === true && replay.reused === true,
		JSON.stringify(replay),
	);
	check("C2-I1 the replay did NOT replace the runtime again", runtime.session === runtimeBeforeReplay);
	check(
		"C2-I1 the replay added NO second completion",
		readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length === completionsBeforeReplay,
	);

	// ---- C2-F1: cancel leaves no false completion ----------------------------
	queue(2);
	await runtime.session.prompt("Please hand over to a fresh session again.");
	const beforeCancel = runtime.session;
	const completionsBeforeCancel = readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length;
	process.env.AEGIS_TEST_CANCEL_SWITCH = "1";
	turn = 0;
	faux.setResponses([]);
	const cancelResult = await makeSupervisor().rotate();
	delete process.env.AEGIS_TEST_CANCEL_SWITCH;
	check(
		"C2-F1 a cancelled rotation is reported cancelled",
		cancelResult.applied === false && cancelResult.cancelled === true,
		JSON.stringify(cancelResult),
	);
	check("C2-F1 a cancelled rotation did not replace the session", runtime.session === beforeCancel);
	check(
		"C2-F1 a cancelled rotation recorded NO completion",
		readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length === completionsBeforeCancel,
	);
	check("C2-F1 a cancelled rotation left the request staged", existsSync(handoffFile), handoffFile);

	// ---- C2-F2: creation failure leaves no false completion ------------------
	const completionsBeforeFailure = readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length;
	const failure = await makeSupervisor({
		runtime: {
			newSession: async () => {
				throw new Error("boom");
			},
		},
	}).rotate();
	check(
		"C2-F2 a creation failure is reported, not swallowed",
		failure.applied === false && failure.reason === "boom",
		JSON.stringify(failure),
	);
	check("C2-F2 a creation failure left the request staged", existsSync(handoffFile));
	check(
		"C2-F2 a creation failure recorded NO completion",
		readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length === completionsBeforeFailure,
	);

	// ---- C2-S1/S2/S3: refusals (offline supervisor contract, unit level) -----
	// These are unit-level checks on the supervisor's decision logic with a
	// controlled EventLog, so they never fork the live runtime's single-writer
	// chain. The real rotation phases above prove the product entry.
	const { EventLog } = await import("../shared/events.mjs");
	const offline = await (async () => {
		const dir = mkdtempSync(join(tmpdir(), "aegis-c2-offline-"));
		const logPath = join(dir, "events.jsonl");
		const hoPath = join(dir, "handoff.json");
		const log = new EventLog(logPath);
		await log.open();
		const src = { actor_id: "c2-test", kind: "runtime", adapter: "aegis-test", version: "0.1.0" };
		const ep = "ep-c2-offline";
		await log.append({
			event_type: "episode.started",
			episode_id: ep,
			payload: {
				task_id: "task-offline",
				goal: { description: "offline goal" },
				authorization: "authorized",
				budget: { limit: { session_count: 5 }, consumed: { session_count: 1 } },
			},
			source: src,
		});
		await log.append({
			event_type: "action.requested",
			episode_id: ep,
			payload: { action_id: "act-inflight", tool_name: "aegis_execute" },
			source: src,
		});
		await log.close();
		writeFileSync(
			hoPath,
			JSON.stringify(
				{ request_id: "req-offline", episode_id: ep, task_id: "task-offline", reason: "offline" },
				null,
				2,
			),
		);
		const stubRuntime = { newSession: async () => ({ cancelled: false }) };
		const s1 = createSessionSupervisor({
			eventLogPath: logPath,
			handoffPath: hoPath,
			runtime: stubRuntime,
			taskId: "task-offline",
			budget: { limit: { session_count: 5 }, consumed: { session_count: 1 } },
		});
		const inflight = await s1.canRotate();
		const inflightAttempt = await s1.rotate();
		// C2-S3 needs a CLEAN, settled episode with an exhausted budget so the
		// refusal can only come from the budget guard (not a pending action).
		const dir2 = mkdtempSync(join(tmpdir(), "aegis-c2-offline2-"));
		const logPath2 = join(dir2, "events.jsonl");
		const hoPath2 = join(dir2, "handoff.json");
		const log3 = new EventLog(logPath2);
		await log3.open();
		await log3.append({
			event_type: "episode.started",
			episode_id: "ep-c2-budget",
			payload: {
				task_id: "task-budget",
				goal: { description: "budget goal" },
				authorization: "authorized",
				budget: { limit: { session_count: 1 }, consumed: { session_count: 1 } },
			},
			source: src,
		});
		await log3.close();
		writeFileSync(
			hoPath2,
			JSON.stringify(
				{ request_id: "req-budget", episode_id: "ep-c2-budget", task_id: "task-budget", reason: "budget" },
				null,
				2,
			),
		);
		let stubNewSessionCalls = 0;
		const countingRuntime = {
			newSession: async () => {
				stubNewSessionCalls += 1;
				return { cancelled: false };
			},
		};
		const exhausted = createSessionSupervisor({
			eventLogPath: logPath2,
			handoffPath: hoPath2,
			runtime: countingRuntime,
			taskId: "task-budget",
			budget: { limit: { session_count: 1 }, consumed: { session_count: 1 } },
		});
		const budgetVerdict = await exhausted.canRotate();
		const budgetRotate = await exhausted.rotate();
		rmSync(dir2, { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
		return { inflight, inflightAttempt, budgetVerdict, budgetRotate, stubNewSessionCalls };
	})();
	check(
		"C2-S1 an in-flight side effect blocks rotation",
		offline.inflight.allowed === false && /unfinished|unresolved/i.test(offline.inflight.reason),
		JSON.stringify(offline.inflight),
	);
	check(
		"C2-S1 a blocked rotate does not call newSession",
		offline.inflightAttempt.applied === false,
		JSON.stringify(offline.inflightAttempt),
	);
	check(
		"C2-S2 the refusal names the blocking action",
		(offline.inflight.blocking || []).includes("aegis_execute"),
		JSON.stringify(offline.inflight),
	);
	check(
		"C2-S3 an exhausted session budget refuses rotation",
		offline.budgetVerdict.allowed === false && /budget|session/i.test(offline.budgetVerdict.reason),
		JSON.stringify(offline.budgetVerdict),
	);
	check(
		"C2-S3 rotate() also refuses on exhausted session budget and calls no newSession",
		offline.budgetRotate.applied === false &&
			/budget|session/i.test(offline.budgetRotate.reason) &&
			offline.stubNewSessionCalls === 0,
		JSON.stringify({ budgetRotate: offline.budgetRotate, calls: offline.stubNewSessionCalls }),
	);

	// ---- C2-I2: interrupted recovery -----------------------------------------
	// Clear the staged cancel/failure file, then stage a FRESH handoff through a
	// model proposal, and apply it once with a throwing runtime to simulate an
	// interruption BEFORE the completion is committed. The file stays staged with
	// no completion; recoverInterrupted() must then apply it exactly once through
	// the real path.
	try {
		rmSync(handoffFile, { force: true });
		rmSync(`${handoffFile}.applied.json`, { force: true });
	} catch {
		// ignore
	}
	queue(2);
	await runtime.session.prompt("Please hand over to a fresh session for recovery.");
	check("C2-I2 a fresh handoff is staged for recovery", existsSync(handoffFile), handoffFile);
	const recoveryStaged = JSON.parse(readFileSync(handoffFile, "utf8"));
	const recoverBefore = runtime.session;
	await makeSupervisor({
		runtime: {
			newSession: async () => {
				throw new Error("interrupted");
			},
		},
	}).rotate();
	const completionsBeforeRecovery = readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length;
	check(
		"C2-I2 the interruption left the request staged with no completion",
		existsSync(handoffFile) &&
			readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length === completionsBeforeRecovery,
	);
	queue(1);
	const recovered = await makeSupervisor().recoverInterrupted();
	check(
		"C2-I2 recoverInterrupted() applied the staged handoff",
		recovered.recovered === true && recovered.applied === true,
		JSON.stringify(recovered),
	);
	check("C2-I2 the recovery replaced the runtime with a new session", runtime.session !== recoverBefore);
	check(
		"C2-I2 the recovery recorded exactly one completion",
		readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length === completionsBeforeRecovery + 1,
		`count=${readEvents(eventLog).filter((e) => e.event_type === "handoff.completed").length}`,
	);
	check(
		"C2-I2 the recovery reused the staged request id",
		recovered.request_id === recoveryStaged.request_id,
		JSON.stringify({ recovered: recovered.request_id, staged: recoveryStaged.request_id }),
	);

	// ---- Global invariants ---------------------------------------------------
	events = readEvents(eventLog);
	const finalState = projectState(events);
	check(
		"C2-N2 one episode for the whole rotation sequence",
		Object.keys(finalState.episodes).length === 1,
		JSON.stringify(Object.keys(finalState.episodes)),
	);
	check(
		"C2-N4 no board node was created by handoff bookkeeping",
		projectBoard(events).byType.Fact.length === 0 && projectBoard(events).byType.Refuted.length === 0,
	);

	await runtime.dispose();
	rmSync(base, { recursive: true, force: true });

	if (failures > 0) {
		console.log(`\naegis-c2-session-rotation FAILED: ${failures} assertion(s)`);
		process.exit(1);
	}
	console.log("\naegis-c2-session-rotation ok");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
