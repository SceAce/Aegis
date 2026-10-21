// Local reference retrieval. Model queries/ids select data, never proof or policy.
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { redactMemoryText } from "./summary.mjs";

export const KNOWLEDGE_VERSION = "1.0.0";
/**
 * The knowledge base lives with the Aegis state home, never in the repository.
 * A repository fallback was removed deliberately: a stale checkout must not
 * silently supply (or shadow) the operator's local corpus.
 */
function defaultKnowledgeRoot(env = process.env) {
	const home = env.AEGIS_HOME || join(homedir(), ".Aegis");
	return join(home, "knowledge");
}
// Metadata files in the knowledge tree are not document seeds. Skipping them
// avoids parsing large indexes and reporting them as rejected seeds.
const NON_SEED_FILES = new Set(["manifest.json", "cards.json", "candidates.json", "analysis.json", "summary.json"]);
const MAX_FILES = 4096;
const MAX_FILE_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 64 * 1_048_576;
const MAX_QUERY_CHARS = 800;
const STOP_WORDS = new Set(
	"the and for with that this from into have has are was were not you your what when where how why use using can should must of to in on by is as or do be it if then than ctf wiki introduction basic basics guide".split(
		" ",
	),
);

function text(value, limit) {
	return typeof value === "string" ? redactMemoryText(value).slice(0, limit) : "";
}

function terms(query) {
	const normalized = query.toLowerCase();
	const words = normalized.match(/[a-z0-9_]{2,}/g) ?? [];
	// Chinese text has no word spaces. Bigrams allow a natural-language current
	// message to recall a topic; the LLM can refine this with an explicit query.
	for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? [])
		for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2));
	return [...new Set(words.filter((word) => !STOP_WORDS.has(word)))].slice(0, 64);
}

async function filesUnder(root) {
	const paths = [];
	let omitted = false;
	async function visit(dir, depth) {
		if (depth > 16) {
			omitted = true;
			return;
		}
		for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".") || entry.name === "ctf-wiki-crawl") continue;
			if (NON_SEED_FILES.has(entry.name) || entry.name.endsWith(".recipe.json")) continue;
			if (paths.length >= MAX_FILES) {
				omitted = true;
				break;
			}
			const path = resolve(dir, entry.name);
			// Dirent.isFile/isDirectory exclude symlinks. No paths come from model ids.
			if (entry.isDirectory()) await visit(path, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json") paths.push(path);
		}
	}
	await visit(root, 0);
	return { paths, omitted };
}

function validSeed(seed) {
	if (
		!seed ||
		seed.schema_version !== "document-seed-1" ||
		seed.verified !== false ||
		seed.action_policy !== "none" ||
		!/^sha256:[a-f0-9]{64}$/.test(seed.source_digest) ||
		!Array.isArray(seed.sections) ||
		seed.sections.length > 64
	)
		return false;
	try {
		const uri = new URL(seed.source_uri);
		if (uri.username || uri.password || uri.search || uri.hash || seed.source_uri.length > 2048) return false;
		return seed.source_kind === "external_reference"
			? uri.protocol === "https:"
			: seed.source_kind === "local_document" && uri.protocol === "file:" && !uri.host;
	} catch {
		return false;
	}
}

async function readSeed(path, remaining) {
	const handle = await open(path, "r");
	try {
		const size = (await handle.stat()).size;
		if (size > MAX_FILE_BYTES || size > remaining) throw new Error("seed byte bound exceeded");
		const bytes = Buffer.alloc(Math.min(MAX_FILE_BYTES, remaining) + 1);
		let count = 0;
		while (count < bytes.length) {
			const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null);
			if (!bytesRead) break;
			count += bytesRead;
		}
		if (count > MAX_FILE_BYTES || count > remaining) throw new Error("seed byte bound exceeded");
		return {
			seed: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))),
			bytes: count,
		};
	} finally {
		await handle.close();
	}
}

