// Aegis E1 — planning task bootstrap and whole-graph plan admission.
//
// When `config.planning.enabled` is true the product starts from a Manifest that
// contains ONLY the Campaign root goal and ONE Host-owned planning Task. The
// model submits a complete candidate plan through the structured
// `aegis_submit_plan` tool; the Host validates the WHOLE graph and admits it as a
// single durable batch. No business task tree is pre-seeded.
//
// This module owns the deterministic pieces so `c6-entry.mjs` stays wiring:
//   * `buildPlanningManifest` — root goal + planning task + frozen templates;
//   * `templatesFromConfig`   — the trusted task-type -> oracle/criteria map;
//   * `createPlanReadyJudge`  — the independent plan_ready judge (planning
//     terminated normally AND a complete, legal batch is durably admitted);
//   * `admitCandidatePlan`    — validate + admit through the Host (the batch
//     admission ONLY; the plan-ready gate is reached through the Scheduler).
//
// It never grants the planning Task the business oracle, and never lets a
// business task inherit the planning task's own readiness criterion.

import { summarizeRequestLedger } from "./c6-request-lifecycle.mjs";
import { planDigest } from "./e1-plan-contract.mjs";
import { buildPlanningContract } from "./e1-planning-contract.mjs";
import { projectQueueFromEvents } from "./projection.mjs";
import { isKnownOracleAdapter } from "./registries.mjs";

/** The Host-owned planning task id (never a business task). */
export const PLANNING_TASK_ID = "task-plan";

/** Build the trusted template map (task_type -> {template_ref, oracle_ref, capabilities, criteria}). */
export function templatesFromConfig(planningConfig) {
	const map = new Map();
	for (const template of planningConfig?.templates ?? []) {
		const entry = {
			template_ref: template.template_ref ?? template.task_type ?? null,
			task_type: template.task_type ?? template.template_ref ?? null,
			oracle_ref: template.oracle_ref,
			required_capabilities: template.required_capabilities ?? [],
			success_criteria: template.success_criteria ?? [],
			scope: template.scope ?? null,
		};
		if (entry.template_ref) map.set(entry.template_ref, entry);
		if (entry.task_type && entry.task_type !== entry.template_ref) map.set(entry.task_type, entry);
	}
	return map;
}

/**
 * Turn a base task-family Manifest into a PLANNING manifest:
 *   * keep the objective, authorization, adapters and budget;
 *   * REPLACE the preset business tasks with the single planning task;
 *   * enable dynamic task expansion.
 *
 * The planning task carries the Host-owned `plan_ready` criterion. Business tasks
 * are created ONLY from an admitted plan batch.
 *
 * @param {{base: any, planningConfig: any, campaignId?: string|null}} args
 */
export function buildPlanningManifest({ base, planningConfig, campaignId = null }) {
	// The root-goal REQUIRED criteria are the machine-checkable criteria of the
	// base business tree (what the independent Oracle can actually verify). The
	// objective prose is kept for display. A plan must cover the machine criteria.
	const requiredCriteria = [
		...new Set((base.tasks ?? []).flatMap((task) => (task.stages ?? []).flatMap((stage) => stage.criteria ?? []))),
	];
	if (requiredCriteria.length === 0) requiredCriteria.push(...(base.objective?.success_criteria ?? []));
	const planningTask = {
		task_id: PLANNING_TASK_ID,
		order: 1,
		depends_on: [],
		target_ref: base.authorization?.allowed_targets?.[0] ?? null,
		task_type: "observe",
		scope: { environment_fingerprint: "c6-planning-env", domain: "planning", permissions: [], task_types: [] },
		goal: {
			goal_id: "plan_campaign",
			description: `Plan how to satisfy the campaign root goal: ${base.objective?.description ?? ""}`,
			success_criteria: [PLAN_READY_CRITERION],
		},
		stages: [{ stage_id: "stage-plan", criteria: [PLAN_READY_CRITERION], required: true }],
		oracle_ref: base.adapters?.oracle ?? "fixture.oracle.v1",
		task_budget: { wall_time_ms: 120000, model_requests: 8, tool_calls: 24 },
	};
	// The Host-OWNED tool/planning budget and the plan-shape limits come from the
	// base Manifest. We NEVER widen them here (no Math.max on budget, count, depth,
	// fan-out, enabled flag or allowed types): a base Manifest that cannot host
	// planning is REFUSED so the Host must select a legal Manifest explicitly.
	const baseCheck = checkPlanningBase({ base, planningTask, templates: planningConfig?.templates ?? [] });
	if (!baseCheck.ok) return { ok: false, reasons: baseCheck.reasons, manifest: null };
	const frozen = {
		...base,
		campaign_id: campaignId ?? base.campaign_id,
		title: `${base.title} (planning)`,
		tasks: [planningTask],
		budget: { ...base.budget },
		// The root-goal required criteria are frozen so a plan cannot delete them.
		objective: {
			...base.objective,
			success_criteria: [...(base.objective?.success_criteria ?? [])],
			required_criteria: requiredCriteria,
		},
		dynamic_task_policy: { ...base.dynamic_task_policy },
	};
	// Embed the IMMUTABLE trusted planning contract. A base whose budget/policy
	// cannot accommodate planning is refused with an explicit reason rather than
	// silently widened.
	const built = buildPlanningContract({
		manifest: frozen,
		templates: planningConfig?.templates ?? [],
		requiredCriteria,
	});
	if (!built.ok) {
		return { ok: false, reasons: built.reasons, manifest: null };
	}
	return { ok: true, reasons: [], manifest: { ...frozen, planning_contract: built.contract } };
}

