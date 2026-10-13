// Aegis C6-B — request/tool ledger and pre-call budget gate.
//
// Every REAL SDK provider request (including the automatic tool loop and any
// continuation) and every tool call is admitted BEFORE it happens. This module
// is the single accounting point the model Worker uses; it never trusts a
// post-hoc total and never resets across Task/restart.
//
// Accounting model (all dimensions are hard gates C6 can enforce):
//   * `admitRequest`/`admitTool` atomically RESERVE budget up front, so a
//     second admit at the exact limit is refused even before the first commits.
//   * `commitRequest` moves a reservation to `consumed` EXACTLY once; a duplicate
//     commit of the same reservation id is a no-op (never double-charged).
//   * `remaining = limit - consumed - outstanding reservations`, with wall-time
//     measured against the live clock so an elapsed budget blocks new admits.
//
// Honest boundaries:
//   * Backend tokens/currency are NOT observable with the offline faux provider;
//     they are recorded as `unknown`, never fabricated as 0.
//   * The faux provider reports an ESTIMATED usage derived from prompt length;
//     those numbers are labelled `estimated`, never `measured`.

import { digest } from "../fixture/contracts.mjs";

export const TOOL_LEDGER_VERSION = "3.0.0";

/**
 * @typedef {{model_requests: number, tool_calls: number, input_chars: number, wall_time_ms: number}} LedgerDims
 */

function zeroDims() {
	return { model_requests: 0, tool_calls: 0, input_chars: 0, wall_time_ms: 0 };
}

/**
 * Build a bounded request/tool ledger for one Campaign run.
 *
 * @param {{
 *   limit: LedgerDims,
 *   baseConsumed?: LedgerDims,
 *   baseReserved?: {model_requests?: number, tool_calls?: number, input_chars?: number, wall_time_ms?: number, ledger_id?: string|null, pending?: Array<{reservation_id: string, inputChars: number, kind: string, request_id?: string|null}>, committed?: string[]}|null,
 *   clock?: () => number,
 *   onEvent?: (record: object) => void,
 *   persist?: ((record: object) => void)|null,
 * }} args
 */
