// Aegis Campaign Manifest (schema_version "campaign-1.0") — parse, validate,
// canonicalize and persist immutably.
//
// The Manifest is the Campaign's IMMUTABLE input (docs/CAMPAIGN_ARCHITECTURE.md
// §3.1). A correction creates a new revision/Campaign; it never rewrites the
// source used by a running Campaign. This module owns four jobs:
//
//   1. parse + validate a `campaign-1.0` Manifest, refusing an unknown MAJOR
//      version rather than guessing field meanings (MEMORY_SCHEMA §2.1);
//   2. canonical-digest the immutable Manifest (stable key ordering);
//   3. persist the ORIGINAL manifest as a content-addressed copy so the exact
//      bytes a Campaign ran on remain recoverable;
//   4. expose only value objects — no executable code, no authorization grant.
//
// It deliberately does NOT: create authorization, select an Oracle, register an
// adapter, or widen a budget. Unknown adapters/task types are refused against
// the trusted registries (registries.mjs). A model-provided value can never add
// a permission; validation only ever SUBTRACTS from what the registries allow.

import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { digest } from "../fixture/contracts.mjs";
import { assertIdType, classifyId, isIdOfKind } from "./identifiers.mjs";
import {
	EXECUTION_ADAPTERS,
	isKnownExecutionAdapter,
	isKnownOracleAdapter,
	isKnownReportAdapter,
	isKnownTaskType,
	knownAdapterIds,
	lookupAdapter,
	ORACLE_ADAPTERS,
	REPORT_ADAPTERS,
	TASK_TYPES,
} from "./registries.mjs";

export const CAMPAIGN_SCHEMA_VERSION = "campaign-1.0";
/** Majors this build understands. An unknown major is refused. */
export const KNOWN_CAMPAIGN_MAJORS = Object.freeze(new Set(["1"]));

export const EXECUTION_PROFILES = Object.freeze({
	"supervised-macos-workspace": Object.freeze({
		id: "supervised-macos-workspace",
		workspace_is_sandbox: false,
		supervision: "human_supervised_required",
		description: "User-authorized, human-supervised macOS workspace. NOT an OS sandbox.",
		allowed_execution_adapters: ["workspace.exec.v1"],
	}),
	// Reserved; refused until its adapter is registered. It declares an EMPTY
	// allowed-adapter set, so it can never pair with workspace.exec.v1.
	"container-brokered": Object.freeze({
		id: "container-brokered",
		workspace_is_sandbox: false,
		supervision: "externally_enforced_required",
		description: "Reserved for a later externally enforced container adapter.",
		requires_registered_adapter: true,
		allowed_execution_adapters: [],
	}),
});

const NETWORK_POLICIES = Object.freeze(["disabled", "manifest_policy"]);
const CREDENTIAL_POLICIES = Object.freeze(["none", "manifest_policy"]);
const HUMAN_APPROVAL = Object.freeze(["required", "campaign_grant"]);
const STAGE_POLICIES = Object.freeze(["declared_only", "declared_plus_bounded_dynamic"]);

/** True for a value that would silently act as a wildcard. Never "all". */
function isWildcard(value) {
	if (value === null || value === undefined) return true;
	if (typeof value === "string") return ["*", "any", "all", "unknown", "null", ""].includes(value.trim().toLowerCase());
	return false;
}

export function schemaMajor(version) {
	if (typeof version !== "string" || version.length === 0) return null;
	// `campaign-1.0` -> major "1". Accept an optional `name-` prefix so the
	// Campaign schema string and a bare semver both resolve consistently.
	const numeric = version.includes("-") ? version.slice(version.lastIndexOf("-") + 1) : version;
	return numeric.split(".")[0];
}

export function isKnownCampaignMajor(version) {
	const major = schemaMajor(version);
	return major !== null && KNOWN_CAMPAIGN_MAJORS.has(major);
}

/**
 * Single shared version decision used by EVERY Campaign entry point (Manifest
 * validation, dynamic admission, persistence). A version string must be a
 * non-empty string whose major is known. Callers MUST use this instead of
 * hard-comparing `=== "campaign-1.0"`, so a supported same-major minor is
 * accepted consistently everywhere (CLOSE-07 / P1-4).
 */
