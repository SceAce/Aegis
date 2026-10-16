#!/usr/bin/env node
// Aegis C1 Closure focused tests: source permissions, dynamic admission,
// queue transitions, budget ledger.
//
// TEST-FIRST: expectations come from docs/C1_CLOSURE_BASELINE.md §3 and
// docs/C1_CLOSURE_TEST_MATRIX.md, not from current implementation returns.
// Synthetic-but-structurally-complete committed events; no network/model.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-closure.mjs

import assert from "node:assert/strict";

import {
	admitTaskProposal,
	buildFixtureCampaign,
	projectQueueFromEvents,
	validateCampaignEvent,
} from "../campaign/index.mjs";

const failures = [];
function test(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures.push({ name, error });
		console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const CAMPAIGN = "campaign-c1c";
const TASK_A = "task-a";
const TASK_B = "task-b";
const EP = "ep-1";

function ev(sequence, kind, payload, overrides = {}) {
	return {
		schema_version: "1.1",
		event_type: "runtime.note",
		event_id: overrides.event_id ?? `e${sequence}`,
		episode_id: overrides.episode_id ?? EP,
		sequence,
		source: overrides.source ?? { kind: "runtime", actor_id: "host", adapter: "aegis-runtime", version: "0.1.0" },
		payload: { kind, campaign_id: CAMPAIGN, ...payload },
		event_digest: overrides.event_digest ?? `sha256:e${sequence}`,
	};
}

const staticTasks = [
	{ task_id: TASK_A, order: 1, depends_on: [] },
	{ task_id: TASK_B, order: 2, depends_on: [TASK_A] },
];

// A task with a goal/stage definition so the trusted Outcome resolver can bind.
const TASK_SCOPE = { environment: "fixture-env" };

function boundTask(id, depends_on = []) {
	return {
		task_id: id,
		order: 1,
		depends_on,
		goal: { goal_id: `${id}-goal`, description: "goal", success_criteria: [`${id}-criterion`] },
		stages: [{ stage_id: `${id}-stage`, criteria: [`${id}-criterion`], required: true }],
		scope: TASK_SCOPE,
	};
}

// A fully bound trusted success Outcome for a task (criterion/scope/observed/evidence).
function boundSuccess(task) {
	const goalId = task.goal?.goal_id ?? `${task.task_id}-goal`;
	return {
		outcome_id: `o-${task.task_id}`,
		level: "episode",
		status: "success",
		episode_id: EP,
		task_id: task.task_id,
		task_oracle: true,
		criterion: { criterion_id: goalId, expected: goalId },
		observed: { synthetic: true },
		scope: { ...TASK_SCOPE },
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: task.task_id },
		evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${task.task_id}` }],
	};
}

function stageSuccess(task) {
	const stage = task.stages[0];
	const criterion = stage.criteria[0];
	return {
		outcome_id: `so-${task.task_id}`,
		level: "step",
		step_id: stage.stage_id,
		status: "success",
		episode_id: EP,
		task_id: task.task_id,
		criterion: { criterion_id: criterion, expected: criterion },
		observed: { synthetic: true },
		scope: { ...TASK_SCOPE },
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: task.task_id, stage_id: stage.stage_id },
		evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${task.task_id}` }],
	};
}

function artifactsFor(task) {
	return {
		[`artifact:${task.task_id}`]: { ref_id: `artifact:${task.task_id}`, digest: `sha256:synthetic-${task.task_id}` },
	};
}

