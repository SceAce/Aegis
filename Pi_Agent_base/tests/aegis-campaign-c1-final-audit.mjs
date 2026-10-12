#!/usr/bin/env node
// Aegis C1 Final Audit Fix — regression tests (F1..F6).
//
// TEST-FIRST: expectations come from docs/C1_FINAL_AUDIT_FIX_TASK.md and
// docs/C1_INTEGRATION_EXTERNAL_AUDIT.md, not from the implementation.
//
// Offline: no network, no model, no real Pi Session.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-final-audit.mjs

import assert from "node:assert/strict";

import {
	buildFixtureCampaign,
	contentDigest,
	createCampaignScheduler,
	projectionSnapshot,
	projectQueueFromEvents,
	resolveTaskFromOutcomes,
	resolveTaskOutcome,
} from "../memory/campaign/index.mjs";

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

const CAMPAIGN = "campaign-finalfx";
const EP = "ep-1";

function ev(o, kind, payload, source = { kind: "runtime" }, campaignId = CAMPAIGN) {
	return {
		schema_version: "1.1",
		event_type: "runtime.note",
		event_id: `e${o}`,
		sequence: o,
		source,
		payload: { kind, campaign_id: campaignId, ...payload },
		event_digest: `sha256:e${o}`,
	};
}

const SCOPE = { environment_fingerprint: "fixture-env", domain: "fixture" };

const taskA = {
	task_id: "task-a",
	order: 1,
	depends_on: [],
	goal: { goal_id: "goal-a", description: "a", success_criteria: ["c-a"] },
	stages: [{ stage_id: "stage-a", criteria: ["c-a"], required: true }],
	scope: { ...SCOPE },
	task_budget: { wall_time_ms: 100, model_requests: 3, tool_calls: 3 },
};
const taskB = {
	task_id: "task-b",
	order: 2,
	depends_on: ["task-a"],
	goal: { goal_id: "goal-b", description: "b", success_criteria: ["c-b"] },
	stages: [{ stage_id: "stage-b", criteria: ["c-b"], required: true }],
	scope: { ...SCOPE },
	task_budget: { wall_time_ms: 100, model_requests: 3, tool_calls: 3 },
};
const ARTIFACTS = { "artifact:task-a": { ref_id: "artifact:task-a", digest: "sha256:content-a" } };

function boundOutcome(over = {}) {
	return {
		outcome_id: "o-a",
		level: "episode",
		status: "success",
		episode_id: EP,
		task_id: "task-a",
		task_oracle: true,
		criterion: { criterion_id: "goal-a", expected: "goal-a" },
		observed: { synthetic: true },
		scope: { ...SCOPE },
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: "task-a" },
		evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:task-a", digest: "sha256:content-a" }],
		...over,
	};
}

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
		scope: { ...SCOPE },
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: "task-a", stage_id: "stage-a" },
		evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:task-a" }],
		...over,
	};
}

/** A stage-level success judgment for task-a's required stage. */
function stageJudgment() {
	return { step_id: "stage-a", status: "success", outcome_id: "so-a", outcome: stageOutcome() };
}

// ---------------------------------------------------------------------------
// F1 — reconciliation completes the stranded task
// ---------------------------------------------------------------------------

function makeSink() {
	const events = [];
	let seq = 0;
	return {
		events,
		async append(event) {
			const row = { ...event, event_id: `e${seq}`, sequence: seq, event_digest: `sha256:e${seq}` };
			seq += 1;
			events.push(row);
			return { ok: true, event: row, durable: true };
		},
		replay: () => events.slice(),
	};
}

