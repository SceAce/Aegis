// Aegis C6-B — request/tool ledger and pre-call budget gate.
//
// Every REAL SDK provider request (including the automatic tool loop and any
// continuation) and every tool call is admitted BEFORE it happens. This module
// is the single accounting point the model Worker uses; it never trusts a
// post-hoc total and never resets across Task/restart.
//
// Honest boundaries:
//   * `model_requests`/`tool_calls`/`input_chars` are hard gates that C6 can
//     enforce.
//   * Backend tokens/currency are NOT observable with the offline faux provider;
//     they are recorded as `unknown`, never fabricated as 0.
//   * The faux provider reports an ESTIMATED usage derived from prompt length;
//     those numbers are labelled `estimated`, never `measured`.

import { digest } from "../fixture/contracts.mjs";

export const TOOL_LEDGER_VERSION = "1.0.0";

/**
 * @typedef {{model_requests: number, tool_calls: number, input_chars: number, wall_time_ms: number}} LedgerDims
 */

/**
 * Build a bounded request/tool ledger for one Campaign run.
 *
 * @param {{
 *   limit: LedgerDims,
 *   baseConsumed?: LedgerDims,
 *   inputReserveChars?: number,
 *   clock?: () => number,
 *   onEvent?: (record: object) => void,
 * }} args
 */
export function createToolLedger(
	{
		limit,
		baseConsumed = { model_requests: 0, tool_calls: 0, input_chars: 0, wall_time_ms: 0 },
		clock = () => Date.now(),
		onEvent = null,
	} = /** @type {any} */ ({}),
) {
	const zeros = { model_requests: 0, tool_calls: 0, input_chars: 0, wall_time_ms: 0 };
	const normalizedLimit = { ...zeros, ...(limit ?? {}) };
	const consumed = { ...zeros, ...(baseConsumed ?? {}) };
	const startedAt = clock();
	const records = [];
	const pending = new Set();

	function remaining() {
		return {
			model_requests: Math.max(0, (normalizedLimit.model_requests ?? 0) - consumed.model_requests),
			tool_calls: Math.max(0, (normalizedLimit.tool_calls ?? 0) - consumed.tool_calls),
			input_chars: Math.max(0, (normalizedLimit.input_chars ?? 0) - consumed.input_chars),
			wall_time_ms: Math.max(0, (normalizedLimit.wall_time_ms ?? 0) - (consumed.wall_time_ms + (clock() - startedAt))),
		};
	}

	/**
	 * Admit a provider request BEFORE it is sent. `inputChars` is the ESTIMATED
	 * total input (ROM + tools + RAM + history + output reserve).
	 *
	 * @param {{inputChars: number, kind?: string}} args
	 * @returns {{ok: boolean, reason?: string, reservation_id?: string}}
	 */
	function admitRequest({ inputChars = 0, kind = "provider_request" } = {}) {
		const rem = remaining();
		if (rem.model_requests < 1) {
			return {
				ok: false,
				reason: `model request budget exhausted (${consumed.model_requests}/${normalizedLimit.model_requests})`,
			};
		}
		if (normalizedLimit.input_chars > 0 && inputChars > 0) {
			if (consumed.input_chars + inputChars > normalizedLimit.input_chars) {
				return {
					ok: false,
					reason: `total input estimate ${inputChars} would exceed the configured limit (remaining ${rem.input_chars})`,
				};
			}
		}
		const reservationId = `res-${records.length}-${clock()}`;
		pending.add(reservationId);
		records.push({
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
	 * Commit an admitted provider request with its ACTUAL usage. `usage` may be
	 * missing; unobservable dimensions stay `unknown`.
	 *
	 * @param {{reservation_id?: string, usage?: any, inputChars?: number}} args
	 */
	function commitRequest({ reservation_id = null, usage = null, inputChars = 0 } = {}) {
		if (reservation_id) pending.delete(reservation_id);
		const elapsed = Math.max(0, clock() - startedAt - consumed.wall_time_ms);
		consumed.model_requests += 1;
		consumed.input_chars += Math.max(0, inputChars);
		consumed.wall_time_ms += elapsed;
		const measured = normalizeUsage(usage);
		const record = {
			record_id: reservation_id,
			kind: "provider_request",
			phase: "commit",
			input_chars_estimated: inputChars,
			usage: measured,
			at: new Date(clock()).toISOString(),
		};
		records.push(record);
		if (onEvent) onEvent({ kind: "request.committed", usage: measured });
		return record;
	}

	/**
	 * Admit a tool call BEFORE it runs. The faux/tool loop may issue many; each is
	 * gated independently.
	 *
	 * @param {{tool_name?: string}} args
	 */
	function admitTool({ tool_name = "unknown" } = {}) {
		const rem = remaining();
		if (rem.tool_calls < 1) {
			return { ok: false, reason: `tool call budget exhausted (${consumed.tool_calls}/${normalizedLimit.tool_calls})` };
		}
		consumed.tool_calls += 1;
		records.push({ kind: "tool_call", tool_name, phase: "admit", at: new Date(clock()).toISOString() });
		if (onEvent) onEvent({ kind: "tool.admitted", tool_name });
		return { ok: true };
	}

	/**
	 * A snapshots view. Unobservable token/currency dimensions are surfaced as
	 * `unknown`, never as 0.
	 */
	function snapshot() {
		return {
			schema_version: "1.0",
			limit: { ...normalizedLimit },
			consumed: { ...consumed, wall_time_ms: consumed.wall_time_ms + (clock() - startedAt) },
			remaining: remaining(),
			pending_reservations: [...pending],
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
