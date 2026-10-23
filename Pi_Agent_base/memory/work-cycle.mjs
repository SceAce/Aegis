// Work-cycle projection over committed Episode events.
//
// This is a PURE, ADVISORY reducer. It can request a review and it can tell the
// caller whether a side-effecting tool must stay blocked, but it never creates
// an Outcome/Fact, never grants permission and never decides that a task failed.
// The only inputs are the committed EventLog rows, the current Episode id and a
// TRUSTED host policy (never a model-supplied limit).
//
// Reused authority:
//   * trusted progress is exactly what `memory/board.mjs#permittedNodeType`
//     accepts as a Fact (oracle/human Outcome success, or a verified observation
//     that carries value + evidence + target revision). No second definition.
//   * repeat identity is the committed `arguments_digest` of the request plus the
//     real `content_digest` of the completion.
//
// The reducer deliberately does not parse shell commands. General `bash` stays
// opaque and is counted conservatively as a possibly side-effecting route.

import { digest } from "../shared/events.mjs";
import { projectBoard } from "./board.mjs";

export const WORK_CYCLE_VERSION = "work-cycle-1";
export const WORK_CHECKPOINT_KIND = "work.checkpoint";
export const WORK_REVIEW_KIND = "work.review";
export const WORK_REVIEW_SELECTION_MODE = "work_review";

export const WORK_CYCLE_REASONS = Object.freeze([
	"same_action_same_result_repeated",
	"multiple_routes_without_verified_progress",
]);

/** Tools that never mutate the workspace. Shared by the Observer gate and RAM. */
export const WORK_READ_ONLY_TOOLS = Object.freeze([
	"read",
	"ls",
	"grep",
	"find",
	"glob",
	"webfetch",
	"websearch",
	"aegis_read",
	"aegis_observe",
	"aegis_remote_request",
	"aegis_artifact_read",
]);

/**
 * Aegis control tools that record their own durable intent/observation and are
 * not workspace side effects. Retrieval and review are ALWAYS allowed while a
 * review is pending; `aegis_propose`/`aegis_work_checkpoint` have their own
 * scoped validation in the Observer so they cannot bypass an open review.
 */
export const WORK_CONTROL_TOOLS = Object.freeze([
	"aegis_propose",
	"aegis_switch_session",
	"aegis_submit_candidate",
	"aegis_knowledge",
	"aegis_web_search",
	"aegis_work_review",
	"aegis_work_checkpoint",
	"aegis_task_decision",
	"aegis_submit_plan",
	"aegis_tools",
	"aegis_toolbox",
	"aegis_tool_note",
	"aegis_observe",
	"aegis_artifact_read",
]);

const READ_ONLY = new Set(WORK_READ_ONLY_TOOLS);
const CONTROL = new Set(WORK_CONTROL_TOOLS);

/** True when a tool may change the workspace/environment and must be gated. */
export function isEffectCapableTool(toolName) {
	if (typeof toolName !== "string" || toolName.length === 0) return true;
	return !READ_ONLY.has(toolName) && !CONTROL.has(toolName);
}

const REVIEW_ADVISORY_TOOLS = new Set([
	...WORK_READ_ONLY_TOOLS,
	"aegis_knowledge",
	"aegis_web_search",
	"aegis_work_review",
	"aegis_work_checkpoint",
	"aegis_switch_session",
	"aegis_tools",
	"aegis_toolbox",
	"aegis_tool_note",
]);

/**
 * Decide whether a tool call may proceed while a work review is pending.
 *
 * Allowed: read-only observation, retrieval, the review/checkpoint record and the
 * handoff control tool. A model proposal is allowed ONLY as an Intent that cites
 * the CURRENT committed review (or its recorded retrieval) with a NEW scope. An
 * effect-capable tool is blocked and terminates the same batch. A rejected path
 * never clears the hold: the projection recomputes from committed events.
 *
 * @param {any} cycle output of `projectWorkCycle`
 * @param {{tool_name?: string, input?: any}} call
 * @returns {{allowed: boolean, reason: string, terminate: boolean}}
 */
export function evaluateWorkCycleGate(cycle, call = {}) {
	if (!cycle || cycle.review_required !== true)
		return { allowed: true, reason: "no_review_required", terminate: false };
	const name = typeof call.tool_name === "string" ? call.tool_name : "";
	const input = call.input && typeof call.input === "object" ? call.input : {};
	const reviewEventId = typeof cycle.review?.event_id === "string" ? cycle.review.event_id : null;
	const selectionEventId =
		typeof cycle.review?.selection_event_id === "string" ? cycle.review.selection_event_id : null;
	if (name === "aegis_propose") {
		if (input.kind !== "intent") return { allowed: false, reason: "review_pending_intent_only", terminate: false };
		const scope = typeof input.scope === "string" ? input.scope.trim() : "";
		if (!scope) return { allowed: false, reason: "new_scoped_intent_required", terminate: false };
		if (!reviewEventId) return { allowed: false, reason: "complete_work_review_first", terminate: false };
		if (cycle.work_unit_id && scope === cycle.work_unit_id)
			return { allowed: false, reason: "intent_scope_must_be_new", terminate: false };
		const refs = Array.isArray(input.source_refs)
			? input.source_refs
					.map((ref) => (typeof ref === "string" ? ref : ref?.ref_id))
					.filter((id) => typeof id === "string")
			: [];
		if (!refs.includes(reviewEventId) && !(selectionEventId && refs.includes(selectionEventId)))
			return { allowed: false, reason: "intent_must_cite_current_review", terminate: false };
		return { allowed: true, reason: "scoped_intent_cites_review", terminate: false };
	}
	if (REVIEW_ADVISORY_TOOLS.has(name) && !isEffectCapableTool(name))
		return { allowed: true, reason: "read_or_review_tool", terminate: false };
	return { allowed: false, reason: "effect_capable_tool_blocked_until_review_and_scoped_intent", terminate: true };
}

/**
 * Trusted Host switch for the work-unit START gate.
 *
 * A standalone interactive Pi run keeps the historical behaviour (optional
 * scoped Intents). The Experiment Console Host binds this value for its own run
 * so that NO effect-capable call can run before a non-empty, same-Episode scoped
 * Intent is durably committed. It is read from the Host environment only; a
 * model can never set it.
 */
export const WORK_START_GATE_ENV = "AEGIS_WORK_START_GATE";

