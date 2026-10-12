// Aegis runtime ActionContract engine (batch B).
//
// ONE small, reusable registry/engine shared by read-only observation actions
// and human-configured script actions. It is intentionally not a second
// execution framework and not an event writer:
//
//   * an ActionContract binds a REVIEWED implementation (a registered function
//     or a human-registered argv/executable) to a Recognition check, a
//     Procedure, a Verification check, a scope and an authorization
//     declaration, plus a bounded stop/retry policy;
//   * the broker is the only execution path, and it re-checks arguments,
//     recognition, authority and verification immediately before/after the
//     procedure;
//   * a natural-language `do` is never parsed into code: `bindProposal` returns
//     an explicit mapping or explicit `gaps`, and an unmapped action/checker
//     cannot execute.
//
// The engine produces `observation.captured` / `outcome.recorded` payloads for
// the Observer's ONE EventLog, but it never appends them itself.
//
// Honest boundary: authorization is not verification. `authorize`-style inputs
// only decide whether an action MAY run; success is decided by the registered
// Verification check, never by an exit code or a model claim.

import { digest, evaluatePredicates, getPath, newId, stable } from "../fixture/contracts.mjs";
import { authorizeAction } from "./authorization.mjs";

export const CONTRACT_SCHEMA_VERSION = "1.0";
export const PROCEDURE_KINDS = ["function", "argv"];
export const RISK_CLASSES = ["observe", "low", "medium", "high"];
export const RETRY_POLICIES = ["none", "idempotent", "oracle_check"];
export const PREDICATE_OPS = ["eq", "neq", "exists"];

// An absent/`*`/`any` scope or permission is UNKNOWN, never "all". A contract
// that declares a wildcard target or permission is rejected as a gate failure.
const WILDCARDS = new Set(["*", "any", "all", "unknown", "null"]);

export const ALLOWED_PARAMETER_TYPES = new Set(["string", "integer", "number", "boolean"]);

function isWildcard(value) {
	if (value === null || value === undefined) return true;
	if (typeof value === "string" && WILDCARDS.has(value.trim().toLowerCase())) return true;
	return false;
}

function functionSource(fn) {
	return typeof fn === "function" ? String(fn) : null;
}

/**
 * Digest of the actual implementation. Changing a registered function's source,
 * or a script's executable/argv/digest, changes this value, so it must be
 * re-reviewed and re-verified as a new version (MEMORY_SCHEMA §6.3).
 */
export function implementationDigest(procedure) {
	if (!procedure || typeof procedure !== "object") return null;
	if (procedure.kind === "function") return digest({ kind: "function", source: functionSource(procedure.run) });
	if (procedure.kind === "argv") {
		return digest({
			kind: "argv",
			executable: procedure.executable ?? null,
			executable_digest: procedure.executable_digest ?? null,
			// Pin the SCRIPT body and path separately from the interpreter, so
			// swapping the script cannot keep the same reviewed digest.
			script_path: procedure.script_path ?? null,
			script_digest: procedure.script_digest ?? null,
			argv_template: Array.isArray(procedure.argv_template) ? procedure.argv_template : procedure.argv ?? null,
			// The run wrapper is reviewed code too: a change to how argv is spawned
			// must change the pinned implementation digest.
			run_source: functionSource(procedure.run),
		});
	}
	return null;
}

export const ALLOWED_PARAMETER_TYPES_LIST = ["string", "integer", "number", "boolean"];

/**
 * Full, data-only validation of action arguments against a contract's schema.
 *
 * Enforces: required/optional, type, non-empty, enum membership, numeric range,
 * no unknown fields and no non-JSON values. The fixture helper only checks
 * string+required; batch B needs number/boolean/enum/range/optional and must
 * reject unknown fields BEFORE execution.
 */
