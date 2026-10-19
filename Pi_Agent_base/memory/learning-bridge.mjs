// Aegis learning bridge — the thin adapter between the Observer's COMMITTED
// event log and the D-batch trusted EvidenceResolver / WorkflowEngine.
//
// Background. Two resolver shapes exist and they are NOT interchangeable:
//
//   * Batch C2 / Observer: `createEventRefResolver({events, workspaceRoot,
//     supersededOutcomeIds})` returns `resolveRef({kind, ref})` from
//     `action-runtime.mjs`. It is what the live `aegis_observe`/`aegis_execute`
//     path already uses and it re-checks the workspace target at resolve time.
//   * Batch D: `createEvidenceResolver({events, board, state, scope})` returns
//     `resolveSupport({kind, ref, ref_key})` from `evidence-resolver.mjs`. It
//     verifies the hash chain, indexes full Outcome/Episode/action/artifact/
//     replay records and is the resolver the Compiler/Router/Contribution gates
//     require.
//
// This module EXPLICITLY MAPS between them instead of inventing records or
// trusting a model proposal. It never fabricates an Outcome, a reset, a replay
// or an active Experience: every value comes either from the committed event
// rows or from the reviewed binder. The Observer remains the single writer; this
// bridge only READS the log and returns plain verdict objects.
//
// The bridge does not own any gate. It delegates to the reviewed B2/D modules:
//   * `evidence-resolver.mjs`  -> the one trusted resolver
//   * `workflow-engine.mjs`    -> assess / compile / route / bind / execute
//   * `action-contract.mjs`    -> bindProposal (prose is never parsed)
//
// Nothing here is a new learning concept: `when`/`do`/`expect`/`scope` and the
// evidence gate are the existing contract. `stage_useful` stays association-only.

import { bindProposal } from "../execution/action-contract.mjs";
import { assess, createWorkflowEngine } from "../orchestration/workflow-engine.mjs";
import { projectBoard } from "./board.mjs";
import { createEvidenceResolver, evidenceEnvironment } from "./evidence-resolver.mjs";
import { projectState } from "./state.mjs";

export const LEARNING_BRIDGE_VERSION = "1.0.0";

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function isObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Map a C2-shaped `resolveRef` call to the D `resolveSupport` shape and back.
 *
 * The two shapes differ only in the entry-point name; the D resolver already
 * accepts `{kind, ref}`. This adapter makes the SAME trusted resolver usable by
 * callers that speak the older C2 dialect, so no caller has to fall back to a
 * private Map or a model proposal to obtain a record.
 * @param {{resolveSupport: Function}} resolver a D evidence resolver
 * @returns {(input?: {kind?: string, ref?: {ref_type?: string, type?: string}}) => {ok: boolean, record?: any, content_digest?: string|null, reason?: string}}
 */
export function mapResolveRefToSupport(resolver) {
	if (!resolver || typeof resolver.resolveSupport !== "function") {
		throw new Error("mapResolveRefToSupport requires a D evidence resolver with resolveSupport()");
	}
	return function resolveRef({ kind, ref } = {}) {
		const wanted = kind ?? ref?.ref_type ?? ref?.type ?? null;
		const result = resolver.resolveSupport({ kind: wanted, ref });
		if (!result || result.ok !== true)
			return { ok: false, reason: result?.reason ?? "unresolved", record: null, content_digest: null };
		return { ok: true, record: result.record, content_digest: result.content_digest ?? null };
	};
}

/**
 * Build the ONE trusted production resolver from the committed log + effective
 * board. The board/state default to the projections of the SAME committed rows
 * (never a caller's live Map), so a restarted process rebuilds identical truth.
 *
 * @param {object} input
 * @param {object[]} [input.events] committed EventLog rows (log.replay())
 * @param {object} [input.board] effective board projection (optional)
 * @param {object} [input.state] RuntimeState projection (optional)
 * @param {object} [input.scope] `{task_id?, episode_ids?}` binding (optional)
 * @param {object|null} [input.manifest] trusted Campaign Manifest for shared authority (optional)
 */
export function buildProductionResolver({
	events = [],
	board = null,
	state = null,
	scope = null,
	manifest = null,
} = {}) {
	const rows = asArray(events);
	const effectiveBoard = board ?? projectBoard(rows, { manifest });
	const effectiveState = state ?? projectState(rows);
	const resolver = createEvidenceResolver({ events: rows, board: effectiveBoard, state: effectiveState, scope });
	// The C2 dialect is exposed as a mapping, not a second resolver.
	resolver.resolveRef = mapResolveRefToSupport(resolver);
	return resolver;
}