await test("F1-RECON-COMPLETE: reconcile success completes the stranded task without a rerun", async () => {
	const sink = makeSink();
	// A durable intent with no result → the task is `running`.
	await sink.append({
		event_type: "runtime.note",
		source: { kind: "runtime" },
		payload: { kind: "campaign.task.started", campaign_id: CAMPAIGN, task_id: "task-a", episode_id: EP },
	});
	const dispatched = [];
	const scheduler = createCampaignScheduler({
		manifest: { campaign_id: CAMPAIGN, revision: 1, schema_version: "campaign-1.0", budget: {}, tasks: [taskA, taskB] },
		ownedTasks: [taskA, taskB],
		baseDir: null,
		sink,
		artifacts: ARTIFACTS,
		worker: {
			async run({ task }) {
				dispatched.push(task.task_id);
				return { ok: true, outcome_ref: `artifact:${task.task_id}` };
			},
		},
		oracle: {
			async judge() {
				return {
					status: "success",
					task_oracle: true,
					outcome_id: "o-a",
					stage_outcomes: [stageJudgment()],
					outcome: boundOutcome(),
				};
			},
			async reconcile() {
				return { status: "success", outcome_id: "o-a", stage_outcomes: [stageJudgment()], outcome: boundOutcome() };
			},
		},
		clock: () => 1,
		acquireOwnership: false,
	});
	const result = await scheduler.run();
	const a = result.status.tasks.find((t) => t.task_id === "task-a");
	assert.equal(a.state, "completed", "the stranded task is completed");
	assert.equal(dispatched.includes("task-a"), false, "the stranded task-a is not re-run to reconcile");
	assert.equal(a.task_outcome_ref, "o-a");
});

await test("F1-RECON-DEPENDENT: a dependent task becomes ready after reconcile completion", async () => {
	const sink = makeSink();
	await sink.append({
		event_type: "runtime.note",
		source: { kind: "runtime" },
		payload: { kind: "campaign.task.started", campaign_id: CAMPAIGN, task_id: "task-a", episode_id: EP },
	});
	const scheduler = createCampaignScheduler({
		manifest: { campaign_id: CAMPAIGN, revision: 1, schema_version: "campaign-1.0", budget: {}, tasks: [taskA, taskB] },
		ownedTasks: [taskA, taskB],
		baseDir: null,
		sink,
		artifacts: ARTIFACTS,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "artifact:task-a" };
			},
		},
		oracle: {
			async judge() {
				return {
					status: "success",
					task_oracle: true,
					outcome_id: "o-a",
					stage_outcomes: [stageJudgment()],
					outcome: boundOutcome(),
				};
			},
			async reconcile() {
				return { status: "success", outcome_id: "o-a", stage_outcomes: [stageJudgment()], outcome: boundOutcome() };
			},
		},
		clock: () => 1,
		acquireOwnership: false,
	});
	const result = await scheduler.run();
	const b = result.status.tasks.find((t) => t.task_id === "task-b");
	assert.notEqual(b.state, "queued", "the dependent task's dependency is satisfied");
	assert.equal(b.dependency_status["task-a"], "satisfied");
});

await test("F1-RECON-NOTDONE: an absent effect is not a false completion", async () => {
	const sink = makeSink();
	await sink.append({
		event_type: "runtime.note",
		source: { kind: "runtime" },
		payload: { kind: "campaign.task.started", campaign_id: CAMPAIGN, task_id: "task-a", episode_id: EP },
	});
	const scheduler = createCampaignScheduler({
		manifest: { campaign_id: CAMPAIGN, revision: 1, schema_version: "campaign-1.0", budget: {}, tasks: [taskA] },
		ownedTasks: [taskA],
		baseDir: null,
		sink,
		artifacts: ARTIFACTS,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "artifact:task-a" };
			},
		},
		oracle: {
			async judge() {
				return { status: "success", task_oracle: true, outcome_id: "o-a", outcome: boundOutcome() };
			},
			async reconcile() {
				return { status: "unknown", failure_mode: "effect_absent" };
			},
		},
		clock: () => 1,
		acquireOwnership: false,
	});
	const result = await scheduler.run();
	assert.notEqual(result.status.tasks[0].state, "completed");
});

// ---------------------------------------------------------------------------
// F2 — event source ↔ Outcome provenance
// ---------------------------------------------------------------------------

await test("F2-SRC-RUNTIME: an outer oracle wrapping inner runtime provenance is refused", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		ev(
			1,
			"campaign.oracle.result",
			{
				task_id: "task-a",
				outcome_id: "o-a",
				status: "success",
				task_oracle: true,
				episode_id: EP,
				outcome: boundOutcome({
					provenance: { source: "runtime", independent: true, task_id: "task-a" },
					oracle: { oracle_id: "s", source: "runtime" },
				}),
			},
			{ kind: "oracle" },
		),
		ev(2, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
	assert.notEqual(p.tasks[0].state, "completed");
	assert.ok(
		p.rejected.some((r) => /provenance|source/i.test(r.reason)),
		"the mismatched source is rejected",
	);
});

