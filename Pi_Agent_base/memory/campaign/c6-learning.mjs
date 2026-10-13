// Aegis C6-C — Campaign experience closed loop.
//
// Wires the REAL Campaign evidence (action/data/artifact/Outcome) into the
// EXISTING learning bridge / router / compiler / store. It creates no second
// learning framework:
//
//   * the resolver is rebuilt from the COMMITTED stream every call;
//   * an isolated replay is performed ONLY through a human-configured adapter;
//   * the Compiler is called ONLY when the trusted Host policy is `explicit` and
//     a non-empty proof id list is named, and `promote_experience` stays false;
//   * the derived store is rebuildable from the committed `runtime.note`
//     (`experience.compiled`) records, never a second truth source;
//   * the Router runs BEFORE any model planning: `direct` yields zero planning
//     requests, `habit` fills only the reported missing parameters and re-checks.
//
// A `candidate` is never a hint, never active, and never reaches the model as
// experience. Conflict / environment change / anomaly stay visible and exit the
// shortcut.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { projectBoard } from "../runtime/board.mjs";
import { createLearningBridge } from "../runtime/learning-bridge.mjs";
import { compile as compileCommand, replay as replayCommand } from "../runtime/learning-commands.mjs";
import { authoritativeActiveExperiences, createLearningStore } from "../runtime/learning-store.mjs";
import { projectState } from "../runtime/state.mjs";

export const C6_LEARNING_VERSION = "1.0.0";

/**
 * Build the learning bridge over the committed stream. The registry/broker/
 * authorization come from the SAME assembled Host, so a compiled proof resolves
 * against the real contracts.
 *
 * @param {{events: any[], registry: any, broker: any, authorization: any, environment?: object, sink: any, scope?: object|null}} args
 */
export function buildCampaignLearningBridge({
	events,
	registry,
	broker,
	authorization,
	environment = {},
	sink,
	scope = null,
}) {
	const board = projectBoard(events);
	const state = projectState(events);
	return createLearningBridge({
		events,
		board,
		state,
		scope,
		registry,
		broker,
		authorization,
		environment,
		sink,
	});
}

/**
 * Derive the ACTIVE experiences from the committed authoritative notes plus the
 * derived store. A store record that does not align to a committed
 * `experience.compiled` note is excluded (tamper/stale never routes).
 *
 * @param {{store: any, events: any[]}} args
 */
export async function loadAuthoritativeExperiences({ store, events }) {
	const records = await store.loadActive();
	return authoritativeActiveExperiences(records, events).map((record) => record.experience);
}

/**
 * Called at the Host's explicit learning boundary. It compiles ONLY when the
 * policy is `explicit` and proof ids are named; otherwise it reports why it did
 * nothing. `promote_experience` must be false (the candidate/active status comes
 * from the reviewed compiler, never from this caller).
 *
 * @param {{
 *   policy: "off"|"shadow"|"explicit",
 *   proofIds?: string[],
 *   promoteExperience?: boolean,
 *   existingExperiences?: object[],
 *   supersedes?: string|null,
 *   experienceId?: string|null,
 *   revision?: number,
 * }} args
 * @returns {Promise<{ok: boolean, status: string, reason?: string, active?: boolean, stored?: boolean, experience?: object|null, gaps?: object[], failures?: object[]}>}
 */
export async function runCampaignLearningStep(
	{
		policy = "off",
		proofIds = [],
		promoteExperience = false,
		existingExperiences = [],
		supersedes = null,
		experienceId = null,
		revision = 1,
	} = /** @type {any} */ ({}),
) {
	if (promoteExperience === true) {
		return { ok: false, status: "refused", reason: "promote_experience must remain false in C6" };
	}
	if (policy === "off") return { ok: false, status: "disabled", reason: "learning policy is off" };
	if (policy === "shadow") {
		// Shadow records nothing active; it only exercises the pipeline read-only.
		return { ok: false, status: "shadow", reason: "shadow policy does not compile or store an active experience" };
	}
	if (!Array.isArray(proofIds) || proofIds.length === 0) {
		return { ok: false, status: "candidate", reason: "explicit policy requires named proof ids" };
	}
	return { ok: true, status: "ready", proofIds, existingExperiences, supersedes, experienceId, revision };
}

