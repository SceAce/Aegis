#!/usr/bin/env node
// Aegis C1 Final Audit Fix — EXTERNAL adversarial supplement tests.
//
// Author: external auditor (human-directed session), 2026-10-12.
// Purpose: probe boundaries the DS's own suite (aegis-campaign-c1-final-audit2.mjs)
// does NOT cover. Expectations derive from docs/C1_FINAL_AUDIT_FIX_TASK.md and the
// F7–F9 contract semantics, NOT from the implementation.
//
// Offline: no network, no model, no real Pi Session.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-c1-final-audit3-adversarial.mjs

import assert from "node:assert/strict";

import { createCampaignScheduler, projectionSnapshot, projectQueueFromEvents } from "../campaign/index.mjs";
import { canonicalStageOutcome, currentTaskScope } from "../campaign/projection.mjs";

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

const CAMPAIGN = "campaign-f789-adv";
const EP = "ep-1";
const TASK_SCOPE = { env: "prod" };

function ev(o, kind, payload, source = { kind: "runtime" }) {
	return {
		schema_version: "1.1",
		event_type: "runtime.note",
		event_id: `e${o}`,
		sequence: o,
		source,
		payload: { kind, campaign_id: CAMPAIGN, ...payload },
		event_digest: `sha256:e${o}`,
	};
}

const taskA = {
	task_id: "task-a",
	order: 1,
	depends_on: [],
	goal: { goal_id: "goal-a", description: "a", success_criteria: ["c-a"] },
	stages: [
		{ stage_id: "stage-a", criteria: ["c-a"], required: true },
		{ stage_id: "stage-opt", criteria: ["c-opt"], required: false },
	],
	scope: TASK_SCOPE,
	task_budget: { wall_time_ms: 100, model_requests: 3, tool_calls: 3 },
};
const ARTIFACTS = { "artifact:task-a": { ref_id: "artifact:task-a", digest: "sha256:content-a" } };

function stageOutcome(over = {}) {
	return {
		outcome_id: "so-a",
		level: "step",
		step_id: "stage-a",
		status: "success",
		episode_id: EP,
		task_id: "task-a",
		criterion: { criterion_id: "c-a", expected: "c-a" },
		observed: { synthetic: true },
		scope: { ...TASK_SCOPE },
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: "task-a", stage_id: "stage-a" },
		evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:task-a", digest: "sha256:content-a" }],
		...over,
	};
}

function taskOutcome(over = {}) {
	return {
		outcome_id: "o-a",
		level: "episode",
		status: "success",
		episode_id: EP,
		task_id: "task-a",
		task_oracle: true,
		criterion: { criterion_id: "goal-a", expected: "goal-a" },
		observed: { synthetic: true },
		scope: { ...TASK_SCOPE },
		oracle: { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: "task-a" },
		evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:task-a", digest: "sha256:content-a" }],
		...over,
	};
}

function stageEvent(o, outcome) {
	return ev(
		o,
		"campaign.oracle.result",
		{ task_id: "task-a", outcome_id: outcome.outcome_id, status: outcome.status, step_id: outcome.step_id, outcome },
		{ kind: "oracle" },
	);
}
function taskEvent(o, outcome) {
	return ev(
		o,
		"campaign.oracle.result",
		{
			task_id: "task-a",
			outcome_id: outcome.outcome_id,
			status: outcome.status,
			task_oracle: true,
			episode_id: EP,
			outcome,
		},
		{ kind: "oracle" },
	);
}

function project(events, tasks = [taskA]) {
	return projectQueueFromEvents({ campaign_id: CAMPAIGN, tasks, events, artifacts: ARTIFACTS });
}

// ---------------------------------------------------------------------------
// A1. F7 — the completion gate is genuinely symmetric: a NORMAL completion
// (campaign.task.completed) must be blocked by the same missing-stage evidence
// that blocks reconciliation. (The DS suite only tested the reconciliation side.)
// ---------------------------------------------------------------------------

