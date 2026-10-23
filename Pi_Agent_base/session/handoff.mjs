// Short-session handoff safety.
//
// The LLM may REQUEST a session switch; the Runtime decides whether it is safe
// and what must be carried over. Session != Episode: a switch keeps the same
// Episode/authorization/budget and hands over the board, RAM, unfinished
// actions and budget. A switch is refused while an action is still pending.

import { summarizeBoard } from "../memory/board.mjs";
import { pendingActionsFor, stateDigest } from "../memory/state.mjs";

/**
 * @returns {{allowed: boolean, reason: string, handoff?: object, pending_actions?: any[]}}
 */
export function evaluateHandoff({ state, board, ram, episodeId, reason, requestId, workCycle = null }) {
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
			// Bounded work-cycle continuity. The replacement re-derives the review gate
			// from the committed EventLog; this payload is a derived view and can never
			// grant permission, clear a review or reset a budget. A staged checkpoint
			// status is a model claim / planning metadata, not an Outcome.
			work_cycle: workCycle
				? {
						status: workCycle.status ?? "unknown",
						work_unit_id: workCycle.work_unit_id ?? null,
						reasons: Array.isArray(workCycle.reasons) ? workCycle.reasons.slice(0, 3) : [],
						trigger_id: workCycle.trigger_id ?? null,
						review_event_id: workCycle.review?.event_id ?? workCycle.last_review?.event_id ?? null,
						selection_event_id:
							workCycle.review?.selection_event_id ?? workCycle.last_review?.selection_event_id ?? null,
						evidence_event_ids: Array.isArray(workCycle.evidence_event_ids)
							? workCycle.evidence_event_ids.slice(-8)
							: [],
						checkpoint: workCycle.checkpoint
							? {
									event_id: workCycle.checkpoint.event_id,
									unit_status: workCycle.checkpoint.unit_status,
									trust: "unverified_model_summary",
								}
							: null,
						trust: "runtime_advisory_not_outcome",
					}
				: null,
			// Hand off the EFFECTIVE view only. A superseded/stale Fact must not be
			// carried into the next short session as current support.
			facts: (board.currentByType ?? board.byType).Fact.filter((node) => node.episode_id === episodeId).map(
				(node) => node.text,
			),
			refuted: (board.currentByType ?? board.byType).Refuted.filter((node) => node.episode_id === episodeId).map(
				(node) => node.text,
			),
			intents: (board.currentByType ?? board.byType).Intent.filter((node) => node.episode_id === episodeId).map(
				(node) => node.text,
			),
			created_at: new Date().toISOString(),
		},
	};
}
