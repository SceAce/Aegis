#!/usr/bin/env node
// Aegis E1 — task B: real provider planning input and Host template constraints.
//
// Drives the REAL SDK/faux product chain (subprocess) and the pure planning
// contract. Proves:
//   * the ACTUAL first provider input carries the frozen root criteria, the
//     trusted templates/oracles, targets, budget and graph limits, and points at
//     `aegis_submit_plan` (never the business action instruction);
//   * a faux candidate DERIVED from that received contract completes the real
//     chain (Host admission → Oracle → EventLog → effects);
//   * changing the trusted templates/criteria/limits changes BOTH the provider
//     input and the Host admission outcome;
//   * a plan that keeps root coverage but attaches an unoffered criterion is
//     blocked as a whole through the real tool submission (zero effects);
//   * unknown template, template/type mismatch and empty template criteria block;
//   * malformed success_criteria return a reasoned rejection instead of throwing.
//
// Run: node Pi_Agent_base/tests/aegis-e1-planner-input.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildPlanningContext,
	buildPlanningPrompt,
	validatePlanGraph,
	validatePlanShape,
} from "../memory/campaign/e1-plan-contract.mjs";
import { templatesFromConfig } from "../memory/campaign/e1-planning.mjs";
import { verifyChain } from "../memory/runtime/events.mjs";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOLVER = join(BASE_DIR, "pi", "packages", "coding-agent", "src", "experimental", "source-resolver.ts");
const CHILD = join(BASE_DIR, "tests", "helpers", "c6-e1-planning-child.mjs");
const root = mkdtempSync(join(tmpdir(), "aegis-e1-planner-input-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

function runScenario(name) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const run = spawnSync(process.execPath, ["--import", RESOLVER, CHILD, dir, name], {
		encoding: "utf8",
		timeout: 60000,
		maxBuffer: 32 * 1024 * 1024,
	});
	assert.equal(run.status, 0, `fixture ${name} failed: ${run.stderr?.slice(-1200)}`);
	const readJson = (path) => JSON.parse(readFileSync(join(dir, path), "utf8"));
	const events = readFileSync(join(dir, "events.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	return {
		dir,
		input: readJson("planning-input.json"),
		submitted: readJson("submitted-plan.json"),
		summary: readJson(`summary-${name}.json`),
		manifest: readJson("manifest.json"),
		events,
	};
}

/** Recover the authoritative planning contract embedded in the actual prompt. */
function contractPromptText(input) {
	const strings = [];
	const walk = (value) => {
		if (typeof value === "string") strings.push(value);
		else if (Array.isArray(value)) for (const item of value) walk(item);
		else if (value && typeof value === "object") for (const item of Object.values(value)) walk(item);
	};
	walk(input);
	const marker = "PLANNING CONTRACT (authoritative JSON): ";
	return strings.find((text) => text.includes(marker)) ?? null;
}

function extractContract(input) {
	const text = contractPromptText(input);
	assert.ok(text, "the actual provider input must embed the planning contract");
	const marker = "PLANNING CONTRACT (authoritative JSON): ";
	const at = text.lastIndexOf(marker);
	const start = text.indexOf("{", at + marker.length);
	let depth = 0;
	for (let index = start; index < text.length; index += 1) {
		if (text[index] === "{") depth += 1;
		else if (text[index] === "}") {
			depth -= 1;
			if (depth === 0) return JSON.parse(text.slice(start, index + 1));
		}
	}
	throw new Error("planning contract JSON is not balanced");
}

const derived = runScenario("derived_plan");
const attacker = runScenario("attacker_criterion_plan");

test("B-INPUT-01: the actual first provider input carries the full contract and the plan tool instruction", () => {
	const text = JSON.stringify(derived.input);
	for (const criterion of derived.manifest.objective.required_criteria)
		assert.ok(text.includes(criterion), `planner never received required criterion: ${criterion}`);
	for (const field of ["template_ref", "fixture.oracle.v1", "max_depth", "max_fan_out", "max_task_count"])
		assert.ok(text.includes(field), `planner input lacks ${field}`);
	// The PLANNING prompt itself (not the SDK's tool catalog) must point at the
	// structured plan tool and must not be the business action instruction.
	const prompt = contractPromptText(derived.input);
	assert.ok(prompt.includes("aegis_submit_plan"), "the planning prompt must instruct the structured plan tool");
	assert.ok(prompt.includes("parent_task_id"), "the transport/parent semantics must be described");
	assert.ok(prompt.includes("depends_on"), "the dependency semantics must be described");
	assert.equal(
		prompt.includes("aegis_task_decision"),
		false,
		"the planning task must NOT carry the business action instruction",
	);
	const contract = extractContract(derived.input);
	assert.deepEqual(contract.root_goal.required_criteria, derived.manifest.objective.required_criteria);
	assert.deepEqual(contract.templates.map((t) => t.template_ref).sort(), ["reproduce", "verify"]);
	for (const template of contract.templates) assert.ok(template.success_criteria.length > 0);
});

test("B-INPUT-02: changing trusted criteria/templates/limits changes the input and the Host admission", () => {
	const makeManifest = (criteria, target, depth) => ({
		schema_version: "campaign-1.1",
		campaign_id: "campaign-b-input",
		objective: { description: "g", success_criteria: criteria, required_criteria: criteria },
		budget: { wall_time_ms: 600000, model_requests: 20, tool_calls: 40 },
		authorization: { allowed_targets: [target], allowed_capabilities: ["data.record.write"] },
		dynamic_task_policy: {
			enabled: true,
			allowed_task_types: ["verify"],
			max_depth: depth,
			max_fan_out: 3,
			max_task_count: 6,
		},
		tasks: [
			{
				task_id: "task-plan",
				task_type: "observe",
				depends_on: [],
				task_budget: { wall_time_ms: 1000, model_requests: 1, tool_calls: 1 },
			},
		],
	});
	const makeTemplates = (criteria) =>
		templatesFromConfig({
			templates: [
				{
					template_ref: "verify",
					task_type: "verify",
					oracle_ref: "fixture.oracle.v1",
					required_capabilities: ["data.record.write"],
					success_criteria: criteria,
					scope: { domain: "structured-data", permissions: ["data.record.write"], task_types: ["verify"] },
				},
			],
		});
	const baseManifest = makeManifest(["data.name == Ada", "data.status == active"], "dataset.json", 3);
	const baseTemplates = makeTemplates(["data.name == Ada", "data.status == active"]);
	const changedManifest = makeManifest(["data.owner == Alice"], "other.json", 5);
	const changedTemplates = makeTemplates(["data.owner == Alice"]);

	const basePrompt = buildPlanningPrompt(buildPlanningContext({ manifest: baseManifest, templates: baseTemplates }));
	const changedPrompt = buildPlanningPrompt(
		buildPlanningContext({ manifest: changedManifest, templates: changedTemplates }),
	);
	assert.ok(basePrompt.includes("data.name == Ada"));
	assert.ok(!basePrompt.includes("data.owner == Alice"));
	assert.ok(changedPrompt.includes("data.owner == Alice"));
	assert.ok(!changedPrompt.includes("data.name == Ada"), "the changed contract must not leak the old criterion");
	assert.ok(changedPrompt.includes("other.json"), "the changed target must reach the provider");
	assert.ok(changedPrompt.includes("max_depth=5"), "the changed limit must reach the provider");

	const plan = (criteria, target) => ({
		version: "aegis-plan-1.0",
		plan_id: "plan-b",
		root_goal_ref: "campaign-root",
		tasks: [
			{
				proposed_task_id: "t-a",
				parent_task_id: "task-plan",
				depends_on: [],
				goal: { description: "x", success_criteria: criteria },
				task_type: "verify",
				target_ref: target,
				required_capabilities: ["data.record.write"],
				expected_evidence: ["artifact:t-a"],
				stop_condition: "judged",
				priority: 1,
				budget_reservation: { wall_time_ms: 1000, model_requests: 1, tool_calls: 1 },
			},
		],
	});
	const validate = (candidate, manifest, templates) =>
		validatePlanGraph({
			plan: candidate,
			manifest,
			planningTaskId: "task-plan",
			existingTaskIds: new Set(["task-plan"]),
			templates,
			requiredCriteria: manifest.objective.required_criteria,
		});
	assert.equal(
		validate(plan(["data.owner == Alice"], "other.json"), changedManifest, changedTemplates).status,
		"admitted",
	);
	assert.equal(
		validate(plan(["data.name == Ada"], "dataset.json"), changedManifest, changedTemplates).status,
		"blocked",
	);
});

test("B-CHAIN-01: a candidate DERIVED from the received contract completes the real chain", () => {
	const contract = extractContract(derived.input);
	const offered = new Set(contract.templates.flatMap((template) => template.success_criteria));
	for (const task of derived.submitted.tasks)
		for (const criterion of task.goal.success_criteria) {
			assert.ok(offered.has(criterion), `submitted criterion not offered by any trusted template: ${criterion}`);
		}
	const covered = new Set(derived.submitted.tasks.flatMap((task) => task.goal.success_criteria));
	for (const criterion of contract.root_goal.required_criteria) assert.ok(covered.has(criterion));
	assert.equal(
		derived.summary.plan_kinds.includes("campaign.plan.admitted"),
		true,
		JSON.stringify(derived.summary.plan_kinds),
	);
	assert.equal(derived.summary.plan_ready, true);
	assert.equal(derived.summary.broker_effects, 3);
	assert.deepEqual(derived.summary.dataset, { name: "Ada", status: "active" });
	assert.equal(verifyChain(derived.events).ok, true);
});

test("B-GUARD-01: a root-covering plan with an UNOFFERED criterion is blocked through the real tool path", () => {
	const blocked = attacker.events.find((event) => event.payload?.kind === "campaign.plan.blocked");
	assert.ok(blocked, JSON.stringify(attacker.summary.plan_kinds));
	assert.ok(
		(blocked.payload.reasons ?? []).some((reason) => /not offered by template/.test(reason)),
		JSON.stringify(blocked.payload.reasons),
	);
	assert.equal(attacker.summary.plan_kinds.includes("campaign.plan.admitted"), false);
	assert.deepEqual(attacker.summary.admitted_task_ids, []);
	assert.equal(attacker.summary.broker_effects, 0);
	assert.deepEqual(attacker.summary.dataset, { name: "??", status: "pending" });
	assert.equal(verifyChain(attacker.events).ok, true);
});

test("B-GUARD-02: unknown template, template/type mismatch and empty template criteria never admit", () => {
	const manifest = {
		schema_version: "campaign-1.1",
		campaign_id: "campaign-b-guard",
		objective: {
			description: "g",
			success_criteria: ["data.status == active"],
			required_criteria: ["data.status == active"],
		},
		budget: { wall_time_ms: 600000, model_requests: 20, tool_calls: 40 },
		authorization: { allowed_targets: ["dataset.json"], allowed_capabilities: ["data.record.write"] },
		dynamic_task_policy: {
			enabled: true,
			allowed_task_types: ["verify", "reproduce"],
			max_depth: 3,
			max_fan_out: 3,
			max_task_count: 6,
		},
		tasks: [{ task_id: "task-plan", task_type: "observe", depends_on: [] }],
	};
	const node = (extra) => ({
		proposed_task_id: "t-a",
		parent_task_id: "task-plan",
		depends_on: [],
		goal: { description: "x", success_criteria: ["data.status == active"] },
		task_type: "verify",
		target_ref: "dataset.json",
		required_capabilities: ["data.record.write"],
		expected_evidence: ["artifact:t-a"],
		stop_condition: "j",
		priority: 1,
		budget_reservation: { wall_time_ms: 1000, model_requests: 1, tool_calls: 1 },
		...extra,
	});
	const validate = (candidate, templates) =>
		validatePlanGraph({
			plan: { version: "aegis-plan-1.0", plan_id: "p", root_goal_ref: "root", tasks: [candidate] },
			manifest,
			planningTaskId: "task-plan",
			existingTaskIds: new Set(["task-plan"]),
			templates,
			requiredCriteria: ["data.status == active"],
		});
	const full = templatesFromConfig({
		templates: [
			{
				template_ref: "verify",
				task_type: "verify",
				oracle_ref: "fixture.oracle.v1",
				required_capabilities: ["data.record.write"],
				success_criteria: ["data.status == active"],
			},
			{
				template_ref: "reproduce",
				task_type: "reproduce",
				oracle_ref: "fixture.oracle.v1",
				required_capabilities: ["data.record.write"],
				success_criteria: ["data.status == active"],
			},
		],
	});
	assert.equal(validate(node({ template_ref: "unregistered" }), full).status, "blocked");
	const mismatch = validate(node({ template_ref: "reproduce", task_type: "verify" }), full);
	assert.equal(mismatch.status, "blocked");
	assert.ok(mismatch.reasons.some((reason) => /does not match template/.test(reason)));
	const emptyCriteria = templatesFromConfig({
		templates: [
			{
				template_ref: "verify",
				task_type: "verify",
				oracle_ref: "fixture.oracle.v1",
				required_capabilities: ["data.record.write"],
				success_criteria: [],
			},
		],
	});
	const noCriteria = validate(node({}), emptyCriteria);
	assert.equal(noCriteria.status, "blocked", "missing template criteria must not be a wildcard");
});

test("B-SHAPE-01: malformed criteria return a reasoned rejection instead of throwing", () => {
	const manifest = {
		schema_version: "campaign-1.1",
		campaign_id: "campaign-b-shape",
		objective: {
			description: "g",
			success_criteria: ["data.status == active"],
			required_criteria: ["data.status == active"],
		},
		budget: { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
		authorization: { allowed_targets: ["dataset.json"], allowed_capabilities: ["data.record.write"] },
		dynamic_task_policy: {
			enabled: true,
			allowed_task_types: ["verify"],
			max_depth: 3,
			max_fan_out: 3,
			max_task_count: 6,
		},
		tasks: [{ task_id: "task-plan", task_type: "observe", depends_on: [] }],
	};
	const base = {
		version: "aegis-plan-1.0",
		plan_id: "p",
		root_goal_ref: "root",
		tasks: [
			{
				proposed_task_id: "t-a",
				parent_task_id: "task-plan",
				depends_on: [],
				goal: { description: "x", success_criteria: ["data.status == active"] },
				task_type: "verify",
				target_ref: "dataset.json",
				required_capabilities: ["data.record.write"],
				expected_evidence: ["artifact:t-a"],
				stop_condition: "j",
				priority: 1,
				budget_reservation: { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
			},
		],
	};
	for (const malformed of [{}, "not-an-array", [42], [""], [null]]) {
		const candidate = structuredClone(base);
		candidate.tasks[0].goal.success_criteria = malformed;
		const shape = validatePlanShape(candidate);
		assert.equal(shape.ok, false, `shape must reject ${JSON.stringify(malformed)}`);
		assert.ok(shape.reasons.length > 0, "a shape rejection must carry a reason");
	}
	const templates = templatesFromConfig({
		templates: [
			{
				template_ref: "verify",
				task_type: "verify",
				oracle_ref: "fixture.oracle.v1",
				required_capabilities: ["data.record.write"],
				success_criteria: ["data.status == active"],
			},
		],
	});
	const graph = validatePlanGraph({
		plan: base,
		manifest,
		planningTaskId: "task-plan",
		existingTaskIds: new Set(["task-plan"]),
		templates,
		requiredCriteria: ["data.status == active"],
	});
	assert.equal(graph.status, "admitted");
});