await test("A1-NORMAL-COMPLETION-GATE: campaign.task.completed without stage evidence is rejected", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		taskEvent(1, taskOutcome()),
		ev(2, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
	];
	const p = project(events);
	assert.notEqual(p.tasks[0].state, "completed", "normal completion must pass the same stage gate");
	assert.ok(
		p.tasks[0].state === "waiting_oracle" || p.tasks[0].state === "running",
		`unexpected state ${p.tasks[0].state}`,
	);
});

await test("A1-NORMAL-COMPLETION-FULL: campaign.task.completed WITH stage evidence completes", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, stageOutcome()),
		taskEvent(2, taskOutcome()),
		ev(3, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
	];
	const p = project(events);
	assert.equal(p.tasks[0].state, "completed", p.rejected.map((r) => r.reason).join("; "));
});

// ---------------------------------------------------------------------------
// A2. F7 — a reconciliation whose resolved outcome_id references a DIFFERENT
// (foreign) outcome, while a valid current success exists, must not complete.
// (DS tested outcome-id mismatch only implicitly through F7-NO-STAGE.)
// ---------------------------------------------------------------------------

await test("A2-RECONCILE-FOREIGN-REF: reconciliation referencing a foreign outcome id does not complete", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, stageOutcome()),
		taskEvent(2, taskOutcome()),
		ev(3, "campaign.reconciliation.resolved", { task_id: "task-a", outcome_id: "o-foreign", verdict: "success" }),
	];
	const p = project(events);
	assert.notEqual(p.tasks[0].state, "completed", "a foreign outcome reference must not complete the task");
});

// ---------------------------------------------------------------------------
// A3. F7 — REQUIRED vs OPTIONAL stages. A missing OPTIONAL stage must NOT block
// completion (the gate filters required !== false), and a failed optional stage
// must not block either. A failed REQUIRED stage must block.
// ---------------------------------------------------------------------------

await test("A3-OPTIONAL-MISSING: a missing optional stage does not block completion", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, stageOutcome()),
		taskEvent(2, taskOutcome()),
		ev(3, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
	];
	const p = project(events);
	assert.equal(p.tasks[0].state, "completed", "stage-opt (required:false) is not required for the gate");
});

await test("A3-OPTIONAL-FAILED: a failed optional stage does not block completion", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, stageOutcome()),
		ev(
			2,
			"campaign.oracle.result",
			{
				task_id: "task-a",
				outcome_id: "so-opt",
				status: "failure",
				step_id: "stage-opt",
				episode_id: EP,
				outcome: stageOutcome({
					outcome_id: "so-opt",
					step_id: "stage-opt",
					status: "failure",
					criterion: { criterion_id: "c-opt", expected: "c-opt" },
					evidence_refs: [],
					observed: { synthetic: false },
				}),
			},
			{ kind: "oracle" },
		),
		taskEvent(3, taskOutcome()),
		ev(4, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
	];
	const p = project(events);
	assert.equal(
		p.tasks[0].state,
		"completed",
		`a failed OPTIONAL stage must not block: ${p.rejected.map((r) => r.reason).join("; ")}`,
	);
});

await test("A3-REQUIRED-FAILED: a failed required stage blocks completion", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		ev(
			1,
			"campaign.oracle.result",
			{
				task_id: "task-a",
				outcome_id: "so-a-f",
				status: "failure",
				step_id: "stage-a",
				episode_id: EP,
				outcome: stageOutcome({ status: "failure", observed: null, evidence_refs: [] }),
			},
			{ kind: "oracle" },
		),
		taskEvent(2, taskOutcome()),
		ev(3, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
	];
	const p = project(events);
	assert.notEqual(p.tasks[0].state, "completed", "a failed REQUIRED stage must block completion");
});

// ---------------------------------------------------------------------------
// A4. F7 — a required stage satisfied by MULTIPLE criteria: the gate must
// require every declared criterion of a required stage, not just one.
// ---------------------------------------------------------------------------

