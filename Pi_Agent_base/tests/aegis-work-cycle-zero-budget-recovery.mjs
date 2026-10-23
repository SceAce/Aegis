#!/usr/bin/env node
// REG-R2 — zero Session budget must refuse a staged handoff, including across a
// restart. Then an explicitly corrected budget must recover through the REAL
// Host/Supervisor/newSession path (not merely a completion row).
//
// Negative scenario: Run1 budget 0 -> refusal. Run2 SAME budget 0 -> must NOT
// write handoff.completed, must NOT complete the Task and must NOT execute the
// next-unit effect. Current product writes a completion on first prompt: RED.
//
// Positive scenario: Run1 budget 0 -> refusal. Run2 budget corrected to 4 ->
// one real rotation, one replacement Session object/id/file, one Session charge,
// one completion, one additional effect, no duplicate charge/action.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { buildC3FixtureManifest } from "../campaign/c3-entry.mjs";
import { runC6FromConfig } from "../campaign/c6-entry.mjs";
import { compileDocumentSeed } from "../memory/document-seed.mjs";
import { applyStagedHandoff } from "../session/handoff-host.mjs";
import { verifyChain } from "../shared/events.mjs";

const TASK = "task-hard";
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
const taskPrompt = (messages) =>
	messages.some((message) => message?.role === "user" && textOf(message).trimStart().startsWith(`TASK ${TASK}`));
const followUp = (messages) => {
	const lastAssistant = messages.map((m) => m?.role).lastIndexOf("assistant");
	return messages.slice(lastAssistant + 1).some((message) => message?.role === "toolResult");
};

function writeFixture(mode) {
	const base = mkdtempSync(join(tmpdir(), `aegis-work-zero-${mode}-`));
	const workspace = join(base, "workspace");
	const work = join(base, "run");
	const knowledge = join(base, "knowledge");
	mkdirSync(workspace);
	mkdirSync(work);
	mkdirSync(knowledge);
	writeFileSync(join(workspace, "door.json"), JSON.stringify({ locked: true }));
	writeFileSync(
		join(knowledge, "door.json"),
		JSON.stringify(
			compileDocumentSeed({
				markdown:
					"# Fixture door recovery\n\n## When\n\nRepeated fixture door updates leave locked true.\n\n## Do\n\nRead the door and set locked false.\n\n## Limits\n\nReference only.\n",
				source: { source_kind: "local_document", source_uri: "file:///test/door.md" },
			}),
		),
	);
	const manifest = buildC3FixtureManifest({ workspaceRoot: workspace, campaignId: `campaign-zero-${mode}` });
	manifest.tasks = [
		{
			...manifest.tasks[0],
			task_id: TASK,
			order: 1,
			depends_on: [],
			goal: { goal_id: "unlock", description: "Unlock the fixture door.", success_criteria: ["door.locked == false"] },
			stages: [{ stage_id: "stage-hard", criteria: ["door.locked == false"], required: true }],
			task_budget: { wall_time_ms: 180000, model_requests: 60, tool_calls: 120 },
		},
	];
	manifest.budget.task_count = 1;
	manifest.budget.session_count = 8;
	manifest.dynamic_task_policy.max_task_count = 1;
	manifest.session_policy.max_requests_per_session = 100;
	writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest));
	return { base, workspace, work, knowledge, manifest };
}

