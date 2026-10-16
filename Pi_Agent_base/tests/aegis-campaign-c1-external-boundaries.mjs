#!/usr/bin/env node
// External C1 acceptance boundaries. Failures are intentional regression evidence
// until the findings in docs/C1_FINAL_EXTERNAL_AUDIT_3.md are fixed.
// Run: node --test Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCampaignScheduler, projectQueueFromEvents, resolveTaskOutcome } from "../campaign/index.mjs";
import { EventLog } from "../shared/events.mjs";

const campaignId = "campaign-external-boundaries";
const episodeId = "episode-original";
const scope = { env: "prod" };
const task = {
	task_id: "task-a",
	order: 1,
	depends_on: [],
	goal: { goal_id: "goal-a", success_criteria: ["criterion-a"] },
	stages: [{ stage_id: "stage-a", criteria: ["criterion-a"], required: true }],
	scope,
	task_budget: { wall_time_ms: 10, model_requests: 10, tool_calls: 10 },
};
const artifacts = { "artifact:a": { digest: "digest:a" } };
function outcome(stage, overrides = {}) {
	return {
		outcome_id: stage ? "outcome-stage" : "outcome-task",
		level: stage ? "step" : "episode",
		status: "success",
		task_id: task.task_id,
		episode_id: episodeId,
		...(stage ? { step_id: "stage-a" } : { task_oracle: true }),
		criterion: { criterion_id: stage ? "criterion-a" : "goal-a", expected: true },
		observed: { value: true },
		scope,
		oracle: { oracle_id: "oracle-local", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: task.task_id },
		evidence_refs: [{ ref_id: "artifact:a", digest: "digest:a" }],
		...overrides,
	};
}
function event(kind, payload = {}, source = "runtime") {
	return {
		schema_version: "1.1",
		event_type: "runtime.note",
		source: { kind: source },
		payload: { campaign_id: campaignId, kind, task_id: task.task_id, ...payload },
	};
}
function rows(events) {
	return events.map((e, i) => ({ ...e, event_id: `event-${i}`, sequence: i, event_digest: `digest:${i}` }));
}
function started() {
	return event("campaign.task.started", { episode_id: episodeId });
}
function judged(o) {
	return event(
		"campaign.oracle.result",
		{
			outcome_id: o.outcome_id,
			status: o.status,
			episode_id: o.episode_id,
			...(o.step_id ? { step_id: o.step_id } : { task_oracle: true }),
			outcome: o,
		},
		"oracle",
	);
}
function project(events, definition = task, priorState = null) {
	return projectQueueFromEvents({ campaign_id: campaignId, tasks: [definition], events, artifacts, priorState });
}
function prior(p) {
	return structuredClone({
		queue: p.tasks,
		budget: p.budget,
		control: p.control,
		proposals: [...p.proposals].map(([id, entry]) => ({ id, ...entry })),
		outcomes: [...p.outcomes].map(([id, entry]) => ({ id, outcome: entry })),
		tail_offset: p.tail_offset,
	});
}
function completion(stage, taskResult = outcome(false), definition = task, reconcile = false) {
	return project(
		rows([
			started(),
			judged(stage),
			judged(taskResult),
			event(reconcile ? "campaign.reconciliation.resolved" : "campaign.task.completed", {
				outcome_id: taskResult.outcome_id,
				verdict: "success",
			}),
		]),
		definition,
	);
}

test("CONTROL: fully bound stage and task evidence completes through both gates", () => {
	for (const reconcile of [false, true]) {
		const p = completion(outcome(true), outcome(false), task, reconcile);
		assert.equal(p.tasks[0].state, "completed", JSON.stringify(p.rejected));
	}
});

test("F10: missing current scope must not disable task outcome scope validation", () => {
	const result = resolveTaskOutcome({
		result: outcome(false),
		task: { ...task, scope: null },
		episodeId,
		scope: null,
		artifacts,
		eventSource: "oracle",
	});
	assert.equal(result.ok, false, "null current scope is unknown authority, not a wildcard");
});

test("F10: both scopes missing cannot complete a task", () => {
	const p = completion(outcome(true, { scope: null }), outcome(false, { scope: null }), { ...task, scope: null });
	assert.notEqual(p.tasks[0].state, "completed");
});

for (const [name, patch] of [
	["foreign scope", { scope: { env: "foreign" } }],
	["missing scope", { scope: null }],
	["missing episode", { episode_id: null }],
	["empty evidence", { evidence_refs: [] }],
	["non-independent provenance", { provenance: { source: "oracle", independent: false, task_id: task.task_id } }],
]) {
	for (const reconcile of [false, true]) {
		test(`F11: ${name} stage cannot complete ${reconcile ? "reconciliation" : "normal"} path`, () => {
			const p = completion(outcome(true, patch), outcome(false), task, reconcile);
			assert.notEqual(p.tasks[0].state, "completed", `${name}; reconciliation=${reconcile}`);
		});
	}
}

