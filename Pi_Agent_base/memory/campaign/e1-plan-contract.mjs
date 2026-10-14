// Aegis E1 — structured plan contract and whole-graph admission.
//
// The model submits a COMPLETE candidate plan as data. This module is the ONE
// pure place that:
//   * validates the plan transport shape (size, ids, required semantic fields);
//   * validates the whole TASK GRAPH (ids, parentage, dependencies, cycles,
//     authorization, capabilities, oracle/template resolution, budget, depth,
//     fan-out, total count) BEFORE anything becomes durable;
//   * produces the normalized candidate batches and the per-task definitions the
//     Host may later admit.
//
// It owns no scheduling and no truth. It never calls a provider and never writes
// events. `c6-entry.mjs` persists the normalized batch as one durable
// `runtime.note`, and `projection.mjs` reduces the admitted definitions.
//
// Two relations are kept SEPARATE and validated separately:
//   * `parent_task_id` — the split provenance / organisation hierarchy;
//   * `depends_on`     — the EXECUTION prerequisite set (a DAG).
// Being a child of X never implies a dependency on X; both are rendered and
// validated on their own.
//
// Whole-graph semantics: a plan with ANY illegal node is REJECTED as a batch. A
// legal subset is never executed to masquerade as a complete plan.

import { digest } from "../fixture/contracts.mjs";
import { isKnownTaskType } from "./registries.mjs";

export const PLAN_SCHEMA_VERSION = "aegis-plan-1.0";
export const PLAN_STATUSES = Object.freeze(["admitted", "blocked", "rejected"]);

/** Version of the normalized planning input shared by the provider prompt and admission. */
export const PLANNING_INPUT_VERSION = "aegis-planning-input-1.0";

/** Hard transport bounds (never a place to widen authorization). */
export const PLAN_LIMITS = Object.freeze({
	/** Maximum nodes in ONE candidate plan. */
	max_tasks: 24,
	/** Maximum characters of any single explanation/criterion string. */
	max_text: 2000,
	/** Maximum dependency edges declared by one node. */
	max_depends_on: 16,
});

/** Priority is a bounded scheduler hint, never a privilege. */
const PRIORITY_MIN = 0;
const PRIORITY_MAX = 1000;

function check(name, passed, detail = null) {
	return { name, passed: passed === true, detail: detail ?? null };
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value) {
	return Number.isInteger(value) && value >= 0;
}

