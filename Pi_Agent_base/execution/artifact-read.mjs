// Aegis — controlled artifact readback (MEM-02 §5.2).
//
// `shared/artifact-store.mjs` persists bytes and rebuilds heads. This module is
// the ONLY read surface a caller (tool, Observer, observation view) should use.
//
// The trust boundary, stated as rules:
//
//   1. The request carries a REGISTERED ref, a byte offset, a limit and an
//      encoding. It cannot carry a path, a directory, a URL, an owner, or a
//      digest override. Unknown keys are refused (no "extra fields ignored").
//   2. The identity/authorization used for the ownership check comes from
//      `principal()`, a TRUSTED host callback — never from the request payload
//      and never from the model.
//   3. A read is bounded three ways: the page size, the rendered character
//      budget, and a per-session byte/page budget. Exceeding a budget is an
//      explicit `budget_exceeded`, and a failed read does not consume budget.
//   4. Offsets are BYTE offsets. For `utf8`, a page always starts and ends on a
//      UTF-8 character boundary, so concatenating consecutive pages reproduces
//      the original text exactly (no dropped or duplicated characters). For
//      `base64`, the range is the exact byte range.
//   5. A read grants nothing: `grants` is always all-false and no event is
//      appended. Reading bytes is not a Fact, not an Outcome, not a permit.

import {
	artifactOwnerMatches,
	isArtifactRef,
	normalizeArtifactOwner,
	normalizeRange,
} from "../shared/artifact-store.mjs";

/** Read result schema marker. */
export const ARTIFACT_READ_SCHEMA = "artifact-read-1.0";

/** Bounded defaults, all enforced. */
export const DEFAULT_READ_LIMITS = Object.freeze({
	maxPageBytes: 32 * 1024,
	maxPageChars: 64 * 1024,
	maxBytesPerSession: 512 * 1024,
	maxPagesPerSession: 64,
});

/** The closed set of refusal reasons. A caller can branch on these. */
export const READ_REASONS = Object.freeze([
	"invalid_request",
	"unauthorized",
	"unknown_principal",
	"foreign",
	"missing",
	"corrupt",
	"symlink",
	"out_of_bounds",
	"budget_exceeded",
	"unsupported_encoding",
	"internal_error",
]);

const ALLOWED_REQUEST_KEYS = Object.freeze(["ref_id", "offset", "limit", "encoding", "basis"]);
const ENCODINGS = Object.freeze(["utf8", "base64"]);
const NO_GRANTS = Object.freeze({ fact: false, outcome: false, permission: false, budget: false });

/**
 * @param {object} options
 * @param {ReturnType<import("../shared/artifact-store.mjs").createArtifactStore>} options.store
 * @param {Partial<typeof DEFAULT_READ_LIMITS>} [options.limits]
 * @param {() => (object|Promise<object>)} options.principal   trusted current identity/authorization
 * @param {(event: {type: string, detail?: string}) => void} [options.onDiagnostic]
 * @param {(dir: string) => string[]} [options.readdir]        injectable listing (tests prove control flow)
 */
