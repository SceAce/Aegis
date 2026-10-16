// Aegis Batch D — workflow-engine coordination tests.
//
// Independent, offline, temp-dir tests for `workflow-engine.mjs`:
//   * `bindProposal` maps explicit input or returns gaps; prose `do` is never
//     parsed/eval'd.
//   * `executeDirect` uses the broker with final args + authorization + pre/post
//     digests and ZERO model calls; normal mode without approval does not run.
//   * an Oracle `unknown` is classified unknown, not success/failure; a tool
//     error is an anomaly, not a task failure.
//   * `bindHabit` returns the missing-parameter mapping, applies it, RE-CHECKS,
//     and refuses a wrong-typed / unexpected binding.
//   * a changed registered version pauses the binding (re-verify).
//   * a NEW candidate is never routed as a hint/direct.
//   * `replayOutcome` needs an explicitly configured ISOLATED adapter, refuses a
//     changed implementation, a wrong pre-state digest, and a non-isolated
//     adapter, and writes a genuine `replay.performed` record.
//   * a non-idempotent action is not auto-retried.
//   * feedback is association-only; an `unknown` is never a negative.
//
// Run:
//   node Pi_Agent_base/tests/aegis-workflow-engine-d.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventLog, digest } from "../shared/events.mjs";
import { createEvidenceResolver } from "../memory/evidence-resolver.mjs";
import { createWorkflowEngine, assess } from "../orchestration/workflow-engine.mjs";
import { ActionRegistry, createActionBroker, defineContract } from "../execution/action-contract.mjs";
import { workspaceObservationContracts, syntheticElfHeader } from "../execution/workspace-info-actions.mjs";

let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

const SRC = {
	runtime: { actor_id: "aegis-runtime", kind: "runtime", adapter: "d-test", version: "1.0.0" },
	oracle: { actor_id: "fixture-oracle", kind: "oracle", adapter: "d-test-oracle", version: "1.0.0" },
	replay: { actor_id: "fixture-replay", kind: "replay", adapter: "d-test-replay", version: "1.0.0" },
};

const ENVB = { environment_fingerprint: "env-d-2", domain: "habit", permissions: ["read"], task_types: ["bind"] };

function makeHabitContract(version = 1, salt = "") {
	// The implementation digest is source-derived, so a genuinely changed
	// implementation must change the procedure source — not merely close over a
	// new constant.
	const run = version === 1
		? async ({ arguments: args }) => ({ ok: true, observed: { done: true, bits: args.bits }, transport_ok: true })
		: async ({ arguments: args }) => ({ ok: true, observed: { done: true, bits: args.bits, variant: salt || "v2" }, transport_ok: true });
	return defineContract({
		id: "fixture.bind",
		version,
		tool: "aegis_bind",
		operation: "bind",
		risk_class: "low",
		parameters: { bits: { type: "string", required: true } },
		recognition: { predicates: [{ path: "arguments.bits", op: "exists" }] },
		verification: { check: ({ observed }) => ({ ok: observed?.done === true, reason: "must be done", observed }) },
		procedure: { kind: "function", run },
		scope: { environment_fingerprint: ENVB.environment_fingerprint, domain: ENVB.domain, permissions: [...ENVB.permissions], task_types: [...ENVB.task_types] },
		authorization: { allowed_targets: ["workspace"] },
		stop_policy: { max_attempts: 1, retry: "none", timeout_ms: 5000 },
	});
}