/** True when the trusted Host requested the scoped-Intent start gate. */
export function workStartGateEnabled(env = process.env) {
	const raw = env && typeof env === "object" ? env[WORK_START_GATE_ENV] : null;
	if (typeof raw !== "string") return false;
	return ["on", "1", "true", "enabled"].includes(raw.trim().toLowerCase());
}

/**
 * Decide whether a call may proceed while the Episode has NO accepted scoped
 * Intent (derived `unscoped` status).
 *
 * While unscoped, the model may observe, retrieve knowledge, consult the tool
 * catalogue, review/checkpoint and submit a NON-EMPTY scoped Intent. Every
 * effect-capable call is refused, and the refusal terminates the same assistant
 * batch so a parallel Intent+effect cannot race ahead of the commit.
 *
 * @param {any} cycle output of `projectWorkCycle`
 * @param {{tool_name?: string, input?: any}} call
 * @returns {{allowed: boolean, reason: string, terminate: boolean}}
 */
export function evaluateWorkStartGate(cycle, call = {}) {
	if (!cycle || cycle.unscoped !== true) return { allowed: true, reason: "work_unit_scoped", terminate: false };
	const name = typeof call.tool_name === "string" ? call.tool_name : "";
	const input = call.input && typeof call.input === "object" ? call.input : {};
	if (name === "aegis_propose") {
		if (input.kind !== "intent")
			return { allowed: false, reason: "proposal_kind_not_intent_before_work_unit", terminate: false };
		const scope = typeof input.scope === "string" ? input.scope.trim() : "";
		if (!scope) return { allowed: false, reason: "scoped_intent_scope_required", terminate: false };
		return { allowed: true, reason: "unscoped_start_intent", terminate: false };
	}
	if (!isEffectCapableTool(name) && REVIEW_ADVISORY_TOOLS.has(name))
		return { allowed: true, reason: "read_or_review_tool", terminate: false };
	return { allowed: false, reason: "scoped_intent_required_before_effect", terminate: true };
}

const MAX_EVIDENCE_REFS = 24;
const MAX_SELECTED_KNOWLEDGE = 8;

/**
 * Default HOST POLICY (T0 defaults, owner review pending). These are
 * centralized here and can only be changed through `resolveWorkCyclePolicy`,
 * which reads trusted Host environment values. Tests pass explicit policies;
 * a model can never supply one.
 */
export const WORK_CYCLE_POLICY_DEFAULTS = Object.freeze({
	repeat_limit: 3,
	action_window: 8,
	min_distinct_routes: 4,
	context_pressure_percent: 85,
});

const POLICY_BOUNDS = Object.freeze({
	repeat_limit: [2, 10],
	action_window: [3, 50],
	min_distinct_routes: [2, 50],
	context_pressure_percent: [50, 95],
});

const POLICY_ENV = Object.freeze({
	repeat_limit: "AEGIS_WORK_CYCLE_REPEAT_LIMIT",
	action_window: "AEGIS_WORK_CYCLE_ACTION_WINDOW",
	min_distinct_routes: "AEGIS_WORK_CYCLE_MIN_DISTINCT_ROUTES",
	context_pressure_percent: "AEGIS_WORK_CYCLE_CONTEXT_PERCENT",
});

function boundedInteger(value, key, invalid) {
	const [min, max] = POLICY_BOUNDS[key];
	// Absent means "use the frozen default"; only a PRESENT but out-of-range value
	// is reported as invalid.
	if (value === undefined || value === null) return WORK_CYCLE_POLICY_DEFAULTS[key];
	if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
	invalid.push(key);
	return WORK_CYCLE_POLICY_DEFAULTS[key];
}

/**
 * @typedef {{repeat_limit?: number, action_window?: number, min_distinct_routes?: number, context_pressure_percent?: number}} WorkCyclePolicyInput
 * @typedef {{repeat_limit: number, action_window: number, min_distinct_routes: number, context_pressure_percent: number, source: string, invalid: string[], origin?: string, configured?: string[]}} WorkCyclePolicy
 */

/**
 * Normalize a trusted policy object. Invalid values fall back to the frozen
 * defaults and are reported in `invalid`; they are never widened silently.
 *
 * @param {WorkCyclePolicyInput|null} [input]
 * @returns {WorkCyclePolicy}
 */
export function normalizeWorkCyclePolicy(input = {}) {
	const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
	const invalid = [];
	const repeat_limit = boundedInteger(source.repeat_limit, "repeat_limit", invalid);
	const action_window = boundedInteger(source.action_window, "action_window", invalid);
	// min_distinct_routes cannot exceed the window it is measured over.
	const [routesMin, routesMax] = POLICY_BOUNDS.min_distinct_routes;
	let min_distinct_routes = boundedInteger(source.min_distinct_routes, "min_distinct_routes", invalid);
	if (min_distinct_routes > action_window) {
		min_distinct_routes = Math.max(routesMin, action_window);
		if (min_distinct_routes > routesMax) {
			invalid.push("min_distinct_routes");
			min_distinct_routes = Math.min(WORK_CYCLE_POLICY_DEFAULTS.min_distinct_routes, action_window);
		}
	}
	const context_pressure_percent = boundedInteger(source.context_pressure_percent, "context_pressure_percent", invalid);
	return {
		repeat_limit,
		action_window,
		min_distinct_routes,
		context_pressure_percent,
		source: "host_policy",
		invalid,
	};
}

/**
 * Resolve the work-cycle policy from TRUSTED Host configuration only. An
 * unset/invalid value falls back to the frozen default and is reported.
 */
export function resolveWorkCyclePolicy(env = process.env) {
	const source = env && typeof env === "object" ? env : {};
	/** @type {Record<string, number>} */
	const input = {};
	const set = [];
	for (const [key, name] of Object.entries(POLICY_ENV)) {
		const raw = source[name];
		if (raw === undefined || raw === null || String(raw).trim() === "") continue;
		const parsed = Number(String(raw).trim());
		input[key] = parsed;
		set.push(key);
	}
	const policy = normalizeWorkCyclePolicy(input);
	return { ...policy, origin: set.length > 0 ? "host_env" : "frozen_default", configured: set };
}

function isRow(row) {
	return row && typeof row === "object" && typeof row.event_id === "string" && row.event_id.length > 0;
}

function sameEpisode(row, episodeId) {
	return row?.episode_id === episodeId;
}

function unitScope(row) {
	if (row?.event_type !== "proposal.submitted") return null;
	if (row?.source?.kind !== "llm") return null;
	if (row?.payload?.kind !== "intent") return null;
	const scope = typeof row?.payload?.scope === "string" ? row.payload.scope.trim() : "";
	return scope.length > 0 ? scope : null;
}

