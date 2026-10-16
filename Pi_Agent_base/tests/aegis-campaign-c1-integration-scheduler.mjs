#!/usr/bin/env node
// Aegis C1 Integration closure — scheduler tests (INT-COMMIT / INT-BUDGET /
// INT-DYNAMIC dispatch / INT-RECOVERY control / INT-CHECKPOINT via the scheduler).
//
// Uses a FAKE sink/worker/oracle and a controlled clock. Where the case is about
// DURABILITY it uses the REAL EventLog (see the eventlog-durability suite and T4).
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-integration-scheduler.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildFixtureCampaign,
	createCampaignScheduler,
	FIXTURE_SCOPE,
	projectQueueFromEvents,
} from "../campaign/index.mjs";

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
const root = mkdtempSync(join(tmpdir(), "aegis-c1int-sched-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

/** A recording sink. `failOn(kind)` may return a failure MODE for a kind. */
function makeSink({ failOn = null } = {}) {
	const events = [];
	let seq = 0;
	return {
		events,
		async append(event) {
			const mode = failOn?.(event.payload?.kind, event);
			if (mode === "fail") return { ok: false, error: "injected append failure" };
			if (mode === "nondurable") return { ok: true, event: null, durable: false };
			if (mode === "throw") throw new Error("injected append throw");
			const row = { ...event, event_id: `e${seq}`, sequence: seq, event_digest: `sha256:e${seq}` };
			seq += 1;
			events.push(row);
			return { ok: true, event: row, durable: true };
		},
		replay: () => events.slice(),
	};
}

function artifactsFor(tasks) {
	const out = {};
	for (const task of tasks)
		out[`artifact:${task.task_id}`] = { ref_id: `artifact:${task.task_id}`, digest: `sha256:syn-${task.task_id}` };
	return out;
}

/** A bound success/unknown judgment for a task. */
function judged(taskId, task, status = "success", extra = {}) {
	const bound = status === "success" || status === "failure";
	const stage_outcomes = bound
		? (task?.stages ?? []).map((stage) => ({
				step_id: stage.stage_id,
				status,
				outcome_id: `so-${taskId}-${stage.stage_id}`,
				outcome: {
					outcome_id: `so-${taskId}-${stage.stage_id}`,
					level: "step",
					step_id: stage.stage_id,
					status,
					episode_id: `ep-${taskId}`,
					task_id: taskId,
					criterion: { criterion_id: stage.criteria?.[0] ?? null, expected: stage.criteria?.[0] ?? null },
					observed: { synthetic: true },
					scope: { ...FIXTURE_SCOPE },
					oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
					provenance: { source: "oracle", independent: true, task_id: taskId, stage_id: stage.stage_id },
					evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${taskId}` }],
				},
			}))
		: [];
	return {
		status,
		outcome_id: `o-${taskId}`,
		task_oracle: true,
		stage_outcomes,
		...extra,
		outcome: {
			outcome_id: `o-${taskId}`,
			level: "episode",
			status,
			episode_id: `ep-${taskId}`,
			task_id: taskId,
			task_oracle: true,
			criterion: { criterion_id: task.goal?.goal_id ?? null, expected: task.goal?.goal_id ?? null },
			observed: bound ? { synthetic: true } : null,
			scope: { ...FIXTURE_SCOPE },
			oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
			provenance: { source: "oracle", independent: true, task_id: taskId },
			evidence_refs: bound ? [{ ref_type: "artifact", ref_id: `artifact:${taskId}` }] : [],
		},
	};
}

function fixture() {
	const f = buildFixtureCampaign();
	return { fixture: f, manifest: f.manifest, taskA: f.manifest.tasks[0], taskB: f.manifest.tasks[1] };
}

// ---------------------------------------------------------------------------
// INT-COMMIT / C1EXT-02
// ---------------------------------------------------------------------------

await test("COMMIT-BEFORE: a failed durable intent does not call the worker", async () => {
	const { manifest, taskA } = fixture();
	const sink = makeSink({ failOn: (kind) => (kind === "campaign.task.started" ? "fail" : null) });
	let workerCalls = 0;
	const s = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir: null,
		sink,
		worker: {
			async run() {
				workerCalls += 1;
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([taskA]),
		clock: () => 1,
		acquireOwnership: false,
	});
	const r = await s.run();
	assert.equal(workerCalls, 0);
	assert.equal(r.ok, false);
});

await test("COMMIT-BUDGET: a failed budget charge after the effect is degraded, not ok", async () => {
	const { manifest, taskA } = fixture();
	const sink = makeSink({ failOn: (kind) => (kind === "campaign.budget.consumed" ? "fail" : null) });
	let workerCalls = 0;
	const s = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir: null,
		sink,
		worker: {
			async run() {
				workerCalls += 1;
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([taskA]),
		clock: () => 1,
		acquireOwnership: false,
	});
	const r = await s.run();
	assert.equal(workerCalls, 1);
	assert.equal(r.ok, false, "the run must not report success");
	assert.ok(r.reasons.some((reason) => /charge failed/i.test(reason)));
	// The task must NOT be completed.
	assert.notEqual(r.status.tasks[0].state, "completed");
});

await test("COMMIT-RESULT: a failed oracle-result commit leaves the task unresolved", async () => {
	const { manifest, taskA } = fixture();
	const sink = makeSink({ failOn: (kind) => (kind === "campaign.oracle.result" ? "fail" : null) });
	const s = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir: null,
		sink,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([taskA]),
		clock: () => 1,
		acquireOwnership: false,
	});
	const r = await s.run();
	assert.equal(r.ok, false);
	assert.notEqual(r.status.tasks[0].state, "completed");
});

await test("COMMIT-UNKNOWN: a non-durable append is not treated as durable", async () => {
	const { manifest, taskA } = fixture();
	const sink = makeSink({ failOn: (kind) => (kind === "campaign.oracle.result" ? "nondurable" : null) });
	const s = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir: null,
		sink,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([taskA]),
		clock: () => 1,
		acquireOwnership: false,
	});
	const r = await s.run();
	assert.equal(r.ok, false);
	assert.notEqual(r.status.tasks[0].state, "completed");
});

await test("COMMIT-CONTROL: a failed control append does not claim a durable stop", async () => {
	const { manifest, taskA } = fixture();
	const sink = makeSink({ failOn: (kind) => (kind === "campaign.campaign.cancelled" ? "fail" : null) });
	const s = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir: null,
		sink,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([taskA]),
		clock: () => 1,
		acquireOwnership: false,
	});
	const cancel = await s.cancel();
	assert.equal(cancel.ok, false, "a failed cancel must not be reported as durable");
});

await test("COMMIT-CLEANUP: a throwing sink cleans up and does not run the worker", async () => {
	const { manifest, taskA } = fixture();
	const sink = makeSink({ failOn: (kind) => (kind === "campaign.task.started" ? "throw" : null) });
	let workerCalls = 0;
	const s = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir: null,
		sink,
		worker: {
			async run() {
				workerCalls += 1;
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([taskA]),
		clock: () => 1,
		acquireOwnership: false,
	});
	const r = await s.run();
	assert.equal(workerCalls, 0);
	assert.equal(r.ok, false);
});

await test("COMMIT-SINGLEFLIGHT: a concurrent run on one instance is refused", async () => {
	const { manifest, taskA } = fixture();
	const sink = makeSink();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const s = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir: null,
		sink,
		worker: {
			async run() {
				await gate;
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([taskA]),
		clock: () => 1,
		acquireOwnership: false,
	});
	const first = s.run();
	const second = await s.run();
	assert.equal(second.ok, false);
	assert.ok(second.reasons.some((reason) => /single-flight/i.test(reason)));
	release();
	await first;
});

// ---------------------------------------------------------------------------
// INT-BUDGET / C1EXT-06
// ---------------------------------------------------------------------------

await test("BUD-ZERO: a task with zero reservation is not dispatched", async () => {
	const { manifest } = fixture();
	const zero = structuredClone(manifest);
	zero.tasks[0].task_budget = { wall_time_ms: 0, model_requests: 0, tool_calls: 0 };
	const sink = makeSink();
	let workerCalls = 0;
	const s = createCampaignScheduler({
		manifest: zero,
		ownedTasks: [zero.tasks[0]],
		baseDir: null,
		sink,
		worker: {
			async run() {
				workerCalls += 1;
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([zero.tasks[0]]),
		clock: () => 1,
		acquireOwnership: false,
	});
	const r = await s.run();
	assert.equal(workerCalls, 0, "no borrowing from the Campaign remaining");
	assert.ok(r.reasons.some((reason) => /blocked|holds/i.test(reason)));
});

await test("BUD-POS: a dispatch charges the known synthetic cost and leaves the rest held", async () => {
	const { manifest } = fixture();
	const owned = structuredClone(manifest);
	owned.tasks[0].task_budget = { wall_time_ms: 100, model_requests: 3, tool_calls: 3 };
	const sink = makeSink();
	const s = createCampaignScheduler({
		manifest: owned,
		ownedTasks: [owned.tasks[0]],
		baseDir: null,
		sink,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([owned.tasks[0]]),
		budgetAccount: { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
		clock: () => 1,
		acquireOwnership: false,
	});
	const r = await s.run();
	const projection = projectQueueFromEvents({
		campaign_id: owned.campaign_id,
		tasks: [owned.tasks[0]],
		events: sink.events,
		manifest: owned,
		artifacts: artifactsFor([owned.tasks[0]]),
	});
	assert.equal(projection.budget.consumed.model_requests, 1);
	assert.equal(projection.budget.reserved.model_requests, 2, "the rest stays outstanding");
	assert.equal(r.status.tasks[0].state, "completed");
});

await test("BUD-FAIL: a worker failure still records the known synthetic cost", async () => {
	const { manifest } = fixture();
	const owned = structuredClone(manifest);
	owned.tasks[0].task_budget = { wall_time_ms: 100, model_requests: 3, tool_calls: 3 };
	const sink = makeSink();
	const s = createCampaignScheduler({
		manifest: owned,
		ownedTasks: [owned.tasks[0]],
		baseDir: null,
		sink,
		worker: {
			async run() {
				return { ok: false, failure_mode: "transport_failure" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([owned.tasks[0]]),
		clock: () => 1,
		acquireOwnership: false,
	});
	await s.run();
	const projection = projectQueueFromEvents({
		campaign_id: owned.campaign_id,
		tasks: [owned.tasks[0]],
		events: sink.events,
		manifest: owned,
		artifacts: artifactsFor([owned.tasks[0]]),
	});
	assert.equal(projection.budget.consumed.model_requests, 1, "a failed run still costs");
	assert.notEqual(projection.tasks[0].state, "failed");
	assert.equal(projection.tasks[0].state, "unknown");
});

// ---------------------------------------------------------------------------
// INT-RECOVERY / C1EXT-07 — control state from events + real recovery
// ---------------------------------------------------------------------------

await test("CTRL-CANCEL: a durable cancel survives a restart", async () => {
	const { manifest, taskA } = fixture();
	const baseDir = join(root, "ctrl-cancel");
	const sink = makeSink();
	let workerCalls = 0;
	const mk = () =>
		createCampaignScheduler({
			manifest,
			ownedTasks: [taskA],
			baseDir,
			sink,
			worker: {
				async run() {
					workerCalls += 1;
					return { ok: true, outcome_ref: "a" };
				},
			},
			oracle: {
				async judge({ task }) {
					return judged(task.task_id, task);
				},
			},
			artifacts: artifactsFor([taskA]),
			clock: () => 1,
		});
	const first = mk();
	await first.cancel();
	await first.run();
	const second = mk();
	const r = await second.run();
	assert.equal(workerCalls, 0, "a cancelled campaign is not revived");
	assert.equal(r.status.campaign_state, "cancelled");
});

await test("CTRL-PAUSE: a durable pause requires an explicit resume", async () => {
	const { manifest, taskA } = fixture();
	const sink = makeSink();
	let workerCalls = 0;
	const mk = () =>
		createCampaignScheduler({
			manifest,
			ownedTasks: [taskA],
			baseDir: null,
			sink,
			worker: {
				async run() {
					workerCalls += 1;
					return { ok: true, outcome_ref: "a" };
				},
			},
			oracle: {
				async judge({ task }) {
					return judged(task.task_id, task);
				},
			},
			artifacts: artifactsFor([taskA]),
			clock: () => 1,
			acquireOwnership: false,
		});
	const s = mk();
	await s.pause();
	const paused = await s.run();
	assert.equal(workerCalls, 0);
	assert.equal(paused.status.campaign_state, "paused");
	await s.resume();
	await s.run();
	assert.equal(workerCalls, 1, "an explicit resume continues");
});

await test("REC-DONE: a durable result with a missing completion is completed on restart", async () => {
	const { manifest, taskA } = fixture();
	const sink = makeSink({
		failOn: (kind) => (kind === "campaign.task.completed" ? "fail" : null),
	});
	let workerCalls = 0;
	const s1 = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir: null,
		sink,
		worker: {
			async run() {
				workerCalls += 1;
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([taskA]),
		clock: () => 1,
		acquireOwnership: false,
	});
	await s1.run();
	// The result is durable; completion is missing. Restart with completion allowed.
	const sink2 = makeSink();
	sink2.events.push(...sink.events);
	const s2 = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir: null,
		sink: sink2,
		worker: {
			async run() {
				workerCalls += 1;
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([taskA]),
		clock: () => 1,
		acquireOwnership: false,
	});
	const r = await s2.run();
	assert.equal(workerCalls, 1, "the worker is not re-run to backfill the lifecycle");
	assert.equal(r.status.tasks[0].state, "completed");
});

// ---------------------------------------------------------------------------
// INT-CHECKPOINT / C1EXT-03
// ---------------------------------------------------------------------------

await test("CKP-POS: a matching checkpoint is used and used_checkpoint is true", async () => {
	const { manifest, taskA } = fixture();
	const baseDir = join(root, "ckp-pos");
	const sink = makeSink();
	const mk = () =>
		createCampaignScheduler({
			manifest,
			ownedTasks: [taskA],
			baseDir,
			sink,
			worker: {
				async run() {
					return { ok: true, outcome_ref: "a" };
				},
			},
			oracle: {
				async judge({ task }) {
					return judged(task.task_id, task);
				},
			},
			artifacts: artifactsFor([taskA]),
			clock: () => 1,
		});
	await mk().run();
	// Re-run against the SAME committed stream: a matching checkpoint is used.
	const r = await mk().run();
	assert.equal(r.used_checkpoint, true);
});

await test("CKP-FOREIGN: a checkpoint whose stored offset digest diverges is not used", async () => {
	const { manifest, taskA } = fixture();
	const baseDir = join(root, "ckp-foreign");
	const sink = makeSink();
	const s1 = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir,
		sink,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([taskA]),
		clock: () => 1,
	});
	await s1.run();
	// Mutate the event AT the checkpoint's recorded offset so the stored prefix
	// digest no longer matches the stream: a tampered/divergent prefix is refused.
	const cpPath = join(baseDir, manifest.campaign_id, "checkpoint.json");
	const cp = JSON.parse(readFileSync(cpPath, "utf8"));
	if (cp.stream_offset >= 0 && sink.events[cp.stream_offset]) {
		sink.events[cp.stream_offset] = { ...sink.events[cp.stream_offset], event_digest: "sha256:diverged" };
	}
	const s2 = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA],
		baseDir,
		sink,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge({ task }) {
				return judged(task.task_id, task);
			},
		},
		artifacts: artifactsFor([taskA]),
		clock: () => 1,
	});
	const r = await s2.run();
	assert.equal(r.used_checkpoint, false, "a divergent prefix must fall back to full replay");
});

await test("CKP-PREFIX: a valid prefix checkpoint plus its tail equals the full replay", async () => {
	const { manifest, taskA } = fixture();
	const baseDir = join(root, "ckp-prefix");
	const sink = makeSink();
	const mk = () =>
		createCampaignScheduler({
			manifest,
			ownedTasks: [taskA],
			baseDir,
			sink,
			worker: {
				async run() {
					return { ok: true, outcome_ref: "a" };
				},
			},
			oracle: {
				async judge({ task }) {
					return judged(task.task_id, task);
				},
			},
			artifacts: artifactsFor([taskA]),
			clock: () => 1,
		});
	await mk().run();
	// Append a benign event so the checkpoint is a PREFIX of the stream.
	await sink.append({
		event_type: "runtime.note",
		source: { kind: "runtime" },
		payload: { kind: "campaign.proposal.blocked", campaign_id: manifest.campaign_id, proposal_id: "p" },
	});
	const r = await mk().run();
	assert.equal(r.used_checkpoint, true, "a valid prefix is used");
	assert.equal(r.status.tasks[0].state, "completed", "prefix+tail reproduces the full state");
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 integration scheduler: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 integration scheduler: all assertions passed");
