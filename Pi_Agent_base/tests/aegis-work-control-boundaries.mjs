import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrokerWorker } from "../execution/broker-worker.mjs";
import { createWorkController, inspectWorkPermit, projectWorkControl } from "../orchestration/work-control.mjs";
import { digest } from "../shared/events.mjs";

function fixture() {
	const policy = { target_ref: "document", criteria: ["review"] };
	const rows = [];
	function row(event_type, payload, episode_id = "ep") {
		const event = {
			event_id: `event-${rows.length}`,
			event_type,
			payload,
			episode_id,
			source: { kind: "runtime" },
			recorded_at: new Date().toISOString(),
		};
		rows.push(event);
		return event;
	}
	row("episode.started", { task_id: "task", work_contract: policy });
	row("action.requested", { action_id: "read-1", tool_name: "read", arguments_digest: digest({ path: "document" }) });
	const done = row("action.completed", { action_id: "read-1", tool_name: "read" });
	const input = { target_ref: "document", criterion_id: "review", evidence_event_ids: [done.event_id] };
	const append = async (r) => ({ ok: true, durable: true, event: row(r.event_type, r.payload, r.episode_id) });
	const controller = (extra = {}) =>
		createWorkController({ events: () => rows, append, taskId: "task", episodeId: "ep", ...extra });
	return { rows, row, policy, input, controller };
}
test("distinct controllers serialize conflicting submissions and reviewed identity cannot be reused", async () => {
	const f = fixture();
	const results = await Promise.all([f.controller().submit(f.input), f.controller().submit(f.input)]);
	assert.equal(results.filter((r) => r.duplicate).length, 1);
	assert.equal(f.rows.filter((r) => r.payload.kind === "work.candidate").length, 1);
	assert.equal((await f.controller().resume("review rejected", "human", true)).ok, true);
	const length = f.rows.length;
	assert.equal((await f.controller().submit(f.input)).ok, false);
	assert.equal(f.rows.length, length);
});
test("invalid, conflicting and removed frozen contracts deny all execution", () => {
	for (const next of [
		{ ...fixture().policy, max_tool_calls: 0 },
		{ target_ref: "other", criteria: ["review"] },
		null,
	]) {
		const f = fixture();
		f.row("episode.started", { task_id: "task", work_contract: next }, "new-ep");
		assert.equal(inspectWorkPermit({ events: f.rows, taskId: "task", toolName: "bash" }).ok, false);
	}
});
test("failed fsync resume remains held even when EventLog retains the row", async () => {
	const f = fixture();
	assert.equal((await f.controller().submit(f.input)).ok, true);
	const c = f.controller({
		append: async (r) => ({ ok: false, durable: false, event: f.row(r.event_type, r.payload, r.episode_id) }),
	});
	assert.equal((await c.resume("continue", "human")).ok, false);
	assert.equal(projectWorkControl(f.rows, "task").state, "waiting_external");
	assert.equal(inspectWorkPermit({ events: f.rows, taskId: "task", toolName: "read" }).ok, false);
});
test("non-durable candidate retained by EventLog holds but is never a successful duplicate", async () => {
	const f = fixture();
	const c = f.controller({
		append: async (r) => ({ ok: false, durable: false, event: f.row(r.event_type, r.payload, r.episode_id) }),
	});
	assert.equal((await c.submit(f.input)).ok, false);
	assert.equal(projectWorkControl(f.rows, "task").state, "waiting_external");
	assert.equal((await f.controller().submit(f.input)).ok, false);
	assert.equal((await f.controller().resume("continue", "human")).ok, false);
});
test("pending or unknown actions and unfinished charged tools prevent trusted resume", async () => {
	for (const responsibility of ["pending", "unknown", "tool"]) {
		const f = fixture();
		assert.equal((await f.controller().submit(f.input)).ok, true);
		if (responsibility === "tool")
			f.row("runtime.note", {
				kind: "c6.tool",
				phase: "charged",
				task_id: "task",
				episode_id: "ep",
				request_id: "req",
				tool_call_id: "call",
				unit_id: "call",
			});
		else {
			f.row("action.requested", { action_id: "unsettled" });
			if (responsibility === "unknown") f.row("action.completed", { action_id: "unsettled", status: "unknown" });
		}
		assert.equal((await f.controller().resume("continue", "human")).ok, false, responsibility);
		assert.equal(projectWorkControl(f.rows, "task").state, "waiting_external");
	}
});
test("Broker waiting permit refuses before intent append or invoke", async () => {
	const f = fixture();
	assert.equal((await f.controller().submit(f.input)).ok, true);
	let invoked = 0;
	let appended = 0;
	const worker = createBrokerWorker({
		broker: {
			invoke: async () => {
				invoked++;
				return { ok: true };
			},
			registry: new Map(),
		},
		authorization: {},
		workspaceRoot: "/unused",
		artifactIndex: new Map(),
		plan: { task_id: "task", steps: [{ step_id: "step", action_ref: "registered", arguments: {} }] },
		sink: {
			replay: () => f.rows,
			append: async () => {
				appended++;
				return { ok: true };
			},
		},
	});
	const result = await worker.run({ task: { task_id: "task" } });
	assert.equal(result.ok, false);
	assert.equal(result.failure_mode, "waiting_external");
	assert.equal(invoked, 0);
	assert.equal(appended, 0);
});
test("verification allowance pins read-only name and exact arguments; outputs never alter control", async () => {
	const f = fixture();
	f.policy.verification_calls = [{ tool_name: "read", arguments_digest: digest({ path: "document" }) }];
	assert.equal((await f.controller().submit(f.input)).ok, true);
	assert.equal(
		inspectWorkPermit({
			events: f.rows,
			taskId: "task",
			toolName: "read",
			argumentsDigest: digest({ path: "document" }),
		}).ok,
		true,
	);
	assert.equal(
		inspectWorkPermit({ events: f.rows, taskId: "task", toolName: "read", argumentsDigest: digest({ path: "other" }) })
			.ok,
		false,
	);
	assert.equal(
		inspectWorkPermit({
			events: f.rows,
			taskId: "task",
			toolName: "bash",
			argumentsDigest: digest({ path: "document" }),
		}).ok,
		false,
	);
});
