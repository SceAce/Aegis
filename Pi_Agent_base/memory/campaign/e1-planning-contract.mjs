// Aegis E1 (cc-01/02/03) — the IMMUTABLE planning contract and the ONE
// normalized executable-Task shape.
//
// This module is PURE (no disk, no clock, no mutable config) and owns the
// security-critical invariants the rest of the campaign consumes:
//
//   * `buildPlanningContract` freezes the trusted planning context (root goal,
//     templates, policy, tool accounting) into a digestible object that is
//     embedded verbatim in the immutable Manifest. The model can never supply or
//     widen it; replay reloads the SAME object from the durable Manifest.
//   * `normalizeExecutableTask` is the ONE place a static Manifest task, an
//     admitted plan node or a dynamic proposal becomes the `ExecutableTask` the
//     Scheduler/worker/Oracle/Board consume. It refuses missing/conflicting
//     budgets instead of falling back to the Campaign total.
//
// Nothing here writes events. `e1-planning.mjs` composes it into the Manifest
// builder and `projection.mjs` carries the admitted definitions.

import { digest } from "../fixture/contracts.mjs";
import { isKnownTaskType } from "./registries.mjs";

/** Version of the embedded planning contract. */
export const PLANNING_CONTRACT_VERSION = "e1-planning-contract-1.0";

/** Version of a normalized executable task definition. */
export const EXECUTABLE_TASK_VERSION = "e1-executable-task-1.0";

/** The Host-owned string used as the campaign root goal reference. */
export const ROOT_GOAL_REF = "campaign-root";

/** The trusted tool-accounting protocol for a new E1 run. */
export const TOOL_ACCOUNTING_PROTOCOL = "durable-charge-v1";

/** The single-plan admission policy. */
export const PLAN_POLICY_SINGLE = "single_admitted_plan";

/** Budget dimensions, in canonical order. */
export const BUDGET_DIMS = Object.freeze(["wall_time_ms", "model_requests", "tool_calls"]);

export class PlanningContractError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 */
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

function isSafeNonNegativeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Deep-canonicalize a value so two structurally-equal inputs share one digest
 * regardless of key insertion order. Arrays keep their order unless the caller
 * sorts them explicitly (criteria/ref order is semantically meaningful here).
 */
function canonicalValue(value) {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
		return out;
	}
	return value;
}

/**
 * Normalize a trusted template list into a DETERMINISTIC, deduplicated array.
 * Duplicate `template_ref` with differing content, or a `task_type` alias that
 * maps to two different templates, is refused (never silently overwritten).
 *
 * @param {any[]} templates
 * @returns {{ok: boolean, templates: any[], reasons: string[]}}
 */
export function normalizeTrustedTemplates(templates = []) {
	const reasons = [];
	const byRef = new Map();
	const byType = new Map();
	for (const [index, raw] of templates.entries()) {
		if (!raw || typeof raw !== "object") {
			reasons.push(`templates[${index}] must be an object`);
			continue;
		}
		const template_ref = raw.template_ref ?? raw.task_type ?? null;
		const task_type = raw.task_type ?? raw.template_ref ?? null;
		if (!isNonEmptyString(template_ref)) {
			reasons.push(`templates[${index}].template_ref is required`);
			continue;
		}
		if (!isNonEmptyString(task_type)) {
			reasons.push(`templates[${index}].task_type is required`);
			continue;
		}
		if (!isKnownTaskType(task_type)) {
			reasons.push(`templates[${index}].task_type ${task_type} is not registered`);
			continue;
		}
		const scope = raw.scope ?? null;
		if (!scope || typeof scope !== "object" || !isNonEmptyString(scope.environment_fingerprint)) {
			reasons.push(`templates[${index}].scope.environment_fingerprint is required`);
			continue;
		}
		const success_criteria = [...new Set((raw.success_criteria ?? []).filter(isNonEmptyString))];
		if (success_criteria.length === 0) {
			reasons.push(`templates[${index}] offers no success_criteria`);
			continue;
		}
		const entry = canonicalValue({
			template_ref,
			task_type,
			oracle_ref: raw.oracle_ref ?? null,
			required_capabilities: [...new Set((raw.required_capabilities ?? []).filter(isNonEmptyString))],
			success_criteria,
			scope: {
				environment_fingerprint: scope.environment_fingerprint,
				domain: scope.domain ?? null,
				permissions: [...new Set((scope.permissions ?? []).filter(isNonEmptyString))],
				task_types: [...new Set((scope.task_types ?? []).filter(isNonEmptyString))],
			},
		});
		const prior = byRef.get(template_ref);
		if (prior) {
			if (digest(prior) !== digest(entry))
				reasons.push(`template_ref ${template_ref} is duplicated with different content`);
			continue;
		}
		byRef.set(template_ref, entry);
		const priorType = byType.get(task_type);
		if (priorType && priorType.template_ref !== template_ref) {
			reasons.push(`task_type ${task_type} ambiguously maps to ${priorType.template_ref} and ${template_ref}`);
			continue;
		}
		byType.set(task_type, entry);
	}
	const list = [...byRef.values()].sort((a, b) => a.template_ref.localeCompare(b.template_ref));
	return { ok: reasons.length === 0, templates: list, reasons };
}