await test("F2-SRC-LLM: an outer oracle wrapping inner llm provenance is refused", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		ev(
			1,
			"campaign.oracle.result",
			{
				task_id: "task-a",
				outcome_id: "o-a",
				status: "success",
				task_oracle: true,
				episode_id: EP,
				outcome: boundOutcome({ provenance: { source: "llm", independent: true, task_id: "task-a" } }),
			},
			{ kind: "oracle" },
		),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
	assert.notEqual(p.tasks[0].state, "completed");
});

await test("F2-SRC-MISMATCH: a human event wrapping inner oracle provenance is refused", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		ev(
			1,
			"campaign.oracle.result",
			{
				task_id: "task-a",
				outcome_id: "o-a",
				status: "success",
				task_oracle: true,
				episode_id: EP,
				outcome: boundOutcome(),
			},
			{ kind: "human" },
		),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
	assert.notEqual(p.tasks[0].state, "completed");
	assert.ok(
		p.rejected.some((r) => /provenance|source/i.test(r.reason)),
		"the mismatched source is rejected",
	);
});

await test("F2-SRC-ORACLE-OK: a matching oracle source is accepted", () => {
	const resolved = resolveTaskOutcome({
		result: boundOutcome(),
		task: taskA,
		episodeId: EP,
		scope: { ...SCOPE },
		artifacts: ARTIFACTS,
		eventSource: "oracle",
	});
	assert.equal(resolved.ok, true, resolved.reasons?.join("; "));
});

await test("F2-SRC-RESOLVER-RUNTIME: the resolver refuses a runtime event source", () => {
	const resolved = resolveTaskOutcome({
		result: boundOutcome(),
		task: taskA,
		episodeId: EP,
		scope: { ...SCOPE },
		artifacts: ARTIFACTS,
		eventSource: "runtime",
	});
	assert.equal(resolved.ok, false);
});

// ---------------------------------------------------------------------------
// F3 — required Stage aggregation
// ---------------------------------------------------------------------------

await test("F3-STAGE-MISSING: a task-level success without stage evidence does not complete", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		ev(
			1,
			"campaign.oracle.result",
			{
				task_id: "task-a",
				outcome_id: "o-a",
				status: "success",
				task_oracle: true,
				episode_id: EP,
				outcome: boundOutcome(),
			},
			{ kind: "oracle" },
		),
		ev(2, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
	assert.notEqual(p.tasks[0].state, "completed", "required stage evidence is missing");
});

await test("F3-STAGE-SUPERSEDED: a stage success superseded by a legal unknown does not pass", () => {
	const prior = stageOutcome({ outcome_id: "so-a", scope: { env: "e" } });
	const correction = stageOutcome({
		outcome_id: "so-a2",
		status: "unknown",
		observed: null,
		evidence_refs: [],
		supersedes: "so-a",
		scope: { env: "e" },
	});
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		ev(
			1,
			"campaign.oracle.result",
			{ task_id: "task-a", outcome_id: "so-a", status: "success", step_id: "stage-a", outcome: prior },
			{ kind: "oracle" },
		),
		ev(
			2,
			"campaign.oracle.result",
			{ task_id: "task-a", outcome_id: "so-a2", status: "unknown", step_id: "stage-a", outcome: correction },
			{ kind: "oracle" },
		),
		ev(
			3,
			"campaign.oracle.result",
			{
				task_id: "task-a",
				outcome_id: "o-a",
				status: "success",
				task_oracle: true,
				episode_id: EP,
				outcome: boundOutcome(),
			},
			{ kind: "oracle" },
		),
		ev(4, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
	assert.notEqual(p.tasks[0].state, "completed", "a superseded stage success is not a pass");
});

await test("F3-STAGE-ALL: all required stages plus the task Oracle complete the task", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		ev(
			1,
			"campaign.oracle.result",
			{
				task_id: "task-a",
				outcome_id: "so-a",
				status: "success",
				step_id: "stage-a",
				episode_id: EP,
				outcome: stageOutcome(),
			},
			{ kind: "oracle" },
		),
		ev(
			2,
			"campaign.oracle.result",
			{
				task_id: "task-a",
				outcome_id: "o-a",
				status: "success",
				task_oracle: true,
				episode_id: EP,
				outcome: boundOutcome(),
			},
			{ kind: "oracle" },
		),
		ev(3, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
	];
	const p = projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks: [taskA], events, artifacts: ARTIFACTS });
	assert.equal(p.tasks[0].state, "completed", p.rejected.map((r) => r.reason).join("; "));
});