/**
 * Refuse a base Manifest that cannot host the planning Task and at least one
 * child, or whose trusted templates step outside the Manifest's own
 * authorization/registries. Nothing is widened to make a base fit.
 *
 * @param {{base: any, planningTask: any, templates: any[]}} args
 * @returns {{ok: boolean, reasons: string[]}}
 */
function checkPlanningBase({ base, planningTask, templates }) {
	const reasons = [];
	const budget = base?.budget ?? {};
	for (const dim of ["wall_time_ms", "model_requests", "tool_calls"]) {
		const limit = budget[dim];
		if (!Number.isSafeInteger(limit) || limit < 0)
			reasons.push(`base budget.${dim} must be a safe non-negative integer`);
		else if (planningTask.task_budget[dim] > limit)
			reasons.push(
				`planning_budget_exceeds_base: the planning task needs ${dim}=${planningTask.task_budget[dim]} but the base allows ${limit}`,
			);
	}
	// The planning Task itself plus at least one child Task.
	if (!Number.isSafeInteger(budget.task_count) || budget.task_count < 2)
		reasons.push(`base budget.task_count ${String(budget.task_count)} cannot hold the planning task and a child task`);
	const policy = base?.dynamic_task_policy ?? {};
	if (policy.enabled !== true) reasons.push("base dynamic_task_policy.enabled must be true for planning");
	if (Number.isInteger(policy.max_task_count) && policy.max_task_count < 2)
		reasons.push(`base dynamic_task_policy.max_task_count ${policy.max_task_count} cannot hold a child task`);
	if (!planningTask.target_ref) reasons.push("base authorization.allowed_targets is empty");
	const allowedTypes = new Set(Array.isArray(policy.allowed_task_types) ? policy.allowed_task_types : []);
	const allowedCapabilities = new Set(base?.authorization?.allowed_capabilities ?? []);
	for (const template of templates) {
		const label = template?.template_ref ?? template?.task_type ?? "?";
		const type = template?.task_type ?? template?.template_ref;
		if (!allowedTypes.has(type)) reasons.push(`template ${label}: task_type ${type} is not allowed by the base policy`);
		if (!isKnownOracleAdapter(template?.oracle_ref))
			reasons.push(`template ${label}: oracle ${String(template?.oracle_ref)} is not registered`);
		for (const cap of template?.required_capabilities ?? [])
			if (!allowedCapabilities.has(cap)) reasons.push(`template ${label}: capability ${cap} is not authorized`);
		for (const perm of template?.scope?.permissions ?? [])
			if (!allowedCapabilities.has(perm)) reasons.push(`template ${label}: scope permission ${perm} is not authorized`);
	}
	return { ok: reasons.length === 0, reasons };
}

