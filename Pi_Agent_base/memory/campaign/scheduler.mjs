// Aegis Campaign C1 (INT-*) — durable single-worker scheduler control loop.
//
// One Campaign, one writer, at most one active Task. Injected interfaces:
//
//   sink      : { async append(event) -> {ok, event, durable, error}, replay?() }
//   worker    : { async run({task}) -> {ok, outcome_ref} | {ok:false, failure_mode} }
//   oracle    : { async judge({task, outcome_ref}) -> result }
//               { async reconcile({task, intent, effect_probe}) -> {status, ...} } (optional)
//   clock     : () => number (ms). NEVER the wall clock in tests.
//   budgetAccount : synthetic per-dispatch cost (explicitly labelled synthetic).
//
// Invariants (C1_INTEGRATION_CLOSURE_TASK §3):
//   * INT-ORDER: the projection reduces in verified append order.
//   * INT-COMMIT: EVERY append result is checked. A non-durable append before an
//     effect ⇒ no worker. A non-durable append after an effect ⇒ degraded, stop
//     new dispatch, return non-ok.
//   * INT-BUDGET: a dispatch requires the task's OWN persisted reservation; the
//     Campaign remaining is not borrowed.
//   * INT-DYNAMIC: tasks are resolved from the projection (static + admitted
//     dynamic definitions), never from a mutable initial array.
//   * INT-RECOVERY: control state comes from the projection; run() never
//     implicitly resumes; stranded intents are reconciled through the Oracle.
//   * INT-CHECKPOINT: the checkpoint binds the committed stream offset + tail;
//     recovery uses cache+tail when it is a verified prefix, else full replay.

import { digest } from "../fixture/contracts.mjs";
import {
	evaluateToolRecord,
	inspectExecutionPermit,
	PLAN_BINDING_VERSION,
	permitReasonText,
	TOOL_CHARGE_VERSION,
} from "./authority.mjs";
import { admitTaskProposal } from "./dynamic-policy.mjs";
import { compilePlanAdmission, planDigest } from "./e1-plan-contract.mjs";
import { loadPlanningAuthority } from "./e1-planning-contract.mjs";
import { canonicalManifestDigest } from "./manifest.mjs";
import { acquireCampaignOwnership, readCheckpoint, releaseCampaignOwnership, writeCheckpoint } from "./ownership.mjs";
import {
	canDispatch,
	parseBudgetStrict,
	projectQueueFromEvents,
	remainingBudget,
	toolStateFromProjection,
} from "./projection.mjs";
import { buildCommittedStream } from "./stream.mjs";

export const SCHEDULER_VERSION = "2.0.0";

/**
 * F13: a digest of the COMPLETE projection STATE (every semantic field that
 * participates in judgment/recovery). Stream position (tail offset/digest) and
 * other non-semantic fields are intentionally excluded so a prefix checkpoint
 * and its tail-applied state can be compared for state equivalence.
 */
function projectionDigest(projection) {
	return digest({
		tasks: projection.tasks.map((task) => ({
			task_id: task.task_id,
			state: task.state,
			episode_id: task.episode_id ?? null,
			is_dynamic: task.is_dynamic === true,
			definition: task.definition ?? null,
			stage_ids: task.stage_ids ?? [],
			depends_on: task.depends_on ?? [],
			awaiting_plan_ready: task.awaiting_plan_ready === true,
			plan_ready: task.plan_ready === true,
			plan_id: task.plan_id ?? null,
			reservation: task.reservation ?? null,
			budget_consumed: task.budget_consumed ?? null,
			task_outcome_status: task.task_outcome_status ?? null,
			task_outcome_ref: task.task_outcome_ref ?? null,
			task_outcomes: task.task_outcomes ?? [],
			stage_outcomes: task.stage_outcomes ?? [],
			applied_command_keys: [...(task.applied_command_keys ?? [])].sort(),
			stop_reason: task.stop_reason ?? null,
			reconciliation_state: task.reconciliation_state ?? "none",
			reconciliation_ref: task.reconciliation_ref ?? null,
			reconciliation_reason: task.reconciliation_reason ?? null,
		})),
		budget: projection.budget,
		control: { state: projection.control.state, reason: projection.control.reason },
		proposals: [...projection.proposals.entries()]
			.map(([id, entry]) => ({ id, digest: entry.digest, offset: entry.offset }))
			.sort((a, b) => a.id.localeCompare(b.id)),
		plans: (projection.plans ?? [])
			.map((plan) => ({ id: plan.id, status: plan.status, digest: plan.digest }))
			.sort((a, b) => String(a.id).localeCompare(String(b.id))),
		outcomes: [...projection.outcomes.entries()]
			.map(([id, outcome]) => ({ id, outcome }))
			.sort((a, b) => a.id.localeCompare(b.id)),
	});
}

/**
 * @param {{[key: string]: any}} args
 */