// A structurally complete, policy-admissible dynamic proposal + decision.
// The static task set MUST be the Manifest's own tasks so the projection and the
// policy evaluator agree on the Campaign task set.
function makeProposalAndDecision() {
	const fixture = buildFixtureCampaign();
	const manifest = fixture.manifest;
	const proposal = {
		proposed_task_id: "task-dyn-1",
		parent_task_id: manifest.tasks[0].task_id,
		parent_stage_id: manifest.tasks[0].stages[0].stage_id,
		goal: { description: "observe again", success_criteria: ["door.locked == true"] },
		target_ref: "fixture/door.json",
		task_type: "observe",
		required_capabilities: ["fixture.observe"],
		expected_evidence: ["observation.captured"],
		budget_reservation: { wall_time_ms: 1000, model_requests: 1, tool_calls: 2 },
		priority: 1,
		stop_condition: "no remaining authorized target",
	};
	const decision = admitTaskProposal({ proposal, manifest, depth: 1 });
	return { manifest, proposal, decision };
}

// ---------------------------------------------------------------------------
// A. Source permissions
// ---------------------------------------------------------------------------

test("SRC-01: an agent-sourced oracle result is refused", () => {
	const result = validateCampaignEvent(
		ev(
			0,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: "o1", status: "success" },
			{ source: { kind: "agent" } },
		),
	);
	assert.equal(result.ok, false);
	assert.ok(
		result.reasons.some((r) => /source|agent/i.test(r)),
		result.reasons.join("; "),
	);
});

test("SRC-02: an observer-sourced task completion is refused", () => {
	const result = validateCampaignEvent(
		ev(0, "campaign.task.completed", { task_id: TASK_A }, { source: { kind: "observer" } }),
	);
	assert.equal(result.ok, false);
});

test("SRC-03: an environment-sourced task start is refused", () => {
	const result = validateCampaignEvent(
		ev(0, "campaign.task.started", { task_id: TASK_A }, { source: { kind: "environment" } }),
	);
	assert.equal(result.ok, false);
});

test("SRC-04: an agent-sourced task completion is refused", () => {
	const result = validateCampaignEvent(
		ev(0, "campaign.task.completed", { task_id: TASK_A }, { source: { kind: "agent" } }),
	);
	assert.equal(result.ok, false);
});

test("SRC-05: an observer-sourced oracle result is refused", () => {
	const result = validateCampaignEvent(
		ev(
			0,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: "o1", status: "success" },
			{ source: { kind: "observer" } },
		),
	);
	assert.equal(result.ok, false);
});

test("SRC-06: an llm proposal submission is accepted (recorded only)", () => {
	const result = validateCampaignEvent(
		ev(0, "campaign.proposal.submitted", { proposal_id: "p1" }, { source: { kind: "llm" } }),
	);
	assert.equal(result.ok, true, result.reasons.join("; "));
});

test("SRC-07: an llm-sourced admitted proposal is refused", () => {
	const result = validateCampaignEvent(
		ev(0, "campaign.proposal.admitted", { proposal_id: "p1", task_id: "task-dyn-1" }, { source: { kind: "llm" } }),
	);
	assert.equal(result.ok, false);
});

test("SRC-08: a runtime-sourced task start is accepted", () => {
	const result = validateCampaignEvent(ev(0, "campaign.task.started", { task_id: TASK_A }));
	assert.equal(result.ok, true, result.reasons.join("; "));
});

test("SRC-09: an oracle-sourced oracle result is accepted", () => {
	const result = validateCampaignEvent(
		ev(
			0,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: "o1", status: "success" },
			{ source: { kind: "oracle" } },
		),
	);
	assert.equal(result.ok, true, result.reasons.join("; "));
});

test("SRC-10: a runtime-sourced oracle result is refused (runtime cannot self-Oracle)", () => {
	const result = validateCampaignEvent(
		ev(
			0,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: "o1", status: "success" },
			{ source: { kind: "runtime" } },
		),
	);
	assert.equal(result.ok, false);
});

test("SRC-11: budget events must come from runtime, not oracle/agent", () => {
	const ok = validateCampaignEvent(
		ev(0, "campaign.budget.consumed", { task_id: TASK_A, consumed: { wall_time_ms: 1 } }),
	);
	assert.equal(ok.ok, true, ok.reasons.join("; "));
	const bad = validateCampaignEvent(
		ev(
			0,
			"campaign.budget.consumed",
			{ task_id: TASK_A, consumed: { wall_time_ms: 1 } },
			{ source: { kind: "agent" } },
		),
	);
	assert.equal(bad.ok, false);
});

