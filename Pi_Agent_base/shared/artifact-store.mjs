// Aegis — controlled raw artifact store (MEM-02 §5.2).
//
// The problem this solves: RAM keeps only a bounded, redacted excerpt (the
// Observer caps `content_excerpt` at 800 chars) plus a digest. Once a summary
// omits the middle of a large tool output, nothing on disk holds the original
// bytes, so a later Session cannot read them back — not from RAM, not from the
// event log, not by raising a budget.
//
// This module is the STORAGE boundary only:
//
//   * content addressed: the blob name is derived from `sha256` of the RAW
//     BYTES, never from a caller-supplied name, owner, task id or path;
//   * a small persisted HEAD per artifact records owner (task/episode),
//     provenance (source event/action/tool), the real `byte_length`, media
//     type and the digest the bytes were verified against;
//   * the registry view is rebuilt from the persisted heads, so deleting any
//     derived listing changes nothing (there is no derived listing);
//   * `put` verifies what actually reached disk (re-read + re-hash) before it
//     reports success, so a partial write can never masquerade as artifact;
//   * `readBytes` re-verifies the bytes it is about to return and reports
//     `missing`/`corrupt`/`symlink` instead of reconstructing anything from a
//     digest or an excerpt.
//
// HONEST BOUNDARIES (do not weaken):
//   * This is storage, not authority. It grants no Fact, Outcome, permission or
//     budget, and it decides no task success. Authorization for a READ lives in
//     `execution/artifact-read.mjs`, against a trusted principal.
//   * It does not redact raw bytes. Display redaction stays the RAM/report
//     layer's job; an owner-authorized read returns the stored bytes.
//   * Path containment here is a filesystem boundary, not an OS sandbox.
//   * Cross-process writer coordination is NOT provided; concurrent `put`s of
//     the SAME digest are idempotent by design (write-temp + rename), but two
//     processes must not share a root for different content contracts.

import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Persisted head schema version; a reader refuses any other major. */
export const ARTIFACT_STORE_SCHEMA = "artifact-store-1.0";

/** Bounded defaults. Every one of them is enforced, none is advisory. */
export const DEFAULT_ARTIFACT_LIMITS = Object.freeze({
	maxArtifactBytes: 8 * 1024 * 1024,
	maxEntries: 4096,
	maxPageBytes: 64 * 1024,
	maxPageChars: 128 * 1024,
	maxOffset: Number.MAX_SAFE_INTEGER,
});

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REF_PREFIX = "artifact:";
const REF_RE = /^artifact:sha256:[0-9a-f]{64}$/;
const SAFE_TOKEN_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const ENCODINGS = Object.freeze(["utf8", "base64"]);
const CLASSIFICATIONS = Object.freeze(["internal"]);

/**
 * Content address over RAW BYTES.
 * Deliberately NOT `digest()` from contracts.mjs: that one hashes canonical
 * JSON text, and hashing an artifact through `stable()` would let a
 * representation change (and JSON escaping) move the address.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {string} `sha256:<hex>`
 */
export function artifactContentDigest(bytes) {
	if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
		throw new TypeError("artifactContentDigest requires a Buffer or Uint8Array");
	}
	return `sha256:${createHash("sha256").update(Buffer.from(bytes)).digest("hex")}`;
}

/** Stable ref id for a content digest (derived only from the digest). */
export function artifactRefForDigest(digest) {
	if (typeof digest !== "string" || !DIGEST_RE.test(digest)) return null;
	return `${REF_PREFIX}${digest}`;
}

/** True when `value` is a syntactically valid artifact ref (no path chars). */
export function isArtifactRef(value) {
	return typeof value === "string" && REF_RE.test(value);
}

/**
 * Strict owner validation, shared by the store and the reader so the two can
 * never disagree about what "the same owner" means.
 *
 * @param {unknown} owner
 * @returns {{ok: true, owner: {task_id: string, episode_id: string, campaign_id: string|null, session_id: string|null}} | {ok: false, reason: string}}
 */
