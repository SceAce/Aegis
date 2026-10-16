// Bounded dynamic task policy (C0 contract).
//
// Dynamic task expansion is a core Campaign capability, but it is tightly
// bounded (docs/CAMPAIGN_ARCHITECTURE.md §3.2; user decisions D2/D6). A model may
// PROPOSE a task; Aegis admits it ONLY when every check passes against the
// IMMUTABLE Manifest authorization. A proposal can never widen authorization,
// add a target/adapter, enable network, create credentials, or increase budget.
//
// This module is pure: it reads a proposal, a validated Manifest, and queue
// state, and returns one of:
//
//   admitted  — every check passed; may be scheduled inside remaining budget
//   blocked   — needs a human decision (new capability/target/adapter/network/
//               credentials/budget); surfaced on the whiteboard, never executed
//   rejected  — structurally invalid, duplicate, or a cycle; not a human item
//
// Distinguishing `blocked` from `rejected` matters: `blocked` means "a human
// could authorize this", `rejected` means "this proposal is not well-formed".

import { assertIdType } from "./identifiers.mjs";
import { isSupportedCampaignVersion } from "./manifest.mjs";
import { isKnownTaskType } from "./registries.mjs";

export const ADMISSION_STATUSES = Object.freeze(["admitted", "blocked", "rejected"]);

/** Fields a proposal MUST NOT be able to set to gain privilege. */
const PRIVILEGE_FIELDS = Object.freeze([
	"authorization",
	"new_capability",
	"new_target",
	"new_adapter",
	"network",
	"credentials",
	"budget_increase",
	"oracle_ref",
	"execution_adapter",
]);

function check(name, passed, detail) {
	return { name, passed: passed === true, detail: detail ?? null };
}

/**
 * Structural validation of a proposal, independent of authorization. A
 * structurally invalid proposal is `rejected` (not a human decision item).
 */
export function validateTaskProposal(proposal) {
	const reasons = [];
	if (!proposal || typeof proposal !== "object" || Array.isArray(proposal))
		return { ok: false, reasons: ["proposal must be an object"] };

	reasons.push(...assertIdType(proposal.parent_task_id, "task", "parent_task_id").reasons);
	// parent_stage_id is optional but, when present, must be a stage id.
	if (proposal.parent_stage_id !== undefined && proposal.parent_stage_id !== null)
		reasons.push(...assertIdType(proposal.parent_stage_id, "stage", "parent_stage_id").reasons);
	reasons.push(...assertIdType(proposal.proposed_task_id, "task", "proposed_task_id").reasons);

	if (typeof proposal.goal !== "object" || proposal.goal === null) reasons.push("goal is required");
	else {
		if (typeof proposal.goal.description !== "string" || !proposal.goal.description.trim())
			reasons.push("goal.description is required");
		if (!Array.isArray(proposal.goal.success_criteria) || proposal.goal.success_criteria.length === 0)
			reasons.push("goal.success_criteria requires at least one criterion");
	}
	if (typeof proposal.target_ref !== "string" || !proposal.target_ref.trim()) reasons.push("target_ref is required");
	if (!isKnownTaskType(proposal.task_type))
		reasons.push(`task_type "${String(proposal.task_type)}" is not a registered task type`);
	if (!Array.isArray(proposal.required_capabilities) || proposal.required_capabilities.length === 0)
		reasons.push("required_capabilities must be a non-empty list");
	if (!Array.isArray(proposal.expected_evidence) || proposal.expected_evidence.length === 0)
		reasons.push("expected_evidence must be a non-empty list");
	if (typeof proposal.stop_condition !== "string" || !proposal.stop_condition.trim())
		reasons.push("stop_condition is required");
	if (!Number.isInteger(proposal.priority)) reasons.push("priority must be an integer");
	const reservation = proposal.budget_reservation;
	if (!reservation || typeof reservation !== "object") reasons.push("budget_reservation is required");
	else {
		for (const key of ["wall_time_ms", "model_requests", "tool_calls"]) {
			if (!Number.isInteger(reservation[key]) || reservation[key] < 0)
				reasons.push(`budget_reservation.${key} must be a non-negative integer`);
		}
	}
	return { ok: reasons.length === 0, reasons };
}

