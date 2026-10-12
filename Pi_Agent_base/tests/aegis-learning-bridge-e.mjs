// Aegis Batch E — the thin learning bridge over the COMMITTED event log.
//
// This test exercises the production entry point the Observer/library path uses:
// `createLearningBridge`. It proves, on a REAL registered Node script driven by a
// REAL broker, that:
//
//   1. the ONE trusted resolver is built from the committed log (chain-verified)
//      and BOTH the C2 `resolveRef` dialect and the D `resolveSupport` dialect
//      map to the SAME record (no private Map, no model proposal);
//   2. a candidate proposal with a missing gap stays a candidate (never active);
//   3. two independent, committed, verified proofs compile to a canonical ACTIVE
//      Experience through the reviewed compiler;
//   4. routing on that active Experience reaches habit -> bound -> direct, and a
//      direct execution runs the registered script with 0 model calls;
//   5. with NO replay adapter the bridge refuses a replay (writes no fake reset);
//   6. a candidate (non-active) Experience is never hinted.
//
// It runs offline: no network, no model. Run:
//   node Pi_Agent_base/tests/aegis-learning-bridge-e.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionRegistry, createActionBroker } from "../memory/runtime/action-contract.mjs";
import { digest, EventLog } from "../memory/runtime/events.mjs";
import {
	buildProductionResolver,
	createLearningBridge,
	episodeResetStatus,
	loadReplayAdapter,
	mapResolveRefToSupport,
} from "../memory/runtime/learning-bridge.mjs";
import { compile, learn, replay, route } from "../memory/runtime/learning-commands.mjs";
import { authoritativeActiveExperiences, createLearningStore } from "../memory/runtime/learning-store.mjs";
import { createScriptRegistry, executableDigest, scriptContracts } from "../memory/runtime/script-registry.mjs";

let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

const SRC = {
	runtime: { actor_id: "aegis-runtime", kind: "runtime", adapter: "e-bridge", version: "1.0.0" },
	oracle: { actor_id: "registered-stage-oracle", kind: "oracle", adapter: "json-post-state", version: "1.0.0" },
	replay: { actor_id: "registered-stage-replay", kind: "replay", adapter: "read-only-recheck", version: "1.0.0" },
};

