// Trusted cookie broker + HTTP adapter tests. No real Firefox profile, platform,
// network, cookie, or model call is used.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFirefoxCookieHeader } from "../orchestration/remote-cookie.mjs";
import { createRemoteHttpClient } from "../orchestration/remote-http.mjs";
import { createRemotePlatformGate } from "../orchestration/remote-platform.mjs";

const ORIGIN = "https://ctf.example";
async function cookieProfile() {
	const dir = await mkdtemp(join(tmpdir(), "aegis-cookie-test-"));
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(join(dir, "cookies.sqlite"));
	db.exec(`CREATE TABLE moz_cookies (
		host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER
	)`);
	db.prepare("INSERT INTO moz_cookies VALUES (?,?,?,?,?,?)").run(
		".ctf.example",
		"sid",
		"secret-cookie",
		"/",
		Math.floor(Date.now() / 1000) + 3600,
		1,
	);
	db.prepare("INSERT INTO moz_cookies VALUES (?,?,?,?,?,?)").run(
		".ctf.example",
		"expired",
		"old",
		"/",
		Math.floor(Date.now() / 1000) - 1,
		1,
	);
	db.prepare("INSERT INTO moz_cookies VALUES (?,?,?,?,?,?)").run(
		"other.example",
		"foreign",
		"foreign-value",
		"/",
		Math.floor(Date.now() / 1000) + 3600,
		1,
	);
	db.close();
	return dir;
}
function fakeResponse(status, body, headers = {}) {
	return new Response(body, { status, headers });
}

test("cookie broker returns only the matching live cookie header", async () => {
	const dir = await cookieProfile();
	try {
		const result = await readFirefoxCookieHeader({ profilePath: dir, origin: `${ORIGIN}/api` });
		assert.equal(result.ok, true, result.reason);
		assert.equal(result.cookieHeader, "sid=secret-cookie");
		assert.equal(result.count, 1);
		assert.ok(!JSON.stringify(result).includes("foreign-value"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("remote HTTP injects the cookie, enforces origin/rate, and does not return the cookie", async () => {
	const dir = await cookieProfile();
	try {
		const cookie = await readFirefoxCookieHeader({ profilePath: dir, origin: ORIGIN });
		const calls = [];
		const gate = createRemotePlatformGate({ origins: [ORIGIN], now: () => 0, minIntervalMs: 0, perMinute: 10 });
		const client = createRemoteHttpClient({
			origin: ORIGIN,
			cookieHeader: cookie.cookieHeader,
			gate,
			fetchImpl: async (url, options) => {
				calls.push({ url: String(url), options });
				return fakeResponse(200, '{"ok":true}', { "content-type": "application/json" });
			},
		});
		const result = await client.request("/api/v1/challenges", { method: "GET" });
		assert.equal(result.ok, true, result.reason);
		assert.equal(result.status, 200);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].options.headers.cookie, "sid=secret-cookie");
		assert.ok(!JSON.stringify(result).includes("secret-cookie"));
		const lowGate = createRemotePlatformGate({ origins: [ORIGIN], now: () => 0, minIntervalMs: 0, perMinute: 1 });
		assert.equal(lowGate.admit({ kind: "login", origin: ORIGIN }).ok, true);
		const blocked = await createRemoteHttpClient({
			origin: ORIGIN,
			cookieHeader: cookie.cookieHeader,
			gate: lowGate,
			fetchImpl: async () => fakeResponse(200, "must-not-fetch"),
		}).request("/api");
		assert.equal(blocked.ok, false);
		assert.equal(blocked.reason, "minute_limit");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("remote HTTP refuses cross-origin requests and duplicate POSTs", async () => {
	const gate = createRemotePlatformGate({ origins: [ORIGIN], now: () => 0, minIntervalMs: 0, perMinute: 10 });
	let fetches = 0;
	const client = createRemoteHttpClient({
		origin: ORIGIN,
		cookieHeader: "sid=secret-cookie",
		gate,
		fetchImpl: async () => {
			fetches += 1;
			return fakeResponse(200, "ok");
		},
	});
	const foreign = await client.request("https://evil.example/api");
	assert.equal(foreign.ok, false);
	assert.equal(foreign.reason, "origin_not_allowed");
	assert.equal(fetches, 0);
	const first = await client.request("/api/submit", { method: "POST", body: { flag: "x" } });
	assert.equal(first.ok, true, first.reason);
	const second = await client.request("/api/submit", { method: "POST", body: { flag: "x" } });
	assert.equal(second.ok, false);
	assert.equal(second.reason, "duplicate_action");
	assert.equal(fetches, 1);
});
