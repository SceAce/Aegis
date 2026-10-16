// Aegis D: Workflow engine — the coordination layer that binds the reviewed
// batch-B primitives (action contract/broker, learning router, experience
// compiler, contribution) to the ONE trusted evidence resolver, without adding
// a second execution path, a second EventLog, or any model-facing callback.
//
// What this module is NOT:
//   * It is not an executor. The broker is the only execution path; this engine
//     calls it with FINAL, data-only arguments and a re-derived authorization.
//   * It is not a writer. It shapes payloads and hands them to a trusted `sink`
//     (the single EventLog writer) supplied by trusted code at construction.
//     The model can never pass a resolver, a callback, an executable, argv text,
//     or an authorization object.
//   * It never mutates an Experience's life-cycle status or the board. It only
//     reads them and records association notes. Promotion is the Compiler's job.
//
// Coordination responsibilities (D task):
//   * `bindProposal`   explicit predicate/actionRef/checker -> missing gaps or
//                       bound; `do` prose is NEVER parsed/eval'd.
//   * `compileExperience` always uses the ONE real resolver for every gate.
//   * `routeLearning`  passes the verified, EFFECTIVE current state only; an
//                       unverified/foreign/absent state routes to deliberate.
//   * `executeDirect`  broker final args + authorization + pre/post digests,
//                       with 0 model calls.
//   * `bindHabit`      returns the missing-parameter mapping, applies it, and
//                       RE-CHECKS; an invalid/conflicting binding is refused,
//                       never guessed.
//   * `replayOutcome`  only through an explicitly configured trusted isolated
//                       replay adapter; the original target/remote/non-idempotent
//                       script is never re-run.
//   * `assess`         anomalous / unknown exits are classified as unknown, not
//                       success or failure.
//   * `associateFeedback` links a rule revision / action / outcome without a
//                       causal claim; an unknown is never a negative.

import { digest } from "../shared/contracts.mjs";
import { bindProposal as bindProposalContract, validateParameters } from "../execution/action-contract.mjs";
import { compileExperience as compileExperienceGate } from "../memory/experience-compiler.mjs";
import { routeLearning as routeLearningGate } from "../memory/learning-router.mjs";
import { recordStageContribution, dataUsefulness } from "../memory/contribution.mjs";

export const WORKFLOW_VERSION = "1.0.0";

const ANOMALOUS_FAILURE_MODES = new Set(["tool_error", "timeout", "network_error", "proc_guard", "unsafe_target"]);

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function refId(ref) {
	return ref?.ref_id ?? ref?.id ?? null;
}

/** True when an outcome's REAL scope is the rule's scope (environment + domain). */
function scopeCovers(ruleScope, outcomeScope) {
	if (!ruleScope || !outcomeScope || typeof ruleScope !== "object" || typeof outcomeScope !== "object") return false;
	const ruleEnv = ruleScope.environment_fingerprint ?? ruleScope.environment?.environment_fingerprint ?? null;
	const outcomeEnv = outcomeScope.environment_fingerprint ?? outcomeScope.environment?.environment_fingerprint ?? null;
	if (ruleEnv !== outcomeEnv) return false;
	const ruleDomain = ruleScope.domain ?? ruleScope.environment?.domain ?? null;
	const outcomeDomain = outcomeScope.domain ?? outcomeScope.environment?.domain ?? null;
	return ruleDomain === outcomeDomain;
}

/**
 * Classify a broker result honestly.
 *   success  -> the registered Verification read the real post-state and passed.
 *   failure  -> the procedure itself failed (transport/anomaly), not the goal.
 *   unknown  -> the procedure ran but the Oracle did not confirm (or was absent);
 *               an `unknown` is NEVER counted as a success or a failure.
 */
export function assess(result = {}) {
	const status = result.status ?? "unknown";
	const failureMode = result.failure_mode ?? null;
	const transport = result.transport ?? {};
	const anomalous = failureMode !== null && ANOMALOUS_FAILURE_MODES.has(failureMode);
	// The classification follows the VERDICT status alone. An anomaly (timeout,
	// tool error, network error) is transport-level: it is reported as an anomaly
	// but a broker `unknown` is NEVER relabelled as a task failure.
	const classification = status === "success" ? "success" : status === "failure" ? "failure" : "unknown";
	return {
		classification,
		status,
		failure_mode: failureMode,
		anomalous,
		verified: result.verification?.ok === true,
		transport,
		// A zero exit code is transport, never a verdict.
		exit_code: transport.exit_code ?? null,
	};
}

