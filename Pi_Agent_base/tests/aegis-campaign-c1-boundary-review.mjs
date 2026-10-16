#!/usr/bin/env node
// Independent follow-up to F10-F13. No model/network; real EventLog is used
// for Stage reconciliation and checkpoint product paths. Run with node --test.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCampaignScheduler, projectQueueFromEvents } from "../campaign/index.mjs";
import { EventLog } from "../shared/events.mjs";

const campaignId = "campaign-boundary-review";
const episodeId = "episode-local";
const scope = { env: "local" };
const task = {
	task_id: "task-a",
	order: 1,
	depends_on: [],
	scope,
	goal: { goal_id: "goal-a", success_criteria: ["criterion-a"] },
	stages: [{ stage_id: "stage-a", criteria: ["criterion-a"], required: true }],
	task_budget: { wall_time_ms: 10, model_requests: 10, tool_calls: 10 },
};
const artifacts = { "artifact:a": { digest: "digest:a" } };
function result(stage, patch = {}) {
	return {
		outcome_id: stage ? "stage-result" : "task-result",
		level: stage ? "step" : "episode",
		status: "success",
		task_id: task.task_id,
		episode_id: episodeId,
		...(stage ? { step_id: "stage-a" } : { task_oracle: true }),
		criterion: { criterion_id: stage ? "criterion-a" : "goal-a", expected: true },
		observed: { value: true },
		scope,
		oracle: { oracle_id: "oracle-local", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: task.task_id },
		evidence_refs: [{ ref_id: "artifact:a", digest: "digest:a" }],
		...patch,
	};
}
function event(kind, payload = {}, source = "runtime") {
	return {
		schema_version: "1.1",
		event_type: "runtime.note",
		source: { kind: source },
		payload: { campaign_id: campaignId, task_id: task.task_id, kind, ...payload },
	};
}
function judged(outcome, patch = {}) {
	return event(
		"campaign.oracle.result",
		{
			outcome_id: outcome.outcome_id,
			status: outcome.status,
			episode_id: episodeId,
			...(outcome.step_id ? { step_id: outcome.step_id } : { task_oracle: true }),
			outcome,
			...patch,
		},
		"oracle",
	);
}
function rows(events) {
	return events.map((e, i) => ({ ...e, event_id: `e-${i}`, sequence: i, event_digest: `digest:${i}` }));
}
function started() {
	return event("campaign.task.started", { episode_id: episodeId });
}
function project(events, priorState = null) {
	return projectQueueFromEvents({ campaign_id: campaignId, tasks: [task], events, artifacts, priorState });
}
function completed(stage, reconcile = false, stageEnvelope = {}) {
	return project(
		rows([
			started(),
			judged(stage, stageEnvelope),
			judged(result(false)),
			event(reconcile ? "campaign.reconciliation.resolved" : "campaign.task.completed", { outcome_id: "task-result" }),
		]),
	);
}

test("CONTROL: complete independent provenance permits both completion paths", () => {
	for (const reconcile of [false, true]) assert.equal(completed(result(true), reconcile).tasks[0].state, "completed");
});
for (const provenance of [undefined, null]) {
	for (const reconcile of [false, true]) {
		test(`F14: ${String(provenance)} Stage provenance cannot complete ${reconcile ? "reconciliation" : "normal"} path`, () => {
			const p = completed(result(true, { provenance }), reconcile);
			assert.notEqual(p.tasks[0].state, "completed", "oracle.source does not supply missing independence proof");
		});
	}
}
for (const reconcile of [false, true]) {
	test(`F14: foreign inner Stage id cannot be rebound by the ${reconcile ? "reconciliation" : "normal"} event envelope`, () => {
		const p = completed(result(true, { step_id: "stage-foreign" }), reconcile, { step_id: "stage-a" });
		assert.notEqual(p.tasks[0].state, "completed", "canonicalization must not relabel a foreign Stage Outcome");
	});
}