// ---------------------------------------------------------------------------
// B. Dynamic admission
// ---------------------------------------------------------------------------

test("ADM-01: an admitted event with no proposal/decision has no effect", () => {
	const events = [
		ev(0, "campaign.proposal.admitted", {
			proposal_id: "p1",
			task_id: "task-dyn-1",
			parent_task_id: TASK_A,
			reservation: { wall_time_ms: 1000, model_requests: 1, tool_calls: 2 },
		}),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.equal(
		projection.tasks.some((t) => t.task_id === "task-dyn-1"),
		false,
		"no task may be created",
	);
	assert.equal(projection.budget.reserved.wall_time_ms, 0, "no budget may be reserved");
	assert.ok(projection.rejected.length > 0, "the invalid admission is audited");
});

test("ADM-02: an admitted event with a valid proposal+decision creates the task and reservation", () => {
	const { manifest, proposal, decision } = makeProposalAndDecision();
	assert.equal(decision.status, "admitted", decision.reasons.join("; "));
	const events = [
		ev(0, "campaign.proposal.submitted", { proposal_id: "p1", proposal, proposal_digest: "sha256:p1" }),
		ev(1, "campaign.proposal.admitted", {
			proposal_id: "p1",
			proposal_digest: "sha256:p1",
			task_id: proposal.proposed_task_id,
			parent_task_id: proposal.parent_task_id,
			admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
		}),
	];
	const projection = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: manifest.tasks,
		events,
		manifest,
	});
	assert.equal(
		projection.tasks.some((t) => t.task_id === proposal.proposed_task_id),
		true,
	);
	const staticWall = manifest.tasks.reduce((sum, t) => sum + (t.task_budget?.wall_time_ms ?? 0), 0);
	assert.equal(projection.budget.reserved.wall_time_ms, staticWall + 1000, "the dynamic reservation is added");
});

test("ADM-03: an admitted event whose decision is not 'admitted' has no effect", () => {
	const { manifest, proposal, decision } = makeProposalAndDecision();
	const events = [
		ev(0, "campaign.proposal.admitted", {
			proposal_id: "p1",
			task_id: proposal.proposed_task_id,
			proposal,
			admission: { status: "blocked", checks: decision.checks, reserved_budget: null },
		}),
	];
	const projection = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: manifest.tasks,
		events,
		manifest,
	});
	assert.equal(
		projection.tasks.some((t) => t.task_id === proposal.proposed_task_id),
		false,
	);
	const staticWall = manifest.tasks.reduce((sum, t) => sum + (t.task_budget?.wall_time_ms ?? 0), 0);
	assert.equal(projection.budget.reserved.wall_time_ms, staticWall, "no dynamic reservation is added");
});

test("ADM-04: replaying the same proposal_id is applied once", () => {
	const { manifest, proposal, decision } = makeProposalAndDecision();
	const submitted = ev(0, "campaign.proposal.submitted", { proposal_id: "p1", proposal, proposal_digest: "sha256:p1" });
	const admitted = ev(1, "campaign.proposal.admitted", {
		proposal_id: "p1",
		proposal_digest: "sha256:p1",
		task_id: proposal.proposed_task_id,
		admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
	});
	const replay = { ...admitted, event_id: "e2", sequence: 2, event_digest: "sha256:e2" };
	const projection = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: manifest.tasks,
		events: [submitted, admitted, replay],
		manifest,
	});
	const staticWall = manifest.tasks.reduce((sum, t) => sum + (t.task_budget?.wall_time_ms ?? 0), 0);
	assert.equal(projection.budget.reserved.wall_time_ms, staticWall + 1000, "no double reservation");
});

