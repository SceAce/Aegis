// WEB-01 W1 — HTTP/session adapter, real loopback evidence.
//
// Covers WT-01, WT-02, WT-03, WT-04, WT-05 (adapter part), WT-10 (permit order is
// exercised in the wiring script).
//
// Every case uses a REAL `node:http` server bound to 127.0.0.1:0. The server
// records the exact received bytes/headers so "the adapter sent X" is proven by
// the peer, not by the adapter's own return value. No external network.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";

const MODULE = new URL("../execution/adapters/web-http-adapter.mjs", import.meta.url);

async function load() {
	return import(MODULE);
}

/**
 * Start a loopback server. `handler(req, record)` may return
 * `{status, headers, body, delayMs, destroy}`. Every request is recorded with the
 * RAW header pairs and the exact body bytes.
 */
async function startServer(handler) {
	const records = [];
	const sockets = new Set();
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", async () => {
			const record = {
				method: req.method,
				url: req.url,
				raw_headers: req.rawHeaders.slice(),
				headers: req.headers,
				body: Buffer.concat(chunks),
			};
			records.push(record);
			const reply = (await handler(req, record)) ?? {};
			if (reply.destroy) {
				req.socket.destroy();
				return;
			}
			if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
			res.writeHead(reply.status ?? 200, reply.headers ?? { "content-type": "text/plain" });
			res.end(reply.body ?? "ok");
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		port,
		origin: `http://127.0.0.1:${port}`,
		records,
		connectionCount: () => records.length,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

function headerPairs(record, name) {
	const wanted = name.toLowerCase();
	const out = [];
	const raw = record.raw_headers;
	for (let i = 0; i < raw.length; i += 2) {
		if (raw[i].toLowerCase() === wanted) out.push(raw[i + 1]);
	}
	return out;
}

function target(origin, overrides = {}) {
	return {
		target_id: "web-local",
		origin,
		scheme: origin.startsWith("https") ? "https" : "http",
		allowed_methods: ["GET", "POST", "HEAD"],
		allowed_paths: ["/"],
		network: true,
		max_requests: 1,
		...overrides,
	};
}

/** Always-approve wiring used only to reach the transport; never a model path. */
function allowAll(overrides = {}) {
	const calls = { intent: 0, permit: 0, charge: 0, finish: 0, reuse: 0, release: 0 };
	const order = [];
	return {
		calls,
		order,
		callbacks: {
			intent: async () => {
				calls.intent += 1;
				order.push("intent");
				return { ok: true, durable: true, intent_ref: "intent-1" };
			},
			permit: async ({ intent_ref }) => {
				calls.permit += 1;
				order.push("permit");
				return {
					ok: true,
					permit: { mode: "auto", action_ref: "web.request", action_version: 1, intent_ref, permit_id: "p-1" },
				};
			},
			charge: async () => {
				calls.charge += 1;
				order.push("charge");
				return { ok: true, charge_id: "charge-1" };
			},
			finish: async () => {
				calls.finish += 1;
				order.push("finish");
				return { ok: true };
			},
			reuse: async () => {
				calls.reuse += 1;
				return { found: false };
			},
			release: async () => ({ ok: true }),
			...overrides,
		},
	};
}

function identity(overrides = {}) {
	return {
		campaign_id: "campaign-1",
		task_id: "task-1",
		episode_id: "episode-1",
		request_id: "request-1",
		tool_call_id: "tool-1",
		unit_id: "unit-1",
		...overrides,
	};
}

async function runRequest(adapter, request, wiring = allowAll(), id = identity()) {
	return adapter.execute({ request, identity: id, callbacks: wiring.callbacks });
}

// ---------------------------------------------------------------------------
// WT-01: exact bytes on the wire
// ---------------------------------------------------------------------------

test("WT-01-A: path bytes, duplicate headers and query order reach the server verbatim", async () => {
	const { createWebTargetTable, createWebHttpAdapter, validateHttpRequest } = await load();
	const server = await startServer(() => ({ status: 200, body: "seen" }));
	try {
		const table = createWebTargetTable([target(server.origin)]);
		assert.equal(table.ok, true, JSON.stringify(table.reasons));
		const adapter = createWebHttpAdapter({ targets: table.table });
		const pathQuery = "/a%20b%2Fc/d?x=1&x=2&y=%E4%B8%AD&z";

		// Independent pure validation, then the real send.
		const validated = validateHttpRequest(
			{
				target_id: "web-local",
				method: "GET",
				path_query: pathQuery,
				headers: [
					["X-Dup", "a"],
					["X-Dup", "b"],
					["X-Mixed-Case", "v"],
				],
				body: null,
				session_id: null,
			},
			{ targetTable: table.table },
		);
		assert.equal(validated.ok, true, JSON.stringify(validated.reasons));

		const result = await runRequest(adapter, validated.normalized);
		assert.equal(result.transport_status, "received", result.error_detail ?? "");
		assert.equal(result.status_code, 200);
		assert.equal(server.records.length, 1);
		// Exact request-target bytes: no decode/re-encode, no query dedupe.
		assert.equal(server.records[0].url, pathQuery);
		assert.equal(server.records[0].method, "GET");
		assert.deepEqual(headerPairs(server.records[0], "x-dup"), ["a", "b"]);
		assert.deepEqual(headerPairs(server.records[0], "x-mixed-case"), ["v"]);
		assert.equal(result.outcome_candidate, null);
	} finally {
		await server.close();
	}
});

test("WT-01-B: base64 binary POST body arrives byte-identical", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer(() => ({ status: 200, body: "ok" }));
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const bytes = Buffer.from([0x00, 0x01, 0xff, 0x80, 0x0a, 0x0d]);
		const result = await runRequest(adapter, {
			target_id: "web-local",
			method: "POST",
			path_query: "/upload",
			headers: [["Content-Type", "application/octet-stream"]],
			body: { encoding: "base64", data: bytes.toString("base64") },
			session_id: null,
		});
		assert.equal(result.transport_status, "received", result.error_detail ?? "");
		assert.equal(server.records.length, 1);
		assert.deepEqual(server.records[0].body, bytes);
		// The adapter-reported digest must describe the sent body, not the preview.
		const expected = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
		assert.equal(result.requested?.body_digest, expected);
		assert.equal(result.bytes_received, 2);
	} finally {
		await server.close();
	}
});