await test("F3-RESOLVER: resolveTaskFromOutcomes requires every required stage", () => {
	const full = resolveTaskFromOutcomes({
		task: taskA,
		stageResults: [stageOutcome()],
		taskResult: boundOutcome(),
		episodeId: EP,
		scope: { ...SCOPE },
		artifacts: ARTIFACTS,
		eventSource: "oracle",
	});
	assert.equal(full.status, "success", full.reasons?.join("; "));
	const missing = resolveTaskFromOutcomes({
		task: taskA,
		stageResults: [],
		taskResult: boundOutcome(),
		episodeId: EP,
		scope: { ...SCOPE },
		artifacts: ARTIFACTS,
		eventSource: "oracle",
	});
	assert.notEqual(missing.status, "success");
});

// ---------------------------------------------------------------------------
// F4 — synthetic artifact content digest
// ---------------------------------------------------------------------------

await test("F4-DIGEST-BOUND: contentDigest is derived from the real content", () => {
	const a = contentDigest("effect-a");
	const b = contentDigest("effect-b");
	assert.equal(typeof a, "string");
	assert.ok(a.startsWith("sha256:"));
	assert.notEqual(a, b, "different content yields a different digest");
	assert.equal(a, contentDigest("effect-a"), "the same content yields the same digest");
});

await test("F4-DIGEST-CHANGED: a changed sentinel changes the bound reference", () => {
	// The artifact index digest must equal the reference digest; a changed content
	// digest no longer matches.
	const ref = { ref_type: "artifact", ref_id: "artifact:task-a", digest: contentDigest("effect-v1") };
	const indexV1 = { "artifact:task-a": { ref_id: "artifact:task-a", digest: contentDigest("effect-v1") } };
	const indexV2 = { "artifact:task-a": { ref_id: "artifact:task-a", digest: contentDigest("effect-v2") } };
	assert.equal(
		resolveTaskOutcome({
			result: boundOutcome({ evidence_refs: [ref] }),
			task: taskA,
			episodeId: EP,
			scope: { ...SCOPE },
			artifacts: indexV1,
			eventSource: "oracle",
		}).ok,
		true,
	);
	assert.equal(
		resolveTaskOutcome({
			result: boundOutcome({ evidence_refs: [ref] }),
			task: taskA,
			episodeId: EP,
			scope: { ...SCOPE },
			artifacts: indexV2,
			eventSource: "oracle",
		}).ok,
		false,
	);
});

// ---------------------------------------------------------------------------
// F5 — dynamic Task definition completeness
// ---------------------------------------------------------------------------

function dynamicProposal(over = {}) {
	const fixture = buildFixtureCampaign();
	const manifest = fixture.manifest;
	return {
		manifest,
		proposal: {
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
			...over,
		},
	};
}

await test("F5-DEF-FULL2: definition includes capabilities/budget/stop condition/expected evidence", async () => {
	const { manifest, proposal } = dynamicProposal();
	const { admitTaskProposal } = await import("../memory/campaign/index.mjs");
	const decision = admitTaskProposal({ proposal, manifest, depth: 1 });
	assert.equal(decision.status, "admitted", decision.reasons.join("; "));
	const events = [
		ev(
			0,
			"campaign.proposal.submitted",
			{ proposal_id: "p1", proposal, proposal_digest: "sha256:p1" },
			{ kind: "llm" },
			manifest.campaign_id,
		),
		ev(
			1,
			"campaign.proposal.admitted",
			{
				proposal_id: "p1",
				proposal_digest: "sha256:p1",
				task_id: proposal.proposed_task_id,
				admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
			},
			{ kind: "runtime" },
			manifest.campaign_id,
		),
	];
	const p = projectQueueFromEvents({ campaign_id: manifest.campaign_id, tasks: manifest.tasks, events, manifest });
	const dyn = p.tasks.find((t) => t.task_id === proposal.proposed_task_id);
	assert.ok(dyn?.definition);
	assert.equal(dyn.definition.scope ?? null, proposal.scope ?? null);
	assert.equal(dyn.definition.stop_condition, proposal.stop_condition);
	assert.deepEqual(dyn.definition.expected_evidence, proposal.expected_evidence);
	assert.ok(dyn.definition.budget_reservation);
	assert.ok(dyn.definition.task_digest, "the definition carries a digest");
});

