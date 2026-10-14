#!/usr/bin/env node
// Aegis E1 — whole-graph plan admission, depends_on scheduling and plan-ready gate.
//
// Uses the REAL projection + scheduler + a FAKE worker/oracle and a controlled
// clock. No real SDK/provider. Proves:
//   * a batch-admitted plan creates the dynamic tasks with their depends_on;
//   * a successor with unsatisfied prerequisites is NOT dispatched (no worker,
//     no effect) until the predecessors complete with a trusted Oracle result;
//   * a multi-prerequisite ("diamond") task waits for BOTH;
//   * an illegal node rejects the WHOLE batch (no legal subset runs);
//   * the batch admission alone does NOT dispatch: the plan-ready gate is a
//     separate durable state;
//   * the dependency graph and tree are rebuilt from the same committed stream.
//
// Run: node --test Pi_Agent_base/tests/aegis-e1-planning-product.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validatePlanGraph } from "../memory/campaign/e1-plan-contract.mjs";
import { admitCandidatePlan, PLAN_READY_CRITERION, templatesFromConfig } from "../memory/campaign/e1-planning.mjs";
import { buildTaskGraph } from "../memory/campaign/e1-task-graph.mjs";
import { projectQueueFromEvents } from "../memory/campaign/projection.mjs";
import { createCampaignScheduler } from "../memory/campaign/scheduler.mjs";

