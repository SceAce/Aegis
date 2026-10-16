#!/usr/bin/env node
// Batch B2 focused evidence-discipline smoke test.
//
// Scope: the DEFAULTED learning/evidence path only —
//   memory/experience-compiler.mjs
//   memory/contribution.mjs
//   memory/learning-router.mjs
//
// Every test here is a MEANINGFUL NEGATIVE test for a specific way the earlier
// Batch B implementation could be fooled into claiming verified evidence it did
// not have:
//   1. proofKey() returned a `stable()` string, so the per-field identity check
//      iterated a string's Object.entries and passed vacuously;
//   2. a digest-only artifact ref was accepted without resolving real content;
//   3. `replayable:true` + non-empty `replay_hash` + `replay_count:1` supplied by
//      the same producer was treated as an isolated replay proof;
//   4. the rule `when` was the UNION of predicates across episodes — a world
//      that never held simultaneously;
//   5. same replay content hash was treated as non-independent (the inverse
//      error: forcing hash differences fabricates support);
//   6. a superseded Outcome was still counted as support;
//   7. contribution accepted `data_obtained:true` and any `status:"success"`
//      outcome with a matching-typed ref, without resolving real records;
//   8. the Router trusted `success_ids.length` + a `verified_by` string array
//      instead of resolved support.
//
// Offline by construction: no network, no provider, no shell, no temp files
// beyond `os.tmpdir()` if needed. Assertions read returned records, never a
// self-reported status string alone.

import assert from "node:assert/strict";
import { digest, sha256Hex } from "../shared/contracts.mjs";
import { compileExperience, COMPILER_VERSION, EXPERIENCE_SCHEMA_VERSION } from "../memory/experience-compiler.mjs";
import { recordStageContribution, dataUsefulness } from "../memory/contribution.mjs";
import { routeLearning } from "../memory/learning-router.mjs";

const failures = [];
function test(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures.push({ name, error });
		console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SCOPE = Object.freeze({
	environment_fingerprint: "local",
	domain: "demo",
	permissions: ["read-only-observation"],
	task_types: ["identify"],
});

const CONTRACT = Object.freeze({ id: "demo.ping", version: 1, implementation_digest: "sha256:impl", tool: "demo", parameters: { target: { type: "string", required: true } } });
function registry() {
	return { get: (id) => (id === CONTRACT.id ? CONTRACT : null) };
}
function compileEnv(over = {}) {
	return { ...SCOPE, registry: registry(), ...over };
}
const DO_SPEC = Object.freeze({ action_ref: CONTRACT.id, action_version: CONTRACT.version, implementation_digest: CONTRACT.implementation_digest, arguments_template: { target: null } });

/**
 * Build a full set of REAL records for one episode and return a resolver over
 * them. `over` lets a test tamper with exactly one record to prove the check.
 */
function episode({ id, group, isolation, status = "success", replayable = true, replayCount = 2, replayHash = "h", preconditions = true, oracle = true, evidence = null } = {}) {
	const outcomeId = `out_${id}`;
	const refs = evidence ?? [{ ref_type: "artifact", ref_id: `body_${id}`, digest: digest(`body_${id}`) }];
	const records = {
		episode: { episode_id: id, independence_group: group, isolation_ref: isolation, run_id: group, source_kind: "live", scope: SCOPE },
		outcome: {
			outcome_id: outcomeId,
			episode_id: id,
			status,
			observed: status === "success" ? { ok: true } : null,
			preconditions_verified: preconditions,
			criterion: { criterion_id: "demo.criterion", expected: { pong: true } },
			expect: [{ path: "pong", op: "eq", value: true }],
			evidence_refs: refs,
			...(oracle ? { oracle: { oracle_id: "demo-oracle", method: "post_check", independence_group: group, isolation_ref: isolation } } : {}),
		},
		replay: { replayable, replay_count: replayCount, replay_hash: replayHash, episode_id: id, isolation_ref: isolation },
		action: { action_ref: CONTRACT.id, version: CONTRACT.version, status: "completed", episode_id: id },
	};
	records.resolve = ({ kind, ref }) => {
		if (kind === "outcome" && ref.ref_id === outcomeId) return { ok: true, record: records.outcome };
		if (kind === "episode" && ref.ref_id === id) return { ok: true, record: records.episode };
		if (kind === "replay" && ref.ref_id === `replay:${id}:${outcomeId}`) return { ok: true, record: records.replay };
		if (kind === "action" && ref.ref_id === CONTRACT.id) return { ok: true, record: records.action };
		if (kind === "artifact") {
			const match = refs.find((candidate) => candidate.ref_id === ref.ref_id);
			if (match) return { ok: true, record: { ref: ref.ref_id }, content_digest: match.digest };
		}
		return { ok: false, reason: `no ${kind} record for ${ref.ref_id}` };
	};
	return records;
}

function resolverFor(...episodes) {
	return (query) => {
		for (const episodeRecords of episodes) {
			const result = episodeRecords.resolve(query);
			if (result.ok) return result;
		}
		return { ok: false, reason: `no record for ${query.kind}:${query.ref.ref_id}` };
	};
}

function proofFor(episodeRecords, { when = [{ path: "ready", op: "eq", value: true, verified_by: ["ref"] }], do: doSpec = DO_SPEC, scope = SCOPE } = {}) {
	return { outcome_id: episodeRecords.outcome.outcome_id, when, do: doSpec, scope };
}

// ---------------------------------------------------------------------------
// 1. Compiler: proofKey field validation (the string/Object.entries bug)
// ---------------------------------------------------------------------------

test("compiler does not vacuously pass the identity field check (proofKey must be structured)", () => {
	// Two DIFFERENT episodes so identity passes; the point is that a resolved
	// record missing an identity field must still FAIL, which the old string-based
	// proofKey could not detect.
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	// Tamper: the second episode has NO isolation_ref, so independence is not provable.
	b.episode.isolation_ref = null;
	b.outcome.oracle.isolation_ref = null;
	const result = compileExperience({ proofs: [proofFor(a), proofFor(b)], environment: compileEnv(), resolveSupport: resolverFor(a, b) });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("independent_identity"), JSON.stringify(result.failures));
});

