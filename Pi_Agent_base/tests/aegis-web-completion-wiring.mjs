// WEB-01 W1 — adapter wiring semantics (durable intent, latest permit, charge,
// finish, reuse). Real loopback server + injected trusted callbacks.
//
// There is NO model-facing effect path here: the adapter only awaits the
// callbacks a Host/controlled Broker adapter supplies. These callbacks are the
// contract placeholders for the existing authority/ledger; no second ledger is
// created in this module.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

const MODULE = new URL("../execution/adapters/web-http-adapter.mjs", import.meta.url);

async function load() {
	return import(MODULE);
}

async function startServer(handler = () => ({ status: 200, body: "ok" })) {
	const records = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			records.push({ method: req.method, url: req.url, body: Buffer.concat(chunks) });
			const reply = handler(req) ?? {};
			res.writeHead(reply.status ?? 200, reply.headers ?? {});
			res.end(reply.body ?? "ok");
		});
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

function target(origin, limits) {
	return {
		target_id: "web-local",
		origin,
		scheme: "http",
		allowed_methods: ["GET", "POST"],
		allowed_paths: ["/"],
		network: true,
		max_requests: 1,
		...(limits ? { limits } : {}),
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

/** Callbacks that record every call; each can be overridden per case. */
function wiring(overrides = {}) {
	const log = [];
	const counts = { intent: 0, permit: 0, charge: 0, finish: 0, reuse: 0, release: 0 };
	const make = (name, impl) => async (input) => {
		counts[name] += 1;
		log.push(name);
		const value = await impl(input);
		log.push(`${name}:done`);
		return value;
	};
	return {
		log,
		counts,
		callbacks: {
			intent: make("intent", async () => ({ ok: true, durable: true, intent_ref: "intent-1" })),
			permit: make("permit", async () => ({
				ok: true,
				permit: { mode: "auto", action_ref: "web.request", action_version: 1, permit_id: "permit-1" },
			})),
			charge: make("charge", async () => ({ ok: true, charge_id: "charge-1" })),
			finish: make("finish", async () => ({ ok: true })),
			reuse: make("reuse", async () => ({ found: false })),
			release: make("release", async () => ({ ok: true })),
			...overrides,
		},
	};
}

async function execute(adapter, request, cb, id = identity()) {
	return adapter.execute({ request, identity: id, callbacks: cb });
}

const REQ = {
	target_id: "web-local",
	method: "GET",
	path_query: "/one",
	headers: [],
	body: null,
	session_id: null,
};

test("WT-07-A: one request => exactly one reuse/intent/charge/permit/finish and one network attempt", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer();
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const w = wiring();
		const result = await execute(adapter, REQ, w.callbacks);
		assert.equal(result.transport_status, "received", result.error_detail ?? "");
		assert.deepEqual(w.counts, { intent: 1, permit: 1, charge: 1, finish: 1, reuse: 1, release: 0 });
		assert.equal(server.records.length, 1);
		assert.equal(result.attempts, 1);
		assert.equal(result.intent_ref, "intent-1");
		assert.equal(result.charge_id, "charge-1");
		// Ordering: intent and charge strictly before the permit, permit before finish.
		assert.ok(w.log.indexOf("intent") < w.log.indexOf("permit"), w.log.join(","));
		assert.ok(w.log.indexOf("charge") < w.log.indexOf("permit"), w.log.join(","));
		assert.ok(w.log.indexOf("permit:done") < w.log.indexOf("finish"), w.log.join(","));
	} finally {
		await server.close();
	}
});

test("WT-07-B/C: non-durable intent => rejected, zero network, no charge", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer();
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		for (const intentImpl of [
			async () => ({ ok: false, error: "log unavailable" }),
			async () => ({ ok: true, durable: false, intent_ref: "intent-1" }),
			async () => {
				throw new Error("append threw");
			},
		]) {
			const w = wiring({ intent: intentImpl });
			const result = await execute(adapter, REQ, w.callbacks);
			assert.equal(result.transport_status, "rejected");
			assert.equal(result.error_code, "intent_not_durable");
			assert.equal(result.attempts, 0);
			assert.equal(w.counts.charge, 0);
			assert.equal(w.counts.permit, 0);
		}
		assert.equal(server.records.length, 0);
	} finally {
		await server.close();
	}
});

test("WT-07-D: charge failure => rejected with zero network", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer();
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const w = wiring({ charge: async () => ({ ok: false, error: "budget exhausted" }) });
		const result = await execute(adapter, REQ, w.callbacks);
		assert.equal(result.transport_status, "rejected");
		assert.equal(result.error_code, "charge_failed");
		assert.equal(server.records.length, 0);
		assert.equal(w.counts.permit, 0, "permit must not be consulted after a charge refusal");
		assert.equal(w.counts.finish, 0);
	} finally {
		await server.close();
	}
});

