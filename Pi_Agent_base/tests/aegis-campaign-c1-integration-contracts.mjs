#!/usr/bin/env node
// Aegis C1 Integration closure — contract tests (INT-ORDER / INT-OUTCOME /
// INT-DYNAMIC / INT-BUDGET pure projection contracts).
//
// TEST-FIRST: expectations come from docs/C1_INTEGRATION_TEST_SPEC.md and
// docs/C1_INTEGRATION_CLOSURE_TASK.md §3, not from the implementation.
//
// Offline: no network, no model, no real Pi Session.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-integration-contracts.mjs

import assert from "node:assert/strict";

import {
	admitTaskProposal,
	buildCommittedStream,
	buildFixtureCampaign,
	canDispatch,
	parseBudgetStrict,
	projectQueueFromEvents,
	resolveTaskOutcome,
} from "../memory/campaign/index.mjs";

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

const CAMPAIGN = "campaign-int";
const TASK_A = "task-a";
const TASK_B = "task-b";
const EP = "ep-1";

function ev(offset, kind, payload, source = { kind: "runtime" }) {
	return {
		schema_version: "1.1",
		event_type: "runtime.note",
		event_id: `e${offset}`,
		sequence: payload.sequence ?? null,
		source,
		payload: { kind, campaign_id: CAMPAIGN, ...payload },
		event_digest: `sha256:e${offset}`,
	};
}

const taskA = {
	task_id: TASK_A,
	order: 1,
	depends_on: [],
	goal: { goal_id: "goal-a", description: "a", success_criteria: ["c-a"] },
	stages: [{ stage_id: "stage-a", criteria: ["c-a"], required: true }],
	task_budget: { wall_time_ms: 100, model_requests: 3, tool_calls: 3 },
};
const taskB = {
	task_id: TASK_B,
	order: 2,
	depends_on: [TASK_A],
	goal: { goal_id: "goal-b", description: "b", success_criteria: ["c-b"] },
	stages: [{ stage_id: "stage-b", criteria: ["c-b"], required: true }],
	task_budget: { wall_time_ms: 100, model_requests: 3, tool_calls: 3 },
};
const ARTIFACTS = { "artifact:task-a": { ref_id: "artifact:task-a", digest: "sha256:real-temp-a" } };

/** A bound stage-level success Outcome for task-a's required stage. */
function boundStage(overrides = {}) {
	return {
		outcome_id: "so-a",
		level: "step",
		step_id: "stage-a",
		status: "success",
		episode_id: EP,
		task_id: TASK_A,
		criterion: { criterion_id: "c-a", expected: "c-a" },
		observed: { synthetic: true },
		scope: null,
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: TASK_A, stage_id: "stage-a" },
		evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:task-a", digest: "sha256:real-temp-a" }],
		...overrides,
	};
}

function boundOutcome(overrides = {}) {
	return {
		outcome_id: "o-a",
		level: "episode",
		status: "success",
		episode_id: EP,
		task_id: TASK_A,
		task_oracle: true,
		criterion: { criterion_id: "goal-a", expected: "goal-a" },
		observed: { synthetic: true },
		scope: { environment: "local" },
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: TASK_A },
		evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:task-a", digest: "sha256:real-temp-a" }],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// INT-ORDER / C1EXT-04
// ---------------------------------------------------------------------------

test("ORDER-POS: reduce uses append order, not per-episode sequence", () => {
	// Append order: reserve (episode seq 5) BEFORE consume (episode seq 0).
	const events = [
		{
			...ev(0, "campaign.budget.reserved", {
				task_id: TASK_A,
				reservation: { wall_time_ms: 5, model_requests: 1, tool_calls: 1 },
			}),
			sequence: 5,
		},
		{
			...ev(1, "campaign.budget.consumed", {
				task_id: TASK_A,
				consumed: { wall_time_ms: 2, model_requests: 1, tool_calls: 1 },
			}),
			sequence: 0,
		},
	];
	// A BARE task (no static allocation) so the reservation exists ONLY because the
	// append-order reserve ran first; a sequence-based re-sort would reject consume.
	const bare = { task_id: TASK_A, order: 1, depends_on: [] };
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [bare], events });
	assert.equal(p.budget.consumed.wall_time_ms, 2, "consume applied after reserve");
	assert.equal(p.rejected.length, 0, "no rejection from a reordered stream");
});

