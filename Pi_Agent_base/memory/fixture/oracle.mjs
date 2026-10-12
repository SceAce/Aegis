// Independent deterministic Oracle for the fixture direct slice.
//
// The Oracle is the only writer allowed to judge task success. It:
//   1. validates the raw event log hash chain and the trusted run record,
//   2. re-hashes the real fixture file it observed before the action to
//      establish the verified precondition (never trusting manifest.initial_snapshot),
//   3. re-hashes the real fixture file after the action to establish the
//      postcondition,
//   4. separates task success from transport success,
//   5. for a success, independently re-executes the exact registered primitive
//      against a fresh isolated fixture seeded from the trusted observed
//      pre-state; only a genuine reproduction sets reproducibility.replayable
//      and emits a hash-chained replay.verified note plus a self-verifying
//      replay-proof.json artifact (the original fixture is never touched),
//   6. records outcome.recorded events and writes Event/Episode/Outcome
//      projections the Compiler can consume.
//
// The Oracle never reads the agent's final message or any producer-authored
// result text as a success signal.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	SCHEMA_VERSION,
	createEventWriter,
	digest,
	evaluatePredicates,
	isoNow,
	newId,
	readJson,
	readJsonl,
	resolveInside,
	source,
	validateEventLog,
	valuesForPredicates,
	writeJson,
	writeJsonAtomic,
} from "./contracts.mjs";
import { actionSpecDigest, executeAction, getAction, validateActionArguments } from "./action-registry.mjs";

export const ORACLE_VERSION = "0.1.0";
const ORACLE_ID = "fixture-file-state-oracle";
const REPLAY_DRIVER_ID = "fixture-replay-driver";

function makeOutcome({ level, episodeId, stepId, criterion, status, observed, transport, evidence, failureMode, independenceGroup, reproducibility }) {
	const outcome = {
		schema_version: SCHEMA_VERSION,
		outcome_id: newId(),
		level,
		episode_id: episodeId,
		...(stepId ? { step_id: stepId } : {}),
		status,
		criterion,
		observed: status === "unknown" || status === "invalid" ? null : observed,
		oracle: {
			oracle_id: ORACLE_ID,
			method: "independent_json_state_rehash",
			version: ORACLE_VERSION,
			independence_group: independenceGroup,
		},
		evidence_refs: evidence,
		transport,
		failure_mode: failureMode,
		reproducibility: reproducibility || {
			replayable: false,
			replay_hash: digest({ criterion, observed, transport }),
			replay_count: 0,
			checked_at: isoNow(),
		},
		assessed_at: isoNow(),
	};
	return outcome;
}

