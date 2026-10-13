// Aegis C3-A — Campaign Host.
//
// The Host is the PRODUCT entry that binds the existing pieces into one loop
// (CAMPAIGN_NEXT_PHASES §C3, CAMPAIGN_ARCHITECTURE §3.5/3.8):
//
//   trusted Manifest/registries -> C1 scheduler/Worker
//     -> registered ActionContract -> authorization/state checks
//     -> durable action.requested -> existing Broker -> local effect
//     -> durable action.completed -> independent Oracle
//     -> bound Stage/Task Outcomes -> C1 completion/dependency
//
// The Host OWNS the single-writer boundary and the budget ledger; it reuses:
//   * `createCampaignScheduler` for queue/task control and durable truth;
//   * the existing `ActionRegistry`/`createActionBroker`/authorization for
//     capability execution (the caller injects the worker);
//   * the C2 `SessionController` adapter for safe session rotation.
//
// It appends NOTHING of its own to the event log: the Worker/Oracle write
// through the SAME scheduler sink so there is exactly one writer.

import { existsSync, mkdirSync } from "node:fs";

import { digest } from "../fixture/contracts.mjs";
import { parseBudgetStrict } from "./projection.mjs";
import { createCampaignScheduler } from "./scheduler.mjs";

export const HOST_VERSION = "1.0.0";

const SYNTHETIC_KEYS = Object.freeze(["wall_time_ms", "model_requests", "tool_calls"]);

/**
 * @typedef {{wall_time_ms?: number, model_requests?: number, tool_calls?: number, session_count?: number}} BudgetDims
 * @typedef {{reserved?: BudgetDims, consumed?: BudgetDims, released?: BudgetDims}} BudgetLedger
 */

function zeroBudget() {
	return { wall_time_ms: 0, model_requests: 0, tool_calls: 0, session_count: 0 };
}

/**
 * The Host's SINGLE budget ledger view. `base` is the committed Campaign ledger
 * (reserved/consumed from the projection). `sessions_committed` is the number of
 * committed C2 rotations for the active episode. Publicly reports the source of
 * every number so a caller cannot mistake a derived figure for a measured one:
 *
 *   * `synthetic: true` marks the per-dispatch placeholder cost (NOT a measured
 *     request/tool usage).
 *   * `unobservable` lists dimensions whose real value cannot be observed; their
 *     numbers are `null`/`unknown`, never fabricated.
 *
 * @param {{base?: BudgetLedger|null, sessionsCommitted?: number, syntheticCost?: BudgetDims|null,
 *   unobservable?: string[]}} args
 */
export function buildBudgetLedger({
	base = null,
	sessionsCommitted = 0,
	syntheticCost = null,
	unobservable = [],
} = {}) {
	const b = base ?? { reserved: zeroBudget(), consumed: zeroBudget(), released: zeroBudget() };
	const rotations = Number.isInteger(sessionsCommitted) && sessionsCommitted > 0 ? sessionsCommitted : 0;
	const consumed = { ...zeroBudget(), ...(b.consumed ?? {}) };
	// A rotation's session generation is charged ONCE, on top of the committed
	// base. It is NOT added again anywhere else.
	consumed.session_count = (consumed.session_count ?? 0) + rotations;
	return {
		schema_version: "1.0",
		owner: "campaign_host",
		charge_owner: "campaign_host",
		scope: "campaign_episode",
		base: {
			reserved: { ...zeroBudget(), ...(b.reserved ?? {}) },
			consumed: { ...zeroBudget(), ...(b.consumed ?? {}) },
		},
		sessions_committed: rotations,
		consumed,
		synthetic_cost: syntheticCost ? { ...syntheticCost, synthetic: true } : null,
		unobservable: [...unobservable],
		notes: [
			"consumed values are derived from committed events only",
			"session_count includes exactly one charge per committed rotation",
		],
	};
}

/**
 * @param {{[key: string]: any}} args
 */