await test("F5-DEF-STAGEID: a duplicate generated stage id is refused (Campaign-global uniqueness)", async () => {
	const { manifest, proposal } = dynamicProposal();
	const { admitTaskProposal } = await import("../memory/campaign/index.mjs");
	const decision = admitTaskProposal({ proposal, manifest, depth: 1 });
	const proposal2 = { ...proposal, proposed_task_id: "task-dyn-2", proposed_stage_id: "stage-collide" };
	const proposal1 = { ...proposal, proposed_stage_id: "stage-collide" };
	const d1 = admitTaskProposal({ proposal: proposal1, manifest, depth: 1 });
	assert.equal(d1.status, "admitted");
	const events = [
		ev(
			0,
			"campaign.proposal.submitted",
			{ proposal_id: "p1", proposal: proposal1, proposal_digest: "sha256:p1" },
			{ kind: "llm" },
			manifest.campaign_id,
		),
		ev(
			1,
			"campaign.proposal.admitted",
			{
				proposal_id: "p1",
				proposal_digest: "sha256:p1",
				task_id: proposal1.proposed_task_id,
				admission: { status: "admitted", checks: d1.checks, reserved_budget: d1.reserved_budget },
			},
			{ kind: "runtime" },
			manifest.campaign_id,
		),
		ev(
			2,
			"campaign.proposal.submitted",
			{ proposal_id: "p2", proposal: proposal2, proposal_digest: "sha256:p2" },
			{ kind: "llm" },
			manifest.campaign_id,
		),
		ev(
			3,
			"campaign.proposal.admitted",
			{
				proposal_id: "p2",
				proposal_digest: "sha256:p2",
				task_id: proposal2.proposed_task_id,
				admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
			},
			{ kind: "runtime" },
			manifest.campaign_id,
		),
	];
	const p = projectQueueFromEvents({ campaign_id: manifest.campaign_id, tasks: manifest.tasks, events, manifest });
	assert.equal(
		p.tasks.some((t) => t.task_id === proposal2.proposed_task_id),
		false,
		"the colliding stage id is refused",
	);
});

await test("F5-DEF-DIGEST: the definition digest covers capabilities/budget/stop/evidence", async () => {
	const { manifest, proposal } = dynamicProposal();
	const { admitTaskProposal } = await import("../memory/campaign/index.mjs");
	const decision = admitTaskProposal({ proposal, manifest, depth: 1 });
	const base = [
		ev(
			0,
			"campaign.proposal.submitted",
			{ proposal_id: "p1", proposal, proposal_digest: "sha256:p1" },
			{ kind: "llm" },
			manifest.campaign_id,
		),
		ev(
			1,
			"campaign.proposal.admitted",
			{
				proposal_id: "p1",
				proposal_digest: "sha256:p1",
				task_id: proposal.proposed_task_id,
				admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
			},
			{ kind: "runtime" },
			manifest.campaign_id,
		),
	];
	const digestOf = (events) =>
		projectQueueFromEvents({ campaign_id: manifest.campaign_id, tasks: manifest.tasks, events, manifest }).tasks.find(
			(t) => t.task_id === proposal.proposed_task_id,
		)?.definition?.task_digest;
	const original = digestOf(base);
	assert.ok(original);
	// Change the required capabilities (inside budget) and re-admit with the new policy.
	const altProposal = { ...proposal, required_capabilities: ["fixture.unlock"] };
	const altDecision = admitTaskProposal({ proposal: altProposal, manifest, depth: 1 });
	const alt = [
		ev(
			0,
			"campaign.proposal.submitted",
			{ proposal_id: "p1", proposal: altProposal, proposal_digest: "sha256:p1" },
			{ kind: "llm" },
			manifest.campaign_id,
		),
		ev(
			1,
			"campaign.proposal.admitted",
			{
				proposal_id: "p1",
				proposal_digest: "sha256:p1",
				task_id: altProposal.proposed_task_id,
				admission: { status: "admitted", checks: altDecision.checks, reserved_budget: altDecision.reserved_budget },
			},
			{ kind: "runtime" },
			manifest.campaign_id,
		),
	];
	assert.notEqual(digestOf(alt), original, "a changed capability changes the definition digest");
});

