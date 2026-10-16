// Deterministic experience compiler gate (batch B / B2 hardening).
//
// This module IS the mechanical gate. `compileExperience` only ever returns an
// `active` experience when EVERY proof-independent rule below holds; otherwise
// it returns a `candidate` and the failing rules, so nothing reaches the
// Router/direct path without independently RESOLVED, replayable, verified
// evidence.
//
// HARDENING (B2 audit) — the previous version trusted caller-supplied booleans
// and digest strings. It could be fooled by:
//   * a `proofKey()` result compared as an object while it was a string,
//   * an artifact ref that merely carried a `digest` string (never resolved),
//   * `reproducibility.replayable=true` + a non-empty `replay_hash` + a
//     `replay_count` claimed by the same producer,
//   * a union of `when` predicates that never held together in one episode.
// The rules below REQUIRE a trusted resolver that returns real records
// (Outcome / Episode / action execution / artifact) and cross-check every
// claim against them. Without such a resolver, `active` is impossible.
//
// Independence is proven by REAL Episode identity + reset references:
//   distinct episode_id, distinct independence_group, and distinct
//   `isolation_ref` (the reset reference the resolver confirms for that
//   episode). Two proofs that resolve to the same episode / group / reset
//   reference are ONE proof, however they are labelled. Distinct replay
//   hashes are NOT required: two legal re-executions may produce the SAME
//   content hash, and forcing hash differences would fabricate support.
//
// `when` is the INTERSECTION of predicates that the resolver verifies as
// holding in EVERY supporting episode. A predicate seen in only some episodes
// is not a common precondition: it is dropped from the rule (and, if the
// episodes disagree on the observable value of a shared predicate, the whole
// compilation stays a candidate).
//
// `expect` (postconditions) is required and taken from the resolved, verified
// Outcomes — it is never caller-invented. `provenance`, `revision`,
// `created_at`, `updated_at` and the full `support` block follow
// docs/MEMORY_SCHEMA.md §6.2.

import { digest, readJson, stable } from "../shared/contracts.mjs";

export const COMPILER_VERSION = "2.0.0";
export const EXPERIENCE_SCHEMA_VERSION = "1.0";

const WILDCARDS = new Set(["*", "any", "all", "unknown", "null", ""]);
function normalize(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : value;
}
function isWildcard(value) {
	if (value === null || value === undefined) return true;
	return WILDCARDS.has(normalize(value));
}

function doIdentity(doSpec) {
	const spec = doSpec || {};
	return stable({
		action_ref: spec.action_ref ?? spec.tool ?? null,
		action_version: spec.action_version ?? null,
		arguments_template: spec.arguments_template ?? null,
		output: spec.output ?? null,
	});
}

function scopeChecks(scope, environment) {
	const checks = [];
	if (!scope || typeof scope !== "object") return { ok: false, checks: [{ name: "scope_present", ok: false, expected: "scope", actual: null }] };
	const push = (name, expected, actual) => {
		let ok;
		if (Array.isArray(expected)) ok = Array.isArray(actual) && expected.every((value) => actual.includes(value));
		else ok = expected === actual;
		checks.push({ name, ok, expected, actual });
	};
	push("environment_fingerprint", scope.environment_fingerprint, environment.environment_fingerprint);
	push("domain", scope.domain, environment.domain);
	push("permissions", scope.permissions, environment.permissions);
	push("task_types", scope.task_types, environment.task_types);
	return { ok: checks.every((check) => check.ok), checks };
}

/**
 * Identity of ONE proof in four REAL record dimensions. Returns an OBJECT (the
 * previous implementation returned a `stable()` string and then iterated its
 * Object.entries — so every field check silently passed; audit).
 */
function proofIdentity(record) {
	return {
		run_id: record.run_id ?? null,
		episode_id: record.episode_id ?? null,
		independence_group: record.independence_group ?? null,
		isolation_ref: record.isolation_ref ?? null,
	};
}

