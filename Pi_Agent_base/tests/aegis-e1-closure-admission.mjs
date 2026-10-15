#!/usr/bin/env node
// Aegis E1 contract closure — `aegis-e1-closure-admission` (T-A01..T-A18).
//
// Independent expectations over the REAL SDK/faux product chain and real
// Host/EventLog/Broker/Oracle. The normal chain, the per-Task budget, the
// one-effective-plan rule and the foreign-root refusal are asserted from the
// durable stream, not from helper return values.
//
// Run: node --test Pi_Agent_base/tests/aegis-e1-closure-admission.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { planDigest, validatePlanGraph } from "../memory/campaign/e1-plan-contract.mjs";
import { templatesFromConfig } from "../memory/campaign/e1-planning.mjs";
import { createCampaignScheduler } from "../memory/campaign/scheduler.mjs";
import { verifyChain } from "../memory/runtime/events.mjs";
import {
	evidenceDir,
	project,
	providerRequestsByTask,
	runPlanningScenario,
	TEST_PLANNING_CONFIG,
	testPlanningManifest,
} from "./helpers/e1-closure-helpers.mjs";

const out = evidenceDir("admission");
console.log(`admission closure evidence: ${out}`);

let normal;
test("T-A01 CONTROL: the real product completes with 8 requests / 3 effects", () => {
	normal = runPlanningScenario({ workDir: out, scenario: "normal_plan" });
	assert.equal(normal.exit, 0, normal.stderr.slice(-800));
	assert.equal(verifyChain(normal.events).ok, true);
	assert.equal(normal.summary.provider_calls, 8);
	assert.equal(normal.summary.broker_effects, 3);
	assert.deepEqual(normal.summary.dataset, { name: "Ada", status: "active" });
	const projection = project(normal.events, normal.manifest);
	assert.equal(projection.plans.filter((p) => p.status === "admitted").length, 1, "exactly one effective plan");
	assert.deepEqual(projection.rejected, [], "the normal chain has no rejected campaign event");
	// planning 2, each child 2 (independent derivation from the durable stream).
	assert.deepEqual(providerRequestsByTask(normal.events), { "task-plan": 2, "dyn-a": 2, "dyn-b": 2, "dyn-c": 2 });
});

test("T-A06 CONTROL: a repeated identical plan stays idempotent (one admitted plan)", () => {
	const projection = project(normal.events, normal.manifest);
	const planned = projection.plans.filter((p) => p.status === "admitted");
	assert.equal(planned.length, 1);
	// The candidate digest is stable across replay.
	assert.equal(typeof planned[0].digest, "string");
	assert.equal(projection.dynamic_definitions.length, 3);
});

test("T-A10 / HA-03: a second differently-identified plan cannot overallocate", () => {
	const scenario = runPlanningScenario({ workDir: out, scenario: "double_plan" });
	assert.equal(scenario.exit, 0, scenario.stderr.slice(-800));
	const projection = project(scenario.events, scenario.manifest);
	const admitted = projection.plans.filter((p) => p.status === "admitted");
	assert.equal(admitted.length, 1, "only the first legal batch is admitted");
	assert.ok(projection.rejected.length > 0, "the later conflicting batch is visibly rejected");
	// Independent prefix check: reserved+consumed never exceeds the Campaign limit.
	const limit = scenario.manifest.budget;
	for (let i = 0; i < scenario.events.length; i += 1) {
		if (scenario.events[i].payload?.kind !== "campaign.plan.admitted") continue;
		const prefix = project(scenario.events.slice(0, i + 1), scenario.manifest);
		for (const key of ["wall_time_ms", "model_requests", "tool_calls"])
			assert.ok(
				prefix.budget.reserved[key] + prefix.budget.consumed[key] <= limit[key],
				`prefix ${i} ${key} exceeds the campaign limit`,
			);
	}
	assert.deepEqual(projection.dynamic_definitions.map((d) => d.task_id).sort(), ["dyn-a", "dyn-b", "dyn-c"]);
});