/**
 * Validate the TRANSPORT shape of a submitted plan. A shape error is a
 * `rejected` batch, never a human decision item.
 *
 * @param {any} plan
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function validatePlanShape(plan) {
	const reasons = [];
	if (!plan || typeof plan !== "object" || Array.isArray(plan))
		return { ok: false, reasons: ["plan must be an object"] };
	if (plan.version !== undefined && plan.version !== PLAN_SCHEMA_VERSION && plan.version !== "1.0")
		reasons.push(`plan.version must be ${PLAN_SCHEMA_VERSION}`);
	if (!isNonEmptyString(plan.plan_id)) reasons.push("plan.plan_id is required");
	if (!isNonEmptyString(plan.root_goal_ref)) reasons.push("plan.root_goal_ref is required");
	if (!Array.isArray(plan.tasks)) return { ok: false, reasons: [...reasons, "plan.tasks must be an array"] };
	if (plan.tasks.length === 0) reasons.push("plan.tasks must contain at least one task");
	if (plan.tasks.length > PLAN_LIMITS.max_tasks) reasons.push(`plan.tasks exceeds max_tasks ${PLAN_LIMITS.max_tasks}`);
	for (const [index, task] of plan.tasks.entries()) {
		const label = `tasks[${index}]`;
		if (!task || typeof task !== "object" || Array.isArray(task)) {
			reasons.push(`${label} must be an object`);
			continue;
		}
		if (!isNonEmptyString(task.proposed_task_id)) reasons.push(`${label}.proposed_task_id is required`);
		else if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(task.proposed_task_id))
			reasons.push(`${label}.proposed_task_id must be a bounded id`);
		if (task.parent_task_id !== undefined && task.parent_task_id !== null && !isNonEmptyString(task.parent_task_id))
			reasons.push(`${label}.parent_task_id must be a non-empty string when present`);
		if (!Array.isArray(task.depends_on)) reasons.push(`${label}.depends_on must be an array when present`);
		else if (task.depends_on.length > PLAN_LIMITS.max_depends_on)
			reasons.push(`${label}.depends_on exceeds max_depends_on ${PLAN_LIMITS.max_depends_on}`);
		if (
			!task.goal ||
			typeof task.goal !== "object" ||
			Array.isArray(task.goal) ||
			!isNonEmptyString(task.goal.description)
		)
			reasons.push(`${label}.goal.description is required`);
		const criteria =
			task.goal && typeof task.goal === "object" && !Array.isArray(task.goal) ? task.goal.success_criteria : undefined;
		if (criteria !== undefined && !Array.isArray(criteria))
			reasons.push(`${label}.goal.success_criteria must be an array`);
		else if (Array.isArray(criteria))
			for (const [criterionIndex, criterion] of criteria.entries())
				if (!isNonEmptyString(criterion))
					reasons.push(`${label}.goal.success_criteria[${criterionIndex}] must be a non-empty string`);
		if (!isNonEmptyString(task.task_type)) reasons.push(`${label}.task_type is required`);
		if (task.template_ref !== undefined && !isNonEmptyString(task.template_ref))
			reasons.push(`${label}.template_ref must be a non-empty string when present`);
		if (!isNonEmptyString(task.target_ref)) reasons.push(`${label}.target_ref is required`);
		for (const key of ["depends_on", "required_capabilities", "expected_evidence"]) {
			const value = task[key];
			if (value === undefined) continue;
			if (!Array.isArray(value)) {
				reasons.push(`${label}.${key} must be an array when present`);
				continue;
			}
			for (const [elementIndex, element] of value.entries())
				if (!isNonEmptyString(element)) reasons.push(`${label}.${key}[${elementIndex}] must be a non-empty string`);
		}
		if (
			typeof task.priority !== "number" ||
			!Number.isInteger(task.priority) ||
			task.priority < PRIORITY_MIN ||
			task.priority > PRIORITY_MAX
		)
			reasons.push(`${label}.priority must be an integer in [${PRIORITY_MIN}, ${PRIORITY_MAX}]`);
		const reservation = task.budget_reservation;
		if (!reservation || typeof reservation !== "object") reasons.push(`${label}.budget_reservation is required`);
		else
			for (const key of ["wall_time_ms", "model_requests", "tool_calls"]) {
				if (!isNonNegativeInteger(reservation[key]))
					reasons.push(`${label}.budget_reservation.${key} must be a non-negative integer`);
			}
		for (const text of [
			task.goal?.description,
			task.stop_condition,
			task.rationale,
			...(Array.isArray(criteria) ? criteria : []),
		]) {
			if (typeof text === "string" && text.length > PLAN_LIMITS.max_text)
				reasons.push(`${label} contains text longer than max_text ${PLAN_LIMITS.max_text}`);
		}
	}
	return { ok: reasons.length === 0, reasons };
}

/**
 * Validate the whole TASK GRAPH. Pure and order-independent: the graph is built
 * from ids, so the MODEL's input array order never matters.
 *
 * @param {{
 *   plan: any,
 *   manifest: any,
 *   planningTaskId: string,
 *   existingTaskIds?: Set<string>,
 *   templates?: Map<string, any>|null,
 *   requiredCriteria?: string[],
 *   derivedBudget?: {wall_time_ms: number, model_requests: number, tool_calls: number},
 * }} args
 * @returns {{status: "admitted"|"blocked"|"rejected", checks: object[], reasons: string[],
 *   normalized: object[]|null, reserved_budget: object|null}}
 */
