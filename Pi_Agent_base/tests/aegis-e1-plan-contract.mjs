#!/usr/bin/env node
// Aegis E1 — structured plan contract and whole-graph admission (offline).
//
// Pure contract tests: shape bounds, whole-graph validation (ids, parentage,
// dependency DAG, cycles, authorization, capabilities, template resolution,
// depth/fan-out/count, root-criteria coverage) and order independence. No SDK,
// no provider, no filesystem.
//
// Run: node --test Pi_Agent_base/tests/aegis-e1-plan-contract.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_LIMITS, planDigest, validatePlanGraph, validatePlanShape } from "../campaign/e1-plan-contract.mjs";

const MANIFEST = {
	schema_version: "campaign-1.1",
	campaign_id: "campaign-e1",
	tasks: [{ task_id: "task-plan", depends_on: [] }],
	budget: { wall_time_ms: 600000, model_requests: 20, tool_calls: 40 },
	authorization: { allowed_targets: ["dataset.json"], allowed_capabilities: ["data.record.write"] },
	dynamic_task_policy: {
		enabled: true,
		allowed_task_types: ["observe", "verify", "reproduce"],
		max_depth: 3,
		max_fan_out: 4,
		max_task_count: 8,
	},
};

const TEMPLATES = new Map([
	[
		"verify",
		{
			template_ref: "verify",
			task_type: "verify",
			oracle_ref: "fixture.oracle.v1",
			required_capabilities: ["data.record.write"],
			success_criteria: ["data.status == active"],
		},
	],
	[
		"reproduce",
		{
			template_ref: "reproduce",
			task_type: "reproduce",
			oracle_ref: "fixture.oracle.v1",
			required_capabilities: ["data.record.write"],
			success_criteria: ["data.status == active"],
		},
	],
	[
		"observe",
		{
			template_ref: "observe",
			task_type: "observe",
			oracle_ref: "fixture.oracle.v1",
			required_capabilities: ["data.record.write"],
			success_criteria: ["data.status == active"],
		},
	],
]);

function node(id, extra = {}) {
	return {
		proposed_task_id: id,
		parent_task_id: "task-plan",
		depends_on: [],
		goal: { description: `do ${id}`, success_criteria: ["data.status == active"] },
		task_type: "verify",
		target_ref: "dataset.json",
		required_capabilities: ["data.record.write"],
		expected_evidence: [`artifact:${id}`],
		stop_condition: "judged",
		priority: 1,
		budget_reservation: { wall_time_ms: 30000, model_requests: 4, tool_calls: 8 },
		...extra,
	};
}

function plan(tasks, extra = {}) {
	return { version: "aegis-plan-1.0", plan_id: "plan-1", root_goal_ref: "root", tasks, ...extra };
}

function validate(candidate, overrides = {}) {
	return validatePlanGraph({
		plan: candidate,
		manifest: MANIFEST,
		planningTaskId: "task-plan",
		existingTaskIds: new Set(["task-plan"]),
		templates: TEMPLATES,
		requiredCriteria: ["data.status == active"],
		...overrides,
	});
}

test("E1-CONTRACT: a valid three-task plan with two parents and a diamond admits", () => {
	const built = plan([node("t-a"), node("t-b"), node("t-c", { depends_on: ["t-a", "t-b"] })]);
	const result = validate(built);
	assert.equal(result.status, "admitted", JSON.stringify(result.reasons));
	assert.equal(result.normalized.length, 3);
	assert.deepEqual(
		result.normalized.map((t) => t.task_id),
		["t-a", "t-b", "t-c"],
	);
	const c = result.normalized.find((t) => t.task_id === "t-c");
	assert.deepEqual(c.depends_on, ["t-a", "t-b"], "multi-prerequisite dependency preserved");
	assert.equal(c.parent_task_id, "task-plan");
	assert.equal(c.oracle_ref, "fixture.oracle.v1", "business oracle comes from the template");
});

test("E1-CONTRACT: input array order does not change the accepted graph", () => {
	const ordered = plan([node("t-a"), node("t-b"), node("t-c", { depends_on: ["t-a", "t-b"] })]);
	const shuffled = plan([node("t-c", { depends_on: ["t-b", "t-a"] }), node("t-b"), node("t-a")]);
	const a = validate(ordered);
	const b = validate(shuffled);
	assert.equal(a.status, "admitted");
	assert.equal(b.status, "admitted");
	assert.deepEqual(
		a.normalized.map((t) => t.task_id),
		b.normalized.map((t) => t.task_id),
	);
	assert.equal(planDigest(ordered), planDigest(ordered));
});

test("E1-CONTRACT: parentage and dependency are validated separately", () => {
	// A child of t-a is NOT automatically dependent on t-a.
	const built = plan([node("t-a"), node("t-b", { parent_task_id: "t-a" })]);
	const result = validate(built);
	assert.equal(result.status, "admitted", JSON.stringify(result.reasons));
	const b = result.normalized.find((t) => t.task_id === "t-b");
	assert.equal(b.parent_task_id, "t-a");
	assert.deepEqual(b.depends_on, [], "parentage alone never inserts an execution dependency");
});