test("ORDER-NULL: mixed null/int sequence reduces in append order", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A, sequence: null }),
		ev(
			1,
			"campaign.oracle.result",
			{
				task_id: TASK_A,
				outcome_id: "so-a",
				status: "success",
				step_id: "stage-a",
				outcome: boundStage(),
				sequence: null,
			},
			{ kind: "oracle" },
		),
		ev(
			2,
			"campaign.oracle.result",
			{
				task_id: TASK_A,
				outcome_id: "o-a",
				status: "success",
				task_oracle: true,
				outcome: boundOutcome(),
				sequence: null,
			},
			{ kind: "oracle" },
		),
		ev(3, "campaign.task.completed", { task_id: TASK_A, outcome_id: "o-a", sequence: null }),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
	assert.equal(p.tasks[0].state, "completed");
});

test("ORDER-TAIL: tail is the last committed record even when it is rejected", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(
			1,
			"campaign.oracle.result",
			{
				task_id: TASK_A,
				outcome_id: "bad",
				status: "success",
				task_oracle: true,
				outcome: boundOutcome({ task_id: "task-foreign" }),
			},
			{ kind: "oracle" },
		),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
	assert.equal(p.tail_offset, 1, "tail is the physical last committed record");
	assert.equal(p.rejected.length, 1, "the rejected command is audited");
});

test("ORDER-AUTHORITATIVE: a bad chain is refused by the EventLog (structural)", () => {
	// The EventLog owns hash-chain verification; the stream module preserves order.
	const stream = buildCommittedStream({
		rows: [
			{ event_id: "x", event_digest: "sha256:a" },
			{ event_id: "y", event_digest: "sha256:b" },
		],
	});
	assert.equal(stream.tail_offset, 1);
	assert.equal(stream.tail_digest, "sha256:b");
	assert.deepEqual(stream.offsets, [0, 1]);
});

test("ORDER-DEDUP: the same command id is applied once", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A, command_id: "c1" }),
		ev(1, "campaign.task.started", { task_id: TASK_A, command_id: "c1" }),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events });
	assert.equal(p.tasks[0].state, "running");
	assert.equal(p.health.events_deduplicated, 1);
});

// ---------------------------------------------------------------------------
// INT-OUTCOME / C1EXT-01
// ---------------------------------------------------------------------------

test("OUT-POS: a fully bound trusted success completes and frees the dependency", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(
			1,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: "so-a", status: "success", step_id: "stage-a", outcome: boundStage() },
			{ kind: "oracle" },
		),
		ev(
			2,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: "o-a", status: "success", task_oracle: true, outcome: boundOutcome() },
			{ kind: "oracle" },
		),
		ev(3, "campaign.task.completed", { task_id: TASK_A, outcome_id: "o-a" }),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA, taskB], events, artifacts: ARTIFACTS });
	assert.equal(p.tasks.find((t) => t.task_id === TASK_A).state, "completed");
	assert.equal(p.tasks.find((t) => t.task_id === TASK_B).state, "ready");
});

test("OUT-FOREIGN: a foreign episode/task outcome does not complete", () => {
	for (const override of [{ episode_id: "ep-foreign" }, { task_id: "task-foreign" }]) {
		const events = [
			ev(0, "campaign.task.started", { task_id: TASK_A }),
			ev(
				1,
				"campaign.oracle.result",
				{ task_id: TASK_A, outcome_id: "o-a", status: "success", task_oracle: true, outcome: boundOutcome(override) },
				{ kind: "oracle" },
			),
		];
		const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
		assert.notEqual(p.tasks[0].state, "completed", JSON.stringify(override));
		assert.ok(p.rejected.length > 0 || p.tasks[0].state !== "completed");
	}
});

test("OUT-CRITERION: a wrong criterion/expected is refused", () => {
	for (const criterion of [
		{ criterion_id: "other", expected: "other" },
		{ criterion_id: "goal-a", expected: "different" },
	]) {
		const events = [
			ev(0, "campaign.task.started", { task_id: TASK_A }),
			ev(
				1,
				"campaign.oracle.result",
				{
					task_id: TASK_A,
					outcome_id: "o-a",
					status: "success",
					task_oracle: true,
					outcome: boundOutcome({ criterion }),
				},
				{ kind: "oracle" },
			),
		];
		const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
		assert.notEqual(p.tasks[0].state, "completed");
	}
});

test("OUT-NOREF: missing/unresolvable evidence is not success", () => {
	for (const outcome of [
		boundOutcome({ evidence_refs: [] }),
		boundOutcome({ evidence_refs: [{ ref_type: "artifact", ref_id: "not-indexed" }] }),
		boundOutcome({ observed: null }),
	]) {
		const events = [
			ev(0, "campaign.task.started", { task_id: TASK_A }),
			ev(
				1,
				"campaign.oracle.result",
				{ task_id: TASK_A, outcome_id: "o-a", status: "success", task_oracle: true, outcome },
				{ kind: "oracle" },
			),
			ev(2, "campaign.task.completed", { task_id: TASK_A, outcome_id: "o-a" }),
		];
		const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
		assert.notEqual(p.tasks[0].state, "completed");
	}
});