// ---------------------------------------------------------------------------
// 2. Compiler: digest-only artifact is not evidence
// ---------------------------------------------------------------------------

test("compiler refuses a digest-only artifact that no resolver can confirm", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	const fake = { ref_type: "artifact", ref_id: "not_in_any_store", digest: digest("whatever") };
	a.outcome.evidence_refs = [fake];
	b.outcome.evidence_refs = [fake];
	// The stores above no longer carry `fake`, so the resolver refuses it while
	// still resolving the real outcome/episode/replay records.
	const result = compileExperience({ proofs: [proofFor(a), proofFor(b)], environment: compileEnv(), resolveSupport: resolverFor(a, b) });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("evidence_refs"));
});

test("compiler refuses an artifact whose resolver content digest does not match the ref", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	const liar = ({ kind, ref }) => (kind === "artifact" ? { ok: true, record: {}, content_digest: digest("tampered") } : resolverFor(a, b)({ kind, ref }));
	const result = compileExperience({ proofs: [proofFor(a), proofFor(b)], environment: compileEnv(), resolveSupport: liar });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("evidence_refs"));
});

// ---------------------------------------------------------------------------
// 3. Compiler: a producer's replayable/hash/count claim is not proof
// ---------------------------------------------------------------------------

test("compiler refuses when no isolated replay record resolves, even if the outcome claims replayable", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	// Resolver that resolves outcomes/episodes/artifacts but NOT replays.
	const noReplay = ({ kind, ref }) => (kind === "replay" ? { ok: false, reason: "no replay record" } : resolverFor(a, b)({ kind, ref }));
	const result = compileExperience({ proofs: [proofFor(a), proofFor(b)], environment: compileEnv(), resolveSupport: noReplay });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("replay_proof"));
});

test("compiler refuses a resolved replay with replay_count 0", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a", replayCount: 0 });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	const result = compileExperience({ proofs: [proofFor(a), proofFor(b)], environment: compileEnv(), resolveSupport: resolverFor(a, b) });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("replay_proof"));
});