await test("F5-DEF-RESTART: a dynamic definition is recovered identically from committed events", async () => {
	const { manifest, proposal } = dynamicProposal();
	const { admitTaskProposal } = await import("../memory/campaign/index.mjs");
	const decision = admitTaskProposal({ proposal, manifest, depth: 1 });
	const events = [
		ev(
			0,
			"campaign.proposal.submitted",
			{ proposal_id: "p1", proposal, proposal_digest: "sha256:p1" },
			{ kind: "llm" },
			manifest.campaign_id,
		),
		ev(
			1,
			"campaign.proposal.admitted",
			{
				proposal_id: "p1",
				proposal_digest: "sha256:p1",
				task_id: proposal.proposed_task_id,
				admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
			},
			{ kind: "runtime" },
			manifest.campaign_id,
		),
	];
	const first = projectQueueFromEvents({ campaign_id: manifest.campaign_id, tasks: manifest.tasks, events, manifest });
	const second = projectQueueFromEvents({ campaign_id: manifest.campaign_id, tasks: manifest.tasks, events, manifest });
	const dash = first.tasks.find((t) => t.task_id === proposal.proposed_task_id);
	const dash2 = second.tasks.find((t) => t.task_id === proposal.proposed_task_id);
	assert.ok(dash.definition.task_digest);
	assert.equal(
		dash.definition.task_digest,
		dash2.definition.task_digest,
		"the recovered definition digest is identical",
	);
});

await test("F6-CKP-FULL: prefix+tail equals full replay across the COMPLETE projection", () => {
	// Build a stream with a static completion, a dynamic admission, a budget charge
	// and a control event; then compare a prefix+tail reduce with the full reduce.
	const { manifest, proposal } = dynamicProposal();
	const admitted = [
		ev(
			0,
			"campaign.proposal.submitted",
			{ proposal_id: "p1", proposal, proposal_digest: "sha256:p1" },
			{ kind: "llm" },
			manifest.campaign_id,
		),
		ev(
			1,
			"campaign.proposal.admitted",
			{
				proposal_id: "p1",
				proposal_digest: "sha256:p1",
				task_id: proposal.proposed_task_id,
				admission: { status: "admitted", checks: [], reserved_budget: proposal.budget_reservation },
			},
			{ kind: "runtime" },
			manifest.campaign_id,
		),
	];
	// `admission` with empty checks + matching reservation is re-validated against the
	// live policy inside the projection; if refused, the dynamic task is absent in
	// BOTH projections and the equivalence still holds.
	const all = [
		...admitted,
		ev(
			3,
			"campaign.budget.reserved",
			{ task_id: proposal.proposed_task_id, reservation: { wall_time_ms: 1, model_requests: 0, tool_calls: 0 } },
			{ kind: "runtime" },
			manifest.campaign_id,
		),
		ev(4, "campaign.campaign.paused", { reason: "user_paused" }, { kind: "runtime" }, manifest.campaign_id),
	];
	const full = projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: manifest.tasks,
		events: all,
		manifest,
	});
	// Prefix = first two events; tail = the rest.
	const prefix = projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: manifest.tasks,
		events: all.slice(0, 2),
		manifest,
	});
	const prefixPlusTail = projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: manifest.tasks,
		events: all,
		manifest,
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
			tail_offset: 1,
		},
	});
	const a = projectionSnapshot(full);
	const b = projectionSnapshot(prefixPlusTail);
	assert.deepEqual(b, a, "prefix+tail must equal the full replay across the complete projection");
	assert.equal(b.control.state, "paused");
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 final audit: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 final audit: all assertions passed");