export function createArtifactReader({ store, limits = {}, principal, onDiagnostic = null, readdir = null } = {}) {
	if (!store || typeof store.readBytes !== "function" || typeof store.head !== "function") {
		throw new Error("createArtifactReader requires an artifact store");
	}
	if (typeof principal !== "function") throw new Error("createArtifactReader requires a trusted principal() callback");
	const effective = validateReadLimits({ ...DEFAULT_READ_LIMITS, ...limits });
	const usage = { bytes: 0, pages: 0 };
	const diagnostic = (type, detail) => {
		if (typeof onDiagnostic === "function") onDiagnostic({ type, detail });
	};

	/** Reset the per-session counters (a new session/Episode gets a new reader). */
	function reset() {
		usage.bytes = 0;
		usage.pages = 0;
		return usageSnapshot();
	}

	function usageSnapshot() {
		return {
			session_bytes_used: usage.bytes,
			session_pages_used: usage.pages,
			max_bytes: effective.maxBytesPerSession,
			max_pages: effective.maxPagesPerSession,
			bytes_remaining: Math.max(0, effective.maxBytesPerSession - usage.bytes),
			pages_remaining: Math.max(0, effective.maxPagesPerSession - usage.pages),
		};
	}

	/**
	 * Read a page of a registered artifact.
	 *
	 * @param {{ref_id: string, offset?: number, limit?: number, encoding?: "utf8"|"base64", basis?: string}} request
	 * @returns {Promise<object>} ReadResult (see contracts.md §2.2)
	 */
	async function read(request) {
		const rejected = validateRequest(request);
		if (!rejected.ok) return refusal("invalid_request", rejected.detail, request);
		const encoding = rejected.encoding;

		let context;
		try {
			context = await principal();
		} catch (error) {
			return refusal(
				"unknown_principal",
				`principal lookup failed: ${error instanceof Error ? error.message : String(error)}`,
				request,
			);
		}
		const principalResult = normalizePrincipal(context);
		if (!principalResult.ok) return refusal(principalResult.reason, principalResult.detail, request);
		const who = principalResult.principal;

		const head = store.head({ ref_id: rejected.ref_id });
		if (!head.ok) {
			// The store's own reasons are a subset of ours; pass through unknown ones
			// as `missing` only after recording the actual diagnostic.
			const reason = READ_REASONS.includes(head.reason) ? head.reason : "internal_error";
			diagnostic("artifact.read-head", `${rejected.ref_id}: ${head.reason} ${head.detail}`);
			return refusal(reason, head.detail ?? "artifact is unavailable", request);
		}
		const entry = head.entry;

		// Ownership first: a foreign ref must not leak size, digest or provenance.
		if (!artifactOwnerMatches(entry.owner, who.owner)) {
			return refusal("foreign", "artifact is not owned by the current task/episode", request);
		}
		if (who.artifactRefs !== null && !who.artifactRefs.includes(rejected.ref_id)) {
			return refusal("foreign", "artifact ref is outside the current authorization set", request);
		}

		// Bounds and budgets are checked BEFORE any bytes are requested.
		const range = normalizeRange({ offset: rejected.offset, limit: rejected.limit, byte_length: entry.byte_length });
		if (!range.ok) return refusal(range.reason, range.detail, request, { entry });

		const pageBudget = Math.min(effective.maxPageBytes, who.budget.maxBytes ?? effective.maxPageBytes);
		const pageLimit = Math.min(rejected.limit, pageBudget);
		const clampedBytes = pageLimit < rejected.limit;
		if (usage.pages + 1 > Math.min(effective.maxPagesPerSession, who.budget.maxPages ?? effective.maxPagesPerSession)) {
			return refusal("budget_exceeded", "session page budget exhausted", request, { entry });
		}
		const requestedBytes = Math.min(pageLimit, Math.max(0, entry.byte_length - range.offset));
		if (
			usage.bytes + requestedBytes >
			Math.min(effective.maxBytesPerSession, who.budget.maxBytesTotal ?? effective.maxBytesPerSession)
		) {
			return refusal("budget_exceeded", "session byte budget exhausted", request, { entry });
		}

		// Normalize a utf8 start offset onto a character boundary. Reading the
		// preceding (at most 3) bytes is what lets an offset that lands inside a
		// multi-byte character snap BACK to that character's lead byte instead of
		// silently dropping the character. base64 keeps the exact byte offset.
		let readOffset = range.offset;
		let alignBack = 0;
		const pageLimitBytes = pageLimit;
		if (encoding === "utf8" && range.offset > 0) {
			const back = Math.min(3, range.offset);
			const leading = store.readBytes({ ref_id: rejected.ref_id, offset: range.offset - back, limit: back + 1 });
			if (leading.ok && (leading.bytes[back] & 0xc0) === 0x80) {
				let index = back;
				while (index > 0 && (leading.bytes[index] & 0xc0) === 0x80) index--;
				alignBack = back - index;
			}
		}
		if (alignBack > 0) {
			// The requested offset fell inside a multi-byte character: the page starts
			// at that character's lead byte and the limit counts from THAT boundary.
			readOffset = range.offset - alignBack;
		}

		// Bounded store read. `readBytes` re-verifies the whole blob digest.
		const bounded = store.readBytes({ ref_id: rejected.ref_id, offset: readOffset, limit: pageLimitBytes });
		if (!bounded.ok) {
			const reason = READ_REASONS.includes(bounded.reason) ? bounded.reason : "internal_error";
			diagnostic("artifact.read-bytes", `${rejected.ref_id}: ${bounded.reason} ${bounded.detail}`);
			return refusal(reason, bounded.detail ?? "artifact bytes are unavailable", request, { entry });
		}

		// `alignBack > 0` means the requested offset fell inside a character; the
		// page deliberately starts earlier so the character is returned whole.
		const page = encodePage({
			bytes: bounded.bytes,
			entry,
			offset: bounded.offset,
			encoding,
			maxChars: effective.maxPageChars,
		});
		if (!page.ok) return refusal(page.reason, page.detail, request, { entry });

		if (page.page.byte_length === 0 && page.page.end_offset < entry.byte_length) {
			// The requested offset landed inside a character that does not fit the
			// remaining byte budget. Returning an empty page whose `next_offset` equals
			// its own offset would loop forever, so this is an explicit budget refusal
			// (the page cannot be produced inside the configured limit).
			return refusal("budget_exceeded", "the next character does not fit the remaining page budget", request, {
				entry,
			});
		}

		usage.pages += 1;
		usage.bytes += page.page.byte_length;

		const hasMore = page.page.end_offset < entry.byte_length;
		return {
			ok: true,
			schema_version: ARTIFACT_READ_SCHEMA,
			ref_id: entry.ref_id,
			digest: entry.digest,
			media_type: entry.media_type,
			classification: entry.classification,
			owner: { ...entry.owner },
			origin: { ...entry.origin },
			encoding,
			offset: range.offset,
			limit: rejected.limit,
			byte_length: entry.byte_length,
			page: page.page,
			pagination: {
				has_more: hasMore,
				next_offset: hasMore ? page.page.end_offset : null,
				prev_offset: page.page.offset > 0 ? page.page.offset : null,
				total_pages_hint: page.page.byte_length > 0 ? Math.ceil(entry.byte_length / page.page.byte_length) : null,
				aligned_back_bytes: alignBack,
				next_page_limit: pageLimit,
				clamped: { bytes: clampedBytes, chars: page.page.char_clamped === true },
				state: usageSnapshot(),
			},
			integrity: { verified: true, bytes_checked: entry.byte_length, digest_checked: "full" },
			diagnostic: page.page.char_clamped === true ? "page shortened to respect the character budget" : null,
			grants: { ...NO_GRANTS },
		};
	}

	/**
	 * Head-only metadata view (no bytes, still owner- and auth-checked). Useful for
	 * a prompt that wants "this result exists and is N bytes" without paying for
	 * a page.
	 *
	 * @param {{ref_id: string}} request
	 */
	async function stat(request) {
		const rejected = validateStatRequest(request);
		if (!rejected.ok) return refusal("invalid_request", rejected.detail, request);
		let context;
		try {
			context = await principal();
		} catch (error) {
			return refusal(
				"unknown_principal",
				`principal lookup failed: ${error instanceof Error ? error.message : String(error)}`,
				request,
			);
		}
		const principalResult = normalizePrincipal(context);
		if (!principalResult.ok) return refusal(principalResult.reason, principalResult.detail, request);
		const who = principalResult.principal;
		const head = store.head({ ref_id: rejected.ref_id });
		if (!head.ok) {
			const reason = READ_REASONS.includes(head.reason) ? head.reason : "internal_error";
			return refusal(reason, head.detail ?? "artifact is unavailable", request);
		}
		const entry = head.entry;
		if (!artifactOwnerMatches(entry.owner, who.owner))
			return refusal("foreign", "artifact is not owned by the current task/episode", request);
		if (who.artifactRefs !== null && !who.artifactRefs.includes(rejected.ref_id)) {
			return refusal("foreign", "artifact ref is outside the current authorization set", request);
		}
		return {
			ok: true,
			schema_version: ARTIFACT_READ_SCHEMA,
			ref_id: entry.ref_id,
			digest: entry.digest,
			media_type: entry.media_type,
			encoding_hint: entry.encoding_hint,
			classification: entry.classification,
			owner: { ...entry.owner },
			origin: { ...entry.origin },
			byte_length: entry.byte_length,
			stored_at: entry.stored_at,
			grants: { ...NO_GRANTS },
		};
	}

	return { read, stat, reset, usage: usageSnapshot, limits: effective };
}

