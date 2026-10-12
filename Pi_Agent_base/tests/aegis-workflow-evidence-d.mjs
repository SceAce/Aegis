// Aegis Batch D — evidence-resolver + compiler integration tests.
//
// Independent, offline, temp-dir tests that assert the resolver only ever hands
// the batch-B Compiler REAL records from a VALIDATED, hash-chained EventLog, and
// that it refuses every fabricated-proof branch the D task lists:
//   * unresolvable / unknown refs
//   * a model-source (`llm`) record is never evidence
//   * a fake digest on a ref is refused
//   * a superseded / stale outcome is refused
//   * a foreign-episode / foreign-task outcome is refused
//   * a shared isolation/independence reference is ONE proof, not two
//   * a changed registered implementation is caught (version/digest)
//   * a current-scope mismatch stays a candidate
//   * an unknown outcome is NOT counted as a success or a failure
//
// Run:
//   node Pi_Agent_base/tests/aegis-workflow-evidence-d.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventLog, digest } from "../memory/runtime/events.mjs";
import { createEvidenceResolver } from "../memory/runtime/evidence-resolver.mjs";
import { createWorkflowEngine } from "../memory/runtime/workflow-engine.mjs";
import { ActionRegistry, createActionBroker, defineContract } from "../memory/runtime/action-contract.mjs";

let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

const ENV = { environment_fingerprint: "env-d-1", domain: "fixture-d", permissions: ["read"] };

const SRC = {
	runtime: { actor_id: "aegis-runtime", kind: "runtime", adapter: "d-test", version: "1.0.0" },
	observer: { actor_id: "aegis-observer", kind: "observer", adapter: "d-test", version: "1.0.0" },
	oracle: { actor_id: "fixture-oracle", kind: "oracle", adapter: "d-test-oracle", version: "1.0.0" },
	replay: { actor_id: "fixture-replay", kind: "replay", adapter: "d-test-replay", version: "1.0.0" },
	llm: { actor_id: "model", kind: "llm", adapter: "model", version: "0.0.1" },
};

function makeContract(version = 1, digestSalt = "") {
	return defineContract({
		id: "fixture.advance",
		version,
		tool: "aegis_fixture",
		operation: "advance",
		risk_class: "low",
		parameters: { bits: { type: "string", required: true } },
		recognition: { predicates: [{ path: "arguments.bits", op: "exists" }] },
		verification: { check: ({ observed }) => ({ ok: observed?.stage === "done", reason: `stage must be done (got ${observed?.stage})`, observed }) },
		procedure: { kind: "function", run: async ({ arguments: args }) => ({ ok: true, observed: { stage: "done", bits: args.bits, salt: digestSalt }, transport_ok: true }) },
		scope: { environment_fingerprint: ENV.environment_fingerprint, domain: ENV.domain, permissions: [...ENV.permissions] },
		authorization: { allowed_targets: ["workspace"] },
		stop_policy: { max_attempts: 1, retry: "none", timeout_ms: 5000 },
	});
}

/**
 * Append one complete, trusted episode to the log: reset proof, data, action,
 * observation, outcome and an isolated replay. Returns the ids/refs so the test
 * can build proof descriptors.
 */
