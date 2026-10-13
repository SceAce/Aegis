// Aegis C3-D — product entry.
//
// This is the actual entry a user runs to start a Campaign Host. It wires the
// frozen C3 contract together:
//
//   manifest file -> validate -> Host(worker=broker-worker, oracle=host-oracle)
//     -> C1 scheduler over the REAL EventLog -> local effects -> bound Outcomes
//
// It exposes start/pause/cancel/exit and a recovery re-run, and prints a small
// derived summary. It NEVER calls a real model/network/target. The Worker is the
// registered Broker path; the Oracle reads real post-state.
//
// Honest boundaries:
//   * the workspace is NOT a sandbox;
//   * fixture effects are synthetic local files;
//   * token/currency usage is `unknown` (not measured), published in the ledger.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { digest, resolveInside } from "../fixture/contracts.mjs";
import { ActionRegistry, createActionBroker } from "../runtime/action-contract.mjs";
import { createAuthorization } from "../runtime/authorization.mjs";
import { EventLog } from "../runtime/events.mjs";
import { createScriptRegistry, scriptContracts } from "../runtime/script-registry.mjs";
import { createBrokerWorker } from "./broker-worker.mjs";
import { createCampaignActionGate } from "./campaign-mode.mjs";
import { createFixtureAdapterContract, FIXTURE_ADAPTER_ACTION_REF } from "./fixture-adapter.mjs";
import { createCampaignHost } from "./host.mjs";
import { createHostOracle } from "./host-oracle.mjs";
import { loadManifest, validateManifest } from "./manifest.mjs";

export const ENTRY_VERSION = "1.0.0";

/**
 * @param {{[key: string]: any}} args
 */
export function createProductSink({ eventLogPath }) {
	const log = new EventLog(eventLogPath);
	return {
		log,
		async open() {
			return log.open();
		},
		async append(event) {
			return log.append(
				/** @type {any} */ ({
					event_type: event.event_type,
					episode_id: event.episode_id ?? null,
					payload: event.payload ?? {},
					source: event.source ?? {
						kind: "runtime",
						actor_id: "campaign-host",
						adapter: "c3-entry",
						version: ENTRY_VERSION,
					},
				}),
			);
		},
		replay: () => log.replay(),
		close: () => log.close(),
	};
}

/**
 * Build a fixture Campaign Manifest bound to a real temp workspace. Two static
 * tasks: task-002 depends on task-001. The Host Oracle reads `door.json`.
 *
 * @param {{workspaceRoot: string, campaignId?: string, target?: string}} args
 */
