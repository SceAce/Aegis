#!/usr/bin/env node
// Independent task-A fault checks: real SDK/faux + Host/Oracle + EventLog.
// Only the SDK tool-result writer or the ready append is faulted. A fresh
// subprocess then restarts from those actual durable events, without truncation
// or injected Oracle results. No paid provider or external target calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { artifactIndexFromEvents } from "../campaign/c3-entry.mjs";
import { summarizeRequestLedger } from "../campaign/c6-request-lifecycle.mjs";
import { projectQueueFromEvents } from "../campaign/projection.mjs";
import { verifyChain } from "../shared/events.mjs";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resolver = join(base, "pi/packages/coding-agent/src/experimental/source-resolver.ts");
const child = join(base, "tests/helpers/c6-e1-planning-child.mjs");
const evidenceRoot = join(base, "runtime/dev/e1-repair-a-external/faults");
mkdirSync(evidenceRoot, { recursive: true });
const workDir = mkdtempSync(join(evidenceRoot, "cases-"));
console.log(`planning gate fault evidence: ${workDir}`);

function scenario(name, directory = name) {
	const dir = join(workDir, directory);
	const run = spawnSync(process.execPath, ["--import", resolver, child, dir, name], {
		encoding: "utf8",
		timeout: 60000,
		maxBuffer: 8 * 1024 * 1024,
	});
	assert.equal(run.status, 0, `fixture ${name} failed: ${run.stderr?.slice(-1000)}`);
	const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	const summary = JSON.parse(readFileSync(join(dir, `summary-${name}.json`), "utf8"));
	const projection = projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: manifest.tasks,
		manifest,
		events,
		artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
	});
	return { events, summary, projection, ledger: summarizeRequestLedger(events) };
}

function assertNoEffects(fixture, consumed) {
	assert.equal(verifyChain(fixture.events).ok, true);
	assert.equal(fixture.summary.broker_effects, 0);
	assert.deepEqual(fixture.summary.dataset, { name: "??", status: "pending" });
	assert.equal(fixture.summary.plan_ready, false);
	assert.equal(fixture.ledger.unresolved, 0);
	assert.equal(fixture.ledger.consumed.model_requests, consumed);
	assert.equal(
		fixture.events.some(
			(event) => event.payload?.kind === "campaign.task.started" && event.payload.task_id.startsWith("dyn-"),
		),
		false,
	);
}

test("A-AUDIT-01: SDK persistence error after recording a candidate never admits it, including restart", () => {
	const failed = scenario("sdk_result_persist_error_plan");
	assert.equal(failed.summary.injected_failures.sdk_tool_result, 1);
	assert.equal(failed.summary.provider_calls, 1);
	assert.equal(failed.summary.task_states["task-plan"], "unknown");
	assert.ok(failed.events.some((event) => event.payload?.kind === "campaign.plan.submitted"));
	assert.equal(
		failed.events.some((event) => event.payload?.kind === "campaign.plan.admitted"),
		false,
	);
	assertNoEffects(failed, 1);

	const restarted = scenario("restart", "sdk_result_persist_error_plan");
	assert.equal(restarted.summary.provider_calls, 0);
	assert.equal(restarted.summary.task_states["task-plan"], "unknown");
	assert.equal(
		restarted.events.some((event) => event.payload?.kind === "campaign.plan.admitted"),
		false,
	);
	assertNoEffects(restarted, 1);
});

test("A-AUDIT-02: actual ready append failure retains accepted completion but holds children after restart", () => {
	const failed = scenario("plan_ready_persist_error");
	assert.equal(failed.summary.injected_failures.plan_ready_append, 1);
	assert.equal(failed.summary.provider_calls, 2);
	assert.equal(failed.summary.ok, false, "durable completion gate failure propagates to entry");
	assert.equal(failed.summary.task_states["task-plan"], "completed");
	const accepted = failed.events.find(
		(event) => event.payload?.kind === "campaign.oracle.result" && event.payload.task_id === "task-plan",
	);
	assert.equal(accepted?.payload.outcome?.status, "success", "the actual Host Oracle judged the planning batch");
	assert.equal(failed.projection.tasks.filter((task) => task.task_id.startsWith("dyn-")).length, 3);
	assertNoEffects(failed, 2);

	const restarted = scenario("restart", "plan_ready_persist_error");
	assert.equal(restarted.summary.provider_calls, 0);
	assert.equal(restarted.summary.task_states["task-plan"], "completed");
	for (const fixture of [failed, restarted]) {
		for (const task of fixture.projection.tasks.filter((row) => row.task_id.startsWith("dyn-"))) {
			assert.equal(task.state, "queued");
			assert.equal(task.awaiting_plan_ready, true);
		}
	}
	assertNoEffects(restarted, 2);
});