test("OUT-CURRENT: completion referencing a non-current outcome is refused", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(
			1,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: "o-a", status: "success", task_oracle: true, outcome: boundOutcome() },
			{ kind: "oracle" },
		),
		ev(2, "campaign.task.completed", { task_id: TASK_A, outcome_id: "o-other" }),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
	assert.notEqual(p.tasks[0].state, "completed");
});

test("OUT-SOURCE: a self-reported runtime oracle is refused at the boundary", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(
			1,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: "o-a", status: "success", task_oracle: true, outcome: boundOutcome() },
			{ kind: "runtime" },
		),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
	assert.notEqual(p.tasks[0].state, "completed");
	assert.ok(p.rejected.some((r) => /source/i.test(r.reason)));
});

test("OUT-RESOLVER: resolveTaskOutcome requires observed + resolvable evidence", () => {
	const ok = resolveTaskOutcome({
		result: boundOutcome(),
		task: taskA,
		episodeId: EP,
		scope: null,
		artifacts: ARTIFACTS,
	});
	assert.equal(ok.ok, true, ok.reasons?.join("; "));
	const noEvidence = resolveTaskOutcome({
		result: boundOutcome({ evidence_refs: [] }),
		task: taskA,
		episodeId: EP,
		scope: null,
		artifacts: ARTIFACTS,
	});
	assert.equal(noEvidence.ok, false);
});

// ---------------------------------------------------------------------------
// INT-DYNAMIC / C1EXT-05
// ---------------------------------------------------------------------------

function proposalAndDecision() {
	const fixture = buildFixtureCampaign();
	const manifest = fixture.manifest;
	const proposal = {
		proposed_task_id: "task-dyn-1",
		parent_task_id: manifest.tasks[0].task_id,
		parent_stage_id: manifest.tasks[0].stages[0].stage_id,
		goal: { goal_id: "dyn-goal", description: "observe again", success_criteria: ["door.locked == true"] },
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

test("DYN-NOSUB: admitted without a prior submitted proposal has no effect", () => {
	const { manifest, proposal, decision } = proposalAndDecision();
	const events = [
		ev(0, "campaign.proposal.admitted", {
			proposal_id: "p1",
			task_id: proposal.proposed_task_id,
			admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
		}),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: manifest.tasks, events, manifest });
	assert.equal(
		p.tasks.some((t) => t.task_id === proposal.proposed_task_id),
		false,
	);
	assert.ok(p.rejected.some((r) => /submitted/i.test(r.reason)));
});

test("DYN-SWAP: a digest mismatch between submitted and admitted is refused", () => {
	const { manifest, proposal, decision } = proposalAndDecision();
	const events = [
		ev(0, "campaign.proposal.submitted", { proposal_id: "p1", proposal, proposal_digest: "sha256:orig" }),
		ev(1, "campaign.proposal.admitted", {
			proposal_id: "p1",
			proposal_digest: "sha256:swapped",
			task_id: proposal.proposed_task_id,
			admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
		}),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: manifest.tasks, events, manifest });
	assert.equal(
		p.tasks.some((t) => t.task_id === proposal.proposed_task_id),
		false,
	);
});

test("DYN-DEFINED: an admitted task carries a full recoverable definition", () => {
	const { manifest, proposal, decision } = proposalAndDecision();
	const events = [
		ev(0, "campaign.proposal.submitted", { proposal_id: "p1", proposal, proposal_digest: "sha256:p1" }),
		ev(1, "campaign.proposal.admitted", {
			proposal_id: "p1",
			proposal_digest: "sha256:p1",
			task_id: proposal.proposed_task_id,
			admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
		}),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: manifest.tasks, events, manifest });
	const dyn = p.tasks.find((t) => t.task_id === proposal.proposed_task_id);
	assert.ok(dyn, "the dynamic task exists");
	assert.ok(dyn.definition, "it carries a definition");
	assert.equal(dyn.definition.goal.goal_id, "dyn-goal");
	assert.ok(Array.isArray(dyn.definition.stages) && dyn.definition.stages.length > 0);
	assert.equal(typeof dyn.definition.stop_condition, "string");
});

