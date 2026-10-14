#!/usr/bin/env node
// Independent acceptance checks for the actual E1 entry, not hand-built success
// events. The SDK/faux fixture records provider input before revealing its plan.
// Evidence is retained in ignored runtime/dev; no paid provider or target calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { artifactIndexFromEvents } from "../memory/campaign/c3-entry.mjs";
import { summarizeRequestLedger } from "../memory/campaign/c6-request-lifecycle.mjs";
import { buildE1View } from "../memory/campaign/e1-observation.mjs";
import { validatePlanGraph, validatePlanShape } from "../memory/campaign/e1-plan-contract.mjs";
import { projectQueueFromEvents } from "../memory/campaign/projection.mjs";
import { verifyChain } from "../memory/runtime/events.mjs";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resolver = join(base, "pi/packages/coding-agent/src/experimental/source-resolver.ts");
const child = join(base, "tests/helpers/c6-e1-planning-child.mjs");
const evidenceRoot = join(base, "runtime/dev/e1-external-review-run1/cases");
mkdirSync(evidenceRoot, { recursive: true });
const workDir = mkdtempSync(join(evidenceRoot, "acceptance-"));
let normal;
let unknown;
let admittedRestart;
let unverifiedRestart;

function scenario(name, directory = name) {
	const dir = join(workDir, directory);
	const run = spawnSync(process.execPath, ["--import", resolver, child, dir, name], {
		encoding: "utf8",
		timeout: 60000,
		maxBuffer: 8 * 1024 * 1024,
	});
	assert.equal(run.status, 0, `fixture failed: ${run.stderr?.slice(-1000)}`);
	const readJson = (path) => JSON.parse(readFileSync(join(dir, path), "utf8"));
	const manifest = readJson("manifest.json");
	const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	return {
		dir,
		manifest,
		events,
		input: readJson("planning-input.json"),
		summary: readJson(`summary-${name}.json`),
		view: buildE1View({ manifest, events }),
	};
}

// A real process restart from an actual committed prefix. This models the
// durable state after a crash; it does not claim to exercise the SIGKILL signal.
function restartAt(kind, directory, sourceScenario = "normal_plan") {
	const initial = scenario(sourceScenario, directory);
	const end = initial.events.findIndex((e) => e.payload?.kind === kind);
	assert.ok(end >= 0);
	writeFileSync(join(initial.dir, "source-events.jsonl"), readFileSync(join(initial.dir, "events.jsonl")));
	writeFileSync(
		join(initial.dir, "events.jsonl"),
		`${initial.events
			.slice(0, end + 1)
			.map(JSON.stringify)
			.join("\n")}\n`,
	);
	writeFileSync(join(initial.dir, "workspace/dataset.json"), JSON.stringify({ name: "??", status: "pending" }));
	writeFileSync(join(initial.dir, "effects.json"), JSON.stringify({ effects: 0 }));
	return scenario("restart", directory);
}

function project(fixture, events = fixture.events) {
	return projectQueueFromEvents({
		campaign_id: fixture.manifest.campaign_id,
		tasks: fixture.manifest.tasks,
		manifest: fixture.manifest,
		events,
		artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
	});
}

before(() => {
	normal = scenario("normal_plan");
	unknown = scenario("unknown_plan");
	admittedRestart = restartAt("campaign.plan.admitted", "restart-admitted");
	unverifiedRestart = restartAt("campaign.task.unknown", "restart-unverified", "unknown_plan");
	console.log(`external review evidence: ${workDir}`);
});

test("ER-01 CONTROL: real SDK/entry produces three effects and a valid settled request chain", () => {
	assert.equal(verifyChain(normal.events).ok, true);
	assert.equal(normal.summary.broker_effects, 3);
	assert.deepEqual(normal.summary.dataset, { name: "Ada", status: "active" });
	const ledger = summarizeRequestLedger(normal.events);
	assert.equal(ledger.unresolved, 0);
	assert.equal(ledger.consumed.model_requests, normal.summary.provider_calls);
});

test("ER-02: normal planning Task completes through its own independent Oracle", () => {
	assert.equal(normal.summary.task_states["task-plan"], "completed");
	const result = normal.events.find(
		(e) => e.payload?.kind === "campaign.oracle.result" && e.payload.task_id === "task-plan",
	);
	assert.equal(result?.payload.outcome?.status, "success");
});

test("ER-03: children start only after durable planning Task completion", () => {
	const complete = normal.events.findIndex(
		(e) => e.payload?.kind === "campaign.task.completed" && e.payload.task_id === "task-plan",
	);
	const start = normal.events.findIndex(
		(e) => e.payload?.kind === "campaign.task.started" && e.payload.task_id.startsWith("dyn-"),
	);
	assert.ok(complete >= 0 && start > complete, `planning completion=${complete}, first child=${start}`);
});

test("ER-04 CONTROL: durable admitted prefix keeps all children gated", () => {
	const end = normal.events.findIndex((e) => e.payload?.kind === "campaign.plan.admitted");
	assert.ok(end >= 0);
	assert.ok(
		project(normal, normal.events.slice(0, end + 1))
			.tasks.filter((t) => t.task_id.startsWith("dyn-"))
			.every((t) => t.state === "queued" && t.awaiting_plan_ready === true),
	);
});

test("ER-05: replay cannot dispatch children after unknown planning completion", () => {
	const end = unknown.events.findIndex(
		(e) => e.payload?.kind === "campaign.task.unknown" && e.payload.task_id === "task-plan",
	);
	assert.ok(end >= 0);
	const projection = project(unknown, unknown.events.slice(0, end + 1));
	const dispatchable = projection.tasks.filter((t) => t.task_id.startsWith("dyn-") && t.state === "ready");
	assert.deepEqual(
		dispatchable.map((t) => t.task_id),
		[],
	);
});

