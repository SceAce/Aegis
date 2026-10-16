#!/usr/bin/env node
// Aegis E1 — single-authority invariants (live Host == replay == consumers).
//
// Complements the independent review (aegis-e1-contract-closure-review) with
// LEGITIMATE-path controls for the same contracts: a concurrent charge under a
// real accepted start and committed request, the exact §7.1 allocation
// boundary, the persistent deadline boundary, invalidation reaching the REAL
// dependant and the execution permit, and duplicates never re-allocating.
//
// Run: node --test Pi_Agent_base/tests/aegis-e1-authority-invariants.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectExecutionPermit } from "../memory/campaign/authority.mjs";
import { compilePlanAdmission } from "../memory/campaign/e1-plan-contract.mjs";
import { loadPlanningAuthority } from "../memory/campaign/e1-planning-contract.mjs";
import { createCampaignScheduler } from "../memory/campaign/scheduler.mjs";
import { digest } from "../memory/fixture/contracts.mjs";
import { projectBoard } from "../memory/runtime/board.mjs";
import { eventDigest, verifyChain } from "../memory/runtime/events.mjs";
import {
	acceptedPlanningPrefix,
	evidenceDir,
	project,
	runPlanningScenario,
	testPlanningManifest,
} from "./helpers/e1-closure-helpers.mjs";

const out = evidenceDir("authority-invariants");
const normal = runPlanningScenario({ workDir: out, scenario: "normal_plan" });
assert.equal(normal.exit, 0, normal.stderr.slice(-600));
const manifest = normal.manifest;

function rechain(events) {
	let previous;
	const sequences = new Map();
	for (const e of events) {
		if (e.episode_id) {
			e.sequence = sequences.get(e.episode_id) ?? 0;
			sequences.set(e.episode_id, e.sequence + 1);
		} else e.sequence = null;
		if (previous === undefined) delete e.prev_event_digest;
		else e.prev_event_digest = previous;
		e.event_digest = eventDigest(e);
		previous = e.event_digest;
	}
	assert.equal(verifyChain(events).ok, true);
	return events;
}

function fakeSink(rows) {
	const events = rows;
	let seq = 0;
	return {
		events,
		async append(event) {
			const row = {
				...event,
				event_id: `inv-${seq}`,
				event_digest: `sha256:inv${seq}`,
				recorded_at: new Date(1000).toISOString(),
			};
			seq += 1;
			// Yield before committing so two concurrent commands genuinely interleave.
			await new Promise((resolve) => setImmediate(resolve));
			events.push(row);
			return { ok: true, event: row, durable: true };
		},
	};
}

function schedulerOver(m, sink) {
	return createCampaignScheduler({
		manifest: m,
		ownedTasks: m.tasks,
		sink,
		acquireOwnership: false,
		clock: () => 1000,
		worker: { run: async () => ({ ok: false }) },
		oracle: { judge: async () => ({ status: "unknown" }) },
	});
}

test("INV-01: legitimate concurrent charges at limit 1 accept exactly one (live == replay)", async () => {
	const m = structuredClone(testPlanningManifest({ workDir: out }));
	m.tasks[0].task_budget.tool_calls = 1;
	const sink = fakeSink(acceptedPlanningPrefix({ campaignId: m.campaign_id, requests: ["req-a"] }));
	const scheduler = schedulerOver(m, sink);
	const unit = (id) => ({
		request_id: "req-a",
		tool_call_id: id,
		unit_id: "call",
		tool_name: "aegis_read",
		arguments_digest: digest({ id }),
	});
	const results = await Promise.all([scheduler.chargeTool(unit("tc-1")), scheduler.chargeTool(unit("tc-2"))]);
	assert.deepEqual(
		results.map((r) => r.ok).sort(),
		[false, true],
		`exactly one legitimate charge passes: ${JSON.stringify(results.map((r) => r.reasons))}`,
	);
	assert.match(results.find((r) => !r.ok).reasons.join(";"), /budget_exhausted/);
	// The read-decide-commit is ONE critical section: the refused unit is decided
	// against the committed first charge and is NEVER appended (no rejected row a
	// later reader must filter out).
	const chargedRows = sink.events.filter((e) => e.payload?.kind === "c6.tool" && e.payload.phase === "charged");
	assert.equal(chargedRows.length, 1, "the over-limit charge never reaches the durable log");
	assert.equal(results.find((r) => !r.ok).record_durable, false);
	assert.equal(project(sink.events, m).rejected.length, 0, "no rejected tool row is written");
	assert.equal(project(sink.events, m).tool_charges.length, 1, "replay agrees with the live decision");
	// A finish closes the accepted unit; the refused unit cannot be finished.
	const accepted = results[0].ok ? "tc-1" : "tc-2";
	const refused = accepted === "tc-1" ? "tc-2" : "tc-1";
	assert.equal((await scheduler.finishTool(unit(accepted))).ok, true);
	assert.equal((await scheduler.finishTool(unit(refused))).ok, false);
	assert.equal(project(sink.events, m).tool_charges[0].finished, true);
});

