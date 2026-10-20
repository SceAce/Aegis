#!/usr/bin/env node
// CTF Wiki -> initial memory, in one command, into $AEGIS_HOME.
//
//   clone wiki -> document seeds -> candidate proposals -> analysis
//
// WHAT THIS DOES NOT DO: produce active Experience. Per MEMORY_SCHEMA
// §6.2b/§6.3 a knowledge-type rule only becomes `active` after >=2
// independently resolved outcomes. The wiki is an unverified external
// reference, so the strongest thing it can yield is `candidate` proposals.
// The analysis report states this on every run so the output cannot be
// mistaken for learned competence.
//
// Layout (default $AEGIS_HOME = ~/.Aegis):
//
//   <home>/knowledge/seeds/                 document-seed-1 JSON + manifest.json
//   <home>/knowledge/candidates/            candidates.jsonl + summary.json
//   <home>/knowledge/analysis.json          the run report
//
// Everything is derived data: rebuilding is always safe, and a refresh moves
// the previous seeds aside instead of deleting them.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { extract } from "./build-ctf-wiki-experience-candidates.mjs";
import { buildGithubSeeds, DEFAULTS as SEED_DEFAULTS } from "./build-ctf-wiki-seeds.mjs";

const LANGUAGES = new Set(["zh", "zh-tw", "zh-cn", "en", "ja", "ko", "ru", "de", "fr", "es", "pt", "vi", "tr", "pl"]);

const DEFAULTS = Object.freeze({
	repo: SEED_DEFAULTS.githubRepo,
	ref: SEED_DEFAULTS.githubRef,
	proxy: SEED_DEFAULTS.proxy,
	maxCandidates: 2000,
	limit: null,
	refresh: false,
	reuseOnly: false,
	dryRun: false,
	report: false,
});

function aegisHome(override) {
	const raw = override ?? process.env.AEGIS_HOME ?? join(homedir(), ".Aegis");
	return resolve(raw);
}

function usage() {
	console.log(`Usage: node build-ctf-wiki-memory.mjs [options]

Clones the CTF Wiki, compiles document seeds, extracts candidate proposals,
and writes an analysis report inside the Aegis home.

Options:
  --home DIR         Aegis home (default $AEGIS_HOME or ~/.Aegis)
  --repo URL         wiki repository (default ${SEED_DEFAULTS.githubRepo})
  --ref REF          branch/tag/sha (default ${SEED_DEFAULTS.githubRef})
  --proxy URL        git https proxy (default ${SEED_DEFAULTS.proxy}); pass "" to disable
  --limit N          cap extracted candidates
  --max-candidates N hard cap on candidates (default ${DEFAULTS.maxCandidates})
  --refresh          rebuild seeds even when present (old dir is moved aside)
  --reuse-only       never clone; require existing seeds
  --report           print the analysis, write nothing
  --dry-run          analyse without writing candidates
  -h, --help         this help

Output:
  <home>/knowledge/seeds/         document-seed-1 JSON + manifest.json
  <home>/knowledge/candidates/    candidates.jsonl + summary.json
  <home>/knowledge/analysis.json  run report

The wiki can only produce unverified document references and candidate
hypotheses. Activation still requires >=2 independently resolved outcomes.`);
}