export function validatePlanGraph({
	plan,
	manifest,
	planningTaskId,
	existingTaskIds = new Set(),
	templates = null,
	requiredCriteria = [],
	derivedBudget = { wall_time_ms: 0, model_requests: 0, tool_calls: 0 },
}) {
	const checks = [];
	const rejectReasons = [];
	const blockReasons = [];

	if (!manifest || typeof manifest !== "object" || typeof manifest.schema_version !== "string") {
		return {
			status: "rejected",
			checks,
			reasons: ["a validated campaign-1.x manifest is required"],
			normalized: null,
			reserved_budget: null,
		};
	}

	// 1. Transport shape.
	const shape = validatePlanShape(plan);
	checks.push(check("shape_valid", shape.ok, shape.ok ? null : shape.reasons.join("; ")));
	if (!shape.ok) rejectReasons.push(...shape.reasons);
	if (rejectReasons.length > 0) {
		return { status: "rejected", checks, reasons: rejectReasons, normalized: null, reserved_budget: null };
	}

	const nodes = plan.tasks;
	const policy = manifest.dynamic_task_policy ?? {};
	const allowedTypes = Array.isArray(policy.allowed_task_types) ? policy.allowed_task_types : [];
	const allowedTargets = new Set(manifest.authorization?.allowed_targets ?? []);
	const allowedCapabilities = new Set(manifest.authorization?.allowed_capabilities ?? []);

	// 2. Identity: unique ids in the batch, disjoint from known task ids, and the
	//    planning task itself may not be redefined.
	const ids = new Set();
	const idSetNodes = new Map();
	for (const node of nodes) {
		if (ids.has(node.proposed_task_id)) rejectReasons.push(`duplicate proposed_task_id ${node.proposed_task_id}`);
		ids.add(node.proposed_task_id);
		idSetNodes.set(node.proposed_task_id, node);
	}
	for (const node of nodes) {
		if (node.proposed_task_id === planningTaskId)
			rejectReasons.push(`plan may not redefine the planning task ${planningTaskId}`);
		if (existingTaskIds.has(node.proposed_task_id))
			rejectReasons.push(`proposed_task_id ${node.proposed_task_id} already exists`);
	}
	checks.push(check("unique_ids", rejectReasons.length === 0, `${nodes.length} nodes`));

	// 3. Parentage: parent must be the planning task, another node in the batch,
	//    or a known existing task. No parent cycles; parentage is SEPARATE from
	//    dependency.
	const parentEdges = new Map();
	for (const node of nodes) {
		const parent = node.parent_task_id ?? null;
		parentEdges.set(node.proposed_task_id, parent);
		if (parent === null) continue;
		if (parent === node.proposed_task_id) rejectReasons.push(`task ${node.proposed_task_id} is its own parent`);
		else if (parent !== planningTaskId && !ids.has(parent) && !existingTaskIds.has(parent))
			rejectReasons.push(`parent_task_id ${parent} of ${node.proposed_task_id} is unknown (dangling parent)`);
	}
	// Parent cycle detection (only over in-batch parent edges).
	const parentCycle = findCycle(parentEdges);
	if (parentCycle) rejectReasons.push(`parentage cycle: ${parentCycle.join(" -> ")}`);
	checks.push(check("parent_acyclic", parentCycle === null, parentCycle ? parentCycle.join(" -> ") : null));

	// 4. Dependencies: no self, no dangling, no foreign reference, DAG (no cycle).
	//    Order-independent because we resolve against the id set, not array order.
	const depEdges = new Map();
	for (const node of nodes) {
		const deps = [...new Set(node.depends_on)];
		depEdges.set(node.proposed_task_id, deps);
		for (const dep of deps) {
			if (dep === node.proposed_task_id) rejectReasons.push(`task ${node.proposed_task_id} depends on itself`);
			else if (!ids.has(dep) && !existingTaskIds.has(dep))
				rejectReasons.push(`depends_on ${dep} of ${node.proposed_task_id} is unknown (dangling dependency)`);
		}
	}
	const depCycle = findCycle(depEdges);
	if (depCycle) rejectReasons.push(`dependency cycle: ${depCycle.join(" -> ")}`);
	checks.push(check("dependency_acyclic", depCycle === null, depCycle ? depCycle.join(" -> ") : null));

	// 5. Authorization + semantics per node + budget aggregate. Computed even when
	//    earlier structure failed so the diagnostics are complete.
	let aggregate = { wall_time_ms: 0, model_requests: 0, tool_calls: 0 };
	let maxDepth = 0;
	for (const node of nodes) {
		const label = node.proposed_task_id;
		if (!isKnownTaskType(node.task_type)) blockReasons.push(`${label}: task_type ${node.task_type} is not registered`);
		if (!allowedTypes.includes(node.task_type))
			blockReasons.push(`${label}: task_type ${node.task_type} is not allowed by dynamic_task_policy`);
		if (!allowedTargets.has(node.target_ref))
			blockReasons.push(`${label}: target ${node.target_ref} is not authorized`);
		for (const cap of node.required_capabilities ?? [])
			if (!allowedCapabilities.has(cap)) blockReasons.push(`${label}: capability ${cap} is not authorized`);

		// A business task resolves its oracle/criteria from the TRUSTED template, not
		// by inheriting the planning task's own readiness criterion. The model may
		// only select a non-empty SUBSET of the template's offered criteria; it can
		// never invent a new acceptance definition or a foreign oracle/identity.
		const templateKey = node.template_ref ?? node.task_type;
		const template = templates ? templates.get(templateKey) : null;
		if (templates) {
			if (!template) blockReasons.push(`${label}: no trusted template for ${templateKey}`);
			else {
				const templateLabel = template.template_ref ?? templateKey;
				if (node.template_ref && template.template_ref && node.template_ref !== template.template_ref)
					blockReasons.push(
						`${label}: template_ref ${node.template_ref} does not match the resolved template ${template.template_ref}`,
					);
				if (template.task_type && node.task_type !== template.task_type)
					blockReasons.push(
						`${label}: task_type ${node.task_type} does not match template ${templateLabel} (${template.task_type})`,
					);
				const offered = new Set(template.success_criteria ?? []);
				const criteria = Array.isArray(node.goal?.success_criteria) ? node.goal.success_criteria : [];
				if (offered.size === 0)
					blockReasons.push(`${label}: trusted template ${templateLabel} offers no success criteria`);
				if (criteria.length === 0)
					blockReasons.push(`${label}: select at least one success criterion offered by template ${templateLabel}`);
				for (const criterion of criteria)
					if (!offered.has(criterion))
						blockReasons.push(`${label}: criterion "${criterion}" is not offered by template ${templateLabel}`);
				const templateCaps = new Set(template.required_capabilities ?? []);
				for (const cap of node.required_capabilities ?? [])
					if (!templateCaps.has(cap)) blockReasons.push(`${label}: capability ${cap} is not offered by template`);
			}
		}
		const depth = parentDepthOf(node.proposed_task_id, parentEdges, planningTaskId);
		maxDepth = Math.max(maxDepth, depth);
		if (Number.isInteger(policy.max_depth) && depth > policy.max_depth)
			rejectReasons.push(`${label}: parent depth ${depth} exceeds max_depth ${policy.max_depth}`);

		const reservation = node.budget_reservation;
		aggregate = {
			wall_time_ms: aggregate.wall_time_ms + reservation.wall_time_ms,
			model_requests: aggregate.model_requests + reservation.model_requests,
			tool_calls: aggregate.tool_calls + reservation.tool_calls,
		};
	}

	// 6. Fan-out / total count / aggregate budget.
	if (Number.isInteger(policy.max_fan_out) && policy.max_fan_out > 0) {
		const childCount = new Map();
		for (const node of nodes) {
			const parent = node.parent_task_id ?? null;
			if (parent === null) continue;
			childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
		}
		for (const [parent, count] of childCount)
			if (count > policy.max_fan_out)
				rejectReasons.push(`fan-out for ${parent} is ${count} > max_fan_out ${policy.max_fan_out}`);
	}
	if (Number.isInteger(policy.max_task_count) && policy.max_task_count > 0) {
		const prospective = new Set([...existingTaskIds, ...ids]).size;
		if (prospective > policy.max_task_count)
			rejectReasons.push(`total task count ${prospective} exceeds max_task_count ${policy.max_task_count}`);
	}
	const campaignBudget = manifest.budget ?? {};
	const totalRemaining = {
		wall_time_ms: (campaignBudget.wall_time_ms ?? 0) - (derivedBudget.wall_time_ms ?? 0),
		model_requests: (campaignBudget.model_requests ?? 0) - (derivedBudget.model_requests ?? 0),
		tool_calls: (campaignBudget.tool_calls ?? 0) - (derivedBudget.tool_calls ?? 0),
	};
	const fits = ["wall_time_ms", "model_requests", "tool_calls"].every((key) => aggregate[key] <= totalRemaining[key]);
	checks.push(
		check(
			"aggregate_budget_fits",
			fits,
			`need ${JSON.stringify(aggregate)} remaining ${JSON.stringify(totalRemaining)}`,
		),
	);
	if (!fits)
		blockReasons.push(
			`plan budget aggregate ${JSON.stringify(aggregate)} exceeds remaining Campaign budget ${JSON.stringify(totalRemaining)}`,
		);

	// 7. Root-goal coverage: the plan must keep a task that can satisfy EVERY
	//    frozen required criterion. Removing a hard criterion (or rephrasing all
	//    tasks as "read a file") cannot earn plan_ready.
	const covered = new Set();
	for (const node of nodes) for (const criterion of node.goal?.success_criteria ?? []) covered.add(criterion);
	const missingCriteria = (requiredCriteria ?? []).filter((criterion) => !covered.has(criterion));
	checks.push(check("root_criteria_covered", missingCriteria.length === 0, missingCriteria.join(", ")));
	if (missingCriteria.length > 0)
		blockReasons.push(`plan does not cover required root criteria: ${missingCriteria.join(", ")}`);

	checks.push(check("max_depth", maxDepth <= (policy.max_depth ?? 0), `depth ${maxDepth}`));

	if (rejectReasons.length > 0) {
		return { status: "rejected", checks, reasons: rejectReasons, normalized: null, reserved_budget: null };
	}
	if (blockReasons.length > 0) {
		return { status: "blocked", checks, reasons: blockReasons, normalized: null, reserved_budget: null };
	}

	// 8. Normalize to a deterministic definition set. Sort by (parent depth, id) so
	//    the digest is stable regardless of the model's input order.
	const normalized = nodes
		.map((node) => normalizePlanNode({ node, plan, manifest, templates, planningTaskId }))
		.sort((a, b) => a.order - b.order || a.task_id.localeCompare(b.task_id));
	return {
		status: "admitted",
		checks,
		reasons: [],
		normalized,
		reserved_budget: aggregate,
	};
}