/**
 * Build the trusted `PlanningContract` embedded in the immutable Manifest.
 * PURE: the caller supplies the trusted base manifest + normalized templates.
 * The result is deterministic (templates sorted, criteria exact) so live and
 * replay derive the same digest.
 *
 * @param {{manifest: any, templates: any[]|Map<string,any>, requiredCriteria?: string[]}} args
 * @returns {{ok: boolean, contract: any|null, reasons: string[]}}
 */
export function buildPlanningContract({ manifest, templates, requiredCriteria = [] } = /** @type {any} */ ({})) {
	const reasons = [];
	if (!manifest || typeof manifest !== "object") {
		return { ok: false, contract: null, reasons: ["buildPlanningContract requires a base manifest"] };
	}
	const rawTemplates = templates instanceof Map ? [...new Set(templates.values())] : (templates ?? []);
	const normalized = normalizeTrustedTemplates(rawTemplates);
	if (!normalized.ok) reasons.push(...normalized.reasons);
	const criteria = [...new Set((requiredCriteria ?? []).filter(isNonEmptyString))];
	if (normalized.ok && criteria.length > 0) {
		const covered = new Set(normalized.templates.flatMap((t) => t.success_criteria));
		const missing = criteria.filter((c) => !covered.has(c));
		if (missing.length > 0) reasons.push(`no trusted template offers required criteria: ${missing.join(", ")}`);
	}
	if (reasons.length > 0) return { ok: false, contract: null, reasons };
	const base = {
		version: PLANNING_CONTRACT_VERSION,
		planning_task_id: "task-plan",
		planning_criterion: "plan_ready",
		root_goal_ref: ROOT_GOAL_REF,
		plan_policy: PLAN_POLICY_SINGLE,
		tool_accounting: TOOL_ACCOUNTING_PROTOCOL,
		templates: normalized.templates,
	};
	return { ok: true, contract: { ...base, digest: digest(base) }, reasons: [] };
}

/**
 * Validate an already-built contract (loaded from a durable Manifest). Refuses
 * an unknown MAJOR version and any structural drift. Unknown same-major fields
 * never widen authorization.
 *
 * @param {any} contract
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function validatePlanningContract(contract) {
	const reasons = [];
	if (!contract || typeof contract !== "object") return { ok: false, reasons: ["planning contract is missing"] };
	if (contract.version !== PLANNING_CONTRACT_VERSION)
		return { ok: false, reasons: [`unsupported planning contract version ${String(contract.version)}`] };
	const { digest: declared, ...rest } = contract;
	if (declared !== digest(rest)) reasons.push("planning contract digest does not match its content");
	if (rest.plan_policy !== PLAN_POLICY_SINGLE) reasons.push(`unsupported plan_policy ${String(rest.plan_policy)}`);
	if (rest.tool_accounting !== TOOL_ACCOUNTING_PROTOCOL)
		reasons.push(`unsupported tool_accounting ${String(rest.tool_accounting)}`);
	if (!isNonEmptyString(rest.planning_task_id)) reasons.push("planning_task_id is required");
	if (rest.root_goal_ref !== ROOT_GOAL_REF) reasons.push(`root_goal_ref must be ${ROOT_GOAL_REF}`);
	const normalized = normalizeTrustedTemplates(rest.templates ?? []);
	if (!normalized.ok) reasons.push(...normalized.reasons);
	else if (digest(normalized.templates) !== digest(rest.templates ?? []))
		reasons.push("planning contract templates are not in canonical form");
	return { ok: reasons.length === 0, reasons };
}

/**
 * Load the trusted planning authority from a manifest. Returns the contract,
 * its digest, the template map and the derived `context_digest`. Absent or
 * invalid contract -> `legacy_context_unavailable` / explicit failure.
 *
 * @param {{manifest: any}} args
 */