export function validateParameters(parameters, args, label = "arguments") {
	const reasons = [];
	if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, reasons: [`${label} must be an object`] };
	const schema = parameters && typeof parameters === "object" ? parameters : {};
	for (const name of Object.keys(args)) {
		if (!Object.hasOwn(schema, name)) reasons.push(`${label}.${name} is not a declared parameter`);
	}
	for (const [name, spec] of Object.entries(schema)) {
		const value = args[name];
		const absent = value === undefined || value === null;
		if (absent) {
			if (spec.required) reasons.push(`${label}.${name} is required`);
			continue;
		}
		if (spec.type === "string") {
			if (typeof value !== "string") reasons.push(`${label}.${name} must be a string`);
			else if (spec.min_length !== undefined && value.length < spec.min_length) reasons.push(`${label}.${name} is shorter than min_length ${spec.min_length}`);
		} else if (spec.type === "integer") {
			if (!Number.isInteger(value)) reasons.push(`${label}.${name} must be an integer`);
		} else if (spec.type === "number") {
			if (typeof value !== "number" || Number.isNaN(value)) reasons.push(`${label}.${name} must be a number`);
		} else if (spec.type === "boolean") {
			if (typeof value !== "boolean") reasons.push(`${label}.${name} must be a boolean`);
		} else {
			reasons.push(`${label}.${name} has an unsupported type ${String(spec.type)}`);
		}
		if (Array.isArray(spec.values) && !spec.values.includes(value)) reasons.push(`${label}.${name} must be one of ${spec.values.join(", ")}`);
		if (spec.type === "integer" || spec.type === "number") {
			if (spec.minimum !== undefined && value < spec.minimum) reasons.push(`${label}.${name} is below minimum ${spec.minimum}`);
			if (spec.maximum !== undefined && value > spec.maximum) reasons.push(`${label}.${name} is above maximum ${spec.maximum}`);
		}
		if (spec.pattern !== undefined && typeof value === "string" && !new RegExp(spec.pattern).test(value)) reasons.push(`${label}.${name} does not match pattern`);
		if (typeof value === "string" && value.includes("\u0000")) reasons.push(`${label}.${name} contains a NUL byte`);
		if (value !== null && typeof value === "object") reasons.push(`${label}.${name} must be a scalar (data-only)`);
	}
	return { ok: reasons.length === 0, reasons };
}

function checkCanonical(check) {
	if (!check || typeof check !== "object") return null;
	return {
		predicates: Array.isArray(check.predicates) ? check.predicates : null,
		check_source: functionSource(check.check),
	};
}

/** Digest over the executable part of the contract (not over comments/descriptions). */
export function contractDigest(contract) {
	return digest({
		schema_version: contract.schema_version,
		id: contract.id,
		version: contract.version,
		tool: contract.tool,
		operation: contract.operation,
		risk_class: contract.risk_class,
		network: contract.network === true,
		parameters: contract.parameters ?? {},
		recognition: checkCanonical(contract.recognition),
		procedure: {
			kind: contract.procedure?.kind ?? null,
			implementation_digest: contract.implementation_digest ?? null,
			executable: contract.procedure?.executable ?? null,
			executable_digest: contract.procedure?.executable_digest ?? null,
			script_path: contract.procedure?.script_path ?? null,
			script_digest: contract.procedure?.script_digest ?? null,
			argv_template: contract.procedure?.argv_template ?? null,
		},
		verification: checkCanonical(contract.verification),
		scope: contract.scope ?? null,
		authorization: contract.authorization ?? null,
		stop_policy: contract.stop_policy ?? null,
	});
}

/** Build a contract from a spec, filling safe defaults. Does not validate. */
export function defineContract(spec) {
	const defaults = {
		schema_version: CONTRACT_SCHEMA_VERSION,
		version: 1,
		risk_class: "medium",
		network: false,
		parameters: {},
		stop_policy: { max_attempts: 1, retry: "none", timeout_ms: 10000 },
	};
	const contract = { ...defaults, ...spec };
	contract.stop_policy = { ...defaults.stop_policy, ...(spec.stop_policy || {}) };
	contract.implementation_digest = spec.implementation_digest ?? implementationDigest(contract.procedure);
	return contract;
}

/**
 * Structural review of a contract. Returns `{ok, reasons}`. This is the static
 * review table for a registered primitive: id/version, digest, a Recognition
 * check, a Procedure, a Verification check, a non-wildcard scope, an
 * authorization declaration and a bounded stop policy.
 */
