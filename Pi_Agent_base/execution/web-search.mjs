// Aegis web search: a bounded technique/CVE reference lookup, never a task oracle.
//
// The local knowledge corpus cannot cover every CTF technique. This module adds
// ONE fallback: the operator's DeepSeek Search API, used for technique-level
// references (PHP disable_functions, CVE-2021-4034, GTFOBins, ...). It is NOT a
// way to fetch the current challenge's write-up:
//
//   * the current target/challenge tokens (hosts, domains, task id, WP slugs
//     seen in committed actions, AEGIS_SEARCH_DENY) are refused in the query;
//   * results whose URL/title/snippet names those tokens are dropped;
//   * `writeup`/`wp`/`题解`/`复现` is only allowed with purpose=similar-task;
//   * only summary/snippet are returned, never full page content;
//   * every attempt is bounded per Episode and recorded as a runtime.note.
//
// Results are unverified reference data (`verified=false`, `action_policy=none`).
// They cannot create Facts, authorize actions, or replace the target's own
// observations. The model must verify a technique on the real target.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const WEB_SEARCH_VERSION = "1.0.0";
export const DEFAULT_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
export const SEARCH_PURPOSES = Object.freeze(["technique", "cve", "tool", "similar-task"]);
export const MAX_QUERY_CHARS = 128;
export const MAX_COUNT = 10;
export const MAX_SUMMARY_CHARS = 800;
export const MAX_RESULT_TITLE = 240;
export const MAX_RESULT_URL = 2048;
const MAX_EVENT_SCAN = 20_000;

const HTTP_REASONS = Object.freeze({
	400: "invalid_request",
	401: "invalid_api_key",
	402: "insufficient_balance",
	403: "search_denied",
	404: "no_content",
	408: "timeout",
	413: "request_too_large",
	429: "rate_limited",
	500: "server_error",
	504: "upstream_timeout",
});

function bounded(value, limit) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit);
}

function normalizeToken(value) {
	if (typeof value !== "string") return "";
	return value.trim().toLowerCase();
}

/** A conservative registrable domain: example.com, example.co.uk, example.com.cn. */
export function registrableDomain(host) {
	const value = normalizeToken(host).replace(/^\[|\]$/g, "");
	if (!value || value.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(value)) return value;
	const parts = value.split(".").filter(Boolean);
	if (parts.length <= 2) return parts.join(".");
	const twoLevelSuffixes = new Set(["co.uk", "org.uk", "ac.uk", "com.cn", "net.cn", "org.cn", "com.au", "co.jp"]);
	const lastTwo = parts.slice(-2).join(".");
	return twoLevelSuffixes.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

function extractUrls(text) {
	const matches = String(text ?? "").match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? [];
	return matches.map((value) => value.replace(/[.,;:!?，。；：！？）】]+$/u, ""));
}

function addUrlTokens(tokens, rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		return;
	}
	const host = normalizeToken(url.hostname).replace(/^www\./, "");
	if (!host) return;
	tokens.add(host);
	if (url.port) tokens.add(`${host}:${url.port}`);
	tokens.add(registrableDomain(host));
	for (const segment of url.pathname.split("/")) {
		const slug = normalizeToken(segment);
		if (!slug || slug.length < 6) continue;
		if (!/(ctf|web|pwn|crypto|reverse|misc|writeup|wp|20\d{2})/.test(slug)) continue;
		tokens.add(slug);
		for (const word of slug.split(/[^a-z0-9]+/)) {
			if (word.length >= 5 || /ctf|pwn|crypto|reverse|misc|rceme/.test(word)) tokens.add(word);
		}
	}
}

/**
 * Derive the tokens that must never appear in a search query or result.
 * Sources: the Episode goal, the task target, committed action/proposal payloads
 * (bounded), and the operator's AEGIS_SEARCH_DENY list.
 *
 * @returns {{tokens: string[]}}
 */
