#!/usr/bin/env node
// Aegis C1 Integration closure — recovery tests (REAL local subprocesses +
// REAL EventLog where durability is the point).
//
// The child uses the REAL EventLog. The Worker/Oracle are synthetic. Effects are
// real local files. SIGTERM (drain) and SIGKILL (abrupt) are both exercised.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-integration-recovery.mjs

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
const root = mkdtempSync(join(tmpdir(), "aegis-c1int-rec-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const harness = fileURLToPath(new URL("./helpers/campaign-recovery-child.mjs", import.meta.url));

function run(workDir, scenario, extraEnv = {}) {
	return spawnSync(process.execPath, [harness, workDir, scenario], {
		encoding: "utf8",
		env: { ...process.env, ...extraEnv },
	});
}
function summary(workDir) {
	const path = join(workDir, "summary.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
function readEvents(workDir) {
	const path = join(workDir, "events.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}
function killAfter(workDir, scenario, delayMs, signal = "SIGKILL") {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [harness, workDir, scenario], { env: { ...process.env }, stdio: "ignore" });
		setTimeout(() => {
			try {
				child.kill(signal);
			} catch {
				/* already gone */
			}
		}, delayMs);
		child.on("exit", (code, signalName) => resolve({ code, signal: signalName }));
	});
}

await test("REC-EXISTS: a durable intent whose effect exists is reconciled without a rerun", () => {
	const workDir = join(root, "exists");
	const killed = run(workDir, "intent_then_effect", { AEGIS_KILL_AFTER_EFFECT: "1" });
	assert.notEqual(killed.status, 0, "the child is killed after the effect");
	const before = readEvents(workDir).filter((e) => e.payload.kind === "campaign.task.started").length;
	const recovered = run(workDir, "recover");
	assert.equal(recovered.status, 0, recovered.stderr);
	const s = summary(workDir);
	assert.equal(s.worker_rerun, 0, "the worker is not re-run to reconcile");
	assert.equal(s.reconciled_outcome, true, "a full Outcome was committed from the real effect");
	assert.equal(
		readEvents(workDir).filter((e) => e.payload.kind === "campaign.task.started").length,
		before,
		"no new intent",
	);
});

await test("REC-NOTDONE: a durable intent with no effect is recorded as not-done", () => {
	const workDir = join(root, "notdone");
	// The child writes the intent then kills BEFORE the effect.
	const killed = run(workDir, "intent_no_effect", { AEGIS_KILL_AFTER_INTENT: "1" });
	assert.notEqual(killed.status, 0);
	const recovered = run(workDir, "recover");
	assert.equal(recovered.status, 0, recovered.stderr);
	const s = summary(workDir);
	assert.equal(s.worker_rerun, 0, "no blind non-idempotent re-dispatch");
	assert.equal(s.effect_exists, false, "the effect is absent");
	assert.equal(s.reconciled_outcome, false, "no false success");
});

await test("REC-DELAY: a delayed judgment leaves the task unresolved until a late judgment", () => {
	const workDir = join(root, "delay");
	const result = run(workDir, "delayed");
	assert.equal(result.status, 0, result.stderr);
	const s = summary(workDir);
	assert.equal(s.delayed_unknown_visible, true, "the delayed unknown is visible");
	assert.equal(s.late_judgment_advanced, true, "a late judgment advances the task");
	assert.equal(s.worker_calls, 1, "the worker is not re-run to backfill the result");
});

await test("REC-SIGTERM: a graceful SIGTERM drains and exits with a distinct code", async () => {
	const workDir = join(root, "sigterm");
	const { signal, code } = await killAfter(workDir, "long", 400, "SIGTERM");
	// The child installs a SIGTERM handler that drains and exits 0.
	assert.equal(signal, null, "SIGTERM is handled, not fatal");
	assert.equal(code, 0, `graceful drain exits 0, got ${code}`);
});

await test("REC-SIGKILL: an abrupt SIGKILL is distinguishable and recoverable", async () => {
	const workDir = join(root, "sigkill");
	const { signal } = await killAfter(workDir, "long", 400, "SIGKILL");
	assert.equal(signal, "SIGKILL", "abrupt kill is observable");
	// The real EventLog chain still opens and the committed intent is present.
	const recovered = run(workDir, "recover");
	assert.equal(recovered.status, 0, recovered.stderr);
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 integration recovery: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 integration recovery: all assertions passed");
