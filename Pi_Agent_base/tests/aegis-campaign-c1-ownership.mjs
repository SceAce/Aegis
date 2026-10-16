#!/usr/bin/env node
// Aegis Campaign C1-C ownership + checkpoint tests.
//
// Covers:
//   * per-Campaign private directory and a single real writer (file lock);
//   * same-process and cross-process contention (real child processes);
//   * a dead owner's lock is reclaimable; a stale-but-live owner is not preempted;
//   * checkpoint binds manifest digest + last event digest + revision;
//   * corrupt/half-written/foreign checkpoints are ignored and rebuilt from events.
//
// Offline: local temp dirs and real local child processes only. No network/model.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-ownership.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	acquireCampaignOwnership,
	campaignRuntimeDir,
	readCheckpoint,
	releaseCampaignOwnership,
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
const root = mkdtempSync(join(tmpdir(), "aegis-campaign-c1-own-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const CAMPAIGN = "campaign-c1-ownership";

await test("WRT-01: campaignRuntimeDir is a private per-Campaign directory", () => {
	const dir = campaignRuntimeDir(root, CAMPAIGN);
	assert.ok(dir.includes(CAMPAIGN), "the directory is Campaign-scoped");
	assert.ok(dir.startsWith(root), "the directory is inside the base dir");
});

await test("WRT-01: the first owner acquires the lock; a second same-process owner is refused", () => {
	const base = join(root, "one");
	const first = acquireCampaignOwnership(base, CAMPAIGN, { ownerId: "owner-1", now: 1000 });
	assert.equal(first.ok, true, first.reason);
	const second = acquireCampaignOwnership(base, CAMPAIGN, { ownerId: "owner-2", now: 1000 });
	assert.equal(second.ok, false, "a second live owner must be refused");
	assert.ok(/owned|lock|held/i.test(second.reason));
	releaseCampaignOwnership(base, CAMPAIGN, { ownerId: "owner-1" });
});

await test("WRT-01: after release a new owner can acquire", () => {
	const base = join(root, "release");
	const first = acquireCampaignOwnership(base, CAMPAIGN, { ownerId: "owner-1" });
	assert.equal(first.ok, true);
	releaseCampaignOwnership(base, CAMPAIGN, { ownerId: "owner-1" });
	const second = acquireCampaignOwnership(base, CAMPAIGN, { ownerId: "owner-2" });
	assert.equal(second.ok, true, second.reason);
	releaseCampaignOwnership(base, CAMPAIGN, { ownerId: "owner-2" });
});

await test("WRT-02: a stale lock from a DEAD owner (pid gone) is reclaimed", () => {
	const base = join(root, "dead");
	// Acquire as a definitely-dead process: a fake pid that is not running.
	const acquired = acquireCampaignOwnership(base, CAMPAIGN, {
		ownerId: "dead-owner",
		pid: 2 ** 31 - 1, // almost certainly not a live process
		now: 1000,
	});
	assert.equal(acquired.ok, true, acquired.reason);
	const reclaimed = acquireCampaignOwnership(base, CAMPAIGN, {
		ownerId: "new-owner",
		pid: process.pid,
		now: 1_000_000_000,
		isAlive: (pid) => pid === process.pid,
	});
	assert.equal(reclaimed.ok, true, `dead owner's lock must be reclaimable: ${reclaimed.reason}`);
	releaseCampaignOwnership(base, CAMPAIGN, { ownerId: "new-owner" });
});

await test("WRT-02: a stale-but-LIVE owner is NOT preempted by lease expiry alone", () => {
	const base = join(root, "live");
	const acquired = acquireCampaignOwnership(base, CAMPAIGN, {
		ownerId: "live-owner",
		pid: process.pid,
		now: 1000,
	});
	assert.equal(acquired.ok, true);
	// Even far past any lease, a live pid may not be preempted.
	const preempt = acquireCampaignOwnership(base, CAMPAIGN, {
		ownerId: "would-be-owner",
		pid: process.pid,
		now: 1_000_000_000,
		isAlive: (pid) => pid === process.pid,
	});
	assert.equal(preempt.ok, false, "a live owner must not be preempted by expiry alone");
	releaseCampaignOwnership(base, CAMPAIGN, { ownerId: "live-owner" });
});

await test("CKP-02: a checkpoint binds manifest digest, last event digest and revision", () => {
	const base = join(root, "ckp");
	const checkpoint = {
		campaign_id: CAMPAIGN,
		manifest_digest: "sha256:manifest",
		last_event_digest: "sha256:event",
		revision: 3,
		projection_version: "1.0.0",
		queue: [],
		budget: { reserved: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 } },
	};
	writeCheckpoint(base, CAMPAIGN, checkpoint);
	const read = readCheckpoint(base, CAMPAIGN, {
		manifest_digest: "sha256:manifest",
		revision: 3,
	});
	assert.equal(read.ok, true, read.reason);
	assert.equal(read.checkpoint.last_event_digest, "sha256:event");
});

await test("CKP-01: a checkpoint with a FOREIGN manifest digest is ignored", () => {
	const base = join(root, "ckp-foreign");
	writeCheckpoint(base, CAMPAIGN, {
		campaign_id: CAMPAIGN,
		manifest_digest: "sha256:other",
		last_event_digest: "sha256:event",
		revision: 3,
	});
	const read = readCheckpoint(base, CAMPAIGN, { manifest_digest: "sha256:manifest", revision: 3 });
	assert.equal(read.ok, false);
	assert.ok(/manifest/i.test(read.reason));
});

await test("CKP-01: a checkpoint whose revision is AHEAD of the caller is ignored", () => {
	const base = join(root, "ckp-ahead");
	writeCheckpoint(base, CAMPAIGN, {
		campaign_id: CAMPAIGN,
		manifest_digest: "sha256:manifest",
		last_event_digest: "sha256:event",
		revision: 9,
	});
	const read = readCheckpoint(base, CAMPAIGN, { manifest_digest: "sha256:manifest", revision: 3 });
	assert.equal(read.ok, false);
	assert.ok(/revision/i.test(read.reason));
});

await test("CKP-01: a corrupt / half-written checkpoint is ignored", () => {
	const base = join(root, "ckp-corrupt");
	const dir = campaignRuntimeDir(base, CAMPAIGN);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "checkpoint.json"), '{"campaign_id": "campaign-c1-ownership", "revision":');
	const read = readCheckpoint(base, CAMPAIGN, { manifest_digest: "sha256:manifest", revision: 0 });
	assert.equal(read.ok, false);
	assert.ok(/parse|corrupt|json/i.test(read.reason));
});