/**
 * Build the environment object the Compiler/Router need: the ONE resolver plus
 * the current effective view. `renderProofs` is the only route from committed
 * Outcomes to compiler proof descriptors.
 * @param {object} resolver the D evidence resolver
 * @param {{ environment_fingerprint?: string|null, domain?: string|null, permissions?: string[]|null, task_types?: string[]|null, registry?: object|null }} [input]
 */
export function buildLearningEnvironment(
	resolver,
	{ environment_fingerprint = null, domain = null, permissions = null, task_types = null, registry = null } = {},
) {
	return evidenceEnvironment(
		resolver,
		/** @type {any} */ ({ environment_fingerprint, domain, permissions, task_types, registry }),
	);
}

/**
 * Turn one resolved, verified Outcome into a Compiler proof descriptor.
 *
 * Every field is READ FROM THE RESOLVED OUTCOME — never from a caller value and
 * never from a model proposal. The `do.action_version` / `implementation_digest`
 * come from the recorded Outcome, so a changed registration fails the gate
 * rather than being silently accepted.
 *
 * Returns `{ ok:false, reason }` when the Outcome does not resolve.
 * @param {any} resolver
 * @param {string} outcomeId
 * @param {{ argumentsTemplate?: object|null }} [options]
 */
export function proofFromOutcome(resolver, outcomeId, { argumentsTemplate = null } = {}) {
	const resolved = resolver.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: outcomeId } });
	if (resolved.ok !== true) return { ok: false, reason: resolved.reason, outcome_id: outcomeId ?? null };
	const outcome = resolved.record;
	const doSpec = {
		action_ref: outcome.action_ref ?? outcome.oracle?.action_ref ?? null,
		action_version: outcome.action_version ?? null,
		implementation_digest: outcome.implementation_digest ?? null,
		arguments_template: isObject(argumentsTemplate) ? argumentsTemplate : null,
	};
	return {
		ok: true,
		proof: {
			episode_id: outcome.episode_id ?? null,
			outcome_id: outcome.outcome_id,
			do: doSpec,
			when: Array.isArray(outcome.when) ? outcome.when : [],
			scope: outcome.scope ?? null,
		},
		outcome,
	};
}

/**
 * Build the compiler proof list from EXPLICITLY named outcome ids. Only ids the
 * caller names are considered; the bridge never guesses which Outcomes should
 * support a rule. Ids that do not resolve are reported as gaps (their reason),
 * never dropped silently and never replaced by a fabricated record.
 *
 * @returns {{ ok:boolean, proofs:object[], gaps:object[] }}
 * @param {any} resolver
 * @param {string[]} [outcomeIds]
 * @param {{ argumentsTemplates?: object }} [options]
 */
export function proofsFromOutcomeIds(resolver, outcomeIds = [], { argumentsTemplates = {} } = {}) {
	const proofs = [];
	const gaps = [];
	for (const outcomeId of asArray(outcomeIds)) {
		const built = proofFromOutcome(resolver, outcomeId, { argumentsTemplate: argumentsTemplates[outcomeId] ?? null });
		if (built.ok) proofs.push(built.proof);
		else gaps.push({ outcome_id: outcomeId ?? null, reason: built.reason });
	}
	return { ok: gaps.length === 0 && proofs.length > 0, proofs, gaps };
}

/**
 * Collect the compiler proof descriptors for an Experience whose support names
 * outcome ids. This reads the SUPPORT the compiler already recorded (or an
 * explicit list) — it does not re-derive support from prose.
 */
export function proofsFromExperienceSupport(resolver, experience, options = {}) {
	const support = experience?.support ?? {};
	const ids = asArray(support.outcome_ids ?? support.outcomes);
	return { ...proofsFromOutcomeIds(resolver, ids, options), outcome_ids: ids };
}

/**
/**
 * The learning bridge. It holds the trusted resolver + the reviewed engine and
 * exposes the WHOLE tested library surface through one production entry point.
 * The Registry/Broker/Authorization are provided by trusted construction code
 * (the Observer/launcher), never by the model.
 *
 * @param {{ events?: object[], board?: object|null, state?: object|null, scope?: object|null, registry?: object, broker?: object, authorization?: object|null, replayAdapter?: object|null, environment?: object, sink?: object|null, clock?: function }} [input]
 */
