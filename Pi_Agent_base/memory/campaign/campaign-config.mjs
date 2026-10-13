// Aegis C5 — trusted Campaign run configuration.
//
// A single, human-authored JSON file describes a whole Campaign run so a user
// does not hand-assemble factories. It is a TRUSTED Host input: it is read from
// an explicit `--config` path and NEVER from model text or a tool parameter.
//
// The loader VALIDATES strictly (fail closed):
//   * schema_version must be known;
//   * unknown top-level keys are refused (no silent feature flags);
//   * every required path must exist and be absolute-or-resolved;
//   * `workspace_root` must equal the (validated) Manifest authorization, so the
//     config can never widen the grant;
//   * a `normal` mode without approval is refused at run time by authorization,
//     not silently promoted here.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { validateManifest } from "./manifest.mjs";

export const CONFIG_SCHEMA_VERSION = "campaign-config-1.0";
// C6 adds `campaign-config-1.1`. A 1.0 document keeps its exact previous
// behaviour (no provider/context/learning/task_family keys). A 1.1 document may
// carry the additive C6 keys below; any other top-level key is still refused.
export const CONFIG_SCHEMA_VERSION_V11 = "campaign-config-1.1";
export const KNOWN_CONFIG_V11_KEYS = Object.freeze([
	"schema_version",
	"manifest_path",
	"workspace_root",
	"work_dir",
	"mode",
	"script_config_path",
	"session",
	"observation",
	"oracle",
	"label",
	"provider",
	"context",
	"learning",
	"task_family",
	"measure",
]);
export const KNOWN_CONFIG_KEYS = Object.freeze([
	"schema_version",
	"manifest_path",
	"workspace_root",
	"work_dir",
	"mode",
	"script_config_path",
	"session",
	"observation",
	"oracle",
	"label",
]);

const MODES = ["auto", "normal"];
const ORACLE_KINDS = ["fixture"];
const TASK_FAMILIES = ["fixture-state", "structured-data-repair", "code-repair"];
const CONTEXT_STRATEGIES = ["bounded_ram", "full_history"];
const LEARNING_POLICIES = ["off", "shadow", "explicit"];

/** Validate the C6 `provider` object. Unknown keys/types are refused. */
function validateProviderKey(provider, reasons) {
	if (!isPlainObject(provider)) {
		reasons.push("config.provider must be an object");
		return null;
	}
	for (const key of Object.keys(provider)) {
		if (!["kind", "model", "base_url", "credential_ref"].includes(key))
			reasons.push(`unknown config.provider key ${key}`);
	}
	if (typeof provider.kind !== "string" || provider.kind.length === 0) reasons.push("config.provider.kind is required");
	if (typeof provider.model !== "string" || provider.model.trim().length === 0)
		reasons.push("config.provider.model is required");
	if (provider.base_url !== undefined && provider.base_url !== null && typeof provider.base_url !== "string")
		reasons.push("config.provider.base_url must be a string");
	if (
		provider.credential_ref !== undefined &&
		provider.credential_ref !== null &&
		typeof provider.credential_ref !== "string"
	)
		reasons.push("config.provider.credential_ref must be a string");
	return provider;
}

/** Validate the C6 `context` object. */
function validateContextKey(context, reasons) {
	if (context === undefined)
		return { strategy: "bounded_ram", max_total_input_chars: 24000, output_reserve_chars: 2000 };
	if (!isPlainObject(context)) {
		reasons.push("config.context must be an object");
		return null;
	}
	for (const key of Object.keys(context)) {
		if (!["strategy", "max_total_input_chars", "output_reserve_chars"].includes(key))
			reasons.push(`unknown config.context key ${key}`);
	}
	const strategy = context.strategy ?? "bounded_ram";
	if (!CONTEXT_STRATEGIES.includes(strategy))
		reasons.push(`config.context.strategy must be one of ${CONTEXT_STRATEGIES.join(", ")}`);
	for (const field of ["max_total_input_chars", "output_reserve_chars"]) {
		if (context[field] !== undefined && (!Number.isSafeInteger(context[field]) || context[field] < 0))
			reasons.push(`config.context.${field} must be a non-negative safe integer`);
	}
	return {
		strategy,
		max_total_input_chars:
			Number.isSafeInteger(context.max_total_input_chars) && context.max_total_input_chars > 0
				? context.max_total_input_chars
				: 24000,
		output_reserve_chars:
			Number.isSafeInteger(context.output_reserve_chars) && context.output_reserve_chars >= 0
				? context.output_reserve_chars
				: 2000,
	};
}