function sourceRefIds(row) {
	const refs = row?.payload?.source_refs;
	if (!Array.isArray(refs)) return [];
	return refs
		.map((ref) => (typeof ref === "string" ? ref : typeof ref?.ref_id === "string" ? ref.ref_id : null))
		.filter((id) => typeof id === "string" && id.length > 0);
}

/**
 * Validate a committed `runtime.note kind=work.review` row.
 *
 * Evidence and retrieval refs must already exist in the committed prefix, belong
 * to the same Episode and precede the review row. Anything else makes the review
 * unusable for clearing the hold (fail-closed).
 */
export function readWorkReview(row, index, byId, episodeId) {
	if (typeof episodeId !== "string" || episodeId.length === 0) return null;
	if (!isRow(row) || row.event_type !== "runtime.note") return null;
	if (row.source?.kind !== "runtime" || !sameEpisode(row, episodeId)) return null;
	if (row.payload?.kind !== WORK_REVIEW_KIND || row.payload?.version !== WORK_CYCLE_VERSION) return null;
	const triggerId = typeof row.payload?.trigger_id === "string" ? row.payload.trigger_id : null;
	if (!triggerId) return null;
	const evidence = Array.isArray(row.payload?.evidence_event_ids)
		? row.payload.evidence_event_ids.filter((id) => typeof id === "string")
		: [];
	for (const id of evidence) {
		const ref = byId.get(id);
		if (!ref || ref.index >= index || !sameEpisode(ref.row, episodeId)) return null;
	}
	const retrieval = row.payload?.retrieval;
	const selectionId = typeof retrieval?.selection_event_id === "string" ? retrieval.selection_event_id : null;
	if (!selectionId) return null;
	const selection = byId.get(selectionId);
	if (
		!selection ||
		selection.index >= index ||
		!sameEpisode(selection.row, episodeId) ||
		selection.row.source?.kind !== "runtime" ||
		selection.row.payload?.kind !== "knowledge.selected" ||
		selection.row.payload?.mode !== WORK_REVIEW_SELECTION_MODE
	)
		return null;
	if (
		typeof selection.row.payload?.work_review_trigger_id === "string" &&
		selection.row.payload.work_review_trigger_id !== triggerId
	)
		return null;
	const selected = Array.isArray(selection.row.payload?.selected)
		? selection.row.payload.selected
				.map((item) => item?.knowledge_id)
				.filter((id) => typeof id === "string")
				.slice(0, MAX_SELECTED_KNOWLEDGE)
		: [];
	return {
		event_id: row.event_id,
		index,
		trigger_id: triggerId,
		work_unit_id: typeof row.payload?.work_unit_id === "string" ? row.payload.work_unit_id : null,
		work_unit_event_id: typeof row.payload?.work_unit_event_id === "string" ? row.payload.work_unit_event_id : null,
		// Explicit bootstrap variant: the trigger's earliest evidence predates the
		// first Intent, so there is no work unit to bind. The flag is only HONOURED
		// when the committed prefix really has no accepted scoped Intent (see
		// `reviewBootstrap`), so a fabricated flag on an Episode with units is inert.
		bootstrap: row.payload?.bootstrap === true,
		blocker: boundedText(row.payload?.blocker?.text, 400),
		next_step: boundedText(row.payload?.next_step?.text, 400),
		attempted_routes: Array.isArray(row.payload?.attempted_routes)
			? row.payload.attempted_routes
					.map((item) => boundedText(item, 180))
					.filter(Boolean)
					.slice(0, 6)
			: [],
		selection_event_id: selectionId,
		retrieval_status: typeof retrieval?.status === "string" ? retrieval.status : "unknown",
		selected_knowledge_ids: selected,
		evidence_event_ids: evidence.slice(0, MAX_EVIDENCE_REFS),
		trust: "unverified_model_summary",
	};
}

/** Validate a committed `runtime.note kind=work.checkpoint` row (planning metadata only). */
export function readWorkCheckpoint(row, index, byId, episodeId) {
	if (typeof episodeId !== "string" || episodeId.length === 0) return null;
	if (!isRow(row) || row.event_type !== "runtime.note") return null;
	if (row.source?.kind !== "runtime" || !sameEpisode(row, episodeId)) return null;
	if (row.payload?.kind !== WORK_CHECKPOINT_KIND || row.payload?.version !== WORK_CYCLE_VERSION) return null;
	const evidence = Array.isArray(row.payload?.evidence_event_ids)
		? row.payload.evidence_event_ids.filter((id) => typeof id === "string")
		: [];
	for (const id of evidence) {
		const ref = byId.get(id);
		if (!ref || ref.index >= index || !sameEpisode(ref.row, episodeId)) return null;
	}
	const unitStatus = ["continue", "blocked", "complete"].includes(row.payload?.unit_status)
		? row.payload.unit_status
		: "continue";
	return {
		event_id: row.event_id,
		index,
		work_unit_id: typeof row.payload?.work_unit_id === "string" ? row.payload.work_unit_id : null,
		work_unit_event_id: typeof row.payload?.work_unit_event_id === "string" ? row.payload.work_unit_event_id : null,
		unit_status: unitStatus,
		summary: boundedText(row.payload?.model_claim?.summary, 600),
		blocker: boundedText(row.payload?.model_claim?.blocker, 400),
		next_step: boundedText(row.payload?.model_claim?.next_step, 400),
		context_usage: normalizeContextUsage(row.payload?.context_usage),
		evidence_event_ids: evidence.slice(0, MAX_EVIDENCE_REFS),
		trust: "unverified_model_summary",
	};
}

/**
 * Validate caller-supplied evidence references against the committed prefix.
 * Foreign, future, duplicate or malformed references are refused.
 *
 * @returns {{ok: boolean, ids: string[], reason?: string|null}}
 */
export function validateWorkEvidence(events, episodeId, ids) {
	if (!Array.isArray(ids) || ids.length === 0) return { ok: false, ids: [], reason: "evidence_event_ids_required" };
	if (ids.length > MAX_EVIDENCE_REFS) return { ok: false, ids: [], reason: "too_many_evidence_refs" };
	const byId = indexEvents(events);
	const seen = new Set();
	const out = [];
	for (const id of ids) {
		if (typeof id !== "string" || id.length === 0) return { ok: false, ids: [], reason: "malformed_evidence_ref" };
		if (seen.has(id)) return { ok: false, ids: [], reason: "duplicate_evidence_ref" };
		seen.add(id);
		const ref = byId.get(id);
		if (!ref) return { ok: false, ids: [], reason: "foreign_or_unknown_evidence_ref" };
		if (!sameEpisode(ref.row, episodeId)) return { ok: false, ids: [], reason: "foreign_episode_evidence_ref" };
		out.push(id);
	}
	return { ok: true, ids: out, reason: null };
}