/**
 * Admit or refuse a dynamic task proposal.
 *
 * queueState SEMANTICS (fixed): `queueState.tasks` is the FULL set of currently
 * known Campaign tasks — the static Manifest tasks AND every already-admitted
 * dynamic task — in any state (queued/running/completed/failed/unknown/
 * cancelled). It is NOT only the dynamic tasks. Therefore the current task count
 * is `queueState.tasks.length`; we must NOT add `manifest.tasks.length` again.
 *
 * Backward compatibility: a legacy `{dynamic_tasks}` field is accepted ONLY when
 * explicitly present, and is then UNIONED with the static tasks and flagged in
 * the returned checks. It is never silently merged.
 *
 * @param {{[key: string]: any}} args
 * @returns {{status: "admitted"|"blocked"|"rejected", checks: object[], reasons: string[], reserved_budget: object|null}}
 */
export function admitTaskProposal({ proposal, manifest, queueState = {}, depth = 1 } = {}) {
	const checks = [];
	const blockReasons = [];
	const rejectReasons = [];

	if (!manifest || !isSupportedCampaignVersion(manifest.schema_version)) {
		return {
			status: "rejected",
			checks,
			reasons: ["a validated campaign-1.x manifest is required"],
			reserved_budget: null,
		};
	}

	// 1. Structural validity first. A malformed proposal is never a human item.
	const structural = validateTaskProposal(proposal);
	checks.push(check("structural_validity", structural.ok, structural.ok ? null : structural.reasons.join("; ")));
	if (!structural.ok) rejectReasons.push(...structural.reasons);

	// 2. Forbidden privilege fields: a model value must never grant privilege.
	if (proposal && typeof proposal === "object") {
		const attempted = PRIVILEGE_FIELDS.filter(
			(field) =>
				proposal[field] !== undefined &&
				proposal[field] !== null &&
				proposal[field] !== false &&
				proposal[field] !== "",
		);
		checks.push(check("no_privilege_fields", attempted.length === 0, attempted.join(", ")));
		if (attempted.length > 0)
			blockReasons.push(`proposal attempted to set privilege field(s): ${attempted.join(", ")}`);
	} else {
		checks.push(check("no_privilege_fields", false, "proposal is not an object"));
	}

	// If we cannot even read structural fields, we cannot continue meaningfully.
	if (rejectReasons.length > 0) {
		return { status: "rejected", checks, reasons: rejectReasons, reserved_budget: null };
	}

	const policy = manifest.dynamic_task_policy ?? { enabled: false };

	// 3. Policy must be enabled.
	checks.push(
		check(
			"dynamic_policy_enabled",
			policy.enabled === true,
			policy.enabled === true ? null : "dynamic_task_policy.enabled is false",
		),
	);
	if (policy.enabled !== true)
		return {
			status: "blocked",
			checks,
			reasons: ["dynamic task expansion is not enabled in this Campaign"],
			reserved_budget: null,
		};

	// 4. Parent linkage: parent task must exist in the Campaign. `queueState.tasks`
	//    is the FULL task set (static + admitted dynamic), so the static task list
	//    is a subset; union is safe and never double-counts an id because we key by
	//    task_id.
	const taskIds = new Set((manifest.tasks ?? []).map((task) => task.task_id));
	const staticTasks = new Map((manifest.tasks ?? []).map((task) => [task.task_id, task]));
	const queueTasks = Array.isArray(queueState.tasks) ? queueState.tasks : [];
	const legacyDynamic = Array.isArray(queueState.dynamic_tasks) ? queueState.dynamic_tasks : null;
	const queueById = new Map(queueTasks.map((task) => [task.task_id, task]));
	if (legacyDynamic)
		for (const task of legacyDynamic) if (!queueById.has(task.task_id)) queueById.set(task.task_id, task);
	if (legacyDynamic)
		checks.push(
			check(
				"legacy_dynamic_tasks_field",
				true,
				"queueState.dynamic_tasks unioned; caller should migrate to queueState.tasks",
			),
		);
	const parentExists = taskIds.has(proposal.parent_task_id) || queueById.has(proposal.parent_task_id);
	checks.push(check("parent_exists", parentExists, proposal.parent_task_id));
	if (!parentExists) rejectReasons.push(`parent_task_id ${proposal.parent_task_id} is not a known task`);

	// 4b. Parent STAGE ownership (CLOSE-11): when a parent_stage_id is supplied,
	//     that stage MUST belong to the parent task. A stage id is globally unique
	//     (Manifest CLOSE-06), so a foreign stage is a structural error, not a
	//     human decision item.
	if (parentExists && proposal.parent_stage_id !== undefined && proposal.parent_stage_id !== null) {
		const parentStatic = staticTasks.get(proposal.parent_task_id);
		if (parentStatic) {
			const ownsStage = (parentStatic.stages ?? []).some((stage) => stage.stage_id === proposal.parent_stage_id);
			checks.push(check("parent_stage_owned_by_parent_task", ownsStage, proposal.parent_stage_id));
			if (!ownsStage)
				rejectReasons.push(
					`parent_stage_id ${proposal.parent_stage_id} does not belong to parent task ${proposal.parent_task_id}`,
				);
		} else {
			// Dynamic parent: its stage ownership is not in the static Manifest; the
			// projection (C1) must supply it. Without that proof we fail closed.
			const parentRow = queueById.get(proposal.parent_task_id);
			const stageIds = Array.isArray(parentRow?.stage_ids) ? parentRow.stage_ids : null;
			const ownsStage = stageIds === null ? false : stageIds.includes(proposal.parent_stage_id);
			checks.push(check("parent_stage_owned_by_parent_task", ownsStage, proposal.parent_stage_id));
			if (!ownsStage)
				rejectReasons.push(
					`parent_stage_id ${proposal.parent_stage_id} cannot be confirmed to belong to dynamic parent ${proposal.parent_task_id}`,
				);
		}
	}

	// 5. Task type allowed by the Manifest policy.
	const allowedTypes = Array.isArray(policy.allowed_task_types) ? policy.allowed_task_types : [];
	const typeAllowed = allowedTypes.includes(proposal.task_type);
	checks.push(check("task_type_allowed", typeAllowed, `${proposal.task_type} in [${allowedTypes.join(", ")}]`));
	if (!typeAllowed) blockReasons.push(`task_type ${proposal.task_type} is not allowed by dynamic_task_policy`);

	// 6. Target must already be authorized. A new target is BLOCKED (human item).
	const allowedTargets = manifest.authorization?.allowed_targets ?? [];
	const targetAllowed = allowedTargets.includes(proposal.target_ref);
	checks.push(check("target_authorized", targetAllowed, proposal.target_ref));
	if (!targetAllowed) blockReasons.push(`target ${proposal.target_ref} is not in the Campaign authorization`);

	// 7. Capabilities must already be authorized. A new capability is BLOCKED.
	const allowedCapabilities = new Set(manifest.authorization?.allowed_capabilities ?? []);
	const missing = (proposal.required_capabilities ?? []).filter((cap) => !allowedCapabilities.has(cap));
	checks.push(check("capabilities_authorized", missing.length === 0, missing.join(", ")));
	if (missing.length > 0) blockReasons.push(`required capabilities are not authorized: ${missing.join(", ")}`);

	// 8. Oracle may not be changed by the proposal (already covered by privilege
	//    fields, but make the check explicit and visible).
	const oracleUnchanged = proposal.oracle_ref === undefined || proposal.oracle_ref === null;
	checks.push(check("oracle_unchanged", oracleUnchanged, proposal.oracle_ref ?? null));
	if (!oracleUnchanged) blockReasons.push("a dynamic task may not change the Oracle adapter");

	// 9. Depth / fan-out / total-count limits.
	const maxDepth = policy.max_depth ?? 0;
	const maxFanOut = policy.max_fan_out ?? 0;
	const maxTaskCount = policy.max_task_count ?? 0;

	// 9a. Depth must be derived from the TRUSTED parent chain, not from the
	//     caller/model's self-reported value (CLOSE-11). The static manifest gives
	//     root tasks depth 1; an admitted dynamic task's depth is its parent's
	//     depth + 1, read from the queue projection. When the parent chain cannot
	//     be resolved, we fail closed (blocked) rather than trust the claim.
	const chainDepth = resolveChainDepth({
		parentTaskId: proposal.parent_task_id,
		staticTasks,
		queueById,
	});
	const withinDepth = chainDepth !== null && Number.isInteger(depth) && depth === chainDepth && depth <= maxDepth;
	checks.push(
		check(
			"within_depth",
			withinDepth,
			chainDepth === null
				? `parent chain depth for ${proposal.parent_task_id} could not be resolved`
				: `claimed depth ${depth} vs trusted chain depth ${chainDepth}; max ${maxDepth}`,
		),
	);
	if (chainDepth === null)
		rejectReasons.push(`depth could not be derived from the trusted parent chain for ${proposal.parent_task_id}`);
	else if (!Number.isInteger(depth) || depth !== chainDepth)
		rejectReasons.push(`claimed depth ${depth} does not match trusted parent-chain depth ${chainDepth}`);
	// Hard, non-widenable limits are STRUCTURAL: exceeding max_depth/max_fan_out/
	// max_task_count is `rejected`, not a human decision item (contract §3.3).
	else if (depth > maxDepth)
		rejectReasons.push(`proposal depth ${depth} exceeds dynamic_task_policy.max_depth ${maxDepth}`);

	const siblings = queueTasks.filter((task) => task.parent_task_id === proposal.parent_task_id).length;
	const withinFanOut = siblings < maxFanOut;
	checks.push(check("within_fan_out", withinFanOut, `siblings ${siblings} < ${maxFanOut}`));
	if (!withinFanOut)
		rejectReasons.push(`fan-out for parent ${proposal.parent_task_id} already at max_fan_out ${maxFanOut}`);

	// `queueState.tasks` is the FULL known task set (static + admitted dynamic), so
	// the current count is simply its size. Do NOT add manifest.tasks.length: that
	// would double-count the static tasks that are already represented.
	const allKnownIds = new Set([...taskIds, ...queueById.keys()]);
	const currentCount = allKnownIds.size;
	const withinCount = currentCount < maxTaskCount;
	checks.push(check("within_task_count", withinCount, `${currentCount} < ${maxTaskCount}`));
	if (!withinCount)
		rejectReasons.push(
			`total task count ${currentCount} has reached dynamic_task_policy.max_task_count ${maxTaskCount}`,
		);

	// 10. Duplicate detection: never re-admit an active/completed task id.
	const existingIds = new Set([...allKnownIds, ...(queueState.completed_task_ids ?? [])]);
	const duplicate = existingIds.has(proposal.proposed_task_id);
	checks.push(check("not_duplicate", !duplicate, proposal.proposed_task_id));
	if (duplicate) rejectReasons.push(`proposed_task_id ${proposal.proposed_task_id} already exists`);

	// 11. Cycle safety: a proposal's parent must not be (transitively) derived
	//     from the proposed task. Since a proposal always creates a NEW id, the
	//     only way to build a cycle is if the proposed id already exists (handled
	//     above) or the parent chain contains the proposed id.
	const ancestry = collectAncestry(proposal.parent_task_id, queueById, taskIds);
	const wouldCycle = ancestry.has(proposal.proposed_task_id);
	checks.push(check("no_cycle", !wouldCycle, wouldCycle ? "proposed task is an ancestor of its own parent" : null));
	if (wouldCycle) rejectReasons.push("proposal would create a dependency cycle");

	// 12. Budget reservation must fit the REMAINING Campaign budget. The Campaign
	//     total can never grow (user decision 3): only a reservation is allowed.
	//
	//     IMPORTANT (C0 vs C1): this is a PURE admission check. It does NOT itself
	//     reserve anything. The CALLER must commit the reservation into
	//     `queueState.derived_budget` before evaluating the next proposal, or two
	//     proposals could each pass against the same stale remaining budget. C1 MUST
	//     perform an atomic admission+reservation commit under the single writer /
	//     lease to avoid a double-reservation race.
	const budget = manifest.budget ?? {};
	const derived = queueState.derived_budget ?? { wall_time_ms: 0, model_requests: 0, tool_calls: 0 };
	const reservation = proposal.budget_reservation ?? {};
	const remaining = {
		wall_time_ms: (budget.wall_time_ms ?? 0) - (derived.wall_time_ms ?? 0),
		model_requests: (budget.model_requests ?? 0) - (derived.model_requests ?? 0),
		tool_calls: (budget.tool_calls ?? 0) - (derived.tool_calls ?? 0),
	};
	const fits = ["wall_time_ms", "model_requests", "tool_calls"].every(
		(key) => (reservation[key] ?? 0) <= remaining[key],
	);
	checks.push(check("budget_reservation_fits", fits, `remaining ${JSON.stringify(remaining)}`));
	if (!fits)
		blockReasons.push(
			`budget reservation ${JSON.stringify(reservation)} exceeds remaining Campaign budget ${JSON.stringify(remaining)}`,
		);

	// Decide. `rejected` dominates `blocked` (malformed), `blocked` dominates
	// `admitted` (needs a human).
	if (rejectReasons.length > 0) return { status: "rejected", checks, reasons: rejectReasons, reserved_budget: null };
	if (blockReasons.length > 0) return { status: "blocked", checks, reasons: blockReasons, reserved_budget: null };
	return {
		status: "admitted",
		checks,
		reasons: [],
		reserved_budget: {
			wall_time_ms: reservation.wall_time_ms ?? 0,
			model_requests: reservation.model_requests ?? 0,
			tool_calls: reservation.tool_calls ?? 0,
		},
	};
}

