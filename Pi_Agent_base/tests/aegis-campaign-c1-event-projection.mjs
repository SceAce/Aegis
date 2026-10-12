#!/usr/bin/env node
// Aegis Campaign C1-A event contract + C1-B projection/budget tests.
//
// TEST-FIRST: expectations are derived from docs/CAMPAIGN_ARCHITECTURE.md §3.2,
// docs/DS_MASTER_PROMPT.md C1-A/C1-B and docs/CAMPAIGN_TEST_MATRIX.md, NOT from
// the implementation's return values. Events are synthetic but structurally
// complete; every event names its trusted `source.kind`.
//
// Offline by construction: no network, no model, no real Pi Session.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-event-projection.mjs

import assert from "node:assert/strict";

import {
	admitTaskProposal,
	buildFixtureCampaign,
	CAMPAIGN_EVENT_KINDS,
	projectQueueFromEvents,
	validateCampaignEvent,
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

const CAMPAIGN = "campaign-c1";
const TASK_A = "task-a";
const TASK_B = "task-b";
const EP = "ep-1";

/** Build a committed `runtime.note` campaign event envelope. */
function ev(sequence, kind, payload, overrides = {}) {
	return {
		schema_version: "1.1",
		event_type: "runtime.note",
		event_id: `e${sequence}`,
		episode_id: overrides.episode_id ?? EP,
		sequence: overrides.sequence ?? sequence,
		source: overrides.source ?? { kind: "runtime", actor_id: "host", adapter: "aegis-runtime", version: "0.1.0" },
		payload: { kind, campaign_id: CAMPAIGN, ...payload },
		...(overrides.evidence_refs ? { evidence_refs: overrides.evidence_refs } : {}),
	};
}

function staticAllocation(manifest) {
	return (manifest.tasks ?? []).reduce(
		(acc, t) => {
			acc.wall_time_ms += t.task_budget?.wall_time_ms ?? 0;
			acc.model_requests += t.task_budget?.model_requests ?? 0;
			acc.tool_calls += t.task_budget?.tool_calls ?? 0;
			return acc;
		},
		{ wall_time_ms: 0, model_requests: 0, tool_calls: 0 },
	);
}

// A valid admitted event built from the real dynamic policy, so the projection
// can re-validate the proposal against the Manifest.
function makeAdmission(taskId) {
	const fixture = buildFixtureCampaign();
	const manifest = fixture.manifest;
	const proposal = {
		proposed_task_id: taskId,
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
	const submittedEvent = ev(
		0,
		"campaign.proposal.submitted",
		{ proposal_id: "p-1", proposal, proposal_digest: "sha256:p-1" },
		{ event_digest: "sha256:e0" },
	);
	const admittedEvent = ev(
		1,
		"campaign.proposal.admitted",
		{
			proposal_id: "p-1",
			proposal_digest: "sha256:p-1",
			task_id: taskId,
			parent_task_id: proposal.parent_task_id,
			admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
		},
		{ event_digest: "sha256:e1" },
	);
	return { manifest, proposal, decision, submittedEvent, admittedEvent };
}

const TASK_SCOPE = { environment: "fixture-env" };

const staticTasks = [
	{
		task_id: TASK_A,
		order: 1,
		depends_on: [],
		goal: { goal_id: "goal-a", description: "a", success_criteria: ["c-a"] },
		stages: [{ stage_id: "stage-a", criteria: ["c-a"], required: true }],
		scope: TASK_SCOPE,
	},
	{
		task_id: TASK_B,
		order: 2,
		depends_on: [TASK_A],
		goal: { goal_id: "goal-b", description: "b", success_criteria: ["c-b"] },
		stages: [{ stage_id: "stage-b", criteria: ["c-b"], required: true }],
		scope: TASK_SCOPE,
	},
];

/** A fully bound trusted success Outcome for TASK_A (episode EP). */
function boundSuccessA(overrides = {}) {
	return {
		outcome_id: "o-a",
		level: "episode",
		status: "success",
		episode_id: EP,
		task_id: TASK_A,
		task_oracle: true,
		criterion: { criterion_id: "goal-a", expected: "goal-a" },
		observed: { synthetic: true },
		scope: { ...TASK_SCOPE },
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: TASK_A },
		evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:task-a" }],
		...overrides,
	};
}
const ARTIFACTS = { "artifact:task-a": { ref_id: "artifact:task-a", digest: "sha256:synthetic-a" } };

/** A bound stage-level success Outcome for stage-a (required by task-a). */
function stageSuccessA(overrides = {}) {
	return {
		outcome_id: "so-a",
		level: "step",
		step_id: "stage-a",
		status: "success",
		episode_id: EP,
		task_id: TASK_A,
		criterion: { criterion_id: "c-a", expected: "c-a" },
		observed: { synthetic: true },
		scope: { ...TASK_SCOPE },
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: TASK_A, stage_id: "stage-a" },
		evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:task-a" }],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// C1-A: event contract
// ---------------------------------------------------------------------------

test("EVT-01: the campaign event kind vocabulary is frozen and registered", () => {
	for (const kind of [
		"campaign.task.started",
		"campaign.task.completed",
		"campaign.task.unknown",
		"campaign.task.paused",
		"campaign.task.resumed",
		"campaign.task.cancelled",
		"campaign.proposal.admitted",
		"campaign.proposal.blocked",
		"campaign.proposal.rejected",
		"campaign.budget.reserved",
		"campaign.budget.consumed",
		"campaign.budget.released",
		"campaign.oracle.result",
		"campaign.campaign.stopped",
		"campaign.handoff.requested",
		"campaign.handoff.completed",
	]) {
		assert.ok(CAMPAIGN_EVENT_KINDS.includes(kind), `${kind} must be a frozen campaign kind`);
	}
	// No bare `note` and no un-namespaced kind.
	assert.ok(!CAMPAIGN_EVENT_KINDS.includes("note"));
	assert.ok(CAMPAIGN_EVENT_KINDS.every((k) => k.startsWith("campaign.")));
});

test("EVT-01: a well-formed trusted campaign event validates", () => {
	const result = validateCampaignEvent(
		ev(0, "campaign.task.started", { task_id: TASK_A, episode_id: EP, expected_revision: 0 }),
	);
	assert.equal(result.ok, true, result.reasons.join("; "));
});

test("EVT-01: an unknown campaign.* kind is refused", () => {
	const result = validateCampaignEvent(ev(0, "campaign.made.up", { task_id: TASK_A }));
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /kind/.test(r)));
});

