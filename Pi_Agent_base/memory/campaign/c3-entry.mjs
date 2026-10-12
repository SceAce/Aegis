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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { digest } from "../fixture/contracts.mjs";
import { ActionRegistry, createActionBroker } from "../runtime/action-contract.mjs";
import { createAuthorization } from "../runtime/authorization.mjs";
import { EventLog } from "../runtime/events.mjs";
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
			return log.append(/** @type {any} */ ({
				event_type: event.event_type,
				episode_id: event.episode_id ?? null,
				payload: event.payload ?? {},
				source: event.source ?? {
					kind: "runtime",
					actor_id: "campaign-host",
					adapter: "c3-entry",
					version: ENTRY_VERSION,
				},
			}));
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
 * Assemble a Host for a validated manifest. The Worker plan is TRUSTED Host
 * config (never model text): each task maps to registered fixture-adapter steps.
 *
 * @param {{[key: string]: any}} args
 */
export async function assembleCampaignHost({
	manifest,
	workspaceRoot,
	workDir,
	eventLogPath,
	mode = "normal",
	sessionController = null,
	oracleOverrides = null,
	sinkImpl = null,
	planFactory = null,
	delayedFirstByTask = {},
} = {}) {
	mkdirSync(workspaceRoot, { recursive: true });
	mkdirSync(workDir, { recursive: true });
	const sink = sinkImpl ?? createProductSink({ eventLogPath });
	if (sink.open) {
		const opened = await sink.open();
		if (opened && opened.ok !== true) throw new Error(`event log open failed: ${opened.error}`);
	}

	const registry = new ActionRegistry([createFixtureAdapterContract({ workspaceRoot })]);
	const broker = createActionBroker({ registry });
	const authorization = createAuthorization({
		mode,
		workspaceRoot,
		allowedTools: ["aegis_workspace", "aegis_script"],
		allowNetwork: false,
		approved: mode === "auto",
	});
	const gate = createCampaignActionGate({ allowDirectTools: [] });
	const artifactIndex = new Map();

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

	const worker = createBrokerWorker({
		broker,
		authorization,
		plan,
		sink,
		workspaceRoot,
		artifactIndex,
		actionGate: gate,
		probePath: (/** @type {any} */ step) => join(workspaceRoot, step.arguments?.target ?? "door.json"),
		targetPathFor: (/** @type {any} */ step) => join(workspaceRoot, step.arguments?.target ?? "door.json"),
	});

	const oracle = createHostOracle({
		workspaceRoot,
		judgeTask:
			typeof oracleOverrides?.judgeTask === "function"
				? oracleOverrides.judgeTask
				: ({ task, attempt }) => {
						const target = task.target_ref ?? "door.json";
						const path = join(workspaceRoot, target);
						if (!exists(path)) return { status: "unknown", failure_mode: "effect_absent" };
						const state = JSON.parse(readFileSync(path, "utf8"));
						const unlock = task.task_type === "verify" || task.task_id.endsWith("002");
						const expected = !unlock;
						const digest = oracleOverrides?.digestOf?.(path) ?? undefined;
						const evidence = [{ ref_id: `artifact:${task.task_id}`, digest: digest ?? stateDigest(path), path }];
						// A delayed-verification task returns unknown on its first judgment.
						if (delayedFirstByTask[task.task_id] && attempt === 1) {
							return { status: "unknown", delayed: true, failure_mode: "delayed_verification", evidence };
						}
						if (state.locked === expected)
							return { status: "success", observed: { locked: state.locked }, expected, evidence };
						return {
							status: "failure",
							observed: { locked: state.locked },
							expected,
							failure_mode: "criterion_not_met",
							evidence,
						};
					},
		reconcileImpl: oracleOverrides?.reconcileImpl ?? null,
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
export async function runCampaignHost({
	manifestPath = null,
	workDir,
	workspaceRoot,
	scenario = "start",
	mode = "auto",
	delayedFirst = [],
} = /** @type {any} */ ({})) {
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
	if (scenario === "pause") {
		await host.pause("cli_pause");
		result = await host.run();
	} else if (scenario === "cancel") {
		await host.cancel("cli_cancel");
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
	const workDir = resolve(workDirArg);
	const workspaceRoot = resolve(workspaceArg ?? join(workDir, "workspace"));
	const outcome = await runCampaignHost({ workDir, workspaceRoot, scenario: scenarioArg, mode: "auto" });
	process.stdout.write(`${JSON.stringify(outcome.summary ?? { ok: outcome.ok }, null, 2)}\n`);
	process.exit(outcome.ok ? 0 : 2);
}
