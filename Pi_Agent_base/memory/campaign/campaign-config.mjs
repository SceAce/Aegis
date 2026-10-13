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

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { validateManifest } from "./manifest.mjs";

export const CONFIG_SCHEMA_VERSION = "campaign-config-1.0";
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
	if (raw.schema_version !== CONFIG_SCHEMA_VERSION) {
		return {
			ok: false,
			reasons: [`config.schema_version must be "${CONFIG_SCHEMA_VERSION}", got ${String(raw.schema_version)}`],
			config: null,
			manifest: null,
		};
	}
	for (const key of Object.keys(raw)) {
		if (!KNOWN_CONFIG_KEYS.includes(key)) reasons.push(`unknown config key "${key}"`);
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

	// Session budget/rotation config.
	const session = isPlainObject(raw.session) ? raw.session : {};
	const sessionConfig = {
		session_count: Number.isInteger(session.session_count) && session.session_count >= 0 ? session.session_count : 0,
		max_requests_per_session:
			Number.isInteger(session.max_requests_per_session) && session.max_requests_per_session > 0
				? session.max_requests_per_session
				: 10,
		budget_ledger: isPlainObject(session.budget_ledger) ? session.budget_ledger : null,
	};
	if (session && !isPlainObject(session)) reasons.push("config.session must be an object");

	const observation = isPlainObject(raw.observation) ? raw.observation : {};
	const observationConfig = {
		enabled: observation.enabled === true,
		host: typeof observation.host === "string" ? observation.host : "127.0.0.1",
		port: Number.isInteger(observation.port) && observation.port >= 0 ? observation.port : 0,
	};
	if (
		observationConfig.host !== "127.0.0.1" &&
		observationConfig.host !== "localhost" &&
		observationConfig.host !== "::1"
	) {
		reasons.push("config.observation.host must be a loopback address (single-host observation only)");
	}

	const oracle = isPlainObject(raw.oracle) ? raw.oracle : { kind: "fixture" };
	const oracleConfig = { kind: typeof oracle.kind === "string" ? oracle.kind : "fixture" };
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
	if (manifest.authorization?.workspace_root !== workspaceRoot) {
		reasons.push(
			`config.workspace_root (${workspaceRoot}) must equal the Manifest authorization.workspace_root (${manifest.authorization?.workspace_root})`,
		);
	}
	if (manifest.authorization?.workspace_is_sandbox !== false) {
		reasons.push("manifest authorization.workspace_is_sandbox must be false");
	}
	if (reasons.length > 0) return { ok: false, reasons, config: null, manifest: null };

	const config = {
		schema_version: CONFIG_SCHEMA_VERSION,
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
