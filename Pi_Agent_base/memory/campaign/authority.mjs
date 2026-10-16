// Aegis E1 — shared, PURE Campaign authority helpers.
//
// The Campaign projection (`projection.mjs`) is the ONE reducer that decides what
// is accepted. The rules it applies at each physical prefix live here so the
// live Host commands, the replay reducer, the request rebuild and the execution
// permit evaluate the SAME function instead of re-deriving their own version:
//
//   * a prefix-bound artifact log (evidence must exist BEFORE the claim);
//   * scope keys and supersede validation for Campaign Outcomes;
//   * the durable tool-charge evaluator (`c6.tool`, e1-tool-charge-1.0);
//   * the common execution permit (task binding, effective dependencies, time).
//
// No I/O, no clock, no mutable config: every input is an argument.

import { digest } from "../fixture/contracts.mjs";

export const PLAN_BINDING_VERSION = "e1-plan-binding-1.0";
export const TOOL_CHARGE_VERSION = "e1-tool-charge-1.0";
export const TOOL_ACCOUNTING_DURABLE = "durable-charge-v1";

/** Trusted writer kinds that may contribute evidence artifacts. */
const ARTIFACT_SOURCES = new Set(["runtime", "oracle", "human"]);

/**
 * A prefix-bound artifact log. `register` records a digest at a physical
 * offset; `view(offset)` exposes ONLY versions recorded strictly before that
 * offset (plus explicitly injected trusted fixtures), so a later artifact can
 * never make an earlier claim resolvable and a later digest never rewrites an
 * earlier point in time.
 *
 * Injected entries that carry an `origin` / `origin_offset` tag were derived
 * from events (or live process memory) and are IGNORED: the reducer rebuilds
 * event evidence itself so live and replay see the same prefix. Untagged
 * entries are trusted Host fixtures/registries.
 *
 * @param {Map<string, any>|Record<string, any>|null} injected
 */
export function createArtifactLog(injected = null) {
	/** @type {Map<string, Array<{ref_id: string, digest: string, offset: number, event_id: string|null, source: string}>>} */
	const versions = new Map();
	const trusted = new Map();
	const entries = injected instanceof Map ? [...injected.entries()] : Object.entries(injected ?? {});
	for (const [refId, entry] of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (entry.origin !== undefined || entry.origin_offset !== undefined) continue;
		if (typeof entry.digest === "string" && entry.digest.length > 0) trusted.set(refId, { ...entry, ref_id: refId });
	}
	return {
		register(refId, contentDigest, { offset, event_id = null, source = "event" }) {
			if (typeof refId !== "string" || !refId || typeof contentDigest !== "string" || !contentDigest) return;
			const list = versions.get(refId) ?? [];
			list.push({ ref_id: refId, digest: contentDigest, offset, event_id, source });
			versions.set(refId, list);
		},
		/** The artifact index valid at `offset` (exclusive), shaped for `isResolvableRef`. */
		view(offset) {
			const out = {};
			for (const [refId, entry] of trusted) out[refId] = entry;
			for (const [refId, list] of versions) {
				let latest = null;
				for (const version of list) if (version.offset < offset) latest = version;
				if (latest) out[refId] = latest;
			}
			return out;
		},
		entries() {
			return [...versions.values()].flat();
		},
	};
}

/** Register the evidence a trusted committed row contributes to the log. */
export function registerRowArtifacts(log, raw, offset) {
	if (!ARTIFACT_SOURCES.has(raw?.source?.kind)) return;
	const payload = raw?.payload ?? {};
	if (raw?.event_type === "action.completed" && typeof payload.evidence_ref === "string")
		log.register(payload.evidence_ref, payload.content_digest, {
			offset,
			event_id: raw.event_id ?? null,
			source: "action.completed",
		});
}
/** A stable scope key: trimmed string, or the canonical digest of an object. */
export function scopeKey(scope) {
	if (scope === null || scope === undefined) return null;
	if (typeof scope === "string") return scope.trim() || null;
	return digest(scope);
}

/** The canonical content identity of one committed Campaign Outcome envelope. */
export function outcomeContentDigest(payload) {
	return digest({
		task_id: payload?.task_id ?? null,
		step_id: payload?.step_id ?? null,
		task_oracle: payload?.task_oracle === true,
		episode_id: payload?.episode_id ?? null,
		status: payload?.status ?? null,
		outcome: payload?.outcome ?? null,
	});
}