// ---------------------------------------------------------------------------
// 4. Compiler: same replay hash is legal; distinct isolation refs are the proof
// ---------------------------------------------------------------------------

test("compiler activates with IDENTICAL replay hashes (independence is episode reset refs, not hashes)", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a", replayHash: "identical" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b", replayHash: "identical" });
	const result = compileExperience({ proofs: [proofFor(a), proofFor(b)], environment: compileEnv(), resolveSupport: resolverFor(a, b) });
	assert.equal(result.status, "active", JSON.stringify(result.failures));
	assert.deepEqual(result.experience.support.replay_hashes, ["identical"]);
});

test("compiler refuses two proofs that resolve to the SAME episode/isolation reset reference", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_same" });
	// A second outcome inside the SAME episode/isolation: not an independent proof.
	const a2 = episode({ id: "ep_a", group: "grp_a", isolation: "iso_same" });
	a2.outcome.outcome_id = "out_ep_a_2";
	const result = compileExperience({ proofs: [proofFor(a), proofFor(a2)], environment: compileEnv(), resolveSupport: resolverFor(a, a2) });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("independence"));
});

// ---------------------------------------------------------------------------
// 5. Compiler: `when` is an intersection, never a union (no fictitious world)
// ---------------------------------------------------------------------------

test("compiler refuses a when-union that never held in one episode", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	const whenA = [{ path: "ready", op: "eq", value: true, verified_by: ["a"] }];
	const whenB = [{ path: "armed", op: "eq", value: true, verified_by: ["b"] }];
	const result = compileExperience({ proofs: [proofFor(a, { when: whenA }), proofFor(b, { when: whenB })], environment: compileEnv(), resolveSupport: resolverFor(a, b) });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("when_not_common"));
	assert.deepEqual(result.experience.when, []);
});

test("compiler keeps only the predicates that hold in EVERY episode", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	const common = { path: "ready", op: "eq", value: true, verified_by: ["ref"] };
	const whenA = [common, { path: "extra_a", op: "eq", value: 1, verified_by: ["a"] }];
	const whenB = [common];
	const result = compileExperience({ proofs: [proofFor(a, { when: whenA }), proofFor(b, { when: whenB })], environment: compileEnv(), resolveSupport: resolverFor(a, b) });
	assert.equal(result.status, "candidate", "a dropped predicate is a visible gap, not a silent activation");
	assert.ok(result.experience.failure_rules.includes("when_not_common"));
	assert.deepEqual(result.experience.when.map((predicate) => predicate.path), ["ready"]);
});

test("compiler refuses when supporting episodes disagree on a shared predicate value", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	const whenA = [{ path: "ready", op: "eq", value: true, verified_by: ["a"] }];
	const whenB = [{ path: "ready", op: "eq", value: false, verified_by: ["b"] }];
	const result = compileExperience({ proofs: [proofFor(a, { when: whenA }), proofFor(b, { when: whenB })], environment: compileEnv(), resolveSupport: resolverFor(a, b) });
	// The shared predicate is not true in EVERY episode, so it is dropped (never
	// silently unioned into a world that never held) and the rule stays candidate.
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("when_not_common"));
	assert.deepEqual(result.experience.when, []);
});

// ---------------------------------------------------------------------------
// 6. Compiler: full Experience shape + superseded outcomes
// ---------------------------------------------------------------------------

test("compiler emits the full MEMORY_SCHEMA Experience shape when active", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	const result = compileExperience({ proofs: [proofFor(a), proofFor(b)], environment: compileEnv(), resolveSupport: resolverFor(a, b) });
	assert.equal(result.status, "active", JSON.stringify(result.failures));
	const experience = result.experience;
	assert.equal(experience.schema_version, EXPERIENCE_SCHEMA_VERSION);
	assert.equal(experience.status, "active");
	assert.ok(Array.isArray(experience.when) && experience.when.length > 0);
	assert.ok(Array.isArray(experience.expect) && experience.expect.length > 0, "expect is required");
	assert.equal(experience.provenance.compiled_by, "aegis-experience-compiler");
	assert.equal(experience.provenance.compiler_version, COMPILER_VERSION);
	assert.equal(experience.revision, 1);
	assert.equal(typeof experience.created_at, "string");
	assert.equal(typeof experience.updated_at, "string");
	assert.equal(experience.support.independent_episode_count, 2);
});

