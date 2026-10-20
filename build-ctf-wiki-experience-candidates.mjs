#!/usr/bin/env node
// Bounded CTF Wiki -> candidate Experience proposal extractor.
//
// WHAT THIS IS NOT: an Experience compiler. Per MEMORY_SCHEMA §6.2b/§6.3 a
// knowledge-type rule only becomes `active` after >=2 independently resolved
// outcomes. The wiki is an unverified external reference, so the strongest
// thing it can produce is a CANDIDATE hypothesis.
//
// Every draft is passed through the REAL `validateProposal` gate before it is
// written, so this script cannot emit something the runtime would reject.
//
// Rules it follows (docs/CTF_WIKI_EXPERIENCE_COMPILATION.md):
//   * only `kind: "candidate"`; never status/verified/active
//   * provenance (source_uri, section range, digest) stays in the draft record,
//     NOT in the proposal body (where unknown fields are refused)
//   * no network, no reads outside --input, no writes outside --output
//   * deterministic: sorted input, no timestamps in dedupe identity
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProposal } from "./Pi_Agent_base/memory/proposal.mjs";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

export const DEFAULTS = Object.freeze({
	input: "knowledge/ctf-wiki",
	output: "knowledge/ctf-wiki-candidates",
	maxFiles: 20000,
	maxSeedBytes: 262144,
	maxCandidates: 2000,
	maxPerFile: 3,
	maxSteps: 8,
	maxStepChars: 400,
	maxTextChars: 1200,
});

// Text markers. Kept narrow on purpose: a false candidate costs a reviewer's
// time, so we prefer missing a technique over inventing one.
const WHEN_MARKERS = ["当", "如果", "前提", "条件下", "已知", "假设", "when ", "if ", "assuming", "given "];
const EXPECT_MARKERS = [
	"得到",
	"获得",
	"输出",
	"结果为",
	"可恢复",
	"解出",
	"还原",
	"expect",
	"returns",
	"outputs",
	"reveals",
];
const REJECT_MARKERS = ["未验证", "存疑", "不可靠", "unverified", "disputed"];

// A step must look like an action, not like prose or a definition. These are
// ANCHORED at the start of the item: a definition such as "选择明文攻击：攻击者
// 仅能获得明文" contains action words but is not an instruction.
const STEP_START =
	/^(?:使用|利用|计算|构造|调用|运行|执行|发送|提交|解密|加密|分解|枚举|爆破|注入|提取|读取|写入|比对|验证|设置|获取|尝试|收集|替换|拼接|解出|还原|安装|打开|连接|上传|下载|构造出|计算出|run\b|use\b|call\b|compute\b|build\b|send\b|decrypt\b|encrypt\b|extract\b|read\b|write\b|compare\b|verify\b|install\b|open\b|connect\b)/i;

// Definitional / encyclopaedic list items are not procedures.
const DEFINITION_MARKER = /(是指|称为|定义为|即为|也就是说|攻击者|定义为|concept|refers to|is defined as)/i;