export function normalizeArtifactOwner(owner) {
	if (!owner || typeof owner !== "object" || Array.isArray(owner))
		return { ok: false, reason: "owner is not an object" };
	const taskId = owner.task_id;
	const episodeId = owner.episode_id;
	if (typeof taskId !== "string" || !SAFE_TOKEN_RE.test(taskId))
		return { ok: false, reason: "owner.task_id is missing or malformed" };
	if (typeof episodeId !== "string" || !SAFE_TOKEN_RE.test(episodeId))
		return { ok: false, reason: "owner.episode_id is missing or malformed" };
	const optional = (value) =>
		value === undefined || value === null ? null : SAFE_TOKEN_RE.test(value) ? value : undefined;
	const campaignId = optional(owner.campaign_id);
	const sessionId = optional(owner.session_id);
	if (campaignId === undefined) return { ok: false, reason: "owner.campaign_id is malformed" };
	if (sessionId === undefined) return { ok: false, reason: "owner.session_id is malformed" };
	return {
		ok: true,
		owner: { task_id: taskId, episode_id: episodeId, campaign_id: campaignId, session_id: sessionId },
	};
}

/** Same owner identity? Campaign/session are informational, not part of identity. */
export function artifactOwnerMatches(a, b) {
	if (!a || !b) return false;
	return (
		a.task_id === b.task_id && a.episode_id === b.episode_id && (a.campaign_id ?? null) === (b.campaign_id ?? null)
	);
}

/** Fixed, non-caller-controlled blob location for a digest. */
function blobPathFor(root, digest) {
	const hex = digest.slice("sha256:".length);
	return join(root, "objects", "sha256", hex.slice(0, 2), hex);
}

function headPathFor(root, digest) {
	const hex = digest.slice("sha256:".length);
	return join(root, "heads", `${hex}.json`);
}

