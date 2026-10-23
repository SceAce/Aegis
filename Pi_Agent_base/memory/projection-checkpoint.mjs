// Verified EventLog projection checkpoint (PERFORMANCE ONLY).
//
// The console Host re-derives Board/RuntimeState/Work-cycle from the committed
// EventLog after every settle. On a long-running experiment that is a lot of
// pure computation for an immutable prefix. This module memoizes the projection
// of one VERIFIED prefix so a Session transition with NO intervening events does
// not replay it again.
//
// Hard rules (STRUCTURED_RAM_AND_WORK_CONTROL §"下一阶段提案", phase-3 §6):
//   * The checkpoint is a deletable derived cache. It never grants permission,
//     never clears a hold, never consumes a review and never changes a budget.
//   * It is bound to: the hash-chained prefix (event offset + last event
//     id/digest + a digest of the prefix rows), the Task/Episode, the frozen
//     work-cycle policy digest, the trusted config digest, the projection
//     version AND the reducer version. Any mismatch => full replay.
//   * A tampered/stale/foreign/corrupt/unreadable checkpoint is IGNORED (or
//     reported as rejected) and the caller gets the same answer from a complete
//     replay. Deleting the file must produce an identical projection.
//   * When a committed tail exists, the SAME reducers run over prefix + tail;
//     the cache saves the "no new events" round trip, not the reducer work. We
//     therefore report `replayed_rows`/`tail_rows` instead of claiming O(1).
//
// The authoritative source is always the EventLog. This module only answers
// "what did the reducers output for this exact prefix".

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { digest } from "../shared/events.mjs";
import { projectBoard } from "./board.mjs";
import { projectState } from "./state.mjs";
import { normalizeWorkCyclePolicy, projectWorkCycle } from "./work-cycle.mjs";

export const PROJECTION_CHECKPOINT_VERSION = "aegis-projection-checkpoint-1";
/** Bump whenever a reducer's output shape/semantics change. */
export const PROJECTION_REDUCER_VERSION = "board-current/state-1/work-cycle-1";

/** Digest of the frozen policy fields that can change the projection. */
export function projectionPolicyDigest(policy) {
	const normalized = normalizeWorkCyclePolicy(policy ?? {});
	return digest({
		repeat_limit: normalized.repeat_limit,
		action_window: normalized.action_window,
		min_distinct_routes: normalized.min_distinct_routes,
		context_pressure_percent: normalized.context_pressure_percent,
	});
}

/** Digest of the rows that make up a prefix (order-sensitive). */
function prefixDigest(rows) {
	return digest((Array.isArray(rows) ? rows : []).map((row) => row?.event_digest ?? null));
}

/**
 * Canonical, cycle-free view of a projection.
 *
 * The board/state objects can share references, so a naive JSON digest is not
 * stable across a round trip through disk. These functions pick EXACTLY the
 * authority-relevant fields (Board nodes/current view, Task/Episode state,
 * pending responsibility, handoff identity, work-cycle hold/trigger/counters/
 * consumptions/checkpoint/policy) with sorted keys, so the digest of the live
 * projection equals the digest of its persisted form — and covers every field
 * the phase-3 contract requires to stay identical.
 */
function byId(a, b) {
	return String(a.id ?? a.event_id ?? "").localeCompare(String(b.id ?? b.event_id ?? ""));
}