async function seedRun(log, i, contract, withReplay = true) {
	const epId = `hep-${i}`;
	const runId = `hrun-${i}`;
	const outId = `hout-${i}`;
	const group = `hgroup-${i}`;
	const isolation = `hreset-${i}`;
	const dataRef = { ref_type: "data", ref_id: `hdata-${i}` };
	const actionRef = { ref_type: "action", ref_id: contract.id };
	const artifactValue = { done: true, bits: "64" };
	const artifactRef = { ref_type: "artifact", ref_id: `hartifact-${i}`, digest: digest(artifactValue) };
	await log.append({ event_type: "episode.started", episode_id: epId, payload: { task_id: "task-H", goal: "bind" }, source: SRC.runtime });
	await log.append({ event_type: "runtime.note", episode_id: epId, payload: { kind: "episode.isolated_reset", isolation_ref: isolation, independence_group: group, run_id: runId }, source: SRC.runtime });
	await log.append({ event_type: "runtime.note", episode_id: epId, payload: { kind: "data.obtained", data_ref: dataRef, content_digest: digest({ i }) }, source: SRC.runtime });
	// A committed current-state snapshot whose REAL value is `{ bits: "64" }`. The
	// resolved content digest pins the trusted state ref the router is given.
	const stateRef = { ref_type: "data", ref_id: `hstate-${i}` };
	await log.append({ event_type: "runtime.note", episode_id: epId, payload: { kind: "data.obtained", data_ref: stateRef, value: { bits: "64" } }, source: SRC.runtime });
	await log.append({ event_type: "action.requested", episode_id: epId, payload: { action_id: `hact-${i}`, action_ref: contract.id, version: contract.version, implementation_digest: contract.implementation_digest, tool_name: contract.tool, run_id: runId, bound_arguments: [dataRef] }, source: SRC.runtime });
	await log.append({ event_type: "action.completed", episode_id: epId, payload: { action_id: `hact-${i}`, action_ref: contract.id, version: contract.version, implementation_digest: contract.implementation_digest, tool_name: contract.tool, run_id: runId }, source: SRC.runtime });
	await log.append({ event_type: "observation.captured", episode_id: epId, payload: { kind: "observation.captured", value: artifactValue, artifact_ref: artifactRef, content_digest: artifactRef.digest, verified: true, run_id: runId }, source: SRC.oracle, evidence_refs: [artifactRef] });
	const preState = { stage: "start" };
	const outcomePayload = {
		outcome_id: outId,
		episode_id: epId,
		run_id: runId,
		level: "episode",
		status: "success",
		independent: true,
		criterion: { criterion_id: "bind-done", path: "done", op: "eq", value: true },
		observed: { done: true, bits: "64", pre_state: preState, arguments: { bits: "64" } },
		oracle: { oracle_id: "fixture-file-state-oracle", method: "independent_json_state_rehash", version: "0.1.0", independence_group: group, isolation_ref: isolation },
		expect: [{ path: "done", op: "eq", value: true }],
		when: [{ path: "bits", op: "eq", value: "64", verified_by: [outId] }],
		preconditions_verified: true,
		action_ref: contract.id,
		action_version: contract.version,
		implementation_digest: contract.implementation_digest,
		evidence_refs: [dataRef, actionRef, artifactRef],
		scope: { ...ENVB },
		transport: { tool_ok: true, exit_code: 0 },
	};
	await log.append({ event_type: "outcome.recorded", episode_id: epId, payload: outcomePayload, source: SRC.oracle, evidence_refs: outcomePayload.evidence_refs });
	if (withReplay) {
		await log.append({ event_type: "runtime.note", episode_id: epId, payload: { kind: "replay.performed", replay_id: `replay:${epId}:${outId}`, outcome_id: outId, episode_id: epId, replayable: true, replay_count: 1, replay_hash: digest({ replayed: outId }), isolated: true, adapter: "d-test-replay", pre_state_digest: digest(preState), post_state_digest: digest({ done: true }) }, source: SRC.replay });
	}
	return { epId, outId, runId, group, isolation, dataRef, actionRef, artifactRef, stateRef };
}