/** Derive a node's parent depth from the in-batch parent edges + planning task. */
function parentDepthOf(taskId, parentEdges, planningTaskId) {
	let depth = 0;
	let current = taskId;
	const seen = new Set();
	while (current && current !== planningTaskId) {
		if (seen.has(current)) return depth; // cycle: bounded, already reported
		seen.add(current);
		const parent = parentEdges.get(current) ?? null;
		if (parent === null) break;
		depth += 1;
		current = parent;
	}
	return depth + (current === planningTaskId ? 1 : 0);
}

/** Find a directed cycle in an adjacency map (id -> id[]|id|null). Returns ids or null. */
function findCycle(edges) {
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map();
	const stack = [];
	let cycle = null;
	const normalize = (value) => {
		if (value === null || value === undefined) return [];
		return Array.isArray(value) ? value : [value];
	};
	const visit = (id) => {
		if (cycle) return;
		color.set(id, GRAY);
		stack.push(id);
		for (const next of normalize(edges.get(id))) {
			if (!edges.has(next) && !color.has(next)) continue; // dangling: reported elsewhere
			const state = color.get(next) ?? WHITE;
			if (state === GRAY) {
				cycle = [...stack.slice(stack.indexOf(next)), next];
				return;
			}
			if (state === WHITE) visit(next);
		}
		stack.pop();
		color.set(id, BLACK);
	};
	for (const id of edges.keys()) if ((color.get(id) ?? WHITE) === WHITE) visit(id);
	return cycle;
}

