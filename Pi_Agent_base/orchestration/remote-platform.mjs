// Remote platform policy for the human-authorized browser adapter.
//
// This module does not perform network I/O, launch a browser, read credentials,
// or write Outcomes. It is the shared gate that a browser/platform adapter must
// call before touching the competition platform: exact-origin allowlist,
// sliding-window rate limits, one-shot submit/checker attempts, bounded
// attachment downloads, and a structured solved-state predicate.

import { basename, resolve, sep } from "node:path";

export const REMOTE_PLATFORM_VERSION = "1.0.0";

const DEFAULT_RATE = Object.freeze({
	perMinute: 2,
	perFiveMinutes: 8,
	minIntervalMs: 30_000,
});
const DEFAULT_DOWNLOAD = Object.freeze({
	maxFileBytes: 64 * 1024 * 1024,
	maxTotalBytes: 256 * 1024 * 1024,
	maxFiles: 20,
});
const PLATFORM_ACTIONS = new Set(["login", "list", "open", "navigation", "download", "submit", "checker"]);
const REPLAY_ONCE_ACTIONS = new Set(["submit", "checker"]);

function normalizeOrigin(value) {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const parsed = new URL(value);
		if (!["http:", "https:"].includes(parsed.protocol)) return null;
		return parsed.origin;
	} catch {
		return null;
	}
}

function positiveInteger(value, fallback) {
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value, fallback) {
	return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function validatePlatformUrl(value) {
	if (typeof value !== "string" || !value.trim()) return { ok: false, reason: "url_required" };
	let parsed;
	try {
		parsed = new URL(value.trim());
	} catch {
		return { ok: false, reason: "invalid_url" };
	}
	if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, reason: "unsupported_protocol" };
	if (parsed.username || parsed.password) return { ok: false, reason: "credentials_in_url_forbidden" };
	return { ok: true, url: parsed.href, origin: parsed.origin };
}

/** Keep downloaded files inside a dedicated root and strip path components. */
export function sanitizeDownloadName(name) {
	const raw = typeof name === "string" ? name : "download";
	const base = basename(raw)
		.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
		.trim();
	if (!base || base === "." || base === "..") return "download";
	return base.slice(0, 180);
}

