#!/usr/bin/env node
// Aegis C3-B — product Host test over the offline fixture adapter.
//
// Drives the REAL product entry (`assembleCampaignHost`/`createCampaignHost`)
// with the REAL EventLog and REAL local effect files. The fixture adapter is a
// registered ActionContract exercised through the existing Broker.
//
// Cases: C3-POS, C3-POS-2 (dependency), C3-DYN, C3-DENY-1, C3-ORACLE-2,
//        C3-ORACLE-3 (delayed then legal), C3-PRODUCT (CLI entry).
//
// Run:
//   node Pi_Agent_base/tests/aegis-c3-host-fixture.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	admitTaskProposal,
	assembleCampaignHost,
	buildC3FixtureManifest,
	FIXTURE_ADAPTER_ACTION_REF,
	loadManifest,
	validateManifest,
} from "../memory/campaign/index.mjs";
import { digest } from "../memory/fixture/contracts.mjs";
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
const root = mkdtempSync(join(tmpdir(), "aegis-c3-fixture-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

function validatedFixture(workspaceRoot, extra = {}) {
	const base = buildC3FixtureManifest({ workspaceRoot, ...extra });
	const validation = validateManifest(base);
	assert.equal(validation.ok, true, `fixture manifest invalid: ${validation.reasons?.join("; ")}`);
	return validation.manifest;
}

async function makeHost({ dir, workspaceRoot, mode = "auto", manifest, delayedFirstByTask = {} }) {
	const eventLogPath = join(dir, "events.jsonl");
	const assembled = await assembleCampaignHost({
		manifest,
		workspaceRoot,
		workDir: dir,
		eventLogPath,
		mode,
		delayedFirstByTask,
	});
	return assembled;
}

function kinds(sink) {
	return sink.replay().map((e) => e.payload?.kind ?? e.event_type);
}

// ---------------------------------------------------------------------------
// C3-POS / C3-POS-2
// ---------------------------------------------------------------------------

await test("C3-POS: two static tasks reach real local effects and bound Stage/Task Outcomes", async () => {
	const dir = join(root, "pos");
	const workspaceRoot = join(dir, "ws");
	const manifest = validatedFixture(workspaceRoot);
	const { host, sink } = await makeHost({ dir, workspaceRoot, manifest });
	const result = await host.run();
	assert.equal(result.ok, true, `host run failed: ${result.reasons?.join("; ")}`);
	const projection = result.status;
	const byId = Object.fromEntries(projection.tasks.map((t) => [t.task_id, t]));
	assert.equal(byId["task-001"].state, "completed", "task-001 completed");
	assert.equal(byId["task-002"].state, "completed", "task-002 completed");
	// Real effect: a file was created and holds the final deterministic state.
	assert.equal(existsSync(join(workspaceRoot, "door.json")), true, "the effect file exists");
	assert.deepEqual(JSON.parse(readFileSync(join(workspaceRoot, "door.json"), "utf8")), { locked: false });
	// Every required stage has a bound outcome for each task.
	for (const id of ["task-001", "task-002"]) {
		const def = manifest.tasks.find((t) => t.task_id === id);
		for (const stage of def.stages) {
			const has = (byId[id].stage_outcomes ?? []).some((o) => (o.step_id ?? o.stage_id) === stage.stage_id);
			assert.equal(has, true, `stage ${stage.stage_id} has a bound outcome`);
		}
	}
	// Action evidence is traceable and the action count matches the two steps.
	assert.equal(kinds(sink).filter((k) => k === "action.requested").length, 2);
	assert.equal(kinds(sink).filter((k) => k === "action.completed").length, 2);
	assert.equal(projection.rejected.length, 0, `no rejected outcomes: ${JSON.stringify(projection.rejected)}`);
	host.releaseOwnership();
});

await test("C3-POS-2: the dependent task is not dispatched before its dependency completes", async () => {
	const dir = join(root, "pos-order");
	const workspaceRoot = join(dir, "ws");
	const manifest = validatedFixture(workspaceRoot);
	const { host, sink } = await makeHost({ dir, workspaceRoot, manifest });
	await host.run();
	const events = sink.replay();
	const started = events.filter((e) => e.payload?.kind === "campaign.task.started").map((e) => e.payload.task_id);
	const completed1 = events.findIndex(
		(e) => e.payload?.kind === "campaign.task.completed" && e.payload.task_id === "task-001",
	);
	const started2 = events.findIndex(
		(e) => e.payload?.kind === "campaign.task.started" && e.payload.task_id === "task-002",
	);
	assert.equal(started[0], "task-001", "task-001 starts first");
	assert.ok(completed1 >= 0 && started2 > completed1, "task-002 starts after task-001 completes");
	host.releaseOwnership();
});

// ---------------------------------------------------------------------------
// C3-DYN
// ---------------------------------------------------------------------------

await test("C3-DYN: a real submitted/admitted dynamic task is dispatched through the same Broker", async () => {
	const dir = join(root, "dyn");
	const workspaceRoot = join(dir, "ws");
	const manifest = validatedFixture(workspaceRoot);
	const { host, sink } = await makeHost({ dir, workspaceRoot, manifest });
	// Submit an LLM proposal (a CLAIM) then a Runtime admission (a transition).
	const proposal = {
		proposed_task_id: "task-dyn-1",
		parent_task_id: "task-001",
		parent_stage_id: "stage-001-observe",
		goal: { goal_id: "observe_again", description: "observe again", success_criteria: ["door.locked == true"] },
		target_ref: "door.json",
		task_type: "observe",
		required_capabilities: ["fixture.observe"],
		expected_evidence: ["observation.captured"],
		budget_reservation: { wall_time_ms: 1000, model_requests: 1, tool_calls: 1 },
		priority: 1,
		stop_condition: "no remaining authorized target",
		scope: { environment_fingerprint: "fixture-env", domain: "fixture" },
	};
	await sink.append({
		event_type: "runtime.note",
		source: { kind: "llm", actor_id: "synthetic-proposer" },
		payload: {
			kind: "campaign.proposal.submitted",
			campaign_id: manifest.campaign_id,
			proposal_id: "p-dyn-1",
			proposal_digest: "sha256:p-dyn-1",
			proposal,
		},
	});
	const decision = admitTaskProposal({ proposal, manifest, depth: 1 });
	assert.equal(decision.status, "admitted", `dynamic admission failed: ${decision.reasons?.join("; ")}`);
	await sink.append({
		event_type: "runtime.note",
		source: { kind: "runtime", actor_id: "host" },
		payload: {
			kind: "campaign.proposal.admitted",
			campaign_id: manifest.campaign_id,
			proposal_id: "p-dyn-1",
			proposal_digest: "sha256:p-dyn-1",
			task_id: proposal.proposed_task_id,
			admission: { status: "admitted", checks: decision.checks, reserved_budget: decision.reserved_budget },
		},
	});
	const result = await host.run();
	const dyn = result.status.tasks.find((t) => t.task_id === "task-dyn-1");
	assert.ok(dyn, "the dynamic task exists in the projection");
	assert.equal(dyn.is_dynamic, true, "resolved as a dynamic task (not preset in ownedTasks)");
	assert.equal(dyn.state, "completed", "the dynamic task completed via the Broker");
	// Its action went through the same registered action and produced a real effect.
	const dynAction = sink
		.replay()
		.find((e) => e.event_type === "action.completed" && e.payload?.task_id === "task-dyn-1");
	assert.ok(dynAction, "the dynamic task produced a brokered action completion");
	assert.equal(dynAction.payload.action_ref, FIXTURE_ADAPTER_ACTION_REF);
	host.releaseOwnership();
});

// ---------------------------------------------------------------------------
// C3-DENY-1
// ---------------------------------------------------------------------------

await test("C3-DENY-1: an unregistered action_ref is refused and produces no effect", async () => {
	const dir = join(root, "deny");
	const workspaceRoot = join(dir, "ws");
	const manifest = validatedFixture(workspaceRoot);
	const { host, sink } = await makeHost({
		dir,
		workspaceRoot,
		manifest,
		// A Host plan that names an UNREGISTERED action for task-001.
	});
	// Replace the worker plan by re-assembling with a hostile plan factory.
	const assembled = await assembleCampaignHost({
		manifest,
		workspaceRoot,
		workDir: dir,
		eventLogPath: join(dir, "events2.jsonl"),
		mode: "auto",
		planFactory: (task) => ({
			task_id: task.task_id,
			steps: [
				{
					step_id: "s",
					stage_id: task.stages[0].stage_id,
					action_ref: "attacker.unregistered",
					arguments: { x: 1 },
					criterion_id: null,
					evidence_ref: null,
				},
			],
		}),
	});
	const hostileHost = assembled.host;
	const result = await hostileHost.run();
	// The run handles the rejection gracefully (unknown + reconciliation), so run
	// itself may be ok; what matters is that NO effect happened and the broker
	// rejected the unregistered action.
	const projection = result.status;
	const hostileTask = projection.tasks.find((t) => t.task_id === "task-001");
	assert.notEqual(hostileTask.state, "completed", "the task is not completed");
	const completed = assembled.sink.replay().find((e) => e.event_type === "action.completed");
	assert.ok(completed, "an action.completed records the rejection");
	assert.equal(completed.payload.status, "rejected", "the broker rejected the unknown action");
	assert.match(String(completed.payload.rejection_reason), /unknown action/i);
	assert.equal(existsSync(join(workspaceRoot, "door.json")), false, "no effect file was produced");
	host.releaseOwnership();
	hostileHost.releaseOwnership();
	void sink;
});

// ---------------------------------------------------------------------------
// C3-ORACLE-2 / C3-ORACLE-3
// ---------------------------------------------------------------------------

await test("C3-ORACLE-2: an unresolvable (missing/foreign) evidence ref blocks a Task success", async () => {
	const dir = join(root, "oracle-evidence");
	const workspaceRoot = join(dir, "ws");
	const manifest = validatedFixture(workspaceRoot);
	const assembled = await assembleCampaignHost({
		manifest,
		workspaceRoot,
		workDir: dir,
		eventLogPath: join(dir, "events.jsonl"),
		mode: "auto",
		oracleOverrides: {
			// Claim success but cite an evidence ref that is NOT in the real artifact
			// index (a foreign/missing ref).
			judgeTask: () => ({
				status: "success",
				observed: { locked: true },
				expected: true,
				evidence: [{ ref_id: "artifact:foreign-nonexistent", digest: "sha256:deadbeef" }],
			}),
		},
	});
	const result = await assembled.host.run();
	const t1 = result.status.tasks.find((t) => t.task_id === "task-001");
	assert.notEqual(t1.state, "completed", "a missing/foreign evidence ref must not complete the task");
	assert.ok(
		result.status.rejected.some((r) => /evidence/i.test(r.reason)),
		`an evidence rejection is recorded: ${JSON.stringify(result.status.rejected)}`,
	);
	assembled.host.releaseOwnership();
});

await test("C3-ORACLE-3: a delayed judgment blocks the dependent task, then a late result advances it without re-running the worker", async () => {
	const dir = join(root, "oracle-delayed");
	const workspaceRoot = join(dir, "ws");
	const manifest = validatedFixture(workspaceRoot);
	// task-002 is delayed/unknown until an EXTERNAL resolution marker exists; only
	// then does the Oracle return success. This proves a late judgment (not a
	// re-run) advances the task.
	const marker = join(workspaceRoot, "task-002.resolved");
	const assembled = await assembleCampaignHost({
		manifest,
		workspaceRoot,
		workDir: dir,
		eventLogPath: join(dir, "events.jsonl"),
		mode: "auto",
		oracleOverrides: {
			judgeTask: ({ task }) => {
				const path = join(workspaceRoot, task.target_ref ?? "door.json");
				if (!existsSync(path)) return { status: "unknown", failure_mode: "effect_absent" };
				const state = JSON.parse(readFileSync(path, "utf8"));
				const unlock = task.task_type === "verify";
				const expected = !unlock;
				const evidence = [{ ref_id: `artifact:${task.task_id}`, digest: digest(readFileSync(path, "utf8")), path }];
				if (task.task_id === "task-002" && !existsSync(marker)) {
					return { status: "unknown", delayed: true, failure_mode: "delayed_verification", evidence };
				}
				if (state.locked === expected)
					return { status: "success", observed: { locked: state.locked }, expected, evidence };
				return {
					status: "failure",
					observed: { locked: state.locked },
					expected,
					failure_mode: "criterion_not_met",
					evidence,
				};
			},
		},
	});
	const first = await assembled.host.run();
	const t2first = first.status.tasks.find((t) => t.task_id === "task-002");
	assert.equal(t2first.state, "unknown", "the delayed task is unknown after the first run");
	assert.equal(t2first.stop_reason, "delayed_verification");
	// Count dispatches of task-002 so far.
	const dispatchesBefore = assembled.sink
		.replay()
		.filter((e) => e.payload?.kind === "campaign.task.started" && e.payload.task_id === "task-002").length;
	assert.equal(dispatchesBefore, 1);
	// A second run with STILL no resolution keeps it unknown (dependents blocked).
	const secondPending = await assembled.host.run();
	assert.equal(secondPending.status.tasks.find((t) => t.task_id === "task-002").state, "unknown");
	// Now the external late result arrives; a fresh judgment advances the task
	// WITHOUT re-running the worker.
	writeFileSync(marker, "resolved\n");
	const third = await assembled.host.run();
	const t2third = third.status.tasks.find((t) => t.task_id === "task-002");
	assert.equal(t2third.state, "completed", "the late judgment advances the task");
	const dispatchesAfter = assembled.sink
		.replay()
		.filter((e) => e.payload?.kind === "campaign.task.started" && e.payload.task_id === "task-002").length;
	assert.equal(dispatchesAfter, 1, "the worker is NOT re-run for the late judgment");
	assembled.host.releaseOwnership();
});

// ---------------------------------------------------------------------------
// C3-PRODUCT (CLI)
// ---------------------------------------------------------------------------

await test("C3-PRODUCT: the CLI product entry runs the real loop", async () => {
	const dir = join(root, "cli");
	const entry = fileURLToPath(new URL("../memory/campaign/c3-entry.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [entry, dir, "start"], { encoding: "utf8" });
	assert.equal(result.status, 0, `CLI failed: ${result.stderr}`);
	const summary = JSON.parse(result.stdout);
	assert.equal(summary.task_states["task-001"], "completed");
	assert.equal(summary.task_states["task-002"], "completed");
	assert.equal(summary.action_events.requested, 2);
	// The real EventLog chain verifies.
	const log = new EventLog(join(dir, "events.jsonl"));
	const opened = await log.open();
	assert.equal(opened.ok, true, opened.error);
	assert.ok(log.replay().length > 0);
	void loadManifest;
	void writeFileSync;
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C3 host fixture: ${failures.length} failure(s)`);
	for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
	process.exit(1);
}
console.log("campaign C3 host fixture: all assertions passed");