test("F12: checkpoint hydration preserves the current episode", () => {
	const events = rows([started()]);
	const full = project(events);
	const restored = project(events, task, prior(full));
	assert.equal(restored.tasks[0].episode_id, episodeId);
});

test("F12: checkpoint hydration cannot admit a task outcome from a foreign episode", () => {
	const events = rows([started(), judged(outcome(false, { episode_id: "episode-foreign" }))]);
	const full = project(events);
	const restored = project(events, task, prior(project(events.slice(0, 1))));
	assert.equal(full.tasks[0].task_outcome_status ?? null, null);
	assert.equal(restored.tasks[0].task_outcome_status ?? null, null, "cache+tail must reject the same foreign episode");
});

test("F12: outcome id deduplication survives the checkpoint boundary", () => {
	const events = rows([started(), judged(outcome(true)), judged(outcome(true))]);
	const full = project(events);
	const restored = project(events, task, prior(project(events.slice(0, 2))));
	assert.equal(full.tasks[0].stage_outcomes.length, 1);
	assert.equal(restored.tasks[0].stage_outcomes.length, 1, "cached outcomes must seed deduplication");
});

test("F12: command deduplication survives the checkpoint boundary", () => {
	const charge = event("campaign.budget.consumed", {
		command_id: "charge-once",
		consumed: { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
	});
	const events = rows([started(), charge, charge]);
	const full = project(events);
	const restored = project(events, task, prior(project(events.slice(0, 2))));
	assert.equal(full.budget.consumed.model_requests, 1);
	assert.equal(restored.budget.consumed.model_requests, 1, "a repeated charge is not a new charge");
});

async function checkpointFor(stage) {
	const events = rows([started(), judged(stage), event("campaign.campaign.cancelled", { reason: "audit-stop" })]);
	let captured;
	const scheduler = createCampaignScheduler({
		manifest: { campaign_id: campaignId, revision: 1, budget: {}, tasks: [task] },
		ownedTasks: [task],
		baseDir: "unused-injected-checkpoint",
		acquireOwnership: false,
		sink: { replay: () => events },
		artifacts,
		worker: {
			run() {
				throw new Error("cancelled campaign must never dispatch");
			},
		},
		oracle: {},
		readCheckpointImpl: () => ({ ok: false, reason: "absent" }),
		writeCheckpointImpl: (_base, _campaign, record) => {
			captured = structuredClone(record);
			return { ok: true };
		},
	});
	await scheduler.run();
	assert.ok(captured, "the actual scheduler checkpoint writer must be called");
	return captured;
}

test("F13: actual scheduler checkpoint contains episode binding", async () => {
	const cp = await checkpointFor(outcome(true));
	assert.equal(cp.queue[0].episode_id, episodeId);
});

test("F13: scheduler projection digest changes when stage observation changes at fixed ids", async () => {
	const a = await checkpointFor(outcome(true, { observed: { value: "a" } }));
	const b = await checkpointFor(outcome(true, { observed: { value: "b" } }));
	assert.notDeepEqual(a.queue[0].stage_outcomes, b.queue[0].stage_outcomes);
	assert.notEqual(a.projection_digest, b.projection_digest, "F8 requires full stage projection in the state digest");
});

// Actual scheduler + durable EventLog entry. Outcomes and the artifact index
// are synthetic test evidence; there is no model, network or real target.
for (const foreign of [false, true]) {
	test(`F11-PRODUCT: real EventLog reconciliation with ${foreign ? "foreign" : "matching"} stage scope`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "aegis-external-boundary-"));
		const log = new EventLog(join(dir, "events.jsonl"));
		let reruns = 0;
		try {
			assert.equal((await log.open()).ok, true);
			assert.equal((await log.append(started())).ok, true);
			const scheduler = createCampaignScheduler({
				manifest: { campaign_id: campaignId, revision: 1, budget: {}, tasks: [task] },
				ownedTasks: [task],
				baseDir: null,
				acquireOwnership: false,
				artifacts,
				sink: { append: (e) => log.append(e), replay: () => log.replay() },
				worker: {
					async run() {
						reruns += 1;
						return { ok: true };
					},
				},
				oracle: {
					async reconcile() {
						return {
							status: "success",
							outcome_id: "outcome-task",
							outcome: outcome(false),
							stage_outcomes: [outcome(true, { scope: foreign ? { env: "foreign" } : scope })],
						};
					},
				},
			});
			const result = await scheduler.run();
			assert.equal(reruns, 0, "a stranded worker must not be run again");
			assert.ok(log.replay().some((e) => e.payload.kind === "campaign.reconciliation.resolved"));
			if (foreign)
				assert.notEqual(
					result.status.tasks[0].state,
					"completed",
					"foreign stage must not complete through the real product entry",
				);
			else assert.equal(result.status.tasks[0].state, "completed");
		} finally {
			await log.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
}
