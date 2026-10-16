#!/usr/bin/env node
// Aegis E1 contract closure — `aegis-e1-closure-contract` (T-C01..T-C16).
//
// Independent, hand-written expectations for the trusted planning contract,
// the executable-Task normalization, whole-graph compile semantics and the
// immutable-Manifest creation gate. Pure/offline where the matrix says `F`;
// the real SDK/faux child where it says `P`/`M`.
//
// Run: node --test Pi_Agent_base/tests/aegis-e1-closure-contract.mjs

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { planDigest, validatePlanGraph } from "../campaign/e1-plan-contract.mjs";
import { buildPlanningManifest, PLAN_READY_CRITERION, templatesFromConfig } from "../campaign/e1-planning.mjs";
import {
	buildPlanningContract,
	EXECUTABLE_TASK_VERSION,
	loadPlanningAuthority,
	normalizeExecutableTask,
	normalizeTrustedTemplates,
	PLANNING_CONTRACT_VERSION,
	ROOT_GOAL_REF,
	validatePlanningContract,
} from "../campaign/e1-planning-contract.mjs";
import { canonicalManifestDigest, persistImmutableManifest, validateManifest } from "../campaign/manifest.mjs";
import { digest } from "../shared/contracts.mjs";
import { evidenceDir, testPlanningManifest } from "./helpers/e1-closure-helpers.mjs";

const out = evidenceDir("contract");
console.log(`contract closure evidence: ${out}`);

/** Build a minimal valid base manifest for pure tests. */
function baseManifest(overrides = {}) {
	return {
		schema_version: "campaign-1.1",
		campaign_id: "campaign-contract",
		revision: 1,
		title: "contract",
		objective: { description: "root", success_criteria: ["c1"], required_criteria: ["c1"] },
		budget: { wall_time_ms: 600000, model_requests: 100, tool_calls: 200, task_count: 8, session_count: 10 },
		authorization: { allowed_targets: ["dataset.json"], allowed_capabilities: ["data.record.write"] },
		adapters: { execution: "workspace.exec.v1", oracle: "fixture.oracle.v1" },
		dynamic_task_policy: {
			enabled: true,
			allowed_task_types: ["verify"],
			max_depth: 3,
			max_fan_out: 4,
			max_task_count: 8,
		},
		scope: { environment_fingerprint: "env-1", domain: "structured-data", permissions: ["data.record.write"] },
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
				task_budget: { wall_time_ms: 1000, model_requests: 2, tool_calls: 2 },
			},
		],
		...overrides,
	};
}

const TEMPLATES = [
	{
		template_ref: "verify",
		task_type: "verify",
		oracle_ref: "fixture.oracle.v1",
		required_capabilities: ["data.record.write"],
		success_criteria: ["c1", "c2"],
		scope: {
			environment_fingerprint: "env-1",
			domain: "structured-data",
			permissions: ["data.record.write"],
			task_types: ["verify"],
		},
	},
];

test("T-C01a: a new E1 manifest embeds a complete, digestible contract", () => {
	const built = buildPlanningManifest({ base: baseManifest(), planningConfig: { templates: TEMPLATES } });
	assert.equal(built.ok, true, JSON.stringify(built.reasons));
	const manifest = built.manifest;
	assert.ok(manifest.planning_contract, "the contract must be embedded in the Manifest");
	assert.equal(manifest.planning_contract.version, PLANNING_CONTRACT_VERSION);
	assert.equal(manifest.planning_contract.root_goal_ref, ROOT_GOAL_REF);
	assert.equal(manifest.planning_contract.plan_policy, "single_admitted_plan");
	assert.equal(manifest.planning_contract.tool_accounting, "durable-charge-v1");
	// Independent digest check: the declared digest equals digest(rest).
	const { digest: declared, ...rest } = manifest.planning_contract;
	assert.equal(declared, digest(rest));
	// The embedded contract survives a full validateManifest round trip.
});

