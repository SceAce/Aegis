// Aegis Web Console — the Host control channel.
//
// One implementation of the request semantics the browser depends on, used by
// the Experiment Host itself (over stdio) and never by an HTTP handler directly:
//
//   * every command runs on the Host that owns the experiment (ownership →
//     EventLog → single writer → SDK Session → recovery → dispatch);
//   * a dispatch carries a client `request_id`. Its receipt is committed as an
//     inert `runtime.note kind="web.control.receipt"` row (Board/RAM ignore that
//     kind), so a retry after a browser re-connect — or after a Host restart —
//     resolves from committed truth instead of guessing:
//        same id + same prompt  → replay: no second prompt
//        same id + different    → 409 conflict, no prompt
//        id accepted, no result → `unknown` (the run may or may not have started);
//                                 it is NOT silently sent again
//   * pause stops DISPATCHING; it does not claim to abort a running tool;
//   * resume goes through the existing recovery checks (pending/unknown, staged
//     handoff, policy, review hold, budget) and never clears a hold;
//   * stop is a Host shutdown; an unknown in-flight effect keeps its
//     responsibility and is reported as such.
//
// The channel never writes business events, never grants permission and never
// fabricates success. HTTP 202/"message accepted" is not task success.

import { digest } from "../shared/events.mjs";

export const CONTROL_VERSION = "aegis-web-control-1";
export const CONTROL_RECEIPT_KIND = "web.control.receipt";

/** Error codes the Web API maps to HTTP statuses. */
export const CONTROL_ERRORS = Object.freeze({
	unavailable: "host_unavailable",
	conflict_owner: "ownership_conflict",
	paused: "dispatch_paused",
	unknown_request: "request_outcome_unknown",
	id_conflict: "request_id_conflict",
	invalid: "invalid_request",
	blocked: "host_blocked",
});

function isNonEmptyString(value, limit = 200) {
	return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}

function receiptsFrom(events) {
	const map = new Map();
	for (const row of Array.isArray(events) ? events : []) {
		if (row?.event_type !== "runtime.note") continue;
		const payload = row.payload ?? {};
		if (payload.kind !== CONTROL_RECEIPT_KIND) continue;
		if (typeof payload.request_id !== "string" || !payload.request_id) continue;
		map.set(payload.request_id, {
			event_id: row.event_id,
			recorded_at: row.recorded_at ?? null,
			request_id: payload.request_id,
			prompt_digest: payload.prompt_digest ?? null,
			status: payload.status ?? "accepted",
			detail: payload.detail ?? null,
		});
	}
	return map;
}

/**
 * Create the control channel over one Host.
 *
 * @param {{
 *   host: {
 *     start: () => Promise<any>,
 *     status: () => Promise<any>,
 *     snapshot: () => Promise<any>,
 *     dispatch: (text: string) => Promise<any>,
 *     pause: (reason?: string) => any,
 *     resume: (reason?: string) => Promise<any>,
 *     shutdown: (reason?: string) => Promise<any>,
 *     phase: () => string,
 *     committedEvents?: () => Promise<{ok: boolean, events?: any[], reason?: string}>,
 *     appendControlReceipt?: (receipt: object) => Promise<{ok: boolean, event_id?: string|null, reason?: string}>,
 *   },
 *   limits?: {text?: number},
 * }} args
 */
