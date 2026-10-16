// Trusted Campaign registries (C0 contract).
//
// A Manifest may REFER to an adapter or task type, but it may never DEFINE one.
// The set of known execution adapters, Oracle adapters, report writers and task
// types is a code-owned, reviewed registry (user decision 7). A value outside
// this registry is refused, never "learned" from a Manifest or a model.
//
// This is deliberately data-only: entries describe what a primitive is for; they
// carry no executable code and grant no authorization. Authorization still comes
// only from the Manifest's `authorization` block and, at execution time, from the
// Broker/authorization modules.

/**
 * Execution adapters. The first supervised profile is the authorized macOS
 * workspace; it is explicitly NOT a sandbox. `network`, `credentials` and
 * `supervision` are declared so the Manifest authorization check can match them.
 */
export const EXECUTION_ADAPTERS = Object.freeze({
	"workspace.exec.v1": Object.freeze({
		id: "workspace.exec.v1",
		version: "1.0.0",
		description: "Supervised authorized macOS workspace execution; not a sandbox",
		environment: "macos-workspace",
		network: "manifest_policy",
		credentials: "manifest_policy",
		supervision: "human_supervised_required",
		sandbox: false,
	}),
	// Reserved for a later, externally enforced container adapter. Kept explicit
	// so a Manifest that names it is refused until that adapter is registered.
});

/** Oracle adapters. The model can never select or implement one at runtime. */
export const ORACLE_ADAPTERS = Object.freeze({
	"fixture.oracle.v1": Object.freeze({
		id: "fixture.oracle.v1",
		version: "1.0.0",
		description: "Deterministic local fixture oracle (no network, no model)",
		domains: ["fixture"],
		isolation_group: "fixture-local",
		supports_delayed: true,
	}),
});

/** Report writers. Only the reviewed acceptance writer is known in C0. */
export const REPORT_ADAPTERS = Object.freeze({
	"aegis-acceptance.v1": Object.freeze({
		id: "aegis-acceptance.v1",
		version: "1.0.0",
		description: "Deterministic Campaign report + acceptance bundle writer",
	}),
});

/**
 * Allowed dynamic task types. A dynamic proposal's `task_type` must be one of
 * these; the Manifest may narrow this list but never widen it.
 */
export const TASK_TYPES = Object.freeze({
	observe: Object.freeze({ id: "observe", description: "Read-only observation inside the declared target" }),
	verify: Object.freeze({ id: "verify", description: "Independently verify an existing claim/criterion" }),
	reproduce: Object.freeze({ id: "reproduce", description: "Reproduce a previously observed condition" }),
});

/** Unknown values are refused, never defaulted. */
export function lookupAdapter(registry, id) {
	if (typeof id !== "string" || id.length === 0) return null;
	return Object.hasOwn(registry, id) ? registry[id] : null;
}

export function isKnownExecutionAdapter(id) {
	return lookupAdapter(EXECUTION_ADAPTERS, id) !== null;
}
export function isKnownOracleAdapter(id) {
	return lookupAdapter(ORACLE_ADAPTERS, id) !== null;
}
export function isKnownReportAdapter(id) {
	return lookupAdapter(REPORT_ADAPTERS, id) !== null;
}
export function isKnownTaskType(id) {
	return lookupAdapter(TASK_TYPES, id) !== null;
}

export function knownAdapterIds() {
	return {
		execution: Object.keys(EXECUTION_ADAPTERS),
		oracle: Object.keys(ORACLE_ADAPTERS),
		report: Object.keys(REPORT_ADAPTERS),
		task_types: Object.keys(TASK_TYPES),
	};
}
