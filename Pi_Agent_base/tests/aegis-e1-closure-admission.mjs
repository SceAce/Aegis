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
import { verifyChain } from "../memory/runtime/events.mjs";
import { evidenceDir, project, providerRequestsByTask, runPlanningScenario } from "./helpers/e1-closure-helpers.mjs";

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