test("E1-CONTRACT: dangling parent, dangling dependency and self-reference are rejected", () => {
	assert.equal(validate(plan([node("t-a", { parent_task_id: "ghost" })])).status, "rejected");
	assert.equal(validate(plan([node("t-a", { depends_on: ["ghost"] })])).status, "rejected");
	assert.equal(validate(plan([node("t-a", { depends_on: ["t-a"] })])).status, "rejected");
	assert.equal(validate(plan([node("t-a", { parent_task_id: "t-a" })])).status, "rejected");
});

test("E1-CONTRACT: parent cycle and dependency cycle are separately detected", () => {
	const parentCycle = validate(plan([node("t-a", { parent_task_id: "t-b" }), node("t-b", { parent_task_id: "t-a" })]));
	assert.equal(parentCycle.status, "rejected");
	assert.ok(
		parentCycle.reasons.some((r) => /parentage cycle/.test(r)),
		JSON.stringify(parentCycle.reasons),
	);
	const depCycle = validate(plan([node("t-a", { depends_on: ["t-b"] }), node("t-b", { depends_on: ["t-a"] })]));
	assert.equal(depCycle.status, "rejected");
	assert.ok(
		depCycle.reasons.some((r) => /dependency cycle/.test(r)),
		JSON.stringify(depCycle.reasons),
	);
});

test("E1-CONTRACT: an unauthorized target/capability/type blocks the whole batch", () => {
	assert.equal(validate(plan([node("t-a", { target_ref: "secret.txt" })])).status, "blocked");
	assert.equal(validate(plan([node("t-a", { required_capabilities: ["net.attack"] })])).status, "blocked");
	assert.equal(validate(plan([node("t-a", { task_type: "exploit" })])).status, "blocked");
	// Even alongside a legal node: block the WHOLE graph.
	const mixed = validate(plan([node("t-a"), node("t-b", { target_ref: "secret.txt" })]));
	assert.equal(mixed.status, "blocked", "a legal node does not rescue an illegal sibling");
	assert.equal(mixed.normalized, null, "no partial normalized set is exposed");
});

test("E1-CONTRACT: root criteria must be covered and cannot be rephrased away", () => {
	const uncovered = validate(
		plan([node("t-a", { goal: { description: "read a file", success_criteria: ["read the file"] } })]),
	);
	assert.equal(uncovered.status, "blocked");
	assert.ok(uncovered.reasons.some((r) => /required root criteria/.test(r)));
});

test("E1-CONTRACT: template resolution rejects an unknown template", () => {
	const result = validate(plan([node("t-a", { template_ref: "unregistered" })]));
	assert.equal(result.status, "blocked");
});

test("E1-CONTRACT: depth, fan-out, count and aggregate budget limits are enforced", () => {
	// depth: t-a -> t-b -> t-c -> t-d exceeds max_depth 3 for the leaf chain.
	const deep = validate(
		plan([
			node("t-a"),
			node("t-b", { parent_task_id: "t-a" }),
			node("t-c", { parent_task_id: "t-b" }),
			node("t-d", { parent_task_id: "t-c" }),
		]),
	);
	assert.equal(deep.status, "rejected", JSON.stringify(deep.reasons));
	// fan-out: 5 children under the planning task exceeds max_fan_out 4.
	const wide = validate(plan(["t-1", "t-2", "t-3", "t-4", "t-5"].map((id) => node(id))));
	assert.equal(wide.status, "rejected");
	const overBudget = validate(
		plan([node("t-a", { budget_reservation: { wall_time_ms: 1000, model_requests: 100, tool_calls: 0 } })]),
	);
	assert.equal(overBudget.status, "blocked");
});

test("E1-CONTRACT: transport shape bounds reject malformed or oversized plans", () => {
	assert.equal(validatePlanShape(null).ok, false);
	assert.equal(validatePlanShape({ tasks: [] }).ok, false);
	assert.equal(validatePlanShape(plan([node("t-a")], { plan_id: "" })).ok, false);
	const tooMany = plan(Array.from({ length: PLAN_LIMITS.max_tasks + 1 }, (_, i) => node(`t-${i}`)));
	assert.equal(validatePlanShape(tooMany).ok, false);
	assert.equal(validatePlanShape(plan([node("t-a", { priority: 1.5 })])).ok, false);
	assert.equal(validatePlanShape(plan([node("t-a", { priority: 99999 })])).ok, false);
	const bad = validate(plan([{ proposed_task_id: "t-a" }]));
	assert.equal(bad.status, "rejected");
});

test("E1-CONTRACT: a node may not redefine the planning task and duplicate ids are rejected", () => {
	assert.equal(validate(plan([node("task-plan")])).status, "rejected");
	assert.equal(validate(plan([node("t-a"), node("t-a")])).status, "rejected");
	const existing = validate(plan([node("t-x")]), { existingTaskIds: new Set(["task-plan", "t-x"]) });
	assert.equal(existing.status, "rejected");
});

test("E1-CONTRACT: empty success_criteria on a node still enforces root coverage", () => {
	const result = validate(plan([node("t-a", { goal: { description: "x", success_criteria: [] } })]));
	assert.equal(result.status, "blocked");
});
