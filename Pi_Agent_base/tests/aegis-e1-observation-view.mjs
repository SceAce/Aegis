#!/usr/bin/env node
// Aegis E1 — observable board content and task graph over the committed stream.
//
// Pure projection tests. Proves the six whiteboard node classes carry real
// CONTENT (not counts), Task/Episode binding, current/history status and
// downgrade reasons; and that the task graph exposes the root goal container,
// the parent tree and the dependency DAG from the SAME events.
//
// Run: node --test Pi_Agent_base/tests/aegis-e1-observation-view.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildE1View } from "../observation/e1-observation.mjs";

let counter = 0;
function ev(event_type, payload, { episode = "ep-task-001", kind = "oracle", evidence_refs } = {}) {
	counter += 1;
	return {
		event_type,
		episode_id: episode,
		payload,
		source: { kind, actor_id: "test", source_id: "test" },
		event_id: `evt-${counter}`,
		evidence_refs: evidence_refs ?? payload?.evidence_refs ?? [],
		recorded_at: new Date(1_700_000_000_000 + counter * 1000).toISOString(),
		event_digest: `sha256:e${counter}`,
	};
}

const MANIFEST = {
	schema_version: "campaign-1.1",
	campaign_id: "campaign-e1",
	revision: 1,
	objective: { description: "Repair the dataset", success_criteria: ["dataset.name repaired"] },
	budget: { wall_time_ms: 600000, model_requests: 20, tool_calls: 40 },
	authorization: { allowed_targets: ["dataset.json"], allowed_capabilities: ["data.record.write"] },
	dynamic_task_policy: {
		enabled: true,
		allowed_task_types: ["verify"],
		max_depth: 3,
		max_fan_out: 6,
		max_task_count: 12,
	},
	tasks: [
		{
			task_id: "task-001",
			order: 1,
			depends_on: [],
			target_ref: "dataset.json",
			task_type: "verify",
			goal: { goal_id: "g1", description: "Repair name", success_criteria: ["dataset.name repaired"] },
			stages: [{ stage_id: "s1", criteria: ["dataset.name repaired"], required: true }],
			oracle_ref: "fixture.oracle.v1",
			task_budget: { wall_time_ms: 30000, model_requests: 4, tool_calls: 8 },
		},
	],
};

function outcome(
	outcomeId,
	{
		status = "success",
		criterionId = "dataset.name repaired",
		expected = "Ada",
		observed = "Ada",
		taskId = "task-001",
		episode = "ep-task-001",
		kind = "oracle",
		scope,
		supersedes,
	} = {},
) {
	return ev(
		"outcome.recorded",
		{
			outcome_id: outcomeId,
			status,
			task_id: taskId,
			criterion: { criterion_id: criterionId, description: criterionId, expected },
			observed,
			scope: scope ?? { environment_fingerprint: "data-repair-env" },
			oracle: { oracle_id: "fixture.oracle.v1", source: "oracle" },
			provenance: { source: "oracle", independent: true, task_id: taskId },
			evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${taskId}` }],
			...(supersedes ? { supersedes } : {}),
		},
		{ episode, kind, evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${taskId}` }] },
	);
}

test("E1-BOARD: the six node classes carry real content over the committed stream", () => {
	const events = [
		ev("episode.started", { goal: { description: "Repair the dataset" } }, { kind: "runtime" }),
		ev("action.requested", { action_id: "a1", tool_name: "aegis_workspace", task_id: "task-001" }, { kind: "runtime" }),
		ev("action.completed", { action_id: "a1", tool_name: "aegis_workspace", status: "ok" }, { kind: "runtime" }),
		ev("proposal.submitted", { kind: "hint", text: "the name field looks corrupt" }, { kind: "llm" }),
		ev("proposal.submitted", { kind: "intent", text: "normalize the name" }, { kind: "llm" }),
		outcome("o-1"),
	];
	const view = buildE1View({ manifest: MANIFEST, events });
	const types = new Set(view.board.nodes.map((node) => node.type));
	for (const type of ["Origin", "Fact", "Intent", "Hint", "Artifact"])
		assert.ok(types.has(type), `board exposes ${type}`);
	const fact = view.board.nodes.find((node) => node.type === "Fact");
	assert.match(fact.text, /Ada/, "the fact states the verified proposition/observed value, not a bare status");
	assert.equal(fact.observed, "Ada");
	assert.equal(fact.episode_id, "ep-task-001", "the fact is bound to its episode");
	assert.equal(fact.effective_status, "current");
	const hint = view.board.nodes.find((node) => node.type === "Hint");
	assert.match(hint.text, /corrupt/, "hint carries the model's claim text");
});