/**
 * Validate a `supersedes` correction against the PRIOR accepted record. Only a
 * correction of the SAME Campaign/Task/Episode/Stage/criterion/subject/scope,
 * from a trusted judging source, may retire a prior judgment. Missing, forward,
 * self, foreign or rejected targets never retire anything.
 *
 * @param {{prior: any, next: any}} args
 * @returns {{valid: boolean, reason: string|null}}
 */
export function validateCampaignSupersede({ prior, next }) {
	if (!prior) return { valid: false, reason: "supersede_target_missing" };
	if (prior.accepted !== true) return { valid: false, reason: "supersede_target_not_accepted" };
	if (prior.outcome_id === next.outcome_id) return { valid: false, reason: "supersede_self" };
	if (!(prior.offset < next.offset)) return { valid: false, reason: "supersede_forward" };
	if (!["oracle", "human"].includes(next.source)) return { valid: false, reason: "supersede_untrusted_source" };
	if (prior.campaign_id !== next.campaign_id) return { valid: false, reason: "supersede_foreign_campaign" };
	if (prior.task_id !== next.task_id) return { valid: false, reason: "supersede_foreign_task" };
	if (prior.episode_id !== next.episode_id) return { valid: false, reason: "supersede_foreign_episode" };
	if ((prior.stage_id ?? null) !== (next.stage_id ?? null)) return { valid: false, reason: "supersede_stage_mismatch" };
	if (prior.task_oracle !== next.task_oracle) return { valid: false, reason: "supersede_level_mismatch" };
	if ((prior.criterion?.criterion_id ?? null) !== (next.criterion?.criterion_id ?? null))
		return { valid: false, reason: "supersede_criterion_mismatch" };
	if (digest(prior.criterion?.expected ?? null) !== digest(next.criterion?.expected ?? null))
		return { valid: false, reason: "supersede_subject_mismatch" };
	if (prior.scope_key !== next.scope_key) return { valid: false, reason: "supersede_scope_mismatch" };
	return { valid: true, reason: null };
}

// ---------------------------------------------------------------------------
// Durable tool charge (c6.tool)
// ---------------------------------------------------------------------------

/** The dedup identity of one charged tool unit. */
export function toolChargeKey(p) {
	return [p.campaign_id, p.task_id ?? "-", p.episode_id ?? "-", p.request_id, p.tool_call_id, p.unit_id].join("|");
}

const UNIT_ID = /^(?:call|action:\d{1,4})$/;

function reject(code, message) {
	return { ok: false, code, reason: `${code}: ${message}` };
}

/**
 * Evaluate ONE `c6.tool` record against the authority state at its prefix.
 * The SAME function serves the Host's pre-commit decision and the replay, so a
 * record the Host would refuse can never be accepted on rebuild (and vice
 * versa). Returns `{ok, duplicate?, entry?, key?, code?, reason?}`.
 *
 * @param {{
 *   payload: any, sourceKind: string|null, recordedAt?: string|null,
 *   state: {campaign_id: string, manifest_digest: string|null, context_digest: string|null,
 *     charges: Map<string, any>, requests: Map<string, any>, starts: Map<string, any>,
 *     runningTaskId: string|null, taskToolLimit: (taskId: string) => number,
 *     campaignToolLimit: number, deadlines: (taskId: string) => {task: number|null, campaign: number|null}},
 * }} args
 */