/** Validate the C6 `learning` object. `promote_experience` must stay false. */
function validateLearningKey(learning, reasons) {
	if (learning === undefined) return { policy: "off", promote_experience: false, environment: null, proof_ids: [] };
	if (!isPlainObject(learning)) {
		reasons.push("config.learning must be an object");
		return null;
	}
	for (const key of Object.keys(learning)) {
		if (!["policy", "promote_experience", "environment", "proof_ids"].includes(key))
			reasons.push(`unknown config.learning key ${key}`);
	}
	const policy = learning.policy ?? "off";
	if (!LEARNING_POLICIES.includes(policy))
		reasons.push(`config.learning.policy must be one of ${LEARNING_POLICIES.join(", ")}`);
	if (learning.promote_experience !== undefined && learning.promote_experience !== false)
		reasons.push("config.learning.promote_experience must be false (C6 never auto-promotes)");
	if (learning.proof_ids !== undefined && !Array.isArray(learning.proof_ids))
		reasons.push("config.learning.proof_ids must be an array");
	return {
		policy,
		promote_experience: false,
		environment: isPlainObject(learning.environment) ? learning.environment : null,
		proof_ids: Array.isArray(learning.proof_ids) ? learning.proof_ids.filter((id) => typeof id === "string") : [],
	};
}

