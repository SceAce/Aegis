// Tool catalog: a capability list for GENERAL CLIs, not a script-action registry.
//
// The distinction matters. A registered script action has a fixed argv and an
// Oracle. A general tool (ROPgadget, pwninit, ...) is invoked with arguments the
// model composes, so the catalog carries the interface and the observed pitfalls -
// and grants nothing: nothing here authorises a call or becomes evidence.
//
// Pitfalls are JUDGEMENTS (架构.md §6.4): condition + symptom + correct invocation,
// never free-form "lessons".
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	addToolNote,
	describeTool,
	loadToolCatalog,
	parseNote,
	parseTool,
	saveToolCatalog,
	summarizeTools,
} from "../memory/tool-catalog.mjs";

const TOOL = {
	id: "ropgadget",
	purpose: "从 ELF 中列出 ROP gadget",
	category: "pwn",
	executable: "/usr/local/bin/ROPgadget",
	interface: {
		usage: 'ROPgadget --binary <file> [--only "pop|ret"] [--depth N]',
		key_flags: ["--binary", "--only", "--depth"],
		examples: ['ROPgadget --binary ./pwn --only "pop|ret"'],
	},
	pitfalls: [],
};

const NOTE = {
	condition: "目标是没有符号的裸 ELF",
	symptom: "只给位置参数时没有输出",
	correct_invocation: 'ROPgadget --binary ./pwn --only "pop|ret"',
};

function catalogFile(tools = [TOOL]) {
	const dir = mkdtempSync(join(tmpdir(), "aegis-catalog-"));
	const path = join(dir, "catalog.json");
	writeFileSync(path, JSON.stringify({ schema_version: "1.0", tools }, null, 2), "utf8");
	return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a missing catalog is a valid empty catalog", () => {
	const loaded = loadToolCatalog("/nonexistent/catalog.json");
	assert.equal(loaded.ok, true);
	assert.deepEqual(loaded.catalog.tools, []);
});

test("a tool needs purpose, executable and an invocation shape", () => {
	assert.equal(parseTool(TOOL).ok, true);
	assert.match(parseTool({ ...TOOL, purpose: "" }).reason, /needs a purpose/);
	assert.match(parseTool({ ...TOOL, executable: "" }).reason, /needs an executable/);
	assert.match(parseTool({ ...TOOL, interface: {} }).reason, /needs interface\.usage/);
	assert.match(parseTool({ ...TOOL, id: "../evil" }).reason, /invalid id/);
});

test("a pitfall without condition, symptom or correct invocation is refused", () => {
	assert.equal(parseNote(NOTE).ok, true);
	assert.match(parseNote({ ...NOTE, condition: "" }).reason, /needs a condition/);
	assert.match(parseNote({ ...NOTE, symptom: "" }).reason, /needs a symptom/);
	assert.match(parseNote({ ...NOTE, correct_invocation: "" }).reason, /needs correct_invocation/);
	assert.match(parseNote({ ...NOTE, status: "maybe" }).reason, /status must be/);
});

test("the summary omits paths and pitfall text but keeps the invocation shape", () => {
	const env = catalogFile();
	try {
		const { catalog } = loadToolCatalog(env.path);
		const summary = summarizeTools(catalog);
		assert.equal(summary.length, 1);
		assert.equal(summary[0].id, "ropgadget");
		assert.match(summary[0].usage, /--binary/);
		assert.equal(summary[0].pitfall_count, 0);
		assert.equal(Object.hasOwn(summary[0], "executable"), false, "paths stay out of the model-facing list");
	} finally {
		env.cleanup();
	}
});

test("describeTool returns the interface and pitfalls for one tool", () => {
	const env = catalogFile([{ ...TOOL, pitfalls: [NOTE] }]);
	try {
		const { catalog } = loadToolCatalog(env.path);
		const detail = describeTool(catalog, "ropgadget");
		assert.equal(detail.id, "ropgadget");
		assert.equal(detail.interface.key_flags.length, 3);
		assert.equal(detail.pitfalls.length, 1);
		assert.equal(detail.pitfalls[0].condition, NOTE.condition);
		assert.equal(describeTool(catalog, "nope"), null);
	} finally {
		env.cleanup();
	}
});

test("a proposed note is candidate; a confirmed solve promotes it without rewriting it", () => {
	const env = catalogFile();
	try {
		const { catalog } = loadToolCatalog(env.path);
		const first = addToolNote(catalog, "ropgadget", NOTE);
		assert.deepEqual([first.ok, first.added, first.promoted], [true, true, false]);
		assert.equal(catalog.tools[0].pitfalls[0].status, "candidate");
		assert.equal(catalog.tools[0].pitfalls[0].condition, NOTE.condition);

		// Same note again: no duplicate.
		const again = addToolNote(catalog, "ropgadget", NOTE);
		assert.deepEqual([again.added, again.promoted], [false, false]);
		assert.equal(catalog.tools[0].pitfalls.length, 1);

		// Confirmation changes status and provenance only.
		const confirmed = addToolNote(catalog, "ropgadget", NOTE, { confirm: true, recordedAt: "2026-10-21T00:00:00Z" });
		assert.deepEqual([confirmed.added, confirmed.promoted], [false, true]);
		const note = catalog.tools[0].pitfalls[0];
		assert.equal(note.status, "confirmed");
		assert.equal(note.correct_invocation, NOTE.correct_invocation);
		assert.equal(note.recorded_at, "2026-10-21T00:00:00Z");
	} finally {
		env.cleanup();
	}
});

test("adding a note to an unknown tool is refused", () => {
	const env = catalogFile();
	try {
		const { catalog } = loadToolCatalog(env.path);
		const result = addToolNote(catalog, "nope", NOTE);
		assert.equal(result.ok, false);
		assert.match(result.reason, /unknown tool/);
	} finally {
		env.cleanup();
	}
});

test("save/load round-trips and rejects a malformed file", () => {
	const env = catalogFile();
	try {
		const { catalog } = loadToolCatalog(env.path);
		addToolNote(catalog, "ropgadget", NOTE);
		saveToolCatalog(env.path, catalog);
		const reloaded = loadToolCatalog(env.path);
		assert.equal(reloaded.ok, true);
		assert.equal(reloaded.catalog.tools[0].pitfalls[0].symptom, NOTE.symptom);

		writeFileSync(env.path, JSON.stringify({ tools: [{ ...TOOL, pitfalls: [{ condition: "only" }] }] }), "utf8");
		const broken = loadToolCatalog(env.path);
		assert.equal(broken.ok, false);
		assert.match(broken.errors.join(" "), /needs a symptom/);
		assert.deepEqual(broken.catalog.tools, [], "a malformed catalog yields no tools rather than a partial one");
	} finally {
		env.cleanup();
	}
});

test("duplicate tool ids are reported and dropped", () => {
	const env = catalogFile([TOOL, { ...TOOL }]);
	try {
		const loaded = loadToolCatalog(env.path);
		assert.equal(loaded.ok, false);
		assert.equal(loaded.catalog.tools.length, 1);
		assert.match(loaded.errors.join(" "), /duplicate tool id/);
	} finally {
		env.cleanup();
	}
});

test("the catalog file is documented as non-authoritative", () => {
	const source = readFileSync(new URL("../memory/tool-catalog.mjs", import.meta.url), "utf8");
	assert.match(source, /documentation, not authorization/);
	// Pitfalls are stored as a judgement (condition + symptom + correct invocation),
	// never as a "lesson" paragraph: 架构.md §6.4 forbids lesson text.
	assert.match(source, /pitfall judgement/);
	assert.match(source, /condition, the symptom and the correct invocation/);
});