async function seedEpisode(log, { i, taskId = "task-A", group = `group-${i}`, isolation = `reset-${i}`, contract, extra = {} }) {
	const epId = `ep-${i}`;
	const runId = `run-${i}`;
	const outId = `out-${i}`;
	const dataRef = { ref_type: "data", ref_id: `data-${i}` };
	const actionRef = { ref_type: "action", ref_id: contract.id };
	const artifactValue = { stage: "done", bits: "64" };
	const artifactRef = { ref_type: "artifact", ref_id: `artifact-${i}`, digest: digest(artifactValue) };

	await log.append({ event_type: "episode.started", episode_id: epId, payload: { task_id: taskId, goal: "advance the fixture" }, source: SRC.runtime });
	await log.append({ event_type: "runtime.note", episode_id: epId, payload: { kind: "episode.isolated_reset", isolation_ref: isolation, independence_group: group, run_id: runId, adapter: "d-test-replay" }, source: SRC.runtime });
	await log.append({ event_type: "runtime.note", episode_id: epId, payload: { kind: "data.obtained", data_ref: dataRef, content_digest: digest({ data: i }) }, source: SRC.runtime });
	await log.append({ event_type: "action.requested", episode_id: epId, payload: { action_id: `act-${i}`, action_ref: contract.id, version: contract.version, implementation_digest: contract.implementation_digest, tool_name: contract.tool, run_id: runId, bound_arguments: [dataRef] }, source: SRC.runtime });
	const obsEvent = await log.append({ event_type: "observation.captured", episode_id: epId, payload: { kind: "observation.captured", value: artifactValue, artifact_ref: artifactRef, content_digest: artifactRef.digest, verified: true, run_id: runId }, source: SRC.oracle, evidence_refs: [artifactRef] });
	await log.append({ event_type: "action.completed", episode_id: epId, payload: { action_id: `act-${i}`, action_ref: contract.id, version: contract.version, implementation_digest: contract.implementation_digest, tool_name: contract.tool, run_id: runId, observation: artifactValue }, source: SRC.runtime });

	const preState = { stage: "start", bits: "64" };
	const outcomePayload = {
		outcome_id: outId,
		episode_id: epId,
		run_id: runId,
		level: "episode",
		status: "success",
		independent: true,
		criterion: { criterion_id: "stage-done", path: "stage", op: "eq", value: "done" },
		observed: { stage: "done", bits: "64", pre_state: preState, arguments: { bits: "64" } },
		oracle: { oracle_id: "fixture-file-state-oracle", method: "independent_json_state_rehash", version: "0.1.0", independence_group: group, isolation_ref: isolation },
		expect: [{ path: "stage", op: "eq", value: "done" }],
		when: [{ path: "bits", op: "eq", value: "64", verified_by: [outId] }],
		preconditions_verified: true,
		evidence_refs: [dataRef, actionRef, artifactRef, { ref_type: "event", ref_id: obsEvent.event.event_id }],
		scope: { environment_fingerprint: ENV.environment_fingerprint, domain: ENV.domain, permissions: [...ENV.permissions] },
		transport: { tool_ok: true, exit_code: 0, timed_out: false },
		...extra,
	};
	await log.append({ event_type: "outcome.recorded", episode_id: epId, payload: outcomePayload, source: SRC.oracle, evidence_refs: outcomePayload.evidence_refs });
	await log.append({ event_type: "runtime.note", episode_id: epId, payload: { kind: "replay.performed", replay_id: `replay:${epId}:${outId}`, outcome_id: outId, episode_id: epId, replayable: true, replay_count: 2, replay_hash: digest({ replayed: outId }), isolated: true, adapter: "d-test-replay", pre_state_digest: digest(preState), post_state_digest: digest({ stage: "done" }) }, source: SRC.replay });

	return { epId, runId, outId, isolation, group, dataRef, actionRef, artifactRef, obsEventId: obsEvent.event.event_id, preState };
}

function doSpec(contract) {
	return { action_ref: contract.id, action_version: contract.version, implementation_digest: contract.implementation_digest, arguments_template: { bits: "64" } };
}

function proof(seed, contract) {
	return { episode_id: seed.epId, outcome_id: seed.outId, do: doSpec(contract), when: [{ path: "bits", op: "eq", value: "64", verified_by: [seed.outId] }], scope: { ...ENV } };
}