export function validateContract(contract) {
	const reasons = [];
	if (!contract || typeof contract !== "object") return { ok: false, reasons: ["contract must be an object"] };
	if (contract.schema_version !== CONTRACT_SCHEMA_VERSION) reasons.push(`schema_version must be ${CONTRACT_SCHEMA_VERSION}`);
	if (typeof contract.id !== "string" || !contract.id) reasons.push("id is required");
	if (!Number.isInteger(contract.version) || contract.version < 1) reasons.push("version must be a positive integer");
	if (typeof contract.tool !== "string" || !contract.tool) reasons.push("tool is required");
	if (typeof contract.operation !== "string" || !contract.operation) reasons.push("operation is required");
	if (!RISK_CLASSES.includes(contract.risk_class)) reasons.push(`risk_class must be one of ${RISK_CLASSES.join(", ")}`);
	if (contract.network === true && contract.risk_class === "observe") {
		// A network observation is still a network side effect; never let it hide
		// behind the read-only risk label.
		reasons.push("network=true cannot be declared risk_class=observe");
	}

	// Parameters: a data-only schema.
	if (!contract.parameters || typeof contract.parameters !== "object" || Array.isArray(contract.parameters)) {
		reasons.push("parameters must be an object schema");
	} else {
		for (const [name, spec] of Object.entries(contract.parameters)) {
			if (!spec || typeof spec !== "object") reasons.push(`parameter ${name} must be an object`);
			else if (!ALLOWED_PARAMETER_TYPES.has(spec.type)) reasons.push(`parameter ${name} needs a data-only type (${[...ALLOWED_PARAMETER_TYPES].join("/")})`);
			else if (Array.isArray(spec.values) && spec.values.length === 0) reasons.push(`parameter ${name} declares an empty value enum`);
		}
	}

	// Procedure.
	const procedure = contract.procedure;
	if (!procedure || typeof procedure !== "object") {
		reasons.push("procedure is required");
	} else if (!PROCEDURE_KINDS.includes(procedure.kind)) {
		reasons.push(`procedure.kind must be one of ${PROCEDURE_KINDS.join(", ")}`);
	} else if (procedure.kind === "function") {
		if (typeof procedure.run !== "function") reasons.push("function procedure requires run()");
	} else if (procedure.kind === "argv") {
		if (typeof procedure.executable !== "string" || !procedure.executable) reasons.push("argv procedure requires executable");
		if (!Array.isArray(procedure.argv_template) || !procedure.argv_template.every((t) => typeof t === "string")) {
			reasons.push("argv procedure requires a string argv_template");
		}
		if (typeof procedure.run !== "function") reasons.push("argv procedure requires a reviewed run() wrapper");
	}
	if (!contract.implementation_digest || typeof contract.implementation_digest !== "string") reasons.push("implementation_digest is required");

	// Recognition is mandatory AND must be able to actually decide something:
	// an empty predicates list with no check() would auto-pass, so it is refused.
	if (!contract.recognition || typeof contract.recognition !== "object") reasons.push("recognition is required");
	else if (typeof contract.recognition.check !== "function" && !(Array.isArray(contract.recognition.predicates) && contract.recognition.predicates.length > 0)) {
		reasons.push("recognition must have a non-empty predicates list or a check()");
	}
	if (Array.isArray(contract.recognition?.predicates)) {
		for (const [index, predicate] of contract.recognition.predicates.entries()) {
			reasons.push(...validatePredicateShape(predicate, `recognition.predicates[${index}]`));
		}
	}

	// Verification is mandatory AND must be able to actually decide something.
	if (!contract.verification || typeof contract.verification !== "object") reasons.push("verification is required");
	else if (typeof contract.verification.check !== "function" && !(Array.isArray(contract.verification.predicates) && contract.verification.predicates.length > 0)) {
		reasons.push("verification must have a non-empty predicates list or a check()");
	}
	if (Array.isArray(contract.verification?.predicates)) {
		for (const [index, predicate] of contract.verification.predicates.entries()) {
			reasons.push(...validatePredicateShape(predicate, `verification.predicates[${index}]`));
		}
	}

	// Scope and authorization: no unknown wildcard.
	if (!contract.scope || typeof contract.scope !== "object") reasons.push("scope is required");
	else {
		if (isWildcard(contract.scope.environment_fingerprint)) reasons.push("scope.environment_fingerprint must not be a wildcard or unset");
		if (isWildcard(contract.scope.domain)) reasons.push("scope.domain must not be a wildcard or unset");
		const permissions = contract.scope.permissions;
		if (!Array.isArray(permissions) || permissions.length === 0) reasons.push("scope.permissions must be a non-empty list");
		else if (permissions.some(isWildcard)) reasons.push("scope.permissions must not contain a wildcard");
	}
	if (!contract.authorization || typeof contract.authorization !== "object") reasons.push("authorization is required");
	else {
		const targets = contract.authorization.allowed_targets ?? contract.authorization.target_kinds ?? contract.authorization.targets;
		if (!Array.isArray(targets) || targets.length === 0) reasons.push("authorization must declare allowed target(s)");
		else if (targets.some(isWildcard)) reasons.push("authorization targets must not be a wildcard");
	}

	// Stop/retry policy.
	const policy = contract.stop_policy;
	if (!policy || typeof policy !== "object") reasons.push("stop_policy is required");
	else {
		if (!Number.isInteger(policy.max_attempts) || policy.max_attempts < 1) reasons.push("stop_policy.max_attempts must be >= 1");
		if (!RETRY_POLICIES.includes(policy.retry)) reasons.push(`stop_policy.retry must be one of ${RETRY_POLICIES.join(", ")}`);
		if (!Number.isInteger(policy.timeout_ms) || policy.timeout_ms < 0) reasons.push("stop_policy.timeout_ms must be >= 0");
	}

	return { ok: reasons.length === 0, reasons };
}

