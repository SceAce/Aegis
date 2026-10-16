// Aegis C6 — request lifecycle contract.
//
// ONE request identity and ONE set of state rules shared by:
//   * the LIVE provider gate in `c6-model-worker.mjs`, which drives the two
//     in-memory ledgers and writes the durable records through the entry's
//     `persistRequest`;
//   * the RESTART/measure rebuild (`summarizeRequestLedger`) used by
//     `c6-entry.mjs`.
//
// THREE separate facts are represented, never collapsed into one `ok`:
//
//   1. per-side budget responsibility — each request independently holds a
//      Task-side and a Campaign-side obligation (`pending` hold or `consumed`);
//   2. joint settlement — a request is `unresolved` until a legal, fully
//      associated durable `committed` closes it (a reconciliation that confirms
//      both sides is NOT a joint settlement);
//   3. planning termination — the Worker derives normal/error/aborted from the
//      SDK stopReason; this module only owns facts 1 and 2.
//
// A joint request moves through:
//
//   created -> admitted -> reserved_durable -> provider_started
//           -> provider_finished -> committed_in_memory -> committed_durable
//           -> settled
//
// Failure/unknown paths keep the budget responsibility and a reconciliation
// record. A request that may already have reached the provider is NEVER released
// as "never happened". `reconciliation_required` means "unresolved", not
// "cancelled".
//
// The module is deliberately pure: no timers, no I/O, no SDK. It is the same
// code the live lifecycle and the rebuild agree on.

export const REQUEST_PHASE = Object.freeze({
	RESERVED: "reserved",
	COMMITTED: "committed",
	RELEASED: "released",
	REJECTED: "rejected",
	RECONCILIATION_REQUIRED: "reconciliation_required",
});

/** A durable id is trusted only when it is a non-empty string. */
export function isRequestId(value) {
	return typeof value === "string" && value.length > 0;
}

/**
 * Classify ONE Pi assistant `stopReason` into Aegis' termination facts.
 *
 * Pi's `error` and `aborted` are HARD exits: `agent-loop.ts` ends the loop and
 * skips that response's tool calls. They must never be mapped to a normal
 * response. `stop`/`length`/`toolUse`/`deferred` describe a completed response
 * (the planning may continue after `toolUse`). An unknown/missing value is
 * `unknown` and is never, by itself, execution permission.
 *
 * @param {unknown} stopReason
 * @returns {{providerStatus: "ok"|"error"|"aborted"|"unknown", planningStatus: "normal"|"error"|"aborted"|"unknown"}}
 */
export function classifyStopReason(stopReason) {
	if (stopReason === "error") return { providerStatus: "error", planningStatus: "error" };
	if (stopReason === "aborted") return { providerStatus: "aborted", planningStatus: "aborted" };
	if (["stop", "length", "toolUse", "deferred"].includes(/** @type {string} */ (stopReason)))
		return { providerStatus: "ok", planningStatus: "normal" };
	return { providerStatus: "unknown", planningStatus: "unknown" };
}

/**
 * A reservation note is a legal hold only when it names the request and at
 * least one side's reservation. Anything else is ignored (never a legal hold),
 * so a malformed note cannot invent budget responsibility.
 *
 * @param {any} payload
 * @returns {{valid: boolean, reason: string|null}}
 */
export function validateReservation(payload) {
	if (!isRequestId(payload?.request_id)) return { valid: false, reason: "missing_request_id" };
	if (!isRequestId(payload?.task_reservation_id) && !isRequestId(payload?.campaign_reservation_id))
		return { valid: false, reason: "missing_reservation_id" };
	return { valid: true, reason: null };
}

/**
 * A durable `committed` record settles the WHOLE joint request only when it
 * names the request AND both sides' reservation ids, and the reservation ids
 * are consistent with the original `reserved` note. Single-ledger mode may set
 * both id fields to the same value; the semantics stay "both sides settled".
 *
 * A partial / mismatched / conflicting record must NOT settle the request and
 * must NOT release the other side.
 *
 * @param {any} payload
 * @param {{task_reservation_id?: string|null, campaign_reservation_id?: string|null, task_id?: string|null, campaign_id?: string|null}|null} reservedNote
 * @returns {{valid: boolean, reason: string|null}}
 */