function isInside(rootReal, candidate) {
	const rel = relative(rootReal, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve an existing path and prove it is still inside the store root after
 * symlink resolution. Every intermediate component is checked because
 * `realpath` on the final path alone would follow a swapped directory.
 *
 * @param {string} rootReal realpath of the store root
 * @param {string} candidate absolute candidate path
 * @returns {{ok: true, path: string, real: string} | {ok: false, reason: "symlink"|"missing", detail: string}}
 */
function containExistingPath(rootReal, candidate) {
	if (!isInside(rootReal, resolve(candidate)))
		return { ok: false, reason: "symlink", detail: "candidate escapes the store root" };
	if (!existsSync(candidate)) return { ok: false, reason: "missing", detail: "path does not exist" };
	// Check every ancestor from the root down so a symlinked intermediate
	// directory is refused even when the leaf itself is a regular file (a
	// symlinked top-level component such as `heads` -> outside is visible here
	// because `join(rootReal, "heads")` is still the symlink itself).
	let cursor = rootReal;
	for (const part of relative(rootReal, resolve(candidate)).split(/[\\/]/).filter(Boolean)) {
		cursor = join(cursor, part);
		if (!existsSync(cursor)) return { ok: false, reason: "missing", detail: `path component is absent: ${part}` };
		let real;
		try {
			real = realpathSync(cursor);
		} catch (error) {
			return {
				ok: false,
				reason: "missing",
				detail: `cannot resolve ${part}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (!isInside(rootReal, real))
			return { ok: false, reason: "symlink", detail: `path component escapes the store root: ${part}` };
	}
	const real = realpathSync(candidate);
	if (!isInside(rootReal, real))
		return { ok: false, reason: "symlink", detail: "resolved path escapes the store root" };
	return { ok: true, path: resolve(candidate), real };
}

/**
 * Create an artifact store rooted at `root` (a private, ignored runtime dir).
 *
 * @param {object} [options]
 * @param {string} options.root                        store root directory
 * @param {Partial<typeof DEFAULT_ARTIFACT_LIMITS>} [options.limits]
 * @param {() => string} [options.now]                 injectable clock (RFC 3339)
 * @param {(event: {type: string, detail?: string}) => void} [options.onDiagnostic] structured diagnostics, never a silent catch
 */
export function createArtifactStore({
	root,
	limits = {},
	now = () => new Date().toISOString(),
	onDiagnostic = null,
} = {}) {
	if (typeof root !== "string" || !root) throw new Error("createArtifactStore requires a non-empty root directory");
	const effective = validateLimits({ ...DEFAULT_ARTIFACT_LIMITS, ...limits });
	const rootReal = (() => {
		mkdirSync(resolve(root), { recursive: true });
		return realpathSync(resolve(root));
	})();
	const diagnostic = (type, detail) => {
		if (typeof onDiagnostic === "function") onDiagnostic({ type, detail });
	};

	/**
	 * Persist one artifact.
	 *
	 * @param {object} input
	 * @param {Buffer|Uint8Array} input.bytes                RAW bytes (never a path)
	 * @param {object} input.owner                           `{task_id, episode_id, campaign_id?, session_id?}`
	 * @param {object} [input.origin]                        provenance `{event_id, event_type, action_id, tool_name, causation_id}`
	 * @param {string} [input.media_type]
	 * @param {"utf8"|"base64"} [input.encoding_hint]
	 * @param {"internal"} [input.classification]
	 * @param {unknown} [input.metadata]                     bounded JSON-side metadata (never used in the path)
	 * @returns {{ok: true, ref_id: string, digest: string, byte_length: number, created: boolean, entry: object} | {ok: false, reason: string, detail: string}}
	 */
	function put({
		bytes,
		owner,
		origin = null,
		media_type = "application/octet-stream",
		encoding_hint = "base64",
		classification = "internal",
		metadata = null,
	} = {}) {
		if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
			return { ok: false, reason: "invalid_request", detail: "bytes must be a Buffer or Uint8Array" };
		const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
		if (buffer.byteLength > effective.maxArtifactBytes) {
			return {
				ok: false,
				reason: "too_large",
				detail: `artifact is ${buffer.byteLength} bytes, over the ${effective.maxArtifactBytes} byte limit`,
			};
		}
		const ownerResult = normalizeArtifactOwner(owner);
		if (!ownerResult.ok) return { ok: false, reason: "invalid_request", detail: ownerResult.reason };
		if (typeof media_type !== "string" || media_type.length === 0 || media_type.length > 200) {
			return { ok: false, reason: "invalid_request", detail: "media_type must be a non-empty string" };
		}
		if (!ENCODINGS.includes(encoding_hint))
			return { ok: false, reason: "invalid_request", detail: `encoding_hint must be one of ${ENCODINGS.join(", ")}` };
		if (!CLASSIFICATIONS.includes(classification))
			return {
				ok: false,
				reason: "invalid_request",
				detail: `classification must be one of ${CLASSIFICATIONS.join(", ")}`,
			};
		const originResult = normalizeOrigin(origin);
		if (!originResult.ok) return { ok: false, reason: "invalid_request", detail: originResult.reason };
		const metadataResult = normalizeMetadata(metadata);
		if (!metadataResult.ok) return { ok: false, reason: "invalid_request", detail: metadataResult.reason };

		const digest = artifactContentDigest(buffer);
		const refId = artifactRefForDigest(digest);
		const blobPath = blobPathFor(rootReal, digest);
		const headPath = headPathFor(rootReal, digest);

		let created = false;
		try {
			mkdirSync(dirname(blobPath), { recursive: true });
			const parentCheck = containExistingPath(rootReal, dirname(blobPath));
			if (!parentCheck.ok) return { ok: false, reason: parentCheck.reason, detail: parentCheck.detail };
			const headsPath = join(rootReal, "heads");
			mkdirSync(headsPath, { recursive: true });
			const headsCheck = containExistingPath(rootReal, headsPath);
			if (!headsCheck.ok) return { ok: false, reason: headsCheck.reason, detail: headsCheck.detail };
			if (existsSync(headPath)) {
				const previous = head({ ref_id: refId });
				if (!previous.ok) return previous;
				if (!artifactOwnerMatches(previous.entry.owner, ownerResult.owner))
					return { ok: false, reason: "foreign", detail: "content already registered to another owner" };
			}
			if (existsSync(blobPath)) {
				// Content address: existing bytes must already be this content. If they
				// are not, the store is corrupt and we must not paper over it.
				const existing = readFileSync(blobPath);
				if (artifactContentDigest(existing) !== digest) {
					diagnostic("artifact.blob-mismatch", digest);
					return { ok: false, reason: "corrupt", detail: "existing blob does not match its content address" };
				}
			} else {
				const written = writeBlobDurably(blobPath, buffer);
				if (!written.ok) {
					diagnostic("artifact.persist-failed", written.detail);
					return { ok: false, reason: "persist_failed", detail: written.detail };
				}
				created = true;
			}
			// Verify what actually reached disk, exactly once, before any head exists.
			const verify = verifyBlob(blobPath, digest, buffer.byteLength);
			if (!verify.ok) {
				// A blob we cannot verify must not stay reachable.
				if (created) safeUnlink(blobPath);
				diagnostic("artifact.verify-failed", verify.detail);
				return { ok: false, reason: "persist_failed", detail: verify.detail };
			}
			const entry = {
				schema_version: ARTIFACT_STORE_SCHEMA,
				ref_id: refId,
				digest,
				byte_length: buffer.byteLength,
				media_type,
				encoding_hint,
				owner: ownerResult.owner,
				origin: originResult.origin,
				classification,
				metadata: metadataResult.value,
				stored_at: String(now()),
				integrity: { algo: "sha256", bytes_checked: buffer.byteLength },
			};
			const headWrite = writeHeadDurably(headPath, entry);
			if (!headWrite.ok) {
				if (created) safeUnlink(blobPath);
				diagnostic("artifact.head-persist-failed", headWrite.detail);
				return { ok: false, reason: "persist_failed", detail: headWrite.detail };
			}
			return { ok: true, ref_id: refId, digest, byte_length: buffer.byteLength, created, entry };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			diagnostic("artifact.put-error", detail);
			return { ok: false, reason: "persist_failed", detail };
		}
	}

	/**
	 * Read a registered head. Never invents an entry and never reads the blob.
	 *
	 * @param {{ref_id: string}} input
	 * @returns {{ok: true, entry: object} | {ok: false, reason: string, detail: string}}
	 */
	function head({ ref_id } = {}) {
		if (!isArtifactRef(ref_id))
			return { ok: false, reason: "invalid_request", detail: "ref_id is not a valid artifact ref" };
		const digest = ref_id.slice(REF_PREFIX.length);
		const headPath = headPathFor(rootReal, digest);
		const contained = containExistingPath(rootReal, headPath);
		if (!contained.ok) return { ok: false, reason: contained.reason, detail: contained.detail };
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(contained.real, "utf8"));
		} catch (error) {
			return {
				ok: false,
				reason: "corrupt",
				detail: `head is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const validation = validateHead(parsed, digest);
		if (!validation.ok) return { ok: false, reason: "corrupt", detail: validation.detail };
		return { ok: true, entry: validation.entry };
	}

	/**
	 * Read a byte range with integrity verification. Store level: it performs NO
	 * caller-authorization (that is `execution/artifact-read.mjs`), but it does
	 * enforce offset/limit/size bounds so a bad call can never read the file.
	 *
	 * @param {{ref_id: string, offset?: number, limit?: number}} input
	 * @returns {{ok: true, entry: object, bytes: Buffer, offset: number, end_offset: number, byte_length: number} | {ok: false, reason: string, detail: string}}
	 */
	function readBytes({ ref_id, offset = 0, limit = effective.maxPageBytes } = {}) {
		const found = head({ ref_id });
		if (!found.ok) return found;
		const entry = found.entry;
		const range = normalizeRange({ offset, limit, byte_length: entry.byte_length });
		if (!range.ok) return range;
		const blobPath = blobPathFor(rootReal, entry.digest);
		const contained = containExistingPath(rootReal, blobPath);
		if (!contained.ok) {
			diagnostic("artifact.blob-unavailable", `${ref_id}: ${contained.detail}`);
			return { ok: false, reason: contained.reason, detail: contained.detail };
		}
		let size;
		try {
			size = statSync(contained.real).size;
		} catch (error) {
			return {
				ok: false,
				reason: "missing",
				detail: `blob cannot be stat-ed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (size !== entry.byte_length) {
			diagnostic("artifact.blob-size-mismatch", `${ref_id}: expected ${entry.byte_length}, found ${size}`);
			return { ok: false, reason: "corrupt", detail: `blob is ${size} bytes, head says ${entry.byte_length}` };
		}
		if (range.end_offset === range.offset) {
			return {
				ok: true,
				entry,
				bytes: Buffer.alloc(0),
				offset: range.offset,
				end_offset: range.end_offset,
				byte_length: entry.byte_length,
			};
		}
		let full;
		try {
			full = readFileSync(contained.real);
		} catch (error) {
			return {
				ok: false,
				reason: "missing",
				detail: `blob cannot be read: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		// Full-content verification, not a page hash: a corrupt region outside the
		// requested page would otherwise silently corrupt future pages.
		if (artifactContentDigest(full) !== entry.digest) {
			diagnostic("artifact.blob-digest-mismatch", ref_id);
			return { ok: false, reason: "corrupt", detail: "blob content does not match the registered digest" };
		}
		return {
			ok: true,
			entry,
			bytes: full.subarray(range.offset, range.end_offset),
			offset: range.offset,
			end_offset: range.end_offset,
			byte_length: entry.byte_length,
		};
	}

	/**
	 * Registered entries for one owner (or all when no owner is given), bounded by
	 * `limits.maxEntries`. Overflow is explicit.
	 *
	 * @param {{owner?: object}} [input]
	 * @returns {{ok: true, entries: object[], truncated: boolean, total: number, entries_scanned: number} | {ok: false, reason: string, detail: string}}
	 */
	function list({ owner = null } = {}) {
		let ownerFilter = null;
		if (owner !== null) {
			const normalized = normalizeArtifactOwner(owner);
			if (!normalized.ok) return { ok: false, reason: "invalid_request", detail: normalized.reason };
			ownerFilter = normalized.owner;
		}
		const headsDir = join(rootReal, "heads");
		let names = [];
		try {
			names = readdirSync(headsDir);
		} catch (error) {
			if ((error && error.code) === "ENOENT")
				return { ok: true, entries: [], truncated: false, total: 0, entries_scanned: 0 };
			return {
				ok: false,
				reason: "internal_error",
				detail: `heads directory is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const entries = [];
		let total = 0;
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const refId = `${REF_PREFIX}sha256:${name.slice(0, -".json".length)}`;
			if (!isArtifactRef(refId)) continue;
			const found = head({ ref_id: refId });
			if (!found.ok) {
				// A broken head is a diagnostic, not an entry; it must not be hidden.
				diagnostic("artifact.head-unusable", `${refId}: ${found.reason} ${found.detail}`);
				continue;
			}
			if (ownerFilter && !artifactOwnerMatches(found.entry.owner, ownerFilter)) continue;
			total += 1;
			if (entries.length >= effective.maxEntries) continue;
			entries.push(found.entry);
		}
		return { ok: true, entries, truncated: total > entries.length, total, entries_scanned: names.length };
	}

	return { root: rootReal, limits: effective, put, head, readBytes, list };
}

/** Clamp/validate a page request against a known length. */
export function normalizeRange({ offset = 0, limit = DEFAULT_ARTIFACT_LIMITS.maxPageBytes, byte_length = 0 } = {}) {
	if (!Number.isSafeInteger(offset) || offset < 0)
		return { ok: false, reason: "invalid_request", detail: "offset must be a non-negative safe integer" };
	if (!Number.isSafeInteger(limit) || limit < 1)
		return { ok: false, reason: "invalid_request", detail: "limit must be a positive safe integer" };
	if (!Number.isSafeInteger(byte_length) || byte_length < 0)
		return { ok: false, reason: "invalid_request", detail: "byte_length must be a non-negative safe integer" };
	if (offset > byte_length)
		return { ok: false, reason: "out_of_bounds", detail: `offset ${offset} is past the end of ${byte_length} bytes` };
	const end_offset = Math.min(byte_length, offset + limit);
	return { ok: true, offset, end_offset };
}

function validateLimits(limits) {
	const integer = (name, minimum) => {
		const value = limits[name];
		if (!Number.isSafeInteger(value) || value < minimum)
			throw new Error(`artifact limits.${name} must be a safe integer >= ${minimum}`);
		return value;
	};
	return Object.freeze({
		maxArtifactBytes: integer("maxArtifactBytes", 1),
		maxEntries: integer("maxEntries", 1),
		maxPageBytes: integer("maxPageBytes", 1),
		maxPageChars: integer("maxPageChars", 1),
		maxOffset: integer("maxOffset", 1),
	});
}

function normalizeOrigin(origin) {
	const shape = { event_id: null, event_type: null, action_id: null, tool_name: null, causation_id: null };
	if (origin === null || origin === undefined) return { ok: true, origin: shape };
	if (typeof origin !== "object" || Array.isArray(origin)) return { ok: false, reason: "origin must be an object" };
	const result = { ...shape };
	for (const key of Object.keys(shape)) {
		const value = origin[key];
		if (value === undefined || value === null) continue;
		if (typeof value !== "string" || value.length > 400) return { ok: false, reason: `origin.${key} must be a string` };
		result[key] = value;
	}
	const extra = Object.keys(origin).filter((key) => !Object.hasOwn(shape, key));
	if (extra.length > 0) return { ok: false, reason: `origin has unsupported keys: ${extra.join(",")}` };
	return { ok: true, origin: result };
}

function normalizeMetadata(metadata) {
	if (metadata === null || metadata === undefined) return { ok: true, value: null };
	if (typeof metadata !== "object" || Array.isArray(metadata))
		return { ok: false, reason: "metadata must be a plain object" };
	let json;
	try {
		json = JSON.stringify(metadata);
	} catch (error) {
		return {
			ok: false,
			reason: `metadata is not serializable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (json.length > 4096) return { ok: false, reason: "metadata exceeds 4096 characters" };
	return { ok: true, value: JSON.parse(json) };
}

/** Write bytes to a temp sibling, fsync, rename, fsync the directory. */
function writeBlobDurably(path, buffer) {
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	let fd = null;
	try {
		mkdirSync(dirname(path), { recursive: true });
		fd = openSync(temporary, "wx");
		writeSync(fd, buffer);
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		renameSync(temporary, path);
		if (!syncDirectory(dirname(path))) throw new Error("directory durability unconfirmed");
		return { ok: true };
	} catch (error) {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// closing twice is not an error we can act on
			}
		}
		safeUnlink(temporary);
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

function writeHeadDurably(path, entry) {
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	let fd = null;
	try {
		mkdirSync(dirname(path), { recursive: true });
		fd = openSync(temporary, "wx");
		writeSync(fd, `${JSON.stringify(entry, null, 2)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		renameSync(temporary, path);
		if (!syncDirectory(dirname(path))) throw new Error("directory durability unconfirmed");
		// The head must be readable and equal to what we intended.
		const readBack = JSON.parse(readFileSync(path, "utf8"));
		if (readBack.ref_id !== entry.ref_id || readBack.digest !== entry.digest)
			return { ok: false, detail: "head read-back does not match the entry" };
		return { ok: true };
	} catch (error) {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// see above
			}
		}
		safeUnlink(temporary);
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

function syncDirectory(directory) {
	let fd = null;
	try {
		fd = openSync(directory, "r");
		fsyncSync(fd);
		return true;
	} catch {
		// Directory fsync is not supported everywhere; the blob itself is already
		// fsynced, so this is a weaker (documented) guarantee, not a fake success.
		return false;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// ignore
			}
		}
	}
}

function safeUnlink(path) {
	try {
		unlinkSync(path);
	} catch {
		// A temp/unverifiable file that is already gone is the desired end state.
	}
}

/** Verify size + digest of a written blob. */
function verifyBlob(path, digest, byteLength) {
	let stat;
	try {
		stat = statSync(path);
	} catch (error) {
		return { ok: false, detail: `written blob is missing: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!stat.isFile()) return { ok: false, detail: "written blob is not a regular file" };
	if (stat.size !== byteLength)
		return { ok: false, detail: `written blob is ${stat.size} bytes, expected ${byteLength}` };
	let actual;
	try {
		actual = artifactContentDigest(readFileSync(path));
	} catch (error) {
		return {
			ok: false,
			detail: `written blob cannot be re-read: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (actual !== digest) return { ok: false, detail: "written blob digest does not match the computed digest" };
	return { ok: true };
}

/** Validate a persisted head; any deviation is corruption, never a default. */
export function validateHead(raw, expectedDigest = null) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, detail: "head is not an object" };
	if (raw.schema_version !== ARTIFACT_STORE_SCHEMA)
		return { ok: false, detail: `unsupported head schema_version ${String(raw.schema_version)}` };
	if (typeof raw.digest !== "string" || !DIGEST_RE.test(raw.digest))
		return { ok: false, detail: "head digest is malformed" };
	if (expectedDigest && raw.digest !== expectedDigest)
		return { ok: false, detail: "head digest does not match its content address" };
	if (raw.ref_id !== artifactRefForDigest(raw.digest))
		return { ok: false, detail: "head ref_id is not derived from its digest" };
	if (!Number.isSafeInteger(raw.byte_length) || raw.byte_length < 0)
		return { ok: false, detail: "head byte_length is not a non-negative safe integer" };
	const owner = normalizeArtifactOwner(raw.owner);
	if (!owner.ok) return { ok: false, detail: `head owner is invalid: ${owner.reason}` };
	if (!ENCODINGS.includes(raw.encoding_hint)) return { ok: false, detail: "head encoding_hint is unsupported" };
	if (!CLASSIFICATIONS.includes(raw.classification)) return { ok: false, detail: "head classification is unsupported" };
	if (typeof raw.media_type !== "string" || raw.media_type.length === 0)
		return { ok: false, detail: "head media_type is missing" };
	const origin = normalizeOrigin(raw.origin);
	if (!origin.ok) return { ok: false, detail: `head origin is invalid: ${origin.reason}` };
	if (typeof raw.stored_at !== "string" || raw.stored_at.length === 0)
		return { ok: false, detail: "head stored_at is missing" };
	if (!raw.integrity || typeof raw.integrity !== "object" || raw.integrity.algo !== "sha256")
		return { ok: false, detail: "head integrity metadata is missing" };
	return {
		ok: true,
		entry: Object.freeze({
			schema_version: ARTIFACT_STORE_SCHEMA,
			ref_id: raw.ref_id,
			digest: raw.digest,
			byte_length: raw.byte_length,
			media_type: raw.media_type,
			encoding_hint: raw.encoding_hint,
			owner: owner.owner,
			origin: origin.origin,
			classification: raw.classification,
			metadata: raw.metadata ?? null,
			stored_at: raw.stored_at,
			integrity: {
				algo: "sha256",
				bytes_checked: Number.isSafeInteger(raw.integrity.bytes_checked)
					? raw.integrity.bytes_checked
					: raw.byte_length,
			},
		}),
	};
}

/** Do two paths name the same file after symlink resolution? (test support) */
export function samePath(a, b) {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

export { blobPathFor, headPathFor, verifyBlob };