export function buildC3FixtureManifest({ workspaceRoot, campaignId = "campaign-c3-fixture", target = "door.json" }) {
	return {
		schema_version: "campaign-1.0",
		campaign_id: campaignId,
		revision: 1,
		created_at: "2026-01-01T00:00:00Z",
		title: "C3 broker/oracle execution fixture",
		objective: {
			description: "Two static tasks verified by an independent local oracle; never a real target.",
			success_criteria: ["task-001 locked state observed", "task-002 unlocked state verified"],
			stage_policy: "declared_only",
		},
		worker: { provider: "fixture", model: "deterministic-no-model" },
		authorization: {
			execution_profile: "supervised-macos-workspace",
			workspace_root: workspaceRoot,
			allowed_targets: [target],
			allowed_capabilities: ["fixture.state.write", "fixture.observe"],
			network: "disabled",
			credentials: "none",
			human_approval: "campaign_grant",
			workspace_is_sandbox: false,
		},
		budget: {
			wall_time_ms: 600000,
			model_requests: 100,
			tool_calls: 200,
			task_count: 4,
			session_count: 20,
		},
		session_policy: {
			max_requests_per_session: 10,
			max_context_chars: 20000,
			rotate_at_stage_boundary: true,
			rotate_on_model_request: true,
			allow_model_handoff_request: true,
		},
		adapters: { execution: "workspace.exec.v1", oracle: "fixture.oracle.v1", report: "aegis-acceptance.v1" },
		tasks: [
			{
				task_id: "task-001",
				order: 1,
				depends_on: [],
				target_ref: target,
				task_type: "observe",
				scope: { environment_fingerprint: "fixture-env", domain: "fixture" },
				goal: {
					goal_id: "observe_locked",
					description: "Observe the locked fixture door.",
					success_criteria: ["door.locked == true"],
				},
				stages: [{ stage_id: "stage-001-observe", criteria: ["door.locked == true"], required: true }],
				oracle_ref: "fixture.oracle.v1",
				task_budget: { wall_time_ms: 120000, model_requests: 20, tool_calls: 40 },
			},
			{
				task_id: "task-002",
				order: 2,
				depends_on: ["task-001"],
				target_ref: target,
				task_type: "verify",
				scope: { environment_fingerprint: "fixture-env", domain: "fixture" },
				goal: {
					goal_id: "verify_unlocked",
					description: "Verify the fixture door is unlocked.",
					success_criteria: ["door.locked == false"],
				},
				stages: [{ stage_id: "stage-002-verify", criteria: ["door.locked == false"], required: true }],
				oracle_ref: "fixture.oracle.v1",
				task_budget: { wall_time_ms: 120000, model_requests: 20, tool_calls: 40 },
			},
		],
		dynamic_task_policy: {
			enabled: true,
			allowed_task_types: ["observe", "verify"],
			max_depth: 2,
			max_fan_out: 2,
			max_task_count: 4,
			required_stop_condition: "no remaining authorized target or budget",
			allow_new_target: false,
			allow_new_capability: false,
			allow_new_adapter: false,
			allow_network: false,
			allow_credentials: false,
			allow_budget_increase: false,
		},
		evidence_policy: { independent_result_required: true, unknown_is_not_failure: true, promote_experience: false },
	};
}

/**
 * Reconstruct the artifact index from the COMMITTED stream. Each successful
 * `action.completed` (or oracle result) records the real content digest for its
 * evidence ref, so a restarted process can resolve prior evidence WITHOUT
 * re-running the worker. This is what makes recovery/restart correct.
 *
 * @param {Array<any>} events committed rows
 * @returns {Map<string, {ref_id: string, digest: string}>}
 */
export function artifactIndexFromEvents(events = []) {
	const index = new Map();
	for (const event of events) {
		if (!["runtime", "oracle", "human"].includes(event?.source?.kind)) continue;
		const payload = event?.payload ?? {};
		if (event?.event_type === "action.completed") {
			const refId = payload.evidence_ref;
			if (typeof refId === "string" && typeof payload.content_digest === "string") {
				index.set(refId, { ref_id: refId, digest: payload.content_digest });
			}
		}
		// Oracle-committed evidence refs (e.g. from a reconcile that read the real
		// artifact) are indexed too.
		if (!["oracle", "human"].includes(event?.source?.kind)) continue;
		const outcome = payload.outcome;
		for (const ref of Array.isArray(outcome?.evidence_refs) ? outcome.evidence_refs : []) {
			if (ref?.ref_id && typeof ref.digest === "string")
				index.set(ref.ref_id, { ref_id: ref.ref_id, digest: ref.digest });
		}
		// Stage-level results carry their own evidence refs in the outer payload.
		for (const ref of Array.isArray(payload.evidence_refs) ? payload.evidence_refs : []) {
			if (ref?.ref_id && typeof ref.digest === "string")
				index.set(ref.ref_id, { ref_id: ref.ref_id, digest: ref.digest });
		}
	}
	return index;
}

/**
 * Assemble a Host for a validated manifest. The Worker plan is TRUSTED Host
 * config (never model text): each task maps to registered fixture-adapter steps.
 *
 * @param {{[key: string]: any}} args
 */