export function validateCommittedRecord(payload, reservedNote = null) {
	if (!isRequestId(payload?.request_id)) return { valid: false, reason: "missing_request_id" };
	if (!isRequestId(payload?.task_reservation_id)) return { valid: false, reason: "missing_task_reservation_id" };
	if (!isRequestId(payload?.campaign_reservation_id))
		return { valid: false, reason: "missing_campaign_reservation_id" };
	if (reservedNote) {
		if (reservedNote.task_reservation_id && reservedNote.task_reservation_id !== payload.task_reservation_id)
			return { valid: false, reason: "task_reservation_mismatch" };
		if (
			reservedNote.campaign_reservation_id &&
			reservedNote.campaign_reservation_id !== payload.campaign_reservation_id
		)
			return { valid: false, reason: "campaign_reservation_mismatch" };
		if (reservedNote.task_id && payload.task_id && reservedNote.task_id !== payload.task_id)
			return { valid: false, reason: "task_id_mismatch" };
		if (reservedNote.campaign_id && payload.campaign_id && reservedNote.campaign_id !== payload.campaign_id)
			return { valid: false, reason: "campaign_id_mismatch" };
	}
	// A record that admits a failed/unknown side is NOT a joint success.
	const status = payload?.commit_status;
	if (
		status &&
		(status.task === "failed" ||
			status.task === "unknown" ||
			status.campaign === "failed" ||
			status.campaign === "unknown")
	)
		return { valid: false, reason: "partial_commit" };
	return { valid: true, reason: null };
}

/**
 * Rebuild the request accounting from the authoritative committed stream.
 *
 * THREE separate facts are derived, never collapsed into one:
 *
 *   1. per-side budget responsibility — for each request the Task side and the
 *      Campaign side are independently `pending` (a hold) or `consumed`
 *      (charged). A durable `reconciliation_required` that confirms a side as
 *      committed restores THAT side's consumed responsibility and reservation
 *      identity (idempotently) instead of merely dropping it from pending. A
 *      side that failed/unknown keeps its hold.
 *   2. joint settlement — `unresolved` counts requests that have a reservation
 *      and neither a legal full joint `committed` nor a pre-dispatch release.
 *      Confirming both sides via reconciliation is NOT a joint settlement; a
 *      later legal full `committed` closes it without double-charging. A
 *      pending count of zero does not imply unresolved zero.
 *
 * Rules:
 *   * `reserved` requires a request id and at least one reservation id, and is
 *     idempotent by request id (a repeat never creates a second hold);
 *   * `committed` must carry request + BOTH reservation ids and match the
 *     original reserved note; a partial/mismatched record is a diagnostic and
 *     settles nothing;
 *   * `reconciliation_required` keeps the request unresolved; a side it
 *     confirms as committed is charged once with its reservation identity;
 *   * `released`/`rejected` only cancel a request that was NOT dispatched; they
 *     can never erase a charge and never contradict a reconciliation;
 *   * duplicate legal events do not double-charge and repeated rebuilds are
 *     idempotent.
 *
 * `consumed` is the Campaign-side total; `byTask` is the per-Task total.
 *
 * @param {any[]} events
 * @returns {{
 *   consumed: {model_requests: number, tool_calls: number, input_chars: number, wall_time_ms: number},
 *   byTask: Map<string, {model_requests: number, tool_calls: number, input_chars: number}>,
 *   campaignPending: Array<{reservation_id: string, request_id: string|null, inputChars: number, kind: string, task_id: string|null}>,
 *   taskPending: Array<{reservation_id: string, request_id: string|null, inputChars: number, kind: string, task_id: string|null}>,
 *   committedReservations: Set<string>,
 *   taskCommittedByTask: Map<string, string[]>,
 *   unresolved: number,
 *   diagnostics: Array<{code: string, request_id: string|null, reason?: string|null}>,
 *   records: any[],
 *   tool_accounting: string,
 * }}
 */
