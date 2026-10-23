// Aegis C6 — product entry: automatic SDK runtime + model Worker + Campaign
// learning, on top of the accepted C1-C5 stack.
//
// One command runs the whole product chain from a trusted config file:
//
//   config -> validated Manifest -> SDK runtime (isolated creds, allowlist
//   ResourceLoader, shared gate) -> Host (one EventLog owner, one Broker
//   Worker, one Oracle) -> Router -> model structured decision -> Broker ->
//   local effect -> independent Oracle -> committed evidence / replay /
//   compiler -> safe Session rotation / control / recovery -> read-only
//   observation, report and measurement export.
//
// It reuses the existing Scheduler/Host/Broker/Observer/Oracle/Compiler/Router/
// learning bridge/Replay. It creates NO second scheduler, evidence, learning or
// model-call framework. It never contacts a real provider/target by default.
//
// Honest boundaries: the workspace is NOT an OS sandbox; the development default
// provider is the offline `faux`; token/currency usage is `unknown` unless the
// backend reports it (faux reports an ESTIMATE, labelled as such).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectBoard } from "../memory/board.mjs";
import {
	buildCampaignLearningBridge,
	createCampaignLearningStore,
	loadAuthoritativeExperiences,
	rebuildExperienceStore,
	replayThenCompile,
	routeBeforeModel,
	runCampaignLearningStep,
} from "../memory/c6-learning.mjs";
import { buildRam } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";
import {
	completedWorkCycleBoundaries,
	frozenWorkCyclePolicyPayload,
	isWorkCycleAdvisoryTool,
	projectWorkCycle,
	readFrozenWorkCyclePolicy,
	readWorkCycleRunState,
	workStartGateEnabled,
} from "../memory/work-cycle.mjs";
import { createObservationServer } from "../observation/observation-server.mjs";
import { runReportExport } from "../observation/report-entry.mjs";
import {
	bindWorkToolAccount,
	createWorkController,
	inspectWorkPermit,
	projectWorkControl,
} from "../orchestration/work-control.mjs";
import { createSessionSupervisor } from "../session/session-supervisor.mjs";
import { evaluateHostWorkCycleRotation, latestSessionUsage } from "../session/work-cycle-rotation.mjs";
import { digest } from "../shared/contracts.mjs";
import { bindHostEventLog, EventLog, parseJsonl, verifyChain } from "../shared/events.mjs";
import { inspectExecutionPermit } from "./authority.mjs";
import { artifactIndexFromEvents, assembleCampaignHost } from "./c3-entry.mjs";
import {
	createDecisionCaptureTool,
	createModelPlan,
	createModelWorker,
	createObservationTool,
	createToolCallRegistry,
} from "./c6-model-worker.mjs";
import { reservedSeedForTask, summarizeRequestLedger } from "./c6-request-lifecycle.mjs";
import { createCampaignSdkRuntime } from "./c6-sdk-runtime.mjs";
import { createToolLedger } from "./c6-tool-ledger.mjs";
import { loadCampaignConfig } from "./campaign-config.mjs";
import { loadPlanningAuthority, normalizeExecutableTask, normalizeTrustedTemplates } from "./e1-planning-contract.mjs";
import { canonicalManifestDigest, loadImmutableManifest, persistImmutableManifest } from "./manifest.mjs";
import { projectQueueFromEvents } from "./projection.mjs";
import { describeCredentialRef, resolveProviderConfig } from "./provider-config.mjs";

export const C6_ENTRY_VERSION = "1.0.0";

/**
 * Resolve the ONE execution budget for a task from its normalized executable
 * shape. A dynamic task that carries no valid `task_budget` fails CLOSED to a
 * zero limit (never the Campaign total): its provider/tool calls are refused
 * rather than silently funded by the whole Campaign.
 *
 * @param {any} task
 */
function normalizeTaskBudget(task) {
	const definition = task?.definition ?? task ?? {};
	const origin = task?.is_dynamic === true ? "plan" : "static";
	const normalized = normalizeExecutableTask({
		definition: { ...definition, task_id: task?.task_id ?? definition.task_id },
		origin,
	});
	if (normalized.ok) return { ...normalized.task.task_budget };
	// Legacy static Manifest tasks that predate the executable shape: use the
	// explicit task_budget dims when present, otherwise 0 (never Campaign total).
	const alloc = task?.task_budget ?? definition?.task_budget ?? {};
	const dim = (key) => (Number.isSafeInteger(alloc[key]) && alloc[key] >= 0 ? alloc[key] : 0);
	return { wall_time_ms: dim("wall_time_ms"), model_requests: dim("model_requests"), tool_calls: dim("tool_calls") };
}

const SUBCOMMANDS = ["run", "status", "pause", "resume", "cancel", "export", "observe", "rotate", "measure"];

