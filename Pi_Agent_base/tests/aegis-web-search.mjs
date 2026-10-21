// Web search contract: technique-only lookup with a target/challenge denylist.
// No network: every request uses an injected fetch. No real key is read.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectBoard } from "../memory/board.mjs";
import {
	buildDenyTokens,
	countWebSearches,
	DEFAULT_SEARCH_ENDPOINT,
	filterSearchResults,
	resolveDeepSeekKey,
	searchWeb,
	validateSearchRequest,
	webSearchConfigFromEnv,
} from "../execution/web-search.mjs";

const GOAL =
	"这是 CTF web 的题目：http://node4.anna.nssctf.cn:24565/，解出flag，并且记录一下解题时间";
const WP = "https://sigeryang.net/2021/12/24/sctf-2021-web-rceme/";

function fakeAgent({ key = "test-key", baseUrl = "https://api.deepseek.com" } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "aegis-web-search-"));
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({ providers: { deedeepseek: { baseUrl, api: "openai-completions" } } }),
		"utf8",
	);
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ deedeepseek: { type: "api_key", key } }), "utf8");
	return dir;
}

function config(overrides = {}) {
	return {
		enabled: true,
		endpoint: DEFAULT_SEARCH_ENDPOINT,
		endpoint_ok: true,
		count: 5,
		maxCalls: 8,
		timeoutMs: 5_000,
		denyExtra: [],
		agentDir: "/nonexistent",
		...overrides,
	};
}

function response(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		async json() {
			return body;
		},
	};
}

test("a technique query is accepted; a target/WP query is refused before any call", () => {
	const deny = buildDenyTokens({ goal: GOAL, extra: [] }).tokens;
	assert.ok(deny.includes("node4.anna.nssctf.cn"));
	assert.ok(deny.includes("nssctf.cn"));
	assert.ok(deny.includes("node4.anna.nssctf.cn:24565"));

	const ok = validateSearchRequest({
		query: "PHP 7.2 disable_functions bypass create_function",
		purpose: "technique",
		count: 5,
		denyTokens: deny,
	});
	assert.equal(ok.ok, true, ok.reason);

	const target = validateSearchRequest({
		query: "node4.anna.nssctf.cn flag",
		purpose: "technique",
		denyTokens: deny,
	});
	assert.equal(target.ok, false);
	assert.match(target.reason, /current target/);

	const wp = validateSearchRequest({
		query: "sctf-2021-web-rceme writeup",
		purpose: "similar-task",
		denyTokens: buildDenyTokens({ goal: GOAL, events: [{ event_type: "action.requested", payload: { command: `curl ${WP}` } }] }).tokens,
	});
	assert.equal(wp.ok, false, "the current challenge's WP must stay refused even with similar-task");
});

test("write-ups are only allowed as a similar-task technique query", () => {
	const deny = buildDenyTokens({ goal: GOAL }).tokens;
	assert.equal(
		validateSearchRequest({ query: "PHP disable_functions writeup", purpose: "technique", denyTokens: deny }).ok,
		false,
	);
	const similar = validateSearchRequest({
		query: "similar PHP disable_functions challenge writeup",
		purpose: "similar-task",
		denyTokens: deny,
	});
	assert.equal(similar.ok, true, similar.reason);
	assert.equal(
		validateSearchRequest({ query: "x", purpose: "other", denyTokens: deny }).ok,
		false,
		"unknown purpose is refused",
	);
	assert.equal(validateSearchRequest({ query: "x", count: 11, denyTokens: deny }).ok, false);
	assert.equal(validateSearchRequest({ query: "x".repeat(129), denyTokens: deny }).ok, false);
});

test("deny tokens cover the target host, domain, port and a fetched WP slug", () => {
	const { tokens } = buildDenyTokens({
		goal: GOAL,
		events: [
			{
				event_type: "action.requested",
				payload: { command: `curl -s ${WP} -o wp.html` },
			},
		],
		extra: ["NSSCTF-2021-RCEME"],
	});
	for (const expected of [
		"node4.anna.nssctf.cn",
		"nssctf.cn",
		"node4.anna.nssctf.cn:24565",
		"sigeryang.net",
		"sctf-2021-web-rceme",
		"sctf",
		"rceme",
		"nssctf-2021-rceme",
	])
		assert.ok(tokens.includes(expected), `missing deny token ${expected}`);
});

