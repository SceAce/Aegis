// Aegis RuntimeState: a deterministic projection of the event log for task
// binding, lifecycle, authorization/budget, pending actions and routing
// decisions. It is rebuilt from events (plus trusted runtime/oracle payloads);
// the LLM never writes it directly.

import { digest } from "./events.mjs";

export function initialState() {
	return {
		schema_version: "1.0",
		version: 0,
		tasks: {},
		episodes: {},
		pending_actions: {},
		experience_decisions: [],
		handoffs: [],
		open_handoff: null,
	};
}

/**
 * Aegis control tools are not workspace side effects. They must never block a
 * handoff: the handoff request tool would otherwise count itself as a pending
 * action and always refuse its own switch. Real tools still block.
 */
export const CONTROL_TOOLS = Object.freeze(new Set(["aegis_propose", "aegis_switch_session", "aegis_observe"]));

/** True when an action is a genuine side effect that can gate a handoff. */
export function isSideEffectAction(action) {
	return action && !CONTROL_TOOLS.has(action.tool_name);
}

function openEpisode(state, taskId) {
	const episodeId = state.tasks[taskId];
	if (!episodeId) return null;
	const episode = state.episodes[episodeId];
	return episode && episode.status === "open" ? episode : null;
}

/** Task -> open Episode. This is what keeps the same task in one Episode. */
export function resolveOpenEpisode(state, taskId) {
	return openEpisode(state, taskId);
}

function bump(state) {
	state.version += 1;
}

/**
 * Link a session id to an episode. Sessions are NOT episodes: one episode can
 * span several short sessions (a handoff), so an episode keeps the SET of
 * session ids that actually recorded events for it. This is derived purely from
 * trusted event payloads (`session.started`/`prompt.received` carry session_id;
 * `handoff.completed` carries `to_session`). It is never inferred from model
 * text and never grants a foreign session write access.
 */
function linkSession(episode, sessionId) {
	if (!episode || typeof sessionId !== "string" || sessionId.length === 0) return;
	if (!Array.isArray(episode.sessions)) episode.sessions = [];
	if (!episode.sessions.includes(sessionId)) episode.sessions.push(sessionId);
}

export function projectState(events) {
	const state = initialState();
	for (const event of events) {
		if (!event || typeof event !== "object") continue;
		const payload = event.payload || {};
		switch (event.event_type) {
			case "episode.started": {
				const taskId = payload.task_id || event.episode_id;
				state.tasks[taskId] = event.episode_id;
				state.episodes[event.episode_id] = {
					episode_id: event.episode_id,
					task_id: taskId,
					goal: payload.goal || null,
					authorization: payload.authorization ?? "unknown",
					budget: payload.budget ?? "unknown",
					source_kind: event.source?.kind || "runtime",
					status: "open",
					started_at: event.recorded_at,
					closed_at: null,
					prompts: 0,
					sessions: [],
				};
				linkSession(state.episodes[event.episode_id], payload.session_id);
				bump(state);
				break;
			}
			case "session.started": {
				// A session may start before its episode is known (episode_id null).
				// When it does carry an episode_id it binds the session to that episode.
				if (event.episode_id && state.episodes[event.episode_id]) {
					linkSession(state.episodes[event.episode_id], payload.session_id);
					bump(state);
				}
				break;
			}
			case "prompt.received": {
				if (event.episode_id && state.episodes[event.episode_id]) {
					state.episodes[event.episode_id].prompts += 1;
					// The session that issued this prompt belongs to the episode.
					linkSession(state.episodes[event.episode_id], payload.session_id);
					bump(state);
				}
				break;
			}
			case "episode.closed": {
				if (event.episode_id && state.episodes[event.episode_id]) {
					state.episodes[event.episode_id].status = "closed";
					state.episodes[event.episode_id].closed_at = event.recorded_at;
					state.episodes[event.episode_id].close_reason = payload.reason || null;
					bump(state);
				}
				break;
			}
			case "action.requested": {
				const actionId = payload.action_id;
				if (actionId) {
					state.pending_actions[actionId] = {
						action_id: actionId,
						tool_name: payload.tool_name || "unknown",
						episode_id: event.episode_id || null,
						status: "pending",
						requested_at: event.recorded_at,
					};
					bump(state);
				}
				break;
			}
			case "action.completed": {
				const actionId = payload.action_id;
				if (actionId && state.pending_actions[actionId]) {
					state.pending_actions[actionId].status = "completed";
					state.pending_actions[actionId].completed_at = event.recorded_at;
					bump(state);
				}
				break;
			}
			case "experience.decision": {
				state.experience_decisions.push({
					event_id: event.event_id,
					episode_id: event.episode_id || null,
					mode: payload.mode || null,
					considered: payload.considered || [],
					matched: payload.matched || [],
					rejected: payload.rejected || [],
					selected: payload.selected || null,
					reason: payload.reason || null,
				});
				bump(state);
				break;
			}
			case "handoff.requested": {
				state.open_handoff = {
					request_id: payload.request_id || event.event_id,
					episode_id: event.episode_id || null,
					reason: payload.reason || null,
					requested_at: event.recorded_at,
				};
				bump(state);
				break;
			}
			case "handoff.rejected": {
				if (state.open_handoff && state.open_handoff.request_id === (payload.request_id || event.event_id)) {
					state.open_handoff = null;
				}
				state.handoffs.push({ status: "rejected", reason: payload.reason || null, event_id: event.event_id });
				bump(state);
				break;
			}
			case "handoff.completed": {
				if (state.open_handoff) {
					state.handoffs.push({ status: "completed", to_session: payload.to_session || null, event_id: event.event_id });
				}
				// The replacement session now belongs to the same episode.
				if (event.episode_id && state.episodes[event.episode_id]) {
					linkSession(state.episodes[event.episode_id], payload.to_session);
				}
				state.open_handoff = null;
				bump(state);
				break;
			}
			default:
				break;
		}
	}
	return state;
}

export function pendingActionsFor(state, episodeId) {
	return Object.values(state.pending_actions).filter(
		(action) => action.status === "pending" && (!episodeId || action.episode_id === episodeId) && isSideEffectAction(action),
	);
}

/**
 * True when `sessionId` is one of the sessions that actually recorded events for
 * `episodeId` (via session.started/prompt.received/handoff.completed payloads).
 * A session that only appears in a foreign episode (or in no episode) is NOT
 * accepted, so a hand-supplied session id can never grant cross-task write
 * access.
 */
export function episodeHasSession(state, episodeId, sessionId) {
	if (!episodeId || typeof sessionId !== "string" || sessionId.length === 0) return false;
	const episode = state.episodes[episodeId];
	if (!episode) return false;
	return Array.isArray(episode.sessions) && episode.sessions.includes(sessionId);
}

export function stateDigest(state) {
	return digest({
		version: state.version,
		tasks: state.tasks,
		episodes: Object.fromEntries(Object.entries(state.episodes).map(([id, ep]) => [id, { status: ep.status, prompts: ep.prompts }])),
		pending: Object.keys(state.pending_actions).filter((id) => state.pending_actions[id].status === "pending"),
	});
}