export function buildDenyTokens({ goal = "", targetRef = "", events = [], extra = [] } = {}) {
	const tokens = new Set();
	const add = (value) => {
		const token = normalizeToken(value);
		if (token.length >= 3 && token.length <= 200) tokens.add(token);
	};
	for (const value of [goal, targetRef]) {
		for (const url of extractUrls(value)) addUrlTokens(tokens, url);
		const bare = normalizeToken(value);
		if (/^[a-z0-9.-]+(?::\d+)?$/i.test(bare)) {
			add(bare);
			add(registrableDomain(bare.split(":")[0]));
		}
	}
	const extras = Array.isArray(extra) ? extra : String(extra ?? "").split(/[,\n]/);
	for (const value of extras) add(value);
	for (const event of Array.isArray(events) ? events : []) {
		if (
			!event ||
			!["episode.started", "action.requested", "action.completed", "proposal.submitted", "runtime.note"].includes(
				event.event_type,
			)
		)
			continue;
		let text = "";
		try {
			text = JSON.stringify(event.payload ?? {}).slice(0, MAX_EVENT_SCAN);
		} catch {
			continue;
		}
		for (const url of extractUrls(text)) addUrlTokens(tokens, url);
	}
	return { tokens: [...tokens].sort() };
}

/**
 * Validate one search request BEFORE any network call. This is the policy gate:
 * a refused request is auditable and consumes no paid call.
 */
export function validateSearchRequest({ query, purpose = "technique", count = 5, denyTokens = [] } = {}) {
	const text = typeof query === "string" ? query.trim() : "";
	if (!text) return { ok: false, status: "refused", reason: "query is required" };
	if (text.length > MAX_QUERY_CHARS)
		return { ok: false, status: "refused", reason: `query must be at most ${MAX_QUERY_CHARS} characters` };
	if (/[\u0000-\u001f]/u.test(text))
		return { ok: false, status: "refused", reason: "query must not contain control characters" };
	const chosen = typeof purpose === "string" ? purpose.trim() : "technique";
	if (!SEARCH_PURPOSES.includes(chosen))
		return {
			ok: false,
			status: "refused",
			reason: `purpose must be one of ${SEARCH_PURPOSES.join(", ")}`,
		};
	const requestedCount = count === undefined || count === null ? 5 : Number(count);
	if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > MAX_COUNT)
		return { ok: false, status: "refused", reason: `count must be an integer between 1 and ${MAX_COUNT}` };
	const lower = text.toLowerCase();
	const hits = (Array.isArray(denyTokens) ? denyTokens : [])
		.map(normalizeToken)
		.filter((token) => token.length >= 3 && lower.includes(token));
	if (hits.length > 0)
		return {
			ok: false,
			status: "refused",
			reason: "query names the current target/challenge; search for the technique instead",
		};
	const asksForWriteup = /\b(?:writeup|walkthrough|wp(?!-))\b|题解|复现/iu.test(text);
	if (asksForWriteup && chosen !== "similar-task")
		return {
			ok: false,
			status: "refused",
			reason: "write-up queries require purpose=similar-task and must not name this challenge",
		};
	return { ok: true, query: text, purpose: chosen, count: requestedCount };
}

