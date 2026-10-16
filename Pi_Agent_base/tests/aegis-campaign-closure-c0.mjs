#!/usr/bin/env node
// Aegis Campaign C0 CLOSURE regression tests (P0-1..P1-5 + adjacent CLOSE items).
//
// TEST-FIRST: authored from docs/CAMPAIGN_CONTRACT_BASELINE.md §4 and the
// reported audit findings, NOT from the current implementation's return values.
// Every case names the defect it guards; where the pre-fix code is wrong, this
// script fails on it (recorded in docs/CAMPAIGN_TEST_MATRIX.md "old" column).
//
// Offline by construction: no network, no model, no Pi runtime, only local temp
// dirs. Synthetic inputs are structurally complete but explicitly fixtures.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-closure-c0.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	admitTaskProposal,
	aggregateCampaign,
	aggregateStage,
	aggregateTask,
	assertIdType,
	buildAcceptanceBundle,
	buildCampaignReport,
	buildFixtureCampaign,
	canonicalManifestDigest,
	classifySupersede,
	contributionLink,
	effectiveOutcomes,
	independenceOf,
	persistImmutableManifest,
	validateManifest,
} from "../campaign/index.mjs";

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
const root = mkdtempSync(join(tmpdir(), "aegis-campaign-closure-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const SCOPE = { environment_fingerprint: "fixture-env", domain: "fixture" };
const EP = "ep-fixture-1";

/** A structurally complete, trusted prior Outcome. */
function prior(overrides = {}) {
	return {
		outcome_id: "o-prior",
		status: "failure",
		episode_id: EP,
		scope: { ...SCOPE },
		criterion: { criterion_id: "c1", expected: "door.locked == false" },
		provenance: { source: "oracle", independent: true, group: "g-root" },
		...overrides,
	};
}
/** A structurally complete correction; defaults to a LEGAL success. */
function correction(overrides = {}) {
	return {
		outcome_id: "o-corr",
		status: "success",
		supersedes: "o-prior",
		episode_id: EP,
		scope: { ...SCOPE },
		criterion: { criterion_id: "c1", expected: "door.locked == false" },
		provenance: { source: "oracle", independent: true, group: "g-root" },
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// P0-1: illegal corrections never enter the effective view
// ---------------------------------------------------------------------------

await test("P0-1: legal correction replaces the prior in the effective view", () => {
	const eff = effectiveOutcomes([prior(), correction()]);
	assert.deepEqual(
		eff.map((o) => o.outcome_id),
		["o-corr"],
	);
});

await test("P0-1: llm-sourced correction is excluded from effective judgments", () => {
	const llm = correction({ status: "unknown", provenance: { source: "llm", independent: true, group: "g-x" } });
	const eff = effectiveOutcomes([prior(), llm]);
	const ids = eff.map((o) => o.outcome_id);
	assert.ok(ids.includes("o-prior"), "prior must survive an llm correction");
	assert.ok(!ids.includes("o-corr"), "the illegal correction itself must NOT be an effective judgment");
	const ignored = eff.ignored_supersedes ?? [];
	assert.ok(
		ignored.some((entry) => entry.outcome_id === "o-corr" && entry.reason === "llm"),
		"audit must record the llm rejection",
	);
});

await test("P0-1: foreign-episode correction (success) is excluded from the effective view", () => {
	const foreign = correction({ status: "success", episode_id: "ep-other" });
	const eff = effectiveOutcomes([prior(), foreign]);
	assert.ok(
		eff.some((o) => o.outcome_id === "o-prior"),
		"prior survives",
	);
	assert.ok(
		!eff.some((o) => o.outcome_id === "o-corr"),
		"a foreign correction must not enter the effective view even when it says success",
	);
});

await test("P0-1: malformed provenance correction is excluded from the effective view", () => {
	const malformed = correction({ provenance: { source: "oracle" } });
	const eff = effectiveOutcomes([prior(), malformed]);
	assert.ok(eff.some((o) => o.outcome_id === "o-prior"));
	assert.ok(!eff.some((o) => o.outcome_id === "o-corr"));
});

await test("P0-1: correction with a missing target is excluded from the effective view", () => {
	const missing = correction({ supersedes: "does-not-exist" });
	const eff = effectiveOutcomes([prior(), missing]);
	assert.ok(eff.some((o) => o.outcome_id === "o-prior"));
	assert.ok(!eff.some((o) => o.outcome_id === "o-corr"));
});

await test("P0-1: an illegal correction cannot flip stage aggregation to success", () => {
	const stage = { stage_id: "stage-1", task_id: "task-1", required: true, criterion_ids: ["c1"] };
	const foreignSuccess = correction({
		outcome_id: "o-for",
		status: "success",
		episode_id: "ep-foreign",
		provenance: { source: "oracle", independent: true, group: "g-for" },
	});
	const agg = aggregateStage({ stage, outcomes: [prior(), foreignSuccess] });
	assert.notEqual(agg.status, "success", "a foreign success correction must not produce stage success");
});

await test("P0-1: a cycle is audited and neither member is silently accepted", () => {
	const a = prior({ outcome_id: "o1" });
	const b = correction({ outcome_id: "o2", supersedes: "o1" });
	a.supersedes = "o2"; // o1 -> o2 and o2 -> o1
	const eff = effectiveOutcomes([a, b]);
	assert.equal(
		eff.some((o) => o.outcome_id === "o1"),
		false,
		"a cycle member must not be silently accepted as an effective judgment",
	);
	assert.equal(eff.ignored_supersedes.length, 2, "both cycle members are audited as ignored");
});

// ---------------------------------------------------------------------------
// P0-2: missing scope / episode fail closed; canonical compare
// ---------------------------------------------------------------------------

await test("P0-2: two outcomes with NO scope cannot supersede (fail-closed)", () => {
	const noScopePrior = prior({ scope: undefined });
	const noScopeCorr = correction({ scope: undefined });
	const verdict = classifySupersede(noScopeCorr, { outcomes: [noScopePrior, noScopeCorr] });
	assert.equal(verdict.valid, false, "both-missing scope must not be treated as equal");
	assert.equal(verdict.reason, "scope_mismatch");
	assert.ok(effectiveOutcomes([noScopePrior, noScopeCorr]).some((o) => o.outcome_id === "o-prior"));
});

await test("P0-2: canonical scope compare ignores object key order", () => {
	const p = prior({ scope: { a: 1, b: { x: 2, y: 3 } } });
	const c = correction({ scope: { b: { y: 3, x: 2 }, a: 1 } });
	assert.equal(classifySupersede(c, { outcomes: [p, c] }).valid, true);
});

await test("P0-2: canonical criterion.expected compare ignores key order", () => {
	const p = prior({ criterion: { criterion_id: "c1", expected: { locked: false, door: 1 } } });
	const c = correction({ criterion: { criterion_id: "c1", expected: { door: 1, locked: false } } });
	assert.equal(classifySupersede(c, { outcomes: [p, c] }).valid, true);
});

await test("P0-2: both missing episode_id cannot supersede", () => {
	const p = prior({ episode_id: null });
	const c = correction({ episode_id: null, scope: { ...SCOPE } });
	const verdict = classifySupersede(c, { outcomes: [p, c] });
	assert.equal(verdict.valid, false, "a null episode on both sides is not a trusted same-episode binding");
});

// ---------------------------------------------------------------------------
// P0-3: credentials whitelist
// ---------------------------------------------------------------------------

async function reportWithCredentials(value) {
	const fixture = buildFixtureCampaign();
	const manifest = structuredClone(fixture.manifest);
	manifest.authorization.credentials = value;
	const campaignAggregate = aggregateCampaign({ manifest, taskAggregates: [] });
	return buildCampaignReport({ manifest, campaignAggregate });
}

await test("P0-3: credentials policy whitelist keeps none / manifest_policy visible", async () => {
	assert.equal((await reportWithCredentials("none")).authorization.credentials, "none");
	assert.equal((await reportWithCredentials("manifest_policy")).authorization.credentials, "manifest_policy");
});

await test("P0-3: an arbitrary credentials value is never restored into the report", async () => {
	for (const evil of ["api_key=SECRET", "password=SECRET", "Bearer abcdefghijklmnop", "flag{secret}"]) {
		const report = await reportWithCredentials(evil);
		const text = JSON.stringify(report);
		assert.equal(report.authorization.credentials, "[redacted]", `credentials must be redacted for ${evil}`);
		assert.ok(!text.includes("SECRET"), `report must not leak ${evil}`);
	}
});

await test("P0-3: an arbitrary credentials value is never restored into the bundle", async () => {
	const fixture = buildFixtureCampaign();
	const manifest = structuredClone(fixture.manifest);
	manifest.authorization.credentials = "api_key=SECRET";
	const campaignAggregate = aggregateCampaign({ manifest, taskAggregates: [] });
	const report = buildCampaignReport({ manifest, campaignAggregate });
	const bundle = buildAcceptanceBundle({ report });
	assert.equal(bundle.authorization.credentials, "[redacted]");
	assert.ok(!JSON.stringify(bundle).includes("SECRET"));
});

// ---------------------------------------------------------------------------
// P1-1: TaskOracle must be bound to the current Task
// ---------------------------------------------------------------------------

function taskFixture() {
	const fixture = buildFixtureCampaign();
	const task = fixture.manifest.tasks[0];
	const successStages = task.stages.map((stage) => ({
		stage_id: stage.stage_id,
		task_id: task.task_id,
		required: true,
		status: "success",
		outcome_ids: [`o_${stage.stage_id}`],
		criterion_ids: stage.criteria,
	}));
	const taskOracle = {
		outcome_id: "o_task",
		status: "success",
		task_id: task.task_id,
		episode_id: "ep-task-1",
		criterion: { criterion_id: task.goal.goal_id, expected: task.goal.goal_id },
		provenance: { source: "oracle", independent: true, group: "fixture-local" },
	};
	return { fixture, task, successStages, taskOracle };
}

await test("P1-1: a fully bound trusted taskOracle yields task success (positive control)", () => {
	const { task, successStages, taskOracle } = taskFixture();
	const result = aggregateTask({ task, stages: successStages, taskOracle });
	assert.equal(result.status, "success", result.reasons.join("; "));
});

await test("P1-1: a taskOracle without task/criterion binding never yields success", () => {
	const { task, successStages } = taskFixture();
	const result = aggregateTask({
		task,
		stages: successStages,
		taskOracle: { outcome_id: "o_t", status: "success" },
	});
	assert.notEqual(result.status, "success");
});

await test("P1-1: a taskOracle bound to a FOREIGN task never yields success", () => {
	const { task, successStages, taskOracle } = taskFixture();
	const result = aggregateTask({
		task,
		stages: successStages,
		taskOracle: { ...taskOracle, task_id: "task-foreign" },
	});
	assert.notEqual(result.status, "success");
});

await test("P1-1: a model-self-reported (llm) taskOracle never yields success", () => {
	const { task, successStages, taskOracle } = taskFixture();
	const result = aggregateTask({
		task,
		stages: successStages,
		taskOracle: { ...taskOracle, provenance: { source: "llm", independent: true, group: "x" } },
	});
	assert.notEqual(result.status, "success");
});

await test("P1-1: a taskOracle with a mismatched episode never yields success", () => {
	const { task, successStages, taskOracle } = taskFixture();
	const result = aggregateTask({
		task,
		stages: successStages,
		taskOracle: { ...taskOracle, episode_id: "ep-other" },
		episodeId: taskOracle.episode_id,
	});
	assert.notEqual(result.status, "success");
});

await test("P1-1: a taskOracle missing its episode binding never yields success", () => {
	const { task, successStages, taskOracle } = taskFixture();
	const { episode_id: _drop, ...noEpisode } = taskOracle;
	const result = aggregateTask({
		task,
		stages: successStages,
		taskOracle: noEpisode,
		episodeId: taskOracle.episode_id,
	});
	assert.notEqual(result.status, "success");
});

await test("P1-1: a taskOracle whose criterion mismatches the task goal never yields success", () => {
	const { task, successStages, taskOracle } = taskFixture();
	const result = aggregateTask({
		task,
		stages: successStages,
		taskOracle: { ...taskOracle, criterion: { criterion_id: "some_other_goal", expected: "x" } },
	});
	assert.notEqual(result.status, "success");
});

// ---------------------------------------------------------------------------
// P1-2: only LEGAL corrections count as corrections / independence
// ---------------------------------------------------------------------------

await test("P1-2: an illegal correction adds no correction and no independent group", () => {
	const p = prior();
	const illegal = correction({ status: "unknown", episode_id: "ep-foreign" });
	const ind = independenceOf([p, illegal]);
	assert.equal(ind.corrections, 0, "an illegal correction is not a legal correction");
	assert.equal(ind.independent_count, 1, "an illegal correction must not manufacture a new independent group");
});

await test("P1-2: a legal correction is counted exactly once and adds no independent group", () => {
	const ind = independenceOf([prior(), correction()]);
	assert.equal(ind.corrections, 1);
	assert.equal(ind.independent_count, 1);
});

// ---------------------------------------------------------------------------
// P1-3: ID global boundaries
// ---------------------------------------------------------------------------

await test("P1-3: empty-suffix ids are refused for every kind", () => {
	for (const [id, kind] of [
		["task-", "task"],
		["stage-", "stage"],
		["ep-", "episode"],
		["sess-", "session"],
		["campaign-", "campaign"],
	]) {
		assert.equal(assertIdType(id, kind, "id").ok, false, `${id} must be refused`);
	}
});

await test("P1-3: path / traversal / control-character ids are refused", () => {
	for (const id of ["task-a/b", "task-..", "task-./x", "task-a\\b", "task-\u0000x", "task- ../x"]) {
		assert.equal(assertIdType(id, "task", "id").ok, false, `${JSON.stringify(id)} must be refused`);
	}
});

await test("P1-3: well-formed ids are still accepted", () => {
	assert.equal(assertIdType("task-abc123", "task", "id").ok, true);
	assert.equal(assertIdType("stage-abc123", "stage", "id").ok, true);
});

await test("P1-3: a Stage id duplicated ACROSS tasks is refused by the Manifest", () => {
	const manifest = structuredClone(buildFixtureCampaign().manifest);
	manifest.tasks[1].stages[0].stage_id = manifest.tasks[0].stages[0].stage_id;
	const result = validateManifest(manifest);
	assert.equal(result.ok, false);
	assert.ok(
		result.reasons.some((r) => /stage/i.test(r)),
		result.reasons.join("; "),
	);
});

// ---------------------------------------------------------------------------
// P1-4: one shared version policy
// ---------------------------------------------------------------------------

await test("P1-4: a supported same-major minor is accepted at BOTH entries", async () => {
	const manifest = structuredClone(buildFixtureCampaign().manifest);
	manifest.schema_version = "campaign-1.7";
	const validation = validateManifest(manifest);
	assert.equal(validation.ok, true, validation.reasons.join("; "));
	// dynamic-policy must use the SAME decision: the version alone must not reject.
	const proposal = {
		proposed_task_id: "task-dyn-9",
		parent_task_id: manifest.tasks[0].task_id,
		goal: { description: "d", success_criteria: ["x"] },
		target_ref: "fixture/door.json",
		task_type: "observe",
		required_capabilities: ["fixture.observe"],
		expected_evidence: ["e"],
		budget_reservation: { wall_time_ms: 1, model_requests: 0, tool_calls: 0 },
		priority: 1,
		stop_condition: "s",
	};
	const admission = admitTaskProposal({ proposal, manifest, depth: 1 });
	assert.notEqual(admission.status, "rejected", `/version/ must not reject: ${admission.reasons.join("; ")}`);
});

await test("P1-4: an unknown major is refused at both entries", () => {
	const manifest = structuredClone(buildFixtureCampaign().manifest);
	manifest.schema_version = "campaign-2.0";
	assert.equal(validateManifest(manifest).ok, false);
	const proposal = {
		proposed_task_id: "task-dyn-9",
		parent_task_id: manifest.tasks[0].task_id,
		goal: { description: "d", success_criteria: ["x"] },
		target_ref: "fixture/door.json",
		task_type: "observe",
		required_capabilities: ["fixture.observe"],
		expected_evidence: ["e"],
		budget_reservation: { wall_time_ms: 1, model_requests: 0, tool_calls: 0 },
		priority: 1,
		stop_condition: "s",
	};
	assert.equal(admitTaskProposal({ proposal, manifest, depth: 1 }).status, "rejected");
});

// ---------------------------------------------------------------------------
// P1-5: consistent persistImmutableManifest return fields
// ---------------------------------------------------------------------------

await test("P1-5: every success branch returns digest/canonical_digest/path/existed", async () => {
	const dir = join(root, "persist-fields");
	const manifest = buildFixtureCampaign().manifest;
	const first = await persistImmutableManifest(manifest, dir);
	const second = await persistImmutableManifest(manifest, dir);
	for (const [label, result] of [
		["first", first],
		["existed", second],
	]) {
		assert.equal(result.ok, true, label);
		for (const key of ["digest", "canonical_digest", "path", "existed"]) {
			assert.ok(result[key] !== undefined, `${label} success must include ${key}`);
		}
		assert.equal(result.digest, result.canonical_digest, `${label}: digest must equal canonical_digest`);
		assert.equal(result.digest, canonicalManifestDigest(manifest));
	}
	assert.equal(first.existed, false);
	assert.equal(second.existed, true);
});

await test("P1-5: concurrent identical writes both report success with identical fields", async () => {
	const dir = join(root, "persist-race");
	const manifest = buildFixtureCampaign().manifest;
	const results = await Promise.all([
		persistImmutableManifest(manifest, dir),
		persistImmutableManifest(manifest, dir),
		persistImmutableManifest(manifest, dir),
	]);
	for (const result of results) {
		assert.equal(result.ok, true);
		assert.equal(result.digest, canonicalManifestDigest(manifest));
		assert.equal(result.canonical_digest, result.digest);
		assert.ok(typeof result.path === "string");
	}
});

// ---------------------------------------------------------------------------
// CLOSE-08: full required-stage / criterion aggregation
// ---------------------------------------------------------------------------

await test("CLOSE-08: a task missing one required stage never succeeds", () => {
	const { task, successStages, taskOracle } = taskFixture();
	const partial = successStages.slice(0, 1); // drop the second required stage
	const result = aggregateTask({ task, stages: partial, taskOracle });
	assert.notEqual(result.status, "success", "a task must check ALL required stages from its own definition");
});

await test("CLOSE-08: a stage requiring two criteria does not succeed on one", () => {
	const stage = { stage_id: "stage-1", task_id: "task-1", required: true, criterion_ids: ["c1", "c2"] };
	const agg = aggregateStage({
		stage,
		outcomes: [{ outcome_id: "o1", status: "success", criterion: { criterion_id: "c1" }, provenance: { group: "g" } }],
	});
	assert.notEqual(agg.status, "success");
});

await test("CLOSE-08: stage success requires every required criterion", () => {
	const stage = { stage_id: "stage-1", task_id: "task-1", required: true, criterion_ids: ["c1", "c2"] };
	const agg = aggregateStage({
		stage,
		outcomes: [
			{ outcome_id: "o1", status: "success", criterion: { criterion_id: "c1" }, provenance: { group: "g" } },
			{ outcome_id: "o2", status: "success", criterion: { criterion_id: "c2" }, provenance: { group: "g" } },
		],
	});
	assert.equal(agg.status, "success");
});

// ---------------------------------------------------------------------------
// CLOSE-09: legal unknown retains semantics
// ---------------------------------------------------------------------------

await test("CLOSE-09: a legal unknown correction retires the prior Fact but is retained", () => {
	const eff = effectiveOutcomes([prior({ status: "success" }), correction({ status: "unknown" })]);
	// The prior success Fact must be gone.
	assert.ok(!eff.some((o) => o.outcome_id === "o-prior"));
	// The latest legal unknown must remain visible in effective judgments.
	assert.ok(
		eff.some((o) => o.outcome_id === "o-corr" && o.status === "unknown"),
		"the latest legal unknown must be retained in effective judgments",
	);
});

// ---------------------------------------------------------------------------
// CLOSE-10: data usefulness requires real structured references
// ---------------------------------------------------------------------------

await test("CLOSE-10: contributionLink requires structured refs, not bare truthy strings", () => {
	const link = contributionLink({
		data_ref: "not-a-structured-ref",
		used_by_action: "also-not-structured",
		verified_stage_outcome: "nope",
	});
	assert.equal(link.useful, false, "bare truthy strings are not an obtain->use->advance chain");
	const structured = contributionLink({
		data_ref: { ref_type: "data", ref_id: "d1", digest: "sha256:x" },
		used_by_action: { action_id: "a1", event_digest: "sha256:y" },
		verified_stage_outcome: { outcome_id: "o1", stage_id: "s1", status: "success" },
	});
	assert.equal(structured.useful, true);
});

// ---------------------------------------------------------------------------
// CLOSE-11: dynamic parent stage / depth / budget ledger
// ---------------------------------------------------------------------------

function proposalFor(manifest, overrides = {}) {
	return {
		proposed_task_id: "task-dyn-1",
		parent_task_id: manifest.tasks[0].task_id,
		parent_stage_id: manifest.tasks[0].stages[0].stage_id,
		goal: { description: "observe again", success_criteria: ["door.locked == true"] },
		target_ref: "fixture/door.json",
		task_type: "observe",
		required_capabilities: ["fixture.observe"],
		expected_evidence: ["observation.captured"],
		budget_reservation: { wall_time_ms: 1000, model_requests: 1, tool_calls: 2 },
		priority: 1,
		stop_condition: "no remaining authorized target",
		...overrides,
	};
}

await test("CLOSE-11: a parent_stage that belongs to another Task is not admitted", () => {
	const manifest = buildFixtureCampaign().manifest;
	// stage of task[1] used as parent_stage of a proposal whose parent is task[0]
	const proposal = proposalFor(manifest, { parent_stage_id: manifest.tasks[1].stages[0].stage_id });
	const result = admitTaskProposal({ proposal, manifest, depth: 1 });
	assert.notEqual(result.status, "admitted", result.reasons.join("; "));
	assert.notEqual(result.status, "blocked", "a foreign parent stage is structurally invalid, not a human item");
});

await test("CLOSE-11: a self-reported depth inconsistent with the parent chain is refused", () => {
	const manifest = buildFixtureCampaign().manifest;
	// parent task-1 has a real depth of 1 (root); a proposal at depth 1 is fine.
	const fine = admitTaskProposal({ proposal: proposalFor(manifest), manifest, depth: 1 });
	assert.equal(fine.status, "admitted", fine.reasons.join("; "));
	// A proposal claiming depth 1 but whose parent is a depth-1 admitted task is
	// actually depth 2; the caller's claim must be refused.
	const queueState = {
		tasks: [
			{ task_id: manifest.tasks[0].task_id, state: "completed" },
			{ task_id: "task-dyn-parent", parent_task_id: manifest.tasks[0].task_id, state: "completed" },
		],
	};
	const inconsistent = admitTaskProposal({
		proposal: proposalFor(manifest, { parent_task_id: "task-dyn-parent" }),
		manifest,
		queueState,
		depth: 1, // real depth is 2
	});
	assert.notEqual(inconsistent.status, "admitted", "reported depth must match the trusted parent chain");
});

// ---------------------------------------------------------------------------
// CLOSE-12: malformed input returns structured errors
// ---------------------------------------------------------------------------

await test("CLOSE-12: validateManifest never throws on malformed input", () => {
	for (const bad of [null, undefined, 42, "x", [], { schema_version: null }]) {
		const result = validateManifest(bad);
		assert.equal(result.ok, false);
		assert.ok(Array.isArray(result.reasons));
	}
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign closure C0: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign closure C0: all assertions passed");
// Reference imports that are only used in some branches (kept for future cases).
void readFileSync;
void spawn;
