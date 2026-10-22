// Deterministic document seed compiler. No provider call, no Event/Outcome writer.
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { contentDigest } from "./learning-store.mjs";
import { redactMemoryText } from "./summary.mjs";

export const DOCUMENT_SEED_COMPILER_VERSION = "1.0.0";
export const DOCUMENT_SEED_LIMITS = Object.freeze({
	maxBytes: 262144,
	maxSections: 64,
	maxChars: 24000,
	maxSectionChars: 2000,
	maxDepth: 6,
});
export function documentSeedLimits(options = {}) {
	if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("invalid seed limits");
	const limits = { ...DOCUMENT_SEED_LIMITS };
	for (const [key, value] of Object.entries(options)) {
		if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > limits[key])
			throw new Error("invalid seed limit");
		limits[key] = value;
	}
	return limits;
}
function sourceMetadata(source) {
	if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("source metadata required");
	const allowed = new Set(["source_uri", "source_kind", "approved"]);
	if (Object.keys(source).some((key) => !allowed.has(key))) throw new Error("unsupported source metadata");
	const { source_uri: uri, source_kind: kind } = source;
	if (
		typeof uri !== "string" ||
		!uri ||
		uri.length > 2048 ||
		/[\s\u0000-\u001f]/u.test(uri) ||
		redactMemoryText(uri) !== uri
	)
		throw new Error("invalid source URI");
	let url;
	try {
		url = new URL(uri);
	} catch {
		throw new Error("absolute source URI required");
	}
	if (url.username || url.password || url.search || url.hash)
		throw new Error("source URI must not carry credentials, query or fragment");
	if (kind === "local_document") {
		if (url.protocol !== "file:" || url.host) throw new Error("local document requires a local file URI");
	} else if (kind === "external_reference") {
		if (url.protocol !== "https:" || source.approved !== true)
			throw new Error("external reference requires approved HTTPS metadata");
	} else throw new Error("invalid source kind");
	return { source_uri: uri, source_kind: kind, verified: false, action_policy: "none" };
}
// Keep physical source lines through removal and redact multiline keys before
// per-line credential handling. Line refs always address the original document.
function safeDocument(markdown) {
	const lines = markdown.split("\n");
	const protectedLines = new Set();
	let fence = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			protectedLines.add(index);
			if (new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null;
		} else if (opening) {
			fence = opening[1];
			protectedLines.add(index);
		}
	}
	// HTML-looking text inside a fenced code block is source content, not markup.
	// Mask those lines while applying the document sanitizer, then restore them
	// before parsing sections so PHP/XML examples survive seed compilation.
	const masked = lines
		.map((line, index) => (protectedLines.has(index) ? line.replace(/[^\r\n]/g, " ") : line))
		.join("\n");
	const blankLines = (text) => text.replace(/[^\r\n]/g, " ");
	const sanitized = masked
		.replace(/<!--[\s\S]*?(?:-->|$)/g, blankLines)
		.replace(/<(script|style|iframe|object)\b[^>]*(?:>|$)[\s\S]*?(?:<\/\1\s*>|$)/gi, blankLines)
		.replace(/<[^>]*(?:>|$)/g, blankLines)
		.replace(
			/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
			(text) => `[REDACTED_KEY]${text.match(/\n/g)?.join("") ?? ""}`,
		)
		.split("\n")
		.map((line, index) => redactMemoryText(protectedLines.has(index) ? lines[index] : line))
		.join("\n");
	return sanitized;
}
/** @param {{markdown:string,source:object,limits?:object,generatedAt?:string}} input */
export function compileDocumentSeed({
	markdown,
	source,
	limits: options = {},
	generatedAt = "1970-01-01T00:00:00.000Z",
}) {
	const metadata = sourceMetadata(source);
	const limits = documentSeedLimits(options);
	if (
		typeof markdown !== "string" ||
		!markdown.trim() ||
		markdown.includes("\0") ||
		Buffer.byteLength(markdown, "utf8") > limits.maxBytes ||
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(markdown)
	)
		throw new Error("invalid or oversized Markdown");
	if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("invalid generation time");
	const source_digest = `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`;
	const lines = safeDocument(markdown).split("\n");
	const sections = [];
	const headings = [];
	let used = 0;
	let truncated = false;
	function emit(kind, start, end, text) {
		const clean = text.trim();
		if (!clean) return;
		const budget = Math.min(limits.maxSectionChars, limits.maxChars - used);
		if (sections.length >= limits.maxSections || budget <= 0) {
			truncated = true;
			return;
		}
		const content = clean.slice(0, budget);
		const clipped = content.length !== clean.length;
		truncated ||= clipped;
		used += content.length;
		sections.push({
			...metadata,
			source_digest,
			compiler_version: DOCUMENT_SEED_COMPILER_VERSION,
			kind,
			topic: headings[0] ?? "document",
			section: headings.slice(0, limits.maxDepth),
			content,
			line_start: start + 1,
			line_end: end + 1,
			truncated: clipped,
		});
	}
	for (let i = 0; i < lines.length; ) {
		if (!lines[i].trim()) {
			i++;
			continue;
		}
		const start = i;
		const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
		if (fence) {
			i++;
			const body = [];
			while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i]))
				body.push(lines[i++]);
			if (i >= lines.length) throw new Error("unclosed Markdown code fence");
			emit("code", start, i++, body.join("\n"));
			continue;
		}
		const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
		if (heading) {
			const depth = Math.min(heading[1].length, limits.maxDepth);
			headings.length = Math.min(headings.length, depth - 1);
			headings.push(heading[2].slice(0, 160));
			emit("heading", i, i, heading[2]);
			i++;
			continue;
		}
		const list = /^\s*(?:[-+*]|\d+[.)])\s+/.test(lines[i]);
		const body = [lines[i++]];
		while (
			i < lines.length &&
			lines[i].trim() &&
			!/^\s{0,3}(?:#{1,6}\s|`{3,}|~{3,})/.test(lines[i]) &&
			/^\s*(?:[-+*]|\d+[.)])\s+/.test(lines[i]) === list
		)
			body.push(lines[i++]);
		emit(list ? "list" : "paragraph", start, i - 1, body.join("\n"));
	}
	if (!sections.length) throw new Error("document contains no usable reference content");
	const semantic = {
		schema_version: "document-seed-1",
		...metadata,
		source_digest,
		compiler_version: DOCUMENT_SEED_COMPILER_VERSION,
		limits,
		sections,
		truncated,
		content_chars: used,
		provenance: { extractor: "deterministic-markdown-blocks", source_digest },
	};
	return { ...semantic, semantic_digest: contentDigest(semantic), generated_at: generatedAt };
}
/** @param {{path:string,limits?:object,generatedAt?:string}} input */
export async function compileDocumentSeedFile({ path, limits = {}, generatedAt }) {
	if (typeof path !== "string" || !isAbsolute(path) || !/\.md(?:own|arkdown)?$/i.test(path))
		throw new Error("explicit absolute Markdown path required");
	const bounds = documentSeedLimits(limits);
	const handle = await open(path, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > bounds.maxBytes) throw new Error("invalid or oversized Markdown file");
		const buffer = Buffer.alloc(bounds.maxBytes + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset > bounds.maxBytes) throw new Error("oversized Markdown file");
		const markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
		return compileDocumentSeed({
			markdown,
			source: { source_uri: pathToFileURL(path).href, source_kind: "local_document" },
			limits,
			generatedAt,
		});
	} finally {
		await handle.close();
	}
}
