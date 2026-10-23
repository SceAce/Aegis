// Aegis C2 — Host-level Session rotation supervisor.
//
// The Host, not the Observer extension, owns the real Pi session lifecycle
// (CAMPAIGN_ARCHITECTURE §3.3). This module is the small Host/scheduler-facing
// entry that decides WHEN a rotation is legal and records continuity across it.
//
// It is deliberately thin and reuses the existing pieces rather than creating a
// parallel framework:
//   * safety + bounded RAM come from `session/handoff.mjs` + `ram.mjs`;
//   * the real SDK call is the existing `session/handoff-host.mjs`
//     `applyStagedHandoff` (which itself calls `runtime.newSession`);
//   * committed truth is re-derived from the EventLog, never from the staged
//     file or from model text.
//
// What this module owns and the helper does not:
//   * a read-only `canRotate()` precheck that is safe to call before settle;
//   * cumulative-budget continuity (a rotation must not reset or grow remaining);
//   * idempotent replay of an already-completed request id (no second session,
//     completion or charge);
//   * recovery of an interrupted staged handoff (staged, no completion) through
//     the same real path, never re-running an unconfirmed Task side effect.

import { readFile } from "node:fs/promises";
import { projectBoard } from "../memory/board.mjs";
import { buildRam } from "../memory/ram.mjs";
import { projectState, resolveOpenEpisode } from "../memory/state.mjs";
import { projectWorkCycle, resolveWorkCyclePolicy } from "../memory/work-cycle.mjs";
import { EventLog } from "../shared/events.mjs";
import { evaluateHandoff } from "./handoff.mjs";
import { applyStagedHandoff } from "./handoff-host.mjs";

const BUDGET_KEYS = Object.freeze(["wall_time_ms", "model_requests", "tool_calls", "session_count"]);

function zeroBudget() {
	return { wall_time_ms: 0, model_requests: 0, tool_calls: 0, session_count: 0 };
}

/** Read a committed budget ledger into a normalized {limit, consumed, remaining}. */
export function budgetSnapshot(budget) {
	if (!budget || typeof budget !== "object") return null;
	const limit = { ...zeroBudget(), ...(budget.limit ?? {}) };
	const consumed = { ...zeroBudget(), ...(budget.consumed ?? {}) };
	const reserved = { ...zeroBudget(), ...(budget.reserved ?? {}) };
	const remaining = zeroBudget();
	for (const key of BUDGET_KEYS) {
		remaining[key] = Math.max(0, (limit[key] ?? 0) - (reserved[key] ?? 0) - (consumed[key] ?? 0));
	}
	return { limit, consumed, reserved, remaining, max_requests_per_session: budget.max_requests_per_session ?? null };
}

/** True when the ledger can fund one more session (a session-count generation).
 *
 * `committedSessionsUsed` is the number of Session generations already spent by
 * committed `handoff.completed` events for THIS episode that are not yet
 * reflected in the caller's base ledger. The gate is evaluated against
 * `base_consumed + committedSessionsUsed` so an already-committed rotation can
 * never be ignored merely because the Host passed an unchanged ledger object
 * (e.g. after a restart/replay). */
export function budgetAllowsSession(budget, committedSessionsUsed = 0) {
	if (!budget || typeof budget !== "object" || !budget.limit)
		return { allowed: true, reason: "no budget ledger supplied; the Host enforces safety only" };
	const snap = budgetSnapshot(budget);
	const used = Math.max(0, committedSessionsUsed);
	const effectiveConsumed = (snap.consumed.session_count ?? 0) + used;
	const remaining = Math.max(
		0,
		(snap.limit.session_count ?? 0) - (snap.reserved.session_count ?? 0) - effectiveConsumed,
	);
	if (remaining < 1) {
		return {
			allowed: false,
			reason: `session budget is exhausted (limit=${snap.limit.session_count}, base_consumed=${snap.consumed.session_count}, committed_rotations=${used}, remaining=${remaining}); refusing to create a new Session`,
		};
	}
	return { allowed: true };
}

/**
 * How many rotations have already committed for an episode. This is the count
 * of `handoff.completed` events bound to that episode. It is the authority for
 * "a committed rotation already spent one Session generation".
 */
export function committedRotations(events, episodeId) {
	if (!episodeId) return 0;
	return events.filter(
		(event) =>
			event.event_type === "handoff.completed" &&
			((event.episode_id ?? null) === episodeId || event.payload?.episode_id === episodeId),
	).length;
}

/**
 * The committed rotation state: open episode + the handoff already completed
 * for a request id (if any). Re-derived from the EventLog every call.
 */
