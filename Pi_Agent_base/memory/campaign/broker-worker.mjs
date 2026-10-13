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

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { digest } from "../fixture/contracts.mjs";

/**
 * Compare two paths by their REAL location when they exist, falling back to a
 * lexical resolve. Keeps the grant boundary strict (a genuinely different root
 * is refused) while tolerating a symlinked prefix (e.g. macOS /tmp ->
 * /private/tmp).
 */
function samePath(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return false;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return resolve(a) === resolve(b);
	}
}

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
	let campaignManifest = null;

	function grantCheck(task, step) {
		if (!campaignManifest) return { ok: false, reason: "no trusted Campaign grant bound to Worker" };
		const contract = broker.registry?.get(step.action_ref);
		if (!contract) return { ok: false, reason: `unknown action: ${String(step.action_ref)}` };
		const auth = campaignManifest.authorization;
		if (!samePath(auth.workspace_root, workspaceRoot))
			return { ok: false, reason: "workspace differs from Manifest grant" };
		const target =
			typeof targetPathFor === "function"
				? targetPathFor(step, task)
				: (step.arguments?.target ?? step.arguments?.path);
		const absolute = typeof target === "string" ? resolve(workspaceRoot, target) : null;
		if (
			!absolute ||
			absolute !== resolve(workspaceRoot, task.target_ref) ||
			!auth.allowed_targets.some((t) => absolute === resolve(workspaceRoot, t))
		) {
			return { ok: false, reason: "action target is outside Campaign/Task grant" };
		}
		// Check actual data path parameters too: a trusted target resolver must not
		// mask an ungranted resource path supplied in the final arguments.
		for (const [name, spec] of Object.entries(contract.parameters ?? {})) {
			if (
				spec.direction &&
				typeof step.arguments?.[name] === "string" &&
				resolve(workspaceRoot, step.arguments[name]) !== absolute
			) {
				return { ok: false, reason: `resource parameter ${name} escapes the allowed Task target` };
			}
		}
		const capabilities = contract.scope?.permissions ?? [];
		if (
			capabilities.length === 0 ||
			capabilities.some((c) => !auth.allowed_capabilities.includes(c)) ||
			(task.required_capabilities ?? []).some((c) => !auth.allowed_capabilities.includes(c))
		) {
			return { ok: false, reason: "action capability is outside Campaign/Task grant" };
		}
		if (contract.network === true && auth.network === "disabled")
			return { ok: false, reason: "network is outside Campaign grant" };
		return { ok: true };
	}

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
			// Read as UTF-8 text so the digest agrees with the Oracle's own read of
			// the same artifact (the registered verify()/judge read text too).
			const contentDigest = digest(readFileSync(path, "utf8"));
			indexEntry(refId, { ref_id: refId, digest: contentDigest, path });
			return contentDigest;
		} catch {
			return null;
		}
	}

	async function runStep({ task, step }) {
		const episodeId = `ep-${task.task_id}`;
		const actionEventKey = `act-${task.task_id}-${step.step_id}`;
		const contract = broker.registry?.get(step.action_ref);
		let grant = grantCheck(task, step);
		const requested = await commit({
			event_type: "action.requested",
			episode_id: episodeId,
			source: { kind: "runtime", actor_id: "campaign-host", adapter: "c3-broker-worker", version: "1.0.0" },
			payload: {
				action_id: actionEventKey,
				action_ref: step.action_ref,
				version: contract?.version ?? null,
				implementation_digest: contract?.implementation_digest ?? null,
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
			// The intent append is awaited; re-check final parameters/grants at the
			// actual execution boundary as well.
			grant = grant.ok ? grantCheck(task, step) : grant;
			result = grant.ok
				? await broker.invoke({
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
					})
				: { ok: false, status: "rejected", reason: grant.reason };
		} catch (error) {
			result = { ok: false, status: "unknown", reason: `broker threw: ${String(error)}`, failure_mode: "tool_error" };
		}

		const transport = result?.transport ?? null;
		// Record the REAL effect artifact (if the step produced one) so the Oracle
		// can independently re-read it.
		const refId = step.evidence_ref ?? null;
		const path = typeof probePath === "function" ? probePath(step, task) : null;
		const contentDigest = refId && grant.ok && result?.status !== "rejected" ? recordEffectArtifact(refId, path) : null;

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
				evidence_ref: refId,
				rejection_reason:
					result?.ok === true ? null : (result?.reason ?? result?.detail ?? result?.failure_mode ?? "unknown"),
				detail: result?.detail ?? result?.reason ?? null,
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
		if (result?.status === "rejected") {
			return { ok: false, phase: "rejected", error: result.reason, effect_probe: false };
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
		/** Bind the trusted grant before dispatch; models never supply it. */
		bindCampaign(manifest) {
			campaignManifest = manifest;
		},
		/**
		 * Replace the trusted action-plan resolver. C6 uses this to inject the MODEL's
		 * admitted structured decision as the plan, so the ONE Broker Worker executes
		 * it. It never accepts model text: the caller passes a structured plan object.
		 *
		 * @param {ActionPlan|((task: any) => ActionPlan|null)} nextPlan
		 */
		setPlan(nextPlan) {
			plan = nextPlan;
		},
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
						failure_mode:
							stepResult.phase === "rejected"
								? "action_rejected"
								: stepResult.phase === "intent"
									? "intent_not_durable"
									: "result_not_durable",
						audit_degraded: stepResult.phase === "intent" || stepResult.phase === "result",
						detail: stepResult.error,
						effects,
						effect_probe: stepResult.effect_probe === true,
					};
				}
			}
			// A stable outcome_ref: the last recorded artifact ref (or the task id).
			const last = steps.steps[steps.steps.length - 1];
			const outcomeRef = last?.evidence_ref ?? `artifact:${task.task_id}`;
			// The action pin of the LAST executed step: this is what the independent
			// Oracle outcome must carry so a compiled rule pins the SAME action version
			// and implementation digest that actually produced the effect.
			const lastContract = last ? broker.registry?.get(last.action_ref) : null;
			const actionPin = lastContract
				? {
						action_ref: lastContract.id,
						action_version: lastContract.version ?? null,
						implementation_digest: lastContract.implementation_digest ?? null,
						arguments: last.arguments ?? {},
					}
				: null;
			return { ok: true, outcome_ref: outcomeRef, action_pin: actionPin, effects };
		},
		/** Expose the artifact index the Host/Oracle share. */
		artifactIndex,
		readIndex,
	};
}
