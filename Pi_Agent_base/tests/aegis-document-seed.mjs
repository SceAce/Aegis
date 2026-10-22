import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { compileDocumentSeed, compileDocumentSeedFile } from "../memory/document-seed.mjs";
import { documentReferenceForRam, loadDocumentSeed, selectDocumentSeeds } from "../memory/seed-registry.mjs";

const source = { source_uri: "https://example.invalid/guide.md", source_kind: "external_reference", approved: true };
const markdown = "# Guide\n\nA paragraph.\n\n- first\n- second\n\n## Example\n\n```js\nconst ready = true;\n```\n";
const compile = (extra = {}) => compileDocumentSeed({ markdown, source, ...extra });

test("deterministic blocks, raw source digest, independent physical line refs", () => {
	const a = compile();
	assert.deepEqual(a, compile());
	const b = compile({ generatedAt: "2030-02-03T00:00:00Z" });
	assert.equal(a.semantic_digest, b.semantic_digest);
	assert.notEqual(a.generated_at, b.generated_at);
	assert.equal(a.source_digest, `sha256:${createHash("sha256").update(markdown).digest("hex")}`);
	assert.deepEqual(
		a.sections.map((row) => [row.kind, row.line_start, row.line_end, row.content]),
		[
			["heading", 1, 1, "Guide"],
			["paragraph", 3, 3, "A paragraph."],
			["list", 5, 6, "- first\n- second"],
			["heading", 8, 8, "Example"],
			["code", 10, 12, "const ready = true;"],
		],
	);
	for (const section of a.sections) {
		assert.equal(section.source_digest, a.source_digest);
		assert.equal(section.verified, false);
		assert.equal(section.action_policy, "none");
		assert.equal(section.source_kind, "external_reference");
		assert.equal(section.compiler_version, "1.0.0");
	}
});

test("bounded sections, total content, individual content and heading depth", () => {
	const seed = compile({
		markdown: `# Root\n## Two\n### Three\n\n${"a".repeat(100)}\n\n${"b".repeat(100)}\n`,
		limits: { maxSections: 4, maxChars: 30, maxSectionChars: 12, maxDepth: 2 },
	});
	assert.equal(seed.sections.length, 4);
	assert.ok(seed.sections.every((section) => section.content.length <= 12 && section.section.length <= 2));
	assert.ok(seed.content_chars <= 30);
	assert.equal(seed.truncated, true);
	assert.throws(() => compile({ limits: { maxBytes: 999999 } }));
});

test("PHP/XML examples inside fenced code blocks survive HTML cleanup", () => {
	const seed = compile({
		markdown: [
			"# PHP bypass",
			"",
			"```php",
			"<?php",
			"eval($_POST['x']);",
			"?>",
			"```",
			"",
			"## XML",
			"",
			"```xml",
			'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///tmp/example">]>',
			"```",
			"",
		].join("\n"),
	});
	const code = seed.sections.filter((section) => section.kind === "code").map((section) => section.content);
	assert.ok(
		code.some((content) => content.includes("<?php")),
		"PHP open tag must remain in the seed",
	);
	assert.ok(
		code.some((content) => content.includes("eval($_POST['x'])")),
		"PHP source must remain intact",
	);
	assert.ok(
		code.some((content) => content.includes("<!DOCTYPE")),
		"XML declarations inside code must remain intact",
	);
});

test("HTML, scripts, multiline keys and credentials removed before clipping; refs survive", () => {
	const raw =
		"# Safe\n<script>\nsteal-secret\n</script>\n<!-- hidden -->\n<p>visible</p>\npassword=hunter2\nBearer abcdef\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\nhttps://user:pass@example.invalid/x\n";
	const seed = compile({ markdown: raw });
	const text = JSON.stringify(seed);
	for (const forbidden of [
		"steal-secret",
		"hidden",
		"hunter2",
		"abcdef",
		"private-material",
		"user:pass",
		"<p>",
		"<script>",
	])
		assert.ok(!text.includes(forbidden), forbidden);
	assert.ok(text.includes("REDACTED"));
	assert.equal(seed.sections[1].line_start, 6);
	assert.ok(seed.sections[1].content.includes("visible"));
});

test("malformed Markdown, oversized input and invalid source metadata refused", () => {
	for (const bad of ["", "\0", "```js\nunclosed", "\ud800", "<script>only unsafe</script>"])
		assert.throws(() => compile({ markdown: bad }));
	assert.throws(() => compile({ markdown: "x".repeat(262145) }));
	for (const bad of [
		{ ...source, verified: true },
		{ ...source, action_policy: "execute" },
		{ ...source, active: true },
		{ ...source, source_kind: "oracle" },
		{ ...source, approved: false },
		{ ...source, source_uri: "javascript:alert(1)" },
		{ ...source, source_uri: "https://user:pass@example.invalid/a" },
		{ ...source, source_uri: "https://example.invalid/a?token=x" },
		{ source_kind: "local_document", source_uri: "file://remote/a.md" },
	])
		assert.throws(() => compile({ source: bad }));
});

