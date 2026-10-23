// Aegis Experiment Console Host.
//
// The user starts ONE resident process for one Experiment label. The Host owns
// the real Pi `AgentSessionRuntime`, dispatches human input into the CURRENT
// Task/Episode, waits for a genuine settle, and only then decides whether to
// continue in the same Session, carry an open work-cycle hold into a bounded
// replacement Session, or stop and report why.
//
// Authority boundary (phase-3 task §2):
//   * EventLog is the only durable truth. Board/RuntimeState/work-cycle are
//     derived from it, optionally through a VERIFIED projection checkpoint.
//   * The Host never writes Facts/Outcomes, never grants permissions, never
//     clears a review hold and never resets a budget. It stages a handoff
//     request and asks the existing `SessionSupervisor` to create a genuinely
//     new Session; the Supervisor re-checks pending/unknown effects + budget.
//   * The Observer owns the current Session's hooks/tools/RAM and writes the
//     single `handoff.completed` at the post-bind boundary. This module never
//     creates a Session from `agent_end`/`agent_settled`.
//   * One process / one EventLog writer. The Host opens the EventLog and binds
//     it in-process (`bindHostEventLog`) so the Observer borrows the same
//     writer; a second console on the same label is refused by the lease.
//
// The console state (running/settling/handoff_pending/paused/blocked/stopped,
// rotation attempts, continuation counter) is DERIVED: rotation/continuation
// identity that matters is read back from committed events, and the mutable
// bits are process-local only.

import { randomUUID } from "node:crypto";
import { acquireCampaignOwnership, releaseCampaignOwnership } from "../campaign/ownership.mjs";
import { projectWithCheckpoint } from "../memory/projection-checkpoint.mjs";
import { pendingActionsFor, resolveOpenEpisode } from "../memory/state.mjs";
import {
	completedWorkCycleBoundaries,
	normalizeWorkCyclePolicy,
	recommendWorkHandoff,
	resolveWorkCyclePolicy,
} from "../memory/work-cycle.mjs";
import { bindHostEventLog, EventLog, verifyChain } from "../shared/events.mjs";
import { stageHostHandoff } from "./handoff-stage.mjs";
import { createSessionSupervisor } from "./session-supervisor.mjs";
import { latestSessionUsage } from "./work-cycle-rotation.mjs";

export const EXPERIMENT_CONSOLE_VERSION = "experiment-console-1";

/** Trusted Host configuration keys (never model/environment-writable at runtime). */
export const CONSOLE_POLICY_ENV = Object.freeze({
	max_auto_rotations: "AEGIS_CONSOLE_MAX_AUTO_ROTATIONS",
	max_continuations: "AEGIS_CONSOLE_MAX_CONTINUATIONS",
	work_start_gate: "AEGIS_WORK_START_GATE",
});

export const CONSOLE_POLICY_DEFAULTS = Object.freeze({
	max_auto_rotations: 3,
	max_continuations: 12,
});

const CONSOLE_POLICY_BOUNDS = Object.freeze({
	max_auto_rotations: [0, 8],
	max_continuations: [1, 64],
});

function boundedInt(raw, [min, max], fallback, invalid, key) {
	if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
	const value = Number(String(raw).trim());
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		invalid.push(key);
		return fallback;
	}
	return value;
}

/**
 * Resolve the bounded Session-rotation policy from TRUSTED Host configuration.
 * The launcher writes these values; a model can never set them. An out-of-range
 * value falls back to the frozen default and is reported, never widened.
 *
 * @param {Record<string,string|undefined>} [env]
 */
export function resolveConsolePolicy(env = process.env) {
	const source = env && typeof env === "object" ? env : {};
	const invalid = [];
	const policy = {
		max_auto_rotations: boundedInt(
			source[CONSOLE_POLICY_ENV.max_auto_rotations],
			CONSOLE_POLICY_BOUNDS.max_auto_rotations,
			CONSOLE_POLICY_DEFAULTS.max_auto_rotations,
			invalid,
			"max_auto_rotations",
		),
		max_continuations: boundedInt(
			source[CONSOLE_POLICY_ENV.max_continuations],
			CONSOLE_POLICY_BOUNDS.max_continuations,
			CONSOLE_POLICY_DEFAULTS.max_continuations,
			invalid,
			"max_continuations",
		),
		invalid,
		source: "host_policy",
	};
	policy.work_start_gate = ["on", "1", "true", "enabled"].includes(
		String(source[CONSOLE_POLICY_ENV.work_start_gate] ?? "")
			.trim()
			.toLowerCase(),
	);
	return policy;
}

/**
 * Freeze the trusted Host configuration into this process' Observer environment.
 *
 * Besides the work-cycle policy this binds the exact EventLog/handoff/task the
 * Host owns, so the Observer can only ever write through the Host's single
 * writer (it resolves its path from `AEGIS_EVENT_LOG`). A divergent value would
 * silently split the audit trail, so it is not left to the caller.
 */