export function createCampaignScheduler({
	manifest,
	ownedTasks = [],
	baseDir,
	sink,
	worker,
	oracle,
	clock = () => Date.now(),
	budgetAccount = { wall_time_ms: 1, model_requests: 1, tool_calls: 1 },
	acquireOwnership = true,
	ownerId = `scheduler-${process.pid}-${Math.random().toString(16).slice(2)}`,
	maxSteps = 1000,
	writeCheckpointImpl = writeCheckpoint,
	readCheckpointImpl = readCheckpoint,
	effectProbe = null,
	artifacts = {},
} = {}) {
	let ownership = null;
	let lastCheckpoint = { ok: null, reason: null };
	let usedCheckpoint = false;
	let running = false; // single-flight guard
	const manifestDigest = canonicalManifestDigest(manifest);
	const staticTasks = [...ownedTasks];
	const costCheck = parseBudgetStrict(budgetAccount);
	const dispatchCost = costCheck.ok ? costCheck.value : { wall_time_ms: 0, model_requests: 0, tool_calls: 0 };
	const syntheticCost = { ...dispatchCost, synthetic: true };

	/** Read the committed rows in append order (via the real EventLog or a fake). */
	function readCommittedRows() {
		if (typeof sink.replay === "function") return sink.replay();
		return sink.events ?? sink.rows ?? [];
	}

	/** Reduce the current committed stream into the projection. */
	function project({ baseTasks = staticTasks, events = null } = {}) {
		const rows = events ?? readCommittedRows();
		return projectQueueFromEvents({
			campaign_id: manifest.campaign_id,
			tasks: baseTasks,
			events: rows,
			revision: manifest.revision ?? 0,
			manifest,
			artifacts,
		});
	}

	/**
	 * INT-CHECKPOINT: reduce the committed stream on top of a checkpoint snapshot.
	 * Only events after the checkpoint's offset are applied.
	 */
	function projectWithPrior(checkpoint) {
		return projectQueueFromEvents({
			campaign_id: manifest.campaign_id,
			tasks: staticTasks,
			events: readCommittedRows(),
			revision: manifest.revision ?? 0,
			manifest,
			artifacts,
			priorState: {
				queue: checkpoint.queue,
				budget: checkpoint.budget,
				control: checkpoint.control,
				proposals: checkpoint.proposals ?? [],
				outcomes: checkpoint.outcomes ?? [],
				applied_commands: checkpoint.applied_commands ?? [],
				applied_outcomes: checkpoint.applied_outcomes ?? [],
				accepted_outcomes: checkpoint.accepted_outcomes ?? [],
				tool_charges: checkpoint.tool_charges ?? [],
				tail_offset: checkpoint.stream_offset ?? -1,
			},
		});
	}

	function releaseOwnership() {
		if (ownership?.ok && baseDir) releaseCampaignOwnership(baseDir, manifest.campaign_id, { ownerId });
		ownership = null;
	}

	/** Persist a checkpoint bound to the PHYSICAL committed tail. Never throws. */
	function persistCheckpoint(projection) {
		if (!baseDir) return { ok: true, skipped: true };
		const stream = buildCommittedStream({ rows: readCommittedRows(), campaign_id: manifest.campaign_id });
		const record = {
			campaign_id: manifest.campaign_id,
			manifest_digest: manifestDigest,
			revision: manifest.revision ?? 0,
			state_revision: manifest.revision ?? 0,
			stream_offset: stream.tail_offset,
			last_event_digest: stream.tail_digest,
			last_event_id: stream.tail_event_id,
			projection_digest: projectionDigest(projection),
			queue: projection.tasks.map((task) => ({
				task_id: task.task_id,
				state: task.state,
				episode_id: task.episode_id ?? null,
				session_id: task.session_id ?? null,
				attempt_id: task.attempt_id ?? null,
				depends_on: task.depends_on ?? [],
				order: task.order ?? 1,
				reservation: task.reservation ?? null,
				budget_consumed: task.budget_consumed ?? null,
				definition: task.definition ?? null,
				is_dynamic: task.is_dynamic === true,
				parent_task_id: task.parent_task_id ?? null,
				stage_ids: task.stage_ids ?? [],
				task_outcome_status: task.task_outcome_status ?? null,
				task_outcome_ref: task.task_outcome_ref ?? null,
				task_outcomes: task.task_outcomes ?? [],
				stage_outcomes: task.stage_outcomes ?? [],
				applied_command_ids: task.applied_command_ids ?? [],
				applied_command_keys: task.applied_command_keys ?? [],
				stop_reason: task.stop_reason ?? null,
				reconciliation_state: task.reconciliation_state ?? "none",
				reconciliation_ref: task.reconciliation_ref ?? null,
				reconciliation_reason: task.reconciliation_reason ?? null,
			})),
			budget: projection.budget,
			control: projection.control,
			proposals: [...projection.proposals.entries()].map(([id, entry]) => ({
				id,
				digest: entry.digest,
				offset: entry.offset,
				proposal: entry.proposal,
			})),
			outcomes: [...projection.outcomes.entries()].map(([id, outcome]) => ({ id, outcome })),
			applied_commands: projection.applied_commands ?? [],
			applied_outcomes: projection.applied_outcomes ?? [],
			accepted_outcomes: projection.accepted_outcomes ?? [],
			tool_charges: projection.tool_charges ?? [],
		};
		const written = writeCheckpointImpl(baseDir, manifest.campaign_id, record);
		lastCheckpoint = written?.ok ? { ok: true, reason: null } : { ok: false, reason: written?.reason ?? "unknown" };
		return written;
	}

	/**
	 * INT-COMMIT: a unified durable append boundary. Returns
	 * `{ok, durable, event, error}` and NEVER treats a Promise resolution as a
	 * durability guarantee.
	 */
	async function commit(kind, payload, source) {
		let result;
		try {
			result = await sink.append({
				event_type: "runtime.note",
				source,
				payload: { kind, campaign_id: manifest.campaign_id, ...payload },
			});
		} catch (error) {
			return { ok: false, durable: false, event: null, error: `append threw: ${String(error)}` };
		}
		if (!result || result.ok !== true) {
			return { ok: false, durable: false, event: null, error: result?.error ?? "append not ok" };
		}
		if (result.durable === false) {
			return { ok: false, durable: false, event: result.event ?? null, error: "append reported durable:false" };
		}
		return { ok: true, durable: true, event: result.event ?? null, error: null };
	}

	/**
	 * The exact §6.1 PlanCommandResult shape: every field explicitly present.
	 * @param {{command: string, ok: boolean, status: string, reasons?: string[], planId?: string|null, planDigest?: string|null, submittedEventId?: string|null, transitionEventId?: string|null, committedPrefix?: any, recordDurable?: boolean, admission?: any}} args
	 */
	function commandResult(
		{
			command,
			ok,
			status,
			reasons = [],
			planId = null,
			planDigest: pd = null,
			submittedEventId = null,
			transitionEventId = null,
			committedPrefix: prefix = null,
			recordDurable = true,
			admission = null,
		} = /** @type {any} */ ({}),
	) {
		const current = project();
		const active = (current.plans ?? []).find((p) => p.status === "admitted") ?? null;
		// `activated` only reflects an ACCEPTED durable plan-ready for THIS plan.
		const activated =
			planId !== null &&
			current.tasks.some((task) => task.plan_ready === true && task.plan_id === planId && task.state === "completed");
		// Only an ACCEPTED admission is a plan transition; recording a candidate is not.
		const transition = ok === true && command === "admit_plan" && status === "admitted";
		return {
			command,
			ok: ok === true,
			status,
			buffered: false,
			record_durable: recordDurable === true,
			transition_accepted: transition,
			activated,
			plan_id: planId,
			plan_digest: pd,
			active_plan_id: active?.id ?? null,
			submitted_event_id: submittedEventId,
			transition_event_id: transitionEventId,
			committed_prefix: prefix,
			reasons: [...reasons],
			admission,
		};
	}

	/** The durable committed prefix identity of a plan index entry. */
	function committedPrefix(entry) {
		if (!entry) return null;
		return { offset: entry.offset ?? -1, event_id: entry.event_id ?? null, event_digest: entry.event_digest ?? null };
	}

	/**
	 * E1-CC §6.2: ONE short critical section for every Host command that reads the
	 * latest prefix, decides, appends and confirms (plans, tool charges). EventLog
	 * serializes appends only; this serializes the read-decide-commit. It never
	 * spans a provider/Oracle/Worker wait.
	 */
	let commandTail = Promise.resolve();
	function exclusive(fn) {
		const run = commandTail.then(fn, fn);
		commandTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	const planningContract = manifest.planning_contract ?? null;
	/** The run binding every E1 Host envelope carries (E1-CC §4.1). */
	function runBinding() {
		if (!planningContract) return {};
		return {
			binding_version: PLAN_BINDING_VERSION,
			manifest_revision: manifest.revision ?? 0,
			manifest_digest: manifestDigest,
			context_digest: planningContract.digest ?? null,
		};
	}
	/** The ACCEPTED planning Episode, from the projection (never the caller). */
	function planningBinding(projection, requestedTaskId) {
		const planningTaskId = planningContract?.planning_task_id ?? requestedTaskId ?? null;
		if (!planningTaskId) return { ok: false, reason: "invalid_plan_binding: no planning task identity" };
		if (planningContract && requestedTaskId && requestedTaskId !== planningTaskId)
			return { ok: false, reason: `invalid_plan_binding: ${requestedTaskId} is not the contract planning task` };
		const start = (projection.authority?.accepted_starts ?? []).find((s) => s.task_id === planningTaskId) ?? null;
		const row = projection.tasks.find((task) => task.task_id === planningTaskId) ?? null;
		if (planningContract && (!start || row?.state !== "running"))
			return {
				ok: false,
				reason: `invalid_plan_binding: planning task ${planningTaskId} is not the active started task`,
			};
		return { ok: true, planningTaskId, episodeId: start?.episode_id ?? null };
	}
	/** True when the reducer rejected the event with this id. */
	function rejectionFor(projection, eventId) {
		return (projection.rejected ?? []).find((r) => r.event_id === eventId) ?? null;
	}
	function planResult(fields) {
		return commandResult({ command: "admit_plan", ...fields });
	}

	async function recordCandidateLocked({ plan, planningTaskId }) {
		const pid = plan?.plan_id ?? null;
		const pd = planDigest(plan);
		const fail = (status, reasons, extra = {}) =>
			commandResult({ command: "record_candidate", ok: false, status, planId: pid, planDigest: pd, reasons, ...extra });
		if (typeof pid !== "string" || !pid) return fail("rejected", ["plan.plan_id is required"]);
		const projection = project();
		const binding = planningBinding(projection, planningTaskId);
		if (!binding.ok) return fail("rejected", [binding.reason]);
		const existing = projection.plans.find((p) => p.id === pid) ?? null;
		if (existing) {
			if (existing.digest !== pd)
				return fail("rejected", [
					`plan_identity_conflict: plan ${pid} was already recorded with a different candidate`,
				]);
			return commandResult({
				command: "record_candidate",
				ok: true,
				status: "duplicate",
				planId: pid,
				planDigest: pd,
				submittedEventId: existing.event_id ?? null,
				committedPrefix: committedPrefix(existing),
			});
		}
		const written = await commit(
			"campaign.plan.submitted",
			{
				plan_id: pid,
				plan_digest: pd,
				plan,
				planning_task_id: binding.planningTaskId,
				episode_id: binding.episodeId,
				...runBinding(),
			},
			{ kind: "runtime", actor_id: ownerId },
		);
		if (!written.ok)
			return fail("incomplete", [`submitted: ${written.error ?? "append failed"}`], { recordDurable: false });
		const after = project();
		const accepted = after.plans.find((p) => p.id === pid && p.event_id === written.event?.event_id) ?? null;
		if (!accepted)
			return fail("rejected", [rejectionFor(after, written.event?.event_id)?.reason ?? "candidate not accepted"], {
				submittedEventId: written.event?.event_id ?? null,
			});
		return commandResult({
			command: "record_candidate",
			ok: true,
			status: "submitted",
			planId: pid,
			planDigest: pd,
			submittedEventId: written.event?.event_id ?? null,
			committedPrefix: committedPrefix(accepted),
		});
	}
	async function admitPlanLocked({ plan, planningTaskId }) {
		const pid = plan?.plan_id ?? null;
		const pd = planDigest(plan);
		const base = { planId: pid, planDigest: pd };
		if (!planningContract)
			return planResult({
				...base,
				ok: false,
				status: "rejected",
				reasons: ["legacy_context_unavailable: a plan admission requires the Manifest's trusted planning contract"],
			});
		const authority = loadPlanningAuthority({ manifest });
		if (!authority.ok)
			return planResult({
				...base,
				ok: false,
				status: "rejected",
				reasons: [`planning_context_conflict: ${authority.reasons.join("; ")}`],
			});
		let projection = project();
		const binding = planningBinding(projection, planningTaskId);
		if (!binding.ok) return planResult({ ...base, ok: false, status: "rejected", reasons: [binding.reason] });
		const envelopeBase = {
			plan_id: pid,
			plan_digest: pd,
			planning_task_id: binding.planningTaskId,
			episode_id: binding.episodeId,
			...runBinding(),
		};
		// 1. The candidate: reuse the SAME durable submitted record (shared dedup).
		let existing = projection.plans.find((p) => p.id === pid) ?? null;
		if (existing && existing.digest !== pd)
			return planResult({
				...base,
				ok: false,
				status: "rejected",
				reasons: [`plan_identity_conflict: plan ${pid} was already recorded with a different candidate`],
			});
		// 2. Exact duplicate of the ACCEPTED admission: return its original identity.
		if (existing?.status === "admitted")
			return planResult({
				...base,
				ok: true,
				status: "duplicate",
				submittedEventId: existing.event_id ?? null,
				transitionEventId: existing.admitted_event_id ?? null,
				committedPrefix: {
					offset: existing.admitted_offset ?? -1,
					event_id: existing.admitted_event_id ?? null,
					event_digest: existing.admitted_event_digest ?? null,
				},
			});
		if (existing && existing.status !== "submitted")
			return planResult({
				...base,
				ok: false,
				status: existing.status,
				submittedEventId: existing.event_id ?? null,
				reasons: [...(existing.reasons ?? []), `plan ${pid} was already ${existing.status}`],
			});
		let submittedEventId = existing?.event_id ?? null;
		if (!existing) {
			const submitted = await commit(
				"campaign.plan.submitted",
				{ ...envelopeBase, plan },
				{ kind: "runtime", actor_id: ownerId },
			);
			if (!submitted.ok)
				return planResult({
					...base,
					ok: false,
					status: "incomplete",
					recordDurable: false,
					reasons: [`submitted: ${submitted.error ?? "append failed"}`],
				});
			submittedEventId = submitted.event?.event_id ?? null;
			projection = project();
			existing = projection.plans.find((p) => p.id === pid && p.event_id === submittedEventId) ?? null;
			if (!existing)
				return planResult({
					...base,
					ok: false,
					status: "rejected",
					submittedEventId,
					reasons: [rejectionFor(projection, submittedEventId)?.reason ?? "the candidate was not accepted"],
				});
		}
		// 3. Decide against the LATEST prefix with the shared compiler.
		const active = projection.plans.find((p) => p.status === "admitted") ?? null;
		/** @type {any} */
		const compiled = active
			? {
					status: "rejected",
					reasons: [`plan_already_admitted: plan ${active.id} is already the active admitted plan`],
				}
			: compilePlanAdmission({
					plan,
					manifest,
					planningTaskId: binding.planningTaskId,
					existingTaskIds: [...projection.tasks.map((task) => task.task_id), ...staticTasks.map((t) => t.task_id)],
					allocation: projection.budget.allocation_total,
					templates: authority.templates,
					rootGoalRef: authority.contract.root_goal_ref,
				});
		if (compiled.status !== "admitted") {
			const kind = compiled.status === "rejected" ? "campaign.plan.rejected" : "campaign.plan.blocked";
			const recorded = await commit(
				kind,
				{ ...envelopeBase, reasons: compiled.reasons, status: compiled.status },
				{ kind: "runtime", actor_id: ownerId },
			);
			return planResult({
				...base,
				ok: false,
				status: recorded.ok ? compiled.status : "incomplete",
				recordDurable: recorded.ok,
				submittedEventId,
				transitionEventId: recorded.event?.event_id ?? null,
				reasons: recorded.ok ? compiled.reasons : [...compiled.reasons, `${kind}: ${recorded.error}`],
			});
		}
		const admitted = await commit(
			"campaign.plan.admitted",
			{ ...envelopeBase, plan_tasks: compiled.normalized, reserved_budget: compiled.reserved_budget },
			{ kind: "runtime", actor_id: ownerId },
		);
		if (!admitted.ok)
			return planResult({
				...base,
				ok: false,
				status: "incomplete",
				recordDurable: false,
				submittedEventId,
				reasons: [`admitted: ${admitted.error ?? "append failed"}`],
			});
		// 4. Confirm the reducer accepted THIS event (append success is not acceptance).
		const after = project();
		const transitionEventId = admitted.event?.event_id ?? null;
		const entry = after.plans.find((p) => p.id === pid) ?? null;
		if (entry?.status !== "admitted" || entry.admitted_event_id !== transitionEventId)
			return planResult({
				...base,
				ok: false,
				status: "rejected",
				submittedEventId,
				transitionEventId,
				reasons: [rejectionFor(after, transitionEventId)?.reason ?? "the durable admission was not accepted"],
			});
		return planResult({
			...base,
			ok: true,
			status: "admitted",
			submittedEventId,
			transitionEventId,
			committedPrefix: {
				offset: entry.admitted_offset,
				event_id: transitionEventId,
				event_digest: entry.admitted_event_digest ?? null,
			},
			admission: compiled,
		});
	}

	async function toolCommandLocked(phase, args) {
		const refuse = (reasons, extra = {}) => ({
			ok: false,
			duplicate: false,
			charged: false,
			record_durable: false,
			event_id: null,
			reasons,
			...extra,
		});
		const projection = project();
		const running = projection.tasks.find((task) => task.state === "running") ?? null;
		const start = running
			? ((projection.authority?.accepted_starts ?? []).find((s) => s.task_id === running.task_id) ?? null)
			: null;
		if (!running || !start) return refuse(["invalid_tool_binding: no active accepted Task/Episode"]);
		if (args.task_id && args.task_id !== running.task_id)
			return refuse([`invalid_tool_binding: ${args.task_id} is not the active task ${running.task_id}`]);
		if (args.episode_id && args.episode_id !== start.episode_id)
			return refuse([`invalid_tool_binding: ${args.episode_id} is not the accepted episode ${start.episode_id}`]);
		if (phase === "charged") {
			const permit = inspectExecutionPermit({
				projection,
				taskId: running.task_id,
				episodeId: start.episode_id,
				now: clock(),
				operation: "tool_unit",
			});
			if (!permit.ok) return refuse([permitReasonText(permit)], { permit });
		}
		const payload = {
			kind: "c6.tool",
			campaign_id: manifest.campaign_id,
			version: TOOL_CHARGE_VERSION,
			phase,
			task_id: running.task_id,
			episode_id: start.episode_id,
			request_id: args.request_id ?? null,
			tool_call_id: args.tool_call_id ?? null,
			unit_id: args.unit_id ?? null,
			tool_name: args.tool_name ?? null,
			...(phase === "charged"
				? {
						arguments_digest: args.arguments_digest ?? null,
						manifest_revision: manifest.revision ?? 0,
						manifest_digest: manifestDigest,
						context_digest: planningContract?.digest ?? null,
						units: 1,
						charge_event_id: null,
					}
				: { result_ref: args.result_ref ?? null, result_digest: args.result_digest ?? null }),
		};
		const verdict = evaluateToolRecord({
			payload,
			sourceKind: "runtime",
			recordedAt: null,
			state: toolStateFromProjection(projection, manifest),
		});
		if (!verdict.ok) return refuse([verdict.reason], { code: verdict.code });
		if (verdict.duplicate)
			return {
				ok: true,
				duplicate: true,
				charged: false,
				record_durable: true,
				event_id: (phase === "charged" ? verdict.entry.charge_event_id : verdict.entry.finish_event_id) ?? null,
				reasons: [],
			};
		const { kind: _kind, campaign_id: _campaign, ...rest } = payload;
		const written = await commit("c6.tool", rest, { kind: "runtime", actor_id: ownerId });
		if (!written.ok) return refuse([`durability_unconfirmed: ${written.error ?? "tool append failed"}`]);
		const eventId = written.event?.event_id ?? null;
		const after = project();
		const confirmed = (after.tool_charges ?? []).find((entry) => entry.key === verdict.key) ?? null;
		const accepted =
			phase === "charged" ? confirmed?.charge_event_id === eventId : confirmed?.finish_event_id === eventId;
		if (!accepted)
			return refuse([rejectionFor(after, eventId)?.reason ?? "the durable tool record was not accepted"], {
				record_durable: true,
				event_id: eventId,
			});
		return {
			ok: true,
			duplicate: false,
			charged: phase === "charged",
			record_durable: true,
			event_id: eventId,
			reasons: [],
		};
	}

	return {
		get state() {
			return project().control.state;
		},
		/**
		 * INT-DYNAMIC: admit a bounded dynamic Task proposal through the ONE existing
		 * policy. It commits `campaign.proposal.submitted` then
		 * `campaign.proposal.admitted` (both durable) so the Scheduler discovers the
		 * task from the projection and dispatches it. The proposal is re-validated by
		 * `admitTaskProposal`; a rejected/blocked proposal is committed honestly and
		 * never becomes a task. The MODEL supplies only data: it can never grant
		 * privilege or raise the budget.
		 *
		 * @param {{proposal: any, commandId?: string|null, proposalId?: string|null}} [args]
		 */
		async proposeDynamicTask({ proposal, commandId = null, proposalId = null } = /** @type {any} */ ({})) {
			const projection = project();
			const queueState = {
				tasks: [...staticTasks, ...projection.tasks.map((t) => t.definition).filter(Boolean)],
			};
			const parentDepth =
				(projection.tasks.find((t) => t.task_id === proposal?.parent_task_id)?.parent_chain_depth ?? 0) + 1;
			const admission = admitTaskProposal({ proposal, manifest, queueState, depth: parentDepth });
			const pid = proposalId ?? `prop-${manifest.campaign_id}-${clock()}`;
			const cid = commandId ?? `cmd-${pid}`;
			const submitted = await commit(
				"campaign.proposal.submitted",
				{
					proposal_id: pid,
					proposal,
					proposal_digest: digest(proposal),
					command_id: cid,
				},
				{ kind: "runtime", actor_id: ownerId },
			);
			if (!submitted.ok) return { ok: false, status: "rejected", reason: submitted.error };
			if (admission.status !== "admitted") {
				const kind = admission.status === "rejected" ? "campaign.proposal.rejected" : "campaign.proposal.blocked";
				const recorded = await commit(
					kind,
					{ proposal_id: pid, proposal_digest: digest(proposal), reasons: admission.reasons, status: admission.status },
					{ kind: "runtime", actor_id: ownerId },
				);
				if (!recorded.ok) return { ok: false, status: admission.status, reason: recorded.error };
				return { ok: false, status: admission.status, reasons: admission.reasons, admission };
			}
			const admitted = await commit(
				"campaign.proposal.admitted",
				{
					proposal_id: pid,
					proposal_digest: digest(proposal),
					task_id: proposal.proposed_task_id,
					command_id: cid,
					admission,
					reserved_budget: admission.reserved_budget,
				},
				{ kind: "runtime", actor_id: ownerId },
			);
			if (!admitted.ok) return { ok: false, status: "admitted", reason: admitted.error };
			return { ok: true, status: "admitted", task_id: proposal.proposed_task_id, admission };
		},
		/**
		 * E1-CC §6: admit ONE complete candidate plan. The Host NEVER trusts a
		 * caller-supplied admission: inside one short critical section it reads the
		 * latest committed prefix, compiles the candidate with the SAME compiler the
		 * replay uses, appends, and re-projects to confirm THIS event was accepted.
		 * `admission` is accepted for interface compatibility and ignored.
		 *
		 * @param {{plan: any, planningTaskId?: string, admission?: any, planId?: string|null, planDigest?: string|null}} args
		 */
		async admitPlan({ plan, planningTaskId = null } = /** @type {any} */ ({})) {
			return exclusive(() => admitPlanLocked({ plan, planningTaskId }));
		},
		/**
		 * E1-CC §6.1: record ONE candidate plan. Tool and Host share this dedup and
		 * writer, so an identical candidate is a `duplicate` of the original durable
		 * record and a same-id/different-content candidate is a conflict that writes
		 * nothing. Recording never admits or activates anything.
		 *
		 * @param {{plan: any, planningTaskId?: string|null, planId?: string|null}} args
		 */
		async recordPlanCandidate({ plan, planningTaskId = null } = /** @type {any} */ ({})) {
			return exclusive(() => recordCandidateLocked({ plan, planningTaskId }));
		},
		/**
		 * E1: complete the PLANNING task through its own trusted plan_ready Oracle,
		 * then release the batch children from the plan-ready gate. This is a SEPARATE
		 * durable state from the batch admission.
		 *
		 * @param {{taskId: string, planId?: string|null, outcome?: any}} args
		 */
		async completePlanningTask({ taskId, planId = null, outcome = null } = /** @type {any} */ ({})) {
			const released = await releasePlanGate(taskId, outcome?.outcome_id ?? null, planId);
			if (released.ok !== true)
				return { ok: false, reason: released.reason ?? released.error ?? "plan-ready gate failed" };
			return { ok: true };
		},
		/**
		 * E1-CC §7.2: the atomic, dual-sided DURABLE tool charge. The binding (active
		 * Task/Episode) comes from the authoritative projection, never the caller;
		 * the decision uses the SAME evaluator the reducer replays, inside the same
		 * critical section as plan commands, so two concurrent charges can never both
		 * pass a stale balance. The caller must await this before the tool body.
		 *
		 * @param {{request_id: string, tool_call_id: string, unit_id: string, tool_name: string, arguments_digest?: string|null, task_id?: string|null, episode_id?: string|null}} args
		 */
		async chargeTool(args = /** @type {any} */ ({})) {
			return exclusive(() => toolCommandLocked("charged", args));
		},
		/**
		 * E1-CC §7.2: mark an ACCEPTED charged unit finished (the body returned, error
		 * or not). A finish with no prior accepted charge is refused. It never
		 * refunds and is not an Oracle result.
		 */
		async finishTool(args = /** @type {any} */ ({})) {
			return exclusive(() => toolCommandLocked("finished", args));
		},
		lastCheckpointOk() {
			return lastCheckpoint.ok;
		},
		lastCheckpointReason() {
			return lastCheckpoint.reason;
		},
		usedCheckpoint() {
			return usedCheckpoint;
		},
		/**
		 * INT-RECOVERY: control changes are DURABLE Host commands. These append a
		 * committed control event so the state survives a restart; they are not a
		 * local boolean.
		 */
		async pause(reason = "user_paused") {
			return commit("campaign.campaign.paused", { reason }, { kind: "runtime", actor_id: ownerId });
		},
		async resume(reason = "user_resumed") {
			return commit("campaign.campaign.resumed", { reason }, { kind: "runtime", actor_id: ownerId });
		},
		async cancel(reason = "user_cancelled") {
			return commit("campaign.campaign.cancelled", { reason }, { kind: "runtime", actor_id: ownerId });
		},
		async stop(reason = "user_stopped") {
			return commit("campaign.campaign.stopped", { reason }, { kind: "runtime", actor_id: ownerId });
		},
		releaseOwnership,
		async run() {
			// INT-COMMIT: single-flight. A concurrent/re-entrant run is refused.
			if (running) return { ok: false, reasons: ["run() is already in progress (single-flight)"], status: null };
			running = true;
			const runReasons = [];
			try {
				if (acquireOwnership && baseDir) {
					ownership = acquireCampaignOwnership(baseDir, manifest.campaign_id, { ownerId });
					if (!ownership.ok) {
						return { ok: false, reasons: [ownership.reason], status: project(), used_checkpoint: false };
					}
				}

				// INT-CHECKPOINT: attempt a verified cache+tail recovery.
				const startupEvents = readCommittedRows();
				let baseProjection = null;
				usedCheckpoint = false;
				// E1-CC §9: an E1 stream always replays its complete committed source.
				if (baseDir && !planningContract) {
					// A checkpoint may be at ANY verified prefix (not only the exact tail).
					const read = readCheckpointImpl(baseDir, manifest.campaign_id, { manifest_digest: manifestDigest });
					if (read.ok) {
						const cp = read.checkpoint;
						const cpOffset = cp.stream_offset ?? -1;
						// The checkpoint offset must be inside the current stream and its
						// recorded digest must equal the event at that offset (a verified prefix).
						const prefixValid =
							cpOffset >= -1 &&
							cpOffset < startupEvents.length &&
							(cpOffset < 0 || startupEvents[cpOffset]?.event_digest === cp.last_event_digest);
						if (prefixValid) {
							// F13: validate the checkpoint's PREFIX state digest FIRST (reduce only
							// the prefix events on top of the cached state), THEN apply the tail.
							const prefixEvents = startupEvents.slice(0, cpOffset + 1);
							const prefixState = projectQueueFromEvents({
								campaign_id: manifest.campaign_id,
								tasks: staticTasks,
								events: prefixEvents,
								revision: manifest.revision ?? 0,
								manifest,
								artifacts,
								priorState: {
									queue: cp.queue,
									budget: cp.budget,
									control: cp.control,
									proposals: cp.proposals ?? [],
									plans: cp.plans ?? [],
									dynamic_definitions: cp.dynamic_definitions ?? [],
									outcomes: cp.outcomes ?? [],
									applied_commands: cp.applied_commands ?? [],
									applied_outcomes: cp.applied_outcomes ?? [],
									accepted_outcomes: cp.accepted_outcomes ?? [],
									tool_charges: cp.tool_charges ?? [],
									tail_offset: cpOffset,
								},
							});
							if (prefixState.ok && projectionDigest(prefixState) === cp.projection_digest) {
								// The cached prefix is trusted; apply the tail on top of it.
								const resumed = projectWithPrior(cp);
								if (resumed.ok) {
									baseProjection = resumed;
									usedCheckpoint = true;
								}
							}
						}
					}
				}

				// Control state is taken from the PROJECTION (never a local default).
				let projection = baseProjection ?? project();
				let controlState = projection.control.state;

				if (controlState === "cancelled") {
					// A cancellation survives restart; the cancel event is already durable.
					// Do not append a redundant `stopped` (which would overwrite the cancel).
					persistCheckpoint(project());
					return { ok: true, reasons: runReasons, status: snapshot(controlState), used_checkpoint: usedCheckpoint };
				}
				if (controlState === "paused" || controlState === "stopped" || controlState === "budget_stopped") {
					return { ok: true, reasons: runReasons, status: snapshot(controlState), used_checkpoint: usedCheckpoint };
				}

				// INT-RECOVERY: reconcile stranded intents before dispatching.
				const reconcile = await reconcileStrandedRunning(project());
				if (!reconcile.ok) {
					persistCheckpoint(project());
					return {
						ok: false,
						reasons: [reconcile.reason],
						status: snapshot(controlState),
						used_checkpoint: usedCheckpoint,
					};
				}

				// INT-RECOVERY: a DELAYED unknown is revisited with a fresh judgment (no
				// worker re-run) so a late verification can advance the task legally.
				// (Also run once more after the dispatch loop below.)

				let steps = 0;
				while (steps < maxSteps) {
					steps += 1;
					projection = project();
					controlState = projection.control.state;
					if (controlState !== "running") break;
					const nextReady = projection.tasks.find((task) => task.state === "ready");
					if (!nextReady) break;
					// INT-BUDGET: gate on the task's OWN reservation.
					const permit = canDispatch({ task: nextReady, need: dispatchCost });
					if (!permit.ok) {
						runReasons.push(`task ${nextReady.task_id} blocked: ${permit.reason}`);
						// A durable budget-stop is recorded so a restart does not silently
						// retry a task whose allocation cannot fund a dispatch.
						const ledger = projection.budget;
						const limit = projection.health?.budget_limit ?? {};
						const remaining = remainingBudget(limit, ledger);
						const campaignExhausted = ["wall_time_ms", "model_requests", "tool_calls"].some(
							(key) => (limit[key] ?? 0) > 0 && remaining[key] < (dispatchCost[key] ?? 0),
						);
						if (campaignExhausted) {
							await commit(
								"campaign.campaign.stopped",
								{ reason: "budget_exhausted" },
								{ kind: "runtime", actor_id: ownerId },
							);
						}
						break;
					}
					// INT-DYNAMIC: the task definition comes from the projection.
					const definition = nextReady.definition ?? staticTasks.find((t) => t.task_id === nextReady.task_id);
					if (!definition) {
						runReasons.push(`task ${nextReady.task_id} has no resolvable definition`);
						break;
					}
					const step = await dispatchOne({ task: definition });
					if (!step.ok) {
						if (step.reason) runReasons.push(step.reason);
						break;
					}
					persistCheckpoint(project());
				}
				// INT-RECOVERY: after dispatch, revisit any task left `unknown` by a delayed
				// verification (fresh judgment, no worker re-run).
				await revisitDelayedUnknowns();
				persistCheckpoint(project());
				return {
					ok: runReasons.length === 0,
					reasons: runReasons,
					status: snapshot(project().control.state),
					used_checkpoint: usedCheckpoint,
				};
			} finally {
				// INT-COMMIT: always clean up the held resource.
				releaseOwnership();
				running = false;
			}
		},
	};

	function snapshot(controlState) {
		const p = project();
		return { campaign_state: controlState ?? p.control.state, ...p };
	}

	/**
	 * INT-RECOVERY: a task left `running` by a previous process holds a durable
	 * intent with no committed result. Ask the Oracle to reconcile it against the
	 * real effect. The worker is NEVER re-run to backfill a result.
	 */
	/**
	 * INT-RECOVERY: for each task left `unknown` by a DELAYED verification, ask the
	 * Oracle again and commit the (possibly corrected) judgment. The worker is NOT
	 * re-run. A bounded number of passes avoids an infinite loop.
	 */
	async function revisitDelayedUnknowns() {
		for (let pass = 0; pass < 3; pass += 1) {
			const projection = project();
			const delayed = projection.tasks.filter((t) => t.state === "unknown" && t.stop_reason === "delayed_verification");
			if (delayed.length === 0) return;
			let advanced = false;
			for (const row of delayed) {
				const definition = row.definition ?? staticTasks.find((t) => t.task_id === row.task_id) ?? null;
				if (!definition) continue;
				let judgment;
				try {
					judgment = await oracle.judge({ task: definition, outcome_ref: `artifact:${row.task_id}` });
				} catch (error) {
					judgment = { status: "unknown", failure_mode: "oracle_unavailable", error: String(error) };
				}
				const status = ["success", "failure", "unknown", "invalid"].includes(judgment?.status)
					? judgment.status
					: "unknown";
				if (status === "unknown") continue;
				const outcomeId =
					judgment?.outcome_id && judgment.outcome_id !== `o-${row.task_id}`
						? judgment.outcome_id
						: `o-revisit-${row.task_id}-${pass}`;
				// A fresh judgment must also supply the required stage evidence.
				for (const stageJudgment of Array.isArray(judgment?.stage_outcomes) ? judgment.stage_outcomes : []) {
					const stageCommit = await commit(
						"campaign.oracle.result",
						{
							task_id: row.task_id,
							outcome_id: stageJudgment.outcome_id ?? `o-${row.task_id}-${stageJudgment.step_id}-${pass}`,
							status: stageJudgment.status,
							step_id: stageJudgment.step_id,
							episode_id: stageJudgment.episode_id ?? row.episode_id ?? `ep-${row.task_id}`,
							outcome: stageJudgment.outcome ?? stageJudgment,
						},
						{ kind: "oracle", actor_id: oracle.id ?? "oracle" },
					);
					if (!stageCommit.ok) return;
				}
				const resultCommit = await commit(
					"campaign.oracle.result",
					{
						task_id: row.task_id,
						outcome_id: outcomeId,
						status,
						task_oracle: true,
						episode_id: row.episode_id ?? `ep-${row.task_id}`,
						outcome:
							judgment?.outcome ??
							buildJudgmentOutcome({
								judgment,
								task: definition,
								status,
								episodeId: row.episode_id ?? `ep-${row.task_id}`,
							}),
					},
					{ kind: "oracle", actor_id: oracle.id ?? "oracle" },
				);
				if (!resultCommit.ok) return;
				if (status === "success") {
					const done = await commit(
						"campaign.task.completed",
						{ task_id: row.task_id, outcome_id: outcomeId },
						{ kind: "runtime", actor_id: ownerId },
					);
					if (!done.ok) return;
				}
				advanced = true;
			}
			if (!advanced) return;
		}
	}

	async function reconcileStrandedRunning(projection) {
		// E1: an admitted plan batch identifies its planning Task. Admission alone is
		// NOT completion, so a stranded planning Task is never completed by
		// re-judging the batch: recovery must not activate a batch whose planning
		// Task never durably completed.
		const planningTaskIds = new Set(
			(projection.plans ?? [])
				.filter((plan) => plan.status === "admitted")
				.map((plan) => plan.planning_task_id)
				.filter(Boolean),
		);
		for (const row of projection.tasks) {
			if (row.state !== "running") continue;
			if (row.task_outcome_status === "success") {
				// INT-RECOVERY: result durable but completion missing → complete it.
				const done = await commit(
					"campaign.task.completed",
					{ task_id: row.task_id, outcome_id: row.task_outcome_ref ?? null },
					{ kind: "runtime", actor_id: ownerId },
				);
				if (!done.ok) return { ok: false, reason: `could not complete recovered result: ${done.error}` };
				// E1: only after the planning Task durably completed may the batch release.
				const gate = await releasePlanGate(row.task_id, row.task_outcome_ref ?? null);
				if (gate.ok !== true) return { ok: false, reason: `plan-ready gate failed on recovery: ${gate.reason}` };
				continue;
			}
			if (planningTaskIds.has(row.task_id)) {
				// The batch is durable but the planning Task never completed. Keep the
				// recovery fail-closed: record an explicit hold rather than guessing that
				// the planning ended normally.
				const held = await commit(
					"campaign.task.unknown",
					{ task_id: row.task_id, reason: "planning_completion_missing" },
					{ kind: "runtime", actor_id: ownerId },
				);
				if (!held.ok) return { ok: false, reason: `could not record planning hold: ${held.error}` };
				continue;
			}
			const definition = row.definition ?? staticTasks.find((t) => t.task_id === row.task_id) ?? null;
			if (!definition) return { ok: false, reason: `stranded task ${row.task_id} has no definition` };
			let verdict;
			try {
				verdict =
					typeof oracle.reconcile === "function"
						? await oracle.reconcile({ task: definition, intent: row, effect_probe: effectProbe })
						: { status: "unknown", failure_mode: "no_reconcile_adapter" };
			} catch (error) {
				verdict = { status: "unknown", failure_mode: "reconcile_threw", error: String(error) };
			}
			const status = ["success", "failure", "unknown", "invalid"].includes(verdict?.status)
				? verdict.status
				: "unknown";
			if (status === "success" || status === "failure") {
				// F7: commit the reconciled STAGE evidence too, so reconciliation goes
				// through the same required-stage gate as a normal completion.
				for (const stageJudgment of Array.isArray(verdict?.stage_outcomes) ? verdict.stage_outcomes : []) {
					const stageCommit = await commit(
						"campaign.oracle.result",
						{
							task_id: row.task_id,
							outcome_id: stageJudgment.outcome_id ?? `o-${row.task_id}-${stageJudgment.step_id}`,
							status: stageJudgment.status,
							step_id: stageJudgment.step_id,
							episode_id: stageJudgment.episode_id ?? row.episode_id ?? `ep-${row.task_id}`,
							outcome: stageJudgment.outcome ?? stageJudgment,
						},
						{ kind: "oracle", actor_id: oracle.id ?? "oracle" },
					);
					if (!stageCommit.ok)
						return { ok: false, reason: `could not commit reconciled stage result: ${stageCommit.error}` };
				}
				const resultCommit = await commit(
					"campaign.oracle.result",
					{
						task_id: row.task_id,
						outcome_id: verdict.outcome_id ?? `o-reconcile-${row.task_id}`,
						status,
						task_oracle: true,
						episode_id: row.episode_id ?? `ep-${row.task_id}`,
						outcome: verdict.outcome ?? verdict,
					},
					{ kind: "oracle", actor_id: oracle.id ?? "oracle" },
				);
				if (!resultCommit.ok) return { ok: false, reason: `could not commit reconciled result: ${resultCommit.error}` };
				const resolved = await commit(
					"campaign.reconciliation.resolved",
					{ task_id: row.task_id, outcome_id: verdict.outcome_id ?? null, verdict: status },
					{ kind: "runtime", actor_id: ownerId },
				);
				if (!resolved.ok) return { ok: false, reason: `could not record reconciliation: ${resolved.error}` };
			} else {
				const pending = await commit(
					"campaign.reconciliation.requested",
					{
						task_id: row.task_id,
						failure_mode: verdict?.failure_mode ?? "unknown",
						boundary: "restart_running_without_result",
					},
					{ kind: "runtime", actor_id: ownerId },
				);
				if (!pending.ok) return { ok: false, reason: `could not record reconciliation request: ${pending.error}` };
			}
		}
		return { ok: true };
	}

	async function releasePlanGate(taskId, outcomeId = null, requestedPlanId = null) {
		const projection = project();
		const admitted = (projection.plans ?? []).filter(
			(plan) => plan.status === "admitted" && (plan.planning_task_id ?? null) === taskId,
		);
		// A non-planning task has no batch: nothing to release (not a failure).
		if (admitted.length === 0) return { ok: true, skipped: true };
		const plan = admitted[admitted.length - 1];
		const planId = requestedPlanId ?? plan.id ?? plan.plan?.plan_id ?? null;
		if (!planId) return { ok: false, reason: `the admitted plan for ${taskId} has no id` };
		const start = (projection.authority?.accepted_starts ?? []).find((s) => s.task_id === taskId) ?? null;
		const record = await commit(
			"campaign.plan.ready",
			{
				task_id: taskId,
				plan_id: planId,
				outcome_id: outcomeId,
				...(planningContract ? { episode_id: start?.episode_id ?? null, ...runBinding() } : {}),
			},
			{ kind: "oracle", actor_id: oracle?.id ?? "oracle" },
		);
		if (!record.ok) return { ok: false, reason: record.error };
		return { ok: true };
	}

	async function dispatchOne({ task }) {
		const episodeId = `ep-${task.task_id}`;
		// 1. DURABLE INTENT (+ reservation commit) FIRST.
		const started = await commit(
			"campaign.task.started",
			{
				task_id: task.task_id,
				episode_id: episodeId,
				command_id: `start-${task.task_id}-${clock()}`,
				...(planningContract
					? {
							manifest_revision: manifest.revision ?? 0,
							manifest_digest: manifestDigest,
							context_digest: planningContract.digest ?? null,
						}
					: {}),
			},
			{ kind: "runtime", actor_id: ownerId },
		);
		if (!started.ok) return { ok: false, reason: `durable intent failed; worker not dispatched: ${started.error}` };

		// 2. Execute the injected worker.
		let run;
		try {
			run = await worker.run({ task });
		} catch (error) {
			run = { ok: false, failure_mode: "transport_failure", error: String(error) };
		}

		// 3. Charge the KNOWN synthetic cost (success, failure, or unknown).
		const charged = await commit(
			"campaign.budget.consumed",
			{ task_id: task.task_id, command_id: `consume-${task.task_id}-${clock()}`, consumed: syntheticCost },
			{ kind: "runtime", actor_id: ownerId },
		);
		// INT-COMMIT: a failed charge AFTER the effect is degraded, not ok:true,[].
		if (!charged.ok) {
			return {
				ok: false,
				reason: `budget charge failed after a possible effect; side effects halted: ${charged.error}`,
			};
		}

		// 4. Worker failure → unknown + reconciliation (never a task failure).
		if (!run || run.ok !== true) {
			const recon = await commit(
				"campaign.reconciliation.requested",
				{
					task_id: task.task_id,
					failure_mode: run?.failure_mode ?? "unknown_failure",
					detail: run?.error ?? null,
					boundary: "post_effect_failure",
				},
				{ kind: "runtime", actor_id: ownerId },
			);
			if (!recon.ok) return { ok: false, reason: `could not record reconciliation: ${recon.error}` };
			const unknown = await commit(
				"campaign.task.unknown",
				{ task_id: task.task_id, reason: "transport_failure" },
				{ kind: "runtime", actor_id: ownerId },
			);
			if (!unknown.ok) return { ok: false, reason: `could not record unknown task: ${unknown.error}` };
			if (run?.audit_degraded === true) {
				const stopped = await commit(
					"campaign.campaign.stopped",
					{ reason: "audit_degraded" },
					{ kind: "runtime", actor_id: ownerId },
				);
				return {
					ok: false,
					reason: `action audit failed; new dispatch stopped: ${run.detail ?? run.failure_mode}${stopped.ok ? "" : `; stop append failed: ${stopped.error}`}`,
				};
			}
			return { ok: true };
		}

		// 5. Oracle judgment (the worker's self-report is NOT a result).
		let judgment;
		try {
			judgment = await oracle.judge({ task, outcome_ref: run.outcome_ref, action_pin: run.action_pin ?? null });
		} catch (error) {
			judgment = { status: "unknown", failure_mode: "oracle_unavailable", error: String(error) };
		}
		const status = ["success", "failure", "unknown", "invalid"].includes(judgment?.status)
			? judgment.status
			: "unknown";

		// 5a. Stage-level judgments: the Host commits one `campaign.oracle.result`
		//     per required stage the Oracle judged, so completion requires every stage.
		const stageJudgments = Array.isArray(judgment?.stage_outcomes) ? judgment.stage_outcomes : [];
		for (const stageJudgment of stageJudgments) {
			const stageCommit = await commit(
				"campaign.oracle.result",
				{
					task_id: task.task_id,
					outcome_id: stageJudgment.outcome_id ?? `o-${task.task_id}-${stageJudgment.step_id}`,
					status: stageJudgment.status,
					step_id: stageJudgment.step_id,
					episode_id: stageJudgment.episode_id ?? episodeId,
					outcome: stageJudgment.outcome ?? stageJudgment,
				},
				{ kind: "oracle", actor_id: oracle.id ?? "oracle" },
			);
			if (!stageCommit.ok) return { ok: false, reason: `stage result commit failed: ${stageCommit.error}` };
		}

		const resultCommit = await commit(
			"campaign.oracle.result",
			{
				task_id: task.task_id,
				outcome_id: judgment?.outcome_id ?? `o-${task.task_id}`,
				status,
				episode_id: judgment?.episode_id ?? episodeId,
				task_oracle: judgment?.task_oracle === true,
				outcome: judgment?.outcome ?? buildJudgmentOutcome({ judgment, task, status, episodeId }),
			},
			{ kind: "oracle", actor_id: oracle.id ?? "oracle" },
		);
		if (!resultCommit.ok) {
			return { ok: false, reason: `oracle result commit failed; result is not durable: ${resultCommit.error}` };
		}

		// 6. Close the task ONLY on a matched, current success.
		if (status === "success" && judgment?.task_oracle === true && judgment?.delayed !== true) {
			const done = await commit(
				"campaign.task.completed",
				{ task_id: task.task_id, outcome_id: judgment?.outcome_id ?? null },
				{ kind: "runtime", actor_id: ownerId },
			);
			if (!done.ok) return { ok: false, reason: `completion commit failed; lifecycle not closed: ${done.error}` };
			// E1: ONLY after the planning Task durably completed through its own trusted
			// plan_ready Oracle may the admitted batch be released. The gate is a
			// separate durable state; admission alone never dispatches a child.
			const gate = await releasePlanGate(task.task_id, judgment?.outcome_id ?? null);
			if (gate.ok !== true) return { ok: false, reason: `plan-ready gate failed: ${gate.reason}` };
		} else if (judgment?.task_oracle === true && (status === "unknown" || judgment?.delayed === true)) {
			const unknown = await commit(
				"campaign.task.unknown",
				{
					task_id: task.task_id,
					reason: judgment?.delayed === true ? "delayed_verification" : "insufficient_evidence",
					outcome_id: judgment?.outcome_id ?? null,
				},
				{ kind: "runtime", actor_id: ownerId },
			);
			if (!unknown.ok) return { ok: false, reason: `unknown commit failed: ${unknown.error}` };
		}
		return { ok: true };
	}
}

/** Build a structurally complete Outcome payload for the projection/resolver. */
function buildJudgmentOutcome({ judgment, task, status, episodeId }) {
	return {
		outcome_id: judgment?.outcome_id ?? null,
		level: "episode",
		status,
		episode_id: judgment?.episode_id ?? episodeId,
		task_id: task.task_id,
		task_oracle: true,
		// The action pin of the effect that produced this outcome. It lets a later
		// Compiler proof pin the SAME action version and implementation digest.
		action_ref: judgment?.action_pin?.action_ref ?? null,
		action_version: judgment?.action_pin?.action_version ?? null,
		implementation_digest: judgment?.action_pin?.implementation_digest ?? null,
		when: Array.isArray(judgment?.when) ? judgment.when : [],
		criterion: judgment?.criterion ?? {
			criterion_id: task.goal?.goal_id ?? null,
			expected: task.goal?.goal_id ?? null,
		},
		observed: judgment?.observed ?? (status === "success" ? { synthetic: true } : null),
		scope: judgment?.scope ?? task.scope ?? null,
		oracle: judgment?.oracle ?? { oracle_id: "synthetic.oracle", source: "oracle" },
		provenance: judgment?.provenance ?? { source: "oracle", independent: true, task_id: task.task_id },
		evidence_refs: judgment?.evidence_refs ?? [],
	};
}