test("ADM-05: an out-of-envelope proposal is blocked by policy before admission", () => {
	const { manifest, proposal } = makeProposalAndDecision();
	const decision = admitTaskProposal({ proposal: { ...proposal, target_ref: "elsewhere/target" }, manifest, depth: 1 });
	assert.equal(decision.status, "blocked");
});

// ---------------------------------------------------------------------------
// C. Queue transitions
// ---------------------------------------------------------------------------

function stateOf(projection, taskId) {
	return projection.tasks.find((t) => t.task_id === taskId)?.state;
}

test("QUE-01: a cancelled task cannot be restarted", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(1, "campaign.task.cancelled", { task_id: TASK_A }),
		ev(2, "campaign.task.started", { task_id: TASK_A }),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.equal(stateOf(projection, TASK_A), "cancelled");
});

test("QUE-02: an unknown task cannot be restarted", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(1, "campaign.task.unknown", { task_id: TASK_A }),
		ev(2, "campaign.task.started", { task_id: TASK_A }),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.equal(stateOf(projection, TASK_A), "unknown");
});

test("QUE-03: a completed task cannot be restarted", () => {
	const task = boundTask(TASK_A);
	const outcome = boundSuccess(task);
	const stage = stageSuccess(task);
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(
			1,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: stage.outcome_id, status: "success", step_id: stage.step_id, outcome: stage },
			{ source: { kind: "oracle" } },
		),
		ev(
			2,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: outcome.outcome_id, status: "success", task_oracle: true, outcome },
			{ source: { kind: "oracle" } },
		),
		ev(3, "campaign.task.completed", { task_id: TASK_A, outcome_id: outcome.outcome_id }),
		ev(4, "campaign.task.started", { task_id: TASK_A }),
	];
	const projection = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: [task],
		events,
		artifacts: artifactsFor(task),
	});
	assert.equal(stateOf(projection, TASK_A), "completed");
});

test("QUE-04: resume is refused from a non-paused state (no unconditional ready)", () => {
	// B is `queued` (dependency unsatisfied) and was never paused: a resume event
	// must not promote it to `ready`, and the refusal must be audited.
	const events = [ev(0, "campaign.task.resumed", { task_id: TASK_B })];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.notEqual(stateOf(projection, TASK_B), "ready");
	assert.equal(stateOf(projection, TASK_B), "queued");
	assert.ok(
		projection.rejected.some((r) => /only a paused task can resume/.test(r.reason)),
		"the resume refusal must be audited",
	);
});

test("QUE-04b: a resume cannot promote a dependency-blocked task", () => {
	// A is `unknown` (NOT completed), so B's dependency is unsatisfied. A resume
	// event for B must not promote it to `ready`.
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(1, "campaign.task.unknown", { task_id: TASK_A }),
		ev(2, "campaign.task.resumed", { task_id: TASK_B }),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.notEqual(stateOf(projection, TASK_B), "ready");
});

test("QUE-05: resume with satisfied dependency and budget becomes ready", () => {
	const taskA = boundTask(TASK_A);
	const taskB = boundTask(TASK_B, [TASK_A]);
	const outcome = boundSuccess(taskA);
	const stage = stageSuccess(taskA);
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(
			1,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: stage.outcome_id, status: "success", step_id: stage.step_id, outcome: stage },
			{ source: { kind: "oracle" } },
		),
		ev(
			2,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: outcome.outcome_id, status: "success", task_oracle: true, outcome },
			{ source: { kind: "oracle" } },
		),
		ev(3, "campaign.task.completed", { task_id: TASK_A, outcome_id: outcome.outcome_id }),
		ev(4, "campaign.task.started", { task_id: TASK_B }),
		ev(5, "campaign.task.paused", { task_id: TASK_B }),
		ev(6, "campaign.task.resumed", { task_id: TASK_B }),
	];
	const projection = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: [taskA, taskB],
		events,
		artifacts: { ...artifactsFor(taskA), ...artifactsFor(taskB) },
	});
	assert.equal(stateOf(projection, TASK_B), "ready");
});