export function createLearningBridge({
	events = [],
	board = null,
	state = null,
	scope = null,
	registry,
	broker,
	authorization = null,
	replayAdapter = null,
	environment = {},
	sink = null,
	clock,
} = {}) {
	let currentEvents = asArray(events);
	let resolver = buildProductionResolver({ events: currentEvents, board, state, scope });

	/**
	 * @param {{events?: object[], board?: object, state?: object, scope?: object}} [next]
	 * @returns {object} the rebuilt resolver
	 */
	function refresh({ events: nextEvents, board: nextBoard, state: nextState, scope: nextScope } = {}) {
		if (nextEvents !== undefined) currentEvents = asArray(nextEvents);
		if (board !== undefined && nextBoard !== undefined) board = nextBoard;
		if (state !== undefined && nextState !== undefined) state = nextState;
		if (scope !== undefined && nextScope !== undefined) scope = nextScope;
		resolver = buildProductionResolver({ events: currentEvents, board, state, scope });
		return resolver;
	}

	const environmentObject = () => ({
		environment_fingerprint: /** @type {any} */ (environment).environment_fingerprint ?? null,
		domain: /** @type {any} */ (environment).domain ?? null,
		permissions: /** @type {any} */ (environment).permissions,
		task_types: /** @type {any} */ (environment).task_types,
		registry,
	});

	function makeEngine() {
		if (!registry || !broker) return null;
		// The reviewed engine accepts `sink` (its signature declares it); its JSDoc
		// simply predates the option. The cast keeps our scoped type check honest
		// without editing a D-owned file.
		return createWorkflowEngine(
			/** @type {any} */ ({
				registry,
				broker,
				authorization,
				resolver,
				replayAdapter,
				environment: environmentObject(),
				sink,
				clock,
			}),
		);
	}

	/**
	 * Bind a model/Host proposal to registered primitives. Prose is never parsed.
	 * @param {object} proposal
	 * @param {object} [options]
	 */
	function bindCandidate(proposal, options = {}) {
		const bound = bindProposal(proposal, { registry, ...options });
		return {
			...bound,
			model_text_parsed: false,
			eval_used: false,
			// A candidate is never executable until compiled AND routed.
			active: false,
		};
	}

	/**
	 * Compile from explicitly named outcome ids. Two independent resolved
	 * replayable proofs are still required by the reviewed compiler — the bridge
	 * adds none.
	 */
	function compileFromOutcomeIds({
		outcomeIds = [],
		argumentsTemplates = {},
		existingExperiences = [],
		supersedes = null,
		experienceId = null,
		revision = 1,
		procedure = null,
	} = {}) {
		const engine = makeEngine();
		if (!engine)
			return {
				status: "unavailable",
				ok: false,
				reason: "no registry/broker was configured; compilation is not available",
				proofs: [],
				gaps: [],
			};
		const built = proofsFromOutcomeIds(resolver, outcomeIds, { argumentsTemplates });
		if (built.proofs.length === 0) {
			return {
				status: "candidate",
				ok: false,
				failures: built.gaps.map((gap) => ({
					rule: "proof_resolvable",
					detail: `${/** @type {any} */ (gap).outcome_id}: ${/** @type {any} */ (gap).reason}`,
				})),
				proofs: [],
				gaps: built.gaps,
				experience: null,
			};
		}
		// A reviewed procedure (knowledge-type `do`) replaces the action do-clause
		// on EVERY proof; the compiler validates the digest and 2-proof gate. The
		// action path is unchanged when no procedure is supplied.
		const proofs = procedure ? built.proofs.map((proof) => ({ ...proof, do: procedure })) : built.proofs;
		const compiled = engine.compileExperience({
			proofs,
			existingExperiences,
			supersedes,
			experienceId,
			revision,
		});
		return { ...compiled, proofs, gaps: built.gaps };
	}

	/** Route on active Experiences only; the current state must be resolver-verified. */
	function route({
		experiences = [],
		task = {},
		currentState = undefined,
		currentStateRef = null,
		episodeId = null,
	} = {}) {
		const engine = makeEngine();
		if (!engine)
			return {
				route: "unavailable",
				ok: false,
				reason: "no registry/broker was configured; routing is not available",
				model_calls: 0,
			};
		return engine.routeLearning({ experiences, task, currentState, currentStateRef, episodeId });
	}

	function bindHabit(options = {}) {
		const engine = makeEngine();
		if (!engine)
			return { ok: false, route: "unavailable", reason: "no registry/broker was configured", model_calls: 0 };
		return engine.bindHabit(options);
	}

	function executeDirect(options = {}) {
		const engine = makeEngine();
		if (!engine)
			return Promise.resolve({
				ok: false,
				status: "unavailable",
				reason: "no registry/broker was configured",
				model_calls: 0,
			});
		return engine.executeDirect(options);
	}

	function invokeExploratory(options = {}) {
		const engine = makeEngine();
		if (!engine)
			return Promise.resolve({
				ok: false,
				status: "unavailable",
				reason: "no registry/broker was configured",
				model_calls: 0,
			});
		return engine.invokeExploratory(options);
	}

	function replayOutcome(options = {}) {
		const engine = makeEngine();
		if (!engine)
			return Promise.resolve({ ok: false, reason: "no registry/broker was configured; a replay is never guessed" });
		return engine.replayOutcome(options);
	}

	function recordContribution(input = {}) {
		const engine = makeEngine();
		if (!engine) return { ok: false, reason: "no registry/broker was configured" };
		return engine.recordContribution(input);
	}

	function associateFeedback(input = {}) {
		const engine = makeEngine();
		if (!engine) return { ok: false, reason: "no registry/broker was configured" };
		return engine.associateFeedback(input);
	}

	function usefulness(records = []) {
		const engine = makeEngine();
		if (!engine) return { usable: false, reason: "no registry/broker was configured" };
		return engine.usefulness(records);
	}

	return {
		version: LEARNING_BRIDGE_VERSION,
		get resolver() {
			return resolver;
		},
		get events() {
			return currentEvents;
		},
		resolveSupport: (query) => resolver.resolveSupport(query),
		resolveRef: (query) => resolver.resolveRef(query),
		refresh,
		environment: environmentObject,
		bindCandidate,
		compileFromOutcomeIds,
		proofsFromOutcomeIds: (ids, options) => proofsFromOutcomeIds(resolver, ids, options),
		route,
		bindHabit,
		executeDirect,
		invokeExploratory,
		replayOutcome,
		recordContribution,
		associateFeedback,
		usefulness,
		assess,
	};
}

