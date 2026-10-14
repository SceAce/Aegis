#!/usr/bin/env node
// Aegis E1 — focused negative/recovery checks for the planning EXECUTION gate.
//
// Error/aborted cases drive the real SDK/faux + Host/Broker/Oracle/EventLog.
// Identity/order checks mutate a real stream for reducer tests. GATE-07 uses a
// controlled Scheduler fixture; aegis-e1-planning-gate-audit.mjs separately
// faults the actual Host EventLog writer and tests a fresh-process restart.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-e1-planning-gate.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { artifactIndexFromEvents } from "../memory/campaign/c3-entry.mjs";
import { planDigest } from "../memory/campaign/e1-plan-contract.mjs";
import { projectQueueFromEvents } from "../memory/campaign/projection.mjs";
import { createCampaignScheduler } from "../memory/campaign/scheduler.mjs";
import { verifyChain } from "../memory/runtime/events.mjs";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resolver = join(base, "pi/packages/coding-agent/src/experimental/source-resolver.ts");
const child = join(base, "tests/helpers/c6-e1-planning-child.mjs");
const evidenceRoot = join(base, "runtime/dev/e1-planning-gate");
mkdirSync(evidenceRoot, { recursive: true });
const workDir = mkdtempSync(join(evidenceRoot, "cases-"));

function scenario(name) {
	const dir = join(workDir, name);
	const run = spawnSync(process.execPath, ["--import", resolver, child, dir, name], {
		encoding: "utf8",
		timeout: 60000,
		maxBuffer: 8 * 1024 * 1024,
	});
	assert.equal(run.status, 0, `fixture ${name} failed: ${run.stderr?.slice(-1000)}`);
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	const summary = JSON.parse(readFileSync(join(dir, `summary-${name}.json`), "utf8"));
	return { dir, manifest, events, summary };
}

function project(fixture, events = fixture.events) {
	return projectQueueFromEvents({
		campaign_id: fixture.manifest.campaign_id,
		tasks: fixture.manifest.tasks,
		events,
		revision: fixture.manifest.revision ?? 0,
		manifest: fixture.manifest,
		// Artifact-aware replay: the planning/business Oracle evidence refs must be
		// resolvable exactly as the authoritative product replay resolves them.
		artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
	});
}

let errorRun;
let abortedRun;
let normal;
before(() => {
	errorRun = scenario("error_plan");
	abortedRun = scenario("aborted_plan");
	normal = scenario("normal_plan");
});

test("GATE-01: an error planning termination retains the candidate and admits/executes nothing", () => {
	assert.equal(verifyChain(errorRun.events).ok, true);
	assert.ok(
		errorRun.events.some((e) => e.payload?.kind === "campaign.plan.submitted"),
		"candidate is retained",
	);
	assert.equal(
		errorRun.events.some((e) => e.payload?.kind === "campaign.plan.admitted"),
		false,
	);
	assert.equal(errorRun.summary.broker_effects, 0);
	assert.deepEqual(errorRun.summary.dataset, { name: "??", status: "pending" });
});

test("GATE-02: an aborted planning termination retains the candidate and admits/executes nothing", () => {
	assert.equal(verifyChain(abortedRun.events).ok, true);
	assert.ok(
		abortedRun.events.some((e) => e.payload?.kind === "campaign.plan.submitted"),
		"candidate is retained",
	);
	assert.equal(
		abortedRun.events.some((e) => e.payload?.kind === "campaign.plan.admitted"),
		false,
	);
	assert.equal(abortedRun.summary.broker_effects, 0);
	assert.deepEqual(abortedRun.summary.dataset, { name: "??", status: "pending" });
});