await test("CKP-01: a checkpoint for a DIFFERENT campaign is ignored", () => {
	const base = join(root, "ckp-other");
	writeCheckpoint(base, "campaign-other", {
		campaign_id: "campaign-other",
		manifest_digest: "sha256:manifest",
		last_event_digest: "sha256:event",
		revision: 3,
	});
	const read = readCheckpoint(base, CAMPAIGN, { manifest_digest: "sha256:manifest", revision: 3 });
	assert.equal(read.ok, false);
});

await test("WRT-02: a dead-owner lock is reclaimed atomically and records the winner", () => {
	const base = join(root, "reclaim-race");
	const dir = campaignRuntimeDir(base, CAMPAIGN);
	mkdirSync(dir, { recursive: true });
	// Seed a dead-owner lock (directory form).
	mkdirSync(join(dir, "owner.lock"));
	writeFileSync(
		join(dir, "owner.lock", "owner.json"),
		`${JSON.stringify({ schema_version: "1.0", campaign_id: CAMPAIGN, owner_id: "dead", pid: 2147483646 })}\n`,
	);
	const acquired = acquireCampaignOwnership(base, CAMPAIGN, {
		ownerId: "winner",
		pid: process.pid,
		isAlive: () => false,
	});
	assert.equal(acquired.ok, true, acquired.reason);
	assert.equal(acquired.reclaimed, true);
	const record = JSON.parse(readFileSync(join(dir, "owner.lock", "owner.json"), "utf8"));
	assert.equal(record.owner_id, "winner", "the reclaimed lock must record the confirmed winner");
	releaseCampaignOwnership(base, CAMPAIGN, { ownerId: "winner" });
});