export function evaluateToolRecord({ payload: p, sourceKind, recordedAt = null, state }) {
	if (sourceKind !== "runtime")
		return reject("invalid_tool_binding", `source ${String(sourceKind)} cannot charge a tool`);
	if (p?.campaign_id !== state.campaign_id)
		return reject("invalid_tool_binding", "tool record belongs to another campaign");
	if (p?.version !== TOOL_CHARGE_VERSION)
		return reject("invalid_tool_binding", `unsupported tool charge version ${String(p?.version)}`);
	for (const field of ["task_id", "episode_id", "request_id", "tool_call_id", "unit_id", "tool_name"])
		if (typeof p[field] !== "string" || p[field].length === 0)
			return reject("invalid_tool_binding", `tool record requires ${field}`);
	if (!UNIT_ID.test(p.unit_id)) return reject("invalid_tool_binding", `illegal unit_id ${p.unit_id}`);
	const key = toolChargeKey(p);
	const prior = state.charges.get(key) ?? null;
	if (p.phase === "finished") {
		if (!prior) return reject("tool_finish_without_charge", `no accepted charge for ${key}`);
		if (prior.tool_name !== p.tool_name)
			return reject("tool_identity_conflict", `finish names another tool for ${key}`);
		if (prior.finished) return { ok: true, duplicate: true, key, entry: prior };
		return { ok: true, duplicate: false, key, entry: { ...prior, finished: true } };
	}
	if (p.phase !== "charged") return reject("invalid_tool_binding", `unknown tool phase ${String(p.phase)}`);
	if (p.units !== 1) return reject("invalid_tool_binding", "a tool unit charges exactly 1");
	if (typeof p.arguments_digest !== "string" || !p.arguments_digest.startsWith("sha256:"))
		return reject("invalid_tool_binding", "arguments_digest must be a canonical sha256 digest");
	if (state.manifest_digest && p.manifest_digest !== state.manifest_digest)
		return reject("invalid_tool_binding", "tool charge manifest_digest does not match the run");
	if (state.context_digest && p.context_digest !== state.context_digest)
		return reject("invalid_tool_binding", "tool charge context_digest does not match the run");
	if (prior) {
		if (prior.tool_name !== p.tool_name || prior.arguments_digest !== p.arguments_digest)
			return reject("tool_identity_conflict", `charge ${key} repeats with different content`);
		return { ok: true, duplicate: true, key, entry: prior };
	}
	const start = state.starts.get(p.task_id) ?? null;
	if (!start) return reject("invalid_tool_binding", `task ${p.task_id} has no accepted start`);
	if (start.episode_id !== p.episode_id)
		return reject("invalid_tool_binding", `episode ${p.episode_id} is not the accepted episode ${start.episode_id}`);
	if (state.runningTaskId !== p.task_id)
		return reject("invalid_tool_binding", `task ${p.task_id} is not the active task`);
	const request = state.requests.get(p.request_id) ?? null;
	if (!request || request.phase !== "committed")
		return reject("invalid_tool_binding", `request ${p.request_id} was not durably committed`);
	if (request.task_id !== p.task_id)
		return reject("invalid_tool_binding", `request ${p.request_id} belongs to task ${request.task_id}`);
	if (request.provider_status !== "ok")
		return reject("invalid_tool_binding", `request ${p.request_id} ended with ${String(request.provider_status)}`);
	let taskCharged = 0;
	for (const entry of state.charges.values()) if (entry.task_id === p.task_id) taskCharged += 1;
	const taskLimit = state.taskToolLimit(p.task_id);
	if (!(taskCharged + 1 <= taskLimit))
		return reject("budget_exhausted", `task ${p.task_id} tool_calls ${taskCharged}/${taskLimit}`);
	if (!(state.charges.size + 1 <= state.campaignToolLimit))
		return reject("budget_exhausted", `campaign tool_calls ${state.charges.size}/${state.campaignToolLimit}`);
	const at = recordedAt ? Date.parse(recordedAt) : Number.NaN;
	if (Number.isFinite(at)) {
		const deadlines = state.deadlines(p.task_id);
		if (deadlines.task !== null && !(at < deadlines.task))
			return reject("budget_exhausted", `task ${p.task_id} wall-time deadline passed`);
		if (deadlines.campaign !== null && !(at < deadlines.campaign))
			return reject("budget_exhausted", "campaign wall-time deadline passed");
	}
	return {
		ok: true,
		duplicate: false,
		key,
		entry: {
			charged: true,
			finished: false,
			task_id: p.task_id,
			episode_id: p.episode_id,
			request_id: p.request_id,
			tool_call_id: p.tool_call_id,
			unit_id: p.unit_id,
			tool_name: p.tool_name,
			arguments_digest: p.arguments_digest,
			units: 1,
			charge_event_id: null,
		},
	};
}
/**
 * Index one runtime `c6.request` record (request identity -> settlement facts)
 * so a tool charge can prove its producing request was dispatched and settled.
 * Only the trusted ledger writer contributes.
 */