/** Strict request validator: unknown keys and non-primitive types are refused. */
export function validateRequest(request) {
	if (!request || typeof request !== "object" || Array.isArray(request))
		return { ok: false, detail: "request must be a plain object" };
	const keys = Object.keys(request);
	const unknown = keys.filter((key) => !ALLOWED_REQUEST_KEYS.includes(key));
	if (unknown.length > 0) return { ok: false, detail: `unsupported request keys: ${unknown.sort().join(",")}` };
	if (!isArtifactRef(request.ref_id)) return { ok: false, detail: "ref_id must be a registered artifact ref" };
	const offset = request.offset === undefined ? 0 : request.offset;
	const limit = request.limit === undefined ? DEFAULT_READ_LIMITS.maxPageBytes : request.limit;
	if (!Number.isSafeInteger(offset) || offset < 0)
		return { ok: false, detail: "offset must be a non-negative safe integer" };
	if (!Number.isSafeInteger(limit) || limit < 1) return { ok: false, detail: "limit must be a positive safe integer" };
	const encoding = request.encoding === undefined ? "utf8" : request.encoding;
	if (!ENCODINGS.includes(encoding)) return { ok: false, detail: `encoding must be one of ${ENCODINGS.join(", ")}` };
	if (request.basis !== undefined && (typeof request.basis !== "string" || request.basis.length > 400))
		return { ok: false, detail: "basis must be a string" };
	return { ok: true, ref_id: request.ref_id, offset, limit, encoding, basis: request.basis ?? null };
}

