// Thin Host helper for an Aegis short-session handoff.
//
// The Host, not the new session's `session_start`, owns the completion record:
// only after the real `AgentSessionRuntime.newSession` returns successfully
// (which includes the Host rebind callback and the continuation) AND the
// `handoff.completed` row is durably appended does the helper report
// `applied:true`. A cancelled switch, a thrown creation/rebind error, or a
// non-durable completion append all leave the request staged for deliberate
// recovery and never write a false completion.
//
// It re-validates the staged request against the committed Events and never
// trusts the staged JSON: a closed episode, a moved task, or an unfinished
// action all refuse the switch. It is deliberately NOT a second scheduler and
// does not touch the Pi UI.

import { readFile, rename } from "node:fs/promises";
import { projectBoard } from "../memory/board.mjs";
import { buildRam } from "../memory/ram.mjs";
import { projectState, resolveOpenEpisode } from "../memory/state.mjs";
import { projectWorkCycle, resolveWorkCyclePolicy } from "../memory/work-cycle.mjs";
import { EventLog } from "../shared/events.mjs";
import { evaluateHandoff } from "./handoff.mjs";
import { beginHandoffAttempt, endHandoffAttempt } from "./handoff-grant.mjs";

/**
 * Apply the staged handoff file (if any) through a real AgentSessionRuntime.
 *
 * @param {{
 *   eventLogPath: string,
 *   handoffPath: string,
 *   runtime: { newSession: (options?: object) => Promise<{ cancelled?: boolean }>, session?: { sessionId?: string|null } },
 *   taskId?: string,
 *   continuation?: (handoff: object) => string,
 * }} args
 * @returns {Promise<{applied: boolean, cancelled?: boolean, verified?: boolean, request_id?: string, episode_id?: string, to_session?: string|null, reason?: string}>}
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
	// Idempotency: a committed completion for this request already exists. Do not
	// create a second Session and do not append a second completion.
	const alreadyCompleted = events.some(
		(event) =>
			event.event_type === "handoff.completed" &&
			event.payload?.request_id === handoff.request_id &&
			handoff.request_id,
	);
	if (alreadyCompleted) {
		return {
			applied: true,
			reused: true,
			verified: true,
			request_id: handoff.request_id,
			episode_id: handoff.episode_id,
			reason: "this handoff request already has a committed completion; no second Session was created",
		};
	}
	const workCycle = projectWorkCycle(events, handoff.episode_id, resolveWorkCyclePolicy(process.env));
	const ram = buildRam({
		board,
		state,
		episodeId: handoff.episode_id,
		goal: episode.goal?.description || "",
		workCycle,
	});
	const verdict = evaluateHandoff({
		state,
		board,
		ram,
		episodeId: handoff.episode_id,
		reason: handoff.reason || "automatic post-settle handoff",
		requestId: handoff.request_id,
		workCycle,
	});
	if (!verdict.allowed)
		return { applied: false, reason: verdict.reason, request_id: handoff.request_id, episode_id: handoff.episode_id };

	const reasonForSession = handoff.reason ?? "";
	const requestForSession = handoff.request_id;
	const episodeForSession = handoff.episode_id;
	// Open the SHORT-LIVED Host attempt that authorizes the replacement Session
	// (not the initial Session) to append `handoff.completed`. The live attempt id
	// exists only for the duration of this `newSession` call; it is cleared in
	// `finally` even on create/rebind/continuation failure.
	let attempt = null;
	let result;
	try {
		try {
			attempt = await beginHandoffAttempt({
				handoffPath,
				handoff,
				fromSession: runtime.session?.sessionId ?? null,
			});
		} catch (error) {
			return {
				applied: false,
				reason: `could not open a Host handoff attempt: ${error instanceof Error ? error.message : String(error)}`,
				request_id: requestForSession,
				episode_id: episodeForSession,
			};
		}
		try {
			result = await runtime.newSession({
				withSession: async (next) => {
					// `withSession` runs AFTER the SDK has rebound the new Session. The new
					// Session's Observer records `handoff.completed` when its continuation
					// prompt starts (a genuine post-bind point), so the Host never opens a
					// second EventLog writer here. A rebind failure prevents `withSession`
					// from running at all, so no completion can precede the bind.
					const text = continuation
						? continuation(handoff)
						: `[Aegis] continuing episode ${episodeForSession}: ${reasonForSession}`;
					await next.sendUserMessage(text);
				},
			});
		} catch (error) {
			// Creation/rebind/continuation failed: no completion happened, keep the
			// request staged.
			return {
				applied: false,
				reason: error instanceof Error ? error.message : String(error),
				request_id: requestForSession,
				episode_id: episodeForSession,
			};
		}
	} finally {
		await endHandoffAttempt({ handoffPath, attempt });
	}
	if (result?.cancelled)
		return {
			applied: false,
			cancelled: true,
			reason: "switch was cancelled",
			request_id: requestForSession,
			episode_id: episodeForSession,
		};

	// The SDK returned a non-cancelled new Session (Host rebind + continuation
	// done). The new session id is read from the bound runtime; a missing id means
	// the bind did not really produce a usable session.
	let toSession = null;
	try {
		toSession = runtime.session?.sessionId ?? null;
	} catch {
		toSession = null;
	}
	if (typeof toSession !== "string" || toSession.length === 0) {
		return {
			applied: false,
			reason: "the new Session was not bound (no session id); refusing to record completion",
			request_id: requestForSession,
			episode_id: episodeForSession,
		};
	}
	// VERIFY the completion is committed. It is recorded by the new Session's
	// Observer at its first post-bind `before_agent_start`; the Host refuses to
	// report success if no committed completion can be found (never trust the
	// SDK return).
	const committed = await readCommittedCompletion(eventLogPath, requestForSession);
	if (!committed.ok) {
		return {
			applied: false,
			reason: `no committed handoff completion could be verified: ${committed.reason}`,
			request_id: requestForSession,
			episode_id: episodeForSession,
			to_session: toSession,
		};
	}
	if (committed.completion.payload?.to_session && committed.completion.payload.to_session !== toSession) {
		return {
			applied: false,
			reason: "the committed completion names a different Session than the bound runtime",
			request_id: requestForSession,
			episode_id: episodeForSession,
			to_session: toSession,
		};
	}
	if (!attempt || committed.completion.payload?.attempt_id !== attempt.attempt_id) {
		return {
			applied: false,
			reason: "the committed completion is not bound to this Host handoff attempt",
			request_id: requestForSession,
			episode_id: episodeForSession,
			to_session: toSession,
		};
	}
	if (committed.completion.payload?.from_session !== attempt.from_session) {
		return {
			applied: false,
			reason: "the committed completion names a different source Session",
			request_id: requestForSession,
			episode_id: episodeForSession,
			to_session: toSession,
		};
	}
	// Retire the staged request only after a verified, durable completion.
	await rename(handoffPath, `${handoffPath}.applied.json`).catch(() => undefined);
	return {
		applied: true,
		verified: true,
		request_id: requestForSession,
		episode_id: episodeForSession,
		to_session: toSession,
		completion_event_id: committed.completion.event_id ?? null,
	};
}

/**
 * Read the committed log and return the single `handoff.completed` row for a
 * request id, enforcing uniqueness (two rows for one request is a corruption
 * the Host must not treat as success).
 *
 * @param {string} eventLogPath
 * @param {string|undefined} requestId
 */
async function readCommittedCompletion(eventLogPath, requestId) {
	if (!requestId) return { ok: false, reason: "the staged handoff has no request_id" };
	const log = new EventLog(eventLogPath);
	const opened = await log.open();
	if (!opened.ok) return { ok: false, reason: opened.error || "event log unavailable" };
	try {
		const matches = log
			.replay()
			.filter((event) => event.event_type === "handoff.completed" && event.payload?.request_id === requestId);
		if (matches.length === 0) return { ok: false, reason: "no committed handoff.completed for this request" };
		if (matches.length > 1)
			return { ok: false, reason: `duplicate handoff.completed rows (${matches.length}) for this request` };
		return { ok: true, completion: matches[0] };
	} finally {
		await log.close();
	}
}