function readEventsSafe(path) {
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Read the committed stream for an EXECUTION decision. A corrupt chain or an
 * unparseable line is never filtered into a "normal" prefix: it throws, and the
 * caller fails closed. (`readEventsSafe` remains for display-only diagnostics.)
 */
function readEventsStrict(path) {
	if (!existsSync(path)) return [];
	const { rows, errors } = parseJsonl(readFileSync(path, "utf8"));
	if (errors.length > 0) throw new Error(`committed event log has unparseable lines: ${errors.slice(0, 2).join("; ")}`);
	const chain = verifyChain(rows);
	if (!chain.ok) throw new Error(`committed event log chain is corrupt: ${chain.errors.slice(0, 2).join("; ")}`);
	return rows;
}

// The rebuild rules live in ONE shared module (`c6-request-lifecycle.mjs`) so the
// live gate and the restart/measure rebuild cannot drift apart. Re-exported here
// for the existing import surface (`../campaign/c6-entry.mjs`).
export { summarizeRequestLedger };

/**
 * E1: compose the Host-owned planning Task's judge with the task-family judge.
 * The planning Task MUST be judged by the independent plan_ready check (never by
 * a business judge that would read the target file); every business Task keeps
 * its registered task-family judge. When planning is disabled this is a no-op.
 *
 * @param {{baseJudge: Function, e1Planning: any, enabled: boolean, readEvents: () => any[], manifest: any}} args
 */
function withPlanReadyJudge({ baseJudge, e1Planning, enabled, readEvents, manifest }) {
	if (enabled !== true || !e1Planning || typeof e1Planning.createPlanReadyJudge !== "function") return baseJudge;
	const planningTaskId = e1Planning.PLANNING_TASK_ID ?? "task-plan";
	const planJudge = e1Planning.createPlanReadyJudge({ readEvents, manifest, planningTaskId });
	return (args) => (args?.task?.task_id === planningTaskId ? planJudge(args) : baseJudge(args));
}

/**
 * Build a decision buffer shared between the SDK custom tool and the model plan.
 * @returns {{setTask: (taskId: string) => void, push: (d: any) => void, pushTask: (p: any) => boolean, pushPlan: (plan: any) => boolean, listTasks: () => any[], listPlans: () => any[], list: () => any[], reset: () => void, byTask: () => Map<string, any[]>}}
 */
export function createDecisionBuffer() {
	let currentTask = null;
	const byTask = new Map();
	const taskProposals = [];
	const proposalKeys = new Set();
	const planBatches = [];
	return {
		setTask(taskId) {
			currentTask = taskId;
			// E1: a plan batch belongs to the planning task only. Clear the plan buffer
			// when the bound task changes so a business task never re-submits (or sees)
			// another task's plan.
			planBatches.length = 0;
			// A new dispatch must PLAN FRESH. Keeping old decisions would replay an
			// already-executed action plan after a review/rotation boundary.
			byTask.delete(taskId);
		},
		push(decision) {
			const key = currentTask ?? "unbound";
			const list = byTask.get(key) ?? [];
			list.push(decision);
			byTask.set(key, list);
		},
		/** Record a bounded dynamic task proposal (deduped by semantic identity). */
		pushTask(proposal) {
			const key = `${proposal?.parent_task_id ?? ""}|${proposal?.proposed_task_id ?? ""}|${proposal?.task_type ?? ""}|${proposal?.target_ref ?? ""}`;
			if (proposalKeys.has(key)) return false;
			proposalKeys.add(key);
			taskProposals.push(proposal);
			return true;
		},
		listTasks() {
			return taskProposals.slice();
		},
		/** E1: record ONE candidate plan batch (a complete candidate, not yet admitted). */
		pushPlan(plan) {
			planBatches.push(plan);
			return true;
		},
		listPlans() {
			return planBatches.slice();
		},
		list() {
			return byTask.get(currentTask ?? "unbound") ?? [];
		},
		reset() {
			byTask.clear();
			taskProposals.length = 0;
			proposalKeys.clear();
			planBatches.length = 0;
		},
		byTask: () => byTask,
	};
}

/**
 * The COMPOSITE worker the Scheduler drives: it first asks the bound SDK model
 * for a structured decision (driving the SDK + ledger), then executes the
 * admitted plan through the ORIGINAL Broker Worker. One Broker path only.
 */
export function createCompositeWorker({
	modelWorker,
	brokerWorker,
	buffer,
	onTaskSettled = null,
	onPlanSubmitted = null,
	permitEffect = null,
	workCycleEnabled = false,
}) {
	return {
		bindCampaign(manifest) {
			brokerWorker.bindCampaign?.(manifest);
		},
		async run({ task }) {
			if (task.work_resume_event_id) buffer.reset();
			buffer.setTask(task.task_id);
			const planned = await modelWorker.run({ task });
			if (
				typeof permitEffect === "function" &&
				permitEffect({ task })?.reasons?.some((reason) => reason.code === "waiting_external")
			) {
				buffer.reset();
				return { ok: true, overview: "waiting_external" };
			}
			if (planned?.failure_mode === "waiting_external") return { ok: true, overview: "waiting_external" };
			// A review-only turn has no broker decision by design. The Observer may have
			// committed a review/Intent/checkpoint during the model request; the Host
			// loop checks for real work-cycle progress before spending another request.
			if (
				workCycleEnabled &&
				planned?.ok !== true &&
				planned?.failure_mode === "no_model_decision" &&
				buffer.list().length === 0
			) {
				if (typeof onTaskSettled === "function")
					await onTaskSettled({ task, result: { ok: true, overview: "work_cycle_review_turn" } });
				return { ok: true, overview: "work_cycle_review_turn" };
			}
			if (!planned.ok) return planned;
			// A review-only model turn (review / new Intent / checkpoint, no broker
			// action) is a valid non-terminal boundary when the work-cycle policy is
			// enabled. It executes no effect and is NOT judged by the Oracle.
			if (workCycleEnabled && buffer.list().length === 0) {
				if (typeof onTaskSettled === "function")
					await onTaskSettled({ task, result: { ok: true, overview: "work_cycle_review_turn" } });
				return { ok: true, overview: "work_cycle_review_turn" };
			}
			// E1: a PLANNING task returns a candidate plan (no business decision).
			// Admission is a SEPARATE Host step; submitting a plan never executes
			// anything and never means the root goal is complete. A rejected/blocked
			// admission (or a durable-write failure) is propagated as a failure so the
			// Scheduler records an unknown/hold and no child Task is ever dispatched.
			if (planned.overview === "plan_submitted" && Array.isArray(planned.plans) && planned.plans.length > 0) {
				const submitted =
					typeof onPlanSubmitted === "function" ? await onPlanSubmitted({ task, plans: planned.plans }) : { ok: true };
				if (submitted?.ok === false) {
					return {
						ok: false,
						failure_mode: submitted.status === "blocked" ? "plan_blocked" : "plan_not_admitted",
						detail: (submitted.reasons ?? []).join("; ") || submitted.reason || "the candidate plan was not admitted",
						provider_requests: planned.provider_requests,
					};
				}
				return { ok: true, overview: "plan_submitted", plans: planned.plans };
			}
			// The effect boundary re-checks the LATEST authoritative permit (binding,
			// effective dependencies, deadlines, settled tool units). A refusal is a
			// hold, never a fabricated Oracle failure.
			if (typeof permitEffect === "function") {
				const permit = permitEffect({ task });
				if (permit && permit.ok !== true) {
					const workCycleHold = (permit.reasons ?? []).some(
						(reason) => reason.code === "work_review_required" || reason.code === "work_cycle_projection_failed",
					);
					if (workCycleHold) {
						// A hold is NOT a failure: drop the unexecuted buffered remainder so
						// it cannot be replayed after review/replan, then let the Host record
						// the non-terminal boundary.
						buffer.reset();
						if (typeof onTaskSettled === "function")
							await onTaskSettled({
								task,
								result: { ok: false, failure_mode: "work_review_required" },
							});
						return {
							ok: true,
							overview: "work_cycle_hold",
							work_cycle: { reason: "work_review_required", trigger_id: null },
							provider_requests: planned.provider_requests,
						};
					}
					return {
						ok: false,
						failure_mode: permit.reasons?.[0]?.code ?? "execution_not_permitted",
						detail: (permit.reasons ?? []).map((r) => `${r.code}: ${r.message}`).join("; "),
						provider_requests: planned.provider_requests,
					};
				}
			}
			// Execute the model's admitted decision through the existing Broker.
			brokerWorker.setExecutionPermit?.(permitEffect);
			const result = await brokerWorker.run({ task });
			// A blocked Broker effect is a WORK HOLD, not an Oracle failure. The
			// unexecuted remainder is dropped (never replayed blindly) and the Host
			// gets a safe boundary to decide rotation/continuation.
			if (result?.work_cycle_blocked === true) {
				buffer.reset();
				if (typeof onTaskSettled === "function") await onTaskSettled({ task, result });
				return {
					ok: true,
					overview: "work_cycle_hold",
					work_cycle: { reason: "work_review_required", trigger_id: null },
					effects: result.effects ?? [],
				};
			}
			// A safe settle boundary: the caller may rotate the Session here. The
			// caller only rotates when idle/settled/committed with no pending effect
			// and budget allowing; this callback never forces a rotation.
			if (typeof onTaskSettled === "function") await onTaskSettled({ task, result });
			return result;
		},
	};
}

/**
 * Run the C6 product chain from a trusted config.
 *
 * @param {{
 *   configPath: string, scenario?: string, observe?: boolean, export?: boolean,
 *   outDir?: string|null, port?: number|null, sdk?: any, createSeam?: Function|null,
 *   fauxProviderFactory?: Function|null, print?: (text: string) => void,
 *   installSignalHandlers?: boolean, signalSource?: any,
 *   resident?: boolean,
 *   workerSeam?: ((worker: any) => any)|null,
 * }} args
 */
export async function runC6FromConfig(
	{
		configPath,
		scenario = "run",
		observe = false,
		export: doExport = false,
		outDir = null,
		port = null,
		sdk = null,
		createSeam = null,
		fauxProviderFactory = null,
		print = null,
		installSignalHandlers = false,
		signalSource = process,
		resident = false,
		workerSeam = null,
	} = /** @type {any} */ ({}),
) {
	const out = typeof print === "function" ? print : (text) => process.stdout.write(`${text}\n`);
	if (!SUBCOMMANDS.includes(scenario)) return { ok: false, reasons: ["unknown Campaign command"], stage: "config" };
	if (port !== null && (!Number.isInteger(port) || port < 0 || port > 65535))
		return { ok: false, reasons: ["observation port is invalid"], stage: "config" };

	const loaded = loadCampaignConfig({ configPath });
	if (!loaded.ok) return { ok: false, reasons: loaded.reasons, stage: "config" };
	const { config } = loaded;
	// E1: when planning is enabled the on-disk Manifest already contains ONLY the
	// Campaign root goal container and the Host planning task (built by the
	// run-package helper via `buildPlanningManifest`). Business tasks are created
	// ONLY from an admitted plan batch. This module only tracks the templates.
	let manifest = loaded.manifest;
	let planningTemplates = null;
	let planningContext = null;
	let e1Planning = null;
	const READ_ONLY_SCENARIO = ["status", "export", "observe", "measure"].includes(scenario);
	if (manifest.planning_contract && config.planning?.enabled !== true && !READ_ONLY_SCENARIO)
		return {
			ok: false,
			stage: "config",
			reasons: ["planning_context_conflict: frozen planning protocol cannot be disabled"],
		};
	if (config.planning?.enabled === true) {
		e1Planning = await import("./e1-planning.mjs");
		// E1-CC §4.2: the trusted planning context is the contract FROZEN in the
		// Manifest. The current config may only confirm it; a differing safe field is
		// `planning_context_conflict` (zero new requests/effects). Read-only views
		// keep using the frozen contract.
		const authority = loadPlanningAuthority({ manifest });
		if (!authority.ok)
			return {
				ok: false,
				reasons: [`${authority.code ?? "planning_context_conflict"}: ${authority.reasons.join("; ")}`],
				stage: "config",
			};
		const configured = normalizeTrustedTemplates(config.planning.templates ?? []);
		if (
			!READ_ONLY_SCENARIO &&
			(!configured.ok || digest(configured.templates) !== digest(authority.contract.templates))
		)
			return {
				ok: false,
				reasons: ["planning_context_conflict: the current planning config differs from the frozen Manifest contract"],
				stage: "config",
			};
		planningTemplates = authority.templates;
		planningContext = e1Planning.buildPlanningContext({ manifest, templates: planningTemplates });
	}

	// Provider must be EXPLICIT and recognized; no silent fallback to faux.
	const providerCheck = resolveProviderConfig(config.provider);
	if (!providerCheck.ok) return { ok: false, reasons: providerCheck.reasons, stage: "provider" };
	const credentialInfo = describeCredentialRef(providerCheck.provider.credential_ref);
	if (!credentialInfo.ok) return { ok: false, reasons: [credentialInfo.reason], stage: "provider" };
	const READ_ONLY = ["status", "export", "observe", "measure"].includes(scenario);
	if (!READ_ONLY && providerCheck.provider.kind === "remote-openai" && !process.env[credentialInfo.env_name]?.trim())
		return {
			ok: false,
			reasons: ["the configured remote provider credential environment variable is empty"],
			stage: "provider",
		};

	// The SDK is injected in tests; the real SDK is imported lazily in CLI mode.
	let sdkImpl = sdk;
	if (!sdkImpl && createSeam) {
		sdkImpl = await createSeam({ provider: providerCheck.provider, config });
		if (!sdkImpl?.ok) return { ok: false, reasons: [sdkImpl?.reason ?? "SDK creation failed"], stage: "sdk" };
		sdkImpl = sdkImpl.sdk;
	}
	if (!sdkImpl) {
		try {
			sdkImpl = await importSdk();
		} catch (error) {
			return { ok: false, reasons: [`Pi SDK is unavailable: ${String(error)}`], stage: "sdk" };
		}
	}
	// Explicitly selected Pi config uses Pi's own model composition and auth.
	// The source auth is read-only; any SDK catalog cache belongs to this attempt.
	let configuredPi = null;
	if (!READ_ONLY && providerCheck.provider.kind === "pi-config") {
		const selected = providerCheck.provider;
		try {
			if (!existsSync(join(selected.agent_dir, "models.json")))
				return { ok: false, reasons: ["the selected Pi models.json is missing"], stage: "provider" };
			const modelRuntime = await sdkImpl.ModelRuntime.create({
				credentials: new sdkImpl.ReadOnlyAuthStorage(join(selected.agent_dir, "auth.json")),
				modelsPath: join(selected.agent_dir, "models.json"),
				modelsStorePath: join(config.work_dir, "sdk", "models-store.json"),
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			if (modelRuntime.getError())
				return { ok: false, reasons: ["the selected Pi model configuration is invalid"], stage: "provider" };
			const configured = modelRuntime.getModel(selected.provider_id, selected.model);
			if (!configured)
				return {
					ok: false,
					reasons: ["the selected provider/model is not present in Pi configuration"],
					stage: "provider",
				};
			if (!(await modelRuntime.getAuth(configured)))
				return { ok: false, reasons: ["the selected Pi provider has no available credential"], stage: "provider" };
			configuredPi = {
				modelRuntime,
				model: { ...configured, maxTokens: Math.min(configured.maxTokens, selected.max_output_tokens) },
			};
		} catch {
			return { ok: false, reasons: ["unable to load the selected Pi model or credential"], stage: "provider" };
		}
	}

	mkdirSync(config.work_dir, { recursive: true });
	config.session.handoff_path = config.session.handoff_path ?? join(config.work_dir, "runtime", "handoff.json");
	mkdirSync(dirname(config.session.handoff_path), { recursive: true });
	const cwd = join(config.work_dir, "cwd");
	const agentDir = join(config.work_dir, "agent");
	const sessionDir = join(config.work_dir, "sessions");
	for (const d of [cwd, agentDir, sessionDir]) mkdirSync(d, { recursive: true });

	const eventLogPath = join(config.work_dir, "events.jsonl");
	// Never append the new accounting protocol to an established legacy stream.
	// The side-aware summary preserves historical consumption for review/migration.
	const accountingRows = readEventsSafe(eventLogPath);
	const legacyRequests = accountingRows.some(
		(row) => row.payload?.kind === "c6.request" && row.payload.tool_accounting !== "durable-charge-v1",
	);
	const durableAccounting = accountingRows.some(
		(row) =>
			row.payload?.kind === "c6.tool" ||
			(row.payload?.kind === "c6.request" && row.payload.tool_accounting === "durable-charge-v1"),
	);
	if (!READ_ONLY && legacyRequests && !durableAccounting) {
		const historical = summarizeRequestLedger(accountingRows);
		return {
			ok: false,
			stage: "accounting",
			read_only: true,
			reasons: ["migration_required: existing legacy tool accounting cannot switch protocols"],
			consumed: historical.consumed,
			unresolved: historical.unresolved,
			diagnostics: historical.diagnostics,
		};
	}
	// E1-CC §4.1/§4.2: a planning run's Manifest is FROZEN as an immutable,
	// content-addressed canonical copy (file + directory fsync confirmed) BEFORE
	// any provider request. A resume locates the copy through the first accepted
	// Host start binding; an existing log without a valid binding, a missing copy
	// or a different Manifest holds with zero new requests/effects.
	const manifestDir = join(config.work_dir, "manifests");
	let canonicalManifestPath = null;
	if (manifest.planning_contract) {
		const runDigest = canonicalManifestDigest(manifest);
		let priorRows;
		try {
			priorRows = readEventsStrict(eventLogPath);
		} catch (error) {
			return { ok: false, reasons: [String(error instanceof Error ? error.message : error)], stage: "events" };
		}
		const firstStart = priorRows.find(
			(row) =>
				row?.event_type === "runtime.note" &&
				row.payload?.kind === "campaign.task.started" &&
				row.source?.kind === "runtime" &&
				row.payload?.campaign_id === manifest.campaign_id,
		);
		if (firstStart) {
			const bound = firstStart.payload.manifest_digest ?? null;
			if (!bound)
				return {
					ok: false,
					reasons: ["legacy_context_unavailable: the existing log has no trusted Manifest binding"],
					stage: "config",
					read_only: true,
				};
			const frozen = await loadImmutableManifest(manifestDir, bound);
			if (!frozen.ok) return { ok: false, reasons: [`planning_context_conflict: ${frozen.reason}`], stage: "config" };
			if (bound !== runDigest && !READ_ONLY_SCENARIO)
				return {
					ok: false,
					reasons: ["planning_context_conflict: the configured Manifest differs from the run's frozen Manifest"],
					stage: "config",
				};
			if (READ_ONLY_SCENARIO) manifest = frozen.manifest;
			canonicalManifestPath = frozen.path;
		} else if (!READ_ONLY_SCENARIO) {
			const persisted = await persistImmutableManifest(manifest, manifestDir);
			if (!persisted.ok || persisted.digest !== runDigest)
				return {
					ok: false,
					reasons: [`durability_unconfirmed: ${persisted.reason ?? "manifest not durable"}`],
					stage: "config",
				};
			canonicalManifestPath = persisted.path;
		}
	}
	// Read-only scenarios project the committed stream only: they never create an
	// SDK runtime, never dispatch a task and never append an event.

	// X5: the TRUSTED config decides the SDK/Observer stream, RAM, handoff and Task
	// binding. The Aegis Observer extension reads these from the environment, so we
	// set them from the config BEFORE any SDK object exists (overriding an inherited
	// decoy) and restore the previous values on exit, so a caller's stale
	// AEGIS_EVENT_LOG can never silently redirect the SDK writes. This is scoped to
	// the single Campaign run (C6 runs one Campaign at a time).
	// -----------------------------------------------------------------------
	// WORK-CYCLE RUN BINDING. The trusted config section is frozen into the
	// committed stream BEFORE any SDK object exists, so a restart/replay uses the
	// bound policy and a mutable env/config cannot silently change the trigger or
	// clear a hold. The candidate 3/8/4/85 values are NOT calibrated defaults: the
	// section is disabled unless the config explicitly enables it.
	// -----------------------------------------------------------------------
	const WORK_CYCLE_DEFAULTS = {
		enabled: false,
		repeat_limit: 3,
		action_window: 8,
		min_distinct_routes: 4,
		context_pressure_percent: 85,
		max_auto_rotations: 6,
		max_continuations: 8,
	};
	/** @type {{enabled: boolean, repeat_limit: number, action_window: number, min_distinct_routes: number, context_pressure_percent: number, max_auto_rotations: number, max_continuations: number, policy_event_id?: string|null, policy_origin?: string}} */
	let boundWorkCycle = { ...WORK_CYCLE_DEFAULTS };
	{
		const configured = { ...WORK_CYCLE_DEFAULTS, ...(config.work_cycle ?? {}) };
		const prior = readFrozenWorkCyclePolicy(readEventsSafe(eventLogPath), manifest.campaign_id);
		if (prior.ok) {
			const boundConfig = {
				enabled: prior.raw?.enabled === true,
				repeat_limit: prior.policy.repeat_limit,
				action_window: prior.policy.action_window,
				min_distinct_routes: prior.policy.min_distinct_routes,
				context_pressure_percent: prior.policy.context_pressure_percent,
				max_auto_rotations: Number.isSafeInteger(prior.raw?.max_auto_rotations)
					? prior.raw.max_auto_rotations
					: WORK_CYCLE_DEFAULTS.max_auto_rotations,
				max_continuations: Number.isSafeInteger(prior.raw?.max_continuations)
					? prior.raw.max_continuations
					: WORK_CYCLE_DEFAULTS.max_continuations,
			};
			const changed = Object.keys(WORK_CYCLE_DEFAULTS).filter((key) => boundConfig[key] !== configured[key]);
			if (!READ_ONLY_SCENARIO && changed.length > 0)
				return {
					ok: false,
					stage: "config",
					reasons: [
						`work_cycle_policy_conflict: the configured work_cycle differs from the run's frozen policy (${changed.join(", ")})`,
					],
				};
			boundWorkCycle = { ...boundConfig, policy_event_id: prior.event_id, policy_origin: "committed" };
		} else if (!READ_ONLY_SCENARIO) {
			const payload = frozenWorkCyclePolicyPayload(configured, manifest.campaign_id, {
				enabled: configured.enabled === true,
				max_auto_rotations: configured.max_auto_rotations,
				max_continuations: configured.max_continuations,
			});
			const writer = new EventLog(eventLogPath);
			/** @type {any} */
			const writerAny = writer;
			const opened = await writer.open();
			const written = opened.ok
				? await writerAny.append({
						event_type: "runtime.note",
						episode_id: null,
						payload,
						source: {
							kind: "runtime",
							actor_id: "c6-work-cycle",
							adapter: "c6-entry",
							version: C6_ENTRY_VERSION,
						},
						schema_version: "1.1",
					})
				: opened;
			await writer.close();
			if (!written?.ok || written.durable === false)
				return {
					ok: false,
					stage: "durability",
					reasons: ["work_cycle policy binding was not durably recorded"],
				};
			boundWorkCycle = {
				...configured,
				policy_event_id: written.event?.event_id ?? null,
				policy_origin: "written",
			};
		} else {
			boundWorkCycle = { ...configured, policy_origin: "config_read_only" };
		}
	}
	/** The FROZEN policy for every Host-side work-cycle projection. */
	function hostWorkCyclePolicy() {
		return {
			repeat_limit: boundWorkCycle.repeat_limit,
			action_window: boundWorkCycle.action_window,
			min_distinct_routes: boundWorkCycle.min_distinct_routes,
			context_pressure_percent: boundWorkCycle.context_pressure_percent,
		};
	}

	const aegisEnvKeys = [
		"AEGIS_EVENT_LOG",
		"AEGIS_RAM_DIR",
		"AEGIS_HANDOFF_FILE",
		"AEGIS_ROM_FILE",
		"AEGIS_TASK_ID",
		"AEGIS_PROJECTION_DIR",
		"AEGIS_MANIFEST_FILE",
		"AEGIS_TASK_CONTRACT_FILE",
		"AEGIS_WORK_CYCLE_REPEAT_LIMIT",
		"AEGIS_WORK_CYCLE_ACTION_WINDOW",
		"AEGIS_WORK_CYCLE_MIN_DISTINCT_ROUTES",
		"AEGIS_WORK_CYCLE_CONTEXT_PERCENT",
	];
	const envBefore = Object.fromEntries(aegisEnvKeys.map((key) => [key, process.env[key]]));
	const ramDir = join(config.work_dir, "ram");
	mkdirSync(ramDir, { recursive: true });
	const romPath = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "agent", "ROM.md");
	function bindObserverEnv(taskId) {
		delete process.env.AEGIS_TASK_CONTRACT_FILE;
		process.env.AEGIS_EVENT_LOG = eventLogPath;
		process.env.AEGIS_RAM_DIR = ramDir;
		process.env.AEGIS_HANDOFF_FILE = config.session.handoff_path;
		process.env.AEGIS_ROM_FILE = romPath;
		process.env.AEGIS_PROJECTION_DIR = join(config.work_dir, "projections");
		// The Observer rebuilds its Board with the SAME trusted Campaign context.
		if (canonicalManifestPath) process.env.AEGIS_MANIFEST_FILE = canonicalManifestPath;
		else process.env.AEGIS_MANIFEST_FILE = config.manifest_path;
		if (typeof taskId === "string" && taskId) process.env.AEGIS_TASK_ID = taskId;
		// The Observer must use the SAME frozen policy as the Host.
		process.env.AEGIS_WORK_CYCLE_REPEAT_LIMIT = String(boundWorkCycle.repeat_limit);
		process.env.AEGIS_WORK_CYCLE_ACTION_WINDOW = String(boundWorkCycle.action_window);
		process.env.AEGIS_WORK_CYCLE_MIN_DISTINCT_ROUTES = String(boundWorkCycle.min_distinct_routes);
		process.env.AEGIS_WORK_CYCLE_CONTEXT_PERCENT = String(boundWorkCycle.context_pressure_percent);
	}
	function restoreObserverEnv() {
		unbindWorkAccount();
		for (const key of aegisEnvKeys) {
			if (envBefore[key] === undefined) delete process.env[key];
			else process.env[key] = envBefore[key];
		}
	}
	bindObserverEnv(config.label ?? manifest.tasks?.[0]?.task_id ?? "campaign-task");

	// Provider model. For the offline default we register the faux provider.
	let modelRuntime;
	let model;
	let faux = null;
	try {
		if (READ_ONLY) {
			modelRuntime = null;
			model = null;
		} else if (configuredPi) {
			({ modelRuntime, model } = configuredPi);
		} else if (providerCheck.provider.kind === "faux") {
			const fauxFactory = fauxProviderFactory ?? (await importFauxFactory());
			faux = fauxFactory({ provider: "faux", models: [{ id: providerCheck.provider.model }] });
			model = faux.getModel();
			const authDir = join(config.work_dir, "sdk");
			mkdirSync(authDir, { recursive: true });
			const credentials = sdkImpl.AuthStorage.inMemory();
			await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-offline-key" }));
			modelRuntime = await sdkImpl.ModelRuntime.create({
				credentials,
				modelsPath: join(authDir, "models.json"),
				allowModelNetwork: false,
			});
			modelRuntime.registerProvider(model.provider, modelDetails(model));
		} else if (["local-openai", "remote-openai"].includes(providerCheck.provider.kind)) {
			// Register the explicit endpoint and model in the real SDK with isolated
			// credentials. Registration makes no request; the Worker gate bounds inference.
			const authDir = join(config.work_dir, "sdk");
			mkdirSync(authDir, { recursive: true });
			const credentials = sdkImpl.AuthStorage.inMemory();
			const providerId = providerCheck.provider.kind;
			const remote = providerId === "remote-openai";
			if (credentialInfo.env_name && process.env[credentialInfo.env_name]) {
				await credentials.modify(providerId, async () => ({
					type: "api_key",
					key: process.env[credentialInfo.env_name],
				}));
			}
			modelRuntime = await sdkImpl.ModelRuntime.create({
				credentials,
				modelsPath: join(authDir, "models.json"),
				allowModelNetwork: false,
			});
			model = {
				id: providerCheck.provider.model,
				name: providerCheck.provider.model,
				provider: providerId,
				api: providerCheck.provider.api ?? "openai-completions",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: remote ? 4096 : 16384,
				baseUrl: providerCheck.provider.base_url,
				...(remote
					? {
							compat: {
								maxTokensField: "max_tokens",
								supportsStore: false,
								supportsDeveloperRole: false,
								supportsReasoningEffort: false,
							},
						}
					: {}),
			};
			modelRuntime.registerProvider(providerId, { api: model.api, baseUrl: model.baseUrl, models: [model] });
		} else {
			return {
				ok: false,
				reasons: [`provider "${providerCheck.provider.kind}" is not implemented in offline C6`],
				stage: "sdk",
			};
		}
	} catch (error) {
		return { ok: false, reasons: [`SDK model runtime creation failed: ${String(error)}`], stage: "sdk" };
	}

	// The shared gate + the SDK runtime. The gate object is injected into EVERY
	// session's resource loader; the Host owns the same object.
	const { createCampaignActionGate } = await import("./campaign-mode.mjs");
	// C6's read-only tool checks the current Task grant and real workspace path.
	// Admit that transport explicitly; direct Pi read/write/bash remain denied.
	const gate = createCampaignActionGate({ allowDirectTools: ["aegis_read"] });

	// X3: the context max is a PER-REQUEST window, not a cumulative budget. The
	// campaign ledger's `input_chars` is the accumulated sum across requests; the
	// per-request window is enforced in the worker against `context.max_total_input_chars`.
	const contextWindowChars = config.context?.max_total_input_chars ?? 24000;
	// The cumulative ledger is rebuilt from the committed stream so a restart/measure
	// never resets it (X4). We persist each request RESERVATION and COMMIT as a
	// durable runtime.note. `consumed` is rebuilt from commits; a reservation with
	// no matching commit is a durable PENDING hold that still counts against
	// remaining (so a restart never forgets an in-flight request).
	const persistedLedgerRecords = [];
	const persistedUsage = { model_requests: 0, tool_calls: 0, input_chars: 0, wall_time_ms: 0 };
	const persistedByTask = new Map();
	const {
		consumed: rebuiltConsumed,
		byTask: rebuiltByTask,
		campaignPending,
		taskPending,
		committedReservations,
		taskCommittedByTask,
		unresolved: unresolvedRequestCount,
		diagnostics: rebuildDiagnostics,
		records: rebuiltRecords,
	} = summarizeRequestLedger(
		readEventsSafe(eventLogPath),
		durableAccounting
			? {
					toolCharges: projectQueueFromEvents({
						campaign_id: manifest.campaign_id,
						tasks: manifest.tasks,
						events: readEventsSafe(eventLogPath),
						manifest,
						artifacts: Object.fromEntries(artifactIndexFromEvents(readEventsSafe(eventLogPath))),
					}).tool_charges,
				}
			: {},
	);
	Object.assign(persistedUsage, rebuiltConsumed);
	for (const [taskId, dims] of rebuiltByTask) persistedByTask.set(taskId, dims);
	persistedLedgerRecords.push(...rebuiltRecords);
	// C-ISOLATION: a Task ledger is seeded ONLY with THAT Task's outstanding and
	// committed reservation identities. A global pending set would let Task A's
	// hold leak into Task B's ledger.
	const baseReserved = {
		model_requests: campaignPending.length,
		tool_calls: 0,
		input_chars: campaignPending.reduce((sum, note) => sum + note.inputChars, 0),
		wall_time_ms: 0,
		pending: campaignPending,
		committed: [...committedReservations],
	};
	// The reconciliation guard: a restart may not blindly re-dispatch while a
	// prior provider request is unresolved (pending hold) OR the rebuild saw an
	// invalid/conflicting record. This is the running stop/block path, not a
	// display-only unknown.
	const reconciliationGuard = {
		unresolved: unresolvedRequestCount,
		diagnostics: rebuildDiagnostics.length,
		diagnostics_detail: rebuildDiagnostics,
		runtimeBlocked: false,
	};
	const ledger = createToolLedger({
		limit: {
			model_requests: manifest.budget.model_requests,
			tool_calls: manifest.budget.tool_calls,
			// The cumulative input budget still exists as a bound, but it is NOT the
			// per-request window (that is contextWindowChars).
			input_chars: 0,
			wall_time_ms: manifest.budget.wall_time_ms,
		},
		baseConsumed: persistedUsage,
		baseReserved,
		onEvent: (/** @type {any} */ record) => {
			// Count REAL provider requests (including the automatic tool loop) so a
			// declared requests-per-session threshold can trigger a safe rotation.
			if (record.kind === "request.committed") requestsSinceRotation += 1;
		},
	});

	const buffer = createDecisionBuffer();
	let TypeSchema = null;
	try {
		TypeSchema = (await importPiAi()).Type;
	} catch {
		TypeSchema = null;
	}
	// X2: the decision tool consults the ACTIVE per-task ledger through this holder,
	// so the tool installed on the SDK session (created below, before assembly) can
	// still enforce the current task's tool/request allocation.
	const ledgerHolder = { ledger: null };
	const decisionState = { budget_terminated: false };
	// The ACTUAL current Task binding, so the observation read grant follows the
	// task the Host is running (never the union of every Manifest target).
	const currentTaskRef = { task: null };
	// E1-CC §7.2: the binding between each SDK tool call id and the REAL provider
	// request whose assistant message carried it (bound by the model worker at that
	// message_end). Tools never guess a request identity.
	const toolCallRegistry = createToolCallRegistry();
	const durableTools = true;
	/**
	 * Charge ONE tool unit durably before its body runs. Existing legacy streams
	 * are refused at entry; new runs use the existing Host durable ledger.
	 */
	async function chargeUnit({ unit_id, tool_call_id, tool_name, arguments_digest }) {
		if (!durableTools) return null;
		if (!hostRef || typeof hostRef.chargeTool !== "function")
			return { ok: false, reasons: ["invalid_tool_binding: no Host is bound"] };
		const binding = toolCallRegistry.lookup(tool_call_id);
		if (!binding) return { ok: false, reasons: ["invalid_tool_binding: the tool call has no dispatched request"] };
		// The producing request's durable commit must settle BEFORE the charge.
		const settled = await binding.commit.catch((error) => ({ ok: false, error: String(error) }));
		if (!settled || settled.ok === false)
			return { ok: false, reasons: [`durability_unconfirmed: ${settled?.error ?? "request commit failed"}`] };
		return hostRef.chargeTool({ request_id: binding.request_id, tool_call_id, unit_id, tool_name, arguments_digest });
	}
	async function finishUnit({ unit_id, tool_call_id, tool_name }) {
		if (!durableTools || !hostRef) return null;
		const binding = toolCallRegistry.lookup(tool_call_id);
		if (!binding) return { ok: false, reasons: ["invalid_tool_binding: the tool call has no dispatched request"] };
		return hostRef.finishTool({ request_id: binding.request_id, tool_call_id, unit_id, tool_name });
	}
	const unbindWorkAccount = bindWorkToolAccount(eventLogPath, {
		async admit({ tool_call_id, tool_name, arguments_digest }) {
			const work = executionPermit({
				task_id: currentTaskRef.task?.task_id,
				operation: "tool_unit",
				tool_name,
			});
			if (!work.ok) return { ok: false, reasons: work.reasons };
			return (
				(await chargeUnit({ unit_id: "call", tool_call_id, tool_name, arguments_digest })) ??
				(ledgerHolder.ledger ? ledgerHolder.ledger.admitTool({ tool_name }) : { ok: false, reason: "no active ledger" })
			);
		},
		async finish({ tool_call_id, tool_name }) {
			return (await finishUnit({ unit_id: "call", tool_call_id, tool_name })) ?? { ok: true };
		},
	});
	const decisionCapture = {
		tool: READ_ONLY
			? null
			: createDecisionCaptureTool({
					sdk: sdkImpl,
					buffer,
					type: TypeSchema ?? undefined,
					state: decisionState,
					admitTool: ({ tool_name }) =>
						ledgerHolder.ledger ? ledgerHolder.ledger.admitTool({ tool_name }) : { ok: true },
					// E1-CC §7.2: in a durable-charge run each decision UNIT is charged by the
					// Host (actual accepted Task/Episode, real SDK tool call id, producing
					// request) BEFORE it is buffered, and finished after the body returns.
					chargeUnit,
					finishUnit,
					remainingRequests: () => (ledgerHolder.ledger ? ledgerHolder.ledger.remaining().model_requests : 1),
				}),
		buffer,
	};
	// X11: an authorized, read-only observation path so the model can inspect the
	// real target before deciding. It performs NO effect; the Broker remains the
	// only effect path.
	const observationTool =
		!READ_ONLY && TypeSchema
			? createObservationTool({
					sdk: sdkImpl,
					type: TypeSchema,
					workspaceRoot: config.workspace_root,
					chargeUnit,
					finishUnit,
					// X5/X11: the read grant is the CURRENT task's own target(s), resolved
					// against the real workspace location. The whole-Manifest target set is
					// NOT used as a fallback, so task A cannot read task B's file.
					grantProvider: () => ({
						task_id: currentTaskRef.task?.task_id ?? null,
						targets: currentTaskRef.task
							? [currentTaskRef.task.target_ref, currentTaskRef.task.definition?.target_ref].filter(Boolean)
							: [],
					}),
				})
			: null;
	const extraTools = observationTool ? [observationTool] : [];
	// E1: the structured plan submission tool. It records a candidate plan only;
	// admission is a separate Host step. Active only when planning is enabled.
	if (!READ_ONLY && config.planning?.enabled === true && TypeSchema) {
		const { createPlanSubmitTool } = await import("./c6-model-worker.mjs");
		const { PLAN_LIMITS } = await import("./e1-plan-contract.mjs");
		extraTools.push(
			createPlanSubmitTool({
				sdk: sdkImpl,
				buffer,
				type: TypeSchema,
				planLimits: PLAN_LIMITS,
				planningContext,
				chargeUnit,
				finishUnit,
				recordPlan: async (plan) => {
					// The tool and the Host share ONE dedup + writer (§6.1). When the Host is
					// assembled, route through recordPlanCandidate so a later admit reuses this
					// durable candidate instead of appending a duplicate submitted record.
					if (hostRef && typeof hostRef.recordPlanCandidate === "function") {
						const result = await hostRef.recordPlanCandidate({
							plan,
							planningTaskId: currentTaskRef.task?.task_id ?? "task-plan",
						});
						return result.ok
							? { ok: true, event_id: result.submitted_event_id ?? null }
							: { ok: false, error: (result.reasons ?? []).join("; ") || "record refused" };
					}
					if (!sinkRef || typeof sinkRef.append !== "function")
						return { ok: false, error: "no durable writer is bound" };
					const written = await sinkRef.append({
						event_type: "runtime.note",
						episode_id: `ep-${currentTaskRef.task?.task_id ?? "task-plan"}`,
						payload: {
							kind: "campaign.plan.submitted",
							campaign_id: manifest.campaign_id ?? null,
							plan_id: plan.plan_id ?? null,
							plan_digest: e1Planning.planDigest(plan),
							plan,
							planning_task_id: currentTaskRef.task?.task_id ?? "task-plan",
						},
						source: { kind: "llm", actor_id: "c6-model", adapter: "c6-entry", version: C6_ENTRY_VERSION },
						schema_version: "1.1",
					});
					if (written?.ok === true) return { ok: true };
					return { ok: false, error: written?.error ?? "durable append failed" };
				},
			}),
		);
	}

	// The real SDK runtime (or an injected seam for tests). Read-only scenarios do
	// not create one.
	let sdkRuntime = null;
	/** @type {any} */
	let sessionController = null;
	if (!READ_ONLY) {
		try {
			sdkRuntime = createSeam
				? await createSeam({
						provider: providerCheck.provider,
						model,
						modelRuntime,
						gate,
						cwd,
						agentDir,
						sessionDir,
						sdk: sdkImpl,
						decisionCapture,
						extraTools,
					})
				: await createCampaignSdkRuntime({
						provider: providerCheck.provider,
						model,
						modelRuntime,
						gate,
						cwd,
						agentDir,
						sessionDir,
						sdk: sdkImpl,
						decisionCapture,
						extraTools,
					});
		} catch (error) {
			return { ok: false, reasons: [`SDK runtime creation failed: ${String(error)}`], stage: "sdk" };
		}
		if (!sdkRuntime || typeof sdkRuntime.session !== "function") {
			return { ok: false, reasons: ["SDK runtime seam did not return a runtime handle"], stage: "sdk" };
		}
	}

	let server = null;
	let unbind = null;
	let controlResult = null;
	let runResult = null;
	let exportResult = null;
	let rotationResult = null;
	const rotationAttempts = [];
	const dynamicAdmissions = [];
	const pendingToolAdmissions = [];
	let requestsSinceRotation = 0;
	let hostRef = null;
	let sinkRef = null;
	let learningBridgeRef = null;
	let learningStoreRef = null;

	/** A C2-shaped budget ledger derived from the trusted config (session_count only). */
	function sessionLedger() {
		const limit = config.session.budget_ledger?.limit ?? { session_count: config.session.session_count };
		const consumed = config.session.budget_ledger?.consumed ?? { session_count: 0 };
		const reserved = config.session.budget_ledger?.reserved ?? { session_count: 0 };
		return { limit, consumed, reserved, max_requests_per_session: config.session.max_requests_per_session };
	}

	/** Build (once) the learning bridge over the assembled registry/broker. */
	async function ensureLearningBridge() {
		if (learningBridgeRef) return learningBridgeRef;
		if (!hostRef) return null;
		learningStoreRef = createCampaignLearningStore(config.work_dir);
		learningBridgeRef = buildLearningBridgeFromStream();
		return learningBridgeRef;
	}

	/**
	 * Read the current target state and commit it as a trusted obtained-data
	 * record, returning a resolver-verifiable current-state ref. This is a
	 * read-only observation; it lets the Router decide `direct`/`habit` from a
	 * VERIFIED current state rather than an unknown one.
	 */
	async function observeCurrentState({ task }) {
		const target = task?.target_ref ?? task?.definition?.target_ref ?? null;
		if (!target || typeof target !== "string") return { state: null, currentStateRef: null };
		let state = null;
		try {
			const absolute = resolve(config.workspace_root, target);
			if (!absolute.startsWith(resolve(config.workspace_root))) return { state: null, currentStateRef: null };
			state = JSON.parse(readFileSync(absolute, "utf8"));
		} catch {
			return { state: null, currentStateRef: null };
		}
		if (!state || typeof state !== "object" || Array.isArray(state)) return { state: null, currentStateRef: null };
		const dataRef = {
			ref_type: "data",
			ref_id: `current-state:${task.task_id}:${readEventsSafe(eventLogPath).length}`,
		};
		const written = await sinkRef?.append?.({
			event_type: "runtime.note",
			episode_id: `ep-${task.task_id}`,
			payload: { kind: "data.obtained", data_ref: dataRef, value: state, source: "c6-current-state" },
			source: { kind: "runtime", actor_id: "c6-router", adapter: "c6-entry", version: C6_ENTRY_VERSION },
			schema_version: "1.1",
		});
		if (written?.ok !== true) return { state: null, currentStateRef: null };
		return {
			state,
			currentStateRef: { ...dataRef, digest: digest(state) },
		};
	}

	/** Build a fresh bridge over the CURRENT committed stream (never cached). */
	function buildLearningBridgeFromStream() {
		if (!hostRef) return null;
		const events = readEventsSafe(eventLogPath);
		return buildCampaignLearningBridge({
			events,
			registry: assembled?.registry,
			broker: assembled?.broker,
			authorization: assembled?.authorization,
			environment: {
				environment_fingerprint: config.learning?.environment?.environment_fingerprint ?? "campaign-local",
				domain: config.learning?.environment?.domain ?? null,
				permissions: config.learning?.environment?.permissions ?? [],
				task_types: config.learning?.environment?.task_types ?? [],
			},
			sink: sinkRef,
			manifest,
		});
	}

	function buildSessionController() {
		if (!sdkRuntime) {
			// Read-only scenarios have no SDK runtime: rotation is refused, never faked.
			return {
				committedRotations: () =>
					readEventsSafe(eventLogPath).filter((e) => e.event_type === "handoff.completed").length,
				canRotate: () => ({ allowed: false, reason: "read-only scenario has no SDK runtime" }),
				rotate: async () => ({ applied: false, reason: "read-only scenario has no SDK runtime" }),
				recoverInterrupted: () => ({ recovered: false, reason: "read-only scenario" }),
			};
		}
		// Reuse the accepted C2 supervisor through the SDK runtime's newSession seam.
		// The Host stages a handoff decision into the shared handoff file, then the
		// supervisor applies it through the REAL SDK and verifies that exactly one
		// `handoff.completed` is committed for the request (no false completion).
		const supervisor = createSessionSupervisor({
			eventLogPath,
			handoffPath: config.session.handoff_path,
			runtime: {
				newSession: (options) => sdkRuntime.runtime.newSession(options),
				get session() {
					return sdkRuntime.session();
				},
			},
			taskId: config.label ?? "campaign-task",
			budget: sessionLedger(),
			manifest,
		});
		return {
			committedRotations: () => readEventsSafe(eventLogPath).filter((e) => e.event_type === "handoff.completed").length,
			canRotate: () => supervisor.canRotate(),
			rotate: async (options = {}) => {
				const before = sdkRuntime.session();
				// Stage the Host's rotation request so the observer writes exactly one
				// completion at the post-bind boundary (the same path as a model request).
				const staged = stageHostHandoff({
					eventLogPath,
					handoffPath: config.session.handoff_path,
					taskId: config.label ?? "campaign-task",
					reason: options.reason ?? "auto_request_threshold",
					manifest,
					workCyclePolicy: hostWorkCyclePolicy(),
					workCycleIdentity: options.work_cycle_identity ?? null,
					workCycleReasons: options.work_cycle_reasons ?? [],
				});
				if (!staged.ok) return { applied: false, reason: staged.reason };
				const result = /** @type {any} */ (
					await supervisor.rotate({ requestId: staged.request_id, reason: staged.reason })
				);
				if (result.applied === true && result.reused !== true) {
					// Rebind the SDK subscriptions to the new session (C6-A rebind seam).
					const after = sdkRuntime.session();
					await sdkRuntime.rebind?.(after);
					result.new_session_id = safeSessionId(after);
					result.new_object = after !== before;
				}
				return result;
			},
			recoverInterrupted: () => supervisor.recoverInterrupted(),
		};
	}

	/** Committed rows for an EXECUTION decision (the Host sink, else a strict read). */
	function committedRows() {
		if (sinkRef && typeof sinkRef.replay === "function") return sinkRef.replay();
		return readEventsStrict(eventLogPath);
	}
	/** The ONE authoritative projection over the current committed stream. */
	function authorityProjection(rows = committedRows()) {
		return projectQueueFromEvents({
			campaign_id: manifest.campaign_id,
			tasks: manifest.tasks ?? [],
			events: rows,
			revision: manifest.revision ?? 0,
			manifest,
		});
	}
	/**
	 * The common execution permit at a provider/tool/effect boundary, evaluated on
	 * the LATEST prefix (never cached). An unfinished durable tool charge of the
	 * active task also holds later effects/continuations (E1-CC §7.2).
	 */
	function executionPermit({ task_id, operation, tool_name = null }) {
		let projection;
		try {
			projection = authorityProjection();
		} catch (error) {
			return {
				ok: false,
				reasons: [{ code: "full_replay_required", field: null, event_id: null, message: String(error) }],
			};
		}
		const permit = inspectExecutionPermit({ projection, taskId: task_id, now: Date.now(), operation });
		const work = inspectWorkPermit({ events: committedRows(), taskId: task_id });
		if (!work.ok)
			permit.reasons.push({
				code: work.code,
				field: "work_control",
				event_id: work.work.candidate?.event_id ?? null,
				message: "work controller withheld execution",
			});
		permit.ok = permit.reasons.length === 0;
		// WORK-CYCLE HOLD at the REAL effect boundary. A buffered plan/Experience
		// direct route reaches this check right before each effect; the next effect
		// after a trigger is refused even if the whole batch was admitted earlier.
		// Provider requests and advisory/read/review tools stay available so the
		// model can perform the required review in the SAME Session.
		const advisoryTool = operation === "tool_unit" && isWorkCycleAdvisoryTool(tool_name);
		if (operation !== "provider_request" && !advisoryTool) {
			try {
				const rows = committedRows();
				const episodeId = `ep-${task_id}`;
				const cycle = projectWorkCycle(rows, episodeId, {
					board: projectBoard(rows, { manifest }),
					manifest,
					policy: hostWorkCyclePolicy(),
				});
				if (cycle.review_required)
					permit.reasons.push({
						code: "work_review_required",
						field: "work_cycle",
						event_id: cycle.review?.event_id ?? cycle.trigger_id ?? null,
						message: `work review pending (${cycle.reasons.join(", ")}); trigger ${cycle.trigger_id ?? "unknown"}`,
					});
				// Work-unit START gate at the REAL effect boundary. Honoured only when the
				// trusted Host bound it (the Experiment Console does). A scoped Intent must
				// already be committed and effective; a buffered plan admitted earlier in
				// the same batch cannot outrun the commit.
				if (!cycle.review_required && workStartGateEnabled(process.env) && cycle.unscoped === true)
					permit.reasons.push({
						code: "work_unit_unscoped",
						field: "work_cycle",
						event_id: null,
						message:
							"no accepted scoped work Intent exists for this Episode; every effect is refused until one is durably committed",
					});
			} catch (error) {
				// Fail closed: an unreadable projection keeps effects blocked.
				permit.reasons.push({
					code: "work_cycle_projection_failed",
					field: "work_cycle",
					event_id: null,
					message: String(error),
				});
			}
			permit.ok = permit.reasons.length === 0;
		}
		if (durableTools && operation !== "tool_unit") {
			const open = (projection.tool_charges ?? []).filter(
				(entry) => entry.task_id === task_id && entry.finished !== true,
			);
			if (open.length > 0)
				permit.reasons.push({
					code: "tool_unsettled",
					field: "tool_calls",
					event_id: open[0].charge_event_id ?? null,
					message: `${open.length} charged tool unit(s) have no durable finished record`,
				});
			permit.ok = permit.reasons.length === 0;
		}
		return permit;
	}

	let assembled;
	let modelWorker;
	let brokerRef = null;
	// Select the registered adapter + judge for the configured task family. The
	// fixture-state family keeps the accepted C3 behavior; structured-data-repair
	// registers the reviewed data adapter and its INDEPENDENT file-recheck judge.
	let extraContracts = [];
	let judgeFactory = null;
	if (config.task_family === "structured-data-repair") {
		const { createStructuredDataAdapter, createDataRepairJudge } = await import(
			"../execution/adapters/structured-data-adapter.mjs"
		);
		extraContracts = [createStructuredDataAdapter({ workspaceRoot: config.workspace_root })];
		judgeFactory = ({ workspaceRoot, manifest: judgedManifest }) =>
			withPlanReadyJudge({
				baseJudge: createDataRepairJudge({ workspaceRoot }),
				e1Planning,
				enabled: config.planning?.enabled === true,
				readEvents: () => readEventsSafe(eventLogPath),
				manifest: judgedManifest,
			});
	} else if (config.task_family === "code-repair") {
		const { createCodeRepairAdapter, createCodeRepairJudge } = await import(
			"../execution/adapters/code-repair-adapter.mjs"
		);
		const { runRegisteredTest } = await import("../verification/registered-test.mjs");
		extraContracts = [createCodeRepairAdapter({ workspaceRoot: config.workspace_root })];
		// Tested target code receives a minimal runtime environment, never provider keys.
		const testEnv = Object.fromEntries(
			["PATH", "TMPDIR", "LANG", "LC_ALL", "SystemRoot"]
				.filter((key) => process.env[key] !== undefined)
				.map((key) => [key, process.env[key]]),
		);
		// The test procedure is HOST code (a registered, read-only external test),
		// never model code. The model cannot modify the test to manufacture success.
		judgeFactory = ({ workspaceRoot, manifest: judgedManifest }) =>
			withPlanReadyJudge({
				baseJudge: createCodeRepairJudge({
					workspaceRoot,
					runTests: (root) =>
						runRegisteredTest({ workspaceRoot: root, testFile: config.registered_test ?? "check.mjs", env: testEnv }),
				}),
				e1Planning,
				enabled: config.planning?.enabled === true,
				readEvents: () => readEventsSafe(eventLogPath),
				manifest: judgedManifest,
			});
	}
	try {
		// Build the model ledger/plan worker wiring. The composite worker is
		// injected as the Host worker so ONE broker path executes the plan.
		sessionController = buildSessionController();
		assembled = await assembleCampaignHost({
			manifest,
			workspaceRoot: config.workspace_root,
			workDir: config.work_dir,
			eventLogPath,
			mode: config.mode,
			actionGate: gate,
			extraContracts,
			judgeFactory,
			sessionController,
			wrapWorker: (brokerWorker) => {
				// X2: a PER-TASK ledger bounded by the task's own allocation. The
				// cumulative campaign ledger is mirrored on each commit for restart/measure.
				let currentTaskId = config.label ?? "campaign-task";
				let currentTaskLedger = null;
				const ledgerFactory = (task) => {
					currentTaskId = task?.task_id ?? currentTaskId;
					currentTaskRef.task = task ?? currentTaskRef.task;
					// The Task budget is the ONE normalized executable budget. A STATIC task
					// whose dims were explicitly zeroed keeps its own (0) limit; we NEVER fall
					// back to the Campaign total for a dynamic task, which would silently widen
					// its allocation (E1 §5.1/§7). The static Manifest path keeps the explicit
					// task_budget produced by normalizeExecutableTask at assembly time.
					const alloc = normalizeTaskBudget(task);
					const taskBase = persistedByTask.get(currentTaskId) ?? { model_requests: 0, tool_calls: 0, input_chars: 0 };
					// C-ISOLATION: only THIS Task's own pending holds and committed
					// reservation identities seed this Task's ledger.
					const taskBaseReserved = reservedSeedForTask(taskPending, taskCommittedByTask, currentTaskId);
					currentTaskLedger = createToolLedger({
						limit: {
							model_requests: alloc.model_requests,
							tool_calls: alloc.tool_calls,
							input_chars: 0,
							wall_time_ms: alloc.wall_time_ms,
						},
						baseConsumed: taskBase,
						baseReserved: taskBaseReserved,
						onEvent: (/** @type {any} */ record) => {
							if (record.kind === "tool.admitted") pendingToolAdmissions.push(record);
						},
					});
					ledgerHolder.ledger = currentTaskLedger;
					decisionState.budget_terminated = false;
					return currentTaskLedger;
				};
				modelWorker = createModelWorker({
					session: () => sdkRuntime?.session() ?? null,
					ledger,
					ledgerFactory,
					contextWindowChars,
					romPath,
					reconciliationGuard,
					toolCallRegistry,
					executionPermit,
					context: config.context ?? { max_total_input_chars: 24000, output_reserve_chars: 2000 },
					taskId: config.label ?? "campaign-task",
					campaignId: manifest.campaign_id ?? null,
					goal: manifest.objective?.description ?? manifest.title ?? "",
					planning: planningContext ? { context: planningContext } : null,
					actionCatalog: null,
					getActionCatalog: () => ({ actions: safeDescribe(brokerRef) }),
					// X5: the RAM/facts/refs are bound to the CURRENT task's episode, never
					// the first episode in the map.
					ramProvider: () => {
						const events = committedRows();
						const board = projectBoard(events, { manifest });
						const state = projectState(events);
						const episodeId = `ep-${currentTaskId}`;
						return buildRam({ board, state, episodeId, goal: manifest.objective?.description ?? "" });
					},
					// X5: bind the Observer's Task/Episode (and stream env) to the current
					// Host task before its prompt.
					setTaskBinding: (task) => {
						currentTaskId = task?.task_id ?? currentTaskId;
						currentTaskRef.task = task ?? currentTaskRef.task;
						bindObserverEnv(currentTaskId);
					},
					// X4: persist each request RESERVATION and COMMIT as a durable runtime.note
					// so the cumulative ledger (and any in-flight pending hold) rebuild after
					// restart/measure. The provider gate AWAITS this before calling the
					// provider; a failed reservation write means the provider is not called.
					persistRequest: async (/** @type {any} */ request) => {
						const phase = request?.phase ?? "committed";
						const requestId = request?.request_id ?? null;
						const taskRes = request?.task_reservation_id ?? null;
						const campaignRes = request?.campaign_reservation_id ?? null;
						// A reservation without a stable request identity and at least one
						// reservation id is NOT a legal hold: refuse it so the provider is not
						// called behind a null-id record.
						if (phase === "reserved" && (!requestId || (!taskRes && !campaignRes))) {
							return { ok: false, error: "reserved request requires request_id and a reservation id" };
						}
						// A committed/reconciliation record must name BOTH sides for a joint
						// request (single-ledger mode uses the same id twice).
						if (phase === "committed" && (!requestId || !taskRes || !campaignRes)) {
							return { ok: false, error: "committed request requires request_id, task and campaign reservation ids" };
						}
						if (!sinkRef || typeof sinkRef.append !== "function") {
							return { ok: false, error: "no durable writer is bound" };
						}
						const usage = request?.usage ?? null;
						// A durable-charge run counts tools ONLY through `c6.tool`; the legacy
						// per-request aggregate is not written, so it can never double-count.
						const toolCalls =
							!durableTools && (phase === "committed" || phase === "reconciliation_required")
								? pendingToolAdmissions.length
								: undefined;
						const written = await sinkRef.append({
							event_type: "runtime.note",
							episode_id: `ep-${request?.task_id ?? currentTaskId}`,
							payload: {
								kind: "c6.request",
								phase,
								campaign_id: manifest.campaign_id ?? null,
								task_id: request?.task_id ?? currentTaskId,
								request_id: requestId,
								task_reservation_id: taskRes,
								campaign_reservation_id: campaignRes,
								input_chars: request?.input_chars ?? 0,
								...(Array.isArray(request?.coverage) ? { coverage: request.coverage } : {}),
								...(request?.source ? { input_source: request.source } : {}),
								...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
								...(durableTools ? { tool_accounting: "durable-charge-v1" } : {}),
								...(request?.provider_started === true ? { provider_started: true } : {}),
								...(request?.provider_status ? { provider_status: request.provider_status } : {}),
								...(request?.stop_reason ? { stop_reason: request.stop_reason } : {}),
								...(request?.commit_status ? { commit_status: request.commit_status } : {}),
								...(request?.failure_reason ? { failure_reason: request.failure_reason } : {}),
								wall_time_ms: Date.now(),
								...(phase === "committed" || phase === "reconciliation_required"
									? { usage, usage_source: request?.usage_source ?? usage?.source ?? "unknown" }
									: {}),
							},
							source: { kind: "runtime", actor_id: "c6-ledger", adapter: "c6-entry", version: C6_ENTRY_VERSION },
							schema_version: "1.1",
						});
						if (phase === "committed" || phase === "reconciliation_required") pendingToolAdmissions.length = 0;
						if (written?.ok === true) return { ok: true };
						return { ok: false, error: written?.error ?? "durable append failed" };
					},
					decisionBuffer: buffer,
					decisionState,
					router:
						config.learning?.policy === "off"
							? null
							: async ({ task: routedTask }) => {
									// Route BEFORE the model plans. FIRST observe the real current state and
									// commit it, so the router's resolver sees the JUST-COMMITTED
									// current-state ref (a stale resolver reports `when` as unknown).
									if (!learningStoreRef) learningStoreRef = createCampaignLearningStore(config.work_dir);
									const { state: currentState, currentStateRef } = await observeCurrentState({
										task: routedTask,
									});
									const bridge = buildLearningBridgeFromStream() ?? (await ensureLearningBridge());
									if (!bridge) return { route: "deliberate", planning_requests: 1 };
									const experiences = await loadAuthoritativeExperiences({
										store: learningStoreRef,
										events: readEventsSafe(eventLogPath),
									});
									const decision = routeBeforeModel({
										bridge,
										experiences,
										task: routedTask,
										currentState,
										currentStateRef,
										episodeId: `ep-${routedTask.task_id}`,
									});
									if (decision.route === "direct" && decision.action_ref) {
										return {
											...decision,
											actions: [
												{
													action_ref: decision.action_ref,
													arguments: decision.arguments ?? {},
													criterion_id: null,
												},
											],
										};
									}
									return decision;
								},
					onEvent: (/** @type {any} */ record) => {
						if (record.kind === "request.committed") requestsSinceRotation += 1;
						out(`  [ledger] ${JSON.stringify(record)}`);
					},
				});
				// Recovery/continuation must not reuse a committed action id: seed the
				// plan generation from the committed stream's prior model steps.
				const priorGenerations = readEventsSafe(eventLogPath)
					.map((row) => /:model:(\d+):/.exec(String(row.payload?.step_id ?? ""))?.[1])
					.filter((value) => value !== undefined)
					.map(Number);
				const generationStart = priorGenerations.length > 0 ? Math.max(...priorGenerations) + 1 : 0;
				const plan = createModelPlan({ decisionsByTask: buffer.byTask(), generationStart });
				// Rebuild the Broker Worker with the MODEL plan instead of the fixture plan.
				brokerWorker.setPlan?.(plan);
				const composite = createCompositeWorker({
					modelWorker,
					brokerWorker,
					buffer,
					// E1-CC §6.2: every candidate goes through the ONE Host command, in the
					// tools' sequential (durable) order. The result is decided by the Host's
					// active plan, never by "the last command in this loop".
					onPlanSubmitted: async ({ task: planTask, plans }) => {
						if (!hostRef || config.planning?.enabled !== true || !e1Planning) return { ok: true };
						const { admitCandidatePlan } = e1Planning;
						const settlement = summarizeRequestLedger(committedRows());
						let last = { ok: false, status: "blocked", reasons: ["no candidate plan"] };
						let accepted = null;
						for (const plan of plans) {
							last = await admitCandidatePlan({
								plan,
								host: hostRef,
								planningTaskId: planTask?.task_id ?? e1Planning.PLANNING_TASK_ID,
								planningSettled: settlement.unresolved === 0,
							});
							dynamicAdmissions.push(last);
							if (last.ok === true && !accepted) accepted = last;
						}
						return accepted ?? last;
					},
					permitEffect: ({ task: effectTask }) =>
						executionPermit({ task_id: effectTask.task_id, operation: "broker_effect" }),
					workCycleEnabled: boundWorkCycle.enabled,
					onTaskSettled: async () => {
						// Admit any model-proposed bounded dynamic tasks through the ONE policy.
						if (hostRef && buffer.listTasks().length > 0) {
							for (const proposal of buffer.listTasks()) {
								const admission = await hostRef.proposeDynamicTask({ proposal });
								dynamicAdmissions.push(admission);
							}
						}
						// A safe settle boundary: rotate only when the declared threshold is
						// reached, an idle/settled/committed Host exists and budget allows.
						// When the explicit work-cycle policy is enabled the Host loop merges
						// the request threshold with the work-cycle reasons into ONE rotation,
						// so this legacy path stays inactive to avoid a double Session charge.
						if (boundWorkCycle.enabled) return;
						const threshold = config.session.max_requests_per_session;
						if (!hostRef || !Number.isInteger(threshold) || threshold < 1) return;
						if (requestsSinceRotation < threshold) return;
						const rotation = await hostRef.rotateSession({ reason: "auto_request_threshold" });
						rotationAttempts.push(rotation);
						if (rotation?.applied === true && rotation.reused !== true) requestsSinceRotation = 0;
					},
				});
				// An optional outer worker seam (trusted tests/tooling) that observes the
				// result AFTER the Broker effect; it never changes scheduling semantics.
				return typeof workerSeam === "function" ? workerSeam(composite) : composite;
			},
		});
	} catch (error) {
		// X12: a read-only scenario has no sdkRuntime; never let a null access
		// replace the real, structured failure. Dispose only what exists.
		try {
			await sdkRuntime?.dispose?.();
		} catch {
			// ignore cleanup failure; preserve the original reason
		}
		return { ok: false, reasons: [error instanceof Error ? error.message : String(error)], stage: "assembly" };
	}
	const { host, sink } = assembled;
	brokerRef = assembled.broker ?? null;
	hostRef = host;
	sinkRef = sink;
	let removeSignalHandlers = () => {};

	try {
		unbind = bindHostEventLog(eventLogPath, sink.log);

		// X9: signal handling that AWAITS the durable drain and removes the handler
		// before cleanup, so a resident observe can exit cleanly.
		let signalReceived = null;
		let resolveSignal = null;
		const signalPromise = new Promise((resolve) => {
			resolveSignal = resolve;
		});
		const onSignal = (signal) => {
			if (signalReceived) return;
			signalReceived = signal;
			void (async () => {
				try {
					await host.stop(`signal_${signal}`);
				} catch {
					// ignore: the drain is best-effort
				}
				resolveSignal(signal);
			})();
		};
		const sigtermHandler = () => onSignal("SIGTERM");
		const sigintHandler = () => onSignal("SIGINT");
		let signalsInstalled = false;
		if (installSignalHandlers && signalSource && typeof signalSource.on === "function") {
			signalSource.on("SIGTERM", sigtermHandler);
			signalSource.on("SIGINT", sigintHandler);
			signalsInstalled = true;
		}
		const removeSignalHandlers_ = () => {
			if (!signalsInstalled || typeof signalSource.removeListener !== "function") return;
			signalSource.removeListener("SIGTERM", sigtermHandler);
			signalSource.removeListener("SIGINT", sigintHandler);
			signalsInstalled = false;
		};
		removeSignalHandlers = removeSignalHandlers_;

		if (observe || scenario === "observe" || config.observation.enabled) {
			server = createObservationServer({
				manifestPath: config.manifest_path,
				eventsPath: eventLogPath,
				host: config.observation.host,
				port: port ?? config.observation.port,
			});
			try {
				await server.listen();
				out(`observation board: ${server.url}`);
			} catch (error) {
				await server.close();
				server = null;
				out(`observation unavailable: ${error instanceof Error ? error.message : "bind failed"}`);
			}
		}

		try {
			if (scenario === "pause") {
				controlResult = await host.pause("cli_pause");
				if (controlResult.ok) runResult = await host.run();
			} else if (scenario === "resume") {
				controlResult = { ok: true };
				for (const task of authorityProjection().tasks) {
					const work = projectWorkControl(committedRows(), task.task_id);
					if (!work.candidate) continue;
					const controller = createWorkController({
						events: committedRows,
						append: (row) => sinkRef.append(row),
						taskId: task.task_id,
						episodeId: work.candidate.episode_id,
					});
					controlResult = await controller.resume("Host CLI resume", "runtime");
					if (!controlResult.ok) break;
				}
				if (controlResult.ok) controlResult = await host.resume("cli_resume");
				if (controlResult.ok) runResult = await host.run();
			} else if (scenario === "cancel") {
				controlResult = await host.cancel("cli_cancel");
				if (controlResult.ok) runResult = await host.run();
			} else if (scenario === "rotate") {
				rotationResult = await host.rotateSession({ reason: "cli_rotate" });
				runResult = await host.run();
			} else if (["status", "export", "observe", "measure"].includes(scenario)) {
				const { rows: events, errors } = parseJsonl(existsSync(eventLogPath) ? readFileSync(eventLogPath, "utf8") : "");
				if (errors.length || !verifyChain(events).ok) throw new Error("committed event log is corrupt");
				const projection = projectQueueFromEvents({
					campaign_id: manifest.campaign_id,
					tasks: manifest.tasks ?? [],
					events,
					revision: manifest.revision ?? 0,
					manifest,
					artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
				});
				runResult = {
					ok: projection.ok,
					status: {
						projection,
						campaign_state: projection.control?.state ?? "unknown",
						work_control: projection.tasks.map((task) => {
							const work = projectWorkControl(events, task.task_id);
							return {
								task_id: task.task_id,
								state: work.state,
								policy_error: work.policyError,
								candidate_event_id: work.candidate?.event_id ?? null,
							};
						}),
					},
				};
			} else {
				// R2: recover an INTERRUPTED/REFUSED handoff through the SAME
				// Host/Supervisor path BEFORE dispatching the next work unit. A staged
				// request without a committed completion is not permission to continue;
				// if the budget/safety gate refuses it, the Task stays running and no
				// next-unit effect is sent. With a corrected budget the Supervisor
				// creates the replacement Session once, and only then may Host.run()
				// continue the same committed boundary.
				let recoveryBlocked = false;
				if (existsSync(config.session.handoff_path)) {
					const recovery = await sessionController.recoverInterrupted();
					if (recovery.recovered === true) {
						rotationAttempts.push(recovery);
					} else if (!/already completed|no staged handoff to recover/i.test(recovery.reason ?? "")) {
						rotationAttempts.push(recovery);
						recoveryBlocked = true;
						runResult = {
							ok: true,
							status: host.status(),
							reasons: [`handoff_recovery_refused: ${recovery.reason ?? "unknown"}`],
							work_cycle: { reason: "handoff_recovery_required", recovery },
						};
					}
				}
				if (!recoveryBlocked) runResult = await host.run();
				// -------------------------------------------------------------
				// Same-Task work-cycle continuation + Host auto rotation.
				//
				// This loop is the PRODUCT automation path: it reads only committed
				// events + the frozen policy, rotates through the existing Supervisor,
				// and re-dispatches the SAME running Task (never a second Task). It is
				// skipped unless the trusted config explicitly enabled work_cycle.
				// -------------------------------------------------------------
				if (boundWorkCycle.enabled && !recoveryBlocked) {
					let continuationRounds = 0;
					let rotationsApplied = 0;
					let forceContinue = false;
					while (continuationRounds < boundWorkCycle.max_continuations) {
						const rows = committedRows();
						const projectionNow = projectQueueFromEvents({
							campaign_id: manifest.campaign_id,
							tasks: manifest.tasks ?? [],
							events: rows,
							revision: manifest.revision ?? 0,
							manifest,
							artifacts: Object.fromEntries(artifactIndexFromEvents(rows)),
						});
						const runningTask = (projectionNow.tasks ?? []).find((task) => task.state === "running");
						if (!runningTask) break;
						const episodeForTask = `ep-${runningTask.task_id}`;
						// Never resume exploration from a candidate hold, pause, cancel or
						// terminal lifecycle state.
						if (projectWorkControl(rows, runningTask.task_id).state === "waiting_external") break;
						const runState = readWorkCycleRunState(rows, runningTask.task_id);
						const decision = evaluateHostWorkCycleRotation({
							events: rows,
							episodeId: episodeForTask,
							policy: { ...boundWorkCycle, ...hostWorkCyclePolicy() },
							manifest,
							completedBoundaries: completedWorkCycleBoundaries(rows),
							taskState: runningTask.state,
							campaignState: projectionNow.control?.state ?? null,
						});
						const threshold = config.session.max_requests_per_session;
						const thresholdReached =
							Number.isInteger(threshold) && threshold >= 1 && requestsSinceRotation >= threshold;
						const rotationReasons = [
							...(decision.reasons ?? []),
							...(thresholdReached ? ["auto_request_threshold"] : []),
						];
						const shouldRotate = decision.rotate === true || thresholdReached;
						// Record the continuation boundary BEFORE attempting the rotation. If
						// creation/budget fails, the same committed source still knows this
						// Task must be continued (recovery), and the SAME boundary identity
						// prevents a second rotation for the same completion/context.
						if (shouldRotate && !runState.pending_hold && sinkRef) {
							const sessionUsage = latestSessionUsage(rows, episodeForTask);
							const identity =
								decision.identity ??
								(thresholdReached
									? `request-threshold:${sessionUsage?.session_id ?? "unknown"}:${requestsSinceRotation}`
									: null);
							const marked = await sinkRef.append({
								event_type: "runtime.note",
								episode_id: episodeForTask,
								payload: {
									kind: "campaign.work_cycle.boundary",
									version: "work-cycle-1",
									task_id: runningTask.task_id,
									reason: rotationReasons.join(","),
									boundary_identity: identity,
								},
								source: {
									kind: "runtime",
									actor_id: "c6-work-cycle",
									adapter: "c6-entry",
									version: C6_ENTRY_VERSION,
								},
								schema_version: "1.1",
							});
							if (marked?.ok !== true || marked.durable === false) break;
							runState.pending_hold = { event_id: marked.event?.event_id ?? null };
						}
						let rotatedNow = false;
						if (shouldRotate && rotationsApplied < boundWorkCycle.max_auto_rotations) {
							const sessionUsage = latestSessionUsage(rows, episodeForTask);
							const identity =
								decision.identity ??
								(thresholdReached
									? `request-threshold:${sessionUsage?.session_id ?? "unknown"}:${requestsSinceRotation}`
									: null);
							const rotation = await host.rotateSession({
								reason: rotationReasons.join(","),
								work_cycle_identity: identity,
								work_cycle_reasons: rotationReasons,
							});
							rotationAttempts.push(rotation);
							if (rotation?.applied === true && rotation.reused !== true) {
								rotatedNow = true;
								rotationsApplied += 1;
								if (thresholdReached) requestsSinceRotation = 0;
							}
							if (rotation?.applied !== true) break; // retain recovery responsibility
						}
						if (shouldRotate && !rotatedNow) break; // rotation budget/limit reached
						if (!runState.pending_hold && !rotatedNow && !forceContinue) break;
						forceContinue = false;
						const before = rows.length;
						runResult = await host.run();
						continuationRounds += 1;
						const afterRows = committedRows();
						const reviewTurnBoundary = afterRows
							.slice(before)
							.some(
								(row) =>
									row.event_type === "runtime.note" &&
									row.payload?.kind === "campaign.work_cycle.boundary" &&
									row.payload?.task_id === runningTask.task_id &&
									row.payload?.reason === "review_turn",
							);
						const newRows = afterRows.slice(before);
						const workCycleProgress = newRows.some(
							(row) =>
								(row.event_type === "runtime.note" && ["work.review", "work.checkpoint"].includes(row.payload?.kind)) ||
								(row.event_type === "proposal.submitted" && row.payload?.kind === "intent"),
						);
						// No new committed evidence and no rotation = no progress; stop
						// instead of spending requests in a spin.
						if (afterRows.length === before && !rotatedNow && !reviewTurnBoundary) break;
						if (reviewTurnBoundary && !rotatedNow && !workCycleProgress) break;
						// A review-only turn that actually changed the review/plan state gets
						// ONE follow-up dispatch in the SAME Session.
						if (reviewTurnBoundary && !rotatedNow) forceContinue = true;
					}
				}
			}
		} finally {
			host.releaseOwnership();
		}

		// X9: a resident observe OWNS its listener until a signal. It returns only
		// after the drain completed, then the finally block closes the service.
		if (resident && scenario === "observe" && server) {
			out(`observation resident: ${server.url} (waiting for SIGTERM/SIGINT)`);
			const signal = await signalPromise;
			out(`observation closing on ${signal}`);
		}

		// The explicit learning boundary: compile ONLY when the trusted policy is
		// `explicit` and proof ids are named; otherwise report why nothing ran. The
		// derived store is rebuilt from the committed notes so it is never a second
		// truth source.
		let learningResult = null;
		if (scenario !== "status" && scenario !== "observe") {
			try {
				const bridge = await ensureLearningBridge();
				if (bridge) {
					await rebuildExperienceStore({ store: learningStoreRef, events: readEventsSafe(eventLogPath) });
					const policy = config.learning?.policy ?? "off";
					const proofIds = config.learning?.proof_ids ?? [];
					if (policy === "explicit" && proofIds.length > 0) {
						// X8: perform the REAL isolated replay, then compile from the SAME
						// proof ids. A compile that reaches `active` is recorded through the
						// SAME writer as an authoritative `experience.compiled` note, so the
						// derived store rebuilds from the committed stream.
						learningResult = await replayThenCompile({
							policy,
							proofIds,
							bridge,
							store: learningStoreRef,
							replayAdapterPath: config.learning.replay_adapter ?? null,
							refreshBridge: () => buildLearningBridgeFromStream(),
						});
						if (learningResult.active === true && learningResult.experience && sinkRef) {
							const note = {
								event_type: "runtime.note",
								episode_id: null,
								payload: {
									kind: "experience.compiled",
									active: true,
									experience_id: learningResult.experience.experience_id,
									revision: learningResult.experience.revision ?? 1,
									source_outcome_ids: proofIds,
									content_digest: learningResult.content_digest ?? null,
									experience: learningResult.experience,
								},
								source: { kind: "runtime", actor_id: "c6-learning", adapter: "c6-entry", version: C6_ENTRY_VERSION },
								schema_version: "1.1",
							};
							const written = await sinkRef.append(note);
							if (written?.ok === true)
								await rebuildExperienceStore({ store: learningStoreRef, events: readEventsSafe(eventLogPath) });
						}
					} else {
						learningResult = await runCampaignLearningStep({ policy, proofIds });
					}
				}
			} catch (error) {
				learningResult = { ok: false, status: "error", reason: String(error) };
			}
		}

		if (doExport || scenario === "export") {
			const target = outDir ?? join(config.work_dir, "report");
			exportResult = await runReportExport({
				manifestPath: config.manifest_path,
				eventsPath: eventLogPath,
				outDir: target,
			});
			out(`report exported: ${target} (ok=${exportResult.ok})`);
		}

		let measureResult = null;
		if (scenario === "measure") {
			measureResult = buildMeasurement({
				config,
				manifest,
				ledger,
				events: readEventsSafe(eventLogPath),
				outDir: config.measure?.out_dir ?? join(config.work_dir, "measure"),
			});
			out(`measurement exported: ${measureResult.out_dir}`);
		}

		const status = runResult?.status ?? host.status();
		status.work_control = (status.projection?.tasks ?? status.tasks ?? []).map((task) => {
			const work = projectWorkControl(committedRows(), task.task_id);
			return {
				task_id: task.task_id,
				state: work.state,
				policy_error: work.policyError,
				candidate_event_id: work.candidate?.event_id ?? null,
			};
		});
		const summary = status.projection ?? status;
		const taskStates = Object.fromEntries((summary?.tasks ?? []).map((t) => [t.task_id, t.state]));
		out(
			`campaign ${manifest.campaign_id}: ${status.campaign_state} | tasks ${JSON.stringify(taskStates)} | ledger ${JSON.stringify(ledger.consumed())}`,
		);
		const events = readEventsSafe(eventLogPath);
		return {
			ok:
				(runResult?.ok ?? true) &&
				(controlResult?.ok ?? true) &&
				(exportResult?.ok ?? true) &&
				(rotationResult?.applied ?? true),
			reasons: [
				...(runResult?.reasons ?? []),
				...(exportResult?.reasons ?? []),
				...(controlResult?.ok === false ? [controlResult.error ?? "control command failed"] : []),
			],
			campaign_id: manifest.campaign_id,
			observation_url: server ? server.url : null,
			task_states: taskStates,
			work_control: status.work_control,
			gate: assembled.gate,
			export_dir: exportResult?.outDir ?? null,
			measurement: measureResult,
			learning: learningResult,
			rotation: rotationResult,
			rotation_attempts: rotationAttempts,
			dynamic_admissions: dynamicAdmissions,
			ledger: ledger.snapshot(),
			reconciliation: {
				unresolved_requests: reconciliationGuard.unresolved,
				diagnostics: reconciliationGuard.diagnostics_detail,
				blocked: reconciliationGuard.unresolved > 0 || reconciliationGuard.diagnostics > 0,
			},
			chain_ok: verifyChain(events).ok,
			config,
		};
	} catch (error) {
		return { ok: false, reasons: [error instanceof Error ? error.message : String(error)], stage: "run" };
	} finally {
		try {
			removeSignalHandlers();
			host.releaseOwnership();
			if (server) await server.close();
		} finally {
			try {
				await sdkRuntime?.dispose?.();
			} finally {
				try {
					if (sink.close) await sink.close();
				} finally {
					if (unbind) unbind();
					restoreObserverEnv();
				}
			}
		}
	}
}

function safeSessionId(session) {
	try {
		return session?.sessionId ?? session?.sessionFile ?? null;
	} catch {
		return null;
	}
}

// The staging rules live in ONE shared module (`session/handoff-stage.mjs`) so
// the Campaign Host and the Experiment Console Host stage the SAME request shape
// through the same `evaluateHandoff` validation. Re-exported here for the
// existing import surface.
import { stageHostHandoff } from "../session/handoff-stage.mjs";

export { resolveOpenEpisodeId, stageHostHandoff } from "../session/handoff-stage.mjs";

function safeDescribe(broker) {
	try {
		return broker?.describe?.() ?? [];
	} catch {
		return [];
	}
}

function modelDetails(model) {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		api: model.api,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		baseUrl: model.baseUrl,
	};
}

/** Measurement export: keeps every attempt, failure and unknown; no fake gains. */
export function buildMeasurement({ config, manifest, ledger, events, outDir }) {
	const attempts = [];
	for (const event of events) {
		if (event?.event_type !== "runtime.note") continue;
		const payload = event.payload ?? {};
		if (payload.kind === "c6.attempt") attempts.push(payload.attempt);
		// X4: every committed provider request is a real, durable measurement record.
		else if (payload.kind === "c6.request") {
			attempts.push({
				type: "provider_request",
				task_id: payload.task_id ?? null,
				input_chars_estimated: payload.input_chars ?? null,
				tool_calls: payload.tool_calls ?? null,
				usage: payload.usage ?? null,
				usage_source: payload.usage_source ?? "unknown",
				recorded_at: event.recorded_at ?? null,
			});
		}
	}
	const measurement = {
		schema_version: "1.0",
		campaign_id: manifest.campaign_id,
		config: {
			schema_version: config.schema_version,
			provider: config.provider,
			context: config.context,
			task_family: config.task_family,
			learning_policy: config.learning?.policy ?? "off",
		},
		seed: config.measure?.attempts?.[0]?.seed ?? null,
		attempts,
		ledger: ledger.snapshot(),
		// Not observable offline: keep null/unknown, never 0.
		backend_tokens: null,
		backend_currency: null,
		measured_at: new Date().toISOString(),
	};
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "measurement.json"), `${JSON.stringify(measurement, null, 2)}\n`, "utf8");
	return { ok: true, out_dir: outDir, attempts: attempts.length, measurement };
}