const STAGE_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";
const [inputPath, outPath] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const post = { stage: "done", token: input.token, from: input.stage };
writeFileSync(outPath, JSON.stringify(post));
process.stdout.write(JSON.stringify({ ok: true, out: outPath }) + "\\n");
`;

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-learning-bridge-"));
	const workspaceRoot = join(base, "workspace");
	mkdirSync(workspaceRoot, { recursive: true });
	const scriptPath = join(base, "stage.mjs");
	writeFileSync(scriptPath, STAGE_SCRIPT);
	for (const i of [0, 1, 2])
		writeFileSync(join(workspaceRoot, `input-${i}.json`), JSON.stringify({ stage: "start", token: "shared" }));

	const environment = {
		environment_fingerprint: "local-workspace",
		domain: "script.stage",
		permissions: ["workspace-script"],
		task_types: ["stage"],
	};
	const registration = {
		schema_version: "1.0",
		id: "stage-advance",
		version: 1,
		executable: process.execPath,
		executable_digest: executableDigest(process.execPath),
		script_path: scriptPath,
		script_digest: executableDigest(scriptPath),
		argv_template: [scriptPath, "{input}", "{out}"],
		allowed_root: workspaceRoot,
		cwd: workspaceRoot,
		parameters: {
			input: { type: "string", required: true, direction: "in" },
			out: { type: "string", required: true, direction: "out" },
		},
		environment_fingerprint: environment.environment_fingerprint,
		domain: environment.domain,
		permissions: [...environment.permissions],
		task_types: [...environment.task_types],
		verify: ({ observed }) => {
			const outPath = observed?.resource_bindings?.out;
			if (!outPath) return { ok: false, reason: "no bound output path to re-read" };
			let post;
			try {
				post = JSON.parse(readFileSync(outPath, "utf8"));
			} catch (error) {
				return {
					ok: false,
					reason: `could not re-read the JSON post-state: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			if (post.stage !== "done") return { ok: false, reason: `post-state stage is ${post.stage}`, observed: post };
			return { ok: true, reason: "independent JSON post-state re-read agrees", observed: post };
		},
	};
	const scriptRegistry = createScriptRegistry({ scripts: [registration] });
	const contracts = scriptContracts(scriptRegistry);
	const contract = contracts[0];
	const registry = new ActionRegistry(contracts);
	const broker = createActionBroker({ registry });
	const authorization = {
		mode: "auto",
		workspaceRoot,
		allowedTools: ["aegis_script"],
		allowNetwork: false,
		approved: true,
	};

	const log = new EventLog(join(base, "events.jsonl"));
	await log.open();

	// A vacuous resolver for the exploratory runs (execution does not need proofs).
	const exploratoryBridge = createLearningBridge({ events: [], registry, broker, authorization, environment });

	// The REAL isolated replay adapter, written by the human/test harness to a
	// module file (never an LLM exec string, never eval'd). It performs a fresh
	// read-only re-check of the pinned pre-state and does NOT re-run the original
	// (non-idempotent) target script.
	const adapterModulePath = join(base, "replay-adapter.mjs");
	writeFileSync(
		adapterModulePath,
		`import { createHash } from "node:crypto";
function stable(value) {
	if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
	if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
	return JSON.stringify(value);
}
const digest = (v) => "sha256:" + createHash("sha256").update(stable(v)).digest("hex");
export const replayAdapter = {
	id: "e-bridge-readonly",
	isolated: true,
	replay({ priorPreState, arguments: args, contract, criterion }) {
		// The read-only re-check rebuilds the expected post-state from the pinned
		// pre-state; a mismatch in the criterion would refuse the replay.
		const post = { stage: "done", token: priorPreState.token, applied: args?.input ?? null };
		const ok = post.stage === criterion.value;
		return {
			ok,
			isolated: true,
			isolation_ref: "fresh-" + (args?.input ?? "reset"),
			action_ref: contract.id,
			implementation_digest: contract.implementation_digest,
			arguments_digest: digest(args),
			pre_state_digest: digest(priorPreState),
			post_state_digest: digest(post),
			criterion_verified: ok,
			replay_count: 1,
			replay_hash: digest({ post, ok }),
		};
	}
};
`,
	);
	const loadedAdapter = await loadReplayAdapter(adapterModulePath);
	check(
		"the configured isolated replay adapter module loads",
		loadedAdapter.configured === true && loadedAdapter.adapter !== null,
		JSON.stringify({ configured: loadedAdapter.configured, reason: loadedAdapter.reason }),
	);
	const buildBridge = () =>
		createLearningBridge({
			events: log.replay(),
			registry,
			broker,
			authorization,
			environment,
			replayAdapter: loadedAdapter.adapter,
			sink: { append: (row) => log.append(row) },
		});

	const runs = [];
	for (const i of [0, 1]) {
		const epId = `ep-${i}`;
		const runId = `run-${i}`;
		const outId = `out-${i}`;
		const group = `group-${i}`;
		const isolation = `reset-${i}`;
		const dataRef = { ref_type: "data", ref_id: `data-${i}` };
		const stateRef = { ref_type: "data", ref_id: `state-${i}` };
		const preState = { stage: "start", token: "shared" };
		await log.append({
			event_type: "episode.started",
			episode_id: epId,
			payload: { task_id: "task-E", goal: "advance the staged fixture" },
			source: SRC.runtime,
		});
		await log.append({
			event_type: "runtime.note",
			episode_id: epId,
			payload: {
				kind: "episode.isolated_reset",
				isolation_ref: isolation,
				independence_group: group,
				run_id: runId,
				adapter: "e-bridge",
			},
			source: SRC.runtime,
		});
		await log.append({
			event_type: "runtime.note",
			episode_id: epId,
			payload: { kind: "data.obtained", data_ref: dataRef, content_digest: digest(preState) },
			source: SRC.runtime,
		});
		await log.append({
			event_type: "runtime.note",
			episode_id: epId,
			payload: { kind: "data.obtained", data_ref: stateRef, value: { token: "shared" } },
			source: SRC.runtime,
		});
		await log.append({
			event_type: "action.requested",
			episode_id: epId,
			payload: {
				action_id: `act-${i}`,
				action_ref: contract.id,
				version: contract.version,
				implementation_digest: contract.implementation_digest,
				tool_name: contract.tool,
				run_id: runId,
				bound_arguments: [dataRef],
			},
			source: SRC.runtime,
		});

		const result = await exploratoryBridge.invokeExploratory({
			action_ref: contract.id,
			arguments: { input: `input-${i}.json`, out: `out-${i}.json` },
			context: { workspaceRoot, target_path: join(workspaceRoot, `input-${i}.json`) },
			episodeId: epId,
			currentState: preState,
		});
		check(
			`run ${i} executes the registered script and the Oracle confirms success`,
			result.status === "success" && result.classification === "success",
			JSON.stringify({ status: result.status, reason: result.verification?.reasons }),
		);
		const post = JSON.parse(readFileSync(join(workspaceRoot, `out-${i}.json`), "utf8"));
		check(`run ${i} wrote the real JSON post-state`, post.stage === "done" && post.token === "shared");

		const artifactValueDigest = digest(post);
		const artifactRef = { ref_type: "artifact", ref_id: `art-${i}`, digest: artifactValueDigest };
		const actionRef = { ref_type: "action", ref_id: contract.id };
		await log.append({
			event_type: "observation.captured",
			episode_id: epId,
			payload: {
				kind: "observation.captured",
				value: post,
				artifact_ref: artifactRef,
				content_digest: artifactValueDigest,
				verified: true,
				run_id: runId,
			},
			source: SRC.oracle,
			evidence_refs: [artifactRef],
		});
		await log.append({
			event_type: "action.completed",
			episode_id: epId,
			payload: {
				action_id: `act-${i}`,
				action_ref: contract.id,
				version: contract.version,
				implementation_digest: contract.implementation_digest,
				tool_name: contract.tool,
				run_id: runId,
			},
			source: SRC.runtime,
		});
		await log.append({
			event_type: "outcome.recorded",
			episode_id: epId,
			payload: {
				...result.step_outcome,
				outcome_id: outId,
				episode_id: epId,
				run_id: runId,
				level: "episode",
				status: "success",
				independent: true,
				criterion: { criterion_id: "stage-done", path: "stage", op: "eq", value: "done" },
				observed: { ...post, pre_state: preState, arguments: { input: `input-${i}.json`, out: `out-${i}.json` } },
				oracle: {
					oracle_id: "registered-stage-oracle",
					method: "independent_json_state_rehash",
					version: "1.0.0",
					independence_group: group,
					isolation_ref: isolation,
				},
				expect: [{ path: "stage", op: "eq", value: "done" }],
				when: [{ path: "token", op: "eq", value: "shared", verified_by: [outId] }],
				preconditions_verified: true,
				action_ref: contract.id,
				action_version: contract.version,
				implementation_digest: contract.implementation_digest,
				evidence_refs: [dataRef, actionRef, artifactRef],
				scope: { ...environment },
				transport: result.transport,
			},
			source: SRC.oracle,
			evidence_refs: [dataRef, actionRef, artifactRef],
		});
		// A genuine isolated replay record is produced by the REAL configured
		// adapter (not a hand-written note): rebuild the bridge from the now-committed
		// log and drive `replayOutcome`, which appends the trusted
		// `episode.isolated_reset` + `replay.performed` rows through the sink.
		const replayBridge = buildBridge();
		const replayResult = await replayBridge.replayOutcome({ outcomeId: outId, episodeId: epId });
		check(
			`run ${i} replays through the real isolated adapter and commits a durable replay record`,
			replayResult.ok === true && replayResult.isolated === true,
			JSON.stringify({ ok: replayResult.ok, reason: replayResult.reason }),
		);
		runs.push({ epId, outId, dataRef, stateRef, actionRef });
	}

	// ---- The bridge over the COMMITTED log ----------------------------------
	const events = log.replay();
	const resolver = buildProductionResolver({ events, scope: { task_id: "task-E" } });
	check(
		"the bridge resolver verifies the committed chain",
		resolver.chain_ok === true,
		JSON.stringify(resolver.errors),
	);

	// (1) The two dialects map to the SAME record.
	const outcomeRef = { ref_type: "outcome", ref_id: runs[0].outId };
	const dResolved = resolver.resolveSupport({ kind: "outcome", ref: outcomeRef });
	const c2Resolved = resolver.resolveRef({ kind: "outcome", ref: outcomeRef });
	check(
		"resolveRef and resolveSupport return the same committed Outcome",
		dResolved.ok === true && c2Resolved.ok === true && c2Resolved.record.outcome_id === dResolved.record.outcome_id,
	);
	// A mapping built standalone also works.
	const mapped = mapResolveRefToSupport(resolver);
	check(
		"the standalone C2 mapping returns a real record for a committed data ref",
		mapped({ kind: "data", ref: runs[0].dataRef }).ok === true,
	);

	// (2) A candidate proposal with a missing gap stays a candidate.
	const bridge = createLearningBridge({
		events,
		registry,
		broker,
		authorization,
		environment,
		replayAdapter: loadedAdapter.adapter,
		sink: { append: (row) => log.append(row) },
	});
	const candidate = bridge.bindCandidate({
		when: [{ path: "token", op: "eq", value: "shared" }, "free text predicate"],
		scope: { environment_fingerprint: environment.environment_fingerprint, domain: environment.domain },
		do: contract.id,
		arguments_template: { input: null, out: null },
	});
	check(
		"a proposal with a free-text `when` entry stays a candidate with an explicit gap",
		candidate.status === "candidate" &&
			candidate.executable === false &&
			candidate.gaps.some((g) => g.field === "when"),
	);
	check(
		"the binder never parses prose or evals",
		candidate.model_text_parsed === false && candidate.eval_used === false,
	);
	check("a candidate is not marked active", candidate.active === false);

	// (3) Two independent committed proofs compile to ACTIVE.
	const built = bridge.proofsFromOutcomeIds([runs[0].outId, runs[1].outId], {
		argumentsTemplates: { [runs[0].outId]: { input: null, out: null }, [runs[1].outId]: { input: null, out: null } },
	});
	check(
		"both committed outcomes resolve to compiler proofs",
		built.ok === true && built.proofs.length === 2,
		JSON.stringify(built.gaps),
	);
	const compiled = bridge.compileFromOutcomeIds({
		outcomeIds: [runs[0].outId, runs[1].outId],
		argumentsTemplates: { [runs[0].outId]: { input: null, out: null }, [runs[1].outId]: { input: null, out: null } },
	});
	check(
		"two resolved committed proofs compile to a canonical active Experience",
		compiled.status === "active",
		JSON.stringify(compiled.failures),
	);
	check(
		"the active Experience pins the real implementation digest",
		compiled.experience?.do?.implementation_digest === contract.implementation_digest,
	);

	// A ghost outcome id never becomes a proof.
	const ghost = bridge.proofsFromOutcomeIds(["ghost-outcome"]);
	check(
		"a ghost outcome id is a gap, never a fabricated proof",
		ghost.ok === false && ghost.proofs.length === 0 && ghost.gaps.length === 1,
	);

	// (4) Route habit -> bind -> direct, then execute with 0 model calls.
	const task = { task_id: "task-E", task_types: ["stage"], permissions: ["workspace-script"], arguments: {} };
	const stateRecord = resolver.resolveSupport({ kind: "data", ref: runs[0].stateRef });
	const currentStateRef = { ref_type: "data", ref_id: runs[0].stateRef.ref_id, digest: stateRecord.content_digest };
	const currentState = { token: "shared" };
	const routeDecision = bridge.route({
		experiences: [compiled.experience],
		task,
		currentState,
		currentStateRef,
		episodeId: runs[0].epId,
	});
	check(
		"the active Experience routes to habit with the missing resource params",
		routeDecision.route === "habit" &&
			routeDecision.missing_parameters.includes("input") &&
			routeDecision.missing_parameters.includes("out"),
		JSON.stringify({ route: routeDecision.route, missing: routeDecision.missing_parameters }),
	);
	check("a trusted current state is required to route", routeDecision.state_trusted === true);
	const bound = bridge.bindHabit({
		experiences: [compiled.experience],
		task,
		currentState,
		currentStateRef,
		bindings: { input: "input-2.json", out: "out-2.json" },
	});
	check(
		"binding the missing params re-checks to a direct route",
		bound.ok === true && bound.recheck?.route === "direct",
	);
	const finalRun = await bridge.executeDirect({
		experiences: [compiled.experience],
		task: { ...task, arguments: bound.arguments },
		context: { workspaceRoot, target_path: join(workspaceRoot, "input-2.json") },
		currentState,
		currentStateRef,
	});
	check(
		"direct execution runs the registered script with 0 model calls",
		finalRun.status === "success" &&
			finalRun.model_calls === 0 &&
			finalRun.route === "direct" &&
			finalRun.direct === true,
		JSON.stringify({ status: finalRun.status, route: finalRun.route, reason: finalRun.reason }),
	);

	// Routing with NO verified state falls back to hint/deliberate, never direct.
	const noState = bridge.route({ experiences: [compiled.experience], task, currentState: null, currentStateRef: null });
	check(
		"without a verified current-state ref the route is never direct",
		noState.route !== "direct",
		JSON.stringify({ route: noState.route, trusted: noState.state_trusted }),
	);

	// (6) A candidate (non-active) Experience is never hinted.
	const candidateExperience = { ...compiled.experience, experience_id: "candidate-exp", status: "candidate" };
	const candRoute = bridge.route({ experiences: [candidateExperience], task, currentState, currentStateRef });
	check(
		"a candidate Experience is filtered out of the hint surface",
		candRoute.candidates_filtered === 1 && candRoute.route !== "habit" && candRoute.route !== "direct",
		JSON.stringify({ route: candRoute.route, filtered: candRoute.candidates_filtered }),
	);

	// (5) No replay adapter -> refuse; the reset status is honest.
	const noAdapter = await loadReplayAdapter(null);
	check(
		"no configured replay adapter reports unconfigured",
		noAdapter.configured === false && noAdapter.adapter === null,
	);
	const noAdapterBridge = createLearningBridge({
		events,
		registry,
		broker,
		authorization,
		environment,
		sink: { append: (row) => log.append(row) },
	});
	const replayRefused = await noAdapterBridge.replayOutcome({ outcomeId: runs[0].outId });
	check(
		"a replay with no configured adapter is refused",
		replayRefused.ok === false && /adapter/i.test(replayRefused.reason ?? ""),
	);
	const resetStatus = episodeResetStatus(resolver, runs[0].epId);
	check(
		"a committed trusted reset is reported canonical (not invented)",
		resetStatus.ok === true &&
			resetStatus.status === "canonical" &&
			typeof resetStatus.isolation_ref === "string" &&
			resetStatus.isolation_ref.length > 0,
	);
	const noReset = episodeResetStatus(resolver, "missing-episode");
	check("an unknown episode is never reported as a canonical reset", noReset.ok !== true);

	// An unconfigured/malformed adapter module is refused, never silently ignored.
	const badAdapter = await loadReplayAdapter("/tmp/aegis-no-such-adapter-xyz.mjs");
	check(
		"a malformed replay adapter module is refused, not silently ignored",
		badAdapter.configured === true && badAdapter.adapter === null,
	);

	// ---- The human/Host command surface over the store ----------------------
	const store = createLearningStore({ dir: join(base, "experiences") });
	const learned = learn(
		{
			when: [{ path: "token", op: "eq", value: "shared" }],
			scope: { environment_fingerprint: environment.environment_fingerprint, domain: environment.domain },
			do: contract.id,
			arguments_template: { input: null, out: null },
		},
		bridge,
	);
	check(
		"`learn` binds a complete proposal but never activates it",
		learned.status === "bound" && learned.active === false,
	);

	const compiledCmd = await compile({
		proofIds: [runs[0].outId, runs[1].outId],
		bridge,
		store,
		argumentsTemplates: { [runs[0].outId]: { input: null, out: null }, [runs[1].outId]: { input: null, out: null } },
		experienceId: "exp-e-1",
		recordedAt: new Date().toISOString(),
	});
	check(
		"`compile` from committed proofs yields an active Experience AND stores it",
		compiledCmd.status === "active" && compiledCmd.stored === true && compiledCmd.active === true,
		JSON.stringify(compiledCmd.failures),
	);
	const storedRecord = await store.load("exp-e-1");
	check(
		"the stored record is marked active",
		storedRecord?.active === true && storedRecord?.experience?.status === "active",
	);

	// The authoritative `experience.compiled` note is emitted by the Observer's
	// command path in production. The unit test records it and rebuilds the bridge
	// so the store-validation gate (`authoritativeActiveExperiences`) can
	// cross-check the derived store against the committed note.
	await log.append({
		event_type: "runtime.note",
		episode_id: null,
		payload: {
			kind: "experience.compiled",
			status: compiledCmd.status,
			active: compiledCmd.active,
			experience_id: "exp-e-1",
			revision: 1,
			source_outcome_ids: [runs[0].outId, runs[1].outId],
			content_digest: compiledCmd.content_digest,
			stored: compiledCmd.stored,
			failures: [],
			gaps: [],
		},
		source: SRC.runtime,
	});
	bridge.refresh({ events: log.replay() });

	// A single-proof compile stays a CANDIDATE and is NOT loaded as active.
	const candidateOnly = await compile({
		proofIds: [runs[0].outId],
		bridge,
		store,
		argumentsTemplates: { [runs[0].outId]: { input: null, out: null } },
		experienceId: "exp-e-candidate",
	});
	check(
		"`compile` with a single proof stays a candidate",
		candidateOnly.status === "candidate" && candidateOnly.active === false,
	);
	const activeRecords = await store.loadActive();
	check(
		"only the active Experience is loadable for routing (candidate excluded)",
		activeRecords.length === 1 && activeRecords[0].experience_id === "exp-e-1",
		JSON.stringify(activeRecords.map((r) => r.experience_id)),
	);
	const candidateRoute = await route({ store, bridge, task, currentState, currentStateRef, episodeId: runs[0].epId });
	check(
		"`route` on the store reaches habit/direct (candidate is not eligible)",
		candidateRoute.route === "habit" && candidateRoute.active_experiences === 1,
		JSON.stringify({ route: candidateRoute.route, active: candidateRoute.active_experiences }),
	);

	// ---- The derived store is NOT a second truth source ---------------------
	// A projection is only eligible for direct routing when it aligns EXACTLY with
	// the committed `experience.compiled` note (id + revision + source proofs +
	// full content digest). A tampered / stale / missing projection must fall back
	// to candidate/deliberate, never direct.
	const recordPath = store.experiencePath("exp-e-1");
	const originalRecordText = readFileSync(recordPath, "utf8");
	check(
		"the authoritative gate admits the aligned active record",
		authoritativeActiveExperiences(await store.loadActive(), bridge.events).length === 1,
	);
	const mutateRecord = async (mutator) => {
		const current = JSON.parse(readFileSync(recordPath, "utf8"));
		mutator(current);
		writeFileSync(recordPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
		return authoritativeActiveExperiences(await store.loadActive(), bridge.events).length;
	};
	check(
		"a tampered content_digest is rejected by the authoritative gate",
		(await mutateRecord((r) => {
			r.content_digest = "sha256:tampered";
		})) === 0,
	);
	check(
		"a stale revision is rejected by the authoritative gate",
		(await mutateRecord((r) => {
			r.revision = 99;
		})) === 0,
	);
	check(
		"a swapped source_outcome_ids is rejected by the authoritative gate",
		(await mutateRecord((r) => {
			r.source_outcome_ids = ["ghost-outcome"];
		})) === 0,
	);
	check(
		"a MISSING content_digest is rejected (not skipped) by the authoritative gate",
		(await mutateRecord((r) => {
			delete r.content_digest;
		})) === 0,
	);
	check(
		"a MISSING source_outcome_ids is rejected (not skipped) by the authoritative gate",
		(await mutateRecord((r) => {
			delete r.source_outcome_ids;
		})) === 0,
	);
	check(
		"a swapped experience body is rejected even when the note digest is copied",
		(await mutateRecord((r) => {
			r.experience = { ...r.experience, do: { ...r.experience.do, action_ref: "script.attacker" } };
		})) === 0,
	);
	const tamperedRoute = await route({ store, bridge, task, currentState, currentStateRef, episodeId: runs[0].epId });
	check(
		"a tampered store record cannot route direct (candidate/deliberate fallback)",
		tamperedRoute.route !== "direct" && tamperedRoute.active_experiences === 0,
		JSON.stringify({ route: tamperedRoute.route, active: tamperedRoute.active_experiences }),
	);
	// A record with NO committed note at all is stale, not authoritative.
	const staleId = "exp-never-compiled";
	writeFileSync(
		store.experiencePath(staleId),
		`${JSON.stringify({ ...JSON.parse(originalRecordText), experience_id: staleId }, null, 2)}\n`,
		"utf8",
	);
	check(
		"a store record with no committed note is rejected as stale",
		authoritativeActiveExperiences(
			[{ ...JSON.parse(readFileSync(store.experiencePath(staleId), "utf8")) }],
			bridge.events,
		).length === 0,
	);
	rmSync(store.experiencePath(staleId), { force: true });
	writeFileSync(recordPath, originalRecordText, "utf8");
	const restoredRoute = await route({ store, bridge, task, currentState, currentStateRef, episodeId: runs[0].epId });
	check(
		"the restored active projection routes again (the store is rebuildable)",
		restoredRoute.route === "habit" && restoredRoute.active_experiences === 1,
		JSON.stringify({ route: restoredRoute.route, active: restoredRoute.active_experiences }),
	);

	// A real configured isolated replay adapter module drives a durable replay.
	const replayResult = await replay({ outcomeId: runs[0].outId, bridge, adapterPath: adapterModulePath });
	check(
		"a configured isolated adapter replays and reports configured",
		replayResult.configured === true && replayResult.ok === true,
		JSON.stringify({ configured: replayResult.configured, ok: replayResult.ok, reason: replayResult.reason }),
	);

	// ---- `adapterPath` result is REALLY used for replay ---------------------
	// A bridge built WITHOUT a pre-configured adapter must still replay through
	// the command's `adapterPath`; the loaded adapter is actually executed (a NEW
	// `replay.performed` row for a FRESH outcome), never silently ignored.
	const freshEp = "ep-fresh";
	const freshOut = "out-fresh";
	const freshData = { ref_type: "data", ref_id: "data-fresh" };
	const freshState = { token: "shared" };
	const freshArgs = { input: "input-fresh.json", out: "out-fresh.json" };
	const freshPost = { stage: "done", token: "shared", applied: "input-fresh.json" };
	const freshArtifact = { ref_type: "artifact", ref_id: "art-fresh", digest: digest(freshPost) };
	await log.append({
		event_type: "episode.started",
		episode_id: freshEp,
		payload: { task_id: "task-E", goal: "advance the staged fixture" },
		source: SRC.runtime,
	});
	await log.append({
		event_type: "runtime.note",
		episode_id: freshEp,
		payload: {
			kind: "episode.isolated_reset",
			isolation_ref: "reset-fresh",
			independence_group: "group-fresh",
			run_id: "run-fresh",
			adapter: "e-bridge",
		},
		source: SRC.runtime,
	});
	await log.append({
		event_type: "action.requested",
		episode_id: freshEp,
		payload: {
			action_id: "act-fresh",
			action_ref: contract.id,
			version: contract.version,
			implementation_digest: contract.implementation_digest,
			tool_name: contract.tool,
			run_id: "run-fresh",
		},
		source: SRC.runtime,
	});
	await log.append({
		event_type: "observation.captured",
		episode_id: freshEp,
		payload: {
			kind: "observation.captured",
			value: freshPost,
			content_digest: freshArtifact.digest,
			verified: true,
			run_id: "run-fresh",
		},
		source: SRC.oracle,
		evidence_refs: [freshArtifact],
	});
	await log.append({
		event_type: "action.completed",
		episode_id: freshEp,
		payload: {
			action_id: "act-fresh",
			action_ref: contract.id,
			version: contract.version,
			implementation_digest: contract.implementation_digest,
			tool_name: contract.tool,
			run_id: "run-fresh",
		},
		source: SRC.runtime,
	});
	await log.append({
		event_type: "outcome.recorded",
		episode_id: freshEp,
		payload: {
			schema_version: "1.0",
			outcome_id: freshOut,
			level: "episode",
			episode_id: freshEp,
			run_id: "run-fresh",
			status: "success",
			independent: true,
			criterion: { criterion_id: "stage-done", path: "stage", op: "eq", value: "done" },
			observed: { ...freshPost, pre_state: freshState, arguments: freshArgs },
			oracle: {
				oracle_id: "registered-stage-oracle",
				method: "independent_json_state_rehash",
				independence_group: "group-fresh",
				isolation_ref: "reset-fresh",
			},
			expect: [{ path: "stage", op: "eq", value: "done" }],
			when: [{ path: "token", op: "eq", value: "shared", verified_by: [freshOut] }],
			preconditions_verified: true,
			action_ref: contract.id,
			action_version: contract.version,
			implementation_digest: contract.implementation_digest,
			evidence_refs: [freshData, freshArtifact],
			scope: { ...environment },
		},
		source: SRC.oracle,
		evidence_refs: [freshData, freshArtifact],
	});
	// A bridge with NO pre-configured adapter: only the command `adapterPath` can
	// supply one.
	const bareBridge = createLearningBridge({
		events: log.replay(),
		registry,
		broker,
		authorization,
		environment,
		sink: { append: (row) => log.append(row) },
	});
	const bareRefused = await replay({ outcomeId: freshOut, bridge: bareBridge, adapterPath: null });
	check(
		"a bridge without a pre-configured adapter and without adapterPath refuses replay",
		bareRefused.configured === false && bareRefused.ok !== true,
		JSON.stringify(bareRefused),
	);
	const replayViaPath = await replay({ outcomeId: freshOut, bridge: bareBridge, adapterPath: adapterModulePath });
	check(
		"`learningCommands.replay` really executes through the adapterPath-loaded adapter",
		replayViaPath.configured === true && replayViaPath.ok === true && replayViaPath.duplicated !== true,
		JSON.stringify({
			configured: replayViaPath.configured,
			ok: replayViaPath.ok,
			duplicated: replayViaPath.duplicated,
			reason: replayViaPath.reason,
		}),
	);
	const freshReplayRows = log
		.replay()
		.filter((e) => e.payload?.kind === "replay.performed" && e.payload?.outcome_id === freshOut);
	check(
		"the adapterPath replay committed exactly one durable replay row for the fresh outcome",
		freshReplayRows.length === 1,
		JSON.stringify(freshReplayRows.length),
	);
	// A SECOND command builds a FRESH bridge over the committed log (exactly what
	// the Observer does), so the prior replay row is visible and the adapter is not
	// re-run. A stale in-memory bridge would append a second row; production never
	// reuses the bridge across commands.
	bareBridge.refresh({ events: log.replay() });
	const replayedAgain = await replay({ outcomeId: freshOut, bridge: bareBridge, adapterPath: adapterModulePath });
	const freshReplayRowsAfter = log
		.replay()
		.filter((e) => e.payload?.kind === "replay.performed" && e.payload?.outcome_id === freshOut);
	check(
		"a duplicate command replay is idempotent (adapter not re-run, no second row)",
		replayedAgain.ok === true && replayedAgain.duplicated === true && freshReplayRowsAfter.length === 1,
		JSON.stringify({ ok: replayedAgain.ok, duplicated: replayedAgain.duplicated, rows: freshReplayRowsAfter.length }),
	);

	await log.close();
	rmSync(base, { recursive: true, force: true });
	if (failures > 0) {
		console.error(`aegis-learning-bridge-e FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-learning-bridge-e ok");
}

main().catch((error) => {
	console.error(`aegis-learning-bridge-e: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
