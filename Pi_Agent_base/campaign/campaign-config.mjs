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
	"registered_test",
	"seed",
	"planning",
	"work_cycle",
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
		const allowed =
			provider.kind === "pi-config"
				? ["kind", "model", "provider_id", "agent_dir", "max_output_tokens"]
				: ["kind", "model", "base_url", "credential_ref"];
		if (!allowed.includes(key)) reasons.push(`unknown config.provider key ${key}`);
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

/**
 * Validate the additive C6 `work_cycle` object. The section is DISABLED unless
 * the trusted config explicitly enables it; thresholds are Host policy, never
 * model input. Candidate defaults (3/8/4/85) are NOT calibrated production
 * values and only apply when this section is enabled (or to the manual gate).
 */
function validateWorkCycleKey(input, reasons) {
	const defaults = {
		enabled: false,
		repeat_limit: 3,
		action_window: 8,
		min_distinct_routes: 4,
		context_pressure_percent: 85,
		max_auto_rotations: 6,
		max_continuations: 8,
	};
	if (input === undefined) return { ...defaults };
	if (!isPlainObject(input)) {
		reasons.push("config.work_cycle must be an object");
		return { ...defaults };
	}
	const allowed = [
		"enabled",
		"repeat_limit",
		"action_window",
		"min_distinct_routes",
		"context_pressure_percent",
		"max_auto_rotations",
		"max_continuations",
	];
	for (const key of Object.keys(input))
		if (!allowed.includes(key)) reasons.push(`unknown config.work_cycle key ${key}`);
	if (input.enabled !== undefined && typeof input.enabled !== "boolean")
		reasons.push("config.work_cycle.enabled must be boolean");
	const bounds = {
		repeat_limit: [2, 10],
		action_window: [3, 50],
		min_distinct_routes: [2, 50],
		context_pressure_percent: [50, 95],
		max_auto_rotations: [0, 50],
		max_continuations: [0, 50],
	};
	const out = { ...defaults, enabled: input.enabled === true };
	for (const [key, [min, max]] of Object.entries(bounds)) {
		if (input[key] === undefined) continue;
		if (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max)
			reasons.push(`config.work_cycle.${key} must be an integer in [${min}, ${max}]`);
		else out[key] = input[key];
	}
	if (out.min_distinct_routes > out.action_window)
		reasons.push("config.work_cycle.min_distinct_routes cannot exceed action_window");
	return out;
}

/** Validate the C6 `learning` object. `promote_experience` must stay false. */
function validateLearningKey(learning, reasons) {
	if (learning === undefined) return { policy: "off", promote_experience: false, environment: null, proof_ids: [] };
	if (!isPlainObject(learning)) {
		reasons.push("config.learning must be an object");
		return null;
	}
	for (const key of Object.keys(learning)) {
		if (!["policy", "promote_experience", "environment", "proof_ids", "replay_adapter"].includes(key))
			reasons.push(`unknown config.learning key ${key}`);
	}
	const policy = learning.policy ?? "off";
	if (!LEARNING_POLICIES.includes(policy))
		reasons.push(`config.learning.policy must be one of ${LEARNING_POLICIES.join(", ")}`);
	if (learning.promote_experience !== undefined && learning.promote_experience !== false)
		reasons.push("config.learning.promote_experience must be false (C6 never auto-promotes)");
	if (learning.proof_ids !== undefined && !Array.isArray(learning.proof_ids))
		reasons.push("config.learning.proof_ids must be an array");
	if (
		learning.replay_adapter !== undefined &&
		learning.replay_adapter !== null &&
		typeof learning.replay_adapter !== "string"
	)
		reasons.push("config.learning.replay_adapter must be a path string when present");
	return {
		policy,
		promote_experience: false,
		environment: isPlainObject(learning.environment) ? learning.environment : null,
		proof_ids: Array.isArray(learning.proof_ids) ? learning.proof_ids.filter((id) => typeof id === "string") : [],
		replay_adapter: typeof learning.replay_adapter === "string" ? learning.replay_adapter : null,
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

/**
 * Validate the E1 `planning` object. When enabled, the entry prepends a Host
 * planning Task whose model may submit ONE complete candidate plan; business
 * tasks come only from admitted plan nodes. `templates` binds each allowed task
 * type to its trusted oracle/criteria/capabilities.
 */
function validatePlanningKey(planning, reasons) {
	if (planning === undefined) return { enabled: false, templates: [] };
	if (!isPlainObject(planning)) {
		reasons.push("config.planning must be an object");
		return null;
	}
	for (const key of Object.keys(planning)) {
		if (!["enabled", "templates"].includes(key)) reasons.push(`unknown config.planning key ${key}`);
	}
	const enabled = planning.enabled === true;
	const templates = [];
	if (planning.templates !== undefined) {
		if (!Array.isArray(planning.templates)) {
			reasons.push("config.planning.templates must be an array when present");
		} else {
			for (const [index, template] of planning.templates.entries()) {
				if (!isPlainObject(template)) {
					reasons.push(`config.planning.templates[${index}] must be an object`);
					continue;
				}
				if (typeof template.template_ref !== "string" || !template.template_ref)
					reasons.push(`config.planning.templates[${index}].template_ref is required`);
				if (typeof template.oracle_ref !== "string" || !template.oracle_ref)
					reasons.push(`config.planning.templates[${index}].oracle_ref is required`);
				templates.push({
					template_ref: template.template_ref ?? null,
					task_type: typeof template.task_type === "string" ? template.task_type : template.template_ref,
					oracle_ref: template.oracle_ref ?? null,
					required_capabilities: Array.isArray(template.required_capabilities)
						? template.required_capabilities.filter((c) => typeof c === "string")
						: [],
					success_criteria: Array.isArray(template.success_criteria)
						? template.success_criteria.filter((c) => typeof c === "string")
						: [],
					scope: template.scope && typeof template.scope === "object" ? template.scope : null,
				});
			}
		}
	}
	// A trusted business template must offer a NON-EMPTY criteria set. Missing or
	// empty criteria are an explicit config error, never treated as a wildcard.
	if (enabled) {
		if (templates.length === 0)
			reasons.push("config.planning.templates must define at least one trusted template when planning is enabled");
		for (const [index, template] of templates.entries()) {
			if (template.success_criteria.length === 0)
				reasons.push(
					`config.planning.templates[${index}].success_criteria must be a non-empty string array when planning is enabled`,
				);
		}
	}
	return { enabled, templates };
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
	let planningConfig = null;
	let workCycleConfig = null;
	if (isV11) {
		providerConfig = validateProviderKey(raw.provider, reasons);
		contextConfig = validateContextKey(raw.context, reasons);
		learningConfig = validateLearningKey(raw.learning, reasons);
		measureConfig = validateMeasureKey(raw.measure, reasons);
		planningConfig = validatePlanningKey(raw.planning, reasons);
		workCycleConfig = validateWorkCycleKey(raw.work_cycle, reasons);
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
		planning: planningConfig,
		work_cycle: workCycleConfig,
		registered_test: typeof raw.registered_test === "string" ? raw.registered_test : null,
		seed: raw.seed ?? null,
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