/** Build a normalized plan-task definition (the durable record this round admits). */
function normalizePlanNode({ node, plan, manifest, templates, planningTaskId }) {
	const template = templates ? templates.get(node.template_ref ?? node.task_type) : null;
	const criteria = (node.goal?.success_criteria ?? []).slice();
	const oracleRef = template?.oracle_ref ?? node.oracle_ref ?? null;
	const definition = {
		task_id: node.proposed_task_id,
		campaign_id: manifest.campaign_id,
		plan_id: plan.plan_id,
		planning_task_id: planningTaskId,
		parent_task_id: node.parent_task_id ?? planningTaskId,
		depends_on: [...new Set(node.depends_on ?? [])].sort(),
		target_ref: node.target_ref,
		task_type: node.task_type,
		template_ref: node.template_ref ?? node.task_type,
		required_capabilities: [...(node.required_capabilities ?? [])],
		goal: {
			goal_id: node.goal?.goal_id ?? node.proposed_task_id,
			description: node.goal?.description ?? "",
			success_criteria: criteria,
		},
		// One stage per criterion: the independent Oracle emits one stage judgment per
		// declared criterion, so a stage must not bundle several criteria (which would
		// leave the extra ones unverified).
		stages: criteria.map((criterion, index) => ({
			stage_id: criteria.length > 1 ? `stage-${node.proposed_task_id}-${index}` : `stage-${node.proposed_task_id}`,
			criteria: [criterion],
			required: true,
		})),
		oracle_ref: oracleRef,
		// The trusted CURRENT scope comes from the template (never invented by the
		// model). Absent template scope -> null (fail-closed at judgment time).
		scope: template?.scope ?? manifest.scope ?? null,
		expected_evidence: [...(node.expected_evidence ?? [`artifact:${node.proposed_task_id}`])],
		stop_condition: node.stop_condition ?? "task oracle judged",
		priority: node.priority ?? 0,
		budget_reservation: { ...node.budget_reservation },
		rationale: node.rationale ?? null,
		source: "model_plan",
	};
	definition.task_digest = digest(definition);
	return { ...definition, order: (manifest.tasks?.length ?? 0) + 1 };
}

