// Aegis C6 — request lifecycle contract.
//
// ONE request identity and ONE set of state rules shared by:
//   * the LIVE provider gate in `c6-model-worker.mjs`, which drives the two
//     in-memory ledgers and writes the durable records through the entry's
//     `persistRequest`;
//   * the RESTART/measure rebuild (`summarizeRequestLedger`) used by
//     `c6-entry.mjs`.
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
 * Rules:
 *   * `reserved` requires a request id and at least one reservation id, and is
 *     idempotent by request id (a repeat never creates a second hold);
 *   * `committed` must carry request + BOTH reservation ids and match the
 *     original reserved note; a partial/mismatched record is kept as an
 *     invalid/reconciliation diagnostic and does NOT settle anything;
 *   * `released`/`rejected` only cancel a request that was NOT committed; they
 *     can never erase a charge;
 *   * `reconciliation_required` keeps the request pending (unresolved), and may
 *     confirm one side as committed without releasing the other;
 *   * duplicate legal events do not double-charge and repeated rebuilds are
 *     idempotent.
 *
 * `consumed` is the Campaign-side total; `byTask` is the per-Task total. A
 * request whose Campaign side is committed but whose Task side is unresolved
 * (or vice versa) is consumed only on the settled side and pending on the other.
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
 * }}
 */
export function summarizeRequestLedger(events = []) {
	const consumed = { model_requests: 0, tool_calls: 0, input_chars: 0, wall_time_ms: 0 };
	/** @type {Map<string, {model_requests: number, tool_calls: number, input_chars: number}>} */
	const byTask = new Map();
	/** @type {Map<string, {request_id: string, task_reservation_id: string|null, campaign_reservation_id: string|null, inputChars: number, kind: string, task_id: string|null, campaign_id: string|null, released: boolean, reconciliation: boolean}>} */
	const reservedNotes = new Map();
	const settledTask = new Set();
	const settledCampaign = new Set();
	const countedRequests = new Set();
	const taskCommittedByTask = new Map();
	const diagnostics = [];
	const records = [];

	const noteCommitted = (taskId, reservationId) => {
		if (!isRequestId(taskId) || !isRequestId(reservationId)) return;
		const list = taskCommittedByTask.get(taskId) ?? [];
		if (!list.includes(reservationId)) list.push(reservationId);
		taskCommittedByTask.set(taskId, list);
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
			if (reservedNotes.has(requestId)) continue; // idempotent: one hold per request
			reservedNotes.set(requestId, {
				request_id: requestId,
				task_reservation_id: taskRes,
				campaign_reservation_id: campaignRes,
				inputChars: Number.isFinite(payload.input_chars) ? payload.input_chars : 0,
				kind: payload.request_kind ?? "provider_bound",
				task_id: isRequestId(payload.task_id) ? payload.task_id : null,
				campaign_id: isRequestId(payload.campaign_id) ? payload.campaign_id : null,
				released: false,
				reconciliation: false,
			});
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
			if (settledTask.has(note.task_reservation_id) || settledCampaign.has(note.campaign_reservation_id)) {
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
			const status = payload.commit_status;
			if (status?.task === "committed" && note.task_reservation_id) settledTask.add(note.task_reservation_id);
			if (status?.campaign === "committed" && note.campaign_reservation_id)
				settledCampaign.add(note.campaign_reservation_id);
			continue;
		}

		if (phase === REQUEST_PHASE.COMMITTED || payload.usage !== undefined) {
			const note = requestId ? reservedNotes.get(requestId) : null;
			const verdict = validateCommittedRecord(payload, note);
			if (!verdict.valid) {
				diagnostics.push({ code: "invalid_committed", request_id: requestId, reason: verdict.reason });
				continue;
			}
			if (countedRequests.has(requestId)) continue; // duplicate legal event: never double-charge
			countedRequests.add(requestId);
			const toolCalls = Number.isInteger(payload.tool_calls) ? payload.tool_calls : 0;
			const inputChars = Number.isFinite(payload.input_chars) ? payload.input_chars : 0;
			consumed.model_requests += 1;
			consumed.tool_calls += toolCalls;
			consumed.input_chars += inputChars;
			const taskId = isRequestId(payload.task_id) ? payload.task_id : (note?.task_id ?? null);
			if (taskId) {
				const dims = byTask.get(taskId) ?? { model_requests: 0, tool_calls: 0, input_chars: 0 };
				dims.model_requests += 1;
				dims.tool_calls += toolCalls;
				dims.input_chars += inputChars;
				byTask.set(taskId, dims);
				noteCommitted(taskId, taskRes);
			}
			settledTask.add(taskRes);
			settledCampaign.add(campaignRes);
			records.push(payload);
		}
	}

	/** @type {Array<{note: any, taskPending: boolean, campaignPending: boolean}>} */
	const unresolvedNotes = [];
	for (const note of reservedNotes.values()) {
		if (note.released) continue;
		const taskPending = isRequestId(note.task_reservation_id) && !settledTask.has(note.task_reservation_id);
		const campaignPending =
			isRequestId(note.campaign_reservation_id) && !settledCampaign.has(note.campaign_reservation_id);
		if (taskPending || campaignPending) unresolvedNotes.push({ note, taskPending, campaignPending });
	}
	const campaignPending = unresolvedNotes
		.filter((entry) => entry.campaignPending)
		.map((entry) => ({
			reservation_id: /** @type {string} */ (entry.note.campaign_reservation_id),
			request_id: entry.note.request_id,
			inputChars: entry.note.inputChars,
			kind: entry.note.kind,
			task_id: entry.note.task_id,
		}));
	const taskPending = unresolvedNotes
		.filter((entry) => entry.taskPending)
		.map((entry) => ({
			reservation_id: /** @type {string} */ (entry.note.task_reservation_id),
			request_id: entry.note.request_id,
			inputChars: entry.note.inputChars,
			kind: entry.note.kind,
			task_id: entry.note.task_id,
		}));
	const committedReservations = new Set([...settledTask, ...settledCampaign]);
	return {
		consumed,
		byTask,
		campaignPending,
		taskPending,
		committedReservations,
		taskCommittedByTask,
		unresolved: unresolvedNotes.length,
		diagnostics,
		records,
	};
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