function collectAncestry(startId, queueById, taskIds) {
	const seen = new Set();
	let current = startId;
	while (current) {
		if (seen.has(current)) break;
		seen.add(current);
		const node = queueById.get(current);
		if (node) current = node.parent_task_id ?? null;
		else if (taskIds.has(current)) break;
		else break;
	}
	return seen;
}

/**
 * Derive the depth of a prospective CHILD of `parentTaskId` from the trusted
 * parent chain. Root (static, no known dynamic parent) => the child is depth 1.
 * A dynamic parent at depth d => the child is depth d+1. Returns `null` when the
 * chain cannot be fully resolved (fail-closed: never trust a self-reported
 * depth).
 *
 * @param {{parentTaskId: string, staticTasks: Map, queueById: Map}} args
 */
export function resolveChainDepth({ parentTaskId, staticTasks, queueById }) {
	const seen = new Set();
	// The child of any task with no known parent is at depth 1.
	let node = queueById.get(parentTaskId);
	if (!node) {
		// Static (or unknown) parent: the static Manifest has no dynamic parent
		// chain, so a child of a static task is depth 1.
		return staticTasks.has(parentTaskId) ? 1 : null;
	}
	let depth = 1;
	while (node) {
		if (seen.has(node.task_id)) return null; // cyclic parent chain: refuse
		seen.add(node.task_id);
		const parentId = node.parent_task_id ?? null;
		if (parentId === null || parentId === undefined) return depth;
		// Parent is either static (base of the chain) or another dynamic task.
		if (staticTasks.has(parentId) && !queueById.has(parentId)) return depth + 1;
		node = queueById.get(parentId);
		if (!node) return staticTasks.has(parentId) ? depth + 1 : null;
		depth += 1;
	}
	return depth;
}

/**
 * Commit an admitted proposal's reservation into a (new) queueState. Pure helper
 * so a caller/test can apply the reservation explicitly. C0 does not persist it;
 * C1 must make this commit atomic with the admission under the Campaign writer.
 */
export function applyAdmission(queueState = {}, { proposal, reserved_budget }) {
	const tasks = Array.isArray(queueState.tasks) ? [...queueState.tasks] : [];
	tasks.push({
		task_id: proposal.proposed_task_id,
		parent_task_id: proposal.parent_task_id,
		state: "queued",
		target_ref: proposal.target_ref,
		required_capabilities: [...(proposal.required_capabilities ?? [])],
	});
	const derived = queueState.derived_budget ?? { wall_time_ms: 0, model_requests: 0, tool_calls: 0 };
	const nextDerived = {
		wall_time_ms: (derived.wall_time_ms ?? 0) + (reserved_budget?.wall_time_ms ?? 0),
		model_requests: (derived.model_requests ?? 0) + (reserved_budget?.model_requests ?? 0),
		tool_calls: (derived.tool_calls ?? 0) + (reserved_budget?.tool_calls ?? 0),
	};
	return { ...queueState, tasks, derived_budget: nextDerived };
}
