// Trusted Host -> replacement-Session completion grant.
//
// `handoff.completed` is authoritative: it spends one Session generation and
// advances the Task boundary. Neither the staged JSON nor a plain
// `session_start` may create it. Only the Host call that is actually creating a
// replacement (Supervisor/`applyStagedHandoff` or the explicit `/aegis switch`
// command) may open a short-lived attempt:
//
//   * a durable attempt file names the exact request + episode + source Session
//     and carries a random attempt id (auditable causation);
//   * the SAME attempt id exists only in this process' environment for the
//     duration of the `newSession` call. A later process/initial Session has no
//     live id, so a stale attempt file can never authorize a completion.
//
// The replacement Session consumes the grant exactly once; the Host clears the
// live id in a `finally` block even when creation/rebind fails.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";

export const HANDOFF_ATTEMPT_VERSION = "handoff-attempt-1";
export const HANDOFF_ATTEMPT_ENV = "AEGIS_HANDOFF_ATTEMPT";

/** @param {string} handoffPath */
export function handoffAttemptPath(handoffPath) {
	return `${handoffPath}.attempt.json`;
}

/**
 * Open one controlled replacement attempt. Must be paired with
 * `endHandoffAttempt` in a `finally` block.
 *
 * @param {{handoffPath: string, handoff: any, fromSession?: string|null, boundaryIdentity?: string|null}} args
 * @returns {Promise<{version: string, attempt_id: string, request_id: string|null, episode_id: string|null, from_session: string|null, boundary_identity: string|null, created_at: string}>}
 */
export async function beginHandoffAttempt({ handoffPath, handoff, fromSession = null, boundaryIdentity = null }) {
	const attempt = {
		version: HANDOFF_ATTEMPT_VERSION,
		attempt_id: randomUUID(),
		request_id: typeof handoff?.request_id === "string" ? handoff.request_id : null,
		episode_id: typeof handoff?.episode_id === "string" ? handoff.episode_id : null,
		from_session: typeof fromSession === "string" && fromSession ? fromSession : null,
		boundary_identity:
			typeof boundaryIdentity === "string" && boundaryIdentity
				? boundaryIdentity
				: typeof handoff?.work_cycle?.boundary_identity === "string"
					? handoff.work_cycle.boundary_identity
					: null,
		created_at: new Date().toISOString(),
	};
	await writeFile(handoffAttemptPath(handoffPath), JSON.stringify(attempt, null, 2), "utf8");
	process.env[HANDOFF_ATTEMPT_ENV] = attempt.attempt_id;
	return attempt;
}

/**
 * Clear the live capability. An un-consumed attempt file is removed; a consumed
 * one has already been retired by the replacement Session.
 *
 * @param {{handoffPath: string, attempt: {attempt_id?: string}|null, consumed?: boolean}} args
 */
export async function endHandoffAttempt({ handoffPath, attempt, consumed = false }) {
	if (attempt?.attempt_id && process.env[HANDOFF_ATTEMPT_ENV] === attempt.attempt_id)
		delete process.env[HANDOFF_ATTEMPT_ENV];
	if (!consumed) await unlink(handoffAttemptPath(handoffPath)).catch(() => undefined);
}

/**
 * Read the durable attempt file (no authority by itself).
 * @param {string} handoffPath
 * @returns {Promise<any|null>}
 */
export async function readHandoffAttempt(handoffPath) {
	try {
		return JSON.parse(await readFile(handoffAttemptPath(handoffPath), "utf8"));
	} catch {
		return null;
	}
}

/** Synchronous variant used by the extension's post-bind completion path. */
export function readHandoffAttemptSync(handoffPath) {
	try {
		return JSON.parse(readFileSync(handoffAttemptPath(handoffPath), "utf8"));
	} catch {
		return null;
	}
}

/**
 * Retire the attempt file only after its completion was durably appended.
 * @param {string} handoffPath
 */
export async function consumeHandoffAttempt(handoffPath) {
	const { rename } = await import("node:fs/promises");
	await rename(handoffAttemptPath(handoffPath), `${handoffAttemptPath(handoffPath)}.applied.json`).catch(
		() => undefined,
	);
}

/**
 * True only when a LIVE Host attempt authorizes this replacement Session to
 * complete exactly this staged request.
 *
 * @param {{handoff: any, attempt: any, sessionId: string|null}} args
 * @returns {{ok: boolean, reason?: string}}
 */
export function handoffAttemptAuthorizes({ handoff, attempt, sessionId }) {
	const live = process.env[HANDOFF_ATTEMPT_ENV];
	if (typeof live !== "string" || !live) return { ok: false, reason: "no live Host handoff attempt" };
	if (!attempt || attempt.version !== HANDOFF_ATTEMPT_VERSION) return { ok: false, reason: "no valid attempt record" };
	if (attempt.attempt_id !== live) return { ok: false, reason: "attempt record does not match the live Host call" };
	if (!handoff?.request_id || attempt.request_id !== handoff.request_id)
		return { ok: false, reason: "attempt request does not match the staged request" };
	if (!handoff?.episode_id || attempt.episode_id !== handoff.episode_id)
		return { ok: false, reason: "attempt episode does not match the staged request" };
	if (typeof attempt.from_session !== "string" || !attempt.from_session)
		return { ok: false, reason: "attempt has no source Session identity" };
	if (typeof sessionId !== "string" || !sessionId)
		return { ok: false, reason: "the replacement Session has no bound identity" };
	if (attempt.from_session === sessionId)
		return { ok: false, reason: "the bound Session is the source Session, not a replacement" };
	const stagedBoundary = handoff?.work_cycle?.boundary_identity;
	if (
		typeof stagedBoundary === "string" &&
		stagedBoundary &&
		attempt.boundary_identity &&
		attempt.boundary_identity !== stagedBoundary
	)
		return { ok: false, reason: "attempt boundary does not match the staged request" };
	return { ok: true };
}