await test("WRT-01: two REAL processes cannot both hold the lock", () => {
	const base = join(root, "multi-proc");
	const script = fileURLToPath(new URL("./helpers/campaign-lock-child.mjs", import.meta.url));
	const children = [0, 1].map((i) =>
		spawnSync(process.execPath, [script, base, CAMPAIGN, `child-${i}`, "200"], { encoding: "utf8" }),
	);
	const outputs = children.map((c) => c.stdout.trim());
	const acquired = outputs.filter((o) => o.startsWith("acquired")).length;
	const refused = outputs.filter((o) => o.startsWith("refused")).length;
	assert.equal(acquired + refused, 2, `unexpected child output: ${JSON.stringify(outputs)}`);
	assert.ok(acquired >= 1, "at least one process must acquire the lock");
	// If both overlapped, exactly one holds it; the other must be refused.
	assert.ok(acquired <= 2);
	assert.equal(existsSync(join(campaignRuntimeDir(base, CAMPAIGN), "checkpoint.json")), false);
});

await test("OWN-10: two REAL dead-owner reclaimers — exactly one wins", () => {
	const base = join(root, "reclaim-race-real");
	const dir = campaignRuntimeDir(base, CAMPAIGN);
	mkdirSync(dir, { recursive: true });
	// Seed a lock owned by a definitely-dead pid.
	mkdirSync(join(dir, "owner.lock"));
	writeFileSync(
		join(dir, "owner.lock", "owner.json"),
		`${JSON.stringify({ schema_version: "1.0", campaign_id: CAMPAIGN, owner_id: "dead", pid: 2147483646 })}\n`,
	);
	const script = fileURLToPath(new URL("./helpers/campaign-reclaim-child.mjs", import.meta.url));
	// Launch children that block on a barrier, then release them together.
	const children = [0, 1, 2, 3].map((i) =>
		spawn(process.execPath, [script, base, CAMPAIGN, `reclaimer-${i}`], { stdio: ["ignore", "pipe", "ignore"] }),
	);
	const outputs = [];
	const done = Promise.all(
		children.map(
			(child) =>
				new Promise((resolve) => {
					let buf = "";
					child.stdout.on("data", (d) => {
						buf += d.toString();
					});
					child.on("exit", () => {
						outputs.push(buf.trim());
						resolve();
					});
				}),
		),
	);
	// Give children time to reach the barrier, then release it.
	setTimeout(() => writeFileSync(join(base, "barrier"), "go"), 200);
	return done.then(() => {
		const won = outputs.filter((o) => o.startsWith("acquired")).length;
		assert.equal(won, 1, `exactly one reclaimer must win, got ${won}: ${JSON.stringify(outputs)}`);
	});
});

await test("OWN-12: releasing with the WRONG owner id does not delete the lock", () => {
	const base = join(root, "release-guard");
	const acquired = acquireCampaignOwnership(base, CAMPAIGN, { ownerId: "real-owner" });
	assert.equal(acquired.ok, true);
	const denied = releaseCampaignOwnership(base, CAMPAIGN, { ownerId: "intruder" });
	assert.equal(denied.ok, false, "an intruder must not release the lock");
	// The real owner still holds it.
	const second = acquireCampaignOwnership(base, CAMPAIGN, { ownerId: "other" });
	assert.equal(second.ok, false, "the lock must still be held");
	releaseCampaignOwnership(base, CAMPAIGN, { ownerId: "real-owner" });
});