function bindHostEnv({ policy, eventLogPath, handoffPath, taskId, label }) {
	const keys = {
		AEGIS_WORK_CYCLE_REPEAT_LIMIT: policy.repeat_limit,
		AEGIS_WORK_CYCLE_ACTION_WINDOW: policy.action_window,
		AEGIS_WORK_CYCLE_MIN_DISTINCT_ROUTES: policy.min_distinct_routes,
		AEGIS_WORK_CYCLE_CONTEXT_PERCENT: policy.context_pressure_percent,
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_HANDOFF_FILE: handoffPath,
		AEGIS_TASK_ID: taskId,
		AEGIS_EXPERIMENT_LABEL: label,
	};
	const previous = {};
	for (const [key, value] of Object.entries(keys)) {
		previous[key] = process.env[key];
		if (Number.isSafeInteger(value)) process.env[key] = String(value);
		else if (typeof value === "string" && value) process.env[key] = value;
	}
	return () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

/**
 * A review hold is a legitimate REPLACEMENT reason in phase 3: the replacement
 * only refreshes the model context and continues the SAME review. It never
 * clears the hold. Identity includes the trigger AND the source Session, so one
 * open trigger gives each source Session at most one automatic handoff, and the
 * same boundary can never rotate twice.
 */
export function reviewHoldBoundary(cycle, sourceSessionId) {
	if (!cycle || cycle.review_required !== true) return null;
	if (typeof cycle.trigger_id !== "string" || !cycle.trigger_id) return null;
	if (typeof sourceSessionId !== "string" || !sourceSessionId) return null;
	return {
		identity: `review-hold:${cycle.trigger_id}:${sourceSessionId}`,
		reasons: ["review_hold"],
		trigger_id: cycle.trigger_id,
		source_session_id: sourceSessionId,
	};
}

/**
 * Combine the committed advisory boundaries with the phase-3 review-hold
 * allowance. Pure: it only reads committed events + the frozen policy.
 *
 * `completedBoundaries` are identities that already produced a committed
 * `handoff.completed`; `attemptedBoundaries` are identities this Host already
 * tried (a refused/failed attempt must not be retried forever, and must not be
 * counted as a successful rotation).
 */
export function evaluateConsoleRotation({
	cycle,
	events,
	policy,
	sourceSessionId,
	completedBoundaries = new Set(),
	attemptedBoundaries = new Set(),
}) {
	const usage = latestSessionUsage(events, cycle?.episode_id ?? null);
	const recommendation = recommendWorkHandoff({
		cycle,
		contextUsage: usage?.context_usage ?? null,
		policy,
		sourceSessionId: sourceSessionId ?? usage?.session_id ?? null,
	});
	const candidates = [];
	if (recommendation.recommended && recommendation.identity) {
		candidates.push({ identity: recommendation.identity, reasons: recommendation.reasons.slice() });
	}
	const hold = reviewHoldBoundary(cycle, sourceSessionId ?? usage?.session_id ?? null);
	if (hold) candidates.push(hold);
	for (const candidate of candidates) {
		if (completedBoundaries.has(candidate.identity)) continue;
		if (attemptedBoundaries.has(candidate.identity)) continue;
		return {
			rotate: true,
			identity: candidate.identity,
			reasons: candidate.reasons,
			context_usage: recommendation.context_usage,
			source_session_id: sourceSessionId ?? usage?.session_id ?? null,
			trigger_id: cycle?.trigger_id ?? null,
		};
	}
	if (candidates.length > 0) return { rotate: false, reason: "boundary_already_rotated" };
	return { rotate: false, reason: "no_boundary" };
}

/**
 * The statuses that must never auto-continue or auto-rotate.
 * `waiting_external`/paused/cancelled/terminal belong to the existing controller.
 */
const NON_RUNNABLE_EPISODE = new Set(["closed", "paused", "cancelled", "terminal", "completed", "failed", "unknown"]);

function sessionIdentity(adapter) {
	try {
		return adapter?.sessionId?.() ?? null;
	} catch {
		return null;
	}
}

/**
 * Create one resident Experiment Console Host.
 *
 * @param {{
 *   label: string,
 *   taskId: string,
 *   eventLogPath: string,
 *   handoffPath: string,
 *   checkpointPath?: string|null,
 *   ownershipBaseDir: string,
 *   sessionFactory: () => Promise<ConsoleSessionAdapter>,
 *   session?: ConsoleSessionAdapter,
 *   workCyclePolicy?: any,
 *   consolePolicy?: any,
 *   manifest?: any,
 *   sessionBudget?: {limit?: object, consumed?: object, reserved?: object, max_requests_per_session?: number}|null,
 *   configDigest?: string|null,
 *   continuation?: (handoff: object) => string,
 * }} args
 *
 * Startup responsibility order (the reason `sessionFactory` is a FACTORY):
 *
 *   acquire ownership → open+verify EventLog → bindHostEventLog →
 *   create the SDK runtime → bind the initial Session/Observer →
 *   pending/unknown+policy+staged-handoff check → Supervisor recovery →
 *   dispatch
 *
 * Creating a Session binds the Observer, whose `session_start` appends
 * `session.started`. If the runtime were created before the lease, a second
 * console on the same label would write into the live run's EventLog even
 * though its ownership request is refused. `sessionFactory` is therefore called
 * ONLY after the lease and the single-writer binding are in place.
 *
 * `session` (a pre-bound adapter) is a seam for callers that already own the
 * Session lifecycle. By definition it CANNOT prevent events from a Session that
 * was created before `start()`; production entry points must use
 * `sessionFactory`. A refused instance never disposes or unbinds a pre-bound
 * adapter.
 */
export function createExperimentConsole({
	label,
	taskId,
	eventLogPath,
	handoffPath,
	checkpointPath = null,
	ownershipBaseDir,
	sessionFactory = null,
	session: providedSession = null,
	workCyclePolicy = null,
	consolePolicy = null,
	manifest = null,
	sessionBudget = null,
	configDigest = null,
	continuation = null,
}) {
	if (typeof label !== "string" || !label) throw new Error("createExperimentConsole requires a label");
	if (typeof taskId !== "string" || !taskId) throw new Error("createExperimentConsole requires a taskId");
	if (typeof eventLogPath !== "string" || !eventLogPath)
		throw new Error("createExperimentConsole requires eventLogPath");
	if (typeof handoffPath !== "string" || !handoffPath) throw new Error("createExperimentConsole requires handoffPath");
	if (typeof ownershipBaseDir !== "string" || !ownershipBaseDir)
		throw new Error("createExperimentConsole requires ownershipBaseDir");
	if (providedSession && typeof sessionFactory === "function")
		throw new Error("createExperimentConsole accepts either sessionFactory or a pre-bound session, not both");
	if (!providedSession && typeof sessionFactory !== "function")
		throw new Error("createExperimentConsole requires a sessionFactory (or a pre-bound session adapter)");
	if (
		providedSession &&
		(typeof providedSession.prompt !== "function" || typeof providedSession.waitForIdle !== "function")
	)
		throw new Error("the pre-bound session adapter needs prompt/waitForIdle");

	const consolePolicyResolved = consolePolicy ?? resolveConsolePolicy(process.env);
	// A unique owner id per console INSTANCE, not just per PID: two consoles in the
	// same process must still be one live writer per label.
	const ownerId = `${process.pid}:${randomUUID()}`;
	const workPolicy = normalizeWorkCyclePolicy(workCyclePolicy ?? resolveWorkCyclePolicy(process.env));

	let log = null;
	let unbind = null;
	let restoreEnv = null;
	let ownership = null;
	let ownershipHeld = false;
	let bound = false;
	let supervisor = null;
	/** Current Session adapter. `null` until the factory runs (after ownership). */
	let session = providedSession;
	let sessionFromFactory = false;
	let started = false;
	let phase = "idle"; // idle | running | settling | handoff_pending | paused | blocked | stopped
	let stopReason = null;
	let blockReason = null;
	let lastAction = null;
	const attemptedBoundaries = new Set();
	let autoRotations = 0;
	let continuations = 0;
	/** Set while a single settle→rotation decision is executing, so a late callback cannot double-rotate. */
	let decisionChain = Promise.resolve();

	/** Read a staged handoff request (derived view; no authority by itself). */
	async function readStagedRequest() {
		try {
			const { readFile } = await import("node:fs/promises");
			const parsed = JSON.parse(await readFile(handoffPath, "utf8"));
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	}

	async function openCommitted({ persist = true } = {}) {
		if (!log) return { ok: false, reason: "event log is not open" };
		// The Host only reads a VERIFIED, current prefix. A refresh is a cheap stat
		// when nothing changed; it also surfaces a corrupt/removed tail immediately.
		const refreshed = await log.refresh();
		if (!refreshed.ok) return { ok: false, reason: refreshed.error || "event log refresh failed" };
		const events = log.replay();
		const projection = await projectWithCheckpoint({
			events,
			taskId,
			policy: workPolicy,
			manifest,
			checkpointPath,
			configDigest,
			persist,
		});
		return { ok: true, events, projection };
	}

	/** Live/derived status. Never an authority: every field is re-derivable. */
	async function status() {
		const committed = await openCommitted({ persist: false });
		const view = committed.ok ? committed.projection : null;
		const state = view?.state ?? null;
		const episode = view?.episodeId ? state?.episodes?.[view.episodeId] : null;
		const cycle = view?.workCycle ?? null;
		const rotationCompleted = committed.ok
			? committed.events.filter((row) => row.event_type === "handoff.completed")
			: [];
		return {
			version: EXPERIMENT_CONSOLE_VERSION,
			label,
			task_id: taskId,
			console_status: phase,
			stop_reason: stopReason,
			block_reason: blockReason,
			episode_id: view?.episodeId ?? null,
			episode_status: episode?.status ?? null,
			work_unit_state: cycle?.work_unit_state ?? null,
			work_unit_id: cycle?.work_unit_id ?? null,
			work_cycle_status: cycle?.status ?? null,
			trigger_id: cycle?.trigger_id ?? null,
			bootstrap_review: cycle?.bootstrap_review === true,
			review_event_id: cycle?.review?.event_id ?? null,
			selection_event_id: cycle?.review?.selection_event_id ?? null,
			action_count: cycle?.action_count ?? 0,
			review_round_action_count: cycle?.review_round_action_count ?? 0,
			consumptions: cycle?.consumptions ?? [],
			session_id: sessionIdentity(session),
			session_file: typeof session?.sessionFile === "function" ? session.sessionFile() : null,
			session_creations: typeof session?.creations === "function" ? session.creations() : null,
			model: typeof session?.model === "function" ? session.model() : null,
			rotation_attempts: [...attemptedBoundaries],
			rotations_completed: rotationCompleted.length,
			auto_rotations: autoRotations,
			continuations,
			pending_actions: view?.episodeId ? pendingActionsFor(state, view.episodeId) : [],
			unknown_actions: view?.episodeId
				? Object.values(state?.pending_actions ?? {}).filter(
						(action) =>
							action.episode_id === view.episodeId && (action.status === "unknown" || action.status === "unresolved"),
					)
				: [],
			policy: { ...consolePolicyResolved, work_cycle: workPolicy },
			session_budget: sessionBudget
				? {
						limit: sessionBudget.limit ?? null,
						consumed: sessionBudget.consumed ?? null,
						reserved: sessionBudget.reserved ?? null,
					}
				: null,
			last_action: lastAction,
			last_committed_cursor: committed.ok
				? {
						offset: committed.events.length,
						event_id: committed.events[committed.events.length - 1]?.event_id ?? null,
						event_digest: committed.events[committed.events.length - 1]?.event_digest ?? null,
						projection_source: committed.projection.source,
						tail_rows: committed.projection.tail_rows,
					}
				: null,
		};
	}

	function setPhase(next, reason = null) {
		phase = next;
		if (next === "blocked") blockReason = reason;
		if (next === "stopped") stopReason = reason;
	}

	/** Human-readable one-liner for the console prompt. */
	function statusLine() {
		return `[aegis] ${phase}${phase === "blocked" && blockReason ? ` (${blockReason})` : ""} task=${taskId} session=${sessionIdentity(session) ?? "none"} rotations=${autoRotations}/${consolePolicyResolved.max_auto_rotations} continuations=${continuations}/${consolePolicyResolved.max_continuations}`;
	}

	/**
	 * Release everything THIS instance actually acquired, in the order that keeps
	 * the Host writer valid for the Observer's shutdown event:
	 *   dispose our Session (still owner + still bound) → unbind → close log →
	 *   restore env → release the lease.
	 *
	 * Idempotent. A refused instance holds none of these, so it never touches
	 * another Host's lease, binding, writer or Session.
	 */
	async function cleanupOwn() {
		if (ownershipHeld && session && typeof session.dispose === "function") {
			try {
				await session.dispose();
			} catch {
				// disposal is best effort; the lease/binding cleanup below still runs
			}
		}
		if (sessionFromFactory) session = null;
		sessionFromFactory = false;
		if (bound && unbind) {
			try {
				unbind();
			} catch {
				// ignore: the binding is only an in-process registry entry
			}
		}
		bound = false;
		unbind = null;
		if (log) {
			await log.close().catch(() => undefined);
			log = null;
		}
		if (restoreEnv) {
			restoreEnv();
			restoreEnv = null;
		}
		if (ownershipHeld) {
			releaseCampaignOwnership(ownershipBaseDir, label, { ownerId });
			ownershipHeld = false;
		}
		ownership = null;
		supervisor = null;
		started = false;
	}

	/** Fail a startup attempt: clean up our own resources, keep the reason visible. */
	async function failStart(reason, extra = {}) {
		await cleanupOwn();
		setPhase("blocked", reason);
		return { ok: false, reason, ...extra };
	}

	/**
	 * Acquire ownership, open/bind the EventLog, and only THEN create the Session.
	 *
	 * A refused ownership acquisition happens before any SDK/runtime/Observer work,
	 * so it cannot append `session.started` to the live run's EventLog.
	 */
	async function start() {
		if (started) return { ok: true, already_started: true, status: await status() };
		if (phase === "stopped") return { ok: false, reason: "console is stopped" };
		// 1. ownership FIRST. No Session, no Observer, no event.
		ownership = acquireCampaignOwnership(ownershipBaseDir, label, { ownerId });
		if (!ownership.ok) {
			setPhase("blocked", `another console owns this experiment: ${ownership.reason}`);
			return { ok: false, reason: ownership.reason, ownership_conflict: true };
		}
		ownershipHeld = true;
		// 2. frozen Host policy for the Observer.
		restoreEnv = bindHostEnv({ policy: workPolicy, eventLogPath, handoffPath, taskId, label });
		// 3. open + verify the committed log.
		log = new EventLog(eventLogPath);
		const opened = await log.open();
		if (!opened.ok) return failStart(opened.error || "event log unavailable");
		const verified = verifyChain(log.replay());
		if (!verified.ok) return failStart(`event log chain is corrupt: ${verified.errors.slice(0, 3).join("; ")}`);
		// 4. single writer: the Observer will borrow THIS log instance.
		try {
			unbind = bindHostEventLog(eventLogPath, log);
			bound = true;
		} catch (error) {
			return failStart(
				`another in-process Host already owns this EventLog: ${error instanceof Error ? error.message : String(error)}`,
				{ ownership_conflict: true },
			);
		}
		// 5. NOW create the SDK runtime / bind the initial Session. Its Observer
		//    writes through the Host writer we already own.
		if (!session) {
			try {
				session = await sessionFactory();
				sessionFromFactory = true;
			} catch (error) {
				return failStart(error instanceof Error ? error.message : String(error));
			}
			if (!session || typeof session.prompt !== "function" || typeof session.waitForIdle !== "function")
				return failStart("the session factory did not return a usable Session adapter");
		}
		started = true;
		supervisor = createSessionSupervisor({
			eventLogPath,
			handoffPath,
			runtime: supervisorRuntime(),
			taskId,
			budget: sessionBudget,
			continuation: continuation ?? undefined,
			manifest,
		});
		// 6. pending/unknown responsibility, frozen policy and staged handoff.
		//    A refusal keeps the reason and cleans up our own resources.
		const recovery = await recover();
		if (!recovery.ok) return failStart(recovery.reason, { recovery });
		setPhase("running");
		return { ok: true, recovery, status: await status() };
	}

	/**
	 * Adapter the Supervisor sees. `newSession` is the REAL SDK replacement path;
	 * `session.sessionId` is read live from the bound runtime.
	 */
	function supervisorRuntime() {
		return {
			newSession: (options) => {
				if (typeof session.newSession !== "function")
					throw new Error("the console session adapter has no newSession()");
				continuations += 1;
				return session.newSession(options);
			},
			get session() {
				return { sessionId: sessionIdentity(session) };
			},
		};
	}

	/**
	 * Resolve a pending staged handoff / unknown responsibility BEFORE dispatch.
	 * A refusal is reported and keeps the console blocked; it never dispatches
	 * the next unit's effects.
	 */
	async function recover() {
		if (!supervisor) return { ok: false, reason: "supervisor unavailable" };
		const committed = await openCommitted({ persist: true });
		if (!committed.ok) return { ok: false, reason: committed.reason };
		const { events, projection } = committed;
		const episodeId = projection.episodeId;
		if (!episodeId) return { ok: true, action: "no_episode" };
		const pending = pendingActionsFor(projection.state, episodeId);
		if (pending.length > 0)
			return {
				ok: false,
				reason: `unfinished action(s) must be reconciled before dispatch: ${pending
					.map((action) => action.tool_name || action.action_id)
					.join(", ")}`,
				pending_actions: pending,
			};
		// An interrupted handoff (staged request, no completion) goes through the
		// Supervisor's budget/safety gate. A refusal keeps the responsibility.
		const staged = await readStagedRequest();
		if (staged?.request_id) {
			const completed = events.some(
				(row) => row.event_type === "handoff.completed" && row.payload?.request_id === staged.request_id,
			);
			if (!completed) {
				const recovered = await supervisor.recoverInterrupted();
				if (!recovered.recovered)
					return {
						ok: false,
						reason: `interrupted handoff ${staged.request_id} could not be recovered: ${recovered.reason}`,
						recovery: recovered,
					};
				autoRotations += 1;
				attemptedBoundaries.add(staged.work_cycle?.boundary_identity ?? `recovered:${staged.request_id}`);
				return { ok: true, action: "recovered_handoff", recovery: recovered };
			}
		}
		return { ok: true, action: "clean" };
	}

	/** Non-runnable states never auto-continue. */
	async function runnable(projection) {
		const episode = projection.episodeId ? projection.state.episodes[projection.episodeId] : null;
		if (!episode) return { ok: false, reason: "no open episode" };
		if (NON_RUNNABLE_EPISODE.has(episode.status))
			return { ok: false, reason: `episode is ${episode.status}; not auto-resumed` };
		const pending = pendingActionsFor(projection.state, projection.episodeId);
		if (pending.length > 0)
			return {
				ok: false,
				reason: `unfinished action(s): ${pending.map((action) => action.tool_name || action.action_id).join(", ")}`,
			};
		const unknown = Object.values(projection.state.pending_actions ?? {}).filter(
			(action) =>
				action.episode_id === projection.episodeId && (action.status === "unknown" || action.status === "unresolved"),
		);
		if (unknown.length > 0)
			return {
				ok: false,
				reason: `unknown side effect(s) require reconciliation: ${unknown
					.map((action) => action.tool_name || action.action_id)
					.join(", ")}`,
			};
		return { ok: true, episode };
	}

	/**
	 * One settle decision. Runs under a serialized chain so a late Host callback
	 * (or a second settle emission) can never rotate twice for the same boundary.
	 */
	function decideAfterSettle() {
		const run = decisionChain.then(() => decideAfterSettleInner());
		decisionChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async function decideAfterSettleInner() {
		const committed = await openCommitted({ persist: true });
		if (!committed.ok) {
			setPhase("blocked", committed.reason);
			return { action: "blocked", reason: committed.reason };
		}
		const { events, projection } = committed;
		const runnableVerdict = await runnable(projection);
		if (!runnableVerdict.ok) {
			setPhase("blocked", runnableVerdict.reason);
			return { action: "blocked", reason: runnableVerdict.reason };
		}
		// A settle that left the EventLog unhealthy is never a safe boundary.
		if (!log || log.healthy !== true) {
			setPhase("blocked", "event log is not healthy");
			return { action: "blocked", reason: "event_log_unhealthy" };
		}
		const cycle = projection.workCycle;
		const sourceSessionId = sessionIdentity(session);
		const settledForCurrent = events.findLast((row) => row.event_type === "agent.settled") ?? null;
		if (!settledForCurrent || settledForCurrent.payload?.session_id !== sourceSessionId) {
			setPhase("blocked", "no genuine settle is committed for the current Session");
			return { action: "blocked", reason: "no_settle_for_current_session" };
		}
		const decision = evaluateConsoleRotation({
			cycle,
			events,
			policy: workPolicy,
			sourceSessionId,
			completedBoundaries: completedWorkCycleBoundaries(events),
			attemptedBoundaries,
		});
		if (!decision.rotate) {
			lastAction = { action: "continue", reason: decision.reason, identity: null };
			setPhase("running");
			return { action: "continue", reason: decision.reason };
		}
		// Bounded rotation: the trusted Host policy, never a model value.
		if (autoRotations >= consolePolicyResolved.max_auto_rotations) {
			const reason = `automatic Session rotation limit reached (${autoRotations}/${consolePolicyResolved.max_auto_rotations}); the same work-cycle boundary has no committed progress`;
			setPhase("blocked", reason);
			return { action: "blocked", reason, identity: decision.identity };
		}
		if (continuations >= consolePolicyResolved.max_continuations) {
			const reason = `continuation limit reached (${continuations}/${consolePolicyResolved.max_continuations}); refusing another Session`;
			setPhase("blocked", reason);
			return { action: "blocked", reason, identity: decision.identity };
		}
		setPhase("handoff_pending");
		// Never clobber a staged request that is already waiting (for example one
		// the model staged with `aegis_switch_session`). Recover THAT request through
		// the same Supervisor gate instead of overwriting it.
		const waiting = await readStagedRequest();
		if (waiting?.request_id) {
			const completed = events.some(
				(row) => row.event_type === "handoff.completed" && row.payload?.request_id === waiting.request_id,
			);
			if (!completed) {
				attemptedBoundaries.add(decision.identity);
				const recovered = await supervisor.recoverInterrupted();
				if (!recovered.recovered) {
					setPhase("blocked", `a waiting handoff could not be recovered: ${recovered.reason}`);
					return {
						action: "blocked",
						reason: `waiting_handoff_not_recovered: ${recovered.reason}`,
						identity: decision.identity,
					};
				}
				autoRotations += 1;
				lastAction = {
					action: "rotated",
					identity: decision.identity,
					reasons: decision.reasons,
					from_session: sourceSessionId,
					to_session: recovered.new_session_id ?? sessionIdentity(session),
					request_id: recovered.request_id ?? waiting.request_id,
					recovered: true,
				};
				setPhase("running");
				return { action: "rotated", ...lastAction };
			}
		}
		// One attempt per boundary identity. Recorded BEFORE the attempt so a
		// failure is not retried in a loop; a refusal does NOT count as a rotation.
		attemptedBoundaries.add(decision.identity);
		const staged = stageHostHandoff({
			eventLogPath,
			handoffPath,
			taskId,
			reason: decision.reasons.includes("review_hold")
				? "work-cycle review hold carried into a bounded replacement Session"
				: `automatic post-settle rotation (${decision.reasons.join(", ")})`,
			manifest,
			workCyclePolicy: workPolicy,
			workCycleIdentity: decision.identity,
			workCycleReasons: decision.reasons,
		});
		if (!staged.ok) {
			setPhase("blocked", `handoff staging refused: ${staged.reason}`);
			return { action: "blocked", reason: `handoff_staging_refused: ${staged.reason}`, identity: decision.identity };
		}
		const rotated = await supervisor.rotate({ requestId: staged.request_id, reason: "console settle boundary" });
		if (rotated.reused) {
			// The boundary already completed in a previous process: do not create a
			// second Session for it, and do not report a failure.
			lastAction = { action: "continue", reason: "boundary_already_rotated", identity: decision.identity };
			setPhase("running");
			return { action: "continue", reason: "boundary_already_rotated", identity: decision.identity };
		}
		if (!rotated.applied) {
			setPhase("blocked", `Session replacement was not applied: ${rotated.reason}`);
			return {
				action: "blocked",
				reason: `rotation_not_applied: ${rotated.reason}`,
				identity: decision.identity,
				rotation: rotated,
			};
		}
		autoRotations += 1;
		lastAction = {
			action: "rotated",
			identity: decision.identity,
			reasons: decision.reasons,
			from_session: sourceSessionId,
			to_session: rotated.new_session_id ?? sessionIdentity(session),
			request_id: rotated.request_id ?? staged.request_id,
		};
		setPhase("running");
		return { action: "rotated", ...lastAction };
	}

	/**
	 * Send one human input to the CURRENT Session and drive the settle loop.
	 *
	 * Input is NEVER permission: the Observer/Broker still check the Task
	 * contract, target grant, work-unit gate and budget at the real boundaries.
	 */
	async function dispatch(text) {
		if (!started) {
			const startedResult = await start();
			if (!startedResult.ok) return { ok: false, reason: startedResult.reason, status: await status() };
		}
		if (phase === "paused" || phase === "stopped")
			return { ok: false, reason: `console is ${phase}`, status: await status() };
		if (phase === "blocked") {
			// An operator may ask again; recovery runs first and can unblock.
			const recovery = await recover();
			if (!recovery.ok) return { ok: false, reason: recovery.reason, status: await status() };
			setPhase("running");
		}
		if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "empty input" };
		setPhase("running");
		let promptError = null;
		try {
			await session.prompt(text);
		} catch (error) {
			promptError = error instanceof Error ? error.message : String(error);
		}
		try {
			await session.waitForIdle();
		} catch {
			// waitForIdle must not throw for a settled session; ignore and verify below.
		}
		setPhase("settling");
		if (promptError) {
			// A transport failure is not a settle. Report it and keep the run.
			lastAction = { action: "prompt_failed", reason: promptError };
			setPhase("running");
			return { ok: false, reason: promptError, status: await status() };
		}
		// Bounded continuation loop: each applied rotation already ran the
		// replacement's continuation prompt to settle, so re-decide until no
		// further safe boundary remains (or the policy limit stops it).
		const actions = [];
		for (let step = 0; step <= consolePolicyResolved.max_continuations; step += 1) {
			const decision = await decideAfterSettle();
			actions.push(decision);
			if (decision.action !== "rotated") break;
		}
		const last = actions[actions.length - 1] ?? { action: "continue" };
		return {
			ok: last.action !== "blocked",
			action: last.action,
			actions,
			reason: last.reason ?? null,
			status: await status(),
		};
	}

	function pause(reason = "operator paused the console") {
		if (phase === "stopped") return { ok: false, reason: "console is stopped" };
		setPhase("paused", reason);
		return { ok: true, status: "paused", reason };
	}

	async function resume(reason = "operator resumed the console") {
		if (phase === "stopped") return { ok: false, reason: "console is stopped" };
		if (phase !== "paused" && phase !== "blocked") return { ok: true, status: phase };
		if (!started) {
			// A blocked/failed instance released its lease; re-acquire and re-create.
			const restarted = await start();
			if (!restarted.ok) return { ok: false, reason: restarted.reason };
			return { ok: true, status: "running", recovery: restarted.recovery };
		}
		const recovery = await recover();
		if (!recovery.ok) {
			setPhase("blocked", recovery.reason);
			return { ok: false, reason: recovery.reason };
		}
		blockReason = null;
		setPhase("running");
		void reason;
		return { ok: true, status: "running", recovery };
	}

	/**
	 * Stop and release ONLY the resources this instance actually holds. Idempotent:
	 * a second call is a no-op. A refused instance (no lease, no binding, no
	 * Session) therefore cannot stop the real owner.
	 */
	async function shutdown(reason = "operator stopped the console") {
		if (phase === "stopped" && !ownershipHeld && !log && !bound) return { ok: true, already_stopped: true };
		setPhase("stopped", reason);
		await cleanupOwn();
		return { ok: true, already_stopped: false };
	}

	/**
	 * Switch the CURRENT Session's model (session configuration, not a task fact).
	 *
	 * The adapter validates the provider/model against this run's ModelRuntime and
	 * Pi refuses one without credentials. Nothing is written to the EventLog: a
	 * model change grants nothing, changes no budget and is not progress.
	 */
	/**
	 * Models the LIVE Session can switch to (from the run's ModelRuntime). This is
	 * deliberately not the agent-config catalog: the catalog may list models whose
	 * provider/credential this run was never configured for.
	 */
	async function availableModels() {
		if (!started || !session || typeof session.models !== "function")
			return { ok: false, reason: "no live Session", models: [] };
		try {
			return { ok: true, models: session.models() };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error), models: [] };
		}
	}

	async function setModel({ provider, id } = {}) {
		if (!started || !session) return { ok: false, reason: "no live Session to switch" };
		if (typeof session.setModel !== "function")
			return { ok: false, reason: "this Session adapter cannot switch models" };
		if (typeof provider !== "string" || !provider || typeof id !== "string" || !id)
			return { ok: false, reason: "provider and model id are required" };
		try {
			const applied = await session.setModel({ provider, id });
			return { ok: true, model: applied ?? null, status: await status() };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * Read the committed rows through the Host's own writer (refresh + verify).
	 * Read-only: no projection, no append, no authority. Used by the control
	 * channel to resolve request receipts and by the Web view.
	 */
	async function committedEvents() {
		if (!log) return { ok: false, reason: "event log is not open" };
		const refreshed = await log.refresh();
		if (!refreshed.ok) return { ok: false, reason: refreshed.error || "event log refresh failed" };
		return { ok: true, events: log.replay() };
	}

	/**
	 * Commit an INERT control receipt (`runtime.note kind=web.control.receipt`).
	 *
	 * This is transport metadata for the Web control channel: it creates no Board
	 * node, changes no RuntimeState field, grants nothing and cannot become a
	 * Fact/Outcome. It exists so a retried request resolves from committed truth
	 * (no duplicate prompt) and a crash leaves an `accepted` receipt instead of a
	 * silent "never received".
	 */
	async function appendControlReceipt({ requestId, promptDigest, status = "accepted", detail = null } = {}) {
		if (!log || log.healthy !== true) return { ok: false, reason: "event log is not healthy" };
		if (typeof requestId !== "string" || !requestId || requestId.length > 200)
			return { ok: false, reason: "invalid request id" };
		if (typeof promptDigest !== "string" || !promptDigest) return { ok: false, reason: "invalid prompt digest" };
		const boundedDetail = typeof detail === "string" ? detail.slice(0, 300) : null;
		const recorded = await log.append({
			event_type: "runtime.note",
			episode_id: null,
			payload: {
				kind: "web.control.receipt",
				version: "web-control-1",
				request_id: requestId,
				prompt_digest: promptDigest,
				status: typeof status === "string" ? status.slice(0, 40) : "accepted",
				detail: boundedDetail,
			},
			source: {
				actor_id: "aegis-web",
				kind: "runtime",
				adapter: "experiment-console",
				version: EXPERIMENT_CONSOLE_VERSION,
			},
		});
		if (!recorded.ok) return { ok: false, reason: recorded.error || "receipt was not durable" };
		return { ok: true, event_id: recorded.event?.event_id ?? null };
	}

	return {
		version: EXPERIMENT_CONSOLE_VERSION,
		start,
		committedEvents,
		appendControlReceipt,
		availableModels,
		setModel,
		recover,
		dispatch,
		status,
		statusLine,
		pause,
		resume,
		shutdown,
		/** Derived projection for the current committed prefix (Host boundary only). */
		snapshot: async () => {
			const committed = await openCommitted({ persist: true });
			if (!committed.ok) return { ok: false, reason: committed.reason };
			return {
				ok: true,
				source: committed.projection.source,
				tail_rows: committed.projection.tail_rows,
				events: committed.events.length,
				board: committed.projection.board,
				state: committed.projection.state,
				workCycle: committed.projection.workCycle,
			};
		},
		/** Test/diagnostic seam: the derived status machine's current phase. */
		phase: () => phase,
	};
}

/** True when a Task/Episode has no accepted scoped Intent yet (derived). */
export function isUnscopedEpisode(state, taskId, cycle) {
	if (!state || !taskId) return false;
	const episode = resolveOpenEpisode(state, taskId);
	if (!episode) return false;
	return cycle?.unscoped === true;
}
