// Host-side staging of a Session handoff request.
//
// Extracted from `campaign/c6-entry.mjs#stageHostHandoff` so the Experiment
// Console Host and the Campaign Host stage the SAME request shape through the
// SAME validation (`session/handoff.mjs#evaluateHandoff`). Staging writes the
// derived request file only: it grants nothing. A real replacement still has to
// pass the Supervisor budget/safety check and bind a genuinely new Session, and
// only the post-bind Observer writes `handoff.completed`.
//
// This module deliberately does not decide WHEN to rotate; the caller owns that
// policy. It only refuses to stage an unsafe request.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectBoard } from "../memory/board.mjs";
import { buildRam } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";
import { projectWorkCycle, recommendWorkHandoff, resolveWorkCyclePolicy } from "../memory/work-cycle.mjs";
import { readEventsSafe } from "../shared/events.mjs";
import { evaluateHandoff } from "./handoff.mjs";
import { latestSessionUsage } from "./work-cycle-rotation.mjs";

/** Task -> open Episode id, falling back to any open Episode (single-task logs). */
export function resolveOpenEpisodeId(state, taskId) {
	for (const [id, episode] of Object.entries(state.episodes ?? {})) {
		if (episode.status === "open" || episode.status === "active") {
			if (!taskId || episode.task_id === taskId) return id;
		}
	}
	for (const [id, episode] of Object.entries(state.episodes ?? {})) {
		if (episode.status === "open" || episode.status === "active") return id;
	}
	return null;
}

/**
 * Stage a Host-initiated handoff request into the shared handoff file.
 *
 * @param {{eventLogPath: string, handoffPath: string, taskId: string, reason: string, manifest?: any,
 *   workCyclePolicy?: any, workCycleIdentity?: string|null, workCycleReasons?: string[],
 *   requestId?: string|null, boundaryReasons?: string[]}} args
 */
export function stageHostHandoff({
	eventLogPath,
	handoffPath,
	taskId,
	reason,
	manifest = null,
	workCyclePolicy = null,
	workCycleIdentity = null,
	workCycleReasons = [],
	requestId = null,
	boundaryReasons = null,
}) {
	const events = readEventsSafe(eventLogPath);
	const state = projectState(events);
	const board = projectBoard(events, { manifest });
	const episodeId = state.open_handoff?.episode_id ?? resolveOpenEpisodeId(state, taskId);
	if (!episodeId) return { ok: false, reason: "no open episode to hand over" };
	const policy = workCyclePolicy ?? resolveWorkCyclePolicy(process.env);
	const workCycle = projectWorkCycle(events, episodeId, { policy, board, manifest });
	const usage = latestSessionUsage(events, episodeId);
	const advisory = recommendWorkHandoff({
		cycle: workCycle,
		contextUsage: usage?.context_usage ?? null,
		policy,
		sourceSessionId: usage?.session_id ?? null,
	});
	const ram = buildRam({
		board,
		state,
		episodeId,
		goal: state.episodes[episodeId]?.goal?.description ?? "",
		workCycle: { ...workCycle, handoff: advisory },
	});
	const effectiveRequestId = requestId ?? `host-rotate-${events.length}-${Date.now()}`;
	const verdict = evaluateHandoff({
		state,
		board,
		ram,
		episodeId,
		reason,
		requestId: effectiveRequestId,
		workCycle,
	});
	if (!verdict.allowed) return { ok: false, reason: verdict.reason, blocking: verdict.pending_actions ?? [] };
	const boundaryIdentity = workCycleIdentity ?? advisory.identity ?? `explicit:${effectiveRequestId}`;
	/** @type {{work_cycle?: Record<string, unknown>|null}|undefined} */
	const handoffView = verdict.handoff;
	const stagedWorkCycle = handoffView?.work_cycle
		? {
				...handoffView.work_cycle,
				boundary_identity: boundaryIdentity,
				boundary_reasons: (boundaryReasons ?? workCycleReasons).length
					? (boundaryReasons ?? workCycleReasons)
					: advisory.reasons,
				context_usage: advisory.context_usage,
			}
		: null;
	mkdirSync(dirname(handoffPath), { recursive: true });
	writeFileSync(
		handoffPath,
		JSON.stringify({ ...verdict.handoff, request_id: effectiveRequestId, work_cycle: stagedWorkCycle }, null, 2),
		"utf8",
	);
	return {
		ok: true,
		request_id: effectiveRequestId,
		episode_id: episodeId,
		reason,
		work_cycle_identity: boundaryIdentity,
	};
}