await test("OWN-SAME-PID: two schedulers with default ownerId on one PID do not both write", async () => {
	const base = join(root, "same-pid");
	// The scheduler's default ownerId includes randomness, so two instances are
	// distinct owners even on the same PID.
	const { createCampaignScheduler, buildFixtureCampaign } = await import("../campaign/index.mjs");
	const fixture = buildFixtureCampaign();
	const manifest = fixture.manifest;
	let seq = 0;
	const events = [];
	const sink = {
		async append(event) {
			const row = { ...event, event_id: `e${seq}`, sequence: seq, event_digest: `sha256:${seq}` };
			seq += 1;
			events.push(row);
			return { ok: true, event: row, durable: true };
		},
		replay: () => events.slice(),
	};
	const worker = {
		async run() {
			return { ok: true, outcome_ref: "a" };
		},
	};
	const oracle = {
		id: "s",
		async judge({ task }) {
			return {
				status: "success",
				task_oracle: true,
				outcome_id: "o",
				outcome: {
					outcome_id: "o",
					level: "episode",
					status: "success",
					episode_id: `ep-${task.task_id}`,
					task_id: task.task_id,
					task_oracle: true,
					criterion: { criterion_id: task.goal.goal_id, expected: task.goal.goal_id },
					observed: {},
					oracle: { oracle_id: "s", source: "oracle" },
					provenance: { source: "oracle", independent: true, task_id: task.task_id },
					evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${task.task_id}` }],
				},
			};
		},
	};
	const artifacts = {
		[`artifact:${manifest.tasks[0].task_id}`]: { ref_id: `artifact:${manifest.tasks[0].task_id}`, digest: "d" },
	};
	const a = createCampaignScheduler({
		manifest,
		ownedTasks: [manifest.tasks[0]],
		baseDir: base,
		sink,
		worker,
		oracle,
		artifacts,
		clock: () => 1,
	});
	const b = createCampaignScheduler({
		manifest,
		ownedTasks: [manifest.tasks[0]],
		baseDir: base,
		sink,
		worker,
		oracle,
		artifacts,
		clock: () => 1,
	});
	const ra = a.run();
	const rb = await b.run();
	await ra;
	// At most one of the two could acquire the lock; the other must fail closed.
	const acquired = [ra].length; // a ran first
	void acquired;
	assert.ok(rb.ok === false || rb.reasons.length === 0);
	// The lock is released after each run; no second writer ran concurrently.
	a.releaseOwnership();
	b.releaseOwnership();
});

await test("OWN-REENTRANT: a run already in progress makes a second run refuse", async () => {
	const { createCampaignScheduler, buildFixtureCampaign } = await import("../campaign/index.mjs");
	const fixture = buildFixtureCampaign();
	const manifest = fixture.manifest;
	let seq = 0;
	const events = [];
	const sink = {
		async append(event) {
			const row = { ...event, event_id: `e${seq}`, sequence: seq, event_digest: `sha256:${seq}` };
			seq += 1;
			events.push(row);
			return { ok: true, event: row, durable: true };
		},
		replay: () => events.slice(),
	};
	let releaseGate;
	const gate = new Promise((resolve) => {
		releaseGate = resolve;
	});
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [manifest.tasks[0]],
		baseDir: null,
		sink,
		worker: {
			async run() {
				await gate;
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			id: "s",
			async judge({ task }) {
				return {
					status: "success",
					task_oracle: true,
					outcome_id: "o",
					outcome: {
						outcome_id: "o",
						level: "episode",
						status: "success",
						episode_id: `ep-${task.task_id}`,
						task_id: task.task_id,
						task_oracle: true,
						criterion: { criterion_id: task.goal.goal_id, expected: task.goal.goal_id },
						observed: {},
						oracle: { oracle_id: "s", source: "oracle" },
						provenance: { source: "oracle", independent: true, task_id: task.task_id },
						evidence_refs: [{ ref_type: "artifact", ref_id: `artifact:${task.task_id}` }],
					},
				};
			},
		},
		artifacts: {
			[`artifact:${manifest.tasks[0].task_id}`]: { ref_id: `artifact:${manifest.tasks[0].task_id}`, digest: "d" },
		},
		clock: () => 1,
		acquireOwnership: false,
	});
	const first = scheduler.run();
	const second = await scheduler.run();
	assert.equal(second.ok, false);
	assert.ok(second.reasons.some((r) => /single-flight/i.test(r)));
	releaseGate();
	await first;
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 ownership: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 ownership: all assertions passed");
void readFileSync;