export function resolveDownloadPath(root, name) {
	const safeName = sanitizeDownloadName(name);
	const rootPath = resolve(root);
	const target = resolve(rootPath, safeName);
	if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`))
		throw new Error("download path escapes the quarantine root");
	return { filename: safeName, path: target };
}

/**
 * Create one gate per platform/account/run. The caller must call `admit` before
 * every browser/platform action and `authorizeDownload` before saving an
 * attachment. The gate counts failed actions too; retries are not free.
 */
export function createRemotePlatformGate({
	origins = [],
	now = () => Date.now(),
	perMinute = DEFAULT_RATE.perMinute,
	perFiveMinutes = DEFAULT_RATE.perFiveMinutes,
	minIntervalMs = DEFAULT_RATE.minIntervalMs,
	downloads = DEFAULT_DOWNLOAD,
} = {}) {
	const allowed = new Set((Array.isArray(origins) ? origins : []).map(normalizeOrigin).filter(Boolean));
	const clock = typeof now === "function" ? now : () => Date.now();
	const minuteLimit = positiveInteger(perMinute, DEFAULT_RATE.perMinute);
	const fiveMinuteLimit = positiveInteger(perFiveMinutes, DEFAULT_RATE.perFiveMinutes);
	const minimumInterval = nonNegativeInteger(minIntervalMs, DEFAULT_RATE.minIntervalMs);
	const maxFileBytes = positiveInteger(downloads?.maxFileBytes, DEFAULT_DOWNLOAD.maxFileBytes);
	const maxTotalBytes = positiveInteger(downloads?.maxTotalBytes, DEFAULT_DOWNLOAD.maxTotalBytes);
	const maxFiles = positiveInteger(downloads?.maxFiles, DEFAULT_DOWNLOAD.maxFiles);
	const events = [];
	const attempted = new Set();
	const downloadUsage = { files: 0, bytes: 0 };

	function originAllowed(value) {
		const origin = normalizeOrigin(value);
		return origin !== null && allowed.has(origin);
	}

	function prune(t) {
		while (events.length > 0 && t - events[0].at >= 300_000) events.shift();
	}

	function stats() {
		const t = clock();
		prune(t);
		return {
			events: events.length,
			firstAt: events[0]?.at ?? null,
			lastAt: events.at(-1)?.at ?? null,
			downloads: { ...downloadUsage },
		};
	}

	function admit(action = {}) {
		const kind = typeof action.kind === "string" ? action.kind : "";
		const origin = action.origin;
		if (!PLATFORM_ACTIONS.has(kind)) return { ok: false, reason: "unknown_platform_action" };
		if (!originAllowed(origin)) return { ok: false, reason: "origin_not_allowed" };
		if (action.replay === true) return { ok: false, reason: "replay_forbidden" };

		const key = typeof action.key === "string" && action.key ? action.key : null;
		if (REPLAY_ONCE_ACTIONS.has(kind)) {
			if (!key) return { ok: false, reason: "action_key_required" };
			if (attempted.has(`${kind}:${key}`)) return { ok: false, reason: "duplicate_action" };
		}

		const t = clock();
		prune(t);
		const last = events.at(-1);
		if (last && t - last.at < minimumInterval) {
			return { ok: false, reason: "min_interval", nextAllowedAt: last.at + minimumInterval };
		}
		const recentMinute = events.filter((event) => t - event.at < 60_000).length;
		if (recentMinute >= minuteLimit) {
			return { ok: false, reason: "minute_limit", nextAllowedAt: events[0].at + 60_000 };
		}
		if (events.length >= fiveMinuteLimit) {
			return { ok: false, reason: "five_minute_limit", nextAllowedAt: events[0].at + 300_000 };
		}

		events.push({ at: t, kind });
		if (REPLAY_ONCE_ACTIONS.has(kind)) attempted.add(`${kind}:${key}`);
		return {
			ok: true,
			at: t,
			remaining: { minute: minuteLimit - recentMinute - 1, fiveMinutes: fiveMinuteLimit - events.length },
		};
	}

	/**
	 * Reserve one attachment download before writing it. The caller must pass
	 * the exact bytes it is about to save; a failed download still consumes the
	 * reservation, preventing retry floods.
	 */
	function authorizeDownload({ url, filename, bytes, root }) {
		if (!originAllowed(url)) return { ok: false, reason: "origin_not_allowed" };
		if (!Number.isSafeInteger(bytes) || bytes < 0) return { ok: false, reason: "invalid_download_size" };
		if (bytes > maxFileBytes) return { ok: false, reason: "file_size_limit" };
		if (downloadUsage.files + 1 > maxFiles) return { ok: false, reason: "file_count_limit" };
		if (downloadUsage.bytes + bytes > maxTotalBytes) return { ok: false, reason: "total_size_limit" };
		let resolved;
		try {
			resolved = resolveDownloadPath(root, filename);
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : "invalid_download_path" };
		}
		downloadUsage.files += 1;
		downloadUsage.bytes += bytes;
		return { ok: true, ...resolved, bytes };
	}

	return {
		version: REMOTE_PLATFORM_VERSION,
		origins: [...allowed],
		originAllowed,
		admit,
		authorizeDownload,
		sanitizeDownloadName,
		stats,
	};
}

/**
 * Structured platform success predicate. The adapter must set `accepted` only
 * from the platform's known submission response/API, and must provide the
 * before/after challenge status. Arbitrary page text is not enough.
 *
 * Required evidence:
 * - same allowed platform origin
 * - same challenge id in the response
 * - before status was not already solved
 * - after status is solved
 * - submission was accepted
 */
export function evaluatePlatformSuccess({
	origin,
	origins = [],
	challengeId,
	beforeStatus,
	afterStatus,
	accepted,
	responseChallengeId = challengeId,
	evidence = null,
} = {}) {
	const allowed = new Set((Array.isArray(origins) ? origins : []).map(normalizeOrigin).filter(Boolean));
	const actualOrigin = normalizeOrigin(origin);
	if (!actualOrigin || !allowed.has(actualOrigin)) return { ok: false, reason: "origin_not_allowed" };
	if (typeof challengeId !== "string" || !challengeId) return { ok: false, reason: "challenge_id_required" };
	if (responseChallengeId !== challengeId) return { ok: false, reason: "challenge_mismatch" };
	if (beforeStatus === "solved") return { ok: false, reason: "already_solved" };
	if (typeof beforeStatus !== "string" || !beforeStatus || beforeStatus === "unknown")
		return { ok: false, reason: "before_status_required" };
	if (afterStatus !== "solved") return { ok: false, reason: "solved_status_not_observed" };
	if (accepted !== true) return { ok: false, reason: "submission_not_accepted" };
	return {
		ok: true,
		evidence: {
			origin: actualOrigin,
			challenge_id: challengeId,
			before_status: beforeStatus,
			after_status: afterStatus,
			accepted: true,
			...(evidence && typeof evidence === "object" ? { evidence } : {}),
		},
	};
}
