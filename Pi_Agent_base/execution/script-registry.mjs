// Human-configured script actions (batch B).
//
// A script action is only ever constructed from an explicit, human-registered
// configuration entry: a fixed executable, a fixed argv template, a pinned
// executable digest, a bounded cwd/workspace, a data-only parameter schema, a
// timeout and a registered post-condition Oracle. The Experience/LLM may only
// supply DATA arguments; it can never supply the executable, the argv shape or
// any executable text.
//
// Registrations may arrive as a JavaScript module (a `verify` FUNCTION) or as a
// JSON roster (a declarative `verify_spec`). A roster is a lookup table a human
// can scan; `compileVerifySpec` turns its data into the same Oracle contract, and
// the check still re-reads the real post-state instead of trusting stdout/exit.
//
// Rejections that matter:
//   * no configuration -> `unconfigured`; the runtime never self-registers a
//     contest/remote script;
//   * a changed executable (digest mismatch) -> refused and requires a NEW
//     version + re-verification;
//   * shell interpreters and `-e`/`-c`/`--eval` tokens -> refused (no eval);
//   * a timeout is NOT retried (attempts: 1, retry_allowed: false); an Oracle
//     must inspect the real post-state before anything runs again.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { digest, evaluatePredicates, getPath, sha256Hex } from "../shared/contracts.mjs";
import { defineContract, newOutcomeId, validateParameters, validatePredicateShape } from "./action-contract.mjs";

export const SCRIPT_SCHEMA_VERSION = "1.0";
export const FORBIDDEN_EXECUTABLES = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"csh",
	"tcsh",
	"cmd",
	"cmd.exe",
	"powershell",
	"powershell.exe",
	"pwsh",
	"pwsh.exe",
]);
export const FORBIDDEN_ARGV_TOKENS = new Set(["-e", "--eval", "-c", "-Command", "-EncodedCommand", "--command"]);
// Interpreters that must have their SCRIPT ARGUMENT pinned separately (the
// interpreter binary alone is not enough if the script can be swapped out).
export const INTERPRETER_BASENAMES = new Set([
	"node",
	"node.exe",
	"python",
	"python3",
	"python3.11",
	"python3.12",
	"ruby",
	"perl",
	"deno",
	"bun",
]);
const MAX_CAPTURE_BYTES = 256 * 1024;

/** True when this executable is a known interpreter needing a pinned script arg. */
export function isInterpreter(executable) {
	return INTERPRETER_BASENAMES.has(basename(executable).toLowerCase());
}

export function fileDigestHex(path) {
	return sha256Hex(readFileSync(path));
}

export function executableDigest(path) {
	return `sha256:${fileDigestHex(path)}`;
}

/** Static review of one script registration. Returns `{ok, reasons}`. */
/** Oracle kinds a JSON roster may request. Each re-reads real state. */
export const VERIFY_SPEC_KINDS = Object.freeze(["json_post_state"]);

/**
 * @typedef {object} VerifySpecCheck
 * @property {string} path  Dotted or JSON-pointer path in the post-state.
 * @property {"eq"|"neq"|"exists"} op
 * @property {unknown} [value]
 */

/**
 * @typedef {object} VerifySpec
 * @property {"json_post_state"} kind
 * @property {string} resource  Bound output parameter whose file is re-read.
 * @property {VerifySpecCheck[]} checks
 */

/**
 * @typedef {{ok: boolean, reason: string, expected?: unknown, observed?: unknown}} VerifyResult
 */

/**
 * Validate a declarative Oracle spec (the JSON-roster form of `verify`).
 * @param {unknown} spec
 * @returns {{ok: boolean, reasons: string[]}}  `reasons` is empty when ok.
 */