function writeConfig(fixture, name, sessionCount) {
	const path = join(fixture.base, `${name}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			schema_version: "campaign-config-1.1",
			manifest_path: join(fixture.base, "manifest.json"),
			workspace_root: fixture.workspace,
			work_dir: fixture.work,
			mode: "auto",
			provider: { kind: "faux", model: "zero-budget" },
			context: { strategy: "bounded_ram", max_total_input_chars: 1000000, output_reserve_chars: 1000 },
			learning: { policy: "off", promote_experience: false },
			task_family: "fixture-state",
			session: { session_count: sessionCount, max_requests_per_session: 100 },
			work_cycle: {
				enabled: true,
				repeat_limit: 3,
				action_window: 8,
				min_distinct_routes: 4,
				context_pressure_percent: 85,
				max_auto_rotations: 3,
				max_continuations: 12,
			},
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
		}),
	);
	return path;
}

function runOne(configPath, responder, sessions) {
	return runC6FromConfig({
		configPath,
		print() {},
		sdk: {
			...sdkBase,
			AuthStorage,
			async createAgentSessionFromServices(options) {
				const created = await sdkBase.createAgentSessionFromServices(options);
				sessions.push(created.session);
				return created;
			},
		},
		fauxProviderFactory(options) {
			const faux = registerFauxProvider(options);
			faux.setResponses(Array.from({ length: 40 }, () => responder));
			return faux;
		},
	});
}

function run1Responder(fixture) {
	let dispatch = 0;
	let lastKey = null;
	return (context) => {
		const messages = context.messages ?? [];
		if (followUp(messages)) return fauxAssistantMessage("observed");
		if (!taskPrompt(messages)) return fauxAssistantMessage("continuing");
		const count = messages.filter((m) => m?.role === "user" && textOf(m).trimStart().startsWith(`TASK ${TASK}`)).length;
		const key = `${count}:${readRows(join(fixture.work, "events.jsonl")).length}`;
		if (key !== lastKey) {
			lastKey = key;
			dispatch += 1;
		}
		const decision = (value) =>
			fauxToolCall("aegis_task_decision", {
				actions: [{ action_ref: "fixture.state.set", arguments: { target: "door.json", key: "locked", value } }],
			});
		if (dispatch === 1)
			return fauxAssistantMessage([
				fauxToolCall("aegis_propose", { kind: "intent", text: "initial repeated probe", scope: "unit:initial" }),
				...[1, 2, 3, 4].map(() => decision(true)),
			]);
		if (dispatch === 2)
			return fauxAssistantMessage([
				fauxToolCall("aegis_work_review", {
					blocker: "repeated failure",
					knowledge_query: "fixture door recovery",
					next_step: "switch state",
					tried_routes: ["fixture.state.set locked=true x4"],
				}),
			]);
		const review = readRows(join(fixture.work, "events.jsonl"))
			.filter((row) => row.payload?.kind === "work.review")
			.at(-1);
		return fauxAssistantMessage([
			fauxToolCall("aegis_propose", {
				kind: "intent",
				text: "reviewed next unit",
				scope: "unit:after-review",
				source_refs: [{ ref_type: "event", ref_id: review.event_id }],
			}),
			fauxToolCall("aegis_work_checkpoint", { unit_status: "complete", summary: "unit ready for handoff" }),
		]);
	};
}

function run2Responder({ negative }) {
	let dispatch = 0;
	let lastKey = null;
	return (context) => {
		const messages = context.messages ?? [];
		if (followUp(messages)) return fauxAssistantMessage("observed");
		if (!taskPrompt(messages)) return fauxAssistantMessage("continuing");
		const count = messages.filter((m) => m?.role === "user" && textOf(m).trimStart().startsWith(`TASK ${TASK}`)).length;
		const key = `${count}`;
		if (key !== lastKey) {
			lastKey = key;
			dispatch += 1;
		}
		const decision = (value) =>
			fauxToolCall("aegis_task_decision", {
				actions: [{ action_ref: "fixture.state.set", arguments: { target: "door.json", key: "locked", value } }],
			});
		if (negative) return fauxAssistantMessage([decision(false)]);
		if (dispatch === 1) return fauxAssistantMessage("recover the durable boundary");
		return fauxAssistantMessage([decision(false)]);
	};
}

function successEffects(rows) {
	return rows.filter(
		(row) =>
			row.event_type === "action.completed" && row.payload?.task_id === TASK && row.payload?.status === "success",
	);
}
function assertLedger(rows, label) {
	const open = new Set();
	const charged = new Set();
	for (const row of rows.filter((r) => r.payload?.kind === "c6.tool")) {
		const p = row.payload;
		const key = [p.campaign_id, p.task_id, p.episode_id, p.request_id, p.tool_call_id, p.unit_id].join("|");
		if (p.phase === "charged") {
			check(`${label}: no duplicate charge`, !charged.has(key), key);
			charged.add(key);
			open.add(key);
		} else if (p.phase === "finished") {
			check(`${label}: finish matches charge`, open.delete(key), key);
		}
	}
	check(`${label}: all tool units settle`, open.size === 0, [...open].join(","));
}

async function negativeScenario(previousKnowledge) {
	const fixture = writeFixture("negative");
	process.env.AEGIS_KNOWLEDGE_DIR = fixture.knowledge;
	process.env.AEGIS_KNOWLEDGE_ENABLED = "on";
	process.env.AEGIS_WEB_SEARCH = "off";
	const sessions = [];
	try {
		const run1 = await runOne(writeConfig(fixture, "run1", 0), run1Responder(fixture), sessions);
		const rows1 = readRows(join(fixture.work, "events.jsonl"));
		check(
			"R2 negative: Run1 refuses the rotation",
			run1.rotation_attempts.some((attempt) => attempt.applied === false),
			JSON.stringify(run1.rotation_attempts),
		);
		check(
			"R2 negative: Run1 writes no completion",
			rows1.filter((row) => row.event_type === "handoff.completed").length === 0,
		);
		check(
			"R2 negative: Run1 keeps the Task running",
			run1.task_states[TASK] === "running",
			JSON.stringify(run1.task_states),
		);
		const effectsAfterRun1 = successEffects(rows1).length;
		const run2 = await runOne(writeConfig(fixture, "run2", 0), run2Responder({ negative: true }), sessions);
		const rows2 = readRows(join(fixture.work, "events.jsonl"));
		const completions = rows2.filter((row) => row.event_type === "handoff.completed");
		check(
			"R2 negative: unchanged zero budget must still refuse completion after restart",
			completions.length === 0,
			JSON.stringify(completions.map((row) => row.payload)),
		);
		check(
			"R2 negative: the refused boundary must not complete the Task",
			run2.task_states[TASK] !== "completed",
			JSON.stringify(run2.task_states),
		);
		check(
			"R2 negative: no next-unit effect executes under the refused boundary",
			successEffects(rows2).length === effectsAfterRun1,
			`before=${effectsAfterRun1} after=${successEffects(rows2).length}`,
		);
		check(
			"R2 negative: the fixture file is unchanged",
			JSON.parse(readFileSync(join(fixture.workspace, "door.json"), "utf8")).locked === true,
		);
		check(
			"R2 negative: no Supervisor rotation was applied",
			(run2.rotation_attempts ?? []).every((attempt) => attempt.applied !== true),
			JSON.stringify(run2.rotation_attempts),
		);
		const stagedNegative = existsSync(join(fixture.work, "runtime", "handoff.json"))
			? JSON.parse(readFileSync(join(fixture.work, "runtime", "handoff.json"), "utf8"))
			: null;
		console.log(
			`ZERO_BUDGET_NEGATIVE ${JSON.stringify({
				run1Applied: run1.rotation_attempts.map((attempt) => attempt.applied),
				run2Applied: (run2.rotation_attempts ?? []).map((attempt) => attempt.applied),
				refusal: run2.rotation_attempts?.[0]?.reason ?? null,
				stagedRequestId: stagedNegative?.request_id ?? null,
				completions: completions.length,
				task: run2.task_states[TASK],
				successEffects: { before: effectsAfterRun1, after: successEffects(rows2).length },
				sessionIds: sessions.map((session) => session.sessionId),
			})}`,
		);
	} finally {
		for (const session of sessions) await session.dispose?.();
		if (previousKnowledge === undefined) delete process.env.AEGIS_KNOWLEDGE_DIR;
		else process.env.AEGIS_KNOWLEDGE_DIR = previousKnowledge;
		rmSync(fixture.base, { recursive: true, force: true });
	}
}

async function positiveScenario(previousKnowledge) {
	const fixture = writeFixture("positive");
	process.env.AEGIS_KNOWLEDGE_DIR = fixture.knowledge;
	process.env.AEGIS_KNOWLEDGE_ENABLED = "on";
	process.env.AEGIS_WEB_SEARCH = "off";
	const sessions = [];
	try {
		const run1 = await runOne(writeConfig(fixture, "run1", 0), run1Responder(fixture), sessions);
		check(
			"R2 positive: Run1 refuses the rotation",
			run1.rotation_attempts.some((attempt) => attempt.applied === false),
		);
		const effectsAfterRun1 = successEffects(readRows(join(fixture.work, "events.jsonl"))).length;
		// BIND/COMPLETION FAULT: a replacement that returns without a committed
		// completion must NOT be treated as applied. The staged request stays put,
		// the live attempt is cleared, and no completion is fabricated.
		const handoffPath = join(fixture.work, "runtime", "handoff.json");
		const faultRuntime = {
			session: { sessionId: "fault-source-session" },
			async newSession() {
				this.session = { sessionId: "fault-replacement-without-completion" };
				return { cancelled: false };
			},
		};
		const fault = await applyStagedHandoff({
			eventLogPath: join(fixture.work, "events.jsonl"),
			handoffPath,
			runtime: faultRuntime,
			taskId: TASK,
		});
		check(
			"R2 fault: a missing completion is refused, not reported as applied",
			fault.applied === false && /no committed handoff completion/i.test(fault.reason ?? ""),
			JSON.stringify(fault),
		);
		check(
			"R2 fault: no false completion is committed",
			readRows(join(fixture.work, "events.jsonl")).filter((row) => row.event_type === "handoff.completed").length === 0,
		);
		check("R2 fault: the staged request remains recoverable", existsSync(handoffPath));
		check("R2 fault: the live attempt is cleared", !existsSync(`${handoffPath}.attempt.json`));
		const sessionsBefore = sessions.length;
		const run2 = await runOne(writeConfig(fixture, "run2", 4), run2Responder({ negative: false }), sessions);
		const rows = readRows(join(fixture.work, "events.jsonl"));
		const completions = rows.filter((row) => row.event_type === "handoff.completed");
		check("R2 positive: exactly one completion", completions.length === 1, `count=${completions.length}`);
		check("R2 positive: Task completed", run2.task_states[TASK] === "completed", JSON.stringify(run2.task_states));
		check(
			"R2 positive: real fixture file changed",
			JSON.parse(readFileSync(join(fixture.workspace, "door.json"), "utf8")).locked === false,
		);
		const applied = (run2.rotation_attempts ?? []).filter((attempt) => attempt.applied === true);
		check(
			"R2 positive: the Supervisor applied exactly one rotation",
			applied.length === 1,
			JSON.stringify(run2.rotation_attempts),
		);
		check(
			"R2 positive: Run2 created its initial Session plus exactly one Supervisor replacement",
			sessions.length === sessionsBefore + 2,
			`sessions=${sessions.length} before=${sessionsBefore}`,
		);
		const run2Initial = sessions[sessionsBefore];
		const run2Replacement = sessions[sessionsBefore + 1];
		check(
			"R2 positive: the replacement is a different SDK object",
			Boolean(run2Replacement && run2Replacement !== run2Initial),
		);
		check(
			"R2 positive: the replacement has a different session id",
			Boolean(run2Replacement && run2Replacement.sessionId !== run2Initial?.sessionId),
		);
		check(
			"R2 positive: the replacement has a different session file",
			Boolean(run2Replacement && run2Replacement.sessionFile !== run2Initial?.sessionFile),
		);
		check(
			"R2 positive: the completion is bound to the Supervisor replacement, not the initial bind",
			Boolean(run2Replacement && completions[0]?.payload?.to_session === run2Replacement.sessionId),
			JSON.stringify({
				completion: completions[0]?.payload,
				initial: run2Initial?.sessionId,
				replacement: run2Replacement?.sessionId,
			}),
		);
		const rotation = applied[0];
		check(
			"R2 positive: exactly one Session generation is charged",
			rotation &&
				(rotation.budget_after?.consumed?.session_count ?? 0) ===
					(rotation.budget_before?.consumed?.session_count ?? 0) + 1,
			JSON.stringify(
				rotation?.budget_before
					? { before: rotation.budget_before.consumed, after: rotation.budget_after.consumed }
					: null,
			),
		);
		check(
			"R2 positive: exactly one new effect after recovery",
			successEffects(rows).length === effectsAfterRun1 + 1,
			`before=${effectsAfterRun1} after=${successEffects(rows).length}`,
		);
		const actionIds = successEffects(rows).map((row) => row.payload?.action_id);
		check("R2 positive: action ids are unique", new Set(actionIds).size === actionIds.length);
		assertLedger(rows, "R2 positive");
		check(
			"R2 positive: no Task unknown/failure row",
			rows.filter((row) => row.payload?.kind === "campaign.task.unknown" && row.payload?.task_id === TASK).length === 0,
		);
		check("R2 positive: event chain verifies", verifyChain(rows).ok === true);
		const run2Sessions = sessions.slice(sessionsBefore);
		console.log(
			`ZERO_BUDGET_RECOVERY_EVIDENCE ${JSON.stringify({
				request_id: completions[0]?.payload?.request_id ?? null,
				completion_event_id: completions[0]?.event_id ?? null,
				attempt_id: completions[0]?.payload?.attempt_id ?? null,
				from_session: completions[0]?.payload?.from_session ?? null,
				to_session: completions[0]?.payload?.to_session ?? null,
				initial_session: {
					id: run2Sessions[0]?.sessionId ?? null,
					file: run2Sessions[0]?.sessionFile ?? null,
				},
				replacement_session: {
					id: run2Sessions[1]?.sessionId ?? null,
					file: run2Sessions[1]?.sessionFile ?? null,
					different_object: run2Sessions[0] !== run2Sessions[1],
				},
				budget_before: applied[0]?.budget_before?.consumed ?? null,
				budget_after: applied[0]?.budget_after?.consumed ?? null,
				applied: applied.map((attempt) => ({
					applied: attempt.applied,
					new_object: attempt.new_object,
					new_session_id: attempt.new_session_id,
				})),
				completions: completions.length,
				task: run2.task_states[TASK],
				sessions: sessions.map((session) => session.sessionId),
				completionTo: completions[0]?.payload?.to_session,
			})}`,
		);
	} finally {
		for (const session of sessions) await session.dispose?.();
		if (previousKnowledge === undefined) delete process.env.AEGIS_KNOWLEDGE_DIR;
		else process.env.AEGIS_KNOWLEDGE_DIR = previousKnowledge;
		rmSync(fixture.base, { recursive: true, force: true });
	}
}

const previousKnowledge = process.env.AEGIS_KNOWLEDGE_DIR;
await negativeScenario(previousKnowledge);
await positiveScenario(previousKnowledge);
console.log(
	failures === 0
		? "\nZero-budget recovery: refusal and corrected-budget Supervisor recovery passed"
		: `\nZero-budget recovery: ${failures} check(s) failed (RED retained)`,
);
process.exit(failures === 0 ? 0 : 1);