function parseArgs(argv) {
	const options = { ...DEFAULTS };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = () => {
			const next = argv[i + 1];
			if (next === undefined) throw new Error(`${arg} needs a value`);
			i += 1;
			return next;
		};
		switch (arg) {
			case "--home":
				options.home = value();
				break;
			case "--repo":
				options.repo = value();
				break;
			case "--ref":
				options.ref = value();
				break;
			case "--proxy":
				options.proxy = value();
				break;
			case "--limit":
				options.limit = Number(value());
				break;
			case "--max-candidates":
				options.maxCandidates = Number(value());
				break;
			case "--refresh":
				options.refresh = true;
				break;
			case "--reuse-only":
				options.reuseOnly = true;
				break;
			case "--report":
				options.report = true;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new Error(`unknown option: ${arg}`);
		}
	}
	for (const key of ["limit", "maxCandidates"]) {
		if (options[key] !== null && (!Number.isInteger(options[key]) || options[key] < 1)) {
			throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a positive integer`);
		}
	}
	if (!/^https:\/\/[^\s]+$/.test(options.repo)) throw new Error("--repo must be an https URL");
	return options;
}

const step = (message) => console.log(`\n== ${message}`);

async function walk(dir, acc = []) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return acc;
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) await walk(full, acc);
		else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json") acc.push(full);
	}
	return acc;
}

/** Count seeds by category and language, and how many were truncated. */
async function profileSeeds(seedsDir) {
	const files = await walk(seedsDir);
	const byCategory = {};
	const byLanguage = {};
	let truncated = 0;
	let read = 0;
	for (const file of files) {
		const rel = file.slice(seedsDir.length + 1).split("/");
		const category = rel[0] ?? "unknown";
		byCategory[category] = (byCategory[category] ?? 0) + 1;
		const maybeLanguage = rel[1];
		if (maybeLanguage && LANGUAGES.has(maybeLanguage.toLowerCase())) {
			byLanguage[maybeLanguage] = (byLanguage[maybeLanguage] ?? 0) + 1;
		}
		try {
			const seed = JSON.parse(await readFile(file, "utf8"));
			if (seed.truncated === true) truncated += 1;
			read += 1;
		} catch {
			/* a malformed seed is counted by the compiler manifest, not here */
		}
	}
	return { files: files.length, parsed: read, by_category: byCategory, by_language: byLanguage, truncated };
}

async function readManifest(seedsDir) {
	try {
		return JSON.parse(await readFile(join(seedsDir, "manifest.json"), "utf8"));
	} catch {
		return null;
	}
}

/** Move an existing seeds dir aside; never delete derived-but-expensive output. */
async function parkSeeds(seedsDir) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const parked = `${seedsDir}.previous-${stamp}`;
	await rename(seedsDir, parked);
	return parked;
}

function buildAnalysis({ home, seedsDir, candidatesDir, manifest, seedProfile, extraction, refreshed, parked }) {
	const byCategory = {};
	const byCategorySteps = {};
	for (const draft of extraction.drafts) {
		const category = draft.provenance.category || "unknown";
		byCategory[category] = (byCategory[category] ?? 0) + 1;
		byCategorySteps[category] = (byCategorySteps[category] ?? 0) + (draft.provenance.step_count ?? 0);
	}
	// Mechanical triage signals only; this is not a quality score.
	const ranked = [...extraction.drafts].sort((a, b) => {
		const score = (draft) => (draft.provenance.step_count ?? 0) + (draft.provenance.code_block_count ?? 0) * 2;
		return score(b) - score(a);
	});
	return {
		schema_version: "aegis-ctf-wiki-memory-1",
		generated_at: new Date().toISOString(),
		home,
		seeds_dir: seedsDir,
		candidates_dir: candidatesDir,
		seeds: {
			...seedProfile,
			commit_sha: manifest?.commit_sha ?? null,
			repository_url: manifest?.repository_url ?? null,
			ref: manifest?.ref ?? null,
			compiled: manifest?.markdown?.compiled ?? null,
			failed: manifest?.markdown?.failed ?? null,
			skipped: manifest?.markdown?.skipped ?? null,
			skipped_reasons: manifest?.markdown?.skipped_reasons ?? {},
			compiler_errors: (manifest?.errors ?? []).length,
		},
		candidates: {
			count: extraction.candidates,
			by_category: byCategory,
			steps_by_category: byCategorySteps,
			rejects: extraction.rejects,
			coverage: seedProfile.files > 0 ? Number((extraction.candidates / seedProfile.files).toFixed(4)) : 0,
		},
		triage: ranked.slice(0, 20).map((draft) => ({
			draft_id: draft.draft_id,
			title: draft.provenance.title,
			category: draft.provenance.category,
			step_count: draft.provenance.step_count ?? 0,
			code_block_count: draft.provenance.code_block_count ?? 0,
			source_uri: draft.provenance.source_uri,
			when: draft.proposal.when,
			expect: draft.proposal.expect,
		})),
		refreshed,
		parked_previous_seeds: parked,
		boundary: {
			document_seeds: "external_reference, verified=false, action_policy=none: usable as retrieval material only",
			candidates: "unverified hypotheses; activation requires >=2 independently resolved outcomes (MEMORY_SCHEMA §6.3)",
			not_produced: ["Fact", "Refuted", "active Experience", "authorization", "budget"],
		},
	};
}

function printAnalysis(analysis) {
	const { seeds, candidates, triage } = analysis;
	console.log("\n== Seeds");
	console.log(`  commit      ${seeds.commit_sha ?? "unknown"}`);
	console.log(`  files       ${seeds.files}`);
	console.log(
		`  compiled    ${seeds.compiled ?? "?"}   failed ${seeds.failed ?? "?"}   skipped ${seeds.skipped ?? "?"}`,
	);
	console.log(`  truncated   ${seeds.truncated}`);
	const categories = Object.entries(seeds.by_category).sort((a, b) => b[1] - a[1]);
	if (categories.length > 0) console.log(`  categories  ${categories.map(([k, v]) => `${k}=${v}`).join(" ")}`);

	console.log("\n== Candidates");
	console.log(`  count       ${candidates.count}   coverage ${(candidates.coverage * 100).toFixed(2)}% of seeds`);
	for (const [category, count] of Object.entries(candidates.by_category).sort((a, b) => b[1] - a[1])) {
		console.log(`    ${category.padEnd(12)} ${count}`);
	}
	const rejects = Object.entries(candidates.rejects).sort((a, b) => b[1] - a[1]);
	if (rejects.length > 0) {
		console.log("  rejected blocks");
		for (const [reason, count] of rejects) console.log(`    ${String(count).padStart(5)}  ${reason}`);
	}
	if (triage.length > 0) {
		console.log("\n== Triage (mechanical signals, not a quality score)");
		for (const item of triage.slice(0, 10)) {
			console.log(`  ${item.draft_id}  [${item.category}] ${item.title}`);
			console.log(`      steps=${item.step_count} code=${item.code_block_count}`);
			if (item.when?.[0]) console.log(`      when: ${String(item.when[0]).slice(0, 110)}`);
		}
	} else {
		console.log("\n  no candidate met the bar (steps + precondition + observable expectation).");
		console.log("  That is a valid outcome: the wiki is mostly explanation, not procedure.");
	}
	console.log("\n== Boundary");
	console.log(`  seeds      ${analysis.boundary.document_seeds}`);
	console.log(`  candidates ${analysis.boundary.candidates}`);
	console.log(`  never      ${analysis.boundary.not_produced.join(", ")}`);
}

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(String(error instanceof Error ? error.message : error));
		usage();
		process.exit(2);
	}
	if (options.help) {
		usage();
		return;
	}

	const home = aegisHome(options.home);
	const knowledgeDir = join(home, "knowledge");
	const seedsDir = join(knowledgeDir, "seeds");
	const candidatesDir = join(knowledgeDir, "candidates");

	console.log(`Aegis home : ${home}`);
	console.log(`knowledge  : ${knowledgeDir}`);

	await mkdir(knowledgeDir, { recursive: true, mode: 0o700 });

	// --- seeds -------------------------------------------------------------
	const seedsExist = existsSync(join(seedsDir, "manifest.json"));
	let manifest = null;
	let refreshed = false;
	let parked = null;

	if (seedsExist && !options.refresh) {
		step("Reusing existing document seeds");
		console.log(`  ${seedsDir}`);
		console.log("  pass --refresh to re-clone and rebuild");
		manifest = await readManifest(seedsDir);
	} else if (options.reuseOnly) {
		console.error(`--reuse-only was set but no seeds found at ${seedsDir}`);
		process.exit(1);
	} else if (options.report || options.dryRun) {
		if (!seedsExist) {
			console.error(`no seeds at ${seedsDir}; run without --report/--dry-run to clone and compile first`);
			process.exit(1);
		}
		manifest = await readManifest(seedsDir);
	} else {
		if (seedsExist) {
			parked = await parkSeeds(seedsDir);
			console.log(`  previous seeds moved to ${parked}`);
			refreshed = true;
		}
		step(`Cloning and compiling ${options.repo} (${options.ref})`);
		console.log("  this clones the wiki and writes one document seed per markdown file");
		const proxy = options.proxy && options.proxy.trim() !== "" ? options.proxy.trim() : null;
		try {
			manifest = await buildGithubSeeds({
				githubRepo: options.repo,
				githubRef: options.ref,
				output: seedsDir,
				...(proxy ? { proxy } : {}),
			});
		} catch (error) {
			console.error(`\nseed build failed: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`);
			process.exit(1);
		}
		console.log(`  compiled ${manifest.markdown.compiled} seeds from ${manifest.commit_sha?.slice(0, 12) ?? "?"}`);
		if (manifest.markdown.failed > 0) console.log(`  ${manifest.markdown.failed} files failed to compile`);
	}

	// --- candidates --------------------------------------------------------
	step("Extracting candidate proposals");
	const extraction = await extract({
		input: seedsDir,
		maxCandidates: options.limit ?? options.maxCandidates,
	});
	console.log(`  ${extraction.candidates} candidates from ${extraction.seeds_read} seeds`);

	// --- profile + analysis ------------------------------------------------
	const seedProfile = await profileSeeds(seedsDir);
	const analysis = buildAnalysis({
		home,
		seedsDir,
		candidatesDir,
		manifest,
		seedProfile,
		extraction,
		refreshed,
		parked,
	});

	printAnalysis(analysis);

	if (options.report) {
		await writeFile(join(knowledgeDir, "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`, {
			mode: 0o600,
		});
		console.log(`\nanalysis written to ${join(knowledgeDir, "analysis.json")}`);
		return;
	}
	if (options.dryRun) {
		console.log("\n--dry-run: no files written");
		return;
	}

	// --- write -------------------------------------------------------------
	await mkdir(candidatesDir, { recursive: true, mode: 0o700 });
	const jsonl = extraction.drafts.map((draft) => JSON.stringify(draft)).join("\n");
	await writeFile(join(candidatesDir, "candidates.jsonl"), extraction.drafts.length > 0 ? `${jsonl}\n` : "", {
		mode: 0o600,
	});
	await writeFile(
		join(candidatesDir, "summary.json"),
		`${JSON.stringify(
			{
				generated_at: analysis.generated_at,
				candidates: extraction.candidates,
				by_category: analysis.candidates.by_category,
				rejects: extraction.rejects,
				boundary: analysis.boundary,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
	await writeFile(join(knowledgeDir, "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`, { mode: 0o600 });

	console.log("\n== Written");
	console.log(`  ${join(knowledgeDir, "analysis.json")}`);
	console.log(`  ${join(candidatesDir, "candidates.jsonl")}`);
	console.log("\nNext: review the drafts, then submit accepted ones as `aegis_propose` candidates.");
	console.log("They stay unverified until real tasks produce >=2 independent outcomes.");
}

await main();
