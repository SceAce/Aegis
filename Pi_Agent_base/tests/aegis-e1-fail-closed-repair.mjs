#!/usr/bin/env node
// Aegis E1 Fail-Closed Repair — FC-O (Outcome binding), FC-P (Plan replay),
// FC-I (real SDK/faux integration).
//
// These cases MUST fail on the pre-repair implementation: missing/foreign
// Campaign/Task/Episode/Stage/Source bindings still projected a Fact, and an
// orphan/conflicting `campaign.plan.admitted` still created dynamic tasks.
//
// Run: node Pi_Agent_base/tests/aegis-e1-fail-closed-repair.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLAN_BINDING_VERSION } from "../campaign/authority.mjs";
import { artifactIndexFromEvents } from "../campaign/c3-entry.mjs";
import { compilePlanAdmission, planDigest } from "../campaign/e1-plan-contract.mjs";
import { buildPlanningContract, loadPlanningAuthority } from "../campaign/e1-planning-contract.mjs";
import { projectQueueFromEvents } from "../campaign/projection.mjs";
import { projectBoard } from "../memory/board.mjs";

const BASE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOLVER = join(BASE, "pi", "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
const CHILD = join(BASE, "tests", "helpers", "c6-e1-planning-child.mjs");
const workRoot = mkdtempSync(join(tmpdir(), "aegis-e1-fail-closed-"));
after(() => rmSync(workRoot, { recursive: true, force: true }));

const CAMPAIGN = "campaign-fc";

// ---------------------------------------------------------------------------
// FC-O — Campaign Outcome binding fail closed
// ---------------------------------------------------------------------------

const BOARD_MANIFEST = {
	schema_version: "campaign-1.1",
	campaign_id: CAMPAIGN,
	revision: 1,
	objective: { description: "Repair the dataset", success_criteria: ["c1"] },
	authorization: { allowed_targets: ["dataset.json"], allowed_capabilities: ["data.record.write"] },
	budget: { wall_time_ms: 600000, model_requests: 20, tool_calls: 40 },
	dynamic_task_policy: {
		enabled: true,
		allowed_task_types: ["verify"],
		max_depth: 3,
		max_fan_out: 4,
		max_task_count: 8,
	},
	tasks: [
		{
			task_id: "t-1",
			order: 1,
			depends_on: [],
			target_ref: "dataset.json",
			task_type: "verify",
			goal: { goal_id: "g1", description: "verify", success_criteria: ["c1"] },
			stages: [{ stage_id: "s-1", criteria: ["c1"], required: true }],
			oracle_ref: "fixture.oracle.v1",
			// A COMPLETE trusted binding needs the Task's current scope (fail-closed
			// without it, E1-CC §8.1 item 1).
			scope: { domain: "structured-data" },
		},
	],
};

/** The trusted effect row that produced the evidence BEFORE the judgment. */
function evidenceEvent() {
	return {
		event_type: "action.completed",
		event_id: "effect-t-1",
		episode_id: "ep-1",
		source: { kind: "runtime" },
		payload: { evidence_ref: "artifact:t-1", content_digest: "sha256:x", task_id: "t-1" },
	};
}

function startedEvent(taskId = "t-1", episodeId = "ep-1") {
	return {
		event_type: "runtime.note",
		event_id: `start-${taskId}`,
		source: { kind: "runtime" },
		payload: { kind: "campaign.task.started", campaign_id: CAMPAIGN, task_id: taskId, episode_id: episodeId },
	};
}

function stageOracleEvent() {
	return {
		event_type: "runtime.note",
		event_id: "oracle-stage",
		source: { kind: "oracle" },
		evidence_refs: [],
		payload: {
			kind: "campaign.oracle.result",
			campaign_id: CAMPAIGN,
			task_id: "t-1",
			outcome_id: "so-stage",
			status: "success",
			step_id: "s-1",
			episode_id: "ep-1",
			outcome: {
				outcome_id: "so-stage",
				level: "step",
				step_id: "s-1",
				stage_id: "s-1",
				status: "success",
				task_id: "t-1",
				episode_id: "ep-1",
				criterion: { criterion_id: "c1", expected: "x" },
				observed: "x",
				scope: { domain: "structured-data" },
				oracle: { oracle_id: "fixture.oracle.v1", source: "oracle" },
				provenance: { source: "oracle", independent: true, task_id: "t-1", stage_id: "s-1" },
				evidence_refs: [{ ref_type: "artifact", ref_id: "artifact:t-1", digest: "sha256:x" }],
			},
		},
	};
}

function boardOf(events) {
	// Evidence must be committed before the claim; the Board and the queue share
	// the Campaign authority, so a Fact needs a judgment the queue also accepts.
	return projectBoard([evidenceEvent(), ...events], { manifest: BOARD_MANIFEST });
}
function factFor(board, eventId) {
	return board.byType.Fact.find((node) => node.origin_event_id === eventId);
}
function hintFor(board, eventId) {
	return board.byType.Hint.find((node) => node.origin_event_id === eventId);
}

test("FC-O-01: a complete trusted Oracle binding still becomes one traceable Fact", () => {
	const board = boardOf([startedEvent(), stageOracleEvent()]);
	const fact = factFor(board, "oracle-stage");
	assert.ok(fact, "the fully-bound stage success must stay a Fact");
	assert.equal(fact.task_id, "t-1");
	assert.equal(fact.episode_id, "ep-1");
	assert.ok(fact.evidence_refs.length > 0);
});

test("FC-O-02: a missing envelope task_id is downgraded to a reasoned Hint", () => {
	const event = stageOracleEvent();
	delete event.payload.task_id;
	const board = boardOf([startedEvent(), event]);
	assert.equal(factFor(board, "oracle-stage"), undefined);
	const hint = hintFor(board, "oracle-stage");
	assert.ok(hint, "the downgrade is visible");
	assert.match(hint.downgrade_reason, /task_id/);
});

test("FC-O-03: a missing inner task/provenance binding is downgraded", () => {
	const event = stageOracleEvent();
	delete event.payload.outcome.task_id;
	delete event.payload.outcome.provenance.task_id;
	const board = boardOf([startedEvent(), event]);
	assert.equal(factFor(board, "oracle-stage"), undefined);
	assert.match(hintFor(board, "oracle-stage").downgrade_reason, /task_id/);
});

test("FC-O-04: a missing or foreign campaign is downgraded", () => {
	const missing = stageOracleEvent();
	delete missing.payload.campaign_id;
	const boardMissing = boardOf([startedEvent(), missing]);
	assert.equal(factFor(boardMissing, "oracle-stage"), undefined);
	assert.match(hintFor(boardMissing, "oracle-stage").downgrade_reason, /campaign/);

	const foreign = stageOracleEvent();
	foreign.payload.campaign_id = "campaign-other";
	const boardForeign = projectBoard([startedEvent(), foreign], { manifest: BOARD_MANIFEST });
	assert.equal(factFor(boardForeign, "oracle-stage"), undefined);
	assert.match(hintFor(boardForeign, "oracle-stage").downgrade_reason, /campaign/);
});

test("FC-O-05: a missing / unstarted / foreign episode is downgraded", () => {
	const missing = stageOracleEvent();
	delete missing.payload.outcome.episode_id;
	const boardMissing = boardOf([startedEvent(), missing]);
	assert.equal(factFor(boardMissing, "oracle-stage"), undefined);
	assert.match(hintFor(boardMissing, "oracle-stage").downgrade_reason, /episode/);

	const unstarted = boardOf([stageOracleEvent()]);
	assert.equal(factFor(unstarted, "oracle-stage"), undefined);
	assert.match(hintFor(unstarted, "oracle-stage").downgrade_reason, /episode/);

	const foreign = stageOracleEvent();
	foreign.payload.outcome.episode_id = "ep-foreign";
	const boardForeign = boardOf([startedEvent(), foreign]);
	assert.equal(factFor(boardForeign, "oracle-stage"), undefined);
	assert.match(hintFor(boardForeign, "oracle-stage").downgrade_reason, /episode/);
});

test("FC-O-06: a missing / mismatched / foreign stage is downgraded", () => {
	const missing = stageOracleEvent();
	delete missing.payload.step_id;
	const boardMissing = boardOf([startedEvent(), missing]);
	assert.equal(factFor(boardMissing, "oracle-stage"), undefined);
	assert.match(hintFor(boardMissing, "oracle-stage").downgrade_reason, /step_id/);

	const mismatch = stageOracleEvent();
	mismatch.payload.outcome.step_id = "s-2";
	const boardMismatch = boardOf([startedEvent(), mismatch]);
	assert.equal(factFor(boardMismatch, "oracle-stage"), undefined);
	assert.match(hintFor(boardMismatch, "oracle-stage").downgrade_reason, /stage|step/);

	const foreign = stageOracleEvent();
	foreign.payload.step_id = "s-foreign";
	foreign.payload.outcome.step_id = "s-foreign";
	foreign.payload.outcome.stage_id = "s-foreign";
	const boardForeign = boardOf([startedEvent(), foreign]);
	assert.equal(factFor(boardForeign, "oracle-stage"), undefined);
	assert.match(hintFor(boardForeign, "oracle-stage").downgrade_reason, /stage|step/);
});

test("FC-O-07: a missing / inconsistent provenance source is downgraded", () => {
	const missing = stageOracleEvent();
	delete missing.payload.outcome.provenance.source;
	const boardMissing = boardOf([startedEvent(), missing]);
	assert.equal(factFor(boardMissing, "oracle-stage"), undefined);
	assert.match(hintFor(boardMissing, "oracle-stage").downgrade_reason, /source/);

	const mismatch = stageOracleEvent();
	mismatch.payload.outcome.provenance.source = "platform";
	const boardMismatch = boardOf([startedEvent(), mismatch]);
	assert.equal(factFor(boardMismatch, "oracle-stage"), undefined);
	assert.match(hintFor(boardMismatch, "oracle-stage").downgrade_reason, /source/);
});

test("FC-O-08: missing evidence, unknown status and a runtime/llm source never become a Fact", () => {
	const noEvidence = stageOracleEvent();
	noEvidence.payload.outcome.evidence_refs = [];
	noEvidence.evidence_refs = [];
	const boardNoEvidence = boardOf([startedEvent(), noEvidence]);
	assert.equal(factFor(boardNoEvidence, "oracle-stage"), undefined);
	assert.equal(hintFor(boardNoEvidence, "oracle-stage").type, "Hint");

	const unknown = stageOracleEvent();
	unknown.payload.status = "unknown";
	unknown.payload.outcome.status = "unknown";
	const boardUnknown = boardOf([startedEvent(), unknown]);
	assert.equal(factFor(boardUnknown, "oracle-stage"), undefined);

	const llm = stageOracleEvent();
	llm.source.kind = "llm";
	const boardLlm = boardOf([startedEvent(), llm]);
	assert.equal(factFor(boardLlm, "oracle-stage"), undefined);
});

// ---------------------------------------------------------------------------
// FC-P — Plan replay identity chain fail closed
// ---------------------------------------------------------------------------

const PLAN = {
	version: "aegis-plan-1.0",
	plan_id: "plan-fc",
	root_goal_ref: "campaign-root",
	tasks: [
		{
			proposed_task_id: "dyn-1",
			parent_task_id: "task-plan",
			depends_on: [],
			goal: { description: "verify", success_criteria: ["data.status == active"] },
			task_type: "verify",
			target_ref: "dataset.json",
			required_capabilities: ["data.record.write"],
			expected_evidence: ["artifact:dyn-1"],
			stop_condition: "judged",
			priority: 1,
			budget_reservation: { wall_time_ms: 30000, model_requests: 4, tool_calls: 8 },
		},
	],
};
const PLAN_DIGEST = planDigest(PLAN);
// FIXTURE MIGRATION (E1-CC §4.2): a plan admission is only executable under the
// Manifest's frozen planning contract; a contract-less Manifest is
// `legacy_context_unavailable`. The positive chain therefore uses a contract
// Manifest, an accepted planning start and Host-bound envelopes. The negative
// cases keep their original assertions and now fail for their own cause.
const PLAN_SCOPE = { environment_fingerprint: "data-repair-env", domain: "structured-data", permissions: [] };
const PLAN_BASE = {
	...BOARD_MANIFEST,
	objective: {
		description: "g",
		success_criteria: ["data.status == active"],
		required_criteria: ["data.status == active"],
	},
	tasks: [
		{
			task_id: "task-plan",
			order: 1,
			depends_on: [],
			target_ref: "dataset.json",
			task_type: "observe",
			goal: { goal_id: "plan_campaign", description: "plan", success_criteria: ["plan_ready"] },
			stages: [{ stage_id: "stage-plan", criteria: ["plan_ready"], required: true }],
			oracle_ref: "fixture.oracle.v1",
		},
	],
};
const CONTRACT = buildPlanningContract({
	manifest: PLAN_BASE,
	templates: [
		{
			template_ref: "verify",
			task_type: "verify",
			oracle_ref: "fixture.oracle.v1",
			required_capabilities: ["data.record.write"],
			success_criteria: ["data.status == active"],
			scope: PLAN_SCOPE,
		},
	],
	requiredCriteria: ["data.status == active"],
});
assert.equal(CONTRACT.ok, true, JSON.stringify(CONTRACT.reasons));
const PLAN_MANIFEST = { ...PLAN_BASE, planning_contract: CONTRACT.contract };
const AUTHORITY = loadPlanningAuthority({ manifest: PLAN_MANIFEST });
const ADMISSION = compilePlanAdmission({
	plan: PLAN,
	manifest: PLAN_MANIFEST,
	planningTaskId: "task-plan",
	existingTaskIds: ["task-plan"],
	allocation: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 },
	templates: AUTHORITY.templates,
	rootGoalRef: AUTHORITY.contract.root_goal_ref,
});
assert.equal(ADMISSION.status, "admitted", "control: the plan normalizes");
const BINDING = {
	binding_version: PLAN_BINDING_VERSION,
	manifest_revision: PLAN_MANIFEST.revision,
	manifest_digest: AUTHORITY.manifest_digest,
	context_digest: AUTHORITY.context_digest,
	episode_id: "ep-task-plan",
};

