// Seed splitting must not silently drop a document's tail.
//
// Regression origin: web/php/php.md compiled to exactly 64 sections with
// `truncated: true` - the compiler's cap - so everything after the no-alnum
// webshell trick was dropped: dynamic calls, backticks, callbacks, unserialize,
// PHP quirks and source-backup leaks. The model then re-derived `unserialize` by
// hand mid-session. 177 of 770 seeds (23%) were truncated this way.
//
// splitMarkdown only split by BYTES (256 KB), which most pages never reach, so the
// section cap was never relieved. It now verifies its own output with the real
// compiler and cuts only where it is safe.
import assert from "node:assert/strict";
import test from "node:test";
import { splitMarkdown } from "../../build-ctf-wiki-seeds.mjs";
import { compileDocumentSeed } from "../memory/document-seed.mjs";

const SOURCE = { source_uri: "https://example.test/page.md", source_kind: "external_reference", approved: true };
const compile = (text) => compileDocumentSeed({ markdown: text, source: SOURCE });

/** A page with `count` headings, each followed by a paragraph and a fence. */
function page(count) {
	const parts = ["# Chapter"];
	for (let i = 0; i < count; i += 1) {
		parts.push(`## Section ${i}`, `Body of section ${i}.`, "```shell", `echo ${i}`, "```");
	}
	return parts.join("\n\n");
}

test("a long page is split so no part hits the section cap", () => {
	const markdown = page(120);
	const single = compile(markdown);
	assert.equal(single.truncated, true, "one part would truncate: this is the bug being fixed");

	const parts = splitMarkdown(markdown, 262144, { compile });
	assert.ok(parts.length > 1, `expected multiple parts, got ${parts.length}`);

	let sections = 0;
	for (const [index, part] of parts.entries()) {
		const seed = compile(part);
		assert.equal(seed.truncated, false, `part ${index + 1} must not truncate`);
		sections += seed.sections.length;
	}
	// Nothing was lost: every heading survives across the parts.
	for (let i = 0; i < 120; i += 1) {
		const found = parts.some((part) => part.includes(`## Section ${i}`));
		assert.equal(found, true, `section ${i} must survive the split`);
	}
	assert.ok(sections > single.sections.length, "the split preserves more than the truncated single part");
});

test("a page that already fits is returned unchanged", () => {
	const markdown = page(3);
	const parts = splitMarkdown(markdown, 262144, { compile });
	assert.equal(parts.length, 1);
	assert.equal(parts[0], markdown);
});

test("splits land on headings, so fenced code is never cut in half", () => {
	const markdown = page(80);
	const parts = splitMarkdown(markdown, 262144, { compile });
	for (const [index, part] of parts.entries()) {
		// Every part compiles: an unclosed fence would throw.
		assert.doesNotThrow(() => compile(part), `part ${index + 1} has balanced fences`);
		const fences = (part.match(/^\s*(?:`{3,}|~{3,})/gm) ?? []).length;
		assert.equal(fences % 2, 0, `part ${index + 1} has an even number of fence lines`);
	}
});

test("a '#' line inside a fence is not treated as a cut point", () => {
	// Shell comments look like markdown headings. A cut there would split a fence.
	const blocks = ["# Page"];
	for (let i = 0; i < 60; i += 1) {
		blocks.push(`## Real ${i}`, "```shell", "# this is a shell comment, not a heading", `echo ${i}`, "```");
	}
	const markdown = blocks.join("\n\n");
	const parts = splitMarkdown(markdown, 262144, { compile });
	for (const [index, part] of parts.entries()) {
		const fences = (part.match(/^\s*(?:`{3,}|~{3,})/gm) ?? []).length;
		assert.equal(fences % 2, 0, `part ${index + 1} stayed fence-balanced`);
		assert.doesNotThrow(() => compile(part));
	}
});

test("without a compile probe the byte split still applies", () => {
	const markdown = `${"x".repeat(500)}\n\n${"y".repeat(500)}`;
	const parts = splitMarkdown(markdown, 600);
	assert.equal(parts.length, 2);
	assert.equal(parts.join("\n\n"), markdown);
});