test("WT-07-E: permit is consulted AFTER the durable intent and its refusal stops the effect", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer();
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const seen = [];
		const w = wiring({
			intent: async () => {
				seen.push("intent");
				return { ok: true, durable: true, intent_ref: "intent-1" };
			},
			permit: async () => {
				seen.push("permit");
				return { ok: false, reason: "cancelled" };
			},
		});
		const result = await execute(adapter, REQ, w.callbacks);
		assert.deepEqual(seen, ["intent", "permit"]);
		assert.equal(result.transport_status, "rejected");
		assert.equal(result.error_code, "permit_denied");
		assert.equal(result.intent_ref, "intent-1", "the durable intent is preserved for reconciliation");
		assert.equal(server.records.length, 0);
	} finally {
		await server.close();
	}
});

test("WT-07-F: wildcard / incomplete permits are refused", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer();
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const bad = [
			{ ok: true, permit: { mode: "auto", action_ref: "*" } },
			{ ok: true, permit: { mode: "auto", action_ref: "web.request" } },
			{ ok: true, permit: { action_ref: "web.request", action_version: 1 } },
			{ ok: true },
			{
				ok: true,
				permit: { mode: "auto", action_ref: "web.request", action_version: 1, expires_at: "2000-01-01T00:00:00.000Z" },
			},
			{ ok: true, permit: { mode: "auto", action_ref: "web.request", action_version: 1, target_id: "other" } },
		];
		for (const [index, permitImpl] of bad.entries()) {
			const w = wiring({ permit: async () => permitImpl });
			const result = await execute(adapter, REQ, w.callbacks);
			assert.equal(result.transport_status, "rejected", `case ${index}`);
			assert.equal(result.error_code, "permit_denied", `case ${index}`);
		}
		assert.equal(server.records.length, 0);
	} finally {
		await server.close();
	}
});

test("WT-07-G: verified reuse returns the stored result with zero network and zero charge", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer();
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const stored = {
			transport_status: "received",
			status_code: 200,
			headers: [["content-type", "text/plain"]],
			body_preview: "cached",
			body_base64: Buffer.from("cached").toString("base64"),
			body_digest: null,
			bytes_received: 6,
			truncated: false,
			session_id: null,
			error_code: null,
		};
		const w = wiring({ reuse: async () => ({ found: true, result: stored }) });
		const result = await execute(adapter, REQ, w.callbacks);
		assert.equal(result.reused, true);
		assert.equal(result.transport_status, "received");
		assert.equal(result.attempts, 0);
		assert.equal(w.counts.intent, 0);
		assert.equal(w.counts.charge, 0);
		assert.equal(w.counts.finish, 0);
		assert.equal(server.records.length, 0, "reuse must never touch the network");
	} finally {
		await server.close();
	}
});

test("WT-07-H: reuse hit without a verifiable result holds as unknown and does not resend", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer();
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const w = wiring({ reuse: async () => ({ found: true, result: { status_code: 200 } }) });
		const result = await execute(adapter, REQ, w.callbacks);
		assert.equal(result.transport_status, "unknown");
		assert.equal(result.error_code, "reuse_unverified");
		assert.equal(result.attempts, 0);
		assert.equal(w.counts.charge, 0);
		assert.equal(server.records.length, 0);
	} finally {
		await server.close();
	}
});

test("WT-07-I: the same tool identity cannot produce a second network effect", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer();
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const store = new Map();
		const key = (id) => JSON.stringify([id.campaign_id, id.task_id, id.episode_id, id.tool_call_id, id.unit_id]);
		const w = wiring({
			reuse: async ({ identity: id }) => {
				const hit = store.get(key(id));
				return hit ? { found: true, result: hit } : { found: false };
			},
			finish: async ({ identity: id, outcome }) => {
				store.set(key(id), outcome.result);
				return { ok: true };
			},
		});
		const first = await execute(adapter, REQ, w.callbacks);
		const second = await execute(adapter, REQ, w.callbacks);
		assert.equal(first.reused, false);
		assert.equal(second.reused, true);
		assert.equal(server.records.length, 1, "second identical call must not hit the network");
		assert.equal(w.counts.charge, 1);
		assert.equal(second.attempts, 0);
	} finally {
		await server.close();
	}
});

