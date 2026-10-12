// Aegis Batch D — the first end-to-end workflow on a REAL registered Node script.
//
// This is the "首个工作流" the D task describes: a deterministic, non-exploit
// stage-advance script in a temp dir, registered the human way (fixed Node
// executable, pinned script digest, fixed argv template, resource-bounded
// input/output params, and an independent JSON post-state Oracle). It is run
// TWICE, live, in controlled isolation; the two real runs are committed as
// Events, compiled into a canonical active Experience, then re-used on a THIRD
// fresh target through habit binding -> direct execution with 0 model calls.
//
// It also asserts the target/template proposition stays consistent: the two runs
// use different input files but the SAME rule (same action, same template
// shape), so no success-union / scope generalization is smuggled in.
//
// Run:
//   node Pi_Agent_base/tests/aegis-workflow-live-script-d.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventLog, digest } from "../memory/runtime/events.mjs";
import { createEvidenceResolver } from "../memory/runtime/evidence-resolver.mjs";
import { createWorkflowEngine } from "../memory/runtime/workflow-engine.mjs";
import { ActionRegistry, createActionBroker } from "../memory/runtime/action-contract.mjs";
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
	runtime: { actor_id: "aegis-runtime", kind: "runtime", adapter: "d-live", version: "1.0.0" },
	oracle: { actor_id: "registered-stage-oracle", kind: "oracle", adapter: "json-post-state", version: "1.0.0" },
	replay: { actor_id: "registered-stage-replay", kind: "replay", adapter: "read-only-recheck", version: "1.0.0" },
};