function campaignEvent(kind, payload, { id, source = "runtime" } = {}) {
	return {
		event_type: "runtime.note",
		event_id: id,
		source: { kind: source },
		payload: { kind, campaign_id: CAMPAIGN, ...payload },
		evidence_refs: [],
	};
}
function submitted(payload = {}) {
	return campaignEvent(
		"campaign.plan.submitted",
		{ plan_id: "plan-fc", plan_digest: PLAN_DIGEST, plan: PLAN, planning_task_id: "task-plan", ...BINDING, ...payload },
		{ id: "submitted-1" },
	);
}
function admitted(payload = {}) {
	return campaignEvent(
		"campaign.plan.admitted",
		{
			plan_id: "plan-fc",
			plan_digest: PLAN_DIGEST,
			planning_task_id: "task-plan",
			plan_tasks: ADMISSION.normalized,
			reserved_budget: ADMISSION.reserved_budget,
			...BINDING,
			...payload,
		},
		{ id: "admitted-1" },
	);
}
function project(events) {
	return projectQueueFromEvents({
		campaign_id: CAMPAIGN,
		tasks: PLAN_MANIFEST.tasks,
		events: [
			campaignEvent(
				"campaign.task.started",
				{ task_id: "task-plan", episode_id: "ep-task-plan" },
				{ id: "start-plan" },
			),
			...events,
		],
		revision: 1,
		manifest: PLAN_MANIFEST,
		artifacts: {},
	});
}
function reasonsText(projection) {
	return (projection.rejected ?? []).map((entry) => entry.reason).join(" ; ");
}

