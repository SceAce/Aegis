// Aegis C3-C — supervised macOS workspace script adapter.
//
// Reuses the EXISTING script-registry (`execution/script-registry.mjs`)
// instead of a new execution framework. It builds one reviewed registration:
//
//   * fixed absolute `executable` (the real `node` binary) + pinned
//     `executable_digest`;
//   * a pinned `script_path` + `script_digest` (an interpreter registration MUST
//     pin the script body, or the body could be swapped silently);
//   * a data-only parameter schema with declared resource `direction` so every
//     path is bounded to `allowed_root` BEFORE any effect;
//   * explicit `cwd` inside `allowed_root`, an environment allowlist, a bounded
//     timeout and `network: false`;
//   * a registered post-condition `verify()` that re-reads the REAL state file.
//
// Honest boundary: the workspace is NOT an OS sandbox. `network:false` is a
// declared policy for a registered script, not kernel isolation.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { digest } from "../../shared/contracts.mjs";
import { executableDigest, isInterpreter } from "../script-registry.mjs";

export const WORKSPACE_ADAPTER_SCRIPT_ID = "aegis.workspace.state";

/**
 * Build a script-registry registration bound to a real, human-provided script
 * file and an authorized workspace root.
 *
 * @param {{
 *   workspaceRoot: string,
 *   scriptPath: string,
 *   executable?: string,
 *   stateFile?: string,
 *   id?: string,
 *   version?: number,
 *   timeoutMs?: number,
 *   env?: Record<string, string>,
 * }} args
 * @returns {object} a validated script registration (pass to createScriptRegistry)
 */
export function createWorkspaceScriptRegistration(
	{
		workspaceRoot,
		scriptPath,
		executable = process.execPath,
		stateFile = "state.json",
		id = WORKSPACE_ADAPTER_SCRIPT_ID,
		version = 1,
		timeoutMs = 10000,
		env = {},
	} = /** @type {any} */ ({}),
) {
	if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot)) {
		throw new Error("createWorkspaceScriptRegistration requires an absolute workspaceRoot");
	}
	if (typeof scriptPath !== "string" || !isAbsolute(scriptPath) || !existsSync(scriptPath)) {
		throw new Error("createWorkspaceScriptRegistration requires an existing absolute scriptPath");
	}
	if (!isInterpreter(executable)) {
		// The registry only pins a script body for known interpreters; for any
		// other executable the reviewed digest is the executable itself.
		if (!existsSync(executable)) throw new Error(`registered executable does not exist: ${executable}`);
	}
	const scriptDigest = `sha256:${executableDigest(scriptPath).replace(/^sha256:/, "")}`;
	const executablePin = executableDigest(executable);

	return {
		schema_version: "1.0",
		id,
		version,
		description:
			"Set one boolean key in a JSON state file inside the authorized workspace via the pinned local script; no shell, no network.",
		executable,
		executable_digest: executablePin,
		script_path: scriptPath,
		script_digest: scriptDigest,
		// Data-only argv. The script path is the pinned script token; the declared
		// parameters bind positions 2..4.
		argv_template: [scriptPath, "{state_file}", "{key}", "{value}"],
		allowed_root: workspaceRoot,
		cwd: workspaceRoot,
		parameters: {
			state_file: { type: "string", required: true, direction: "out" },
			key: { type: "string", required: true, min_length: 1 },
			value: { type: "boolean", required: true },
		},
		env,
		timeout_ms: timeoutMs,
		risk_class: "low",
		network: false,
		target_kinds: ["workspace_file"],
		permissions: ["workspace-script"],
		domain: "script",
		task_types: ["verify", "reproduce", "observe"],
		expect: "state file contains key=true|false after the script runs",
		// The registered post-condition: re-read the REAL file. A missing/malformed
		// file or a mismatched value is NOT a success.
		verify: ({ context }) => {
			const stateFileArg = context?.final_arguments?.state_file ?? context?.arguments?.state_file ?? null;
			const key = context?.final_arguments?.key ?? context?.arguments?.key ?? null;
			const value = context?.final_arguments?.value ?? context?.arguments?.value ?? null;
			const relative = stateFileArg ?? stateFile;
			const absolute = isAbsolute(relative) ? relative : resolve(workspaceRoot, relative);
			if (!existsSync(absolute))
				return { ok: false, reason: `state file does not exist after the script: ${relative}` };
			let state;
			try {
				state = JSON.parse(readFileSync(absolute, "utf8"));
			} catch (error) {
				return { ok: false, reason: `state file is not valid JSON: ${String(error)}` };
			}
			if (!state || typeof state !== "object" || Array.isArray(state)) {
				return { ok: false, reason: "state file is not a JSON object" };
			}
			if (key && state[key] !== value) {
				return {
					ok: false,
					reason: `state[${key}]=${String(state[key])}, expected ${String(value)}`,
					expected: value,
					observed: state[key],
				};
			}
			const content = readFileSync(absolute, "utf8");
			return {
				ok: true,
				reason: "registered post-condition confirmed the real state file",
				expected: value,
				observed: state[key],
				content_digest: digest(content),
				file: relative,
			};
		},
	};
}

/** Convenience: build a registration whose state file lives under the root. */
export function workspaceStateFile(workspaceRoot, name = "state.json") {
	return join(workspaceRoot, name);
}