function sectionRecord(path, seed, section, index, root) {
	if (
		!section ||
		typeof section.content !== "string" ||
		!section.content.trim() ||
		section.source_digest !== seed.source_digest ||
		section.source_uri !== seed.source_uri ||
		section.source_kind !== seed.source_kind ||
		section.verified !== false ||
		section.action_policy !== "none"
	)
		return null;
	const rel = relative(root, path).replaceAll("\\", "/");
	return {
		knowledge_id: `${rel}#${index}`,
		source_kind: seed.source_kind,
		source_uri: seed.source_uri,
		source_digest: seed.source_digest,
		compiler_version: seed.compiler_version,
		topic: text(section.topic || "document", 160),
		section: Array.isArray(section.section) ? section.section.slice(0, 6).map((s) => text(s, 160)) : [],
		kind: text(section.kind || "section", 40),
		content: text(section.content, 2000),
		line_start: section.line_start,
		line_end: section.line_end,
		truncated: section.truncated === true || section.content.length > 2000,
		verified: false,
		action_policy: "none",
	};
}

// General workflow terms are useful only when the query contains no task terms.
const WORKFLOW_WORDS = new Set(
	"python script scripts cli bash shell stdout stderr install run running command code local file files output executes exit fails handout supplied inspect save read write".split(
		" ",
	),
);
// Chinese has no word spaces, so `terms()` emits bigrams. Task-wrapper bigrams then
// collide with topic text: "这是 CTF web 的题目…解出 flag" matched "RSA 复杂题目"
// purely on 题目. These describe the request, not the technique, so they are not
// evidence that a section is relevant.
const WRAPPER_BIGRAMS = new Set(
	"这是 的题 题目 题面 附件 解出 解法 并且 记录 一下 时间 帮我 这个 那个 什么 怎么 需要 已经 可以 一个 现在 我们 你们 它们 通过 进行 使用 结果 输出 正确 错误 请帮 看下 看看 试试 是否 上面 下面 这里 那里 时候".split(
		" ",
	),
);
const HAN_FROM = "條爾當頁據種響應恢復數觀兩時";
const HAN_TO = "条尔当页据种响应恢复数观两时";
function canonicalText(value) {
	return value
		.toLowerCase()
		.replace(/[條爾當頁據種響應恢復數觀兩時]/g, (c) => HAN_TO[HAN_FROM.indexOf(c)])
		.replace(/\s+/g, " ")
		.trim();
}

// Direction hints in the request. A message that names its domain ("CTF web",
// "rsa", "栈溢出") is a strong filter: retrieving kernel ROP notes for a web task
// wastes context and, worse, invites the wrong plan. Only used when the hint is
// explicit and the corpus actually has that category.
const DIRECTION_HINTS = {
	web: [
		"web",
		"http",
		"https",
		"sql",
		"sqli",
		"xss",
		"ssrf",
		"csrf",
		"upload",
		"cookie",
		"php",
		"jwt",
		"flask",
		"thinkphp",
		"nginx",
	],
	crypto: [
		"crypto",
		"rsa",
		"aes",
		"ecc",
		"des",
		"hash",
		"md5",
		"sha",
		"lattice",
		"格子",
		"格",
		"共模",
		"离散对数",
		"维纳",
		"广播",
		"padding oracle",
	],
	pwn: [
		"pwn",
		"rop",
		"ret2",
		"shellcode",
		"栈溢出",
		"堆",
		"heap",
		"tcache",
		"uaf",
		"格式化字符串",
		"libc",
		"seccomp",
		"one_gadget",
	],
	reverse: [
		"reverse",
		"逆向",
		"反编译",
		"反汇编",
		"apk",
		"dex",
		"jadx",
		"ida",
		"ghidra",
		"upx",
		"angr",
		"frida",
		"ollvm",
	],
	misc: ["misc", "隐写", "stego", "流量", "pcap", "取证", "音频", "图片", "二维码", "压缩包", "编码", "osint"],
};

/**
 * Category segment of a seed path, e.g. ctf-wiki/web/zh/... -> web, or
 * techniques/seeds/web-php-... -> web. Curated cards carry their category in the
 * card id prefix, so a direction-filtered query must not silently drop them.
 */
function directionOfPath(path) {
	const parts = String(path).split("/");
	const index = parts.indexOf("ctf-wiki");
	if (index >= 0) {
		const segment = parts[index + 1];
		return segment && DIRECTION_HINTS[segment] ? segment : null;
	}
	if (parts[0] === "seeds") {
		const id = String(parts[1] ?? "").toLowerCase();
		for (const direction of ["web", "crypto", "pwn", "misc"]) {
			if (id.startsWith(`${direction}-`)) return direction;
		}
		if (id.startsWith("rev-")) return "reverse";
	}
	return null;
}