test("FC-P-01: a normal submitted -> admitted chain admits and creates the dynamic task", () => {
	const projection = project([submitted(), admitted()]);
	assert.deepEqual(projection.rejected, [], reasonsText(projection));
	assert.ok(projection.tasks.some((task) => task.task_id === "dyn-1"));
	const plan = projection.plans.find((entry) => entry.id === "plan-fc");
	assert.equal(plan.status, "admitted");
});

test("FC-P-02: an admitted event without a prior submitted creates no dynamic task", () => {
	const projection = project([admitted()]);
	assert.ok(projection.rejected.length > 0, "the orphan admission must be rejected");
	assert.equal(
		projection.tasks.some((task) => task.task_id === "dyn-1"),
		false,
	);
	assert.equal(projection.plans.find((entry) => entry.id === "plan-fc")?.status ?? "absent", "absent");
});

test("FC-P-03: a submitted/admitted digest conflict creates no dynamic task", () => {
	const projection = project([submitted(), admitted({ plan_digest: "sha256:conflict" })]);
	assert.ok(projection.rejected.length > 0, "the digest conflict must be rejected");
	assert.equal(
		projection.tasks.some((task) => task.task_id === "dyn-1"),
		false,
	);
});

test("FC-P-04: a declared digest that does not match planDigest(plan) is refused", () => {
	const projection = project([submitted({ plan_digest: "sha256:bogus" }), admitted({ plan_digest: "sha256:bogus" })]);
	assert.ok(projection.rejected.length > 0, "the mismatched declared digest must be rejected");
	assert.equal(
		projection.tasks.some((task) => task.task_id === "dyn-1"),
		false,
	);
});

