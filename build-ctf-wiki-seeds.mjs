#!/usr/bin/env node
// Bounded CTF Wiki repository seed compiler.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileDocumentSeed, DOCUMENT_SEED_LIMITS } from "./Pi_Agent_base/memory/document-seed.mjs";

export const DEFAULTS = Object.freeze({
	githubRepo: "https://github.com/ctf-wiki/ctf-wiki.git",
	githubRef: "master",
	output: "knowledge/ctf-wiki",
	proxy: "http://127.0.0.1:7897",
	maxFiles: 20000,
	maxRepoBytes: 800000000,
	maxSeedBytes: 262144,
	dryRun: false,
});
const HARD = { maxFiles: 100000, maxRepoBytes: 2000000000, maxSeedBytes: DOCUMENT_SEED_LIMITS.maxBytes };
const CATEGORIES = new Set(
	"crypto web pwn reverse misc executable assembly android ics blockchain ai introduction contribute usage discussion other".split(
		" ",
	),
);
const EXCLUDED = /(?:^|\/)(?:\.git|node_modules|vendor|generated|build|dist)(?:\/|$)/i;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg|ico)$/i;
const hash = (data) => createHash("sha256").update(data).digest("hex");
function repairUnclosedFence(markdown) {
	const lines = markdown.split("\n");
	let fence = null;
	for (const line of lines) {
		const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (!fence && open) fence = { char: open[1][0], length: open[1].length };
		else if (fence && new RegExp(`^\\s{0,3}${fence.char}{${fence.length},}\\s*$`).test(line)) fence = null;
	}
	return fence
		? { markdown: `${markdown}\n${fence.char.repeat(fence.length)}\n`, transformed: "closed_eof_fence" }
		: { markdown, transformed: null };
}
/**
 * Split one markdown file into seed-sized parts.
 *
 * Two limits apply and BOTH must be respected: the byte bound below, and the
 * compiler's own section/char budget. Splitting only by bytes left 23% of the
 * corpus (`truncated: true`) with its tail silently dropped - a long chapter such
 * as web/php/php.md kept 64 of its ~130 sections, cutting everything after the
 * no-alnum trick: dynamic calls, backticks, callbacks, unserialize, PHP quirks,
 * source-backup leaks.
 *
 * The split therefore verifies itself: a chunk that still compiles to a truncated
 * seed is halved at a block boundary until every part fits. `compile` is injected
 * so the splitter uses the REAL truncation signal instead of guessing a count.
 */