/** Curated local material is direction-neutral when its path has no category. */
function isCuratedPath(path) {
	const value = String(path);
	return (
		value.startsWith("seeds/") ||
		value.startsWith("documents/") ||
		value.startsWith("techniques/seeds/") ||
		value.includes("/techniques/seeds/")
	);
}

/** The direction the request itself names, or null when it does not say. */
function directionOfQuery(words) {
	for (const [direction, hints] of Object.entries(DIRECTION_HINTS)) {
		if (words.some((word) => hints.includes(word))) return direction;
	}
	return null;
}

/** Minimum relevance for an automatic recall. Explicit `ids` bypass scoring. */
const MIN_RELEVANCE = 5;

/**
 * A long latin token is specific on its own: "changed_content" or
 * "http_response_split" identifies a section, while "题目" identifies nothing.
 * Without a full IDF pass this is the cheap proxy that keeps precise queries
 * working under the MIN_RELEVANCE floor.
 */
function hasSpecificWord(record, words) {
	const body = canonicalText(record.content);
	const heading = canonicalText(record.section.join(" "));
	return words.some(
		(word) => word.length >= 6 && /^[a-z0-9_]/.test(word) && (heading.includes(word) || body.includes(word)),
	);
}

/**
 * Curated local material outranks the broad wiki when both match. Cards are
 * human-reviewed hints and CVE documents are curated references; the wiki is a
 * broad background corpus. The bonus is small enough that a much stronger wiki
 * match still wins, but a tie no longer drops the card behind generic pages.
 */
function sourceBonus(record) {
	const id = record.knowledge_id;
	if (id.startsWith("seeds/") || id.startsWith("techniques/seeds/") || id.includes("/techniques/seeds/")) return 6;
	if (id.startsWith("documents/") || id.includes("/documents/")) return 4;
	return 0;
}

function score(record, words) {
	const topic = canonicalText(record.topic);
	const heading = canonicalText(record.section.join(" "));
	const body = canonicalText(record.content);
	const path = record.knowledge_id.toLowerCase();
	let value = 0;
	for (const word of words) {
		if (topic.includes(word)) value += 8;
		if (heading.includes(word)) value += 5;
		if (body.includes(word)) value += 2;
		if (path.includes(word)) value += 1;
	}
	// Return substantive blocks before bare headings of the same topic.
	return (record.kind === "heading" ? value * 0.5 : value) + sourceBonus(record);
}

/** Read only the configured local tree. Limits and unavailable data are visible;
 * the index is rebuilt so edited/migrated knowledge is not served from a cache.
 * @param {{root?: string, query?: string, maxResults?: number, maxChars?: number, ids?: string[]}} input
 */