const root = mkdtempSync(join(tmpdir(), "aegis-e1-planning-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const SCOPE = {
	environment_fingerprint: "data-repair-env",
	domain: "structured-data",
	permissions: ["data.record.write"],
	task_types: ["verify", "reproduce"],
};
const ROOT_CRITERIA = ["dataset.name repaired", "dataset.status transformed"];

const MANIFEST = {
	schema_version: "campaign-1.1",
	campaign_id: "campaign-e1",
	revision: 1,
	objective: { description: "Repair the dataset", success_criteria: ROOT_CRITERIA, required_criteria: ROOT_CRITERIA },
	budget: { wall_time_ms: 600000, model_requests: 20, tool_calls: 120, task_count: 8, session_count: 10 },
	authorization: { allowed_targets: ["dataset.json"], allowed_capabilities: ["data.record.write"] },
	adapters: { execution: "workspace.exec.v1", oracle: "fixture.oracle.v1", report: "aegis-acceptance.v1" },
	dynamic_task_policy: {
		enabled: true,
		allowed_task_types: ["verify", "reproduce"],
		max_depth: 3,
		max_fan_out: 6,
		max_task_count: 12,
	},
	tasks: [
		{
			task_id: "task-plan",
			order: 1,
			depends_on: [],
			target_ref: "dataset.json",
			task_type: "observe",
			scope: SCOPE,
			goal: { goal_id: "plan_campaign", description: "Plan the campaign", success_criteria: [PLAN_READY_CRITERION] },
			stages: [{ stage_id: "stage-plan", criteria: [PLAN_READY_CRITERION], required: true }],
			oracle_ref: "fixture.oracle.v1",
			task_budget: { wall_time_ms: 120000, model_requests: 8, tool_calls: 24 },
		},
	],
};

const TEMPLATES = templatesFromConfig({
	templates: [
		{
			template_ref: "verify",
			task_type: "verify",
			oracle_ref: "fixture.oracle.v1",
			required_capabilities: ["data.record.write"],
			scope: SCOPE,
		},
		{
			template_ref: "reproduce",
			task_type: "reproduce",
			oracle_ref: "fixture.oracle.v1",
			required_capabilities: ["data.record.write"],
			scope: SCOPE,
		},
	],
});

function planNode(id, extra = {}) {
	return {
		proposed_task_id: id,
		parent_task_id: "task-plan",
		depends_on: [],
		goal: { description: `do ${id}`, success_criteria: ROOT_CRITERIA },
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
	};
}

function makeFixtureWorker() {
	const calls = [];
	return {
		calls,
		worker: {
			async run({ task }) {
				calls.push(task.task_id);
				return { ok: true, outcome_ref: `artifact:${task.task_id}` };
			},
		},
	};
}

function makeOracle(script) {
	return {
		id: "synthetic.oracle",
		async judge({ task }) {
			const entry = script[task.task_id];
			if (!entry) return { status: "unknown", failure_mode: "no_rule" };
			const stageOutcomes = (task.stages ?? []).flatMap((stage) =>
				(stage.criteria ?? []).map((criterionId, index) => ({
					step_id: stage.stage_id,
					status: entry.status,
					outcome_id: `so-${task.task_id}-${stage.stage_id}-${index}`,
					outcome: {
						outcome_id: `so-${task.task_id}-${stage.stage_id}-${index}`,
						level: "step",
						step_id: stage.stage_id,
						status: entry.status,
						episode_id: `ep-${task.task_id}`,
						task_id: task.task_id,
						criterion: { criterion_id: criterionId, expected: criterionId },
						observed: { synthetic: true },
						scope: { ...SCOPE },
						oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
						provenance: { source: "oracle", independent: true, task_id: task.task_id, stage_id: stage.stage_id },
						evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${task.task_id}` }],
					},
				})),
			);
			return {
				status: entry.status,
				stage_outcomes: stageOutcomes,
				outcome_id: `o-${task.task_id}`,
				task_oracle: true,
				outcome: {
					outcome_id: `o-${task.task_id}`,
					level: "task",
					task_id: task.task_id,
					status: entry.status,
					episode_id: `ep-${task.task_id}`,
					criterion: { criterion_id: task.goal?.goal_id ?? null, expected: task.goal?.success_criteria?.[0] ?? null },
					observed: { synthetic: true },
					scope: { ...SCOPE },
					oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
					provenance: { source: "oracle", independent: true, task_id: task.task_id },
					evidence_refs: [{ type: "artifact", ref_id: `artifact:${task.task_id}` }],
				},
			};
		},
	};
}

function makeArtifacts(taskIds) {
	return Object.fromEntries(
		taskIds.map((id) => [`artifact:${id}`, { ref_id: `artifact:${id}`, digest: `sha256:${id}` }]),
	);
}

/** A Host stub exposing admitPlan/completePlanningTask over a real scheduler sink. */
function makeHost({ manifest, sink }) {
	const events = [];
	let seq = 0;
	const commit = async (kind, payload, source) => {
		const row = {
			event_type: "runtime.note",
			source,
			payload: { kind, campaign_id: manifest.campaign_id, ...payload },
			event_id: `h${seq}`,
			sequence: 1000 + seq,
			event_digest: `sha256:h${seq}`,
		};
		seq += 1;
		events.push(row);
		sink.events.push(row);
		return { ok: true, event: row, durable: true };
	};
	return {
		events,
		async admitPlan({ plan, planningTaskId, admission, planId }) {
			await commit(
				"campaign.plan.submitted",
				{ plan_id: planId ?? plan.plan_id, plan, planning_task_id: planningTaskId },
				{ kind: "runtime", actor_id: "host" },
			);
			if (admission.status !== "admitted") {
				const kind = admission.status === "rejected" ? "campaign.plan.rejected" : "campaign.plan.blocked";
				await commit(
					kind,
					{ plan_id: planId ?? plan.plan_id, reasons: admission.reasons, planning_task_id: planningTaskId },
					{ kind: "runtime", actor_id: "host" },
				);
				return { ok: false, status: admission.status };
			}
			await commit(
				"campaign.plan.admitted",
				{ plan_id: planId ?? plan.plan_id, plan_tasks: admission.normalized, planning_task_id: planningTaskId },
				{ kind: "runtime", actor_id: "host" },
			);
			return { ok: true, status: "admitted", plan_id: planId ?? plan.plan_id };
		},
		async completePlanningTask({ taskId, planId }) {
			await commit("campaign.plan.ready", { task_id: taskId, plan_id: planId }, { kind: "oracle", actor_id: "oracle" });
			return { ok: true };
		},
	};
}

test("E1-PLAN: batch admission creates the DAG and the plan-ready gate is separate", async () => {
	const sink = makeSink();
	const host = makeHost({ manifest: MANIFEST, sink });
	const plan = {
		version: "aegis-plan-1.0",
		plan_id: "plan-1",
		root_goal_ref: "root",
		tasks: [planNode("t-c", { depends_on: ["t-a", "t-b"] }), planNode("t-b"), planNode("t-a")],
	};
	// Not settled → blocked, nothing admitted.
	const blocked = await admitCandidatePlan({
		plan,
		manifest: MANIFEST,
		host,
		projection: { tasks: [], budget: { reserved: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 } } },
		templates: TEMPLATES,
		planningSettled: false,
	});
	assert.equal(blocked.ok, false);
	let projection = projectQueueFromEvents({
		campaign_id: MANIFEST.campaign_id,
		tasks: MANIFEST.tasks,
		events: sink.events,
		revision: 1,
		manifest: MANIFEST,
		artifacts: {},
	});
	assert.equal(projection.tasks.length, 1, "a blocked plan creates no task");

	// Settled → admitted as one batch; children are queued awaiting the gate.
	const admitted = await admitCandidatePlan({
		plan,
		manifest: MANIFEST,
		host,
		projection,
		templates: TEMPLATES,
		planningSettled: true,
	});
	assert.equal(admitted.ok, true, JSON.stringify(admitted.reasons));
	// BEFORE the plan-ready gate the children are queued + gated.
	const gated = projectQueueFromEvents({
		campaign_id: MANIFEST.campaign_id,
		tasks: MANIFEST.tasks,
		events: sink.events.slice(0, -1),
		revision: 1,
		manifest: MANIFEST,
		artifacts: makeArtifacts(["t-a", "t-b", "t-c"]),
	});
	const gatedC = gated.tasks.find((t) => t.task_id === "t-c");
	assert.equal(gatedC.awaiting_plan_ready, true, "a batch-admitted child waits for the plan-ready gate");
	assert.equal(gatedC.state, "queued", "a batch-admitted child is not ready before the gate");
	assert.deepEqual(gatedC.depends_on, ["t-a", "t-b"], "the stored dependency set survives batch admission");
	// t-b has NO dependency: it may only become ready after the plan-ready gate.
	assert.equal(
		gated.tasks.find((t) => t.task_id === "t-b").state,
		"queued",
		"even a dependency-free child waits for the gate",
	);
	projection = projectQueueFromEvents({
		campaign_id: MANIFEST.campaign_id,
		tasks: MANIFEST.tasks,
		events: sink.events,
		revision: 1,
		manifest: MANIFEST,
		artifacts: makeArtifacts(["t-a", "t-b", "t-c"]),
	});
	const ids = projection.tasks.map((t) => t.task_id).sort();
	assert.deepEqual(ids, ["t-a", "t-b", "t-c", "task-plan"]);
	const tc = projection.tasks.find((t) => t.task_id === "t-c");
	assert.deepEqual(tc.depends_on, ["t-a", "t-b"], "multi-prerequisite dependency preserved in the projection");
	assert.equal(tc.state, "queued", "batch admission alone does not dispatch");
	assert.equal(tc.awaiting_plan_ready, false, "the plan-ready gate released the children");
	const ta = projection.tasks.find((t) => t.task_id === "t-a");
	assert.equal(ta.depends_on.length, 0);
});

test("E1-PLAN: a successor waits for ALL prerequisites before dispatch", async () => {
	const sink = makeSink();
	const host = makeHost({ manifest: MANIFEST, sink });
	const plan = {
		version: "aegis-plan-1.0",
		plan_id: "plan-diamond",
		root_goal_ref: "root",
		tasks: [planNode("t-a"), planNode("t-b"), planNode("t-c", { depends_on: ["t-a", "t-b"] })],
	};
	await admitCandidatePlan({
		plan,
		manifest: MANIFEST,
		host,
		projection: { tasks: [], budget: { reserved: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 } } },
		templates: TEMPLATES,
	});
	// The stored dependency set reaches both the scheduler-facing projection and the
	// task graph.
	const gated = projectQueueFromEvents({
		campaign_id: MANIFEST.campaign_id,
		tasks: MANIFEST.tasks,
		events: sink.events,
		revision: 1,
		manifest: MANIFEST,
		artifacts: makeArtifacts(["t-a", "t-b", "t-c"]),
	});
	assert.deepEqual(
		gated.tasks.find((t) => t.task_id === "t-c").depends_on,
		["t-a", "t-b"],
		"the projection keeps the joint dependency set",
	);
	const { worker, calls } = makeFixtureWorker();
	const oracle = makeOracle({
		"task-plan": { status: "success" },
		"t-a": { status: "success" },
		"t-b": { status: "success" },
		"t-c": { status: "success" },
	});
	const owned = MANIFEST.tasks;
	const scheduler = createCampaignScheduler({
		manifest: MANIFEST,
		ownedTasks: owned,
		baseDir: null,
		sink,
		worker,
		oracle,
		clock: () => 1000,
		artifacts: makeArtifacts(["t-a", "t-b", "t-c", "task-plan"]),
	});
	const result = await scheduler.run();
	assert.equal(result.ok, true, JSON.stringify(result.reasons ?? []));
	// Scheduling order must respect the DAG: t-c only after BOTH t-a and t-b.
	assert.equal(calls.includes("t-c"), true, "the diamond successor runs once both prerequisites complete");
	assert.ok(calls.indexOf("t-c") > calls.indexOf("t-a"), "t-c runs after t-a");
	assert.ok(calls.indexOf("t-c") > calls.indexOf("t-b"), "t-c runs after t-b");
	const finalProjection = projectQueueFromEvents({
		campaign_id: MANIFEST.campaign_id,
		tasks: MANIFEST.tasks,
		events: sink.events,
		revision: 1,
		manifest: MANIFEST,
		artifacts: makeArtifacts(["t-a", "t-b", "t-c", "task-plan"]),
	});
	for (const id of ["t-a", "t-b", "t-c"])
		assert.equal(finalProjection.tasks.find((t) => t.task_id === id).state, "completed", `${id} completed`);
});

test("E1-PLAN: an unsatisfied prerequisite blocks the successor provider/effect", async () => {
	const sink = makeSink();
	const host = makeHost({ manifest: MANIFEST, sink });
	const plan = {
		version: "aegis-plan-1.0",
		plan_id: "plan-blocked",
		root_goal_ref: "root",
		tasks: [planNode("t-a"), planNode("t-c", { depends_on: ["t-a"] })],
	};
	await admitCandidatePlan({
		plan,
		manifest: MANIFEST,
		host,
		projection: { tasks: [], budget: { reserved: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 } } },
		templates: TEMPLATES,
	});
	const { worker, calls } = makeFixtureWorker();
	// t-a produces an UNKNOWN result → it does not complete → t-c must not run.
	const oracle = makeOracle({ "t-a": { status: "unknown" } });
	const scheduler = createCampaignScheduler({
		manifest: MANIFEST,
		ownedTasks: MANIFEST.tasks,
		baseDir: null,
		sink,
		worker,
		oracle,
		clock: () => 1000,
		artifacts: makeArtifacts(["t-a", "t-c", "task-plan"]),
	});
	await scheduler.run();
	assert.equal(calls.includes("t-a"), true, "the predecessor still ran");
	assert.equal(calls.includes("t-c"), false, "a successor with an unsatisfied prerequisite must NOT dispatch");
});

test("E1-PLAN: an illegal node rejects the whole batch and runs no legal subset", async () => {
	const sink = makeSink();
	const host = makeHost({ manifest: MANIFEST, sink });
	const plan = {
		version: "aegis-plan-1.0",
		plan_id: "plan-bad",
		root_goal_ref: "root",
		tasks: [planNode("t-a"), planNode("t-bad", { target_ref: "unauthorized.txt" })],
	};
	const outcome = await admitCandidatePlan({
		plan,
		manifest: MANIFEST,
		host,
		projection: { tasks: [], budget: { reserved: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 } } },
		templates: TEMPLATES,
	});
	assert.equal(outcome.ok, false);
	assert.equal(outcome.status, "blocked");
	const projection = projectQueueFromEvents({
		campaign_id: MANIFEST.campaign_id,
		tasks: MANIFEST.tasks,
		events: sink.events,
		revision: 1,
		manifest: MANIFEST,
		artifacts: {},
	});
	assert.equal(projection.tasks.length, 1, "no partial batch is applied");
	const { worker, calls } = makeFixtureWorker();
	const scheduler = createCampaignScheduler({
		manifest: MANIFEST,
		ownedTasks: MANIFEST.tasks,
		baseDir: null,
		sink,
		worker,
		oracle: makeOracle({}),
		clock: () => 1000,
		artifacts: {},
	});
	await scheduler.run();
	assert.deepEqual(
		calls.filter((id) => id !== "task-plan"),
		[],
		"no business task runs from a rejected batch",
	);
});

test("E1-GRAPH: the tree and the dependency DAG come from the same committed stream", async () => {
	const sink = makeSink();
	const host = makeHost({ manifest: MANIFEST, sink });
	const plan = {
		version: "aegis-plan-1.0",
		plan_id: "plan-graph",
		root_goal_ref: "root",
		tasks: [
			planNode("t-a", { parent_task_id: "task-plan" }),
			planNode("t-b", { parent_task_id: "t-a" }),
			planNode("t-c", { parent_task_id: "t-a", depends_on: ["t-a", "t-b"] }),
		],
	};
	await admitCandidatePlan({
		plan,
		manifest: MANIFEST,
		host,
		projection: { tasks: [], budget: { reserved: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 } } },
		templates: TEMPLATES,
	});
	const projection = projectQueueFromEvents({
		campaign_id: MANIFEST.campaign_id,
		tasks: MANIFEST.tasks,
		events: sink.events,
		revision: 1,
		manifest: MANIFEST,
		artifacts: makeArtifacts(["t-a", "t-b", "t-c"]),
	});
	const graph = buildTaskGraph({ manifest: MANIFEST, projection });
	assert.equal(graph.root.kind, "goal_container");
	assert.equal(graph.root.goal, MANIFEST.objective.description);
	const tc = graph.nodes.find((n) => n.task_id === "t-c");
	assert.equal(tc.parent_task_id, "t-a", "parentage (split source) preserved");
	assert.deepEqual(tc.depends_on, ["t-a", "t-b"], "dependencies (execution prerequisites) preserved");
	assert.deepEqual(
		graph.prerequisites["t-c"],
		["t-a", "t-b"],
		"the prerequisites index carries the joint dependency set",
	);
	assert.deepEqual(graph.prerequisites["t-b"], [], "a child of t-a has no execution prerequisite of its own");
	assert.equal(tc.depends_on.length, 2, "the second prerequisite is not swallowed by the tree");
	// Two separate relations.
	const parentEdges = graph.edges.filter((e) => e.relation === "parent_of");
	const depEdges = graph.edges.filter((e) => e.relation === "depends_on");
	assert.ok(parentEdges.some((e) => e.from === "task:t-a" && e.to === "task:t-c"));
	assert.ok(depEdges.some((e) => e.from === "task:t-a" && e.to === "task:t-c"));
	assert.ok(depEdges.some((e) => e.from === "task:t-b" && e.to === "task:t-c"));
});

test("E1-PLAN: different plans produce different graphs (not hardcoded)", () => {
	const a = validatePlanGraph({
		plan: {
			version: "aegis-plan-1.0",
			plan_id: "p-a",
			root_goal_ref: "root",
			tasks: [planNode("x-1"), planNode("x-2", { depends_on: ["x-1"] })],
		},
		manifest: MANIFEST,
		planningTaskId: "task-plan",
		existingTaskIds: new Set(["task-plan"]),
		templates: TEMPLATES,
		requiredCriteria: ROOT_CRITERIA,
	});
	const b = validatePlanGraph({
		plan: {
			version: "aegis-plan-1.0",
			plan_id: "p-b",
			root_goal_ref: "root",
			tasks: [planNode("y-1"), planNode("y-2"), planNode("y-3", { depends_on: ["y-1", "y-2"] })],
		},
		manifest: MANIFEST,
		planningTaskId: "task-plan",
		existingTaskIds: new Set(["task-plan"]),
		templates: TEMPLATES,
		requiredCriteria: ROOT_CRITERIA,
	});
	assert.equal(a.status, "admitted");
	assert.equal(b.status, "admitted");
	assert.notDeepEqual(
		a.normalized.map((t) => t.task_id),
		b.normalized.map((t) => t.task_id),
	);
	assert.equal(b.normalized.length, 3);
});

test("E1-PLAN: submitting a plan is a candidate record; it never asserts root completion", async () => {
	const { createPlanSubmitTool } = await import("../memory/campaign/c6-model-worker.mjs");
	const recorded = [];
	const tool = createPlanSubmitTool({
		sdk: { defineTool: (x) => x },
		buffer: { pushPlan: (p) => recorded.push(p), listPlans: () => recorded },
		type: { Object: (x) => x, String: () => ({}), Array: (x) => x, Number: () => ({}), Optional: (x) => x },
		planLimits: { max_tasks: 24 },
		recordPlan: async () => ({ ok: true }),
	});
	const result = await tool.execute("t1", {
		plan_id: "p1",
		root_goal_ref: "root",
		tasks: [
			{
				proposed_task_id: "t-a",
				parent_task_id: "task-plan",
				depends_on: [],
				goal: { description: "d", success_criteria: ROOT_CRITERIA },
				task_type: "verify",
				target_ref: "dataset.json",
				required_capabilities: ["data.record.write"],
				expected_evidence: ["artifact:t-a"],
				stop_condition: "j",
				priority: 1,
				budget_reservation: { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
			},
		],
	});
	assert.equal(result.details.recorded, 1);
	assert.equal(recorded.length, 1);
	// The tool return text must NOT claim admission or root completion.
	assert.match(result.content[0].text, /does not execute anything and does not mean the goal is complete/);
	assert.equal(Object.hasOwn(result.details, "root_goal_complete"), false);
});
