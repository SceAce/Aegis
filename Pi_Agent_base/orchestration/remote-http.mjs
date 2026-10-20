// Trusted platform HTTP adapter. The Cookie header is supplied by the local
// cookie broker and is never returned to the model. All calls pass the same
// remote-platform gate; redirects to another origin and raw replay are refused.

import { digest } from "../shared/events.mjs";

const MAX_BODY = 64 * 1024;

function sameOrigin(value, origin) {
	try {
		return new URL(value).origin === origin;
	} catch {
		return false;
	}
}

/**
 * @param {{
 *   origin: string,
 *   cookieHeader: string,
 *   gate: ReturnType<import("./remote-platform.mjs").createRemotePlatformGate>,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} options
 */
export function createRemoteHttpClient({ origin, cookieHeader, gate, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
	let parsed;
	try {
		parsed = new URL(origin);
	} catch {
		throw new Error("remote HTTP requires an absolute origin");
	}
	if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("remote HTTP requires http(s)");
	const base = parsed.origin;
	const cookie = typeof cookieHeader === "string" ? cookieHeader : "";
	const clock = () => Date.now();
	let sequence = 0;

	async function request(
		pathname,
		{ method = "GET", body = null, headers = {}, actionKey = null, kind = "navigation" } = {},
	) {
		const url = new URL(pathname, `${base}/`);
		if (url.origin !== base) return { ok: false, reason: "origin_not_allowed" };
		const upper = String(method).toUpperCase();
		if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(upper)) return { ok: false, reason: "method_not_allowed" };
		const key =
			actionKey ?? (upper === "POST" ? `request:${digest(`${upper}:${url.pathname}:${body ?? ""}`)}` : undefined);
		const admitted = gate?.admit({
			kind: upper === "GET" ? kind : kind === "navigation" ? "submit" : kind,
			origin: base,
			key,
			replay: false,
		});
		if (admitted && admitted.ok === false)
			return { ok: false, reason: admitted.reason, nextAllowedAt: admitted.nextAllowedAt };
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetchImpl(url, {
				method: upper,
				headers: {
					...(cookie ? { cookie } : {}),
					...(body !== null && !headers["content-type"] ? { "content-type": "application/json" } : {}),
					...headers,
				},
				body: body === null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
				redirect: "manual",
				signal: controller.signal,
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (location && !sameOrigin(new URL(location, url).href, base))
					return { ok: false, reason: "cross_origin_redirect" };
				return { ok: false, reason: "redirect_not_followed", status: response.status };
			}
			const text = (await response.text()).slice(0, MAX_BODY);
			return {
				ok: true,
				status: response.status,
				contentType: response.headers.get("content-type") ?? null,
				text,
				truncated: text.length >= MAX_BODY,
				request: { method: upper, path: url.pathname, sequence: ++sequence, at: clock() },
			};
		} catch (error) {
			return { ok: false, reason: error?.name === "AbortError" ? "timeout" : "request_failed" };
		} finally {
			clearTimeout(timer);
		}
	}

	return { origin: base, request };
}