test("GATE-03: the admitted prefix and the completed-without-ready prefix both keep children held", () => {
	const admittedEnd = normal.events.findIndex((e) => e.payload?.kind === "campaign.plan.admitted");
	const completedEnd = normal.events.findIndex(
		(e) => e.payload?.kind === "campaign.task.completed" && e.payload.task_id === "task-plan",
	);
	const readyStart = normal.events.findIndex((e) => e.payload?.kind === "campaign.plan.ready");
	assert.ok(admittedEnd >= 0 && completedEnd > admittedEnd && readyStart > completedEnd);
	for (const [label, slice] of [
		["admitted", normal.events.slice(0, admittedEnd + 1)],
		["completed-without-ready", normal.events.slice(0, readyStart)],
	]) {
		const held = project(normal, slice);
		for (const task of held.tasks.filter((t) => t.task_id.startsWith("dyn-"))) {
			assert.equal(task.awaiting_plan_ready, true, `${label}: ${task.task_id} must stay gated`);
		}
	}
	// The full stream releases exactly the admitted batch.
	const released = project(normal);
	for (const task of released.tasks.filter((t) => t.task_id.startsWith("dyn-"))) {
		assert.equal(task.awaiting_plan_ready, false, `${task.task_id} released only after the durable gate`);
	}
});

function mutateReady(mutate) {
	const events = normal.events.map((e) => structuredClone(e));
	const ready = events.find((e) => e.payload?.kind === "campaign.plan.ready");
	assert.ok(ready, "control: a plan-ready record exists");
	mutate(ready);
	return project(normal, events);
}

test("GATE-04: a plan-ready record with a mismatched Outcome identity is rejected and holds children", () => {
	const held = mutateReady((ready) => {
		ready.payload.outcome_id = "o-forged";
	});
	assert.ok(
		held.rejected.some((r) => String(r.reason).includes("does not match")),
		JSON.stringify(held.rejected),
	);
	for (const task of held.tasks.filter((t) => t.task_id.startsWith("dyn-"))) {
		assert.equal(task.awaiting_plan_ready, true, `${task.task_id} must stay gated`);
	}
});

test("GATE-05: a plan-ready record with a null/foreign plan id releases nothing", () => {
	for (const mutate of [
		(ready) => {
			ready.payload.plan_id = null;
		},
		(ready) => {
			ready.payload.plan_id = "plan-foreign";
		},
	]) {
		const held = mutateReady(mutate);
		assert.ok(held.rejected.length > 0, "a null/foreign plan id is rejected");
		for (const task of held.tasks.filter((t) => t.task_id.startsWith("dyn-"))) {
			assert.equal(task.awaiting_plan_ready, true, `${task.task_id} must stay gated`);
		}
	}
});

test("GATE-06: a plan-ready record before the planning Task completes is rejected and holds children", () => {
	const readyIndex = normal.events.findIndex((e) => e.payload?.kind === "campaign.plan.ready");
	// Move the plan-ready record BEFORE the planning completion.
	const events = normal.events.map((e) => structuredClone(e));
	const [ready] = events.splice(readyIndex, 1);
	const completedIndex = events.findIndex(
		(e) => e.payload?.kind === "campaign.task.completed" && e.payload.task_id === "task-plan",
	);
	events.splice(completedIndex, 0, ready);
	const held = project(normal, events);
	assert.ok(
		held.rejected.some((r) => String(r.reason).includes("completed")),
		JSON.stringify(held.rejected),
	);
	for (const task of held.tasks.filter((t) => t.task_id.startsWith("dyn-"))) {
		assert.equal(task.awaiting_plan_ready, true, `${task.task_id} must stay gated`);
	}
});

// --- GATE-07: the completion gate's durable write failure keeps children held ---
function makeSink({ failKinds = [] } = {}) {
	const events = [];
	let seq = 0;
	return {
		events,
		async append(event) {
			const kind = event?.payload?.kind;
			if (failKinds.includes(kind)) return { ok: false, error: `synthetic durable failure for ${kind}` };
			const row = { ...event, event_id: `e${seq}`, sequence: seq, event_digest: `sha256:e${seq}` };
			seq += 1;
			events.push(row);
			return { ok: true, event: row, durable: true };
		},
	};
}

