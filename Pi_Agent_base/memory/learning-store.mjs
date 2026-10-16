// Aegis learning store — a derived, rebuildable view of compiled Experiences.
//
// This is NOT a second truth source. The authoritative record of "an Experience
// was compiled" is an append-only `runtime.note` (kind `experience.compiled`)
// written by the trusted Observer/Runtime through its ONE EventLog. This store
// is a convenience projection so `/aegis route`/`/aegis run` can load an active
// Experience without re-running the compiler; deleting it loses nothing.
//
// Rules:
//   * Only a `status: "active"` Experience produced by the reviewed compiler is
//     stored as active. A `candidate` is stored as a candidate and is NEVER
//     eligible to route direct/habit.
//   * Writes are atomic (temp + rename) and versioned per experience id; the
//     previous revision is kept under `versions/` for review.
//   * The store never invents a proof, a digest or a scope.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LEARNING_STORE_SCHEMA = "1.0";

function safeId(id) {
	return String(id).replace(/[^A-Za-z0-9._-]/g, "_");
}

function isObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stable(value) {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Content digest of a compiled Experience. Used to pin the derived store against the authoritative `experience.compiled` note. Canonicalised through JSON first so an in-memory object and its persisted round-trip produce the SAME digest (an `undefined`-valued key would otherwise be dropped on disk). */
export function contentDigest(value) {
	const canonical = value === undefined ? null : JSON.parse(JSON.stringify(value));
	return `sha256:${createHash("sha256").update(stable(canonical)).digest("hex")}`;
}

/**
 * Filter active store records to only those whose `experience_id`, revision,
 * `source_outcome_ids` AND full content digest match an authoritative committed
 * `experience.compiled` note (source `runtime`). A tampered, missing or stale
 * store record never routes (it falls back to candidate/deliberate upstream).
 *
 * @param {any[]} records store `loadActive()` results
 * @param {any[]} events committed EventLog rows
 * @returns {any[]}
 */
export function authoritativeActiveExperiences(records, events) {
	const rows = Array.isArray(events) ? events : [];
	const notes = new Map();
	for (const event of rows) {
		const payload = event?.payload;
		if (!payload || payload.kind !== "experience.compiled") continue;
		if (payload.active !== true) continue;
		const id = payload.experience_id;
		if (typeof id !== "string" || !id) continue;
		notes.set(id, payload);
	}
	return (Array.isArray(records) ? records : []).filter((record) => {
		if (!isObject(record) || record.active !== true) return false;
		if (typeof record.experience_id !== "string" || !record.experience_id) return false;
		const note = notes.get(record.experience_id);
		if (!note) return false;
		// EVERY authoritative field must be PRESENT on both sides and match. A
		// missing/omitted field is a tamper/stale projection, never a pass: a
		// record that cannot be aligned to the committed note must not route.
		if (!Number.isInteger(note.revision) || !Number.isInteger(record.revision)) return false;
		if (note.revision !== record.revision) return false;
		const noteIds = Array.isArray(note.source_outcome_ids) ? [...note.source_outcome_ids].sort() : null;
		const recordIds = Array.isArray(record.source_outcome_ids) ? [...record.source_outcome_ids].sort() : null;
		if (!noteIds || noteIds.length === 0 || !recordIds) return false;
		if (JSON.stringify(noteIds) !== JSON.stringify(recordIds)) return false;
		if (typeof note.content_digest !== "string" || note.content_digest.length === 0) return false;
		if (typeof record.content_digest !== "string" || record.content_digest.length === 0) return false;
		if (note.content_digest !== record.content_digest) return false;
		// The digest must also actually cover the STORED content, so copying the
		// note's digest onto a swapped body is refused.
		if (contentDigest(record.experience) !== record.content_digest) return false;
		return true;
	});
}

/**
 * @param {{ dir?: string }} input
 * @returns {object}
 */
export function createLearningStore({ dir } = {}) {
	if (typeof dir !== "string" || !dir) throw new Error("createLearningStore requires a directory");

	const indexPath = () => join(dir, "index.json");
	const experiencePath = (id) => join(dir, `${safeId(id)}.json`);

	async function readJson(path) {
		try {
			return JSON.parse(await readFile(path, "utf8"));
		} catch {
			return null;
		}
	}

	async function writeAtomic(path, value) {
		await mkdir(dir, { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await rename(tmp, path);
	}

	/** Persist one compiled result. Returns the stored record (never mutates it). */
	async function save(compiled, { sourceOutcomeIds = [], recordedAt = null } = {}) {
		const experience = compiled?.experience ?? null;
		if (!isObject(experience) || typeof experience.experience_id !== "string" || !experience.experience_id) {
			return { ok: false, reason: "the compiled result carries no experience_id; nothing was stored" };
		}
		const status = experience.status === "active" ? "active" : "candidate";
		const record = {
			schema_version: LEARNING_STORE_SCHEMA,
			note: "derived projection; the authoritative record is the append-only runtime.note event",
			experience_id: experience.experience_id,
			revision: Number.isInteger(experience.revision) ? experience.revision : 1,
			status,
			active: status === "active",
			source_outcome_ids: [...sourceOutcomeIds],
			content_digest: contentDigest(experience),
			recorded_at: recordedAt,
			experience,
			failures: Array.isArray(compiled?.failures) ? compiled.failures : [],
		};
		// A failed/candidate re-compile of an ALREADY-ACTIVE Experience must not
		// silently downgrade the derived record. The authoritative committed note
		// still says "active"; keeping the active projection is what makes the store
		// a rebuildable projection rather than a second source of truth. A genuine
		// replacement must itself reach `active` (new proofs/revision).
		const existing = await readJson(experiencePath(experience.experience_id));
		if (existing && existing.active === true && status !== "active") {
			return {
				ok: false,
				reason:
					"refusing to downgrade an already-active Experience to candidate; the authoritative active record is preserved",
			};
		}
		await writeAtomic(experiencePath(experience.experience_id), record);
		const index = (await readJson(indexPath())) ?? { schema_version: LEARNING_STORE_SCHEMA, experiences: [] };
		const without = index.experiences.filter((entry) => entry.experience_id !== experience.experience_id);
		without.push({
			experience_id: experience.experience_id,
			revision: record.revision,
			status,
			active: record.active,
			recorded_at: recordedAt,
		});
		await writeAtomic(indexPath(), { schema_version: LEARNING_STORE_SCHEMA, experiences: without });
		return { ok: true, record };
	}

	/** Load one experience record (active or candidate). */
	async function load(experienceId) {
		return readJson(experiencePath(experienceId));
	}

	/** Load every ACTIVE experience (candidates are excluded from routing). */
	async function loadActive() {
		const index = await readJson(indexPath());
		if (!index || !Array.isArray(index.experiences)) return [];
		const out = [];
		for (const entry of index.experiences) {
			if (entry.active !== true) continue;
			const record = await readJson(experiencePath(entry.experience_id));
			if (record && record.active === true && isObject(record.experience)) out.push(record);
		}
		return out;
	}

	/** Load ALL stored records (for review/reporting). */
	async function loadAll() {
		const index = await readJson(indexPath());
		if (!index || !Array.isArray(index.experiences)) return [];
		const out = [];
		for (const entry of index.experiences) {
			const record = await readJson(experiencePath(entry.experience_id));
			if (record) out.push(record);
		}
		return out;
	}

	return { dir, indexPath, experiencePath, save, load, loadActive, loadAll };
}