export async function assembleCampaignHost(
	{
		manifest,
		workspaceRoot,
		workDir,
		eventLogPath,
		mode = "normal",
		sessionController = null,
		oracleOverrides = null,
		sinkImpl = null,
		planFactory = null,
		scriptRegistrationConfig = null,
		delayedFirstByTask = {},
		extraContracts = [],
		judgeFactory = null,
		wrapWorker = null,
		actionGate = null,
	} = /** @type {any} */ ({}),
) {
	const checked = validateManifest(manifest);
	if (!checked.ok) throw new Error(`manifest invalid: ${checked.reasons.join("; ")}`);
	manifest = checked.manifest;
	// The workspace must equal the authorized root. The comparison uses REAL paths
	// (after creating the directory) so a symlinked prefix such as macOS
	// /tmp -> /private/tmp does not cause a false mismatch, while a genuinely
	// different root is still refused.
	mkdirSync(workspaceRoot, { recursive: true });
	const workspaceReal = realpathSync(workspaceRoot);
	let authorizedReal = null;
	try {
		authorizedReal = realpathSync(manifest.authorization.workspace_root);
	} catch {
		authorizedReal = resolve(manifest.authorization.workspace_root);
	}
	if (workspaceReal !== authorizedReal) {
		throw new Error("workspaceRoot differs from Manifest authorization");
	}
	mkdirSync(workDir, { recursive: true });
	const sink = sinkImpl ?? createProductSink({ eventLogPath });
	if (sink.open) {
		const opened = await sink.open();
		if (opened && opened.ok !== true) throw new Error(`event log open failed: ${opened.error}`);
	}

	const scripts = createScriptRegistry(scriptRegistrationConfig ?? {});
	// The caller (C6 task family) may register ONE additional reviewed adapter; the
	// fixture adapter remains for the accepted C3/C5 path.
	const registry = new ActionRegistry([
		createFixtureAdapterContract({ workspaceRoot }),
		...(Array.isArray(extraContracts) ? extraContracts : []),
		...scriptContracts(scripts),
	]);
	const broker = createActionBroker({ registry });
	const authorization = createAuthorization({
		mode,
		workspaceRoot,
		allowedTools: ["aegis_workspace", "aegis_script"],
		allowNetwork: false,
		approved: mode === "auto",
	});
	// A trusted deployment may pass ONE gate object so the runtime resource loader
	// (including rotated sessions) and the Host share it; otherwise create one.
	const gate = actionGate ?? createCampaignActionGate({ allowDirectTools: [] });
	const artifactIndex = new Map();
	// Recovery correctness: rebuild prior evidence digests from the COMMITTED
	// stream so a restarted Host resolves the same evidence without re-running the
	// worker. (The worker/oracle continue to add live digests as they run.)
	if (typeof sink.replay === "function") {
		for (const [refId, entry] of artifactIndexFromEvents(sink.replay())) artifactIndex.set(refId, entry);
	}

	// TRUSTED per-task plan: each task writes/reads the fixture state through the
	// registered adapter. The model can never supply this.
	function defaultPlan(task) {
		const target = task.target_ref ?? task.definition?.target_ref ?? "door.json";
		// The engine's state machine: task-001 observes locked=true, task-002 unlocks
		// (sets false). Values come from the Host plan, not model text.
		const unlock = task.task_type === "verify" || task.task_id.endsWith("002");
		const steps = (task.stages ?? []).map((stage) => ({
			step_id: `${task.task_id}:${stage.stage_id}`,
			stage_id: stage.stage_id,
			action_ref: FIXTURE_ADAPTER_ACTION_REF,
			arguments: { target, key: "locked", value: !unlock },
			criterion_id: stage.criteria?.[0] ?? null,
			evidence_ref: `artifact:${task.task_id}`,
		}));
		return { task_id: task.task_id, steps };
	}
	const plan = planFactory ?? defaultPlan;

	const workerRaw = createBrokerWorker({
		broker,
		authorization,
		plan,
		sink,
		workspaceRoot,
		artifactIndex,
		actionGate: gate,
		probePath: (/** @type {any} */ step) =>
			resolve(workspaceRoot, step.arguments?.target ?? step.arguments?.state_file ?? "door.json"),
		targetPathFor: (/** @type {any} */ step) =>
			resolve(workspaceRoot, step.arguments?.target ?? step.arguments?.state_file ?? "door.json"),
	});
	workerRaw.bindCampaign(manifest);
	// A preparation seam: wrap the worker to count real effects or inject a
	// process fault AFTER the effect. It never changes Broker semantics.
	const worker = typeof wrapWorker === "function" ? wrapWorker(workerRaw) : workerRaw;

	const oracle = createHostOracle({
		workspaceRoot,
		judgeTask:
			typeof judgeFactory === "function"
				? judgeFactory({ workspaceRoot, manifest })
				: typeof oracleOverrides?.judgeTask === "function"
					? oracleOverrides.judgeTask
					: ({ task, attempt, onEvidence }) => {
							const target = task.target_ref ?? "door.json";
							const path = resolveInside(workspaceRoot, target, { mustExist: false });
							if (!exists(path)) return { status: "unknown", failure_mode: "effect_absent" };
							const state = JSON.parse(readFileSync(path, "utf8"));
							// Only the registered local boolean criterion is executable here;
							// task labels/types never decide whether its postcondition passed.
							const stageOverrides = Object.fromEntries(
								(task.stages ?? []).map((stage) => {
									const criteria = stage.criteria ?? [];
									const matches = criteria.map((criterion) =>
										/^(?:door|state)\.locked == (true|false)$/.exec(criterion),
									);
									if (matches.length === 0 || matches.some((match) => !match)) {
										return [stage.stage_id, { status: "unknown", failure_mode: "unregistered_criterion" }];
									}
									const expectedValues = matches.map((match) => match[1] === "true");
									return [
										stage.stage_id,
										{
											status: expectedValues.every((value) => state.locked === value) ? "success" : "failure",
											expected: expectedValues[0],
											observed: { locked: state.locked },
										},
									];
								}),
							);
							const required = (task.stages ?? [])
								.filter((stage) => stage.required !== false)
								.map((stage) => stageOverrides[stage.stage_id]);
							const judgedStatus = required.some((stage) => stage.status === "unknown")
								? "unknown"
								: required.every((stage) => stage.status === "success")
									? "success"
									: "failure";
							const expected = required[0]?.expected ?? null;
							const evidence = [{ ref_id: `artifact:${task.task_id}`, digest: stateDigest(path), path }];
							// The default judge READ the real file, so its digest may be indexed.
							if (typeof onEvidence === "function") onEvidence(evidence);
							// A delayed-verification task returns unknown on its first judgment.
							if (delayedFirstByTask[task.task_id] && attempt === 1) {
								return { status: "unknown", delayed: true, failure_mode: "delayed_verification", evidence };
							}
							for (const stage of Object.values(stageOverrides)) Object.assign(stage, { evidence });
							if (judgedStatus === "success")
								return {
									status: "success",
									observed: { locked: state.locked },
									expected,
									evidence,
									stage_overrides: stageOverrides,
								};
							return {
								status: judgedStatus,
								stage_overrides: stageOverrides,
								observed: { locked: state.locked },
								expected,
								failure_mode: "criterion_not_met",
								evidence,
							};
						},
		reconcileImpl: oracleOverrides?.reconcileImpl ?? null,
		// Independent Oracle evidence must be resolvable by the projection even
		// when the Worker is NOT re-run (recovery). Index the real digests here.
		onEvidence: (refs) => {
			for (const ref of refs) {
				if (ref && typeof ref.ref_id === "string" && typeof ref.digest === "string") artifactIndex.set(ref.ref_id, ref);
			}
		},
	});

	const host = createCampaignHost({
		manifest,
		ownedTasks: manifest.tasks,
		baseDir: join(workDir, "runtime"),
		workspaceRoot,
		sink,
		worker,
		oracle,
		actionGate: gate,
		sessionController,
		artifacts: artifactIndexToObject(artifactIndex),
		effectProbe: async ({ task }) => {
			const target = task?.target_ref ?? "door.json";
			const path = join(workspaceRoot, target);
			return { path, exists: exists(path) };
		},
	});

	return { host, sink, registry, broker, authorization, gate, artifactIndex, oracle, worker };
}