await test("A4-MULTI-CRITERION: a stage with two criteria needs both satisfied", () => {
	const taskMulti = {
		...taskA,
		stages: [{ stage_id: "stage-m", criteria: ["c-1", "c-2"], required: true }],
	};
	const mk = (cid, oid) =>
		ev(
			oid === "so-1" ? 1 : 2,
			"campaign.oracle.result",
			{
				task_id: "task-a",
				outcome_id: oid,
				status: "success",
				step_id: "stage-m",
				episode_id: EP,
				outcome: stageOutcome({
					outcome_id: oid,
					step_id: "stage-m",
					criterion: { criterion_id: cid, expected: cid },
				}),
			},
			{ kind: "oracle" },
		);
	// Only c-1 present.
	const partial = project(
		[
			ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
			mk("c-1", "so-1"),
			taskEvent(3, taskOutcome()),
			ev(4, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
		],
		[taskMulti],
	);
	assert.notEqual(partial.tasks[0].state, "completed", "c-2 unsatisfied must block");
	// Both present.
	const full = project(
		[
			ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
			mk("c-1", "so-1"),
			mk("c-2", "so-2"),
			taskEvent(3, taskOutcome()),
			ev(4, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
		],
		[taskMulti],
	);
	assert.equal(
		full.tasks[0].state,
		"completed",
		`both criteria satisfied must complete: ${full.rejected.map((r) => r.reason).join("; ")}`,
	);
});

// ---------------------------------------------------------------------------
// A5. F8 — canonicalStageOutcome must NOT let `observed` or `oracle` or
// `provenance` silently collapse, and a null evidence_refs must normalize to [].
// ---------------------------------------------------------------------------

await test("A5-CANONICAL-COMPLETENESS: observed/oracle/provenance/failure_mode all survive canonicalization", () => {
	const src = stageOutcome({
		observed: { real: "observation" },
		oracle: { oracle_id: "real.oracle", source: "oracle" },
		provenance: { source: "oracle", independent: true, task_id: "task-a", stage_id: "stage-a" },
		failure_mode: "none",
		supersedes: "so-old",
	});
	const c = canonicalStageOutcome(src);
	assert.equal(c.observed.real, "observation");
	assert.equal(c.oracle.oracle_id, "real.oracle");
	assert.equal(c.provenance.stage_id, "stage-a");
	assert.equal(c.failure_mode, "none");
	assert.equal(c.supersedes, "so-old");
});

await test("A5-CANONICAL-EVIDENCE-NULL: null evidence_refs canonicalize to an empty array", () => {
	const c = canonicalStageOutcome(stageOutcome({ evidence_refs: null }));
	assert.deepEqual(c.evidence_refs, []);
});

await test("A5-CANONICAL-NULLISH: a nullish outcome canonicalizes fail-closed, not crash", () => {
	const c = canonicalStageOutcome(null);
	assert.equal(c.status, null);
	assert.equal(c.step_id, null);
	assert.deepEqual(c.evidence_refs, []);
});

// ---------------------------------------------------------------------------
// A6. F8 — idempotent replay: committing the SAME stage outcome_id twice does
// not duplicate it in stage_outcomes nor the outcomes index.
// ---------------------------------------------------------------------------

await test("A6-IDEMPOTENT-STAGE: a duplicated stage outcome event is not double-recorded", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, stageOutcome()),
		stageEvent(2, stageOutcome()), // same outcome_id "so-a", same content
	];
	const p = project(events);
	const task = p.tasks[0];
	assert.equal(task.stage_outcomes.length, 1, `expected 1 canonical stage outcome, got ${task.stage_outcomes.length}`);
	assert.equal(p.outcomes.size, 1, `expected 1 indexed outcome, got ${p.outcomes.size}`);
});

// ---------------------------------------------------------------------------
// A7. F9 — currentTaskScope resolution order and the scheduler path.
// ---------------------------------------------------------------------------