test("compiler will not count an outcome that was superseded in the effective view", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	const result = compileExperience({ proofs: [proofFor(a), proofFor(b)], environment: compileEnv(), resolveSupport: resolverFor(a, b), supersededOutcomeIds: [b.outcome.outcome_id] });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("superseded_not_counted"));
});

test("compiler counts no proof twice across a corrected outcome", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	// The superseding outcome is not among the proofs (it was replaced elsewhere).
	const result = compileExperience({
		proofs: [proofFor(a), proofFor(b)],
		environment: compileEnv(),
		resolveSupport: resolverFor(a, b),
		supersedes: { superseding_outcome_id: "out_not_supplied", superseded_experience_id: "exp_old" },
	});
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("supersedes"));
});

// ---------------------------------------------------------------------------
// 7. Contribution: real records only
// ---------------------------------------------------------------------------

const DATA_REF = { ref_type: "data", ref_id: "dataset_1", digest: digest("rows") };
const ACTION_REF = { ref_type: "action", ref_id: "act_run_1" };

function contributionStore(over = {}) {
	return {
		episode_id: "ep_1",
		data: { dataset_1: { episode_id: "ep_1", digest: digest("rows") } },
		action: { act_run_1: { status: "completed", episode_id: "ep_1", bound_arguments: [DATA_REF] } },
		outcome: { out_1: { outcome_id: "out_1", episode_id: "ep_1", status: "success", oracle: { oracle_id: "demo", method: "post_check" }, evidence_refs: [DATA_REF, ACTION_REF] } },
		...over,
	};
}
function contributionResolver(store) {
	return ({ kind, ref }) => {
		const bucket = kind === "action" ? store.action : kind === "outcome" ? store.outcome : store.data;
		const record = bucket[ref.ref_id];
		if (!record) return { ok: false, reason: `no ${kind}` };
		if (kind === "data") return { ok: true, record, content_digest: record.digest ?? undefined };
		return { ok: true, record };
	};
}
function contributionInput(store, over = {}) {
	return { episode_id: "ep_1", dataRef: DATA_REF, actionRef: ACTION_REF, useRefs: [DATA_REF], stage: "use", resolveSupport: contributionResolver(store), outcome: { outcome_id: "out_1" }, ...over };
}

test("contribution refuses a data_obtained boolean with no resolved data record", () => {
	// No resolver at all: the old code would have accepted `data_obtained:true`.
	const record = recordStageContribution({ episode_id: "ep_1", dataRef: DATA_REF, actionRef: ACTION_REF, stage: "use", data_obtained: true, outcome: { outcome_id: "out_1", status: "success", evidence_refs: [DATA_REF, ACTION_REF] } });
	assert.equal(record.status, "unknown");
	assert.equal(record.stage_useful, false);
});

test("contribution refuses a success outcome that resolves to no real record", () => {
	const store = contributionStore({ outcome: {} });
	const record = recordStageContribution(contributionInput(store));
	assert.equal(record.status, "unknown");
});

test("contribution refuses an action that has not completed", () => {
	const store = contributionStore({ action: { act_run_1: { status: "pending", episode_id: "ep_1", bound_arguments: [DATA_REF] } } });
	const record = recordStageContribution(contributionInput(store));
	assert.equal(record.status, "unknown");
	assert.equal(record.action_completed, false);
});

test("contribution refuses a completed action whose final bound arguments do not bind the data", () => {
	const store = contributionStore({ action: { act_run_1: { status: "completed", episode_id: "ep_1", bound_arguments: [] } } });
	const record = recordStageContribution(contributionInput(store));
	assert.equal(record.status, "unknown");
	assert.equal(record.action_uses_data, false);
});

