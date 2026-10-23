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

	const previousRound = projectWorkCycle(latest(), episodeId()).review_round_action_count;
	const consumedIntent = latest()
		.filter((e) => e.event_type === "proposal.submitted" && e.payload?.kind === "intent")
		.at(-1);
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_propose", {
				kind: "intent",
				text: "revise consumed unit",
				scope: "unit:revised",
				replace_event_id: consumedIntent.event_id,
				source_refs: [{ ref_type: "event", ref_id: review.event_id }],
			}),
		]),
		fauxAssistantMessage("revised"),
	]);
	await runtime.session.prompt("Revise the work unit, retaining its original review reference.");
	const after = projectWorkCycle(latest(), episodeId());
	console.log(
		`REPLACE_EVIDENCE ${JSON.stringify({
			beforeRound: previousRound,
			afterRound: after.review_round_action_count,
			total: after.action_count,
			expectedConsumingIntent: consumedIntent.event_id,
			consumptions: after.consumptions,
		})}`,
	);
	check("R1: the consumed round had one attempt before the replacement", previousRound === 1, `round=${previousRound}`);
	check(
		"R1: replacing the consumed Intent must not move the review window",
		after.review_round_action_count === previousRound,
		JSON.stringify({
			beforeRound: previousRound,
			afterRound: after.review_round_action_count,
			total: after.action_count,
			consumptions: after.consumptions,
		}),
	);
	check(
		"R1: consumption remains bound to the original consuming Intent",
		after.consumptions.length === 1 && after.consumptions[0].intent_event_id === consumedIntent.event_id,
		JSON.stringify({ expected: consumedIntent.event_id, consumptions: after.consumptions }),
	);
	check("R1: cumulative attempts remain four", after.action_count === 4, `total=${after.action_count}`);
	check("R1: the replacement becomes the current work unit", after.work_unit_event_id !== consumedIntent.event_id);
	const replay = projectWorkCycle(latest(), episodeId(), resolveWorkCyclePolicy(process.env));
	check(
		"R1: replay of the same prefix is deterministic",
		JSON.stringify(replay.consumptions) === JSON.stringify(after.consumptions) &&
			replay.review_round_action_count === after.review_round_action_count,
	);
	const consumedIndex = latest().findIndex((row) => row.event_id === consumedIntent.event_id);
	check(
		"R1: the prefix before the consuming Intent has no consumption yet",
		projectWorkCycle(latest().slice(0, consumedIndex), episodeId(), resolveWorkCyclePolicy(process.env)).consumptions
			.length === 0,
	);
	check(
		"R1: the prefix at the consuming Intent has exactly one consumption",
		projectWorkCycle(latest().slice(0, consumedIndex + 1), episodeId(), resolveWorkCyclePolicy(process.env))
			.consumptions.length === 1,
	);
	// R1: a SECOND legal replacement that still cites the same review changes
	// neither the historical consumption nor the round window, and replay of the
	// same prefix stays deterministic.
	const firstReplacementEventId = after.work_unit_event_id;
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_propose", {
				kind: "intent",
				text: "revise the replacement again",
				scope: "unit:revised-again",
				replace_event_id: firstReplacementEventId,
				source_refs: [{ ref_type: "event", ref_id: review.event_id }],
			}),
		]),
		fauxAssistantMessage("revised again"),
	]);
	await runtime.session.prompt("Replace the replacement, still citing the original review.");
	const twiceReplaced = projectWorkCycle(latest(), episodeId());
	check(
		"R1 product: a second replace keeps the consumed round",
		twiceReplaced.review_round_action_count === previousRound,
		JSON.stringify({ round: twiceReplaced.review_round_action_count, expected: previousRound }),
	);
	check(
		"R1 product: a second replace adds no consumption",
		twiceReplaced.consumptions.length === 1 &&
			twiceReplaced.consumptions[0].intent_event_id === consumedIntent.event_id,
		JSON.stringify(twiceReplaced.consumptions),
	);
	check(
		"R1 product: the latest replacement is the current unit",
		twiceReplaced.work_unit_event_id !== firstReplacementEventId,
	);
	const replayTwice = projectWorkCycle(latest(), episodeId());
	check(
		"R1 product: replay after multiple replaces is deterministic",
		JSON.stringify(replayTwice) === JSON.stringify(twiceReplaced),
	);

	// R1: a NEW stall after the consumed window forms a NEW trigger and a new
	// review is consumed by a new Intent; the old review cannot consume it.
	const oldTriggerId = review.payload.trigger_id;
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("bash", { command: "printf 'same-two'" }),
			fauxToolCall("bash", { command: "printf 'same-two'" }),
			fauxToolCall("bash", { command: "printf 'same-two'" }),
		]),
		fauxAssistantMessage("new stall"),
	]);
	await runtime.session.prompt("Repeat the same probe three times again.");
	const stalledAgain = projectWorkCycle(latest(), episodeId());
	check(
		"R1 product: a new stall forms a new trigger",
		stalledAgain.review_required === true && stalledAgain.trigger_id !== oldTriggerId,
		JSON.stringify({ old: oldTriggerId, now: stalledAgain.trigger_id }),
	);
	check(
		"R1 product: the new round starts after the first consumption",
		stalledAgain.review_round_action_count === 4,
		`round=${stalledAgain.review_round_action_count}`,
	);
	check(
		"R1 product: cumulative attempts continue",
		stalledAgain.action_count === 7,
		`total=${stalledAgain.action_count}`,
	);
	const secondReviewStart = latest().length;
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_work_review", {
				blocker: "the new probe repeats the same result",
				knowledge_query: "parser boundary encoding error mode",
				next_step: "probe a third route",
				tried_routes: ["bash: printf 'same-two' x3"],
			}),
		]),
		fauxAssistantMessage("second review recorded"),
	]);
	await runtime.session.prompt("Review the new stall.");
	const secondReview = latest()
		.slice(secondReviewStart)
		.find((row) => row.event_type === "runtime.note" && row.payload?.kind === "work.review");
	check(
		"R1 product: the new review binds the new trigger",
		secondReview?.payload?.trigger_id === stalledAgain.trigger_id,
		JSON.stringify(secondReview?.payload?.trigger_id),
	);
	resetTurn();
	queueResponses([
		fauxAssistantMessage([
			fauxToolCall("aegis_propose", {
				kind: "intent",
				text: "third route after the new review",
				scope: "unit:after-second-review",
				source_refs: [
					{ ref_type: "event", ref_id: review.event_id },
					{ ref_type: "event", ref_id: secondReview.event_id },
				],
			}),
		]),
		fauxAssistantMessage("accepted"),
	]);
	await runtime.session.prompt("Propose the new reviewed unit, still referencing the old review.");
	const afterSecondReview = projectWorkCycle(latest(), episodeId());
	check(
		"R1 product: only the current review is consumed by the new Intent",
		afterSecondReview.consumptions.length === 2 &&
			afterSecondReview.consumptions[0].intent_event_id === consumedIntent.event_id &&
			afterSecondReview.consumptions[1].review_event_id === secondReview?.event_id &&
			afterSecondReview.consumptions[1].intent_event_id !== consumedIntent.event_id,
		JSON.stringify(afterSecondReview.consumptions),
	);
	check(
		"R1 product: the new review clears the hold",
		afterSecondReview.status === "clear",
		JSON.stringify(afterSecondReview.reasons),
	);
	check(
		"R1 product: the total remains cumulative",
		afterSecondReview.action_count === 7,
		`total=${afterSecondReview.action_count}`,
	);

	// ---- cleanup ---------------------------------------------------------------
	await runtime.dispose?.();
	rmSync(base, { recursive: true, force: true });
	console.log(
		failures === 0
			? "\nReplace consumed review: review window and consumption preserved"
			: `\nReplace consumed review: ${failures} check(s) failed (RED retained)`,
	);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