export function validateVerifySpec(spec) {
	if (!spec || typeof spec !== "object" || Array.isArray(spec))
		return { ok: false, reasons: ["verify_spec must be an object"] };
	const value = /** @type {VerifySpec} */ (spec);
	const reasons = [];
	if (!VERIFY_SPEC_KINDS.includes(value.kind)) {
		reasons.push(`verify_spec.kind must be one of ${VERIFY_SPEC_KINDS.join(", ")}`);
	}
	if (typeof value.resource !== "string" || !value.resource) {
		reasons.push("verify_spec.resource is required (a bound output parameter name)");
	}
	if (!Array.isArray(value.checks) || value.checks.length === 0) {
		reasons.push("verify_spec.checks must be a non-empty array");
	} else {
		for (const [index, check] of value.checks.entries()) {
			reasons.push(...validatePredicateShape(check, `verify_spec.checks[${index}]`));
		}
	}
	return { ok: reasons.length === 0, reasons };
}

/**
 * Compile a declarative Oracle spec into the `verify({observed})` contract.
 *
 * The compiled Oracle resolves the bound output path from the run's
 * `resource_bindings`, reads it from disk and re-parses it. It never looks at the
 * script's stdout, exit code or the caller's claims.
 *
 * @param {unknown} spec
 * @returns {(input?: {observed?: {resource_bindings?: Record<string, string>}}) => VerifyResult}
 */