function splitByLimit(blocks, maxBytes) {
	const chunks = [];
	let current = [];
	let bytes = 0;
	for (const block of blocks) {
		const size = Buffer.byteLength(block, "utf8");
		const separator = current.length > 0 ? 2 : 0;
		if (current.length > 0 && bytes + separator + size > maxBytes) {
			chunks.push(current);
			current = [block];
			bytes = size;
		} else {
			current.push(block);
			bytes += separator + size;
		}
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/**
 * For each block, record whether it STARTS inside a fenced code block and whether
 * its first line is a heading outside any fence. A cut is only safe at a block that
 * begins outside a fence and opens with a heading: `#` lines also occur *inside*
 * fences (shell comments), so a plain heading regex is not enough.
 */
function blockFenceInfo(blocks) {
	const info = [];
	let inside = false;
	for (const block of blocks) {
		const firstLine = block.split("\n").find((line) => line.trim().length > 0) ?? "";
		const isHeading = !inside && /^#{1,6}\s/.test(firstLine);
		info.push({ startsInsideFence: inside, isHeading });
		for (const line of block.split("\n")) {
			if (!/^\s*(?:`{3,}|~{3,})/.test(line)) continue;
			// A fence line toggles state, except a closing fence of a different char.
			inside = !inside;
		}
	}
	return info;
}

export function splitMarkdown(markdown, maxBytes, { compile = null } = {}) {
	if (Buffer.byteLength(markdown, "utf8") <= maxBytes && !compile) return [markdown];
	// Group blocks so a fenced code block is never split across parts: an unclosed
	// fence makes compileDocumentSeed throw, and a splitter must not manufacture
	// malformed markdown while trying to preserve content.
	const fenceOpen = (text) => (text.match(/^\s{0,3}(?:`{3,}|~{3,})/gm) ?? []).length % 2 === 1;
	const grouped = [];
	let pending = null;
	for (const block of markdown.split(/\n{2,}/)) {
		if (pending === null) {
			pending = block;
		} else {
			pending = `${pending}\n\n${block}`;
		}
		if (!fenceOpen(pending)) {
			grouped.push(pending);
			pending = null;
		}
	}
	if (pending !== null) grouped.push(pending);
	const blocks = grouped;

	const byteChunks = splitByLimit(blocks, maxBytes);
	if (typeof compile !== "function") return byteChunks.map((chunk) => chunk.join("\n\n"));

	/** True when this markdown compiles without hitting the section/char budget. */
	const fits = (text) => {
		try {
			return compile(text)?.truncated !== true;
		} catch {
			// A compile error is handled by the caller's existing fallback; treat it
			// as "fits" so the splitter does not mask it.
			return true;
		}
	};

	const out = [];
	const fenceInfo = blockFenceInfo(blocks);
	const visit = (blocks, offset = 0) => {
		const text = blocks.join("\n\n");
		if (blocks.length <= 1 || fits(text)) {
			out.push(text);
			return;
		}
		// Cut at a HEADING, never at an arbitrary block: a heading cannot appear inside
		// a fenced code block, so this keeps every part's fences balanced (an unclosed
		// fence makes the compiler throw). Scan outward from the midpoint; fall back to
		// the midpoint only when the chunk has no heading at all.
		const middle = Math.ceil(blocks.length / 2);
		let cut = middle;
		for (let offset = 0; offset < blocks.length; offset += 1) {
			for (const candidate of [middle + offset, middle - offset]) {
				if (candidate <= 0 || candidate >= blocks.length) continue;
				const info = fenceInfo[offset + candidate];
				if (info.isHeading && !info.startsInsideFence) {
					cut = candidate;
					offset = blocks.length;
					break;
				}
			}
		}
		visit(blocks.slice(0, cut), offset);
		visit(blocks.slice(cut), offset + cut);
	};
	for (const chunk of byteChunks) visit(chunk);
	return out;
}

export function classifyRepoPath(path) {
	const original = path;
	const parts = path.split("/");
	if (parts[0] === "docs") parts.shift();
	const lang = /^(?:zh(?:-[A-Za-z]+)?|en|[a-z]{2})$/i.test(parts[0] ?? "") ? parts.shift() : null;
	if (parts[0] === "docs") parts.shift();
	const first = (parts[0] || "other").toLowerCase();
	return { category: CATEGORIES.has(first) ? first : "other", language: lang, page_path: original };
}
export function parseWikiArgs(args) {
	const options = { ...DEFAULTS };
	const keys = {
		"--github-repo": "githubRepo",
		"--github-ref": "githubRef",
		"--github-output": "output",
		"--output": "output",
		"--proxy": "proxy",
		"--max-files": "maxFiles",
		"--max-repo-bytes": "maxRepoBytes",
		"--max-seed-bytes": "maxSeedBytes",
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (a === "--help") {
			options.help = true;
			continue;
		}
		const key = keys[a];
		if (!key || !args[i + 1] || args[i + 1].startsWith("--"))
			throw Error("unknown option or missing value; use --help");
		const value = args[++i];
		options[key] = key.startsWith("max") ? Number(value) : value;
	}
	if (!/^https:\/\/github\.com\/ctf-wiki\/ctf-wiki(?:\.git)?$/.test(options.githubRepo))
		throw Error("github repository must be the official HTTPS CTF Wiki repository");
	if (
		!/^[A-Za-z0-9._/-]{1,128}$/.test(options.githubRef) ||
		options.githubRef.includes("..") ||
		options.githubRef.startsWith("-") ||
		options.githubRef.includes("//")
	)
		throw Error("invalid Git ref");
	for (const key of Object.keys(HARD))
		if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > HARD[key])
			throw Error(`invalid bound: ${key}`);
	const proxy = new URL(options.proxy);
	if (
		!/^https?:$/.test(proxy.protocol) ||
		proxy.username ||
		proxy.password ||
		proxy.search ||
		proxy.hash ||
		proxy.pathname !== "/"
	)
		throw Error("proxy must be HTTP(S) without credentials or path");
	options.output = resolve(options.output);
	return options;
}
function run(command, args, env = process.env) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
		let out = "",
			err = "";
		child.stdout.on("data", (b) => {
			if (out.length < 10000000) out += b.toString();
		});
		child.stderr.on("data", (b) => {
			if (err.length < 4096) err += b.toString();
		});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0 ? resolveRun(out.trim()) : reject(Error(`${command} exited ${code}: ${err.slice(-1000)}`)),
		);
	});
}
async function assertAbsentOutput(path) {
	try {
		const output = await lstat(path);
		if (output.isSymbolicLink() || !output.isDirectory()) throw Error("output contains symlink or non-directory");
		throw Error("output already exists; refusing stale or unrelated output");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	// Validate the immediate parent through the filesystem's real path. System
	// ancestors such as macOS /var may themselves be symlinks; they are outside
	// the caller-owned output and are not treated as an output escape.
	const parent = dirname(path);
	const parentInfo = await lstat(parent);
	if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw Error("output parent is not a real directory");
}
async function writeFailureManifest(output, manifest) {
	await mkdir(dirname(output), { recursive: true });
	await mkdir(output);
	const p = join(output, "manifest.json");
	await writeFile(p, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
async function filesUnder(root, paths) {
	const list = [];
	for (const relative of paths) {
		if (EXCLUDED.test(relative) || relative.split("/").some((x) => x === "." || x === "..")) continue;
		const full = join(root, ...relative.split("/"));
		const info = await lstat(full);
		if (info.isSymbolicLink() || !info.isFile()) continue;
		list.push({ relative, full, size: info.size });
	}
	return list;
}
export async function buildGithubSeeds(input = {}) {
	const options = { ...DEFAULTS, ...input, output: resolve(input.output ?? DEFAULTS.output) };
	for (const key of Object.keys(HARD))
		if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > HARD[key])
			throw Error(`invalid bound: ${key}`);
	const manifest = {
		schema_version: "ctf-wiki-github-seeds-1",
		repository_url: options.githubRepo,
		ref: options.githubRef,
		commit_sha: null,
		generated_at: new Date().toISOString(),
		compiler: "document-seed-1",
		bounds: { max_files: options.maxFiles, max_repo_bytes: options.maxRepoBytes, max_seed_bytes: options.maxSeedBytes },
		markdown: {
			found: 0,
			compiled: 0,
			failed: 0,
			skipped: 0,
			skipped_reasons: {},
			transformed_fences: 0,
			split_parts: 0,
		},
		assets: { found: 0, bytes: 0, files: [] },
		errors: [],
	};
	const parent = join(tmpdir(), "aegis-ctf-wiki-");
	await mkdir(parent, { recursive: true });
	const work = await mkdtemp(join(parent, "repo-"));
	let staging = null;
	try {
		const env = {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_LFS_SKIP_SMUDGE: "1",
			HTTPS_PROXY: options.proxy,
			https_proxy: options.proxy,
			HTTP_PROXY: options.proxy,
			http_proxy: options.proxy,
			NO_PROXY: "",
			no_proxy: "",
		};
		const cloneSource = options.sourcePath ?? options.githubRepo;
		await run(
			"git",
			[
				"-c",
				"credential.helper=",
				"-c",
				"core.askPass=",
				"clone",
				"--depth",
				"1",
				"--single-branch",
				"--branch",
				options.githubRef,
				"--filter=blob:none",
				cloneSource,
				join(work, "repo"),
			],
			env,
		);
		const repo = join(work, "repo");
		manifest.commit_sha = await run("git", ["-C", repo, "rev-parse", "HEAD"], env);
		const names = (await run("git", ["-C", repo, "ls-tree", "-r", "--name-only", "-z", "HEAD"], env))
			.split("\0")
			.filter(Boolean);
		if (names.length > options.maxFiles)
			throw Error(`tracked file count ${names.length} exceeds max-files ${options.maxFiles}`);
		const blobs = (await run("git", ["-C", repo, "ls-tree", "-r", "-l", "-z", "HEAD"], env))
			.split("\0")
			.filter(Boolean);
		let total = 0;
		for (const row of blobs) {
			const size = Number(row.split("\t")[0].trim().split(/\s+/).at(-1));
			if (Number.isFinite(size)) total += size;
		}
		if (total > options.maxRepoBytes)
			throw Error(`repository blob bytes ${total} exceeds max-repo-bytes ${options.maxRepoBytes}`);
		await run("git", ["-C", repo, "checkout", "--detach", manifest.commit_sha], env);
		const tracked = await filesUnder(repo, names);
		const md = tracked.filter((f) => /\.md$/i.test(f.relative));
		manifest.markdown.found = md.length;
		const assets = tracked.filter((f) => IMAGE_EXT.test(f.relative));
		manifest.assets.found = assets.length;
		for (const file of assets) {
			const bytes = await readFile(file.full);
			manifest.assets.bytes += bytes.length;
			manifest.assets.files.push({
				path: file.relative,
				sha256: `sha256:${hash(bytes)}`,
				size_bytes: bytes.length,
				reference: file.relative,
			});
		}
		await assertAbsentOutput(options.output);
		const outputParent = join(options.output, "..");
		await mkdir(outputParent, { recursive: true });
		staging = await mkdtemp(join(outputParent, ".ctf-wiki-stage-"));
		for (const file of md) {
			const rel = file.relative;
			try {
				if (file.size === 0) {
					manifest.markdown.skipped++;
					manifest.markdown.skipped_reasons.empty_markdown =
						(manifest.markdown.skipped_reasons.empty_markdown ?? 0) + 1;
					continue;
				}
				const rawMarkdown = await readFile(file.full, "utf8");
				const repaired = repairUnclosedFence(rawMarkdown);
				const parts = splitMarkdown(repaired.markdown, options.maxSeedBytes, {
					compile: (text) =>
						compileDocumentSeed({
							markdown: text,
							source: { source_uri: sourceUri, source_kind: "external_reference", approved: true },
							generatedAt: manifest.generated_at,
						}),
				});
				if (repaired.transformed) manifest.markdown.transformed_fences++;
				if (parts.length > 1) manifest.markdown.split_parts += parts.length;
				const sourceUri = `https://github.com/ctf-wiki/ctf-wiki/blob/${manifest.commit_sha}/${rel.split("/").map(encodeURIComponent).join("/")}`;
				const cls = classifyRepoPath(rel);
				for (const [partIndex, markdown] of parts.entries()) {
					let sourceTransform = repaired.transformed;
					let compileInput = markdown;
					let seed;
					try {
						seed = compileDocumentSeed({
							markdown: compileInput,
							source: { source_uri: sourceUri, source_kind: "external_reference", approved: true },
							generatedAt: manifest.generated_at,
						});
					} catch (error) {
						if (!String(error?.message).includes("unclosed Markdown code fence")) throw error;
						compileInput = markdown.replace(/^\s*(`{3,}|~{3,}).*$/gm, "");
						sourceTransform = "normalized_fence_markers";
						seed = compileDocumentSeed({
							markdown: compileInput,
							source: { source_uri: sourceUri, source_kind: "external_reference", approved: true },
							generatedAt: manifest.generated_at,
						});
					}
					seed.provenance = {
						...seed.provenance,
						source_transform: sourceTransform,
						source_path: rel,
						part_index: partIndex,
						part_count: parts.length,
					};
					const target = join(
						staging,
						cls.category,
						...(cls.language ? [cls.language] : []),
						`${rel.replace(/[^A-Za-z0-9._/-]/g, "-").replaceAll("/", "__")}-part${partIndex + 1}of${parts.length}-${hash(`${rel}:${partIndex}`).slice(0, 16)}.json`,
					);
					await mkdir(join(target, ".."), { recursive: true });
					await writeFile(target, `${JSON.stringify(seed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
					manifest.markdown.compiled++;
				}
			} catch (error) {
				manifest.markdown.failed++;
				manifest.errors.push({ path: rel, error: String(error.message).slice(0, 500) });
			}
		}
		await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		await mkdir(join(options.output, ".."), { recursive: true });
		await rename(staging, options.output);
		staging = null;
		return manifest;
	} catch (error) {
		manifest.errors.push({ error: String(error.message).slice(0, 1000) });
		try {
			await writeFailureManifest(options.output, manifest);
		} catch (writeError) {
			manifest.errors.push({ manifest_error: String(writeError.message).slice(0, 500) });
		}
		throw Object.assign(error, { manifest });
	} finally {
		if (staging) await rm(staging, { recursive: true, force: true });
		await rm(work, { recursive: true, force: true });
	}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseWikiArgs(process.argv.slice(2));
		if (options.help)
			console.log(
				"Usage: node build-ctf-wiki-seeds.mjs [--github-repo URL] [--github-ref master] [--github-output DIR] [--proxy URL] [--max-files N] [--max-repo-bytes N] [--max-seed-bytes N]",
			);
		else {
			const manifest = await buildGithubSeeds(options);
			console.log(
				JSON.stringify({
					commit_sha: manifest.commit_sha,
					markdown: manifest.markdown,
					assets: manifest.assets.found,
					errors: manifest.errors.length,
				}),
			);
			if (manifest.markdown.failed || manifest.errors.length) process.exitCode = 1;
		}
	} catch (error) {
		console.error(`CTF Wiki GitHub build failed: ${String(error.message).slice(0, 1000)}`);
		process.exitCode = 1;
	}
}
