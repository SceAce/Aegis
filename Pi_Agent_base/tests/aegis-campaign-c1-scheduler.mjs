#!/usr/bin/env node
// Aegis Campaign C1-D scheduler control-loop tests.
//
// Uses a FAKE worker, FAKE oracle and a CONTROLLED clock. No real Pi Session, no
// Broker, no network, no OS side effect.
//
// Covers:
//   * durable-before-dispatch: an event-write failure prevents the worker call;
//   * pause / resume / cancel / budget-stop halt new dispatch;
//   * a transport failure becomes `unknown`, never task failure;
//   * a delayed oracle leaves the task waiting and blocks dependents.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-scheduler.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildFixtureCampaign,
	canonicalManifestDigest,
	projectQueueFromEvents,
	readCheckpoint,
	createCampaignScheduler as realCreateCampaignScheduler,
	writeCheckpoint,
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
const root = mkdtempSync(join(tmpdir(), "aegis-campaign-c1-sched-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

/** A recording fake event sink with an injectable failure mode. */
function makeSink({ failOn = null } = {}) {
	const events = [];
	let seq = 0;
	return {
		events,
		async append(event) {
			if (failOn?.(event)) return { ok: false, error: "injected event-log failure" };
			const row = { ...event, event_id: `e${seq}`, sequence: seq, event_digest: `sha256:e${seq}` };
			seq += 1;
			events.push(row);
			return { ok: true, event: row, durable: true };
		},
	};
}

/**
 * Wrap the scheduler so every test gets a resolvable synthetic artifact index
 * for the tasks it owns. This keeps the tests focused on scheduler behaviour
 * while satisfying the trusted-Outcome evidence requirement.
 */
function createCampaignScheduler(options) {
	const owned = options.ownedTasks ?? [];
	const artifacts = { ...(options.artifacts ?? {}) };
	for (const task of owned)
		artifacts[`artifact:${task.task_id}`] = {
			ref_id: `artifact:${task.task_id}`,
			digest: `sha256:synthetic-${task.task_id}`,
		};
	return realCreateCampaignScheduler({ ...options, artifacts });
}

/** A resolvable synthetic artifact index for one task (real temp file in T4). */
function artifactsFor(taskId) {
	return { [`artifact:${taskId}`]: { ref_id: `artifact:${taskId}`, digest: `sha256:synthetic-${taskId}` } };
}

const TASK_SCOPE = { environment_fingerprint: "fixture-env", domain: "fixture" };

function makeFixture() {
	const fixture = buildFixtureCampaign();
	const manifest = fixture.manifest;
	// F10: every task needs a trusted CURRENT scope; the fixture historically had
	// none, so declare one here (all tasks share the fixture environment).
	for (const task of manifest.tasks) if (task.scope == null) task.scope = { ...TASK_SCOPE };
	const workerCalls = [];
	const worker = {
		async run({ task }) {
			workerCalls.push(task.task_id);
			// Deterministic success marker per task.
			return { ok: true, outcome_ref: `artifact:${task.task_id}` };
		},
	};
	return { fixture, manifest, worker, workerCalls };
}

/**
 * A deterministic oracle returning per-task scripted outcomes. A `success`/
 * `failure` entry is expanded into a FULLY BOUND Outcome (criterion, scope,
 * observed, evidence ref) so the projection's trusted resolver accepts it.
 */
function makeOracle(script) {
	return {
		id: "synthetic.oracle",
		async judge({ task }) {
			const entry = script[task.task_id];
			if (!entry) return { status: "unknown", failure_mode: "no_rule" };
			if (entry.outcome) return entry;
			const bound = entry.status === "success" || entry.status === "failure";
			// Stage-level judgments so a task with required stages can complete (F3).
			const stageOutcomes = bound
				? (task.stages ?? []).map((stage) => ({
						step_id: stage.stage_id,
						status: entry.status,
						outcome_id: `so-${task.task_id}-${stage.stage_id}`,
						outcome: {
							outcome_id: `so-${task.task_id}-${stage.stage_id}`,
							level: "step",
							step_id: stage.stage_id,
							status: entry.status,
							episode_id: `ep-${task.task_id}`,
							task_id: task.task_id,
							criterion: { criterion_id: stage.criteria?.[0] ?? null, expected: stage.criteria?.[0] ?? null },
							observed: { synthetic: true },
							scope: { ...TASK_SCOPE },
							oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
							provenance: { source: "oracle", independent: true, task_id: task.task_id, stage_id: stage.stage_id },
							evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${task.task_id}` }],
						},
					}))
				: [];
			return {
				...entry,
				stage_outcomes: stageOutcomes,
				outcome_id: entry.outcome_id ?? `o-${task.task_id}`,
				// A complete Outcome as the trusted producer would emit it.
				outcome: {
					outcome_id: entry.outcome_id ?? `o-${task.task_id}`,
					level: "episode",
					status: entry.status,
					episode_id: `ep-${task.task_id}`,
					task_id: task.task_id,
					task_oracle: true,
					criterion: { criterion_id: task.goal?.goal_id ?? null, expected: task.goal?.goal_id ?? null },
					observed: bound ? { synthetic: true, task_id: task.task_id } : null,
					scope: entry.scope ?? { ...TASK_SCOPE },
					oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
					provenance: { source: "oracle", independent: true, task_id: task.task_id },
					evidence_refs: bound ? [{ ref_type: "artifact", ref_id: `artifact:${task.task_id}` }] : [],
				},
			};
		},
	};
}

await test("RUN-01: a single-task campaign dispatches, completes, and records audit events", async () => {
	const { manifest, worker, workerCalls } = makeFixture();
	const taskId = manifest.tasks[0].task_id;
	const sink = makeSink();
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [manifest.tasks[0]],
		baseDir: join(root, "s1"),
		sink,
		worker,
		oracle: makeOracle({
			[taskId]: {
				status: "success",
				outcome_id: "o-task1",
				task_oracle: true,
				criterion_id: manifest.tasks[0].goal.goal_id,
			},
		}),
		clock: () => 1000,
	});
	const result = await scheduler.run();
	assert.equal(result.ok, true, JSON.stringify(result.reasons ?? []));
	assert.deepEqual(workerCalls, [taskId], "the worker runs the ready task");
	assert.equal(result.status.tasks.find((t) => t.task_id === taskId).state, "completed");
	// The intent was persisted before the effect: a started event precedes completion.
	const kinds = sink.events.map((e) => e.payload.kind);
	assert.ok(kinds.indexOf("campaign.task.started") < kinds.indexOf("campaign.task.completed"));
});

await test("DUR-01: an event-log failure BEFORE dispatch prevents the worker call", async () => {
	const { manifest, worker, workerCalls } = makeFixture();
	const taskId = manifest.tasks[0].task_id;
	// Fail exactly on the durable intent write.
	const sink = makeSink({ failOn: (event) => event.payload?.kind === "campaign.task.started" });
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [manifest.tasks[0]],
		baseDir: join(root, "s2"),
		sink,
		worker,
		oracle: makeOracle({ [taskId]: { status: "success", outcome_id: "o", task_oracle: true } }),
		clock: () => 1000,
	});
	const result = await scheduler.run();
	assert.equal(workerCalls.length, 0, "the worker must NOT run when the durable intent failed");
	assert.equal(result.ok, false);
	assert.ok(
		result.reasons.some((r) => /durab|intent|event/i.test(r)),
		JSON.stringify(result.reasons),
	);
});

await test("RUN-01: pause stops new dispatch until resumed", async () => {
	const { manifest, worker, workerCalls } = makeFixture();
	const taskId = manifest.tasks[0].task_id;
	const sink = makeSink();
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [manifest.tasks[0]],
		baseDir: join(root, "s3"),
		sink,
		worker,
		oracle: makeOracle({ [taskId]: { status: "success", outcome_id: "o", task_oracle: true } }),
		clock: () => 1000,
	});
	await scheduler.pause();
	const paused = await scheduler.run();
	assert.equal(workerCalls.length, 0, "a paused scheduler dispatches nothing");
	assert.equal(paused.status.campaign_state, "paused");
	await scheduler.resume();
	await scheduler.run();
	assert.equal(workerCalls.length, 1, "resume allows dispatch");
});

await test("RUN-01: cancel stops new dispatch and never claims task failure", async () => {
	const { manifest, worker, workerCalls } = makeFixture();
	const taskId = manifest.tasks[0].task_id;
	const sink = makeSink();
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [manifest.tasks[0]],
		baseDir: join(root, "s4"),
		sink,
		worker,
		oracle: makeOracle({ [taskId]: { status: "success", outcome_id: "o", task_oracle: true } }),
		clock: () => 1000,
	});
	await scheduler.cancel();
	const result = await scheduler.run();
	assert.equal(workerCalls.length, 0);
	assert.equal(result.status.campaign_state, "cancelled");
	// No task is marked a failure by cancellation.
	assert.ok(result.status.tasks.every((t) => t.state !== "failed"));
	assert.ok(sink.events.some((e) => e.payload.kind === "campaign.campaign.cancelled"));
});

await test("RUN-01: budget exhaustion stops new dispatch and records a budget stop", async () => {
	const { manifest, worker, workerCalls } = makeFixture();
	const taskId = manifest.tasks[0].task_id;
	const sink = makeSink();
	// A campaign whose budget is already fully consumed by a prior dispatch: seed a
	// consumed event so the live ledger reports no fundable remaining budget.
	const zeroBudget = structuredClone(manifest);
	for (const task of zeroBudget.tasks) task.scope = { ...TASK_SCOPE };
	zeroBudget.budget.model_requests = 1;
	zeroBudget.budget.wall_time_ms = 200000;
	zeroBudget.tasks[0].task_budget = { wall_time_ms: 100000, model_requests: 1, tool_calls: 1 };
	const consumedSeed = {
		schema_version: "1.1",
		event_type: "runtime.note",
		event_id: "seed",
		sequence: 0,
		source: { kind: "runtime", actor_id: "seed" },
		payload: {
			kind: "campaign.budget.consumed",
			campaign_id: zeroBudget.campaign_id,
			task_id: zeroBudget.tasks[0].task_id,
			command_id: "seed-consume",
			consumed: { wall_time_ms: 100000, model_requests: 1, tool_calls: 1 },
		},
		event_digest: "sha256:seed",
	};
	sink.events.push(consumedSeed);
	const scheduler = createCampaignScheduler({
		manifest: zeroBudget,
		ownedTasks: [zeroBudget.tasks[0]],
		baseDir: join(root, "s5"),
		sink,
		worker,
		oracle: makeOracle({ [taskId]: { status: "success", outcome_id: "o", task_oracle: true } }),
		clock: () => 1000,
		budgetAccount: { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
	});
	const result = await scheduler.run();
	assert.equal(workerCalls.length, 0, "no dispatch when the budget is exhausted");
	assert.equal(result.status.campaign_state, "budget_stopped");
	assert.ok(
		sink.events.some((e) => e.payload.kind === "campaign.campaign.stopped" && e.payload.reason === "budget_exhausted"),
	);
});

await test("RUN-UNKNOWN: a worker transport failure becomes unknown, never task failure", async () => {
	const { manifest } = makeFixture();
	const taskId = manifest.tasks[0].task_id;
	const sink = makeSink();
	const failingWorker = {
		async run() {
			return { ok: false, failure_mode: "transport_failure", error: "connection reset" };
		},
	};
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [manifest.tasks[0]],
		baseDir: join(root, "s6"),
		sink,
		worker: failingWorker,
		oracle: makeOracle({ [taskId]: { status: "success", outcome_id: "o", task_oracle: true } }),
		clock: () => 1000,
	});
	const result = await scheduler.run();
	const task = result.status.tasks.find((t) => t.task_id === taskId);
	assert.equal(task.state, "unknown", "transport failure is unknown");
	assert.notEqual(task.state, "failed");
	// Reconciliation is requested, not a blind retry.
	assert.ok(sink.events.some((e) => e.payload.kind === "campaign.reconciliation.requested"));
});

await test("RUN-UNKNOWN: a delayed oracle leaves the task waiting and blocks dependents", async () => {
	const { manifest, worker, workerCalls } = makeFixture();
	const [taskA, taskB] = manifest.tasks;
	const sink = makeSink();
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA, taskB],
		baseDir: join(root, "s7"),
		sink,
		worker,
		oracle: makeOracle({
			[taskA.task_id]: { status: "unknown", outcome_id: "o-a", task_oracle: true, delayed: true },
			[taskB.task_id]: { status: "success", outcome_id: "o-b", task_oracle: true },
		}),
		clock: () => 1000,
	});
	const result = await scheduler.run();
	const byId = new Map(result.status.tasks.map((t) => [t.task_id, t]));
	assert.equal(byId.get(taskA.task_id).state, "unknown");
	assert.notEqual(byId.get(taskB.task_id).state, "completed", "a dependent task must not run on an unknown dependency");
	assert.ok(!workerCalls.includes(taskB.task_id), "dependent worker must not be dispatched");
});

await test("BUD-10/BUD-16: the scheduler reads the projection ledger and stops at the limit", async () => {
	// A Manifest whose model_requests budget is fully consumed by the first
	// dispatch. The scheduler must stop dispatching from the REAL ledger, not from
	// an injected budgetExhausted() callback (which stays false here).
	const fixture = buildFixtureCampaign();
	const manifest = structuredClone(fixture.manifest);
	for (const task of manifest.tasks) task.scope = { ...TASK_SCOPE };
	const [taskA, taskB] = manifest.tasks;
	// taskA may consume one model request; taskB may consume none. The Campaign
	// limit is exactly one request, so only the first dispatch fits.
	taskA.task_budget = { wall_time_ms: 100000, model_requests: 1, tool_calls: 1 };
	taskB.task_budget = { wall_time_ms: 100000, model_requests: 0, tool_calls: 0 };
	manifest.budget.model_requests = 1;
	const workerCalls = [];
	const sink = makeSink();
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [taskA, taskB],
		baseDir: join(root, "bud-ledger"),
		sink,
		worker: {
			async run({ task }) {
				workerCalls.push(task.task_id);
				return { ok: true, outcome_ref: `a:${task.task_id}` };
			},
		},
		oracle: makeOracle({
			[taskA.task_id]: { status: "success", outcome_id: "o-a", task_oracle: true },
			[taskB.task_id]: { status: "success", outcome_id: "o-b", task_oracle: true },
		}),
		// Consume the whole model_requests limit on each dispatch; the scheduler must
		// observe this via the projection ledger.
		budgetAccount: { model_requests: 1 },
		clock: () => 1000,
		acquireOwnership: false,
	});
	const result = await scheduler.run();
	assert.equal(workerCalls.length, 1, `only one task may run within the 1-request budget, got ${workerCalls.length}`);
	assert.equal(result.status.campaign_state, "budget_stopped");
});

await test("CKP-10/CKP-11: the scheduler writes a checkpoint bound to the event tail", async () => {
	const fixture = buildFixtureCampaign();
	const manifest = fixture.manifest;
	const taskId = manifest.tasks[0].task_id;
	const sink = makeSink();
	const baseDir = join(root, "ckp-write");
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [manifest.tasks[0]],
		baseDir,
		sink,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: makeOracle({ [taskId]: { status: "success", outcome_id: "o", task_oracle: true } }),
		clock: () => 1000,
	});
	await scheduler.run();
	scheduler.releaseOwnership();
	const read = readCheckpoint(baseDir, manifest.campaign_id, {
		manifest_digest: canonicalManifestDigest(manifest),
		revision: manifest.revision,
	});
	assert.equal(read.ok, true, read.reason);
	assert.equal(Number.isInteger(read.checkpoint.stream_offset), true);
	assert.equal(typeof read.checkpoint.last_event_digest, "string");
	assert.equal(typeof read.checkpoint.projection_digest, "string");
	assert.equal(read.checkpoint.manifest_digest, canonicalManifestDigest(manifest));
});

await test("CKP-12: a checkpoint whose tail digest mismatches the event log is rejected", () => {
	const fixture = buildFixtureCampaign();
	const manifest = fixture.manifest;
	const baseDir = join(root, "ckp-tail");
	writeCheckpoint(baseDir, manifest.campaign_id, {
		campaign_id: manifest.campaign_id,
		manifest_digest: canonicalManifestDigest(manifest),
		revision: manifest.revision,
		last_event_sequence: 99,
		last_event_digest: "sha256:not-the-tail",
		projection_digest: "sha256:whatever",
	});
	const read = readCheckpoint(baseDir, manifest.campaign_id, {
		manifest_digest: canonicalManifestDigest(manifest),
		revision: manifest.revision,
		expected_tail_digest: "sha256:real-tail",
	});
	assert.equal(read.ok, false, "a mismatched tail digest must not be usable");
	assert.ok(/tail/i.test(read.reason), read.reason);
});

await test("CKP-13: a checkpoint write failure leaves the event log authoritative", async () => {
	const fixture = buildFixtureCampaign();
	const manifest = fixture.manifest;
	for (const task of manifest.tasks) task.scope = { ...TASK_SCOPE };
	const taskId = manifest.tasks[0].task_id;
	const sink = makeSink();
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [manifest.tasks[0]],
		baseDir: join(root, "ckp-fail"),
		sink,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: makeOracle({ [taskId]: { status: "success", outcome_id: "o", task_oracle: true } }),
		clock: () => 1000,
		// Inject a failing checkpoint writer.
		writeCheckpointImpl: () => ({ ok: false, reason: "injected checkpoint failure" }),
	});
	const result = await scheduler.run();
	// The task still completed from the event log; the checkpoint failure is
	// reported but never turned into a false "checkpoint updated".
	assert.equal(result.status.tasks.find((t) => t.task_id === taskId).state, "completed");
	assert.equal(scheduler.lastCheckpointOk(), false);
});

await test("CKP-15: rebuild from checkpoint+tail equals a full replay", async () => {
	const fixture = buildFixtureCampaign();
	const manifest = fixture.manifest;
	for (const task of manifest.tasks) task.scope = { ...TASK_SCOPE };
	const taskId = manifest.tasks[0].task_id;
	const sink = makeSink();
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [manifest.tasks[0]],
		baseDir: join(root, "ckp-rebuild"),
		sink,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: makeOracle({ [taskId]: { status: "success", outcome_id: "o", task_oracle: true } }),
		clock: () => 1000,
	});
	await scheduler.run();
	scheduler.releaseOwnership();
	const full = projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: [manifest.tasks[0]],
		events: sink.events,
		manifest,
		revision: manifest.revision,
		artifacts: artifactsFor(taskId),
	});
	assert.equal(full.tasks[0].state, "completed");
	assert.ok(full.tail_digest, "the projection exposes the last committed digest");
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 scheduler: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 scheduler: all assertions passed");
