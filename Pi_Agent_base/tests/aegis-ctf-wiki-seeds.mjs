import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildGithubSeeds, classifyRepoPath, DEFAULTS, parseWikiArgs } from "../../build-ctf-wiki-seeds.mjs";

test("repository path classification preserves language and maps category", () => {
	assert.deepEqual(classifyRepoPath("zh/crypto/a.md"), {
		category: "crypto",
		language: "zh",
		page_path: "zh/crypto/a.md",
	});
	assert.deepEqual(classifyRepoPath("docs/zh/docs/crypto/a.md"), {
		category: "crypto",
		language: "zh",
		page_path: "docs/zh/docs/crypto/a.md",
	});
	assert.equal(classifyRepoPath("pwn/a.md").category, "pwn");
	assert.equal(classifyRepoPath("new/a.md").category, "other");
});
test("GitHub CLI defaults and bounds are explicit", () => {
	const parsed = parseWikiArgs([]);
	assert.equal(parsed.githubRepo, DEFAULTS.githubRepo);
	assert.equal(parsed.githubRef, "master");
	for (const args of [
		["--max-files", "100001"],
		["--max-repo-bytes", "2000000001"],
		["--github-repo", "https://evil.invalid/a.git"],
		["--github-ref", "../private"],
	])
		assert.throws(() => parseWikiArgs(args));
});
test("offline local git fixture compiles commit-pinned markdown and inventories image metadata", async () => {
	const temp = await mkdtemp(join(tmpdir(), "aegis-wiki-git-"));
	try {
		const repo = join(temp, "repo"),
			output = join(temp, "out");
		await mkdir(repo);
		execFileSync("git", ["init", "-b", "master", repo]);
		execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
		execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.invalid"]);
		await mkdir(join(repo, "zh", "crypto"), { recursive: true });
		await mkdir(join(repo, "images"));
		await writeFile(join(repo, "zh", "crypto", "basic.md"), "# RSA notes\n\nPublic key arithmetic reference.");
		await writeFile(join(repo, "images", "diagram.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
		execFileSync("git", ["-C", repo, "add", "."]);
		execFileSync("git", ["-C", repo, "commit", "-m", "fixture"]);
		const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		const manifest = await buildGithubSeeds({
			githubRepo: "https://github.com/ctf-wiki/ctf-wiki.git",
			githubRef: "master",
			output,
			proxy: "http://127.0.0.1:7897",
			maxFiles: 10,
			maxRepoBytes: 10000,
			maxSeedBytes: 10000,
			sourcePath: repo,
		});
		assert.equal(manifest.commit_sha, sha);
		assert.deepEqual(manifest.markdown, {
			found: 1,
			compiled: 1,
			failed: 0,
			skipped: 0,
			skipped_reasons: {},
			transformed_fences: 0,
			split_parts: 0,
		});
		assert.equal(manifest.assets.found, 1);
		assert.equal(manifest.assets.files[0].size_bytes, 7);
		assert.match(manifest.assets.files[0].sha256, /^sha256:[a-f0-9]{64}$/);
		const seedPath = (await findJson(output)).find((p) => !p.endsWith("manifest.json"));
		const seed = JSON.parse(await readFile(seedPath, "utf8"));
		assert.equal(seed.source_uri, `https://github.com/ctf-wiki/ctf-wiki/blob/${sha}/zh/crypto/basic.md`);
		assert.equal(seed.sections[0].content, "RSA notes");
		assert.equal((await readFile(join(output, "manifest.json"), "utf8")).includes("Public key arithmetic"), false);
		await assert.rejects(
			buildGithubSeeds({
				githubRepo: "https://github.com/ctf-wiki/ctf-wiki.git",
				githubRef: "master",
				output,
				sourcePath: repo,
			}),
		);
		const linked = join(temp, "linked");
		await symlink(output, linked);
		await assert.rejects(
			buildGithubSeeds({
				githubRepo: "https://github.com/ctf-wiki/ctf-wiki.git",
				githubRef: "master",
				output: linked,
				sourcePath: repo,
			}),
		);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
async function findJson(root) {
	const out = [];
	for (const e of await readdir(root, { withFileTypes: true })) {
		const p = join(root, e.name);
		if (e.isDirectory()) out.push(...(await findJson(p)));
		else if (e.name.endsWith(".json")) out.push(p);
	}
	return out;
}
