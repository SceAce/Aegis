// Thin Host helper for an Aegis short-session handoff.
//
// The Observer stages a handoff when the model calls `aegis_switch_session`, and
// the new session's own `session_start` records `handoff.completed`. This helper
// is the small piece the HOST owns: after the current agent batch has settled, it
// re-validates the staged request against the committed Events and applies it
// through the real `AgentSessionRuntime.newSession` path. It keeps no runtime
// state and never trusts the staged JSON: a closed episode, a moved task, or an
// unfinished action all refuse the switch. It is deliberately NOT a second
// scheduler and does not touch the Pi UI.

import { readFile } from "node:fs/promises";

import { EventLog } from "./events.mjs";
import { projectBoard } from "./board.mjs";
import { projectState, resolveOpenEpisode } from "./state.mjs";
import { evaluateHandoff } from "./handoff.mjs";
import { buildRam } from "./ram.mjs";

/**
 * Apply the staged handoff file (if any) through a real AgentSessionRuntime.
 *
 * @param {{
 *   eventLogPath: string,
 *   handoffPath: string,
 *   runtime: { newSession: (options?: object) => Promise<{ cancelled?: boolean }> },
 *   taskId?: string,
 *   continuation?: (handoff: object) => string,
 * }} args
 * @returns {Promise<{applied: boolean, cancelled?: boolean, request_id?: string, episode_id?: string, reason?: string}>}
 */
export async function applyStagedHandoff({ eventLogPath, handoffPath, runtime, taskId, continuation }) {
	let handoff = null;
	try {
		handoff = JSON.parse(await readFile(handoffPath, "utf8"));
	} catch {
		return { applied: false, reason: "no staged handoff" };
	}
	if (!handoff || !handoff.episode_id) return { applied: false, reason: "staged handoff has no episode_id" };

	const log = new EventLog(eventLogPath);
	const opened = await log.open();
	if (!opened.ok) return { applied: false, reason: opened.error || "event log unavailable" };
	const events = log.replay();
	await log.close();

	const state = projectState(events);
	const board = projectBoard(events);
	const episode = state.episodes[handoff.episode_id];
	if (!episode || (episode.status !== "open" && episode.status !== "active")) {
		return { applied: false, reason: `episode ${handoff.episode_id} is ${episode ? episode.status : "missing"}` };
	}
	if (taskId !== undefined) {
		const target = resolveOpenEpisode(state, handoff.task_id || taskId);
		if (target && target.episode_id !== handoff.episode_id) {
			return { applied: false, reason: "the current task maps to a different episode" };
		}
	}
	const ram = buildRam({ board, state, episodeId: handoff.episode_id, goal: episode.goal?.description || "" });
	const verdict = evaluateHandoff({
		state,
		board,
		ram,
		episodeId: handoff.episode_id,
		reason: handoff.reason || "automatic post-settle handoff",
		requestId: handoff.request_id,
	});
	if (!verdict.allowed) return { applied: false, reason: verdict.reason, request_id: handoff.request_id, episode_id: handoff.episode_id };

	const reasonForSession = handoff.reason ?? "";
	const requestForSession = handoff.request_id;
	const episodeForSession = handoff.episode_id;
	let result;
	try {
		result = await runtime.newSession({
			withSession: async (next) => {
				const text = continuation ? continuation(handoff) : `[Aegis] continuing episode ${episodeForSession}: ${reasonForSession}`;
				await next.sendUserMessage(text);
			},
		});
	} catch (error) {
		// Creation failed: no completion happened, keep the request staged.
		return {
			applied: false,
			reason: error instanceof Error ? error.message : String(error),
			request_id: requestForSession,
			episode_id: episodeForSession,
		};
	}
	if (result?.cancelled) return { applied: false, cancelled: true, reason: "switch was cancelled", request_id: requestForSession, episode_id: episodeForSession };
	return { applied: true, verified: true, request_id: requestForSession, episode_id: episodeForSession };
}