test("WT-01-C: utf8 body is sent as UTF-8 and the model cannot set Content-Length", async () => {
	const { createWebTargetTable, createWebHttpAdapter, validateHttpRequest } = await load();
	const server = await startServer(() => ({ status: 200, body: "ok" }));
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const result = await runRequest(adapter, {
			target_id: "web-local",
			method: "POST",
			path_query: "/echo",
			headers: [],
			body: { encoding: "utf8", data: '{"a":"中"}' },
			session_id: null,
		});
		assert.equal(result.transport_status, "received", result.error_detail ?? "");
		assert.equal(server.records[0].body.toString("utf8"), '{"a":"中"}');
		// Rejecting the inbound Content-Length is what makes the above meaningful.
		const rejected = validateHttpRequest(
			{
				target_id: "web-local",
				method: "POST",
				path_query: "/echo",
				headers: [["Content-Length", "1"]],
				body: { encoding: "utf8", data: "abcd" },
				session_id: null,
			},
			{ targetTable: table.table },
		);
		assert.equal(rejected.ok, false);
		assert.match(rejected.reasons.join(";"), /content-length/i);
	} finally {
		await server.close();
	}
});

test("WT-01-D: absolute URL, protocol-relative URL and fragment are rejected with zero requests", async () => {
	const { createWebTargetTable, validateHttpRequest } = await load();
	const server = await startServer(() => ({ status: 200, body: "ok" }));
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const base = { target_id: "web-local", method: "GET", headers: [], body: null, session_id: null };
		for (const bad of [
			"http://evil.test/",
			"https://127.0.0.1/",
			"//evil.test/x",
			"/a#frag",
			"a/b",
			"",
			"/a\r\nHost: evil",
		]) {
			const result = validateHttpRequest({ ...base, path_query: bad }, { targetTable: table.table });
			assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
			assert.ok(result.reasons.length > 0);
		}
		assert.equal(server.records.length, 0);
	} finally {
		await server.close();
	}
});