/**
 * A committed `runtime.note` carrying an isolation/reset reference is the ONLY
 * source the resolver treats as a canonical reset. This helper reports whether a
 * given episode already has such a trusted record, so a caller can tell the
 * human/launcher "no replay adapter -> no independent proof" instead of
 * inventing a UUID. It performs no writes.
 */
export function episodeResetStatus(resolver, episodeId) {
	if (!resolver || typeof resolver.episodeRelation !== "function")
		return { ok: false, reason: "resolver cannot report episode relations" };
	const relation = resolver.episodeRelation(episodeId);
	return {
		ok: relation.ok === true,
		status: relation.status,
		reason: relation.reason,
		isolation_ref: relation.isolation_ref ?? null,
		episode_id: episodeId ?? null,
	};
}

/**
 * Load a human-configured trusted ISOLATED replay adapter module.
 *
 * The path is provided EXPLICITLY by a human/launcher through configuration; it
 * is never read from a model message and the string is never `eval`'d. A module
 * must export an object with `isolated === true`, a string `id`, and a
 * `replay()` procedure. An absent configuration means "unconfigured" (no
 * replay is attempted); a malformed module is refused, never silently ignored.
 * @param {string|null} modulePath
 * @param {{ importModule?: Function }} [options]
 */
export async function loadReplayAdapter(modulePath, { importModule } = {}) {
	if (typeof modulePath !== "string" || !modulePath.trim())
		return { configured: false, adapter: null, reason: "no replay adapter is configured; a replay is never guessed" };
	let mod;
	try {
		if (typeof importModule === "function") {
			mod = await importModule(modulePath);
		} else {
			const { pathToFileURL } = await import("node:url");
			const { resolve } = await import("node:path");
			mod = await import(pathToFileURL(resolve(modulePath)).href);
		}
	} catch (error) {
		return {
			configured: true,
			adapter: null,
			reason: `the replay adapter module could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const candidate = mod?.replayAdapter ?? mod?.default ?? mod;
	if (!isObject(candidate) || candidate.isolated !== true || typeof candidate.replay !== "function") {
		return {
			configured: true,
			adapter: null,
			reason: "the replay adapter module must export { isolated:true, id, replay() }",
		};
	}
	if (typeof candidate.id !== "string" || !candidate.id) {
		return { configured: true, adapter: null, reason: "the replay adapter must declare a non-empty `id`" };
	}
	return { configured: true, adapter: candidate, reason: null };
}
