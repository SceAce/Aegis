// Aegis learning subcommands — the human/Host-operated half of the learning loop.
//
// This module is deliberately Pi-free so it can be unit-tested directly. The
// Observer extension supplies the trusted wiring (the committed EventLog, the
// registry/broker built from human configuration, a note emitter) and this
// module performs the mechanical steps:
//
//   learn    propose -> bind via the REVIEWED binder; a missing mapping stays a
//            candidate with explicit gaps (never active, never hinted).
//   compile  ONLY the explicitly named, committed proof outcome ids; the reviewed
//            compiler decides active vs candidate. The result is stored AND a
//            `runtime.note` records it (the authoritative record).
//   route    active Experiences only; a resolver-verified current-state ref is
//            required before direct/habit; otherwise hint/deliberate.
//   bind     fill only the reported missing parameters; re-check reaches direct.
//   run      the one broker path (direct) via the selected confirmed Experience.
//   replay   only through a human-configured isolated adapter; the trusted sink
//            commits a genuine reset + replay record.
//
// A model NEVER drives these: they are invoked from the `/aegis` command (a
// human/Host context) or from the launcher. The model may only propose.

import { loadReplayAdapter } from "./learning-bridge.mjs";
import { authoritativeActiveExperiences } from "./learning-store.mjs";

/** Re-exported so the extension imports the whole command surface from one module. */
export { loadReplayAdapter as loadReplayAdapterModule };