export function loadPlanningAuthority({ manifest } = /** @type {any} */ ({})) {
	if (!manifest || typeof manifest !== "object")
		return { ok: false, context: null, templates: null, manifest_digest: null, context_digest: null, reasons: ["manifest required"] };
	const manifest_digest = digest(manifest);
	const contract = manifest.planning_contract ?? null;
	if (!contract)
		return {
			ok: false,
			context: null,
			templates: null,
			manifest_digest,
			context_digest: null,
			reasons: ["legacy_context_unavailable: manifest carries no planning_contract"],
			code: "legacy_context_unavailable",
		};
	const check = validatePlanningContract(contract);
	if (!check.ok)
		return {
			ok: false,
			context: null,
			templates: null,
			manifest_digest,
			context_digest: null,
			reasons: check.reasons,
			code: "planning_context_conflict",
		};
	const templates = new Map();
	for (const template of contract.templates) {
		templates.set(template.template_ref, template);
		if (template.task_type && template.task_type !== template.template_ref) templates.set(template.task_type, template);
	}
	return {
		ok: true,
		contract,
		context: contract,
		templates,
		manifest_digest,
		context_digest: contract.digest,
		reasons: [],
	};
}

/**
 * Normalize a definition (static | plan | proposal) into the ONE ExecutableTask
 * shape. Rules (task §5.1):
 *   * static tasks: each missing budget dimension is explicitly ZERO, never a
 *     fallback to the Campaign total;
 *   * dynamic plan/proposal: all three budget dimensions are REQUIRED and must
 *     be safe non-negative integers;
 *   * when BOTH `task_budget` and `budget_reservation` are present they must be
 *     dimension-wise EQUAL; a missing/conflicting dimension is refused;
 *   * re-normalizing a normalized task keeps the same value (idempotent).
 *
 * @param {{definition: any, origin: "static"|"plan"|"proposal", authority?: any}} args
 */
export function normalizeExecutableTask({ definition, origin, authority = null } = /** @type {any} */ ({})) {
	const reasons = [];
	if (!definition || typeof definition !== "object")
		return { ok: false, task: null, reasons: ["definition must be an object"] };
	if (!["static", "plan", "proposal"].includes(origin))
		return { ok: false, task: null, reasons: [`unknown origin ${String(origin)}`] };
	const dynamic = origin === "plan" || origin === "proposal";

	const budgetAlias = definition.budget_reservation ?? null;
	const taskBudget = definition.task_budget ?? null;
	const resolveDims = (value, label) => {
		const out = {};
		for (const dim of BUDGET_DIMS) {
			const raw = value?.[dim];
			if (raw === undefined || raw === null) out[dim] = undefined;
			else if (!isSafeNonNegativeInteger(raw)) out[dim] = `invalid:${String(raw)}`;
			else out[dim] = raw;
		}
		return out;
	};

	let resolved = { wall_time_ms: 0, model_requests: 0, tool_calls: 0 };
	if (dynamic) {
		if (!budgetAlias && !taskBudget) {
			reasons.push(`invalid_task_budget: a dynamic ${origin} task requires a complete budget`);
		} else {
			const dims = resolveDims(taskBudget ?? budgetAlias, "budget");
			for (const dim of BUDGET_DIMS)
				if (dims[dim] === undefined) reasons.push(`invalid_task_budget: ${origin} budget.${dim} is required`);
				else if (typeof dims[dim] === "string") reasons.push(`invalid_task_budget: budget.${dim} ${dims[dim]}`);
			// When BOTH aliases are present they must match dimension-by-dimension.
			if (budgetAlias && taskBudget) {
				const aliasDims = resolveDims(budgetAlias, "budget_reservation");
				for (const dim of BUDGET_DIMS) {
					if (aliasDims[dim] === undefined || dims[dim] === undefined) continue;
					if (aliasDims[dim] !== dims[dim])
						reasons.push(`invalid_task_budget: task_budget.${dim} (${dims[dim]}) != budget_reservation.${dim} (${aliasDims[dim]})`);
				}
			}
			if (reasons.length === 0)
				resolved = { wall_time_ms: dims.wall_time_ms, model_requests: dims.model_requests, tool_calls: dims.tool_calls };
		}
	} else {
		// static: each provided dimension must be valid; missing -> 0.
		if (taskBudget || budgetAlias) {
			const dims = resolveDims(taskBudget ?? budgetAlias, "budget");
			for (const dim of BUDGET_DIMS)
				if (typeof dims[dim] === "string") reasons.push(`invalid_task_budget: budget.${dim} ${dims[dim]}`);
			if (taskBudget && budgetAlias) {
				const aliasDims = resolveDims(budgetAlias, "budget_reservation");
				for (const dim of BUDGET_DIMS)
					if (aliasDims[dim] !== undefined && dims[dim] !== undefined && aliasDims[dim] !== dims[dim])
						reasons.push(`invalid_task_budget: task_budget.${dim} != budget_reservation.${dim}`);
			}
			if (reasons.length === 0)
				resolved = {
					wall_time_ms: dims.wall_time_ms ?? 0,
					model_requests: dims.model_requests ?? 0,
					tool_calls: dims.tool_calls ?? 0,
				};
		}
	}

	if (reasons.length > 0) return { ok: false, task: null, reasons };
	return { ok: true, task: buildExecutableTask({ definition, origin, resolved, authority }), reasons: [] };
}