export async function selectKnowledge({
	root = DEFAULT_ROOT,
	query = "",
	maxResults = 3,
	maxChars = 6000,
	ids = [],
} = {}) {
	if (typeof root !== "string" || !root) throw new Error("knowledge root is required");
	if (typeof query !== "string" || query.length > MAX_QUERY_CHARS)
		throw new Error("knowledge query must be at most 800 characters");
	if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 8)
		throw new Error("invalid knowledge result bound");
	if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 12000)
		throw new Error("invalid knowledge character bound");
	if (!Array.isArray(ids) || ids.length > 8 || ids.some((id) => typeof id !== "string" || id.length > 1024))
		throw new Error("invalid knowledge selection ids");
	const resolvedRoot = resolve(root);
	let files;
	try {
		files = await filesUnder(resolvedRoot);
	} catch (error) {
		return {
			version: KNOWLEDGE_VERSION,
			status: "unavailable",
			query: text(query, MAX_QUERY_CHARS),
			selected: [],
			available: 0,
			omitted: 0,
			rejected_files: 0,
			bounds_reached: false,
			missing_ids: ids,
			reason: error.code ?? "knowledge_unreadable",
		};
	}
	const records = [];
	let remainingBytes = MAX_TOTAL_BYTES;
	let rejectedFiles = 0;
	for (const path of files.paths) {
		if (remainingBytes <= 0) {
			files.omitted = true;
			break;
		}
		try {
			const loaded = await readSeed(path, remainingBytes);
			remainingBytes -= loaded.bytes;
			if (!validSeed(loaded.seed)) {
				rejectedFiles++;
				continue;
			}
			for (const [index, section] of loaded.seed.sections.entries()) {
				const record = sectionRecord(path, loaded.seed, section, index, resolvedRoot);
				if (record) records.push(record);
			}
		} catch {
			rejectedFiles++;
		}
	}
	const byId = new Map(records.map((record) => [record.knowledge_id, record]));
	const allWords = terms(canonicalText(query));
	const taskWords = allWords.filter((word) => !WORKFLOW_WORDS.has(word) && !WRAPPER_BIGRAMS.has(word));
	const words = taskWords.length ? taskWords : allWords;
	// Direction filter: when the request names a domain, drop records from other
	// domains. Falling back to the unfiltered set keeps recall when a category is
	// absent from the corpus, so this never hides knowledge entirely.
	const direction = ids.length === 0 ? directionOfQuery(words) : null;
	const sameDirection =
		direction === null
			? records
			: records.filter((record) => {
					const recordDirection = directionOfPath(record.knowledge_id);
					return recordDirection === direction || (recordDirection === null && isCuratedPath(record.knowledge_id));
				});
	const pool = sameDirection.length > 0 ? sameDirection : records;
	const rankedWithScore =
		ids.length > 0
			? [...new Set(ids)].map((id) => ({ record: byId.get(id), score: null })).filter((entry) => entry.record)
			: pool
					.map((record) => ({ record, score: score(record, words) }))
					.filter((entry) => entry.score >= MIN_RELEVANCE || hasSpecificWord(entry.record, words))
					.sort((a, b) => b.score - a.score || a.record.knowledge_id.localeCompare(b.record.knowledge_id));
	const ranked = rankedWithScore.map((entry) => entry.record);
	const scoreById = new Map(rankedWithScore.map((entry) => [entry.record.knowledge_id, entry.score]));
	let remaining = maxChars;
	const selected = [];
	const seenContent = new Set();
	// Parallel translations (zh / zh-tw / en) of the same page score identically and
	// would fill every slot with one section. One row per section path keeps the
	// working set diverse without changing what counts as relevant.
	const seenSection = new Set();
	for (const record of ranked) {
		if (remaining <= 0 || selected.length >= (taskWords.length ? maxResults : 1)) break;
		const contentKey = canonicalText(record.content);
		const sectionKey = `${record.source_uri}|${canonicalText(record.section.join("/"))}`;
		if (seenSection.has(sectionKey)) continue;
		if (
			record.kind === "heading" &&
			ranked.some(
				(other) =>
					other.kind !== "heading" &&
					other.source_uri === record.source_uri &&
					canonicalText(other.section.join(" ")).startsWith(canonicalText(record.section.join(" "))),
			)
		)
			continue;
		if (seenContent.has(contentKey)) continue;
		if (
			record.kind === "heading" &&
			ranked.some(
				(other) =>
					other.kind !== "heading" &&
					other.source_uri === record.source_uri &&
					canonicalText(other.section.join(" ")) === canonicalText(record.section.join(" ")),
			)
		)
			continue;
		seenContent.add(contentKey);
		seenSection.add(sectionKey);
		const content = record.content.slice(0, remaining);
		remaining -= content.length;
		selected.push({
			...record,
			content,
			truncated: record.truncated || content.length !== record.content.length,
			// Why this row was recalled; null for an explicit id lookup.
			score: scoreById.get(record.knowledge_id) ?? null,
		});
	}
	return {
		version: KNOWLEDGE_VERSION,
		status: "ready",
		query: text(query, MAX_QUERY_CHARS),
		selected,
		available: records.length,
		omitted: Math.max(0, ranked.length - selected.length),
		rejected_files: rejectedFiles,
		bounds_reached: files.omitted,
		missing_ids: ids.filter((id) => !byId.has(id)),
	};
}

export function knowledgeRootFromEnv() {
	return process.env.AEGIS_KNOWLEDGE_DIR || defaultKnowledgeRoot();
}