export function indexRequestRecord(requests, raw, offset) {
	if (raw?.event_type !== "runtime.note" || raw?.payload?.kind !== "c6.request") return;
	if (raw?.source?.kind !== "runtime") return;
	const p = raw.payload;
	if (typeof p.request_id !== "string" || !p.request_id) return;
	const prior = requests.get(p.request_id) ?? null;
	if (p.phase === "reserved") {
		if (!prior)
			requests.set(p.request_id, { task_id: p.task_id ?? null, phase: "reserved", provider_status: null, offset });
		return;
	}
	if (p.phase === "committed") {
		// A commit must belong to the reservation it settles; a foreign task never
		// re-binds an existing request.
		if (prior && prior.task_id !== (p.task_id ?? null)) return;
		requests.set(p.request_id, {
			task_id: p.task_id ?? null,
			phase: "committed",
			provider_status: p.provider_status ?? null,
			offset,
		});
		return;
	}
	if (prior && (p.phase === "reconciliation_required" || p.phase === "released" || p.phase === "rejected"))
		requests.set(p.request_id, { ...prior, phase: prior.phase === "committed" ? "committed" : p.phase });
}

/**
 * The common execution permit (E1-CC §5.3). A pure check over the latest
 * authoritative projection: the Host calls it at every provider request, tool
 * unit and Broker effect boundary, with a trusted `now`. A permit computed for an
 * older prefix must never be cached to a later effect.
 *
 * @param {{projection: any, taskId: string|null, episodeId?: string|null, now: number, operation: "provider_request"|"tool_unit"|"broker_effect"}} args
 * @returns {{ok: boolean, prefix: number, deadlines: {task: number|null, campaign: number|null}, reasons: Array<{code: string, field: string|null, event_id: string|null, message: string}>}}
 */
export function inspectExecutionPermit({ projection, taskId, episodeId = null, now, operation }) {
	const reasons = [];
	const push = (code, message, field = null, event_id = null) => reasons.push({ code, field, event_id, message });
	const authority = projection?.authority ?? null;
	const prefix = authority?.physical_tail ?? -1;
	const empty = { task: null, campaign: null };
	// Rows of ANOTHER Campaign in a shared runtime log are diagnostics, not a gap
	// in this Campaign's authority; only a missing authority (e.g. a refused cache)
	// or an invalid budget limit withholds the permit.
	if (!authority) {
		push("full_replay_required", "no complete authoritative projection is available");
		return { ok: false, prefix, deadlines: empty, reasons };
	}
	if (projection.health?.budget_limit_valid === false) {
		push("invalid_task_budget", "the Campaign budget limit is invalid", "budget");
		return { ok: false, prefix, deadlines: empty, reasons };
	}
	if (projection.control?.state !== "running")
		push("campaign_not_running", `campaign is ${String(projection.control?.state)}`, "control");
	const task = (projection.tasks ?? []).find((row) => row.task_id === taskId) ?? null;
	if (!task) push("invalid_task_binding", `task ${String(taskId)} is not an accepted task`, "task_id");
	else if (task.state !== "running")
		push("invalid_task_binding", `task ${taskId} is ${task.state}, not the active task`, "task_id");
	const start = (authority.accepted_starts ?? []).find((entry) => entry.task_id === taskId) ?? null;
	if (task && !start) push("invalid_task_binding", `task ${taskId} has no accepted start`, "task_id");
	if (start && episodeId !== null && start.episode_id !== episodeId)
		push("invalid_task_binding", `episode ${episodeId} is not the accepted episode ${start.episode_id}`, "episode_id");
	for (const [dep, status] of Object.entries(task?.dependency_status ?? {}))
		if (status !== "satisfied")
			push("dependency_invalidated", `dependency ${dep} is ${status} for ${operation}`, "depends_on");
	const deadlines = authority.deadlines?.byTask?.[taskId] ?? empty;
	if (!Number.isFinite(now)) push("clock_regressed", "no trusted current time", "now");
	else {
		const latest = authority.deadlines?.latest_recorded_at ?? null;
		if (latest !== null && now < latest)
			push("clock_regressed", `now ${now} is before the latest record ${latest}`, "now");
		if (start && (deadlines.task === null || deadlines.campaign === null))
			push("budget_exhausted", "no valid persistent time anchor for the active task", "wall_time_ms");
		if (deadlines.campaign !== null && !(now < deadlines.campaign))
			push("budget_exhausted", "campaign wall-time deadline passed", "wall_time_ms");
		if (deadlines.task !== null && !(now < deadlines.task))
			push("budget_exhausted", `task ${taskId} wall-time deadline passed`, "wall_time_ms");
	}
	return { ok: reasons.length === 0, prefix, deadlines, reasons };
}

/** Format structured permit reasons into the legacy string form. */
export function permitReasonText(permit) {
	return (permit?.reasons ?? []).map((reason) => `${reason.code}: ${reason.message}`).join("; ");
}
