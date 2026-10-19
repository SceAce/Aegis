import assert from "node:assert/strict";
import { test } from "node:test";
import { createAegisTuiDataSource } from "../observation/tui/data-source.mjs";

function task(id, overrides = {}) {
	return {
		task_id: id,
		order: 1,
		depends_on: [],
		target_ref: "input.json",
		task_type: "verify",
		goal: {
			goal_id: `goal-${id}`,
			description: `Validate ${id}`,
			success_criteria: ["document is valid"],
		},
		stages: [],
		task_budget: { model_requests: 2, tool_calls: 4, wall_time_ms: 30_000 },
		...overrides,
	};
}

const manifest = {
	campaign_id: "campaign-ui-test",
	revision: 1,
	objective: {
		description: "Inspect a document",
		success_criteria: ["document is valid"],
	},
	budget: { model_requests: 4, tool_calls: 8, wall_time_ms: 60_000 },
	tasks: [task("task-inspect")],
};

function makeSource(overrides = {}) {
	return {
		manifest: structuredClone(manifest),
		events: [],
		integrityOk: true,
		taskId: "task-inspect",
		episodeId: null,
		sessionId: "s-ui",
		...overrides,
	};
}

test("snapshot exposes committed task state and bounded counters", () => {
	const source = createAegisTuiDataSource(makeSource);
	const snapshot = source.snapshot();
	assert.equal(snapshot.campaign.id, "campaign-ui-test");
	assert.equal(snapshot.current.taskId, "task-inspect");
	assert.equal(snapshot.current.state, "ready");
	assert.equal(snapshot.current.episodeId, "ep-task-inspect");
	assert.equal(snapshot.integrity.ok, true);
	assert.equal(snapshot.budgets.consumed.tool_calls, 0);
	assert.equal(snapshot.health.stale, false);
	const page = source.taskPage({ revision: snapshot.revision });
	assert.equal(page.total, 1);
	assert.equal(page.returned, 1);
	assert.equal(page.items[0].task_id, "task-inspect");
	assert.equal(page.items[0].state, "ready");
});

test("stale integrity does not expose event-derived board claims", () => {
	const source = createAegisTuiDataSource(() => ({
		...makeSource(),
		integrityOk: false,
	}));
	const snapshot = source.snapshot();
	assert.equal(snapshot.integrity.ok, false);
	assert.equal(snapshot.integrity.status, "integrity_unavailable");
	assert.equal(snapshot.health.stale, true);
	assert.ok(snapshot.health.warnings.some((warning) => /EventLog chain/.test(warning)));
	assert.equal(source.boardPage({ revision: snapshot.revision }).total, 0);
	assert.equal(
		source.evidence().steps.every((step) => step.status === "UNKNOWN"),
		true,
	);
});

test("pages reject a cursor from a different committed revision", () => {
	let revision = 1;
	const source = createAegisTuiDataSource(() => ({
		...makeSource(),
		manifest: { ...manifest, revision },
	}));
	const first = source.snapshot();
	revision = 2;
	assert.throws(
		() =>
			source.taskPage({
				revision: first.revision,
				cursor: `${first.revision}:0`,
			}),
		/state changed/,
	);
});

test("task pages are bounded and carry revision-bound cursors", () => {
	const tasks = Array.from({ length: 8 }, (_, index) => task(`task-${index + 1}`));
	const source = createAegisTuiDataSource(() => makeSource({ manifest: { ...manifest, tasks }, taskId: "task-1" }));
	const snapshot = source.snapshot();
	const first = source.taskPage({ revision: snapshot.revision });
	assert.equal(first.total, 8);
	assert.equal(first.returned, 6);
	assert.equal(first.truncated, true);
	assert.ok(Array.isArray(first.edges), "graph page must expose a bounded edges list");
	assert.ok(first.nextCursor?.startsWith(`${snapshot.revision}|`));
	const second = source.taskPage({
		revision: snapshot.revision,
		cursor: first.nextCursor,
	});
	assert.equal(second.total, 8);
	assert.equal(second.returned, 2);
	assert.equal(second.truncated, false);
});