test("EVT-01: a bare note event is refused (no top-level note event)", () => {
	const bad = ev(0, "campaign.task.started", {});
	bad.payload.kind = "note";
	const result = validateCampaignEvent(bad);
	assert.equal(result.ok, false);
});

test("EVT-01: an llm-sourced event cannot drive a state transition", () => {
	const result = validateCampaignEvent(
		ev(0, "campaign.task.completed", { task_id: TASK_A }, { source: { kind: "llm", actor_id: "model" } }),
	);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /source|llm|trust/i.test(r)));
});

test("EVT-01: an event for a FOREIGN campaign is refused by the projection", () => {
	const events = [ev(0, "campaign.task.started", { task_id: TASK_A })];
	const foreign = { ...events[0], payload: { ...events[0].payload, campaign_id: "campaign-other" } };
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events: [foreign] });
	assert.equal(projection.ok, false);
	assert.ok(projection.reasons.some((r) => /campaign/i.test(r)));
});

// ---------------------------------------------------------------------------
// C1-B: projection
// ---------------------------------------------------------------------------

test("PRJ-01: a task with no dependency is ready; a dependent task stays queued", () => {
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events: [] });
	assert.equal(projection.ok, true, projection.reasons.join("; "));
	const byId = new Map(projection.tasks.map((t) => [t.task_id, t]));
	assert.equal(byId.get(TASK_A).state, "ready");
	assert.equal(byId.get(TASK_B).state, "queued");
	assert.equal(byId.get(TASK_B).dependency_status[TASK_A], "pending");
});

