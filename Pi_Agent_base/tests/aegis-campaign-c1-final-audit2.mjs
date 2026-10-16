#!/usr/bin/env node
// Aegis C1 Final Audit Fix (F7–F9) — regression tests.
//
// TEST-FIRST: expectations come from docs/C1_FINAL_AUDIT_FIX_TASK.md and
// docs/C1_FINAL_EXTERNAL_AUDIT.md, not from the implementation.
//
// Offline: no network, no model, no real Pi Session.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-final-audit2.mjs

import assert from "node:assert/strict";

import {
	buildFixtureCampaign,
	createCampaignScheduler,
	projectionSnapshot,
	projectQueueFromEvents,
	resolveTaskOutcome,
} from "../campaign/index.mjs";

const failures = [];
async function test(name, fn) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures.push({ name, error });
		console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const CAMPAIGN = "campaign-f789";
const EP = "ep-1";
const TASK_SCOPE = { env: "prod" };

function ev(o, kind, payload, source = { kind: "runtime" }) {
	return {
		schema_version: "1.1",
		event_type: "runtime.note",
		event_id: `e${o}`,
		sequence: o,
		source,
		payload: { kind, campaign_id: CAMPAIGN, ...payload },
		event_digest: `sha256:e${o}`,
	};
}

const taskA = {
	task_id: "task-a",
	order: 1,
	depends_on: [],
	goal: { goal_id: "goal-a", description: "a", success_criteria: ["c-a"] },
	stages: [{ stage_id: "stage-a", criteria: ["c-a"], required: true }],
	scope: TASK_SCOPE,
	task_budget: { wall_time_ms: 100, model_requests: 3, tool_calls: 3 },
};
const taskB = {
	task_id: "task-b",
	order: 2,
	depends_on: ["task-a"],
	goal: { goal_id: "goal-b", description: "b", success_criteria: ["c-b"] },
	stages: [{ stage_id: "stage-b", criteria: ["c-b"], required: true }],
	scope: TASK_SCOPE,
	task_budget: { wall_time_ms: 100, model_requests: 3, tool_calls: 3 },
};
const ARTIFACTS = { "artifact:task-a": { ref_id: "artifact:task-a", digest: "sha256:content-a" } };

function stageOutcome(over = {}) {
	return {
		outcome_id: "so-a",
		level: "step",
		step_id: "stage-a",
		status: "success",
		episode_id: EP,
		task_id: "task-a",
		criterion: { criterion_id: "c-a", expected: "c-a" },
		observed: { synthetic: true },
		scope: { ...TASK_SCOPE },
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: "task-a", stage_id: "stage-a" },
		evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:task-a", digest: "sha256:content-a" }],
		...over,
	};
}

function taskOutcome(over = {}) {
	return {
		outcome_id: "o-a",
		level: "episode",
		status: "success",
		episode_id: EP,
		task_id: "task-a",
		task_oracle: true,
		criterion: { criterion_id: "goal-a", expected: "goal-a" },
		observed: { synthetic: true },
		scope: { ...TASK_SCOPE },
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: "task-a" },
		evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:task-a", digest: "sha256:content-a" }],
		...over,
	};
}

// ---------------------------------------------------------------------------
// F7 — reconciliation reuses the Stage gate
// ---------------------------------------------------------------------------

function stageEvent(o, outcome) {
	return ev(
		o,
		"campaign.oracle.result",
		{ task_id: "task-a", outcome_id: outcome.outcome_id, status: outcome.status, step_id: outcome.step_id, outcome },
		{ kind: "oracle" },
	);
}
function taskEvent(o, outcome) {
	return ev(
		o,
		"campaign.oracle.result",
		{
			task_id: "task-a",
			outcome_id: outcome.outcome_id,
			status: outcome.status,
			task_oracle: true,
			episode_id: EP,
			outcome,
		},
		{ kind: "oracle" },
	);
}

function project(events, tasks = [taskA]) {
	return projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks, events, artifacts: ARTIFACTS });
}

await test("F7-NO-STAGE: reconciliation success without stage evidence does not complete", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		taskEvent(1, taskOutcome()),
		ev(2, "campaign.reconciliation.resolved", { task_id: "task-a", outcome_id: "o-a", verdict: "success" }),
	];
	const p = project(events);
	assert.notEqual(p.tasks[0].state, "completed", "required stages must gate reconciliation completion");
	assert.ok(p.tasks[0].state === "waiting_oracle" || p.tasks[0].state === "unknown" || p.tasks[0].state === "running");
});

await test("F7-MISSING-CRIT: a required criterion missing blocks reconciliation completion", () => {
	// The stage Outcome targets a criterion the stage does not declare as satisfied.
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, stageOutcome({ criterion: { criterion_id: "c-other", expected: "c-other" } })),
		taskEvent(2, taskOutcome()),
		ev(3, "campaign.reconciliation.resolved", { task_id: "task-a", outcome_id: "o-a", verdict: "success" }),
	];
	const p = project(events);
	assert.notEqual(p.tasks[0].state, "completed");
});