test("task detail is read from the committed graph projection", () => {
	const source = createAegisTuiDataSource(makeSource);
	const snapshot = source.snapshot();
	const detail = source.detail({
		kind: "task",
		id: "task-inspect",
		revision: snapshot.revision,
	});
	assert.equal(detail.status, "available");
	assert.equal(detail.value.task_id, "task-inspect");
	assert.deepEqual(detail.value.depends_on, []);
});

test("evidence ladder keeps request, transport, judgement, and Outcome distinct", () => {
	const events = [
		{
			event_type: "action.requested",
			episode_id: "ep-task-inspect",
			source: { kind: "runtime" },
			payload: {},
		},
		{ event_type: "outcome.recorded", payload: { status: "success" } },
	];
	const source = createAegisTuiDataSource(() => ({
		...makeSource(),
		episodeId: "ep-task-inspect",
		events,
	}));
	const steps = source.evidence().steps;
	assert.equal(steps[0].status, "PARTIAL");
	assert.match(steps[0].proves, /只记录了动作请求/);
	assert.equal(steps[1].status, "NOT RUN");
	assert.equal(steps[2].status, "NOT RUN");
	assert.equal(steps[3].status, "NOT RUN");
});

test("recent events exclude session noise and keep committed action/proposal events", () => {
	const events = [
		{
			event_type: "session.started",
			episode_id: null,
			source: { kind: "runtime" },
		},
		{
			event_type: "action.completed",
			episode_id: "ep-task-inspect",
			source: { kind: "runtime" },
			sequence: 0,
		},
		{
			event_type: "proposal.submitted",
			episode_id: "ep-task-inspect",
			source: { kind: "llm" },
			sequence: 1,
		},
	];
	const source = createAegisTuiDataSource(() => ({ ...makeSource(), events }));
	const recent = source.snapshot().recent;
	assert.equal(recent.length, 2);
	assert.ok(recent.some((event) => event.event_type === "action.completed"));
	assert.ok(recent.some((event) => event.event_type === "proposal.submitted"));
	assert.ok(recent.every((event) => event.event_type !== "session.started"));
});

test("board pages preserve type, trust, and effective/history fields", () => {
	const events = [
		{
			event_type: "proposal.submitted",
			episode_id: "ep-ui",
			sequence: 0,
			event_id: "evt-ui-proposal",
			event_digest: "sha256:not-authoritative-test-row",
			occurred_at: "2026-01-01T00:00:00.000Z",
			source: { kind: "llm", actor_id: "test", source_id: "test" },
			payload: {
				proposal_id: "p-ui",
				kind: "hint",
				text: "Check schema",
				task_id: "task-inspect",
			},
		},
	];
	const source = createAegisTuiDataSource(() => ({ ...makeSource(), events }));
	const snapshot = source.snapshot();
	const board = source.boardPage({ revision: snapshot.revision });
	assert.equal(board.total, 1);
	const node = board.items[0];
	assert.equal(node.type, "Hint");
	assert.equal(node.effective_status, "current");
	assert.equal(typeof node.text, "string");
	const detail = source.detail({
		kind: "board-node",
		id: node.node_id,
		revision: snapshot.revision,
	});
	assert.equal(detail.status, "available");
	assert.equal(detail.value.type, "Hint");
});

test("absent source and unknown detail are explicit, never fabricated", () => {
	const source = createAegisTuiDataSource(() => ({
		manifest: null,
		events: [],
		integrityOk: false,
		taskId: null,
		episodeId: null,
		sessionId: null,
	}));
	const snapshot = source.snapshot();
	assert.equal(snapshot.integrity.ok, false);
	assert.equal(snapshot.integrity.status, "manifest_unavailable");
	assert.ok(snapshot.health.warnings.some((warning) => /Manifest/.test(warning)));
	assert.equal(snapshot.campaign.id, null);
	assert.equal(source.taskPage({ revision: snapshot.revision }).total, 0);
	const missing = source.detail({
		kind: "task",
		id: "not-a-task",
		revision: snapshot.revision,
	});
	assert.equal(missing.status, "not_found");
});

test("data source requires a read function and does not mutate committed input", () => {
	assert.throws(() => createAegisTuiDataSource(null), /readCommitted/);
	const committed = makeSource();
	const before = JSON.stringify(committed);
	const source = createAegisTuiDataSource(() => committed);
	source.snapshot();
	source.taskPage({ revision: source.snapshot().revision });
	assert.equal(JSON.stringify(committed), before);
});