/**
 * Build the workflow engine.
 *
 * @param {object} input
 * @param {object} input.registry        ActionRegistry (reviewed contracts)
 * @param {object} input.broker          createActionBroker({registry}) — the only executor
 * @param {object} [input.authorization] trusted authorization config (auto/normal)
 * @param {object} input.resolver        the ONE trusted evidence resolver
 * @param {object} [input.replayAdapter] trusted isolated-replay adapter (see below)
 * @param {object} [input.environment]   `{environment_fingerprint, domain, permissions, task_types}`
 * @param {function} [input.clock]       optional trusted clock (defaults to Date)
 */
export function createWorkflowEngine({ registry, broker, authorization = null, resolver, replayAdapter = null, sink: configuredSink = null, environment = {}, clock = () => new Date() } = {}) {
	if (!broker || typeof broker.invoke !== "function") throw new Error("createWorkflowEngine requires a broker");
	if (!resolver || typeof resolver.resolveSupport !== "function") throw new Error("createWorkflowEngine requires the trusted evidence resolver");

	const env = {
		environment_fingerprint: environment.environment_fingerprint ?? null,
		domain: environment.domain ?? null,
		permissions: environment.permissions,
		task_types: environment.task_types,
		registry,
		resolveSupport: resolver.resolveSupport,
	};
	const now = () => clock().toISOString();
	// The last confirmed routing decision (direct/habit) this engine produced.
	// executeDirect revalidates it instead of accepting a bare action_ref.
	let lastSelection = null;

	/** Remember a confirmed selection so executeDirect can re-check it later. */
	function rememberSelection(decision, experiences, task, currentState, currentStateRef) {
		if (decision && (decision.route === "direct" || decision.route === "habit")) {
			lastSelection = { decision, experiences, task, currentState, currentStateRef, selected_at: now() };
		}
		return decision;
	}

	/**
	 * Trust a current state ONLY when it is pinned by a resolver-verified
	 * data/snapshot ref whose content digest matches. `chain_ok` is necessary but
	 * NOT sufficient: an arbitrary caller object is never a verified state, and a
	 * missing/absent predicate field stays UNKNOWN (never a silent `neq` match).
	 */
	function resolveVerifiedState({ currentState, currentStateRef }) {
		if (!currentStateRef || typeof currentStateRef !== "object") {
			return { state: null, trusted: false, reason: "no verified current-state ref was supplied; `when` is unknown and the route cannot go direct or habit" };
		}
		const kind = refKind(currentStateRef);
		const resolved = resolver.resolveSupport({ kind, ref: currentStateRef, ref_key: `${kind}:${refId(currentStateRef) ?? ""}` });
		if (!resolved.ok) return { state: null, trusted: false, reason: `the current-state ref did not resolve: ${resolved.reason}` };
		const pinnedDigest = currentStateRef.digest ?? resolved.content_digest ?? null;
		if (typeof pinnedDigest !== "string" || !pinnedDigest) return { state: null, trusted: false, reason: "the current-state ref carries no content digest to verify against" };
		if (currentState === undefined || currentState === null) return { state: null, trusted: false, reason: "a verified current-state ref was supplied without the state value it pins" };
		if (digest(currentState) !== pinnedDigest) return { state: null, trusted: false, reason: "the supplied current state does not match the verified current-state ref digest" };
		return { state: currentState, trusted: true, reason: "the supplied current state matches the resolver-verified data/snapshot ref", ref: resolved.record };
	}

	/**
	 * Explicit proposal binding. Delegates to the reviewed contract binder so
	 * prose `do` is never parsed and a wildcard/missing field is a gap. This
	 * engine adds NO new parsing.
	 */
	function bindProposal(proposal, options = {}) {
		const bound = bindProposalContract(proposal, { registry, ...options });
		return { ...bound, model_text_parsed: false, eval_used: false };
	}

	/**
	 * Compile through the real resolver for EVERY gate. This engine cannot supply
	 * candidate-only sufficiency: the resolver decides whether each proof is real.
	 */
	function compileExperience({ proofs = [], existingExperiences = [], supersedes = null, experienceId = null, revision = 1, createdAt = null, updatedAt = null } = {}) {
		if (!resolver.chain_ok) {
			return { status: "candidate", ok: false, failures: [{ rule: "chain_invalid", detail: `the committed event chain is not verified: ${resolver.errors.join("; ")}` }], experience: null };
		}
		const supersededOutcomeIds = resolver.supersededOutcomeIds;
		return compileExperienceGate({
			proofs,
			environment: env,
			existingExperiences,
			resolveSupport: resolver.resolveSupport,
			supersededOutcomeIds,
			supersedes,
			experienceId,
			revision,
			createdAt,
			updatedAt,
		});
	}

	/**
	 * Route learning. The current state is trusted ONLY when a verified
	 * data/snapshot ref pins it (see `resolveVerifiedState`); `chain_ok` alone is
	 * never enough. A caller may name an episode for bookkeeping, but without a
	 * verified state ref the router is given NO state (so a `when` predicate is
	 * UNKNOWN, never a silent match).
	 */
	function routeLearning({ experiences = [], task = {}, currentState = undefined, currentStateRef = null, episodeId = null } = {}) {
		const verifiedState = resolveVerifiedState({ currentState, currentStateRef });
		// New candidates are never eligible to hint/direct; the router enforces
		// this, but we also drop non-active experiences from the hint surface.
		const routable = experiences.filter((experience) => experience && experience.status === "active");
		const decision = routeLearningGate({
			experiences: routable,
			task,
			environment: env,
			currentState: verifiedState.trusted ? verifiedState.state : null,
			registry,
			resolveSupport: resolver.resolveSupport,
		});
		rememberSelection(decision, routable, task, currentState, currentStateRef);
		return {
			...decision,
			state_trusted: verifiedState.trusted,
			state_ref: verifiedState.ref ?? null,
			state_reason: verifiedState.reason,
			candidates_filtered: experiences.length - routable.length,
			model_calls: 0,
		};
	}

	/**
	 * The one broker call. The CALLER PATH labels the result; the broker call
	 * itself is identical, so there is never a second execution path.
	 */
	async function runBroker({ action_ref, arguments: args = {}, episodeId = null, actionEventId = null, approved = false, context = {}, currentState = null } = {}) {
		const contract = registry.get(action_ref);
		if (!contract) return { ok: false, status: "rejected", reason: `unknown action: ${String(action_ref)}`, model_calls: 0 };
		const effectiveAuth = authorization ? { ...authorization, approved: authorization.mode === "normal" ? approved === true : authorization.approved } : null;
		if (!effectiveAuth) return { ok: false, status: "rejected", reason: "no authorization config; the engine never executes un-authorized", model_calls: 0 };
		const preStateDigest = currentState === null || currentState === undefined ? null : digest(currentState);
		const result = await broker.invoke({ action_ref: contract.id, arguments: args, context: { ...context, episode_id: episodeId, action_event_id: actionEventId }, authorization: effectiveAuth, state: currentState ?? {} });
		const classification = assess(result);
		const observed = result.observation?.value ?? result.step_outcome?.observed ?? null;
		return {
			...result,
			classification: classification.classification,
			anomalous: classification.anomalous,
			pre_state_digest: preStateDigest,
			post_state_digest: observed === null ? null : digest(observed),
			model_calls: 0,
		};
	}

	/**
	 * Deliberate/exploratory execution. There is NO confirmed active Experience
	 * for this task, so the broker is used for deliberate exploration only. The
	 * result is explicitly labeled `route: "exploratory"` and NEVER claims to be a
	 * reused direct rule.
	 */
	async function invokeExploratory(options = {}) {
		const result = await runBroker(options);
		return { ...result, route: "exploratory", direct: false, explored: true };
	}

	/**
	 * The direct path: reuse a PREVIOUSLY SELECTED, confirmed active Experience.
	 * A bare `action_ref` is never accepted as a direct rule — the engine
	 * re-validates the confirmed selection against the CURRENT verified state
	 * (when/params) and the registered contract before it calls the broker. Use
	 * `invokeExploratory` for deliberate execution without a selected rule.
	 */
	async function executeDirect({ decision = null, experience = null, experience_id = null, experiences = null, task = {}, currentState = undefined, currentStateRef = null, action_ref: requestedActionRef = null, arguments: requestedArgs = null, context = {}, approved = false, episodeId = null, actionEventId = null } = {}) {
		let selection = null;
		if (decision && decision.route) {
			selection = { decision, experiences: Array.isArray(experiences) ? experiences : lastSelection?.experiences ?? null, task, currentState, currentStateRef };
		} else if (experience || experience_id || Array.isArray(experiences)) {
			const pool = Array.isArray(experiences) ? experiences : experience ? [experience] : lastSelection?.experiences ?? [];
			selection = { decision: null, experiences: pool, task, currentState, currentStateRef };
		} else if (lastSelection) {
			selection = lastSelection;
		}
		if (!selection || !Array.isArray(selection.experiences) || selection.experiences.length === 0) {
			return { ok: false, status: "rejected", route: "unselected", direct: false, reason: "executeDirect requires a previously selected confirmed active Experience; call routeLearning/bindHabit first or use invokeExploratory for deliberate execution", model_calls: 0 };
		}
		const selectionTask = selection.task ?? {};
		const stateToUse = currentState !== undefined ? currentState : selection.currentState;
		const refToUse = currentStateRef ?? selection.currentStateRef ?? null;
		// FINAL REVALIDATION against the current verified state (when/params) and
		// the registered contract version/implementation/authorization.
		const recheck = routeLearning({ experiences: selection.experiences, task: selectionTask, currentState: stateToUse, currentStateRef: refToUse });
		if (recheck.route !== "direct") {
			return { ok: false, status: "rejected", route: recheck.route, direct: false, reason: `the confirmed selection no longer routes to direct (${recheck.route}: ${recheck.reason})`, recheck, model_calls: 0 };
		}
		const chosenActionRef = recheck.action_ref ?? selection.decision?.action_ref ?? null;
		const chosenArgs = recheck.arguments ?? selection.decision?.arguments ?? {};
		const contract = chosenActionRef ? registry.get(chosenActionRef) : null;
		if (!contract) return { ok: false, status: "rejected", route: "direct", direct: true, reason: `the selected action ${String(chosenActionRef)} is not registered`, model_calls: 0 };
		if (requestedActionRef !== null && requestedActionRef !== undefined && requestedActionRef !== chosenActionRef) {
			return { ok: false, status: "rejected", route: "direct", direct: true, reason: `the requested action ${String(requestedActionRef)} is not the selected confirmed action ${String(chosenActionRef)}`, model_calls: 0 };
		}
		if (requestedArgs !== null && requestedArgs !== undefined && digest(requestedArgs) !== digest(chosenArgs)) {
			return { ok: false, status: "rejected", route: "direct", direct: true, reason: "the requested arguments do not match the confirmed selection; re-plan or re-bind", model_calls: 0 };
		}
		const result = await runBroker({ action_ref: chosenActionRef, arguments: chosenArgs, episodeId, actionEventId, approved, context, currentState: stateToUse ?? null });
		return { ...result, route: "direct", direct: true };
	}

	/**
	 * Habit binding: the router fixed the path; the model may ONLY fill the
	 * missing parameters. We merge the supplied data-only bindings, validate the
	 * full argument set against the contract, and RE-CHECK that the route became
	 * `direct`. A conflicting or wrong-typed binding is refused, never guessed.
	 */
	function bindHabit({ experiences = [], task = {}, episodeId = null, currentState = undefined, currentStateRef = null, bindings = {} } = {}) {
		const first = routeLearning({ experiences, task, episodeId, currentState, currentStateRef });
		if (first.route !== "habit") return { ok: false, route: first.route, reason: `habit binding requested but the route is ${first.route}`, missing_parameters: first.missing_parameters ?? [], recheck: null, model_calls: 0 };
		const experience = first.experience;
		const doSpec = experience?.do ?? {};
		const contract = registry.get(doSpec.action_ref);
		if (!contract) return { ok: false, route: "habit", reason: `the habit action ${String(doSpec.action_ref)} is not registered`, missing_parameters: first.missing_parameters, recheck: null, model_calls: 0 };

		// Rebuild the FULL argument set from the template + the task arguments +
		// the model's bindings. Only the declared missing parameters may be filled.
		const template = isPlainObject(doSpec.arguments_template) ? doSpec.arguments_template : {};
		const merged = { ...template, ...(isPlainObject(task.arguments) ? task.arguments : {}) };
		const provided = isPlainObject(bindings) ? bindings : {};
		const unexpected = Object.keys(provided).filter((name) => !first.missing_parameters.includes(name));
		if (unexpected.length > 0) {
			return { ok: false, route: "habit", reason: `bindings may only fill the reported missing parameters (${first.missing_parameters.join(", ") || "none"}); unexpected: ${unexpected.join(", ")}`, missing_parameters: first.missing_parameters, recheck: null, model_calls: 0 };
		}
		for (const [name, value] of Object.entries(provided)) merged[name] = value;
		const argCheck = validateParameters(contract.parameters, merged, "arguments");
		if (!argCheck.ok) {
			return { ok: false, route: "habit", reason: `the bound arguments are invalid: ${argCheck.reasons.join("; ")}`, missing_parameters: first.missing_parameters, recheck: null, model_calls: 0 };
		}

		// RE-CHECK: with the bindings supplied, the route must become direct.
		const recheck = routeLearning({ experiences, task: { ...task, arguments: merged }, episodeId, currentState, currentStateRef });
		if (recheck.route !== "direct") {
			return { ok: false, route: "habit", reason: `the re-check did not reach direct (got ${recheck.route}: ${recheck.reason})`, arguments: merged, missing_parameters: first.missing_parameters, recheck, model_calls: 0 };
		}
		return { ok: true, route: "direct", action_ref: contract.id, arguments: merged, experience_id: experience.experience_id ?? null, recheck, model_calls: 0 };
	}

	/**
	 * Perform a genuine ISOLATED replay of a prior verified outcome through the
	 * trusted adapter configured at construction. Never re-runs the original
	 * target/remote script.
	 *
	 * The adapter must be marked `isolated: true`, receive the prior REAL
	 * pre-state/arguments/criterion READ FROM THE RESOLVED OUTCOME (a caller
	 * snapshot is never used), rebuild a FRESH local temp state, and return
	 * `{ok, replay_hash, replay_count>=1, pre_state_digest, post_state_digest,
	 * implementation_digest, criterion_verified|verification.ok, transport}`.
	 * The engine writes an `episode.isolated_reset` + `replay.performed` note
	 * through the trusted `sink` (single EventLog writer) and only reports `ok`
	 * when BOTH writes are awaited and confirmed `ok && durable`.
	 */
	async function replayOutcome({ outcomeId, episodeId = null, sink = configuredSink, adapter: adapterOverride = null } = {}) {
		const adapter = adapterOverride ?? replayAdapter;
		if (typeof adapter !== "object" || adapter === null) return { ok: false, reason: "no trusted isolated replay adapter is configured; a replay is never guessed" };
		if (adapter.isolated !== true) return { ok: false, reason: "the replay adapter is not marked isolated; refusing" };
		if (typeof adapter.replay !== "function") return { ok: false, reason: "the configured replay adapter has no replay() procedure" };
		const resolved = resolver.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: outcomeId } });
		if (!resolved.ok) return { ok: false, reason: `the outcome to replay did not resolve: ${resolved.reason}` };
		const outcome = resolved.record;
		if (outcome.status !== "success") return { ok: false, reason: `only a verified success may be replayed (status ${outcome.status})` };
		if (outcome.source_kind === "llm") return { ok: false, reason: "an llm outcome is never replayed" };
		const actionRefId = outcome.action_ref ?? outcome.oracle?.action_ref ?? null;
		const contract = actionRefId ? registry.get(actionRefId) : null;
		if (!contract) return { ok: false, reason: `the outcome's action ${String(actionRefId)} is not a registered contract; refusing to replay` };
		// A changed implementation must be RE-VERIFIED, never replayed as the old rule.
		if (outcome.implementation_digest && outcome.implementation_digest !== contract.implementation_digest) {
			return { ok: false, reason: "the registered implementation changed since the outcome was recorded; re-verification (not replay) is required", version_changed: true };
		}
		if (!outcome.criterion || typeof outcome.criterion !== "object") return { ok: false, reason: "the outcome has no pinned criterion; a replay cannot be judged against it" };
		// The inputs are pinned from the RESOLVED outcome record. A caller-supplied
		// snapshot is never accepted as the prior real pre-state.
		const args = outcome.observed?.arguments ?? outcome.arguments ?? null;
		if (!args || typeof args !== "object") return { ok: false, reason: "the outcome has no recorded arguments; the replay inputs cannot be pinned" };
		const preState = outcome.observed?.pre_state ?? outcome.pre_state ?? null;
		if (preState === undefined || preState === null) return { ok: false, reason: "the outcome has no recorded prior pre-state; a fresh isolated state cannot be rebuilt" };
		const argsDigest = digest(args);
		const priorPreStateDigest = digest(preState);
		// A caller may never attribute an outcome to a foreign episode.
		if (episodeId !== null && episodeId !== undefined && outcome.episode_id !== null && outcome.episode_id !== undefined && episodeId !== outcome.episode_id) {
			return { ok: false, reason: `refusing to replay outcome ${outcomeId} under a foreign episode ${episodeId} (the outcome belongs to ${outcome.episode_id})` };
		}
		const ep = episodeId ?? outcome.episode_id ?? null;
		const replayId = `replay:${ep}:${outcomeId}`;
		// Idempotency: a committed replay for this outcome+episode already exists, so
		// the adapter is NOT re-run and no duplicate record is appended.
		const prior = resolver.resolveSupport({ kind: "replay", ref: { ref_type: "replay", ref_id: replayId } });
		if (prior.ok) {
			return { ok: true, replay_id: replayId, duplicated: true, reason: "this outcome+episode already has a committed isolated replay; no new execution was performed", existing: prior.record };
		}

		let replayed;
		try {
			replayed = await adapter.replay({
				adapter_id: adapter.id ?? null,
				action_ref: actionRefId,
				action_version: outcome.action_version ?? contract.version,
				contract,
				arguments: args,
				arguments_digest: argsDigest,
				priorPreState: preState,
				priorPreStateDigest,
				criterion: outcome.criterion,
				episodeId: ep,
				outcomeId,
			});
		} catch (error) {
			return { ok: false, reason: `the isolated replay adapter threw: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!replayed || replayed.ok !== true) return { ok: false, reason: replayed?.reason ?? "the isolated replay did not verify" };
		if (replayed.isolated !== true) return { ok: false, reason: "the adapter did not report an isolated execution" };
		// The adapter report must be pinned to the SAME action/impl/args/pre/post
		// and criterion as the resolved outcome. A mismatch is a different procedure.
		if (replayed.action_ref !== undefined && replayed.action_ref !== null && replayed.action_ref !== actionRefId) return { ok: false, reason: "the replay adapter ran a different action_ref" };
		if (replayed.implementation_digest !== undefined && replayed.implementation_digest !== null && replayed.implementation_digest !== contract.implementation_digest) return { ok: false, reason: "the replay adapter implementation digest does not match the pinned contract" };
		if (replayed.arguments_digest !== undefined && replayed.arguments_digest !== null && replayed.arguments_digest !== argsDigest) return { ok: false, reason: "the replay adapter arguments do not match the pinned outcome arguments" };
		if (replayed.pre_state_digest !== priorPreStateDigest) return { ok: false, reason: "the replay pre-state does not match the prior real pre-state digest" };
		if (typeof replayed.post_state_digest !== "string" || replayed.post_state_digest.length === 0) return { ok: false, reason: "the replay reported no post-state digest" };
		const criterionOk = replayed.criterion_verified === true || replayed.verification?.ok === true;
		if (!criterionOk) return { ok: false, reason: "the replay did not re-verify the pinned criterion" };
		if (!(Number.isInteger(replayed.replay_count) && replayed.replay_count >= 1)) return { ok: false, reason: "the replay count is < 1" };
		if (typeof replayed.replay_hash !== "string" || replayed.replay_hash.length === 0) return { ok: false, reason: "the replay produced no replay_hash" };
		if (typeof replayed.isolation_ref !== "string" || !replayed.isolation_ref.trim()) return { ok: false, reason: "the replay adapter reported no non-empty isolation_ref; a fresh isolated reset identity is required" };
		if (!sink || typeof sink.append !== "function") return { ok: false, reason: "no trusted sink is available; the replay is not committed and is not reported as a durable replay" };

		const source = { actor_id: "aegis-workflow", kind: "replay", adapter: adapter.id ?? "workflow-replay", version: WORKFLOW_VERSION };
		const resetPayload = {
			kind: "episode.isolated_reset",
			episode_id: ep,
			run_id: outcome.run_id ?? null,
			independence_group: outcome.oracle?.independence_group ?? null,
			isolation_ref: replayed.isolation_ref ?? null,
			adapter: adapter.id ?? null,
			pre_state_digest: priorPreStateDigest,
			post_state_digest: replayed.post_state_digest ?? null,
			recorded_at: now(),
		};
		const replayPayload = {
			kind: "replay.performed",
			replay_id: replayId,
			outcome_id: outcomeId,
			episode_id: ep,
			replayable: true,
			replay_count: replayed.replay_count,
			replay_hash: replayed.replay_hash,
			isolated: true,
			adapter: adapter.id ?? null,
			pre_state_digest: priorPreStateDigest,
			post_state_digest: replayed.post_state_digest ?? null,
			implementation_digest: replayed.implementation_digest ?? outcome.implementation_digest ?? null,
			transport: replayed.transport ?? null,
			recorded_at: now(),
		};
		// Single-writer durability: await the EventLog-shaped append and require
		// BOTH `ok` and `durable`. A failed/partial write never reports `ok`.
		const resetResult = await sink.append({ event_type: "runtime.note", episode_id: ep, payload: resetPayload, source });
		if (!resetResult || resetResult.ok !== true || resetResult.durable !== true) {
			return { ok: false, reason: `the isolated-reset record was not durably committed: ${resetResult?.error ?? "the sink did not confirm ok/durable"}`, reset: resetPayload, replay: replayPayload };
		}
		const replayResult = await sink.append({ event_type: "runtime.note", episode_id: ep, payload: replayPayload, source });
		if (!replayResult || replayResult.ok !== true || replayResult.durable !== true) {
			return { ok: false, reason: `the replay record was not durably committed: ${replayResult?.error ?? "the sink did not confirm ok/durable"}`, reset: resetPayload, replay: replayPayload };
		}
		return {
			ok: true,
			replay_id: replayId,
			isolated: true,
			adapter: adapter.id ?? null,
			reset_event_id: resetResult.event?.event_id ?? null,
			replay_event_id: replayResult.event?.event_id ?? null,
			reset: resetPayload,
			replay: replayPayload,
		};
	}

	/**
	 * Association-only contribution. Delegates to the reviewed contribution gate
	 * with the ONE resolver; the engine adds no success claim.
	 */
	function recordContribution(input = {}) {
		return recordStageContribution({ ...input, resolveSupport: resolver.resolveSupport, supersededOutcomeIds: resolver.supersededOutcomeIds });
	}

	/**
	 * Feedback = an association between a rule revision, an Action and an
	 * Outcome. NEVER causal, and `unknown` is never counted as a negative. A
	 * trusted scope change or a verified counterexample keeps the candidate (or
	 * pauses a binding); it does not silently retire a method.
	 */
	function associateFeedback({ experience_id = null, actionRef = null, outcomeRef = null, experience = null, kind = "association", scopeChange = false, counterexample = false, note = null } = {}) {
		const resolvedAction = actionRef ? resolver.resolveSupport({ kind: refKind(actionRef), ref: actionRef }) : { ok: false };
		const resolvedOutcome = outcomeRef ? resolver.resolveSupport({ kind: "outcome", ref: outcomeRef }) : { ok: false };
		const actionRecord = resolvedAction.ok ? resolvedAction.record : null;
		const outcomeRecord = resolvedOutcome.ok ? resolvedOutcome.record : null;
		const outcomeStatus = outcomeRecord ? outcomeRecord.status : "unknown";
		const trustedOutcome = resolvedOutcome.ok && Boolean(outcomeRecord.oracle && (outcomeRecord.oracle.oracle_id || outcomeRecord.oracle.method));

		// Resolve the rule revision the feedback is about. Unknown/timeout is never
		// a negative; a counterexample needs the SAME episode action + Outcome with
		// a matching contract/version/scope and a real postcondition failure.
		const rule = experience ?? (Array.isArray(experience_id) ? experience_id[0] : null);
		const ruleExperienceId = experience_id ?? rule?.experience_id ?? null;
		const sameEpisode = Boolean(actionRecord && outcomeRecord && actionRecord.episode_id && actionRecord.episode_id === outcomeRecord.episode_id);
		const contractMatches = Boolean(actionRecord && outcomeRecord && actionRecord.action_ref && actionRecord.action_ref === (outcomeRecord.action_ref ?? outcomeRecord.oracle?.action_ref ?? null));
		const actionVersion = actionRecord?.action_version ?? actionRecord?.version ?? null;
		const outcomeVersion = outcomeRecord?.action_version ?? outcomeRecord?.version ?? null;
		const versionMatches = Boolean(actionRecord && outcomeRecord && actionVersion !== null && outcomeVersion !== null && actionVersion === outcomeVersion);
		const implMatches = Boolean(actionRecord && outcomeRecord && actionRecord.implementation_digest && outcomeRecord.implementation_digest && actionRecord.implementation_digest === outcomeRecord.implementation_digest);
		const ruleScope = rule?.scope ?? experience_id?.scope ?? null;
		const outcomeScope = outcomeRecord?.scope ?? outcomeRecord?.environment ?? null;
		const scopeMatches = ruleScope === null || outcomeScope === null ? false : scopeCovers(ruleScope, outcomeScope);
		const preconditionsVerified = outcomeRecord?.preconditions_verified === true || actionRecord?.preconditions_verified === true;
		const postconditionFailed = outcomeRecord?.failure_mode === "postcondition_failed" || outcomeRecord?.postcondition_failed === true;
		const counterexampleContract = sameEpisode && contractMatches && versionMatches && (implMatches || !actionRecord?.implementation_digest || !outcomeRecord?.implementation_digest) && scopeMatches && preconditionsVerified && postconditionFailed;
		const verifiedCounterexample = Boolean(counterexample) && trustedOutcome && outcomeStatus === "failure" && counterexampleContract;
		const checks = {
			same_episode: sameEpisode,
			contract_matches: contractMatches,
			version_matches: versionMatches,
			implementation_matches: implMatches,
			scope_matches: scopeMatches,
			preconditions_verified: preconditionsVerified,
			postcondition_failed: postconditionFailed,
			trusted_outcome: trustedOutcome,
			status_failure: outcomeStatus === "failure",
		};
		return {
			kind,
			experience_id: ruleExperienceId,
			action_ref: actionRecord ? actionRecord.action_ref ?? refId(actionRef) : null,
			action_resolved: resolvedAction.ok,
			outcome_ref: outcomeRef ?? null,
			outcome_resolved: resolvedOutcome.ok,
			outcome_status: outcomeStatus,
			trusted_outcome: trustedOutcome,
			scope_change: Boolean(scopeChange),
			counterexample_checks: checks,
			verified_counterexample: verifiedCounterexample,
			// A bare unknown never counts as a negative success/failure.
			counts_as_negative: verifiedCounterexample,
			pause_recommended: Boolean(scopeChange) || verifiedCounterexample,
			causal: false,
			association_only: true,
			note,
			recorded_at: now(),
		};
	}

	/** Expose usefulness over already-recorded contributions (read-only). */
	function usefulness(records = []) {
		return dataUsefulness(records);
	}

	return {
		version: WORKFLOW_VERSION,
		registry,
		broker,
		resolver,
		environment: env,
		replayAdapter,
		bindProposal,
		compileExperience,
		routeLearning,
		executeDirect,
		invokeExploratory,
		bindHabit,
		replayOutcome,
		recordContribution,
		associateFeedback,
		usefulness,
		get last_selection() {
			return lastSelection ? { ...lastSelection } : null;
		},
	};
}

function refKind(ref) {
	return ref?.ref_type ?? ref?.type ?? "action";
}

/**
 * The resolver object the engine requires. Provided as a convenience so trusted
 * construction code can build the engine from a committed log in one call.
 */
export function createWorkflowResolver(resolver) {
	return { resolveSupport: (query) => resolver.resolveSupport(query), chain_ok: resolver.chain_ok, errors: resolver.errors, state: resolver.state, supersededOutcomeIds: resolver.supersededOutcomeIds };
}