/** @returns {Map<string, {row: any, index: number}>} */
export function indexEvents(events) {
	const byId = new Map();
	if (!Array.isArray(events)) return byId;
	for (let index = 0; index < events.length; index += 1) {
		const row = events[index];
		if (!isRow(row) || byId.has(row.event_id)) continue;
		byId.set(row.event_id, { row, index });
	}
	return byId;
}

/** Normalize a real `ctx.getContextUsage()` snapshot. Unknown stays unknown. */
export function normalizeContextUsage(usage) {
	if (!usage || typeof usage !== "object") return { known: false };
	if (usage.known === false) return { known: false };
	// Accept the raw Pi `ctx.getContextUsage()` shape ({tokens, contextWindow})
	// and the already-normalized shape ({used_tokens, limit_tokens}).
	const tokens = Number.isFinite(usage.tokens) ? usage.tokens : usage.used_tokens;
	const limit = Number.isFinite(usage.contextWindow) ? usage.contextWindow : usage.limit_tokens;
	if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(limit) || limit <= 0) return { known: false };
	const percent =
		Number.isFinite(usage.percent) && usage.percent >= 0
			? Math.min(100, usage.percent)
			: Math.min(100, Math.round((tokens / limit) * 100));
	return { known: true, used_tokens: Math.round(tokens), limit_tokens: Math.round(limit), percent };
}

/** Paired effect actions committed after `windowStart` (read-only tools excluded). */
function collectActions(rows, episodeId, windowStart) {
	const requests = new Map();
	const completed = [];
	for (let index = windowStart + 1; index < rows.length; index += 1) {
		const row = rows[index];
		if (!isRow(row) || !sameEpisode(row, episodeId) || row.source?.kind !== "runtime") continue;
		const actionId = row.payload?.action_id;
		if (row.event_type === "action.requested" && typeof actionId === "string" && !requests.has(actionId)) {
			requests.set(actionId, { row, index });
			continue;
		}
		if (row.event_type !== "action.completed" || typeof actionId !== "string") continue;
		const start = requests.get(actionId);
		if (!start) continue;
		requests.delete(actionId);
		const toolName =
			typeof start.row.payload?.tool_name === "string"
				? start.row.payload.tool_name
				: typeof row.payload?.tool_name === "string"
					? row.payload.tool_name
					: "unknown";
		// Only real effect routes count. Read-only tools never count, and Aegis
		// control/planning tools (propose/knowledge/review/checkpoint/task decision)
		// are not effects. `aegis_execute` IS an effect path and stays counted.
		if (READ_ONLY.has(toolName) || (CONTROL.has(toolName) && toolName !== "aegis_execute")) continue;
		const argumentsDigest =
			typeof start.row.payload?.arguments_digest === "string" && start.row.payload.arguments_digest
				? start.row.payload.arguments_digest
				: digest(start.row.payload?.input ?? {});
		const contentDigest =
			typeof row.payload?.content_digest === "string" && row.payload.content_digest ? row.payload.content_digest : null;
		completed.push({
			request_event_id: start.row.event_id,
			completion_event_id: row.event_id,
			tool_name: toolName,
			signature: `${toolName}\u0000${argumentsDigest}`,
			// A missing result digest is UNKNOWN, never "same as success".
			result_digest: contentDigest,
			status: typeof row.payload?.status === "string" ? row.payload.status : "unknown",
			index,
		});
	}
	return completed;
}

/** Reviews with these retrieval outcomes are usable; `unavailable` may be retried. */
export const WORK_REVIEW_USABLE_STATUSES = Object.freeze(["ready", "no_match", "disabled"]);

function boundedText(value, limit) {
	return typeof value === "string" ? value.slice(0, limit) : null;
}

/**
 * Effective scoped work Intents, ordered by their committed position.
 *
 * The Board owns effectiveness/replacement. A raw `proposal.submitted` row that
 * was replaced is NOT a current unit; taking "the latest raw row" would make the
 * reducer disagree with the Board/RAM subgoal view.
 */
function effectiveWorkIntents(episodeId, board, byId) {
	const proposal = new Map();
	for (const [id, entry] of byId) {
		if (!sameEpisode(entry.row, episodeId)) continue;
		const scope = unitScope(entry.row);
		if (!scope) continue;
		proposal.set(id, {
			event_id: id,
			scope,
			index: entry.index,
			source_refs: sourceRefIds(entry.row),
			causation_id: typeof entry.row.causation_id === "string" ? entry.row.causation_id : null,
		});
	}
	const effectiveIds = new Set(
		(board?.currentByType?.Intent ?? [])
			.filter((node) => node?.episode_id === episodeId && node?.type === "Intent" && node?.effective !== false)
			.map((node) => node.origin_event_id),
	);
	return [...proposal.values()].filter((intent) => effectiveIds.has(intent.event_id)).sort((a, b) => a.index - b.index);
}

/**
 * Every scoped Intent that was accepted at its OWN committed position, whether
 * or not a later `replace_event_id` removed it from the final effective Board.
 *
 * Review consumption is an immutable historical projection: a replacement must
 * not retroactively move which Intent consumed a review. The Board's accepted/
 * rejected proposal gate is reused (`board.rejections`); merely being superseded
 * later does not invalidate the earlier acceptance.
 */
function historicalWorkIntents(episodeId, board, byId) {
	const rejected = new Set(
		(Array.isArray(board?.rejections) ? board.rejections : [])
			.map((item) => item?.event_id)
			.filter((id) => typeof id === "string"),
	);
	const out = [];
	for (const [id, entry] of byId) {
		if (!sameEpisode(entry.row, episodeId) || rejected.has(id)) continue;
		const scope = unitScope(entry.row);
		if (!scope) continue;
		out.push({
			event_id: id,
			scope,
			index: entry.index,
			source_refs: sourceRefIds(entry.row),
			causation_id: typeof entry.row.causation_id === "string" ? entry.row.causation_id : null,
		});
	}
	return out.sort((a, b) => a.index - b.index);
}