function validateStatRequest(request) {
	if (!request || typeof request !== "object" || Array.isArray(request))
		return { ok: false, detail: "request must be a plain object" };
	const keys = Object.keys(request);
	const unknown = keys.filter((key) => key !== "ref_id");
	if (unknown.length > 0) return { ok: false, detail: `unsupported request keys: ${unknown.sort().join(",")}` };
	if (!isArtifactRef(request.ref_id)) return { ok: false, detail: "ref_id must be a registered artifact ref" };
	return { ok: true, ref_id: request.ref_id };
}

/**
 * Shape the trusted principal. Missing `authorization.read === true` is a
 * denial, not a default-allow; a missing task/episode is not a wildcard.
 */
export function normalizePrincipal(context) {
	if (!context || typeof context !== "object" || Array.isArray(context))
		return { ok: false, reason: "unknown_principal", detail: "principal context is missing" };
	const owner = normalizeArtifactOwner({
		task_id: context.task_id,
		episode_id: context.episode_id,
		campaign_id: context.campaign_id,
		session_id: context.session_id,
	});
	if (!owner.ok) return { ok: false, reason: "unknown_principal", detail: owner.reason };
	const authorization = context.authorization;
	if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) {
		return { ok: false, reason: "unauthorized", detail: "authorization is missing" };
	}
	if (authorization.read !== true)
		return { ok: false, reason: "unauthorized", detail: "authorization.read is not granted" };
	let artifactRefs = null;
	if (authorization.artifact_refs !== undefined && authorization.artifact_refs !== null) {
		if (!Array.isArray(authorization.artifact_refs))
			return { ok: false, reason: "unauthorized", detail: "authorization.artifact_refs must be an array" };
		for (const ref of authorization.artifact_refs) {
			if (!isArtifactRef(ref))
				return { ok: false, reason: "unauthorized", detail: "authorization.artifact_refs contains an invalid ref" };
		}
		artifactRefs = [...new Set(authorization.artifact_refs)];
	}
	const budget = {};
	if (context.budget !== undefined && context.budget !== null) {
		if (typeof context.budget !== "object" || Array.isArray(context.budget))
			return { ok: false, reason: "unknown_principal", detail: "budget must be an object" };
		for (const [key, value] of Object.entries(context.budget)) {
			if (value === undefined || value === null) continue;
			if (!Number.isSafeInteger(value) || value < 0)
				return { ok: false, reason: "unknown_principal", detail: `budget.${key} must be a non-negative safe integer` };
			budget[key] = value;
		}
	}
	return { ok: true, principal: { owner: owner.owner, artifactRefs, budget } };
}

/**
 * Render one page. For `utf8` the page is trimmed to a character boundary and,
 * when the character budget is smaller than the byte budget, to whole code
 * points. `char_offset`/`char_end_offset` are UTF-16 code-unit indices into the
 * decoded text (documented, and consistent across pages of one artifact).
 */