export function createControlChannel({ host, limits = { text: 200_000 } }) {
	if (!host || typeof host.dispatch !== "function") throw new Error("createControlChannel requires a Host");

	/** Serialize commands so two browser tabs cannot interleave dispatches. */
	let queue = Promise.resolve();
	function serial(fn) {
		const run = queue.then(fn, fn);
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async function events() {
		if (typeof host.committedEvents === "function") return host.committedEvents();
		const snapshot = await host.snapshot();
		if (!snapshot.ok) return { ok: false, reason: snapshot.reason };
		return { ok: true, events: snapshot.events };
	}

	async function receiptFor(requestId) {
		const committed = await events();
		if (!committed.ok) return { ok: false, reason: committed.reason };
		return { ok: true, receipt: receiptsFrom(committed.events).get(requestId) ?? null };
	}

	async function recordReceipt({ requestId, promptDigest, status, detail }) {
		if (typeof host.appendControlReceipt !== "function")
			return { ok: false, reason: "the Host does not support control receipts" };
		return host.appendControlReceipt({ requestId, promptDigest, status, detail });
	}

	return {
		version: CONTROL_VERSION,

		status: () => host.status(),

		snapshot: () => host.snapshot(),

		/** A prompt from a browser, resolved against committed receipts. */
		dispatch({ requestId, text, reason = "web message" } = {}) {
			return serial(async () => {
				if (typeof requestId !== "string" || !requestId || requestId.length > 200)
					return { ok: false, code: CONTROL_ERRORS.invalid, reason: "request_id is required" };
				if (typeof text !== "string" || !text.trim())
					return { ok: false, code: CONTROL_ERRORS.invalid, reason: "text is required" };
				if (text.length > (limits.text ?? 200_000))
					return { ok: false, code: CONTROL_ERRORS.invalid, reason: "text is too long" };
				const promptDigest = digest(text);
				const known = await receiptFor(requestId);
				if (!known.ok) return { ok: false, code: CONTROL_ERRORS.unavailable, reason: known.reason };
				if (known.receipt) {
					if (known.receipt.prompt_digest !== promptDigest)
						return {
							ok: false,
							code: CONTROL_ERRORS.id_conflict,
							reason: "this request_id was already used with a different prompt",
							receipt: known.receipt,
						};
					return {
						ok: true,
						duplicate: true,
						code: null,
						receipt: known.receipt,
						// A receipt with no terminal status is an UNKNOWN outcome, not a queued
						// message: the browser must not assume it ran.
						status: known.receipt.status,
						reason:
							known.receipt.status === "started" || known.receipt.status === "accepted"
								? "this request was already accepted; its outcome is unknown and it will not be sent twice"
								: "this request was already handled",
					};
				}
				const phase = typeof host.phase === "function" ? host.phase() : null;
				if (phase === "paused")
					return { ok: false, code: CONTROL_ERRORS.paused, reason: "dispatch is paused; resume first" };
				if (phase === "stopped") return { ok: false, code: CONTROL_ERRORS.unavailable, reason: "the Host is stopped" };
				// Record the acceptance BEFORE running, so a crash cannot make the same
				// request look never-received (that is what would cause a silent replay).
				const accepted = await recordReceipt({
					requestId,
					promptDigest,
					status: "accepted",
					detail: reason,
				});
				if (!accepted.ok)
					return {
						ok: false,
						code: CONTROL_ERRORS.blocked,
						reason: `the Host could not record the request receipt: ${accepted.reason}`,
					};
				const result = await host.dispatch(text);
				const status = result.ok === true ? "handled" : result.action === "blocked" ? "blocked" : "failed";
				await recordReceipt({
					requestId,
					promptDigest,
					status,
					detail: result.reason ?? result.action ?? null,
				});
				return {
					ok: result.ok === true,
					duplicate: false,
					code: result.ok === true ? null : result.action === "blocked" ? CONTROL_ERRORS.blocked : null,
					action: result.action ?? null,
					reason: result.reason ?? null,
					turns: Array.isArray(result.actions) ? result.actions : null,
					status_snapshot: result.status ?? null,
					receipt_status: status,
				};
			});
		},

		pause(reason = "web pause") {
			return serial(async () => host.pause(reason));
		},

		resume(reason = "web resume") {
			return serial(async () => host.resume(reason));
		},

		stop(reason = "web stop") {
			return serial(async () => host.shutdown(reason));
		},

		/** Resolve a request id from committed truth (used on reconnect). */
		requestStatus(requestId) {
			return serial(async () => {
				if (!isNonEmptyString(requestId)) return { ok: false, code: CONTROL_ERRORS.invalid };
				const known = await receiptFor(requestId);
				if (!known.ok) return { ok: false, code: CONTROL_ERRORS.unavailable, reason: known.reason };
				if (!known.receipt) return { ok: true, found: false, receipt: null };
				return { ok: true, found: true, receipt: known.receipt };
			});
		},
	};
}

/** True when a status phase means the Host will accept a new dispatch. */
export function canDispatch(phase) {
	return phase === "running" || phase === "settling" || phase === "handoff_pending";
}