test("FC-P-05: a planning-task identity mismatch creates no dynamic task", () => {
	const projection = project([submitted(), admitted({ planning_task_id: "task-other" })]);
	assert.ok(projection.rejected.length > 0, "the planning identity mismatch must be rejected");
	assert.equal(
		projection.tasks.some((task) => task.task_id === "dyn-1"),
		false,
	);
});

test("FC-P-06: identical repeated submitted/admitted events are idempotent", () => {
	const baseline = project([submitted(), admitted()]);
	const repeated = project([submitted(), submitted(), admitted(), admitted()]);
	assert.deepEqual(repeated.rejected, [], reasonsText(repeated));
	assert.equal(repeated.tasks.filter((task) => task.task_id === "dyn-1").length, 1);
	assert.deepEqual(repeated.budget.reserved, baseline.budget.reserved, "no duplicate reservation");
});

test("FC-P-07: an admitted-only prefix stays held (no dispatch)", () => {
	const projection = project([submitted(), admitted()]);
	const child = projection.tasks.find((task) => task.task_id === "dyn-1");
	assert.equal(child.awaiting_plan_ready, true);
	assert.equal(child.state, "queued");
});

// ---------------------------------------------------------------------------
// FC-I — real SDK/faux integration
// ---------------------------------------------------------------------------