export function validatePredicateShape(predicate, label) {
	const reasons = [];
	if (!predicate || typeof predicate !== "object") return [`${label} must be an object`];
	if (typeof predicate.path !== "string" || !predicate.path) reasons.push(`${label}.path is required`);
	if (!PREDICATE_OPS.includes(predicate.op)) reasons.push(`${label}.op is unsupported`);
	if (predicate.op !== "exists" && !Object.hasOwn(predicate, "value")) reasons.push(`${label}.value is required`);
	if (predicate.op !== "exists" && predicate.value !== null && typeof predicate.value === "object") reasons.push(`${label}.value must be a scalar`);
	return reasons;
}

/**
 * Registry of reviewed contracts. Duplicate ids and invalid contracts are
 * refused: an unreviewed primitive must never be silently usable.
 */
export class ActionRegistry {
	constructor(contracts = []) {
		this.map = new Map();
		for (const contract of contracts) this.register(contract);
	}

	register(contract) {
		const validation = validateContract(contract);
		if (!validation.ok) throw new Error(`refusing invalid contract ${contract?.id}: ${validation.reasons.join("; ")}`);
		if (this.map.has(contract.id)) throw new Error(`duplicate contract id: ${contract.id}`);
		this.map.set(contract.id, contract);
		return contract;
	}

	get(id) {
		return this.map.get(id) || null;
	}

	has(id) {
		return this.map.has(id);
	}

	list() {
		return [...this.map.values()];
	}

	/** A data-only description safe to expose to a model. */
	describe() {
		return this.list().map((contract) => ({
			id: contract.id,
			version: contract.version,
			implementation_digest: contract.implementation_digest,
			tool: contract.tool,
			operation: contract.operation,
			risk_class: contract.risk_class,
			network: contract.network === true,
			description: contract.description ?? "",
			parameters: contract.parameters,
		}));
	}
}