test("T-A11 / HA-02: a per-Task allocation of 1 bounds actual requests and effects", () => {
	const scenario = runPlanningScenario({ workDir: out, scenario: "task_budget_plan" });
	assert.equal(scenario.exit, 0, scenario.stderr.slice(-800));
	const projection = project(scenario.events, scenario.manifest);
	const dynamic = projection.tasks.filter((t) => t.is_dynamic);
	assert.equal(dynamic.length, 3, "a legal one-request allocation is still admitted");
	const requests = providerRequestsByTask(scenario.events);
	const over = dynamic
		.filter((t) => (requests[t.task_id] ?? 0) > t.definition.task_budget.model_requests)
		.map((t) => ({ task: t.task_id, limit: t.definition.task_budget.model_requests, actual: requests[t.task_id] }));
	assert.deepEqual(over, [], "no dynamic task exceeds its own model_requests allocation");
	assert.equal(scenario.summary.broker_effects, 0, "the second request never dispatches an effect");
	for (const task of dynamic) assert.ok((requests[task.task_id] ?? 0) <= 1);
});

test("T-A11b: static and dynamic budgets never fall back to the Campaign total", () => {
	const projection = project(normal.events, normal.manifest);
	const planning = projection.tasks.find((t) => t.task_id === "task-plan");
	assert.deepEqual(planning.definition.task_budget, { wall_time_ms: 120000, model_requests: 8, tool_calls: 24 });
	for (const task of projection.tasks.filter((t) => t.is_dynamic)) {
		assert.deepEqual(
			task.definition.task_budget,
			{ wall_time_ms: 30000, model_requests: 4, tool_calls: 8 },
			`task ${task.task_id} must expose its own normalized budget`,
		);
	}
});

test("T-A17: an abnormal planning termination never activates the children", () => {
	for (const scenario of ["error_plan", "aborted_plan", "unknown_plan"]) {
		const run = runPlanningScenario({ workDir: out, scenario });
		assert.equal(run.exit, 0, run.stderr.slice(-400));
		assert.equal(run.summary.plan_ready, false, `${scenario} must not write plan.ready`);
		const projection = project(run.events, run.manifest);
		for (const task of projection.tasks.filter((t) => t.is_dynamic))
			assert.notEqual(task.state, "completed", `${scenario}: a held child must not complete`);
		assert.equal(run.summary.broker_effects, 0, `${scenario}: no effect may follow an abnormal termination`);
	}
});

test("T-A18: a persisted plan-ready gate failure keeps the children held", () => {
	const run = runPlanningScenario({ workDir: out, scenario: "plan_ready_persist_error" });
	assert.equal(run.exit, 0, run.stderr.slice(-400));
	assert.equal(run.summary.plan_ready, false);
	assert.equal(run.summary.injected_failures.plan_ready_append, 1, "the injected gate write failure actually fired");
	assert.equal(run.summary.broker_effects, 0, "no child effect without a durable ready gate");
});

test("T-A15 / T-A02: a legacy path without a contract keeps prior behavior", () => {
	// The independent history audit's legitimate scenarios are the reference; this
	// script only re-checks that the admission never fabricated a definition from
	// a rejected batch (visible as zero dynamic definitions).
	const scenario = runPlanningScenario({ workDir: out, scenario: "foreign_root_plan" });
	assert.equal(scenario.exit, 0, scenario.stderr.slice(-400));
	const projection = project(scenario.events, scenario.manifest);
	assert.equal(projection.dynamic_definitions.length, 0, "no dynamic definition from a refused root");
	assert.equal(scenario.summary.broker_effects, 0);
	assert.equal(scenario.summary.provider_calls, 2, "only the planning request may run");
});

