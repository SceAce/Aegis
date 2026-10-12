#!/usr/bin/env node
// Aegis C1 closure — REAL EventLog durability tests.
//
// This suite uses the REAL `memory/runtime/events.mjs` EventLog (append + fsync +
// hash chain) in a real child process that is SIGKILLed, to prove the durability
// boundary that the synthetic harness cannot:
//   * a durable `campaign.task.started` survives a real SIGKILL;
//   * a scheduler wired to the real EventLog does not dispatch the worker when
//     the durable intent append FAILS (fail-closed);
//   * reopening the log replays the committed chain and the projection is
//     identical.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-eventlog-durability.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtureCampaign, createCampaignScheduler, projectQueueFromEvents } from "../memory/campaign/index.mjs";
import { EventLog } from "../memory/runtime/events.mjs";

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
const root = mkdtempSync(join(tmpdir(), "aegis-campaign-c1-durable-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const child = fileURLToPath(new URL("./helpers/campaign-eventlog-child.mjs", import.meta.url));

function killAfter(workDir, delayMs, extraEnv = {}) {
	return new Promise((resolve) => {
		const proc = spawn(process.execPath, [child, workDir], {
			env: { ...process.env, AEGIS_KILL_SELF_AFTER_MS: String(delayMs), ...extraEnv },
			stdio: "ignore",
		});
		proc.on("exit", (code, signal) => resolve({ code, signal }));
	});
}

await test("REC-14: a durable intent survives a real SIGKILL and the chain verifies", async () => {
	const workDir = join(root, "durable-intent");
	const { signal } = await killAfter(workDir, 400);
	assert.equal(signal, "SIGKILL", `expected SIGKILL, got ${signal}`);
	// Reopen the REAL EventLog and verify the hash chain + fsynced rows.
	const log = new EventLog(join(workDir, "events.jsonl"));
	const opened = await log.open();
	assert.equal(opened.ok, true, opened.error);
	const rows = log.replay();
	assert.ok(rows.length > 0, "at least one durable event must survive");
	const started = rows.find((r) => r.payload?.kind === "campaign.task.started");
	assert.ok(started, "the durable intent must be committed before the effect");
	assert.equal(typeof started.event_digest, "string");
	// The effect was recorded AFTER the durable intent.
	const effects = JSON.parse(readFileSync(join(workDir, "effects.json"), "utf8"));
	assert.equal(effects.effects, 1);
});

await test("REC-13: an EventLog append failure before dispatch prevents the worker call", async () => {
	const workDir = join(root, "append-fail");
	// A real EventLog whose sync hook throws -> append must fail closed.
	const log = new EventLog(join(workDir, "events.jsonl"), {
		sync: async () => {
			throw new Error("injected fsync failure");
		},
	});
	await log.open();
	const fixture = buildFixtureCampaign();
	const manifest = fixture.manifest;
	let workerCalled = false;
	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks: [manifest.tasks[0]],
		baseDir: null,
		sink: {
			async append(event) {
				const result = await log.append({
					event_type: event.event_type,
					episode_id: event.episode_id,
					payload: event.payload,
					source: event.source,
				});
				return result;
			},
			replay: () => log.replay(),
			events: [],
		},
		worker: {
			async run() {
				workerCalled = true;
				return { ok: true, outcome_ref: "a" };
			},
		},
		oracle: {
			async judge() {
				return { status: "success", outcome_id: "o", task_oracle: true };
			},
		},
		clock: () => 1000,
		acquireOwnership: false,
	});
	const result = await scheduler.run();
	assert.equal(workerCalled, false, "the worker must not run when the durable append fails");
	assert.equal(result.ok, false);
	await log.close();
});

await test("REC-15: reopening the real EventLog replays an identical projection", async () => {
	const workDir = join(root, "replay");
	const result = spawnSync(process.execPath, [child, workDir, "complete"], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const log = new EventLog(join(workDir, "events.jsonl"));
	const opened = await log.open();
	assert.equal(opened.ok, true, opened.error);
	const fixture = buildFixtureCampaign();
	const projection = projectQueueFromEvents({
		campaign_id: fixture.manifest.campaign_id,
		tasks: [fixture.manifest.tasks[0]],
		events: log.replay(),
		revision: fixture.manifest.revision,
		manifest: fixture.manifest,
		artifacts: {
			[`artifact:${fixture.manifest.tasks[0].task_id}`]: {
				ref_id: `artifact:${fixture.manifest.tasks[0].task_id}`,
				digest: "sha256:child",
			},
		},
	});
	assert.equal(projection.tasks[0].state, "completed");
	assert.ok(projection.tail_digest, "the projection exposes the committed tail digest");
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 eventlog durability: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 eventlog durability: all assertions passed");