/** A digest over the COMPLETE candidate batch, used for durable identity. */
export function planDigest(plan) {
	return digest({ plan_id: plan?.plan_id ?? null, tasks: plan?.tasks ?? null });
}

/**
 * Build the ONE normalized planning contract. Both the provider prompt/tool
 * schema and the Host admission consume this object (or the same manifest +
 * template map it is derived from), so the model can only ever choose what the
 * Host will independently re-check. It is pure and never widens authorization.
 *
 * @param {{manifest?: any, templates?: Map<string, any>|null, planningTaskId?: string, planningCriterion?: string}} [args]
 */
export function buildPlanningContext({
	manifest = null,
	templates = null,
	planningTaskId = "task-plan",
	planningCriterion = "plan_ready",
} = {}) {
	const policy = manifest?.dynamic_task_policy ?? {};
	const seenTemplates = new Set();
	const templateList = [];
	if (templates && typeof templates.values === "function") {
		for (const template of templates.values()) {
			if (!template || typeof template !== "object" || seenTemplates.has(template)) continue;
			seenTemplates.add(template);
			templateList.push({
				template_ref: template.template_ref ?? null,
				task_type: template.task_type ?? template.template_ref ?? null,
				oracle_ref: template.oracle_ref ?? null,
				required_capabilities: [...(template.required_capabilities ?? [])],
				success_criteria: [...(template.success_criteria ?? [])],
				scope: template.scope
					? {
							domain: template.scope.domain ?? null,
							task_types: [...(template.scope.task_types ?? [])],
							permissions: [...(template.scope.permissions ?? [])],
						}
					: null,
			});
		}
	}
	const planningTask = (manifest?.tasks ?? []).find((task) => task.task_id === planningTaskId) ?? null;
	const requiredCriteria = [...(manifest?.objective?.required_criteria ?? manifest?.objective?.success_criteria ?? [])];
	return {
		version: PLANNING_INPUT_VERSION,
		campaign_id: manifest?.campaign_id ?? null,
		planning_task_id: planningTaskId,
		planning_criterion: planningCriterion,
		root_goal_ref: "campaign-root",
		root_goal: {
			description: manifest?.objective?.description ?? manifest?.title ?? "",
			required_criteria: requiredCriteria,
			objective_success_criteria: [...(manifest?.objective?.success_criteria ?? [])],
		},
		allowed_targets: [...(manifest?.authorization?.allowed_targets ?? [])],
		allowed_capabilities: [...(manifest?.authorization?.allowed_capabilities ?? [])],
		existing_tasks: (manifest?.tasks ?? []).map((task) => ({
			task_id: task.task_id,
			task_type: task.task_type ?? null,
			target_ref: task.target_ref ?? null,
			depends_on: [...(task.depends_on ?? [])],
		})),
		templates: templateList,
		budget: {
			campaign: { ...(manifest?.budget ?? {}) },
			planning_task: planningTask?.task_budget ? { ...planningTask.task_budget } : null,
		},
		limits: {
			max_tasks: PLAN_LIMITS.max_tasks,
			max_depends_on: PLAN_LIMITS.max_depends_on,
			max_text: PLAN_LIMITS.max_text,
			max_depth: Number.isInteger(policy.max_depth) ? policy.max_depth : null,
			max_fan_out: Number.isInteger(policy.max_fan_out) ? policy.max_fan_out : null,
			max_task_count: Number.isInteger(policy.max_task_count) ? policy.max_task_count : null,
		},
	};
}