test("results naming the target/challenge are dropped; unrelated technique references survive", () => {
	const deny = buildDenyTokens({ goal: GOAL, events: [{ event_type: "action.requested", payload: { command: WP } }] }).tokens;
	const { allowed, dropped } = filterSearchResults(
		[
			{ title: "SCTF 2021 RCEME writeup", url: "https://sigeryang.net/2021/12/24/sctf-2021-web-rceme/", snippet: "" },
			{ title: "target", url: "http://node4.anna.nssctf.cn:24565/", snippet: "" },
			{ title: "PHP disable_functions bypass", url: "https://example.com/php-bypass", snippet: "create_function + unserialize" },
			{ title: "bad url", url: "javascript:alert(1)", snippet: "" },
		],
		deny,
	);
	assert.equal(allowed.length, 1);
	assert.equal(allowed[0].url, "https://example.com/php-bypass");
	assert.equal(dropped, 3);
});

test("the default DeepSeek key is read from the agent config, never from ~/.pi", () => {
	const dir = fakeAgent();
	try {
		const resolved = resolveDeepSeekKey({ agentDir: dir, env: {} });
		assert.equal(resolved.ok, true);
		assert.equal(resolved.source, "agent:deedeepseek");
		assert.equal(resolved.key, "test-key");
		assert.ok(!JSON.stringify(resolved).includes("api.deepseek.com"), "no endpoint dump is needed");
		assert.deepEqual(resolveDeepSeekKey({ agentDir: dir, env: { DEEPSEEK_API_KEY: "env-key" } }), {
			ok: true,
			key: "env-key",
			source: "env:DEEPSEEK_API_KEY",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	assert.equal(resolveDeepSeekKey({ agentDir: "/nonexistent", env: {} }).ok, false);
});

test("configuration is off by default and bounds count/calls", () => {
	assert.equal(webSearchConfigFromEnv({}).enabled, false);
	const on = webSearchConfigFromEnv({
		AEGIS_WEB_SEARCH: "on",
		AEGIS_SEARCH_COUNT: "99",
		AEGIS_SEARCH_MAX_CALLS: "0",
		AEGIS_SEARCH_DENY: "one, two",
	});
	assert.equal(on.enabled, true);
	assert.equal(on.count, 5);
	assert.equal(on.maxCalls, 8);
	assert.deepEqual(on.denyExtra, ["one", "two"]);
	assert.equal(webSearchConfigFromEnv({ AEGIS_WEB_SEARCH: "on", AEGIS_SEARCH_ENDPOINT: "http://x" }).endpoint_ok, false);
});

test("searchWeb sends a bounded request, filters results and never echoes the key", async () => {
	let seen = null;
	const result = await searchWeb({
		query: "PHP 7 disable_functions bypass",
		purpose: "technique",
		count: 3,
		denyTokens: buildDenyTokens({ goal: GOAL }).tokens,
		config: config(),
		apiKey: "test-key",
		fetchImpl: async (url, init) => {
			seen = { url, init };
			return response(200, {
				results: [
					{
						title: "PHP bypass",
						url: "https://example.com/php",
						snippet: "create_function",
						summary: "technique summary",
						rerank_score: 2.1,
						authority: 3,
					},
					{ title: "target", url: "http://node4.anna.nssctf.cn:24565/", snippet: "" },
				],
			});
		},
	});
	assert.equal(seen.url, DEFAULT_SEARCH_ENDPOINT);
	assert.equal(seen.init.method, "POST");
	assert.equal(seen.init.headers.Authorization, "Bearer test-key");
	assert.deepEqual(JSON.parse(seen.init.body), { query: "PHP 7 disable_functions bypass", count: 3, need_content: false });
	assert.equal(result.ok, true);
	assert.equal(result.results.length, 1);
	assert.equal(result.filtered, 1);
	assert.equal(result.attempted, true);
	assert.equal(result.key_source, "injected");
	assert.ok(!JSON.stringify(result).includes("test-key"), "the key never reaches the model payload");
});

test("page content is opt-in, bounded, and never requested for a similar-task write-up", async () => {
	let body = null;
	const result = await searchWeb({
		query: "PHP disable_functions bypass",
		purpose: "technique",
		includeContent: true,
		config: config(),
		apiKey: "test-key",
		fetchImpl: async (_url, init) => {
			body = JSON.parse(init.body);
			return response(200, {
				results: [
					{
						title: "PHP bypass",
						url: "https://example.com/php",
						summary: "summary",
						content: "x".repeat(5000),
					},
				],
			});
		},
	});
	assert.equal(body.need_content, true);
	assert.equal(result.results[0].content.length, 2000);
	assert.equal(result.include_content, true);

	const similar = await searchWeb({
		query: "similar PHP disable_functions writeup",
		purpose: "similar-task",
		includeContent: true,
		config: config(),
		apiKey: "test-key",
		fetchImpl: async (_url, init) => {
			body = JSON.parse(init.body);
			return response(200, {
				results: [{ title: "similar", url: "https://example.com/similar", summary: "summary", content: "full" }],
			});
		},
	});
	assert.equal(body.need_content, false);
	assert.equal(similar.results[0].content, undefined);
	assert.equal(similar.include_content, false);
});

test("HTTP failures are reported, not retried or hidden", async () => {
	for (const [status, expected] of [
		[401, "http_401"],
		[402, "http_402"],
		[429, "http_429"],
		[500, "http_500"],
	]) {
		const result = await searchWeb({
			query: "PHP disable_functions bypass",
			config: config(),
			apiKey: "test-key",
			fetchImpl: async () => response(status, {}),
		});
		assert.equal(result.ok, false);
		assert.equal(result.status, expected);
		assert.equal(result.attempted, true);
		assert.ok(!JSON.stringify(result).includes("test-key"));
	}
});

test("a denied query or missing key makes no network call", async () => {
	let calls = 0;
	const denied = await searchWeb({
		query: "node4.anna.nssctf.cn writeup",
		denyTokens: buildDenyTokens({ goal: GOAL }).tokens,
		config: config(),
		fetchImpl: async () => {
			calls += 1;
			return response(200, { results: [] });
		},
	});
	assert.equal(denied.ok, false);
	assert.equal(denied.status, "refused");
	assert.equal(calls, 0);
	const noKey = await searchWeb({
		query: "PHP disable_functions bypass",
		config: config({ agentDir: "/nonexistent" }),
		fetchImpl: async () => {
			calls += 1;
			return response(200, { results: [] });
		},
	});
	assert.equal(noKey.ok, false);
	assert.equal(noKey.status, "unconfigured");
	assert.equal(calls, 0);
});

test("paid attempts count against the Episode budget; refusals do not", () => {
	const events = [
		{ event_type: "runtime.note", episode_id: "ep", payload: { kind: "web.search", attempted: true } },
		{ event_type: "runtime.note", episode_id: "ep", payload: { kind: "web.search", attempted: false } },
		{ event_type: "runtime.note", episode_id: "other", payload: { kind: "web.search", attempted: true } },
	];
	assert.equal(countWebSearches(events, "ep"), 1);
});

test("a web.search runtime note is an Artifact, not a Fact", () => {
	const rows = [
		{
			event_id: "ev-episode",
			event_type: "episode.started",
			episode_id: "ep",
			sequenced: 0,
			payload: { task_id: "task", goal: { description: GOAL } },
			source: { kind: "runtime" },
		},
		{
			event_id: "ev-search",
			event_type: "runtime.note",
			episode_id: "ep",
			payload: { kind: "web.search", status: "ok", returned: 1, total: 2, purpose: "technique" },
			source: { kind: "runtime" },
		},
	];
	const board = projectBoard(rows);
	assert.equal(board.byType.Artifact.length, 1);
	assert.equal(board.byType.Fact.length, 0);
	assert.match(board.byType.Artifact[0].text, /web search ok/);
});