// Independently re-execute the registered primitive against a FRESH isolated
// fixture initialized from the trusted observed pre-state. This is the only
// thing that may mark an outcome replayable. The original fixture is never
// touched: replay runs inside a throwaway temp directory and the temp root is
// always removed. On any failure it returns `ok:false` and no proof, so the
// caller must keep `reproducible:false` and the Compiler must not activate.
export function replayIsolatedOutcome({ manifest, run, requested, episodeId }) {
	const reasons = [];
	const fail = (reason) => {
		reasons.push(reason);
		return { ok: false, reasons, proof: null };
	};

	const action = getAction(manifest?.action?.action_id);
	if (!action) return fail(`action is not registered: ${manifest?.action?.action_id}`);
	const relativePath = run?.fixture_relative_path;
	if (typeof relativePath !== "string" || relativePath.length === 0) return fail("run.fixture_relative_path is missing");
	const args = { path: relativePath };
	const argCheck = validateActionArguments(action, args);
	if (!argCheck.ok) return fail(`replay arguments are invalid: ${argCheck.reason}`);

	// Bind the replay to the exact recorded intent: same registered action, same
	// tool/operation, same target argument. Free text is never replayed.
	if (!requested) return fail("no action.requested event to replay");
	if (requested.payload?.action_ref !== action.id) return fail("recorded action_ref does not match the registered action");
	if (requested.payload?.tool_name !== action.tool) return fail("recorded tool_name does not match the registered action");
	if (requested.payload?.operation !== action.operation) return fail("recorded operation does not match the registered action");
	if (requested.payload?.arguments?.path !== relativePath) return fail("recorded action arguments do not match the trusted target");

	let tempRoot = null;
	try {
		tempRoot = mkdtempSync(join(tmpdir(), "aegis-fixture-replay-"));
		const fixtureRoot = join(tempRoot, "fixture");
		mkdirSync(fixtureRoot, { recursive: true });
		// Seed the isolated fixture from the trusted observed pre-state, then
		// re-read it so provenance is a real file digest, not a declaration.
		const seedPath = resolveInside(fixtureRoot, relativePath);
		writeJsonAtomic(seedPath, run.initial_state);
		const observedPreState = readJson(seedPath);
		const preStateDigest = digest(observedPreState);
		if (preStateDigest !== run.initial_state_digest) {
			return fail("isolated replay pre-state does not match the trusted observation digest");
		}

		const transport = executeAction(action.id, { fixtureRoot, arguments: args });
		let postState;
		try {
			postState = readJson(resolveInside(fixtureRoot, relativePath, { mustExist: true }));
		} catch (error) {
			return fail(`isolated replay post-state is unreadable: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (transport.tool_ok !== true) return fail(`isolated replay transport failed: ${transport.failure_mode || "tool_error"}`);
		if (!evaluatePredicates(postState, manifest.state.postconditions)) return fail("isolated replay post-state does not satisfy the manifest postconditions");

		const core = {
			schema_version: SCHEMA_VERSION,
			proof_type: "isolated_fixture_replay",
			oracle_id: ORACLE_ID,
			oracle_version: ORACLE_VERSION,
			episode_id: episodeId,
			run_id: run.run_id,
			action_ref: action.id,
			action_spec_digest: actionSpecDigest(action),
			arguments: args,
			pre_state_digest: preStateDigest,
			post_state: postState,
			postconditions_verified: true,
			transport: {
				tool_ok: transport.tool_ok === true,
				exit_code: transport.exit_code ?? null,
				timed_out: transport.timed_out ?? null,
				duration_ms: transport.duration_ms ?? null,
			},
			isolated: true,
			replayed_at: isoNow(),
		};
		return { ok: true, reasons, proof: { ...core, proof_digest: digest(core) } };
	} catch (error) {
		return fail(`isolated replay error: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	}
}

function transportFor(completed) {
	const transport = completed?.payload?.transport || {};
	return {
		tool_ok: transport.tool_ok === true,
		exit_code: transport.exit_code ?? null,
		timed_out: transport.timed_out ?? null,
		duration_ms: transport.duration_ms ?? null,
	};
}

// Validate the trusted run record and confirm the observed pre-state matches the
// recorded initial digest. Returns { ok, reason, run }.
export function validateRunRecord(root) {
	const runPath = join(root, "run.json");
	if (!existsSync(runPath)) return { ok: false, reason: "run.json is missing" };
	let run;
	try {
		run = readJson(runPath);
	} catch (error) {
		return { ok: false, reason: `run.json unreadable: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (run.schema_version !== SCHEMA_VERSION) return { ok: false, reason: "run.json schema_version mismatch" };
	if (run.initial_state === undefined || run.initial_state === null) return { ok: false, reason: "run.json has no initial_state" };
	const recomputed = digest(run.initial_state);
	if (recomputed !== run.initial_state_digest) {
		return { ok: false, reason: "run.json initial_state does not match its recorded digest" };
	}
	if (typeof run.fixture_root !== "string" || !existsSync(run.fixture_root)) {
		return { ok: false, reason: "run.json fixture_root is missing" };
	}
	// Independently re-hash the trusted snapshot the runner persisted.
	const snapshotPath = join(root, run.trusted_initial_state_path || "trusted-initial-state.json");
	if (!existsSync(snapshotPath)) return { ok: false, reason: "trusted initial-state snapshot is missing" };
	let snapshot;
	try {
		snapshot = readJson(snapshotPath);
	} catch (error) {
		return { ok: false, reason: `trusted snapshot unreadable: ${error instanceof Error ? error.message : String(error)}` };
	}
	const snapshotDigest = digest(snapshot);
	if (snapshotDigest !== run.initial_state_digest) {
		return { ok: false, reason: "trusted snapshot does not match the recorded initial_state_digest" };
	}
	return { ok: true, run, recomputed, snapshot, snapshotDigest };
}

// Confirm the trusted observation event exists and its recorded value digest
// matches the run record. This is what makes the precondition "verified live".
function findTrustedObservation(events, run) {
	return events.find(
		(event) =>
			event.event_type === "observation.captured" &&
			event.payload?.source === "trusted_runner" &&
			event.payload?.run_id === run.run_id &&
			event.payload?.value_digest === run.initial_state_digest,
	);
}

// Read the fixture state through the boundary.
function readBoundaryFile(fixtureRoot, relativePath, run) {
	const targetPath = resolveInside(fixtureRoot, relativePath, { mustExist: true });
	if (!existsSync(targetPath)) return { ok: false, reason: "fixture file is missing", state: null };
	try {
		const state = readJson(targetPath);
		return { ok: true, state, path: targetPath };
	} catch (error) {
		return { ok: false, reason: `cannot parse fixture: ${error instanceof Error ? error.message : String(error)}`, state: null, run };
	}
}

// The Oracle records outcomes against a completed Host run directory. It never
// mutates the fixture except to append oracle events/projections.
export function judgeRun(root) {
	const manifest = readJson(join(root, "manifest.json"));
	const rawEvents = readJsonl(join(root, "events.jsonl"));

	const result = {
		root,
		manifest,
		rawEvents,
		projectedEvents: rawEvents,
		episode: null,
		outcomes: [],
		stepOutcome: null,
		episodeOutcome: null,
		status: "invalid",
		transport: null,
		valid: false,
		reasons: [],
	};

	// 1. Event chain integrity.
	try {
		validateEventLog(rawEvents);
	} catch (error) {
		result.reasons.push(`event chain invalid: ${error instanceof Error ? error.message : String(error)}`);
		return result;
	}

	// 2. Trusted run record and its consistency with the observation event.
	const runCheck = validateRunRecord(root);
	if (!runCheck.ok) {
		result.reasons.push(`trusted run record invalid: ${runCheck.reason}`);
		return result;
	}
	const run = runCheck.run;
	const started = rawEvents.find((event) => event.event_type === "episode.started" && event.episode_id);
	if (!started) {
		result.reasons.push("no episode.started event");
		return result;
	}
	const episodeEvents = rawEvents.filter((event) => event.episode_id === started.episode_id);
	const observation = findTrustedObservation(episodeEvents, run);
	if (!observation) {
		result.reasons.push("no trusted observation.captured event matching the run record");
		return result;
	}

	const request = episodeEvents.find((event) => event.event_type === "action.requested");
	const completed = episodeEvents
		.filter((event) => event.event_type === "action.completed")
		.find((event) => event.payload?.action_id === request?.payload?.action_id)
		|| episodeEvents.find((event) => event.event_type === "action.completed");
	const transport = transportFor(completed);

	// 3. The trusted observation event must be consistent with the run record.
	if (digest(observation.payload.value) !== run.initial_state_digest) {
		result.reasons.push("trusted observation event value does not match the run record");
		result.transport = transport;
		result.status = "invalid";
		return result;
	}
	// Verify the declared precondition against the trusted observed state.
	if (!evaluatePredicates(observation.payload.value, manifest.state.preconditions)) {
		result.reasons.push("trusted observed state does not satisfy declared preconditions");
		result.transport = transport;
		result.status = "invalid";
		return result;
	}

	const fixtureRoot = run.fixture_root;
	const relativePath = run.fixture_relative_path;

	// 4. Verify the trusted pre-action snapshot (persisted before the action) still
	// matches the run record. This is the independently re-hashed precondition; we
	// do NOT expect the live fixture to still hold the pre-action state.
	const preMatches = runCheck.snapshotDigest === run.initial_state_digest;

	// 5. Observe the post-action state directly.
	let postState = { ok: false, state: null, reason: "not read" };
	try {
		postState = readBoundaryFile(fixtureRoot, relativePath, run);
	} catch (error) {
		postState = { ok: false, state: null, reason: error instanceof Error ? error.message : String(error) };
	}

	// 6. Decide the outcome. Precondition mismatch -> invalid (unusable evidence).
	let status = "unknown";
	let failureMode = "insufficient_evidence";
	if (!preMatches) {
		status = "invalid";
		failureMode = "environment_changed";
	} else if (!postState.ok) {
		status = "unknown";
		failureMode = "insufficient_evidence";
	} else if (!request || !completed) {
		status = "unknown";
		failureMode = "insufficient_evidence";
	} else if (!transport.tool_ok) {
		// A failed/rejected/timed-out transport is never a task failure on its own
		// (MEMORY_SCHEMA 5.2). The action was not verified as the cause.
		status = "unknown";
		failureMode = transport.timed_out ? "timeout" : "tool_error";
	} else if (evaluatePredicates(postState.state, manifest.state.postconditions)) {
		status = "success";
		failureMode = undefined;
	} else {
		status = "failure";
		failureMode = "postcondition_failed";
	}

	if (status === "invalid") {
		result.reasons.push(failureMode === "environment_changed" ? "fixture changed between trusted observation and action" : "precondition could not be verified");
	}
	result.transport = transport;
	result.status = status;
	result.run = run;

	// 7. Replay and outcome writes are append-only. A repeated judgment of the
	// same episode must not duplicate outcomes, corrupt the hash chain, or
	// rewrite the replay proof, so it fails clearly before any write.
	const priorOutcomes = rawEvents.filter((event) => event.event_type === "outcome.recorded");
	if (priorOutcomes.length > 0) {
		throw new Error(
			`oracle refused to re-judge ${root}: the append-only event log already contains ${priorOutcomes.length} outcome.recorded event(s); refusing to duplicate outcomes`,
		);
	}

	// 7b. Independent replay before any outcome is recorded. A success is marked
	// replayable ONLY when a fresh isolated fixture, seeded from the trusted
	// observed pre-state, reproduces the postconditions by re-executing the exact
	// registered primitive. The live fixture is never touched; replay runs in a
	// throwaway temp directory that is always removed.
	const expected = Object.fromEntries(manifest.state.postconditions.map((predicate) => [predicate.path, predicate.value]));
	const observedValues = postState.ok ? valuesForPredicates(postState.state, manifest.state.postconditions) : null;
	const criterion = { criterion_id: manifest.goal.goal_id, description: manifest.goal.description, expected };
	let replay = null;
	let replayReason = null;
	if (status === "success") {
		replay = replayIsolatedOutcome({ manifest, run, requested: request, episodeId: started.episode_id });
		if (!replay.ok) {
			replayReason = replay.reasons.join("; ");
			result.reasons.push(`isolated replay did not reproduce the success: ${replayReason}`);
		}
	}
	const replayable = Boolean(replay?.ok);
	const reproducibility = replayable
		? { replayable: true, replay_hash: replay.proof.proof_digest, replay_count: 1, checked_at: isoNow() }
		: { replayable: false, replay_hash: digest({ criterion, observed: observedValues, transport }), replay_count: 0, checked_at: isoNow() };
	result.replayable = replayable;
	result.replayProof = replay?.proof || null;
	result.reproducibility = reproducibility;
	if (replayable) writeJson(join(root, "replay-proof.json"), replay.proof);

	// 8. Write outcome events + projections. Even invalid/unknown runs are
	// recorded so the audit trail is complete; they just cannot support active.
	//
	// The Oracle owns the append-only event stream: outcome events are appended
	// through the confirmed-append writer, never by rewriting events.jsonl.
	const writer = createEventWriter(rawEvents, { persistPath: join(root, "events.jsonl") });
	const oracleSource = source(ORACLE_ID, "oracle", "fixture-oracle", ORACLE_VERSION);
	const replaySource = source(REPLAY_DRIVER_ID, "replay", "fixture-replay", ORACLE_VERSION);
	let sequence = Math.max(...episodeEvents.map((event) => Number(event.sequence)).filter(Number.isInteger), -1) + 1;

	// Anchor the replay in the hash-chained event log so its provenance is
	// auditable and tamper-evident, not just a flag on the outcome projection.
	let replayNote = null;
	if (status === "success") {
		if (replayable) {
			replayNote = writer.emit(
				"note",
				started.episode_id,
				sequence++,
				{
					kind: "replay.verified",
					method: "isolated_fixture_replay",
					run_id: run.run_id,
					action_ref: replay.proof.action_ref,
					action_spec_digest: replay.proof.action_spec_digest,
					pre_state_digest: replay.proof.pre_state_digest,
					proof_digest: replay.proof.proof_digest,
					postconditions_verified: true,
				},
				replaySource,
				{ evidence_refs: [{ ref_type: "event", ref_id: observation.event_id }] },
			);
		} else {
			replayNote = writer.emit(
				"note",
				started.episode_id,
				sequence++,
				{ kind: "replay.failed", method: "isolated_fixture_replay", run_id: run.run_id, reason: replayReason },
				replaySource,
			);
		}
	}

	const stepId = `step-${newId()}`;
	const independenceGroup = run.independence_group;
	const evidence = [
		...(completed ? [{ ref_type: "event", ref_id: completed.event_id }] : []),
		{ ref_type: "event", ref_id: observation.event_id },
	];
	if (replayable) {
		evidence.push({ ref_type: "artifact", ref_id: "replay-proof.json", digest: replay.proof.proof_digest });
		if (replayNote) evidence.push({ ref_type: "event", ref_id: replayNote.event_id });
	}

	const stepOutcome = makeOutcome({
		level: "step",
		episodeId: started.episode_id,
		stepId,
		criterion: { ...criterion, criterion_id: `${criterion.criterion_id}:step` },
		status,
		observed: observedValues,
		transport,
		evidence,
		failureMode,
		independenceGroup,
		reproducibility,
	});
	const stepEvent = writer.emit(
		"outcome.recorded",
		started.episode_id,
		sequence++,
		{ outcome_id: stepOutcome.outcome_id, level: "step", status, ...(failureMode ? { failure_mode: failureMode } : {}) },
		oracleSource,
		{ causation_id: completed?.event_id || observation.event_id, evidence_refs: evidence },
	);
	const episodeOutcome = makeOutcome({
		level: "episode",
		episodeId: started.episode_id,
		criterion,
		status,
		observed: observedValues,
		transport,
		evidence: [{ ref_type: "event", ref_id: stepEvent.event_id }, ...evidence],
		failureMode,
		independenceGroup,
		reproducibility,
	});
	const episodeEvent = writer.emit(
		"outcome.recorded",
		started.episode_id,
		sequence++,
		{ outcome_id: episodeOutcome.outcome_id, level: "episode", status, ...(failureMode ? { failure_mode: failureMode } : {}) },
		oracleSource,
		{ causation_id: stepEvent.event_id, evidence_refs: episodeOutcome.evidence_refs },
	);
	const projectedEvents = writer.all();

	// Re-validate the projected chain so a broken append is caught here.
	validateEventLog(projectedEvents);

	const episodeStatus = status === "success" ? "completed" : status === "failure" ? "completed" : status === "invalid" ? "invalid" : "aborted";
	const episode = {
		schema_version: SCHEMA_VERSION,
		episode_id: started.episode_id,
		status: episodeStatus,
		source_kind: "live",
		goal: manifest.goal,
		authorization: manifest.authorization,
		environment: manifest.environment,
		started_at: started.occurred_at,
		ended_at: episodeEvent.occurred_at,
		event_ids: projectedEvents.filter((event) => event.episode_id === started.episode_id).map((event) => event.event_id),
		steps: [{
			step_id: stepId,
			index: 0,
			action_event_id: request?.event_id || observation.event_id,
			observation_event_ids: [observation.event_id],
			step_outcome_id: stepOutcome.outcome_id,
		}],
		episode_outcome_id: episodeOutcome.outcome_id,
		provenance: {
			source_refs: [`experiment:${manifest.experiment_id}`, "events.jsonl", "run.json"],
			adapter: "fixture-oracle",
			adapter_version: ORACLE_VERSION,
		},
		episode_digest: digest({ episodeId: started.episode_id, eventIds: projectedEvents.map((event) => event.event_id), outcome: episodeOutcome.outcome_id }),
	};

	writeJson(join(root, "episodes.json"), [episode]);
	writeJson(join(root, "outcomes.json"), [stepOutcome, episodeOutcome]);
	writeJson(join(root, "oracle-report.json"), {
		schema_version: SCHEMA_VERSION,
		oracle_version: ORACLE_VERSION,
		experiment_id: manifest.experiment_id,
		oracle: { id: ORACLE_ID, method: "independent_json_state_rehash" },
		status,
		failure_mode: failureMode || null,
		transport,
		checks: {
			event_chain_valid: true,
			trusted_run_record: runCheck.ok,
			trusted_observation_present: true,
			trusted_snapshot_matches_run: preMatches,
			precondition_verified: true,
			pre_action_matches_observation: preMatches,
			post_state_readable: postState.ok,
			postconditions_verified: postState.ok ? evaluatePredicates(postState.state, manifest.state.postconditions) : false,
			replay_verified: replayable,
			replay_isolated: replayable,
		},
		reproducibility,
		replay: replayable
			? { proof_path: "replay-proof.json", proof_digest: replay.proof.proof_digest, replay_count: 1 }
			: { proof_path: null, reason: replayReason },
		reasons: result.reasons,
		warnings: ["Live state evidence is current-environment evidence; replayable evidence is an isolated re-execution of the registered primitive, not a re-run of free text."],
	});

	result.projectedEvents = projectedEvents;
	result.episode = episode;
	result.outcomes = [stepOutcome, episodeOutcome];
	result.stepOutcome = stepOutcome;
	result.episodeOutcome = episodeOutcome;
	result.valid = true;
	return result;
}