test("INV-02: §7.1 allocation boundary — remaining 12 admits, 13 blocks; allocation is gross", () => {
	const m = structuredClone(manifest);
	m.budget.model_requests = 20; // planning holds 8
	const authority = loadPlanningAuthority({ manifest: m });
	const plan = normal.events.find((e) => e.payload?.kind === "campaign.plan.submitted").payload.plan;
	const withRequests = (counts) => ({
		...plan,
		tasks: plan.tasks.map((t, i) => ({
			...t,
			budget_reservation: { ...t.budget_reservation, model_requests: counts[i] },
		})),
	});
	const compile = (candidate) =>
		compilePlanAdmission({
			plan: candidate,
			manifest: m,
			planningTaskId: "task-plan",
			existingTaskIds: ["task-plan"],
			allocation: { wall_time_ms: 120000, model_requests: 8, tool_calls: 24 },
			templates: authority.templates,
			rootGoalRef: authority.contract.root_goal_ref,
		});
	assert.equal(compile(withRequests([4, 4, 4])).status, "admitted", "8 + 12 = 20 fits exactly");
	const over = compile(withRequests([4, 4, 5]));
	assert.equal(over.status, "blocked");
	assert.match(over.reasons.join(";"), /allocation_exceeded/);
	// Gross allocation never shrinks with consumption: the normal run stays 8 + 12.
	assert.equal(project(normal.events, manifest).budget.allocation_total.model_requests, 20);
});

test("INV-03: an exact duplicate admission is idempotent and never re-allocates", () => {
	const admitted = normal.events.find((e) => e.payload?.kind === "campaign.plan.admitted");
	const at = normal.events.indexOf(admitted);
	const events = structuredClone(normal.events.slice(0, at + 1));
	const repeat = structuredClone(admitted);
	repeat.event_id = "inv-duplicate-admission";
	events.push(repeat);
	const before = project(normal.events.slice(0, at + 1), manifest);
	const after = project(rechain(events), manifest);
	assert.deepEqual(after.budget.allocation_total, before.budget.allocation_total);
	assert.equal(after.rejected.length, 0, JSON.stringify(after.rejected));
	assert.equal(after.dynamic_definitions.length, 3);
});

test("INV-04: invalidation reaches the REAL dependant and withholds the execution permit", () => {
	const doneB = normal.events.findIndex(
		(e) => e.payload?.kind === "campaign.task.completed" && e.payload.task_id === "dyn-b",
	);
	const prefix = structuredClone(normal.events.slice(0, doneB + 1));
	const control = project(prefix, manifest).tasks.find((t) => t.task_id === "dyn-c");
	assert.equal(control.state, "ready", "control: dyn-c (depends on a+b) is ready");
	const scope = project(prefix, manifest).tasks.find((t) => t.task_id === "dyn-a").definition.scope;
	prefix.push({
		event_type: "environment.changed",
		event_id: "inv-env",
		episode_id: "ep-dyn-a",
		schema_version: "1.1",
		source: { kind: "oracle", actor_id: "inv" },
		payload: { scope, reason: "independent invalidation" },
		evidence_refs: [],
	});
	const invalidated = project(rechain(prefix), manifest);
	const dynC = invalidated.tasks.find((t) => t.task_id === "dyn-c");
	assert.equal(dynC.state, "queued", "an unstarted dependant loses its permission");
	assert.equal(dynC.dependency_status["dyn-a"], "invalidated");
	assert.equal(invalidated.tasks.find((t) => t.task_id === "dyn-a").state, "completed", "history is kept");
	// The Board agrees with the queue: dyn-a's Facts left the current view.
	const board = projectBoard(prefix, { manifest });
	assert.equal(board.currentByType.Fact.filter((n) => n.task_id === "dyn-a").length, 0);
	// A start of dyn-c after the invalidation is refused by the reducer itself.
	const started = structuredClone(
		normal.events.find((e) => e.payload?.kind === "campaign.task.started" && e.payload.task_id === "dyn-c"),
	);
	started.event_id = "inv-start-c";
	prefix.push(started);
	const refused = project(rechain(prefix), manifest);
	assert.ok(refused.rejected.some((r) => r.event_id === "inv-start-c" && /dependency_invalidated/.test(r.reason)));
});

test("INV-05: persistent deadline boundary — deadline-1 permits, deadline/+1 refuse", () => {
	const startAt = normal.events.findIndex(
		(e) => e.payload?.kind === "campaign.task.started" && e.payload.task_id === "dyn-a",
	);
	const prefix = normal.events.slice(0, startAt + 1);
	const projection = project(prefix, manifest);
	const deadline = projection.authority.deadlines.byTask["dyn-a"].task;
	assert.equal(typeof deadline, "number");
	const permit = (now) =>
		inspectExecutionPermit({ projection, taskId: "dyn-a", episodeId: "ep-dyn-a", now, operation: "provider_request" });
	assert.equal(permit(deadline - 1).ok, true, JSON.stringify(permit(deadline - 1).reasons));
	for (const now of [deadline, deadline + 1]) {
		const refused = permit(now);
		assert.equal(refused.ok, false);
		assert.ok(refused.reasons.some((r) => r.code === "budget_exhausted"));
	}
	const regressed = permit(projection.authority.deadlines.latest_recorded_at - 1);
	assert.ok(regressed.reasons.some((r) => r.code === "clock_regressed"));
});

