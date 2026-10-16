#!/usr/bin/env node
// Aegis Campaign C0 contract tests.
//
// Offline by construction: no network, no model/provider, no Pi runtime, only
// local temp dirs. Every assertion reads the RECORDS the modules return; nothing
// trusts a self-reported status string without its corresponding evidence.
//
// Covers:
//   1. Manifest validation matrix + canonical digest + immutable persistence;
//   2. typed identifier separation (Campaign/Task/Stage/Episode/Session);
//   3. queue state contract + legal transition table;
//   4. bounded dynamic task proposal: admitted / blocked / rejected;
//   5. deterministic stage/task/Campaign aggregation + supersedes counts;
//   6. report + acceptance bundle determinism, redaction, reviewer verdicts;
//   7. fixture structure (2 tasks, dependency, >=2 stages, one unknown).
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-contracts-c0.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	ADMISSION_STATUSES,
	admitTaskProposal,
	aggregateCampaign,
	aggregateStage,
	aggregateTask,
	applyAdmission,
	BUNDLE_SCHEMA_VERSION,
	buildAcceptanceBundle,
	buildCampaignReport,
	buildFixtureCampaign,
	CAMPAIGN_SCHEMA_VERSION,
	canonicalManifestDigest,
	classifyId,
	effectiveOutcomes,
	findDependencyCycle,
	fixtureOutcomes,
	independenceOf,
	isLegalTransition,
	makeQueueItem,
	newCampaignId,
	newEpisodeId,
	newSessionId,
	newStageId,
	newTaskId,
	persistFixtureCampaign,
	persistImmutableManifest,
	projectInitialQueue,
	QUEUE_STATES,
	REPORT_SCHEMA_VERSION,
	REVIEWER_VERDICTS,
	renderCampaignReportMarkdown,
	renderReviewerPrompt,
	validateManifest,
	validateQueueItem,
	validateReviewerVerdict,
	validateTaskProposal,
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

const root = mkdtempSync(join(tmpdir(), "aegis-campaign-c0-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

function validManifest() {
	return buildFixtureCampaign().manifest;
}
function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 0. identifiers
// ---------------------------------------------------------------------------

await test("identifiers: five distinct prefixes and classifier", () => {
	const ids = {
		campaign: newCampaignId(),
		task: newTaskId(),
		stage: newStageId(),
		episode: newEpisodeId(),
		session: newSessionId(),
	};
	for (const [kind, id] of Object.entries(ids)) assert.equal(classifyId(id), kind, `${id} -> ${kind}`);
	// A session id can never be classified as an episode id.
	assert.notEqual(classifyId(ids.session), "episode");
	assert.equal(classifyId("nonsense"), null);
	assert.equal(classifyId(""), null);
});

// ---------------------------------------------------------------------------
// 1. Manifest validation
// ---------------------------------------------------------------------------

await test("manifest: fixture manifest is valid", () => {
	const result = validateManifest(validManifest());
	assert.equal(result.ok, true, result.reasons.join("; "));
	assert.equal(result.manifest.schema_version, CAMPAIGN_SCHEMA_VERSION);
});

await test("manifest: unknown MAJOR version is refused, same-major minor accepted", () => {
	const bad = validManifest();
	bad.schema_version = "2.0";
	assert.equal(validateManifest(bad).ok, false);
	assert.ok(validateManifest(bad).reasons.some((r) => /major/.test(r)));
	const minor = validManifest();
	minor.schema_version = "1.7";
	assert.equal(validateManifest(minor).ok, true, validateManifest(minor).reasons.join("; "));
});

await test("manifest: missing authorization is refused", () => {
	const bad = validManifest();
	delete bad.authorization;
	const result = validateManifest(bad);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /authorization/.test(r)));
});

await test("manifest: missing target / wildcard target is refused", () => {
	const bad = validManifest();
	bad.authorization.allowed_targets = ["*"];
	const result = validateManifest(bad);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /wildcard/.test(r)));
});

await test("manifest: missing budget and non-positive budget are refused", () => {
	const missing = validManifest();
	delete missing.budget;
	assert.equal(validateManifest(missing).ok, false);
	const zero = validManifest();
	zero.budget.task_count = 0;
	assert.equal(validateManifest(zero).ok, false);
});

await test("manifest: missing task success criteria is refused", () => {
	const bad = validManifest();
	bad.tasks[0].goal.success_criteria = [];
	const result = validateManifest(bad);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /success_criteria/.test(r)));
});

await test("manifest: unregistered execution/oracle/report adapters are refused", () => {
	for (const key of ["execution", "oracle", "report"]) {
		const bad = validManifest();
		bad.adapters[key] = "nope.v9";
		const result = validateManifest(bad);
		assert.equal(result.ok, false, `${key} should fail`);
		assert.ok(
			result.reasons.some((r) => /adapters\./.test(r)),
			`${key} reason`,
		);
	}
});

await test("manifest: duplicate task ids are refused", () => {
	const bad = validManifest();
	bad.tasks[1].task_id = bad.tasks[0].task_id;
	const result = validateManifest(bad);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /duplicate task_id/.test(r)));
});

