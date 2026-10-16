// Campaign-level typed identifiers (C0 contract).
//
// The Campaign layer must never conflate Campaign / Task / Stage / Episode /
// Session identity. A Session is disposable and must not be counted as an
// independent Episode (docs/ARCHITECTURE_DECISIONS.md "短会话主线"). This module
// gives each object a stable, prefixed id and a classifier so a projection can
// refuse a value of the wrong kind before it is stored or compared.
//
// Prefixes are deliberately distinct so an accidental Session id can never be
// mistaken for an Episode id, and a Task id can never be mistaken for a Stage id.

import { randomUUID } from "node:crypto";

export const ID_KINDS = Object.freeze(["campaign", "task", "stage", "episode", "session"]);

const PREFIX = Object.freeze({
	campaign: "campaign-",
	task: "task-",
	stage: "stage-",
	episode: "ep-",
	session: "sess-",
});

/**
 * Deterministic-by-injection id factory.
 *
 * `make` defaults to `randomUUID`, but callers (fixtures, tests) may inject a
 * counter so the same fixture builds the same ids every run. The Campaign
 * fixture MUST be deterministic, so it injects a counter rather than relying on
 * entropy.
 */
function makeId(kind, make = randomUUID) {
	return `${PREFIX[kind]}${make()}`;
}

export function newCampaignId(make) {
	return makeId("campaign", make);
}
export function newTaskId(make) {
	return makeId("task", make);
}
export function newStageId(make) {
	return makeId("stage", make);
}
export function newEpisodeId(make) {
	return makeId("episode", make);
}
export function newSessionId(make) {
	return makeId("session", make);
}

/**
 * Classify an id string by its prefix. Returns a kind in `ID_KINDS`, or `null`
 * for an empty/non-string/unknown value. Unknown values are NEVER guessed at.
 */
/**
 * A safe id SUFFIX: non-empty, no path separator, no traversal segment, no
 * control character or whitespace. This is deliberately restrictive: a Task id
 * is used to build filesystem paths (per-task evidence dirs) and to key maps, so
 * `task-`, `task-..`, `task-a/b` and control characters must never classify as
 * a valid id. This is a pure predicate and never throws.
 */
function isSafeIdSuffix(suffix) {
	if (typeof suffix !== "string" || suffix.length === 0) return false;
	// No path separators, no traversal, no control chars, no whitespace.
	if (/[\\/\u0000-\u001f\u007f]/.test(suffix)) return false;
	if (suffix === "." || suffix === "..") return false;
	if (suffix.split(/[.\-_]/).includes("..")) return false;
	return true;
}

/**
 * Classify an id string by its prefix. Returns a kind in `ID_KINDS`, or `null`
 * for an empty/non-string/unknown value OR a malformed suffix. Unknown values
 * are NEVER guessed at.
 */
export function classifyId(id) {
	if (typeof id !== "string" || id.length === 0) return null;
	for (const kind of ID_KINDS) {
		const prefix = PREFIX[kind];
		if (id.startsWith(prefix)) return isSafeIdSuffix(id.slice(prefix.length)) ? kind : null;
	}
	return null;
}

/** True only when `id` is a well-formed id of exactly `kind`. */
export function isIdOfKind(id, kind) {
	return ID_KINDS.includes(kind) && classifyId(id) === kind;
}

/**
 * Assert an id is of an expected kind. Returns `{ok, reasons}` rather than
 * throwing so a Manifest validator can accumulate every problem.
 */
export function assertIdType(id, kind, label = "id") {
	const reasons = [];
	if (!ID_KINDS.includes(kind)) reasons.push(`${label}: unknown expected kind ${String(kind)}`);
	if (typeof id !== "string" || id.length === 0) reasons.push(`${label} must be a non-empty string`);
	else {
		const actual = classifyId(id);
		if (actual === null)
			reasons.push(`${label} "${id}" is not a well-formed ${kind} id (missing prefix or unsafe suffix)`);
		else if (actual !== kind) reasons.push(`${label} "${id}" is a ${actual} id, expected ${kind}`);
	}
	return { ok: reasons.length === 0, reasons };
}

/** The prefix for a kind; exposed so callers never hardcode the string. */
export function idPrefix(kind) {
	return PREFIX[kind] ?? null;
}