test("F15: applying checkpoint tail must not mutate the caller's cached reservation", () => {
	const charge = event("campaign.budget.consumed", {
		command_id: "charge-1",
		consumed: { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
	});
	const events = rows([started(), charge]);
	const prefix = project(events.slice(0, 1));
	const priorState = structuredClone({
		queue: prefix.tasks,
		budget: prefix.budget,
		control: prefix.control,
		proposals: [],
		outcomes: [],
		applied_commands: prefix.applied_commands,
		applied_outcomes: prefix.applied_outcomes,
		tail_offset: 0,
	});
	const before = structuredClone(priorState);
	const restored = project(events, priorState);
	assert.equal(restored.budget.consumed.model_requests, 1, "the tail is really applied");
	assert.deepEqual(priorState, before, "hydration must not share mutable reservation objects");
});

for (const [name, patch] of [
	["complete binding", {}],
	["missing provenance", { provenance: null }],
	["foreign inner Stage id", { step_id: "stage-foreign" }],
]) {
	test(`F14-PRODUCT: real reconciliation rejects ${name} only when invalid`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "aegis-c1-stage-review-"));
		const log = new EventLog(join(dir, "events.jsonl"));
		let workerCalls = 0;
		try {
			assert.equal((await log.open()).ok, true);
			assert.equal((await log.append(started())).ok, true);
			const scheduler = createCampaignScheduler({
				manifest: { campaign_id: campaignId, revision: 1, budget: {}, tasks: [task] },
				ownedTasks: [task],
				baseDir: null,
				acquireOwnership: false,
				artifacts,
				sink: { append: (e) => log.append(e), replay: () => log.replay() },
				worker: {
					async run() {
						workerCalls += 1;
						return { ok: true };
					},
				},
				oracle: {
					async reconcile() {
						return {
							status: "success",
							outcome_id: "task-result",
							outcome: result(false),
							stage_outcomes: [
								{ step_id: "stage-a", status: "success", outcome_id: "stage-result", outcome: result(true, patch) },
							],
						};
					},
				},
			});
			const run = await scheduler.run();
			assert.equal(workerCalls, 0);
			if (name === "complete binding") assert.equal(run.status.tasks[0].state, "completed");
			else assert.notEqual(run.status.tasks[0].state, "completed", name);
		} finally {
			await log.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
}

test("F16: accepted real prefix checkpoint drives scheduler execution without replaying the prefix", async () => {
	const dir = await mkdtemp(join(tmpdir(), "aegis-c1-cache-review-"));
	const log = new EventLog(join(dir, "events.jsonl"));
	const manifest = { campaign_id: campaignId, revision: 1, budget: {}, tasks: [task] };
	try {
		assert.equal((await log.open()).ok, true);
		for (const e of [
			started(),
			judged(result(true)),
			judged(result(false)),
			event("campaign.task.completed", { outcome_id: "task-result" }),
			event("campaign.campaign.cancelled"),
		]) {
			assert.equal((await log.append(e)).ok, true);
		}
		const first = createCampaignScheduler({
			manifest,
			ownedTasks: [task],
			baseDir: dir,
			acquireOwnership: false,
			artifacts,
			sink: { append: (e) => log.append(e), replay: () => log.replay() },
			worker: {
				run() {
					throw new Error("completed task must not run");
				},
			},
			oracle: {},
		});
		await first.run();
		assert.equal(first.lastCheckpointOk(), true, "real checkpoint writer succeeded");
		assert.equal((await log.append(event("campaign.campaign.resumed"))).ok, true, "a changing tail is committed");
		// Allow one authority-validation replay of the prefix, but not repeated
		// full reductions in the scheduler loop, checkpoint and final status.
		let oneReplayReads = 0;
		const referenceRows = log.replay();
		referenceRows[0] = new Proxy(referenceRows[0], {
			get(target, key, receiver) {
				if (key === "payload") oneReplayReads += 1;
				return Reflect.get(target, key, receiver);
			},
		});
		project(referenceRows);
		assert.ok(oneReplayReads > 0);
		let prefixPayloadReads = 0;
		const second = createCampaignScheduler({
			manifest,
			ownedTasks: [task],
			baseDir: dir,
			acquireOwnership: false,
			artifacts,
			sink: {
				append: (e) => log.append(e),
				replay() {
					const committed = log.replay();
					committed[0] = new Proxy(committed[0], {
						get(target, key, receiver) {
							if (key === "payload") prefixPayloadReads += 1;
							return Reflect.get(target, key, receiver);
						},
					});
					return committed;
				},
			},
			worker: {
				run() {
					throw new Error("completed task must not run");
				},
			},
			oracle: {},
		});
		const resumed = await second.run();
		assert.equal(resumed.used_checkpoint, true, "the prefix cache was accepted");
		assert.equal(resumed.status.control.state, "running", "the changed tail was applied");
		assert.equal(resumed.status.tasks[0].state, "completed");
		assert.ok(
			prefixPayloadReads <= oneReplayReads,
			`accepted cache must drive subsequent loop/status/checkpoint; prefix reads ${prefixPayloadReads} exceed one validation replay (${oneReplayReads})`,
		);
	} finally {
		await log.close();
		await rm(dir, { recursive: true, force: true });
	}
});
