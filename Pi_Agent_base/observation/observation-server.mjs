// Aegis C4a — localhost read-only observation HTTP server.
//
// Serves a bounded, escaped HTML page and a read-only JSON API derived from the
// SAME observation view as the Pi command and the C4 report. It is a read-only
// client: there is NO write route, it cannot pause/cancel/authorize, and it
// never reads an arbitrary file from a query/path parameter.
//
// Lifecycle: bind loopback, expose `url`/`port`, `close()` is idempotent and
// releases the port. A failed UI never blocks the Host.
//
// Honest boundary: loopback is NOT a security boundary against a local hostile
// process; this is a local, single-user observation surface, not a remote admin
// plane.

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { loadManifest } from "../campaign/manifest.mjs";
import { parseJsonl, verifyChain } from "../shared/events.mjs";
import { buildE1Explorer } from "./e1-explorer.mjs";
import { E1_EXPLORER_CLIENT_JS } from "./e1-explorer-client.mjs";
import {
	buildObservationView,
	escapeHtml,
	OBSERVATION_LIMITS,
	OBSERVATION_VIEW_VERSION,
	renderObservationHtml,
	summarizeObservationView,
} from "./observation-view.mjs";
import { redactSecrets } from "./report.mjs";

export const OBSERVATION_SERVER_VERSION = "1.0.0";

const READONLY_ROUTES = new Set([
	"/",
	"/healthz",
	"/api/view",
	"/api/tasks",
	"/api/queue",
	"/api/actions",
	"/api/outcomes",
	"/api/faults",
	"/api/board",
	"/api/task-graph",
	"/api/plans",
	"/api/requests",
	// OBS-01: bounded, continuable E1 exploration (still read-only).
	"/api/e1/board",
	"/api/e1/graph",
	"​/api/e1/node",
	"/api/e1/edge",
	"/api/e1/state",
	// OBS-01: the read-only exploration client (a static, fixed asset).
	"/e1-explorer.js",
]);

/** The fixed JS asset routes. No other asset can ever be requested. */
const STATIC_ASSETS = new Map([
	["/e1-explorer.js", { type: "text/javascript; charset=utf-8", body: E1_EXPLORER_CLIENT_JS }],
]);

/**
 * The ONLY query keys any route accepts. Everything else is a 400, never a
 * silently ignored parameter: an unknown key cannot reach a file or a command.
 */
const ALLOWED_QUERY_KEYS = new Set([
	"page",
	"page_size",
	"type",
	"status",
	"task_id",
	"episode_id",
	"relation",
	"q",
	"cursor",
	"since_state_revision",
	"kind",
	"edge_offset",
]);

/** E1 explorer routes reuse ONE view: the page summary is part of `/api/view`. */
const E1_ROUTES = new Set(["/api/e1/board", "/api/e1/graph", "/api/e1/node", "/api/e1/edge", "/api/e1/state"]);

function json(res, status, body) {
	const text = `${JSON.stringify(body, null, 2)}\n`;
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
	});
	res.end(text);
}
function html(res, status, text) {
	res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(text) });
	res.end(text);
}

/**
 * Read the committed source and build the observation view. Read-only; a
 * missing/unparseable file yields an explicit unavailable view, never a guess.
 */
async function readView({ manifestPath, eventsPath, artifactsPath, runtimePath, limits, page, pageSize }) {
	if (!manifestPath || !existsSync(manifestPath)) {
		return { ok: false, reason: "manifest not found", view: unavailableView("manifest not found") };
	}
	if (!eventsPath || !existsSync(eventsPath)) {
		return { ok: false, reason: "events not found", view: unavailableView("event log not found") };
	}
	const loaded = await loadManifest(manifestPath);
	if (!loaded.ok)
		return {
			ok: false,
			reason: `manifest invalid: ${loaded.reasons.join("; ")}`,
			view: unavailableView("manifest invalid"),
		};
	const { rows, errors } = parseJsonl(readFileSync(eventsPath, "utf8"));
	const chain = errors.length === 0 ? verifyChain(rows) : { ok: false, errors };
	let artifacts = {};
	if (artifactsPath && existsSync(artifactsPath)) {
		try {
			artifacts = JSON.parse(readFileSync(artifactsPath, "utf8"));
		} catch {
			artifacts = {};
		}
	}
	let runtimeDigests = {};
	if (runtimePath && existsSync(runtimePath)) {
		try {
			runtimeDigests = JSON.parse(readFileSync(runtimePath, "utf8"));
		} catch {
			runtimeDigests = {};
		}
	}
	if (!chain.ok) {
		const view = unavailableView("event chain integrity failed");
		view.integrity.status = "integrity_failure";
		view.integrity.errors = redactSecrets(chain.errors.slice(0, 5));
		return { ok: false, reason: "event chain integrity failed", view };
	}
	const view = buildObservationView({
		manifest: loaded.manifest,
		// Pass the parsed rows either way: buildReportInputs preserves the integrity
		// diagnostic and refuses to reduce a non-verifying chain to success.
		events: rows,
		artifacts,
		runtimeDigests,
		limits,
		generatedAt: new Date().toISOString(),
		page,
		page_size: pageSize,
	});
	// The view's own integrity is authoritative; surface a bad chain explicitly.
	if (!chain.ok) {
		view.integrity = {
			...view.integrity,
			event_chain_ok: false,
			stale: true,
			status: "integrity_failure",
			errors: chain.errors.slice(0, 5),
		};
	}
	return {
		ok: chain.ok,
		reason: chain.ok ? null : "event chain integrity failed",
		view,
		manifest: loaded.manifest,
		events: rows,
	};
}