test("file input refuses invalid UTF-8, oversize, ambiguous and missing paths", async () => {
	const dir = await mkdtemp(join(tmpdir(), "aegis-doc-invalid-"));
	try {
		const path = join(dir, "input.md");
		await writeFile(path, Buffer.from([0xc3, 0x28]));
		await assert.rejects(compileDocumentSeedFile({ path }));
		const bom = Buffer.from("\ufeff# BOM\n");
		await writeFile(path, bom);
		assert.equal(
			(await compileDocumentSeedFile({ path })).source_digest,
			`sha256:${createHash("sha256").update(bom).digest("hex")}`,
		);
		await writeFile(path, "x".repeat(262145));
		await assert.rejects(compileDocumentSeedFile({ path }));
		await assert.rejects(compileDocumentSeedFile({ path: "relative.md" }));
		await assert.rejects(compileDocumentSeedFile({ path: dir }));
		const result = await loadDocumentSeed({ seedPath: join(dir, "seed.json"), documentPath: path, markdown, source });
		assert.equal(result.ok, false);
		assert.equal(result.seed, null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registry reload, source/compiler/body invalidation and atomic interrupted-write recovery", async () => {
	const dir = await mkdtemp(join(tmpdir(), "aegis-doc-registry-"));
	try {
		const documentPath = join(dir, "guide.md");
		const seedPath = join(dir, "seed.json");
		await writeFile(documentPath, markdown);
		const selection = { seedPath, documentPath };
		const writers = await Promise.all(Array.from({ length: 4 }, () => loadDocumentSeed(selection)));
		assert.ok(writers.every((result) => result.ok));
		assert.ok(writers.some((result) => result.status === "rebuilt"));
		const first = writers[0];
		assert.equal(first.seed.source_kind, "local_document");
		assert.equal(first.seed.source_uri, pathToFileURL(documentPath).href);
		assert.equal((await loadDocumentSeed(selection)).status, "loaded");
		const concurrent = await Promise.all(Array.from({ length: 4 }, () => loadDocumentSeed(selection)));
		assert.ok(concurrent.every((result) => result.ok));
		await writeFile(`${seedPath}.interrupted.tmp`, '{"partial":');
		assert.equal((await loadDocumentSeed(selection)).status, "loaded");
		await writeFile(documentPath, "# Changed\n\nNew content.\n");
		assert.equal((await loadDocumentSeed({ ...selection, rebuild: false })).seed, null);
		const changed = await loadDocumentSeed(selection);
		assert.equal(changed.status, "rebuilt");
		assert.notEqual(changed.seed.source_digest, first.seed.source_digest);
		for (const patch of [
			{ compiler_version: "old" },
			{ verified: true },
			{ action_policy: "execute" },
			{ sections: [{ content: "injected" }] },
		]) {
			await writeFile(seedPath, JSON.stringify({ ...changed.seed, ...patch }));
			assert.equal((await loadDocumentSeed({ ...selection, rebuild: false })).ok, false);
			assert.equal((await loadDocumentSeed(selection)).status, "rebuilt");
		}
		await writeFile(seedPath, "{broken");
		assert.equal((await loadDocumentSeed(selection)).status, "rebuilt");
		assert.equal(JSON.parse(await readFile(seedPath, "utf8")).verified, false);
		assert.deepEqual(
			(await readdir(dir)).filter((name) => name.endsWith(".tmp")),
			["seed.json.interrupted.tmp"],
		);
		await rm(documentPath);
		assert.equal((await loadDocumentSeed(selection)).seed, null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("explicit selection, topic bounds and RAM compatibility never promote trust", async () => {
	const dir = await mkdtemp(join(tmpdir(), "aegis-doc-select-"));
	try {
		assert.deepEqual(await selectDocumentSeeds({ selections: [] }), { references: [], unavailable: [], omitted: 0 });
		const selections = [{ seedPath: join(dir, "explicit.json"), markdown, source }];
		const selected = await selectDocumentSeeds({ selections, topic: "Example", maxSeeds: 1, maxChars: 5 });
		assert.equal(selected.references.length, 1);
		assert.equal(selected.references[0].content, "Examp");
		assert.equal(selected.omitted, 1);
		const reference = documentReferenceForRam(selected.references[0]);
		assert.equal(reference.source_kind, "external_reference");
		assert.equal(reference.verified, false);
		assert.equal(reference.action_policy, "none");
		assert.throws(() => documentReferenceForRam({ ...selected.references[0], verified: true }));
		assert.equal((await selectDocumentSeeds({ selections, topic: "unrelated" })).references.length, 0);
		await writeFile(join(dir, "blocked"), "file");
		const blocked = await loadDocumentSeed({ seedPath: join(dir, "blocked", "seed.json"), markdown, source });
		assert.equal(blocked.ok, false);
		assert.equal(blocked.seed, null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