export function compileVerifySpec(spec) {
	const review = validateVerifySpec(spec);
	if (!review.ok) throw new Error(`invalid verify_spec: ${review.reasons.join("; ")}`);
	const value = /** @type {VerifySpec} */ (spec);
	return (/** @type {{observed?: {resource_bindings?: Record<string, string>}}} */ input = {}) => {
		const bindings = input.observed?.resource_bindings;
		const target = bindings ? bindings[value.resource] : undefined;
		if (typeof target !== "string" || !target) {
			return { ok: false, reason: `no bound "${value.resource}" output to re-read` };
		}
		/** @type {any} */
		let state;
		try {
			state = JSON.parse(readFileSync(target, "utf8"));
		} catch (error) {
			return {
				ok: false,
				reason: `could not re-read ${value.kind} at ${target}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const satisfied = state !== null && typeof state === "object" && evaluatePredicates(state, value.checks);
		const actual = Object.fromEntries(value.checks.map((check) => [check.path, getPath(state, check.path)]));
		return satisfied
			? { ok: true, reason: `independent ${value.kind} re-read agrees`, expected: value.checks, observed: actual }
			: {
					ok: false,
					reason: `independent ${value.kind} re-read does not satisfy the checks`,
					expected: value.checks,
					observed: actual,
				};
	};
}

export function validateScriptRegistration(registration) {
	const reasons = [];
	if (!registration || typeof registration !== "object")
		return { ok: false, reasons: ["registration must be an object"] };
	if (registration.schema_version !== SCRIPT_SCHEMA_VERSION)
		reasons.push(`schema_version must be ${SCRIPT_SCHEMA_VERSION}`);
	if (typeof registration.id !== "string" || !registration.id) reasons.push("id is required");
	if (!Number.isInteger(registration.version) || registration.version < 1)
		reasons.push("version must be a positive integer");
	if (typeof registration.executable !== "string" || !registration.executable) reasons.push("executable is required");
	else if (!isAbsolute(registration.executable)) reasons.push("executable must be an absolute path");
	else if (FORBIDDEN_EXECUTABLES.has(basename(registration.executable).toLowerCase()))
		reasons.push(`shell interpreter is not an allowed executable: ${basename(registration.executable)}`);
	if (
		typeof registration.executable_digest !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(registration.executable_digest)
	)
		reasons.push("executable_digest (sha256) is required for version pinning");
	if (
		!Array.isArray(registration.argv_template) ||
		!registration.argv_template.every((token) => typeof token === "string")
	)
		reasons.push("argv_template must be an array of strings");
	else
		for (const token of registration.argv_template)
			if (FORBIDDEN_ARGV_TOKENS.has(token))
				reasons.push(`argv_template contains a forbidden eval/shell token: ${token}`);

	// Interpreter + script pinning: when the executable is a general interpreter,
	// the SCRIPT FILE it runs must be pinned by digest too. Otherwise a human could
	// swap the script body without changing any reviewed digest.
	if (typeof registration.executable === "string" && isInterpreter(registration.executable)) {
		if (
			typeof registration.script_path !== "string" ||
			!registration.script_path ||
			!isAbsolute(registration.script_path)
		) {
			reasons.push("an interpreter registration requires an absolute script_path (the script to run)");
		}
		if (registration.script_path) {
			if (!existsSync(registration.script_path)) reasons.push("script_path does not exist");
			else if (
				typeof registration.script_digest !== "string" ||
				!/^sha256:[0-9a-f]{64}$/.test(registration.script_digest)
			)
				reasons.push("script_digest (sha256) is required to pin the script body for an interpreter registration");
			else if (registration.script_digest !== executableDigest(registration.script_path))
				reasons.push("script_digest does not match the registered script file");
		}
		const templateHasScript =
			Array.isArray(registration.argv_template) && registration.argv_template.includes(registration.script_path);
		if (registration.script_path && !templateHasScript)
			reasons.push("the argv_template must reference script_path as an executable token");
	}

	// A one-line purpose is optional but bounded: the roster exists so a human can
	// choose a technique at a glance, which a long blurb defeats.
	if (registration.description !== undefined) {
		if (typeof registration.description !== "string" || !registration.description.trim()) {
			reasons.push("description must be a non-empty string when provided");
		} else if (registration.description.length > 200) {
			reasons.push("description must be <= 200 characters");
		}
	}

	if (
		typeof registration.allowed_root !== "string" ||
		!registration.allowed_root ||
		!isAbsolute(registration.allowed_root)
	)
		reasons.push("allowed_root (absolute workspace path) is required");
	if (typeof registration.cwd !== "string" || !registration.cwd || !isAbsolute(registration.cwd))
		reasons.push("cwd (absolute path) is required");
	// cwd must be inside the allowed root (real, symlink-resolved). A lexical
	// check alone would let a symlinked cwd escape.
	if (
		typeof registration.allowed_root === "string" &&
		isAbsolute(registration.allowed_root) &&
		typeof registration.cwd === "string" &&
		isAbsolute(registration.cwd)
	) {
		const cwdCheck = insideRoot(registration.allowed_root, registration.cwd);
		if (!cwdCheck.ok) reasons.push(`cwd must be inside allowed_root: ${cwdCheck.reason}`);
	}
	if (!registration.parameters || typeof registration.parameters !== "object" || Array.isArray(registration.parameters))
		reasons.push("parameters must be an object schema");
	else {
		for (const [name, spec] of Object.entries(registration.parameters)) {
			if (!spec || typeof spec !== "object" || typeof spec.type !== "string")
				reasons.push(`parameter ${name} needs a type`);
			// A resource parameter (filesystem path) MUST declare its direction so the
			// runtime can bound it to allowed_root BEFORE any effect. `in` must exist
			// inside the root; `out` must resolve inside the root too.
			if (spec && spec.direction !== undefined) {
				if (spec.direction !== "in" && spec.direction !== "out")
					reasons.push(`parameter ${name} direction must be "in" or "out"`);
				else if (spec.type !== "string")
					reasons.push(`parameter ${name} declares a resource direction and must be a string`);
			}
		}
	}
	if (typeof registration.verify === "function") {
		if (registration.verify_spec !== undefined) reasons.push("declare either verify() or verify_spec, not both");
	} else if (registration.verify_spec !== undefined) {
		reasons.push(...validateVerifySpec(registration.verify_spec).reasons);
	} else {
		reasons.push("a registered post-condition Oracle is required: verify() or verify_spec (JSON roster)");
	}
	if (registration.network === true && registration.risk_class === "observe")
		reasons.push("network=true cannot be risk_class=observe");
	return { ok: reasons.length === 0, reasons };
}

/** Build a Map keyed by `id@version`. Empty config is a valid (unconfigured) registry. */
export function createScriptRegistry(config = {}) {
	const scripts = new Map();
	const registrations = Array.isArray(config.scripts) ? config.scripts : [];
	for (const registration of registrations) {
		const review = validateScriptRegistration(registration);
		if (!review.ok)
			throw new Error(`refusing invalid script registration ${registration?.id}: ${review.reasons.join("; ")}`);
		// A JSON roster has no functions, so the declarative Oracle is compiled here.
		// Downstream code therefore always sees a callable `verify`.
		const compiled =
			typeof registration.verify === "function"
				? registration
				: { ...registration, verify: compileVerifySpec(registration.verify_spec) };
		const key = `${registration.id}@${registration.version}`;
		if (scripts.has(key)) throw new Error(`duplicate script registration: ${key}`);
		scripts.set(key, compiled);
	}
	return {
		configured: scripts.size > 0,
		all: () => [...scripts.values()],
		get: (id, version) => scripts.get(`${id}@${version}`) ?? null,
		describe: () =>
			[...scripts.values()].map((r) => ({
				id: r.id,
				version: r.version,
				description: r.description ?? "",
				executable: r.executable,
				risk_class: r.risk_class ?? "medium",
				network: r.network === true,
				parameters: r.parameters,
			})),
	};
}

/**
 * Validate that `candidate` is really inside `allowedRoot`, resolving symlinks.
 * A lexical `..` check is not enough: a symlink inside the root can point out.
 */
export function insideRoot(allowedRoot, candidate, { mustExist = true } = {}) {
	try {
		const rootReal = existsSync(allowedRoot) ? realpathSync(resolve(allowedRoot)) : resolve(allowedRoot);
		if (mustExist && !existsSync(candidate)) return { ok: false, reason: `path does not exist: ${candidate}` };
		// Resolve the deepest existing ancestor of the candidate, so a not-yet-created
		// path (or one under a symlinked parent like macOS /var -> /private/var) is
		// compared on its REAL location.
		let resolved = resolve(candidate);
		let probe = resolved;
		while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
		if (existsSync(probe)) resolved = resolve(realpathSync(probe), relative(probe, resolved));
		const rel = relative(rootReal, resolved);
		if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return { ok: true, resolved, root: rootReal };
		return { ok: false, reason: `path escapes the allowed root (symlink or ..): ${candidate}` };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

/** Substitute the final argv from the template. Only registered parameters bind. */
export function buildArgv(registration, args) {
	const validation = validateParameters(registration.parameters ?? {}, args, "arguments");
	if (!validation.ok) return { ok: false, reason: validation.reasons.join("; ") };
	const parameterNames = Object.keys(registration.parameters ?? {});
	const referenced = new Set();
	const argv = [];
	for (const token of registration.argv_template) {
		const substituted = token.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => {
			if (!parameterNames.includes(name)) throw new Error(`argv template references unknown parameter: ${name}`);
			if (args[name] === undefined || args[name] === null) throw new Error(`argv template requires argument: ${name}`);
			referenced.add(name);
			return String(args[name]);
		});
		if (substituted.includes("\u0000")) return { ok: false, reason: "argument contains a NUL byte" };
		argv.push(substituted);
	}
	const unbound = parameterNames.filter(
		(name) => args[name] !== undefined && args[name] !== null && !referenced.has(name),
	);
	if (unbound.length > 0)
		return { ok: false, reason: `provided argument not bound by argv_template: ${unbound.join(", ")}` };
	return { ok: true, argv };
}

/**
 * Validate the declared resource (path) parameters BEFORE any effect. A path
 * parameter must resolve INSIDE `allowed_root` (symlinks included): an `in` path
 * must already exist, an `out` path may be created but its deepest existing
 * ancestor must stay inside the root. This closes the "arg points anywhere"
 * hole for every parameter a human marked with a direction.
 *
 * @returns {{ok: boolean, reasons: string[], resolved: Record<string,string>}}
 */
export function validateResourceParams(registration, args, { cwd = null } = {}) {
	const reasons = [];
	const resolved = {};
	const parameters = registration?.parameters ?? {};
	const base = cwd || registration?.cwd || registration?.allowed_root;
	for (const [name, spec] of Object.entries(parameters)) {
		if (!spec || (spec.direction !== "in" && spec.direction !== "out")) continue;
		const value = args?.[name];
		if (value === undefined || value === null) continue;
		if (typeof value !== "string" || value.length === 0) {
			reasons.push(`resource parameter ${name} must be a non-empty string`);
			continue;
		}
		if (value.includes("\u0000")) {
			reasons.push(`resource parameter ${name} contains a NUL byte`);
			continue;
		}
		const candidate = isAbsolute(value) ? value : resolve(base, value);
		const check = insideRoot(registration.allowed_root, candidate, { mustExist: spec.direction === "in" });
		if (!check.ok) {
			reasons.push(`resource parameter ${name} (${spec.direction}) is not inside the allowed root: ${check.reason}`);
			continue;
		}
		// An `out` path must live in an existing, in-root directory so the script
		// cannot be pointed at a path whose parent is a symlink out of the root.
		const parentCheck = insideRoot(registration.allowed_root, dirname(check.resolved), { mustExist: true });
		if (!parentCheck.ok) {
			reasons.push(
				`resource parameter ${name} (${spec.direction}) parent is not a usable in-root directory: ${parentCheck.reason}`,
			);
			continue;
		}
		resolved[name] = check.resolved;
	}
	return { ok: reasons.length === 0, reasons, resolved };
}

function excerpt(text) {
	const value = String(text ?? "");
	return value.length <= 2000 ? value : `${value.slice(0, 2000)}…`;
}

/**
 * Turn one reviewed script registration into an ActionContract. The contract's
 * procedure spawns the fixed executable with `shell:false`; the registered
 * Oracle decides post-conditions.
 */
export function createScriptContract(registration) {
	const review = validateScriptRegistration(registration);
	if (!review.ok)
		throw new Error(`refusing invalid script registration ${registration?.id}: ${review.reasons.join("; ")}`);
	const id = `script.${registration.id}`;
	// Cache the reviewed registration so the closures always compare against the
	// CONTRACT's declared pin, not a mutated contract field.
	let contract;
	contract = defineContract({
		id,
		version: registration.version,
		tool: "aegis_script",
		operation: registration.id,
		description:
			registration.description ?? `Run the human-registered script ${registration.id}@${registration.version}.`,
		risk_class: registration.risk_class ?? "medium",
		network: registration.network === true,
		parameters: registration.parameters,
		recognition: {
			check: () => {
				if (!existsSync(registration.executable)) return { ok: false, reason: "registered executable is missing" };
				if (!statSync(registration.executable).isFile())
					return { ok: false, reason: "registered executable is not a regular file" };
				// Compare against the contract's declared pins so a mutated contract is
				// itself detected as a change.
				const declaredExecDigest = contract.procedure.executable_digest;
				const current = executableDigest(registration.executable);
				if (current !== declaredExecDigest || current !== registration.executable_digest) {
					return {
						ok: false,
						reason: "registered executable changed; a new version and re-verification are required",
						expected: declaredExecDigest,
						observed: current,
					};
				}
				// Interpreter registrations additionally re-check the script body.
				if (isInterpreter(registration.executable)) {
					if (!registration.script_path || !existsSync(registration.script_path))
						return { ok: false, reason: "registered script_path is missing" };
					const scriptNow = executableDigest(registration.script_path);
					if (scriptNow !== registration.script_digest) {
						return {
							ok: false,
							reason: "registered script changed; a new version and re-verification are required",
							expected: registration.script_digest,
							observed: scriptNow,
						};
					}
				}
				// Real (symlink-resolved) cwd check.
				const cwdCheck = insideRoot(registration.allowed_root, registration.cwd);
				if (!cwdCheck.ok) return cwdCheck;
				return { ok: true, executable_digest: current, cwd: cwdCheck.resolved };
			},
		},
		procedure: {
			kind: "argv",
			executable: registration.executable,
			executable_digest: registration.executable_digest,
			script_path: registration.script_path ?? null,
			script_digest: registration.script_digest ?? null,
			argv_template: registration.argv_template,
			run: ({ arguments: args, context }) => {
				const argvBuild = buildArgv(registration, args);
				if (!argvBuild.ok)
					return { ok: false, failure_mode: "precondition_unmet", detail: argvBuild.reason, retry_allowed: false };
				const cwdCheck = insideRoot(registration.allowed_root, registration.cwd);
				if (!cwdCheck.ok)
					return { ok: false, failure_mode: "action_rejected", detail: cwdCheck.reason, retry_allowed: false };
				// Bound every declared path parameter to allowed_root BEFORE spawning.
				const resourceCheck = validateResourceParams(registration, args, { cwd: cwdCheck.resolved });
				if (!resourceCheck.ok)
					return {
						ok: false,
						failure_mode: "action_rejected",
						detail: `resource binding refused: ${resourceCheck.reasons.join("; ")}`,
						retry_allowed: false,
						resource_bindings: resourceCheck.resolved,
					};
				const started = Date.now();
				const result = spawnSync(registration.executable, argvBuild.argv, {
					cwd: cwdCheck.resolved,
					shell: false,
					timeout: contract.stop_policy.timeout_ms,
					encoding: "utf8",
					maxBuffer: MAX_CAPTURE_BYTES,
					windowsHide: true,
					env: { PATH: process.env.PATH ?? "", ...(registration.env ?? {}) },
				});
				const stdout = typeof result.stdout === "string" ? result.stdout : "";
				const stderr = typeof result.stderr === "string" ? result.stderr : "";
				// Distinguish a real timeout (spawnSync kills with SIGTERM and reports
				// ETIMEDOUT) from any other signal (e.g. SIGSEGV, SIGKILL from outside).
				const errored = Boolean(result.error);
				const timedOut = result.error?.code === "ETIMEDOUT";
				const signal = result.signal ?? null;
				const exitCode = typeof result.status === "number" ? result.status : null;
				const observed = {
					executable: registration.executable,
					executable_digest: registration.executable_digest,
					argv: argvBuild.argv,
					cwd: cwdCheck.resolved,
					cwd_root: cwdCheck.root,
					resource_bindings: resourceCheck.resolved,
					exit_code: exitCode,
					signal,
					timed_out: timedOut,
					spawn_error: errored ? (result.error?.message ?? String(result.error)) : null,
					stdout_excerpt: excerpt(stdout),
					stderr_excerpt: excerpt(stderr),
					stdout_digest: digest(stdout),
					stderr_digest: digest(stderr),
					attempts: 1,
					retry_allowed: false,
				};
				if (timedOut)
					return {
						ok: false,
						failure_mode: "timeout",
						detail: "script timed out; not retried",
						timed_out: true,
						exit_code: exitCode,
						signal,
						duration_ms: Date.now() - started,
						observed,
					};
				if (errored && exitCode === null) {
					return {
						ok: false,
						failure_mode: "tool_error",
						detail: `script could not complete: ${observed.spawn_error ?? signal ?? "unknown"}`,
						exit_code: exitCode,
						signal,
						duration_ms: Date.now() - started,
						observed,
					};
				}
				// A non-zero exit code is a TRANSPORT fact, not a task verdict: the
				// registered Oracle still inspects the real post-state. So we return ok
				// (proceed to verification) while keeping exit_code/signal in the
				// transport record. A failed post-state then becomes `unknown`.
				return { ok: true, exit_code: exitCode, signal, duration_ms: Date.now() - started, observed };
			},
		},
		verification: {
			check: ({ observed, context }) => {
				let result;
				try {
					result = registration.verify({ observed, context, registration });
				} catch (error) {
					result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
				}
				if (!result || result.ok !== true)
					return { ok: false, reason: result?.reason ?? "registered oracle rejected the post-state" };
				return {
					ok: true,
					reason: result.reason ?? "registered oracle confirmed the post-state",
					expected: result.expected,
					observed: result.observed,
				};
			},
		},
		scope: {
			environment_fingerprint: registration.environment_fingerprint ?? "local-workspace",
			domain: registration.domain ?? "script",
			permissions: registration.permissions ?? ["workspace-script"],
			task_types: registration.task_types ?? ["script"],
		},
		authorization: {
			target_kinds: registration.target_kinds ?? ["workspace_file"],
			allowed_actions: [id],
		},
		stop_policy: { max_attempts: 1, retry: "none", timeout_ms: registration.timeout_ms ?? 10000 },
		build: ({ observed, context, transport, verification, status, failure_mode }) => {
			const now = new Date().toISOString();
			// `action_ref` is the REGISTERED action id (script.<id>); the Pi toolCallId
			// is a separate execution identity (`action_id`). Keeping them distinct lets
			// the compiler resolve `do.action_ref` against the Registry while the event
			// log still pairs the request/completion by the toolCallId.
			const actionRef = id;
			const actionId = context.action_event_id ?? null;
			const observation = {
				observation_kind: "script_execution",
				subject: `${registration.id}@${registration.version}`,
				predicate: "postcondition",
				value: observed ?? null,
				source: "registered_script",
				verified: status === "success" && verification.ok === true,
				action_ref: actionRef,
				action_id: actionId,
				observed_at: now,
			};
			const evidenceRefs = [];
			if (observed?.stdout_digest)
				evidenceRefs.push({
					ref_type: "artifact",
					ref_id: `${registration.id}.stdout`,
					digest: observed.stdout_digest,
				});
			if (context.action_event_id) evidenceRefs.push({ ref_type: "action", ref_id: context.action_event_id });
			// Data refs the FINAL bound arguments actually used are part of the stage
			// Outcome's own evidence, so a later contribution can be confirmed against
			// the real record (the outcome must name both the data and the action).
			for (const ref of Array.isArray(context.use_refs) ? context.use_refs : []) {
				if (ref && typeof ref === "object" && ref.ref_id) evidenceRefs.push(ref);
			}
			const criterion = {
				criterion_id: `script.${registration.id}:postcondition`,
				description: `registered script ${registration.id}@${registration.version} satisfies its declared postcondition`,
				expected: registration.expect ?? "registered postcondition",
			};
			// MEMORY_SCHEMA §5.4: keep `schema_version: "1.0"` on the Outcome object;
			// a non-success judgement has no observed value (the raw transport/post-state
			// stays in the observation + transport fields).
			const stepOutcome = {
				schema_version: "1.0",
				outcome_id: newOutcomeId("out_step"),
				level: "step",
				episode_id: context.episode_id ?? null,
				step_id: context.step_id ?? `step_${id}`,
				scope: `script.${registration.id}@${registration.version}`,
				criterion,
				status,
				observed: status === "success" || status === "failure" ? (observed ?? null) : null,
				oracle: {
					oracle_id: `script-oracle:${registration.id}`,
					method: "registered_post_check",
					version: String(registration.version),
					independence_group: registration.independence_group ?? null,
				},
				evidence_refs: evidenceRefs,
				transport,
				failure_mode: status === "success" ? null : failure_mode || "insufficient_evidence",
				preconditions_verified: true,
				// Honest replayability: the Oracle check is reproducible only in the
				// read-only sense, and the script itself is NOT auto-replayed (it may be
				// non-idempotent). replay_count stays 0 unless an independent replay is
				// actually performed by a caller.
				reproducibility: {
					replayable: status === "success",
					replay_kind: "postcondition_check",
					replay_hash: status === "success" ? (observed?.stdout_digest ?? null) : null,
					replay_count: 0,
					checked_at: now,
				},
				assessed_at: now,
				action_ref: actionRef,
				action_id: actionId,
				action_version: contract.version,
				implementation_digest: contract.implementation_digest,
			};
			return { observation, step_outcome: stepOutcome };
		},
	});
	return contract;
}

/** All contracts for a registry, for use with ActionRegistry. */
export function scriptContracts(registry) {
	return registry.all().map((registration) => createScriptContract(registration));
}