/** Bind a checkpoint to exactly one effective Intent that precedes it. */
function checkpointUnitIntent(checkpoint, intents, byId, episodeId) {
	if (checkpoint.work_unit_event_id) {
		const ref = byId.get(checkpoint.work_unit_event_id);
		if (!ref || ref.index >= checkpoint.index || !sameEpisode(ref.row, episodeId)) return null;
		const intent = intents.find((item) => item.event_id === checkpoint.work_unit_event_id) ?? null;
		if (!intent) return null;
		if (checkpoint.work_unit_id && intent.scope !== checkpoint.work_unit_id) return null;
		return intent;
	}
	// Legacy checkpoint without `work_unit_event_id`: derive a binding ONLY when the
	// earlier prefix contains exactly one effective Intent matching its scope.
	const candidates = intents.filter(
		(intent) =>
			intent.index < checkpoint.index && (!checkpoint.work_unit_id || intent.scope === checkpoint.work_unit_id),
	);
	return candidates.length === 1 ? candidates[0] : null;
}

function reviewUnitIntent(review, intents, historicalIntents = intents) {
	if (review.work_unit_event_id) {
		// An explicit binding is validated against the ACCEPTED PREFIX, because the
		// unit it names may be replaced later without invalidating the review that
		// was legally recorded while it was current.
		const intent = historicalIntents.find((item) => item.event_id === review.work_unit_event_id) ?? null;
		if (!intent || intent.index >= review.index) return null;
		if (review.work_unit_id && intent.scope !== review.work_unit_id) return null;
		return intent;
	}
	// Legacy review without `work_unit_event_id`: only bind when the earlier prefix
	// has exactly one effective Intent matching its scope.
	const candidates = intents.filter(
		(intent) => intent.index < review.index && (!review.work_unit_id || intent.scope === review.work_unit_id),
	);
	return candidates.length === 1 ? candidates[0] : null;
}

function citesReview(intent, review) {
	const refs = new Set(intent.source_refs);
	return refs.has(review.event_id) || refs.has(review.selection_event_id);
}

/**
 * A bootstrap (no-work-unit) review is valid ONLY when the accepted prefix
 * before it contains no scoped Intent at all. That removes the `rceme-001`
 * deadlock (stall evidence predating the first Intent) without letting a review
 * bypass an existing unit.
 */
function reviewBootstrap(review, historicalIntents) {
	if (!review || review.bootstrap !== true) return false;
	if (review.work_unit_event_id) return false;
	return !historicalIntents.some((intent) => intent.index < review.index);
}

/**
 * A consuming Intent must declare a NEW scope, not re-use the stalled unit.
 * A bootstrap review has no prior unit, so the first non-empty scoped Intent
 * that cites it consumes it.
 */
function isNewScopeIntent(intent, review) {
	if (review.bootstrap === true && !review.work_unit_id) return true;
	if (!review.work_unit_id) return true;
	return intent.scope !== review.work_unit_id;
}

/**
 * The active trigger for one round window.
 *
 * Identity is formed at the EARLIEST qualifying evidence prefix and never
 * changes when later actions arrive. Without that stability, one post-review
 * action would change the trigger id and make the committed review unusable
 * (the F1 reset defect). Evidence is bounded to the forming prefix.
 */
function deriveTrigger(actions, policy, episodeId, roundStartEventId) {
	const ordered = [...actions].sort((a, b) => a.index - b.index);
	let repeatFormation = null;
	const buckets = new Map();
	for (let position = 0; position < ordered.length; position += 1) {
		const action = ordered[position];
		if (action.result_digest === null) continue;
		const key = `${action.signature}\u0000${action.result_digest}`;
		const bucket = buckets.get(key) ?? [];
		bucket.push(action);
		buckets.set(key, bucket);
		if (!repeatFormation && bucket.length >= policy.repeat_limit) {
			repeatFormation = {
				formation_index: action.index,
				formation_position: position,
				reason: WORK_CYCLE_REASONS[0],
				evidence_actions: bucket.slice(0, policy.repeat_limit),
				signature: action.signature,
				result_digest: action.result_digest,
				repeat_count: bucket.length,
			};
		}
	}
	let broadFormation = null;
	if (ordered.length >= policy.action_window) {
		for (let end = policy.action_window - 1; end < ordered.length; end += 1) {
			const windowActions = ordered.slice(end - policy.action_window + 1, end + 1);
			const routes = new Set(windowActions.map((action) => action.signature)).size;
			if (routes >= policy.min_distinct_routes) {
				broadFormation = {
					formation_index: ordered[end].index,
					formation_position: end,
					reason: WORK_CYCLE_REASONS[1],
					evidence_actions: windowActions,
					unique_routes: routes,
				};
				break;
			}
		}
	}
	let formation = null;
	if (repeatFormation && broadFormation)
		formation =
			repeatFormation.formation_position <= broadFormation.formation_position ? repeatFormation : broadFormation;
	else formation = repeatFormation ?? broadFormation;
	if (!formation) return null;
	const evidenceEventIds = formation.evidence_actions
		.flatMap((action) => [action.request_event_id, action.completion_event_id])
		.slice(0, MAX_EVIDENCE_REFS);
	const triggerId = `wrev_${digest({
		version: WORK_CYCLE_VERSION,
		episode_id: episodeId,
		policy: {
			repeat_limit: policy.repeat_limit,
			action_window: policy.action_window,
			min_distinct_routes: policy.min_distinct_routes,
		},
		window_start: roundStartEventId ?? null,
		evidence_event_ids: evidenceEventIds,
		reasons: [formation.reason],
	}).slice(7, 23)}`;
	return {
		trigger_id: triggerId,
		reasons: [formation.reason],
		evidence_event_ids: evidenceEventIds,
		action_count: ordered.length,
		unique_routes: new Set(ordered.map((action) => action.signature)).size,
		repeat_count:
			formation.signature && formation.result_digest
				? Math.max(
						policy.repeat_limit,
						ordered.filter(
							(action) => action.signature === formation.signature && action.result_digest === formation.result_digest,
						).length,
					)
				: 0,
		window_start_event_id: roundStartEventId ?? null,
	};
}

/**
 * Project the current work cycle for one committed Episode prefix.
 *
 * Two counters are derived independently:
 *   * `action_count` — every effect attempt since the last trusted progress. A
 *     review, Intent, checkpoint or Session rotation NEVER clears it.
 *   * `review_round_action_count` — attempts in the current review round. Only a
 *     trusted progress event or ONE valid consumption of the current trigger's
 *     review moves this window forward.
 *
 * @param {any[]} events committed EventLog rows (current prefix)
 * @param {string|null} episodeId
 * @param {{policy?: object, board?: any, manifest?: any}|object} [options]
 */