function refKey(ref) {
	if (!ref || typeof ref !== "object") return null;
	return `${ref.ref_type ?? ref.type ?? ""}:${ref.ref_id ?? ref.id ?? ""}`;
}

/**
 * Resolve ONE support reference to a REAL record through the trusted resolver.
 *
 * The resolver is the ONLY source of truth. A bare `{ref_type, digest}` string
 * is never accepted: the resolver must return `{ok:true, record}` describing the
 * actual Outcome / Episode / action execution / artifact, and when the ref
 * carries a digest the resolver's `content_digest` must match it.
 *
 * @returns {{ok:boolean, record?:object, reason?:string}}
 */
function resolveSupport(resolver, kind, ref) {
	if (typeof resolver !== "function") return { ok: false, reason: "no trusted resolver supplied" };
	let resolved;
	try {
		resolved = resolver({ kind, ref, ref_key: refKey(ref) });
	} catch (error) {
		return { ok: false, reason: `resolver threw: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!resolved || resolved.ok !== true) return { ok: false, reason: resolved?.reason ?? "resolver did not confirm the record" };
	if (!resolved.record || typeof resolved.record !== "object") return { ok: false, reason: "resolver returned no record" };
	if (ref && typeof ref.digest === "string" && ref.digest) {
		if (typeof resolved.content_digest !== "string" || resolved.content_digest !== ref.digest) {
			return { ok: false, reason: "resolver content_digest does not match the ref digest" };
		}
	}
	return { ok: true, record: resolved.record };
}

/**
 * Require a resolver-provided boolean field to be the literal `true`.
 * Used for isolated-replay proof so a producer's own flag can never stand in.
 */
function resolverBoolean(value, name) {
	return typeof value === "boolean" ? value : null;
}

function outcomeStatus(outcome) {
	return outcome?.status ?? null;
}

/**
 * @param {object} input
 * @param {object[]} input.proofs proof descriptors: `{ episode_id, outcome_id,
 *   when?, do?, scope? }` (the resolver supplies the real records)
 * @param {object} input.environment `{environment_fingerprint, domain, permissions, task_types, registry}`
 * @param {(query:{kind:string, ref:object, ref_key:string|null})=>{ok:boolean, record?:object, content_digest?:string, reason?:string}} input.resolveSupport
 *   trusted resolver for REAL records (outcome/episode/action/artifact/replay)
 * @param {object[]} [input.existingExperiences]
 * @param {object} [input.supersededOutcomeIds] outcome ids already superseded in
 *   the current effective view; these must not be counted or reused
 * @param {object} [input.supersedes] `{superseding_outcome_id, superseded_outcome_id|superseded_experience_id}`
 * @param {string} [input.experienceId]
 * @param {number} [input.revision]
 * @param {string} [input.createdAt]
 * @param {string} [input.updatedAt]
 */
export function compileExperience({
	proofs = [],
	environment = {},
	existingExperiences = [],
	resolveSupport = null,
	supersededOutcomeIds = [],
	supersedes = null,
	experienceId = null,
	revision = 1,
	createdAt = null,
	updatedAt = null,
} = {}) {
	const failures = [];
	const resolver = typeof resolveSupport === "function" ? resolveSupport : typeof environment.resolveSupport === "function" ? environment.resolveSupport : null;
	const supersededSet = new Set(Array.isArray(supersededOutcomeIds) ? supersededOutcomeIds.filter((id) => typeof id === "string" && id) : []);

	// --- Resolve every proof to its REAL Outcome / Episode / action records ----
	const records = [];
	for (const [index, proof] of proofs.entries()) {
		const outcomeRef = { ref_type: "outcome", ref_id: proof.outcome_id ?? proof.outcome?.outcome_id ?? null };
		if (!outcomeRef.ref_id) {
			failures.push({ rule: "proof_resolvable", detail: `proof ${index} has no outcome_id to resolve` });
			continue;
		}
		if (supersededSet.has(outcomeRef.ref_id)) {
			failures.push({ rule: "superseded_not_counted", detail: `proof ${index} outcome ${outcomeRef.ref_id} was superseded in the current effective view` });
			continue;
		}
		const outcomeRes = resolveSupportFor(resolver, "outcome", outcomeRef);
		if (!outcomeRes.ok) {
			failures.push({ rule: "proof_resolvable", detail: `proof ${index} outcome ${outcomeRef.ref_id} did not resolve: ${outcomeRes.reason}` });
			continue;
		}
		const outcome = outcomeRes.record;
		// The resolved Outcome is the authority for episode/status/evidence — the
		// caller-supplied descriptor cannot override it.
		const episodeId = outcome.episode_id ?? proof.episode_id ?? null;
		const episodeRes = episodeId ? resolveSupportFor(resolver, "episode", { ref_type: "episode", ref_id: episodeId }) : { ok: false, reason: "no episode id" };
		if (!episodeRes.ok) {
			failures.push({ rule: "episode_resolvable", detail: `proof ${index} episode ${episodeId ?? "(none)"} did not resolve: ${episodeRes.reason}` });
			continue;
		}
		const episode = episodeRes.record;

		const doSpec = proof.do ?? proof.action ?? null;
		const actionRefId = doSpec?.action_ref ?? outcome.action_ref ?? null;
		const actionRes = actionRefId || doSpec?.action_version ? resolveSupportFor(resolver, "action", { ref_type: "action", ref_id: actionRefId, version: doSpec?.action_version ?? null }) : { ok: false, reason: "no action ref" };

		// Every evidence ref must resolve to a REAL record and match its digest.
		const evidenceRefs = Array.isArray(outcome.evidence_refs) ? outcome.evidence_refs : Array.isArray(proof.evidence_refs) ? proof.evidence_refs : [];
		const resolvedRefs = [];
		for (const ref of evidenceRefs) {
			const refRes = resolveSupportFor(resolver, ref?.ref_type ?? ref?.type ?? "artifact", ref);
			if (!refRes.ok) failures.push({ rule: "evidence_refs", detail: `proof ${index} evidence ref ${refKey(ref)} did not resolve: ${refRes.reason}` });
			else resolvedRefs.push({ ref, record: refRes.record });
		}

		records.push({
			index,
			proof,
			outcome,
			episode,
			action: actionRes.ok ? actionRes.record : null,
			action_resolved: actionRes.ok,
			do: doSpec,
			do_identity: doSpec ? doIdentity(doSpec) : null,
			status: outcomeStatus(outcome),
			run_id: outcome.run_id ?? episode.run_id ?? null,
			episode_id: episodeId,
			independence_group: outcome.oracle?.independence_group ?? proof.independence_group ?? episode.independence_group ?? null,
			isolation_ref: outcome.oracle?.isolation_ref ?? episode.isolation_ref ?? proof.isolation_ref ?? null,
			evidence_refs: evidenceRefs,
			resolved_evidence: resolvedRefs,
			oracle: outcome.oracle ?? null,
		});
	}

	// --- Rule 1: at least two resolved proofs ---------------------------------
	if (records.length < 2) failures.push({ rule: "min_proofs", detail: `need >= 2 resolvable proofs, got ${records.length}` });

	// --- Rule 2: every proof is a SUCCESS with a full, verified Outcome -------
	for (const record of records) {
		if (record.status !== "success") failures.push({ rule: "proof_success", detail: `proof ${record.index} (${record.episode_id ?? "no episode"}) status is ${record.status}` });
		// A success must carry a non-null observed value and an oracle method.
		if (record.status === "success" && (record.outcome.observed === null || record.outcome.observed === undefined)) {
			failures.push({ rule: "proof_observed", detail: `proof ${record.index} success has no observed value` });
		}
		if (!record.oracle || !(record.oracle.oracle_id || record.oracle.method)) failures.push({ rule: "proof_oracle", detail: `proof ${record.index} has no oracle identity` });
		if (!record.outcome.criterion || typeof record.outcome.criterion !== "object") failures.push({ rule: "proof_criterion", detail: `proof ${record.index} has no criterion` });
		// Preconditions must be verified for the rule to be a positive rule.
		if (record.outcome.preconditions_verified !== true) failures.push({ rule: "proof_preconditions", detail: `proof ${record.index} does not assert verified preconditions` });
	}

	// --- Rule 3: the resolved action matches the pinned contract --------------
	let contract = null;
	const first = records[0] ?? null;
	if (first) {
		const doSpec = first.do ?? { action_ref: first.outcome.action_ref, action_version: first.outcome.action_version, implementation_digest: first.outcome.implementation_digest };
		if (!doSpec?.action_ref) failures.push({ rule: "action_registered", detail: "proofs do not identify an action_ref" });
		else if (!(environment.registry && typeof environment.registry.get === "function" && environment.registry.get(doSpec.action_ref))) failures.push({ rule: "action_registered", detail: `action ${doSpec.action_ref} is not registered` });
		else contract = environment.registry.get(doSpec.action_ref);
		if (contract) {
			if (doSpec.action_version === undefined || doSpec.action_version === null) failures.push({ rule: "action_version", detail: "proofs do not pin action_version" });
			else if (doSpec.action_version !== contract.version) failures.push({ rule: "action_version", detail: `proof action version ${doSpec.action_version} != registered ${contract.version}` });
			if (typeof doSpec.implementation_digest !== "string" || doSpec.implementation_digest.length === 0) failures.push({ rule: "implementation_digest", detail: "proofs do not pin implementation_digest" });
			else if (doSpec.implementation_digest !== contract.implementation_digest) failures.push({ rule: "implementation_digest", detail: "proof implementation digest does not match the registered implementation" });
			// The resolved action execution must confirm the SAME version+args.
			if (!first.action_resolved) failures.push({ rule: "action_resolution", detail: "the action execution for the first proof could not be resolved to a real record" });
			else if (first.action && (first.action.version ?? null) !== (doSpec.action_version ?? null)) failures.push({ rule: "action_resolution", detail: "the resolved action version does not match the pinned action_version" });
		}
	}

	// --- Rule 4: same action / arguments template across all proofs -----------
	const doIdentities = new Set(records.map((record) => record.do_identity).filter(Boolean));
	if (doIdentities.size > 1) failures.push({ rule: "same_action", detail: "proofs disagree on action/arguments template (possible argument swap)" });

	// --- Rule 5: independence from REAL episode identity + reset refs ---------
	for (const record of records) {
		const identity = proofIdentity(record);
		for (const [field, value] of Object.entries(identity)) {
			if (value === null || value === undefined || value === "") failures.push({ rule: "independent_identity", detail: `proof ${record.index} resolved without a ${field}` });
		}
	}
	const identityKeys = new Map();
	for (const record of records) {
		const signature = stable(proofIdentity(record));
		if (identityKeys.has(signature)) failures.push({ rule: "independence", detail: `proofs ${identityKeys.get(signature)} and ${record.index} resolve to the same episode/group/isolation reference` });
		else identityKeys.set(signature, record.index);
	}
	const distinctEpisodes = new Set(records.map((record) => record.episode_id).filter(Boolean));
	const distinctGroups = new Set(records.map((record) => record.independence_group).filter(Boolean));
	const distinctIsolation = new Set(records.map((record) => record.isolation_ref).filter(Boolean));
	if (distinctEpisodes.size < 2) failures.push({ rule: "independence", detail: `need >= 2 distinct resolved episode_id, got ${distinctEpisodes.size}` });
	if (distinctGroups.size < 2) failures.push({ rule: "independence", detail: `need >= 2 distinct resolved independence_group, got ${distinctGroups.size}` });
	if (distinctIsolation.size < 2) failures.push({ rule: "independence", detail: `need >= 2 distinct resolved isolation_ref (episode reset reference), got ${distinctIsolation.size}` });

	// --- Rule 5b: no proof copies an already-active do-clause -----------------
	const activeIdentities = new Set();
	for (const experience of existingExperiences) {
		if (experience.status === "active") activeIdentities.add(doIdentity(experience.do));
	}
	for (const record of records) {
		if (record.do_identity && activeIdentities.has(record.do_identity)) {
			failures.push({ rule: "not_copied", detail: `proof ${record.index} duplicates an already-active do-clause and adds no independence` });
		}
	}

	// --- Rule 6: isolated replay proof, resolved by the trusted resolver ------
	// A replayable claim must come from a REAL replay record resolved for this
	// episode, marked replayable, with a performed replay_count >= 1 and a
	// replay_hash. The resolver confirms it; a producer's own flag is data, not
	// proof. Hashes are NOT required to be distinct.
	const hashes = new Set();
	for (const record of records) {
		const replayRef = { ref_type: "replay", ref_id: `replay:${record.episode_id}:${record.proof.outcome_id ?? record.outcome.outcome_id}` };
		const replayRes = resolveSupportFor(resolver, "replay", replayRef);
		if (!replayRes.ok) {
			failures.push({ rule: "replay_proof", detail: `proof ${record.index} has no resolved isolated-replay record: ${replayRes.reason}` });
			continue;
		}
		const replay = replayRes.record;
		if (resolverBoolean(replay.replayable, "replayable") !== true) failures.push({ rule: "replay_proof", detail: `proof ${record.index} resolved replay is not replayable` });
		if (!(Number.isInteger(replay.replay_count) && replay.replay_count >= 1)) failures.push({ rule: "replay_proof", detail: `proof ${record.index} resolved replay_count < 1 (no replay performed)` });
		if (typeof replay.replay_hash !== "string" || replay.replay_hash.length === 0) failures.push({ rule: "replay_proof", detail: `proof ${record.index} resolved replay has no replay_hash` });
		if (replay.episode_id && record.episode_id && replay.episode_id !== record.episode_id) failures.push({ rule: "replay_proof", detail: `proof ${record.index} replay belongs to episode ${replay.episode_id}, not ${record.episode_id}` });
		if (typeof replay.replay_hash === "string" && replay.replay_hash) hashes.add(replay.replay_hash);
	}

	// --- Rule 7: every evidence ref resolved (already checked above) ----------
	if (typeof resolver !== "function") failures.push({ rule: "evidence_resolver", detail: "no trusted support resolver was supplied; real records cannot be confirmed" });
	for (const record of records) {
		if (record.evidence_refs.length === 0) failures.push({ rule: "evidence_refs", detail: `proof ${record.index} has no evidence_refs` });
	}

	// --- Rule 8: current-environment scope -----------------------------------
	let scopeResult = { ok: false, checks: [] };
	const scope = first?.do ? first.proof.scope ?? first.outcome.scope ?? first.episode.scope : first?.outcome.scope ?? first?.episode.scope;
	if (scope) scopeResult = scopeChecks(scope, environment);
	else failures.push({ rule: "scope_present", detail: "proofs carry no scope to compare with the current environment" });
	if (scopeResult.checks.length > 0 && !scopeResult.ok) failures.push({ rule: "scope_current", detail: `proof scope does not match the current environment: ${scopeResult.checks.filter((check) => !check.ok).map((check) => check.name).join(", ")}` });

	// --- Rule 9: `when` must hold in EVERY supporting episode -----------------
	// Compute the intersection. A predicate that is verified in some proofs but
	// not all is NOT a common precondition and is dropped. If two episodes
	// disagree on the observable VALUE of a shared predicate, the rule is not
	// stable -> candidate.
	const whenPerProof = records.map((record) => {
		const when = record.proof.when ?? record.outcome.when ?? [];
		if (!Array.isArray(when) || when.length === 0) return null;
		const map = new Map();
		for (const predicate of when) {
			if (!predicate || typeof predicate.path !== "string" || !predicate.op) return "malformed";
			if (!Array.isArray(predicate.verified_by) || predicate.verified_by.length === 0) return "unverified";
			if (predicate.op !== "exists" && isWildcard(predicate.value)) return "wildcard";
			const signature = stable({ path: predicate.path, op: predicate.op });
			const value = predicate.op === "exists" ? null : predicate.value;
			if (map.has(signature) && map.get(signature).value !== stable(value)) return "value_disagreement";
			map.set(signature, { predicate, value: stable(value) });
		}
		return map;
	});
	if (whenPerProof.some((entry) => entry === null)) failures.push({ rule: "when_present", detail: "one or more proofs carry no when predicates" });
	if (whenPerProof.some((entry) => entry === "malformed")) failures.push({ rule: "when_shape", detail: "a when predicate is malformed" });
	if (whenPerProof.some((entry) => entry === "unverified")) failures.push({ rule: "when_verified", detail: "a when predicate is not verified by any ref" });
	if (whenPerProof.some((entry) => entry === "wildcard")) failures.push({ rule: "when_not_wildcard", detail: "a when predicate has a wildcard/unset value" });
	if (whenPerProof.some((entry) => entry === "value_disagreement")) failures.push({ rule: "when_consistent", detail: "supporting episodes disagree on the value of a shared when predicate" });
	const maps = whenPerProof.filter((entry) => entry instanceof Map);
	let whenIntersection = [];
	if (maps.length === records.length && maps.length > 0) {
		const [head, ...rest] = maps;
		for (const [signature, entry] of head) {
			if (rest.every((map) => map.has(signature) && map.get(signature).value === entry.value)) whenIntersection.push(entry.predicate);
		}
		// A predicate present in only SOME episodes is not a common precondition:
		// drop it, and record which predicates were dropped so the gap is visible.
		for (const map of maps) {
			for (const [signature, entry] of map) {
				if (!whenIntersection.some((predicate) => stable({ path: predicate.path, op: predicate.op }) === signature)) {
					failures.push({ rule: "when_not_common", detail: `predicate ${entry.predicate.path} does not hold in every supporting episode and was dropped` });
					break;
				}
			}
		}
	}
	if (whenIntersection.length === 0 && records.length > 0) failures.push({ rule: "when_present", detail: "no when predicate holds in every supporting episode" });

	// --- Rule 9b: `expect` postconditions from the resolved Outcomes ----------
	// Every proof's outcome must carry a verified expectation; the rule's expect
	// is the shared postcondition set. It is never caller-invented.
	const expectPerProof = records.map((record) => {
		const expect = record.outcome.expect ?? record.outcome.expected ?? record.proof.expect ?? null;
		if (!Array.isArray(expect) || expect.length === 0) return null;
		for (const predicate of expect) {
			if (!predicate || typeof predicate.path !== "string" || !predicate.op) return "malformed";
			if (predicate.op !== "exists" && isWildcard(predicate.value)) return "wildcard";
		}
		return expect.map((predicate) => stable({ path: predicate.path, op: predicate.op, value: predicate.op === "exists" ? null : predicate.value }));
	});
	if (expectPerProof.some((entry) => entry === null)) failures.push({ rule: "expect_present", detail: "one or more proofs carry no verified expect postconditions" });
	if (expectPerProof.some((entry) => entry === "malformed")) failures.push({ rule: "expect_shape", detail: "an expect predicate is malformed" });
	if (expectPerProof.some((entry) => entry === "wildcard")) failures.push({ rule: "expect_not_wildcard", detail: "an expect predicate has a wildcard/unset value" });
	const expectSets = expectPerProof.filter((entry) => Array.isArray(entry));
	let expect = [];
	if (expectSets.length === records.length && expectSets.length > 0) {
		expect = records[0].outcome.expect ?? records[0].outcome.expected ?? records[0].proof.expect ?? [];
		for (const set of expectSets) {
			if (stable(set) !== stable(expectSets[0])) {
				failures.push({ rule: "expect_consistent", detail: "supporting episodes disagree on the expected postcondition" });
				break;
			}
		}
	}

	// --- Rule 10: supersedes handling ----------------------------------------
	let superseded = null;
	if (supersedes && typeof supersedes === "object") {
		const supersedingId = supersedes.superseding_outcome_id ?? null;
		if (!supersedingId || !records.some((record) => (record.outcome.outcome_id ?? null) === supersedingId)) {
			failures.push({ rule: "supersedes", detail: "declared superseding proof is not among the resolved proofs" });
		}
		superseded = supersedes.superseded_outcome_id ?? supersedes.superseded_experience_id ?? null;
	}

	// --- Assemble the full Experience (MEMORY_SCHEMA §6.2) --------------------
	const ok = failures.length === 0 && records.length >= 2;
	const successOutcomeIds = records.filter((record) => record.status === "success").map((record) => record.outcome.outcome_id).filter(Boolean);
	const failureOutcomeIds = records.filter((record) => record.status === "failure").map((record) => record.outcome.outcome_id).filter(Boolean);
	const unknownOutcomeIds = records.filter((record) => record.status === "unknown").map((record) => record.outcome.outcome_id).filter(Boolean);
	const now = new Date().toISOString();
	const doSpec = first?.do ?? (first ? { action_ref: first.outcome.action_ref, action_version: first.outcome.action_version, implementation_digest: first.outcome.implementation_digest, arguments_template: first.proof.arguments_template ?? null } : null);
	const experience = {
		schema_version: EXPERIENCE_SCHEMA_VERSION,
		experience_id: experienceId ?? `exp_${digest(stable({ do: first?.do_identity ?? null, when: whenIntersection, env: environment.environment_fingerprint ?? null })).slice("sha256:".length, "sha256:".length + 16)}`,
		status: ok ? "active" : "candidate",
		when: whenIntersection,
		do: doSpec,
		expect,
		scope: scope ?? {},
		support: {
			success_outcome_ids: successOutcomeIds,
			failure_outcome_ids: failureOutcomeIds,
			unknown_outcome_ids: unknownOutcomeIds,
			independent_episode_count: distinctEpisodes.size,
			success_count: successOutcomeIds.length,
			failure_count: failureOutcomeIds.length,
			unknown_count: unknownOutcomeIds.length,
			episode_ids: [...distinctEpisodes],
			independence_groups: [...distinctGroups],
			isolation_refs: [...distinctIsolation],
			replay_hashes: [...hashes],
		},
		provenance: {
			compiled_by: "aegis-experience-compiler",
			compiler_version: COMPILER_VERSION,
			source_kind: first?.episode?.source_kind ?? first?.outcome?.source_kind ?? "live",
			source_outcome_ids: records.map((record) => record.outcome.outcome_id).filter(Boolean),
			source_episode_ids: [...distinctEpisodes],
			compiled_at: now,
		},
		validation: {
			failures,
			superseded,
			superseded_outcome_ids: [...supersededSet],
			evidence_resolved: true,
			resolver: typeof resolver === "function" ? "trusted" : "absent",
		},
		revision,
		created_at: createdAt ?? now,
		updated_at: updatedAt ?? now,
		failure_rules: [...new Set(failures.map((failure) => failure.rule))],
	};
	return { status: ok ? "active" : "candidate", ok, experience, failures };
}

function resolveSupportFor(resolver, kind, ref) {
	return resolveSupport(resolver, kind, ref);
}

/** Convenience: load proof descriptors from a JSONL/JSON file and compile. */
export function compileFromFile({ path, environment, existingExperiences = [], resolveSupport = null, supersededOutcomeIds = [], supersedes = null, experienceId = null, revision = 1, createdAt = null, updatedAt = null }) {
	const records = readJson(path);
	const proofs = Array.isArray(records) ? records : records.proofs ?? [];
	return compileExperience({ proofs, environment, existingExperiences, resolveSupport, supersededOutcomeIds, supersedes, experienceId, revision, createdAt, updatedAt });
}