test("WT-07-J: identity is required and must match the request digest", async () => {
	const { createWebTargetTable, createWebHttpAdapter, requestDigest } = await load();
	const server = await startServer();
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const w = wiring();
		const missing = await adapter.execute({ request: REQ, identity: null, callbacks: w.callbacks });
		assert.equal(missing.transport_status, "rejected");
		assert.equal(missing.error_code, "invalid_identity");
		const partial = await adapter.execute({ request: REQ, identity: { campaign_id: "c" }, callbacks: w.callbacks });
		assert.equal(partial.error_code, "invalid_identity");
		const wrongDigest = await adapter.execute({
			request: REQ,
			identity: { ...identity(), arguments_digest: "sha256:" + "0".repeat(64) },
			callbacks: w.callbacks,
		});
		assert.equal(wrongDigest.error_code, "identity_mismatch");
		assert.equal(server.records.length, 0);
		// A matching digest passes.  The test computes it independently from the
		// frozen normalization rules, not from the adapter's own output.
		const ok = await adapter.execute({
			request: REQ,
			identity: { ...identity(), arguments_digest: requestDigest(REQ) },
			callbacks: w.callbacks,
		});
		assert.equal(ok.transport_status, "received");
		assert.equal(server.records.length, 1);
	} finally {
		await server.close();
	}
});

test("WT-08-A: a finish failure keeps the REAL transport facts", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer(() => ({ status: 200, body: "real-body" }));
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const w = wiring({ finish: async () => ({ ok: false, error: "append failed" }) });
		const result = await execute(adapter, REQ, w.callbacks);
		assert.equal(result.transport_status, "received");
		assert.equal(result.status_code, 200);
		assert.equal(result.bytes_received, 9);
		assert.equal(result.error_code, "finish_failed");
		assert.equal(result.attempts, 1);
		assert.equal(server.records.length, 1);
	} finally {
		await server.close();
	}
});

test("WT-08-B: a callback throw is a rejection, never a silent success", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer();
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		for (const name of ["reuse", "intent", "charge", "permit"]) {
			const w = wiring({
				[name]: async () => {
					throw new Error(`${name} exploded`);
				},
			});
			const result = await execute(adapter, REQ, w.callbacks);
			assert.equal(result.transport_status, "rejected", name);
			assert.ok(result.error_code, name);
		}
		assert.equal(server.records.length, 0);
	} finally {
		await server.close();
	}
});

test("WT-10-A: the permit callback observes state written after the intent await", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer();
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const state = { latest: false };
		let releaseBarrier;
		const barrier = new Promise((resolve) => {
			releaseBarrier = resolve;
		});
		const observed = [];
		const w = wiring({
			intent: async () => {
				// Simulate a durable append that takes time: the permit must be read
				// from the state AFTER this resolves.
				await barrier;
				state.latest = true;
				return { ok: true, durable: true, intent_ref: "intent-1" };
			},
			permit: async () => {
				observed.push(state.latest);
				return {
					ok: true,
					permit: { mode: "auto", action_ref: "web.request", action_version: 1, permit_id: "p" },
				};
			},
		});
		const pending = execute(adapter, REQ, w.callbacks);
		// Nothing may reach the permit while the intent is pending.
		assert.deepEqual(observed, []);
		releaseBarrier();
		const result = await pending;
		assert.deepEqual(observed, [true]);
		assert.equal(result.transport_status, "received");
	} finally {
		await server.close();
	}
});

test("WT-10-B: a permit revoked during the await produces zero effect", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer();
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		const w = wiring({
			intent: async () => {
				await new Promise((r) => setTimeout(r, 20));
				return { ok: true, durable: true, intent_ref: "intent-1" };
			},
			permit: async () => ({ ok: false, reason: "task superseded" }),
		});
		const result = await execute(adapter, REQ, w.callbacks);
		assert.equal(result.transport_status, "rejected");
		assert.equal(server.records.length, 0);
	} finally {
		await server.close();
	}
});

test("WT-07-K: artifact refs come only from the injected callback", async () => {
	const { createWebTargetTable, createWebHttpAdapter } = await load();
	const server = await startServer(() => ({ status: 200, body: "with-artifact" }));
	try {
		const table = createWebTargetTable([target(server.origin)]);
		const adapter = createWebHttpAdapter({ targets: table.table });
		// No artifact callback => no ref is invented.
		const w1 = wiring();
		const r1 = await execute(adapter, REQ, w1.callbacks);
		assert.equal(r1.body_ref, null);
		// Injected callback => the ref/digest it returns is used verbatim.
		const w2 = wiring({
			finish: async () => ({ ok: true, body_ref: "artifact:web-1", body_digest: "sha256:" + "a".repeat(64) }),
		});
		const r2 = await execute(adapter, REQ, w2.callbacks, identity({ tool_call_id: "tool-2" }));
		assert.equal(r2.body_ref, "artifact:web-1");
	} finally {
		await server.close();
	}
});