export function projectWorkCycle(events, episodeId, options = {}) {
	/** @type {any} */
	const raw = options;
	const policy = normalizeWorkCyclePolicy(
		raw && typeof raw === "object" && raw.policy && typeof raw.policy === "object" ? raw.policy : raw,
	);
	const rows = Array.isArray(events) ? events.filter(isRow) : [];
	const base = {
		version: WORK_CYCLE_VERSION,
		episode_id: episodeId ?? null,
		status: "inactive",
		review_required: false,
		reasons: [],
		trigger_id: null,
		work_unit_id: null,
		work_unit_event_id: null,
		current_intent: null,
		checkpoint: null,
		historical_checkpoint: null,
		review: null,
		last_review: null,
		failed_review_event_ids: [],
		consumptions: [],
		usage: [],
		evidence_event_ids: [],
		action_count: 0,
		review_round_action_count: 0,
		unique_routes: 0,
		repeat_count: 0,
		trusted_progress_event_id: null,
		unscoped: false,
		bootstrap_review: false,
		complete_candidate: false,
		accepted_intent_count: 0,
		work_unit_state: "inactive",
		policy,
	};
	if (typeof episodeId !== "string" || episodeId.length === 0) return base;
	const startIndex = rows.findIndex((row) => row.event_type === "episode.started" && row.episode_id === episodeId);
	if (startIndex < 0) return base;
	const byId = indexEvents(rows);
	let board = raw?.board ?? null;
	if (!board) {
		try {
			board = projectBoard(rows, raw?.manifest ? { manifest: raw.manifest } : {});
		} catch {
			board = null;
		}
	}
	const intents = effectiveWorkIntents(episodeId, board, byId);
	// Accepted-at-their-own-prefix Intents, including ones later replaced. Used
	// ONLY for historical review consumption; the current unit still comes from
	// the final effective Board view above.
	const acceptedIntents = historicalWorkIntents(episodeId, board, byId);
	const currentIntent = intents.length > 0 ? intents[intents.length - 1] : null;

	// Valid reviews/checkpoints for this Episode. Invalid rows are ignored, so an
	// unverifiable review can never clear the hold.
	const reviews = [];
	const checkpoints = [];
	for (let index = startIndex; index < rows.length; index += 1) {
		const row = rows[index];
		if (!sameEpisode(row, episodeId)) continue;
		const review = readWorkReview(row, index, byId, episodeId);
		if (review) reviews.push(review);
		const checkpoint = readWorkCheckpoint(row, index, byId, episodeId);
		if (checkpoint) checkpoints.push(checkpoint);
	}
	const boundCheckpoints = checkpoints
		.map((checkpoint) => {
			const unitIntent = checkpointUnitIntent(checkpoint, intents, byId, episodeId);
			return unitIntent ? { ...checkpoint, work_unit_event_id: unitIntent.event_id, unit_intent: unitIntent } : null;
		})
		.filter(Boolean);
	const currentCheckpoint =
		[...boundCheckpoints].reverse().find((checkpoint) => checkpoint.unit_intent.event_id === currentIntent?.event_id) ??
		null;
	const historicalCheckpoint = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;

	// Trusted progress is the Board's effective Fact view (Campaign-aware when a
	// Manifest/Board is supplied); a raw `source:oracle` string is never enough.
	const factEventIds = new Set(
		(board?.currentByType?.Fact ?? [])
			.filter((node) => node?.episode_id === episodeId && node?.type === "Fact" && node?.effective !== false)
			.map((node) => node.origin_event_id)
			.filter((id) => typeof id === "string"),
	);
	let lastTrustedProgressIndex = -1;
	let trustedProgressEventId = null;
	for (let index = startIndex + 1; index < rows.length; index += 1) {
		const row = rows[index];
		if (sameEpisode(row, episodeId) && factEventIds.has(row.event_id)) {
			lastTrustedProgressIndex = index;
			trustedProgressEventId = row.event_id;
		}
	}
	const baseStart = Math.max(startIndex, lastTrustedProgressIndex);
	const totalActions = collectActions(rows, episodeId, baseStart);

	// Review consumption is derived in causal order. Each review can consume its
	// OWN trigger at most once. A later Intent citing the same review is a
	// historical association and cannot move a second window.
	const usableReviews = reviews.filter(
		(review) =>
			WORK_REVIEW_USABLE_STATUSES.includes(review.retrieval_status) &&
			(Boolean(reviewUnitIntent(review, intents, acceptedIntents)) || reviewBootstrap(review, acceptedIntents)),
	);
	const consumptions = [];
	let roundStart = baseStart;
	let roundStartEventId = rows[baseStart]?.event_id ?? null;
	let active = null;
	const maxRounds = usableReviews.length + 1;
	for (let round = 0; round < maxRounds; round += 1) {
		const roundActions = collectActions(rows, episodeId, roundStart);
		const derived = deriveTrigger(roundActions, policy, episodeId, roundStartEventId);
		if (!derived) {
			active = null;
			break;
		}
		const candidateReviews = usableReviews.filter(
			(review) => review.index > roundStart && review.trigger_id === derived.trigger_id,
		);
		const review = candidateReviews.length > 0 ? candidateReviews[candidateReviews.length - 1] : null;
		if (!review) {
			active = { ...derived, review: null, round_start: roundStart };
			break;
		}
		// The FIRST accepted Intent after this review consumes it, even if a later
		// legal replacement removes that Intent from the final effective view.
		const consumingIntent =
			acceptedIntents.find(
				(intent) =>
					intent.index > review.index &&
					intent.index > roundStart &&
					citesReview(intent, review) &&
					isNewScopeIntent(intent, review),
			) ?? null;
		if (!consumingIntent) {
			active = { ...derived, review, round_start: roundStart };
			break;
		}
		consumptions.push({
			review_event_id: review.event_id,
			selection_event_id: review.selection_event_id,
			intent_event_id: consumingIntent.event_id,
			trigger_id: review.trigger_id,
		});
		roundStart = consumingIntent.index;
		roundStartEventId = consumingIntent.event_id;
	}
	const roundActions = collectActions(rows, episodeId, roundStart);
	const failedReviews =
		active === null
			? []
			: reviews.filter(
					(review) =>
						review.trigger_id === active.trigger_id &&
						review.index > roundStart &&
						!WORK_REVIEW_USABLE_STATUSES.includes(review.retrieval_status),
				);
	const review = active?.review ?? null;
	const reviewRequired = active !== null;
	const bootstrapReview = review ? reviewBootstrap(review, acceptedIntents) : false;
	// Derived work-unit status. `unscoped` means the Episode has no accepted
	// scoped Intent yet; it does NOT add a second authority, and it never appears
	// in the EventLog. The console/observer use it to refuse effect-capable calls
	// from the very first provider request.
	const unscoped = currentIntent === null;
	const completeCandidate =
		!reviewRequired && currentCheckpoint?.unit_status === "complete" && Boolean(currentIntent?.event_id);
	const recentEvidence =
		active?.evidence_event_ids ??
		roundActions
			.slice(-policy.action_window)
			.flatMap((action) => [action.request_event_id, action.completion_event_id])
			.slice(0, MAX_EVIDENCE_REFS);
	return {
		...base,
		status: !reviewRequired ? "clear" : review ? "awaiting_scoped_intent" : "review_required",
		review_required: reviewRequired,
		reasons: active?.reasons ?? [],
		trigger_id: active?.trigger_id ?? null,
		work_unit_id: currentIntent?.scope ?? null,
		work_unit_event_id: currentIntent?.event_id ?? null,
		current_intent: currentIntent
			? { event_id: currentIntent.event_id, scope: currentIntent.scope, index: currentIntent.index }
			: null,
		checkpoint: currentCheckpoint,
		historical_checkpoint: historicalCheckpoint,
		review,
		last_review: reviews.length > 0 ? reviews[reviews.length - 1] : null,
		failed_review_event_ids: failedReviews.map((item) => item.event_id).slice(-4),
		consumptions: consumptions.slice(-4),
		usage: projectKnowledgeUsage(rows, episodeId, board),
		evidence_event_ids: recentEvidence,
		// CUMULATIVE since the last trusted progress: never reset by a review,
		// Intent, checkpoint or Session rotation.
		action_count: totalActions.length,
		// CURRENT review round (after the last trusted progress or valid consumption).
		review_round_action_count: roundActions.length,
		unique_routes: active?.unique_routes ?? new Set(roundActions.map((action) => action.signature)).size,
		repeat_count: active?.repeat_count ?? 0,
		trusted_progress_event_id: trustedProgressEventId,
		awaiting_scoped_intent: reviewRequired && Boolean(review),
		unscoped,
		bootstrap_review: bootstrapReview,
		// How many scoped Intents were ACCEPTED at their own prefix (including ones a
		// later replacement superseded). Used to decide whether a no-unit review may
		// be the explicit bootstrap variant.
		accepted_intent_count: acceptedIntents.length,
		complete_candidate: completeCandidate,
		work_unit_state: reviewRequired
			? review
				? "awaiting_intent"
				: "awaiting_review"
			: unscoped
				? "unscoped"
				: completeCandidate
					? "complete_candidate"
					: "active",
		window_start_event_id: active?.window_start_event_id ?? roundStartEventId,
		unit_intent_index: currentIntent?.index ?? -1,
	};
}

