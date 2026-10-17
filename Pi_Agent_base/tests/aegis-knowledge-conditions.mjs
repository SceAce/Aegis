// KNOW-01: retrieval must follow task conditions, not tool/environment words.
// The corpus is synthetic and local: no private knowledge, no per-task answer.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDocumentSeed } from "../memory/document-seed.mjs";
import { selectKnowledge } from "../memory/knowledge.mjs";

const root = await mkdtemp(join(tmpdir(), "aegis-knowledge-matrix-"));
const source = { source_kind: "external_reference", source_uri: "https://reference.invalid/", approved: true };
async function seed(rel, markdown) {
	const path = join(root, `${rel}.json`);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, JSON.stringify(compileDocumentSeed({ markdown, source })));
}
const first = (result) => result.selected[0]?.knowledge_id ?? null;
const ids = (result) => result.selected.map((item) => item.knowledge_id);

try {
	// Fixed synthetic corpus. Titles/categories carry the applicable condition;
	// one decoy section is full of workflow words but no cryptographic condition.
	await seed(
		"crypto/symptom-rsa-modulus.md",
		[
			"# Asymmetric - small modulus symptom",
			"## Handout has only n, e and c",
			"When a handout ships a single modulus n with a public exponent e and one ciphertext c,",
			"the operative condition is that the modulus factors into two primes of similar size.",
			"Recover the primes from the modulus before attempting any message arithmetic.",
		].join("\n"),
	);
	await seed(
		"crypto/technique-modular-inverse.md",
		[
			"# Asymmetric - modular inverse technique",
			"## Recover plaintext with a modular inverse",
			"The modular inverse of e modulo phi(n) gives the private exponent d.",
			"Apply modpow over the ciphertext to obtain the plaintext integer, then decode it.",
		].join("\n"),
	);
	await seed(
		"workflow/python-cli-usage.md",
		[
			"# Python CLI usage",
			"## Running a python script",
			"Run a python script from the shell, capture stdout and stderr, and install nothing.",
			"The local python command executes a short script and prints its output for inspection.",
			"A python script that fails exits non-zero; read stderr for the traceback.",
			"Use the python interpreter to write a script file and run it again.",
		].join("\n"),
	);
	await seed(
		"crypto/basics-symmetric.md",
		[
			"# Symmetric - block mode basics",
			"## Cipher block chaining with a repeated first block",
			"When two adjacent ciphertext blocks are identical the plaintext blocks differ only by the",
			"preceding block, so a controlled first block reveals the following plaintext.",
		].join("\n"),
	);
	// Traditional/simplified duplicate pair of the same guidance.
	await seed(
		"zh/injection-condition-simplified.md",
		["# 注入 - 条件观察", "## 布尔条件", "当页面根据布尔条件返回两种不同响应时，可以逐位恢复数据。"].join("\n"),
	);
	await seed(
		"zh-tw/injection-condition-traditional.md",
		["# 注入 - 條件觀察", "## 布爾條件", "當頁面根據布爾條件返回兩種不同響應時，可以逐位恢復數據。"].join("\n"),
	);

	// KNOW-01-01: a python/CLI sentence must not outrank the actual cipher condition.
	const toolQuery = "python script fails on the RSA modulus handout";
	const toolResult = await selectKnowledge({ root, query: toolQuery, maxResults: 3 });
	assert.equal(
		first(toolResult),
		"crypto/symptom-rsa-modulus.md.json#2",
		"task condition must outrank python/CLI workflow words",
	);
	assert.ok(
		!ids(toolResult).includes("workflow/python-cli-usage.md.json#2") ||
			ids(toolResult).indexOf("workflow/python-cli-usage.md.json#2") > 0,
		"workflow section must not lead a cipher-condition query",
	);

	// KNOW-01-02: an explicit technique query returns the technique section first.
	const techniqueResult = await selectKnowledge({ root, query: "modular inverse modpow plaintext", maxResults: 2 });
	assert.equal(first(techniqueResult), "crypto/technique-modular-inverse.md.json#2");

	// KNOW-01-03: an unrelated negative query is allowed to return nothing.
	const negative = await selectKnowledge({
		root,
		query: "kubernetes ingress certificate renewal schedule",
		maxResults: 3,
	});
	assert.equal(negative.status, "ready");
	assert.deepEqual(negative.selected, [], "unrelated query must be allowed zero recall");

	// KNOW-01-04: traditional/simplified duplicates collapse to one result.
	const zh = await selectKnowledge({ root, query: "布尔条件 响应", maxResults: 4 });
	const zhIds = ids(zh).filter((id) => id.startsWith("zh"));
	assert.equal(zhIds.length, 1, "equivalent multilingual duplicates must not repeat");

	// KNOW-01-05: heading/category match beats incidental body mention.
	const headingQuery = await selectKnowledge({ root, query: "symmetric block chaining", maxResults: 2 });
	assert.equal(first(headingQuery), "crypto/basics-symmetric.md.json#2");
	assert.ok(headingQuery.selected[0].section.length > 0, "matched heading/section stays visible");

	// KNOW-01-06: explicit ids still resolve and missing ids stay visible (no substitution).
	const byId = await selectKnowledge({ root, query: "", ids: ["crypto/symptom-rsa-modulus.md.json#2"], maxResults: 2 });
	assert.deepEqual(ids(byId), ["crypto/symptom-rsa-modulus.md.json#2"]);
	const missingId = await selectKnowledge({ root, query: "", ids: ["crypto/absent.md.json#9"], maxResults: 2 });
	assert.deepEqual(missingId.selected, []);
	assert.deepEqual(missingId.missing_ids, ["crypto/absent.md.json#9"]);

	// A query built purely from tool words must not force a foreign section.
	const toolOnly = await selectKnowledge({ root, query: "python stdout stderr exit code", maxResults: 3 });
	assert.ok(toolOnly.selected.length <= 1, "tool-only wording must not surface multiple unrelated reference sections");
	console.log(
		"Knowledge task-condition matrix: tool words demoted, technique/heading match, negative zero-recall, duplicate dedup, id integrity passed",
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