test("WT-01-E: forbidden framing/proxy headers are rejected by name", async () => {
	const { createWebTargetTable, validateHttpRequest } = await load();
	const server = await startServer(() => ({ status: 200, body: "ok" }));
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const base = { target_id: "web-local", method: "GET", path_query: "/", body: null, session_id: null };
		const forbidden = [
			["Host", "evil.test"],
			["content-length", "5"],
			["Transfer-Encoding", "chunked"],
			["Connection", "keep-alive"],
			["Proxy-Connection", "keep-alive"],
			["Proxy-Authorization", "Basic x"],
			["Upgrade", "websocket"],
			["TE", "trailers"],
			["Trailer", "X"],
			["Keep-Alive", "timeout=5"],
		];
		for (const pair of forbidden) {
			const result = validateHttpRequest({ ...base, headers: [pair] }, { targetTable: table.table });
			assert.equal(result.ok, false, `expected rejection for header ${pair[0]}`);
			assert.match(result.reasons.join(";").toLowerCase(), new RegExp(pair[0].toLowerCase().replace("-", "\\-")));
		}
		// A duplicate smuggling attempt (two Host fields) is also refused.
		const dupHost = validateHttpRequest(
			{
				...base,
				headers: [
					["Host", "a"],
					["Host", "b"],
				],
			},
			{ targetTable: table.table },
		);
		assert.equal(dupHost.ok, false);
		assert.equal(server.records.length, 0);
	} finally {
		await server.close();
	}
});

test("WT-01-F/G/H: path prefix, unknown target and method allow-list are enforced", async () => {
	const { createWebTargetTable, validateHttpRequest } = await load();
	const server = await startServer(() => ({ status: 200, body: "ok" }));
	try {
		const table = createWebTargetTable([target(server.origin, { allowed_paths: ["/api"] })]);
		const base = { headers: [], body: null, session_id: null };
		const outside = validateHttpRequest(
			{ ...base, target_id: "web-local", method: "GET", path_query: "/etc/passwd" },
			{ targetTable: table.table },
		);
		assert.equal(outside.ok, false);
		const sibling = validateHttpRequest(
			{ ...base, target_id: "web-local", method: "GET", path_query: "/apix/1" },
			{ targetTable: table.table },
		);
		assert.equal(sibling.ok, false, "prefix match must be path-segment aware");
		const inside = validateHttpRequest(
			{ ...base, target_id: "web-local", method: "GET", path_query: "/api/1?q=a" },
			{ targetTable: table.table },
		);
		assert.equal(inside.ok, true, JSON.stringify(inside.reasons));
		const unknownTarget = validateHttpRequest(
			{ ...base, target_id: "nope", method: "GET", path_query: "/api" },
			{ targetTable: table.table },
		);
		assert.equal(unknownTarget.ok, false);
		const badMethod = validateHttpRequest(
			{ ...base, target_id: "web-local", method: "PUT", path_query: "/api" },
			{ targetTable: table.table },
		);
		assert.equal(badMethod.ok, false);
		assert.equal(server.records.length, 0);
	} finally {
		await server.close();
	}
});

test("WT-01-I: request shape rejection never reaches the network or the write callbacks", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer(() => ({ status: 200, body: "ok" }));
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const wiring = allowAll();
		const result = await runRequest(
			adapter,
			{
				target_id: "web-local",
				method: "GET",
				path_query: "http://evil.test/",
				headers: [],
				body: null,
				session_id: null,
			},
			wiring,
		);
		assert.equal(result.transport_status, "rejected");
		assert.equal(result.error_code, "invalid_request");
		assert.equal(result.attempts, 0);
		assert.equal(server.records.length, 0);
		assert.deepEqual(wiring.calls.charge, 0);
		assert.deepEqual(wiring.calls.intent, 0);
	} finally {
		await server.close();
	}
});

// ---------------------------------------------------------------------------
// WT-02: cookie isolation
// ---------------------------------------------------------------------------

