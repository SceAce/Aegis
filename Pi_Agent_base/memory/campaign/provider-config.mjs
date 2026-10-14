// Aegis C6-D — explicit provider/model configuration and creation interface.
//
// The user selects a provider through the TRUSTED config file. This module turns
// that selection into the exact arguments the SDK's creation seam needs, and
// refuses anything it does not recognize. It NEVER reads the user's default
// auth/models/settings and NEVER prints a credential value.
//
// The development default is the offline `faux` provider. A `local-*` provider
// is only accepted with a loopback `base_url`. E1 adds an explicit HTTPS
// `remote-openai` endpoint with an env credential reference. Provider selection
// never makes a request; the user-operated run command starts real inference.

import { isAbsolute, resolve } from "node:path";

export const PROVIDER_CONFIG_VERSION = "1.0";

/**
 * Known provider kinds.
 *
 * `implemented: true` means C6 can produce the SDK creation arguments for it
 * (model + isolated runtime + endpoint/credential references) without any real
 * network call. Native vendor kinds remain unimplemented; compatible endpoints
 * use the explicitly selected local-openai or remote-openai path.
 */
export const KNOWN_PROVIDERS = Object.freeze({
	faux: { implemented: true, offline: true, requires_base_url: false, loopback_only: false },
	"remote-openai": {
		implemented: true,
		offline: false,
		requires_base_url: true,
		loopback_only: false,
		api: "openai-completions",
	},
	"local-openai": {
		implemented: true,
		offline: false,
		requires_base_url: true,
		loopback_only: true,
		api: "openai-completions",
	},
	anthropic: { implemented: false, offline: false, requires_base_url: false, loopback_only: false },
	openai: { implemented: false, offline: false, requires_base_url: false, loopback_only: false },
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** True when a base_url string points at a loopback host over http. */
export function isLoopbackBaseUrl(baseUrl) {
	if (typeof baseUrl !== "string" || baseUrl.length === 0) return false;
	let parsed;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:") return false;
	return LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * Validate a provider selection from the trusted config.
 *
 * @param {any} provider
 * @returns {{ok: boolean, reasons: string[], provider: any|null}}
 */
export function resolveProviderConfig(provider) {
	const reasons = [];
	if (provider === undefined || provider === null) {
		return { ok: false, reasons: ["config.provider is required"], provider: null };
	}
	if (!isPlainObject(provider)) return { ok: false, reasons: ["config.provider must be an object"], provider: null };
	for (const key of Object.keys(provider)) {
		if (!["kind", "model", "base_url", "credential_ref"].includes(key))
			reasons.push(`unknown config.provider key "${key}"`);
	}
	const kind = provider.kind;
	if (typeof kind !== "string" || kind.length === 0) reasons.push("config.provider.kind is required");
	else if (!Object.hasOwn(KNOWN_PROVIDERS, kind))
		reasons.push(`config.provider.kind "${kind}" is not a known provider`);
	if (typeof provider.model !== "string" || provider.model.trim().length === 0)
		reasons.push("config.provider.model is required");
	if (provider.base_url !== undefined && provider.base_url !== null) {
		if (typeof provider.base_url !== "string") reasons.push("config.provider.base_url must be a string");
	}
	if (provider.credential_ref !== undefined && provider.credential_ref !== null) {
		if (typeof provider.credential_ref !== "string" || provider.credential_ref.trim().length === 0)
			reasons.push("config.provider.credential_ref must be a non-empty string when present");
	}
	const spec = Object.hasOwn(KNOWN_PROVIDERS, kind)
		? /** @type {any} */ (KNOWN_PROVIDERS[/** @type {keyof typeof KNOWN_PROVIDERS} */ (kind)])
		: null;
	if (spec?.requires_base_url && !provider.base_url) reasons.push(`config.provider "${kind}" requires base_url`);
	if (spec?.loopback_only && provider.base_url && !isLoopbackBaseUrl(provider.base_url))
		reasons.push(`config.provider "${kind}" base_url must be a loopback http URL`);
	if (kind === "remote-openai") {
		try {
			const url = new URL(provider.base_url);
			if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
				reasons.push("remote-openai requires an https base_url without embedded credentials, query or fragment");
		} catch {
			reasons.push("remote-openai requires a valid https base_url");
		}
		const credential =
			typeof provider.credential_ref === "string"
				? describeCredentialRef(provider.credential_ref)
				: { ok: false, env_name: null };
		if (!credential.ok || !credential.env_name)
			reasons.push("remote-openai requires an explicit env:NAME credential_ref");
	}
	if (reasons.length > 0) return { ok: false, reasons, provider: null };
	if (spec && spec.implemented === false) {
		// Known but not wired in C6: refuse explicitly rather than auto-fallback.
		return {
			ok: false,
			reasons: [`provider "${kind}" is recognized but not implemented in C6 (offline development default is "faux")`],
			provider: null,
		};
	}
	return {
		ok: true,
		reasons: [],
		provider: {
			kind,
			model: provider.model,
			base_url: provider.base_url ?? null,
			credential_ref: provider.credential_ref ?? null,
			api: spec?.api ?? null,
			offline: spec?.offline === true,
		},
	};
}

/**
 * Resolve a `credential_ref` to an ENVIRONMENT VARIABLE NAME only. The value is
 * never read or printed here; the actual secret resolution (if any) happens at
 * the SDK boundary. A reference that is an absolute file path is normalized to
 * the path string but still never opened.
 *
 * @param {string|null} credentialRef
 * @returns {{ok: boolean, reason?: string, env_name?: string|null, file_path?: string|null}}
 */
export function describeCredentialRef(credentialRef) {
	if (credentialRef === null || credentialRef === undefined) return { ok: true, env_name: null, file_path: null };
	const ref = credentialRef.trim();
	if (ref.startsWith("env:")) {
		const name = ref.slice(4);
		if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return { ok: false, reason: `credential env name is invalid: ${name}` };
		return { ok: true, env_name: name, file_path: null };
	}
	if (ref.startsWith("file:")) {
		const path = ref.slice(5);
		if (path.length === 0) return { ok: false, reason: "credential file reference is empty" };
		return { ok: true, env_name: null, file_path: isAbsolute(path) ? resolve(path) : path };
	}
	return { ok: false, reason: 'credential_ref must use the "env:NAME" or "file:PATH" form' };
}
