#!/usr/bin/env node
// Phase 3 (HC-01/02/03/06/07/08/09/11) — the ORDINARY console call graph.
//
// This drives `session/experiment-console-entry.mjs#createConsoleSdkRuntime` +
// `session/experiment-console.mjs#createExperimentConsole` — the same modules
// `run-experiment.sh` execs — against the real Pi SDK with the offline faux
// provider. It is not a helper-only test:
//
//   * one resident Host, one EventLog writer, one initial Session;
//   * NO effect before a durable scoped Intent (a parallel Intent+effect batch
//     cannot race through the start gate);
//   * a real work-cycle stall+review holds effects, is CONSUMED exactly once by
//     a new scoped Intent, and the same Task then completes through a real file
//     effect;
//   * a hold-carried replacement Session is a genuinely different SDK Session
//     object/file/id in the SAME Episode, whose FIRST provider request sees the
//     carried hold/trigger/counters and NO old assistant transcript;
//   * bounded rotation stops instead of spinning when the hold makes no progress.
//
// No real model/network/target. Temp dirs only.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage, ReadOnlyAuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { compileDocumentSeed } from "../memory/document-seed.mjs";
import { projectWorkCycle } from "../memory/work-cycle.mjs";
import { createExperimentConsole } from "../session/experiment-console.mjs";
import { createConsoleSdkRuntime } from "../session/experiment-console-entry.mjs";
import { verifyChain } from "../shared/events.mjs";

const POLICY = { repeat_limit: 2, action_window: 8, min_distinct_routes: 4, context_pressure_percent: 85 };
const CONSOLE_POLICY = { max_auto_rotations: 2, max_continuations: 4, invalid: [], source: "host_policy" };
const TASK = "console-task";
let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}
const textOf = (message) =>
	typeof message?.content === "string"
		? message.content
		: (message?.content ?? []).map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("\n");
const readRows = (path) =>
	existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
function ramOf(messages) {
	const raw = messages.map(textOf).findLast((text) => text.includes("<aegis_ram>"));
	if (!raw) return null;
	const start = raw.indexOf("<aegis_ram>");
	const end = raw.lastIndexOf("</aegis_ram>");
	if (end < 0) return null;
	try {
		return JSON.parse(raw.slice(start + "<aegis_ram>".length, end).trim());
	} catch {
		return { parse_error: true };
	}
}
const SESSION_MARKER = "S1_ASSISTANT_TRANSCRIPT_MARKER";

/**
 * One isolated experiment fixture: workspace, event log, knowledge, agent dir.
 */
function makeFixture(name) {
	const base = mkdtempSync(join(tmpdir(), `aegis-console-${name}-`));
	const workspace = join(base, "workspace");
	const runtime = join(base, "runtime");
	const knowledge = join(base, "knowledge");
	const agent = join(base, "agent");
	const sessions = join(base, "sessions");
	for (const dir of [workspace, runtime, knowledge, agent, sessions]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(workspace, "door.json"), JSON.stringify({ locked: true }));
	writeFileSync(
		join(knowledge, "door.json"),
		JSON.stringify(
			compileDocumentSeed({
				markdown:
					"# Fixture door recovery\n\n## When\n\nRepeated fixture door writes leave locked true.\n\n## Do\n\nWrite locked false once and verify by reading it back.\n\n## Limits\n\nReference only; independent verification required.\n",
				source: { source_kind: "local_document", source_uri: "file:///test/door.md" },
			}),
		),
	);
	return {
		base,
		workspace,
		runtime,
		knowledge,
		agent,
		sessions,
		eventLogPath: join(runtime, "events.jsonl"),
		handoffPath: join(runtime, "handoff.json"),
		checkpointPath: join(runtime, "projection.json"),
		cleanup() {
			rmSync(base, { recursive: true, force: true });
		},
	};
}