/** Render the normalized planning contract as the actual provider prompt. */
export function buildPlanningPrompt(context) {
	const c = context ?? {};
	const root = c.root_goal ?? {};
	const limits = c.limits ?? {};
	const lines = [
		`TASK ${c.planning_task_id ?? "task-plan"} \u2014 CAMPAIGN PLANNING`,
		`ROOT GOAL (${c.root_goal_ref ?? "campaign-root"}): ${root.description ?? ""}`,
		"REQUIRED ROOT CRITERIA (the plan must cover ALL of them):",
	];
	for (const criterion of root.required_criteria ?? []) lines.push(`  - ${criterion}`);
	lines.push(`READABLE TARGETS: ${(c.allowed_targets ?? []).join(", ") || "(none)"}`);
	lines.push(`ALLOWED CAPABILITIES: ${(c.allowed_capabilities ?? []).join(", ") || "(none)"}`);
	lines.push("EXISTING TASKS:");
	for (const task of c.existing_tasks ?? [])
		lines.push(`  - ${task.task_id} (task_type=${task.task_type ?? "?"}, target=${task.target_ref ?? "?"})`);
	lines.push("TRUSTED TEMPLATES (use one per task; select only its offered success_criteria):");
	for (const template of c.templates ?? []) {
		lines.push(
			`  - template_ref=${template.template_ref} task_type=${template.task_type} oracle=${template.oracle_ref} capabilities=[${(template.required_capabilities ?? []).join(", ")}]`,
		);
		lines.push(
			`      offered success_criteria: ${
				(template.success_criteria ?? []).map((criterion) => JSON.stringify(criterion)).join(", ") ||
				"(none \u2014 not usable)"
			}`,
		);
	}
	lines.push(
		`BUDGET: campaign=${JSON.stringify(c.budget?.campaign ?? {})}; planning_task=${JSON.stringify(c.budget?.planning_task ?? {})}`,
	);
	lines.push(
		`GRAPH LIMITS: max_depth=${limits.max_depth ?? "unspecified"}, max_fan_out=${limits.max_fan_out ?? "unspecified"}, max_task_count=${limits.max_task_count ?? "unspecified"}, max_tasks=${limits.max_tasks ?? "?"}, max_depends_on=${limits.max_depends_on ?? "?"}, max_text=${limits.max_text ?? "?"}`,
	);
	lines.push(
		"TRANSPORT: submit plan_id, root_goal_ref and tasks[]. Each task needs proposed_task_id, parent_task_id, depends_on[], goal.description, goal.success_criteria[], task_type, target_ref, required_capabilities[], expected_evidence[], stop_condition, priority (integer 0..1000) and budget_reservation{wall_time_ms, model_requests, tool_calls}.",
	);
	lines.push(
		"parent_task_id is the SPLIT SOURCE; depends_on is the EXECUTION prerequisite DAG. Being a child of X does NOT imply a dependency on X.",
	);
	lines.push(
		"Choose the task count, parentage and dependencies yourself. Do not invent success_criteria or oracles: each node's goal.success_criteria must be a non-empty subset of the chosen template's offered criteria, and the union of all nodes must cover every required root criterion. Inspect authorized targets with aegis_read if needed.",
	);
	lines.push(
		"Call aegis_submit_plan ONCE with the complete candidate plan. It records a candidate only; the Host validates and admits the whole graph. It does not execute anything and does not mean the goal is complete.",
	);
	lines.push(`PLANNING CONTRACT (authoritative JSON): ${JSON.stringify(c)}`);
	return lines.join("\n");
}

/** A bounded, redacted view of a plan for the observation page/API. */
export function summarizePlan(plan, status, reasons = []) {
	return {
		plan_id: plan?.plan_id ?? null,
		root_goal_ref: plan?.root_goal_ref ?? null,
		status: status ?? "submitted",
		reasons: [...reasons],
		task_count: Array.isArray(plan?.tasks) ? plan.tasks.length : 0,
		tasks: (plan?.tasks ?? []).map((task) => ({
			proposed_task_id: task?.proposed_task_id ?? null,
			parent_task_id: task?.parent_task_id ?? null,
			depends_on: [...(task?.depends_on ?? [])],
			task_type: task?.task_type ?? null,
			target_ref: task?.target_ref ?? null,
		})),
	};
}