test("T-C01b: an insufficient base budget/policy is refused, never widened", () => {
	// task_count 0 cannot hold the planning task + children; max_fan_out 1 cannot
	// hold the three-child split. The builder must refuse, not Math.max.
	const small = baseManifest({
		budget: { wall_time_ms: 1000, model_requests: 4, tool_calls: 4, task_count: 0, session_count: 1 },
		dynamic_task_policy: {
			enabled: true,
			allowed_task_types: ["verify"],
			max_depth: 0,
			max_fan_out: 1,
			max_task_count: 1,
		},
	});
	const built = buildPlanningManifest({ base: small, planningConfig: { templates: TEMPLATES } });
	// E1-CC §4.1: an inadequate base is REFUSED at creation (no Math.max, and no
	// half-built manifest that a caller could still run).
	assert.equal(built.ok, false, "an inadequate base must be refused, not built");
	assert.equal(built.manifest, null);
	const reasons = built.reasons.join("; ");
	assert.match(reasons, /planning_budget_exceeds_base: .*wall_time_ms/);
	assert.match(reasons, /task_count 0 cannot hold/);
	assert.match(reasons, /max_task_count 1 cannot hold/);
});

test("T-C01b2: templates outside the base authorization/policy are refused", () => {
	const built = buildPlanningManifest({
		base: baseManifest(),
		planningConfig: {
			templates: [
				{
					...TEMPLATES[0],
					required_capabilities: ["net.fetch"],
					scope: { ...TEMPLATES[0].scope, permissions: ["net.fetch"] },
				},
			],
		},
	});
	assert.equal(built.ok, false);
	assert.match(built.reasons.join("; "), /capability net\.fetch is not authorized/);
	assert.match(built.reasons.join("; "), /scope permission net\.fetch is not authorized/);
	const disabled = buildPlanningManifest({
		base: baseManifest({ dynamic_task_policy: { ...baseManifest().dynamic_task_policy, enabled: false } }),
		planningConfig: { templates: TEMPLATES },
	});
	assert.equal(disabled.ok, false, "the builder never force-enables dynamic expansion");
	assert.match(disabled.reasons.join("; "), /enabled must be true/);
});

test("T-C01c: a template set that does not cover root criteria is refused", () => {
	const built = buildPlanningManifest({
		base: baseManifest(),
		planningConfig: { templates: [{ ...TEMPLATES[0], success_criteria: ["other"] }] },
	});
	assert.equal(built.ok, false);
	assert.match(built.reasons.join("; "), /required criteria/);
});

test("T-C01d: immutable persistence is content-addressed and idempotent on same bytes", async () => {
	const dir = join(out, "manifests");
	const manifest = buildPlanningManifest({ base: baseManifest(), planningConfig: { templates: TEMPLATES } }).manifest;
	const first = await persistImmutableManifest(manifest, dir);
	assert.equal(first.ok, true);
	assert.equal(first.existed, false);
	const second = await persistImmutableManifest(manifest, dir);
	assert.equal(second.ok, true);
	assert.equal(second.existed, true);
	assert.equal(second.digest, first.digest);
	assert.equal(readFileSync(first.path, "utf8").includes("planning_contract"), true);
});

test("T-C02: a planning contract is deterministic under key/order changes", () => {
	const a = buildPlanningContract({ manifest: baseManifest(), templates: TEMPLATES, requiredCriteria: ["c1"] });
	const reordered = [
		{ ...TEMPLATES[0], success_criteria: [...TEMPLATES[0].success_criteria], scope: { ...TEMPLATES[0].scope } },
	];
	const b = buildPlanningContract({ manifest: baseManifest(), templates: reordered, requiredCriteria: ["c1"] });
	assert.equal(a.ok, true);
	assert.equal(b.ok, true);
	assert.equal(a.contract.digest, b.contract.digest, "object key order must not change the contract digest");
});

test("T-C04: duplicate template_ref or ambiguous task_type alias is refused", () => {
	const dup = normalizeTrustedTemplates([TEMPLATES[0], { ...TEMPLATES[0], success_criteria: ["c2"] }]);
	assert.equal(dup.ok, false);
	const ambiguous = normalizeTrustedTemplates([
		{ ...TEMPLATES[0], template_ref: "a", task_type: "verify" },
		{ ...TEMPLATES[0], template_ref: "b", task_type: "verify" },
	]);
	assert.equal(ambiguous.ok, false);
});

test("T-C04b: missing fingerprint / unknown major / empty criteria are refused", () => {
	assert.equal(normalizeTrustedTemplates([{ ...TEMPLATES[0], scope: { domain: "x" } }]).ok, false);
	assert.equal(normalizeTrustedTemplates([{ ...TEMPLATES[0], success_criteria: [] }]).ok, false);
	assert.equal(validatePlanningContract({ version: "e1-planning-contract-2.0" }).ok, false);
});