function bindEnv(fixture) {
	const keys = [
		"AEGIS_EVENT_LOG",
		"AEGIS_HANDOFF_FILE",
		"AEGIS_KNOWLEDGE_DIR",
		"AEGIS_KNOWLEDGE_ENABLED",
		"AEGIS_WEB_SEARCH",
		"AEGIS_TASK_ID",
		"AEGIS_PI_AGENT_DIR",
		"AEGIS_WORK_START_GATE",
		"AEGIS_CONSOLE_MAX_AUTO_ROTATIONS",
		"AEGIS_CONSOLE_MAX_CONTINUATIONS",
		"AEGIS_WORK_CYCLE_REPEAT_LIMIT",
		"AEGIS_WORK_CYCLE_ACTION_WINDOW",
		"AEGIS_WORK_CYCLE_MIN_DISTINCT_ROUTES",
		"AEGIS_WORK_CYCLE_CONTEXT_PERCENT",
	];
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	process.env.AEGIS_EVENT_LOG = fixture.eventLogPath;
	process.env.AEGIS_HANDOFF_FILE = fixture.handoffPath;
	process.env.AEGIS_KNOWLEDGE_DIR = fixture.knowledge;
	process.env.AEGIS_KNOWLEDGE_ENABLED = "on";
	process.env.AEGIS_WEB_SEARCH = "off";
	process.env.AEGIS_TASK_ID = TASK;
	process.env.AEGIS_PI_AGENT_DIR = fixture.agent;
	process.env.AEGIS_WORK_START_GATE = "on";
	process.env.AEGIS_CONSOLE_MAX_AUTO_ROTATIONS = String(CONSOLE_POLICY.max_auto_rotations);
	process.env.AEGIS_CONSOLE_MAX_CONTINUATIONS = String(CONSOLE_POLICY.max_continuations);
	process.env.AEGIS_WORK_CYCLE_REPEAT_LIMIT = String(POLICY.repeat_limit);
	process.env.AEGIS_WORK_CYCLE_ACTION_WINDOW = String(POLICY.action_window);
	process.env.AEGIS_WORK_CYCLE_MIN_DISTINCT_ROUTES = String(POLICY.min_distinct_routes);
	process.env.AEGIS_WORK_CYCLE_CONTEXT_PERCENT = String(POLICY.context_pressure_percent);
	return () => {
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	};
}

/** Build the real SDK runtime the console entry would build. */
async function buildRuntime(fixture, faux, created = []) {
	const adapter = await createConsoleSdkRuntime({
		sdk: {
			...sdkBase,
			AuthStorage,
			ReadOnlyAuthStorage,
			async createAgentSessionFromServices(options) {
				const result = await sdkBase.createAgentSessionFromServices(options);
				created.push(result.session);
				return result;
			},
		},
		providerKind: "faux",
		model: "console-fixture",
		fauxProviderFactory: () => faux,
		cwd: fixture.workspace,
		agentDir: fixture.agent,
		sessionDir: fixture.sessions,
	});
	return { adapter, created };
}