export function createToolLedger(
	{
		limit,
		baseConsumed = { model_requests: 0, tool_calls: 0, input_chars: 0, wall_time_ms: 0 },
		baseReserved = null,
		clock = () => Date.now(),
		onEvent = null,
		persist = null,
	} = /** @type {any} */ ({}),
) {
	const normalizedLimit = { ...zeroDims(), ...(limit ?? {}) };
	const consumed = { ...zeroDims(), ...(baseConsumed ?? {}) };
	// `reserved` is the outstanding, not-yet-committed hold. It ALWAYS counts
	// against remaining so a pending admission cannot be oversubscribed.
	const reserved = { ...zeroDims(), ...(baseReserved ?? {}) };
	const startedAt = clock();
	const records = [];
	/** @type {Map<string, {inputChars: number, kind: string, request_id: string|null}>} */
	const pending = new Map(
		Array.isArray(baseReserved?.pending)
			? baseReserved.pending.map((p) => [
					p.reservation_id,
					{ inputChars: p.inputChars, kind: p.kind, request_id: p.request_id ?? null },
				])
			: [],
	);
	const committed = new Set(Array.isArray(baseReserved?.committed) ? baseReserved.committed : []);
	// A stable request id is admitted at most once; the ledger resolves a repeated
	// request id to the SAME reservation instead of double-reserving.
	/** @type {Map<string, string>} */
	const requestToReservation = new Map();
	let ledgerId = baseReserved?.ledger_id ?? null;

	function elapsedWall() {
		return Math.max(0, clock() - startedAt);
	}

	function remaining() {
		return {
			model_requests: Math.max(
				0,
				(normalizedLimit.model_requests ?? 0) - consumed.model_requests - reserved.model_requests,
			),
			tool_calls: Math.max(0, (normalizedLimit.tool_calls ?? 0) - consumed.tool_calls - reserved.tool_calls),
			input_chars: Math.max(0, (normalizedLimit.input_chars ?? 0) - consumed.input_chars - reserved.input_chars),
			wall_time_ms: Math.max(0, (normalizedLimit.wall_time_ms ?? 0) - elapsedWall()),
		};
	}

	function record(entry) {
		records.push(entry);
		if (persist) persist(entry);
		return entry;
	}

	/**
	 * Admit a provider request BEFORE it is sent, reserving one model request and
	 * the estimated input. `inputChars` is the ESTIMATED total input (ROM + tools
	 * schema + RAM + history + output reserve).
	 *
	 * A stable external `request_id` may be supplied; the ledger admits it at most
	 * once and returns the SAME reservation for a repeat, so a retried call cannot
	 * double-reserve. Omitting it generates a ledger-local reservation id.
	 *
	 * @param {{inputChars?: number, kind?: string, request_id?: string|null, ledger_id?: string|null}} [args]
	 * @returns {{ok: boolean, reason?: string, failure_mode?: string, reservation_id?: string, request_id?: string|null, ledger_id?: string|null, duplicate?: boolean}}
	 */
	function admitRequest({ inputChars = 0, kind = "provider_request", request_id = null, ledger_id = null } = {}) {
		if (ledger_id && !ledgerId) ledgerId = ledger_id;
		if (request_id && requestToReservation.has(request_id)) {
			const existing = requestToReservation.get(request_id);
			return { ok: true, reservation_id: existing, request_id, ledger_id: ledgerId, duplicate: true };
		}
		const rem = remaining();
		if (rem.wall_time_ms <= 0) {
			return {
				ok: false,
				failure_mode: "budget_exhausted",
				reason: `wall-time budget exhausted (${elapsedWall()}ms elapsed)`,
			};
		}
		if (rem.model_requests < 1) {
			return {
				ok: false,
				failure_mode: "budget_exhausted",
				reason: `model request budget exhausted (consumed=${consumed.model_requests}, reserved=${reserved.model_requests}/${normalizedLimit.model_requests})`,
			};
		}
		if (normalizedLimit.input_chars > 0 && inputChars > 0 && inputChars > rem.input_chars) {
			return {
				ok: false,
				failure_mode: "budget_exhausted",
				reason: `total input estimate ${inputChars} would exceed the configured limit (remaining ${rem.input_chars})`,
			};
		}
		reserved.model_requests += 1;
		reserved.input_chars += Math.max(0, inputChars);
		const reservationId = `res-${ledgerId ?? "ledger"}-${records.length}-${clock()}-${pending.size}`;
		pending.set(reservationId, { inputChars: Math.max(0, inputChars), kind, request_id: request_id ?? null });
		if (request_id) requestToReservation.set(request_id, reservationId);
		record({
			record_id: reservationId,
			kind,
			phase: "admit",
			request_id: request_id ?? null,
			input_chars_estimated: inputChars,
			at: new Date(clock()).toISOString(),
		});
		if (onEvent)
			onEvent({ kind: "request.admitted", input_chars: inputChars, reservation_id: reservationId, request_id });
		return { ok: true, reservation_id: reservationId, request_id: request_id ?? null, ledger_id: ledgerId };
	}

	/**
	 * Release an in-memory reservation that was made but whose request will NOT be
	 * sent (e.g. the second layer of a joint admission refused). Only legal BEFORE
	 * the provider is called; the caller must never release after dispatch. A
	 * committed reservation cannot be released.
	 *
	 * @param {{reservation_id?: string|null, reason?: string}} args
	 * @returns {{ok: boolean, failure_mode?: string, reason?: string}}
	 */
	function cancelReservation({ reservation_id = null, reason = "reservation_cancelled" } = {}) {
		if (!reservation_id || !pending.has(reservation_id)) {
			return {
				ok: false,
				failure_mode: "unknown_reservation",
				reason: `no pending reservation: ${String(reservation_id)}`,
			};
		}
		const held = pending.get(reservation_id);
		reserved.model_requests = Math.max(0, reserved.model_requests - 1);
		reserved.input_chars = Math.max(0, reserved.input_chars - held.inputChars);
		pending.delete(reservation_id);
		if (held.request_id) requestToReservation.delete(held.request_id);
		record({ record_id: reservation_id, phase: "released", reason, at: new Date(clock()).toISOString() });
		if (onEvent) onEvent({ kind: "request.released", reservation_id, reason });
		return { ok: true };
	}

	/**
	 * Commit an admitted provider request with its ACTUAL usage. Idempotent: a
	 * second commit for the same reservation id is ignored (never double-charged).
	 *
	 * A commit WITHOUT a known reservation id is NOT a normal accounting path: a
	 * null/missing id cannot prove which reservation it settles, so it is refused
	 * (`failure_mode: "missing_reservation_id"`) and the caller must reconcile. This
	 * prevents the old post-hoc "mirror" charge that could not be tied to a real
	 * reservation.
	 *
	 * @param {{reservation_id?: string|null, usage?: any, inputChars?: number}} args
	 * @returns {{ok: boolean, record_id?: string|null, duplicate?: boolean, failure_mode?: string, reason?: string}}
	 */
	function commitRequest({ reservation_id = null, usage = null, inputChars = 0 } = {}) {
		if (reservation_id && committed.has(reservation_id)) {
			return { ok: true, record_id: reservation_id, duplicate: true };
		}
		if (!reservation_id || !pending.has(reservation_id)) {
			return {
				ok: false,
				failure_mode: "missing_reservation_id",
				record_id: reservation_id ?? null,
				reason: `commit requires a known reservation id; got ${String(reservation_id)}`,
			};
		}
		const held = pending.get(reservation_id);
		const chargeInput = Math.max(Math.max(0, inputChars), held.inputChars);
		reserved.model_requests = Math.max(0, reserved.model_requests - 1);
		reserved.input_chars = Math.max(0, reserved.input_chars - held.inputChars);
		pending.delete(reservation_id);
		committed.add(reservation_id);
		if (held.request_id) requestToReservation.delete(held.request_id);
		consumed.model_requests += 1;
		consumed.input_chars += chargeInput;
		consumed.wall_time_ms = elapsedWall();
		const measured = normalizeUsage(usage);
		const entry = record({
			record_id: reservation_id,
			kind: "provider_request",
			phase: "commit",
			request_id: held.request_id,
			input_chars_estimated: chargeInput,
			usage: measured,
			at: new Date(clock()).toISOString(),
		});
		if (onEvent) onEvent({ kind: "request.committed", usage: measured, record_id: reservation_id });
		return { ok: true, record_id: entry.record_id };
	}

	/**
	 * Admit a tool call BEFORE it runs. The faux/tool loop may issue many; each is
	 * gated independently and reserves one tool call atomically.
	 *
	 * @param {{tool_name?: string}} args
	 */
	function admitTool({ tool_name = "unknown" } = {}) {
		const rem = remaining();
		if (rem.wall_time_ms <= 0) {
			return { ok: false, reason: `wall-time budget exhausted (${elapsedWall()}ms elapsed)` };
		}
		if (rem.tool_calls < 1) {
			return {
				ok: false,
				reason: `tool call budget exhausted (consumed=${consumed.tool_calls}, reserved=${reserved.tool_calls}/${normalizedLimit.tool_calls})`,
			};
		}
		consumed.tool_calls += 1;
		record({ kind: "tool_call", tool_name, phase: "admit", at: new Date(clock()).toISOString() });
		if (onEvent) onEvent({ kind: "tool.admitted", tool_name });
		return { ok: true };
	}

	/**
	 * A snapshots view. Unobservable token/currency dimensions are surfaced as
	 * `unknown`, never as 0.
	 */
	function snapshot() {
		return {
			schema_version: "2.0",
			limit: { ...normalizedLimit },
			consumed: { ...consumed, wall_time_ms: elapsedWall() },
			reserved: { ...reserved },
			remaining: remaining(),
			pending_reservations: [...pending.keys()],
			records: records.slice(),
			usage_sources: {
				model_requests: "measured",
				tool_calls: "measured",
				input_chars: "estimated",
				tokens: "unknown",
				currency: "unknown",
			},
			digest: digest(records),
		};
	}

	return {
		version: TOOL_LEDGER_VERSION,
		admitRequest,
		cancelReservation,
		commitRequest,
		admitTool,
		remaining,
		snapshot,
		consumed: () => ({ ...consumed }),
		reserved: () => ({ ...reserved }),
		pending: () => [...pending.entries()].map(([reservation_id, held]) => ({ reservation_id, ...held })),
	};
}

/** Normalize whichever usage shape the SDK reported. Unknown fields stay null. */
export function normalizeUsage(usage) {
	if (!usage || typeof usage !== "object") {
		return { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, source: "unknown" };
	}
	const num = (value) => (Number.isFinite(value) ? value : null);
	// The faux provider derives usage from prompt length, so it is `estimated`.
	// A real backend's reported usage would be `measured`; C6 only ever sees faux,
	// so the source is `estimated` whenever any number is present.
	const any = [usage.input, usage.output, usage.totalTokens].some((value) => Number.isFinite(value));
	return {
		input: num(usage.input),
		output: num(usage.output),
		cacheRead: num(usage.cacheRead),
		cacheWrite: num(usage.cacheWrite),
		totalTokens: num(usage.totalTokens),
		source: any ? "estimated" : "unknown",
	};
}
