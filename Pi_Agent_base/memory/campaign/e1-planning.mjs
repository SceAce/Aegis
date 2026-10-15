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

import { artifactIndexFromEvents } from "./c3-entry.mjs";
import { summarizeRequestLedger } from "./c6-request-lifecycle.mjs";
import { buildPlanningContext, planDigest, validatePlanGraph } from "./e1-plan-contract.mjs";
import { buildPlanningContract } from "./e1-planning-contract.mjs";
import { projectQueueFromEvents } from "./projection.mjs";

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
	// base Manifest. We NEVER widen them here (no Math.max on budget, count, depth
	// or fan-out): a base Manifest that is too small for planning must be fixed by
	// the Host selecting a legal Manifest, not by the builder silently expanding.
	const taskCountBudget = base.budget?.task_count ?? 0;
	const frozen = {
		...base,
		campaign_id: campaignId ?? base.campaign_id,
		title: `${base.title} (planning)`,
		tasks: [planningTask],
		budget: { ...base.budget, task_count: taskCountBudget },
		// The root-goal required criteria are frozen so a plan cannot delete them.
		objective: {
			...base.objective,
			success_criteria: [...(base.objective?.success_criteria ?? [])],
			required_criteria: requiredCriteria,
		},
		dynamic_task_policy: {
			...base.dynamic_task_policy,
			enabled: true,
			allowed_task_types: [...new Set((planningConfig?.templates ?? []).map((t) => t.task_type ?? t.template_ref))],
		},
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
			artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
		});
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
 * Validate and admit a candidate plan as ONE durable batch. The plan is validated
 * by the whole graph BEFORE any durable write, so an illegal node rejects the
 * whole batch and no legal subset runs. This records the batch admission ONLY;
 * the plan-ready activation gate is reached later through the Scheduler's
 * independent plan_ready Oracle and durable Task completion.
 *
 * @param {{
 *   plan: any,
 *   manifest: any,
 *   host: any,
 *   projection: any,
 *   templates?: Map<string, any>|null,
 *   planningTaskId?: string,
 *   planningSettled?: boolean,
 *   planningContext?: any|null,
 * }} args
 */
export async function admitCandidatePlan({
	plan,
	manifest,
	host,
	projection,
	templates = null,
	planningTaskId = PLANNING_TASK_ID,
	planningSettled = true,
	planningContext = null,
}) {
	if (!planningSettled) {
		return { ok: false, status: "blocked", reasons: ["the planning request did not settle normally"] };
	}
	const existingTaskIds = new Set([
		...(manifest.tasks ?? []).map((task) => task.task_id),
		...(projection?.tasks ?? []).map((task) => task.task_id),
	]);
	const derived = projection?.budget?.reserved ?? { wall_time_ms: 0, model_requests: 0, tool_calls: 0 };
	// Consume the SAME normalized contract the provider was given (or rebuild it
	// from the same manifest + trusted templates). Never a second test-only copy.
	const context = planningContext ?? buildPlanningContext({ manifest, templates, planningTaskId });
	// Root-goal binding: compare against the trusted context when one is known
	// (the real product run always supplies it). A caller that supplies NO context
	// and whose manifest has NO frozen contract has no root to bind against, so the
	// candidate root is accepted as-is (the Host still re-validates the whole graph).
	const expectedRoot = planningContext
		? (context?.root_goal_ref ?? null)
		: (manifest?.planning_contract?.root_goal_ref ?? null);
	const admission = validatePlanGraph({
		plan,
		manifest,
		planningTaskId,
		existingTaskIds,
		templates: templates && templates.size > 0 ? templates : null,
		requiredCriteria: context?.root_goal?.required_criteria ?? [],
		expectedRootGoalRef: expectedRoot,
		derivedBudget: derived,
	});
	if (admission.status !== "admitted") {
		await host.admitPlan({ plan, planningTaskId, admission, planId: plan?.plan_id ?? null });
		return { ok: false, status: admission.status, reasons: admission.reasons, admission };
	}
	const recorded = await host.admitPlan({
		plan,
		planningTaskId,
		admission,
		planId: plan?.plan_id ?? null,
		planDigest: planDigest(plan),
	});
	if (!recorded.ok) {
		return {
			ok: false,
			status: recorded.status ?? "incomplete",
			reasons: [recorded.reason ?? "plan admission incomplete"],
			admission,
		};
	}
	// The plan-ready gate is a SEPARATE durable state reached ONLY through the
	// Scheduler's independent Oracle chain (planning Task completed). This function
	// records the whole-batch admission and stops there: it never writes
	// `campaign.plan.ready` and never releases a child Task.
	return { ok: true, status: "admitted", plan_id: recorded.plan_id, admission, digest: planDigest(plan) };
}

export { buildPlanningContext, buildPlanningPrompt, PLAN_LIMITS, planDigest } from "./e1-plan-contract.mjs";