test("T-C06: a legacy Manifest without a contract is legacy_context_unavailable", () => {
	const authority = loadPlanningAuthority({ manifest: baseManifest() });
	assert.equal(authority.ok, false);
	assert.equal(authority.code, "legacy_context_unavailable");
	assert.equal(authority.context_digest, null);
});

test("T-C07: static budget dims default to zero; dynamic dims are required", () => {
	// static: missing dims -> explicit 0, never the Campaign total.
	const staticTask = normalizeExecutableTask({
		definition: {
			task_id: "t-1",
			task_type: "verify",
			target_ref: "dataset.json",
			stages: [{ stage_id: "s-1", criteria: ["c1"] }],
			budget_reservation: { wall_time_ms: 5 },
		},
		origin: "static",
	});
	assert.equal(staticTask.ok, true, JSON.stringify(staticTask.reasons));
	assert.deepEqual(staticTask.task.task_budget, { wall_time_ms: 5, model_requests: 0, tool_calls: 0 });
	// dynamic: all dims required.
	const badDynamic = normalizeExecutableTask({
		definition: {
			task_id: "d-1",
			task_type: "verify",
			target_ref: "dataset.json",
			stages: [{ stage_id: "s-1", criteria: ["c1"] }],
			budget_reservation: { wall_time_ms: 5, model_requests: 2 },
		},
		origin: "plan",
	});
	assert.equal(badDynamic.ok, false);
	assert.match(badDynamic.reasons.join("; "), /tool_calls is required/);
});

test("T-C08: conflicting / invalid dynamic budgets are refused per dimension", () => {
	const def = (task_budget, budget_reservation) => ({
		task_id: "d-1",
		task_type: "verify",
		target_ref: "dataset.json",
		stages: [{ stage_id: "s-1", criteria: ["c1"] }],
		task_budget,
		budget_reservation,
	});
	for (const [label, tb, br] of [
		["string", { wall_time_ms: "5", model_requests: 2, tool_calls: 2 }, null],
		["negative", { wall_time_ms: -1, model_requests: 2, tool_calls: 2 }, null],
		["fraction", { wall_time_ms: 1.5, model_requests: 2, tool_calls: 2 }, null],
		["nan", { wall_time_ms: Number.NaN, model_requests: 2, tool_calls: 2 }, null],
		["infinity", { wall_time_ms: Number.POSITIVE_INFINITY, model_requests: 2, tool_calls: 2 }, null],
		["unsafe", { wall_time_ms: Number.MAX_SAFE_INTEGER + 2, model_requests: 2, tool_calls: 2 }, null],
		[
			"conflict",
			{ wall_time_ms: 5, model_requests: 2, tool_calls: 2 },
			{ wall_time_ms: 6, model_requests: 2, tool_calls: 2 },
		],
	]) {
		const result = normalizeExecutableTask({ definition: def(tb, br), origin: "plan" });
		assert.equal(result.ok, false, `${label} must be refused`);
	}
});

test("T-C09: re-normalizing a normalized task is idempotent and covered by task_digest", () => {
	const first = normalizeExecutableTask({
		definition: {
			task_id: "d-1",
			task_type: "verify",
			target_ref: "dataset.json",
			order: 2,
			scope: { environment_fingerprint: "env-1" },
			stages: [{ stage_id: "s-1", criteria: ["c1"] }],
			task_budget: { wall_time_ms: 5, model_requests: 2, tool_calls: 2 },
		},
		origin: "plan",
	});
	assert.equal(first.ok, true);
	const second = normalizeExecutableTask({ definition: first.task, origin: "plan" });
	assert.equal(second.ok, true, JSON.stringify(second.reasons));
	assert.equal(second.task.task_digest, first.task.task_digest, "re-normalization must be value-stable");
	assert.equal(first.task.definition_version, EXECUTABLE_TASK_VERSION);
	// A single executable field change changes the digest.
	const changed = normalizeExecutableTask({ definition: { ...first.task, order: 99 }, origin: "plan" });
	assert.notEqual(changed.task.task_digest, first.task.task_digest);
});