test("INV-07: an otherwise-valid correction with a mismatched supersede target retires nothing", () => {
	const isStage = (e, task) =>
		e.payload?.kind === "campaign.oracle.result" && e.payload.task_id === task && !e.payload.task_oracle;
	const target = normal.events.find((e) => isStage(e, "dyn-a"));
	// A legal unknown correction for dyn-b (its OWN binding is valid), pointing at
	// dyn-a's outcome: foreign task/episode/criterion => invalid supersede.
	const own = normal.events.find((e) => isStage(e, "dyn-b"));
	const correction = structuredClone(own);
	correction.event_id = "inv-foreign-supersede";
	correction.payload.outcome_id = "inv-foreign-supersede-outcome";
	Object.assign(correction.payload.outcome, {
		outcome_id: correction.payload.outcome_id,
		status: "unknown",
		observed: null,
		evidence_refs: [],
		supersedes: target.payload.outcome_id,
	});
	const events = rechain([...structuredClone(normal.events), correction]);
	const p = project(events, manifest);
	const reason = p.rejected.find((r) => r.event_id === correction.event_id)?.reason ?? "";
	assert.match(reason, /invalid_supersede: supersede_foreign_task/, "the supersede itself is what refuses it");
	const record = p.authority.outcome_records.find((r) => r.outcome_id === target.payload.outcome_id);
	assert.equal(record.effective, true, "the prior judgment stays effective");
	assert.ok(
		projectBoard(events, { manifest }).currentByType.Fact.some((n) => n.outcome_id === target.payload.outcome_id),
		"the Board agrees: the prior Fact is still current",
	);
	// Control: the SAME correction aimed at its own task's outcome is legal and retires it.
	const legal = structuredClone(correction);
	legal.event_id = "inv-legal-supersede";
	legal.payload.outcome_id = "inv-legal-supersede-outcome";
	legal.payload.outcome.outcome_id = legal.payload.outcome_id;
	legal.payload.outcome.supersedes = own.payload.outcome_id;
	const control = project(rechain([...structuredClone(normal.events), legal]), manifest);
	assert.equal(control.authority.outcome_records.find((r) => r.outcome_id === own.payload.outcome_id).effective, false);
	assert.equal(control.tasks.find((t) => t.task_id === "dyn-c").dependency_status["dyn-b"], "invalidated");
});

test("INV-08: resuming a paused Task re-checks EFFECTIVE dependencies, not completed history", () => {
	const doneB = normal.events.findIndex(
		(e) => e.payload?.kind === "campaign.task.completed" && e.payload.task_id === "dyn-b",
	);
	const prefix = structuredClone(normal.events.slice(0, doneB + 1));
	const host = { kind: "runtime", actor_id: "inv-host" };
	const note = (event_id, payload) => ({
		event_type: "runtime.note",
		event_id,
		schema_version: "1.1",
		source: host,
		payload: { campaign_id: manifest.campaign_id, ...payload },
		evidence_refs: [],
	});
	const scope = project(prefix, manifest).tasks.find((t) => t.task_id === "dyn-a").definition.scope;
	prefix.push(note("inv-pause-c", { kind: "campaign.task.paused", task_id: "dyn-c" }));
	prefix.push({
		event_type: "environment.changed",
		event_id: "inv-env-2",
		episode_id: "ep-dyn-a",
		schema_version: "1.1",
		source: { kind: "oracle", actor_id: "inv" },
		payload: { scope, reason: "independent invalidation" },
		evidence_refs: [],
	});
	prefix.push(note("inv-resume-c", { kind: "campaign.task.resumed", task_id: "dyn-c" }));
	const p = project(rechain(prefix), manifest);
	const reason = p.rejected.find((r) => r.event_id === "inv-resume-c")?.reason ?? "";
	assert.match(reason, /dependency_invalidated/, "the resume is refused for the invalidated prerequisite");
	assert.equal(p.tasks.find((t) => t.task_id === "dyn-c").state, "paused", "resume does not grant a stale permission");
	// Control: without the invalidation the same resume is legal and makes it ready.
	const clean = prefix.filter((e) => e.event_id !== "inv-env-2");
	const ok = project(rechain(clean), manifest);
	assert.equal(ok.rejected.length, 0, JSON.stringify(ok.rejected));
	assert.equal(ok.tasks.find((t) => t.task_id === "dyn-c").state, "ready");
});

test("INV-06: a cached state is never E1 authority; the full source rebuilds the same result", () => {
	const full = project(normal.events, manifest);
	const again = project(structuredClone(normal.events), manifest);
	assert.equal(digest(full.authority.outcome_records), digest(again.authority.outcome_records));
	assert.equal(full.tasks.filter((t) => t.state === "completed").length, 4);
});