test("PRJ-01: a dependent task becomes ready only after a TRUSTED dependency completion", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A, episode_id: EP }),
		ev(
			1,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: "so-a", status: "success", step_id: "stage-a", outcome: stageSuccessA() },
			{ source: { kind: "oracle" } },
		),
		ev(
			2,
			"campaign.oracle.result",
			{ task_id: TASK_A, outcome_id: "o-a", status: "success", task_oracle: true, outcome: boundSuccessA() },
			{ source: { kind: "oracle" } },
		),
		ev(3, "campaign.task.completed", { task_id: TASK_A, outcome_id: "o-a" }),
	];
	const projection = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: staticTasks,
		events,
		artifacts: ARTIFACTS,
	});
	assert.equal(projection.ok, true, projection.reasons.join("; "));
	const byId = new Map(projection.tasks.map((t) => [t.task_id, t]));
	assert.equal(byId.get(TASK_A).state, "completed");
	assert.equal(byId.get(TASK_B).state, "ready", "dependent task must be promoted only by a trusted completion");
	assert.equal(byId.get(TASK_B).dependency_status[TASK_A], "satisfied");
});

test("PRJ-01: a dependency marked complete WITHOUT a trusted outcome does not satisfy", () => {
	// A `completed` event with no preceding trusted success outcome must NOT be
	// enough: a scheduler label is not a result.
	const events = [ev(0, "campaign.task.completed", { task_id: TASK_A, outcome_id: null })];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	const byId = new Map(projection.tasks.map((t) => [t.task_id, t]));
	assert.notEqual(byId.get(TASK_B).state, "ready");
	assert.notEqual(byId.get(TASK_B).dependency_status[TASK_A], "satisfied");
});

test("PRJ-01: at most ONE task is running at a time (single active Task)", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(1, "campaign.task.started", { task_id: TASK_B }),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	const running = projection.tasks.filter((t) => t.state === "running");
	assert.equal(running.length, 1, "only one task may be running");
});

test("PRJ-01: a task cannot become running while another is running", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(1, "campaign.task.started", { task_id: TASK_B }),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	const byId = new Map(projection.tasks.map((t) => [t.task_id, t]));
	assert.equal(byId.get(TASK_A).state, "running");
	assert.notEqual(byId.get(TASK_B).state, "running");
});

test("PRJ-02: replaying the same events is idempotent", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(1, "campaign.task.completed", { task_id: TASK_A }),
	];
	const first = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	const second = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.deepEqual(first.tasks, second.tasks);
});

test("EVT-02: a duplicate command_id is applied only once", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A, command_id: "cmd-1" }),
		ev(1, "campaign.task.started", { task_id: TASK_A, command_id: "cmd-1" }),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	const byId = new Map(projection.tasks.map((t) => [t.task_id, t]));
	assert.equal(byId.get(TASK_A).state, "running");
	assert.equal(byId.get(TASK_A).applied_command_ids.length, 1, "duplicate command applied once");
});

test("EVT-02: an event whose expected_revision does not match is refused", () => {
	const events = [ev(0, "campaign.task.started", { task_id: TASK_A, expected_revision: 7 })];
	const projection = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: staticTasks,
		events,
		revision: 0,
	});
	const byId = new Map(projection.tasks.map((t) => [t.task_id, t]));
	assert.notEqual(byId.get(TASK_A).state, "running");
	assert.ok(projection.rejected.some((r) => /revision/.test(r.reason)));
});

// ---------------------------------------------------------------------------
// C1-B: budget ledger
// ---------------------------------------------------------------------------

test("BUD-01: an admitted proposal reserves budget exactly once", () => {
	const { manifest, submittedEvent, admittedEvent } = makeAdmission("task-dyn-1");
	const staticB = staticAllocation(manifest);
	const projection = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: manifest.tasks,
		events: [submittedEvent, admittedEvent],
		manifest,
	});
	assert.equal(projection.ok, true, projection.reasons.join("; "));
	assert.equal(projection.budget.reserved.wall_time_ms, staticB.wall_time_ms + 1000);
	assert.equal(projection.budget.reserved.model_requests, staticB.model_requests + 1);
	assert.equal(projection.budget.reserved.tool_calls, staticB.tool_calls + 2);
	assert.equal(projection.budget.consumed.wall_time_ms, 0);
});

