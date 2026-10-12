// Aegis C3-B — brokered Worker.
//
// A C1-shaped worker (`run({task}) -> {ok, outcome_ref}`) whose side effects go
// through the EXISTING Action Broker (action-contract.mjs). It never parses
// model prose, never accepts an executable/argv/authorization object from the
// model, and never treats an exit code or its own `ok` as a task verdict.
//
// Durable ordering (CAMPAIGN_ARCHITECTURE §3.8, C3-INTENT / C3-AFTER):
//   1. append `action.requested` and CONFIRM durability (fsync) BEFORE the
//      effect. An append/fsync failure => the adapter is NOT called.
//   2. run the registered procedure through the Broker (which re-checks
//      arguments, authorization, recognition).
//   3. append `action.completed` with the REAL observed result. A failure here
//      after a possible effect is reported as degraded; the caller (scheduler)
//      stops new effects and keeps the task unknown.
//
// The worker returns the transport fact only. The independent Oracle decides
// the criterion.

import { existsSync, readFileSync } from "node:fs";

import { digest } from "../fixture/contracts.mjs";

/**
 * @typedef {{step_id: string, stage_id: string|null, action_ref: string,
 *   arguments: object, criterion_id: string, description?: string,
 *   evidence_ref?: string|null}} ActionStep
 * @typedef {{task_id: string, steps: ActionStep[]}} ActionPlan
 */

/**
 * @param {{
 *   broker: {invoke: Function, registry?: any},
 *   authorization: any,
 *   plan: ActionPlan|((task: any) => ActionPlan|null),
 *   sink: {append: Function},
 *   workspaceRoot: string,
 *   artifactIndex: Map<string, {ref_id: string, digest: string, path?: string}>|Record<string, {ref_id: string, digest: string}>,
 *   actionGate?: any,
 *   onAction?: (kind: string, record: object) => void,
 *   probePath?: (step: ActionStep, task: any) => string|null,
 *   targetPathFor?: (step: ActionStep, task: any) => string|null,
 * }} args
 */