/** Validate the C6 `measure` object. */
function validateMeasureKey(measure, reasons) {
	if (measure === undefined) return null;
	if (!isPlainObject(measure)) {
		reasons.push("config.measure must be an object");
		return null;
	}
	for (const key of Object.keys(measure)) {
		if (!["out_dir", "attempts"].includes(key)) reasons.push(`unknown config.measure key ${key}`);
	}
	if (measure.attempts !== undefined && !Array.isArray(measure.attempts))
		reasons.push("config.measure.attempts must be an array when present");
	return {
		out_dir: typeof measure.out_dir === "string" ? measure.out_dir : null,
		attempts: Array.isArray(measure.attempts) ? measure.attempts.filter((a) => isPlainObject(a)) : [],
	};
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveConfigPath(value, baseDir) {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
}

/**
 * Load and validate a Campaign run config, and its referenced Manifest.
 *
 * @param {{configPath: string}} args
 * @returns {{ok: boolean, reasons: string[], config: any, manifest: any}}
 */
export function loadCampaignConfig({ configPath } = /** @type {any} */ ({})) {
	const reasons = [];
	if (typeof configPath !== "string" || !configPath) {
		return { ok: false, reasons: ["configPath is required"], config: null, manifest: null };
	}
	const absoluteConfig = resolve(configPath);
	if (!existsSync(absoluteConfig)) {
		return { ok: false, reasons: [`config not found: ${absoluteConfig}`], config: null, manifest: null };
	}
	// A config that is a symlink is refused: the trusted path must be a real file.
	try {
		if (lstatSync(absoluteConfig).isSymbolicLink()) {
			return { ok: false, reasons: [`config must not be a symlink: ${absoluteConfig}`], config: null, manifest: null };
		}
	} catch (error) {
		return { ok: false, reasons: [`config is not readable: ${String(error)}`], config: null, manifest: null };
	}
	let raw;
	try {
		raw = JSON.parse(readFileSync(absoluteConfig, "utf8"));
	} catch (error) {
		return { ok: false, reasons: [`config is not valid JSON: ${String(error)}`], config: null, manifest: null };
	}
	if (!isPlainObject(raw))
		return { ok: false, reasons: ["config must be a JSON object"], config: null, manifest: null };
	const isV11 = raw.schema_version === CONFIG_SCHEMA_VERSION_V11;
	if (raw.schema_version !== CONFIG_SCHEMA_VERSION && !isV11) {
		return {
			ok: false,
			reasons: [
				`config.schema_version must be "${CONFIG_SCHEMA_VERSION}" or "${CONFIG_SCHEMA_VERSION_V11}", got ${String(raw.schema_version)}`,
			],
			config: null,
			manifest: null,
		};
	}
	const knownKeys = isV11 ? KNOWN_CONFIG_V11_KEYS : KNOWN_CONFIG_KEYS;
	for (const key of Object.keys(raw)) {
		if (!knownKeys.includes(key)) reasons.push(`unknown config key "${key}"`);
	}

	const baseDir = dirname(absoluteConfig);
	const manifestPath = resolveConfigPath(raw.manifest_path, baseDir);
	if (!manifestPath) reasons.push("config.manifest_path is required");
	else if (!existsSync(manifestPath)) reasons.push(`manifest not found: ${manifestPath}`);

	const workspaceRoot = resolveConfigPath(raw.workspace_root, baseDir);
	if (!workspaceRoot) reasons.push("config.workspace_root is required");
	else if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
		reasons.push(`workspace_root is not an existing directory: ${workspaceRoot}`);
	}

	const workDir = resolveConfigPath(raw.work_dir, baseDir) ?? resolve(dirname(absoluteConfig), "run");
	const mode = raw.mode ?? "auto";
	if (!MODES.includes(mode)) reasons.push(`config.mode must be one of ${MODES.join(", ")}`);

	let scriptConfigPath = null;
	if (raw.script_config_path !== undefined && raw.script_config_path !== null) {
		scriptConfigPath = resolveConfigPath(raw.script_config_path, baseDir);
		if (!scriptConfigPath || !existsSync(scriptConfigPath))
			reasons.push(`script_config_path not found: ${scriptConfigPath}`);
	}

	// Nested objects are configuration, not implicit permissions or defaults.
	for (const [name, keys] of Object.entries({
		session: ["session_count", "max_requests_per_session", "budget_ledger"],
		observation: ["enabled", "host", "port"],
		oracle: ["kind"],
	})) {
		if (raw[name] !== undefined && !isPlainObject(raw[name])) reasons.push(`config.${name} must be an object`);
		else
			for (const key of Object.keys(raw[name] ?? {}))
				if (!keys.includes(key)) reasons.push(`unknown config.${name} key ${key}`);
	}
	const session = isPlainObject(raw.session) ? raw.session : {};
	for (const field of ["session_count", "max_requests_per_session"]) {
		if (
			session[field] !== undefined &&
			(!Number.isSafeInteger(session[field]) || session[field] < (field === "session_count" ? 0 : 1))
		)
			reasons.push(`config.session.${field} is invalid`);
	}
	if (session.budget_ledger !== undefined && !isPlainObject(session.budget_ledger))
		reasons.push("session.budget_ledger must be an object");
	const sessionConfig = {
		session_count: Number.isInteger(session.session_count) && session.session_count >= 0 ? session.session_count : 0,
		max_requests_per_session:
			Number.isInteger(session.max_requests_per_session) && session.max_requests_per_session > 0
				? session.max_requests_per_session
				: 10,
		budget_ledger: isPlainObject(session.budget_ledger) ? session.budget_ledger : null,
	};

	const observation = isPlainObject(raw.observation) ? raw.observation : {};
	const observationConfig = {
		enabled: observation.enabled === true,
		host: typeof observation.host === "string" ? observation.host : "127.0.0.1",
		port: Number.isInteger(observation.port) && observation.port >= 0 ? observation.port : 0,
	};
	if (
		observation.port !== undefined &&
		(!Number.isInteger(observation.port) || observation.port < 0 || observation.port > 65535)
	)
		reasons.push("observation.port is invalid");
	if (observation.enabled !== undefined && typeof observation.enabled !== "boolean")
		reasons.push("observation.enabled must be boolean");
	if (observation.host !== undefined && typeof observation.host !== "string")
		reasons.push("observation.host must be a string");
	if (
		observationConfig.host !== "127.0.0.1" &&
		observationConfig.host !== "localhost" &&
		observationConfig.host !== "::1"
	) {
		reasons.push("config.observation.host must be a loopback address (single-host observation only)");
	}

	const oracle = isPlainObject(raw.oracle) ? raw.oracle : { kind: "fixture" };
	const oracleConfig = { kind: typeof oracle.kind === "string" ? oracle.kind : "fixture" };
	if (oracle.kind !== undefined && typeof oracle.kind !== "string") reasons.push("oracle.kind must be a string");
	if (!ORACLE_KINDS.includes(oracleConfig.kind)) {
		reasons.push(
			`config.oracle.kind must be one of ${ORACLE_KINDS.join(", ")} (registered oracles are out of C5 scope)`,
		);
	}

	if (reasons.length > 0) return { ok: false, reasons, config: null, manifest: null };

	// Load and validate the Manifest against its authorization, then enforce that
	// the config cannot widen the grant: the workspace_root must equal the
	// Manifest's authorized root (real path compared).
	const loaded = loadManifestSync(manifestPath);
	if (!loaded.ok)
		return { ok: false, reasons: [`manifest invalid: ${loaded.reasons.join("; ")}`], config: null, manifest: null };
	const manifest = loaded.manifest;
	// Compare REAL paths so a symlinked prefix (e.g. macOS /tmp -> /private/tmp)
	// does not cause a false mismatch, while a genuinely different (widened) root
	// is still refused.
	const authorizedRoot = manifest.authorization?.workspace_root;
	const sameRoot =
		typeof authorizedRoot === "string" &&
		realPathOf(authorizedRoot) !== null &&
		realPathOf(authorizedRoot) === realPathOf(workspaceRoot);
	if (!sameRoot) {
		reasons.push(
			`config.workspace_root (${workspaceRoot}) must equal the Manifest authorization.workspace_root (${String(authorizedRoot)})`,
		);
	}
	if (manifest.authorization?.workspace_is_sandbox !== false) {
		reasons.push("manifest authorization.workspace_is_sandbox must be false");
	}
	if (reasons.length > 0) return { ok: false, reasons, config: null, manifest: null };

	const sessionLimit = session.session_count ?? manifest.budget.session_count;
	if (sessionLimit > manifest.budget.session_count) reasons.push("session_count exceeds Manifest budget");
	const ledger = sessionConfig.budget_ledger ?? {
		limit: { session_count: sessionLimit },
		consumed: { session_count: 0 },
		reserved: { session_count: 0 },
	};
	for (const key of Object.keys(ledger)) {
		if (!["limit", "consumed", "reserved"].includes(key)) reasons.push(`unknown budget_ledger key ${key}`);
	}
	for (const section of ["limit", "consumed", "reserved"]) {
		if (!isPlainObject(ledger[section] ?? {})) {
			reasons.push(`budget_ledger.${section} must be an object`);
			continue;
		}
		for (const [key, value] of Object.entries(ledger[section] ?? {})) {
			if (
				!["wall_time_ms", "model_requests", "tool_calls", "session_count"].includes(key) ||
				!Number.isSafeInteger(value) ||
				value < 0
			)
				reasons.push(`invalid budget_ledger.${section}.${key}`);
			if (section === "limit" && value > (manifest.budget[key] ?? 0))
				reasons.push(`budget_ledger limit ${key} exceeds Manifest`);
		}
	}
	if (!Number.isSafeInteger(ledger.limit?.session_count) || ledger.limit.session_count > sessionLimit)
		reasons.push("Session ledger limit exceeds configured grant or is missing");

	// --- C6 additive keys (schema_version campaign-config-1.1 only) ---------
	let providerConfig = null;
	let contextConfig = null;
	let learningConfig = null;
	let taskFamily = null;
	let measureConfig = null;
	if (isV11) {
		providerConfig = validateProviderKey(raw.provider, reasons);
		contextConfig = validateContextKey(raw.context, reasons);
		learningConfig = validateLearningKey(raw.learning, reasons);
		measureConfig = validateMeasureKey(raw.measure, reasons);
		if (raw.task_family !== undefined) {
			if (!TASK_FAMILIES.includes(raw.task_family))
				reasons.push(`config.task_family must be one of ${TASK_FAMILIES.join(", ")}`);
			else taskFamily = raw.task_family;
		} else {
			taskFamily = "fixture-state";
		}
	}

	if (reasons.length) return { ok: false, reasons, config: null, manifest: null };
	sessionConfig.session_count = sessionLimit;
	sessionConfig.budget_ledger = ledger;
	const config = {
		schema_version: isV11 ? CONFIG_SCHEMA_VERSION_V11 : CONFIG_SCHEMA_VERSION,
		config_path: absoluteConfig,
		label: typeof raw.label === "string" ? raw.label : null,
		manifest_path: manifestPath,
		workspace_root: workspaceRoot,
		work_dir: workDir,
		mode,
		script_config_path: scriptConfigPath,
		session: sessionConfig,
		observation: observationConfig,
		oracle: oracleConfig,
		provider: providerConfig,
		context: contextConfig,
		learning: learningConfig,
		task_family: taskFamily,
		measure: measureConfig,
	};
	return { ok: true, reasons: [], config, manifest };
}

// `loadManifest` is async; this config loader stays synchronous and
// deterministic by reading + validating the Manifest directly with the SAME
// pure validator used everywhere else.
function loadManifestSync(path) {
	try {
		const text = readFileSync(path, "utf8");
		const parsed = JSON.parse(text);
		return validateManifest(parsed);
	} catch (error) {
		return { ok: false, reasons: [`manifest is not readable/valid JSON: ${String(error)}`] };
	}
}

/** Resolve a real path for comparison; null when it does not exist. */
function realPathOf(path) {
	if (typeof path !== "string" || path.length === 0) return null;
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}