export function isSupportedCampaignVersion(version) {
	if (typeof version !== "string" || version.trim().length === 0) return false;
	return isKnownCampaignMajor(version);
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
	return Number.isInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// Canonical digest / normalization
// ---------------------------------------------------------------------------

/**
 * Canonical digest of the IMMUTABLE parts of a Manifest. `campaign_id`,
 * `revision` and `created_at` ARE part of the identity: two different Campaigns
 * must not share a digest even with identical tasks.
 */
export function canonicalManifestDigest(manifest) {
	return digest(manifest);
}

/**
 * Return a normalized, deep-frozen copy of a validated Manifest. Normalization
 * preserves the exact declared values; it only fills documented defaults for
 * OPTIONAL display fields and never invents authorization/scope/budget.
 */
export function normalizeManifest(manifest) {
	const clone = structuredClone(manifest);
	// Object key order is irrelevant to `digest` (it sorts), but freezing makes
	// accidental in-place mutation a hard error rather than a silent divergence.
	return deepFreeze(clone);
}

function deepFreeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze(value[key]);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function normalizeStage(stage, taskId, reasons, labels) {
	const label = `${labels}.stages`;
	if (!stage || typeof stage !== "object") {
		reasons.push(`${label}[${taskId}] must be an object`);
		return null;
	}
	const stageLabel = `${label}[${taskId}].stage_id`;
	const idCheck = assertIdType(stage.stage_id, "stage", stageLabel);
	reasons.push(...idCheck.reasons);
	if (!Array.isArray(stage.criteria) || stage.criteria.length === 0)
		reasons.push(`${label}[${taskId}] ${stage.stage_id}: at least one criterion is required`);
	else {
		for (const [index, criterion] of stage.criteria.entries()) {
			if (!isNonEmptyString(criterion))
				reasons.push(`${label}[${taskId}] ${stage.stage_id}.criteria[${index}] must be a non-empty string`);
		}
	}
	// A stage oracle_ref is OPTIONAL. When present it MUST be a registered
	// adapter; it is never silently accepted. When absent the stage inherits the
	// task Oracle.
	if (stage.oracle_ref !== undefined && stage.oracle_ref !== null) {
		if (!isKnownOracleAdapter(stage.oracle_ref))
			reasons.push(
				`${label}[${taskId}] ${stage.stage_id}: oracle_ref "${String(stage.oracle_ref)}" is not a registered oracle adapter`,
			);
	}
	const required = stage.required === undefined ? true : stage.required === true;
	return {
		stage_id: stage.stage_id,
		criteria: Array.isArray(stage.criteria) ? [...stage.criteria] : [],
		required,
		// null means "inherit the task oracle".
		oracle_ref: stage.oracle_ref ?? null,
	};
}

function normalizeTask(task, reasons, labels, authorization = {}) {
	const label = `${labels}.tasks`;
	if (!task || typeof task !== "object") {
		reasons.push(`${label} entry must be an object`);
		return null;
	}
	const idCheck = assertIdType(task.task_id, "task", `${label}.task_id`);
	reasons.push(...idCheck.reasons);
	if (!isPositiveInteger(task.order)) reasons.push(`${label} ${task.task_id}: order must be a positive integer`);

	// depends_on: explicit task ids, no self-reference, must be a list.
	if (!Array.isArray(task.depends_on)) reasons.push(`${label} ${task.task_id}: depends_on must be an array`);
	else {
		for (const [index, dep] of task.depends_on.entries()) {
			const depCheck = assertIdType(dep, "task", `${label} ${task.task_id}.depends_on[${index}]`);
			reasons.push(...depCheck.reasons);
			if (dep === task.task_id) reasons.push(`${label} ${task.task_id}: depends_on must not reference itself`);
		}
	}

	// Target and goal criteria are mandatory; missing criteria invalidates.
	if (isWildcard(task.target_ref))
		reasons.push(`${label} ${task.task_id}: target_ref is required and must not be a wildcard`);
	// A static task's target MUST be inside the Campaign authorization. A task can
	// never create a new target (the same boundary as dynamic proposals).
	else {
		const allowedTargets = Array.isArray(authorization.allowed_targets) ? authorization.allowed_targets : [];
		if (!allowedTargets.includes(task.target_ref))
			reasons.push(`${label} ${task.task_id}: target_ref "${task.target_ref}" is not in authorization.allowed_targets`);
	}
	if (!task.goal || typeof task.goal !== "object") reasons.push(`${label} ${task.task_id}: goal is required`);
	else {
		if (!isNonEmptyString(task.goal.goal_id)) reasons.push(`${label} ${task.task_id}.goal.goal_id is required`);
		if (!isNonEmptyString(task.goal.description)) reasons.push(`${label} ${task.task_id}.goal.description is required`);
		if (!Array.isArray(task.goal.success_criteria) || task.goal.success_criteria.length === 0)
			reasons.push(`${label} ${task.task_id}.goal.success_criteria requires at least one criterion`);
	}

	// Required capabilities: OPTIONAL field (defaults to an empty list, which
	// requires NO special capability — never "any"). When present, every declared
	// capability MUST be inside authorization.allowed_capabilities.
	let requiredCapabilities = [];
	if (task.required_capabilities !== undefined && task.required_capabilities !== null) {
		if (!Array.isArray(task.required_capabilities)) {
			reasons.push(`${label} ${task.task_id}: required_capabilities must be an array when present`);
		} else {
			const allowedCapabilities = new Set(
				Array.isArray(authorization.allowed_capabilities) ? authorization.allowed_capabilities : [],
			);
			requiredCapabilities = [...task.required_capabilities];
			for (const capability of requiredCapabilities) {
				if (typeof capability !== "string" || !capability)
					reasons.push(`${label} ${task.task_id}: each required capability must be a non-empty string`);
				else if (!allowedCapabilities.has(capability))
					reasons.push(
						`${label} ${task.task_id}: required capability "${capability}" is not in authorization.allowed_capabilities`,
					);
			}
		}
	}

	// Oracle reference: required and must be a KNOWN, registered adapter.
	if (!isKnownOracleAdapter(task.oracle_ref))
		reasons.push(
			`${label} ${task.task_id}: oracle_ref "${String(task.oracle_ref)}" is not a registered oracle adapter`,
		);

	// Stages: at least one, unique stage ids, task-scoped.
	const stages = [];
	if (!Array.isArray(task.stages) || task.stages.length === 0)
		reasons.push(`${label} ${task.task_id}: at least one stage is required`);
	else {
		const seenStages = new Set();
		for (const stage of task.stages) {
			const normalized = normalizeStage(stage, task.task_id, reasons, labels);
			if (!normalized) continue;
			if (seenStages.has(normalized.stage_id))
				reasons.push(`${label} ${task.task_id}: duplicate stage_id ${normalized.stage_id}`);
			seenStages.add(normalized.stage_id);
			stages.push(normalized);
		}
	}

	// Task budget: bounded, non-negative; a task budget may not exceed Campaign
	// budget (checked later, Campaign-wide).
	const taskBudget = task.task_budget && typeof task.task_budget === "object" ? task.task_budget : {};
	for (const key of ["wall_time_ms", "model_requests", "tool_calls"]) {
		if (taskBudget[key] !== undefined && !isNonNegativeInteger(taskBudget[key]))
			reasons.push(`${label} ${task.task_id}.task_budget.${key} must be a non-negative integer`);
	}

	const taskType = task.task_type ?? "verify";
	if (!isKnownTaskType(taskType))
		reasons.push(`${label} ${task.task_id}: task_type "${String(taskType)}" is not a registered task type`);

	return {
		task_id: task.task_id,
		order: task.order,
		depends_on: Array.isArray(task.depends_on) ? [...task.depends_on] : [],
		target_ref: task.target_ref ?? null,
		goal: task.goal
			? {
					goal_id: task.goal.goal_id,
					description: task.goal.description,
					success_criteria: [...(task.goal.success_criteria ?? [])],
				}
			: null,
		stages,
		task_type: taskType,
		required_capabilities: requiredCapabilities,
		oracle_ref: task.oracle_ref ?? null,
		// A task may declare a trusted execution scope/environment. It is preserved
		// (not invented) so the Outcome resolver can require a match. Absent -> null
		// (fail-closed at judgment time, never a wildcard).
		scope: task.scope ?? null,
		task_budget: {
			wall_time_ms: taskBudget.wall_time_ms ?? 0,
			model_requests: taskBudget.model_requests ?? 0,
			tool_calls: taskBudget.tool_calls ?? 0,
		},
	};
}

/** Detect a dependency cycle across the task set. Returns the cycle or null. */
export function findDependencyCycle(tasks) {
	const byId = new Map(tasks.map((task) => [task.task_id, task]));
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map(tasks.map((task) => [task.task_id, WHITE]));
	const stack = [];
	let cycle = null;
	function visit(id) {
		if (cycle) return;
		color.set(id, GRAY);
		stack.push(id);
		const task = byId.get(id);
		for (const dep of task?.depends_on ?? []) {
			if (!byId.has(dep)) continue; // unknown dep is reported separately
			if (color.get(dep) === GRAY) {
				const start = stack.indexOf(dep);
				cycle = [...stack.slice(start), dep];
				return;
			}
			if (color.get(dep) === WHITE) visit(dep);
		}
		stack.pop();
		color.set(id, BLACK);
	}
	for (const task of tasks) if (color.get(task.task_id) === WHITE) visit(task.task_id);
	return cycle;
}

/**
 * Validate a Campaign Manifest. Returns `{ok, reasons, manifest}` where
 * `manifest` is a normalized frozen copy (only when `ok`). Every problem is
 * accumulated; validation never throws on bad input and never grants anything.
 *
 * NOTE (C1/C3 direction): this build validates against the fixed, code-owned
 * trusted registries (registries.mjs). A future C1/C3 may inject a trusted
 * registry CONTEXT (e.g. an extra registered adapter), but Manifest and model
 * values must never register adapters themselves. Do not widen this coupling
 * without reporting it.
 */
export function validateManifest(input) {
	const reasons = [];
	const labels = { tasks: "manifest.tasks" };
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, reasons: ["manifest must be an object"], manifest: null };
	}

	// 1. schema_version: known MAJOR required; unknown major is refused.
	if (typeof input.schema_version !== "string" || input.schema_version.length === 0)
		reasons.push("schema_version is required");
	else if (!isKnownCampaignMajor(input.schema_version))
		reasons.push(
			`unknown campaign schema major "${input.schema_version}"; this build understands ${[...KNOWN_CAMPAIGN_MAJORS].map((m) => `${m}.x`).join(", ")}`,
		);

	// 2. Identity.
	reasons.push(...assertIdType(input.campaign_id, "campaign", "campaign_id").reasons);
	if (!isPositiveInteger(input.revision)) reasons.push("revision must be a positive integer");
	if (!isNonEmptyString(input.created_at)) reasons.push("created_at is required");
	if (!isNonEmptyString(input.title)) reasons.push("title is required");

	// 3. Objective.
	if (!input.objective || typeof input.objective !== "object") reasons.push("objective is required");
	else {
		if (!isNonEmptyString(input.objective.description)) reasons.push("objective.description is required");
		if (!Array.isArray(input.objective.success_criteria) || input.objective.success_criteria.length === 0)
			reasons.push("objective.success_criteria requires at least one criterion");
		const stagePolicy = input.objective.stage_policy ?? "declared_only";
		if (!STAGE_POLICIES.includes(stagePolicy))
			reasons.push(`objective.stage_policy must be one of ${STAGE_POLICIES.join(", ")}`);
	}

	// 4. Worker (informational provenance; no authorization here).
	if (input.worker !== undefined) {
		if (!input.worker || typeof input.worker !== "object") reasons.push("worker must be an object when present");
		else if (!isNonEmptyString(input.worker.provider) || !isNonEmptyString(input.worker.model))
			reasons.push("worker.provider and worker.model are required");
	}

	// 5. Authorization. Everything here is mandatory: a Campaign without an
	//    explicit target/scope/capability set is invalid, never "all".
	const executionProfile = input.authorization?.execution_profile;
	const profile = Object.hasOwn(EXECUTION_PROFILES, executionProfile ?? "")
		? EXECUTION_PROFILES[executionProfile]
		: null;
	if (!profile)
		reasons.push(
			`authorization.execution_profile must be a known profile (${Object.keys(EXECUTION_PROFILES).join(", ")})`,
		);
	if (input.authorization && typeof input.authorization === "object") {
		if (isWildcard(input.authorization.workspace_root))
			reasons.push("authorization.workspace_root is required and must not be a wildcard");
		if (!Array.isArray(input.authorization.allowed_targets) || input.authorization.allowed_targets.length === 0)
			reasons.push("authorization.allowed_targets must be a non-empty list");
		else if (input.authorization.allowed_targets.some(isWildcard))
			reasons.push("authorization.allowed_targets must not contain a wildcard");
		const capabilities = input.authorization.allowed_capabilities;
		if (!Array.isArray(capabilities) || capabilities.length === 0)
			reasons.push("authorization.allowed_capabilities must be a non-empty list");
		else if (capabilities.some(isWildcard))
			reasons.push("authorization.allowed_capabilities must not contain a wildcard");
		if (!NETWORK_POLICIES.includes(input.authorization.network))
			reasons.push(`authorization.network must be one of ${NETWORK_POLICIES.join(", ")}`);
		if (!CREDENTIAL_POLICIES.includes(input.authorization.credentials))
			reasons.push(`authorization.credentials must be one of ${CREDENTIAL_POLICIES.join(", ")}`);
		if (!HUMAN_APPROVAL.includes(input.authorization.human_approval))
			reasons.push(`authorization.human_approval must be one of ${HUMAN_APPROVAL.join(", ")}`);
		// workspace_is_sandbox MUST be present and exactly false. Missing, true, or
		// any non-false value is refused: a workspace is never a sandbox.
		if (input.authorization.workspace_is_sandbox !== false)
			reasons.push(
				"authorization.workspace_is_sandbox must be explicitly present and false: a workspace is not an OS sandbox",
			);
	} else {
		reasons.push("authorization is required");
	}

	// 6. Budget. All dimensions mandatory and bounded. Campaign total can never
	//    be increased by a dynamic task (C1); it is fixed here.
	if (!input.budget || typeof input.budget !== "object") reasons.push("budget is required");
	else {
		for (const key of ["wall_time_ms", "model_requests", "tool_calls", "task_count", "session_count"]) {
			if (!isPositiveInteger(input.budget[key])) reasons.push(`budget.${key} must be a positive integer`);
		}
	}

	// 7. Session policy.
	if (!input.session_policy || typeof input.session_policy !== "object") reasons.push("session_policy is required");
	else {
		if (!isPositiveInteger(input.session_policy.max_requests_per_session))
			reasons.push("session_policy.max_requests_per_session must be a positive integer");
		if (!isPositiveInteger(input.session_policy.max_context_chars))
			reasons.push("session_policy.max_context_chars must be a positive integer");
		for (const key of ["rotate_at_stage_boundary", "rotate_on_model_request", "allow_model_handoff_request"]) {
			if (typeof input.session_policy[key] !== "boolean") reasons.push(`session_policy.${key} must be a boolean`);
		}
	}

	// 8. Adapters: all required and must be registered. The Manifest selects; it
	//    cannot register.
	if (!input.adapters || typeof input.adapters !== "object") reasons.push("adapters is required");
	else {
		if (!isKnownExecutionAdapter(input.adapters.execution))
			reasons.push(`adapters.execution "${String(input.adapters.execution)}" is not a registered execution adapter`);
		if (!isKnownOracleAdapter(input.adapters.oracle))
			reasons.push(`adapters.oracle "${String(input.adapters.oracle)}" is not a registered oracle adapter`);
		if (!isKnownReportAdapter(input.adapters.report))
			reasons.push(`adapters.report "${String(input.adapters.report)}" is not a registered report adapter`);
	}

	// 8b. Execution-profile / adapter COMPATIBILITY. Knowing both names is not
	//     enough: only a declared, supported pairing is accepted. A profile that
	//     requires an externally enforced adapter (e.g. container-brokered) is
	//     refused while no such adapter is registered.
	if (profile && input.adapters && typeof input.adapters === "object") {
		const allowedAdapters = Array.isArray(profile.allowed_execution_adapters)
			? profile.allowed_execution_adapters
			: profile.requires_registered_adapter === true
				? []
				: null;
		if (allowedAdapters === null) {
			reasons.push(`execution profile "${executionProfile}" does not declare a supported execution adapter`);
		} else if (allowedAdapters.length === 0) {
			reasons.push(`execution profile "${executionProfile}" has no registered execution adapter and is refused`);
		} else if (!allowedAdapters.includes(input.adapters.execution)) {
			reasons.push(
				`execution profile "${executionProfile}" is not compatible with adapter "${String(input.adapters.execution)}" (allowed: ${allowedAdapters.join(", ")})`,
			);
		}
	}

	// 9. Tasks: at least one, unique ids, valid deps, no cycles, budget within
	//    Campaign total, task_count within Campaign budget.
	const tasks = [];
	if (!Array.isArray(input.tasks) || input.tasks.length === 0) reasons.push("tasks must be a non-empty array");
	else {
		const seen = new Set();
		for (const task of input.tasks) {
			const normalized = normalizeTask(task, reasons, labels, input.authorization);
			if (!normalized) continue;
			if (seen.has(normalized.task_id)) reasons.push(`duplicate task_id ${normalized.task_id}`);
			seen.add(normalized.task_id);
			tasks.push(normalized);
		}
		const knownTaskIds = new Set(tasks.map((task) => task.task_id));
		for (const task of tasks) {
			for (const dep of task.depends_on) {
				if (!knownTaskIds.has(dep)) reasons.push(`task ${task.task_id} depends on unknown task ${dep}`);
			}
		}
		// Stage IDs must be unique across the WHOLE Campaign, not only within one
		// Task (CLOSE-06). A Stage id is a global evidence key, so a duplicate
		// across two Tasks would make Outcome resolution ambiguous.
		const seenStageIds = new Map();
		for (const task of tasks) {
			for (const stage of task.stages) {
				if (seenStageIds.has(stage.stage_id))
					reasons.push(
						`stage_id ${stage.stage_id} is declared in both task ${seenStageIds.get(stage.stage_id)} and task ${task.task_id}; Stage ids must be unique across the Campaign`,
					);
				else seenStageIds.set(stage.stage_id, task.task_id);
			}
		}
		const cycle = findDependencyCycle(tasks);
		if (cycle) reasons.push(`task dependency cycle: ${cycle.join(" -> ")}`);
		// Task budgets must fit inside the Campaign budget (requests, tool calls
		// AND wall time all accumulate).
		if (input.budget && typeof input.budget === "object") {
			let sumRequests = 0;
			let sumTools = 0;
			let sumWallTime = 0;
			for (const task of tasks) {
				sumRequests += task.task_budget.model_requests ?? 0;
				sumTools += task.task_budget.tool_calls ?? 0;
				sumWallTime += task.task_budget.wall_time_ms ?? 0;
			}
			if (isPositiveInteger(input.budget.wall_time_ms) && sumWallTime > input.budget.wall_time_ms)
				reasons.push(
					`sum of task wall_time_ms (${sumWallTime}) exceeds Campaign budget.wall_time_ms (${input.budget.wall_time_ms})`,
				);
			if (isPositiveInteger(input.budget.model_requests) && sumRequests > input.budget.model_requests)
				reasons.push(
					`sum of task model_requests (${sumRequests}) exceeds Campaign budget.model_requests (${input.budget.model_requests})`,
				);
			if (isPositiveInteger(input.budget.tool_calls) && sumTools > input.budget.tool_calls)
				reasons.push(
					`sum of task tool_calls (${sumTools}) exceeds Campaign budget.tool_calls (${input.budget.tool_calls})`,
				);
			if (isPositiveInteger(input.budget.task_count) && tasks.length > input.budget.task_count)
				reasons.push(`declared tasks (${tasks.length}) exceed Campaign budget.task_count (${input.budget.task_count})`);
		}
	}

	// 10. Dynamic task policy (bounded expansion). This describes the ENVELOPE
	//     for model proposals; it is validated strictly (no wildcards).
	if (input.dynamic_task_policy !== undefined) {
		const policy = input.dynamic_task_policy;
		if (!policy || typeof policy !== "object") reasons.push("dynamic_task_policy must be an object when present");
		else if (policy.enabled === true) {
			if (!Array.isArray(policy.allowed_task_types) || policy.allowed_task_types.length === 0)
				reasons.push("dynamic_task_policy.allowed_task_types must be a non-empty list when enabled");
			else
				for (const type of policy.allowed_task_types)
					if (!isKnownTaskType(type))
						reasons.push(`dynamic_task_policy.allowed_task_types contains unregistered task type "${String(type)}"`);
			for (const key of ["max_depth", "max_fan_out", "max_task_count"]) {
				if (!isNonNegativeInteger(policy[key]))
					reasons.push(`dynamic_task_policy.${key} must be a non-negative integer when enabled`);
			}
			if (
				policy.max_task_count !== undefined &&
				input.budget?.task_count !== undefined &&
				isNonNegativeInteger(policy.max_task_count) &&
				policy.max_task_count > input.budget.task_count
			)
				reasons.push("dynamic_task_policy.max_task_count must not exceed budget.task_count");
			if (!isNonEmptyString(policy.required_stop_condition))
				reasons.push("dynamic_task_policy.required_stop_condition is required when enabled");
			if (
				policy.allow_new_target === true ||
				policy.allow_new_capability === true ||
				policy.allow_new_adapter === true ||
				policy.allow_network === true ||
				policy.allow_credentials === true ||
				policy.allow_budget_increase === true
			) {
				reasons.push("dynamic_task_policy cannot grant new target/capability/adapter/network/credentials/budget");
			}
		}
	}

	// 11. Evidence policy.
	if (!input.evidence_policy || typeof input.evidence_policy !== "object") reasons.push("evidence_policy is required");
	else {
		if (typeof input.evidence_policy.independent_result_required !== "boolean")
			reasons.push("evidence_policy.independent_result_required must be a boolean");
		if (typeof input.evidence_policy.unknown_is_not_failure !== "boolean")
			reasons.push("evidence_policy.unknown_is_not_failure must be a boolean");
		if (input.evidence_policy.promote_experience === true)
			reasons.push(
				"evidence_policy.promote_experience must be false: Campaign completion never auto-promotes Experience",
			);
	}

	if (reasons.length > 0) return { ok: false, reasons, manifest: null };
	return { ok: true, reasons: [], manifest: normalizeManifest(input) };
}