export function createCampaignHost({
	manifest,
	ownedTasks = [],
	baseDir = null,
	workspaceRoot,
	sink,
	worker,
	oracle,
	clock = () => Date.now(),
	budgetAccount = { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
	actionGate = null,
	sessionController = null,
	artifacts = {},
	writeCheckpointImpl,
	readCheckpointImpl,
	effectProbe = null,
	ownerId = `campaign-host-${process.pid}-${Math.random().toString(16).slice(2)}`,
} = {}) {
	if (typeof workspaceRoot !== "string" || !workspaceRoot)
		throw new Error("createCampaignHost requires a workspaceRoot");
	if (!sink || typeof sink.append !== "function") throw new Error("createCampaignHost requires a sink with append()");
	if (!worker || typeof worker.run !== "function") throw new Error("createCampaignHost requires a worker with run()");
	if (!oracle || typeof oracle.judge !== "function")
		throw new Error("createCampaignHost requires an oracle with judge()");

	worker.bindCampaign?.(manifest);
	const costCheck = parseBudgetStrict(budgetAccount);
	const syntheticCost = costCheck.ok ? { ...costCheck.value } : { wall_time_ms: 0, model_requests: 0, tool_calls: 0 };
	const actionCounters = { requested: 0, completed: 0, rejected: 0, denied: 0 };
	const sessionCounters = { rotations_attempted: 0, rotations_applied: 0 };

	const scheduler = createCampaignScheduler({
		manifest,
		ownedTasks,
		baseDir,
		sink,
		worker,
		oracle,
		clock,
		budgetAccount: syntheticCost,
		artifacts,
		effectProbe,
		ownerId,
		writeCheckpointImpl,
		readCheckpointImpl,
	});

	function committedRotations() {
		if (sessionController && typeof sessionController.committedRotations === "function") {
			return sessionController.committedRotations();
		}
		return 0;
	}

	// The ledger reads the LAST projection the scheduler returned. The scheduler is
	// the single writer; the Host never mutates events to read the ledger. Before
	// the first run the base ledger is empty/reserved-only as reported by a run.
	let lastProjection = null;

	function currentLedger() {
		return buildBudgetLedger({
			base: lastProjection?.budget ?? null,
			sessionsCommitted: committedRotations(),
			syntheticCost,
			unobservable: ["tokens", "currency"],
		});
	}

	/** One scheduler pass over the committed stream. */
	async function run() {
		if (actionGate && typeof actionGate.activate === "function") actionGate.activate();
		try {
			const result = await scheduler.run();
			syncProjection(result.status);
			return {
				ok: result.ok,
				reasons: result.reasons,
				status: result.status,
				used_checkpoint: result.used_checkpoint,
				actions: { ...actionCounters },
				sessions: { ...sessionCounters },
				budget: currentLedger(),
			};
		} finally {
			if (actionGate && typeof actionGate.deactivate === "function") actionGate.deactivate();
		}
	}

	function syncProjection(status) {
		if (status && Array.isArray(status.tasks)) lastProjection = status;
	}

	/**
	 * A read-only status view. `campaign_state` comes from the scheduler's live
	 * projection; `projection` is the last full snapshot returned by `run()` (null
	 * before the first run). It never dispatches or mutates state.
	 */
	function status() {
		return {
			campaign_state: scheduler.state,
			projection: lastProjection,
			actions: { ...actionCounters },
			sessions: { ...sessionCounters },
			budget: currentLedger(),
			gate_active: Boolean(actionGate && typeof actionGate.isActive === "function" && actionGate.isActive()),
		};
	}

	/**
	 * Attempt ONE safe session rotation through the injected C2 controller. The
	 * Host is the ONLY charge owner: the ledger counts each APPLIED rotation
	 * exactly once, and an exhausted/refused rotation leaves the ledger unchanged.
	 */
	async function rotateSession(options = {}) {
		sessionCounters.rotations_attempted += 1;
		if (!sessionController || typeof sessionController.rotate !== "function") {
			return { applied: false, reason: "no session controller is wired" };
		}
		const before = committedRotations();
		const result = await sessionController.rotate(options);
		if (result && result.applied === true && result.reused !== true) {
			sessionCounters.rotations_applied += 1;
		}
		const after = committedRotations();
		return { ...result, session_charges: { before, after, delta: Math.max(0, after - before) } };
	}

	/** The Campaign-mode gate decision for a candidate direct tool call. */
	function guardToolCall(input) {
		if (!actionGate || typeof actionGate.guardToolCall !== "function") {
			return { allowed: true, reason: "no campaign action gate is configured", mode: "standard", action_ref: null };
		}
		const decision = actionGate.guardToolCall(input);
		if (decision.allowed !== true) actionCounters.denied += 1;
		return decision;
	}

	return {
		version: HOST_VERSION,
		manifest,
		workspaceRoot,
		ownerId,
		scheduler,
		actionCounters,
		sessionCounters,
		/** Host-owned action accounting, updated by the brokered Worker. */
		noteAction(kind, delta = 1) {
			if (Object.hasOwn(actionCounters, kind)) actionCounters[kind] += delta;
		},
		run,
		status,
		guardToolCall,
		rotateSession,
		/**
		 * Admit a bounded dynamic Task proposal from the model through the ONE
		 * existing policy. The model supplies data only; the Host re-validates and
		 * commits the admission, and never lets the proposal raise the budget.
		 */
		proposeDynamicTask: (input) => scheduler.proposeDynamicTask(input),
		budgetLedger: currentLedger,
		async pause(reason) {
			return scheduler.pause(reason);
		},
		async resume(reason) {
			return scheduler.resume(reason);
		},
		async cancel(reason) {
			return scheduler.cancel(reason);
		},
		async stop(reason) {
			return scheduler.stop(reason);
		},
		releaseOwnership() {
			if (typeof scheduler.releaseOwnership === "function") scheduler.releaseOwnership();
		},
		lastCheckpointOk: () => scheduler.lastCheckpointOk(),
		lastCheckpointReason: () => scheduler.lastCheckpointReason(),
		usedCheckpoint: () => scheduler.usedCheckpoint(),
		/** A stable identity for the Host configuration (diagnostics only). */
		configDigest: () => digest({ campaign_id: manifest?.campaign_id ?? null, workspaceRoot, owner: ownerId }),
	};
}

/** Ensure a workspace root exists (the caller authorizes it; this only creates it). */
export function ensureWorkspace(workspaceRoot) {
	if (typeof workspaceRoot !== "string" || !workspaceRoot) throw new Error("ensureWorkspace requires a path");
	if (!existsSync(workspaceRoot)) mkdirSync(workspaceRoot, { recursive: true });
	return workspaceRoot;
}

export { SYNTHETIC_KEYS };
