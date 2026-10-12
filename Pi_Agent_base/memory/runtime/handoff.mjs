// Short-session handoff safety.
//
// The LLM may REQUEST a session switch; the Runtime decides whether it is safe
// and what must be carried over. Session != Episode: a switch keeps the same
// Episode/authorization/budget and hands over the board, RAM, unfinished
// actions and budget. A switch is refused while an action is still pending.

import { summarizeBoard } from "./board.mjs";
import { pendingActionsFor, stateDigest } from "./state.mjs";

/**
 * @returns {{allowed: boolean, reason: string, handoff?: object, pending_actions?: any[]}}
 */
export function evaluateHandoff({ state, board, ram, episodeId, reason, requestId }) {
	if (!episodeId || !state.episodes[episodeId]) {
		return { allowed: false, reason: "no open episode to hand over" };
	}
	const episode = state.episodes[episodeId];
	// An already-closed/paused/invalid episode must never hand over. Only an
	// active/open episode can continue into a fresh short session.
	if (episode.status !== "open" && episode.status !== "active") {
		return { allowed: false, reason: `episode ${episodeId} is ${episode.status}; a closed episode cannot continue` };
	}
	if (typeof reason !== "string" || reason.trim().length === 0) {
		return { allowed: false, reason: "a handoff request must carry a reason" };
	}
	const pending = pendingActionsFor(state, episodeId);
	if (pending.length > 0) {
		return {
			allowed: false,
			reason: `refused: ${pending.length} action(s) are still unfinished (${pending.map((action) => action.tool_name).join(", ")})`,
			pending_actions: pending,
		};
	}
	// Any action whose outcome is unknown/unresolved is also an unfinished
	// side effect; it must block an automatic switch until it is resolved.
	const unresolved = Object.values(state.pending_actions).filter(
		(action) => action.episode_id === episodeId && (action.status === "unknown" || action.status === "unresolved"),
	);
	if (unresolved.length > 0) {
		return {
			allowed: false,
			reason: `refused: ${unresolved.length} action(s) have an unknown/unresolved side effect (${unresolved.map((action) => action.tool_name).join(", ")})`,
			pending_actions: unresolved,
		};
	}
	return {
		allowed: true,
		reason: "no unfinished actions; safe to hand over",
		handoff: {
			schema_version: "1.0",
			request_id: requestId,
			episode_id: episodeId,
			task_id: episode.task_id,
			reason: reason.trim(),
			authorization: episode.authorization,
			budget: episode.budget,
			board_digest: summarizeBoard(board).digest,
			effective_digest: summarizeBoard(board).effective_digest,
			state_digest: stateDigest(state),
			pending_actions: [],
			ram: ram || "",
			// Hand off the EFFECTIVE view only. A superseded/stale Fact must not be
			// carried into the next short session as current support.
			facts: (board.currentByType ?? board.byType).Fact.map((node) => node.text),
			refuted: (board.currentByType ?? board.byType).Refuted.map((node) => node.text),
			intents: (board.currentByType ?? board.byType).Intent.map((node) => node.text),
			created_at: new Date().toISOString(),
		},
	};
}