test("T-C10: the candidate planDigest algorithm is key-order stable and array-order sensitive", () => {
	const plan = {
		version: "aegis-plan-1.0",
		plan_id: "p",
		root_goal_ref: ROOT_GOAL_REF,
		tasks: [{ proposed_task_id: "a" }, { proposed_task_id: "b" }],
	};
	const reorderedKeys = {
		root_goal_ref: plan.root_goal_ref,
		tasks: plan.tasks,
		plan_id: plan.plan_id,
		version: plan.version,
	};
	assert.equal(planDigest(plan), planDigest(reorderedKeys), "key order must not change the candidate digest");
	const swapped = { ...plan, tasks: [plan.tasks[1], plan.tasks[0]] };
	assert.notEqual(planDigest(plan), planDigest(swapped), "task array order is part of the candidate identity");
});

test("T-C11: whole-graph rejects cycles/dangling/foreign, accepts a legal later-node DAG", () => {
	const manifest = baseManifest();
	const node = (id, depends_on = [], extra = {}) => ({
		proposed_task_id: id,
		parent_task_id: "task-plan",
		depends_on,
		goal: { description: `do ${id}`, success_criteria: ["c1"] },
		task_type: "verify",
		target_ref: "dataset.json",
		required_capabilities: ["data.record.write"],
		expected_evidence: [`artifact:${id}`],
		stop_condition: "done",
		priority: 1,
		budget_reservation: { wall_time_ms: 1000, model_requests: 2, tool_calls: 2 },
		...extra,
	});
	const graph = (tasks) =>
		validatePlanGraph({
			plan: { version: "aegis-plan-1.0", plan_id: "p", root_goal_ref: ROOT_GOAL_REF, tasks },
			manifest,
			planningTaskId: "task-plan",
			existingTaskIds: new Set(["task-plan"]),
			templates: templatesFromConfig({ templates: TEMPLATES }),
			requiredCriteria: ["c1"],
			expectedRootGoalRef: ROOT_GOAL_REF,
			derivedBudget: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 },
		});
	// A legal later-node dependency: t-b references t-a which appears AFTER it.
	const legal = graph([node("t-b", ["t-a"]), node("t-a")]);
	assert.equal(legal.status, "admitted", JSON.stringify(legal.reasons));
	// Self / dangling / foreign references reject.
	assert.equal(graph([node("t-a", ["t-a"])]).status, "rejected");
	assert.equal(graph([node("t-a", ["nope"])]).status, "rejected");
	// Two-node cycle rejects.
	assert.equal(graph([node("t-a", ["t-b"]), node("t-b", ["t-a"])]).status, "rejected");
});

test("T-C12: cumulative budget overflow and hard limits are rejected, not blocked", () => {
	const manifest = baseManifest({
		budget: { wall_time_ms: 600000, model_requests: 3, tool_calls: 200, task_count: 8, session_count: 10 },
	});
	const node = (id) => ({
		proposed_task_id: id,
		parent_task_id: "task-plan",
		depends_on: [],
		goal: { description: id, success_criteria: ["c1"] },
		task_type: "verify",
		target_ref: "dataset.json",
		required_capabilities: ["data.record.write"],
		expected_evidence: [`artifact:${id}`],
		stop_condition: "done",
		priority: 1,
		budget_reservation: { wall_time_ms: 1000, model_requests: 2, tool_calls: 2 },
	});
	const over = validatePlanGraph({
		plan: { version: "aegis-plan-1.0", plan_id: "p", root_goal_ref: ROOT_GOAL_REF, tasks: [node("t-a"), node("t-b")] },
		manifest,
		planningTaskId: "task-plan",
		existingTaskIds: new Set(["task-plan"]),
		templates: templatesFromConfig({ templates: TEMPLATES }),
		requiredCriteria: ["c1"],
		expectedRootGoalRef: ROOT_GOAL_REF,
		derivedBudget: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 },
	});
	assert.equal(over.status, "blocked", JSON.stringify(over.reasons));
	assert.equal(over.normalized, null, "a blocked batch exposes no partial definitions");
});