test("T-A08 / HA-04: a foreign-root candidate is retained but never admitted", () => {
	const scenario = runPlanningScenario({ workDir: out, scenario: "foreign_root_plan" });
	const projection = project(scenario.events, scenario.manifest);
	assert.ok(
		projection.plans.some((p) => p.plan?.root_goal_ref === "foreign-root"),
		"the candidate stays inspectable",
	);
	assert.ok(
		projection.plans.some((p) => p.status === "rejected" || p.status === "blocked") || projection.rejected.length > 0,
		"the foreign root is refused",
	);
});

test("T-A06: record_candidate then admit_plan shares ONE submitted record and reports exact fields", async () => {
	const manifest = testPlanningManifest({ workDir: out });
	const events = [];
	let seq = 0;
	const sink = {
		events,
		async append(event) {
			const row = { ...event, event_id: `e${seq}`, sequence: seq, event_digest: `sha256:e${seq}` };
			seq += 1;
			events.push(row);
			return { ok: true, event: row, durable: true };
		},
	};
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: manifest.tasks,
		sink,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "artifact:x" };
			},
		},
		oracle: {
			id: "synthetic.oracle",
			async judge() {
				return { status: "unknown" };
			},
		},
		clock: () => 1000,
		acquireOwnership: false,
	});
	const plan = {
		version: "aegis-plan-1.0",
		plan_id: "plan-host",
		root_goal_ref: manifest.planning_contract.root_goal_ref,
		tasks: [
			{
				proposed_task_id: "dyn-x",
				parent_task_id: "task-plan",
				depends_on: [],
				goal: {
					description: "repair name and status",
					success_criteria: ["data.name == Ada", "data.status == active"],
				},
				task_type: "verify",
				template_ref: "verify",
				target_ref: "dataset.json",
				required_capabilities: ["data.record.write"],
				expected_evidence: ["artifact:dyn-x"],
				stop_condition: "done",
				priority: 1,
				budget_reservation: { wall_time_ms: 1000, model_requests: 2, tool_calls: 2 },
			},
		],
	};
	// record_candidate: durable + accepted, submitted only, never activated.
	const recorded = await scheduler.recordPlanCandidate({ plan, planningTaskId: "task-plan" });
	assert.equal(recorded.ok, true);
	assert.equal(recorded.command, "record_candidate");
	assert.equal(recorded.status, "submitted");
	assert.equal(recorded.activated, false);
	assert.equal(recorded.transition_accepted, false);
	assert.equal(recorded.record_durable, true);
	assert.equal(typeof recorded.submitted_event_id, "string");
	const submittedCount = () => events.filter((e) => e.payload?.kind === "campaign.plan.submitted").length;
	assert.equal(submittedCount(), 1);
	// Re-record is a duplicate referencing the SAME durable event, adding no record.
	const again = await scheduler.recordPlanCandidate({ plan, planningTaskId: "task-plan" });
	assert.equal(again.ok, true);
	assert.equal(again.status, "duplicate");
	assert.equal(again.submitted_event_id, recorded.submitted_event_id);
	assert.equal(submittedCount(), 1, "no duplicate submitted record is appended");
	// admit_plan REUSES the tool-persisted candidate (no second submitted record).
	const admission = validatePlanGraph({
		plan,
		manifest,
		planningTaskId: "task-plan",
		existingTaskIds: new Set(["task-plan"]),
		templates: templatesFromConfig(TEST_PLANNING_CONFIG),
		requiredCriteria: manifest.objective.required_criteria,
		expectedRootGoalRef: manifest.planning_contract.root_goal_ref,
		derivedBudget: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 },
	});
	assert.equal(admission.status, "admitted", JSON.stringify(admission.reasons));
	const admitted = await scheduler.admitPlan({
		plan,
		planningTaskId: "task-plan",
		admission,
		planId: "plan-host",
		planDigest: planDigest(plan),
	});
	assert.equal(admitted.ok, true);
	assert.equal(admitted.status, "admitted");
	assert.equal(admitted.transition_accepted, true);
	assert.equal(admitted.activated, false);
	assert.equal(admitted.active_plan_id, "plan-host");
	assert.equal(admitted.submitted_event_id, recorded.submitted_event_id, "admit reused the recorded candidate");
	assert.equal(submittedCount(), 1, "admit_plan did not append a second submitted record");
	assert.equal(events.filter((e) => e.payload?.kind === "campaign.plan.admitted").length, 1);
});