/** Compose the canonical ExecutableTask and its digest (covers every field). */
function buildExecutableTask({ definition, origin, resolved, authority }) {
	const definition_version =
		typeof definition.definition_version === "string" ? definition.definition_version : EXECUTABLE_TASK_VERSION;
	const stages = Array.isArray(definition.stages) ? definition.stages : [];
	const expected_evidence = Array.isArray(definition.expected_evidence)
		? definition.expected_evidence
		: [...stages.flatMap((stage) => stage.criteria ?? []).map((criterion) => `artifact:${criterion}`)];
	const task = {
		task_id: definition.task_id,
		campaign_id: definition.campaign_id ?? authority?.campaign_id ?? null,
		origin,
		plan_id: definition.plan_id ?? null,
		planning_task_id: definition.planning_task_id ?? authority?.planning_task_id ?? null,
		parent_task_id: definition.parent_task_id ?? null,
		parent_stage_id: definition.parent_stage_id ?? null,
		depends_on: [...new Set(definition.depends_on ?? [])],
		order: Number.isSafeInteger(definition.order) && definition.order > 0 ? definition.order : 1,
		target_ref: definition.target_ref ?? null,
		task_type: definition.task_type ?? null,
		template_ref: definition.template_ref ?? null,
		goal: definition.goal
			? {
					goal_id: definition.goal.goal_id ?? definition.task_id,
					description: definition.goal.description ?? "",
					success_criteria: [...(definition.goal.success_criteria ?? [])],
				}
			: null,
		stages: stages.map((stage) => ({
			stage_id: stage.stage_id,
			criteria: [...(stage.criteria ?? [])],
			required: stage.required !== false,
		})),
		required_capabilities: [...new Set(definition.required_capabilities ?? [])],
		oracle_ref: definition.oracle_ref ?? null,
		scope: definition.scope ?? null,
		initial_state: definition.initial_state ?? null,
		expected_evidence: [...expected_evidence],
		stop_condition: definition.stop_condition ?? null,
		priority: Number.isInteger(definition.priority) ? definition.priority : 0,
		rationale: definition.rationale ?? null,
		source: definition.source ?? origin,
		task_budget: { ...resolved },
		budget_reservation: { ...resolved },
		definition_version,
	};
	// The digest covers the COMPLETE final definition (every field), excluding
	// only task_digest itself. Re-hashing a self-reported digest cannot substitute
	// for recompiling the definition.
	task.task_digest = digest(task);
	return task;
}

/**
 * A convenient adapter: derive a trusted authority object from a manifest.
 * @param {any} manifest
 */
export function authorityFromManifest(manifest) {
	return {
		campaign_id: manifest?.campaign_id ?? null,
		planning_task_id: manifest?.planning_contract?.planning_task_id ?? null,
		manifest_digest: manifest ? digest(manifest) : null,
		context_digest: manifest?.planning_contract?.digest ?? null,
	};
}