export function createBrokerWorker(
	{
		broker,
		authorization,
		plan,
		sink,
		workspaceRoot,
		artifactIndex,
		actionGate = null,
		onAction = null,
		probePath = null,
		targetPathFor = null,
	} = /** @type {any} */ ({}),
) {
	if (!broker || typeof broker.invoke !== "function") throw new Error("createBrokerWorker requires a broker.invoke");
	if (!sink || typeof sink.append !== "function") throw new Error("createBrokerWorker requires a sink with append()");

	/** Uniform durable append boundary. Never treats a Promise as durability. */
	async function commit(event) {
		let result;
		try {
			result = await sink.append(event);
		} catch (error) {
			return { ok: false, durable: false, event: null, error: `append threw: ${String(error)}` };
		}
		if (!result || result.ok !== true)
			return { ok: false, durable: false, event: null, error: result?.error ?? "append not ok" };
		if (result.durable === false)
			return { ok: false, durable: false, event: result.event ?? null, error: "append reported durable:false" };
		return { ok: true, durable: true, event: result.event ?? null, error: null };
	}

	function indexEntry(refId, entry) {
		if (artifactIndex instanceof Map) artifactIndex.set(refId, entry);
		else artifactIndex[refId] = entry;
	}

	function readIndex(refId) {
		if (artifactIndex instanceof Map) return artifactIndex.get(refId) ?? null;
		return artifactIndex?.[refId] ?? null;
	}

	/** Resolve the trusted action plan for a task (never from model text). */
	function planFor(task) {
		if (typeof plan === "function") return plan(task);
		if (plan && plan.task_id === task?.task_id) return plan;
		return null;
	}

	/** The real post-state digest the Oracle will independently re-read. */
	function recordEffectArtifact(refId, path) {
		if (!path || !existsSync(path)) return null;
		try {
			const content = readFileSync(path);
			const contentDigest = digest(content.toString("binary"));
			indexEntry(refId, { ref_id: refId, digest: contentDigest, path });
			return contentDigest;
		} catch {
			return null;
		}
	}

	async function runStep({ task, step }) {
		const episodeId = `ep-${task.task_id}`;
		const actionEventKey = `act-${task.task_id}-${step.step_id}`;
		const requested = await commit({
			event_type: "action.requested",
			episode_id: episodeId,
			source: { kind: "runtime", actor_id: "campaign-host", adapter: "c3-broker-worker", version: "1.0.0" },
			payload: {
				action_id: actionEventKey,
				action_ref: step.action_ref,
				episode_id: episodeId,
				task_id: task.task_id,
				step_id: step.step_id,
				final_arguments: step.arguments ?? {},
				arguments_digest: digest(step.arguments ?? {}),
			},
		});
		// C3-INTENT: no durable intent => NO effect.
		if (!requested.ok) {
			return { ok: false, phase: "intent", error: requested.error, effect_probe: false };
		}
		if (onAction) onAction("requested", { task_id: task.task_id, step_id: step.step_id, action_ref: step.action_ref });

		// The Broker re-checks authorization against the target derived from the
		// REGISTERED action arguments (never model-supplied authorization).
		const derivedTargetPath =
			typeof targetPathFor === "function"
				? targetPathFor(step, task)
				: (step.arguments?.target ?? step.arguments?.path ?? null);
		// The Broker is the ONLY execution path.
		let result;
		try {
			result = await broker.invoke({
				action_ref: step.action_ref,
				arguments: step.arguments ?? {},
				context: {
					workspaceRoot,
					episode_id: episodeId,
					step_id: step.step_id,
					action_event_id: requested.event?.event_id ?? actionEventKey,
					action_id: actionEventKey,
					target_path: derivedTargetPath,
					task_id: task.task_id,
					criterion_id: step.criterion_id ?? null,
				},
				authorization,
				state: {},
			});
		} catch (error) {
			result = { ok: false, status: "unknown", reason: `broker threw: ${String(error)}`, failure_mode: "tool_error" };
		}

		const transport = result?.transport ?? null;
		// Record the REAL effect artifact (if the step produced one) so the Oracle
		// can independently re-read it.
		const refId = step.evidence_ref ?? null;
		const path = typeof probePath === "function" ? probePath(step, task) : null;
		const contentDigest = refId ? recordEffectArtifact(refId, path) : null;

		const completed = await commit({
			event_type: "action.completed",
			episode_id: episodeId,
			source: { kind: "runtime", actor_id: "campaign-host", adapter: "c3-broker-worker", version: "1.0.0" },
			payload: {
				action_id: actionEventKey,
				action_ref: step.action_ref,
				episode_id: episodeId,
				task_id: task.task_id,
				step_id: step.step_id,
				status: result?.status ?? "unknown",
				// The transport/observed facts are preserved verbatim for audit; they
				// are NOT a verdict.
				transport,
				final_arguments: result?.final_arguments ?? step.arguments ?? {},
				observed: result?.result ?? null,
				content_digest: contentDigest,
				rejection_reason: result?.ok === true ? null : (result?.reason ?? result?.failure_mode ?? "unknown"),
			},
		});
		if (onAction) {
			onAction("completed", {
				task_id: task.task_id,
				step_id: step.step_id,
				action_ref: step.action_ref,
				status: result?.status ?? "unknown",
				content_digest: contentDigest,
			});
		}
		// C3-AFTER: the effect may have happened but its result is not durable.
		if (!completed.ok) {
			return {
				ok: false,
				phase: "result",
				error: `result append failed after a possible effect: ${completed.error}`,
				effect_probe: contentDigest !== null,
				transport,
			};
		}
		return {
			ok: true,
			phase: "done",
			transport,
			observed: result?.result ?? null,
			content_digest: contentDigest,
			effect_probe: contentDigest !== null,
		};
	}

	return {
		/**
		 * Run one task's trusted action plan. Returns the TRANSPORT/effect fact; the
		 * Oracle decides success. A failure is `{ok:false, failure_mode}` for the
		 * scheduler, which records unknown + reconciliation (never a task failure).
		 */
		async run({ task }) {
			const steps = planFor(task);
			if (!steps || !Array.isArray(steps.steps) || steps.steps.length === 0) {
				return {
					ok: false,
					failure_mode: "no_action_plan",
					detail: `no trusted action plan for task ${task?.task_id}`,
				};
			}
			const effects = [];
			for (const step of steps.steps) {
				// Campaign mode: a non-brokered step is refused before any effect.
				if (actionGate && typeof actionGate.guardToolCall === "function") {
					const decision = actionGate.guardToolCall({ tool_name: "aegis_script", action_ref: step.action_ref });
					if (decision.allowed !== true) {
						return { ok: false, failure_mode: "action_denied", detail: decision.reason };
					}
				}
				const stepResult = await runStep({ task, step });
				effects.push(stepResult);
				if (!stepResult.ok) {
					return {
						ok: false,
						failure_mode: stepResult.phase === "intent" ? "intent_not_durable" : "result_not_durable",
						detail: stepResult.error,
						effects,
						effect_probe: stepResult.effect_probe === true,
					};
				}
			}
			// A stable outcome_ref: the last recorded artifact ref (or the task id).
			const last = steps.steps[steps.steps.length - 1];
			const outcomeRef = last?.evidence_ref ?? `artifact:${task.task_id}`;
			return { ok: true, outcome_ref: outcomeRef, effects };
		},
		/** Expose the artifact index the Host/Oracle share. */
		artifactIndex,
		readIndex,
	};
}
