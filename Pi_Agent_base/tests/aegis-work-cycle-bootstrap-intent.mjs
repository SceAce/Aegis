#!/usr/bin/env node
// Phase 3 (HC-02/04/09) — the `rceme-001` deadlock and the scoped-Intent start gate.
//
// Part 1 (pure projection + gates): the exact observed deadlock shape — effects
// happened BEFORE any Intent, the stall therefore has no work unit, and the old
// reducer then refused every Intent with `complete_work_review_first`. The fix
// is an EXPLICIT bootstrap review: derived from committed evidence, honoured
// only when the accepted prefix really has no scoped Intent, consumed exactly
// once by the first valid scoped Intent citing it.
//
// Part 2 (real Pi SDK + faux, through the ordinary console call graph): a legacy
// run with `AEGIS_WORK_START_GATE=off` performs effects with no Intent, stalls,
// and the replacement Session performs ONE bootstrap review, ONE scoped Intent
// citing it, then a real effect. The console carries the hold across the
// rotation instead of clearing it.
//
// No real model/network/target.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { evaluateWorkStartGate, projectWorkCycle } from "../memory/work-cycle.mjs";

const POLICY = { repeat_limit: 2, action_window: 8, min_distinct_routes: 4, context_pressure_percent: 85 };
const EPISODE = "ep-bootstrap";
let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

let counter = 0;
function ev(type, payload = {}, sourceKind = "runtime", episode = EPISODE) {
	counter += 1;
	return {
		schema_version: "1.1",
		event_id: `${String(counter).padStart(4, "0")}-${type}`,
		event_type: type,
		episode_id: episode,
		sequence: counter,
		occurred_at: "2026-10-22T00:00:00.000Z",
		recorded_at: "2026-10-22T00:00:00.000Z",
		source: { actor_id: "pi", kind: sourceKind, adapter: "test", version: "1" },
		payload,
		evidence_refs: [],
	};
}
function pair(actionId, contentDigest) {
	return [
		ev("action.requested", {
			action_id: actionId,
			tool_name: "bash",
			arguments_digest: "sha256:same-args",
			input: { summary: { command_excerpt: "probe" } },
		}),
		ev("action.completed", {
			action_id: actionId,
			tool_name: "bash",
			status: "unknown",
			content_digest: contentDigest,
		}),
	];
}

function bootstrapRows() {
	const start = ev("episode.started", {
		task_id: "rceme-001",
		goal: { description: "reproduce rceme-001" },
		authorization: "unknown",
		budget: "unknown",
	});
	// The observed failure: three identical effects BEFORE any Intent.
	const actions = [...pair("a1", "sha256:r1"), ...pair("a2", "sha256:r1"), ...pair("a3", "sha256:r1")];
	return { start, actions, rows: [start, ...actions] };
}

function appendSelection(rows, triggerId, status = "ready") {
	const selection = ev("runtime.note", {
		kind: "knowledge.selected",
		version: "knowledge-selection-1",
		mode: "work_review",
		work_review_trigger_id: triggerId,
		query: "parser condition",
		status,
		selected: status === "ready" ? [{ knowledge_id: "web/parser.json#1" }] : [],
	});
	const review = ev("runtime.note", {
		kind: "work.review",
		version: "work-cycle-1",
		trigger_id: triggerId,
		work_unit_id: null,
		work_unit_event_id: null,
		bootstrap: true,
		evidence_event_ids: [rows[1]?.event_id, rows[2]?.event_id].filter(Boolean),
		blocker: { text: "three identical probes before any work unit", trust: "unverified_model_summary" },
		attempted_routes: ["bash probe"],
		retrieval: {
			query: "parser condition",
			selection_event_id: selection.event_id,
			status,
			selected_knowledge_ids: status === "ready" ? ["web/parser.json#1"] : [],
			limits: { max_results: 4, max_chars: 7000 },
		},
		next_step: { text: "try a different parser condition", trust: "unverified_model_summary" },
		trust: "unverified_model_summary",
	});
	return [...rows, selection, review];
}

function scopedIntent(scope, refs = []) {
	return ev("proposal.submitted", { kind: "intent", text: `work on ${scope}`, scope, source_refs: refs }, "llm");
}