// ---------------------------------------------------------------------------
// Load / immutable persistence
// ---------------------------------------------------------------------------

export async function loadManifest(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		return { ok: false, reasons: [`manifest is not readable at ${path}: ${String(error)}`], manifest: null };
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, reasons: [`manifest is not valid JSON at ${path}: ${String(error)}`], manifest: null };
	}
	return validateManifest(parsed);
}

/**
 * Persist the Manifest as an immutable, content-addressed CANONICAL copy.
 *
 * CONTRACT (explicit): the stored artifact is the CANONICAL JSON bytes produced
 * from the manifest value with stable key ordering — NOT the caller's original
 * whitespace/key order. The content address is the canonical digest of the
 * canonical bytes, so two semantically-equal manifests with different key order
 * resolve to the SAME address and the SAME bytes. If the caller needs to keep
 * the literal original bytes, it must store them separately itself.
 *
 * Returns `{ok, digest, canonical_digest, path, existed}` on EVERY success branch
 * (first write, already-exists, concurrent identical). `digest` and
 * `canonical_digest` are the same value: the content address. Refuses to
 * overwrite a DIFFERENT manifest sharing the same content address (a digest
 * collision).
 */
export async function persistImmutableManifest(manifest, dir) {
	const digestValue = canonicalManifestDigest(manifest);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${digestValue.replace(/^sha256:/, "manifest-")}.json`);
	// Canonical bytes: stable stringifier (sorted keys) is the SAME function used
	// by `digest`, so the bytes and the content address agree.
	const body = `${canonicalJson(manifest)}\n`;
	// A single success shape so every branch returns the identical key set.
	const success = (existed) => ({
		ok: true,
		digest: digestValue,
		canonical_digest: digestValue,
		path,
		existed,
		synced: true,
	});
	// DURABLE CONFIRMATION (E1 §4.1): a writeFile that returns is NOT a durability
	// guarantee. The canonical file must be fsynced, and a newly created parent
	// directory entry must be fsynced, BEFORE the caller may declare the run
	// durable. Any fsync failure is reported as a non-durable failure (fail-closed).
	const failure = (existed, reason) => ({
		ok: false,
		digest: digestValue,
		canonical_digest: digestValue,
		path,
		existed,
		synced: false,
		reason,
	});
	// EVERY success branch (first write, already exists, concurrent identical)
	// confirms BOTH the file and its directory entry. An existing file may be the
	// leftover of an earlier attempt whose directory fsync failed, so its presence
	// alone is not a durability proof.
	const confirm = async (existed) => {
		try {
			await fsyncPath(path);
			await fsyncDirectory(dirname(path));
		} catch (error) {
			return failure(existed, `durability_unconfirmed: ${String(error)}`);
		}
		return success(existed);
	};
	/** Read the canonical copy; ONLY a missing file is "absent", any other error fails. */
	const readExisting = async () => {
		try {
			return { ok: true, text: await readFile(path, "utf8") };
		} catch (error) {
			if (/** @type {any} */ (error)?.code === "ENOENT") return { ok: true, text: null };
			return { ok: false, error };
		}
	};
	const first = await readExisting();
	if (!first.ok) return failure(true, `could not read immutable manifest: ${String(first.error)}`);
	if (first.text !== null) {
		if (first.text === body) return confirm(true);
		return failure(true, "content address exists with different bytes (digest collision)");
	}
	try {
		await writeFile(path, body, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if (/** @type {any} */ (error)?.code !== "EEXIST")
			return failure(false, `could not persist immutable manifest: ${String(error)}`);
		// A concurrent writer created it first; it counts only if the bytes match.
		const raced = await readExisting();
		if (raced.ok && raced.text === body) return confirm(true);
		return failure(true, `could not persist immutable manifest: ${String(error)}`);
	}
	return confirm(false);
}

/**
 * Load the canonical immutable Manifest copy named by a trusted digest. Fails
 * closed on a missing file, unreadable file or a digest mismatch.
 *
 * @param {string} dir
 * @param {string} manifestDigest
 */
export async function loadImmutableManifest(dir, manifestDigest) {
	if (typeof manifestDigest !== "string" || !manifestDigest.startsWith("sha256:"))
		return { ok: false, manifest: null, reason: "a trusted manifest digest is required" };
	const path = join(dir, `${manifestDigest.replace(/^sha256:/, "manifest-")}.json`);
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		return { ok: false, manifest: null, reason: `canonical manifest copy unavailable: ${String(error)}` };
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, manifest: null, reason: `canonical manifest copy is not JSON: ${String(error)}` };
	}
	if (canonicalManifestDigest(parsed) !== manifestDigest)
		return { ok: false, manifest: null, reason: "canonical manifest copy does not match its content address" };
	return { ok: true, manifest: parsed, path, reason: null };
}

/** fsync a single file path. Returns true on success; throws on failure. */
async function fsyncPath(path) {
	const handle = await open(path, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	return true;
}

/** fsync a directory so a newly created entry survives a crash. */
async function fsyncDirectory(dir) {
	const handle = await open(dir, "r");
	try {
		if (typeof handle.sync === "function") await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Canonical JSON text with sorted object keys. This is the byte-level contract
 * behind `canonicalManifestDigest` and the immutable copy: two inputs that are
 * equal as JSON values but differ in key order produce the SAME bytes/digest.
 */
export function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

// Re-export the registry lookups so callers use one import surface.
export {
	EXECUTION_ADAPTERS,
	ORACLE_ADAPTERS,
	REPORT_ADAPTERS,
	TASK_TYPES,
	isKnownExecutionAdapter,
	isKnownOracleAdapter,
	isKnownReportAdapter,
	isKnownTaskType,
	knownAdapterIds,
	lookupAdapter,
};
export { classifyId, isIdOfKind };