export function summarizeRequestLedger(events = [], { toolCharges = null } = {}) {
	const consumed = { model_requests: 0, tool_calls: 0, input_chars: 0, wall_time_ms: 0 };
	/** @type {Map<string, {model_requests: number, tool_calls: number, input_chars: number}>} */
	const byTask = new Map();
	/**
	 * Per request: independent `taskConsumed`/`campaignConsumed` responsibilities,
	 * `jointlySettled` (a legal full committed) and `released`.
	 *
	 * @type {Map<string, {
	 *   request_id: string, task_reservation_id: string|null, campaign_reservation_id: string|null,
	 *   inputChars: number, toolCalls: number, kind: string, task_id: string|null, campaign_id: string|null,
	 *   taskConsumed: boolean, campaignConsumed: boolean, jointlySettled: boolean,
	 *   released: boolean, reconciliation: boolean,
	 * }>}
	 */
	const reservedNotes = new Map();
	const taskCommittedByTask = new Map();
	const diagnostics = [];
	const records = [];

	/**
	 * Add ONE side's already-established responsibility exactly once. The input
	 * occupancy keeps the existing authoritative estimate field (never a
	 * fabricated token/currency number).
	 */
	const chargeSide = (note, side, payload) => {
		const inputChars = Math.max(
			Number.isFinite(note.inputChars) ? note.inputChars : 0,
			Number.isFinite(payload?.input_chars) ? payload.input_chars : 0,
		);
		const toolCalls = Number.isInteger(payload?.tool_calls)
			? payload.tool_calls
			: Number.isInteger(note.toolCalls)
				? note.toolCalls
				: 0;
		if (side === "campaign") {
			consumed.model_requests += 1;
			consumed.tool_calls += toolCalls;
			consumed.input_chars += inputChars;
			return;
		}
		if (!isRequestId(note.task_id)) return;
		const dims = byTask.get(note.task_id) ?? { model_requests: 0, tool_calls: 0, input_chars: 0 };
		dims.model_requests += 1;
		dims.tool_calls += toolCalls;
		dims.input_chars += inputChars;
		byTask.set(note.task_id, dims);
		if (isRequestId(note.task_reservation_id)) {
			const list = taskCommittedByTask.get(note.task_id) ?? [];
			if (!list.includes(note.task_reservation_id)) list.push(note.task_reservation_id);
			taskCommittedByTask.set(note.task_id, list);
		}
	};

	/** Confirm one side as committed (idempotent per request/side). */
	const confirmSide = (note, side, payload) => {
		if (side === "task") {
			if (note.taskConsumed) return;
			note.taskConsumed = true;
		} else {
			if (note.campaignConsumed) return;
			note.campaignConsumed = true;
		}
		chargeSide(note, side, payload);
	};

	/** Create the per-request note if the stream starts past its `reserved` record. */
	const ensureNote = (payload, requestId, taskRes, campaignRes) => {
		const existing = requestId ? reservedNotes.get(requestId) : null;
		if (existing) return existing;
		const note = {
			request_id: /** @type {string} */ (requestId),
			task_reservation_id: taskRes,
			campaign_reservation_id: campaignRes,
			inputChars: Number.isFinite(payload.input_chars) ? payload.input_chars : 0,
			toolCalls: Number.isInteger(payload.tool_calls) ? payload.tool_calls : 0,
			kind: payload.request_kind ?? "provider_bound",
			task_id: isRequestId(payload.task_id) ? payload.task_id : null,
			campaign_id: isRequestId(payload.campaign_id) ? payload.campaign_id : null,
			taskConsumed: false,
			campaignConsumed: false,
			jointlySettled: false,
			released: false,
			reconciliation: false,
		};
		reservedNotes.set(requestId, note);
		return note;
	};

	for (const event of Array.isArray(events) ? events : []) {
		if (event?.event_type !== "runtime.note" || event.payload?.kind !== "c6.request") continue;
		const payload = event.payload;
		const requestId = isRequestId(payload.request_id) ? payload.request_id : null;
		const taskRes = isRequestId(payload.task_reservation_id) ? payload.task_reservation_id : null;
		const campaignRes = isRequestId(payload.campaign_reservation_id) ? payload.campaign_reservation_id : null;
		const phase = payload.phase;

		if (phase === REQUEST_PHASE.RESERVED) {
			const verdict = validateReservation(payload);
			if (!verdict.valid) {
				diagnostics.push({ code: "invalid_reservation", request_id: requestId, reason: verdict.reason });
				continue;
			}
			ensureNote(payload, requestId, taskRes, campaignRes);
			continue;
		}

		if (phase === REQUEST_PHASE.RELEASED || phase === REQUEST_PHASE.REJECTED) {
			const note = requestId ? reservedNotes.get(requestId) : null;
			if (!note) continue;
			// A release/reject is only legal for a request that was NOT dispatched. A
			// release that contradicts a reconciliation (or an already settled side)
			// must not erase the unresolved hold.
			if (note.reconciliation) {
				diagnostics.push({ code: "release_after_reconciliation", request_id: requestId });
				continue;
			}
			if (note.taskConsumed || note.campaignConsumed || note.jointlySettled) {
				diagnostics.push({ code: "release_after_settlement", request_id: requestId });
				continue;
			}
			note.released = true;
			continue;
		}

		if (phase === REQUEST_PHASE.RECONCILIATION_REQUIRED) {
			const note = requestId ? reservedNotes.get(requestId) : null;
			if (!note) {
				diagnostics.push({ code: "reconciliation_without_reservation", request_id: requestId });
				continue;
			}
			note.reconciliation = true;
			const status = payload.commit_status ?? null;
			// A side may only be confirmed when the record belongs to this request/side.
			if (status?.task === "committed") {
				if (taskRes && note.task_reservation_id && taskRes !== note.task_reservation_id)
					diagnostics.push({ code: "reconciliation_task_reservation_mismatch", request_id: requestId });
				else confirmSide(note, "task", payload);
			}
			if (status?.campaign === "committed") {
				if (campaignRes && note.campaign_reservation_id && campaignRes !== note.campaign_reservation_id)
					diagnostics.push({ code: "reconciliation_campaign_reservation_mismatch", request_id: requestId });
				else confirmSide(note, "campaign", payload);
			}
			continue;
		}

		if (phase === REQUEST_PHASE.COMMITTED || payload.usage !== undefined) {
			const note = requestId ? reservedNotes.get(requestId) : null;
			if (note?.released) {
				diagnostics.push({ code: "committed_after_release", request_id: requestId });
				continue;
			}
			const verdict = validateCommittedRecord(payload, note);
			if (!verdict.valid) {
				diagnostics.push({ code: "invalid_committed", request_id: requestId, reason: verdict.reason });
				continue;
			}
			const settledNote = note ?? ensureNote(payload, requestId, taskRes, campaignRes);
			confirmSide(settledNote, "task", payload);
			confirmSide(settledNote, "campaign", payload);
			settledNote.jointlySettled = true;
			records.push(payload);
		}
	}

	// E1-CC §7.2: a run uses ONE fixed tool-accounting protocol. In a
	// durable-charge run the tool count is the accepted `c6.tool` charges (from the
	// authoritative projection when the caller has it), never the legacy
	// per-request aggregate; a legacy count inside such a run is a diagnostic hold.
	const rows = Array.isArray(events) ? events : [];
	const durable =
		Array.isArray(toolCharges) ||
		rows.some(
			(event) =>
				event?.payload?.kind === "c6.tool" ||
				(event?.payload?.kind === "c6.request" && event.payload.tool_accounting === TOOL_ACCOUNTING_DURABLE),
		);
	if (durable) {
		for (const record of records)
			if (Number.isInteger(record.tool_calls) && record.tool_calls > 0)
				diagnostics.push({ code: "mixed_tool_accounting", request_id: record.request_id ?? null });
		consumed.tool_calls = 0;
		for (const dims of byTask.values()) dims.tool_calls = 0;
		for (const charge of toolCharges ?? chargesFromEvents(rows)) {
			consumed.tool_calls += 1;
			if (!isRequestId(charge.task_id)) continue;
			const dims = byTask.get(charge.task_id) ?? { model_requests: 0, tool_calls: 0, input_chars: 0 };
			dims.tool_calls += 1;
			byTask.set(charge.task_id, dims);
		}
	}
	const campaignPending = [];
	const taskPending = [];
	const committedReservations = new Set();
	let unresolved = 0;
	for (const note of reservedNotes.values()) {
		if (!note.released && !note.jointlySettled) unresolved += 1;
		if (note.released) continue;
		if (note.taskConsumed && isRequestId(note.task_reservation_id)) committedReservations.add(note.task_reservation_id);
		if (note.campaignConsumed && isRequestId(note.campaign_reservation_id))
			committedReservations.add(note.campaign_reservation_id);
		if (isRequestId(note.campaign_reservation_id) && !note.campaignConsumed) {
			campaignPending.push({
				reservation_id: note.campaign_reservation_id,
				request_id: note.request_id,
				inputChars: note.inputChars,
				kind: note.kind,
				task_id: note.task_id,
			});
		}
		if (isRequestId(note.task_reservation_id) && !note.taskConsumed) {
			taskPending.push({
				reservation_id: note.task_reservation_id,
				request_id: note.request_id,
				inputChars: note.inputChars,
				kind: note.kind,
				task_id: note.task_id,
			});
		}
	}
	return {
		consumed,
		byTask,
		campaignPending,
		taskPending,
		committedReservations,
		taskCommittedByTask,
		unresolved,
		diagnostics,
		records,
		tool_accounting: durable ? TOOL_ACCOUNTING_DURABLE : "legacy_request_aggregate",
	};
}