function runPredicateCheck(check, state, label) {
	const reasons = [];
	if (!check || typeof check !== "object") return { ok: false, reasons: [`${label} is missing`], checks: [] };
	const checks = [];
	if (Array.isArray(check.predicates)) {
		let predicateOk = true;
		for (const predicate of check.predicates) {
			let value;
			try {
				value = getPath(state, predicate.path);
			} catch {
				value = undefined;
			}
			let ok;
			try {
				ok = evaluatePredicates(state, [predicate]);
			} catch (error) {
				ok = false;
				reasons.push(`${label} predicate ${predicate.path} failed to evaluate: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (!ok) predicateOk = false;
			checks.push({ name: `${label}:${predicate.path}`, ok, expected: predicate, actual: value });
		}
		if (!predicateOk) reasons.push(`${label} predicates are not satisfied`);
	}
	if (typeof check.check === "function") {
		let result;
		try {
			result = check.check(state);
		} catch (error) {
			result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
		const ok = result?.ok === true;
		checks.push({ name: `${label}:check`, ok, expected: "ok", actual: result?.reason ?? result });
		if (!ok) reasons.push(result?.reason || `${label} check failed`);
	}
	return { ok: reasons.length === 0, reasons, checks };
}

/** Recognition: may this action run against this current state/context? */
export function checkRecognition(contract, state) {
	return runPredicateCheck(contract.recognition, state, "recognition");
}

/** Verification: did the procedure actually produce the declared effect? */
export function checkVerification(contract, { observed, state, context = {} }) {
	const reasons = [];
	const checks = [];
	const hasPredicates = Array.isArray(contract.verification?.predicates) && contract.verification.predicates.length > 0;
	const hasCheck = typeof contract.verification?.check === "function";
	// Fail closed: a registered verification that cannot decide anything must not
	// silently pass.
	if (!hasPredicates && !hasCheck) return { ok: false, reasons: ["verification has no predicates and no check(); refusing to auto-pass"], checks };
	if (hasPredicates) {
		const result = runPredicateCheck({ predicates: contract.verification.predicates }, state, "verification");
		reasons.push(...result.reasons);
		checks.push(...result.checks);
	}
	if (hasCheck) {
		let result;
		try {
			result = contract.verification.check({ observed, state, context });
		} catch (error) {
			result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
		const ok = result?.ok === true;
		checks.push({ name: "verification:check", ok, expected: "ok", actual: result?.reason ?? result, expected_value: result?.expected, observed_value: result?.observed });
		if (!ok) reasons.push(result?.reason || "verification check failed");
	}
	return { ok: reasons.length === 0, reasons, checks };
}

// ---------------------------------------------------------------------------
// Proposal binding: LLM text is a proposal, never code.
// ---------------------------------------------------------------------------

/**
 * Bind a model proposal to known, registered primitives.
 *
 * Nothing is inferred from prose. The proposal must name a registered action id
 * and known predicate/checker names. Any unbound field is returned as an
 * explicit `gap`; if there is any gap the result is an executable:false
 * `candidate`, so a missing mapping can never be mistaken for a complete
 * contract ("expose the incomplete mapping; do not claim completeness by
 * editing JSON").
 *
 * @param {object} proposal
 * @param {object} input
 * @param {object} input.registry            reviewed ActionRegistry
 * @param {string[]} [input.knownPredicates] predicate names the binder may accept
 * @param {string[]} [input.knownCheckers]   checker names the binder may accept
 */
export function bindProposal(proposal, { registry, knownPredicates = [], knownCheckers = [] } = {}) {
	const gaps = [];
	if (!proposal || typeof proposal !== "object") {
		return { status: "rejected", executable: false, gaps: [{ field: "proposal", reason: "proposal is not an object" }], reason: "invalid proposal" };
	}

	// Action binding: explicit id only.
	const actionRef = typeof proposal.action_ref === "string" ? proposal.action_ref.trim() : "";
	const doValue = typeof proposal.do === "string" ? proposal.do.trim() : "";
	let resolvedActionRef = null;
	if (actionRef) {
		resolvedActionRef = registry?.has(actionRef) ? actionRef : null;
		if (!resolvedActionRef) gaps.push({ field: "action_ref", value: actionRef, reason: "not a registered action" });
	} else if (doValue && registry?.has(doValue)) {
		resolvedActionRef = doValue;
	} else {
		gaps.push({ field: "do", value: proposal.do ?? null, reason: "no registered action id was named; prose is not parsed into an action" });
	}
	const contract = resolvedActionRef ? registry.get(resolvedActionRef) : null;

	// Recognition/verification checkers: names only.
	const recognitionChecker = proposal.recognition_checker ?? null;
	const verificationChecker = proposal.verification_checker ?? null;
	if (recognitionChecker !== null && !knownCheckers.includes(recognitionChecker)) {
		gaps.push({ field: "recognition_checker", value: recognitionChecker, reason: "unknown checker" });
	}
	if (verificationChecker !== null && !knownCheckers.includes(verificationChecker)) {
		gaps.push({ field: "verification_checker", value: verificationChecker, reason: "unknown checker" });
	}

	// When predicates: structured predicates are taken as data; string forms must
	// name a known predicate. Free text becomes a gap.
	const when = [];
	if (proposal.when !== undefined) {
		if (!Array.isArray(proposal.when)) {
			gaps.push({ field: "when", value: proposal.when, reason: "when must be an array" });
		} else {
			for (const entry of proposal.when) {
				if (entry && typeof entry === "object" && !Array.isArray(entry)) {
					const shapeReasons = validatePredicateShape(entry, "when");
					if (shapeReasons.length > 0) gaps.push({ field: "when", value: entry, reason: shapeReasons.join("; ") });
					else when.push({ path: entry.path, op: entry.op, ...(entry.op === "exists" ? {} : { value: entry.value }) });
				} else if (typeof entry === "string" && knownPredicates.includes(entry.trim())) {
					when.push({ name: entry.trim() });
				} else {
					gaps.push({ field: "when", value: entry, reason: "not a known predicate descriptor or registered predicate name" });
				}
			}
		}
	}

	// Scope: must be explicit, never wildcard.
	const scope = proposal.scope && typeof proposal.scope === "object" ? proposal.scope : null;
	if (!scope) gaps.push({ field: "scope", value: proposal.scope ?? null, reason: "scope is required and must not be inferred" });
	else {
		if (isWildcard(scope.environment_fingerprint)) gaps.push({ field: "scope.environment_fingerprint", reason: "unset or wildcard" });
		if (isWildcard(scope.domain)) gaps.push({ field: "scope.domain", reason: "unset or wildcard" });
	}

	// Arguments template: must cover exactly the contract's parameter names.
	let argumentsTemplate = null;
	if (contract) {
		const template = proposal.arguments_template ?? proposal.arguments ?? null;
		if (template && typeof template === "object" && !Array.isArray(template)) {
			const parameterNames = Object.keys(contract.parameters ?? {});
			const templateNames = Object.keys(template);
			const shapeOk = templateNames.length === parameterNames.length && templateNames.every((name) => parameterNames.includes(name));
			if (shapeOk) argumentsTemplate = template;
			else gaps.push({ field: "arguments_template", value: templateNames, reason: `must match parameters ${parameterNames.join(", ")}` });
		} else {
			gaps.push({ field: "arguments_template", value: template, reason: "a data-only arguments template is required" });
		}
	}

	const executable = gaps.length === 0 && contract !== null && when.length > 0;
	return {
		status: executable ? "bound" : "candidate",
		executable,
		action_ref: resolvedActionRef,
		action_version: contract?.version ?? null,
		implementation_digest: contract?.implementation_digest ?? null,
		arguments_template: argumentsTemplate,
		when,
		recognition_checker: recognitionChecker,
		verification_checker: verificationChecker,
		scope,
		gaps,
		reason: executable ? "proposal maps to registered primitives" : "proposal is incomplete/unmapped and stays a candidate",
	};
}

// ---------------------------------------------------------------------------
// Broker: the only execution path.
// ---------------------------------------------------------------------------

function rejected(reason, extra = {}) {
	return { ok: false, status: "rejected", reason, ...extra };
}

function argumentsDigest(args) {
	return digest(args ?? {});
}

/**
 * Re-check an authorization/permit object against the exact action and final
 * arguments. A permit for action X with arguments A cannot authorize action Y or
 * different arguments (parameter swap). Optionally re-checks target/scope/expiry
 * when the permit carries them.
 */
export function matchPermit(permit, contract, args, { now = Date.now() } = {}) {
	const reasons = [];
	if (!permit || typeof permit !== "object") return { ok: false, reasons: ["no permit supplied"] };
	// A permit must be a real authorization decision, not a hand-built `{ok:true}`.
	if (permit.mode !== "auto" && permit.mode !== "normal") reasons.push("permit has no recognized authorization mode");
	if (permit.ok !== true) reasons.push("permit was not granted");
	if (permit.action_ref !== contract.id) reasons.push("permit action_ref does not match");
	if (permit.version !== contract.version) reasons.push("permit version does not match");
	if (permit.implementation_digest !== contract.implementation_digest) reasons.push("permit implementation_digest does not match");
	// When the permit pins the full reviewed contract (procedure + Recognition +
	// Verification checker source), a change to ANY reviewed part invalidates it.
	if (permit.contract_digest !== undefined && permit.contract_digest !== null) {
		if (permit.contract_digest !== contractDigest(contract)) reasons.push("permit contract_digest does not match the reviewed contract; re-verification is required");
	}
	if (typeof permit.arguments_digest !== "string" || permit.arguments_digest !== argumentsDigest(args)) reasons.push("permit arguments_digest does not match the final arguments");
	if (permit.scope_digest !== undefined && permit.scope_digest !== null) {
		if (permit.scope_digest !== contractScopeDigest(contract)) reasons.push("permit scope_digest does not match the contract scope");
	}
	if (permit.expires_at) {
		const expires = Date.parse(permit.expires_at);
		if (!Number.isFinite(expires)) reasons.push("permit expiry is not a valid timestamp");
		else if (expires <= now) reasons.push("permit has expired");
	}
	return { ok: reasons.length === 0, reasons };
}

export function contractScopeDigest(contract) {
	return digest({ scope: contract.scope ?? null, authorization: contract.authorization ?? null });
}

export function createActionBroker({ registry }) {
	if (!registry) throw new Error("createActionBroker requires a registry");

	/**
	 * Run a registered action through the single execution path.
	 *
	 * @param {object} input
	 * @param {string} input.action_ref registered contract id
	 * @param {object} input.arguments data-only arguments
	 * @param {object} input.context execution context (workspaceRoot, step_id, action_event_id, ...)
	 * @param {object} input.permit result of an authorization decision (action_ref/version/digest/args)
	 * @param {object} [input.state] current state for Recognition predicates
	 */
	async function invoke({ action_ref, arguments: args = {}, context = {}, permit = null, authorization = null, state = {} } = {}) {
		const contract = registry.get(action_ref);
		if (!contract) return rejected(`unknown action: ${String(action_ref)}`, { action_ref: action_ref ?? null });

		// 1. Final arguments validated against the registered, data-only schema.
		const argumentCheck = validateParameters(contract.parameters, args, "arguments");
		if (!argumentCheck.ok) return rejected(`invalid arguments: ${argumentCheck.reasons.join("; ")}`, { action_ref: contract.id, argument_reasons: argumentCheck.reasons });

		// 2. Authorization. When an authorization config is supplied, the permit is
		//    RE-DERIVED here from the actual context; a passed-in permit is ignored
		//    so a hand-built `{ok:true}` object cannot authorize execution.
		let effectivePermit = permit;
		let authorizationDecision = null;
		if (authorization) {
			authorizationDecision = authorizeAction(authorization, {
				action_ref: contract.id,
				tool: contract.tool,
				contract,
				arguments: args,
				target: context.target ?? state.target,
				target_path: context.target_path ?? state.target_path,
				network: context.network ?? contract.network === true,
				expires_at: context.expires_at,
			});
			if (authorizationDecision.status !== "authorized") {
				return rejected(`authorization ${authorizationDecision.status}: ${(authorizationDecision.reasons ?? []).join("; ")}`, { action_ref: contract.id, authorization: authorizationDecision });
			}
			effectivePermit = authorizationDecision.permit;
		}

		// 3. Permit re-check (authorization is not verification).
		const permitCheck = matchPermit(effectivePermit, contract, args);
		if (!permitCheck.ok) return rejected(`permit re-check failed: ${permitCheck.reasons.join("; ")}`, { action_ref: contract.id, permit_checks: permitCheck.reasons });

		// 4. Recognition against the current state AND execution context.
		const recognitionState = { ...context, ...state, arguments: args };
		const recognition = checkRecognition(contract, recognitionState);
		if (!recognition.ok) return rejected(`recognition failed: ${recognition.reasons.join("; ")}`, { action_ref: contract.id, recognition });

		// 5. Procedure.
		let procedureResult;
		const started = Date.now();
		// The final, data-only arguments are part of the execution context so the
		// Procedure, Verification and build steps all see the exact same values.
		const execContext = { ...context, arguments: args };
		try {
			procedureResult = await contract.procedure.run({ arguments: args, context: execContext, limits: contract.stop_policy });
		} catch (error) {
			procedureResult = { ok: false, failure_mode: "tool_error", error: error instanceof Error ? error.message : String(error) };
		}
		if (!procedureResult || typeof procedureResult !== "object") procedureResult = { ok: false, failure_mode: "tool_error", error: "procedure returned no result" };
		// A named `transport_ok` from the procedure wins; otherwise derive it from
		// the exit code when present, and only fall back to `ok`. This keeps the
		// transport fact honest when a script exits non-zero but the caller still
		// wants the post-state (and its Oracle) checked.
		const derivedToolOk =
			typeof procedureResult.transport_ok === "boolean"
				? procedureResult.transport_ok
				: typeof procedureResult.exit_code === "number"
					? procedureResult.exit_code === 0
					: procedureResult.ok === true;
		const transport = {
			tool_ok: derivedToolOk,
			exit_code: procedureResult.exit_code ?? null,
			timed_out: procedureResult.timed_out === true,
			signal: procedureResult.signal ?? null,
			duration_ms: procedureResult.duration_ms ?? Date.now() - started,
			// Honest attempt accounting: preserved on the transport record so a
			// non-success (whose `observed` must be null per MEMORY_SCHEMA §5.2) still
			// shows that the stop policy was honored (no silent retry).
			attempts: procedureResult.observed?.attempts ?? 1,
			retry_allowed: procedureResult.retry_allowed === true,
		};

		// 6. Verification: success only when the registered check passes. The
		//    transport fields are PRESERVED as observed facts; they are never
		//    overwritten to reflect the goal status.
		let status = "unknown";
		let failureMode = procedureResult.failure_mode ?? (procedureResult.ok ? "insufficient_evidence" : "tool_error");
		let verification = { ok: false, reasons: ["procedure failed; verification not attempted"], checks: [] };
		if (procedureResult.ok === true) {
			// Predicate-based verification is evaluated over the observed result first,
			// then the current state. A predicate that cannot be found (path missing)
			// evaluates false -> `unknown`, never a silent success.
			const observed = procedureResult.observed ?? null;
			const verificationState = observed && typeof observed === "object" && !Array.isArray(observed) ? { ...state, ...observed } : { ...state, value: observed };
			verification = checkVerification(contract, { observed, state: verificationState, context: execContext });
			if (verification.ok) {
				status = "success";
				failureMode = null;
			} else {
				failureMode = "insufficient_evidence";
			}
		}

		// 7. Normalized payloads for the Observer EventLog, built by the contract.
		let built = { observation: null, step_outcome: null };
		if (typeof contract.build === "function") {
			try {
				built = contract.build({ observed: procedureResult.observed ?? null, context: execContext, transport, verification, status, failure_mode: failureMode, contract }) ?? built;
			} catch (error) {
				return rejected(`outcome build failed: ${error instanceof Error ? error.message : String(error)}`, { action_ref: contract.id });
			}
		}

		return {
			ok: status === "success",
			status,
			action_ref: contract.id,
			version: contract.version,
			implementation_digest: contract.implementation_digest,
			transport,
			failure_mode: failureMode,
			detail: procedureResult.detail ?? null,
			recognition,
			verification,
			authorization: authorizationDecision,
			observation: built.observation,
			step_outcome: built.step_outcome,
			result: procedureResult.observed ?? null,
			retry_allowed: procedureResult.retry_allowed === true && contract.stop_policy.retry !== "none",
			attempts: 1,
		};
	}

	return {
		registry,
		invoke,
		bindProposal: (proposal, options = {}) => bindProposal(proposal, { registry, ...options }),
		describe: () => registry.describe(),
	};
}

// ---------------------------------------------------------------------------
// Small helpers shared by concrete actions.
// ---------------------------------------------------------------------------

/** Deterministic id for an action identity (used when no event id is supplied). */
export function actionIdentity(contract, args) {
	return `action:${contract.id}@${contract.version}#${digest(args ?? {}).slice(0, 16)}`;
}

export function newOutcomeId(prefix = "out") {
	return `${prefix}_${newId()}`;
}