function runChild(dir, scenario) {
	mkdirSync(dir, { recursive: true });
	return spawnSync(process.execPath, ["--import", RESOLVER, CHILD, dir, scenario], {
		encoding: "utf8",
		timeout: 60000,
		maxBuffer: 32 * 1024 * 1024,
	});
}

test("FC-I-01: the real SDK/faux normal chain has zero rejected and consistent Facts/graph", () => {
	const dir = join(workRoot, "normal");
	const run = runChild(dir, "normal_plan");
	assert.equal(run.status, 0, run.stderr?.slice(-1200));
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	const events = readFileSync(join(dir, "events.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const projection = projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: manifest.tasks ?? [],
		events,
		revision: manifest.revision ?? 0,
		manifest,
		artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
	});
	assert.deepEqual(projection.rejected, []);
	const view = projectBoard(events, { manifest });
	const facts = view.byType.Fact;
	assert.ok(facts.some((node) => node.task_id === "dyn-a"));
	assert.ok(facts.some((node) => node.task_id === "dyn-b"));
	assert.ok(facts.some((node) => node.task_id === "dyn-c"));
});

test("FC-I-02: a second real process over the same log adds no provider call or Broker effect", () => {
	const dir = join(workRoot, "restart");
	assert.equal(runChild(dir, "normal_plan").status, 0);
	const again = runChild(dir, "restart");
	assert.equal(again.status, 0, again.stderr?.slice(-1200));
	const summary = JSON.parse(readFileSync(join(dir, "summary-restart.json"), "utf8"));
	assert.equal(summary.provider_calls, 0);
	assert.equal(summary.broker_effects, 0);
	assert.deepEqual(summary.dataset, { name: "Ada", status: "active" });
	assert.equal(summary.task_states["dyn-c"], "completed");
});
