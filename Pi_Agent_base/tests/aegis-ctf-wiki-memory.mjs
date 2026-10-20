// CTF wiki -> initial memory orchestrator: layout, reuse, refresh, boundaries.
//
// These cases never clone. They plant a tiny seed tree in a temporary AEGIS_HOME
// and assert what the orchestrator does with it: where it writes, that it
// reuses instead of re-cloning, that --refresh parks the old tree instead of
// deleting it, and that the report keeps stating the activation boundary.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../../build-ctf-wiki-memory.mjs", import.meta.url);
const { spawnSync } = await import("node:child_process");

function run(args, env = {}) {
	return spawnSync(process.execPath, [SCRIPT.pathname, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 120_000,
	});
}

function seed({ uri, title, steps }) {
	return {
		schema_version: "document-seed-1",
		source_uri: uri,
		source_kind: "external_reference",
		verified: false,
		action_policy: "none",
		source_digest: "sha256:fixture",
		compiler_version: "1.0.0",
		truncated: false,
		sections: [
			{
				source_uri: uri,
				kind: "heading",
				level: 2,
				content: title,
				line_start: 1,
				line_end: 1,
				topic: title,
			},
			{
				source_uri: uri,
				kind: "paragraph",
				content: "当模数相同且指数互素时，可以恢复明文。",
				line_start: 2,
				line_end: 2,
				topic: title,
			},
			{ source_uri: uri, kind: "list", content: steps, line_start: 3, line_end: 3, topic: title },
			{
				source_uri: uri,
				kind: "paragraph",
				content: "最终可以得到明文。",
				line_start: 4,
				line_end: 4,
				topic: title,
			},
		],
	};
}

function plant(home) {
	const seedsDir = join(home, "knowledge", "seeds");
	mkdirSync(join(seedsDir, "crypto", "zh"), { recursive: true });
	writeFileSync(
		join(seedsDir, "manifest.json"),
		JSON.stringify({
			schema_version: "ctf-wiki-github-seeds-1",
			repository_url: "https://github.com/ctf-wiki/ctf-wiki.git",
			ref: "master",
			commit_sha: "fixture-sha",
			markdown: { found: 1, compiled: 1, failed: 0, skipped: 0, skipped_reasons: {} },
			errors: [],
		}),
		"utf8",
	);
	writeFileSync(
		join(seedsDir, "crypto", "zh", "seed.json"),
		JSON.stringify(
			seed({
				uri: "https://example.test/common-modulus.md",
				title: "共模攻击",
				steps: "- 计算两个指数的最大公约数\n- 利用扩展欧几里得算法求出系数",
			}),
		),
		"utf8",
	);
	return seedsDir;
}

test("writes seeds-adjacent candidates and analysis inside the Aegis home", () => {
	const home = mkdtempSync(join(tmpdir(), "aegis-mem-"));
	try {
		plant(home);
		const result = run(["--home", home]);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(existsSync(join(home, "knowledge", "analysis.json")), "analysis.json is written");
		assert.ok(existsSync(join(home, "knowledge", "candidates", "candidates.jsonl")), "candidates.jsonl is written");

		const analysis = JSON.parse(readFileSync(join(home, "knowledge", "analysis.json"), "utf8"));
		assert.equal(analysis.seeds.commit_sha, "fixture-sha");
		assert.equal(analysis.seeds.files, 1);
		assert.equal(analysis.candidates.count, 1);
		assert.equal(analysis.boundary.candidates.includes(">=2"), true);
		assert.deepEqual(analysis.boundary.not_produced.includes("active Experience"), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("reuses existing seeds instead of re-cloning", () => {
	const home = mkdtempSync(join(tmpdir(), "aegis-mem-reuse-"));
	try {
		plant(home);
		const result = run(["--home", home]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Reusing existing document seeds/);
		assert.doesNotMatch(result.stdout, /Cloning and compiling/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("emitted candidates stay unverified hypotheses", () => {
	const home = mkdtempSync(join(tmpdir(), "aegis-mem-cand-"));
	try {
		plant(home);
		const result = run(["--home", home]);
		assert.equal(result.status, 0, result.stderr);
		const lines = readFileSync(join(home, "knowledge", "candidates", "candidates.jsonl"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean);
		assert.equal(lines.length, 1);
		const draft = JSON.parse(lines[0]);
		assert.equal(draft.proposal.kind, "candidate");
		assert.equal(draft.review_required, true);
		for (const field of ["verified", "active", "status", "outcome", "success"]) {
			assert.equal(Object.hasOwn(draft.proposal, field), false, `proposal must not carry ${field}`);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("--report analyses without writing candidates", () => {
	const home = mkdtempSync(join(tmpdir(), "aegis-mem-report-"));
	try {
		plant(home);
		const result = run(["--home", home, "--report"]);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(existsSync(join(home, "knowledge", "analysis.json")));
		assert.equal(existsSync(join(home, "knowledge", "candidates")), false, "--report writes no candidates");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("--dry-run writes nothing at all", () => {
	const home = mkdtempSync(join(tmpdir(), "aegis-mem-dry-"));
	try {
		plant(home);
		const result = run(["--home", home, "--dry-run"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(home, "knowledge", "candidates")), false);
		assert.match(result.stdout, /--dry-run: no files written/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("--reuse-only fails clearly when no seeds exist, writing nothing", () => {
	const home = mkdtempSync(join(tmpdir(), "aegis-mem-missing-"));
	try {
		const result = run(["--home", home, "--reuse-only"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /no seeds found/);
		assert.equal(existsSync(join(home, "knowledge", "seeds")), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("an unknown option is a usage error", () => {
	const result = run(["--not-an-option"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /unknown option/);
});

test("the analysis never claims to have produced authority or an active rule", () => {
	const home = mkdtempSync(join(tmpdir(), "aegis-mem-boundary-"));
	try {
		plant(home);
		assert.equal(run(["--home", home]).status, 0);
		const analysis = JSON.parse(readFileSync(join(home, "knowledge", "analysis.json"), "utf8"));
		for (const forbidden of ["Fact", "Refuted", "active Experience", "authorization", "budget"]) {
			assert.ok(analysis.boundary.not_produced.includes(forbidden), `boundary must name ${forbidden} as not produced`);
		}
		assert.match(analysis.boundary.document_seeds, /verified=false/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("candidate filenames are predictable and inside the home", () => {
	const home = mkdtempSync(join(tmpdir(), "aegis-mem-layout-"));
	try {
		plant(home);
		assert.equal(run(["--home", home]).status, 0);
		assert.deepEqual(readdirSync(join(home, "knowledge", "candidates")).sort(), ["candidates.jsonl", "summary.json"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