const STAGE_SCRIPT = `// Deterministic stage-advance worker. Reads a JSON pre-state and writes a JSON
// post-state. No network, no shell, no eval. Idempotent in value, but the
// runtime never assumes so.
import { readFileSync, writeFileSync } from "node:fs";

const [inputPath, outPath] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const post = { stage: "done", token: input.token, applied: input.token, from: input.stage };
writeFileSync(outPath, JSON.stringify(post));
process.stdout.write(JSON.stringify({ ok: true, out: outPath }) + "\\n");
`;

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-workflow-live-"));
	const workspaceRoot = join(base, "workspace");
	mkdirSync(workspaceRoot, { recursive: true });
	const scriptPath = join(base, "stage.mjs");
	writeFileSync(scriptPath, STAGE_SCRIPT);
	for (const i of [0, 1, 2]) writeFileSync(join(workspaceRoot, `input-${i}.json`), JSON.stringify({ stage: "start", token: "shared" }));

	const environment = { environment_fingerprint: "local-workspace", domain: "script.stage", permissions: ["workspace-script"], task_types: ["stage"] };

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
		independence_group: null,
		// The independent Oracle re-reads the JSON post-state from disk; it never
		// trusts the script's stdout or exit code.
		verify: ({ observed }) => {
			const outPath = observed?.resource_bindings?.out;
			if (!outPath) return { ok: false, reason: "no bound output path to re-read" };
			let post;
			try {
				post = JSON.parse(readFileSync(outPath, "utf8"));
			} catch (error) {
				return { ok: false, reason: `could not re-read the JSON post-state: ${error instanceof Error ? error.message : String(error)}` };
			}
			if (post.stage !== "done") return { ok: false, reason: `post-state stage is ${post.stage}`, observed: post };
			return { ok: true, reason: "independent JSON post-state re-read agrees", expected: { stage: "done" }, observed: post };
		},
	};

	const scriptRegistry = createScriptRegistry({ scripts: [registration] });
	const contracts = scriptContracts(scriptRegistry);
	const contract = contracts[0];
	const registry = new ActionRegistry(contracts);
	const broker = createActionBroker({ registry });
	const authorization = { mode: "auto", workspaceRoot, allowedTools: ["aegis_script"], allowNetwork: false, approved: true };

	const log = new EventLog(join(base, "events.jsonl"));
	await log.open();
	// The runner engine uses a vacuous resolver: execution does not need one.
	const runEngine = createWorkflowEngine({ registry, broker, resolver: createEvidenceResolver({ events: [] }), environment, authorization });

	const runs = [];
	for (const i of [0, 1]) {
		const epId = `lep-${i}`;
		const runId = `lrun-${i}`;
		const outId = `lout-${i}`;
		const group = `lgroup-${i}`;
		const isolation = `lreset-${i}`;
		const dataRef = { ref_type: "data", ref_id: `ldata-${i}` };
		const actionRef = { ref_type: "action", ref_id: contract.id };
		const preState = { stage: "start", token: "shared" };
		await log.append({ event_type: "episode.started", episode_id: epId, payload: { task_id: "task-L", goal: "advance the staged fixture" }, source: SRC.runtime });
		await log.append({ event_type: "runtime.note", episode_id: epId, payload: { kind: "episode.isolated_reset", isolation_ref: isolation, independence_group: group, run_id: runId, adapter: "d-live" }, source: SRC.runtime });
		await log.append({ event_type: "runtime.note", episode_id: epId, payload: { kind: "data.obtained", data_ref: dataRef, content_digest: digest(preState) }, source: SRC.runtime });
		// A committed current-state snapshot the router can verify (`token: shared`).
		const stateRef = { ref_type: "data", ref_id: `lstate-${i}` };
		await log.append({ event_type: "runtime.note", episode_id: epId, payload: { kind: "data.obtained", data_ref: stateRef, value: { token: "shared" } }, source: SRC.runtime });
		await log.append({ event_type: "action.requested", episode_id: epId, payload: { action_id: `lact-${i}`, action_ref: contract.id, version: contract.version, implementation_digest: contract.implementation_digest, tool_name: contract.tool, run_id: runId, bound_arguments: [dataRef] }, source: SRC.runtime });

		const result = await runEngine.invokeExploratory({
			action_ref: contract.id,
			arguments: { input: `input-${i}.json`, out: `out-${i}.json` },
			context: { workspaceRoot, target_path: join(workspaceRoot, `input-${i}.json`) },
			episodeId: epId,
			currentState: preState,
		});
		check(`live run ${i} executes the registered script and the Oracle confirms success`, result.status === "success" && result.classification === "success", JSON.stringify({ status: result.status, verification: result.verification?.reasons }));
		const post = JSON.parse(readFileSync(join(workspaceRoot, `out-${i}.json`), "utf8"));
		check(`live run ${i} wrote the real JSON post-state`, post.stage === "done" && post.token === "shared", JSON.stringify(post));

		// The artifact ref pins the digest of the COMMITTED observation value (the
		// JSON post-state the Oracle re-read), not the script stdout hash.
		const artifactRef = { ref_type: "artifact", ref_id: `lart-${i}`, digest: digest(post) };
		await log.append({ event_type: "observation.captured", episode_id: epId, payload: { kind: "observation.captured", value: post, artifact_ref: artifactRef, content_digest: artifactRef.digest, verified: true, run_id: runId }, source: SRC.oracle, evidence_refs: [artifactRef] });
		await log.append({ event_type: "action.completed", episode_id: epId, payload: { action_id: `lact-${i}`, action_ref: contract.id, version: contract.version, implementation_digest: contract.implementation_digest, tool_name: contract.tool, run_id: runId }, source: SRC.runtime });
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
				observed: { ...post, pre_state: preState, token: "shared", arguments: { input: `input-${i}.json`, out: `out-${i}.json` } },
				oracle: { oracle_id: "registered-stage-oracle", method: "independent_json_state_rehash", version: "1.0.0", independence_group: group, isolation_ref: isolation },
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
		// A genuine ISOLATED replay: a read-only re-check of the fresh post-state
		// (the non-idempotent script itself is never re-run).
		const recheck = JSON.parse(readFileSync(join(workspaceRoot, `out-${i}.json`), "utf8"));
		await log.append({ event_type: "runtime.note", episode_id: epId, payload: { kind: "replay.performed", replay_id: `replay:${epId}:${outId}`, outcome_id: outId, episode_id: epId, replayable: recheck.stage === "done", replay_count: 1, replay_hash: digest({ out: recheck, ok: true }), isolated: true, adapter: "read-only-recheck", pre_state_digest: digest(preState), post_state_digest: digest(recheck) }, source: SRC.replay });
		runs.push({ epId, outId, dataRef, actionRef, artifactRef, stateRef });
	}

	// ---- Compile from the two REAL runs --------------------------------------
	const resolver = createEvidenceResolver({ events: log.replay(), scope: { task_id: "task-L" } });
	check("the live chain verifies", resolver.chain_ok === true, JSON.stringify(resolver.errors));
	const runner = createWorkflowEngine({ registry, broker, resolver, environment, authorization });

	function proofOf(run) {
		return {
			episode_id: run.epId,
			outcome_id: run.outId,
			do: { action_ref: contract.id, action_version: contract.version, implementation_digest: contract.implementation_digest, arguments_template: { input: null, out: null } },
			when: [{ path: "token", op: "eq", value: "shared", verified_by: [run.outId] }],
			scope: { ...environment },
		};
	}
	const compiled = runner.compileExperience({ proofs: [proofOf(runs[0]), proofOf(runs[1])] });
	check("two live runs compile to a canonical active Experience", compiled.status === "active", JSON.stringify(compiled.failures));
	check("the active Experience pins the real script implementation digest", compiled.experience.do.implementation_digest === contract.implementation_digest);
	check("the active Experience records two distinct isolation refs", new Set(compiled.experience.support.isolation_refs).size === 2);
	check("the active Experience scope is the real environment scope, not a generalization", compiled.experience.scope?.domain === environment.domain && compiled.experience.scope?.environment_fingerprint === environment.environment_fingerprint, JSON.stringify(compiled.experience.scope));

	// A third proof copied from an already-used episode adds no independence.
	const copied = runner.compileExperience({ proofs: [proofOf(runs[0]), proofOf(runs[0])] });
	check("reusing the same live episode does not increase independence", copied.status === "candidate" && copied.failures.some((f) => f.rule === "independence"), JSON.stringify(copied.failures.map((f) => f.rule)));

	// ---- Habit binding then direct execution on a THIRD target ---------------
	const task = { task_id: "task-L", task_types: ["stage"], permissions: ["workspace-script"], arguments: {} };
	// The trusted current state is a resolver-verified committed snapshot.
	const stateRecord = resolver.resolveSupport({ kind: "data", ref: runs[0].stateRef });
	const currentStateRef = { ref_type: "data", ref_id: runs[0].stateRef.ref_id, digest: stateRecord.content_digest };
	const currentState = { token: "shared" };
	const route = runner.routeLearning({ experiences: [compiled.experience], task, currentState, currentStateRef });
	check("the live Experience routes to habit with the missing resource params", route.route === "habit" && route.missing_parameters.includes("input") && route.missing_parameters.includes("out"), JSON.stringify({ route: route.route, missing: route.missing_parameters, trusted: route.state_trusted }));
	const bound = runner.bindHabit({ experiences: [compiled.experience], task, currentState, currentStateRef, bindings: { input: "input-2.json", out: "out-2.json" } });
	check("binding the missing params RE-CHECKS to a direct route", bound.ok === true && bound.recheck?.route === "direct", JSON.stringify(bound));
	// Direct execution reuses the confirmed selection and revalidates it against
	// the current verified state before it runs. No bare action_ref bypass.
	const finalRun = await runner.executeDirect({ experiences: [compiled.experience], task: { ...task, arguments: bound.arguments }, context: { workspaceRoot, target_path: join(workspaceRoot, "input-2.json") }, currentState, currentStateRef });
	check("the direct (0 model call) execution runs the registered script on a fresh target", finalRun.status === "success" && finalRun.model_calls === 0 && finalRun.route === "direct" && finalRun.direct === true, JSON.stringify({ status: finalRun.status, route: finalRun.route, transport: finalRun.transport, reason: finalRun.reason }));
	const finalPost = JSON.parse(readFileSync(join(workspaceRoot, "out-2.json"), "utf8"));
	check("the third live run produced the real post-state", finalPost.stage === "done");

	await log.close();
	rmSync(base, { recursive: true, force: true });
	if (failures > 0) {
		console.error(`aegis-workflow-live-script-d FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-workflow-live-script-d ok");
}

main().catch((error) => {
	console.error(`aegis-workflow-live-script-d: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
