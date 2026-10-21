// Tool catalog: what CLIs this machine has, how to call them, and what goes wrong.
//
// This is NOT the script-action registry (execution/script-registry.mjs). That one
// runs a fixed argv with a pinned digest and an Oracle. This one is a capability
// list for GENERAL tools: the model composes the arguments itself and runs them
// through bash, so the catalog has to say what the tool is, how it is invoked, and
// what pitfalls exist - not what command to run.
//
// Trust: a catalog entry is documentation, not authorization. Nothing here grants
// a call, and nothing here becomes evidence. Observations made through bash stay
// opaque (see Pi_Agent_base/AGENTS.md).
//
// Pitfalls follow the project's rule (架构.md §6.4): a pitfall is a JUDGEMENT, not
// prose. Each note carries the condition, the symptom and the correct invocation,
// plus provenance, so it can be checked instead of believed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const TOOL_CATALOG_VERSION = "1.0";
export const NOTE_STATUSES = Object.freeze(["candidate", "confirmed"]);

const MAX_ID = 80;
const MAX_TEXT = 400;

function bounded(value, limit = MAX_TEXT) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= limit ? trimmed : null;
}

function stringList(value, limit = 12) {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > limit) return null;
	const out = [];
	for (const entry of value) {
		const text = bounded(entry);
		if (!text) return null;
		out.push(text);
	}
	return out;
}

/**
 * Validate one note (a pitfall judgement).
 * @returns {{ok: true, note: object} | {ok: false, reason: string}}
 */
export function parseNote(raw, { index = 0 } = {}) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return { ok: false, reason: `note[${index}] is not an object` };
	const condition = bounded(raw.condition);
	const symptom = bounded(raw.symptom);
	const correct = bounded(raw.correct_invocation ?? raw.correct);
	if (!condition) return { ok: false, reason: `note[${index}] needs a condition ("when this holds")` };
	if (!symptom) return { ok: false, reason: `note[${index}] needs a symptom ("what goes wrong")` };
	if (!correct) return { ok: false, reason: `note[${index}] needs correct_invocation ("what works instead")` };
	const status = raw.status === undefined ? "candidate" : bounded(raw.status, 20);
	if (!NOTE_STATUSES.includes(status))
		return { ok: false, reason: `note[${index}] status must be candidate or confirmed` };
	const refs = stringList(raw.refs ?? [], 8);
	if (refs === null) return { ok: false, reason: `note[${index}] refs must be <=8 short strings` };
	return {
		ok: true,
		note: {
			condition,
			symptom,
			correct_invocation: correct,
			status,
			...(typeof raw.recorded_at === "string" ? { recorded_at: raw.recorded_at } : {}),
			...(refs.length > 0 ? { refs } : {}),
		},
	};
}

/**
 * Validate one tool entry.
 * @returns {{ok: true, tool: object} | {ok: false, reason: string}}
 */
export function parseTool(raw, { index = 0 } = {}) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return { ok: false, reason: `tool[${index}] is not an object` };
	const id = bounded(raw.id, MAX_ID);
	if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return { ok: false, reason: `tool[${index}] has an invalid id` };
	const purpose = bounded(raw.purpose);
	if (!purpose) return { ok: false, reason: `tool ${id} needs a purpose ("what it is for")` };
	const executable = bounded(raw.executable, 500);
	if (!executable) return { ok: false, reason: `tool ${id} needs an executable path` };

	const iface =
		raw.interface && typeof raw.interface === "object" && !Array.isArray(raw.interface) ? raw.interface : {};
	const usage = bounded(iface.usage);
	if (!usage) return { ok: false, reason: `tool ${id} needs interface.usage (the invocation shape)` };
	const flags = stringList(iface.key_flags ?? [], 20);
	if (flags === null) return { ok: false, reason: `tool ${id} key_flags must be <=20 strings` };
	const examples = stringList(iface.examples ?? [], 6);
	if (examples === null) return { ok: false, reason: `tool ${id} examples must be <=6 strings` };

	if (!Array.isArray(raw.pitfalls ?? [])) return { ok: false, reason: `tool ${id} pitfalls must be an array` };
	const pitfalls = [];
	for (const [noteIndex, note] of (raw.pitfalls ?? []).entries()) {
		const parsed = parseNote(note, { index: noteIndex });
		if (!parsed.ok) return { ok: false, reason: `tool ${id}: ${parsed.reason}` };
		pitfalls.push(parsed.note);
	}

	return {
		ok: true,
		tool: {
			schema_version: TOOL_CATALOG_VERSION,
			id,
			purpose,
			executable,
			interface: { usage, key_flags: flags, examples },
			pitfalls,
			...(typeof raw.category === "string" && raw.category.trim() ? { category: raw.category.trim() } : {}),
			...(typeof raw.notes === "string" && raw.notes.trim() ? { notes: raw.notes.trim() } : {}),
			...(typeof raw.updated_at === "string" ? { updated_at: raw.updated_at } : {}),
		},
	};
}