await test("F7-FOREIGN-STAGE: a foreign stage Outcome cannot satisfy the gate", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, stageOutcome({ task_id: "task-foreign" })),
		taskEvent(2, taskOutcome()),
		ev(3, "campaign.reconciliation.resolved", { task_id: "task-a", outcome_id: "o-a", verdict: "success" }),
	];
	const p = project(events);
	assert.notEqual(p.tasks[0].state, "completed");
});

await test("F7-SUPERSEDED: a superseded stage success cannot satisfy the gate", () => {
	const prior = stageOutcome({ outcome_id: "so-a", scope: { ...TASK_SCOPE } });
	const correction = stageOutcome({
		outcome_id: "so-a2",
		status: "unknown",
		observed: null,
		evidence_refs: [],
		supersedes: "so-a",
	});
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, prior),
		stageEvent(2, correction),
		taskEvent(3, taskOutcome()),
		ev(4, "campaign.reconciliation.resolved", { task_id: "task-a", outcome_id: "o-a", verdict: "success" }),
	];
	const p = project(events);
	assert.notEqual(p.tasks[0].state, "completed");
});

await test("F7-FULL: full stage evidence + task success completes via reconciliation", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, stageOutcome()),
		taskEvent(2, taskOutcome()),
		ev(3, "campaign.reconciliation.resolved", { task_id: "task-a", outcome_id: "o-a", verdict: "success" }),
	];
	const p = project(events, [taskA, taskB]);
	const a = p.tasks.find((t) => t.task_id === "task-a");
	assert.equal(a.state, "completed", p.rejected.map((r) => r.reason).join("; "));
	assert.equal(a.task_outcome_ref, "o-a", "the outcome id matches");
	assert.equal(p.tasks.find((t) => t.task_id === "task-b").state, "ready", "the dependent becomes ready");
});

await test("F7-WORKER: reconciliation completes without re-running the worker", async () => {
	const sink = {
		events: [],
		async append(event) {
			const row = {
				...event,
				event_id: `e${this.events.length}`,
				sequence: this.events.length,
				event_digest: `sha256:e${this.events.length}`,
			};
			this.events.push(row);
			return { ok: true, event: row, durable: true };
		},
		replay() {
			return this.events.slice();
		},
	};
	// A durable intent with no result.
	await sink.append({
		event_type: "runtime.note",
		source: { kind: "runtime" },
		payload: { kind: "campaign.task.started", campaign_id: CAMPAIGN, task_id: "task-a", episode_id: "ep-task-a" },
	});
	const dispatched = [];
	const scheduler = createCampaignScheduler({
		manifest: { campaign_id: CAMPAIGN, revision: 1, schema_version: "campaign-1.0", budget: {}, tasks: [taskA] },
		ownedTasks: [taskA],
		baseDir: null,
		sink,
		artifacts: ARTIFACTS,
		worker: {
			async run({ task }) {
				dispatched.push(task.task_id);
				return { ok: true, outcome_ref: "artifact:task-a" };
			},
		},
		oracle: {
			async judge() {
				return {
					status: "success",
					task_oracle: true,
					outcome_id: "o-a",
					stage_outcomes: [
						{
							step_id: "stage-a",
							status: "success",
							outcome_id: "so-a",
							outcome: stageOutcome({ episode_id: "ep-task-a" }),
						},
					],
					outcome: taskOutcome({ episode_id: "ep-task-a" }),
				};
			},
			async reconcile() {
				return {
					status: "success",
					outcome_id: "o-a",
					stage_outcomes: [
						{
							step_id: "stage-a",
							status: "success",
							outcome_id: "so-a",
							outcome: stageOutcome({ episode_id: "ep-task-a" }),
						},
					],
					outcome: taskOutcome({ episode_id: "ep-task-a" }),
				};
			},
		},
		clock: () => 1,
		acquireOwnership: false,
	});
	const result = await scheduler.run();
	assert.equal(result.status.tasks[0].state, "completed");
	assert.equal(dispatched.includes("task-a"), false, "the worker is not re-run");
});

// ---------------------------------------------------------------------------
// F8 — complete Stage Outcome projection
// ---------------------------------------------------------------------------

async function snapshotFor(stage) {
	const events = [ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }), stageEvent(1, stage)];
	const snap = projectionSnapshot(project(events));
	// Compare the STAGE-OUTCOME projection specifically, so a task-state change
	// (e.g. failure) cannot mask a stage-Outcome content change.
	const task = snap.tasks.find((t) => t.task_id === "task-a");
	return JSON.stringify(task?.stage_outcomes ?? task?.stage_outcome_ids ?? null);
}

await test("F8-STATUS: the same stage id with a changed status changes the snapshot", async () => {
	const a = await snapshotFor(stageOutcome({ status: "success" }));
	const b = await snapshotFor(stageOutcome({ status: "failure" }));
	assert.notEqual(a, b, "the stage Outcome status must be part of the projection");
});

await test("F8-CRITERION: the same stage id with a changed criterion changes the snapshot", async () => {
	const a = await snapshotFor(stageOutcome({ criterion: { criterion_id: "c-a", expected: "c-a" } }));
	const b = await snapshotFor(stageOutcome({ criterion: { criterion_id: "c-a", expected: "c-different" } }));
	assert.notEqual(a, b);
});