export function unavailableView(reason) {
	return {
		schema_version: OBSERVATION_VIEW_VERSION,
		generated_at: null,
		campaign_id: null,
		integrity: {
			event_chain_ok: false,
			event_count: null,
			last_committed_digest: null,
			last_committed_offset: null,
			stale: true,
			status: "unavailable",
			errors: [reason],
		},
		control: { state: "unavailable", reason },
		counts: {},
		committed_counts: {},
		budget: null,
		task_counts: {},
		tasks: [],
		task_lifecycle: [],
		stages: [],
		outcomes: [],
		proposals: [],
		actions: { items: [], total: 0, returned: 0, truncated: false },
		faults: [],
		missing_evidence: [],
		conflicts: [],
		authorization: null,
		unsupported_claims: [],
		report_refs: { report_digest: null, bundle_digest: null },
		pagination: {},
		limits: OBSERVATION_LIMITS,
		board: { nodes: [], by_type: {}, history_by_type: {}, summary: {}, rejections: [], truncated: false },
		task_graph: { root: null, nodes: [], edges: [], counts: {}, diagnostics: [] },
		plans: { admitted: [], candidates: [] },
		requests: { consumed: {}, by_task: {}, campaign_pending: [], task_pending: [], unresolved: 0, diagnostics: [] },
		state_revision: null,
		state: null,
		e1_explorer: null,
	};
}

/**
 * @param {{manifestPath: string, eventsPath: string, artifactsPath?: string|null,
 *   runtimePath?: string|null, host?: string, port?: number, limits?: any}} args
 */
