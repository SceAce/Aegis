#!/usr/bin/env node
// Aegis C1 Integration closure — end-to-end product scenario.
//
// Uses the REAL EventLog + createCampaignScheduler + real local subprocesses.
// Worker/Oracle are explicitly SYNTHETIC test dependencies (labelled).
//
// Scenarios:
//   1. E2E-NORMAL: two static tasks (B depends on A) + one bounded dynamic task
//      submitted→admitted→dispatched; B's Oracle is delayed then verified; assert
//      real effects, full Outcome ownership, admission refs, budget, stop state.
//   2. E2E-FAULT: SIGKILL at intent/result boundaries; restart reconciles.
//   3. E2E-CONTROL: durable cancel survives restart; prefix cache+tail == full
//      replay; deleting derived artifacts rebuilds the same semantic projection.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-integration-e2e.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectQueueFromEvents } from "../memory/campaign/index.mjs";
import { EventLog } from "../memory/runtime/events.mjs";

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
const root = mkdtempSync(join(tmpdir(), "aegis-c1int-e2e-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const harness = fileURLToPath(new URL("./helpers/campaign-product-child.mjs", import.meta.url));

function runChild(workDir, scenario, extraEnv = {}) {
	const result = spawnSync(process.execPath, [harness, workDir, scenario], {
		encoding: "utf8",
		env: { ...process.env, ...extraEnv },
	});
	return result;
}

function summary(workDir) {
	const path = join(workDir, "summary.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function readEventsSync(workDir) {
	const path = join(workDir, "events.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

test("E2E-NORMAL: static A→B + dynamic admitted task run through the real EventLog", () => {
	const workDir = join(root, "normal");
	const result = runChild(workDir, "normal");
	assert.equal(result.status, 0, `child failed: ${result.stderr}`);
	const s = summary(workDir);
	// Real effects: each dispatched task produced exactly one synthetic effect.
	assert.ok(s.effects >= 2, `at least two effects, got ${s.effects}`);
	// Dynamic task admitted through submitted→admitted and actually dispatched.
	assert.equal(s.dynamic_admitted, 1, "one dynamic task admitted via events");
	assert.ok(s.dispatched_includes_dynamic, "the dynamic task was dispatched");
	// Full Outcome ownership: A completed with a traced outcome, and B's delayed
	// Oracle left it unknown (not failed), then a late judgment verified it.
	assert.equal(s.static_a_completed, true);
	assert.equal(s.dynamic_completed, true);
	assert.equal(s.b_delayed_then_verified, true);
	// Budget conserved: consumed equals dispatched × synthetic cost.
	assert.equal(s.consumed_model_requests, s.dispatched, "one synthetic unit charged per dispatch");
	// F4: the evidence digest is bound to the REAL effect content.
	assert.ok(s.a_artifact_digest, "the effect sentinel has a content digest");
	assert.equal(
		s.a_artifact_index_digest,
		s.a_artifact_digest,
		"the artifact index digest equals the real content digest",
	);
	// F5: the dynamic definition is complete and has a digest.
	assert.ok(s.dynamic_definition_digest, "the dynamic definition has a digest");
	assert.equal(s.dynamic_has_scope, true, "scope is present in the definition");
	assert.equal(s.dynamic_has_stop_condition, true, "stop_condition is present in the definition");
});

test("E2E-NORMAL: no duplicate effects on a second run over the same log", () => {
	const workDir = join(root, "normal-rerun");
	runChild(workDir, "normal");
	const first = summary(workDir);
	const rerun = runChild(workDir, "normal");
	assert.equal(rerun.status, 0, rerun.stderr);
	const second = summary(workDir);
	assert.equal(second.effects, first.effects, "a re-run does not duplicate effects");
	assert.equal(second.dynamic_admitted, first.dynamic_admitted, "no duplicate admission");
});

test("E2E-FAULT: a SIGKILL after the durable intent is reconciled without a blind rerun", () => {
	const workDir = join(root, "fault");
	const killed = runChild(workDir, "fault_intent", { AEGIS_KILL_CHILD: "1" });
	assert.notEqual(killed.status, 0, "the child was killed");
	const reconciled = runChild(workDir, "recover");
	assert.equal(reconciled.status, 0, reconciled.stderr);
	const s = summary(workDir);
	assert.equal(s.reconciled_worker_calls, 0, "the worker is not re-run to reconcile");
	assert.ok(s.reconciliation_recorded, "the intent is reconciled");
	assert.ok(s.effect_at_most_once, "the effect happened at most once");
	// F7: the reconciled stranded task is really completed through the Stage gate,
	// with a matched outcome id and recorded stage evidence.
	assert.equal(s.recovered_task_state, "completed", "reconciliation completes the stranded task");
	assert.ok(s.recovered_task_outcome_ref?.startsWith("o-"), "the recovered outcome id is recorded");
	assert.ok(
		Array.isArray(s.recovered_stage_outcome_ids) && s.recovered_stage_outcome_ids.length >= 2,
		"every required stage outcome is recorded",
	);
});

test("E2E-F9-SCOPE: a foreign task scope is rejected through the product path", () => {
	const workDir = join(root, "scope-reject");
	const result = runChild(workDir, "scope_reject");
	assert.equal(result.status, 0, `child failed: ${result.stderr}`);
	const s = summary(workDir);
	assert.equal(s.foreign_scope_rejected, true, "a foreign task scope is not accepted");
	assert.notEqual(s.task_state, "completed");
	assert.ok(
		s.rejected_reasons.some((r) => /scope/i.test(r)),
		`a scope rejection reason is recorded: ${JSON.stringify(s.rejected_reasons)}`,
	);
});

test("E2E-CONTROL: a durable cancel survives a restart and prefix cache == full replay", () => {
	const workDir = join(root, "control");
	const first = runChild(workDir, "control");
	assert.equal(first.status, 0, first.stderr);
	const second = runChild(workDir, "control_restart");
	assert.equal(second.status, 0, second.stderr);
	const s = summary(workDir);
	assert.equal(s.worker_calls_after_cancel_restart, 0, "a cancelled campaign is not revived");
	assert.equal(s.campaign_state, "cancelled");
	// F6: prefix cache + tail equals the full replay across the COMPLETE projection.
	// Compare the independently serialized snapshots AND require the snapshot to
	// actually carry the full shape (tasks, proposals, budget, control) — a
	// truncated snapshot cannot pass.
	const fullSnap = JSON.parse(s.full_snapshot);
	const prefixSnap = JSON.parse(s.prefix_snapshot);
	for (const key of ["tasks", "proposals", "budget", "control", "outcome_ids", "tail_offset"]) {
		assert.ok(Object.hasOwn(fullSnap, key), `the full snapshot carries ${key}`);
		assert.ok(Object.hasOwn(prefixSnap, key), `the prefix snapshot carries ${key}`);
	}
	assert.ok(Array.isArray(fullSnap.tasks) && fullSnap.tasks.length >= 2, "the snapshot carries task rows");
	assert.equal(s.prefix_snapshot, s.full_snapshot, "prefix+tail matches the full projection snapshot");
	assert.equal(s.prefix_equals_full, true, "prefix+tail matches the full replay");
	// Deleting the derived checkpoint and rebuilding yields the same semantics.
	assert.equal(s.rebuild_equals_full, true, "rebuild from events matches");
});

test("E2E-CONTROL: the real EventLog chain verifies after the scenarios", async () => {
	const workDir = join(root, "normal");
	const log = new EventLog(join(workDir, "events.jsonl"));
	return log.open().then((opened) => {
		assert.equal(opened.ok, true, opened.error);
		assert.ok(log.replay().length > 0, "committed events exist");
	});
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 integration e2e: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 integration e2e: all assertions passed");
void readEventsSync;
void projectQueueFromEvents;