async function readCommitted({ eventLogPath, handoffPath, budget, manifest = null }) {
	const log = new EventLog(eventLogPath);
	const opened = await log.open();
	if (!opened.ok) return { ok: false, reason: opened.error || "event log unavailable" };
	const events = log.replay();
	await log.close();
	const state = projectState(events);
	// The SAME Campaign context the Host uses (no raw-outcome reinterpretation).
	const board = projectBoard(events, { manifest });

	let handoff = null;
	try {
		handoff = JSON.parse(await readFile(handoffPath, "utf8"));
	} catch {
		handoff = null;
	}
	const completedIds = new Set(
		events
			.filter((event) => event.event_type === "handoff.completed" && event.payload?.request_id)
			.map((event) => event.payload.request_id),
	);
	return { ok: true, events, state, board, handoff, completedIds, budget: budgetSnapshot(budget) };
}
/**
 * @param {{
 *   eventLogPath: string,
 *   handoffPath: string,
 *   runtime: { newSession: (options?: object) => Promise<{ cancelled?: boolean }>, session?: { sessionId?: string|null } },
 *   taskId?: string,
 *   budget?: object|null,
 *   continuation?: (handoff: object) => string,
 *   manifest?: any,
 * }} args
 */
export function createSessionSupervisor({
	eventLogPath,
	handoffPath,
	runtime,
	taskId,
	budget = null,
	continuation,
	manifest = null,
}) {
	if (!eventLogPath || !handoffPath) throw new Error("createSessionSupervisor requires eventLogPath and handoffPath");
	if (!runtime || typeof runtime.newSession !== "function")
		throw new Error("createSessionSupervisor requires a runtime with newSession");

	/**
	 * Read-only precheck. Returns `{allowed, reason, blocking[]}` and never
	 * mutates the runtime or the log. Safe to call at a settle boundary.
	 */
	async function canRotate() {
		const committed = await readCommitted({ eventLogPath, handoffPath, budget, manifest });
		if (!committed.ok) return { allowed: false, reason: committed.reason, blocking: [] };
		const { state, board, handoff, events } = committed;
		const episodeId = handoff?.episode_id ?? resolveOpenEpisode(state, taskId)?.episode_id ?? null;
		if (!episodeId) return { allowed: false, reason: "no open episode to hand over", blocking: [] };
		// Budget is checked independently of the episode so an exhausted ledger is
		// reported even before the safety verdict. Committed rotations for this
		// episode are added on top of the caller's base ledger, so an unchanged
		// base object after a Host restart/replay cannot grant a fresh balance.
		const usedRotations = committedRotations(events, episodeId);
		const budgetCheck = budgetAllowsSession(budget, usedRotations);
		if (!budgetCheck.allowed) return { allowed: false, reason: budgetCheck.reason, blocking: [] };
		const workCycle = projectWorkCycle(events, episodeId, resolveWorkCyclePolicy(process.env));
		const ram = buildRam({
			board,
			state,
			episodeId,
			goal: state.episodes[episodeId]?.goal?.description || "",
			workCycle,
		});
		const verdict = evaluateHandoff({
			state,
			board,
			ram,
			episodeId,
			reason: handoff?.reason || "automatic post-settle rotation",
			requestId: handoff?.request_id,
			workCycle,
		});
		if (!verdict.allowed) {
			const blocking = (verdict.pending_actions ?? []).map(
				(action) => action.tool_name || action.action_id || "unknown",
			);
			return { allowed: false, reason: verdict.reason, blocking };
		}
		return {
			allowed: true,
			reason: verdict.reason,
			episode_id: episodeId,
			request_id: handoff?.request_id ?? null,
			blocking: [],
		};
	}

	/**
	 * Decide and apply one rotation through the REAL SDK path.
	 *
	 * Idempotency: if `requestId` (or the staged request id) already has a
	 * committed `handoff.completed`, the runtime is NOT replaced again and
	 * `{applied:true, reused:true}` is returned with no new completion/charge.
	 */
	async function rotate({ requestId = null, reason = null } = {}) {
		const committed = await readCommitted({ eventLogPath, handoffPath, budget, manifest });
		if (!committed.ok) return { applied: false, reason: committed.reason };
		const { state, board, handoff, completedIds, events } = committed;

		const effectiveRequestId = requestId ?? handoff?.request_id ?? null;
		const episodeId = handoff?.episode_id ?? resolveOpenEpisode(state, taskId)?.episode_id ?? null;

		// Idempotent replay: a prior completion for this request means the work is
		// already done. Do not replace the session, do not complete again.
		if (effectiveRequestId && completedIds.has(effectiveRequestId)) {
			return {
				applied: true,
				reused: true,
				request_id: effectiveRequestId,
				episode_id: episodeId,
				reason: "this handoff request already completed; reusing the committed rotation (no second session)",
				...(budget ? { budget_before: committed.budget, budget_after: committed.budget } : {}),
			};
		}

		if (!episodeId) return { applied: false, reason: "no open episode to hand over" };
		const usedRotations = committedRotations(events, episodeId);
		const budgetCheck = budgetAllowsSession(budget, usedRotations);
		if (!budgetCheck.allowed)
			return { applied: false, reason: budgetCheck.reason, episode_id: episodeId, request_id: effectiveRequestId };

		const workCycle = projectWorkCycle(events, episodeId, resolveWorkCyclePolicy(process.env));
		const ram = buildRam({
			board,
			state,
			episodeId,
			goal: state.episodes[episodeId]?.goal?.description || "",
			workCycle,
		});
		const verdict = evaluateHandoff({
			state,
			board,
			ram,
			episodeId,
			reason: reason || handoff?.reason || "automatic post-settle rotation",
			requestId: effectiveRequestId,
			workCycle,
		});
		if (!verdict.allowed)
			return { applied: false, reason: verdict.reason, episode_id: episodeId, request_id: effectiveRequestId };

		const budgetBefore = committed.budget;
		const result = await applyStagedHandoff({ eventLogPath, handoffPath, runtime, taskId, continuation });
		if (!result.applied) {
			return {
				applied: false,
				cancelled: result.cancelled === true,
				reason: result.reason,
				episode_id: result.episode_id ?? episodeId,
				request_id: result.request_id ?? effectiveRequestId,
			};
		}

		// E2: the Host verifies the completion itself rather than trusting the
		// helper/SDK return. Exactly one committed `handoff.completed` must exist for
		// this request, bound to this episode, naming the bound runtime's Session.
		const verified = await readCommitted({ eventLogPath, handoffPath, budget, manifest });
		const completion = verified.ok
			? verified.events.find(
					(event) => event.event_type === "handoff.completed" && event.payload?.request_id === effectiveRequestId,
				)
			: null;
		const completionCount = verified.ok
			? verified.events.filter(
					(event) => event.event_type === "handoff.completed" && event.payload?.request_id === effectiveRequestId,
				).length
			: 0;
		let boundSessionId = result.to_session ?? null;
		try {
			boundSessionId = runtime.session?.sessionId ?? boundSessionId;
		} catch {
			// keep the helper-reported id
		}
		if (!completion || completionCount !== 1) {
			return {
				applied: false,
				reason: `no unique committed handoff completion could be verified for ${effectiveRequestId} (found ${completionCount})`,
				episode_id: episodeId,
				request_id: effectiveRequestId,
			};
		}
		if (completion.episode_id !== episodeId && completion.payload?.episode_id !== episodeId) {
			return {
				applied: false,
				reason: "the committed completion is bound to a different episode",
				episode_id: episodeId,
				request_id: effectiveRequestId,
			};
		}
		if (completion.payload?.to_session && boundSessionId && completion.payload.to_session !== boundSessionId) {
			return {
				applied: false,
				reason: "the committed completion names a different Session than the bound runtime",
				episode_id: episodeId,
				request_id: effectiveRequestId,
			};
		}

		// Budget continuity: a rotation legitimizes exactly ONE new session
		// generation. The Host charges that generation from the COMMITTED event
		// count (not from a mutable caller ledger), and asserts remaining never
		// grows. It never resets a cumulative accumulator.
		let budgetAfter = budgetBefore;
		let newSessionId = null;
		try {
			newSessionId = runtime.session?.sessionId ?? null;
		} catch {
			newSessionId = null;
		}
		if (budgetBefore) {
			// A rotation legitimately charges exactly ONE Session generation: the
			// cumulative usage is the caller's BASE consumption PLUS every committed
			// rotation for this episode (never a reset, never a double charge).
			const afterCommitted = await readCommitted({ eventLogPath, handoffPath, budget, manifest });
			const rotationsAfter = afterCommitted.ok
				? committedRotations(afterCommitted.events, result.episode_id ?? episodeId)
				: usedRotations + 1;
			budgetAfter = budgetSnapshot({
				limit: budgetBefore.limit,
				consumed: {
					...budgetBefore.consumed,
					session_count: (budgetBefore.consumed.session_count ?? 0) + rotationsAfter,
				},
				reserved: budgetBefore.reserved,
				max_requests_per_session: budgetBefore.max_requests_per_session,
			});
		}
		return {
			applied: true,
			reused: false,
			request_id: result.request_id ?? effectiveRequestId,
			episode_id: result.episode_id ?? episodeId,
			new_session_id: newSessionId,
			...(budgetBefore ? { budget_before: budgetBefore, budget_after: budgetAfter } : {}),
		};
	}

	/**
	 * Recover an interrupted handoff: a staged request with no committed
	 * completion. It re-applies ONCE through the same real path. It never re-runs
	 * an unconfirmed Task side effect (it only rebinds the session).
	 */
	async function recoverInterrupted() {
		const committed = await readCommitted({ eventLogPath, handoffPath, budget, manifest });
		if (!committed.ok) return { recovered: false, reason: committed.reason };
		const { handoff, completedIds } = committed;
		if (!handoff?.episode_id) return { recovered: false, reason: "no staged handoff to recover" };
		if (handoff.request_id && completedIds.has(handoff.request_id)) {
			return {
				recovered: false,
				reason: "the staged handoff already completed; nothing to recover",
				request_id: handoff.request_id,
			};
		}
		const result = await rotate({ requestId: handoff.request_id, reason: handoff.reason });
		if (result.applied)
			return {
				...result,
				recovered: true,
				applied: true,
				request_id: result.request_id,
				episode_id: result.episode_id,
			};
		return { ...result, recovered: false, applied: false, reason: result.reason, request_id: result.request_id };
	}

	return { canRotate, rotate, recoverInterrupted };
}