function engineFor(resolver, contract, environment = ENV) {
	const registry = new ActionRegistry([contract]);
	const broker = createActionBroker({ registry });
	return createWorkflowEngine({ registry, broker, resolver, environment, authorization: { mode: "auto", workspaceRoot: "/workspace", allowedTools: [contract.tool], allowNetwork: false, approved: true } });
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-workflow-evidence-"));
	const logPath = join(base, "events.jsonl");
	const log = new EventLog(logPath);
	await log.open();

	const contract = makeContract(1);
	const seed0 = await seedEpisode(log, { i: 0, contract });
	const seed1 = await seedEpisode(log, { i: 1, contract });

	// ---- 1. Resolver builds from the validated committed log -----------------
	const resolver = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	check("the committed chain verifies", resolver.chain_ok === true, JSON.stringify(resolver.errors));
	check("the resolver resolves a real outcome", resolver.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: seed0.outId } }).ok === true);
	check("the resolver resolves a real episode with canonical reset", (() => {
		const r = resolver.resolveSupport({ kind: "episode", ref: { ref_type: "episode", ref_id: seed0.epId } });
		return r.ok === true && r.record.isolation_ref === seed0.isolation && r.record.relation_status === "canonical";
	})(), JSON.stringify(resolver.resolveSupport({ kind: "episode", ref: { ref_type: "episode", ref_id: seed0.epId } })));
	check("the resolver resolves the action by action id and action_ref", resolver.resolveSupport({ kind: "action", ref: { ref_type: "action", ref_id: contract.id } }).ok === true);
	check("the resolver resolves the artifact and the replay record", resolver.resolveSupport({ kind: "artifact", ref: seed0.artifactRef }).ok === true && resolver.resolveSupport({ kind: "replay", ref: { ref_type: "replay", ref_id: `replay:${seed0.epId}:${seed0.outId}` } }).ok === true);

	// A repeated artifact id with different content must resolve by DIGEST, not
	// just the latest-by-id, or the earlier proof's pinned evidence could not be
	// confirmed.
	const dupA = { ref_type: "artifact", ref_id: "dup-art", digest: digest({ v: 1 }) };
	const dupB = { ref_type: "artifact", ref_id: "dup-art", digest: digest({ v: 2 }) };
	await log.append({ event_type: "observation.captured", episode_id: seed0.epId, payload: { kind: "observation.captured", value: { v: 1 }, artifact_ref: dupA, content_digest: dupA.digest, verified: true }, source: SRC.oracle, evidence_refs: [dupA] });
	await log.append({ event_type: "observation.captured", episode_id: seed0.epId, payload: { kind: "observation.captured", value: { v: 2 }, artifact_ref: dupB, content_digest: dupB.digest, verified: true }, source: SRC.oracle, evidence_refs: [dupB] });
	const resolverDup = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	check("a digest-pinned artifact ref resolves to the matching record when the id is reused", resolverDup.resolveSupport({ kind: "artifact", ref: dupA }).ok === true && resolverDup.resolveSupport({ kind: "artifact", ref: dupB }).ok === true);
	check("a reused artifact id with an unrecorded digest is refused", resolverDup.resolveSupport({ kind: "artifact", ref: { ref_type: "artifact", ref_id: "dup-art", digest: "sha256:deadbeef" } }).ok === false);

	// ---- 2. The compiler activates on two independent resolved proofs --------
	const engine = engineFor(resolver, contract);
	const compiled = engine.compileExperience({ proofs: [proof(seed0, contract), proof(seed1, contract)] });
	check("the compiler reaches active on two independent resolved proofs", compiled.status === "active", JSON.stringify(compiled.failures));
	check("the active experience pins the real action implementation digest", compiled.experience.do.implementation_digest === contract.implementation_digest);
	check("the active experience records two distinct isolation refs", new Set(compiled.experience.support.isolation_refs).size === 2, JSON.stringify(compiled.experience.support.isolation_refs));

	// ---- 3. Unresolvable proof -> candidate ----------------------------------
	const ghost = engine.compileExperience({ proofs: [proof(seed0, contract), { ...proof(seed1, contract), outcome_id: "out-ghost" }] });
	check("an unresolvable proof keeps the compilation a candidate", ghost.status === "candidate" && ghost.failures.some((f) => f.rule === "proof_resolvable"), JSON.stringify(ghost.failures.map((f) => f.rule)));

	// ---- 4. A model-source (llm) outcome is never evidence -------------------
	await log.append({ event_type: "outcome.recorded", episode_id: seed0.epId, payload: { outcome_id: "out-llm", episode_id: seed0.epId, status: "success", criterion: { criterion_id: "stage-done" }, observed: { stage: "done" }, independent: true, evidence_refs: [seed0.artifactRef] }, source: SRC.llm, evidence_refs: [seed0.artifactRef] });
	const resolver2 = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	check("an llm-source outcome is refused by the resolver", resolver2.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: "out-llm" } }).ok === false);
	const llmCompile = engineFor(resolver2, contract).compileExperience({ proofs: [proof(seed0, contract), proof(seed1, contract)] });
	check("the llm outcome did not corrupt the valid compilation", llmCompile.status === "active", JSON.stringify(llmCompile.failures));

	// ---- 5. A fake digest on a ref is refused --------------------------------
	check("a ref with a wrong digest is refused", resolver2.resolveSupport({ kind: "artifact", ref: { ref_type: "artifact", ref_id: seed0.artifactRef.ref_id, digest: "sha256:deadbeef" } }).ok === false);
	check("a foreign event ref is refused", resolver2.resolveSupport({ kind: "event", ref: { ref_type: "event", ref_id: "evt-ghost" } }).ok === false);

	// ---- 6. Unknown outcome is not counted as success or failure -------------
	await log.append({ event_type: "outcome.recorded", episode_id: seed1.epId, payload: { outcome_id: "out-unknown", episode_id: seed1.epId, run_id: seed1.runId, status: "unknown", criterion: { criterion_id: "stage-done" }, observed: null, independent: true, preconditions_verified: true, evidence_refs: [seed1.artifactRef] }, source: SRC.oracle, evidence_refs: [seed1.artifactRef] });
	const resolver3 = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	const unknownCompile = engineFor(resolver3, contract).compileExperience({ proofs: [proof(seed0, contract), proof({ ...seed1, outId: "out-unknown" }, contract)] });
	check("an unknown outcome keeps the compilation a candidate", unknownCompile.status === "candidate" && unknownCompile.failures.some((f) => f.rule === "proof_success"), JSON.stringify(unknownCompile.failures.map((f) => f.rule)));

	// ---- 7. Foreign-episode / foreign-task outcome is refused ----------------
	const seedB = await seedEpisode(log, { i: "B", taskId: "task-B", contract });
	const resolver4 = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	const foreign = resolver4.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: seedB.outId } });
	check("an outcome from another task is refused as foreign", foreign.ok === false && /foreign/i.test(foreign.reason), foreign.reason);

	// ---- 8. Shared isolation/independence reference is ONE proof -------------
	const seedShared1 = await seedEpisode(log, { i: "S1", taskId: "task-A", group: "shared-group", isolation: "shared-reset", contract });
	const seedShared2 = await seedEpisode(log, { i: "S2", taskId: "task-A", group: "shared-group", isolation: "shared-reset", contract });
	const resolver5 = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	const sharedCompile = engineFor(resolver5, contract).compileExperience({ proofs: [proof(seedShared1, contract), proof(seedShared2, contract)] });
	check("two episodes sharing an isolation/independence reference are not independent", sharedCompile.status === "candidate" && sharedCompile.failures.some((f) => f.rule === "independence"), JSON.stringify(sharedCompile.failures.map((f) => f.rule)));

	// ---- 9. A changed registered implementation is caught --------------------
	const contractV2 = makeContract(2, "changed");
	const v2 = engineFor(resolver5, contractV2).compileExperience({ proofs: [proof(seed0, contract), proof(seed1, contract)] });
	check("a changed registered version/digest keeps the compilation a candidate", v2.status === "candidate" && v2.failures.some((f) => f.rule === "implementation_digest" || f.rule === "action_version"), JSON.stringify(v2.failures.map((f) => f.rule)));

	// ---- 10. A current-scope mismatch keeps the compilation a candidate ------
	const offEnv = { environment_fingerprint: "env-d-1", domain: "other-domain", permissions: ["read"] };
	const scopeCompile = engineFor(resolver5, contract, offEnv).compileExperience({ proofs: [proof(seed0, contract), proof(seed1, contract)] });
	check("a mismatched current scope keeps the compilation a candidate", scopeCompile.status === "candidate" && scopeCompile.failures.some((f) => f.rule === "scope_current"), JSON.stringify(scopeCompile.failures.map((f) => f.rule)));

	// ---- 11. Replay proof is required and must resolve ------------------------
	const seedNoReplay = await seedEpisode(log, { i: "NR", taskId: "task-A", contract });
	// Remove the replay record by seeding without it: emulate by building a log view
	// that omits the replay.performed note for this episode.
	const filtered = log.replay().filter((event) => !(event.payload?.kind === "replay.performed" && event.payload?.outcome_id === seedNoReplay.outId));
	const resolver6 = createEvidenceResolver({ events: filtered, scope: { task_id: "task-A" } });
	const noReplayCompile = engineFor(resolver6, contract).compileExperience({ proofs: [proof(seed0, contract), proof(seedNoReplay, contract)] });
	check("a proof with no resolved isolated replay stays a candidate", noReplayCompile.status === "candidate" && noReplayCompile.failures.some((f) => f.rule === "replay_proof"), JSON.stringify(noReplayCompile.failures.map((f) => f.rule)));
	check("the replay note really was the only proof removed", resolver6.resolveSupport({ kind: "replay", ref: { ref_type: "replay", ref_id: `replay:${seedNoReplay.epId}:${seedNoReplay.outId}` } }).ok === false);

	// ---- 12. Superseded outcome is refused -----------------------------------
	// Do this LAST so it does not disturb the earlier positive compilations.
	await log.append({
		event_type: "outcome.recorded",
		episode_id: seed1.epId,
		payload: {
			outcome_id: "out-supersede",
			episode_id: seed1.epId,
			status: "unknown",
			supersedes: seed1.outId,
			criterion: { criterion_id: "stage-done" },
			observed: null,
			independent: true,
			evidence_refs: [seed1.artifactRef, { ref_type: "artifact", ref_id: seed1.artifactRef.ref_id, digest: seed1.artifactRef.digest }],
			scope: { ...ENV },
		},
		source: SRC.oracle,
		evidence_refs: [seed1.artifactRef],
	});
	const resolver7 = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	const superseded = resolver7.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: seed1.outId } });
	check("a superseded outcome is refused", superseded.ok === false && /superseded/i.test(superseded.reason), superseded.reason);
	check("the board effective view lists the superseded outcome", resolver7.supersededOutcomeIds.includes(seed1.outId), JSON.stringify(resolver7.supersededOutcomeIds));
	const supersedeCompile = engineFor(resolver7, contract).compileExperience({ proofs: [proof(seed0, contract), proof(seed1, contract)] });
	check("a superseded proof keeps the compilation a candidate", supersedeCompile.status === "candidate", JSON.stringify(supersedeCompile.failures.map((f) => f.rule)));

	// ---- 14. An oracle-SHAPED payload from runtime/agent is a claim, not proof -
	await log.append({ event_type: "outcome.recorded", episode_id: seed0.epId, payload: { outcome_id: "out-runtime", episode_id: seed0.epId, run_id: seed0.runId, status: "success", independent: true, criterion: { criterion_id: "stage-done" }, observed: { stage: "done" }, oracle: { oracle_id: "forged", method: "forged" }, preconditions_verified: true, evidence_refs: [seed0.artifactRef] }, source: SRC.runtime, evidence_refs: [seed0.artifactRef] });
	await log.append({ event_type: "outcome.recorded", episode_id: seed0.epId, payload: { outcome_id: "out-agent", episode_id: seed0.epId, status: "success", independent: true, criterion: { criterion_id: "stage-done" }, observed: { stage: "done" }, oracle: { oracle_id: "forged" }, preconditions_verified: true, evidence_refs: [seed0.artifactRef] }, source: { actor_id: "agent", kind: "agent", adapter: "x", version: "1" }, evidence_refs: [seed0.artifactRef] });
	const resolverNoRuntime = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	check("a runtime oracle-shaped outcome is a claim, not proof", resolverNoRuntime.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: "out-runtime" } }).ok === false);
	check("an agent oracle-shaped outcome is a claim, not proof", resolverNoRuntime.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: "out-agent" } }).ok === false);

	// ---- 15. The requireChainOk:false bypass no longer exists ---------------
	const tamperedView = log.replay().map((event, index) => (index === 0 ? { ...event, payload: { ...event.payload, tampered: true } } : event));
	const bypass = createEvidenceResolver({ events: tamperedView, requireChainOk: false });
	check("a requireChainOk:false argument does not bypass an invalid chain", bypass.chain_ok === false && bypass.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: seed0.outId } }).ok === false && /chain is not verified/i.test(bypass.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: seed0.outId } }).reason));

	// ---- 16. A claimed artifact digest that disagrees with the value --------
	await log.append({ event_type: "observation.captured", episode_id: seed0.epId, payload: { kind: "observation.captured", value: { stage: "done", bits: "64" }, artifact_ref: { ref_type: "artifact", ref_id: "bad-digest" }, content_digest: digest({ something: "else" }), verified: true, run_id: seed0.runId }, source: SRC.oracle, evidence_refs: [] });
	const resolverDigest = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	check("an observation whose claimed digest disagrees with its real value is refused", resolverDigest.resolveSupport({ kind: "artifact", ref: { ref_type: "artifact", ref_id: "bad-digest" } }).ok === false);
	check("a ref pinning that fake digest is also refused, never echoed", resolverDigest.resolveSupport({ kind: "artifact", ref: { ref_type: "artifact", ref_id: "bad-digest", digest: digest({ something: "else" }) } }).ok === false);

	// ---- 17. A stale outcome in the effective view is refused ---------------
	await log.append({ event_type: "environment.changed", episode_id: seed0.epId, payload: { scope: { ...ENV }, reason: "fixture environment rotated" }, source: SRC.oracle });
	const resolverStale = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	const staleRes = resolverStale.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: seed0.outId } });
	check("a stale outcome is refused by the current effective view", staleRes.ok === false && /stale/i.test(staleRes.reason), staleRes.reason);

	// ---- 18. Replays need a trusted replay source + real isolation ----------
	await log.append({ event_type: "runtime.note", episode_id: seed1.epId, payload: { kind: "replay.performed", replay_id: "replay:ep-1:out-notreal", outcome_id: seed1.outId, isolated: true, replayable: true, replay_count: 1, replay_hash: digest({ fake: true }), adapter: "forged" }, source: SRC.runtime });
	await log.append({ event_type: "runtime.note", episode_id: seed1.epId, payload: { kind: "replay.performed", replay_id: "replay:ep-1:out-noniso", outcome_id: seed1.outId, isolated: false, replayable: true, replay_count: 1, replay_hash: digest({ fake: 2 }), adapter: "forged" }, source: SRC.replay });
	const resolverReplay = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	check("a runtime replay note is a claim, not an isolated replay", resolverReplay.resolveSupport({ kind: "replay", ref: { ref_type: "replay", ref_id: "replay:ep-1:out-notreal" } }).ok === false);
	check("a replay note that is not isolated is refused", resolverReplay.resolveSupport({ kind: "replay", ref: { ref_type: "replay", ref_id: "replay:ep-1:out-noniso" } }).ok === false);

	// ---- 19. Action records pair by execution, never action_ref overwrite ---
	await log.append({ event_type: "episode.started", episode_id: "ep-act-A", payload: { task_id: "task-A", goal: "act A" }, source: SRC.runtime });
	await log.append({ event_type: "episode.started", episode_id: "ep-act-B", payload: { task_id: "task-A", goal: "act B" }, source: SRC.runtime });
	await log.append({ event_type: "action.requested", episode_id: "ep-act-A", payload: { action_id: "actnew-A", action_ref: contract.id, version: 1, implementation_digest: contract.implementation_digest, bound_arguments: [{ ref_type: "data", ref_id: "data-A" }] }, source: SRC.runtime });
	await log.append({ event_type: "action.requested", episode_id: "ep-act-B", payload: { action_id: "actnew-B", action_ref: contract.id, version: 1, implementation_digest: "sha256:different", bound_arguments: [{ ref_type: "data", ref_id: "data-B" }] }, source: SRC.runtime });
	await log.append({ event_type: "action.completed", episode_id: "ep-act-B", payload: { action_id: "actnew-B", action_ref: contract.id, version: 1, implementation_digest: "sha256:different" }, source: SRC.runtime });
	await log.append({ event_type: "action.completed", episode_id: "ep-act-A", payload: { action_id: "actnew-A", action_ref: contract.id, version: 1, implementation_digest: contract.implementation_digest }, source: SRC.runtime });
	const resolverAct = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	const recA = resolverAct.resolveSupport({ kind: "action", ref: { ref_type: "action", ref_id: "actnew-A" } });
	const recB = resolverAct.resolveSupport({ kind: "action", ref: { ref_type: "action", ref_id: "actnew-B" } });
	check("action act-A resolves to its own execution with requested identity preserved", recA.ok === true && recA.record.status === "completed" && recA.record.version === 1 && recA.record.implementation_digest === contract.implementation_digest && recA.record.bound_arguments[0]?.ref_id === "data-A", JSON.stringify(recA.record ?? recA.reason));
	check("action act-B resolves to its own execution, not act-A", recB.ok === true && recB.record.action_id === "actnew-B" && recB.record.bound_arguments[0]?.ref_id === "data-B", JSON.stringify(recB.record ?? recB.reason));
	check("an action_ref with conflicting across-episode digests is ambiguous, not overwritten", resolverAct.resolveSupport({ kind: "action", ref: { ref_type: "action", ref_id: contract.id } }).ok === false);
	await log.append({ event_type: "action.requested", episode_id: "ep-act-A", payload: { action_id: "actnew-C", action_ref: contract.id, version: 1, implementation_digest: contract.implementation_digest, bound_arguments: [{ ref_type: "data", ref_id: "data-C" }] }, source: SRC.runtime });
	const resolverAct2 = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	const recC = resolverAct2.resolveSupport({ kind: "action", ref: { ref_type: "action", ref_id: "actnew-C" } });
	check("a requested action with no completion preserves its version/digest/args", recC.ok === true && recC.record.status === "requested" && recC.record.version === 1 && recC.record.implementation_digest === contract.implementation_digest && recC.record.bound_arguments[0]?.ref_id === "data-C", JSON.stringify(recC.record ?? recC.reason));

	// ---- 20. An incomplete oracle outcome is not a resolvable verdict -------
	await log.append({ event_type: "outcome.recorded", episode_id: seed0.epId, payload: { outcome_id: "out-incomplete", episode_id: seed0.epId, status: "success", criterion: null, observed: null, oracle: { oracle_id: "x" }, evidence_refs: [] }, source: SRC.oracle });
	const resolverIncomplete = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-A" } });
	check("an oracle outcome missing criterion/observed/evidence is not resolvable", resolverIncomplete.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: "out-incomplete" } }).ok === false);

	// ---- 21. Invalid chain resolves nothing ----------------------------------
	const tampered = log.replay().map((event, index) => (index === 0 ? { ...event, payload: { ...event.payload, tampered: true } } : event));
	const brokenResolver = createEvidenceResolver({ events: tampered });
	check("a tampered chain does not verify", brokenResolver.chain_ok === false);
	check("a tampered chain resolves nothing", brokenResolver.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: seed0.outId } }).ok === false && /chain is not verified/i.test(brokenResolver.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: seed0.outId } }).reason));

	await log.close();
	rmSync(base, { recursive: true, force: true });
	if (failures > 0) {
		console.error(`aegis-workflow-evidence-d FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-workflow-evidence-d ok");
}

main().catch((error) => {
	console.error(`aegis-workflow-evidence-d: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