await test("manifest: dependency on unknown task is refused", () => {
	const bad = validManifest();
	bad.tasks[1].depends_on = ["task-does-not-exist"];
	const result = validateManifest(bad);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /unknown task/.test(r)));
});

await test("manifest: task dependency cycle is refused", () => {
	const bad = validManifest();
	// Make task-001 depend on task-002, which already depends on task-001.
	bad.tasks[0].depends_on = [bad.tasks[1].task_id];
	const result = validateManifest(bad);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /cycle/.test(r)));
	// Direct cycle detector also works standalone.
	assert.ok(findDependencyCycle(bad.tasks));
});

await test("manifest: self-dependency is refused", () => {
	const bad = validManifest();
	bad.tasks[0].depends_on = [bad.tasks[0].task_id];
	assert.equal(validateManifest(bad).ok, false);
});

await test("manifest: task budgets exceeding Campaign budget are refused", () => {
	const bad = validManifest();
	bad.tasks[0].task_budget.model_requests = 1000;
	bad.tasks[1].task_budget.model_requests = 1000;
	const result = validateManifest(bad);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /exceeds Campaign budget/.test(r)));
});

await test("manifest: workspace_is_sandbox=true is refused", () => {
	const bad = validManifest();
	bad.authorization.workspace_is_sandbox = true;
	const result = validateManifest(bad);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /not an OS sandbox/.test(r)));
});

await test("manifest: dynamic policy granting new privilege is refused", () => {
	for (const field of [
		"allow_new_target",
		"allow_new_capability",
		"allow_new_adapter",
		"allow_network",
		"allow_credentials",
		"allow_budget_increase",
	]) {
		const bad = validManifest();
		bad.dynamic_task_policy[field] = true;
		const result = validateManifest(bad);
		assert.equal(result.ok, false, `${field} should be refused`);
		assert.ok(
			result.reasons.some((r) => /cannot grant/.test(r)),
			`${field} reason`,
		);
	}
});

await test("manifest: promote_experience=true is refused", () => {
	const bad = validManifest();
	bad.evidence_policy.promote_experience = true;
	assert.equal(validateManifest(bad).ok, false);
});

await test("manifest: canonical digest is stable and identity-sensitive", () => {
	const a = validManifest();
	const b = clone(a);
	// Key order must not matter.
	const reordered = Object.fromEntries(Object.entries(b).reverse());
	assert.equal(canonicalManifestDigest(a), canonicalManifestDigest(reordered));
	// A different campaign_id must change the digest.
	const c = clone(a);
	c.campaign_id = "campaign-other";
	assert.notEqual(canonicalManifestDigest(a), canonicalManifestDigest(c));
});

await test("manifest: immutable persistence is content-addressed and idempotent", async () => {
	const dir = join(root, "manifest-store");
	const manifest = validManifest();
	const first = await persistImmutableManifest(manifest, dir);
	assert.equal(first.ok, true, first.reason);
	assert.equal(existsSync(first.path), true);
	const second = await persistImmutableManifest(manifest, dir);
	assert.equal(second.ok, true);
	assert.equal(second.existed, true);
	assert.equal(second.path, first.path);
	// The stored bytes are the CANONICAL manifest (contract: canonical JSON).
	const stored = JSON.parse(readFileSync(first.path, "utf8"));
	assert.equal(stored.campaign_id, manifest.campaign_id);
	assert.equal(canonicalManifestDigest(stored), first.digest);
});

await test("manifest: canonical persistence collapses key order to one address", async () => {
	const dir = join(root, "manifest-canon");
	const manifest = validManifest();
	const reordered = Object.fromEntries(Object.entries(manifest).reverse());
	const a = await persistImmutableManifest(manifest, dir);
	const b = await persistImmutableManifest(reordered, dir);
	assert.equal(a.digest, b.digest);
	assert.equal(a.path, b.path);
	assert.equal(canonicalManifestDigest(manifest), canonicalManifestDigest(reordered));
	assert.equal(b.existed, true, "same canonical content resolves to the same existing address");
});

await test("manifest: static task target outside authorization is refused", () => {
	const bad = validManifest();
	bad.tasks[0].target_ref = "elsewhere/secret";
	const result = validateManifest(bad);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /not in authorization.allowed_targets/.test(r)));
});

await test("manifest: static task capability outside authorization is refused", () => {
	const bad = validManifest();
	bad.tasks[0].required_capabilities = ["fixture.destroy"];
	const result = validateManifest(bad);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /not in authorization.allowed_capabilities/.test(r)));
	// An ABSENT required_capabilities defaults to [] (no special capability),
	// never to "any".
	const fine = validManifest();
	delete fine.tasks[0].required_capabilities;
	assert.equal(validateManifest(fine).ok, true);
});

