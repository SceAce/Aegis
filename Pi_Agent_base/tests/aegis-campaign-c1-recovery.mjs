#!/usr/bin/env node
// Aegis Campaign C1-E recovery CONTROL-FLOW tests (REAL local subprocesses,
// SYNTHETIC file sink).
//
// IMPORTANT: the child harness writes a SYNTHETIC event JSONL with
// `writeFileSync` and does NOT fsync. This suite proves the scheduler CONTROL
// FLOW across a real SIGKILL (durable-before-dispatch ordering, unknown +
// reconciliation instead of a blind rerun, no duplicate completed action). It
// does NOT prove real EventLog durability — that boundary is covered by
// `aegis-campaign-c1-eventlog-durability.mjs`.
//
// The child harness runs the deterministic scheduler against a file-backed event
// sink and a file-backed "side effect" counter, then is KILLED with SIGKILL at a
// chosen boundary; the parent restarts it and asserts the recovery contract:
//
//   * kill BEFORE the durable intent  -> no side effect, safe to run later;
//   * kill AFTER the intent, before the result -> reconciled, no blind rerun;
//   * kill AFTER the result, before checkpoint -> replay does not duplicate.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-recovery.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
const root = mkdtempSync(join(tmpdir(), "aegis-campaign-c1-rec-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const harness = fileURLToPath(new URL("./helpers/campaign-scheduler-child.mjs", import.meta.url));

function runChild(workDir, boundary, extraEnv = {}) {
	return spawnSync(process.execPath, [harness, workDir, boundary], {
		encoding: "utf8",
		env: { ...process.env, ...extraEnv },
	});
}

function readCounter(workDir) {
	const path = join(workDir, "effects.json");
	if (!existsSync(path)) return 0;
	return JSON.parse(readFileSync(path, "utf8")).effects;
}

function readEvents(workDir) {
	const path = join(workDir, "events.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

/** Start a child asynchronously and kill it with SIGKILL after `delayMs`. */
function killAfter(workDir, boundary, delayMs, extraEnv = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [harness, workDir, boundary], {
			env: { ...process.env, AEGIS_KILL_SELF_AFTER_MS: String(delayMs), ...extraEnv },
			stdio: "ignore",
		});
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
}

const SINGLE = { AEGIS_OWNED: "single" };

await test("REC-01: an idle child starts, dispatches and completes deterministically", () => {
	const workDir = join(root, "idle");
	const result = runChild(workDir, "none", SINGLE);
	assert.equal(result.status, 0, `child failed: ${result.stderr}`);
	assert.equal(readCounter(workDir), 1, "exactly one side effect for one task");
	const events = readEvents(workDir);
	const kinds = events.map((e) => e.payload.kind);
	assert.ok(kinds.includes("campaign.task.started"));
	assert.ok(kinds.includes("campaign.task.completed"));
});

await test("REC-01: a pre-intent durable-log failure causes NO side effect", () => {
	const workDir = join(root, "before-intent");
	// The durable intent append fails; the worker must not be dispatched.
	const attempted = runChild(workDir, "before_intent", SINGLE);
	assert.notEqual(attempted.status, 0, "the scheduler fails closed when the intent is not durable");
	assert.equal(readCounter(workDir), 0, "no side effect before the intent");
	// A safe restart now runs the task normally.
	const result = runChild(workDir, "none", SINGLE);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readCounter(workDir), 1);
});

await test("REC-02: kill AFTER the intent but BEFORE the result reconciles (no blind rerun)", async () => {
	const workDir = join(root, "after-intent");
	const { signal } = await killAfter(workDir, "after_intent", 400, SINGLE);
	assert.equal(signal, "SIGKILL");
	// The intent was durable, but the effect may or may not have happened.
	const eventsAfterKill = readEvents(workDir);
	assert.ok(eventsAfterKill.some((e) => e.payload.kind === "campaign.task.started"));
	const before = readCounter(workDir);
	// Restart in reconcile mode: it must NOT re-execute the non-idempotent action.
	const result = runChild(workDir, "reconcile", SINGLE);
	assert.equal(result.status, 0, result.stderr);
	const after = readCounter(workDir);
	assert.equal(after, before, "reconciliation must not blindly re-run the action");
	const events = readEvents(workDir);
	assert.ok(
		events.some(
			(e) =>
				e.payload.kind === "campaign.reconciliation.requested" ||
				e.payload.kind === "campaign.reconciliation.resolved" ||
				e.payload.kind === "campaign.task.unknown",
		),
		"reconciliation is recorded",
	);
});

await test("REC-03: kill AFTER the result but BEFORE the checkpoint replays without duplication", async () => {
	const workDir = join(root, "after-result");
	const { signal } = await killAfter(workDir, "after_result", 700, SINGLE);
	assert.equal(signal, "SIGKILL");
	const before = readCounter(workDir);
	const eventsAfterKill = readEvents(workDir);
	assert.ok(
		eventsAfterKill.some((e) => e.payload.kind === "campaign.oracle.result"),
		"the result was committed",
	);
	// Restart: replay of the committed result must not run the effect again.
	const result = runChild(workDir, "none", SINGLE);
	assert.equal(result.status, 0, result.stderr);
	const after = readCounter(workDir);
	assert.equal(after, before, "replay must not duplicate the side effect");
	assert.equal(after, 1, "the effect happened exactly once across the crash");
});

await test("END-01: two static tasks + one preset dynamic task + delayed oracle survive a restart", () => {
	const workDir = join(root, "end-to-end");
	const first = runChild(workDir, "none");
	assert.equal(first.status, 0, first.stderr);
	// Restart from committed events: the projection is identical and no task runs twice.
	const second = runChild(workDir, "none");
	assert.equal(second.status, 0, second.stderr);
	const summary = JSON.parse(readFileSync(join(workDir, "summary.json"), "utf8"));
	assert.equal(summary.static_success, 1, "the first static task completed; the second stayed delayed/unknown");
	// NOTE: this synthetic harness presets the third task in `ownedTasks`; it does
	// NOT exercise event-driven dynamic admission. Real submitted→admitted→dispatch
	// is proven in `aegis-campaign-c1-integration-e2e.mjs` (E2E-NORMAL).
	assert.equal(summary.dynamic_admitted, 0, "this synthetic harness does not admit via events");
	assert.equal(summary.delayed_unknown, true, "the delayed oracle case stayed unknown");
	// Effects are exactly once per dispatched task across both runs.
	assert.equal(summary.effects, summary.dispatched, "no duplicate side effects on replay");
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 recovery: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 recovery: all assertions passed");