async function importSdk() {
	// Runtime specifiers (resolved by the source resolver), not static literals, so
	// the Campaign type check does not need Pi's workspace declarations.
	const specifier = "@earendil-works/pi-coding-agent";
	/** @type {any} */
	const mod = await import(specifier);
	// `AuthStorage` is not re-exported from the package index; the CLI resolves it
	// through the documented core module path. Tests may supply their own `sdk`
	// object with `AuthStorage` attached.
	if (!mod.AuthStorage || !mod.ReadOnlyAuthStorage) {
		try {
			const authSpecifier = "@earendil-works/pi-coding-agent/core/auth-storage";
			const auth = await import(authSpecifier);
			return { ...mod, AuthStorage: auth.AuthStorage, ReadOnlyAuthStorage: auth.ReadOnlyAuthStorage };
		} catch {
			return mod;
		}
	}
	return mod;
}
async function importPiAi() {
	const specifier = "@earendil-works/pi-ai/compat";
	return import(specifier);
}
async function importFauxFactory() {
	const mod = await importPiAi();
	return mod.registerFauxProvider;
}

// ---------------------------------------------------------------------------
// CLI parser
// ---------------------------------------------------------------------------

export function parseC6Args(argv) {
	const args = { configPath: null, subcommand: null, observe: false, export: false, outDir: null, port: null };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (["--config", "--out", "--port"].includes(token) && (!argv[i + 1] || argv[i + 1].startsWith("--")))
			return { ok: false, reason: `missing value for ${token}` };
		if (token === "--config") {
			args.configPath = argv[i + 1];
			i += 1;
		} else if (token === "--observe") {
			args.observe = true;
		} else if (token === "--export") {
			args.export = true;
		} else if (token === "--out") {
			args.outDir = argv[i + 1];
			i += 1;
		} else if (token === "--port") {
			const value = argv[i + 1];
			if (!/^\d+$/.test(value) || Number(value) > 65535)
				return { ok: false, reason: "--port must be an integer from 0 to 65535" };
			args.port = Number(value);
			i += 1;
		} else if (!token.startsWith("--") && !args.subcommand) {
			args.subcommand = token;
		} else {
			return { ok: false, reason: `unknown argument: ${token}` };
		}
	}
	if (!args.configPath) return { ok: false, reason: "--config is required" };
	const sub = args.subcommand ?? "run";
	if (!SUBCOMMANDS.includes(sub)) return { ok: false, reason: `subcommand must be one of ${SUBCOMMANDS.join(", ")}` };
	args.subcommand = sub;
	return { ok: true, args };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	const parsed = parseC6Args(process.argv.slice(2));
	if (!parsed.ok) {
		process.stderr.write(`c6-entry: ${parsed.reason}\n`);
		process.exit(2);
	}
	const outcome = await runC6FromConfig({
		configPath: parsed.args.configPath,
		scenario: parsed.args.subcommand,
		observe: parsed.args.observe,
		export: parsed.args.export,
		outDir: parsed.args.outDir,
		port: parsed.args.port,
		installSignalHandlers: parsed.args.subcommand === "observe",
		resident: parsed.args.subcommand === "observe",
	});
	if (!outcome.ok) {
		for (const reason of outcome.reasons ?? []) process.stderr.write(`c6-entry: ${reason}\n`);
	}
	process.exit(outcome.ok ? 0 : 1);
}