await test("manifest: workspace_is_sandbox must be present and false", () => {
	const missing = validManifest();
	delete missing.authorization.workspace_is_sandbox;
	const missingResult = validateManifest(missing);
	assert.equal(missingResult.ok, false);
	assert.ok(missingResult.reasons.some((r) => /workspace_is_sandbox/.test(r)));
	const trueValue = validManifest();
	trueValue.authorization.workspace_is_sandbox = true;
	assert.equal(validateManifest(trueValue).ok, false);
});

await test("manifest: execution profile / adapter compatibility is enforced", () => {
	// supervised-macos-workspace + workspace.exec.v1 -> accepted (fixture default).
	assert.equal(validateManifest(validManifest()).ok, true);
	// container-brokered + workspace.exec.v1 -> refused (no registered adapter).
	const mismatch = validManifest();
	mismatch.authorization.execution_profile = "container-brokered";
	const result = validateManifest(mismatch);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /not compatible|no registered execution adapter/.test(r)));
});

await test("manifest: unregistered stage oracle_ref is refused", () => {
	const bad = validManifest();
	bad.tasks[0].stages[0].oracle_ref = "unknown.oracle";
	const result = validateManifest(bad);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /oracle_ref .* not a registered oracle adapter/.test(r)));
	// A stage with no oracle_ref inherits the task oracle and is accepted.
	const fine = validManifest();
	fine.tasks[0].stages[0].oracle_ref = "fixture.oracle.v1";
	assert.equal(validateManifest(fine).ok, true);
});

await test("manifest: sum of task wall_time_ms over Campaign budget is refused", () => {
	const bad = validManifest();
	bad.budget.wall_time_ms = 100;
	bad.tasks[0].task_budget.wall_time_ms = 100;
	bad.tasks[1].task_budget.wall_time_ms = 100;
	const result = validateManifest(bad);
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((r) => /wall_time_ms/.test(r)));
});

// ---------------------------------------------------------------------------
// 2. Queue state contract
// ---------------------------------------------------------------------------

await test("queue: state vocabulary and legal transitions", () => {
	assert.ok(QUEUE_STATES.includes("waiting_oracle"));
	assert.ok(QUEUE_STATES.includes("unknown"));
	// Legal forward transitions.
	assert.equal(isLegalTransition("queued", "ready"), true);
	assert.equal(isLegalTransition("running", "waiting_oracle"), true);
	assert.equal(isLegalTransition("waiting_oracle", "unknown"), true);
	// Terminal states have no outgoing transitions.
	assert.equal(isLegalTransition("completed", "running"), false);
	assert.equal(isLegalTransition("failed", "ready"), false);
	assert.equal(isLegalTransition("unknown", "running"), false);
	assert.equal(isLegalTransition("bogus", "ready"), false);
});

await test("queue: item shape validation and initial projection", () => {
	const { manifest } = buildFixtureCampaign();
	const items = projectInitialQueue({ campaign_id: manifest.campaign_id, tasks: manifest.tasks });
	assert.equal(items.length, 2);
	for (const item of items) {
		const result = validateQueueItem(item);
		assert.equal(result.ok, true, result.reasons.join("; "));
	}
	// P0-1: a task with NO dependency starts ready; a task with a dependency must
	// NOT be promoted to ready just because the dependency appears earlier.
	const [task001, task002] = manifest.tasks;
	const itemByTask = new Map(items.map((item) => [item.task_id, item]));
	assert.equal(itemByTask.get(task001.task_id).state, "ready", "no-dependency task must be ready");
	assert.equal(itemByTask.get(task002.task_id).state, "queued", "dependent task must stay queued");
	assert.equal(itemByTask.get(task002.task_id).dependency_status[task001.task_id], "pending");
	const bad = makeQueueItem({ campaign_id: manifest.campaign_id, task_id: manifest.tasks[0].task_id });
	bad.state = "pending"; // `pending` is a projection state, not a queue state
	assert.equal(validateQueueItem(bad).ok, false);
});

// ---------------------------------------------------------------------------
// 3. Dynamic task policy
// ---------------------------------------------------------------------------