/** Drop results that mention the current target/challenge. */
export function filterSearchResults(results, denyTokens = []) {
	const denied = new Set((Array.isArray(denyTokens) ? denyTokens : []).map(normalizeToken).filter(Boolean));
	const allowed = [];
	let dropped = 0;
	for (const row of Array.isArray(results) ? results : []) {
		if (!row || typeof row !== "object") {
			dropped += 1;
			continue;
		}
		const url = bounded(row.url, MAX_RESULT_URL);
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			dropped += 1;
			continue;
		}
		if (!["http:", "https:"].includes(parsed.protocol)) {
			dropped += 1;
			continue;
		}
		const host = normalizeToken(parsed.hostname).replace(/^www\./, "");
		const hostVariants = [host, registrableDomain(host)];
		if (parsed.port) hostVariants.push(`${host}:${parsed.port}`);
		if (hostVariants.some((value) => denied.has(value))) {
			dropped += 1;
			continue;
		}
		const text = [row.title, row.snippet, row.summary].filter((value) => typeof value === "string").join(" ").toLowerCase();
		if ([...denied].some((token) => text.includes(token))) {
			dropped += 1;
			continue;
		}
		allowed.push({
			title: bounded(row.title, MAX_RESULT_TITLE),
			url,
			snippet: bounded(row.snippet, 400),
			summary: bounded(row.summary, MAX_SUMMARY_CHARS),
			score: typeof row.rerank_score === "number" ? row.rerank_score : null,
			authority: Number.isInteger(row.authority) ? row.authority : -1,
			date: typeof row.date === "string" ? row.date : null,
			site_name: typeof row.site_name === "string" ? bounded(row.site_name, 120) : null,
		});
	}
	return { allowed, dropped };
}

function agentDirFromEnv(env = process.env) {
	if (typeof env.AEGIS_PI_AGENT_DIR === "string" && env.AEGIS_PI_AGENT_DIR) return env.AEGIS_PI_AGENT_DIR;
	const home = env.AEGIS_HOME || join(homedir(), ".Aegis");
	return join(home, "agent");
}

function isDeepSeekBaseUrl(value) {
	if (typeof value !== "string" || !value) return false;
	try {
		const host = new URL(value).hostname.toLowerCase();
		return host === "api.deepseek.com" || host.endsWith(".api.deepseek.com");
	} catch {
		return false;
	}
}

/**
 * Resolve the official DeepSeek key from the DEFAULT agent configuration.
 * Order: explicit search env vars, then the provider whose base URL is
 * api.deepseek.com in models.json + auth.json. Never reads ~/.pi and never
 * returns the key in an error/log message.
 */
export function resolveDeepSeekKey({ agentDir = null, env = process.env } = {}) {
	for (const name of ["AEGIS_SEARCH_API_KEY", "DEEPSEEK_API_KEY"]) {
		const value = env?.[name];
		if (typeof value === "string" && value.trim()) return { ok: true, key: value.trim(), source: `env:${name}` };
	}
	const dir = agentDir || agentDirFromEnv(env);
	let providers = {};
	let auth = {};
	try {
		providers = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers ?? {};
	} catch {
		// A missing/invalid models.json is not fatal: auth.json may still name the provider.
	}
	try {
		auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
	} catch {
		return { ok: false, reason: "no DeepSeek API key in env or agent auth.json" };
	}
	const deepSeekIds = Object.keys(providers).filter((id) => isDeepSeekBaseUrl(providers[id]?.baseUrl));
	const candidates = [...new Set(["deedeepseek", ...deepSeekIds])];
	for (const id of candidates) {
		const row = auth[id];
		if (row && typeof row.key === "string" && row.key.trim())
			return { ok: true, key: row.key.trim(), source: `agent:${id}` };
	}
	return { ok: false, reason: "no DeepSeek API key in env or agent auth.json" };
}

/** Read and bound the search configuration. Default is OFF. */
export function webSearchConfigFromEnv(env = process.env) {
	const enabled = ["1", "on", "true", "yes"].includes(String(env.AEGIS_WEB_SEARCH ?? "off").toLowerCase());
	const rawEndpoint = typeof env.AEGIS_SEARCH_ENDPOINT === "string" ? env.AEGIS_SEARCH_ENDPOINT.trim() : "";
	const endpoint = rawEndpoint || DEFAULT_SEARCH_ENDPOINT;
	let endpointOk = false;
	try {
		const parsed = new URL(endpoint);
		endpointOk = parsed.protocol === "https:";
	} catch {
		endpointOk = false;
	}
	const intInRange = (value, min, max, fallback) => {
		const parsed = Number(value);
		return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
	};
	return {
		enabled,
		endpoint,
		endpoint_ok: endpointOk,
		count: intInRange(env.AEGIS_SEARCH_COUNT, 1, MAX_COUNT, 5),
		maxCalls: intInRange(env.AEGIS_SEARCH_MAX_CALLS, 1, 50, 8),
		timeoutMs: intInRange(env.AEGIS_SEARCH_TIMEOUT_MS, 1_000, 60_000, 15_000),
		denyExtra: String(env.AEGIS_SEARCH_DENY ?? "")
			.split(/[,\n]/)
			.map((value) => value.trim())
			.filter(Boolean),
		agentDir: agentDirFromEnv(env),
	};
}