/** Convenience wrapper that returns the Manifest directly (throws on refusal). */
export function requirePlanningManifest(args) {
	const built = buildPlanningManifest(args);
	if (!built.ok) {
		const error = /** @type {any} */ (new Error(`cannot build planning manifest: ${built.reasons.join("; ")}`));
		error.reasons = built.reasons;
		throw error;
	}
	return built.manifest;
}

/** The Host-owned plan readiness criterion (never a resolvable business claim). */
export const PLAN_READY_CRITERION = "plan_ready";

/**
 * The independent planning-Task check. Returns success ONLY when:
 *   * the planning request settled normally (no outstanding/abort/error), AND
 *   * a complete candidate plan was durably ADMITTED as a whole batch.
 * It never inspects child tasks (no circular gate) and never implies the root
 * goal is complete.
 *
 * @param {{projection?: any, planningTaskId?: string, requestedPlanId?: string|null, planning?: {termination?: {normal?: boolean, reason?: string|null}, settlement?: {unresolved?: number}}|null}} [args]
 */
export function evaluatePlanReady({
	projection,
	planningTaskId = PLANNING_TASK_ID,
	requestedPlanId = null,
	planning = null,
} = {}) {
	// The planning TERMINATION and the JOINT REQUEST SETTLEMENT are separate
	// trusted facts. A caller that can observe them passes them in; when it cannot,
	// the gate stays conservative (no success).
	if (planning) {
		if (planning.termination && planning.termination.normal !== true) {
			return {
				status: "unknown",
				failure_mode: "planning_termination_not_normal",
				reason: planning.termination.reason ?? "the planning request did not terminate normally",
			};
		}
		if (planning.settlement && Number(planning.settlement.unresolved) > 0) {
			return {
				status: "unknown",
				failure_mode: "planning_requests_unsettled",
				reason: `${planning.settlement.unresolved} planning request(s) are not jointly settled`,
			};
		}
	}
	const plans = (projection?.plans ?? []).filter((plan) => plan.status === "admitted");
	const admitted = requestedPlanId
		? plans.filter((plan) => (plan.id ?? plan.plan_id ?? null) === requestedPlanId)
		: plans;
	if (admitted.length === 0) {
		return {
			status: "unknown",
			failure_mode: "no_admitted_plan",
			reason: "no complete plan batch is durably admitted",
		};
	}
	const plan = admitted[admitted.length - 1];
	if (plan.planning_task_id && plan.planning_task_id !== planningTaskId) {
		return {
			status: "unknown",
			failure_mode: "planning_identity_mismatch",
			reason: `the admitted plan belongs to planning task ${plan.planning_task_id}, not ${planningTaskId}`,
		};
	}
	const taskIds = Array.isArray(plan.normalized) ? plan.normalized : [];
	if (taskIds.length === 0) {
		return { status: "unknown", failure_mode: "empty_plan", reason: "the admitted plan has no tasks" };
	}
	return {
		status: "success",
		plan_id: plan.id ?? plan.plan_id ?? null,
		plan_digest: plan.digest ?? null,
		task_count: taskIds.length,
		criterion: { criterion_id: `${planningTaskId}.plan_ready`, expected: true, description: PLAN_READY_CRITERION },
		observed: true,
	};
}

/**
 * Derive the planning TERMINATION fact from the durable committed stream. Every
 * committed planning request must have ended with a normal provider status; a
 * missing/unknown/error/aborted status is never normal termination.
 *
 * @param {any[]} events
 * @param {string} planningTaskId
 */
export function planningTerminationFromEvents(events = [], planningTaskId = PLANNING_TASK_ID) {
	const committed = events.filter(
		(event) =>
			event?.payload?.kind === "c6.request" &&
			event.payload.task_id === planningTaskId &&
			event.payload.phase === "committed",
	);
	if (committed.length === 0) return { normal: false, reason: "no durably committed planning request" };
	for (const request of committed) {
		if (request.payload.provider_status !== "ok")
			return {
				normal: false,
				reason: `planning request ${request.payload.request_id ?? "?"} ended with provider_status ${String(request.payload.provider_status)}`,
			};
	}
	return { normal: true, reason: null };
}