test("contribution refuses a stage outcome from another episode even with matching refs", () => {
	const store = contributionStore({ outcome: { out_1: { outcome_id: "out_1", episode_id: "ep_other", status: "success", oracle: { oracle_id: "demo", method: "post_check" }, evidence_refs: [DATA_REF, ACTION_REF] } } });
	const record = recordStageContribution(contributionInput(store));
	assert.equal(record.status, "unknown");
});

test("contribution refuses an outcome superseded in the current effective view", () => {
	const record = recordStageContribution(contributionInput(contributionStore(), { supersededOutcomeIds: ["out_1"] }));
	assert.equal(record.status, "unknown");
});

test("contribution records a verified use only with all three real records, and stays association-only", () => {
	const record = recordStageContribution(contributionInput(contributionStore()));
	assert.equal(record.status, "verified_use");
	assert.equal(record.association_only, true);
	assert.equal(record.causal, false);
	assert.equal(record.data_obtained, true);
	assert.equal(record.action_completed, true);
	assert.equal(record.action_uses_data, true);
});

test("contribution stages are independent: obtain does not imply use or advance", () => {
	const store = contributionStore();
	const obtain = recordStageContribution({ ...contributionInput(store, { stage: "obtain", actionRef: null, useRefs: [] }), outcome: { outcome_id: "out_1" } });
	assert.equal(obtain.status, "verified_use", "obtain only needs the data record and a same-episode outcome");
	const usefulness = dataUsefulness([obtain]);
	assert.equal(usefulness.fully_useful, false);
	assert.equal(usefulness.first_gap_stage, "use");
});

// ---------------------------------------------------------------------------
// 8. Router: resolved support, not counts + verified_by strings
// ---------------------------------------------------------------------------

function activeExperience(over = {}) {
	return {
		experience_id: "exp_1",
		status: "active",
		scope: SCOPE,
		when: [{ path: "ready", op: "eq", value: true, verified_by: ["ref"] }],
		do: { action_ref: CONTRACT.id, action_version: CONTRACT.version, implementation_digest: CONTRACT.implementation_digest, arguments_template: { target: null } },
		support: {
			success_outcome_ids: ["out_ep_a", "out_ep_b"],
			episode_ids: ["ep_a", "ep_b"],
			independence_groups: ["grp_a", "grp_b"],
			isolation_refs: ["iso_a", "iso_b"],
			replay_hashes: ["same", "same"],
		},
		...over,
	};
}

function supportStore() {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	// The router resolves support by outcome id `out_ep_a` / `out_ep_b`.
	a.outcome.outcome_id = "out_ep_a";
	b.outcome.outcome_id = "out_ep_b";
	return resolverFor(a, b);
}

test("router goes direct only with a resolver that confirms the claimed support", () => {
	const route = routeLearning({ experiences: [activeExperience()], task: { arguments: { target: "A" } }, environment: compileEnv(), currentState: { ready: true }, registry: registry(), resolveSupport: supportStore() });
	assert.equal(route.route, "direct");
	assert.deepEqual(route.arguments, { target: "A" });
});

test("router does NOT go direct when the claimed support cannot be resolved", () => {
	// No resolver: `success_outcome_ids.length === 2` and a `verified_by` string
	// are exactly the fake signals the old Router trusted.
	const route = routeLearning({ experiences: [activeExperience()], task: { arguments: { target: "A" } }, environment: compileEnv(), currentState: { ready: true }, registry: registry() });
	assert.equal(route.route, "paused");
	const candidate = route.candidates[0];
	assert.equal(candidate.support_resolution.ok, false);
	assert.equal(candidate.support_resolution.resolver, false);
});

test("router pauses when an outcome resolves to a non-success status", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a", status: "unknown" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	a.outcome.outcome_id = "out_ep_a";
	b.outcome.outcome_id = "out_ep_b";
	const route = routeLearning({ experiences: [activeExperience()], task: { arguments: { target: "A" } }, environment: compileEnv(), currentState: { ready: true }, registry: registry(), resolveSupport: resolverFor(a, b) });
	assert.equal(route.route, "paused");
});