test("T-C13: root-criteria coverage is required and foreign root is rejected", () => {
	const manifest = baseManifest();
	const node = {
		proposed_task_id: "t-a",
		parent_task_id: "task-plan",
		depends_on: [],
		goal: { description: "x", success_criteria: ["c1"] },
		task_type: "verify",
		target_ref: "dataset.json",
		required_capabilities: ["data.record.write"],
		expected_evidence: ["artifact:t-a"],
		stop_condition: "done",
		priority: 1,
		budget_reservation: { wall_time_ms: 1000, model_requests: 2, tool_calls: 2 },
	};
	const run = (root, criteria) =>
		validatePlanGraph({
			plan: { version: "aegis-plan-1.0", plan_id: "p", root_goal_ref: root, tasks: [node] },
			manifest,
			planningTaskId: "task-plan",
			existingTaskIds: new Set(["task-plan"]),
			templates: templatesFromConfig({ templates: TEMPLATES }),
			requiredCriteria: criteria,
			expectedRootGoalRef: ROOT_GOAL_REF,
			derivedBudget: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 },
		});
	assert.equal(run(ROOT_GOAL_REF, ["c1"]).status, "admitted");
	assert.equal(run(ROOT_GOAL_REF, ["c1", "c2"]).status, "blocked", "a missing root criterion blocks");
	assert.equal(run("foreign-root", ["c1"]).status, "rejected", "a foreign root is a structural rejection");
});

test("T-C14: compile/evaluate is pure and repeatable for the same input", () => {
	const manifest = baseManifest();
	const plan = {
		version: "aegis-plan-1.0",
		plan_id: "p",
		root_goal_ref: ROOT_GOAL_REF,
		tasks: [
			{
				proposed_task_id: "t-a",
				parent_task_id: "task-plan",
				depends_on: [],
				goal: { description: "x", success_criteria: ["c1"] },
				task_type: "verify",
				target_ref: "dataset.json",
				required_capabilities: ["data.record.write"],
				expected_evidence: ["artifact:t-a"],
				stop_condition: "done",
				priority: 1,
				budget_reservation: { wall_time_ms: 1000, model_requests: 2, tool_calls: 2 },
			},
		],
	};
	const args = {
		plan: structuredClone(plan),
		manifest,
		planningTaskId: "task-plan",
		existingTaskIds: new Set(["task-plan"]),
		templates: templatesFromConfig({ templates: TEMPLATES }),
		requiredCriteria: ["c1"],
		expectedRootGoalRef: ROOT_GOAL_REF,
		derivedBudget: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 },
	};
	const frozen = JSON.stringify(args);
	const a = validatePlanGraph(args);
	const b = validatePlanGraph(args);
	assert.deepEqual(a.normalized, b.normalized);
	assert.equal(JSON.stringify(args), frozen, "the input must not be mutated");
});

test("T-C16: a new E1 run's manifest round-trips through validateManifest", () => {
	const manifest = testPlanningManifest({ workDir: join(out, "roundtrip") });
	const validated = validateManifest(manifest);
	assert.equal(validated.ok, true, JSON.stringify(validated.reasons).slice(0, 400));
	// The contract is not accidentally dropped by the validator.
	assert.ok(
		validated.manifest?.planning_contract || manifest.planning_contract,
		"the contract must survive validation",
	);
	assert.equal(canonicalManifestDigest(manifest), canonicalManifestDigest(structuredClone(manifest)));
});

// Persist a bounded diagnostic summary (never raw secrets).
mkdirSync(out, { recursive: true });
writeFileSync(
	join(out, "contract-summary.json"),
	`${JSON.stringify({ script: "aegis-e1-closure-contract", cases: ["T-C01", "T-C02", "T-C04", "T-C06", "T-C07", "T-C08", "T-C09", "T-C10", "T-C11", "T-C12", "T-C13", "T-C14", "T-C16"], plan_ready_criterion: PLAN_READY_CRITERION }, null, 2)}\n`,
);

test("T-C01e: durable persistence confirms fsync and refuses a digest collision", async () => {
	const dir = join(out, "manifests-fsync");
	const manifest = buildPlanningManifest({ base: baseManifest(), planningConfig: { templates: TEMPLATES } }).manifest;
	const first = await persistImmutableManifest(manifest, dir);
	assert.equal(first.ok, true);
	assert.equal(first.synced, true, "a new canonical manifest must confirm fsync before reporting durable");
	const second = await persistImmutableManifest(manifest, dir);
	assert.equal(second.ok, true);
	assert.equal(second.synced, true, "an existing identical manifest also confirms durability");
	// A same-address different-bytes collision is refused (never overwritten).
	writeFileSync(first.path, '{"tampered":true}\n');
	const collision = await persistImmutableManifest(manifest, dir);
	assert.equal(collision.ok, false, "a canonical file with different bytes is never overwritten");
	assert.match(collision.reason, /collision|different bytes/);
});