test("WT-02-A/B: Set-Cookie is stored, replayed on matching path only", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer((req) => {
		if (req.url === "/login") {
			return {
				status: 200,
				headers: { "set-cookie": ["sid=abc123; Path=/api", "root=1; Path=/"] },
				body: "in",
			};
		}
		return { status: 200, body: "ok" };
	});
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		await runRequest(adapter, {
			target_id: "web-local",
			method: "GET",
			path_query: "/login",
			headers: [],
			body: null,
			session_id: "s1",
		});
		await runRequest(adapter, {
			target_id: "web-local",
			method: "GET",
			path_query: "/apix/1",
			headers: [],
			body: null,
			session_id: "s1",
		});
		await runRequest(adapter, {
			target_id: "web-local",
			method: "GET",
			path_query: "/api/1",
			headers: [],
			body: null,
			session_id: "s1",
		});
		const apix = server.records[1].headers.cookie ?? "";
		const api = server.records[2].headers.cookie ?? "";
		assert.equal(apix.includes("sid="), false, `path /api must not match /apix (got ${apix})`);
		assert.equal(apix.includes("root=1"), true);
		assert.equal(api.includes("sid=abc123"), true);
		assert.equal(api.includes("root=1"), true);
		// Adapter never echoes cookie values.
		const result = await runRequest(adapter, {
			target_id: "web-local",
			method: "GET",
			path_query: "/api/1",
			headers: [],
			body: null,
			session_id: "s1",
		});
		assert.equal(typeof result.cookie_summary.count, "number");
		assert.match(result.cookie_summary.digest, /^sha256:[0-9a-f]{64}$/);
		assert.equal(JSON.stringify(result.cookie_summary).includes("abc123"), false);
	} finally {
		await server.close();
	}
});

test("WT-02-C/D/E/F: domain/expiry/secure/session rules", async () => {
	const { createCookieJar } = await load();
	const jar = createCookieJar({ run_id: "run-1", instance_id: "inst-1" });
	const now = Date.parse("2026-10-18T00:00:00.000Z");
	jar.storeFromResponse({
		url: { host: "target.test", path: "/", secure: true },
		setCookie: [
			"hostonly=1",
			"domainwide=2; Domain=target.test",
			"foreign=3; Domain=other.test",
			"secureonly=4; Secure",
			"expired=5; Max-Age=0",
			"past=6; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
			"future=7; Expires=Fri, 01 Jan 2100 00:00:00 GMT",
		],
		now,
	});
	jar.storeFromResponse({
		url: { host: "other.test", path: "/", secure: false },
		setCookie: ["otherhost=9"],
		now,
	});
	const secureHeaders = jar.headerFor({ host: "target.test", path: "/x", secure: true }, now);
	const plainHeaders = jar.headerFor({ host: "target.test", path: "/x", secure: false }, now);
	assert.match(secureHeaders, /hostonly=1/);
	assert.match(secureHeaders, /domainwide=2/);
	assert.match(secureHeaders, /secureonly=4/);
	assert.match(secureHeaders, /future=7/);
	assert.equal(secureHeaders.includes("expired=5"), false);
	assert.equal(secureHeaders.includes("past=6"), false);
	assert.equal(secureHeaders.includes("foreign=3"), false);
	assert.equal(secureHeaders.includes("otherhost=9"), false, "host-only cookie must not leak to another host");
	assert.equal(plainHeaders.includes("secureonly=4"), false, "Secure cookie must not be sent over http");

	// Session isolation inside one jar.
	jar.storeFromResponse({
		url: { host: "target.test", path: "/", secure: false },
		setCookie: ["s1only=1"],
		now,
		session_id: "s1",
	});
	assert.match(jar.headerFor({ host: "target.test", path: "/", secure: false, session_id: "s1" }, now), /s1only=1/);
	assert.equal(
		jar.headerFor({ host: "target.test", path: "/", secure: false, session_id: "s2" }, now).includes("s1only=1"),
		false,
	);
});

// ---------------------------------------------------------------------------
// WT-03: no redirect, no proxy
// ---------------------------------------------------------------------------