function artifactIndexToObject(map) {
	// The scheduler reads the artifact index synchronously at projection time.
	// A Proxy keeps it live as the worker records real digests.
	return new Proxy(
		{},
		{
			get(_target, prop) {
				return typeof prop === "string" ? map.get(prop) : undefined;
			},
			has(_target, prop) {
				return typeof prop === "string" && map.has(prop);
			},
			ownKeys() {
				return [...map.keys()];
			},
			getOwnPropertyDescriptor() {
				return { enumerable: true, configurable: true };
			},
		},
	);
}

function exists(path) {
	return existsSync(path);
}
function stateDigest(path) {
	return digest(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Run a Campaign Host over a manifest file (or the built-in C3 fixture).
 *
 * @param {{manifestPath?: string, workDir: string, workspaceRoot: string,
 *   scenario?: string, mode?: string, delayedFirst?: string[]}} args
 */
export async function runCampaignHost(
	{
		manifestPath = null,
		workDir,
		workspaceRoot,
		scenario = "start",
		mode = "auto",
		delayedFirst = [],
	} = /** @type {any} */ ({}),
) {
	mkdirSync(workDir, { recursive: true });
	let manifest;
	if (manifestPath) {
		const loaded = await loadManifest(manifestPath);
		if (!loaded.ok) return { ok: false, reasons: loaded.reasons };
		manifest = loaded.manifest;
	} else {
		const validation = validateManifest(buildC3FixtureManifest({ workspaceRoot }));
		if (!validation.ok) return { ok: false, reasons: validation.reasons };
		manifest = validation.manifest;
	}
	const eventLogPath = join(workDir, "events.jsonl");
	const delayedFirstByTask = Object.fromEntries(delayedFirst.map((id) => [id, true]));
	const assembled = await assembleCampaignHost({
		manifest,
		workspaceRoot,
		workDir,
		eventLogPath,
		mode,
		delayedFirstByTask,
	});
	const { host, sink } = assembled;

	let result;
	if (scenario === "resume") {
		const resumed = await host.resume("cli_resume");
		if (!resumed.ok) throw new Error(resumed.error || "resume was not durable");
		result = await host.run();
	} else if (scenario === "pause") {
		const paused = await host.pause("cli_pause");
		if (!paused.ok) throw new Error(paused.error || "pause was not durable");
		result = await host.run();
	} else if (scenario === "cancel") {
		const cancelled = await host.cancel("cli_cancel");
		if (!cancelled.ok) throw new Error(cancelled.error || "cancel was not durable");
		result = await host.run();
	} else {
		result = await host.run();
	}
	const summary = summarize({ host, manifest, sink, workspaceRoot, scenario });
	writeFileSync(join(workDir, "summary.json"), JSON.stringify(summary, null, 2));
	if (sink.close) await sink.close();
	return { ok: result.ok, reasons: result.reasons, result, summary };
}

/** A small derived summary (never a second truth source). */
export function summarize({ host, manifest, sink, workspaceRoot, scenario }) {
	const events = sink.replay();
	const status = host.status();
	const projection = status.projection;
	return {
		scenario,
		campaign_id: manifest.campaign_id,
		campaign_state: status.campaign_state,
		task_states: Object.fromEntries((projection?.tasks ?? []).map((t) => [t.task_id, t.state])),
		action_events: {
			requested: events.filter((e) => e.event_type === "action.requested").length,
			completed: events.filter((e) => e.event_type === "action.completed").length,
		},
		counters: status.actions,
		sessions: status.sessions,
		budget: status.budget,
		key: readKey(workspaceRoot),
	};
}

function readKey(workspaceRoot) {
	try {
		return JSON.parse(readFileSync(join(workspaceRoot, "door.json"), "utf8"));
	} catch {
		return null;
	}
}

/** CLI: node c3-entry.mjs <workDir> <scenario> [workspaceRoot] */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	const [workDirArg, scenarioArg = "start", workspaceArg] = process.argv.slice(2);
	if (!workDirArg || !["start", "pause", "resume", "cancel"].includes(scenarioArg)) {
		process.stderr.write("Usage: node c3-entry.mjs <workDir> start|pause|resume|cancel [workspaceRoot]\n");
		process.exit(2);
	}
	const workDir = resolve(workDirArg);
	const workspaceRoot = resolve(workspaceArg ?? join(workDir, "workspace"));
	const outcome = await runCampaignHost({ workDir, workspaceRoot, scenario: scenarioArg, mode: "auto" });
	process.stdout.write(`${JSON.stringify(outcome.summary ?? { ok: outcome.ok }, null, 2)}\n`);
	process.exit(outcome.ok ? 0 : 2);
}
