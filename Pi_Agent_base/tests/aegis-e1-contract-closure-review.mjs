#!/usr/bin/env node
// Independent review of 7940112 against E1-CC-1.0. Red assertions are intentional
// regression evidence, not an implementation acceptance or a product fix.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { summarizeRequestLedger } from "../campaign/c6-request-lifecycle.mjs";
import { planDigest, validatePlanGraph } from "../campaign/e1-plan-contract.mjs";
import { admitCandidatePlan, buildPlanningManifest } from "../campaign/e1-planning.mjs";
import { loadPlanningAuthority, normalizeExecutableTask } from "../campaign/e1-planning-contract.mjs";
import { projectQueueFromEvents } from "../campaign/projection.mjs";
import { createCampaignScheduler } from "../campaign/scheduler.mjs";
import { buildDataRepairManifest } from "../execution/adapters/structured-data-adapter.mjs";
import { projectBoard } from "../memory/board.mjs";
import { digest } from "../shared/contracts.mjs";
import { EventLog, eventDigest, verifyChain } from "../shared/events.mjs";
import {
	evidenceDir,
	project,
	runPlanningScenario,
	TEST_PLANNING_CONFIG,
	testPlanningManifest,
} from "./helpers/e1-closure-helpers.mjs";

const out = evidenceDir("external-review");
console.log(`Independent review evidence: ${out}`);
const normal = runPlanningScenario({ workDir: out, scenario: "normal_plan" });
assert.equal(normal.exit, 0, normal.stderr.slice(-600));
assert.equal(verifyChain(normal.events).ok, true);
const manifest = normal.manifest;
const admissionIndex = normal.events.findIndex((e) => e.payload?.kind === "campaign.plan.admitted");
const submitted = normal.events.find((e) => e.payload?.kind === "campaign.plan.submitted");
const plan = submitted.payload.plan;

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
	const chain = verifyChain(events);
	assert.equal(chain.ok, true, chain.errors.join("; "));
	return events;
}
function schedulerFor(m = manifest, rows = []) {
	const events = structuredClone(rows);
	const sink = {
		events,
		async append(e) {
			const row = { ...e, event_id: `audit-event-${events.length}`, event_digest: "sha256:diagnostic" };
			events.push(row);
			return { ok: true, durable: true, event: row };
		},
	};
	return {
		events,
		scheduler: createCampaignScheduler({
			manifest: m,
			ownedTasks: m.tasks,
			sink,
			acquireOwnership: false,
			worker: {
				async run() {
					return { ok: false };
				},
			},
			oracle: {
				async judge() {
					return { status: "unknown" };
				},
			},
		}),
	};
}
async function durableScheduler(label, taskTools = 2, campaignTools = 10) {
	const dir = join(out, label);
	mkdirSync(dir, { recursive: true });
	const log = new EventLog(join(dir, "events.jsonl"));
	assert.equal((await log.open()).ok, true);
	const m = structuredClone(testPlanningManifest({ workDir: dir }));
	m.budget.tool_calls = campaignTools;
	m.tasks[0].task_budget.tool_calls = taskTools;
	const scheduler = createCampaignScheduler({
		manifest: m,
		ownedTasks: m.tasks,
		sink: log,
		acquireOwnership: false,
		worker: {
			async run() {
				return { ok: false };
			},
		},
		oracle: {
			async judge() {
				return { status: "unknown" };
			},
		},
	});
	return { scheduler, log, manifest: m };
}
const charge = {
	request_id: "request-never-dispatched",
	tool_call_id: "sdk-call-1",
	unit_id: "call",
	tool_name: "aegis_task_decision",
	arguments_digest: digest({ actions: [] }),
	task_id: "task-plan",
	episode_id: "ep-task-plan",
};

