// CTF wiki -> candidate draft extractor: boundaries and determinism.
//
// The extractor must be boring and honest:
//   * it may only emit `kind: "candidate"` hypotheses, never an Experience
//   * every draft must pass the REAL proposal gate
//   * a definitional list is not a procedure
//   * provenance stays out of the proposal body (unknown fields are refused)
//   * output may not be written into source or contract directories
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extract, selfCheck } from "../../build-ctf-wiki-experience-candidates.mjs";
import { validateProposal } from "../memory/proposal.mjs";

function seed({ uri, sections }) {
	return {
		schema_version: "document-seed-1",
		source_uri: uri,
		source_kind: "external_reference",
		verified: false,
		action_policy: "none",
		source_digest: "sha256:test-digest",
		compiler_version: "1.0.0",
		sections: sections.map((section, index) => ({
			source_uri: uri,
			source_kind: "external_reference",
			verified: false,
			action_policy: "none",
			compiler_version: "1.0.0",
			line_start: index + 1,
			line_end: index + 1,
			topic: "test",
			...section,
		})),
		truncated: false,
	};
}

const TECHNIQUE = seed({
	uri: "https://example.test/technique.md",
	sections: [
		{ kind: "heading", level: 2, content: "共模攻击" },
		{ kind: "paragraph", content: "当模数相同且指数互素时，可以直接恢复明文。" },
		{ kind: "list", content: "- 计算两个指数的最大公约数\n- 利用扩展欧几里得算法求出系数\n- 组合两次密文得到明文" },
		{ kind: "paragraph", content: "最终可以得到明文。" },
	],
});

const DEFINITIONS = seed({
	uri: "https://example.test/definitions.md",
	sections: [
		{ kind: "heading", level: 2, content: "攻击模式" },
		{ kind: "paragraph", content: "当分析密码学系统时，我们会得到一些信息。" },
		{ kind: "list", content: "- 唯密文攻击：攻击者仅能获得密文\n- 选择明文攻击：攻击者可以选择明文" },
		{ kind: "paragraph", content: "最终可以得到不同的攻击模式。" },
	],
});

function writeSeeds(dir, seeds) {
	for (const [index, value] of seeds.entries()) {
		const category = index === 0 ? "crypto" : "misc";
		mkdirSync(join(dir, category), { recursive: true });
		writeFileSync(join(dir, category, `seed-${index}.json`), JSON.stringify(value), "utf8");
	}
}

test("self-check passes", () => {
	assert.equal(selfCheck(), true);
});

test("a technique block becomes one candidate; a definitional list does not", async () => {
	const root = mkdtempSync(join(tmpdir(), "aegis-wiki-cand-"));
	try {
		const input = join(root, "seeds");
		mkdirSync(input, { recursive: true });
		writeSeeds(input, [TECHNIQUE, DEFINITIONS]);

		const result = await extract({ input });
		assert.equal(result.candidates, 1, `expected exactly one candidate, got ${result.candidates}`);
		const draft = result.drafts[0];
		assert.match(draft.provenance.title, /共模攻击/);
		assert.equal(draft.proposal.kind, "candidate");
		assert.equal(draft.review_required, true);
		assert.ok(draft.proposal.when.length >= 1, "a candidate carries a precondition");
		assert.match(draft.proposal.do, /扩展欧几里得/);
		assert.ok(result.rejects.no_actionable_steps >= 1, "the definitional list was rejected as non-actionable");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("every emitted draft passes the real proposal gate", async () => {
	const root = mkdtempSync(join(tmpdir(), "aegis-wiki-gate-"));
	try {
		const input = join(root, "seeds");
		mkdirSync(input, { recursive: true });
		writeSeeds(input, [TECHNIQUE, DEFINITIONS]);
		const result = await extract({ input });
		assert.ok(result.drafts.length > 0);
		for (const draft of result.drafts) {
			const verdict = validateProposal(draft.proposal);
			assert.equal(verdict.accepted, true, `rejected draft: ${verdict.reason}`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a draft never carries the fields the runtime forbids", async () => {
	const root = mkdtempSync(join(tmpdir(), "aegis-wiki-forbidden-"));
	try {
		const input = join(root, "seeds");
		mkdirSync(input, { recursive: true });
		writeSeeds(input, [TECHNIQUE]);
		const result = await extract({ input });
		const forbidden = ["verified", "active", "status", "outcome", "success", "fact", "node_type"];
		for (const draft of result.drafts) {
			for (const field of forbidden) {
				assert.equal(Object.hasOwn(draft.proposal, field), false, `proposal must not contain ${field}`);
			}
			// Provenance is review metadata, not a proposal field.
			assert.equal(Object.hasOwn(draft.proposal, "source_uri"), false);
			assert.ok(draft.provenance.source_uri, "provenance is kept beside the proposal");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("extraction is deterministic for the same input", async () => {
	const root = mkdtempSync(join(tmpdir(), "aegis-wiki-det-"));
	try {
		const input = join(root, "seeds");
		mkdirSync(input, { recursive: true });
		writeSeeds(input, [TECHNIQUE, DEFINITIONS]);
		const first = await extract({ input });
		const second = await extract({ input });
		assert.deepEqual(first.drafts, second.drafts);
		assert.deepEqual(first.rejects, second.rejects);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a seed that marks itself uncertain is not turned into a technique", async () => {
	const root = mkdtempSync(join(tmpdir(), "aegis-wiki-uncertain-"));
	try {
		const input = join(root, "seeds");
		mkdirSync(input, { recursive: true });
		const uncertain = seed({
			uri: "https://example.test/uncertain.md",
			sections: [
				{ kind: "heading", level: 2, content: "存疑的技法" },
				{ kind: "paragraph", content: "当满足条件时，此方法未验证。" },
				{ kind: "list", content: "- 计算参数\n- 运行脚本" },
				{ kind: "paragraph", content: "可以得到结果。" },
			],
		});
		writeSeeds(input, [uncertain]);
		const result = await extract({ input });
		assert.equal(result.candidates, 0);
		assert.ok(result.rejects.source_marks_itself_uncertain >= 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the extractor never writes into source or contract directories", async () => {
	const script = readFileSync(new URL("../../build-ctf-wiki-experience-candidates.mjs", import.meta.url), "utf8");
	assert.match(script, /refusing to write drafts into source\/contract area/);
	for (const blocked of ['"Pi_Agent_base"', '"docs"']) {
		assert.ok(script.includes(blocked), `${blocked} must be in the blocked output list`);
	}
});