/** Paid attempts in this Episode (policy refusals do not consume the budget). */
export function countWebSearches(events, episodeId) {
	return (Array.isArray(events) ? events : []).filter(
		(event) =>
			event?.event_type === "runtime.note" &&
			event.episode_id === episodeId &&
			event.payload?.kind === "web.search" &&
			event.payload?.attempted === true,
	).length;
}

/**
 * One DeepSeek Search request. `fetchImpl` is injectable so tests never touch
 * the network. No retry: a 4xx/5xx is reported, not hidden.
 */
export async function searchWeb({
	query,
	purpose = "technique",
	count = 5,
	denyTokens = [],
	config,
	apiKey = null,
	keyInfo = null,
	fetchImpl = globalThis.fetch,
} = {}) {
	const checked = validateSearchRequest({ query, purpose, count, denyTokens });
	if (!checked.ok) return { ...checked, attempted: false };
	if (!config || config.enabled !== true)
		return { ok: false, status: "disabled", reason: "web search is disabled (AEGIS_WEB_SEARCH=off)", attempted: false };
	if (!config.endpoint_ok)
		return { ok: false, status: "unconfigured", reason: "search endpoint must be an https URL", attempted: false };
	// Accept an injected key for tests, or resolve the default DeepSeek key.
	const key = apiKey
		? { ok: true, key: String(apiKey), source: "injected" }
		: (keyInfo ?? resolveDeepSeekKey({ agentDir: config.agentDir }));
	if (!key || key.ok !== true)
		return {
			ok: false,
			status: "unconfigured",
			reason: key?.reason ?? "no DeepSeek API key in env or agent auth.json",
			attempted: false,
		};
	if (typeof fetchImpl !== "function")
		return { ok: false, status: "unconfigured", reason: "no fetch implementation", attempted: false };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs);
	let response;
	try {
		response = await fetchImpl(config.endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key.key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query: checked.query, count: checked.count, need_content: false }),
			signal: controller.signal,
		});
	} catch (error) {
		const timedOut = error?.name === "AbortError";
		return {
			ok: false,
			status: timedOut ? "timeout" : "network_error",
			reason: timedOut ? "search request timed out" : "search request failed before a response",
			attempted: true,
		};
	} finally {
		clearTimeout(timer);
	}
	if (!response || typeof response.ok !== "boolean")
		return { ok: false, status: "network_error", reason: "search returned no HTTP response", attempted: true };
	if (!response.ok) {
		const code = Number(response.status);
		return {
			ok: false,
			status: `http_${code}`,
			reason: HTTP_REASONS[code] ?? "search request was refused",
			http_status: code,
			attempted: true,
		};
	}
	let body;
	try {
		body = await response.json();
	} catch {
		return { ok: false, status: "invalid_response", reason: "search response is not JSON", attempted: true };
	}
	const rows = Array.isArray(body?.results) ? body.results : [];
	const filtered = filterSearchResults(rows, denyTokens);
	return {
		ok: true,
		status: "ok",
		query: checked.query,
		purpose: checked.purpose,
		requested_count: checked.count,
		results: filtered.allowed,
		total: rows.length,
		filtered: filtered.dropped,
		source: "deepseek-search",
		endpoint_host: (() => {
			try {
				return new URL(config.endpoint).hostname;
			} catch {
				return null;
			}
		})(),
		key_source: key.source,
		attempted: true,
	};
}
