// A seed registry is a disposable retrieval projection, never a truth source.
// No global discovery: every lookup supplies the source and its projection path.
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { compileDocumentSeed, compileDocumentSeedFile } from "./document-seed.mjs";
import { contentDigest } from "./learning-store.mjs";

// Includes repeated bounded provenance, URI/heading metadata and JSON escaping.
const MAX_PROJECTION_BYTES = 1048576;

async function readProjection(path) {
	const handle = await open(path, "r");
	try {
		if (!(await handle.stat()).isFile()) throw new Error("not a projection file");
		const buffer = Buffer.alloc(MAX_PROJECTION_BYTES + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset > MAX_PROJECTION_BYTES) throw new Error("oversized seed projection");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)));
	} finally {
		await handle.close();
	}
}

async function writeProjection(path, seed) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(seed)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await unlink(temporary).catch(() => {});
	}
}

/** Explicit source refresh/load. Recompiles to validate digest, compiler, bounds
 * and the entire stored body. A failed source read or write returns unavailable;
 * it never falls back to the old source projection.
 * @typedef {{seedPath: string, documentPath?: string, markdown?: string, source?: object, limits?: object, generatedAt?: string, rebuild?: boolean}} SeedSelection
 * @param {SeedSelection} input
 */
export async function loadDocumentSeed({
	seedPath,
	documentPath,
	markdown,
	source,
	limits = {},
	generatedAt,
	rebuild = true,
}) {
	try {
		if (typeof seedPath !== "string" || !isAbsolute(seedPath) || !seedPath.endsWith(".json"))
			throw new Error("explicit absolute seed JSON path required");
		if (documentPath !== undefined && (markdown !== undefined || source !== undefined))
			throw new Error("ambiguous source selection");
		if (documentPath === undefined && (typeof markdown !== "string" || !source))
			throw new Error("explicit Markdown and source metadata required");
		const expected =
			documentPath !== undefined
				? await compileDocumentSeedFile({ path: documentPath, limits, generatedAt })
				: compileDocumentSeed({ markdown, source, limits, generatedAt });
		let stored = null;
		try {
			stored = await readProjection(seedPath);
		} catch {
			/* disposable projection */
		}
		if (
			stored &&
			typeof stored.generated_at === "string" &&
			Number.isFinite(Date.parse(stored.generated_at)) &&
			contentDigest({ ...stored, generated_at: null }) === contentDigest({ ...expected, generated_at: null })
		) {
			return { ok: true, status: "loaded", seed: stored };
		}
		if (!rebuild)
			return { ok: false, status: "unavailable", reason: "missing, invalid or stale seed projection", seed: null };
		await writeProjection(seedPath, expected);
		return { ok: true, status: "rebuilt", seed: expected };
	} catch (error) {
		return {
			ok: false,
			status: "unavailable",
			reason: error instanceof Error ? error.message : "seed unavailable",
			seed: null,
		};
	}
}

/** Caller-selected sources only, with optional exact topic/section filtering.
 * The returned references are still unverified data. Limits cap aggregate output.
 * @param {{selections: SeedSelection[], topic?: string, maxSeeds?: number, maxChars?: number}} input
 */
export async function selectDocumentSeeds({ selections, topic, maxSeeds = 8, maxChars = 24000 }) {
	if (
		!Array.isArray(selections) ||
		selections.length > 32 ||
		!Number.isInteger(maxSeeds) ||
		maxSeeds < 1 ||
		maxSeeds > 8 ||
		!Number.isInteger(maxChars) ||
		maxChars < 1 ||
		maxChars > 24000 ||
		(topic !== undefined && (typeof topic !== "string" || topic.length > 160))
	)
		throw new Error("invalid explicit seed selection");
	const references = [];
	const unavailable = [];
	let remaining = maxChars;
	let omitted = 0;
	for (const selection of selections) {
		const loaded = await loadDocumentSeed(selection);
		if (!loaded.ok) {
			unavailable.push({ seedPath: selection.seedPath, reason: loaded.reason });
			continue;
		}
		for (const section of loaded.seed.sections) {
			if (topic !== undefined && section.topic !== topic && !section.section.includes(topic)) continue;
			if (references.length >= maxSeeds || remaining <= 0) {
				omitted++;
				continue;
			}
			const content = section.content.slice(0, remaining);
			remaining -= content.length;
			references.push({
				...section,
				content,
				truncated: section.truncated || content.length !== section.content.length,
				semantic_digest: loaded.seed.semantic_digest,
			});
		}
	}
	return { references, unavailable, omitted };
}

/** Explicit compatibility conversion for the existing RAM seed boundary. Local
 * source identity survives as original_source_kind; this grants no authority.
 * Pass references only from selectDocumentSeeds/loadDocumentSeed, not model data.
 * @param {{source_kind: string, source_uri: string, source_digest: string, compiler_version: string, verified: boolean, action_policy: string, content: string, topic: string, line_start: number, line_end: number}} reference
 */
export function documentReferenceForRam(reference) {
	if (
		!reference ||
		!["local_document", "external_reference"].includes(reference.source_kind) ||
		reference.verified !== false ||
		reference.action_policy !== "none" ||
		typeof reference.content !== "string" ||
		reference.content.length > 24000 ||
		!/^sha256:[a-f0-9]{64}$/.test(reference.source_digest)
	)
		throw new Error("invalid document reference");
	return {
		source_kind: "external_reference",
		original_source_kind: reference.source_kind,
		source_uri: reference.source_uri,
		source_digest: reference.source_digest,
		compiler_version: reference.compiler_version,
		topic: reference.topic,
		content: reference.content,
		line_start: reference.line_start,
		line_end: reference.line_end,
		verified: false,
		action_policy: "none",
	};
}
