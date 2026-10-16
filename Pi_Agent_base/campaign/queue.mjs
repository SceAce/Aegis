// Campaign queue STATE CONTRACT (C0 only).
//
// C0 defines the queue's state vocabulary, its legal transitions, and the shape
// of a queue item. It deliberately does NOT implement a scheduler loop, leases,
// checkpointing or event writing — those are C1. This module is a pure contract
// so C1 can be built and tested against a fixed vocabulary.
//
// Key rules (docs/CAMPAIGN_ARCHITECTURE.md §3.2):
//   * `pending` is NOT a persisted task status; it is a projection/scheduler
//     state. The persisted Outcome stays `unknown` until an Oracle judges it.
//   * `failed` is a scheduler/execution failure, NOT a task Outcome failure.
//   * `unknown` means the evidence is insufficient — never a failure.

import { assertIdType } from "./identifiers.mjs";

export const QUEUE_STATES = Object.freeze([
	"queued",
	"ready",
	"running",
	"waiting_oracle",
	"paused",
	"completed",
	"failed",
	"unknown",
	"cancelled",
]);

/** Terminal states never transition further without a new attempt. */
export const TERMINAL_QUEUE_STATES = Object.freeze(["completed", "failed", "unknown", "cancelled"]);

// Legal forward transitions. Recovery may re-enter from a non-terminal state, so
// `paused` and `waiting_oracle` can return to `ready`/`running`. Terminal states
// have no outgoing edges: a retry is a NEW attempt, not a mutation of a terminal
// row.
const TRANSITIONS = Object.freeze({
	queued: ["ready", "cancelled", "failed"],
	ready: ["running", "paused", "cancelled", "failed"],
	running: ["waiting_oracle", "completed", "failed", "unknown", "paused", "cancelled"],
	waiting_oracle: ["completed", "unknown", "failed", "paused", "cancelled"],
	paused: ["ready", "running", "cancelled", "failed", "unknown"],
	completed: [],
	failed: [],
	// `unknown` is terminal for DISPATCH (no worker restart), but a later legal
	// correction/judgment may re-open the evidence window (waiting_oracle) so the
	// task can be completed. It never returns to `running`/`ready`.
	unknown: ["waiting_oracle", "completed"],
	cancelled: [],
});

export function isQueueState(state) {
	return typeof state === "string" && QUEUE_STATES.includes(state);
}

export function isLegalTransition(from, to) {
	if (!isQueueState(from) || !isQueueState(to)) return false;
	return (TRANSITIONS[from] ?? []).includes(to);
}

export function legalTransitionsFrom(state) {
	return [...(TRANSITIONS[state] ?? [])];
}

/**
 * Validate a queue item's shape. C0 requires the fields a projection must carry;
 * it does not require them to be populated by a scheduler yet.
 */
export function validateQueueItem(item) {
	const reasons = [];
	if (!item || typeof item !== "object") return { ok: false, reasons: ["queue item must be an object"] };
	reasons.push(...assertIdType(item.campaign_id, "campaign", "campaign_id").reasons);
	reasons.push(...assertIdType(item.task_id, "task", "task_id").reasons);
	if (!isQueueState(item.state)) reasons.push(`state must be one of ${QUEUE_STATES.join(", ")}`);
	if (item.episode_id !== undefined && item.episode_id !== null)
		reasons.push(...assertIdType(item.episode_id, "episode", "episode_id").reasons);
	if (item.session_id !== undefined && item.session_id !== null)
		reasons.push(...assertIdType(item.session_id, "session", "session_id").reasons);
	if (item.attempt_id !== undefined && item.attempt_id !== null && typeof item.attempt_id !== "string")
		reasons.push("attempt_id must be a string when present");
	if (item.dependency_status !== undefined && typeof item.dependency_status !== "object")
		reasons.push("dependency_status must be an object when present");
	if (item.budget_consumed !== undefined && (typeof item.budget_consumed !== "object" || item.budget_consumed === null))
		reasons.push("budget_consumed must be an object when present");
	if (item.retry_count !== undefined && !(Number.isInteger(item.retry_count) && item.retry_count >= 0))
		reasons.push("retry_count must be a non-negative integer");
	if (item.pending_action !== undefined && item.pending_action !== null && typeof item.pending_action !== "object")
		reasons.push("pending_action must be an object when present");
	return { ok: reasons.length === 0, reasons };
}

/** Build a minimal, contract-complete queue item for a task. */
export function makeQueueItem({ campaign_id, task_id, state = "queued", depends_on = [], order = 1 }) {
	return {
		campaign_id,
		task_id,
		state,
		attempt_id: null,
		episode_id: null,
		session_id: null,
		order,
		depends_on: [...depends_on],
		dependency_status: Object.fromEntries(depends_on.map((dep) => [dep, "pending"])),
		budget_consumed: { wall_time_ms: 0, model_requests: 0, tool_calls: 0, session_count: 0 },
		next_action: null,
		last_committed_digest: null,
		last_committed_sequence: null,
		pending_action: null,
		reconciliation_state: "none",
		retry_count: 0,
		stop_reason: null,
		stage_outcome_refs: [],
		task_outcome_ref: null,
	};
}

/**
 * C0 projection skeleton: derive the INITIAL queue ROWS from the static Manifest
 * task definitions only. This is intentionally NOT a scheduler.
 *
 * C0 rule: a task with NO dependencies starts `ready`; a task with any dependency
 * starts `queued` with `dependency_status[dep] === "pending"`. C0 has NOT observed
 * any dependency complete, so it MUST NOT infer completion from traversal order.
 * Only the C1 event-driven projection may promote a dependent task to `ready`
 * after it sees the dependency's real committed completion.
 */
export function projectInitialQueue({ campaign_id, tasks }) {
	const rows = [];
	for (const task of [...tasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
		const dependsOn = task.depends_on ?? [];
		// No dependency -> ready. Any dependency -> queued, all deps pending.
		const item = makeQueueItem({
			campaign_id,
			task_id: task.task_id,
			state: dependsOn.length === 0 ? "ready" : "queued",
			depends_on: dependsOn,
			order: task.order ?? 1,
		});
		item.dependency_status = Object.fromEntries(dependsOn.map((dep) => [dep, "pending"]));
		rows.push(item);
	}
	return rows;
}