/**
 * Route BEFORE the model plans a task. `direct` means zero planning requests;
 * `habit` means the model may only fill the missing parameters; anything else
 * means full deliberative planning. The decision is read-only.
 *
 * @param {{
 *   bridge: any, experiences: object[], task: object,
 *   currentState?: object, currentStateRef?: object|null, episodeId?: string|null,
 * }} args
 */
export function routeBeforeModel(
	{
		bridge,
		experiences = [],
		task = {},
		currentState = undefined,
		currentStateRef = null,
		episodeId = null,
	} = /** @type {any} */ ({}),
) {
	const decision = bridge.route({ experiences, task, currentState, currentStateRef, episodeId });
	return {
		...decision,
		// A deliberate/hint route means the model plans; direct/habit do not.
		needs_model_planning: decision.route === "deliberate" || decision.route === "hint" || decision.route === "paused",
		planning_requests: decision.route === "direct" ? 0 : decision.route === "habit" ? 0 : 1,
	};
}

/**
 * Compile a rule from explicit proof ids through the reviewed compiler + store.
 * This is the ONLY path that may reach `active`; it is driven by the Host policy.
 *
 * @param {{policy, proofIds, bridge, store, existingExperiences?, supersedes?, experienceId?, revision?, argumentsTemplates?}} args
 */
export async function compileExperienceFromProofs(
	{
		policy = "off",
		proofIds = [],
		bridge,
		store,
		existingExperiences = [],
		supersedes = null,
		experienceId = null,
		revision = 1,
		argumentsTemplates = {},
	} = /** @type {any} */ ({}),
) {
	const gate = await runCampaignLearningStep({
		policy,
		proofIds,
		existingExperiences,
		supersedes,
		experienceId,
		revision,
	});
	if (gate.ok !== true) return gate;
	const compiled = await compileCommand({
		proofIds,
		bridge,
		store,
		argumentsTemplates,
		experienceId,
		revision,
		supersedes,
		existingExperiences,
	});
	return { ...compiled, policy };
}

/**
 * Perform a REAL isolated reset/replay for one committed outcome through a
 * human-configured adapter module. Independence is proven by the adapter's own
 * `isolated:true` and a committed replay note.
 *
 * @param {{bridge: any, outcomeId: string, adapterPath: string|null}} args
 */
export async function replayCommittedOutcome({ bridge, outcomeId, adapterPath = null } = /** @type {any} */ ({})) {
	return replayCommand({ outcomeId, bridge, adapterPath });
}

/**
 * Rebuild the derived experience store from the committed authoritative notes.
 * Deleting the store loses nothing: this re-derives it from the source records.
 *
 * @param {{store: any, events: any[]}} args
 */
export async function rebuildExperienceStore({ store, events }) {
	let rebuilt = 0;
	for (const event of events) {
		const payload = event?.payload;
		if (!payload || payload.kind !== "experience.compiled") continue;
		if (payload.active !== true) continue;
		if (typeof payload.experience !== "object" || payload.experience === null) continue;
		const saved = await store.save(
			{ experience: payload.experience, failures: [] },
			{ sourceOutcomeIds: payload.source_outcome_ids ?? [], recordedAt: event.recorded_at ?? null },
		);
		if (saved.ok) rebuilt += 1;
	}
	return { ok: true, rebuilt };
}

/** Build the derived learning store under a run directory. */
export function createCampaignLearningStore(workDir) {
	return createLearningStore({ dir: join(workDir, "experiences") });
}

/** Read the committed stream rows (used to rebuild the store). */
export function readCommittedEvents(eventLogPath) {
	try {
		return readFileSync(eventLogPath, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}