test("router does NOT go direct when a support outcome's episode does not resolve", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	a.outcome.outcome_id = "out_ep_a";
	b.outcome.outcome_id = "out_ep_b";
	const noEpisodes = ({ kind, ref }) => (kind === "episode" ? { ok: false, reason: "no episode" } : resolverFor(a, b)({ kind, ref }));
	const route = routeLearning({ experiences: [activeExperience()], task: { arguments: { target: "A" } }, environment: compileEnv(), currentState: { ready: true }, registry: registry(), resolveSupport: noEpisodes });
	assert.notEqual(route.route, "direct");
	assert.equal(route.route, "paused");
});

test("router refuses a support whose isolation refs collapse to one (not independent)", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_same" });
	const b = episode({ id: "ep_b", group: "grp_a", isolation: "iso_same" });
	a.outcome.outcome_id = "out_ep_a";
	b.outcome.outcome_id = "out_ep_b";
	const route = routeLearning({ experiences: [activeExperience()], task: { arguments: { target: "A" } }, environment: compileEnv(), currentState: { ready: true }, registry: registry(), resolveSupport: resolverFor(a, b) });
	assert.notEqual(route.route, "direct");
	assert.equal(route.route, "paused");
});

test("router does NOT go direct on an UNKNOWN when value even with resolved support", () => {
	const route = routeLearning({ experiences: [activeExperience()], task: { arguments: { target: "A" } }, environment: compileEnv(), currentState: {}, registry: registry(), resolveSupport: supportStore() });
	assert.notEqual(route.route, "direct");
	assert.equal(route.candidates[0].when.known, false);
});

test("router does NOT go direct when action_version is unpinned even with resolved support", () => {
	const experience = activeExperience();
	delete experience.do.action_version;
	const route = routeLearning({ experiences: [experience], task: { arguments: { target: "A" } }, environment: compileEnv(), currentState: { ready: true }, registry: registry(), resolveSupport: supportStore() });
	assert.notEqual(route.route, "direct");
	assert.equal(route.candidates[0].binding_ok, false);
});

test("router does NOT go direct when implementation_digest is unpinned even with resolved support", () => {
	const experience = activeExperience();
	delete experience.do.implementation_digest;
	const route = routeLearning({ experiences: [experience], task: { arguments: { target: "A" } }, environment: compileEnv(), currentState: { ready: true }, registry: registry(), resolveSupport: supportStore() });
	assert.notEqual(route.route, "direct");
	assert.equal(route.candidates[0].binding_ok, false);
});

test("router pauses when the registered implementation digest no longer matches", () => {
	const experience = activeExperience();
	experience.do.implementation_digest = "sha256:stale";
	const route = routeLearning({ experiences: [experience], task: { arguments: { target: "A" } }, environment: compileEnv(), currentState: { ready: true }, registry: registry(), resolveSupport: supportStore() });
	assert.equal(route.route, "paused");
	assert.equal(route.recoverable, true);
});

// ---------------------------------------------------------------------------
// Integration: compile -> route on the same resolved evidence
// ---------------------------------------------------------------------------

test("compiler output routes direct under the same resolved support", () => {
	const a = episode({ id: "ep_a", group: "grp_a", isolation: "iso_a" });
	const b = episode({ id: "ep_b", group: "grp_b", isolation: "iso_b" });
	const compiled = compileExperience({ proofs: [proofFor(a), proofFor(b)], environment: compileEnv(), resolveSupport: resolverFor(a, b), experienceId: "exp_int" });
	assert.equal(compiled.status, "active", JSON.stringify(compiled.failures));
	const route = routeLearning({ experiences: [compiled.experience], task: { arguments: { target: "A" } }, environment: compileEnv(), currentState: { ready: true }, registry: registry(), resolveSupport: resolverFor(a, b) });
	assert.equal(route.route, "direct");
	assert.equal(route.experience.experience_id, "exp_int");
});

// ---------------------------------------------------------------------------

console.log("");
if (failures.length > 0) {
	console.error(`${failures.length} learning-evidence test(s) failed`);
	process.exit(1);
}
console.log(`ok memory runtime learning evidence: ${sha256Hex("learning-evidence").slice(0, 8)} all assertions passed`);