await test("A7-SCOPE-ORDER: definition.scope wins over task.scope; fallback chain ends in null", () => {
	const withDef = { definition: { scope: { env: "def" } }, scope: { env: "row" } };
	assert.deepEqual(currentTaskScope(withDef), { env: "def" });
	const rowOnly = { scope: { env: "row" } };
	assert.deepEqual(currentTaskScope(rowOnly), { env: "row" });
	assert.equal(currentTaskScope({}), null);
	assert.equal(currentTaskScope(null), null);
});

await test("A7-SCOPE-PROVENANCE: outcome scope falls back to provenance.scope in the resolver path", () => {
	// The projection reads scope from outcome.scope ?? provenance.scope (F9). An
	// outcome carrying scope ONLY on provenance against a declared task scope must
	// be judged by the provenance value.
	const r = project([
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		ev(
			1,
			"campaign.oracle.result",
			{
				task_id: "task-a",
				outcome_id: "o-p",
				status: "success",
				task_oracle: true,
				episode_id: EP,
				outcome: taskOutcome({
					outcome_id: "o-p",
					scope: null,
					provenance: { source: "oracle", independent: true, task_id: "task-a", scope: { env: "prod" } },
				}),
			},
			{ kind: "oracle" },
		),
	]);
	assert.ok(
		r.tasks[0].task_outcomes.some((o) => o.outcome_id === "o-p" && o.status === "success"),
		`provenance scope {env:prod} matches TASK_SCOPE and must resolve: ${r.rejected.map((x) => x.reason).join("; ")}`,
	);
});

await test("A7-SCOPE-EMPTY-OBJECT: an empty-object scope is a real (declared-empty) scope, not missing", () => {
	// currentTaskScope must distinguish null (missing → fail-closed) from {} (an
	// explicitly empty scope that a {} outcome legitimately matches).
	const taskEmpty = { ...taskA, scope: {} };
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, stageOutcome({ scope: {} })),
		taskEvent(2, taskOutcome({ scope: {} })),
		ev(3, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
	];
	const p = project(events, [taskEmpty]);
	assert.equal(p.tasks[0].state, "completed", p.rejected.map((r) => r.reason).join("; "));
});

// ---------------------------------------------------------------------------
// A8. F7 — reconciliation SOFT gate: a blocked resolution must leave the task in
// its evidence state, record the reason, and set reconciliation_state back to
// "pending" (not "resolved").
// ---------------------------------------------------------------------------

await test("A8-SOFT-GATE-STATE: a blocked reconciliation keeps the evidence state and records the reason", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		taskEvent(1, taskOutcome()),
		ev(2, "campaign.reconciliation.resolved", { task_id: "task-a", outcome_id: "o-a", verdict: "success" }),
	];
	const p = project(events);
	const t = p.tasks[0];
	assert.equal(t.state, "running", "the evidence state is preserved (never left running)");
	assert.equal(t.reconciliation_state, "pending", `expected pending, got ${t.reconciliation_state}`);
	assert.ok(
		typeof t.reconciliation_reason === "string" && t.reconciliation_reason.length > 0,
		"the blocked reason is recorded for audit",
	);
});

// ---------------------------------------------------------------------------
// A9. End-to-end scheduler: a stranded-running task whose oracle reconcile
// returns success WITHOUT stage_outcomes must NOT complete (the scheduler-side
// F7 gate), and the worker must not re-run.
// ---------------------------------------------------------------------------

