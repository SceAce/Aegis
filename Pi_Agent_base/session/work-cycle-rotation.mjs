// Host-side work-cycle rotation decision. PURE: it reads committed events and a
// frozen Host policy, never a model value or an env variable. It never creates a
// Session; the C6 Host applies the decision through the existing Supervisor.
//
// Separation of concerns (phase-two contract):
//   * a pending review is NOT a rotation reason by itself;
//   * real context pressure may carry the unsettled hold across a safe rotation;
//   * a `complete` checkpoint bound to the CURRENT Intent may request one
//     completion handoff;
//   * the same boundary identity is never rotated twice;
//   * context identity includes the SOURCE Session + usage snapshot, so an old
//     high-water mark cannot chain rotations in the replacement Session.

import { projectWorkCycle, recommendWorkHandoff } from "../memory/work-cycle.mjs";

/** Latest committed `agent.settled` usage for an Episode (real API snapshot only). */
export function latestSessionUsage(events, episodeId) {
	let latest = null;
	for (const row of Array.isArray(events) ? events : []) {
		// Observer emits `agent.settled` as an event_type, not a runtime note.
		if (row?.event_type !== "agent.settled") continue;
		const payload = row.payload ?? {};
		if (episodeId && row.episode_id !== episodeId) continue;
		if (typeof payload.session_id !== "string" || !payload.session_id) continue;
		latest = {
			session_id: payload.session_id,
			context_usage: payload.context_usage ?? null,
			event_id: row.event_id,
		};
	}
	return latest;
}

/**
 * @param {{
 *   events?: any[],
 *   episodeId?: string,
 *   policy?: any,
 *   manifest?: any,
 *   completedBoundaries?: Set<string>,
 *   taskState?: string|null,
 *   campaignState?: string|null,
 * }} [args]
 */
export function evaluateHostWorkCycleRotation({
	events,
	episodeId,
	policy,
	manifest = null,
	completedBoundaries = new Set(),
	taskState = null,
	campaignState = null,
} = {}) {
	if (!policy || policy.enabled !== true) return { rotate: false, reason: "work_cycle_disabled" };
	if (campaignState && campaignState !== "running") return { rotate: false, reason: "campaign_not_running" };
	if (taskState && !["running", "ready"].includes(taskState)) return { rotate: false, reason: "task_not_runnable" };
	if (typeof episodeId !== "string" || !episodeId) return { rotate: false, reason: "no_episode" };
	let cycle;
	try {
		cycle = projectWorkCycle(events, episodeId, { policy, manifest });
	} catch (error) {
		return { rotate: false, reason: "work_cycle_projection_failed", detail: String(error) };
	}
	const usage = latestSessionUsage(events, episodeId);
	const recommendation = recommendWorkHandoff({
		cycle,
		contextUsage: usage?.context_usage ?? null,
		policy,
		sourceSessionId: usage?.session_id ?? null,
	});
	if (!recommendation.recommended) return { rotate: false, reason: "no_boundary", cycle, recommendation };
	if (recommendation.identity && completedBoundaries.has(recommendation.identity))
		return { rotate: false, reason: "boundary_already_rotated", cycle, recommendation };
	return {
		rotate: true,
		reasons: recommendation.reasons,
		identity: recommendation.identity,
		cycle,
		recommendation,
		context_usage: recommendation.context_usage,
		source_session_id: recommendation.source_session_id,
	};
}