/**
 * Load and validate a catalog file. A missing file is a valid empty catalog; a
 * malformed one is reported instead of being silently ignored.
 * @returns {{ok: boolean, catalog: {schema_version: string, tools: object[]}, errors: string[]}}
 */
export function loadToolCatalog(path) {
	const empty = { schema_version: TOOL_CATALOG_VERSION, tools: [] };
	if (!path || !existsSync(path)) return { ok: true, catalog: empty, errors: [] };
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return {
			ok: false,
			catalog: empty,
			errors: [`catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tools)) {
		return { ok: false, catalog: empty, errors: ['catalog must be {"tools": [...]}'] };
	}
	const tools = [];
	const errors = [];
	const seen = new Set();
	for (const [index, entry] of parsed.tools.entries()) {
		const result = parseTool(entry, { index });
		if (!result.ok) {
			errors.push(result.reason);
			continue;
		}
		if (seen.has(result.tool.id)) {
			errors.push(`duplicate tool id: ${result.tool.id}`);
			continue;
		}
		seen.add(result.tool.id);
		tools.push(result.tool);
	}
	return { ok: errors.length === 0, catalog: { ...parsed, schema_version: TOOL_CATALOG_VERSION, tools }, errors };
}

export function saveToolCatalog(path, catalog) {
	writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Compact one-line summary per tool. This is what a model needs to decide whether
 * to ask for details; it deliberately omits paths and the full pitfall text.
 */
export function summarizeTools(catalog) {
	return (catalog?.tools ?? []).map((tool) => ({
		id: tool.id,
		purpose: tool.purpose,
		usage: tool.interface?.usage ?? "",
		...(tool.category ? { category: tool.category } : {}),
		pitfall_count: Array.isArray(tool.pitfalls) ? tool.pitfalls.length : 0,
	}));
}

/**
 * Full detail for one tool, or null.
 */
export function describeTool(catalog, id) {
	const tool = (catalog?.tools ?? []).find((entry) => entry.id === id);
	if (!tool) return null;
	return {
		id: tool.id,
		purpose: tool.purpose,
		executable: tool.executable,
		interface: tool.interface,
		...(tool.notes ? { notes: tool.notes } : {}),
		pitfalls: (tool.pitfalls ?? []).map((note) => ({
			condition: note.condition,
			symptom: note.symptom,
			correct_invocation: note.correct_invocation,
			status: note.status,
		})),
	};
}

/**
 * Add a note to a tool. A candidate note that already exists (same condition +
 * symptom) is not duplicated; an identical note is promoted to `confirmed` when
 * `confirm` is set. This is how a confirmed solve turns a proposal into a
 * judgement without inventing new text.
 *
 * @returns {{ok: boolean, reason?: string, added: boolean, promoted: boolean}}
 */
export function addToolNote(catalog, toolId, rawNote, { confirm = false, recordedAt = null } = {}) {
	const tool = (catalog?.tools ?? []).find((entry) => entry.id === toolId);
	if (!tool) return { ok: false, reason: `unknown tool: ${toolId}`, added: false, promoted: false };
	const parsed = parseNote(rawNote);
	if (!parsed.ok) return { ok: false, reason: parsed.reason, added: false, promoted: false };
	const note = {
		...parsed.note,
		status: confirm ? "confirmed" : parsed.note.status === "confirmed" ? "confirmed" : "candidate",
		...(recordedAt ? { recorded_at: recordedAt } : {}),
	};
	tool.pitfalls = Array.isArray(tool.pitfalls) ? tool.pitfalls : [];
	const existing = tool.pitfalls.find((entry) => entry.condition === note.condition && entry.symptom === note.symptom);
	if (existing) {
		if (note.status === "confirmed" && existing.status !== "confirmed") {
			existing.status = "confirmed";
			existing.correct_invocation = note.correct_invocation;
			if (note.recorded_at) existing.recorded_at = note.recorded_at;
			const refs = new Set([...(existing.refs ?? []), ...(note.refs ?? [])]);
			if (refs.size > 0) existing.refs = [...refs].slice(0, 8);
			return { ok: true, added: false, promoted: true };
		}
		return { ok: true, added: false, promoted: false };
	}
	tool.pitfalls.push(note);
	tool.updated_at = recordedAt ?? new Date().toISOString();
	return { ok: true, added: true, promoted: false };
}