test("BUD-01: a duplicate admitted proposal does not double-reserve", () => {
	const { manifest, submittedEvent, admittedEvent } = makeAdmission("task-dyn-1");
	const replay = { ...admittedEvent, event_id: "e2", sequence: 2, event_digest: "sha256:e2" };
	const projection = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: manifest.tasks,
		events: [submittedEvent, admittedEvent, replay],
		manifest,
	});
	assert.equal(
		projection.budget.reserved.wall_time_ms,
		staticAllocation(manifest).wall_time_ms + 1000,
		"no double reservation",
	);
});

test("BUD-01: consumption moves from reserved to consumed without double-charging", () => {
	const { manifest, submittedEvent, admittedEvent } = makeAdmission("task-dyn-1");
	const events = [
		submittedEvent,
		admittedEvent,
		ev(2, "campaign.budget.consumed", {
			task_id: "task-dyn-1",
			consumed: { wall_time_ms: 400, model_requests: 1, tool_calls: 2 },
		}),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: manifest.tasks, events, manifest });
	// consumed is charged once; the matching reservation is reduced by the same
	// amount so the two are never both held for the same spend.
	assert.equal(projection.budget.consumed.wall_time_ms, 400);
	assert.equal(projection.budget.consumed.model_requests, 1);
	assert.equal(projection.budget.consumed.tool_calls, 2);
	assert.equal(
		projection.budget.reserved.wall_time_ms,
		staticAllocation(manifest).wall_time_ms + 600,
		"remaining reservation after consumption",
	);
});

test("BUD-01: cancelling a task releases its outstanding reservation", () => {
	const { manifest, submittedEvent, admittedEvent } = makeAdmission("task-dyn-1");
	const events = [submittedEvent, admittedEvent, ev(2, "campaign.task.cancelled", { task_id: "task-dyn-1" })];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: manifest.tasks, events, manifest });
	assert.equal(
		projection.budget.reserved.wall_time_ms,
		staticAllocation(manifest).wall_time_ms,
		"cancel releases the dynamic reservation",
	);
});

test("BUD-01: a release event clamps at zero and never creates negative budget", () => {
	const { manifest, submittedEvent, admittedEvent } = makeAdmission("task-dyn-1");
	const events = [
		submittedEvent,
		admittedEvent,
		ev(2, "campaign.budget.released", {
			task_id: "task-dyn-1",
			released: { wall_time_ms: 9999, model_requests: 99, tool_calls: 99 },
		}),
	];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: manifest.tasks, events, manifest });
	assert.equal(projection.budget.reserved.wall_time_ms, staticAllocation(manifest).wall_time_ms);
	assert.equal(projection.budget.reserved.model_requests, staticAllocation(manifest).model_requests);
});

test("PRJ-01: an unknown oracle result leaves the task unknown, never failed", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: TASK_A }),
		ev(
			1,
			"campaign.oracle.result",
			{
				task_id: TASK_A,
				outcome_id: "o-a",
				status: "unknown",
				task_oracle: true,
				outcome: boundSuccessA({ status: "unknown", observed: null, evidence_refs: [] }),
			},
			{ source: { kind: "oracle" } },
		),
	];
	const projection = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: staticTasks,
		events,
		artifacts: ARTIFACTS,
	});
	const byId = new Map(projection.tasks.map((t) => [t.task_id, t]));
	assert.equal(byId.get(TASK_A).state, "unknown");
	assert.notEqual(byId.get(TASK_A).state, "failed");
});

test("BUD-01: static task allocations enter the SAME ledger as dynamic reservations", () => {
	const { manifest, submittedEvent, admittedEvent } = makeAdmission("task-dyn-1");
	const staticWall = manifest.tasks.reduce((sum, t) => sum + (t.task_budget?.wall_time_ms ?? 0), 0);
	const projection = projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: manifest.tasks,
		events: [submittedEvent, admittedEvent],
		manifest,
	});
	assert.equal(projection.budget.reserved.wall_time_ms, staticWall + 1000, "static + dynamic share one ledger");
});

test("PRJ-02: the projection reports scheduler health counters", () => {
	const events = [ev(0, "campaign.task.started", { task_id: TASK_A })];
	const projection = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: staticTasks, events });
	assert.equal(typeof projection.health.events_applied, "number");
	assert.equal(typeof projection.health.events_rejected, "number");
	assert.ok("last_applied_event_id" in projection.health);
	assert.ok("last_applied_offset" in projection.health);
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 event/projection: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 event/projection: all assertions passed");
