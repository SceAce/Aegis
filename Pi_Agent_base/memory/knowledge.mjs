// Local reference retrieval. Model queries/ids select data, never proof or policy.
import { open, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactMemoryText } from "./summary.mjs";

export const KNOWLEDGE_VERSION = "1.0.0";
const DEFAULT_ROOT = fileURLToPath(new URL("../../knowledge/", import.meta.url));
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
const HAN_FROM = "條爾當頁據種響應恢復數觀兩時";
const HAN_TO = "条尔当页据种响应恢复数观两时";
function canonicalText(value) {
	return value
		.toLowerCase()
		.replace(/[條爾當頁據種響應恢復數觀兩時]/g, (c) => HAN_TO[HAN_FROM.indexOf(c)])
		.replace(/\s+/g, " ")
		.trim();
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
	return record.kind === "heading" ? value * 0.5 : value;
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
	const taskWords = allWords.filter((word) => !WORKFLOW_WORDS.has(word));
	const words = taskWords.length ? taskWords : allWords;
	const ranked =
		ids.length > 0
			? [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean)
			: records
					.map((record) => ({ record, score: score(record, words) }))
					.filter((entry) => entry.score > 0)
					.sort((a, b) => b.score - a.score || a.record.knowledge_id.localeCompare(b.record.knowledge_id))
					.map((entry) => entry.record);
	let remaining = maxChars;
	const selected = [];
	const seenContent = new Set();
	for (const record of ranked) {
		if (remaining <= 0 || selected.length >= (taskWords.length ? maxResults : 1)) break;
		const contentKey = canonicalText(record.content);
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
		const content = record.content.slice(0, remaining);
		remaining -= content.length;
		selected.push({ ...record, content, truncated: record.truncated || content.length !== record.content.length });
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
	return process.env.AEGIS_KNOWLEDGE_DIR || DEFAULT_ROOT;
}
