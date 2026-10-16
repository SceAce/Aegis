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
import { buildPlanningContract } from "../memory/campaign/e1-planning-contract.mjs";
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

const TEMPLATE_LIST = [
	{
		template_ref: "verify",
		task_type: "verify",
		oracle_ref: "fixture.oracle.v1",
		required_capabilities: ["data.record.write"],
		success_criteria: ROOT_CRITERIA,
		scope: SCOPE,
	},
	{
		template_ref: "reproduce",
		task_type: "reproduce",
		oracle_ref: "fixture.oracle.v1",
		required_capabilities: ["data.record.write"],
		success_criteria: ROOT_CRITERIA,
		scope: SCOPE,
	},
];
const TEMPLATES = templatesFromConfig({ templates: TEMPLATE_LIST });
// FIXTURE MIGRATION (E1-CC §4.2/§6.1): plan admission is only executable under
// the Manifest's FROZEN planning contract, and the Host compiles every candidate
// itself (it never trusts a caller-supplied admission). The Manifest therefore
// embeds the contract and every plan uses the frozen root reference.
const CONTRACT = buildPlanningContract({
	manifest: MANIFEST,
	templates: TEMPLATE_LIST,
	requiredCriteria: ROOT_CRITERIA,
});
assert.equal(CONTRACT.ok, true, JSON.stringify(CONTRACT.reasons));
MANIFEST.planning_contract = CONTRACT.contract;
const ROOT = CONTRACT.contract.root_goal_ref;

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

/**
 * The planning Task submits its candidate through the REAL Host command while it
 * is the active started Task (as the product composite worker does).
 */