await test("F8-EVIDENCE: the same stage id with changed evidence changes the snapshot", async () => {
	const a = await snapshotFor(
		stageOutcome({ evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:task-a", digest: "sha256:content-a" }] }),
	);
	const b = await snapshotFor(
		stageOutcome({ evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:task-a", digest: "sha256:content-b" }] }),
	);
	assert.notEqual(a, b);
});

await test("F8-SCOPE: the same stage id with a changed scope changes the snapshot", async () => {
	const a = await snapshotFor(stageOutcome({ scope: { env: "prod" } }));
	const b = await snapshotFor(stageOutcome({ scope: { env: "dev" } }));
	assert.notEqual(a, b);
});

await test("F8-OUTCOME-INDEX: stage Outcomes enter the projection outcomes index", () => {
	const events = [ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }), stageEvent(1, stageOutcome())];
	const p = project(events);
	assert.ok(p.outcomes.has("so-a"), "the stage Outcome is indexed by outcome_id");
	assert.equal(p.outcomes.get("so-a").step_id, "stage-a");
});

await test("F8-PREFIX-FULL: prefix+tail equals the full replay across the complete stage projection", () => {
	const all = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, stageOutcome()),
		taskEvent(2, taskOutcome()),
		ev(3, "campaign.campaign.paused", { reason: "user_paused" }),
	];
	const full = project(all, [taskA, taskB]);
	const prefix = project(all.slice(0, 2), [taskA, taskB]);
	const prefixPlusTail = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: [taskA, taskB],
		events: all,
		artifacts: ARTIFACTS,
		priorState: {
			queue: prefix.tasks.map((t) => ({
				task_id: t.task_id,
				state: t.state,
				depends_on: t.depends_on,
				order: t.order,
				reservation: t.reservation,
				budget_consumed: t.budget_consumed,
				definition: t.definition,
				is_dynamic: t.is_dynamic,
				parent_task_id: t.parent_task_id,
				stage_ids: t.stage_ids,
				task_outcome_status: t.task_outcome_status,
				task_outcome_ref: t.task_outcome_ref,
				task_outcomes: t.task_outcomes,
				stage_outcomes: t.stage_outcomes,
				stop_reason: t.stop_reason,
				reconciliation_state: t.reconciliation_state,
			})),
			budget: prefix.budget,
			control: prefix.control,
			proposals: [...prefix.proposals.entries()].map(([id, e]) => ({
				id,
				digest: e.digest,
				offset: e.offset,
				proposal: e.proposal,
			})),
			outcomes: [...prefix.outcomes.entries()].map(([id, outcome]) => ({ id, outcome })),
			tail_offset: 1,
		},
	});
	assert.deepEqual(projectionSnapshot(prefixPlusTail), projectionSnapshot(full));
});

// ---------------------------------------------------------------------------
// F9 — Task scope into the resolver
// ---------------------------------------------------------------------------

await test("F9-MATCH: a matching task scope is accepted", () => {
	const r = resolveTaskOutcome({
		result: taskOutcome(),
		task: taskA,
		episodeId: EP,
		scope: TASK_SCOPE,
		artifacts: ARTIFACTS,
		eventSource: "oracle",
	});
	assert.equal(r.ok, true, r.reasons?.join("; "));
});

await test("F9-FOREIGN: a foreign task scope is rejected", () => {
	const r = resolveTaskOutcome({
		result: taskOutcome({ scope: { env: "dev" } }),
		task: taskA,
		episodeId: EP,
		scope: TASK_SCOPE,
		artifacts: ARTIFACTS,
		eventSource: "oracle",
	});
	assert.equal(r.ok, false);
});

await test("F9-FOREIGN-PROJECTION: the projection rejects a foreign task scope", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, stageOutcome({ scope: { env: "dev" } })),
		taskEvent(2, taskOutcome({ scope: { env: "dev" } })),
		ev(3, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
	];
	const p = project(events);
	assert.notEqual(p.tasks[0].state, "completed", "a foreign task scope must be rejected");
});

await test("F9-MISSING: a missing outcome scope is fail-closed against a declared task scope", () => {
	const r = resolveTaskOutcome({
		result: taskOutcome({ scope: null }),
		task: taskA,
		episodeId: EP,
		scope: TASK_SCOPE,
		artifacts: ARTIFACTS,
		eventSource: "oracle",
	});
	assert.equal(r.ok, false);
});

await test("F9-KEYORDER: an equal scope with a different key order is canonical-equal", () => {
	const r = resolveTaskOutcome({
		result: taskOutcome({ scope: { env: "prod", region: "us" } }),
		task: { ...taskA, scope: { region: "us", env: "prod" } },
		episodeId: EP,
		scope: { region: "us", env: "prod" },
		artifacts: ARTIFACTS,
		eventSource: "oracle",
	});
	assert.equal(r.ok, true, r.reasons?.join("; "));
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 final audit2: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 final audit2: all assertions passed");
void buildFixtureCampaign;
