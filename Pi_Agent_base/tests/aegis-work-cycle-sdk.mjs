#!/usr/bin/env node
// WC-07 / WC-08 / WC-09 / WC-10 / WC-11 / WC-12 / WC-13 — REAL Pi SDK + faux.
//
// Drives the actual Aegis Observer extension and a real AgentSessionRuntime with
// a faux provider (no model, no network, no target). It proves the PRODUCT path:
//   * a committed repeat stall blocks an effect-capable tool in the next batch
//     while read/retrieval/review stay available;
//   * `aegis_work_review` performs and durably records a bounded local retrieval;
//     a duplicate replay reuses the committed review (no double selection);
//   * review without a new scoped Intent keeps the hold; an uncited/same-scope
//     Intent is rejected; a citing new-scope Intent releases the effect;
//   * a complete work checkpoint stays planning metadata (no Fact/Outcome) and
//     the RAM/handoff advisory carries the unit;
//   * an in-flight/unknown side effect blocks the REAL Session supervisor; after
//     it settles, the Host rotates through a genuinely new SDK Session object
//     with a new session file/id, the SAME Episode and no transcript replay.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-work-cycle-sdk.mjs

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
import { compileDocumentSeed } from "../memory/document-seed.mjs";
import { buildRamProjection } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";
import { projectWorkCycle, resolveWorkCyclePolicy } from "../memory/work-cycle.mjs";
import { evaluateHandoff } from "../session/handoff.mjs";
import { createSessionSupervisor } from "../session/session-supervisor.mjs";
import { EventLog } from "../shared/events.mjs";

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
function readEvents(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}
function textOf(message) {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content))
		return message.content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join(" ");
	return "";
}
function allText(messages) {
	return messages.map(textOf).join("\n");
}
function humanPromptText(messages) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (!message || message.role !== "user") continue;
		const text = textOf(message);
		if (text.startsWith("<aegis_ram>\n")) continue;
		return text;
	}
	return "";
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

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-work-cycle-sdk-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	const eventLogPath = join(base, "events.jsonl");
	const ramDir = join(base, "ram");
	const handoffPath = join(ramDir, "handoff.json");
	const knowledgeDir = join(base, "knowledge");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(join(knowledgeDir, "techniques"), { recursive: true });

	// A real compilable local seed: bounded retrieval must find it.
	const seed = compileDocumentSeed({
		markdown:
			"# Parser boundary probing\n\n## When\n\nA parser rejects several encodings with the same response.\n\n## Do\n\nProbe an alternative encoding boundary and compare the parser error mode.\n\n## Expect\n\nA distinct parser error class instead of the same rejection.\n\n## Limits\n\nOnly works when the target version is known.\n",
		source: { source_kind: "local_document", source_uri: "file:///knowledge/techniques/parser.md" },
	});
	writeFileSync(join(knowledgeDir, "techniques", "parser.json"), JSON.stringify(seed));

	process.env.AEGIS_EVENT_LOG = eventLogPath;
	process.env.AEGIS_RAM_DIR = ramDir;
	process.env.AEGIS_HANDOFF_FILE = handoffPath;
	process.env.AEGIS_ROM_FILE = join(BASE_DIR, "agent", "ROM.md");
	process.env.AEGIS_TASK_ID = "task-work-cycle-sdk";
	process.env.AEGIS_KNOWLEDGE_DIR = knowledgeDir;
	process.env.AEGIS_AUTHORIZATION = "workspace:probe (operator)";
	process.env.AEGIS_BUDGET = "tool_calls=20";
	delete process.env.AEGIS_WORK_CYCLE_REPEAT_LIMIT;
	delete process.env.AEGIS_WORK_CYCLE_ACTION_WINDOW;
	delete process.env.AEGIS_WORK_CYCLE_MIN_DISTINCT_ROUTES;

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-work-cycle", name: "FauxWorkCycle" }] });
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
				additionalExtensionPaths: [OBSERVER_PATH],
			},
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model,
			tools: [
				"read",
				"bash",
				"aegis_propose",
				"aegis_knowledge",
				"aegis_work_review",
				"aegis_work_checkpoint",
				"aegis_switch_session",
			],
		});
		return { ...result, services, diagnostics: services.diagnostics };
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.create(cwd, sessionDir),
	});
	const bindSession = async () => {
		const session = runtime.session;
		await session.bindExtensions({
			mode: "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtime.newSession(options),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
				reload: async () => {
					await session.reload();
				},
			},
		});
	};
	runtime.setRebindSession(bindSession);
	await bindSession();

	const captured = [];
	// Append (never replace) faux response steps so an un-consumed responder from
	// an earlier phase cannot silently disappear. Each request is captured for
	// provider-bound assertions.
	function queueResponses(list) {
		faux.setResponses(
			list.map((step) => (ctx) => {
				captured.push(ctx.messages);
				return typeof step === "function" ? step(ctx) : step;
			}),
		);
	}
	function resetTurn() {}

	const latest = () => readEvents(eventLogPath);
	const stateNow = () => projectState(latest());
	const episodeId = () => Object.keys(stateNow().episodes)[0];

	// ---- Phase 1: create the episode and record a real scoped Intent ----------
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_propose", {
				kind: "intent",
				text: "probe the parser boundary with encoding variant A",
				scope: "unit:parser-a",
			}),
		]),
		fauxAssistantMessage("work unit recorded"),
	]);
	await runtime.session.prompt("Investigate the parser boundary.");
	check("the episode is open", typeof episodeId() === "string", JSON.stringify(stateNow().episodes));
	check(
		"the scoped work Intent is on the board",
		projectBoard(latest()).nodes.some((node) => node.text.includes("encoding variant A")),
	);

	// ---- Phase 2: three identical effect probes => repeat stall ---------------
	resetTurn();
	const sameCommand = { command: "printf 'same-response'" };
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("bash", sameCommand),
			fauxToolCall("bash", sameCommand),
			fauxToolCall("bash", sameCommand),
		]),
		fauxAssistantMessage("probes finished"),
	]);
	await runtime.session.prompt("Run the same probe three times.");
	let events = latest();
	const bashRequests = events.filter(
		(event) => event.event_type === "action.requested" && event.payload?.tool_name === "bash",
	);
	check("three real bash actions were committed", bashRequests.length === 3, `count=${bashRequests.length}`);
	const cycle = projectWorkCycle(events, episodeId(), resolveWorkCyclePolicy(process.env));
	check(
		"the committed repeat produces a review trigger",
		cycle.review_required === true,
		JSON.stringify(cycle.reasons),
	);
	check("the trigger is repeat-based", cycle.reasons.includes("same_action_same_result_repeated"));
	check("the work unit is still the scoped Intent", cycle.work_unit_id === "unit:parser-a");

	// ---- WC-07: the next effect batch is blocked; the reason reaches the model -
	resetTurn();
	const beforeBlocked = latest().length;
	queueResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'should-not-run'" })]),
		fauxAssistantMessage("blocked as instructed"),
	]);
	await runtime.session.prompt("Try another probe.");
	events = latest();
	const blockedRequests = events.slice(beforeBlocked).filter((event) => event.event_type === "action.requested");
	check(
		"the blocked effect created no new action.requested",
		blockedRequests.length === 0,
		JSON.stringify(blockedRequests),
	);
	// `terminate: true` ends the batch, so the reason is surfaced as a durable
	// toolResult message rather than in a later provider request.
	const blockedText = events
		.slice(beforeBlocked)
		.filter((event) => event.event_type === "message.completed")
		.map((event) => event.payload?.text_excerpt ?? "")
		.join("\n");
	check(
		"the model received the work-review block reason",
		/Aegis work review required/i.test(blockedText),
		blockedText.slice(-400),
	);
	check(
		"the block is recorded as a toolResult observation",
		events
			.slice(beforeBlocked)
			.some(
				(event) =>
					event.event_type === "message.completed" &&
					event.payload?.role === "toolResult" &&
					/Aegis work review required/i.test(event.payload?.text_excerpt ?? ""),
			),
	);

	// The next RAM (built by the Observer) carries the gate with evidence refs.
	const liveState = stateNow();
	const liveBoard = projectBoard(events);
	const liveCycle = projectWorkCycle(events, episodeId(), resolveWorkCyclePolicy(process.env));
	const liveRam = buildRamProjection({
		board: liveBoard,
		state: liveState,
		episodeId: episodeId(),
		goal: "Investigate the parser boundary.",
		workCycle: liveCycle,
	});
	const ramFrame = liveRam.data.task.work_cycle;
	check("RAM exposes the review gate", ramFrame?.status === "review_required", JSON.stringify(ramFrame));
	check(
		"RAM keeps the task authorization and budget",
		Boolean(liveRam.data.task.authorization),
		liveRam.data.task.authorization,
	);
	check(
		"RAM evidence aliases resolve to committed events",
		(ramFrame?.evidence ?? []).every((alias) => typeof liveRam.data.refs[alias]?.id === "string"),
	);

	// ---- WC-08: review performs a REAL bounded local retrieval -----------------
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_work_review", {
				blocker: "three identical parser probes returned the same response",
				knowledge_query: "parser boundary encoding error mode",
				next_step: "probe an alternative encoding boundary and compare the error class",
				tried_routes: ["bash: printf 'same-response' x3"],
			}),
		]),
		fauxAssistantMessage("review recorded"),
	]);
	await runtime.session.prompt("Review the stall.");
	events = latest();
	const reviewEvents = events.filter(
		(event) => event.event_type === "runtime.note" && event.payload?.kind === "work.review",
	);
	check("a work.review event was durably committed", reviewEvents.length === 1, `count=${reviewEvents.length}`);
	const review = reviewEvents[0];
	check(
		"the review carries the detected trigger",
		review?.payload?.trigger_id === cycle.trigger_id,
		JSON.stringify(review?.payload?.trigger_id),
	);
	const selectionId = review?.payload?.retrieval?.selection_event_id;
	const selection = events.find((event) => event.event_id === selectionId);
	check(
		"the review references a committed knowledge.selected retrieval",
		selection?.payload?.kind === "knowledge.selected" && selection?.payload?.mode === "work_review",
		JSON.stringify(selection?.payload?.status),
	);
	check(
		"the retrieval returned the real local technique",
		(selection?.payload?.selected ?? []).some((row) =>
			String(row.knowledge_id ?? "").startsWith("techniques/parser.json#"),
		),
		JSON.stringify((selection?.payload?.selected ?? []).map((row) => row.knowledge_id)),
	);
	check(
		"the retrieval records bounded limits and status",
		selection?.payload?.status === "ready" &&
			(selection?.payload?.selected ?? []).every((row) => row.verified === false && row.action_policy === "none"),
		JSON.stringify(selection?.payload?.status),
	);
	check(
		"the work review is marked unverified model summary",
		review?.payload?.trust === "unverified_model_summary" &&
			review?.payload?.blocker?.trust === "unverified_model_summary",
	);
	check(
		"the review evidence is committed same-Episode action evidence",
		(review?.payload?.evidence_event_ids ?? []).every((id) =>
			events.some((event) => event.event_id === id && event.episode_id === episodeId()),
		),
	);
	check(
		"the review creates no Fact/Outcome",
		projectBoard(events).currentByType.Fact.length === 0 &&
			events.filter((event) => event.event_type === "outcome.recorded").length === 0,
	);
	const reviewCycle = projectWorkCycle(events, episodeId(), resolveWorkCyclePolicy(process.env));
	check("the review moves the gate to awaiting_scoped_intent", reviewCycle.status === "awaiting_scoped_intent");

	// ---- WC-10: replaying the review is idempotent -----------------------------
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_work_review", {
				blocker: "duplicate review attempt",
				knowledge_query: "parser boundary encoding error mode",
				next_step: "same next step",
				tried_routes: ["bash: printf 'same-response' x3"],
			}),
		]),
		fauxAssistantMessage("reused"),
	]);
	await runtime.session.prompt("Review again.");
	events = latest();
	check(
		"a replayed review does not duplicate the work.review record",
		events.filter((event) => event.event_type === "runtime.note" && event.payload?.kind === "work.review").length === 1,
	);
	check(
		"a replayed review does not duplicate the work_review retrieval",
		events.filter(
			(event) =>
				event.event_type === "runtime.note" &&
				event.payload?.kind === "knowledge.selected" &&
				event.payload?.mode === "work_review",
		).length === 1,
	);
	check(
		"the replay response reports reuse",
		allText(captured[captured.length - 1] ?? []).includes('"reused":true'),
		allText(captured[captured.length - 1] ?? []).slice(-300),
	);

	// ---- WC-09: a review without a new scoped Intent keeps effects blocked ------
	resetTurn();
	const beforeUncited = latest().length;
	queueResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'still-held'" })]),
		fauxAssistantMessage("held"),
	]);
	await runtime.session.prompt("Try an effect while reviewed.");
	events = latest();
	check(
		"the hold persists after review without a new Intent",
		events.slice(beforeUncited).filter((event) => event.event_type === "action.requested").length === 0,
	);

	// An uncited new Intent and a same-scope Intent are rejected.
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_propose", {
				kind: "intent",
				text: "uncited next try",
				scope: "unit:parser-b",
			}),
		]),
		fauxAssistantMessage("rejected one"),
	]);
	await runtime.session.prompt("Propose without citing the review.");
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_propose", {
				kind: "intent",
				text: "same unit again",
				scope: "unit:parser-a",
				source_refs: [{ ref_type: "event", ref_id: review.event_id }],
			}),
		]),
		fauxAssistantMessage("rejected two"),
	]);
	await runtime.session.prompt("Propose the same unit.");
	events = latest();
	// The gate refuses these at tool admission, so they never reach proposal
	// execution; the model receives the specific reason and no Intent is stored.
	const refusalText = events
		.filter((event) => event.event_type === "message.completed")
		.map((event) => event.payload?.text_excerpt ?? "")
		.join("\n");
	check(
		"uncited and same-scope Intents are refused with a specific reason",
		refusalText.includes("intent_must_cite_current_review") || refusalText.includes("intent_scope_must_be_new"),
		refusalText.slice(-300),
	);
	check(
		"the refused proposals created no new Intent",
		events.filter((event) => event.event_type === "proposal.submitted").length === 1,
		JSON.stringify(
			events.filter((event) => event.event_type === "proposal.submitted").map((row) => row.payload?.scope),
		),
	);
	check(
		"no proposal rejection row is needed for an admission-blocked proposal",
		events.filter((event) => event.event_type === "proposal.rejected").length === 0,
	);
	check(
		"the gate is still held after the rejections",
		projectWorkCycle(events, episodeId(), resolveWorkCyclePolicy(process.env)).status === "awaiting_scoped_intent",
	);

	// A NEW scope citing the committed review clears the hold.
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_propose", {
				kind: "intent",
				text: "probe an alternative encoding boundary",
				scope: "unit:parser-b",
				source_refs: [{ ref_type: "event", ref_id: review.event_id }],
			}),
		]),
		fauxAssistantMessage("accepted"),
	]);
	await runtime.session.prompt("Propose the reviewed next unit.");
	events = latest();
	const accepted = projectWorkCycle(events, episodeId(), resolveWorkCyclePolicy(process.env));
	check("the citing new-scope Intent releases the hold", accepted.status === "clear", JSON.stringify(accepted.reasons));
	check("the new work unit is the new scope", accepted.work_unit_id === "unit:parser-b");

	// The next effect is admitted again.
	resetTurn();
	const beforeAllowed = latest().length;
	queueResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'new-route'" })]),
		fauxAssistantMessage("ran"),
	]);
	await runtime.session.prompt("Run the new probe.");
	events = latest();
	const allowedRequests = events
		.slice(beforeAllowed)
		.filter((event) => event.event_type === "action.requested" && event.payload?.tool_name === "bash");
	check(
		"the effect is admitted after the scoped Intent",
		allowedRequests.length === 1,
		`count=${allowedRequests.length}`,
	);
	const completion = events.find(
		(event) =>
			event.event_type === "action.completed" && event.payload?.action_id === allowedRequests[0]?.payload?.action_id,
	);
	check("the admitted effect really completed", completion?.payload?.content_digest !== undefined);

	// ---- WC-08 (disabled retrieval): the review must say so explicitly ---------
	// Two more identical probes create a NEW repeat trigger in unit:parser-b.
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("bash", { command: "printf 'new-route'" }),
			fauxToolCall("bash", { command: "printf 'new-route'" }),
		]),
		fauxAssistantMessage("repeat finished"),
	]);
	await runtime.session.prompt("Repeat the same probe twice.");
	events = latest();
	const secondStall = projectWorkCycle(events, episodeId(), resolveWorkCyclePolicy(process.env));
	check(
		"a new work unit can stall again",
		secondStall.status === "review_required",
		JSON.stringify(secondStall.reasons),
	);
	const repeatedIds = events
		.filter((event) => event.event_type === "action.requested" && event.payload?.tool_name === "bash")
		.slice(-2)
		.map((event) => event.event_id);
	process.env.AEGIS_KNOWLEDGE_ENABLED = "off";
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_work_review", {
				blocker: "the repeat produced the same output again",
				knowledge_query: "parser boundary encoding",
				next_step: "check knowledge configuration before assuming no technique exists",
				tried_routes: ["bash: printf 'new-route' x3"],
			}),
		]),
		fauxAssistantMessage("reviewed with retrieval disabled"),
	]);
	await runtime.session.prompt("Review the second stall.");
	delete process.env.AEGIS_KNOWLEDGE_ENABLED;
	events = latest();
	const secondReviews = events.filter(
		(event) => event.event_type === "runtime.note" && event.payload?.kind === "work.review",
	);
	check("a second trigger records a second review", secondReviews.length === 2, `count=${secondReviews.length}`);
	const disabledReview = secondReviews[1];
	const disabledSelection = events.find(
		(event) => event.event_id === disabledReview?.payload?.retrieval?.selection_event_id,
	);
	check(
		"knowledge-disabled retrieval is recorded as disabled, not as checked",
		disabledSelection?.payload?.status === "disabled" && (disabledSelection?.payload?.selected ?? []).length === 0,
		JSON.stringify(disabledSelection?.payload?.status),
	);
	check(
		"the held review does not claim selected knowledge",
		disabledReview?.payload?.retrieval?.status === "disabled" &&
			(disabledReview?.payload?.retrieval?.selected_knowledge_ids ?? []).length === 0,
		JSON.stringify(disabledReview?.payload?.retrieval),
	);
	// A citing new-scope Intent for THIS review clears the second hold.
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_propose", {
				kind: "intent",
				text: "check the knowledge configuration and retry the boundary probe",
				scope: "unit:parser-c",
				source_refs: [{ ref_type: "event", ref_id: disabledReview.event_id }],
			}),
		]),
		fauxAssistantMessage("accepted"),
	]);
	await runtime.session.prompt("Propose the next unit after the second review.");
	events = latest();
	check(
		"the second review is cleared only by a citing new-scope Intent",
		projectWorkCycle(events, episodeId(), resolveWorkCyclePolicy(process.env)).status === "clear",
	);

	// ---- WC-11: complete checkpoint is planning metadata only ------------------
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_work_checkpoint", {
				unit_status: "complete",
				summary: "the alternative encoding boundary was probed and produced a distinct error class",
				next_step: "verify the outcome with an independent check",
				evidence_event_ids: [allowedRequests[0].event_id, completion.event_id, ...repeatedIds],
			}),
		]),
		fauxAssistantMessage("checkpointed"),
	]);
	await runtime.session.prompt("Checkpoint the work unit.");
	events = latest();
	const checkpointEvents = events.filter(
		(event) => event.event_type === "runtime.note" && event.payload?.kind === "work.checkpoint",
	);
	check("a work.checkpoint event was committed", checkpointEvents.length === 1, `count=${checkpointEvents.length}`);
	const checkpoint = checkpointEvents[0];
	check("the checkpoint carries the current unit", checkpoint?.payload?.work_unit_id === "unit:parser-c");
	check(
		"the checkpoint status is explicitly unverified",
		checkpoint?.payload?.unit_status === "complete" && checkpoint?.payload?.trust === "unverified_model_summary",
	);
	check(
		"the checkpoint is an Artifact, not a Fact",
		projectBoard(events).currentByType.Fact.length === 0 &&
			projectBoard(events).currentByType.Artifact.some((node) => node.origin_event_id === checkpoint.event_id),
	);
	const afterCheckpoint = stateNow();
	check(
		"the checkpoint created no Outcome",
		events.filter((event) => event.event_type === "outcome.recorded").length === 0,
	);
	check("the checkpoint created no independent Episode", Object.keys(afterCheckpoint.episodes).length === 1);
	check("the checkpoint status is projected into RuntimeState", afterCheckpoint.work_checkpoints.length === 1);
	const checkpointCycle = projectWorkCycle(events, episodeId(), resolveWorkCyclePolicy(process.env));
	const checkpointRam = buildRamProjection({
		board: projectBoard(events),
		state: afterCheckpoint,
		episodeId: episodeId(),
		workCycle: checkpointCycle,
	});
	check(
		"RAM shows the checkpoint as unverified planning metadata",
		checkpointRam.data.task.work_cycle.checkpoint?.unit_status === "complete" &&
			checkpointRam.data.task.work_cycle.checkpoint?.trust === "unverified_model_summary",
		JSON.stringify(checkpointRam.data.task.work_cycle.checkpoint),
	);

	// ---- WC-13: an unresolved side effect blocks the REAL supervisor -----------
	const supervisorBudget = {
		limit: { wall_time_ms: 600000, model_requests: 100, tool_calls: 200, session_count: 10 },
		consumed: { wall_time_ms: 1000, model_requests: 4, tool_calls: 5, session_count: 1 },
		max_requests_per_session: 10,
	};
	const makeSupervisor = () =>
		createSessionSupervisor({
			eventLogPath,
			handoffPath,
			runtime,
			taskId: process.env.AEGIS_TASK_ID,
			budget: supervisorBudget,
		});
	// Stage a legitimate handoff request through the model tool.
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_switch_session", { reason: "work unit complete; move to a fresh session" }),
		]),
		fauxAssistantMessage("staged"),
	]);
	await runtime.session.prompt("Hand over to a fresh session for the next unit.");
	check("the handoff was staged", existsSync(handoffPath), handoffPath);
	// Inject a real unresolved side-effect action into the authoritative log.
	const inject = new EventLog(eventLogPath);
	const openedInject = await inject.open();
	check("the event log opened for the recovery probe", openedInject.ok === true, JSON.stringify(openedInject));
	await inject.append({
		event_type: "action.requested",
		episode_id: episodeId(),
		payload: {
			action_id: "unknown-effect-1",
			tool_name: "write",
			arguments_digest: "sha256:pending",
			input: { path: "unconfirmed.txt" },
		},
		source: { actor_id: "pi", kind: "runtime", adapter: "aegis-work-cycle-test", version: "1.0.0" },
	});
	await inject.close();
	events = latest();
	const episodeForHandoff = JSON.parse(readFileSync(handoffPath, "utf8")).episode_id;
	const pendingState = projectState(events);
	const pendingBoard = projectBoard(events);
	const pendingCycle = projectWorkCycle(events, episodeForHandoff, resolveWorkCyclePolicy(process.env));
	const pendingVerdict = evaluateHandoff({
		state: pendingState,
		board: pendingBoard,
		ram: buildRamProjection({ board: pendingBoard, state: pendingState, episodeId: episodeForHandoff }),
		episodeId: episodeForHandoff,
		reason: "recovery probe",
		requestId: "recovery-probe",
		workCycle: pendingCycle,
	});
	check("an unresolved side effect refuses the handoff", pendingVerdict.allowed === false, pendingVerdict.reason);
	const sessionBeforeBlockedRotation = runtime.session;
	const blockedRotation = await makeSupervisor().canRotate();
	check(
		"the supervisor precheck refuses while the effect is unresolved",
		blockedRotation.allowed === false,
		blockedRotation.reason,
	);
	check("no replacement Session was created", runtime.session === sessionBeforeBlockedRotation);
	check(
		"no handoff completion was faked",
		latest().filter((event) => event.event_type === "handoff.completed").length === 0,
	);
	// Complete the action truthfully; responsibility is retained in the log.
	const resolve = new EventLog(eventLogPath);
	await resolve.open();
	await resolve.append({
		event_type: "action.completed",
		episode_id: episodeForHandoff,
		payload: {
			action_id: "unknown-effect-1",
			tool_name: "write",
			content_digest: "sha256:confirmed",
			status: "completed",
			transport: { tool_ok: true },
		},
		source: { actor_id: "pi", kind: "runtime", adapter: "aegis-work-cycle-test", version: "1.0.0" },
	});
	await resolve.close();

	// ---- WC-12: real SDK Session replacement through the Host supervisor -------
	const supervisor = makeSupervisor();
	const precheck = await supervisor.canRotate();
	check("the settled boundary is allowed", precheck.allowed === true, JSON.stringify(precheck));
	const beforeSession = runtime.session;
	const beforeFile = beforeSession.sessionFile;
	const beforeId = beforeSession.sessionId;
	const beforeEpisode = Object.keys(projectState(latest()).episodes);
	const sessionsBefore = createdSessions;
	const capturedBeforeRotation = captured.length;
	resetTurn();
	queueResponses([fauxAssistantMessage("continuing in the new session")]);
	const rotation = await supervisor.rotate();
	check("the supervisor applied a real rotation", rotation.applied === true, JSON.stringify(rotation));
	check("a genuinely NEW SDK Session object was created", runtime.session !== beforeSession);
	check(
		"exactly one new runtime Session was created",
		createdSessions === sessionsBefore + 1,
		`created=${createdSessions}`,
	);
	check(
		"a distinct Session file and id were bound",
		typeof runtime.session.sessionFile === "string" &&
			runtime.session.sessionFile !== beforeFile &&
			runtime.session.sessionId !== beforeId,
	);
	events = latest();
	const completions = events.filter(
		(event) => event.event_type === "handoff.completed" && event.payload?.request_id === rotation.request_id,
	);
	check("handoff.completed was committed exactly once", completions.length === 1, `count=${completions.length}`);
	check(
		"the completion names the bound new Session",
		completions[0]?.payload?.to_session === runtime.session.sessionId,
		JSON.stringify(completions[0]?.payload),
	);
	check(
		"the SAME Episode survived (no new attempt)",
		JSON.stringify(Object.keys(projectState(events).episodes)) === JSON.stringify(beforeEpisode) &&
			Object.keys(projectState(events).episodes).length === 1,
		JSON.stringify(Object.keys(projectState(events).episodes)),
	);
	check(
		"cumulative budget did not reset or grow",
		(rotation.budget_after?.consumed?.session_count ?? 0) >= (rotation.budget_before?.consumed?.session_count ?? 0) &&
			(rotation.budget_after?.remaining?.session_count ?? 0) <= (rotation.budget_before?.remaining?.session_count ?? 0),
		JSON.stringify({ before: rotation.budget_before, after: rotation.budget_after }),
	);
	// The staged handoff carried bounded work-cycle continuity (no grant/status).
	const staged = JSON.parse(readFileSync(`${handoffPath}.applied.json`, "utf8"));
	check(
		"the staged handoff carried the work unit and review refs",
		staged?.work_cycle?.work_unit_id === "unit:parser-c" && typeof staged?.work_cycle?.review_event_id === "string",
		JSON.stringify(staged?.work_cycle),
	);
	check(
		"the staged handoff carries no authorization/status grant",
		staged?.work_cycle?.trust === "runtime_advisory_not_outcome" &&
			!Object.hasOwn(staged?.work_cycle ?? {}, "authorization"),
	);
	// No full transcript replay: the new Session's first request must not contain
	// the original prompt text, only the continuation + rebuilt RAM.
	const newSessionRequest = captured.slice(capturedBeforeRotation).find((messages) => messages.length > 0) ?? [];
	const humanContinuation = humanPromptText(newSessionRequest);
	check(
		"the new Session did not replay the original prompt/transcript",
		!humanContinuation.includes("Investigate the parser boundary.") &&
			!humanContinuation.includes("Run the same probe three times.") &&
			newSessionRequest.filter((message) => message?.role === "assistant").length === 0,
		humanContinuation.slice(0, 300),
	);
	check(
		"the new Session received the Aegis continuation",
		humanPromptText(newSessionRequest).includes("[Aegis] continuing episode"),
		humanPromptText(newSessionRequest).slice(0, 200),
	);
	check("the new Session request still includes the rebuilt RAM", allText(newSessionRequest).includes("<aegis_ram>"));

	// ---- cleanup ---------------------------------------------------------------
	await runtime.dispose?.();
	rmSync(base, { recursive: true, force: true });
	if (failures > 0) {
		console.error(`\nWork cycle SDK: ${failures} check(s) failed`);
		process.exit(1);
	}
	console.log(
		"\nWork cycle SDK: stall gate, review retrieval, scoped-Intent unlock, checkpoint metadata, unresolved-effect refusal and real Session rotation passed",
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