export function createObservationServer(
	{
		manifestPath,
		eventsPath,
		artifactsPath = null,
		runtimePath = null,
		host = "127.0.0.1",
		port = 0,
		limits = OBSERVATION_LIMITS,
	} = /** @type {any} */ ({}),
) {
	if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("observation server requires a loopback host");
	limits = { ...OBSERVATION_LIMITS, ...limits };
	let closed = false;

	async function view(params = {}) {
		const result = await readView({
			manifestPath,
			eventsPath,
			artifactsPath,
			runtimePath,
			limits,
			page: params.page,
			pageSize: params.page_size,
		});
		// Serve an explicit unavailable view on error; do not retain an unused
		// cache or claim that stale successful data is being served.
		if (!params.withInputs) return { ...result, manifest: undefined, events: undefined };
		return result;
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			void error;
			json(res, 500, { ok: false, error: "observation source unavailable" });
		});
	});

	async function handle(req, res) {
		const method = req.method ?? "GET";
		let url;
		try {
			url = new URL(req.url ?? "/", `http://${host}`);
		} catch {
			return json(res, 400, { ok: false, error: "invalid url" });
		}
		if (method !== "GET" && method !== "HEAD") {
			// NO write route exists. A mutation attempt is explicitly refused.
			return json(res, 405, { ok: false, error: "read-only server: method not allowed", method });
		}
		const path = url.pathname;
		if (!READONLY_ROUTES.has(path)) return json(res, 404, { ok: false, error: "not found", path });
		// Query params are a WHITELIST. An unknown key is an explicit 400 (never a
		// silently ignored parameter that a client could mistake for an applied
		// filter), and no parameter can ever name a file or a command.
		const params = {};
		const unknownParams = [];
		for (const [key] of url.searchParams) {
			if (!ALLOWED_QUERY_KEYS.has(key)) unknownParams.push(key.slice(0, 64));
		}
		for (const key of ALLOWED_QUERY_KEYS) {
			const value = url.searchParams.get(key);
			if (value !== null) params[key] = value;
		}
		// An unknown key is IGNORED (never reaches a file or a command) on the
		// legacy routes. The E1 exploration routes are stricter: they reject an
		// unknown key so a client cannot mistake an unapplied filter for one that
		// took effect.
		if (unknownParams.length > 0 && E1_ROUTES.has(path))
			return json(res, 400, { ok: false, error: "unknown query parameter", parameters: unknownParams });

		const result = await view({
			page: params.page === undefined ? 0 : Number.parseInt(params.page, 10),
			page_size: params.page_size === undefined ? null : Number.parseInt(params.page_size, 10),
			// E1 explorer routes need the SAME loaded inputs the view used.
			withInputs: E1_ROUTES.has(path),
		});
		const v = result.view;
		if (path === "/healthz") return json(res, 200, { ok: result.ok, integrity: v.integrity?.status ?? "unknown" });
		if (path === "/") {
			const page = renderObservationHtml(v);
			return html(
				res,
				200,
				Buffer.byteLength(page, "utf8") <= limits.max_view_bytes
					? page
					: "<!doctype html><p>Observation page exceeds the configured byte limit. Use a bounded API page.</p>",
			);
		}
		if (STATIC_ASSETS.has(path)) {
			const asset = STATIC_ASSETS.get(path);
			res.writeHead(200, {
				"content-type": asset.type,
				"content-length": Buffer.byteLength(asset.body),
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			});
			return res.end(asset.body);
		}
		if (path === "/api/view") return json(res, 200, bounded(v));
		if (path === "/api/tasks")
			return json(res, 200, bounded({ integrity: v.integrity, tasks: v.tasks, pagination: v.pagination?.tasks }));
		if (path === "/api/queue")
			return json(
				res,
				200,
				bounded({ control: v.control, proposals: v.proposals, pagination: v.pagination?.proposals }),
			);
		if (path === "/api/actions")
			return json(
				res,
				200,
				bounded({ counts: v.committed_counts?.actions ?? {}, actions: v.actions, pagination: v.pagination?.actions }),
			);
		if (path === "/api/outcomes")
			return json(res, 200, bounded({ outcomes: v.outcomes, pagination: v.pagination?.outcomes }));
		if (path === "/api/faults")
			return json(
				res,
				200,
				bounded({
					faults: v.faults,
					missing_evidence: v.missing_evidence,
					conflicts: v.conflicts,
					pagination: v.pagination?.faults,
				}),
			);
		if (path === "/api/board")
			return json(res, 200, bounded({ integrity: v.integrity, board: v.board, requests: v.requests }));
		if (path === "/api/task-graph")
			return json(
				res,
				200,
				bounded({ integrity: v.integrity, root: v.task_graph?.root ?? null, task_graph: v.task_graph, plans: v.plans }),
			);
		if (path === "/api/plans") return json(res, 200, bounded({ integrity: v.integrity, plans: v.plans }));
		if (path === "/api/requests")
			return json(res, 200, bounded({ integrity: v.integrity, requests: v.requests, budget: v.budget }));
		if (E1_ROUTES.has(path)) return e1Route(path, params, result, res);
		return json(res, 404, { ok: false, error: "not found" });
	}

	/**
	 * OBS-01 E1 exploration routes. All of them are read-only projections of the
	 * SAME committed state. A foreign/unknown node or edge is an explicit 404 with
	 * `foreign_reference: true`; it never resolves to another task's data.
	 */
	function e1Route(path, params, result, res) {
		const v = result.view;
		if (path === "/api/e1/state")
			return json(
				res,
				200,
				bounded({
					ok: result.ok,
					integrity: v.integrity,
					state_revision: v.state_revision ?? null,
					state: v.state ?? null,
					e1: v.e1_explorer ?? null,
				}),
			);
		if (!result.ok || !result.manifest)
			return json(res, 200, {
				ok: false,
				status: "unavailable",
				integrity: v.integrity,
				errors: [result.reason ?? "observation source unavailable"],
			});
		const query = { ...params, kind: path === "/api/e1/board" ? "board" : "graph" };
		if (path === "/api/e1/node" || path === "/api/e1/edge") {
			if (!query.task_id && !query.q) {
				return json(res, 400, { ok: false, error: "task_id (node) or q=<from->to> (edge) is required" });
			}
			if (path === "/api/e1/edge" && !query.relation) query.relation = "depends_on";
		}
		const explorer = buildE1Explorer({
			manifest: result.manifest,
			events: result.events ?? [],
			board: v.board ?? null,
			query,
			integrityOk: true,
		});
		if (explorer.ok) return json(res, 200, bounded(explorer));
		if ("status" in explorer && explorer.status === "not_found") return json(res, 404, bounded(explorer));
		return json(
			res,
			400,
			bounded({ ok: false, errors: "errors" in explorer ? explorer.errors : [], error: "invalid query" }),
		);
	}

	function bounded(value) {
		const bytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		if (bytes <= limits.max_view_bytes) return value;
		return {
			truncated: true,
			reason: `response exceeded max_view_bytes ${limits.max_view_bytes}`,
			integrity: value.integrity ? { status: value.integrity.status, stale: value.integrity.stale } : null,
		};
	}

	return {
		server,
		host,
		get port() {
			const address = server.address();
			return address && typeof address === "object" ? address.port : port;
		},
		get url() {
			const address = server.address();
			const actualPort = address && typeof address === "object" ? address.port : port;
			return `http://${host === "::1" ? "[::1]" : host}:${actualPort}/`;
		},
		async listen() {
			if (closed) throw new Error("observation server is closed");
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, () => {
					server.removeListener("error", reject);
					resolve(undefined);
				});
			});
			return this.url;
		},
		async close() {
			if (closed) return { ok: true, alreadyClosed: true };
			closed = true;
			await new Promise((resolve) => server.close(() => resolve(undefined)));
			return { ok: true };
		},
		view,
		summary: async () => summarizeObservationView((await view()).view),
	};
}

export { summarizeObservationView, escapeHtml };
