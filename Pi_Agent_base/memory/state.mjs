// Aegis RuntimeState: a deterministic projection of the event log for task
// binding, lifecycle, authorization/budget, pending actions and routing
// decisions. It is rebuilt from events (plus trusted runtime/oracle payloads);
// the LLM never writes it directly.

import { projectWorkControl } from "../orchestration/work-control.mjs";
import { digest } from "../shared/events.mjs";
import { indexEvents, readWorkCheckpoint, readWorkReview } from "./work-cycle.mjs";

export function initialState() {
	return {
		schema_version: "1.0",
		version: 0,
		tasks: {},
		episodes: {},
		pending_actions: {},
		experience_decisions: [],
		knowledge_selections: [],
		human_hints: [],
		round_checkpoints: [],
		// Structured work-cycle planning metadata. Projected from committed
		// runtime notes; ALWAYS unverified planning state, never a Fact/Outcome.
		work_checkpoints: [],
		work_reviews: [],
		handoffs: [],
		open_handoff: null,
		work_state: {},
	};
}

/**
 * Aegis control tools are not workspace side effects. They must never block a
 * handoff: the handoff request tool would otherwise count itself as a pending
 * action and always refuse its own switch. Real tools still block.
 */
export const CONTROL_TOOLS = Object.freeze(
	new Set(["aegis_propose", "aegis_switch_session", "aegis_observe", "aegis_work_review", "aegis_work_checkpoint"]),
);

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
	const byId = indexEvents(events);
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
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
			case "runtime.note": {
				if (event.source?.kind === "runtime" || event.source?.kind === "human") {
					if (event.payload?.version === "work-control-1") bump(state);
					if (event.payload?.kind === "knowledge.selected" && event.episode_id) {
						const mode = ["model_query", "work_review"].includes(event.payload.mode)
							? event.payload.mode
							: event.payload.mode === "automatic"
								? "automatic"
								: null;
						const selected = Array.isArray(event.payload.selected) ? event.payload.selected.slice(0, 8) : [];
						const existing = state.knowledge_selections.filter((item) => item.episode_id === event.episode_id);
						// Empty explicit selections clear the current working set; a normal
						// automatic miss leaves existing references intact.
						if (selected.length === 0) {
							if (mode !== "automatic" && mode !== "work_review") {
								state.knowledge_selections = state.knowledge_selections.filter(
									(item) => item.episode_id !== event.episode_id,
								);
								bump(state);
							}
							break;
						}
						const byId = new Map(existing.map((item) => [item.knowledge_id, item]));
						for (const item of selected) {
							if (!item || typeof item !== "object" || typeof item.knowledge_id !== "string") continue;
							const prior = byId.get(item.knowledge_id);
							if (mode === "automatic" && ["model_query", "work_review"].includes(prior?.selection_mode)) {
								byId.set(item.knowledge_id, { ...prior, event_id: event.event_id });
								continue;
							}
							byId.set(item.knowledge_id, {
								event_id: event.event_id,
								episode_id: event.episode_id,
								knowledge_id: item.knowledge_id,
								selection_mode:
									mode === "automatic" && ["model_query", "work_review"].includes(prior?.selection_mode)
										? prior.selection_mode
										: (mode ?? prior?.selection_mode ?? "automatic"),
								source_kind: item.source_kind ?? "external_reference",
								line_start: item.line_start ?? null,
								line_end: item.line_end ?? null,
								source_uri: item.source_uri ?? null,
								source_digest: item.source_digest ?? null,
								topic: item.topic ?? null,
								section: Array.isArray(item.section) ? item.section.slice(0, 6) : [],
								content: typeof item.content === "string" ? item.content.slice(0, 7000) : "",
								truncated: item.truncated === true,
								bundle_source_ids: Array.isArray(item.bundle_source_ids) ? item.bundle_source_ids.slice(0, 16) : [],
							});
						}
						const merged = [...byId.values()].sort(
							(a, b) =>
								Number(["model_query", "work_review"].includes(b.selection_mode)) -
								Number(["model_query", "work_review"].includes(a.selection_mode)),
						);
						state.knowledge_selections = [
							...state.knowledge_selections.filter((item) => item.episode_id !== event.episode_id),
							...merged.slice(0, 8),
						];
						bump(state);
					}
					// A human hint is a single, Episode-bound piece of natural-language
					// task guidance. It is NEVER a Fact, rule, permission or budget: the
					// reducer only stores text plus provenance, and the newest hint for an
					// Episode supersedes the previous one (the older event stays in the
					// log). Model-sourced notes cannot reach this branch because the guard
					// above only accepts runtime/human sources.
					if (event.payload?.kind === "human.hint" && event.episode_id) {
						const text = typeof event.payload.text === "string" ? event.payload.text.trim() : "";
						const prior = state.human_hints.filter((item) => item.episode_id !== event.episode_id);
						const cleared = text.length === 0;
						state.human_hints = cleared
							? prior
							: [
									...prior,
									{
										event_id: event.event_id,
										hint_id: typeof event.payload.hint_id === "string" ? event.payload.hint_id : null,
										episode_id: event.episode_id,
										text: text.slice(0, 1200),
										truncated: text.length > 1200,
										supersedes: typeof event.payload.supersedes === "string" ? event.payload.supersedes : null,
									},
								];
						bump(state);
					}
					// A structured work review is a retrieval-backed review record. The
					// validator rejects foreign/future refs and a review without a real
					// bounded-retrieval event, so an unusable row cannot clear a hold.
					const workReview = readWorkReview(event, index, byId, event.episode_id);
					if (workReview) {
						state.work_reviews = [
							...state.work_reviews.filter((item) => item.episode_id !== event.episode_id),
							{ ...workReview, episode_id: event.episode_id },
						].slice(-4);
						bump(state);
					}
					const workCheckpoint = readWorkCheckpoint(event, index, byId, event.episode_id);
					if (workCheckpoint) {
						state.work_checkpoints = [
							...state.work_checkpoints.filter((item) => item.episode_id !== event.episode_id),
							{ ...workCheckpoint, episode_id: event.episode_id },
						].slice(-4);
						bump(state);
					}
					if (event.payload?.kind === "round.checkpoint" && event.episode_id) {
						const prior = state.round_checkpoints.filter((item) => item.episode_id !== event.episode_id);
						prior.push({
							event_id: event.event_id,
							episode_id: event.episode_id,
							turn_index: event.payload.turn_index ?? null,
							text: typeof event.payload.text === "string" ? event.payload.text.slice(0, 1600) : "",
							tool_count: event.payload.tool_count ?? 0,
							state_revision: event.payload.state_revision ?? null,
						});
						state.round_checkpoints = [
							...prior,
							...state.round_checkpoints.filter((item) => item.episode_id === event.episode_id).slice(-2),
						];
						bump(state);
					}
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
					state.handoffs.push({
						status: "completed",
						to_session: payload.to_session || null,
						event_id: event.event_id,
					});
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
	state.work_state = Object.fromEntries(
		Object.keys(state.tasks).map((taskId) => {
			const work = projectWorkControl(events, taskId);
			return [taskId, { state: work.state, policy: work.policy, candidate: work.candidate }];
		}),
	);
	return state;
}

export function pendingActionsFor(state, episodeId) {
	return Object.values(state.pending_actions).filter(
		(action) =>
			action.status === "pending" && (!episodeId || action.episode_id === episodeId) && isSideEffectAction(action),
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
		episodes: Object.fromEntries(
			Object.entries(state.episodes).map(([id, ep]) => [id, { status: ep.status, prompts: ep.prompts }]),
		),
		pending: Object.keys(state.pending_actions).filter((id) => state.pending_actions[id].status === "pending"),
	});
}