test("WT-03-A: 302 is returned, never followed", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer((req) => {
		if (req.url === "/start") return { status: 302, headers: { location: "/next" }, body: "" };
		return { status: 200, body: "should-not-arrive" };
	});
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const result = await runRequest(adapter, {
			target_id: "web-local",
			method: "GET",
			path_query: "/start",
			headers: [],
			body: null,
			session_id: null,
		});
		assert.equal(result.transport_status, "received");
		assert.equal(result.status_code, 302);
		assert.deepEqual(
			result.headers.filter(([name]) => name.toLowerCase() === "location").map(([, value]) => value),
			["/next"],
		);
		assert.equal(
			result.headers.some(([k, v]) => k.toLowerCase() === "location" && v === "/next"),
			true,
		);
		assert.equal(server.records.length, 1, "redirect target must not be requested");
		assert.equal(
			server.records.some((r) => r.url === "/next"),
			false,
		);
	} finally {
		await server.close();
	}
});

test("WT-03-B: proxy environment variables are ignored", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer(() => ({ status: 200, body: "direct" }));
	const saved = { ...process.env };
	try {
		// Port 1 on loopback is closed; a proxy-respecting client would fail here.
		process.env.HTTP_PROXY = "http://127.0.0.1:1";
		process.env.HTTPS_PROXY = "http://127.0.0.1:1";
		process.env.ALL_PROXY = "http://127.0.0.1:1";
		process.env.http_proxy = "http://127.0.0.1:1";
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const result = await runRequest(adapter, {
			target_id: "web-local",
			method: "GET",
			path_query: "/direct",
			headers: [],
			body: null,
			session_id: null,
		});
		assert.equal(result.transport_status, "received", result.error_detail ?? "");
		assert.equal(result.status_code, 200);
		assert.equal(server.records.length, 1);
	} finally {
		process.env = saved;
		await server.close();
	}
});

// ---------------------------------------------------------------------------
// WT-04: real responses, failure vs unknown, no retry
// ---------------------------------------------------------------------------

test("WT-04-A: 4xx/5xx are received responses, not adapter failures", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer((req) =>
		req.url === "/404" ? { status: 404, body: "nope" } : { status: 500, body: "boom" },
	);
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		for (const [path, code] of [
			["/404", 404],
			["/500", 500],
		]) {
			const result = await runRequest(adapter, {
				target_id: "web-local",
				method: "GET",
				path_query: path,
				headers: [],
				body: null,
				session_id: null,
			});
			assert.equal(result.transport_status, "received");
			assert.equal(result.status_code, code);
			assert.equal(result.error_code, null);
			assert.equal(result.outcome_candidate, null, "a response never implies a task outcome");
		}
	} finally {
		await server.close();
	}
});

test("WT-04-B: connection failure is unknown, not received", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer(() => ({ status: 200, body: "ok" }));
	const deadOrigin = server.origin;
	await server.close();
	const table = createWebTargetTable([target(deadOrigin)]);
	const adapter = createWebHttpAdapter({ targets: table.table });
	const result = await runRequest(adapter, {
		target_id: "web-local",
		method: "GET",
		path_query: "/",
		headers: [],
		body: null,
		session_id: null,
	});
	assert.equal(result.transport_status, "unknown");
	assert.equal(result.status_code, null);
	assert.equal(result.error_code, "conn_error");
	assert.equal(result.attempts, 1);
});

test("WT-04-C: timeout is unknown with exactly one network attempt", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer(() => ({ status: 200, body: "late", delayMs: 2000 }));
	try {
		const table = createWebTargetTable([target(server.origin, { limits: { timeout_ms: 150 } })]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const started = Date.now();
		const result = await runRequest(adapter, {
			target_id: "web-local",
			method: "GET",
			path_query: "/slow",
			headers: [],
			body: null,
			session_id: null,
		});
		const elapsed = Date.now() - started;
		assert.equal(result.transport_status, "unknown");
		assert.equal(result.error_code, "timeout");
		assert.equal(result.attempts, 1);
		assert.ok(elapsed < 1500, `timeout should abort quickly, took ${elapsed}ms`);
		assert.equal(server.records.length, 1, "no automatic retry");
	} finally {
		await server.close();
	}
});