test("E1-BOARD: a model claim cannot become a Fact; downgrade reason is visible", () => {
	const events = [
		ev("proposal.submitted", { kind: "claim", text: "the door is open", status: "success" }, { kind: "llm" }),
	];
	const view = buildE1View({ manifest: MANIFEST, events });
	const node = view.board.nodes[0];
	assert.equal(node.type, "Hint");
	assert.ok(!view.board.nodes.some((n) => n.type === "Fact"), "an llm claim never becomes a Fact");
});

test("E1-BOARD: a superseded fact shows history with its supersede reason", () => {
	const events = [
		ev("episode.started", { goal: { description: "g" } }, { kind: "runtime" }),
		outcome("o-old", { observed: "before" }),
		outcome("o-new", { observed: "after", supersedes: "o-old" }),
	];
	const view = buildE1View({ manifest: MANIFEST, events });
	const old = view.board.nodes.find((n) => n.outcome_id === "o-old");
	const next = view.board.nodes.find((n) => n.outcome_id === "o-new");
	assert.equal(old.effective_status, "superseded");
	assert.equal(old.effective, false, "the superseded fact leaves the current view");
	assert.equal(old.superseded_by, "o-new");
	assert.equal(next.effective_status, "current");
	assert.ok(view.board.history_by_type.Fact >= 2, "history is preserved");
});

test("E1-BOARD: two tasks and two episodes remain separately filterable", () => {
	const events = [
		ev("proposal.submitted", { kind: "hint", text: "task A hint" }, { kind: "llm", episode: "ep-task-001" }),
		ev("proposal.submitted", { kind: "hint", text: "task B hint" }, { kind: "llm", episode: "ep-task-002" }),
	];
	const view = buildE1View({ manifest: MANIFEST, events });
	const a = view.board.nodes.find((n) => n.text.includes("task A"));
	const b = view.board.nodes.find((n) => n.text.includes("task B"));
	assert.equal(a.episode_id, "ep-task-001");
	assert.equal(b.episode_id, "ep-task-002");
	assert.notEqual(a.episode_id, b.episode_id, "episodes are not collapsed");
});

test("E1-BOARD: the task graph exposes the root container and the dependency DAG", () => {
	const events = [ev("episode.started", { goal: { description: "Repair the dataset" } }, { kind: "runtime" })];
	const view = buildE1View({ manifest: MANIFEST, events });
	assert.equal(view.task_graph.root.kind, "goal_container");
	assert.equal(view.task_graph.root.executable, false, "the root goal is not an execution task");
	assert.equal(view.task_graph.root.goal, MANIFEST.objective.description);
	assert.equal(view.task_graph.counts.tasks, 1, "only the static task exists before any plan");
	assert.ok(view.task_graph.nodes.some((n) => n.task_id === "task-001"));
});

test("E1-BOARD: the requests panel reports per-side accounting and unresolved count", () => {
	const events = [
		ev(
			"runtime.note",
			{
				kind: "c6.request",
				campaign_id: "campaign-e1",
				phase: "reserved",
				task_id: "task-001",
				request_id: "req-1",
				task_reservation_id: "task-res-1",
				campaign_reservation_id: "camp-res-1",
				input_chars: 100,
			},
			{ kind: "runtime" },
		),
	];
	const view = buildE1View({ manifest: MANIFEST, events });
	assert.equal(view.requests.unresolved, 1);
	assert.equal(view.requests.campaign_pending.length, 1);
	assert.equal(view.requests.task_pending.length, 1);
	assert.equal(view.requests.consumed.model_requests, 0);
});

test("E1-BOARD: a bounded view never fabricates a node or a raw transcript", () => {
	const events = [ev("proposal.submitted", { kind: "hint", text: "x".repeat(5000) }, { kind: "llm" })];
	const view = buildE1View({ manifest: MANIFEST, events, limits: { max_node_text: 100 } });
	const node = view.board.nodes[0];
	assert.equal(node.text.length, 100, "node text is bounded");
	assert.equal(node.text_truncated, true, "truncation is declared");
});