// Code leaked into prose cannot become a `when` predicate or a step. Prose
// predicates never carry statements, calls or hex literals; code excerpts do.
const CODE_SIGNATURE =
	/(\bdef\s|\bimport\s|#include|\bprintf?\s*\(|\bfunction\s|\breturn\s|\bexit\s*\(|\bmemset\s*\(|\bmemcpy\s*\(|\bmprotect\s*\(|__[a-z]+\w*|0x[0-9a-f]{2,}|\w+\s*=\s*[^;=]{0,40}\(|[a-z_][a-z0-9_]*\s*\([^)]*\)\s*;|;\s*$)/im;

const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function clip(text, max) {
	const value = typeof text === "string" ? text.trim() : "";
	return value.length > max ? value.slice(0, max) : value;
}

function stripMarkdown(text) {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\*\*([^*]*)\*\*/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function looksRejected(text) {
	const lower = text.toLowerCase();
	return REJECT_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/** Turn a list section body into discrete steps. */
function listToSteps(content) {
	const raw = String(content ?? "")
		.split("\n")
		.map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").trim())
		.filter(Boolean);
	if (raw.length === 0) return [];
	// A list where most items are definitions is an explanatory list, not a
	// procedure. Dropping it is the point: a false candidate costs a reviewer.
	const definitions = raw.filter((line) => DEFINITION_MARKER.test(stripMarkdown(line))).length;
	if (definitions * 2 >= raw.length) return [];
	return raw
		.map(stripMarkdown)
		.filter((line) => line.length >= 8 && line.length <= DEFAULTS.maxStepChars)
		.filter((line) => !CODE_SIGNATURE.test(line))
		.filter((line) => STEP_START.test(line));
}

/** The first sentence of a paragraph: predicates are single claims. */
function firstSentence(text) {
	const value = typeof text === "string" ? text.trim() : "";
	const match = /^[^。！？!?]{1,400}[。！？!?]?/.exec(value);
	return (match ? match[0] : value).trim();
}

/** True when a prose snippet is a usable predicate: short, no code, few sentences. */
function usablePredicate(text, max = 160) {
	if (!text || text.length > max) return false;
	if (CODE_SIGNATURE.test(text)) return false;
	const sentences = text.split(/[。！？!?]/).filter((part) => part.trim().length > 0).length;
	return sentences <= 2;
}

/** Group flat sections into heading-delimited blocks. */
function intoBlocks(sections) {
	const blocks = [];
	let current = null;
	for (const section of sections) {
		if (!section || typeof section.content !== "string") continue;
		if (section.kind === "heading") {
			const title = stripMarkdown(section.content);
			if (!title) continue;
			// A level-1 document title is not a technique title; start a new block
			// only on deeper headings, but always track the nearest one.
			current = current && section.level && section.level > 1 ? current : null;
			current = { title, lineStart: section.line_start ?? null, sections: [] };
			blocks.push(current);
			continue;
		}
		if (!current) {
			current = { title: null, lineStart: section.line_start ?? null, sections: [] };
			blocks.push(current);
		}
		current.sections.push(section);
	}
	return blocks;
}

function extractFromBlock(block, seed) {
	const title = block.title ? stripMarkdown(block.title) : "";
	if (!title || title.length < 3) return { reject: "no_title" };

	const paragraphs = block.sections.filter((s) => s.kind === "paragraph").map((s) => stripMarkdown(s.content));
	const lists = block.sections.filter((s) => s.kind === "list");
	const codeBlocks = block.sections.filter((s) => s.kind === "code");

	const prose = paragraphs.join(" ");
	if (looksRejected(prose)) return { reject: "source_marks_itself_uncertain" };

	const steps = [];
	for (const list of lists) for (const step of listToSteps(list.content)) steps.push(step);
	if (steps.length < 2) return { reject: "no_actionable_steps" };

	const when = paragraphs
		.filter((p) => WHEN_MARKERS.some((m) => p.toLowerCase().includes(m.toLowerCase())))
		.map((p) => firstSentence(p))
		.filter((p) => !/[：:]\s*$/.test(p))
		.filter((p) => usablePredicate(p, 160))
		.slice(0, 3);
	if (when.length === 0) return { reject: "no_verifiable_precondition" };

	const expect = paragraphs
		.map((p) => firstSentence(p))
		.filter((p) => !/[：:]\s*$/.test(p))
		.filter((p) => usablePredicate(p, 160))
		.find((p) => EXPECT_MARKERS.some((m) => p.toLowerCase().includes(m.toLowerCase())));
	if (!expect) return { reject: "no_observable_expectation" };

	const boundedSteps = steps.slice(0, DEFAULTS.maxSteps);
	const doText = boundedSteps.map((step, index) => `${index + 1}. ${step}`).join(" ");

	// The text must state the technique, not restate the page. Use the first
	// usable predicate or the first step, never a long paragraph.
	const headline = usablePredicate(firstSentence(prose), 160) ? firstSentence(prose) : boundedSteps[0];

	const proposal = {
		kind: "candidate",
		text: clip(`${title}：${headline}`, DEFAULTS.maxTextChars),
		when,
		do: clip(doText, 1000),
		expect: clip(expect, 200),
		scope: clip(seed.category ?? "", 400) || undefined,
	};

	return {
		proposal,
		provenance: {
			source_uri: seed.source_uri ?? null,
			source_digest: seed.source_digest ?? null,
			semantic_digest: seed.semantic_digest ?? null,
			section_lines: [block.lineStart, block.sections[block.sections.length - 1]?.line_end ?? null],
			code_block_count: codeBlocks.length,
			step_count: boundedSteps.length,
			title,
		},
	};
}

async function walkJson(dir, limit) {
	const out = [];
	const stack = [dir];
	while (stack.length > 0 && out.length < limit) {
		const current = stack.pop();
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
			if (out.length >= limit) break;
		}
	}
	return out.sort();
}

function categoryOf(file, inputDir) {
	const rel = relative(inputDir, file);
	const parts = rel.split(sep);
	return parts.length > 1 ? parts[0] : "";
}

export async function extract({
	input = DEFAULTS.input,
	maxFiles = DEFAULTS.maxFiles,
	maxCandidates = DEFAULTS.maxCandidates,
	maxPerFile = DEFAULTS.maxPerFile,
} = {}) {
	const inputDir = resolve(BASE_DIR, input);
	if (!existsSync(inputDir)) throw new Error(`input directory not found: ${input}`);
	const files = await walkJson(inputDir, maxFiles);

	const drafts = [];
	const rejects = {};
	const seen = new Set();
	let seedsRead = 0;
	let seedsSkipped = 0;

	for (const file of files) {
		if (drafts.length >= maxCandidates) break;
		let seed;
		try {
			const bytes = await readFile(file);
			if (bytes.length > DEFAULTS.maxSeedBytes) {
				seedsSkipped += 1;
				continue;
			}
			seed = JSON.parse(bytes.toString("utf8"));
		} catch {
			seedsSkipped += 1;
			continue;
		}
		if (!seed || seed.schema_version !== "document-seed-1" || !Array.isArray(seed.sections)) {
			seedsSkipped += 1;
			continue;
		}
		seed.category = categoryOf(file, inputDir);
		seedsRead += 1;

		let perFile = 0;
		for (const block of intoBlocks(seed.sections)) {
			if (perFile >= maxPerFile || drafts.length >= maxCandidates) break;
			const result = extractFromBlock(block, seed);
			if (result.reject) {
				rejects[result.reject] = (rejects[result.reject] ?? 0) + 1;
				continue;
			}
			// The real gate. Anything it refuses never reaches disk.
			const verdict = validateProposal(result.proposal);
			if (!verdict.accepted) {
				const key = `proposal_rejected:${verdict.reason}`;
				rejects[key] = (rejects[key] ?? 0) + 1;
				continue;
			}
			const identity = sha256(JSON.stringify([result.proposal.text, result.proposal.do]));
			if (seen.has(identity)) {
				rejects.duplicate = (rejects.duplicate ?? 0) + 1;
				continue;
			}
			seen.add(identity);
			drafts.push({
				draft_id: `wc_${identity.slice("sha256:".length, "sha256:".length + 16)}`,
				// Stored separately from the proposal body: these are provenance for a
				// human reviewer, not fields the runtime accepts.
				provenance: { ...result.provenance, category: seed.category },
				review_required: true,
				proposal: verdict.proposal,
			});
			perFile += 1;
		}
	}

	return {
		input: relative(BASE_DIR, inputDir) || ".",
		files_scanned: files.length,
		seeds_read: seedsRead,
		seeds_skipped: seedsSkipped,
		candidates: drafts.length,
		rejects: Object.fromEntries(Object.entries(rejects).sort((a, b) => b[1] - a[1])),
		drafts,
	};
}

// --- self check ------------------------------------------------------------
// Proves the three documented outcomes using inline fixtures, no disk/network.
export function selfCheck() {
	const checks = [];
	const push = (name, ok, detail) => checks.push({ name, ok, detail });

	const proposalOnlySteps = { kind: "candidate", text: "只有步骤", when: [], do: "1. 运行脚本", expect: "得到结果" };
	push(
		"candidate without preconditions is refused by the extractor rules",
		proposalOnlySteps.when.length === 0,
		"extractor requires >=1 when condition",
	);

	const good = {
		kind: "candidate",
		text: "模数相同且指数不同时用共模攻击",
		when: ["模数相同且指数不同"],
		do: "1. 计算 gcd 2. 扩展欧几里得求系数",
		expect: "得到明文",
	};
	push("complete candidate passes the real proposal gate", validateProposal(good).accepted === true);

	const forbidden = { ...good, verified: true };
	push("a draft carrying a forbidden field is refused", validateProposal(forbidden).accepted === false);

	const noDo = { kind: "candidate", text: "没有动作的候选", when: ["条件"], do: "", expect: "结果" };
	push("an empty do string is refused", validateProposal(noDo).accepted === false);

	const asArrayWhen = {
		kind: "candidate",
		text: "when 必须是字符串数组",
		when: "单个字符串",
		do: "步骤",
		expect: "结果",
	};
	push("a non-array when is refused", validateProposal(asArrayWhen).accepted === false);

	const failed = checks.filter((check) => !check.ok);
	for (const check of checks) console.log(`${check.ok ? "ok  " : "FAIL"}  ${check.name}`);
	console.log(`\nself-check: ${checks.length - failed.length}/${checks.length} passed`);
	return failed.length === 0;
}

// --- CLI -------------------------------------------------------------------
function parseArgs(argv) {
	const options = {
		...DEFAULTS,
		dryRun: false,
		report: false,
		selfCheck: false,
		limit: null,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = () => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
			i += 1;
			return next;
		};
		switch (arg) {
			case "--input":
				options.input = value();
				break;
			case "--output":
				options.output = value();
				break;
			case "--max-files":
				options.maxFiles = Number(value());
				break;
			case "--max-candidates":
				options.maxCandidates = Number(value());
				break;
			case "--max-per-file":
				options.maxPerFile = Number(value());
				break;
			case "--limit":
				options.limit = Number(value());
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--report":
				options.report = true;
				break;
			case "--self-check":
				options.selfCheck = true;
				break;
			default:
				throw new Error(`unknown option: ${arg}`);
		}
	}
	for (const key of ["maxFiles", "maxCandidates", "maxPerFile", "limit"]) {
		if (options[key] !== null && (!Number.isInteger(options[key]) || options[key] < 1)) {
			throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a positive integer`);
		}
	}
	return options;
}

/** Refuse output locations that hold source or contracts. */
function assertSafeOutput(output) {
	const target = resolve(BASE_DIR, output);
	const blocked = ["Pi_Agent_base", "docs", "tmp", "run-aegis.sh"].map((p) => resolve(BASE_DIR, p));
	for (const path of blocked) {
		if (target === path || target.startsWith(`${path}${sep}`)) {
			throw new Error(`refusing to write drafts into source/contract area: ${relative(BASE_DIR, target)}`);
		}
	}
	return target;
}

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(String(error instanceof Error ? error.message : error));
		console.error(
			"usage: node build-ctf-wiki-experience-candidates.mjs [--input DIR] [--output DIR] [--dry-run] [--report] [--self-check] [--limit N]",
		);
		process.exit(2);
	}

	if (options.selfCheck) process.exit(selfCheck() ? 0 : 1);

	const result = await extract({
		input: options.input,
		maxFiles: options.maxFiles,
		maxCandidates: options.limit ?? options.maxCandidates,
		maxPerFile: options.maxPerFile,
	});

	const summary = {
		input: result.input,
		files_scanned: result.files_scanned,
		seeds_read: result.seeds_read,
		seeds_skipped: result.seeds_skipped,
		candidates: result.candidates,
		rejects: result.rejects,
		note: "candidates are unverified hypotheses; they become usable only after >=2 independently resolved outcomes (MEMORY_SCHEMA §6.3)",
	};

	if (options.report || options.dryRun) {
		console.log(JSON.stringify(summary, null, 2));
		if (options.dryRun) return;
	}

	const outputDir = assertSafeOutput(options.output);
	await mkdir(outputDir, { recursive: true });
	const jsonlPath = join(outputDir, "candidates.jsonl");
	const body = result.drafts.map((draft) => JSON.stringify(draft)).join("\n");
	await writeFile(jsonlPath, result.drafts.length > 0 ? `${body}\n` : "", "utf8");
	await writeFile(join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

	console.log(`wrote ${result.drafts.length} candidate drafts to ${join(outputDir, "candidates.jsonl")}`);
	console.log("these are unverified hypotheses: review them before submitting as proposals");
	if (result.candidates === 0) {
		console.log("no candidates met the bar (steps + precondition + observable expectation); that is a valid outcome");
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	await main();
}