export function parseJsonArg(text) {
	if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "expected a JSON argument" };
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return { ok: false, reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Parse `--key value` / `--flag` / repeated `--key` into a map of arrays. */
export function parseFlags(args = []) {
	const flags = {};
	for (let i = 0; i < args.length; i += 1) {
		const token = args[i];
		if (typeof token !== "string" || !token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = args[i + 1];
		if (next === undefined || (typeof next === "string" && next.startsWith("--"))) {
			flags[key] = [...(flags[key] ?? []), true];
		} else {
			flags[key] = [...(flags[key] ?? []), next];
			i += 1;
		}
	}
	return flags;
}

function lastFlag(flags, key) {
	const list = flags[key];
	if (!Array.isArray(list) || list.length === 0) return null;
	return list[list.length - 1];
}

export { lastFlag };

/**
 * Bind a proposal to registered primitives. Never executes, never activates.
 * @returns {{ status, executable, gaps, active:false, proposal }}
 */
export function learn(proposal, bridge) {
	const bound = bridge.bindCandidate(proposal);
	return {
		...bound,
		active: false,
		// A candidate/bound proposal is only a step toward compilation; it is not
		// an Experience and cannot be routed.
		experience: null,
	};
}

/**
 * Compile from EXPLICITLY named committed proof outcome ids.
 *
 * @param {{ proofIds?: string[], bridge?: any, store?: any, argumentsTemplates?: object, experienceId?: string|null, revision?: number, supersedes?: string|null, existingExperiences?: object[], recordedAt?: string|null }} input
 * @returns {Promise<{ ok:boolean, status:string, active:boolean, stored:boolean, content_digest:string|null, experience:object|null, gaps:object[], failures:object[] }>}
 */
export async function compile({
	proofIds = [],
	bridge,
	store,
	argumentsTemplates = {},
	experienceId = null,
	revision = 1,
	supersedes = null,
	existingExperiences = [],
	recordedAt = null,
} = {}) {
	if (!Array.isArray(proofIds) || proofIds.length === 0) {
		return {
			ok: false,
			status: "candidate",
			active: false,
			stored: false,
			content_digest: null,
			experience: null,
			gaps: [
				{ reason: "no committed proof outcome ids were named; a rule is never compiled from a model proposal alone" },
			],
			failures: [],
		};
	}
	const compiled = bridge.compileFromOutcomeIds({
		outcomeIds: proofIds,
		argumentsTemplates,
		existingExperiences,
		supersedes,
		experienceId,
		revision,
	});
	const status = compiled.status === "active" ? "active" : "candidate";
	let stored = false;
	let content_digest = null;
	if (compiled.experience && typeof compiled.experience.experience_id === "string") {
		const saved = await store.save(
			{ ...compiled, experience: { ...compiled.experience, status } },
			{ sourceOutcomeIds: proofIds, recordedAt },
		);
		stored = saved.ok === true;
		content_digest = saved.record?.content_digest ?? null;
	}
	return {
		ok: status === "active",
		status,
		active: status === "active",
		stored,
		content_digest,
		experience: compiled.experience ?? null,
		gaps: compiled.gaps ?? [],
		failures: compiled.failures ?? [],
	};
}

/** Load ACTIVE experiences and route them against a verified current state.
 * @param {{ store?: any, bridge?: any, task?: object, currentState?: object, currentStateRef?: object|null, episodeId?: string|null }} input
 */
export async function route({
	store,
	bridge,
	task = {},
	currentState = undefined,
	currentStateRef = null,
	episodeId = null,
} = {}) {
	const records = await store.loadActive();
	const experiences = authoritativeActiveExperiences(records, bridge.events).map((record) => record.experience);
	const decision = bridge.route({ experiences, task, currentState, currentStateRef, episodeId });
	return { ...decision, active_experiences: experiences.length };
}

/** Bind the reported missing parameters and require the route to reach direct.
 * @param {{ store?: any, bridge?: any, task?: object, currentState?: object, currentStateRef?: object|null, bindings?: object, episodeId?: string|null }} input
 */
export async function bind({
	store,
	bridge,
	task = {},
	currentState = undefined,
	currentStateRef = null,
	bindings = {},
	episodeId = null,
} = {}) {
	const records = await store.loadActive();
	const experiences = authoritativeActiveExperiences(records, bridge.events).map((record) => record.experience);
	return bridge.bindHabit({ experiences, task, currentState, currentStateRef, bindings, episodeId });
}

/** Execute the previously selected confirmed active Experience.
 * @param {{ store?: any, bridge?: any, task?: object, currentState?: object, currentStateRef?: object|null, context?: object, approved?: boolean, episodeId?: string|null, actionEventId?: string|null }} input
 */
export async function run({
	store,
	bridge,
	task = {},
	currentState = undefined,
	currentStateRef = null,
	context = {},
	approved = false,
	episodeId = null,
	actionEventId = null,
} = {}) {
	const records = await store.loadActive();
	const experiences = authoritativeActiveExperiences(records, bridge.events).map((record) => record.experience);
	return bridge.executeDirect({
		experiences,
		task,
		currentState,
		currentStateRef,
		context,
		approved,
		episodeId,
		actionEventId,
	});
}

/**
 * Replay a prior verified outcome through a human-configured ISOLATED adapter.
 * The adapter path comes from configuration (never a model). When unconfigured,
 * this reports "not configured" and performs no replay/no write.
 * @param {{ outcomeId?: string|null, bridge?: any, adapterPath?: string|null, importModule?: Function }} input
 */
export async function replay({ outcomeId, bridge, adapterPath, importModule = undefined } = {}) {
	if (!outcomeId) return { ok: false, configured: false, reason: "replay requires an explicit outcome_id" };
	const loaded = await loadReplayAdapter(adapterPath, { importModule });
	if (loaded.configured !== true) return { ok: false, configured: false, reason: loaded.reason };
	if (!loaded.adapter) return { ok: false, configured: true, reason: loaded.reason };
	// Inject the loaded adapter into THIS call so a bridge that was constructed
	// without a pre-configured replay adapter can still perform the replay through
	// the command's own `adapterPath`. The engine re-validates `isolated`/`replay`.
	const result = await bridge.replayOutcome({ outcomeId, adapter: loaded.adapter });
	return { ...result, configured: true };
}

/** Reduce a bridge/engine result to the fields the command surface reports. */
export function describe(result) {
	if (!result || typeof result !== "object") return { ok: false, reason: "no result" };
	return {
		ok: result.ok === true,
		status: result.status ?? null,
		route: result.route ?? null,
		direct: result.direct === true,
		model_calls: typeof result.model_calls === "number" ? result.model_calls : null,
		reason: result.reason ?? null,
	};
}