function pureBootstrap() {
	const { rows } = bootstrapRows();
	const stalled = projectWorkCycle(rows, EPISODE, { policy: POLICY });
	check(
		"rceme-001 shape: the stall triggers with no work unit",
		stalled.review_required === true && stalled.work_unit_id === null,
	);
	check("rceme-001 shape: the Episode is unscoped", stalled.unscoped === true);
	check("rceme-001 shape: status is review_required", stalled.status === "review_required", stalled.status);
	const triggerId = stalled.trigger_id;

	const withReview = appendSelection(rows, triggerId);
	const awaiting = projectWorkCycle(withReview, EPISODE, { policy: POLICY });
	const review = withReview.find((row) => row.payload?.kind === "work.review");
	check("a bootstrap review makes the hold usable", awaiting.status === "awaiting_scoped_intent", awaiting.status);
	check("the bootstrap review is marked", awaiting.bootstrap_review === true);
	check("the bootstrap review has no fabricated work unit", review?.payload?.work_unit_event_id === null);
	check("no consumption exists before the Intent", awaiting.consumptions.length === 0);

	// A rejected/empty-scope Intent cannot consume the bootstrap review.
	const emptyIntent = ev(
		"proposal.rejected",
		{ kind: "intent", rejection_reason: "work_start:intent_scope_required" },
		"llm",
	);
	check(
		"a rejected Intent does not consume the bootstrap review",
		projectWorkCycle([...withReview, emptyIntent], EPISODE, { policy: POLICY }).consumptions.length === 0,
	);

	// The FIRST valid scoped Intent citing the review consumes it exactly once.
	const intentA = scopedIntent("unit:parser", [{ ref_type: "event", ref_id: review.event_id }]);
	const consumed = projectWorkCycle([...withReview, intentA], EPISODE, { policy: POLICY });
	check(
		"a scoped Intent citing the bootstrap review clears the hold",
		consumed.review_required === false,
		consumed.status,
	);
	check(
		"the bootstrap review is consumed exactly once",
		consumed.consumptions.length === 1,
		JSON.stringify(consumed.consumptions),
	);
	check("the consumed review is the bootstrap review", consumed.consumptions[0]?.review_event_id === review.event_id);
	check("the consumed Intent becomes the first work unit", consumed.work_unit_id === "unit:parser");
	check("the cumulative action counter is preserved", consumed.action_count === 3, consumed.action_count);

	// A second Intent citing the same review cannot re-open/consume it again.
	const intentB = scopedIntent("unit:other", [{ ref_type: "event", ref_id: review.event_id }]);
	const twice = projectWorkCycle([...withReview, intentA, intentB], EPISODE, { policy: POLICY });
	check("a later Intent citing the same review is not a second consumption", twice.consumptions.length === 1);

	// An Intent that does not cite the review cannot consume it.
	const unrelated = scopedIntent("unit:unrelated");
	check(
		"an unrelated scoped Intent does not clear the bootstrap hold",
		projectWorkCycle([...withReview, unrelated], EPISODE, { policy: POLICY }).review_required === true,
	);

	// A fabricated bootstrap flag on an Episode that already had a unit is inert.
	const withUnit = [rows[0], ...rows.slice(1), scopedIntent("unit:first"), scopedIntent("unit:second")];
	const triggerB = projectWorkCycle(withUnit, EPISODE, { policy: POLICY });
	check("the Episode is scoped after the first Intents", triggerB.unscoped === false);
	const fakeBootstrap = appendSelection(withUnit, triggerB.trigger_id ?? triggerId);
	const fabricated = projectWorkCycle(fakeBootstrap, EPISODE, { policy: POLICY });
	check(
		"a bootstrap flag cannot bypass an existing work unit",
		fabricated.review_required === true && fabricated.status === "review_required",
		fabricated.status,
	);

	// Second stall after a consumption forms a DISTINCT trigger; the old review
	// cannot be reused for it (HC-09).
	const afterActions = [...withReview, intentA, ...pair("b1", "sha256:r2"), ...pair("b2", "sha256:r2")];
	const second = projectWorkCycle(afterActions, EPISODE, { policy: POLICY });
	check("a second stall forms a new trigger", second.review_required === true && second.trigger_id !== triggerId);
	check("the old review is not reused for the new trigger", second.consumptions.length === 1);

	// The start gate: no effect before a scoped Intent; read/review/intent allowed.
	const gateBase = projectWorkCycle(rows, EPISODE, { policy: POLICY });
	check(
		"the start gate refuses an effect while unscoped",
		evaluateWorkStartGate(gateBase, { tool_name: "bash", input: { command: "x" } }).allowed === false,
	);
	check(
		"the start gate refuses an effect-capable write while unscoped",
		evaluateWorkStartGate(gateBase, { tool_name: "write", input: { path: "x" } }).allowed === false,
	);
	check(
		"the start gate allows read-only observation",
		evaluateWorkStartGate(gateBase, { tool_name: "read", input: { path: "x" } }).allowed === true,
	);
	check(
		"the start gate allows knowledge retrieval",
		evaluateWorkStartGate(gateBase, { tool_name: "aegis_knowledge", input: { query: "x" } }).allowed === true,
	);
	check(
		"the start gate allows a non-empty scoped Intent",
		evaluateWorkStartGate(gateBase, { tool_name: "aegis_propose", input: { kind: "intent", scope: "unit:x" } })
			.allowed === true,
	);
	check(
		"the start gate refuses an empty-scope Intent",
		evaluateWorkStartGate(gateBase, { tool_name: "aegis_propose", input: { kind: "intent", scope: "  " } }).allowed ===
			false,
	);
	const scoped = projectWorkCycle([...withReview, intentA], EPISODE, { policy: POLICY });
	check(
		"the start gate opens after the durable scoped Intent",
		evaluateWorkStartGate(scoped, { tool_name: "bash", input: { command: "x" } }).allowed === true,
	);
}

