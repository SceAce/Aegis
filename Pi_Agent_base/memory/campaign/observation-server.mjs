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

import { parseJsonl, verifyChain } from "../runtime/events.mjs";
import { loadManifest } from "./manifest.mjs";
import {
	buildObservationView,
	escapeHtml,
	OBSERVATION_LIMITS,
	OBSERVATION_VIEW_VERSION,
	renderObservationHtml,
	summarizeObservationView,
} from "./observation-view.mjs";

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
]);

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
	return { ok: chain.ok, reason: chain.ok ? null : "event chain integrity failed", view };
}

function unavailableView(reason) {
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
	let closed = false;
	let current = null; // last successfully built view (for a stale serving on error)

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
		if (result.ok || !current) current = result.view;
		else if (!result.ok && current) {
			// Keep the last good view but mark it stale; never lose it silently.
			current = {
				...current,
				integrity: { ...current.integrity, stale: true, status: "stale_after_error", errors: [result.reason] },
			};
		}
		return result;
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			json(res, 500, { ok: false, error: String(error) });
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
		// Query params may ONLY page/limit. Any other key is ignored, never a path.
		const page = Number.parseInt(url.searchParams.get("page") ?? "", 10);
		const pageSize = Number.parseInt(url.searchParams.get("page_size") ?? "", 10);

		const result = await view({
			page: Number.isNaN(page) ? 0 : page,
			page_size: Number.isNaN(pageSize) ? null : pageSize,
		});
		const v = result.view;
		if (path === "/healthz") return json(res, 200, { ok: true, integrity: v.integrity?.status ?? "unknown" });
		if (path === "/") return html(res, 200, renderObservationHtml(v));
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
		return json(res, 404, { ok: false, error: "not found" });
	}

	function bounded(value) {
		const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
		if (bytes <= limits.max_view_bytes) return value;
		return {
			truncated: true,
			reason: `response exceeded max_view_bytes ${limits.max_view_bytes}`,
			integrity: value.integrity ?? null,
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
			return `http://${host}:${actualPort}/`;
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