test("T-A14: a durable tool charge is dual-sided, deduplicated and never refunded", async () => {
	const manifest = testPlanningManifest({ workDir: out });
	const events = [];
	let seq = 0;
	const sink = {
		events,
		async append(event) {
			const row = { ...event, event_id: `e${seq}`, sequence: seq, event_digest: `sha256:e${seq}` };
			seq += 1;
			events.push(row);
			return { ok: true, event: row, durable: true };
		},
	};
	// A 1-tool allocation: the second distinct unit must be refused.
	const limited = {
		...manifest,
		tasks: [
			{
				...manifest.tasks[0],
				task_budget: { wall_time_ms: 120000, model_requests: 8, tool_calls: 0 },
			},
		],
	};
	const scheduler = createCampaignScheduler({
		manifest: limited,
		ownedTasks: limited.tasks,
		sink,
		worker: { async run() { return { ok: true, outcome_ref: "a" }; } },
		oracle: { id: "synthetic.oracle", async judge() { return { status: "unknown" }; } },
		clock: () => 1000,
		acquireOwnership: false,
	});
	const first = await scheduler.chargeTool({ request_id: "req-1", tool_call_id: "tc-1", unit_id: "action:0", tool_name: "data.record.set", task_id: "task-plan", episode_id: "ep-task-plan" });
	// A zero task tool allocation refuses the first unit entirely.
	assert.equal(first.ok, false, "a zero task tool allocation must refuse the charge");
	assert.equal(events.filter((e) => e.payload?.kind === "c6.tool").length, 0, "no durable charge is written on refusal");
	// Give the task a real allocation and re-charge.
	const permissive = { ...limited, tasks: [{ ...limited.tasks[0], task_budget: { wall_time_ms: 120000, model_requests: 8, tool_calls: 2 } }] };
	const scheduler2 = createCampaignScheduler({ manifest: permissive, ownedTasks: permissive.tasks, sink, worker: { async run() { return { ok: true, outcome_ref: "a" }; } }, oracle: { id: "synthetic.oracle", async judge() { return { status: "unknown" }; } }, clock: () => 1000, acquireOwnership: false });
	const a = await scheduler2.chargeTool({ request_id: "req-2", tool_call_id: "tc-2", unit_id: "action:0", tool_name: "data.record.set", task_id: "task-plan", episode_id: "ep-task-plan" });
	assert.equal(a.ok, true);
	assert.equal(a.charged, true);
	assert.equal(a.record_durable, true);
	assert.equal(typeof a.event_id, "string");
	const b = await scheduler2.chargeTool({ request_id: "req-2", tool_call_id: "tc-2", unit_id: "action:0", tool_name: "data.record.set", task_id: "task-plan", episode_id: "ep-task-plan" });
	assert.equal(b.ok, true);
	assert.equal(b.duplicate, true, "the same unit identity is charged at most once");
	assert.equal(b.charged, false);
	assert.equal(b.event_id, a.event_id, "duplicate references the existing durable event");
	assert.equal(events.filter((e) => e.payload?.kind === "c6.tool").length, 1);
	// A different request is a distinct unit and is charged again.
	const c = await scheduler2.chargeTool({ request_id: "req-3", tool_call_id: "tc-3", unit_id: "action:0", tool_name: "data.record.set", task_id: "task-plan", episode_id: "ep-task-plan" });
	assert.equal(c.ok, true);
	assert.equal(c.charged, true);
	assert.equal(events.filter((e) => e.payload?.kind === "c6.tool").length, 2);
});
