// Shared contract helpers for the fixture direct vertical slice.
//
// These functions intentionally mirror the field names and shapes of
// docs/MEMORY_SCHEMA.md (Event / Episode / Outcome / Experience). The existing
// memory scripts are not modified; this module is used only by the new fixture
// slice so that both code paths speak the same contract.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function sha256Hex(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export const SCHEMA_VERSION = "1.0";
export const HOST_VERSION = "0.1.0";

export function fail(message) {
	throw new Error(message);
}

export function isoNow() {
	return new Date(Date.now()).toISOString();
}

export function newId() {
	return randomUUID();
}

export function stable(value) {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function digest(value) {
	return `sha256:${sha256Hex(stable(value))}`;
}

export function assertObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

export function assertArray(value, label) {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
}

export function readJson(path) {
	if (!existsSync(path)) fail(`File does not exist: ${path}`);
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		fail(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function readJsonl(path) {
	if (!existsSync(path)) fail(`Event log does not exist: ${path}`);
	const rows = [];
	for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch (error) {
			fail(`Cannot parse ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return rows;
}

export function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeJsonl(path, rows) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

// Append one JSONL row and confirm it reached disk before returning. The
// fsync plus read-back means the caller can treat a returned row as durable
// intent, and a throw as "no side effect has been authorized yet".
function appendJsonlConfirmed(path, row) {
	const line = JSON.stringify(row);
	mkdirSync(dirname(path), { recursive: true });
	const fd = openSync(path, "a");
	try {
		writeSync(fd, `${line}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const persisted = readFileSync(path, "utf8").split(/\r?\n/).filter((entry) => entry.length > 0);
	if (persisted.at(-1) !== line) fail(`failed to confirm event write at ${path}`);
	return row;
}

// Atomic-ish JSON write: write to a sibling temp file, then rename.
export function writeJsonAtomic(path, value) {
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporary, path);
}

// Resolve a path strictly inside `root`. Rejects absolute paths, `..`, and
// symlink escapes. This is the fixture boundary; it is NOT a general sandbox.
export function resolveInside(root, relativePath, { mustExist = false } = {}) {
	if (typeof relativePath !== "string" || relativePath.length === 0) fail("path must be a non-empty string");
	if (isAbsolute(relativePath)) fail(`absolute path is not allowed: ${relativePath}`);
	const rootReal = realpathSync(root);
	const candidate = resolve(rootReal, relativePath);
	const rel = relative(rootReal, candidate);
	if (rel.startsWith("..") || isAbsolute(rel)) fail(`path escapes the fixture root: ${relativePath}`);
	if (existsSync(candidate)) {
		const candidateReal = realpathSync(candidate);
		const relReal = relative(rootReal, candidateReal);
		if (relReal.startsWith("..") || isAbsolute(relReal)) fail(`path escapes the fixture root via symlink: ${relativePath}`);
	}
	let parent = dirname(candidate);
	while (!existsSync(parent) && parent !== rootReal) parent = dirname(parent);
	if (existsSync(parent)) {
		const parentReal = realpathSync(parent);
		const relParent = relative(rootReal, parentReal);
		if (relParent.startsWith("..") || isAbsolute(relParent)) fail(`path escapes the fixture root via parent symlink: ${relativePath}`);
	}
	if (mustExist && !existsSync(candidate)) fail(`path does not exist: ${relativePath}`);
	return candidate;
}

export function getPath(value, path) {
	const parts = path.split(".").filter(Boolean);
	let current = value;
	for (const part of parts) {
		if (current === null || current === undefined || !Object.hasOwn(Object(current), part)) return undefined;
		current = current[part];
	}
	return current;
}

export function matchesPredicate(value, predicate) {
	if (predicate.op === "exists") return value !== undefined;
	if (predicate.op === "eq") return stable(value) === stable(predicate.value);
	if (predicate.op === "neq") return stable(value) !== stable(predicate.value);
	fail(`unsupported predicate op: ${predicate.op}`);
}

export function evaluatePredicates(state, predicates) {
	return predicates.every((predicate) => matchesPredicate(getPath(state, predicate.path), predicate));
}

export function valuesForPredicates(state, predicates) {
	return Object.fromEntries(predicates.map((predicate) => [predicate.path, getPath(state, predicate.path)]));
}

export function validatePredicate(predicate, label = "predicate") {
	assertObject(predicate, label);
	if (typeof predicate.path !== "string" || !predicate.path) fail(`${label}.path is required`);
	if (!["eq", "neq", "exists"].includes(predicate.op)) fail(`${label}.op is unsupported: ${predicate.op}`);
	if (predicate.op !== "exists" && !Object.hasOwn(predicate, "value")) fail(`${label}.value is required`);
}

// Append-only event writer with a per-stream hash chain. When `persistPath` is
// given, every event is durably appended and confirmed before `emit` returns;
// emit throws (fail closed) instead of returning an unpersisted event.
export function createEventWriter(seedEvents = [], { persistPath = null } = {}) {
	let previousDigest = seedEvents.at(-1)?.event_digest;
	const events = [...seedEvents];
	return {
		emit(eventType, episodeId, sequence, payload, source, extra = {}) {
			const event = {
				schema_version: SCHEMA_VERSION,
				event_id: newId(),
				event_type: eventType,
				episode_id: episodeId,
				sequence,
				occurred_at: extra.occurred_at || isoNow(),
				recorded_at: isoNow(),
				source,
				payload,
				correlation_id: episodeId || extra.correlation_id || "session",
				evidence_refs: extra.evidence_refs || [],
				...(extra.causation_id ? { causation_id: extra.causation_id } : {}),
				...(previousDigest ? { prev_event_digest: previousDigest } : {}),
			};
			event.event_digest = digest(event);
			previousDigest = event.event_digest;
			events.push(event);
			if (persistPath) appendJsonlConfirmed(persistPath, event);
			return event;
		},
		all() {
			return events;
		},
	};
}

export function validateEvent(event, index, previous) {
	assertObject(event, `event ${index}`);
	if (event.schema_version !== SCHEMA_VERSION) fail(`event ${index} has unsupported schema_version`);
	if (typeof event.event_id !== "string" || !event.event_id) fail(`event ${index} has no event_id`);
	if (typeof event.event_type !== "string" || !event.event_type) fail(`event ${index} has no event_type`);
	if (!Object.hasOwn(event, "episode_id")) fail(`event ${index} has no episode_id`);
	if (!Object.hasOwn(event, "event_digest")) fail(`event ${index} has no event_digest`);
	if (previous && event.prev_event_digest !== previous.event_digest) fail(`event ${index} has a broken prev_event_digest link`);
	const withoutDigest = { ...event };
	delete withoutDigest.event_digest;
	if (digest(withoutDigest) !== event.event_digest) fail(`event ${index} has an invalid event_digest`);
}

export function validateEventLog(events) {
	if (events.length === 0) fail("event log is empty");
	const ids = new Set();
	for (let index = 0; index < events.length; index += 1) {
		if (ids.has(events[index].event_id)) fail(`duplicate event_id: ${events[index].event_id}`);
		ids.add(events[index].event_id);
		validateEvent(events[index], index, events[index - 1]);
	}
	return ids;
}

// Verify that every event evidence reference resolves to a known event id.
export function unresolvedEventRefs(events, refs) {
	const known = new Set(events.map((event) => event.event_id));
	return (refs || [])
		.filter((ref) => ref.ref_type === "event" && !known.has(ref.ref_id))
		.map((ref) => ref.ref_id);
}

export function source(actorId, kind, adapter, version = HOST_VERSION) {
	return { actor_id: actorId, kind, adapter, version };
}

export function joinPath(...parts) {
	return join(...parts);
}