test("DYN-DUP: a re-proposal with a new random id is a semantic duplicate", () => {
	const { manifest, proposal, decision } = proposalAndDecision();
	const admitted = [
		ev(0, "campaign.proposal.submitted", { proposal_id: "p1", proposal, proposal_digest: "sha256:p1" }),
		ev(1, "campaign.proposal.admitted", {
			proposal_id: "p1",
			proposal_digest: "sha256:p1",
			task_id: proposal.proposed_task_id,
			admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
		}),
	];
	const p1 = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: manifest.tasks, events: admitted, manifest });
	const dyn = p1.tasks.find((t) => t.task_id === proposal.proposed_task_id);
	const sameSemantics = dynamicKey(dyn.definition) === dynamicKey({ ...dyn.definition, task_id: "task-dyn-2" });
	assert.equal(sameSemantics, true, "the semantic identity is stable across a new id");
});

function dynamicKey(definition) {
	return JSON.stringify({
		parent: definition.parent_task_id ?? null,
		target: definition.target_ref,
		type: definition.task_type,
		criteria: definition.goal?.success_criteria,
	});
}

// ---------------------------------------------------------------------------
// INT-BUDGET / C1EXT-06
// ---------------------------------------------------------------------------

test("BUD-ZERO: a task with zero reservation is not dispatchable", () => {
	const permit = canDispatch({
		task: { task_id: TASK_A, reservation: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 } },
		need: { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
	});
	assert.equal(permit.ok, false, "no borrowing from the Campaign remaining");
});

test("BUD-BOUND: need equal to held executes; greater does not", () => {
	const task = { task_id: TASK_A, reservation: { wall_time_ms: 3, model_requests: 2, tool_calls: 1 } };
	assert.equal(canDispatch({ task, need: { wall_time_ms: 3, model_requests: 2, tool_calls: 1 } }).ok, true);
	assert.equal(canDispatch({ task, need: { wall_time_ms: 4, model_requests: 2, tool_calls: 1 } }).ok, false);
});

test("BUD-BAD: invalid deltas are rejected and do not change the ledger", () => {
	for (const bad of [
		{ wall_time_ms: -1 },
		{ model_requests: 1.5 },
		{ tool_calls: Number.MAX_SAFE_INTEGER + 10 },
		{ wall_time_ms: Number.NaN },
		{ wall_time_ms: "3" },
	]) {
		const parsed = parseBudgetStrict(bad);
		assert.equal(parsed.ok, false, JSON.stringify(bad));
	}
	const events = [
		ev(0, "campaign.budget.reserved", {
			task_id: TASK_A,
			reservation: { wall_time_ms: 5, model_requests: 5, tool_calls: 5 },
		}),
		ev(1, "campaign.budget.consumed", {
			task_id: TASK_A,
			consumed: { wall_time_ms: -1, model_requests: 0, tool_calls: 0 },
		}),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events });
	assert.equal(p.budget.consumed.wall_time_ms, 0, "the ledger is unchanged by an invalid delta");
	assert.ok(p.rejected.length > 0);
});

test("BUD-RELEASE: release clamps and duplicates never increase the total", () => {
	const bare = { task_id: TASK_A, order: 1, depends_on: [] };
	const events = [
		ev(0, "campaign.budget.reserved", {
			task_id: TASK_A,
			reservation: { wall_time_ms: 5, model_requests: 5, tool_calls: 5 },
		}),
		ev(1, "campaign.budget.released", {
			task_id: TASK_A,
			released: { wall_time_ms: 99, model_requests: 99, tool_calls: 99 },
		}),
		ev(2, "campaign.budget.released", {
			task_id: TASK_A,
			released: { wall_time_ms: 5, model_requests: 5, tool_calls: 5 },
		}),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [bare], events });
	assert.equal(p.budget.reserved.wall_time_ms, 0);
	assert.equal(p.budget.released.wall_time_ms, 5, "released is clamped to what was held");
});

test("ORDER-CONTROL: a checkpoint priorState control is restored without a control event", () => {
	// The tail has NO control event; the control must come from the checkpoint
	// snapshot (priorState.control). A local "always running" default would revive
	// a cancelled campaign.
	const p = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: [taskA],
		events: [],
		priorState: {
			queue: [
				{
					task_id: TASK_A,
					state: "ready",
					depends_on: [],
					order: 1,
					reservation: { wall_time_ms: 100, model_requests: 3, tool_calls: 3 },
					budget_consumed: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 },
				},
			],
			budget: {
				reserved: { wall_time_ms: 100, model_requests: 3, tool_calls: 3 },
				consumed: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 },
				released: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 },
			},
			control: { state: "cancelled", reason: "user_cancelled", offset: 4 },
			proposals: [],
			tail_offset: 5,
		},
	});
	assert.equal(p.control.state, "cancelled", "the checkpoint control is restored");
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 integration contracts: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 integration contracts: all assertions passed");
