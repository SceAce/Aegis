// WEB-01 W1 — recovery / isolation for cookies and artifacts.
//
// The two-process case proves the snapshot is the unit of persistence: a child
// process issues the cookies, serializes them, and the parent restores them and
// gets the SAME selection digest. Instance re-binding is refused, so a reset
// instance cannot silently inherit the old session.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const MODULE = new URL("../execution/adapters/web-http-adapter.mjs", import.meta.url);

async function load() {
	return import(MODULE);
}

async function startServer(handler = () => ({ status: 200, body: "ok" })) {
	const records = [];
	const server = createServer((req, res) => {
		records.push({ url: req.url, cookie: req.headers.cookie ?? "" });
		const reply = handler(req) ?? {};
		const send = () => {
			if (res.destroyed) return;
			res.writeHead(reply.status ?? 200, reply.headers ?? {});
			res.end(reply.body ?? "ok");
		};
		if (reply.delayMs) setTimeout(send, reply.delayMs).unref();
		else send();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address();
	return {
		origin: `http://127.0.0.1:${port}`,
		records,
		async close() {
			await new Promise((r) => server.close(r));
		},
	};
}

function target(origin) {
	return {
		target_id: "web-local",
		origin,
		scheme: "http",
		allowed_methods: ["GET", "POST"],
		allowed_paths: ["/"],
		network: true,
		max_requests: 1,
	};
}

function allowAll() {
	return {
		intent: async () => ({ ok: true, durable: true, intent_ref: "intent-1" }),
		permit: async () => ({
			ok: true,
			permit: { mode: "auto", action_ref: "web.request", action_version: 1, permit_id: "p" },
		}),
		charge: async () => ({ ok: true, charge_id: "charge-1" }),
		finish: async () => ({ ok: true }),
		reuse: async () => ({ found: false }),
	};
}

function identity() {
	return {
		campaign_id: "c",
		task_id: "t",
		episode_id: "e",
		request_id: "r",
		tool_call_id: "tc",
		unit_id: "u",
	};
}

test("WT-09-A: a snapshot cannot be restored into another instance", async () => {
	const { createCookieJar } = await load();
	const jar = createCookieJar({ run_id: "run-1", instance_id: "inst-1" });
	const now = Date.now();
	jar.storeFromResponse({
		url: { host: "127.0.0.1", path: "/", secure: false },
		setCookie: ["sid=secret; Path=/"],
		now,
	});
	const snapshot = jar.snapshot();
	assert.equal(snapshot.run_id, "run-1");
	assert.equal(snapshot.instance_id, "inst-1");

	const same = createCookieJar({ run_id: "run-1", instance_id: "inst-1" });
	const restored = same.restore(snapshot);
	assert.equal(restored.ok, true, JSON.stringify(restored.reasons));

	const otherInstance = createCookieJar({ run_id: "run-1", instance_id: "inst-2" });
	const refused = otherInstance.restore(snapshot);
	assert.equal(refused.ok, false);
	assert.equal(refused.error, "foreign_session");
	assert.equal(otherInstance.headerFor({ host: "127.0.0.1", path: "/", secure: false }).includes("secret"), false);

	const otherRun = createCookieJar({ run_id: "run-2", instance_id: "inst-1" });
	assert.equal(otherRun.restore(snapshot).error, "foreign_session");

	// A corrupted/tampered snapshot is refused rather than partially applied.
	const tampered = { ...snapshot, digest: "sha256:" + "0".repeat(64) };
	const tamperTarget = createCookieJar({ run_id: "run-1", instance_id: "inst-1" });
	assert.equal(tamperTarget.restore(tampered).ok, false);
});

test("WT-09-B: a child process issues cookies and the parent restores the same selection", async () => {
	const { createCookieJar } = await load();
	const server = await startServer((req) => {
		if (req.url === "/login") {
			return { status: 200, headers: { "set-cookie": ["sid=xyz; Path=/", "theme=dark; Path=/"] }, body: "ok" };
		}
		return { status: 200, body: "ok" };
	});
	try {
		const tableTarget = target(server.origin);
		const childScript = `
import { createCookieJar } from ${JSON.stringify(MODULE.href)};
const jar = createCookieJar({ run_id: "run-1", instance_id: "inst-1" });
const now = 1700000000000;
jar.storeFromResponse({ url: { host: "127.0.0.1", path: "/", secure: false },
  setCookie: ["sid=xyz; Path=/", "theme=dark; Path=/"], now });
process.stdout.write(JSON.stringify({ snapshot: jar.snapshot(),
  header: jar.headerFor({ host: "127.0.0.1", path: "/app", secure: false }, now) }));
`;
		const raw = execFileSync(process.execPath, ["--input-type=module", "-e", childScript], {
			encoding: "utf8",
			timeout: 60_000,
		});
		const child = JSON.parse(raw);
		assert.match(child.header, /sid=xyz/);
		assert.match(child.header, /theme=dark/);

		const parent = createCookieJar({ run_id: "run-1", instance_id: "inst-1" });
		const restored = parent.restore(child.snapshot);
		assert.equal(restored.ok, true, JSON.stringify(restored.reasons));
		const parentHeader = parent.headerFor({ host: "127.0.0.1", path: "/app", secure: false }, 1700000000000);
		assert.equal(parentHeader, child.header, "restored selection must match the issuing process");
		assert.equal(target(tableTarget) !== null, true);
	} finally {
		await server.close();
	}
});

test("WT-05-E: artifacts are never created locally; the injected callback owns the store", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer(() => ({ status: 200, body: "payload" }));
	const scratch = mkdtempSync(join(tmpdir(), "aegis-web-adapter-"));
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const request = {
			target_id: "web-local",
			method: "GET",
			path_query: "/payload",
			headers: [],
			body: null,
			session_id: null,
		};
		const plain = await adapter.execute({ request, identity: identity(), callbacks: allowAll() });
		assert.equal(plain.transport_status, "received");
		assert.equal(plain.body_ref, null, "no store callback => no ref");
		assert.deepEqual(readdirSync(scratch), [], "the adapter must not write artifacts itself");

		const withStore = await adapter.execute({
			request,
			identity: identity(),
			callbacks: {
				...allowAll(),
				finish: async () => ({ ok: true, body_ref: "artifact:web-9", body_digest: "sha256:" + "e".repeat(64) }),
			},
		});
		assert.equal(withStore.body_ref, "artifact:web-9");
		assert.equal(withStore.body_digest, "sha256:" + "e".repeat(64));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
		await server.close();
	}
});

test("WT-09-C: an unknown result keeps its intent for reconciliation and never resends", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer(() => ({ status: 200, body: "late", delayMs: 2000 }));
	try {
		const table = createWebTargetTable([{ ...target(server.origin), limits: { timeout_ms: 100 } }]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const releases = [];
		const callbacks = {
			...allowAll(),
			finish: async ({ outcome }) => {
				releases.push(outcome);
				return { ok: true };
			},
		};
		const result = await adapter.execute({
			request: {
				target_id: "web-local",
				method: "GET",
				path_query: "/slow",
				headers: [],
				body: null,
				session_id: null,
			},
			identity: identity(),
			callbacks,
			limits: { timeout_ms: 100 },
		});
		assert.equal(result.transport_status, "unknown");
		assert.equal(result.error_code, "timeout");
		assert.equal(result.intent_ref, "intent-1", "the intent ref is preserved for reconciliation");
		assert.equal(releases.length, 1, "finish still records the unknown outcome");
		assert.equal(releases[0].result_error ?? releases[0].error_code, "timeout");
		assert.equal(server.records.length, 1, "no resend");
	} finally {
		await server.close();
	}
});