export const TOOL_ACCOUNTING_DURABLE = "durable-charge-v1";

/**
 * Context-free view of the durable charges in a stream (used only when the
 * caller has no authoritative projection): trusted writer, known version, a
 * complete identity, deduplicated by key. The projection applies the full
 * binding/limit rules; this view never ADDS charges the projection would drop
 * for shape reasons and never double-counts a repeated unit.
 */
function chargesFromEvents(rows) {
	const seen = new Map();
	for (const event of rows) {
		const p = event?.payload;
		if (event?.event_type !== "runtime.note" || p?.kind !== "c6.tool" || p.phase !== "charged") continue;
		if (event.source?.kind !== "runtime" || p.version !== "e1-tool-charge-1.0") continue;
		if (![p.request_id, p.tool_call_id, p.unit_id, p.task_id].every(isRequestId)) continue;
		const key = [p.campaign_id, p.task_id, p.episode_id ?? "-", p.request_id, p.tool_call_id, p.unit_id].join("|");
		if (!seen.has(key)) seen.set(key, { task_id: p.task_id });
	}
	return [...seen.values()];
}

/**
 * Build the `baseReserved` seed for ONE Task ledger. Only THIS Task's own
 * pending holds and committed reservation identities are injected; a global
 * pending set would let Task A's hold leak into Task B's ledger.
 *
 * @param {Array<{reservation_id: string, request_id: string|null, inputChars: number, kind: string, task_id: string|null}>} taskPending
 * @param {Map<string, string[]>|null} taskCommittedByTask
 * @param {string} taskId
 * @returns {{model_requests: number, tool_calls: number, input_chars: number, wall_time_ms: number, pending: Array<{reservation_id: string, request_id: string|null, inputChars: number, kind: string}>, committed: string[]}}
 */
export function reservedSeedForTask(taskPending, taskCommittedByTask, taskId) {
	const pending = (Array.isArray(taskPending) ? taskPending : [])
		.filter((note) => note && note.task_id === taskId)
		.map((note) => ({
			reservation_id: note.reservation_id,
			request_id: note.request_id,
			inputChars: note.inputChars,
			kind: note.kind,
		}));
	const committed = taskCommittedByTask?.get?.(taskId) ?? [];
	return {
		model_requests: pending.length,
		tool_calls: 0,
		input_chars: pending.reduce((sum, note) => sum + note.inputChars, 0),
		wall_time_ms: 0,
		pending,
		committed: [...committed],
	};
}