export function encodePage({ bytes, entry, offset, encoding, maxChars }) {
	if (encoding === "base64") {
		const limit = Math.min(bytes.byteLength, Math.floor(maxChars / 4) * 3);
		const slice = limit < bytes.byteLength ? bytes.subarray(0, limit) : bytes;
		return {
			ok: true,
			page: {
				offset,
				end_offset: offset + slice.byteLength,
				byte_length: slice.byteLength,
				bytes_aligned: true,
				char_offset: null,
				char_end_offset: null,
				text: slice.toString("base64"),
				encoding,
				char_clamped: slice.byteLength !== bytes.byteLength,
			},
		};
	}
	// Trim a trailing incomplete UTF-8 sequence instead of emitting U+FFFD: the
	// next page starts exactly there, so no character is lost or duplicated.
	const aligned = trimToUtf8Boundary(bytes);
	const text = aligned.toString("utf8");
	if (text.includes("\uFFFD") && !hasLiteralReplacementCharacter(aligned)) {
		return { ok: false, reason: "corrupt", detail: 'artifact bytes are not valid UTF-8; request encoding "base64"' };
	}
	let shown = text;
	let charClamped = false;
	if (shown.length > maxChars) {
		// Cut on a code-point boundary, not in the middle of a surrogate pair.
		let cut = maxChars;
		if (cut > 0 && isHighSurrogate(shown.charCodeAt(cut - 1))) cut -= 1;
		shown = shown.slice(0, cut);
		charClamped = true;
		const shownBytes = Buffer.byteLength(shown, "utf8");
		return {
			ok: true,
			page: {
				offset,
				end_offset: offset + shownBytes,
				byte_length: shownBytes,
				bytes_aligned: true,
				char_offset: null,
				char_end_offset: null,
				text: shown,
				encoding,
				char_clamped: true,
			},
		};
	}
	return {
		ok: true,
		page: {
			offset,
			end_offset: offset + aligned.byteLength,
			byte_length: aligned.byteLength,
			bytes_aligned: aligned.byteLength === bytes.byteLength,
			char_offset: null,
			char_end_offset: null,
			text: shown,
			encoding,
			char_clamped: charClamped,
		},
	};
}

/**
 * Drop a trailing partial UTF-8 sequence.
 *
 * Given a byte slice that may end mid-character, walk back to the last lead
 * byte and keep it only when the full sequence it announces is present. This is
 * what makes consecutive `utf8` pages lossless: the incomplete tail is not
 * returned, and the next page starts exactly at its lead byte.
 */
export function trimToUtf8Boundary(bytes) {
	const length = bytes.byteLength;
	if (length === 0) return bytes;
	// Walk back over at most three continuation bytes to the lead byte.
	let lead = length - 1;
	let back = 0;
	while (lead >= 0 && back < 3 && (bytes[lead] & 0xc0) === 0x80) {
		lead -= 1;
		back += 1;
	}
	if (lead < 0) return bytes.subarray(0, 0);
	const byte = bytes[lead];
	const need =
		byte < 0x80 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
	const available = length - lead;
	if (available >= need) return bytes;
	return bytes.subarray(0, lead);
}

function hasLiteralReplacementCharacter(bytes) {
	return bytes.includes(Buffer.from("\uFFFD", "utf8"));
}

function isHighSurrogate(code) {
	return code >= 0xd800 && code <= 0xdbff;
}

function refusal(reason, detail, request, extra = {}) {
	const result = {
		ok: false,
		schema_version: ARTIFACT_READ_SCHEMA,
		reason,
		detail: String(detail ?? ""),
		ref_id: typeof request?.ref_id === "string" ? request.ref_id : null,
		redacted: true,
		grants: { ...NO_GRANTS },
	};
	if (extra.entry) {
		// Size only: a refusal never includes digest, excerpt or bytes.
		result.byte_length = extra.entry.byte_length;
		result.offset = Number.isSafeInteger(request?.offset) ? request.offset : null;
		result.limit = Number.isSafeInteger(request?.limit) ? request.limit : null;
	}
	return result;
}

function validateReadLimits(limits) {
	const integer = (name, minimum) => {
		const value = limits[name];
		if (!Number.isSafeInteger(value) || value < minimum)
			throw new Error(`artifact read limits.${name} must be a safe integer >= ${minimum}`);
		return value;
	};
	return Object.freeze({
		maxPageBytes: integer("maxPageBytes", 1),
		maxPageChars: integer("maxPageChars", 1),
		maxBytesPerSession: integer("maxBytesPerSession", 1),
		maxPagesPerSession: integer("maxPagesPerSession", 1),
	});
}