function makePlanningScheduler({ sink, failReady = false }) {
	const planningTask = normal.manifest.tasks.find((t) => t.task_id === "task-plan");
	const oracle = {
		id: "synthetic.oracle",
		async judge({ task }) {
			if (task.task_id !== "task-plan") return { status: "unknown", failure_mode: "no_rule" };
			const evidence = [{ ref_id: `artifact:${task.task_id}`, digest: "sha256:plan" }];
			return {
				status: "success",
				outcome_id: `o-${task.task_id}`,
				task_oracle: true,
				stage_outcomes: [
					{
						step_id: "stage-plan",
						status: "success",
						outcome_id: `so-${task.task_id}-stage-plan`,
						outcome: {
							outcome_id: `so-${task.task_id}-stage-plan`,
							level: "step",
							step_id: "stage-plan",
							status: "success",
							episode_id: `ep-${task.task_id}`,
							task_id: task.task_id,
							criterion: { criterion_id: "plan_ready", expected: "plan_ready" },
							observed: { plan_id: "plan-e1" },
							scope: planningTask.scope,
							oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
							provenance: { source: "oracle", independent: true, task_id: task.task_id, stage_id: "stage-plan" },
							evidence_refs: evidence,
						},
					},
				],
				outcome: {
					outcome_id: `o-${task.task_id}`,
					level: "episode",
					status: "success",
					episode_id: `ep-${task.task_id}`,
					task_id: task.task_id,
					task_oracle: true,
					criterion: { criterion_id: "plan_campaign", expected: "plan_ready" },
					observed: { plan_id: "plan-e1" },
					scope: planningTask.scope,
					oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
					provenance: { source: "oracle", independent: true, task_id: task.task_id },
					evidence_refs: evidence,
				},
			};
		},
	};
	const worker = {
		async run() {
			return { ok: true, outcome_ref: "artifact:task-plan" };
		},
	};
	void failReady;
	return createCampaignScheduler({
		manifest: normal.manifest,
		ownedTasks: normal.manifest.tasks,
		baseDir: null,
		sink,
		worker,
		oracle,
		clock: () => 1000,
		artifacts: { "artifact:task-plan": { ref_id: "artifact:task-plan", digest: "sha256:plan" } },
	});
}

test("GATE-07: a durable failure writing the plan-ready gate stops dispatch and holds children", async () => {
	const sink = makeSink({ failKinds: ["campaign.plan.ready"] });
	// Seed the durable submitted candidate and its admitted batch (the admission is
	// durable; the gate write fails). The admitted record MUST reference the
	// prior candidate digest under the fail-closed replay contract.
	const submittedEvent = normal.events.find((e) => e.payload?.kind === "campaign.plan.submitted");
	const candidatePlan = submittedEvent.payload.plan;
	const canonicalDigest = planDigest(candidatePlan);
	const planTasks = normal.events.find((e) => e.payload?.kind === "campaign.plan.admitted").payload.plan_tasks;
	await sink.append({
		event_type: "runtime.note",
		source: { kind: "runtime", actor_id: "host" },
		payload: {
			kind: "campaign.plan.submitted",
			campaign_id: normal.manifest.campaign_id,
			plan_id: "plan-e1",
			plan_digest: canonicalDigest,
			plan: candidatePlan,
			planning_task_id: "task-plan",
		},
	});
	await sink.append({
		event_type: "runtime.note",
		source: { kind: "runtime", actor_id: "host" },
		payload: {
			kind: "campaign.plan.admitted",
			campaign_id: normal.manifest.campaign_id,
			plan_id: "plan-e1",
			plan_digest: canonicalDigest,
			planning_task_id: "task-plan",
			plan_tasks: planTasks,
		},
	});
	const scheduler = makePlanningScheduler({ sink, failReady: true });
	const result = await scheduler.run();
	assert.equal(result.ok, false, "a non-durable activation must not report success");
	assert.equal(
		sink.events.some((e) => e.payload?.kind === "campaign.plan.ready"),
		false,
		"no plan-ready record is durable",
	);
	const held = project({ manifest: normal.manifest }, sink.events);
	assert.ok(
		held.tasks.some((t) => t.task_id.startsWith("dyn-")),
		"the admitted batch created the dynamic tasks",
	);
	for (const task of held.tasks.filter((t) => t.task_id.startsWith("dyn-"))) {
		assert.equal(task.awaiting_plan_ready, true, `${task.task_id} must stay gated after the failed gate write`);
	}
});