async function scenarioStartGateAndCarry() {
	const fixture = makeFixture("carry");
	const restoreEnv = bindEnv(fixture);
	const requests = [];
	const toolTrace = [];
	try {
		const faux = registerFauxProvider({
			provider: "faux",
			models: [{ id: "console-fixture", contextWindow: 128000, maxTokens: 8192 }],
		});
		// Product path: the Host creates the SDK runtime INSIDE start(), after it
		// acquired ownership and bound the single EventLog writer.
		const created = [];
		let adapter = null;
		const steps = new Map();
		const responder = (context) => {
			assert.ok(requests.length < 80, "bounded responder must not spin");
			const messages = context.messages ?? [];
			const active = created[created.length - 1];
			requests.push({
				sessionId: active?.sessionId ?? null,
				messages: structuredClone(messages),
				ram: ramOf(messages),
			});
			// Attribute each tool CALL to its ordered result for product assertions.
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
				if (step === 1) {
					// FIRST provider request of a fresh Episode: read AND an effect AND a
					// scoped Intent in ONE assistant message, with no committed Intent yet.
					return fauxAssistantMessage([
						fauxToolCall("read", { path: "door.json" }),
						fauxToolCall("write", { path: "door.json", content: JSON.stringify({ locked: false }) }),
						// A scope-less intent cannot define a work unit: it must be refused
						// before the durable append.
						fauxToolCall("aegis_propose", { kind: "intent", text: "unlock without a scope" }),
						fauxToolCall("aegis_propose", { kind: "intent", text: "unlock the fixture door", scope: "unit:unlock" }),
					]);
				}
				if (step === 2) {
					return fauxAssistantMessage([
						fauxToolCall("write", { path: "door.json", content: JSON.stringify({ locked: false }) }),
					]);
				}
				if (step === 3) return fauxAssistantMessage("first unit done; waiting for the next instruction");
				if (step === 4) {
					// Same effect twice -> the real repeat trigger forms.
					return fauxAssistantMessage([
						fauxToolCall("write", { path: "door.json", content: JSON.stringify({ locked: false }) }),
						fauxToolCall("write", { path: "door.json", content: JSON.stringify({ locked: false }) }),
					]);
				}
				return fauxAssistantMessage(`${SESSION_MARKER}\nstill probing`);
			}
			// Replacement Session (same Task/Episode, carried hold).
			if (step === 1) {
				return fauxAssistantMessage([
					fauxToolCall("aegis_work_review", {
						blocker: "repeated door writes produced the same state",
						knowledge_query: "fixture door recovery locked",
						next_step: "write locked false once and read it back",
						tried_routes: ["write door.json locked=false"],
					}),
					fauxToolCall("write", { path: "door.json", content: JSON.stringify({ locked: false }) }),
					fauxToolCall("read", { path: "door.json" }),
				]);
			}
			if (step === 2) {
				const review = readRows(fixture.eventLogPath).findLast((row) => row.payload?.kind === "work.review");
				return fauxAssistantMessage([
					fauxToolCall("aegis_propose", {
						kind: "intent",
						text: "recover the door with one verified write",
						scope: "unit:recover",
						source_refs: [{ ref_type: "event", ref_id: review.event_id }],
					}),
					fauxToolCall("write", { path: "door.json", content: JSON.stringify({ locked: false }) }),
				]);
			}
			return fauxAssistantMessage("recovered; the review hold is consumed");
		};
		faux.setResponses(Array.from({ length: 80 }, () => responder));

		const host = createExperimentConsole({
			label: "console-carry",
			taskId: TASK,
			eventLogPath: fixture.eventLogPath,
			handoffPath: fixture.handoffPath,
			checkpointPath: fixture.checkpointPath,
			ownershipBaseDir: join(fixture.runtime, "console"),
			sessionFactory: async () => {
				const built = await buildRuntime(fixture, faux, created);
				adapter = built.adapter;
				return adapter;
			},
			workCyclePolicy: POLICY,
			consolePolicy: CONSOLE_POLICY,
			continuation: (handoff) =>
				`[Aegis console] continue the SAME task/episode ${handoff.episode_id}. Do not re-run committed actions.`,
		});
		const started = await host.start();
		check("the resident Host starts one initial Session", started.ok === true, started.reason);
		const first = await host.dispatch("TASK console-task: unlock door.json and verify it");
		check("first dispatch settles without a rotation", first.action === "continue", JSON.stringify(first.actions));
		const afterFirst = readRows(fixture.eventLogPath);
		check("EventLog chain verifies", verifyChain(afterFirst).ok === true);
		check("one Episode only", afterFirst.filter((row) => row.event_type === "episode.started").length === 1);

		// HC-02: the FIRST batch had no scoped Intent. The read is a real result;
		// the write must not have produced any effect event.
		const blockedWrite = toolTrace.find(
			(entry) => entry.name === "write" && /scoped_intent_required_before_effect/.test(entry.text),
		);
		check(
			"a same-batch effect is blocked before the scoped Intent",
			Boolean(blockedWrite),
			JSON.stringify(toolTrace.slice(0, 6)),
		);
		check(
			"the read-only observation in the same batch still succeeded",
			toolTrace.some((entry) => entry.name === "read" && /locked/.test(entry.text)),
		);
		const intents = afterFirst.filter((row) => row.payload?.kind === "intent");
		check("exactly one scoped Intent was committed", intents.length === 1, `count=${intents.length}`);
		check(
			"the scoped Intent has a non-empty scope",
			intents[0]?.payload?.scope === "unit:unlock",
			intents[0]?.payload?.scope,
		);
		const rejectedProposal = toolTrace.find(
			(entry) => entry.name === "aegis_propose" && /scoped_intent_scope_required|NON-EMPTY scope/.test(entry.text),
		);
		check(
			"a scope-less Intent is refused before it can be committed",
			Boolean(rejectedProposal),
			JSON.stringify(toolTrace.slice(0, 8)),
		);
		const intentIndex = afterFirst.findIndex((row) => row.event_id === intents[0]?.event_id);
		const firstWriteEffect = afterFirst.findIndex(
			(row) => row.event_type === "action.requested" && row.payload?.tool_name === "write",
		);
		check(
			"no write effect was requested before the scoped Intent",
			firstWriteEffect === -1 || firstWriteEffect > intentIndex,
			`intentIndex=${intentIndex} writeIndex=${firstWriteEffect}`,
		);
		check(
			"the fixture file reflects the allowed effect",
			JSON.parse(readFileSync(join(fixture.workspace, "door.json"), "utf8")).locked === false,
		);

		// Stall: same effect / same content digest twice.
		await host.dispatch("TASK console-task: keep probing the same write");
		// The dispatch above drives the review-hold rotation and the replacement.
		const rotatedRows = readRows(fixture.eventLogPath);
		const completions = rotatedRows.filter((row) => row.event_type === "handoff.completed");
		check("at most one bounded replacement happened", completions.length <= 1, `count=${completions.length}`);
		check("the Host created a genuinely different SDK Session", created.length >= 2, `sessions=${created.length}`);
		if (created.length >= 2) {
			check("replacement is a different SDK object", created[0] !== created[1]);
			check("replacement has a different session id", created[0].sessionId !== created[1].sessionId);
			check("replacement has a different session file", created[0].sessionFile !== created[1].sessionFile);
		}
		if (completions.length === 1) {
			const completion = completions[0];
			const completionIndex = rotatedRows.findIndex((row) => row.event_id === completion.event_id);
			const prefix = rotatedRows.slice(0, completionIndex);
			const prefixCycle = projectWorkCycle(
				prefix,
				prefix.find((row) => row.event_type === "episode.started")?.episode_id,
				{
					policy: POLICY,
				},
			);
			check(
				"the stall trigger was derived from committed evidence, not a model claim",
				typeof prefixCycle.trigger_id === "string" && prefixCycle.trigger_id.length > 0,
				JSON.stringify(prefixCycle.trigger_id),
			);
			check(
				"the rotation boundary names that committed trigger",
				String(completion.payload?.work_cycle_identity).startsWith(`review-hold:${prefixCycle.trigger_id}:`),
				String(completion.payload?.work_cycle_identity),
			);
			check("the source prefix is still review_required (carried, not cleared)", prefixCycle.review_required === true);
			check(
				"the completion names the real replacement Session",
				completion.payload?.to_session === created[1]?.sessionId,
			);
			check("the completion names the real source Session", completion.payload?.from_session === created[0]?.sessionId);
			check(
				"the completion is bound to a review-hold boundary",
				String(completion.payload?.work_cycle_identity).startsWith("review-hold:"),
			);
			check(
				"the completion stays in the same Episode",
				rotatedRows.filter((row) => row.event_type === "episode.started").length === 1,
			);
			const replacementRequests = requests.filter((request) => request.sessionId === created[1]?.sessionId);
			const firstReplacement = replacementRequests[0];
			check("the replacement issued at least one provider request", Boolean(firstReplacement));
			if (firstReplacement) {
				const carried = firstReplacement.ram?.task?.work_cycle ?? null;
				check(
					"its FIRST request carries the same work-cycle hold",
					carried?.status === "review_required",
					JSON.stringify(carried),
				);
				check(
					"its FIRST request carries the same trigger",
					typeof carried?.trigger_id === "string" &&
						carried.trigger_id === completion.payload?.work_cycle_identity?.split(":")[1],
					JSON.stringify({ ramTrigger: carried?.trigger_id, identity: completion.payload?.work_cycle_identity }),
				);
				check(
					"its FIRST request carries both action counters",
					Number.isFinite(carried?.action_count) && Number.isFinite(carried?.review_round_action_count),
					JSON.stringify(carried),
				);
				check(
					"the old assistant transcript is not replayed",
					!firstReplacement.messages.some((message) => message.role === "assistant") &&
						!firstReplacement.messages.some((message) => textOf(message).includes(SESSION_MARKER)),
				);
			}
			const reviewedAt = rotatedRows.findIndex((row) => row.payload?.kind === "work.review");
			check(
				"the review was recorded after the rotation (carried hold)",
				reviewedAt > rotatedRows.findIndex((row) => row.event_id === completion.event_id),
			);
		}
		// HC-08: under the hold, the effect stayed blocked while read/review worked.
		const heldWrite = toolTrace.filter((entry) => entry.session === created[1]?.sessionId && entry.name === "write");
		check(
			"the replacement's effect was refused while the hold was open",
			heldWrite.length === 0 ||
				heldWrite.some((entry) => /scoped_intent_required_before_effect|work review required/.test(entry.text)),
			JSON.stringify(heldWrite),
		);
		const finalRows = readRows(fixture.eventLogPath);
		const episodeId = finalRows.find((row) => row.event_type === "episode.started")?.episode_id;
		const finalCycle = projectWorkCycle(finalRows, episodeId, { policy: POLICY, board: undefined });
		check(
			"the review was consumed exactly once",
			finalCycle.consumptions.length === 1,
			JSON.stringify(finalCycle.consumptions),
		);
		check("the final work cycle is clear", finalCycle.review_required === false, JSON.stringify(finalCycle.status));
		const consumption = finalCycle.consumptions[0];
		check(
			"the consumption binds the review and the new Intent",
			Boolean(consumption?.review_event_id) && Boolean(consumption?.intent_event_id),
		);
		const intentAfter = finalRows.find((row) => row.event_id === consumption?.intent_event_id);
		check(
			"the consumed Intent is the unit:recover Intent",
			intentAfter?.payload?.scope === "unit:recover",
			intentAfter?.payload?.scope,
		);
		check(
			"the Task stayed in one Episode",
			finalRows.filter((row) => row.event_type === "episode.started").length === 1,
		);

		const status = await host.status();
		console.log(
			`CONSOLE_EVIDENCE ${JSON.stringify({ sessions: created.map((s) => s.sessionId), completions: completions.length, rotations: status.auto_rotations, workUnitState: status.work_unit_state, consumptions: finalCycle.consumptions.length })}`,
		);
		const stopped = await host.shutdown("test finished");
		check("shutdown releases the lease", stopped.ok === true);
	} finally {
		restoreEnv();
		fixture.cleanup();
	}
}

