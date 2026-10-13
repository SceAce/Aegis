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

export const TOOL_LEDGER_VERSION = "2.0.0";

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
 *   clock?: () => number,
 *   onEvent?: (record: object) => void,
 *   persist?: ((record: object) => void)|null,
 * }} args
 */
export function createToolLedger(
	{
		limit,
		baseConsumed = { model_requests: 0, tool_calls: 0, input_chars: 0, wall_time_ms: 0 },
		clock = () => Date.now(),
		onEvent = null,
		persist = null,
	} = /** @type {any} */ ({}),
) {
	const normalizedLimit = { ...zeroDims(), ...(limit ?? {}) };
	const consumed = { ...zeroDims(), ...(baseConsumed ?? {}) };
	// `reserved` is the outstanding, not-yet-committed hold. It ALWAYS counts
	// against remaining so a pending admission cannot be oversubscribed.
	const reserved = zeroDims();
	const startedAt = clock();
	const records = [];
	/** @type {Map<string, {inputChars: number, kind: string}>} */
	const pending = new Map();
	const committed = new Set();

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
	 * @param {{inputChars?: number, kind?: string}} [args]
	 * @returns {{ok: boolean, reason?: string, reservation_id?: string}}
	 */
	function admitRequest({ inputChars = 0, kind = "provider_request" } = {}) {
		const rem = remaining();
		if (rem.wall_time_ms <= 0) {
			return { ok: false, reason: `wall-time budget exhausted (${elapsedWall()}ms elapsed)` };
		}
		if (rem.model_requests < 1) {
			return {
				ok: false,
				reason: `model request budget exhausted (consumed=${consumed.model_requests}, reserved=${reserved.model_requests}/${normalizedLimit.model_requests})`,
			};
		}
		if (normalizedLimit.input_chars > 0 && inputChars > 0 && inputChars > rem.input_chars) {
			return {
				ok: false,
				reason: `total input estimate ${inputChars} would exceed the configured limit (remaining ${rem.input_chars})`,
			};
		}
		reserved.model_requests += 1;
		reserved.input_chars += Math.max(0, inputChars);
		const reservationId = `res-${records.length}-${clock()}-${pending.size}`;
		pending.set(reservationId, { inputChars: Math.max(0, inputChars), kind });
		record({
			record_id: reservationId,
			kind,
			phase: "admit",
			input_chars_estimated: inputChars,
			at: new Date(clock()).toISOString(),
		});
		if (onEvent) onEvent({ kind: "request.admitted", input_chars: inputChars, reservation_id: reservationId });
		return { ok: true, reservation_id: reservationId };
	}

	/**
	 * Commit an admitted provider request with its ACTUAL usage. Idempotent: a
	 * second commit for the same reservation id is ignored (never double-charged).
	 * A commit without a known reservation still charges exactly one request (a
	 * provider request that happened must be counted).
	 *
	 * @param {{reservation_id?: string|null, usage?: any, inputChars?: number}} args
	 */
	function commitRequest({ reservation_id = null, usage = null, inputChars = 0 } = {}) {
		if (reservation_id && committed.has(reservation_id)) {
			return { record_id: reservation_id, duplicate: true };
		}
		let chargeInput = Math.max(0, inputChars);
		if (reservation_id && pending.has(reservation_id)) {
			const held = pending.get(reservation_id);
			chargeInput = Math.max(chargeInput, held.inputChars);
			reserved.model_requests = Math.max(0, reserved.model_requests - 1);
			reserved.input_chars = Math.max(0, reserved.input_chars - held.inputChars);
			pending.delete(reservation_id);
		}
		if (reservation_id) committed.add(reservation_id);
		consumed.model_requests += 1;
		consumed.input_chars += chargeInput;
		consumed.wall_time_ms = elapsedWall();
		const measured = normalizeUsage(usage);
		const entry = record({
			record_id: reservation_id,
			kind: "provider_request",
			phase: "commit",
			input_chars_estimated: chargeInput,
			usage: measured,
			at: new Date(clock()).toISOString(),
		});
		if (onEvent) onEvent({ kind: "request.committed", usage: measured, record_id: reservation_id });
		return entry;
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
		commitRequest,
		admitTool,
		remaining,
		snapshot,
		consumed: () => ({ ...consumed }),
		reserved: () => ({ ...reserved }),
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
