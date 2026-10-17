// Bounded HTTP adapter. All execution authority is supplied by the trusted Host.

import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { digest } from "../../shared/contracts.mjs";

export const WEB_ADAPTER_LIMITS_DEFAULT = Object.freeze({
	timeout_ms: 10000,
	max_response_bytes: 1048576,
	max_body_bytes: 1048576,
	max_decompressed_bytes: 4194304,
	max_redirects: 0,
});
export const WEB_TRANSPORT_STATUSES = Object.freeze(["received", "rejected", "unknown"]);
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const plain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const forbiddenHeader = /^(host|content-length|transfer-encoding|connection|proxy-.*|upgrade|te|trailer|keep-alive)$/i;
export const requestDigest = (request) => digest(request);
export class WebTargetTable {
	#entries;
	constructor(entries) {
		this.#entries = new Map(entries.map((entry) => [entry.target_id, structuredClone(entry)]));
	}
	get(id) {
		const entry = this.#entries.get(id);
		return entry ? structuredClone(entry) : null;
	}
}
export function createWebTargetTable(targets) {
	const reasons = [];
	if (!Array.isArray(targets) || !targets.length) return { ok: false, reasons: ["targets required"] };
	const seen = new Set();
	for (const t of targets) {
		try {
			if (!plain(t) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t.target_id) || seen.has(t.target_id))
				throw new Error("target identity");
			seen.add(t.target_id);
			const u = new URL(t.origin);
			if (
				!["http:", "https:"].includes(u.protocol) ||
				u.origin !== t.origin ||
				u.protocol !== `${t.scheme}:` ||
				t.network !== true ||
				t.max_requests !== 1
			)
				throw new Error("origin/network");
			if (
				!Array.isArray(t.allowed_methods) ||
				!t.allowed_methods.length ||
				t.allowed_methods.some((m) => !/^[A-Z]+$/.test(m))
			)
				throw new Error("methods");
			if (
				!Array.isArray(t.allowed_paths) ||
				!t.allowed_paths.length ||
				t.allowed_paths.some(
					(p) => typeof p !== "string" || !p.startsWith("/") || p.startsWith("//") || /[?#\r\n]/.test(p),
				)
			)
				throw new Error("paths");
			for (const [key, value] of Object.entries(t.limits ?? {}))
				if (
					!(key in WEB_ADAPTER_LIMITS_DEFAULT) ||
					!Number.isSafeInteger(value) ||
					(key === "max_redirects" ? value !== 0 : value < 1)
				)
					throw new Error("limits");
		} catch (error) {
			reasons.push(`invalid target: ${error.message}`);
		}
	}
	return reasons.length ? { ok: false, reasons } : { ok: true, table: new WebTargetTable(targets), reasons };
}
export function validateHttpRequest(request, { targetTable } = {}) {
	const reasons = [];
	const target = targetTable?.get(request?.target_id);
	if (!plain(request) || !target) return { ok: false, reasons: ["unknown target or invalid request"] };
	const allowed = ["target_id", "method", "path_query", "headers", "body", "session_id"];
	for (const key of Object.keys(request)) if (!allowed.includes(key)) reasons.push(`unknown field ${key}`);
	const method = typeof request.method === "string" ? request.method.toUpperCase() : "";
	if (!target.allowed_methods.includes(method)) reasons.push("method not authorized");
	const path = request.path_query;
	if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\x00-\x20\x7f#]|:\/\//.test(path))
		reasons.push("invalid path");
	else {
		let decoded;
		try {
			decoded = decodeURIComponent(path.split("?")[0]);
		} catch {
			reasons.push("invalid path encoding");
		}
		if (
			decoded &&
			(decoded.split("/").includes("..") ||
				decoded.includes("\\") ||
				!target.allowed_paths.some(
					(prefix) => prefix === "/" || decoded === prefix || decoded.startsWith(prefix.replace(/\/$/, "") + "/"),
				))
		)
			reasons.push("path not authorized");
	}
	if (!Array.isArray(request.headers)) reasons.push("headers required");
	else
		for (const pair of request.headers) {
			if (
				!Array.isArray(pair) ||
				pair.length !== 2 ||
				typeof pair[0] !== "string" ||
				typeof pair[1] !== "string" ||
				!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair[0]) ||
				/[\r\n\x00]/.test(pair[1])
			)
				reasons.push("invalid header");
			else if (forbiddenHeader.test(pair[0])) reasons.push(`forbidden header ${pair[0]}`);
		}
	let bytes = Buffer.alloc(0);
	if (request.body !== null && request.body !== undefined) {
		const body = request.body;
		if (!plain(body) || !["utf8", "base64"].includes(body.encoding) || typeof body.data !== "string")
			reasons.push("invalid body");
		else if (
			body.encoding === "base64" &&
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)
		)
			reasons.push("invalid base64");
		else bytes = Buffer.from(body.data, body.encoding);
		if (["GET", "HEAD"].includes(method)) reasons.push("body not allowed for method");
	}
	if (bytes.length > (target.limits?.max_body_bytes ?? WEB_ADAPTER_LIMITS_DEFAULT.max_body_bytes))
		reasons.push("body_too_large");
	if (
		request.session_id !== null &&
		request.session_id !== undefined &&
		(typeof request.session_id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(request.session_id))
	)
		reasons.push("invalid session_id");
	return { ok: reasons.length === 0, reasons, normalized: reasons.length ? null : { ...request, method } };
}
export function createCookieJar({ run_id, instance_id } = {}) {
	let cookies = [];
	const session = (value) => value ?? "default";
	function storeFromResponse({ url, setCookie = [], now = Date.now(), session_id = null }) {
		for (const line of setCookie) {
			const [first, ...attrs] = line.split(";");
			const split = first.indexOf("=");
			if (split <= 0) continue;
			const name = first.slice(0, split).trim(),
				value = first.slice(split + 1).trim();
			if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\x00;]/.test(value)) continue;
			const c = {
				name,
				value,
				domain: url.host.toLowerCase(),
				hostOnly: true,
				path: url.path?.includes("/") ? url.path.slice(0, url.path.lastIndexOf("/") + 1) || "/" : "/",
				secure: false,
				expires: null,
				session: session(session_id),
			};
			let maxAge = null;
			for (const attr of attrs) {
				const [key, ...rest] = attr.trim().split("=");
				const val = rest.join("=");
				if (key.toLowerCase() === "domain") {
					c.domain = val.replace(/^\./, "").toLowerCase();
					c.hostOnly = false;
				}
				if (key.toLowerCase() === "path" && val.startsWith("/")) c.path = val;
				if (key.toLowerCase() === "secure") c.secure = true;
				if (key.toLowerCase() === "expires" && Number.isFinite(Date.parse(val))) c.expires = Date.parse(val);
				if (key.toLowerCase() === "max-age" && /^-?\d+$/.test(val)) maxAge = Number(val);
			}
			if (maxAge !== null) c.expires = now + maxAge * 1000;
			if (!(url.host === c.domain || (!c.hostOnly && url.host.endsWith(`.${c.domain}`)))) continue;
			cookies = cookies.filter(
				(old) => !(old.name === c.name && old.domain === c.domain && old.path === c.path && old.session === c.session),
			);
			if (c.expires === null || c.expires > now) cookies.push(c);
		}
	}
	function headerFor({ host, path = "/", secure = false, session_id = null }, now = Date.now()) {
		return cookies
			.filter(
				(c) =>
					c.session === session(session_id) &&
					(c.expires === null || c.expires > now) &&
					(!c.secure || secure) &&
					(host === c.domain || (!c.hostOnly && host.endsWith(`.${c.domain}`))) &&
					(path === c.path || path.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`)),
			)
			.sort((a, b) => b.path.length - a.path.length)
			.map((c) => `${c.name}=${c.value}`)
			.join("; ");
	}
	function snapshot() {
		const state = { run_id, instance_id, cookies: structuredClone(cookies) };
		return { ...state, digest: digest(state) };
	}
	function restore(s) {
		if (!plain(s) || s.run_id !== run_id || s.instance_id !== instance_id)
			return { ok: false, error: "foreign_session" };
		const state = { run_id: s.run_id, instance_id: s.instance_id, cookies: s.cookies };
		if (
			!Array.isArray(s.cookies) ||
			s.digest !== digest(state) ||
			s.cookies.some(
				(c) =>
					!plain(c) || typeof c.name !== "string" || typeof c.value !== "string" || /[\r\n]/.test(c.name + c.value),
			)
		)
			return { ok: false, error: "corrupt_session" };
		cookies = structuredClone(s.cookies);
		return { ok: true };
	}
	return {
		storeFromResponse,
		headerFor,
		snapshot,
		restore,
		summary: () => ({ count: cookies.length, digest: digest(cookies) }),
	};
}
export function createNodeHttpTransport() {
	return ({ target, request, jar, session_id, signal }) =>
		new Promise((resolve) => {
			const url = new URL(target.origin),
				limits = { ...WEB_ADAPTER_LIMITS_DEFAULT, ...target.limits };
			const headers = ["Host", url.host, ...request.headers.flat()];
			const cookie = jar.headerFor({
				host: url.hostname,
				path: request.path_query.split("?")[0],
				secure: url.protocol === "https:",
				session_id,
			});
			if (cookie) headers.push("Cookie", cookie);
			const body = request.body ? Buffer.from(request.body.data, request.body.encoding) : Buffer.alloc(0);
			if (body.length) headers.push("Content-Length", String(body.length));
			let settled = false,
				response = null,
				chunks = [],
				size = 0;
			const finish = (result) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(result);
				}
			};
			const transport = url.protocol === "https:" ? https : http;
			const req = transport.request(
				{
					protocol: url.protocol,
					hostname: url.hostname,
					port: url.port,
					method: request.method,
					path: request.path_query,
					headers,
					agent: false,
					signal,
				},
				(res) => {
					response = res;
					const pairs = [];
					for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
					const complete = (truncated = false) => {
						let bytes = Buffer.concat(chunks),
							compressed = Boolean(res.headers["content-encoding"]);
						try {
							const fn = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[
								res.headers["content-encoding"]
							];
							if (fn) bytes = fn(bytes, { maxOutputLength: limits.max_decompressed_bytes });
							else if (compressed) throw new Error("unsupported encoding");
						} catch {
							finish({
								transport_status: "unknown",
								error_code: "decompressed_too_large",
								compressed,
								bytes: Buffer.alloc(0),
								headers: pairs,
							});
							return;
						}
						jar.storeFromResponse({
							url: { host: url.hostname, path: request.path_query.split("?")[0], secure: url.protocol === "https:" },
							setCookie: res.headers["set-cookie"] ?? [],
							session_id,
						});
						finish({
							transport_status: "received",
							status_code: res.statusCode,
							headers: pairs,
							bytes,
							truncated,
							compressed,
						});
					};
					res.on("data", (chunk) => {
						const rest = limits.max_response_bytes - size;
						chunks.push(chunk.subarray(0, rest));
						size += Math.min(rest, chunk.length);
						if (chunk.length > rest) {
							complete(true);
							res.destroy();
						}
					});
					res.on("end", () => complete());
					res.on("error", () => finish({ transport_status: "unknown", error_code: "truncated_response" }));
				},
			);
			const timer = setTimeout(() => {
				finish({ transport_status: "unknown", error_code: "timeout" });
				req.destroy();
				response?.destroy();
			}, limits.timeout_ms);
			req.on("error", () => finish({ transport_status: "unknown", error_code: "conn_error" }));
			req.end(body);
		});
}
export function createWebHttpAdapter({
	targets,
	transport = createNodeHttpTransport(),
	cookieJar = createCookieJar(),
} = {}) {
	const inFlight = new Set();
	return {
		async execute({ request, identity, callbacks = {}, signal }) {
			const base = {
				transport_status: "rejected",
				status_code: null,
				headers: [],
				body_preview: "",
				body_base64: null,
				body_ref: null,
				body_digest: null,
				bytes_received: 0,
				truncated: false,
				compressed: false,
				session_id: request?.session_id ?? null,
				cookie_summary: cookieJar.summary(),
				attempts: 0,
				identity,
				intent_ref: null,
				charge_id: null,
				reused: false,
				outcome_candidate: null,
				error_code: null,
				error_detail: null,
			};
			const refuse = (code, detail = null) => ({ ...base, error_code: code, error_detail: detail });
			const validation = validateHttpRequest(request, { targetTable: targets });
			if (!validation.ok)
				return refuse(
					validation.reasons.includes("body_too_large") ? "body_too_large" : "invalid_request",
					validation.reasons.join("; "),
				);
			if (
				!plain(identity) ||
				["campaign_id", "task_id", "episode_id", "request_id", "tool_call_id", "unit_id"].some(
					(key) => typeof identity[key] !== "string" || !identity[key],
				)
			)
				return refuse("invalid_identity");
			if (identity.arguments_digest && identity.arguments_digest !== requestDigest(request))
				return refuse("identity_mismatch");
			const key = digest(identity);
			if (inFlight.has(key)) return { ...refuse("duplicate_in_flight"), transport_status: "unknown" };
			inFlight.add(key);
			try {
				const reuse = await callbacks.reuse({ identity });
				if (reuse?.found)
					return reuse.result?.transport_status && Number.isInteger(reuse.result.bytes_received)
						? { ...base, ...reuse.result, reused: true, attempts: 0 }
						: { ...refuse("reuse_unverified"), transport_status: "unknown" };
				const intent = await callbacks.intent({ identity, request_digest: requestDigest(request) });
				if (intent?.ok !== true || intent.durable !== true || !intent.intent_ref) return refuse("intent_not_durable");
				base.intent_ref = intent.intent_ref;
				const charge = await callbacks.charge({ identity, intent_ref: base.intent_ref });
				if (charge?.ok !== true) return refuse("charge_failed");
				base.charge_id = charge.charge_id;
				const grant = await callbacks.permit({ identity, intent_ref: base.intent_ref });
				const p = grant?.permit;
				if (
					grant?.ok !== true ||
					p?.mode !== "auto" ||
					p.action_ref !== "web.request" ||
					p.action_version !== 1 ||
					!p.permit_id ||
					(p.target_id && p.target_id !== request.target_id) ||
					(p.expires_at && !(Date.parse(p.expires_at) > Date.now()))
				)
					return refuse("permit_denied");
				const session_id = request.session_id ?? `s-${randomUUID()}`;
				const observed = await transport({
					target: targets.get(request.target_id),
					request: validation.normalized,
					jar: cookieJar,
					session_id,
					signal,
				});
				const bytes = observed.bytes ?? Buffer.alloc(0);
				const body = request.body ? Buffer.from(request.body.data, request.body.encoding) : Buffer.alloc(0);
				const result = {
					...base,
					...observed,
					bytes: undefined,
					attempts: 1,
					session_id,
					body_preview: bytes.toString("utf8").slice(0, 16384),
					body_base64: bytes.toString("base64"),
					body_digest: sha(bytes),
					bytes_received: bytes.length,
					cookie_summary: cookieJar.summary(),
					requested: {
						method: request.method,
						path_query: request.path_query,
						header_names: request.headers.map((h) => h[0]),
						body_bytes: body.length,
						body_digest: sha(body),
					},
				};
				try {
					const finished = await callbacks.finish({ identity, outcome: { result, error_code: result.error_code } });
					if (finished?.ok !== true) result.error_code = "finish_failed";
					else {
						result.body_ref = finished.body_ref ?? null;
						result.body_digest = finished.body_digest ?? result.body_digest;
					}
				} catch {
					result.error_code = "finish_failed";
				}
				return result;
			} catch (error) {
				return refuse(base.intent_ref ? "callback_failed" : "intent_not_durable", error.message);
			} finally {
				inFlight.delete(key);
			}
		},
	};
}