test("WT-04-D: an aborted response is not retried", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer(() => ({ destroy: true }));
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const result = await runRequest(adapter, {
			target_id: "web-local",
			method: "GET",
			path_query: "/flaky",
			headers: [],
			body: null,
			session_id: null,
		});
		assert.equal(result.transport_status, "unknown");
		assert.ok(["conn_error", "truncated_response"].includes(result.error_code), String(result.error_code));
		assert.equal(server.records.length, 1, "exactly one connection attempt (no retry)");
		assert.equal(result.attempts, 1);
	} finally {
		await server.close();
	}
});

// ---------------------------------------------------------------------------
// WT-05: size limits, compression, binary
// ---------------------------------------------------------------------------

test("WT-05-A: oversized response is truncated with exact bytes_received", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const payload = Buffer.alloc(2 * 1024 * 1024, 0x41);
	const server = await startServer(() => ({ status: 200, headers: { "content-type": "text/plain" }, body: payload }));
	try {
		const table = createWebTargetTable([target(server.origin, { limits: { max_response_bytes: 64 * 1024 } })]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const result = await runRequest(adapter, {
			target_id: "web-local",
			method: "GET",
			path_query: "/big",
			headers: [],
			body: null,
			session_id: null,
		});
		assert.equal(result.transport_status, "received");
		assert.equal(result.truncated, true);
		assert.equal(result.bytes_received, 64 * 1024);
		assert.ok(result.body_preview.length <= 64 * 1024);
		assert.match(result.body_digest, /^sha256:[0-9a-f]{64}$/);
		assert.equal(
			result.body_digest,
			`sha256:${createHash("sha256")
				.update(payload.subarray(0, 64 * 1024))
				.digest("hex")}`,
		);
	} finally {
		await server.close();
	}
});

test("WT-05-B: decompression bomb over the declared cap is refused as unknown", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x42));
	const server = await startServer(() => ({
		status: 200,
		headers: { "content-type": "text/plain", "content-encoding": "gzip" },
		body: bomb,
	}));
	try {
		const table = createWebTargetTable([
			target(server.origin, { limits: { max_decompressed_bytes: 256 * 1024, max_response_bytes: 4 * 1024 * 1024 } }),
		]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const result = await runRequest(adapter, {
			target_id: "web-local",
			method: "GET",
			path_query: "/bomb",
			headers: [["Accept-Encoding", "gzip"]],
			body: null,
			session_id: null,
		});
		assert.equal(result.error_code, "decompressed_too_large");
		assert.equal(result.compressed, true);
		assert.equal(result.attempts, 1);
	} finally {
		await server.close();
	}
});

test("WT-05-C/D: all 256 byte values survive base64 round-trip; preview is lossy but safe", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
	const server = await startServer(() => ({
		status: 200,
		headers: { "content-type": "application/octet-stream" },
		body: all,
	}));
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const result = await runRequest(adapter, {
			target_id: "web-local",
			method: "GET",
			path_query: "/bin",
			headers: [],
			body: null,
			session_id: null,
		});
		assert.equal(result.transport_status, "received");
		assert.equal(result.bytes_received, 256);
		assert.deepEqual(Buffer.from(result.body_base64, "base64"), all);
		assert.equal(result.body_digest, `sha256:${createHash("sha256").update(all).digest("hex")}`);
		// A 0xff 0xfe sequence must not throw and must not become the raw bytes.
		const invalid = await runRequest(adapter, {
			target_id: "web-local",
			method: "GET",
			path_query: "/bin",
			headers: [],
			body: null,
			session_id: null,
		});
		assert.equal(typeof invalid.body_preview, "string");
		assert.equal(invalid.body_preview.includes("\uFFFD"), true);
	} finally {
		await server.close();
	}
});

test("WT-05-F: request body over the declared cap is rejected with zero requests", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer(() => ({ status: 200, body: "ok" }));
	try {
		const table = createWebTargetTable([target(server.origin, { limits: { max_body_bytes: 16 } })]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const result = await runRequest(adapter, {
			target_id: "web-local",
			method: "POST",
			path_query: "/upload",
			headers: [],
			body: { encoding: "utf8", data: "x".repeat(64) },
			session_id: null,
		});
		assert.equal(result.transport_status, "rejected");
		assert.equal(result.error_code, "body_too_large");
		assert.equal(server.records.length, 0);
	} finally {
		await server.close();
	}
});