/**
 * The INDEPENDENT plan_ready judge used by the Scheduler's existing Oracle chain
 * for the Host-owned planning Task. It re-derives the authoritative projection
 * from the committed stream, so it never trusts the worker's self-report, a
 * function name, an oracle source label, or a null outcome.
 *
 * @param {{
 *   readEvents: () => any[],
 *   manifest: any,
 *   planningTaskId?: string,
 *   requestedPlanId?: string|null,
 * }} args
 */
export function createPlanReadyJudge(
	{ readEvents, manifest, planningTaskId = PLANNING_TASK_ID, requestedPlanId = null } = /** @type {any} */ ({}),
) {
	if (typeof readEvents !== "function") throw new Error("createPlanReadyJudge requires a readEvents function");
	return (/** @type {any} */ { task, onEvidence } = {}) => {
		const events = readEvents() ?? [];
		const projection = projectQueueFromEvents({
			campaign_id: manifest?.campaign_id,
			tasks: manifest?.tasks ?? [],
			events,
			revision: manifest?.revision ?? 0,
			manifest,
		});
		// A charged planning tool unit with no durable `finished` is an open
		// responsibility: the plan is not ready while it is outstanding.
		const unfinished = (projection.tool_charges ?? []).filter(
			(entry) => entry.task_id === (task?.task_id ?? planningTaskId) && entry.finished !== true,
		);
		if (unfinished.length > 0)
			return {
				status: "unknown",
				failure_mode: "planning_tool_unsettled",
				detail: `${unfinished.length} charged planning tool unit(s) have no durable finished record`,
			};
		const termination = planningTerminationFromEvents(events, task?.task_id ?? planningTaskId);
		const settlement = summarizeRequestLedger(events);
		const verdict = evaluatePlanReady({
			projection,
			planningTaskId: task?.task_id ?? planningTaskId,
			requestedPlanId,
			planning: { termination, settlement },
		});
		if (verdict.status !== "success") {
			return {
				status: "unknown",
				failure_mode: verdict.failure_mode ?? "plan_not_ready",
				detail: verdict.reason ?? null,
			};
		}
		// Evidence is bound to the ADMITTED batch identity (plan id + digest), so a
		// replay resolves the same ref without re-running the planning worker.
		const evidence = [
			{
				ref_id: `artifact:${task?.task_id ?? planningTaskId}`,
				digest: verdict.plan_digest ?? verdict.plan_id ?? PLAN_READY_CRITERION,
				path: null,
			},
		];
		if (typeof onEvidence === "function") onEvidence(evidence);
		return {
			status: "success",
			expected: PLAN_READY_CRITERION,
			observed: { plan_id: verdict.plan_id, plan_digest: verdict.plan_digest, task_count: verdict.task_count },
			evidence,
			failure_mode: null,
		};
	};
}

/**
 * Submit a candidate plan to the Host for whole-batch admission. The decision is
 * made ONLY by the Host command (`host.admitPlan`), which compiles the candidate
 * against the latest committed prefix with the same compiler the replay uses;
 * this adapter never pre-validates with a stale projection and never passes an
 * "already admitted" conclusion. The plan-ready gate is reached later through
 * the Scheduler's independent plan_ready Oracle.
 *
 * `projection`, `templates` and `planningContext` are accepted for interface
 * compatibility only; they never authorize anything.
 *
 * @param {{plan: any, manifest?: any, host: any, projection?: any, templates?: any, planningTaskId?: string, planningSettled?: boolean, planningContext?: any}} args
 */
export async function admitCandidatePlan({ plan, host, planningTaskId = PLANNING_TASK_ID, planningSettled = true }) {
	if (!planningSettled) {
		return { ok: false, status: "blocked", reasons: ["the planning request did not settle normally"] };
	}
	const result = await host.admitPlan({ plan, planningTaskId });
	return {
		...result,
		ok: result?.ok === true,
		status: result?.status ?? "incomplete",
		reasons: result?.reasons ?? (result?.reason ? [result.reason] : []),
		plan_id: result?.plan_id ?? plan?.plan_id ?? null,
		digest: planDigest(plan),
	};
}

export { buildPlanningContext, buildPlanningPrompt, PLAN_LIMITS, planDigest } from "./e1-plan-contract.mjs";