test("XR-00 control: actual SDK/faux normal chain retains 8 requests / 3 effects", () => {
	assert.equal(normal.summary.provider_calls, 8);
	assert.equal(normal.summary.broker_effects, 3);
	assert.deepEqual(normal.summary.dataset, { name: "Ada", status: "active" });
});
test("XR-01 run persists a canonical Manifest before its first request", () => {
	assert.equal(existsSync(join(normal.dir, "manifests")), true, "real run has no immutable Manifest directory");
});
for (const field of ["manifest_digest", "context_digest", "manifest_revision", "episode_id"]) {
	test(`XR-02 admission rejects foreign ${field}`, () => {
		const events = structuredClone(normal.events.slice(0, admissionIndex + 1));
		events.at(-1).payload[field] = field === "manifest_revision" ? 999 : "foreign-audit-binding";
		const p = project(rechain(events), manifest);
		assert.equal(p.dynamic_definitions.length, 0, `foreign ${field} admitted ${p.dynamic_definitions.length} tasks`);
	});
}
test("XR-03 replay charges static allocation before a new plan", () => {
	const candidate = structuredClone(plan);
	for (const node of candidate.tasks) node.budget_reservation.model_requests = 33;
	// Construct an overallocated admission from the real accepted definitions.
	// Its budgets and hashes are internally consistent; 8+99>100 must be rejected
	// by replay independently of the producer's claimed prior budget.
	const definitions = structuredClone(normal.events[admissionIndex].payload.plan_tasks);
	for (const definition of definitions) {
		definition.task_budget.model_requests = 33;
		definition.budget_reservation.model_requests = 33;
		const { task_digest: _oldDigest, ...content } = definition;
		definition.task_digest = digest(content);
	}
	const events = structuredClone(normal.events.slice(0, admissionIndex + 1));
	events.find((e) => e.payload?.kind === "campaign.plan.submitted").payload = {
		...submitted.payload,
		plan: candidate,
		plan_digest: planDigest(candidate),
	};
	events.at(-1).payload.plan_digest = planDigest(candidate);
	events.at(-1).payload.plan_tasks = definitions;
	events.at(-1).payload.reserved_budget = { wall_time_ms: 90000, model_requests: 99, tool_calls: 24 };
	const p = project(rechain(events), manifest);
	assert.equal(
		p.dynamic_definitions.length,
		0,
		`replay admitted allocation ${p.budget.allocation_total.model_requests}>100`,
	);
});
test("XR-04 admitted duplicate compares complete definitions before accepting", () => {
	const events = structuredClone(normal.events.slice(0, admissionIndex + 1));
	const duplicate = structuredClone(events.at(-1));
	duplicate.event_id = "audit-conflicting-admission";
	duplicate.payload.plan_tasks[0].target_ref = "forbidden.txt";
	events.push(duplicate);
	const p = project(rechain(events), manifest);
	assert.ok(
		p.rejected.some((r) => r.event_id === duplicate.event_id),
		"same digest bypassed definition comparison",
	);
});
test("XR-05 Host duplicate returns the accepted prior admission identity", async () => {
	const { scheduler } = schedulerFor(manifest, normal.events.slice(0, admissionIndex + 1));
	const definitions = structuredClone(normal.events[admissionIndex].payload.plan_tasks);
	const result = await scheduler.admitPlan({
		plan,
		planningTaskId: "task-plan",
		admission: { status: "admitted", normalized: definitions },
	});
	assert.equal(result.ok, true);
	assert.equal(result.status, "duplicate", "prior admitted state is not a new accepted transition");
	assert.equal(result.transition_event_id, normal.events[admissionIndex].event_id);
});
test("XR-06 original plan remains duplicate after conflicting same-ID retry", async () => {
	const { scheduler } = schedulerFor(manifest, normal.events.slice(0, admissionIndex + 1));
	const conflicting = structuredClone(plan);
	conflicting.tasks[0].goal.description += " changed";
	await scheduler.recordPlanCandidate({ plan: conflicting, planningTaskId: "task-plan" });
	const result = await admitCandidatePlan({
		plan,
		manifest,
		host: scheduler,
		projection: project(normal.events.slice(0, admissionIndex + 1), manifest),
		templates: loadPlanningAuthority({ manifest }).templates,
	});
	assert.equal(result.ok, true, JSON.stringify(result.reasons));
	assert.equal(result.status, "duplicate");
});
test("XR-08 missing accepted start/provider request rejects a charge", async () => {
	const { scheduler, log } = await durableScheduler("missing-request");
	try {
		assert.equal((await scheduler.chargeTool(charge)).ok, false);
	} finally {
		await log.close();
	}
});
test("XR-09 concurrent charges share the read-decide-commit transaction", async () => {
	const { scheduler, log, manifest: m } = await durableScheduler("concurrent-charge", 1, 1);
	try {
		const results = await Promise.all([
			scheduler.chargeTool(charge),
			scheduler.chargeTool({ ...charge, tool_call_id: "sdk-call-2" }),
		]);
		const charged = project(log.replay(), m).tool_charges.length;
		assert.ok(charged <= 1, `both commands passed stale balance: ok=${results.map((r) => r.ok)} charged=${charged}`);
	} finally {
		await log.close();
	}
});
test("XR-10 duplicate charge with conflicting arguments cannot return ok", async () => {
	const { scheduler, log } = await durableScheduler("conflicting-tool");
	try {
		await scheduler.chargeTool(charge);
		const changed = await scheduler.chargeTool({ ...charge, arguments_digest: digest({ actions: ["changed"] }) });
		assert.equal(changed.ok, false);
	} finally {
		await log.close();
	}
});
test("XR-11 foreign LLM tool charge cannot enter replay ledger", () => {
	const row = {
		event_type: "runtime.note",
		event_id: "audit-llm-charge",
		source: { kind: "llm", actor_id: "model" },
		payload: {
			kind: "c6.tool",
			version: "e1-tool-charge-1.0",
			phase: "charged",
			campaign_id: manifest.campaign_id,
			...charge,
			units: 1,
		},
	};
	assert.equal(project([row], manifest).tool_charges.length, 0);
});
test("XR-12 finished without charge returns rejected semantic result", async () => {
	const { scheduler, log } = await durableScheduler("finish-without-charge");
	try {
		assert.equal((await scheduler.finishTool(charge)).ok, false);
	} finally {
		await log.close();
	}
});
test("XR-13 tool charges survive rebuilding the actual C6 ledger", () => {
	const units = normal.events.filter((e) => e.payload?.kind === "c6.tool" && e.payload.phase === "charged").length;
	assert.equal(units, 4, "§7.2: normal chain charges one submit_plan and three decision units");
	assert.equal(
		normal.events.filter(
			(e) =>
				e.payload?.kind === "c6.tool" && e.payload.phase === "charged" && e.payload.tool_name === "aegis_submit_plan",
		).length,
		1,
		"the planning submission is charged independently of decision actions",
	);
	assert.equal(
		summarizeRequestLedger(normal.events).consumed.tool_calls,
		units,
		"request rebuild lost durable charges",
	);
});
test("XR-14 successful tool bodies record finished before effects/continuation", () => {
	const charged = normal.events.filter((e) => e.payload?.kind === "c6.tool" && e.payload.phase === "charged");
	const finished = normal.events.filter((e) => e.payload?.kind === "c6.tool" && e.payload.phase === "finished");
	assert.equal(finished.length, charged.length, "actual chain never invokes finishTool");
});
test("XR-15 E1 projection rejects cache authority without complete replay", () => {
	const cached = project(normal.events, manifest);
	const restored = projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		manifest,
		tasks: manifest.tasks,
		events: [],
		priorState: {
			queue: cached.tasks,
			budget: cached.budget,
			control: cached.control,
			tail_offset: cached.tail_offset,
		},
	});
	assert.equal(
		restored.ok,
		false,
		`empty source accepted ${restored.tasks.filter((t) => t.state === "completed").length} cached completions`,
	);
	assert.ok(restored.reasons.some((r) => String(r).includes("full_replay_required")));
});
test("XR-16 partial budget alias is rejected rather than ignored", () => {
	const result = normalizeExecutableTask({
		origin: "plan",
		definition: {
			task_id: "audit-task",
			task_budget: { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
			budget_reservation: { model_requests: 1 },
		},
	});
	assert.equal(result.ok, false);
});
test("XR-17 compiled task_digest covers final order", () => {
	const definition = normal.events[admissionIndex].payload.plan_tasks[0];
	const { task_digest, ...content } = definition;
	assert.equal(task_digest, digest(content), "compiler changed order after hashing");
});
test("XR-18 inadequate base fails creation", () => {
	const base = buildDataRepairManifest({ workspaceRoot: join(out, "workspace"), campaignId: "campaign-review-small" });
	base.budget = { ...base.budget, wall_time_ms: 1000, model_requests: 4, tool_calls: 4, task_count: 0 };
	const built = buildPlanningManifest({ base, planningConfig: TEST_PLANNING_CONFIG });
	assert.equal(built.ok, false, "builder accepted an invalid planning allocation/base");
});
test("XR-19 candidate conflicting task_budget alias is rejected", () => {
	const candidate = structuredClone(plan);
	candidate.tasks[0].task_budget = { ...candidate.tasks[0].budget_reservation, model_requests: 999 };
	const result = validatePlanGraph({
		plan: candidate,
		manifest,
		planningTaskId: "task-plan",
		existingTaskIds: new Set(["task-plan"]),
		templates: loadPlanningAuthority({ manifest }).templates,
		requiredCriteria: manifest.objective.required_criteria,
	});
	assert.equal(result.status, "rejected", "compiler dropped the model-supplied alias before normalization");
});
test("XR-20 rejected start cannot change a previously accepted Board Fact", () => {
	const events = structuredClone(normal.events);
	const prior = events.find(
		(e) => e.payload?.kind === "campaign.oracle.result" && e.payload.task_id === "dyn-a" && !e.payload.task_oracle,
	);
	assert.ok(
		projectBoard(events, { manifest }).currentByType.Fact.some((n) => n.outcome_id === prior.payload.outcome_id),
	);
	const bad = structuredClone(
		events.find((e) => e.payload?.kind === "campaign.task.started" && e.payload.task_id === "dyn-a"),
	);
	bad.event_id = "audit-rejected-start";
	bad.payload.episode_id = "ep-audit-foreign";
	bad.payload.command_id = "audit-restart-terminal";
	events.push(bad);
	rechain(events);
	assert.ok(
		project(events, manifest).rejected.some((r) => r.event_id === bad.event_id),
		"control: reducer rejected the terminal restart",
	);
	assert.ok(
		projectBoard(events, { manifest }).currentByType.Fact.some((n) => n.outcome_id === prior.payload.outcome_id),
		"Board indexed rejected raw start",
	);
});
test("XR-21 rejected correction cannot retire a valid Fact", () => {
	const events = structuredClone(normal.events);
	const prior = events.find(
		(e) => e.payload?.kind === "campaign.oracle.result" && e.payload.task_id === "dyn-a" && !e.payload.task_oracle,
	);
	const bad = structuredClone(prior);
	bad.event_id = "audit-rejected-correction";
	bad.payload.outcome_id = "audit-rejected-correction-outcome";
	bad.payload.outcome.outcome_id = bad.payload.outcome_id;
	bad.payload.outcome.supersedes = prior.payload.outcome_id;
	bad.payload.outcome.status = "unknown";
	bad.payload.outcome.observed = null;
	bad.payload.outcome.provenance.independent = false;
	events.push(bad);
	rechain(events);
	assert.ok(
		project(events, manifest).rejected.some((r) => r.event_id === bad.event_id),
		"control: authority rejected correction",
	);
	assert.ok(
		projectBoard(events, { manifest }).currentByType.Fact.some((n) => n.outcome_id === prior.payload.outcome_id),
		"rejected Hint retired accepted Fact",
	);
});
test("XR-22 environment invalidation withdraws unstarted dependency permission", () => {
	const end = normal.events.findIndex(
		(e) => e.payload?.kind === "campaign.task.completed" && e.payload.task_id === "dyn-b",
	);
	const events = structuredClone(normal.events.slice(0, end + 1));
	const control = project(events, manifest).tasks.find((t) => t.task_id === "dyn-c");
	assert.ok(control.definition.depends_on.includes("dyn-a"), "control: dyn-c really depends on dyn-a");
	assert.equal(control.state, "ready", "control: the dependant is ready before invalidation");
	const scope = project(events, manifest).tasks.find((t) => t.task_id === "dyn-a").definition.scope;
	events.push({
		event_type: "environment.changed",
		event_id: "audit-env-change",
		episode_id: "ep-dyn-a",
		schema_version: "1.1",
		source: { kind: "oracle", actor_id: "audit" },
		payload: { scope, reason: "independent environment invalidation" },
		evidence_refs: [],
	});
	rechain(events);
	assert.equal(
		projectBoard(events, { manifest }).currentByType.Fact.filter((n) => n.task_id === "dyn-a").length,
		0,
		"control: Board removed stale Facts",
	);
	const child = project(events, manifest).tasks.find((t) => t.task_id === "dyn-c");
	assert.equal(child.state, "queued", "the real dependant loses readiness after Fact invalidation");
});
test("XR-23 outcome evidence must resolve at its accepted prefix", () => {
	const events = structuredClone(normal.events);
	const verdict = events.find(
		(e) => e.payload?.kind === "campaign.oracle.result" && e.payload.task_id === "dyn-a" && !e.payload.task_oracle,
	);
	const ref = { ref_type: "artifact", ref_id: "audit-future-evidence", digest: "sha256:audit-future" };
	verdict.payload.outcome.evidence_refs = [ref];
	verdict.evidence_refs = [ref];
	events.push({
		event_type: "action.completed",
		event_id: "audit-future-artifact",
		schema_version: "1.1",
		episode_id: "ep-dyn-a",
		source: { kind: "runtime", actor_id: "audit" },
		payload: { evidence_ref: ref.ref_id, content_digest: ref.digest },
		evidence_refs: [],
	});
	rechain(events);
	assert.equal(
		project(events, manifest).authority.accepted_outcomes.includes(verdict.payload.outcome_id),
		false,
		"projection received the final artifact index rather than evidence at each prefix",
	);
});
test("XR-24 Task Oracle requires a real accepted start", () => {
	const events = structuredClone(normal.events).filter(
		(e) => !(e.payload?.kind === "campaign.task.started" && e.payload.task_id === "dyn-a"),
	);
	const taskResult = events.find(
		(e) => e.payload?.kind === "campaign.oracle.result" && e.payload.task_id === "dyn-a" && e.payload.task_oracle,
	);
	const p = project(rechain(events), manifest);
	assert.equal(
		p.authority.accepted_outcomes.includes(taskResult.payload.outcome_id),
		false,
		"task resolver used the result's own episode as authority",
	);
});
test("XR-25 same Outcome ID with different content cannot become a second Fact", () => {
	const events = structuredClone(normal.events);
	const conflicting = structuredClone(
		events.find(
			(e) => e.payload?.kind === "campaign.oracle.result" && e.payload.task_id === "dyn-a" && !e.payload.task_oracle,
		),
	);
	conflicting.event_id = "audit-conflicting-outcome";
	conflicting.payload.outcome.observed = { name: "attacker" };
	events.push(conflicting);
	rechain(events);
	assert.ok(
		project(events, manifest).rejected.some((r) => r.event_id === conflicting.event_id),
		"same ID bypassed content validation",
	);
	assert.equal(
		projectBoard(events, { manifest }).currentByType.Fact.filter((n) => n.origin_event_id === conflicting.event_id)
			.length,
		0,
	);
});
test("XR-26 success with contradictory observed value cannot become a Fact", () => {
	const events = structuredClone(normal.events);
	const verdict = events.find(
		(e) => e.payload?.kind === "campaign.oracle.result" && e.payload.task_id === "dyn-a" && !e.payload.task_oracle,
	);
	verdict.payload.outcome.observed = { name: "attacker" };
	rechain(events);
	assert.equal(
		projectBoard(events, { manifest }).currentByType.Fact.some((n) => n.outcome_id === verdict.payload.outcome_id),
		false,
	);
});
test("XR-27 legitimate unknown correction needs no success evidence to retire a Fact", () => {
	const events = structuredClone(normal.events);
	const prior = events.find(
		(e) => e.payload?.kind === "campaign.oracle.result" && e.payload.task_id === "dyn-a" && !e.payload.task_oracle,
	);
	const correction = structuredClone(prior);
	correction.event_id = "audit-unknown-correction";
	correction.evidence_refs = [];
	correction.payload.outcome_id = "audit-unknown-outcome";
	Object.assign(correction.payload.outcome, {
		outcome_id: correction.payload.outcome_id,
		status: "unknown",
		observed: null,
		evidence_refs: [],
		supersedes: prior.payload.outcome_id,
	});
	events.push(correction);
	rechain(events);
	assert.ok(
		project(events, manifest).authority.accepted_outcomes.includes(correction.payload.outcome_id),
		"control: legal unknown is accepted",
	);
	assert.equal(
		projectBoard(events, { manifest }).currentByType.Fact.some((n) => n.outcome_id === prior.payload.outcome_id),
		false,
	);
});