function habitProof(seed, contract) {
	return {
		episode_id: seed.epId,
		outcome_id: seed.outId,
		do: { action_ref: contract.id, action_version: contract.version, implementation_digest: contract.implementation_digest, arguments_template: { bits: null } },
		when: [{ path: "bits", op: "eq", value: "64", verified_by: [seed.outId] }],
		scope: { ...ENVB },
	};
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-workflow-engine-"));
	const workspaceRoot = join(base, "workspace");
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(join(base, "keep.txt"), "keep");
	const elfAbs = join(workspaceRoot, "target.bin");
	writeFileSync(elfAbs, syntheticElfHeader({ bits: 64, machine_id: 0x3e }), { flag: "w" });
	writeFileSync(join(workspaceRoot, "notes.txt"), "not an elf at all");

	// ======================================================================
	// Part A: bindProposal + executeDirect with a REAL registered ELF action.
	// ======================================================================
	const emptyResolver = createEvidenceResolver({ events: [] });
	check("an empty committed log is a valid (vacuous) chain", emptyResolver.chain_ok === true);
	const elfRegistry = new ActionRegistry(workspaceObservationContracts());
	const elfBroker = createActionBroker({ registry: elfRegistry });
	const autoAuth = { mode: "auto", workspaceRoot, allowedTools: ["aegis_workspace"], allowNetwork: false, approved: true };
	const elfEngine = createWorkflowEngine({ registry: elfRegistry, broker: elfBroker, resolver: emptyResolver, authorization: autoAuth, environment: { environment_fingerprint: "local-workspace", domain: "file.identity", permissions: ["read-only-observation"] } });

	// bindProposal: explicit vs prose
	const boundOk = elfEngine.bindProposal({ action_ref: "workspace.identify_elf", arguments: { path: "target.bin" }, when: [{ path: "arguments.path", op: "exists" }], scope: { environment_fingerprint: "local-workspace", domain: "file.identity" } });
	check("an explicit proposal binds to the registered action", boundOk.status === "bound" && boundOk.executable === true, JSON.stringify(boundOk.gaps));
	check("bindProposal never parses prose or uses eval", boundOk.model_text_parsed === false && boundOk.eval_used === false);
	const prose = elfEngine.bindProposal({ do: "please identify the file for me", scope: { environment_fingerprint: "local-workspace", domain: "file.identity" } });
	check("a prose `do` is an explicit gap, never parsed into an action", prose.executable === false && prose.gaps.some((gap) => gap.field === "do"), JSON.stringify(prose.gaps));

	// executeDirect: real observation success. There is NO previously selected
	// confirmed active Experience here, so deliberate execution goes through the
	// honest `invokeExploratory` path (never a bare action_ref disguised as direct).
	const direct = await elfEngine.invokeExploratory({ action_ref: "workspace.identify_elf", arguments: { path: "target.bin" }, context: { workspaceRoot, target_path: elfAbs }, currentState: { marker: "elf" } });
	check("exploratory execution reaches a verified success with 0 model calls", direct.status === "success" && direct.classification === "success" && direct.model_calls === 0 && direct.direct === false && direct.route === "exploratory", JSON.stringify({ status: direct.status, route: direct.route, reason: direct.reason ?? direct.verification?.reasons }));
	check("the observed ELF bitness is read from the real header", direct.observation?.value?.bits === 64 && direct.observation?.value?.machine_id === 62, JSON.stringify(direct.observation?.value));
	check("exploratory execution records real pre/post state digests", typeof direct.pre_state_digest === "string" && typeof direct.post_state_digest === "string" && direct.pre_state_digest !== direct.post_state_digest, JSON.stringify({ pre: direct.pre_state_digest, post: direct.post_state_digest }));
	// executeDirect WITHOUT a selected confirmed Experience is refused (no bare action_ref bypass).
	const unselected = await elfEngine.executeDirect({ action_ref: "workspace.identify_elf", arguments: { path: "target.bin" } });
	check("executeDirect without a selected confirmed Experience is refused", unselected.ok === false && unselected.route === "unselected" && /selected confirmed active Experience/i.test(unselected.reason ?? ""), JSON.stringify({ route: unselected.route, reason: unselected.reason }));

	// executeDirect: Oracle unknown (non-ELF file) is NOT a success
	const unknownDirect = await elfEngine.invokeExploratory({ action_ref: "workspace.identify_elf", arguments: { path: "notes.txt" }, context: { workspaceRoot, target_path: join(workspaceRoot, "notes.txt") }, currentState: { marker: "txt" } });
	check("a non-ELF observation is classified unknown, never success", unknownDirect.classification === "unknown" && unknownDirect.status !== "success", JSON.stringify({ status: unknownDirect.status, classification: unknownDirect.classification, failure: unknownDirect.failure_mode }));

	// assess: an anomaly is a transport event, not a task failure
	check("assess maps a broker unknown to unknown", assess({ status: "unknown", failure_mode: "insufficient_evidence" }).classification === "unknown");
	check("assess flags a tool error as an anomaly without relabelling the verdict", (() => { const a = assess({ status: "unknown", failure_mode: "tool_error", transport: { exit_code: 1 } }); return a.classification === "unknown" && a.anomalous === true; })());
	check("assess reports a real failure status as failure", assess({ status: "failure", verification: { ok: false } }).classification === "failure");

	// normal mode: no approval does not run
	const normalEngine = createWorkflowEngine({ registry: elfRegistry, broker: elfBroker, resolver: emptyResolver, authorization: { mode: "normal", workspaceRoot, allowedTools: ["aegis_workspace"], allowNetwork: false, approved: false }, environment: { environment_fingerprint: "local-workspace", domain: "file.identity", permissions: ["read-only-observation"] } });
	const pending = await normalEngine.invokeExploratory({ action_ref: "workspace.identify_elf", arguments: { path: "target.bin" }, context: { workspaceRoot, target_path: elfAbs }, approved: false });
	check("normal mode without an explicit approval is rejected", pending.status === "rejected" && /authorization|approval/i.test(pending.reason ?? ""), JSON.stringify({ status: pending.status, reason: pending.reason }));
	const approvedRun = await normalEngine.invokeExploratory({ action_ref: "workspace.identify_elf", arguments: { path: "target.bin" }, context: { workspaceRoot, target_path: elfAbs }, approved: true });
	check("normal mode WITH a human approval runs the registered action", approvedRun.status === "success", JSON.stringify({ status: approvedRun.status, reason: approvedRun.reason }));

	// non-idempotent action is not auto-retried
	check("a non-idempotent (retry:none) action is never auto-retried", unknownDirect.attempts === 1 && unknownDirect.retry_allowed === false, JSON.stringify({ attempts: unknownDirect.attempts, retry_allowed: unknownDirect.retry_allowed }));

	// ======================================================================
	// Part B: habit binding, version pause, candidates, replay, feedback.
	// ======================================================================
	const logPath = join(base, "habit-events.jsonl");
	const log = new EventLog(logPath);
	await log.open();
	const contract = makeHabitContract(1);
	const seed0 = await seedRun(log, 0, contract);
	const seed1 = await seedRun(log, 1, contract);
	const seed2 = await seedRun(log, 2, contract, false); // no committed replay yet

	const resolver = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-H" } });
	const registry = new ActionRegistry([contract]);
	const broker = createActionBroker({ registry });
	const engine = createWorkflowEngine({ registry, broker, resolver, environment: ENVB, authorization: { mode: "auto", workspaceRoot: "/workspace", target: "workspace", allowedTools: [contract.tool], allowNetwork: false, approved: true } });

	const compiled = engine.compileExperience({ proofs: [habitProof(seed0, contract), habitProof(seed1, contract)] });
	check("the habit experience compiles to active", compiled.status === "active", JSON.stringify(compiled.failures));
	const experience = compiled.experience;

	// A resolver-verified current-state ref. The trusted state is the committed
	// snapshot value `{ bits: "64" }`; the ref pins its REAL content digest.
	const stateRefRecord = resolver.resolveSupport({ kind: "data", ref: seed0.stateRef });
	const currentStateRef = { ref_type: "data", ref_id: seed0.stateRef.ref_id, digest: stateRefRecord.content_digest };
	const currentState = { bits: "64" };

	// routeLearning -> habit (bits missing) ONLY with a verified state ref.
	const route = engine.routeLearning({ experiences: [experience], task: { task_id: "task-H", task_types: ["bind"], permissions: ["read"] }, currentState, currentStateRef });
	check("a reliable match with a missing parameter routes to habit", route.route === "habit" && route.missing_parameters.includes("bits") && route.state_trusted === true, JSON.stringify({ route: route.route, missing: route.missing_parameters, reason: route.reason }));
	// An UNVERIFIED caller state is never trusted: absent/forged state ref -> unknown.
	const untrustedRoute = engine.routeLearning({ experiences: [experience], task: { task_id: "task-H", task_types: ["bind"], permissions: ["read"] }, currentState });
	check("a caller state without a verified ref is never trusted and never routes direct/habit", untrustedRoute.state_trusted === false && untrustedRoute.route !== "habit" && untrustedRoute.route !== "direct", JSON.stringify({ route: untrustedRoute.route, trusted: untrustedRoute.state_trusted, reason: untrustedRoute.reason }));
	const forgedRoute = engine.routeLearning({ experiences: [experience], task: { task_id: "task-H", task_types: ["bind"], permissions: ["read"] }, currentState, currentStateRef: { ref_type: "data", ref_id: seed0.stateRef.ref_id, digest: digest({ forged: true }) } });
	check("a state ref whose digest does not match the committed value is not trusted", forgedRoute.state_trusted === false, JSON.stringify({ trusted: forgedRoute.state_trusted, reason: forgedRoute.reason }));

	// bindHabit: wrong type / unexpected / correct
	const wrongType = engine.bindHabit({ experiences: [experience], task: { task_types: ["bind"], permissions: ["read"] }, currentState, currentStateRef, bindings: { bits: 123 } });
	check("a wrong-typed habit binding is refused, never guessed", wrongType.ok === false && /invalid/i.test(wrongType.reason), wrongType.reason);
	const unexpected = engine.bindHabit({ experiences: [experience], task: { task_types: ["bind"], permissions: ["read"] }, currentState, currentStateRef, bindings: { other: "x" } });
	check("a habit binding may only fill the reported missing parameters", unexpected.ok === false && /only fill/i.test(unexpected.reason), unexpected.reason);
	const habitOk = engine.bindHabit({ experiences: [experience], task: { task_types: ["bind"], permissions: ["read"] }, currentState, currentStateRef, bindings: { bits: "64" } });
	check("a correct habit binding RE-CHECKS to a direct route", habitOk.ok === true && habitOk.recheck?.route === "direct", JSON.stringify({ ok: habitOk.ok, reason: habitOk.reason, recheck: habitOk.recheck?.route }));

	// executeDirect: reuses the CONFIRMED selection and revalidates against the
	// current verified state, then runs through the broker.
	const directConfirmed = await engine.executeDirect({ experiences: [experience], task: { task_types: ["bind"], permissions: ["read"], arguments: { bits: "64" } }, currentState, currentStateRef, context: { target: "workspace" } });
	check("executeDirect revalidates a confirmed selection against current verified state", directConfirmed.ok === true && directConfirmed.route === "direct" && directConfirmed.direct === true && directConfirmed.status === "success", JSON.stringify({ ok: directConfirmed.ok, route: directConfirmed.route, status: directConfirmed.status, reason: directConfirmed.reason }));

	// a NEW candidate is never a hint/direct
	const candidateOnly = engine.routeLearning({ experiences: [{ ...experience, experience_id: "exp-candidate", status: "candidate" }], task: { task_types: ["bind"], permissions: ["read"] }, currentState, currentStateRef });
	check("a candidate experience is never routed as direct/hint/habit", candidateOnly.route === "deliberate" && candidateOnly.candidates_filtered === 1, JSON.stringify({ route: candidateOnly.route, filtered: candidateOnly.candidates_filtered }));

	// a changed registered version pauses the binding
	const contractV2 = makeHabitContract(2, "changed");
	const engineV2 = createWorkflowEngine({ registry: new ActionRegistry([contractV2]), broker: createActionBroker({ registry: new ActionRegistry([contractV2]) }), resolver, environment: ENVB, authorization: { mode: "auto", workspaceRoot: "/workspace", allowedTools: [contractV2.tool], allowNetwork: false, approved: true } });
	const paused = engineV2.routeLearning({ experiences: [experience], task: { task_types: ["bind"], permissions: ["read"] }, currentState, currentStateRef });
	check("a changed registered version pauses the binding for re-verification", paused.route === "paused" && paused.recoverable === true, JSON.stringify({ route: paused.route, reason: paused.reason }));

	// replayOutcome: guards. `seed2` has NO committed replay, so the adapter is
	// actually exercised; `seed0` already carries a committed replay (idempotency).
	const replaySink = { append: (event) => log.append(event) };
	const replayEngine = createWorkflowEngine({ registry, broker, resolver, environment: ENVB, replayAdapter: { id: "bad", isolated: false, replay: async () => ({ ok: true }) }, sink: replaySink });
	check("replay without a configured adapter is refused", (await engine.replayOutcome({ outcomeId: seed2.outId })).ok === false);
	check("a non-isolated adapter is refused", (await replayEngine.replayOutcome({ outcomeId: seed2.outId })).ok === false);
	const wrongPreEngine = createWorkflowEngine({ registry, broker, resolver, environment: ENVB, replayAdapter: { id: "x", isolated: true, replay: async () => ({ ok: true, isolated: true, pre_state_digest: "sha256:wrong", replay_count: 1, replay_hash: "sha256:r", criterion_verified: true }) }, sink: replaySink });
	check("a replay whose pre-state digest does not match is refused", (await wrongPreEngine.replayOutcome({ outcomeId: seed2.outId })).ok === false);
	check("replaying an outcome whose implementation changed is refused", (await createWorkflowEngine({ registry: new ActionRegistry([contractV2]), broker: createActionBroker({ registry: new ActionRegistry([contractV2]) }), resolver, environment: ENVB, replayAdapter: { id: "x", isolated: true, replay: async () => ({ ok: true }) }, sink: replaySink }).replayOutcome({ outcomeId: seed2.outId })).version_changed === true);

	// replayOutcome: a genuine isolated replay writes a real, durable record
	const goodAdapter = {
		id: "d-test-replay-adapter",
		isolated: true,
		replay: async ({ priorPreStateDigest, outcomeId, arguments_digest }) => ({ ok: true, isolated: true, action_ref: contract.id, arguments_digest, implementation_digest: contract.implementation_digest, pre_state_digest: priorPreStateDigest, post_state_digest: digest({ done: true }), criterion_verified: true, replay_count: 1, replay_hash: digest({ replayed: outcomeId }), transport: { tool_ok: true, exit_code: 0 }, isolation_ref: `fresh-${outcomeId}` }),
	};
	const durableSink = { append: async (event) => { const r = await log.append(event); return { ok: r.ok === true, durable: r.durable === true, event: r.event, error: r.error }; } };
	const replayEngineGood = createWorkflowEngine({ registry, broker, resolver, environment: ENVB, replayAdapter: goodAdapter, sink: durableSink });

	// New negatives: foreign episode attribution + missing isolation_ref are refused.
	check("a foreign episode is refused for replay", (await replayEngineGood.replayOutcome({ outcomeId: seed2.outId, episodeId: "foreign-ep" })).ok === false);
	const noIsolationAdapter = { id: "no-iso", isolated: true, replay: async ({ priorPreStateDigest, outcomeId, arguments_digest }) => ({ ok: true, isolated: true, action_ref: contract.id, arguments_digest, implementation_digest: contract.implementation_digest, pre_state_digest: priorPreStateDigest, post_state_digest: digest({ done: true }), criterion_verified: true, replay_count: 1, replay_hash: digest({ replayed: outcomeId }) }) };
	const noIsolationEngine = createWorkflowEngine({ registry, broker, resolver, environment: ENVB, replayAdapter: noIsolationAdapter, sink: durableSink });
	check("a replay whose adapter reports no isolation_ref is refused", (await noIsolationEngine.replayOutcome({ outcomeId: seed2.outId })).ok === false);

	const replayResult = await replayEngineGood.replayOutcome({ outcomeId: seed2.outId });
	check("a genuine isolated replay succeeds and is marked isolated", replayResult.ok === true && replayResult.isolated === true, JSON.stringify(replayResult));
	const resolverAfterReplay = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-H" } });
	const replayRecord = resolverAfterReplay.resolveSupport({ kind: "replay", ref: { ref_type: "replay", ref_id: `replay:${seed2.epId}:${seed2.outId}` } });
	check("the replay record is a real committed, resolver-visible record", replayRecord.ok === true && replayRecord.record.replayable === true && replayRecord.record.replay_count >= 1, JSON.stringify(replayRecord.reason ?? replayRecord.record));

	// A second replay of the same committed (episode, outcome) is idempotent: the
	// adapter is NOT re-run and no duplicate record is appended.
	const replayEngineAfter = createWorkflowEngine({ registry, broker, resolver: resolverAfterReplay, environment: ENVB, replayAdapter: goodAdapter, sink: durableSink });
	const dupResult = await replayEngineAfter.replayOutcome({ outcomeId: seed2.outId });
	check("a duplicate replay is idempotent (adapter not re-run)", dupResult.ok === true && dupResult.duplicated === true, JSON.stringify({ ok: dupResult.ok, duplicated: dupResult.duplicated, reason: dupResult.reason }));

	// A failing/undurable sink NEVER yields a committed replay claim.
	const failingSink = { append: async () => ({ ok: false, durable: false, error: "disk full" }) };
	const replayEngineFailing = createWorkflowEngine({ registry, broker, resolver, environment: ENVB, replayAdapter: goodAdapter, sink: failingSink });
	const replayFail = await replayEngineFailing.replayOutcome({ outcomeId: seed2.outId });
	check("a replay whose sink write is not durable is reported as not ok", replayFail.ok === false && /not durably committed/i.test(replayFail.reason ?? ""), JSON.stringify({ ok: replayFail.ok, reason: replayFail.reason }));
	const noSinkEngine = createWorkflowEngine({ registry, broker, resolver, environment: ENVB, replayAdapter: goodAdapter });
	check("a replay with no trusted sink is never reported as committed", (await noSinkEngine.replayOutcome({ outcomeId: seed2.outId })).ok === false);

	// feedback: association-only, unknown is never a negative
	const feedbackUnknown = engine.associateFeedback({ experience_id: experience.experience_id, actionRef: seed0.actionRef, outcomeRef: { ref_type: "outcome", ref_id: "does-not-exist" }, counterexample: true });
	check("feedback on an unresolvable outcome is association-only and not a negative", feedbackUnknown.counts_as_negative === false && feedbackUnknown.verified_counterexample === false && feedbackUnknown.causal === false && feedbackUnknown.outcome_resolved === false, JSON.stringify(feedbackUnknown));
	// a verified failure IS a negative counterexample — but ONLY when it resolves
	// the SAME-episode action + Outcome with matching contract/version/scope and a
	// real postcondition failure.
	await log.append({ event_type: "outcome.recorded", episode_id: seed1.epId, payload: { outcome_id: "hout-fail", episode_id: seed1.epId, run_id: seed1.runId, status: "failure", independent: true, criterion: { criterion_id: "bind-done" }, observed: { done: false }, oracle: { oracle_id: "fixture-file-state-oracle", method: "independent_json_state_rehash" }, preconditions_verified: true, failure_mode: "postcondition_failed", action_ref: contract.id, action_version: contract.version, implementation_digest: contract.implementation_digest, evidence_refs: [seed1.artifactRef], scope: { ...ENVB } }, source: SRC.oracle, evidence_refs: [seed1.artifactRef] });
	const resolverFail = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-H" } });
	const engineFail = createWorkflowEngine({ registry, broker, resolver: resolverFail, environment: ENVB, authorization: { mode: "auto", workspaceRoot: "/workspace", allowedTools: [contract.tool], allowNetwork: false, approved: true } });
	const feedbackFail = engineFail.associateFeedback({ experience_id: experience.experience_id, experience, actionRef: { ref_type: "action", ref_id: contract.id, episode_id: seed1.epId }, outcomeRef: { ref_type: "outcome", ref_id: "hout-fail" }, counterexample: true });
	check("a verified same-episode postcondition failure is a real counterexample", feedbackFail.verified_counterexample === true && feedbackFail.counts_as_negative === true && feedbackFail.pause_recommended === true, JSON.stringify(feedbackFail.counterexample_checks));
	// A caller boolean alone is never enough: the SAME trusted failure with a
	// WRONG action ref (different episode/action) is association-only.
	const feedbackMismatch = engineFail.associateFeedback({ experience_id: experience.experience_id, experience, actionRef: { ref_type: "action", ref_id: contract.id, episode_id: seed0.epId }, outcomeRef: { ref_type: "outcome", ref_id: "hout-fail" }, counterexample: true });
	check("a caller-supplied counterexample with a mismatched action/outcome is not verified", feedbackMismatch.verified_counterexample === false && feedbackMismatch.counts_as_negative === false, JSON.stringify(feedbackMismatch.counterexample_checks));
	const scopeChange = engine.associateFeedback({ experience_id: experience.experience_id, actionRef: seed0.actionRef, outcomeRef: seed0.outId, scopeChange: true });
	check("a trusted scope change recommends pausing but never a fabricated success", scopeChange.pause_recommended === true && scopeChange.causal === false, JSON.stringify(scopeChange));

	// contribution: a verified advance requires the real bound data + outcome
	const contrib = engine.recordContribution({ episode_id: seed1.epId, dataRef: seed1.dataRef, actionRef: seed1.actionRef, useRefs: [seed1.dataRef], outcome: { ref_type: "outcome", ref_id: seed1.outId }, stage: "advance" });
	check("a verified advance contribution is association-only, never causal", contrib.status === "verified_use" && contrib.causal === false && contrib.association_only === true, JSON.stringify({ status: contrib.status, reasons: contrib.reasons }));
	const contribBad = engine.recordContribution({ episode_id: seed1.epId, dataRef: seed0.dataRef, actionRef: seed1.actionRef, outcome: { ref_type: "outcome", ref_id: seed1.outId }, stage: "advance" });
	check("a foreign data ref does not verify an advance", contribBad.status !== "verified_use", JSON.stringify({ status: contribBad.status }));

	await log.close();
	rmSync(base, { recursive: true, force: true });
	if (failures > 0) {
		console.error(`aegis-workflow-engine-d FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-workflow-engine-d ok");
}

main().catch((error) => {
	console.error(`aegis-workflow-engine-d: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