/**
 * Advisory handoff/rotation recommendation. This never creates or stages a
 * Session; the Host/Supervisor remains the only rotation path.
 *
 * A pending review is NOT itself a rotation reason: the model must review in the
 * current Session. A real context-pressure signal may carry the unsettled hold
 * across a safe rotation, and a checkpoint bound to the CURRENT unit may request
 * a completion handoff. `identity` is the per-boundary idempotency key:
 *   * completion: one per work-unit Intent event;
 *   * context: one per source Session + usage snapshot (old high-water cannot
 *     re-trigger in the replacement Session).
 */
export function recommendWorkHandoff({
	cycle = null,
	contextUsage = null,
	policy = null,
	sourceSessionId = null,
} = {}) {
	const normalized = normalizeWorkCyclePolicy(policy ?? cycle?.policy ?? {});
	const usage = normalizeContextUsage(contextUsage);
	const reasons = [];
	const complete =
		cycle?.review_required !== true &&
		cycle?.status === "clear" &&
		cycle?.checkpoint?.unit_status === "complete" &&
		Boolean(cycle?.work_unit_event_id) &&
		cycle?.checkpoint?.work_unit_event_id === cycle?.work_unit_event_id;
	if (complete) reasons.push("work_unit_complete");
	if (usage.known && usage.percent >= normalized.context_pressure_percent) reasons.push("context_pressure");
	let identity = null;
	if (complete) identity = `unit-complete:${cycle.work_unit_event_id}`;
	else if (usage.known && usage.percent >= normalized.context_pressure_percent)
		identity = `context:${typeof sourceSessionId === "string" && sourceSessionId ? sourceSessionId : "unknown"}:${usage.used_tokens}:${usage.limit_tokens}`;
	return {
		recommended: reasons.length > 0,
		reasons,
		identity,
		context_usage: usage,
		source_session_id: typeof sourceSessionId === "string" && sourceSessionId ? sourceSessionId : null,
		advisory: true,
		trust: "runtime_advisory_not_outcome",
		policy: { context_pressure_percent: normalized.context_pressure_percent },
	};
}

/**
 * True when this tool is an advisory/read/review tool that must stay available
 * while a review is pending (used by the Campaign permit gate). `aegis_execute`
 * is NOT advisory even though it is a control tool.
 */
export function isWorkCycleAdvisoryTool(toolName) {
	return typeof toolName === "string" && REVIEW_ADVISORY_TOOLS.has(toolName);
}

/**
 * Read the Host-frozen work-cycle policy note for a Campaign run. The note is a
 * derived, committed record; a config/env change cannot silently replace it.
 */
export function readFrozenWorkCyclePolicy(events, campaignId) {
	for (let index = (Array.isArray(events) ? events.length : 0) - 1; index >= 0; index -= 1) {
		const row = events[index];
		if (
			row?.event_type === "runtime.note" &&
			row.source?.kind === "runtime" &&
			row.payload?.kind === "campaign.work_cycle.policy" &&
			row.payload?.version === WORK_CYCLE_VERSION &&
			(campaignId === undefined || row.payload?.campaign_id === campaignId)
		) {
			const policy = normalizeWorkCyclePolicy(row.payload.policy);
			return {
				ok: true,
				event_id: row.event_id,
				digest: typeof row.payload.policy_digest === "string" ? row.payload.policy_digest : null,
				policy,
				raw: row.payload,
			};
		}
	}
	return { ok: false };
}