async function sdkBootstrapThroughConsole() {
	const { createConsoleSdkRuntime } = await import("../session/experiment-console-entry.mjs");
	const { createExperimentConsole } = await import("../session/experiment-console.mjs");
	const auth = await import("@earendil-works/pi-coding-agent/core/auth-storage");
	// Import order: the SDK modules are resolved by the source resolver.
	const sdkBaseModule = await import("@earendil-works/pi-coding-agent");
	const base = mkdtempSync(join(tmpdir(), "aegis-bootstrap-"));
	const workspace = join(base, "workspace");
	const runtimeDir = join(base, "runtime");
	const knowledge = join(base, "knowledge");
	const agent = join(base, "agent");
	const sessions = join(base, "sessions");
	for (const dir of [workspace, runtimeDir, knowledge, agent, sessions]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(workspace, "door.json"), JSON.stringify({ locked: true }));
	const eventLogPath = join(runtimeDir, "events.jsonl");
	const handoffPath = join(runtimeDir, "handoff.json");
	const keys = [
		"AEGIS_EVENT_LOG",
		"AEGIS_HANDOFF_FILE",
		"AEGIS_KNOWLEDGE_DIR",
		"AEGIS_KNOWLEDGE_ENABLED",
		"AEGIS_WEB_SEARCH",
		"AEGIS_TASK_ID",
		"AEGIS_PI_AGENT_DIR",
		"AEGIS_WORK_START_GATE",
		"AEGIS_WORK_CYCLE_REPEAT_LIMIT",
	];
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	process.env.AEGIS_EVENT_LOG = eventLogPath;
	process.env.AEGIS_HANDOFF_FILE = handoffPath;
	process.env.AEGIS_KNOWLEDGE_DIR = knowledge;
	process.env.AEGIS_KNOWLEDGE_ENABLED = "off";
	process.env.AEGIS_WEB_SEARCH = "off";
	process.env.AEGIS_TASK_ID = "rceme-001";
	process.env.AEGIS_PI_AGENT_DIR = agent;
	process.env.AEGIS_WORK_START_GATE = "off";
	process.env.AEGIS_WORK_CYCLE_REPEAT_LIMIT = "2";
	const created = [];
	const toolTrace = [];
	try {
		const faux = registerFauxProvider({
			provider: "faux",
			models: [{ id: "bootstrap-fixture", contextWindow: 128000, maxTokens: 8192 }],
		});
		const steps = new Map();
		const responder = (context) => {
			const messages = context.messages ?? [];
			const active = created[created.length - 1];
			const assistantIndex = messages.map((message) => message.role).lastIndexOf("assistant");
			const calls = (Array.isArray(messages[assistantIndex]?.content) ? messages[assistantIndex].content : []).filter(
				(part) => part?.type === "toolCall",
			);
			const results = messages.slice(assistantIndex + 1).filter((message) => message.role === "toolResult");
			for (let index = 0; index < calls.length && index < results.length; index += 1) {
				toolTrace.push({ session: active?.sessionId ?? null, name: calls[index].name, text: textOf(results[index]) });
			}
			const sessionId = active?.sessionId ?? "none";
			const step = (steps.get(sessionId) ?? 0) + 1;
			steps.set(sessionId, step);
			const isInitial = sessionId === created[0]?.sessionId;
			if (isInitial) {
				if (step === 1)
					return fauxAssistantMessage([fauxToolCall("write", { path: "door.json", content: '{"locked":false}' })]);
				if (step === 2)
					return fauxAssistantMessage([fauxToolCall("write", { path: "door.json", content: '{"locked":false}' })]);
				return fauxAssistantMessage("stalled without any work unit");
			}
			if (step === 1) {
				return fauxAssistantMessage([
					fauxToolCall("aegis_work_review", {
						blocker: "effects happened before any work unit",
						knowledge_query: "parser condition",
						next_step: "declare the first scoped work unit",
						tried_routes: ["write door.json"],
					}),
				]);
			}
			if (step === 2) {
				const rows = readRows(eventLogPath);
				const review = rows.findLast((row) => row.payload?.kind === "work.review");
				return fauxAssistantMessage([
					fauxToolCall("aegis_propose", {
						kind: "intent",
						text: "first scoped unit after the bootstrap review",
						scope: "unit:bootstrap",
						source_refs: [{ ref_type: "event", ref_id: review.event_id }],
					}),
				]);
			}
			if (step === 3)
				return fauxAssistantMessage([fauxToolCall("write", { path: "door.json", content: '{"locked":false}' })]);
			return fauxAssistantMessage("bootstrap review consumed; the first unit is active");
		};
		faux.setResponses(Array.from({ length: 60 }, () => responder));
		const host = createExperimentConsole({
			label: "bootstrap",
			taskId: "rceme-001",
			eventLogPath,
			handoffPath,
			checkpointPath: join(runtimeDir, "projection.json"),
			ownershipBaseDir: join(runtimeDir, "console"),
			sessionFactory: () =>
				createConsoleSdkRuntime({
					sdk: {
						...sdkBaseModule,
						AuthStorage: auth.AuthStorage,
						ReadOnlyAuthStorage: auth.ReadOnlyAuthStorage,
						async createAgentSessionFromServices(options) {
							const result = await sdkBaseModule.createAgentSessionFromServices(options);
							created.push(result.session);
							return result;
						},
					},
					providerKind: "faux",
					model: "bootstrap-fixture",
					fauxProviderFactory: () => faux,
					cwd: workspace,
					agentDir: agent,
					sessionDir: sessions,
				}),
			workCyclePolicy: POLICY,
			consolePolicy: { max_auto_rotations: 2, max_continuations: 4, invalid: [], source: "host_policy" },
			continuation: (handoff) => `[Aegis console] continue episode ${handoff.episode_id} under the same review hold.`,
		});
		await host.start();
		const result = await host.dispatch("TASK rceme-001: reproduce the original failure");
		const rows = readRows(eventLogPath);
		const reviews = rows.filter((row) => row.payload?.kind === "work.review");
		const intents = rows.filter((row) => row.payload?.kind === "intent");
		const cycle = projectWorkCycle(rows, rows.find((row) => row.event_type === "episode.started")?.episode_id, {
			policy: POLICY,
		});
		check("the legacy run did perform effects before any Intent", cycle.accepted_intent_count === 1);
		check("exactly one bootstrap review was recorded", reviews.length === 1, `reviews=${reviews.length}`);
		check(
			"the review is the explicit bootstrap variant with no fabricated unit",
			reviews[0]?.payload?.bootstrap === true && reviews[0]?.payload?.work_unit_event_id === null,
			JSON.stringify(reviews[0]?.payload?.work_unit_event_id),
		);
		check(
			"the bootstrap review was consumed exactly once",
			cycle.consumptions.length === 1,
			JSON.stringify(cycle.consumptions),
		);
		check("the first scoped Intent is the work unit", cycle.work_unit_id === "unit:bootstrap", cycle.work_unit_id);
		check(
			"the consumed Intent cites the bootstrap review",
			intents[0]?.payload?.source_refs?.some((ref) => ref?.ref_id === reviews[0]?.event_id),
		);
		check("the hold is clear after the consumption", cycle.review_required === false, cycle.status);
		check("at least one replacement Session was created", created.length >= 2, `sessions=${created.length}`);
		const postReviewWrite = toolTrace.filter(
			(entry) => entry.session === created[1]?.sessionId && entry.name === "write",
		);
		check(
			"a real effect executed after the Intent",
			postReviewWrite.some((entry) => !/scoped_intent|review required/i.test(entry.text)),
			JSON.stringify(postReviewWrite),
		);
		check("the Task stayed in ONE Episode", rows.filter((row) => row.event_type === "episode.started").length === 1);
		check("the console reported a settled run", result.ok === true, JSON.stringify(result.actions));
		console.log(
			`BOOTSTRAP_EVIDENCE ${JSON.stringify({ sessions: created.map((s) => s.sessionId), reviews: reviews.length, consumptions: cycle.consumptions, workUnit: cycle.work_unit_id })}`,
		);
		await host.shutdown("test finished");
	} finally {
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
		rmSync(base, { recursive: true, force: true });
	}
}

const textOf = (message) =>
	typeof message?.content === "string"
		? message.content
		: (message?.content ?? []).map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("\n");
const readRows = (path) =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];

async function main() {
	pureBootstrap();
	await sdkBootstrapThroughConsole();
	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exitCode = 1;
	} else {
		console.log("\nbootstrap Intent gate: unscoped start block, bootstrap review, single consumption passed");
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