function makeFixtureWorker({ plan = null, host = () => null } = {}) {
	const calls = [];
	return {
		calls,
		worker: {
			async run({ task }) {
				calls.push(task.task_id);
				if (task.task_id === "task-plan" && plan) {
					const admitted = await admitCandidatePlan({ plan, host: host() });
					if (!admitted.ok) return { ok: false, failure_mode: "plan_not_admitted", error: admitted.reasons.join("; ") };
				}
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

/**
 * The REAL Host commands over the shared sink, with the planning Task already the
 * active started Task (the precondition of a Host plan command). Its
 * `completePlanningTask` writes the independent plan_ready Oracle result and the
 * durable completion, then releases the gate through the real Scheduler.
 */
function makeHost({ manifest, sink }) {
	const commit = (kind, payload, source) => {
		const row = {
			event_type: "runtime.note",
			source,
			payload: { kind, campaign_id: manifest.campaign_id, ...payload },
			event_id: `h${sink.events.length}`,
			event_digest: `sha256:h${sink.events.length}`,
			recorded_at: new Date(1000).toISOString(),
		};
		sink.events.push(row);
		return row;
	};
	commit(
		"campaign.task.started",
		{ task_id: "task-plan", episode_id: "ep-task-plan" },
		{ kind: "runtime", actor_id: "host" },
	);
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: manifest.tasks,
		baseDir: null,
		sink,
		worker: { run: async () => ({ ok: false }) },
		oracle: { id: "synthetic.oracle", judge: async () => ({ status: "unknown" }) },
		clock: () => 1000,
	});
	return {
		admitPlan: (input) => scheduler.admitPlan(input),
		async completePlanningTask({ taskId, planId }) {
			const plan = sink.events.find(
				(e) => e.payload?.kind === "campaign.plan.admitted" && e.payload.plan_id === planId,
			);
			const evidenceRef = { ref_type: "artifact", ref_id: `artifact:${taskId}`, digest: plan?.payload.plan_digest };
			const base = { episode_id: `ep-${taskId}`, task_id: taskId, scope: SCOPE, evidence_refs: [evidenceRef] };
			const oracle = { oracle_id: "fixture.oracle.v1", source: "oracle" };
			commit(
				"campaign.oracle.result",
				{
					task_id: taskId,
					outcome_id: `so-${taskId}-stage-plan`,
					status: "success",
					step_id: "stage-plan",
					episode_id: `ep-${taskId}`,
					outcome: {
						...base,
						outcome_id: `so-${taskId}-stage-plan`,
						level: "step",
						step_id: "stage-plan",
						status: "success",
						criterion: { criterion_id: "plan_ready", expected: "plan_ready" },
						observed: { plan_id: planId },
						oracle,
						provenance: { source: "oracle", independent: true, task_id: taskId, stage_id: "stage-plan" },
					},
				},
				{ kind: "oracle", actor_id: "oracle" },
			);
			commit(
				"campaign.oracle.result",
				{
					task_id: taskId,
					outcome_id: `o-${taskId}`,
					status: "success",
					task_oracle: true,
					episode_id: `ep-${taskId}`,
					outcome: {
						...base,
						outcome_id: `o-${taskId}`,
						level: "episode",
						status: "success",
						task_oracle: true,
						criterion: { criterion_id: "plan_campaign", expected: "plan_ready" },
						observed: { plan_id: planId },
						oracle,
						provenance: { source: "oracle", independent: true, task_id: taskId },
					},
				},
				{ kind: "oracle", actor_id: "oracle" },
			);
			commit(
				"campaign.task.completed",
				{ task_id: taskId, outcome_id: `o-${taskId}` },
				{ kind: "runtime", actor_id: "host" },
			);
			return scheduler.completePlanningTask({ taskId, planId, outcome: { outcome_id: `o-${taskId}` } });
		},
	};
}

test("E1-PLAN: batch admission creates the DAG and the plan-ready gate is separate", async () => {
	const sink = makeSink();
	const host = makeHost({ manifest: MANIFEST, sink });
	const plan = {
		version: "aegis-plan-1.0",
		plan_id: "plan-1",
		root_goal_ref: ROOT,
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
	// BEFORE any planning completion the children are queued + gated. The batch
	// admission alone never releases them (frozen contract 4.5).
	const gated = projectQueueFromEvents({
		campaign_id: MANIFEST.campaign_id,
		tasks: MANIFEST.tasks,
		events: sink.events,
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
	// A SEPARATE, trusted planning completion (independent plan_ready Oracle result
	// plus the durable Task completion) is what releases the batch.
	const completed = await host.completePlanningTask({ taskId: "task-plan", planId: "plan-1" });
	assert.equal(completed.ok, true);
	projection = projectQueueFromEvents({
		campaign_id: MANIFEST.campaign_id,
		tasks: MANIFEST.tasks,
		events: sink.events,
		revision: 1,
		manifest: MANIFEST,
		artifacts: makeArtifacts(["t-a", "t-b", "t-c", "task-plan"]),
	});
	const ids = projection.tasks.map((t) => t.task_id).sort();
	assert.deepEqual(ids, ["t-a", "t-b", "t-c", "task-plan"]);
	const tc = projection.tasks.find((t) => t.task_id === "t-c");
	assert.deepEqual(tc.depends_on, ["t-a", "t-b"], "multi-prerequisite dependency preserved in the projection");
	assert.equal(tc.awaiting_plan_ready, false, "the plan-ready gate released the children");
	assert.equal(
		projection.tasks.find((t) => t.task_id === "t-b").state,
		"ready",
		"a dependency-free child becomes ready after the gate but is not dispatched",
	);
	const ta = projection.tasks.find((t) => t.task_id === "t-a");
	assert.equal(ta.depends_on.length, 0);
});

test("E1-PLAN: a successor waits for ALL prerequisites before dispatch", async () => {
	const sink = makeSink();
	const plan = {
		version: "aegis-plan-1.0",
		plan_id: "plan-diamond",
		root_goal_ref: ROOT,
		tasks: [planNode("t-a"), planNode("t-b"), planNode("t-c", { depends_on: ["t-a", "t-b"] })],
	};
	// The planning Task admits the candidate through the real Host command.
	let scheduler = null;
	const { worker, calls } = makeFixtureWorker({ plan, host: () => scheduler });
	const oracle = makeOracle({
		"task-plan": { status: "success" },
		"t-a": { status: "success" },
		"t-b": { status: "success" },
		"t-c": { status: "success" },
	});
	const owned = MANIFEST.tasks;
	scheduler = createCampaignScheduler({
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
	// The stored dependency set reaches the scheduler-facing projection.
	assert.deepEqual(
		finalProjection.tasks.find((t) => t.task_id === "t-c").depends_on,
		["t-a", "t-b"],
		"the projection keeps the joint dependency set",
	);
	for (const id of ["t-a", "t-b", "t-c"])
		assert.equal(finalProjection.tasks.find((t) => t.task_id === id).state, "completed", `${id} completed`);
});

test("E1-PLAN: an unsatisfied prerequisite blocks the successor provider/effect", async () => {
	const sink = makeSink();
	const plan = {
		version: "aegis-plan-1.0",
		plan_id: "plan-blocked",
		root_goal_ref: ROOT,
		tasks: [planNode("t-a"), planNode("t-c", { depends_on: ["t-a"] })],
	};
	let scheduler = null;
	const { worker, calls } = makeFixtureWorker({ plan, host: () => scheduler });
	// t-a produces an UNKNOWN result → it does not complete → t-c must not run.
	// task-plan completes normally so the admission batch is released to the
	// dependency scheduler; the point is the unsatisfied PREREQUISITE, not the gate.
	const oracle = makeOracle({ "task-plan": { status: "success" }, "t-a": { status: "unknown" } });
	scheduler = createCampaignScheduler({
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
		root_goal_ref: ROOT,
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
		root_goal_ref: ROOT,
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
			root_goal_ref: ROOT,
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
			root_goal_ref: ROOT,
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
		root_goal_ref: ROOT,
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