/** Serialize a frozen policy into the committed run-binding note. */
export function frozenWorkCyclePolicyPayload(policy, campaignId, extra = {}) {
	const normalized = normalizeWorkCyclePolicy(policy);
	return {
		kind: "campaign.work_cycle.policy",
		version: WORK_CYCLE_VERSION,
		campaign_id: campaignId ?? null,
		policy: {
			repeat_limit: normalized.repeat_limit,
			action_window: normalized.action_window,
			min_distinct_routes: normalized.min_distinct_routes,
			context_pressure_percent: normalized.context_pressure_percent,
		},
		policy_digest: digest({
			repeat_limit: normalized.repeat_limit,
			action_window: normalized.action_window,
			min_distinct_routes: normalized.min_distinct_routes,
			context_pressure_percent: normalized.context_pressure_percent,
		}),
		...extra,
	};
}

/**
 * Bounded reference-usage projection: selection -> declared adoption -> explicit
 * action reference -> independent Fact. No evidence means `unknown`/`selected`;
 * temporal proximity is NEVER treated as "used".
 */
export function projectKnowledgeUsage(events, episodeId, board = null) {
	if (typeof episodeId !== "string" || !episodeId) return [];
	const rows = Array.isArray(events) ? events.filter(isRow) : [];
	const byId = indexEvents(rows);
	const selections = [];
	const intents = new Map();
	const actions = [];
	const factNodes = (board?.currentByType?.Fact ?? []).filter(
		(node) => node?.episode_id === episodeId && node?.effective !== false,
	);
	for (const [id, entry] of byId) {
		const row = entry.row;
		if (!sameEpisode(row, episodeId)) continue;
		if (row.event_type === "runtime.note" && row.payload?.kind === "knowledge.selected") {
			selections.push({
				event_id: id,
				index: entry.index,
				knowledge_ids: Array.isArray(row.payload?.selected)
					? row.payload.selected.map((item) => item?.knowledge_id).filter((value) => typeof value === "string")
					: [],
			});
		} else if (row.event_type === "proposal.submitted" && unitScope(row)) {
			intents.set(id, { event_id: id, index: entry.index, refs: new Set(sourceRefIds(row)) });
		} else if (row.event_type === "action.requested") {
			const refs = Array.isArray(row.payload?.source_refs)
				? row.payload.source_refs
						.map((ref) => (typeof ref === "string" ? ref : ref?.ref_id))
						.filter((value) => typeof value === "string")
				: [];
			if (refs.length > 0)
				actions.push({ event_id: id, index: entry.index, action_id: row.payload?.action_id, refs: new Set(refs) });
		}
	}
	const factEvidence = new Map();
	for (const node of factNodes) {
		const refs = [...(node.evidence_refs ?? []), ...(node.source_refs ?? [])]
			.map((ref) => (typeof ref === "string" ? ref : ref?.ref_id))
			.filter((value) => typeof value === "string");
		for (const ref of refs) factEvidence.set(ref, node);
	}
	const completions = new Map();
	for (const row of rows) {
		if (row.event_type === "action.completed" && typeof row.payload?.action_id === "string")
			completions.set(row.payload.action_id, row.event_id);
	}
	const entries = [];
	for (const selection of selections) {
		const adopted =
			[...intents.values()]
				.filter((intent) => intent.refs.has(selection.event_id) && intent.index > selection.index)
				.sort((a, b) => a.index - b.index)[0] ?? null;
		const action =
			adopted === null
				? null
				: (actions
						.filter(
							(candidate) =>
								candidate.index > adopted.index &&
								candidate.refs.has(selection.event_id) &&
								candidate.refs.has(adopted.event_id),
						)
						.sort((a, b) => a.index - b.index)[0] ?? null);
		const completionId = action ? (completions.get(action.action_id) ?? null) : null;
		const outcome = completionId ? (factEvidence.get(completionId) ?? null) : null;
		entries.push({
			selection_event_id: selection.event_id,
			knowledge_ids: selection.knowledge_ids.slice(0, 4),
			intent_event_id: adopted?.event_id ?? null,
			action_event_id: action?.event_id ?? null,
			action_completion_event_id: completionId,
			outcome_event_id: outcome?.origin_event_id ?? null,
			status: outcome ? "used" : adopted ? "adopted" : "selected",
			trust: "runtime_projection_not_authorization",
		});
	}
	// Keep the most informative bounded rows: independent use > declared adoption >
	// bare selection. Insertion order is preserved within a rank.
	const rank = { used: 3, adopted: 2, selected: 1 };
	return entries
		.slice()
		.sort((a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0))
		.slice(0, 3);
}

/**
 * The Host-side non-terminal continuation state for one Task, derived from the
 * committed stream. A hold is "pending" until a `campaign.work_cycle.continued`
 * record names its event id; terminal Task rows make it moot.
 */
export function readWorkCycleRunState(events, taskId) {
	let hold = null;
	const continued = new Set();
	for (const row of Array.isArray(events) ? events : []) {
		if (row?.event_type !== "runtime.note" || row.source?.kind !== "runtime") continue;
		const payload = row.payload ?? {};
		if (payload.version !== WORK_CYCLE_VERSION || payload.task_id !== taskId) continue;
		if (payload.kind === "campaign.work_cycle.hold" || payload.kind === "campaign.work_cycle.boundary") {
			hold = {
				event_id: row.event_id,
				task_id: taskId,
				kind: payload.kind,
				trigger_id: typeof payload.trigger_id === "string" ? payload.trigger_id : null,
				review_event_id: typeof payload.review_event_id === "string" ? payload.review_event_id : null,
				reason:
					typeof payload.reason === "string"
						? payload.reason
						: payload.kind === "campaign.work_cycle.boundary"
							? "rotation_boundary"
							: null,
			};
		} else if (payload.kind === "campaign.work_cycle.continued" && typeof payload.hold_event_id === "string") {
			continued.add(payload.hold_event_id);
		}
	}
	return {
		hold,
		pending_hold: hold && !continued.has(hold.event_id) ? hold : null,
		continued_hold_event_ids: [...continued].slice(-8),
	};
}

/** Boundary identities that already produced a committed Session rotation. */
export function completedWorkCycleBoundaries(events) {
	const identities = new Set();
	for (const row of Array.isArray(events) ? events : []) {
		if (row?.event_type !== "handoff.completed") continue;
		const identity = row.payload?.work_cycle_identity;
		if (typeof identity === "string" && identity) identities.add(identity);
	}
	return identities;
}