await test("A9-RECONCILE-NO-STAGES: scheduler reconciliation without stage evidence does not complete", async () => {
	const sink = {
		events: [],
		async append(event) {
			const row = {
				...event,
				event_id: `e${this.events.length}`,
				sequence: this.events.length,
				event_digest: `sha256:e${this.events.length}`,
			};
			this.events.push(row);
			return { ok: true, event: row, durable: true };
		},
		replay() {
			return this.events.slice();
		},
	};
	await sink.append({
		event_type: "runtime.note",
		source: { kind: "runtime" },
		payload: { kind: "campaign.task.started", campaign_id: CAMPAIGN, task_id: "task-a", episode_id: "ep-task-a" },
	});
	const dispatched = [];
	const scheduler = createCampaignScheduler({
		manifest: { campaign_id: CAMPAIGN, revision: 1, schema_version: "campaign-1.0", budget: {}, tasks: [taskA] },
		ownedTasks: [taskA],
		baseDir: null,
		sink,
		artifacts: ARTIFACTS,
		worker: {
			async run({ task }) {
				dispatched.push(task.task_id);
				return { ok: true, outcome_ref: "artifact:task-a" };
			},
		},
		oracle: {
			async judge() {
				return { status: "unknown", failure_mode: "oracle_unavailable" };
			},
			// Success WITHOUT stage_outcomes — must be blocked by the F7 gate.
			async reconcile() {
				return {
					status: "success",
					outcome_id: "o-rec",
					outcome: taskOutcome({ outcome_id: "o-rec", episode_id: "ep-task-a" }),
				};
			},
		},
		clock: () => 1,
		acquireOwnership: false,
	});
	const result = await scheduler.run();
	const t = result.status.tasks.find((x) => x.task_id === "task-a");
	assert.notEqual(t.state, "completed", "reconcile success without stage evidence must not complete");
	assert.equal(dispatched.includes("task-a"), false, "the worker is not re-run");
});

// ---------------------------------------------------------------------------
// A10. A blocked reconciliation must remain pending in the snapshot.
// Completeness of the other snapshot fields is audited separately; this test
// must not freeze an existing omission as expected behavior.
// ---------------------------------------------------------------------------

await test("A10-SNAPSHOT-RECON-SURFACE: snapshot carries reconciliation state (documents current surface)", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		taskEvent(1, taskOutcome()),
		ev(2, "campaign.reconciliation.resolved", { task_id: "task-a", outcome_id: "o-a", verdict: "success" }),
	];
	const snap = projectionSnapshot(project(events));
	const t = snap.tasks[0];
	assert.equal(t.reconciliation_state, "pending");
	assert.equal(project(events).tasks[0].reconciliation_state, t.reconciliation_state);
});

// ---------------------------------------------------------------------------
// A11. Cross-boundary negative cases. These are behavioral regression tests,
// not mutation runs.
// ---------------------------------------------------------------------------

await test("A11-STAGE-THEN-CORRUPT-TASK: valid stage + task success with unresolvable evidence does not complete", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		stageEvent(1, stageOutcome()),
		ev(
			2,
			"campaign.oracle.result",
			{
				task_id: "task-a",
				outcome_id: "o-bad",
				status: "success",
				task_oracle: true,
				episode_id: EP,
				outcome: taskOutcome({
					outcome_id: "o-bad",
					evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:missing", digest: "sha256:x" }],
				}),
			},
			{ kind: "oracle" },
		),
		ev(3, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-bad" }),
	];
	const p = project(events);
	assert.notEqual(p.tasks[0].state, "completed", "an unresolvable task-level evidence ref must block");
});

await test("A11-RUNTIME-JUDGES: a stage outcome committed by runtime is rejected", () => {
	const events = [
		ev(0, "campaign.task.started", { task_id: "task-a", episode_id: EP }),
		ev(1, "campaign.oracle.result", {
			task_id: "task-a",
			outcome_id: "so-rt",
			status: "success",
			step_id: "stage-a",
			episode_id: EP,
			outcome: stageOutcome({ outcome_id: "so-rt" }),
		}), // source defaults to {kind:"runtime"} — must be rejected as a judge
		taskEvent(2, taskOutcome()),
		ev(3, "campaign.task.completed", { task_id: "task-a", outcome_id: "o-a" }),
	];
	const p = project(events);
	assert.notEqual(p.tasks[0].state, "completed", "runtime may never judge a stage");
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C1 final audit3 (adversarial): ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign C1 final audit3 (adversarial): all assertions passed");
