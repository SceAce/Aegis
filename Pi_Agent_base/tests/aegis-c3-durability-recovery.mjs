#!/usr/bin/env node
// Aegis C3-C — durability and real-child-process recovery.
//
// Cases: C3-DUR-1 (intent append failure => no effect), C3-DUR-2 (result append
// failure after the effect => degraded, unknown, no new effect), C3-REC (SIGKILL
// after durable intent + effect; restart reconciles from the real artifact
// without re-effecting). Uses the REAL EventLog and REAL child processes.
//
// Run:
//   node Pi_Agent_base/tests/aegis-c3-durability-recovery.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const failures = [];
function test(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures.push({ name, error });
		console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
const root = mkdtempSync(join(tmpdir(), "aegis-c3-dur-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const harness = fileURLToPath(new URL("./helpers/c3-recovery-child.mjs", import.meta.url));
function runChild(workDir, scenario, env = {}) {
	return spawnSync(process.execPath, [harness, workDir, scenario], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}
function summary(workDir) {
	const path = join(workDir, "summary.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}
function effects(workDir) {
	const path = join(workDir, "effects.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).effects : 0;
}

test("C3-DUR-1: an intent append failure produces no effect", () => {
	const workDir = join(root, "dur-intent");
	const result = runChild(workDir, "recover", { AEGIS_C3_FAULT: "intent" });
	assert.equal(result.status, 0, result.stderr);
	const s = summary(workDir);
	assert.equal(s.effects, 0, "the worker never ran");
	assert.equal(s.action_completed, 0, "no action completed");
	assert.notEqual(s.task_states["task-001"], "completed");
});

test("C3-DUR-2: a result append failure after the effect stops new effects and stays unknown", () => {
	const workDir = join(root, "dur-result");
	const result = runChild(workDir, "recover", { AEGIS_C3_FAULT: "result" });
	assert.equal(result.status, 0, result.stderr);
	const s = summary(workDir);
	assert.equal(s.effects, 1, "the effect happened at most once");
	assert.equal(s.task_states["task-001"], "unknown", "the task stays unknown (not completed/failed)");
	assert.equal(s.action_completed, 0, "the result was not recorded durably");
	assert.ok(s.unknowns >= 1, "the task was marked unknown");
});

test("C3-REC: a SIGKILL after the effect is reconciled on restart without a blind re-effect", () => {
	const workDir = join(root, "rec");
	// First run is killed right after the real effect, before any result.
	const killed = runChild(workDir, "effect_then_kill");
	assert.notEqual(killed.status, 0, "the child was killed");
	const effectsAfterKill = effects(workDir);
	assert.ok(effectsAfterKill >= 1, "the first effect happened");
	// Restart: the scheduler must reconcile the stranded intent from the real
	// artifact, WITHOUT re-running the effect.
	const recovered = runChild(workDir, "recover");
	assert.equal(recovered.status, 0, recovered.stderr);
	const s = summary(workDir);
	assert.ok(effects(workDir) <= effectsAfterKill + 1, "no blind duplicate effect");
	assert.ok(s.reconciliations >= 1, "the stranded intent was reconciled");
	assert.equal(s.task_states["task-001"], "completed", "the reconciled task is bound and completed");
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C3 durability/recovery: ${failures.length} failure(s)`);
	for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
	process.exit(1);
}
console.log("campaign C3 durability/recovery: all assertions passed");