test("QUE-06: starting a queued task with unsatisfied dependencies is refused", () => {
	const events = [ev(0, "campaign.task.started", { task_id: TASK_B })];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.notEqual(stateOf(projection, TASK_B), "running");
});

test("QUE-09: an illegal ready->completed transition is refused", () => {
	const events = [ev(0, "campaign.task.completed", { task_id: TASK_A, outcome_id: null })];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.notEqual(stateOf(projection, TASK_A), "completed");
});

test("QUE-08: at most one task runs at a time", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(1, "campaign.task.started", { task_id: TASK_B }),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.equal(projection.tasks.filter((t) => t.state === "running").length, 1);
});

// ---------------------------------------------------------------------------
// D. Budget ledger
// ---------------------------------------------------------------------------

test("BUD-11: consumed exceeding its reservation is rejected/clamped with an audit", () => {
	const events = [
		ev(0, "campaign.budget.reserved", {
			task_id: TASK_A,
			reservation: { wall_time_ms: 100, model_requests: 1, tool_calls: 1 },
		}),
		ev(1, "campaign.budget.consumed", {
			task_id: TASK_A,
			consumed: { wall_time_ms: 9999, model_requests: 99, tool_calls: 99 },
		}),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.ok(projection.budget.consumed.wall_time_ms <= projection.budget.reserved.wall_time_ms + 100);
	assert.ok(
		projection.rejected.some((r) => /consumed|reservation/i.test(r.reason)),
		"an over-consumption is audited",
	);
});

test("BUD-12: static and dynamic allocations share one ledger", () => {
	const { manifest, proposal, decision } = makeProposalAndDecision();
	const events = [
		ev(0, "campaign.proposal.submitted", { proposal_id: "p1", proposal, proposal_digest: "sha256:p1" }),
		ev(1, "campaign.proposal.admitted", {
			proposal_id: "p1",
			proposal_digest: "sha256:p1",
			task_id: proposal.proposed_task_id,
			admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
		}),
	];
	const projection = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: manifest.tasks,
		events,
		manifest,
	});
	// The fixture's two static tasks allocate 120000 ms each + 20 requests + 40
	// tools, plus the 1000 ms dynamic reservation: one ledger holds both.
	const staticWall = manifest.tasks.reduce((sum, t) => sum + (t.task_budget?.wall_time_ms ?? 0), 0);
	assert.equal(projection.budget.reserved.wall_time_ms, staticWall + 1000);
});

test("BUD-13: cancel/release clamp at zero and never double-release", () => {
	const events = [
		ev(0, "campaign.budget.reserved", {
			task_id: TASK_A,
			reservation: { wall_time_ms: 100, model_requests: 1, tool_calls: 1 },
		}),
		ev(1, "campaign.budget.released", {
			task_id: TASK_A,
			released: { wall_time_ms: 9999, model_requests: 9, tool_calls: 9 },
		}),
		ev(2, "campaign.budget.released", {
			task_id: TASK_A,
			released: { wall_time_ms: 100, model_requests: 1, tool_calls: 1 },
		}),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.equal(projection.budget.reserved.wall_time_ms, 0);
	assert.equal(projection.budget.released.wall_time_ms, 100, "released amount is clamped to what was held");
});

test("BUD-15: a duplicate consumed command does not double-charge", () => {
	const events = [
		ev(0, "campaign.budget.reserved", {
			task_id: TASK_A,
			reservation: { wall_time_ms: 100, model_requests: 1, tool_calls: 1 },
		}),
		ev(1, "campaign.budget.consumed", {
			command_id: "c1",
			task_id: TASK_A,
			consumed: { wall_time_ms: 40, model_requests: 1, tool_calls: 1 },
		}),
		ev(2, "campaign.budget.consumed", {
			command_id: "c1",
			task_id: TASK_A,
			consumed: { wall_time_ms: 40, model_requests: 1, tool_calls: 1 },
		}),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.equal(projection.budget.consumed.wall_time_ms, 40);
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 closure: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 closure: all assertions passed");