test("ER-06: actual first provider input contains every frozen business criterion", () => {
	const input = JSON.stringify(normal.input);
	for (const criterion of normal.manifest.objective.required_criteria) {
		assert.ok(input.includes(criterion), `planner was never given: ${criterion}`);
	}
});

test("ER-07: actual planner input includes Host templates and graph/budget limits", () => {
	const input = JSON.stringify(normal.input);
	for (const field of ["template_ref", "fixture.oracle.v1", "max_depth", "max_fan_out", "max_task_count"]) {
		assert.ok(input.includes(field), `planner input lacks ${field}`);
	}
});

test("ER-08: unknown final planning termination retains the candidate without admitting or executing it", () => {
	assert.ok(unknown.events.some((e) => e.payload?.kind === "campaign.plan.submitted"));
	assert.equal(
		unknown.events.some((e) => e.payload?.kind === "campaign.plan.admitted"),
		false,
	);
	assert.equal(unknown.summary.broker_effects, 0);
});

test("ER-09: E1 task graph states match trusted artifact-aware replay", () => {
	const actual = Object.fromEntries(normal.view.task_graph.nodes.map((t) => [t.task_id, t.state]));
	const expected = Object.fromEntries(project(normal).tasks.map((t) => [t.task_id, t.state]));
	assert.deepEqual(actual, expected);
});

test("ER-10: trusted business Oracle results appear as traceable board Facts", () => {
	const oracleResults = normal.events.filter(
		(e) =>
			e.payload?.kind === "campaign.oracle.result" &&
			e.payload.task_id.startsWith("dyn-") &&
			e.payload.outcome?.status === "success",
	);
	assert.ok(oracleResults.length >= 3, "control: actual business Oracle success exists");
	const facts = normal.view.board.nodes.filter((n) => n.type === "Fact");
	for (const taskId of ["dyn-a", "dyn-b", "dyn-c"]) {
		assert.ok(
			facts.some(
				(n) =>
					n.task_id === taskId &&
					n.evidence_refs.length > 0 &&
					oracleResults.some((e) => e.event_id === n.origin_event_id),
			),
			`no traceable Fact for ${taskId}`,
		);
	}
});

test("ER-11: admitted plan preserves its identity in the observation projection", () => {
	assert.deepEqual(
		normal.view.plans.admitted.map((p) => p.plan_id),
		["plan-e1"],
	);
});

test("ER-12: normal live event stream replays without rejected plan events", () => {
	const rejected = project(normal).rejected ?? [];
	assert.deepEqual(rejected, []);
});

function validate(plan, templates) {
	return validatePlanGraph({
		plan,
		manifest: normal.manifest,
		planningTaskId: "task-plan",
		existingTaskIds: new Set(["task-plan"]),
		templates,
		requiredCriteria: normal.manifest.objective.required_criteria,
	});
}

test("ER-13: model may not attach unoffered criteria to an otherwise covered plan", () => {
	const plan = structuredClone(normal.events.find((e) => e.payload?.kind === "campaign.plan.submitted").payload.plan);
	const templates = new Map([
		[
			"verify",
			{
				oracle_ref: "fixture.oracle.v1",
				required_capabilities: ["data.record.write"],
				success_criteria: ["data.name == Ada", "data.status == active"],
			},
		],
		[
			"reproduce",
			{
				oracle_ref: "fixture.oracle.v1",
				required_capabilities: ["data.record.write"],
				success_criteria: ["data.status == active"],
			},
		],
	]);
	assert.equal(validate(plan, templates).status, "admitted", "control: permitted criteria admit");
	plan.tasks[0].goal.success_criteria.push("data.status == attacker_chosen");
	assert.equal(validate(plan, templates).status, "blocked");
});

test("ER-14: malformed model criteria return rejection rather than throwing", () => {
	const plan = structuredClone(normal.events.find((e) => e.payload?.kind === "campaign.plan.submitted").payload.plan);
	plan.tasks[0].goal.success_criteria = { arbitrary: true };
	assert.equal(validatePlanShape(plan).ok, false);
});

test("ER-15 CONTROL: both explicit execution prerequisites survive observation replay", () => {
	assert.deepEqual(normal.view.task_graph.nodes.find((t) => t.task_id === "dyn-c").depends_on, ["dyn-a", "dyn-b"]);
	const starts = normal.events.map((e) => `${e.payload?.kind}:${e.payload?.task_id}`);
	const c = starts.indexOf("campaign.task.started:dyn-c");
	assert.ok(c > starts.indexOf("campaign.task.completed:dyn-a"));
	assert.ok(c > starts.indexOf("campaign.task.completed:dyn-b"));
});

test("ER-16 CONTROL: process restart after admission alone dispatches no provider or Broker effect", () => {
	assert.equal(verifyChain(admittedRestart.events).ok, true);
	assert.equal(admittedRestart.summary.provider_calls, 0);
	assert.equal(admittedRestart.summary.broker_effects, 0);
});

test("ER-17: process restart cannot execute a plan whose planning Oracle has never passed", () => {
	assert.equal(verifyChain(unverifiedRestart.events).ok, true);
	assert.equal(unverifiedRestart.summary.provider_calls, 0);
	assert.equal(unverifiedRestart.summary.broker_effects, 0);
	assert.deepEqual(unverifiedRestart.summary.dataset, { name: "??", status: "pending" });
});