function canonBoard(board) {
	if (!board || typeof board !== "object") return null;
	const nodes = (Array.isArray(board.nodes) ? board.nodes : [])
		.map((node) => ({
			id: node?.node_id ?? null,
			type: node?.type ?? null,
			status: node?.status ?? null,
			effective: node?.effective !== false,
			origin: node?.origin_event_id ?? null,
			episode: node?.episode_id ?? null,
			scope: node?.scope ?? null,
		}))
		.sort(byId);
	const current = Object.fromEntries(
		Object.entries(board.currentByType ?? {})
			.map(([type, list]) => [type, (Array.isArray(list) ? list : []).map((node) => node?.node_id ?? null).sort()])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	const rejections = (Array.isArray(board.rejections) ? board.rejections : [])
		.map((item) => item?.event_id ?? null)
		.sort();
	return {
		nodes,
		current,
		rejections,
		digest: board.digest ?? null,
		effective_digest: board.effective_digest ?? null,
	};
}

function canonState(state) {
	if (!state || typeof state !== "object") return null;
	const episodes = Object.fromEntries(
		Object.entries(state.episodes ?? {})
			.map(([id, episode]) => [
				id,
				{
					status: episode?.status ?? null,
					task_id: episode?.task_id ?? null,
					authorization: episode?.authorization ?? null,
					budget: episode?.budget ?? null,
					sessions: Array.isArray(episode?.sessions) ? [...episode.sessions] : [],
					prompts: episode?.prompts ?? 0,
					goal: episode?.goal?.description ?? null,
					closed_at: episode?.closed_at ?? null,
				},
			])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	const pending = Object.fromEntries(
		Object.entries(state.pending_actions ?? {})
			.map(([id, action]) => [
				id,
				{
					status: action?.status ?? null,
					tool_name: action?.tool_name ?? null,
					episode_id: action?.episode_id ?? null,
					task_id: action?.task_id ?? null,
				},
			])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	const handoffs = (Array.isArray(state.handoffs) ? state.handoffs : [])
		.map((row) => ({
			event_id: row?.event_id ?? null,
			request_id: row?.request_id ?? null,
			to_session: row?.to_session ?? null,
			from_session: row?.from_session ?? null,
			episode_id: row?.episode_id ?? null,
		}))
		.sort(byId);
	const open = state.open_handoff
		? {
				request_id: state.open_handoff.request_id ?? null,
				episode_id: state.open_handoff.episode_id ?? null,
			}
		: null;
	return {
		version: state.version ?? null,
		tasks: Object.fromEntries(Object.entries(state.tasks ?? {}).sort(([a], [b]) => a.localeCompare(b))),
		episodes,
		pending,
		handoffs,
		open_handoff: open,
		reviews: (Array.isArray(state.work_reviews) ? state.work_reviews : []).map((row) => row?.event_id ?? null),
		checkpoints: (Array.isArray(state.work_checkpoints) ? state.work_checkpoints : []).map(
			(row) => row?.event_id ?? null,
		),
	};
}

function canonCycle(cycle) {
	if (!cycle || typeof cycle !== "object") return null;
	const review = cycle.review
		? {
				event_id: cycle.review.event_id ?? null,
				selection_event_id: cycle.review.selection_event_id ?? null,
				trigger_id: cycle.review.trigger_id ?? null,
				retrieval_status: cycle.review.retrieval_status ?? null,
				work_unit_event_id: cycle.review.work_unit_event_id ?? null,
				work_unit_id: cycle.review.work_unit_id ?? null,
				bootstrap: cycle.review.bootstrap === true,
			}
		: null;
	const checkpoint = cycle.checkpoint
		? {
				event_id: cycle.checkpoint.event_id ?? null,
				unit_status: cycle.checkpoint.unit_status ?? null,
				work_unit_event_id: cycle.checkpoint.work_unit_event_id ?? null,
			}
		: null;
	return {
		status: cycle.status ?? null,
		review_required: cycle.review_required === true,
		reasons: Array.isArray(cycle.reasons) ? [...cycle.reasons] : [],
		trigger_id: cycle.trigger_id ?? null,
		work_unit_id: cycle.work_unit_id ?? null,
		work_unit_event_id: cycle.work_unit_event_id ?? null,
		current_intent: cycle.current_intent
			? { event_id: cycle.current_intent.event_id ?? null, scope: cycle.current_intent.scope ?? null }
			: null,
		review,
		last_review_event_id: cycle.last_review?.event_id ?? null,
		failed_review_event_ids: Array.isArray(cycle.failed_review_event_ids) ? [...cycle.failed_review_event_ids] : [],
		consumptions: (Array.isArray(cycle.consumptions) ? cycle.consumptions : []).map((entry) => ({
			review_event_id: entry?.review_event_id ?? null,
			selection_event_id: entry?.selection_event_id ?? null,
			intent_event_id: entry?.intent_event_id ?? null,
			trigger_id: entry?.trigger_id ?? null,
		})),
		action_count: cycle.action_count ?? 0,
		review_round_action_count: cycle.review_round_action_count ?? 0,
		unique_routes: cycle.unique_routes ?? 0,
		repeat_count: cycle.repeat_count ?? 0,
		trusted_progress_event_id: cycle.trusted_progress_event_id ?? null,
		checkpoint,
		historical_checkpoint_event_id: cycle.historical_checkpoint?.event_id ?? null,
		unscoped: cycle.unscoped === true,
		bootstrap_review: cycle.bootstrap_review === true,
		complete_candidate: cycle.complete_candidate === true,
		work_unit_state: cycle.work_unit_state ?? null,
		accepted_intent_count: cycle.accepted_intent_count ?? 0,
		policy: {
			repeat_limit: cycle.policy?.repeat_limit ?? null,
			action_window: cycle.policy?.action_window ?? null,
			min_distinct_routes: cycle.policy?.min_distinct_routes ?? null,
			context_pressure_percent: cycle.policy?.context_pressure_percent ?? null,
		},
		evidence_event_ids: Array.isArray(cycle.evidence_event_ids) ? [...cycle.evidence_event_ids] : [],
		window_start_event_id: cycle.window_start_event_id ?? null,
		usage: (Array.isArray(cycle.usage) ? cycle.usage : []).map((entry) => ({
			selection_event_id: entry?.selection_event_id ?? null,
			knowledge_ids: Array.isArray(entry?.knowledge_ids) ? [...entry.knowledge_ids] : [],
			intent_event_id: entry?.intent_event_id ?? null,
			action_event_id: entry?.action_event_id ?? null,
			outcome_event_id: entry?.outcome_event_id ?? null,
			status: entry?.status ?? null,
		})),
		handoff: cycle.handoff
			? {
					recommended: cycle.handoff.recommended === true,
					reasons: Array.isArray(cycle.handoff.reasons) ? [...cycle.handoff.reasons] : [],
					identity: cycle.handoff.identity ?? null,
					source_session_id: cycle.handoff.source_session_id ?? null,
					context_usage: cycle.handoff.context_usage ?? null,
				}
			: null,
	};
}

/** Digest of the projection outputs (the equality oracle for a cache hit). */
export function projectionDigest({ board, state, workCycle }) {
	return digest({ board: canonBoard(board), state: canonState(state), workCycle: canonCycle(workCycle) });
}

/**
 * Run the canonical reducers for one committed prefix.
 *
 * @param {any[]} events
 * @param {{taskId?: string|null, episodeId?: string|null, policy?: any, manifest?: any}} [options]
 */
export function projectCommitted(events, options = {}) {
	const rows = Array.isArray(events) ? events : [];
	const board = projectBoard(rows, options.manifest ? { manifest: options.manifest } : {});
	const state = projectState(rows);
	const episodeId = options.episodeId ?? (options.taskId ? (state.tasks?.[options.taskId] ?? null) : null);
	const workCycle = projectWorkCycle(rows, episodeId ?? null, {
		policy: options.policy ?? {},
		board,
		...(options.manifest ? { manifest: options.manifest } : {}),
	});
	return { board, state, workCycle, episodeId: episodeId ?? null };
}

function buildCheckpoint({ events, projection, taskId, episodeId, policyDigest, configDigest }) {
	const rows = Array.isArray(events) ? events : [];
	const last = rows[rows.length - 1] ?? null;
	return {
		version: PROJECTION_CHECKPOINT_VERSION,
		reducer_version: PROJECTION_REDUCER_VERSION,
		task_id: taskId ?? null,
		episode_id: episodeId ?? null,
		policy_digest: policyDigest,
		config_digest: configDigest ?? null,
		event_offset: rows.length,
		last_event_id: last?.event_id ?? null,
		last_event_digest: last?.event_digest ?? null,
		prefix_digest: prefixDigest(rows),
		projection_digest: projectionDigest(projection),
		projection: {
			board: projection.board,
			state: projection.state,
			workCycle: projection.workCycle,
			episodeId: projection.episodeId,
		},
	};
}

/**
 * Validate a cached checkpoint against the CURRENT committed rows. Returns
 * `{ok:true}` only when the checkpoint is a verified prefix of the same chain,
 * for the same Task/Episode, with the same policy/config/reducer versions.
 *
 * @param {any} checkpoint
 * @param {any[]} events
 * @param {{taskId?: string|null, policyDigest: string, configDigest?: string|null}} expected
 */
export function verifyProjectionCheckpoint(checkpoint, events, expected) {
	if (!checkpoint || typeof checkpoint !== "object") return { ok: false, reason: "missing_checkpoint" };
	if (checkpoint.version !== PROJECTION_CHECKPOINT_VERSION) return { ok: false, reason: "checkpoint_version_unknown" };
	if (checkpoint.reducer_version !== PROJECTION_REDUCER_VERSION)
		return { ok: false, reason: "reducer_version_unknown" };
	if ((checkpoint.task_id ?? null) !== (expected.taskId ?? null)) return { ok: false, reason: "foreign_task" };
	if ((checkpoint.policy_digest ?? null) !== expected.policyDigest)
		return { ok: false, reason: "policy_digest_mismatch" };
	if ((checkpoint.config_digest ?? null) !== (expected.configDigest ?? null))
		return { ok: false, reason: "config_digest_mismatch" };
	const rows = Array.isArray(events) ? events : [];
	const offset = checkpoint.event_offset;
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length)
		return { ok: false, reason: "offset_out_of_range" };
	const prefix = rows.slice(0, offset);
	const last = prefix[prefix.length - 1] ?? null;
	if ((last?.event_id ?? null) !== (checkpoint.last_event_id ?? null))
		return { ok: false, reason: "prefix_id_mismatch" };
	if ((last?.event_digest ?? null) !== (checkpoint.last_event_digest ?? null))
		return { ok: false, reason: "prefix_digest_mismatch" };
	if (prefixDigest(prefix) !== checkpoint.prefix_digest) return { ok: false, reason: "prefix_rows_mismatch" };
	const projection = checkpoint.projection;
	if (!projection || typeof projection !== "object") return { ok: false, reason: "projection_missing" };
	if (projectionDigest(projection) !== checkpoint.projection_digest)
		return { ok: false, reason: "projection_digest_mismatch" };
	return { ok: true, offset, tail_rows: rows.length - offset };
}

/**
 * Read a checkpoint file. A missing/unreadable file is simply "no cache".
 * @param {string} path
 */
export async function readProjectionCheckpoint(path) {
	if (typeof path !== "string" || !path) return null;
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

/** Atomically (temp + rename) write the cache. Failure is never fatal. */
export async function writeProjectionCheckpoint(path, checkpoint) {
	if (typeof path !== "string" || !path) return { ok: false, reason: "no_checkpoint_path" };
	try {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(tmp, JSON.stringify(checkpoint), "utf8");
		await rename(tmp, path);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: String(error) };
	}
}

/** Delete the derived cache (used by tests and by a failed verification). */
export async function deleteProjectionCheckpoint(path) {
	if (typeof path !== "string" || !path) return { ok: true };
	try {
		await unlink(path);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: String(error) };
	}
}

/**
 * Project a committed prefix, reusing a VERIFIED checkpoint when the prefix is
 * unchanged.
 *
 * @param {{
 *   events: any[],
 *   taskId?: string|null,
 *   episodeId?: string|null,
 *   policy?: any,
 *   manifest?: any,
 *   checkpointPath?: string|null,
 *   configDigest?: string|null,
 *   persist?: boolean,
 * }} args
 * @returns {Promise<{ok: boolean, source: "checkpoint"|"full_replay", tail_rows: number, replayed_rows: number,
 *   cache_reason: string|null, board: any, state: any, workCycle: any, episodeId: string|null, checkpoint: any}>}
 */
export async function projectWithCheckpoint({
	events,
	taskId = null,
	episodeId = null,
	policy = {},
	manifest = null,
	checkpointPath = null,
	configDigest = null,
	persist = true,
}) {
	const rows = Array.isArray(events) ? events : [];
	const policyDigest = projectionPolicyDigest(policy);
	const cached = await readProjectionCheckpoint(checkpointPath);
	let cacheReason = null;
	if (cached) {
		const verdict = verifyProjectionCheckpoint(cached, rows, { taskId, policyDigest, configDigest });
		if (!verdict.ok) cacheReason = verdict.reason;
		else if (verdict.tail_rows === 0) {
			const projection = cached.projection;
			return {
				ok: true,
				source: "checkpoint",
				tail_rows: 0,
				replayed_rows: 0,
				cache_reason: null,
				board: projection.board,
				state: projection.state,
				workCycle: projection.workCycle,
				episodeId: projection.episodeId ?? episodeId,
				checkpoint: cached,
			};
		} else {
			cacheReason = `committed_tail_present:${verdict.tail_rows}`;
		}
	}
	const projection = projectCommitted(rows, { taskId, episodeId, policy, manifest });
	const checkpoint = buildCheckpoint({
		events: rows,
		projection,
		taskId,
		episodeId: projection.episodeId,
		policyDigest,
		configDigest,
	});
	if (persist) await writeProjectionCheckpoint(checkpointPath, checkpoint);
	return {
		ok: true,
		source: "full_replay",
		tail_rows: cached ? rows.length : rows.length,
		replayed_rows: rows.length,
		cache_reason: cacheReason,
		board: projection.board,
		state: projection.state,
		workCycle: projection.workCycle,
		episodeId: projection.episodeId,
		checkpoint,
	};
}