function makeProposal(manifest, overrides = {}) {
	return {
		proposed_task_id: newTaskId(),
		parent_task_id: manifest.tasks[0].task_id,
		parent_stage_id: manifest.tasks[0].stages[0].stage_id,
		goal: { description: "observe the door again", success_criteria: ["door.locked == true"] },
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

await test("dynamic: structurally invalid proposal is rejected (not blocked)", () => {
	const { manifest } = buildFixtureCampaign();
	for (const broken of [
		makeProposal(manifest, { parent_task_id: "not-a-task-id" }),
		makeProposal(manifest, { goal: { description: "", success_criteria: [] } }),
		makeProposal(manifest, { task_type: "unregistered" }),
		makeProposal(manifest, { required_capabilities: [] }),
		makeProposal(manifest, { expected_evidence: [] }),
		makeProposal(manifest, { stop_condition: "" }),
		makeProposal(manifest, { budget_reservation: { wall_time_ms: -1, model_requests: 0, tool_calls: 0 } }),
	]) {
		const result = admitTaskProposal({ proposal: broken, manifest });
		assert.equal(result.status, "rejected", JSON.stringify(broken));
		assert.ok(ADMISSION_STATUSES.includes(result.status));
	}
	// `validateTaskProposal` reports reasons too.
	assert.equal(validateTaskProposal({}).ok, false);
});

await test("dynamic: a well-formed proposal inside the envelope is admitted", () => {
	const { manifest } = buildFixtureCampaign();
	const proposal = makeProposal(manifest);
	const result = admitTaskProposal({ proposal, manifest, depth: 1 });
	assert.equal(result.status, "admitted", result.reasons.join("; "));
	assert.ok(result.checks.every((c) => typeof c.passed === "boolean"));
	assert.ok(result.reserved_budget);
});

await test("dynamic: model cannot widen authorization — privilege fields are blocked", () => {
	const { manifest } = buildFixtureCampaign();
	for (const field of [
		"authorization",
		"new_capability",
		"new_target",
		"new_adapter",
		"network",
		"credentials",
		"budget_increase",
		"oracle_ref",
		"execution_adapter",
	]) {
		const proposal = makeProposal(manifest);
		proposal[field] = field === "authorization" ? { mode: "auto" } : true;
		const result = admitTaskProposal({ proposal, manifest });
		assert.equal(result.status, "blocked", `${field} should block`);
		assert.ok(
			result.reasons.some((r) => /privilege field/.test(r)),
			`${field} reason`,
		);
	}
});

await test("dynamic: new target or capability is blocked for human review", () => {
	const { manifest } = buildFixtureCampaign();
	const newTarget = admitTaskProposal({ proposal: makeProposal(manifest, { target_ref: "other/target" }), manifest });
	assert.equal(newTarget.status, "blocked");
	assert.ok(newTarget.reasons.some((r) => /not in the Campaign authorization/.test(r)));
	const newCap = admitTaskProposal({
		proposal: makeProposal(manifest, { required_capabilities: ["fixture.destroy"] }),
		manifest,
	});
	assert.equal(newCap.status, "blocked");
	assert.ok(newCap.reasons.some((r) => /not authorized/.test(r)));
});

await test("dynamic: depth / fan-out / task-count limits are rejected (hard limits)", () => {
	const { manifest } = buildFixtureCampaign();
	// Over max_depth is a STRUCTURAL refusal (contract §3.3), not a human item.
	const tooDeep = admitTaskProposal({ proposal: makeProposal(manifest), manifest, depth: 99 });
	assert.equal(tooDeep.status, "rejected");
	assert.ok(tooDeep.reasons.some((r) => /max_depth|depth/.test(r)));

	const queueState = {
		tasks: [
			{ task_id: "task-x1", parent_task_id: manifest.tasks[0].task_id, state: "running" },
			{ task_id: "task-x2", parent_task_id: manifest.tasks[0].task_id, state: "running" },
		],
	};
	const tooWide = admitTaskProposal({ proposal: makeProposal(manifest), manifest, queueState, depth: 1 });
	assert.equal(tooWide.status, "rejected");
	assert.ok(tooWide.reasons.some((r) => /fan-out|max_fan_out/.test(r)));
});

await test("dynamic: duplicate proposal id is rejected; budget reservation must fit remaining", () => {
	const { manifest } = buildFixtureCampaign();
	const dup = admitTaskProposal({
		proposal: makeProposal(manifest, { proposed_task_id: manifest.tasks[0].task_id }),
		manifest,
	});
	assert.equal(dup.status, "rejected");
	assert.ok(dup.reasons.some((r) => /already exists/.test(r)));

	const overspend = admitTaskProposal({
		proposal: makeProposal(manifest, {
			budget_reservation: { wall_time_ms: 10 ** 9, model_requests: 1, tool_calls: 1 },
		}),
		manifest,
		queueState: { derived_budget: { wall_time_ms: 599000, model_requests: 90, tool_calls: 190 } },
	});
	assert.equal(overspend.status, "blocked");
	assert.ok(overspend.reasons.some((r) => /exceeds remaining/.test(r)));
});

await test("dynamic: disabled policy blocks every proposal", () => {
	const { manifest } = buildFixtureCampaign();
	manifest.dynamic_task_policy.enabled = false;
	const result = admitTaskProposal({ proposal: makeProposal(manifest), manifest });
	assert.equal(result.status, "blocked");
});

await test("dynamic: queueState.tasks is the full set and is not double-counted", () => {
	const { manifest } = buildFixtureCampaign();
	// queueState.tasks already contains the two static tasks plus one admitted
	// dynamic task. max_task_count is 4, so a 4th task must still be admissible.
	const queueState = {
		tasks: [
			{ task_id: manifest.tasks[0].task_id, state: "completed" },
			{ task_id: manifest.tasks[1].task_id, state: "running" },
			{ task_id: "task-dyn-1", parent_task_id: manifest.tasks[0].task_id, state: "running" },
		],
	};
	const result = admitTaskProposal({ proposal: makeProposal(manifest), manifest, queueState, depth: 1 });
	// If static tasks were double-counted the count would be 5 and this would
	// block; with correct semantics it is 3 (< 4) and passes the count check.
	assert.notEqual(result.status, "blocked", result.reasons.join("; "));
	const countCheck = result.checks.find((c) => c.name === "within_task_count");
	assert.equal(countCheck.passed, true);
	assert.ok(/^3 </.test(countCheck.detail), `count should be 3, got ${countCheck.detail}`);
});

await test("dynamic: reservation must be committed before the next proposal", () => {
	const { manifest } = buildFixtureCampaign();
	const proposal1 = makeProposal(manifest, {
		budget_reservation: { wall_time_ms: 500000, model_requests: 80, tool_calls: 150 },
	});
	const first = admitTaskProposal({ proposal: proposal1, manifest, depth: 1 });
	assert.equal(first.status, "admitted", first.reasons.join("; "));
	// Commit the reservation explicitly (C1 must do this atomically).
	const queueState = applyAdmission(
		{ derived_budget: { wall_time_ms: 0, model_requests: 0, tool_calls: 0 } },
		{ proposal: proposal1, reserved_budget: first.reserved_budget },
	);
	// The second proposal cannot fit the now-smaller remaining budget.
	const second = admitTaskProposal({
		proposal: makeProposal(manifest, {
			budget_reservation: { wall_time_ms: 200000, model_requests: 5, tool_calls: 5 },
		}),
		manifest,
		queueState,
		depth: 1,
	});
	assert.equal(second.status, "blocked");
	assert.ok(second.reasons.some((r) => /exceeds remaining/.test(r)));
});

// ---------------------------------------------------------------------------
// 4. Aggregation
// ---------------------------------------------------------------------------

// Minimal, binding-complete Outcome pair used by the supersede tests.
const OUTCOME_SCOPE = { environment_fingerprint: "fixture-env", domain: "fixture" };
function basePrior() {
	return {
		outcome_id: "o1",
		status: "failure",
		episode_id: "ep-fixture-1",
		scope: OUTCOME_SCOPE,
		criterion: { criterion_id: "c", expected: "door.locked == false" },
		provenance: { source: "oracle", independent: true, group: "g1" },
	};
}
function baseCorrection() {
	return {
		outcome_id: "o2",
		status: "success",
		supersedes: "o1",
		episode_id: "ep-fixture-1",
		scope: OUTCOME_SCOPE,
		criterion: { criterion_id: "c", expected: "door.locked == false" },
		provenance: { source: "oracle", independent: true, group: "g1" },
	};
}

await test("aggregate: all-required-success + task success -> task success", () => {
	const fixture = buildFixtureCampaign();
	const task = fixture.manifest.tasks[0];
	const stages = task.stages.map((stage) =>
		aggregateStage({
			stage: { ...stage, task_id: task.task_id, criterion_ids: stage.criteria },
			outcomes: [
				{
					outcome_id: `o_${stage.stage_id}`,
					status: "success",
					criterion: { criterion_id: stage.criteria[0] },
					evidence_refs: [],
					provenance: { group: stage.stage_id },
				},
			],
		}),
	);
	const taskOracle = {
		outcome_id: "o_task",
		status: "success",
		task_id: task.task_id,
		episode_id: "ep-fixture-task-1",
		criterion: { criterion_id: task.goal.goal_id, expected: task.goal.goal_id },
		provenance: { source: "oracle", independent: true, group: "fixture-local" },
	};
	const result = aggregateTask({ task, stages, taskOracle, episodeId: "ep-fixture-task-1" });
	assert.equal(result.status, "success", result.reasons.join("; "));
});

await test("aggregate: unresolved required stage -> unknown (never failure)", () => {
	const fixture = buildFixtureCampaign();
	const task = fixture.manifest.tasks[1];
	const stages = [
		aggregateStage({
			stage: { ...task.stages[0], task_id: task.task_id, criterion_ids: task.stages[0].criteria },
			outcomes: [
				{
					outcome_id: "o_unknown",
					status: "unknown",
					criterion: { criterion_id: task.stages[0].criteria[0] },
					evidence_refs: [],
					provenance: { group: "g" },
				},
			],
		}),
	];
	const result = aggregateTask({ task, stages, taskOracle: { outcome_id: "o_t", status: "unknown" } });
	assert.equal(result.status, "unknown");
});

await test("aggregate: Oracle-verified stage failure -> task failure; no evidence -> pending", () => {
	const fixture = buildFixtureCampaign();
	const task = fixture.manifest.tasks[0];
	const failed = aggregateStage({
		stage: { ...task.stages[0], task_id: task.task_id, criterion_ids: task.stages[0].criteria },
		outcomes: [
			{
				outcome_id: "o_fail",
				status: "failure",
				criterion: { criterion_id: task.stages[0].criteria[0] },
				evidence_refs: [],
				provenance: { group: "g" },
			},
		],
	});
	assert.equal(failed.status, "failure");
	const pending = aggregateStage({
		stage: { ...task.stages[0], task_id: task.task_id, criterion_ids: task.stages[0].criteria },
		outcomes: [],
	});
	assert.equal(pending.status, "pending");
	assert.notEqual(pending.status, "failure");
});

await test("aggregate: safety violation -> task invalid", () => {
	const fixture = buildFixtureCampaign();
	const task = fixture.manifest.tasks[0];
	const result = aggregateTask({
		task,
		stages: [],
		taskOracle: { outcome_id: "o", status: "success" },
		safetyViolation: true,
	});
	assert.equal(result.status, "invalid");
});

await test("aggregate: an illegal Outcome status is never success", () => {
	const fixture = buildFixtureCampaign();
	const task = fixture.manifest.tasks[0];
	const stage = { ...task.stages[0], task_id: task.task_id, criterion_ids: task.stages[0].criteria };
	// Illegal stage status must not become success.
	const bogusStage = aggregateStage({
		stage,
		outcomes: [
			{
				outcome_id: "o",
				status: "banana",
				criterion: { criterion_id: stage.criteria[0] },
				evidence_refs: [],
				provenance: { group: "g" },
			},
		],
	});
	assert.notEqual(bogusStage.status, "success");
	assert.equal(bogusStage.status, "invalid");
	// `pending` is never a persisted Outcome status; if one appears it is illegal.
	const pendingStage = aggregateStage({
		stage,
		outcomes: [
			{
				outcome_id: "o",
				status: "pending",
				criterion: { criterion_id: stage.criteria[0] },
				evidence_refs: [],
				provenance: { group: "g" },
			},
		],
	});
	assert.notEqual(pendingStage.status, "success");
});

await test("aggregate: an illegal task Oracle status is never success", () => {
	const fixture = buildFixtureCampaign();
	const task = fixture.manifest.tasks[0];
	const stages = task.stages.map((stage) => ({
		stage_id: stage.stage_id,
		task_id: task.task_id,
		required: true,
		status: "success",
		outcome_ids: [`o_${stage.stage_id}`],
	}));
	for (const status of ["bogus", "pending", undefined, null]) {
		const result = aggregateTask({ task, stages, taskOracle: { outcome_id: "o_t", status } });
		assert.notEqual(result.status, "success", `status ${String(status)} must not succeed`);
	}
	// A missing task oracle is unknown, not success.
	assert.equal(aggregateTask({ task, stages, taskOracle: null }).status, "unknown");
});

await test("aggregate: supersedes replaces a prior Outcome and never increases independence", () => {
	const prior = basePrior();
	const correction = { ...baseCorrection(), status: "success" };
	const effective = effectiveOutcomes([prior, correction]);
	assert.equal(effective.length, 1);
	assert.equal(effective[0].outcome_id, "o2");
	const independence = independenceOf([prior, correction]);
	assert.equal(independence.corrections, 1);
	assert.equal(independence.independent_count, 1, "a correction is not a new independent attempt");
});

await test("aggregate: supersedes binding — illegal corrections are ignored (fail-closed)", () => {
	const cases = {
		"foreign episode": { ...baseCorrection(), episode_id: "ep-other" },
		"criterion mismatch": { ...baseCorrection(), criterion: { criterion_id: "different" } },
		"scope mismatch": { ...baseCorrection(), scope: { environment_fingerprint: "other" } },
		"missing target": { ...baseCorrection(), supersedes: "does-not-exist" },
	};
	for (const [label, correction] of Object.entries(cases)) {
		const effective = effectiveOutcomes([basePrior(), correction]);
		assert.equal(
			effective.some((o) => o.outcome_id === "o1"),
			true,
			`${label}: prior must survive`,
		);
	}
	// supersede cycle: prior supersedes correction AND correction supersedes prior.
	// Under the corrected P0-1 contract, a row carrying an ILLEGAL `supersedes` is
	// not an effective judgment, so in a mutual cycle BOTH rows are excluded and
	// neither silently retires the other. The audit is preserved.
	const priorCycle = basePrior();
	const correctionCycle = baseCorrection();
	priorCycle.supersedes = correctionCycle.outcome_id; // o1 -> o2
	const effectiveCycle = effectiveOutcomes([priorCycle, correctionCycle]); // o2 -> o1
	assert.equal(
		effectiveCycle.some((o) => o.outcome_id === "o1"),
		false,
		"cycle: neither cycle member is silently accepted as effective",
	);
	assert.equal(
		effectiveCycle.some((o) => o.outcome_id === "o2"),
		false,
		"cycle: neither cycle member is silently accepted as effective",
	);
	assert.equal(effectiveCycle.ignored_supersedes.length, 2, "both cycle members are audited as ignored");
	// llm source is never trusted.
	const llm = { ...baseCorrection(), provenance: { source: "llm", independent: true, group: "g1" } };
	assert.equal(
		effectiveOutcomes([basePrior(), llm]).some((o) => o.outcome_id === "o1"),
		true,
	);
	// malformed provenance (no independent flag) is refused.
	const malformed = { ...baseCorrection(), provenance: { source: "oracle" } };
	assert.equal(
		effectiveOutcomes([basePrior(), malformed]).some((o) => o.outcome_id === "o1"),
		true,
	);
});

await test("aggregate: legal supersede with unknown retires prior but keeps the unknown judgment", () => {
	const effective = effectiveOutcomes([basePrior(), { ...baseCorrection(), status: "unknown" }]);
	assert.equal(
		effective.some((o) => o.outcome_id === "o1"),
		false,
		"prior retired",
	);
	// CLOSE-09: the latest legal unknown IS retained as an effective judgment; it
	// simply creates no success Fact. (It is not silently deleted.)
	assert.equal(
		effective.some((o) => o.outcome_id === "o2" && o.status === "unknown"),
		true,
		"the latest legal unknown must be retained in effective judgments",
	);
});

await test("aggregate: an llm-sourced supersede does not retire a trusted Outcome", () => {
	const llmCorrection = {
		...baseCorrection(),
		status: "unknown",
		provenance: { source: "llm", independent: true, group: "g1" },
	};
	const effective = effectiveOutcomes([basePrior(), llmCorrection]);
	assert.equal(
		effective.some((o) => o.outcome_id === "o1"),
		true,
	);
});

await test("aggregate: campaign aggregate reports raw counts and never a statistical claim", () => {
	const fixture = buildFixtureCampaign();
	const taskAggregates = [
		{ task_id: fixture.manifest.tasks[0].task_id, status: "success", reasons: [] },
		{ task_id: fixture.manifest.tasks[1].task_id, status: "unknown", reasons: [] },
	];
	const aggregate = aggregateCampaign({ manifest: fixture.manifest, taskAggregates });
	assert.equal(aggregate.counts.success, 1);
	assert.equal(aggregate.counts.unknown, 1);
	assert.equal(aggregate.statistical_claim, null);
});

// ---------------------------------------------------------------------------
// 5. Report + acceptance bundle
// ---------------------------------------------------------------------------

async function buildFixtureReport() {
	const fixture = buildFixtureCampaign();
	const taskAggregates = [
		{ task_id: fixture.manifest.tasks[0].task_id, status: "success", reasons: [] },
		{ task_id: fixture.manifest.tasks[1].task_id, status: "unknown", reasons: [] },
	];
	const aggregate = aggregateCampaign({ manifest: fixture.manifest, taskAggregates });
	const outcomes = fixtureOutcomes({ fixture });
	return buildCampaignReport({
		manifest: fixture.manifest,
		manifestDigest: canonicalManifestDigest(fixture.manifest),
		campaignAggregate: aggregate,
		taskAggregates,
		outcomes,
		integrity: { event_chain_ok: true, checkpoint_ok: null, last_committed_digest: "sha256:fixture" },
	});
}

await test("report: schema, deterministic digest, unknown preserved", async () => {
	const report = await buildFixtureReport();
	assert.equal(report.schema_version, REPORT_SCHEMA_VERSION);
	assert.ok(report.report_digest.startsWith("sha256:"));
	// Rebuilding from identical inputs yields an identical digest.
	const again = await buildFixtureReport();
	assert.equal(report.report_digest, again.report_digest);
	// The unknown task stays unknown in the report.
	assert.equal(report.tasks.find((t) => t.status === "unknown")?.status, "unknown");
});

await test("report: markdown renders and cites the digest", async () => {
	const report = await buildFixtureReport();
	const md = renderCampaignReportMarkdown(report);
	assert.ok(md.includes(report.report_digest));
	assert.ok(md.includes("workspace_is_sandbox=false"));
});

await test("report: acceptance bundle is deterministic, bounded and secret-free", async () => {
	const report = await buildFixtureReport();
	const bundle = buildAcceptanceBundle({
		report,
		runtimeDigests: { pi_build_id: "fixture", model: "deterministic-no-model", oracle: "fixture.oracle.v1" },
	});
	assert.equal(bundle.schema_version, BUNDLE_SCHEMA_VERSION);
	assert.equal(bundle.external_reviewer.invoked_by_aegis, false);
	assert.equal(bundle.external_reviewer.may_mutate_state, false);
	// Deterministic.
	const again = buildAcceptanceBundle({
		report,
		runtimeDigests: { pi_build_id: "fixture", model: "deterministic-no-model", oracle: "fixture.oracle.v1" },
	});
	assert.equal(bundle.bundle_digest, again.bundle_digest);
	// No secret-looking keys/values.
	const text = JSON.stringify(bundle);
	assert.ok(!/API[_-]?KEY/i.test(text));
	assert.ok(!/flag\{/i.test(text));
});

await test("report: authorization summary is preserved (not redacted)", async () => {
	const report = await buildFixtureReport();
	assert.equal(typeof report.authorization, "object");
	assert.equal(report.authorization.execution_profile, "supervised-macos-workspace");
	assert.ok(Array.isArray(report.authorization.allowed_targets));
	assert.ok(report.authorization.allowed_targets.length > 0);
	assert.equal(report.authorization.workspace_is_sandbox, false);
	assert.equal(report.authorization.credentials, "none");
});

await test("report: bundle carries structured, traceable evidence_refs", async () => {
	const fixture = buildFixtureCampaign();
	const outcomes = fixtureOutcomes({ fixture });
	const aggregate = aggregateCampaign({ manifest: fixture.manifest, taskAggregates: [] });
	const report = buildCampaignReport({ manifest: fixture.manifest, campaignAggregate: aggregate, outcomes });
	const bundle = buildAcceptanceBundle({ report });
	const withEvidence = bundle.outcomes.find((outcome) => (outcome.evidence_refs ?? []).length > 0);
	assert.ok(withEvidence, "at least one outcome must expose evidence_refs");
	assert.ok(withEvidence.evidence_refs[0].ref_id, "evidence ref must carry a ref_id");
	// Never raw tool output.
	assert.equal(typeof withEvidence.evidence_refs[0], "object");
});

await test("report: bundle_digest covers report_digest", async () => {
	const report = await buildFixtureReport();
	const bundle1 = buildAcceptanceBundle({ report });
	const tamperedReport = { ...report, report_digest: "sha256:tampered" };
	const bundle2 = buildAcceptanceBundle({ report: tamperedReport });
	assert.notEqual(bundle1.bundle_digest, bundle2.bundle_digest, "a changed report_digest must change bundle_digest");
});

await test("report: lowercase flag/ctf/bearer/private-key values are redacted (authorization kept)", async () => {
	const fixture = buildFixtureCampaign();
	const aggregate = aggregateCampaign({ manifest: fixture.manifest, taskAggregates: [] });
	const report = buildCampaignReport({
		manifest: fixture.manifest,
		campaignAggregate: aggregate,
		unsupportedClaims: [
			"flag{lowercase}",
			"ctf{lowercase}",
			"Bearer abcdefghijklmnop",
			"-----BEGIN RSA PRIVATE KEY-----",
		],
	});
	const text = JSON.stringify(report);
	assert.ok(!/flag\{/i.test(text));
	assert.ok(!/ctf\{/i.test(text));
	assert.ok(!/Bearer\s/i.test(text));
	assert.ok(!/PRIVATE KEY/i.test(text));
	// The authorization summary survives the same redaction pass.
	assert.equal(report.authorization.execution_profile, "supervised-macos-workspace");
	assert.ok(report.authorization.allowed_targets.length > 0);
});

await test("report: secrets are redacted from a report", async () => {
	const fixture = buildFixtureCampaign();
	const aggregate = aggregateCampaign({ manifest: fixture.manifest, taskAggregates: [] });
	const report = buildCampaignReport({
		manifest: fixture.manifest,
		campaignAggregate: aggregate,
		unsupportedClaims: ["answer is FLAG{do-not-leak}"],
	});
	// A secret VALUE is redacted.
	assert.ok(!JSON.stringify(report).includes("FLAG{"));
});

await test("report: reviewer prompt requires exactly one verdict and forbids mutation", async () => {
	const report = await buildFixtureReport();
	const bundle = buildAcceptanceBundle({ report });
	const prompt = renderReviewerPrompt(bundle);
	for (const verdict of REVIEWER_VERDICTS) assert.ok(prompt.includes(verdict), verdict);
	assert.ok(/MUST NOT mutate/.test(prompt));
	assert.ok(validateReviewerVerdict({ verdict: "accepted", findings: [] }).ok);
	assert.equal(validateReviewerVerdict({ verdict: "maybe" }).ok, false);
});

// ---------------------------------------------------------------------------
// 6. Fixture structure
// ---------------------------------------------------------------------------

await test("fixture: 2 tasks, dependency, >=2 stages in one task, one unknown case", () => {
	const fixture = buildFixtureCampaign();
	const { manifest } = fixture;
	assert.equal(manifest.tasks.length, 2);
	const [t1, t2] = manifest.tasks;
	assert.ok(t2.depends_on.includes(t1.task_id));
	assert.ok(t1.stages.length >= 2);
	// Deterministic ids: two builds are identical.
	const a = buildFixtureCampaign();
	const b = buildFixtureCampaign();
	assert.equal(canonicalManifestDigest(a.manifest), canonicalManifestDigest(b.manifest));
	// One success and one unknown Oracle case.
	assert.equal(fixture.oracleCases[t1.task_id].stages[t1.stages[0].stage_id].status, "success");
	assert.equal(fixture.oracleCases[t2.task_id].stages[t2.stages[0].stage_id].status, "unknown");
	assert.equal(fixture.oracleCases[t2.task_id].stages[t2.stages[0].stage_id].delayed, true);
});

await test("fixture: persists immutably and rebuilds the same digest", async () => {
	const dir = join(root, "fixture-store");
	const fixture = buildFixtureCampaign();
	const persisted = await persistFixtureCampaign(fixture, dir);
	assert.equal(persisted.ok, true, (persisted.reasons ?? []).join("; "));
	const stored = JSON.parse(readFileSync(persisted.path, "utf8"));
	assert.equal(canonicalManifestDigest(stored), persisted.digest);
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign contracts C0: ${failures.length} failure(s)`);
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
	process.exit(1);
}
console.log("campaign contracts C0: all assertions passed");