async function scenarioBoundedStop() {
	const fixture = makeFixture("bounded");
	const restoreEnv = bindEnv(fixture);
	let dispatch = 0;
	let lastKey = null;
	const created = [];
	try {
		const faux = registerFauxProvider({
			provider: "faux",
			models: [{ id: "console-fixture", contextWindow: 128000, maxTokens: 8192 }],
		});
		const responder = (context) => {
			const messages = context.messages ?? [];
			const active = created[created.length - 1];
			const assistantIndex = messages.map((message) => message.role).lastIndexOf("assistant");
			const results = messages.slice(assistantIndex + 1).filter((message) => message.role === "toolResult");
			if (results.length > 0) return fauxAssistantMessage("observed");
			const taskPrompts = messages.filter(
				(message) => message.role === "user" && textOf(message).trimStart().startsWith("TASK "),
			).length;
			if (taskPrompts === 0) return fauxAssistantMessage("continue");
			const key = `${active?.sessionId}:${taskPrompts}`;
			if (key !== lastKey) {
				lastKey = key;
				dispatch += 1;
			}
			if (dispatch === 1)
				return fauxAssistantMessage([
					fauxToolCall("aegis_propose", { kind: "intent", text: "probe once", scope: "unit:probe" }),
					fauxToolCall("write", { path: "door.json", content: JSON.stringify({ locked: false }) }),
				]);
			// Every later turn repeats the same effect: the hold never progresses and
			// no review/Intent is committed. The Host must stop after its bound.
			return fauxAssistantMessage([
				fauxToolCall("write", { path: "door.json", content: JSON.stringify({ locked: false }) }),
				fauxToolCall("write", { path: "door.json", content: JSON.stringify({ locked: false }) }),
			]);
		};
		faux.setResponses(Array.from({ length: 80 }, () => responder));

		const host = createExperimentConsole({
			label: "console-bounded",
			taskId: TASK,
			eventLogPath: fixture.eventLogPath,
			handoffPath: fixture.handoffPath,
			checkpointPath: fixture.checkpointPath,
			ownershipBaseDir: join(fixture.runtime, "console"),
			sessionFactory: () =>
				createConsoleSdkRuntime({
					sdk: {
						...sdkBase,
						AuthStorage,
						ReadOnlyAuthStorage,
						async createAgentSessionFromServices(options) {
							const result = await sdkBase.createAgentSessionFromServices(options);
							created.push(result.session);
							return result;
						},
					},
					providerKind: "faux",
					model: "console-fixture",
					fauxProviderFactory: () => faux,
					cwd: fixture.workspace,
					agentDir: fixture.agent,
					sessionDir: fixture.sessions,
				}),
			workCyclePolicy: POLICY,
			consolePolicy: { ...CONSOLE_POLICY, max_auto_rotations: 1 },
			continuation: (handoff) => `[Aegis console] continue episode ${handoff.episode_id} under the same hold.`,
		});
		await host.start();
		await host.dispatch("TASK console-task: start");
		const result = await host.dispatch("TASK console-task: repeat the same write");
		const rows = readRows(fixture.eventLogPath);
		const completions = rows.filter((row) => row.event_type === "handoff.completed");
		check("bounded rotation applied at most once", completions.length <= 1, `count=${completions.length}`);
		check(
			"the console stops instead of spinning",
			result.action === "blocked",
			JSON.stringify({ action: result.action, actions: result.actions }),
		);
		check(
			"no fake Outcome was written",
			rows.every((row) => row.event_type !== "outcome.recorded"),
		);
		check("Session creations stay bounded", created.length <= 2, `creations=${created.length}`);
		const status = await host.status();
		check(
			"the blocked status carries an actionable reason",
			typeof status.block_reason === "string" && status.block_reason.length > 0,
			status.block_reason,
		);
		console.log(
			`BOUNDED_EVIDENCE ${JSON.stringify({ sessions: created.length, completions: completions.length, block: status.block_reason })}`,
		);
		await host.shutdown("test finished");
	} finally {
		restoreEnv();
		fixture.cleanup();
	}
}

async function main() {
	await scenarioStartGateAndCarry();
	await scenarioBoundedStop();
	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exitCode = 1;
	} else {
		console.log("\nconsole SDK: start gate, carried hold, single consumption, bounded stop passed");
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
