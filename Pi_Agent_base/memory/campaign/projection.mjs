// Aegis Campaign C1 (INT-*) — pure event projection + budget ledger + indexes.
//
// Events are the AUTHORITATIVE source, reduced STRICTLY in verified append order.
// A per-Episode `event.sequence` is never used as a global index (INT-ORDER).
//
// This module owns:
//   * the queue state machine (frozen `queue.mjs` transitions);
//   * the budget ledger (reserved / consumed / released);
//   * the submitted-proposal index and dynamic Task definitions (INT-DYNAMIC);
//   * trusted Outcome resolution for `campaign.oracle.result` (INT-OUTCOME);
//   * the Campaign control state projected from committed events (INT-RECOVERY).
//
// It is pure and deterministic: the same committed stream always produces the
// same state. A checkpoint is a deletable derived cache.

import { digest } from "../fixture/contracts.mjs";
import { admitTaskProposal } from "./dynamic-policy.mjs";
import { planDigest, validatePlanGraph } from "./e1-plan-contract.mjs";
import { normalizeExecutableTask, loadPlanningAuthority } from "./e1-planning-contract.mjs";
import { campaignEventEnvelope, isCampaignEventKind, validateCampaignEvent } from "./event-contract.mjs";
import { resolveStageOutcome, resolveTaskFromOutcomes, resolveTaskOutcome } from "./outcome-resolver.mjs";
import { isLegalTransition, makeQueueItem } from "./queue.mjs";

const BUDGET_KEYS = Object.freeze(["wall_time_ms", "model_requests", "tool_calls"]);
const TERMINAL_STATES = Object.freeze(["completed", "failed", "unknown", "cancelled"]);

function zeroBudget() {
	return { wall_time_ms: 0, model_requests: 0, tool_calls: 0 };
}

function addBudget(target, delta) {
	for (const key of BUDGET_KEYS) target[key] += Number.isFinite(delta?.[key]) ? delta[key] : 0;
}

function subBudget(target, delta) {
	for (const key of BUDGET_KEYS)
		target[key] = Math.max(0, target[key] - (Number.isFinite(delta?.[key]) ? delta[key] : 0));
}

/**
 * Strict budget parsing: every dimension must be a finite, non-negative, SAFE
 * integer. Anything else (negative, decimal, NaN, Infinity, non-safe, wrong
 * type) is INVALID and is reported rather than normalized to 0. Returns
 * `{ok, value, reasons}`.
 */
export function parseBudgetStrict(value) {
	const reasons = [];
	const out = zeroBudget();
	if (value === null || value === undefined) return { ok: true, value: out, reasons };
	if (typeof value !== "object" || Array.isArray(value))
		return { ok: false, value: null, reasons: ["budget must be an object"] };
	for (const key of BUDGET_KEYS) {
		const raw = value[key];
		if (raw === undefined || raw === null) {
			out[key] = 0;
			continue;
		}
		if (!Number.isSafeInteger(raw) || raw < 0) {
			reasons.push(`budget.${key} must be a non-negative safe integer, got ${String(raw)}`);
			continue;
		}
		out[key] = raw;
	}
	return { ok: reasons.length === 0, value: out, reasons };
}

/** True when `delta` fits inside `held` on every dimension. */
function fitsWithin(delta, held) {
	return BUDGET_KEYS.every((key) => (delta[key] ?? 0) <= (held[key] ?? 0));
}

/**
 * Project the Campaign queue + ledger + indexes + control state from a committed
 * event sequence.
 *
 * @param {{[key: string]: any}} args
 * @returns {{[key: string]: any}}
 */
export function projectQueueFromEvents({
	campaign_id,
	tasks = [],
	events = [],
	revision = 0,
	manifest = null,
	budgetLimit = null,
	artifacts = {},
	priorState = null,
} = {}) {
	const reasons = [];
	const rejected = [];

	if (typeof campaign_id !== "string" || campaign_id.length === 0) {
		return { ok: false, reasons: ["campaign_id is required"], ...emptyProjection(campaign_id, revision) };
	}

	// 1. Static Manifest tasks seed the initial rows (or hydrate from a checkpoint).
	const byId = new Map();
	if (priorState?.queue) {
		// INT-CHECKPOINT: resume from a verified checkpoint snapshot. Only events
		// AFTER `priorState.tail_offset` are reduced on top of this state. The state
		// is deep-cloned so the caller's checkpoint object is never mutated.
		for (const row of priorState.queue) {
			const item = makeQueueItem({
				campaign_id,
				task_id: row.task_id,
				state: row.state,
				depends_on: row.depends_on ?? [],
				order: row.order ?? 1,
			});
			item.stage_ids = [...(row.stage_ids ?? [])];
			item.definition = row.definition ? structuredClone(row.definition) : null;
			item.parent_task_id = row.parent_task_id ?? null;
			item.is_dynamic = row.is_dynamic === true;
			// F15: copy the mutable recovery state so applying the tail never mutates
			// the caller's cached checkpoint objects.
			item.reservation = { ...(row.reservation ?? zeroBudget()) };
			item.budget_consumed = { ...(row.budget_consumed ?? zeroBudget()) };
			// F12: preserve the CURRENT episode and the bindings that participate in
			// judgment. Dropping episode_id would admit a foreign-episode result.
			item.episode_id = row.episode_id ?? null;
			item.session_id = row.session_id ?? null;
			item.attempt_id = row.attempt_id ?? null;
			item.task_outcome_status = row.task_outcome_status ?? null;
			item.task_outcome_ref = row.task_outcome_ref ?? null;
			item.task_outcomes = structuredClone(row.task_outcomes ?? []);
			item.stage_outcomes = structuredClone(row.stage_outcomes ?? []);
			item.stop_reason = row.stop_reason ?? null;
			item.reconciliation_state = row.reconciliation_state ?? "none";
			item.reconciliation_ref = row.reconciliation_ref ?? null;
			item.reconciliation_reason = row.reconciliation_reason ?? null;
			item.applied_command_ids = [...(row.applied_command_ids ?? [])];
			item.applied_command_keys = [...(row.applied_command_keys ?? [])];
			// E1: preserve the plan gate state across a checkpoint boundary.
			item.plan_id = row.plan_id ?? null;
			item.awaiting_plan_ready = row.awaiting_plan_ready === true;
			item.plan_ready = row.plan_ready === true;
			byId.set(item.task_id, item);
		}
	} else {
		for (const task of [...tasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
			const item = makeQueueItem({
				campaign_id,
				task_id: task.task_id,
				state: (task.depends_on ?? []).length === 0 ? "ready" : "queued",
				depends_on: task.depends_on ?? [],
				order: task.order ?? 1,
			});
			item.stage_ids = (task.stages ?? []).map((stage) => stage.stage_id);
			item.definition = task;
			item.parent_task_id = task.parent_task_id ?? null;
			item.applied_command_ids = [];
			item.is_dynamic = false;
			byId.set(task.task_id, item);
		}
	}

	// 2. Reduce STRICTLY in append order. NEVER re-sort by `event.sequence`.
	const budget = priorState?.budget ? structuredClone(priorState.budget) : emptyLedger();
	const limitParse = parseBudgetStrict(budgetLimit ?? manifest?.budget ?? null);
	const limit = limitParse.ok ? limitParse.value : zeroBudget();
	// F12: the dedup sets survive the checkpoint boundary. `applied_commands` and
	// `applied_outcomes` (priorState) seed them so a repeated command/outcome in
	// the tail is not applied twice. These are RETAINED in the projection output.
	const appliedCommands = new Set(priorState?.applied_commands ?? []);
	const appliedOutcomes = new Set(priorState?.applied_outcomes ?? []);
	// `acceptedOutcomes` is the AUTHORITY set: only outcomes the reducer actually
	// ACCEPTED (scope/criterion/evidence/identity/independent-source all valid).
	// `appliedOutcomes` remains the dedup guard (it also records rejected ids so a
	// repeated bad event is not retried).
	const acceptedOutcomes = new Set(priorState?.accepted_outcomes ?? []);
	if (priorState?.queue) {
		for (const row of priorState.queue) {
			for (const outcome of [...(row.task_outcomes ?? []), ...(row.stage_outcomes ?? [])]) {
				if (outcome?.outcome_id) {
					appliedOutcomes.add(outcome.outcome_id);
					acceptedOutcomes.add(outcome.outcome_id);
				}
			}
			for (const key of row.applied_command_keys ?? []) appliedCommands.add(key);
		}
	}
	const proposals = new Map(
		(priorState?.proposals ?? []).map((p) => [p.id, { digest: p.digest, offset: p.offset, proposal: p.proposal }]),
	);
	// E1: the plan index and the batch-admitted dynamic task definitions. A plan is
	// submitted (candidate), then admitted as ONE durable batch; its normalized task
	// definitions carry depends_on so the tree AND the DAG survive rebuild.
	const plans = new Map(
		(priorState?.plans ?? []).map((p) => [
			p.id,
			{
				digest: p.digest ?? null,
				offset: p.offset ?? -1,
				plan: p.plan ?? null,
				status: p.status ?? "submitted",
				reasons: p.reasons ?? [],
				normalized: p.normalized ?? null,
				planning_task_id: p.planning_task_id ?? null,
				campaign_id: p.campaign_id ?? null,
			},
		]),
	);
	const dynamicDefinitions = new Map(
		(priorState?.dynamic_definitions ?? []).map((entry) => [entry.task_id, entry.definition]),
	);
	const outcomeIndex = new Map((priorState?.outcomes ?? []).map((o) => [o.id, o.outcome])); // outcome_id -> canonical outcome
	const health = emptyHealth();
	let lastAppliedEventId = null;
	let lastAppliedOffset = priorState?.tail_offset ?? -1;

	if (!priorState?.queue) {
		for (const task of tasks) {
			const alloc = parseBudgetStrict(task.task_budget);
			const item = byId.get(task.task_id);
			if (item && alloc.ok) item.reservation = { ...alloc.value };
			if (alloc.ok) addBudget(budget.reserved, alloc.value);
		}
	}

	const control = priorState?.control ? { ...priorState.control } : { state: "running", reason: null, offset: -1 };
	const reduceFrom = priorState ? (priorState.tail_offset ?? -1) + 1 : 0;
	const context = {
		campaign_id,
		byId,
		budget,
		appliedOutcomes,
		acceptedOutcomes,
		proposals,
		plans,
		dynamicDefinitions,
		outcomeIndex,
		manifest,
		tasks,
		artifacts,
		rejected,
		control,
		revision,
	};

	for (let offset = reduceFrom; offset < events.length; offset += 1) {
		const raw = events[offset];
		// C3: the Campaign reuses the shared runtime EventLog, which also carries
		// unrelated rows (action.requested/completed, observation.captured, ...).
		// A row that is NOT a campaign event at all is IGNORED, never counted as a
		// rejected campaign event. Only a genuine `campaign.*` envelope that is
		// malformed/unauthorized is rejected. This keeps `events_rejected` an honest
		// count of campaign-contract violations in a mixed log.
		const isCampaignRow = raw?.event_type === "runtime.note" && isCampaignEventKind(raw?.payload?.kind);
		if (!isCampaignRow) continue;
		const validation = validateCampaignEvent(raw);
		if (!validation.ok) {
			rejected.push({ offset, event_id: raw?.event_id ?? null, reason: validation.reasons.join("; ") });
			health.events_rejected += 1;
			continue;
		}
		const envelope = campaignEventEnvelope(raw);
		if (envelope.campaign_id !== campaign_id) {
			reasons.push(`event ${raw.event_id} belongs to campaign ${envelope.campaign_id}, not ${campaign_id}`);
			continue;
		}
		// A revision-guarded command must match the current state revision.
		if (envelope.expected_revision !== null && envelope.expected_revision !== revision) {
			rejected.push({
				offset,
				event_id: raw.event_id,
				reason: `expected_revision ${envelope.expected_revision} != ${revision}`,
			});
			health.events_rejected += 1;
			continue;
		}
		const commandId = envelope.command_id;
		const dedupKey = commandId ? `${envelope.kind}:${commandId}` : null;
		if (dedupKey && appliedCommands.has(dedupKey)) {
			health.events_deduplicated += 1;
			continue;
		}

		const applied = applyEvent({ envelope, offset, ...context });
		if (!applied.ok) {
			rejected.push({ offset, event_id: raw.event_id, reason: applied.reason });
			health.events_rejected += 1;
			continue;
		}
		if (dedupKey) {
			appliedCommands.add(dedupKey);
			// F12: record the dedup key on the task row so a checkpoint restore can
			// seed deduplication from the queue alone (not only a process-level set).
			const target = envelope.task_id ? byId.get(envelope.task_id) : null;
			if (target) {
				if (!target.applied_command_keys) target.applied_command_keys = [];
				if (!target.applied_command_keys.includes(dedupKey)) target.applied_command_keys.push(dedupKey);
			}
		}
		promoteReadyTasks(byId);
		health.events_applied += 1;
		lastAppliedEventId = raw.event_id ?? null;
		lastAppliedOffset = offset;
	}

	// 3. Derive dependency status + ready promotion from the satisfied set.
	for (const item of byId.values()) {
		item.dependency_status = {};
		for (const dep of item.depends_on) {
			const depItem = byId.get(dep);
			item.dependency_status[dep] = depItem?.state === "completed" ? "satisfied" : "pending";
		}
	}
	promoteReadyTasks(byId);

	health.last_applied_event_id = lastAppliedEventId;
	health.last_applied_offset = lastAppliedOffset;
	health.reservation_outstanding = { ...budget.reserved };
	health.remaining = remainingBudget(limit, budget);
	health.budget_limit = limit;
	health.budget_limit_valid = limitParse.ok;
	if (!limitParse.ok) reasons.push(...limitParse.reasons);

	return {
		ok: reasons.length === 0,
		reasons,
		tasks: [...byId.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
		budget,
		proposals,
		plans: [...plans.entries()].map(([id, entry]) => ({ id, ...entry })),
		dynamic_definitions: [...dynamicDefinitions.entries()].map(([task_id, definition]) => ({ task_id, definition })),
		outcomes: outcomeIndex,
		accepted_outcomes: [...acceptedOutcomes],
		// The shared Campaign AUTHORITY (§8.1): the accepted/effective sets every
		// consumer (Board, RAM, observer, learning, status) reads so the SAME input
		// yields the SAME validity judgement.
		authority: {
			campaign_id,
			manifest_digest: manifest ? digest(manifest) : null,
			context_digest: manifest?.planning_contract?.digest ?? null,
			physical_tail: events.length - 1,
			accepted_outcomes: [...acceptedOutcomes],
			accepted_definitions: [...dynamicDefinitions.keys()],
			rejections: rejected.map((r) => ({ offset: r.offset, event_id: r.event_id, reason: r.reason })),
		},
		// F12: expose the dedup sets so the scheduler can persist them and a
		// restored projection can seed them.
		applied_commands: [...appliedCommands],
		applied_outcomes: [...appliedOutcomes],
		accepted_outcomes_set: [...acceptedOutcomes],
		control,
		health,
		rejected,
		task_count: byId.size,
		// Physical tail of the committed stream (last row, even if rejected).
		tail_offset: events.length - 1,
		tail_digest: events.length > 0 ? (events[events.length - 1]?.event_digest ?? "") : "",
		tail_event_id: events.length > 0 ? (events[events.length - 1]?.event_id ?? null) : null,
		// Diagnostic only.
		last_applied_offset: lastAppliedOffset,
		last_applied_event_id: lastAppliedEventId,
		revision,
	};
}

function emptyProjection(campaign_id, revision) {
	return {
		tasks: [],
		budget: emptyLedger(),
		proposals: new Map(),
		plans: [],
		dynamic_definitions: [],
		outcomes: new Map(),
		control: { state: "running", reason: null, offset: -1 },
		health: emptyHealth(),
		rejected: [],
		tail_offset: -1,
		tail_digest: "",
		tail_event_id: null,
		last_applied_offset: -1,
		last_applied_event_id: null,
		revision,
		campaign_id,
	};
}

function emptyLedger() {
	return { reserved: zeroBudget(), consumed: zeroBudget(), released: zeroBudget() };
}

function emptyHealth() {
	return {
		events_applied: 0,
		events_rejected: 0,
		events_deduplicated: 0,
		last_applied_event_id: null,
		last_applied_offset: -1,
	};
}

/** remaining = limit - reserved_outstanding - consumed, clamped at zero. */
export function remainingBudget(limit, ledger) {
	const out = zeroBudget();
	for (const key of BUDGET_KEYS) {
		out[key] = Math.max(0, (limit?.[key] ?? 0) - (ledger.reserved?.[key] ?? 0) - (ledger.consumed?.[key] ?? 0));
	}
	return out;
}

/**
 * A dispatch of `task` is permitted ONLY when the task's OWN persisted
 * reservation covers `need` on every dimension. The Campaign's unused remaining
 * budget is NOT borrowed (INT-BUDGET): reallocation must be committed as an
 * explicit reservation first.
 */
export function canDispatch({ task, need }) {
	const held = parseBudgetStrict(task?.reservation);
	if (!held.ok) return { ok: false, reason: `task reservation is invalid: ${held.reasons.join("; ")}` };
	const want = parseBudgetStrict(need);
	if (!want.ok) return { ok: false, reason: `dispatch cost is invalid: ${want.reasons.join("; ")}` };
	if (!fitsWithin(want.value, held.value)) {
		return {
			ok: false,
			reason: `dispatch needs ${JSON.stringify(want.value)} but the task holds ${JSON.stringify(held.value)}`,
		};
	}
	return { ok: true };
}

function transition(item, to, reasonPrefix = "illegal transition") {
	if (!isLegalTransition(item.state, to)) return { ok: false, reason: `${reasonPrefix}: ${item.state} -> ${to}` };
	item.state = to;
	return { ok: true };
}

/** Apply ONE validated, deduplicated event at physical `offset`. */
function applyEvent({
	envelope,
	offset,
	campaign_id,
	byId,
	budget,
	appliedOutcomes,
	acceptedOutcomes,
	proposals,
	plans,
	dynamicDefinitions,
	outcomeIndex,
	manifest,
	tasks,
	artifacts,
	control,
}) {
	switch (envelope.kind) {
		case "campaign.task.started": {
			if (!envelope.task_id) return { ok: false, reason: "task_id is required" };
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown task ${envelope.task_id}` };
			if ([...byId.values()].some((t) => t.state === "running" && t.task_id !== envelope.task_id)) {
				return { ok: false, reason: "another task is already running (single active Task)" };
			}
			if (TERMINAL_STATES.includes(item.state)) {
				return { ok: false, reason: `terminal task ${item.task_id} (${item.state}) cannot be restarted` };
			}
			if (item.state === "queued") {
				const allSatisfied = item.depends_on.every((dep) => byId.get(dep)?.state === "completed");
				if (!allSatisfied) return { ok: false, reason: "dependencies are not satisfied" };
			} else if (item.state !== "ready") {
				return { ok: false, reason: `task ${item.task_id} cannot start from ${item.state}` };
			}
			const moved = transition(item, "running");
			if (!moved.ok) return moved;
			item.episode_id = envelope.episode_id ?? item.episode_id;
			item.applied_command_ids.push(envelope.command_id);
			return { ok: true };
		}
		case "campaign.oracle.result": {
			if (!envelope.task_id) return { ok: false, reason: "task_id is required" };
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown task ${envelope.task_id}` };
			if (!envelope.outcome_id) return { ok: false, reason: "outcome_id is required" };
			if (appliedOutcomes.has(envelope.outcome_id)) return { ok: true }; // idempotent
			const definition = item.definition ?? null;
			if (!definition) return { ok: false, reason: `task ${envelope.task_id} has no definition to bind an Outcome` };
			const stepId = envelope.step_id ?? envelope.outcome?.step_id ?? null;
			const isTaskOracle = envelope.task_oracle === true;

			// F2 (provenance binding) is enforced inside the resolver, which receives
			// the committed event source; nothing to compute here.

			if (isTaskOracle) {
				const resolved = resolveTaskOutcome({
					result: envelope.outcome,
					task: definition,
					episodeId: item.episode_id ?? envelope.episode_id ?? null,
					scope: currentTaskScope(definition),
					artifacts,
					eventSource: envelope.source_kind,
				});
				appliedOutcomes.add(envelope.outcome_id);
				outcomeIndex.set(
					envelope.outcome_id,
					resolved.outcome ?? { outcome_id: envelope.outcome_id, status: "invalid" },
				);
				if (!resolved.ok) return { ok: false, reason: `oracle outcome rejected: ${resolved.reasons.join("; ")}` };
				acceptedOutcomes.add(envelope.outcome_id);
				if (!item.task_outcomes) item.task_outcomes = [];
				item.task_outcomes.push({ outcome_id: envelope.outcome_id, status: resolved.status, task_oracle: true });
				item.task_outcome_status = resolved.status;
				item.task_outcome_ref = envelope.outcome_id;
				if (resolved.status === "unknown")
					applyTerminalEvidence(
						item,
						"unknown",
						envelope.reason === "delayed_verification" ? "delayed_verification" : "insufficient_evidence",
					);
				else if (resolved.status === "failure") applyTerminalEvidence(item, "failed", "oracle_failure");
				else if (resolved.status === "invalid") applyTerminalEvidence(item, "failed", "invalid_outcome");
				else if (resolved.status === "success" && item.state === "unknown") {
					const reopened = transition(item, "waiting_oracle", "illegal unknown re-open");
					if (!reopened.ok) return reopened;
					item.stop_reason = null;
				}
				return { ok: true };
			}

			// A STAGE-level Outcome: run the FULL trusted stage binding (F11) — task,
			// episode, declared criterion, independent provenance, current scope, and
			// non-empty resolvable evidence — before it may enter the projection.
			const stage = (definition.stages ?? []).find((s) => s.stage_id === stepId);
			if (!stage) return { ok: false, reason: `stage outcome references unknown stage ${String(stepId)}` };
			const outcome = envelope.outcome ?? {};
			const stageVerdict = resolveStageOutcome({
				result: outcome,
				task: definition,
				stage,
				episodeId: item.episode_id ?? null,
				scope: currentTaskScope(definition),
				artifacts,
				eventSource: envelope.source_kind,
			});
			if (!stageVerdict.ok) return { ok: false, reason: `stage outcome rejected: ${stageVerdict.reasons.join("; ")}` };
			appliedOutcomes.add(envelope.outcome_id);
			acceptedOutcomes.add(envelope.outcome_id);
			// F8: store the COMPLETE canonical Stage Outcome so the snapshot, the
			// projection digest, the checkpoint and prefix+tail/full replay all see it.
			const canonical = canonicalStageOutcome(outcome, {
				outcome_id: envelope.outcome_id,
				step_id: stepId,
				task_id: item.task_id,
			});
			if (!item.stage_outcomes) item.stage_outcomes = [];
			item.stage_outcomes.push(canonical);
			outcomeIndex.set(envelope.outcome_id, canonical);
			return { ok: true };
		}
		case "campaign.task.completed": {
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown task ${envelope.task_id}` };
			return completeTaskIfVerified({
				item,
				outcomeId: envelope.outcome_id ?? null,
				artifacts,
				reasonPrefix: "completion",
			});
		}
		case "campaign.task.failed": {
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown task ${envelope.task_id}` };
			if (TERMINAL_STATES.includes(item.state)) {
				return { ok: false, reason: `terminal task ${item.task_id} (${item.state}) cannot be renamed failed` };
			}
			const moved = transition(item, "failed", "illegal failure");
			if (!moved.ok) return moved;
			item.stop_reason = "scheduler_failure";
			return { ok: true };
		}
		case "campaign.task.unknown": {
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown task ${envelope.task_id}` };
			// Preserve a DELAYED verification marker so the scheduler can revisit it
			// with a fresh judgment (without re-running the worker).
			applyTerminalEvidence(
				item,
				"unknown",
				envelope.reason === "delayed_verification" ? "delayed_verification" : "insufficient_evidence",
			);
			return { ok: true };
		}
		case "campaign.task.paused": {
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown task ${envelope.task_id}` };
			const moved = transition(item, "paused", "illegal pause");
			if (!moved.ok) return moved;
			return { ok: true };
		}
		case "campaign.task.resumed": {
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown task ${envelope.task_id}` };
			if (item.state !== "paused") return { ok: false, reason: `only a paused task can resume, not ${item.state}` };
			const allSatisfied = item.depends_on.every((dep) => byId.get(dep)?.state === "completed");
			const moved = transition(item, allSatisfied ? "ready" : "queued", "illegal resume");
			if (!moved.ok) return moved;
			return { ok: true };
		}
		case "campaign.task.cancelled": {
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown task ${envelope.task_id}` };
			const moved = transition(item, "cancelled", "illegal cancel");
			if (!moved.ok) return moved;
			item.stop_reason = "cancelled";
			releasedReservationFor(item, budget, item.reservation ?? zeroBudget());
			return { ok: true };
		}
		case "campaign.proposal.submitted": {
			// INT-DYNAMIC: build the resolvable proposal index.
			const proposalId = envelope.proposal_id;
			if (!proposalId) return { ok: false, reason: "proposal_id is required for a submitted proposal" };
			if (!envelope.proposal || typeof envelope.proposal !== "object") {
				return { ok: false, reason: "submitted proposal has no resolvable proposal object" };
			}
			const existing = proposals.get(proposalId);
			if (existing) {
				if (existing.digest !== envelope.proposal_digest) {
					return { ok: false, reason: `proposal_id ${proposalId} already submitted with a different digest` };
				}
				return { ok: true }; // idempotent
			}
			proposals.set(proposalId, { digest: envelope.proposal_digest, offset, proposal: envelope.proposal });
			return { ok: true };
		}
		case "campaign.proposal.admitted":
			return applyAdmitted({ envelope, offset, byId, budget, proposals, manifest, tasks, campaign_id });
		case "campaign.plan.submitted":
			return applyPlanSubmitted({ envelope, offset, plans });
		case "campaign.plan.admitted":
			return applyPlanAdmitted({ envelope, byId, budget, plans, manifest, tasks, campaign_id, dynamicDefinitions });
		case "campaign.plan.blocked":
		case "campaign.plan.rejected": {
			// Record the rejection/block on the SUBMITTED candidate so the plan index
			// reflects that this candidate was refused (a candidate is inspectable but
			// never admitted). A missing prior submitted candidate is itself a reason.
			const pid = envelope.plan_id ?? null;
			if (!pid) return { ok: false, reason: `${envelope.kind} requires a plan_id` };
			const priorPlan = plans.get(pid);
			if (!priorPlan) return { ok: false, reason: `${envelope.kind} references unknown plan ${pid}` };
			if (priorPlan.status === "admitted")
				return { ok: false, reason: `plan ${pid} is already admitted and cannot be re-marked ${envelope.kind}` };
			priorPlan.status = envelope.kind === "campaign.plan.rejected" ? "rejected" : "blocked";
			priorPlan.reasons = [...(envelope.reasons ?? [])];
			return { ok: true };
		}
		case "campaign.plan.ready": {
			// E1: the plan-ready gate is an ACTIVATION gate, not a second admission.
			// It is only legal when the planning Task has ALREADY completed through its
			// own trusted plan_ready Oracle AND the named plan batch is durably admitted
			// with a matching identity. Missing evidence, a mismatched identity, an
			// unknown/failure Outcome or a missing completion all keep the children
			// HELD (the record is rejected with a diagnostic), so a truncated durable
			// prefix can never release a child Task.
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown planning task ${envelope.task_id}` };
			if (item.state !== "completed")
				return {
					ok: false,
					reason: `plan-ready gate requires the planning task ${envelope.task_id} to be completed, not ${item.state}`,
				};
			if (item.task_outcome_status !== "success")
				return { ok: false, reason: `planning task ${envelope.task_id} has no trusted success Outcome` };
			if (envelope.outcome_id && item.task_outcome_ref && envelope.outcome_id !== item.task_outcome_ref)
				return {
					ok: false,
					reason: `plan-ready outcome ${envelope.outcome_id} does not match the current planning result ${item.task_outcome_ref}`,
				};
			const planId = envelope.plan_id ?? null;
			if (!planId) return { ok: false, reason: "plan-ready gate requires a plan_id (a null id releases nothing)" };
			const plan = plans.get(planId);
			if (!plan || plan.status !== "admitted") return { ok: false, reason: `plan ${planId} is not durably admitted` };
			if (plan.planning_task_id && plan.planning_task_id !== envelope.task_id)
				return {
					ok: false,
					reason: `plan ${planId} belongs to planning task ${plan.planning_task_id}, not ${envelope.task_id}`,
				};
			item.plan_ready = true;
			item.plan_id = planId;
			// Release ONLY the children of THIS admitted batch; a null/foreign plan id
			// never releases an unrelated Task.
			for (const child of byId.values()) {
				if (child.awaiting_plan_ready === true && child.plan_id === planId) child.awaiting_plan_ready = false;
			}
			promoteReadyTasks(byId);
			return { ok: true };
		}
		case "campaign.proposal.blocked":
		case "campaign.proposal.rejected":
			return { ok: true };
		case "campaign.budget.reserved": {
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown task ${envelope.task_id}` };
			const delta = parseBudgetStrict(envelope.reservation);
			if (!delta.ok) return { ok: false, reason: delta.reasons.join("; ") };
			item.reservation = parseBudgetStrict(item.reservation).value ?? zeroBudget();
			for (const key of BUDGET_KEYS) item.reservation[key] += delta.value[key];
			addBudget(budget.reserved, delta.value);
			return { ok: true };
		}
		case "campaign.budget.consumed": {
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown task ${envelope.task_id}` };
			const requested = parseBudgetStrict(envelope.consumed);
			if (!requested.ok) return { ok: false, reason: requested.reasons.join("; ") };
			const held = parseBudgetStrict(item.reservation).value ?? zeroBudget();
			if (!fitsWithin(requested.value, held)) {
				return {
					ok: false,
					reason: `consumed ${JSON.stringify(requested.value)} exceeds the outstanding reservation ${JSON.stringify(held)}`,
				};
			}
			addBudget(budget.consumed, requested.value);
			subBudget(budget.reserved, requested.value);
			subBudget(item.reservation, requested.value);
			item.budget_consumed = parseBudgetStrict(item.budget_consumed).value ?? zeroBudget();
			addBudget(item.budget_consumed, requested.value);
			return { ok: true };
		}
		case "campaign.budget.released": {
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown task ${envelope.task_id}` };
			const requested = parseBudgetStrict(envelope.released);
			if (!requested.ok) return { ok: false, reason: requested.reasons.join("; ") };
			const held = parseBudgetStrict(item.reservation).value ?? zeroBudget();
			const actual = zeroBudget();
			for (const key of BUDGET_KEYS) actual[key] = Math.min(requested.value[key], held[key]);
			releasedReservationFor(item, budget, actual);
			addBudget(budget.released, actual);
			return { ok: true };
		}
		case "campaign.reconciliation.requested":
		case "campaign.reconciliation.resolved": {
			const item = byId.get(envelope.task_id);
			if (!item) return { ok: false, reason: `unknown task ${envelope.task_id}` };
			item.reconciliation_state = envelope.kind.endsWith("requested") ? "pending" : "resolved";
			if (envelope.kind.endsWith("resolved")) {
				item.reconciliation_ref = envelope.outcome_id ?? null;
				// F7: reconciliation must NOT bypass the normal completion gate. A
				// resolution completes a STRANDED task only through the SAME check as
				// `campaign.task.completed` (current task-Oracle success + all required
				// stages/criteria/evidence). Reason codes are preserved for audit; the
				// worker is never re-run and the item stays in its evidence state when
				// the gate is not satisfied.
				const completed = completeTaskIfVerified({
					item,
					outcomeId: envelope.outcome_id ?? null,
					artifacts,
					reasonPrefix: "reconciliation",
					soft: true,
				});
				if (!completed.ok) {
					item.reconciliation_state = "pending";
					item.reconciliation_reason = completed.reason;
					return { ok: true };
				}
			}
			return { ok: true };
		}
		case "campaign.handoff.requested":
		case "campaign.handoff.completed":
			return { ok: true };
		case "campaign.campaign.paused": {
			control.state = "paused";
			control.reason = envelope.reason ?? "paused";
			control.offset = offset;
			return { ok: true };
		}
		case "campaign.campaign.resumed": {
			control.state = "running";
			control.reason = null;
			control.offset = offset;
			return { ok: true };
		}
		case "campaign.campaign.cancelled": {
			control.state = "cancelled";
			control.reason = envelope.reason ?? "cancelled";
			control.offset = offset;
			return { ok: true };
		}
		case "campaign.campaign.stopped": {
			control.state = envelope.reason === "budget_exhausted" ? "budget_stopped" : "stopped";
			control.reason = envelope.reason ?? "stopped";
			control.offset = offset;
			return { ok: true };
		}
		default:
			return { ok: false, reason: `unhandled campaign kind ${envelope.kind}` };
	}
}

/**
 * F3 + F7: the single completion gate used by BOTH `campaign.task.completed` and
 * `campaign.reconciliation.resolved`. It requires a current, matched task-Oracle
 * success AND every required Stage to resolve through the C0 aggregation
 * (`resolveTaskFromOutcomes`). When `soft` is true (reconciliation) a failed gate
 * is a non-fatal "not yet complete" rather than a rejection.
 */
function completeTaskIfVerified({ item, outcomeId, artifacts, reasonPrefix, soft = false }) {
	if (TERMINAL_STATES.includes(item.state)) {
		return {
			ok: false,
			reason: `${reasonPrefix}: terminal task ${item.task_id} (${item.state}) cannot be renamed completed`,
		};
	}
	if (item.task_outcome_status !== "success") {
		return { ok: false, reason: `${reasonPrefix}: no current trusted task Oracle success` };
	}
	if (outcomeId && item.task_outcome_ref && outcomeId !== item.task_outcome_ref) {
		return {
			ok: false,
			reason: `${reasonPrefix}: references ${outcomeId}, not the current result ${item.task_outcome_ref}`,
		};
	}
	const aggregate = resolveTaskFromOutcomes({
		task: item.definition,
		stageResults: item.stage_outcomes ?? [],
		taskResult: null,
		episodeId: item.episode_id ?? null,
		scope: currentTaskScope(item.definition),
		artifacts,
		eventSource: null,
	});
	const requiredStages = (item.definition?.stages ?? []).filter((s) => s.required !== false);
	for (const stage of requiredStages) {
		const agg = aggregate.stage_aggregates?.find((a) => a.stage_id === stage.stage_id);
		if (!agg || agg.status !== "success") {
			return {
				ok: false,
				reason: `${reasonPrefix}: required stage ${stage.stage_id} is not verified (${agg?.status ?? "missing"})`,
				soft,
			};
		}
	}
	const moved = transition(item, "completed", `illegal ${reasonPrefix}`);
	if (!moved.ok) return { ok: false, reason: moved.reason, soft };
	item.task_outcome_ref = outcomeId ?? item.task_outcome_ref ?? null;
	item.stage_aggregate = aggregate.stage_aggregates ?? [];
	return { ok: true };
}

function applyTerminalEvidence(item, to, stopReason) {
	if (TERMINAL_STATES.includes(item.state) && item.state !== "unknown") {
		return { ok: false, reason: `terminal task ${item.task_id} (${item.state}) cannot become ${to}` };
	}
	if (item.state === "unknown" && to === "unknown") {
		// Re-affirming unknown: keep the newest reason (e.g. delayed_verification).
		item.stop_reason = stopReason;
		return { ok: true };
	}
	const moved = transition(item, to, "illegal terminal transition");
	if (!moved.ok) return moved;
	item.stop_reason = stopReason;
	return { ok: true };
}

function promoteReadyTasks(byId) {
	const anyRunning = [...byId.values()].some((t) => t.state === "running");
	for (const item of byId.values()) {
		if (item.state !== "queued") continue;
		// E1: a batch-admitted child task waits for the SEPARATE plan-ready gate in
		// addition to its dependencies. Durable definitions alone never dispatch.
		if (item.awaiting_plan_ready === true) continue;
		const allSatisfied = item.depends_on.every((dep) => byId.get(dep)?.state === "completed");
		if (allSatisfied && !anyRunning) item.state = "ready";
	}
}

/**
 * E1: record a SUBMITTED candidate plan. It is a candidate only: recording it
 * never admits or dispatches anything.
 */
function applyPlanSubmitted({ envelope, offset, plans }) {
	const planId = envelope.plan_id;
	if (!planId) return { ok: false, reason: "plan_id is required for a submitted plan" };
	// Every applicable plan envelope must carry the planning Task identity. A
	// missing value is NEVER defaulted to a literal task id.
	if (typeof envelope.planning_task_id !== "string" || envelope.planning_task_id.length === 0)
		return { ok: false, reason: `plan ${planId} submitted without a planning_task_id` };
	if (!envelope.plan || typeof envelope.plan !== "object") {
		return { ok: false, reason: "submitted plan has no resolvable plan object" };
	}
	// The candidate's OWN plan_id must equal the envelope identity. A foreign inner
	// id (even with a re-hashed digest) is refused whole-batch.
	if (envelope.plan.plan_id !== planId)
		return {
			ok: false,
			reason: `plan ${planId} envelope id does not match candidate plan_id ${String(envelope.plan.plan_id)}`,
		};
	// FAIL CLOSED: a declared digest is required and must match the canonical
	// digest of the candidate plan. This stops an untrusted/foreign digest from
	// ever entering the identity index.
	const declared = envelope.plan_digest;
	if (typeof declared !== "string" || declared.length === 0) {
		return { ok: false, reason: `plan ${planId} submitted without a declared plan_digest` };
	}
	const recomputed = planDigest(envelope.plan);
	if (recomputed !== declared) {
		return {
			ok: false,
			reason: `plan ${planId} declared digest ${declared} does not match planDigest(plan) ${recomputed}`,
		};
	}
	const existing = plans.get(planId);
	if (existing) {
		// A repeated identical candidate is idempotent. A conflicting digest is
		// refused and never overwrites the first legitimate record.
		if (existing.digest !== declared) {
			return { ok: false, reason: `plan_id ${planId} already submitted with a different digest` };
		}
		return { ok: true };
	}
	plans.set(planId, {
		digest: declared,
		offset,
		plan: envelope.plan,
		status: "submitted",
		reasons: [],
		normalized: null,
		planning_task_id: envelope.planning_task_id ?? null,
		campaign_id: envelope.campaign_id ?? null,
	});
	return { ok: true };
}

/**
 * E1: apply ONE durable plan-admission batch. The batch record carries the FULL
 * normalized task definitions (with depends_on) and the whole-graph admission
 * result. The reducer REFUSES to expose a legal prefix: if any definition is
 * already known with a DIFFERENT digest, or a stage id collides, the WHOLE batch
 * is refused and nothing is created.
 *
 * The admission and the planning completion gate are two distinct states:
 *   * this record establishes `campaign.plan.admitted` (definitions durable);
 *   * `campaign.plan.ready` (written after the planning Oracle) is the separate
 *     gate that lets the child tasks become dispatchable.
 * Child tasks therefore enter `queued` (never `ready`) even though their
 * definitions are already durable.
 */
/**
 * Recompile a submitted candidate under the manifest's FROZEN planning contract
 * and return the trusted normalized definitions. Used on REPLAY so a durable
 * admitted batch is compared field-by-field against trusted recompilation (not
 * a self-reported digest). Pure: it reads only the manifest + prior candidate.
 *
 * @param {{manifest: any, prior: any, planningTaskId: string}} args
 */
function recompilePlanDefinitions({ manifest, prior, planningTaskId }) {
	const authority = loadPlanningAuthority({ manifest });
	if (!authority.ok)
		return { ok: false, reason: `plan recompile requires a trusted contract: ${authority.reasons.join("; ")}` };
	const existingTaskIds = new Set((manifest.tasks ?? []).map((task) => task.task_id));
	const derived = { wall_time_ms: 0, model_requests: 0, tool_calls: 0 };
	const requiredCriteria = [...(manifest.objective?.required_criteria ?? manifest.objective?.success_criteria ?? [])];
	const result = validatePlanGraph({
		plan: prior.plan,
		manifest,
		planningTaskId: planningTaskId ?? authority.contract.planning_task_id,
		existingTaskIds,
		templates: authority.templates,
		requiredCriteria,
		expectedRootGoalRef: authority.contract.root_goal_ref,
		derivedBudget: derived,
	});
	if (result.status !== "admitted")
		return { ok: false, reason: `plan recompile ${result.status}: ${result.reasons.join("; ")}` };
	return { ok: true, normalized: result.normalized };
}

function applyPlanAdmitted({ envelope, byId, budget, plans, manifest, tasks, campaign_id, dynamicDefinitions }) {
	const planId = envelope.plan_id;
	if (!planId) return { ok: false, reason: "plan_id is required for an admitted plan" };
	if (!manifest) return { ok: false, reason: "no validated Manifest available to confirm plan admission" };
	const definitions = envelope.plan_tasks;
	if (!Array.isArray(definitions) || definitions.length === 0) {
		return { ok: false, reason: "admitted plan batch carries no task definitions" };
	}
	const declared = envelope.plan_digest;
	if (typeof declared !== "string" || declared.length === 0) {
		return { ok: false, reason: `plan ${planId} admitted without a declared plan_digest` };
	}
	// Every applicable plan envelope must carry the planning Task identity.
	if (typeof envelope.planning_task_id !== "string" || envelope.planning_task_id.length === 0)
		return { ok: false, reason: `plan ${planId} admitted without a planning_task_id` };
	// The admitted envelope identity must equal the candidate's own plan_id.
	const prior = plans.get(planId);
	// ONE EFFECTIVE PLAN (E1 §6.2): once a plan batch is durably admitted, a
	// DIFFERENT plan id (or a different content for the same id) is REFUSED as a
	// whole batch. It never overwrites the active plan, its budget or its
	// definitions. A completely identical re-admission of the SAME id/digest is an
	// idempotent no-op.
	const alreadyAdmitted = [...plans.entries()].find(([id, entry]) => entry.status === "admitted" && id !== planId);
	if (alreadyAdmitted) {
		return {
			ok: false,
			reason: `plan_already_admitted: plan ${alreadyAdmitted[0]} is already the active admitted plan; ${planId} cannot replace it`,
		};
	}
	// Idempotent by plan id: a repeated IDENTICAL batch with the same digest is a
	// no-op. A conflicting digest is refused and never overwrites the first record.
	if (prior?.status === "admitted") {
		if (prior.digest !== declared) {
			return { ok: false, reason: `plan_id ${planId} already admitted with a different digest` };
		}
		return { ok: true };
	}
	// FAIL CLOSED: an admission must reference a prior SAME-CAMPAIGN submitted
	// candidate whose declared digest matches BOTH the admitted digest AND the
	// independently recomputed planDigest(candidate.plan). No prior candidate, a
	// conflicting digest, a missing plan, or a planning identity mismatch rejects
	// the whole batch BEFORE any queue/budget/definition mutation.
	if (!prior) {
		return { ok: false, reason: `plan ${planId} was admitted without a prior submitted candidate` };
	}
	if (prior.status !== "submitted") {
		return { ok: false, reason: `plan ${planId} is in state ${prior.status}, not submitted` };
	}
	if (!prior.plan || typeof prior.plan !== "object") {
		return { ok: false, reason: `plan ${planId} candidate has no resolvable plan` };
	}
	if (prior.digest !== declared) {
		return {
			ok: false,
			reason: `plan ${planId} admitted digest ${declared} does not match the submitted digest ${prior.digest}`,
		};
	}
	// Root-goal binding is re-checked on REPLAY from the durable contract: a
	// candidate whose root_goal_ref does not match the frozen root never admits.
	const authority = loadPlanningAuthority({ manifest });
	const frozenRoot = authority.ok ? authority.contract.root_goal_ref : null;
	if (frozenRoot && prior.plan.root_goal_ref !== frozenRoot) {
		return {
			ok: false,
			reason: `plan ${planId} root_goal_ref ${JSON.stringify(prior.plan.root_goal_ref)} does not match the frozen root goal ${JSON.stringify(frozenRoot)}`,
		};
	}
	const recomputed = planDigest(prior.plan);
	if (recomputed !== declared) {
		return {
			ok: false,
			reason: `plan ${planId} admitted digest ${declared} does not match planDigest(submitted.plan) ${recomputed}`,
		};
	}
	const submittedPlanningTask = prior.planning_task_id ?? null;
	if (envelope.planning_task_id && submittedPlanningTask && envelope.planning_task_id !== submittedPlanningTask) {
		return {
			ok: false,
			reason: `plan ${planId} admitted planning task ${envelope.planning_task_id} does not match the submitted planning task ${submittedPlanningTask}`,
		};
	}
	if (prior.campaign_id && envelope.campaign_id && prior.campaign_id !== envelope.campaign_id) {
		return {
			ok: false,
			reason: `plan ${planId} admitted campaign ${envelope.campaign_id} does not match the submitted campaign ${prior.campaign_id}`,
		};
	}
	// TRUSTED RECOMPILE (E1 §5.2 item 6): the durable batch's normalized
	// definitions must equal what the Host would compile from the submitted
	// candidate under the manifest's frozen planning contract. This re-checks
	// target/criterion/scope/oracle/dependency/parent/budget/task-id/order and the
	// per-task task_digest, so a re-hashed self-reported definition cannot pass.
	// It applies to a NEW E1 run (a manifest carrying the frozen contract). A
	// legacy/direct dynamic path without a contract keeps its prior (still
	// whole-batch, still submitted-bound) behavior.
	if (manifest.planning_contract) {
		const recompile = recompilePlanDefinitions({ manifest, prior, planningTaskId: submittedPlanningTask });
		if (!recompile.ok) return { ok: false, reason: recompile.reason };
		if (definitions.length !== recompile.normalized.length)
			return {
				ok: false,
				reason: `plan ${planId} admitted ${definitions.length} definitions, recompiled ${recompile.normalized.length}`,
			};
		const byIdRecompiled = new Map(recompile.normalized.map((definition) => [definition.task_id, definition]));
		for (const definition of definitions) {
			const expected = byIdRecompiled.get(definition.task_id);
			if (!expected) return { ok: false, reason: `plan ${planId} admitted unknown task ${definition.task_id}` };
			const actual = { ...definition };
			delete actual.task_digest;
			const wanted = { ...expected };
			delete wanted.task_digest;
			if (digest(actual) !== digest(wanted))
				return {
					ok: false,
					reason: `plan task ${definition.task_id} admitted definition does not match the trusted recompile`,
				};
		}
	}
	// Validate ALL definitions BEFORE any mutation (whole-graph, no legal prefix).
	const batchIds = new Set();
	const knownStageIds = new Set();
	for (const existing of byId.values())
		for (const sid of existing.definition?.stages ?? []) knownStageIds.add(sid.stage_id);
	for (const task of tasks) for (const stage of task.stages ?? []) knownStageIds.add(stage.stage_id);
	for (const definition of definitions) {
		const validation = validateDynamicDefinition(definition);
		if (!validation.ok) return { ok: false, reason: `plan task definition invalid: ${validation.reasons.join("; ")}` };
		if (batchIds.has(definition.task_id))
			return { ok: false, reason: `duplicate task id ${definition.task_id} in plan batch` };
		batchIds.add(definition.task_id);
		if (
			byId.has(definition.task_id) &&
			byId.get(definition.task_id).definition?.task_digest !== definition.task_digest
		) {
			return { ok: false, reason: `task ${definition.task_id} already exists with a different definition` };
		}
		for (const stage of definition.stages ?? []) {
			if (knownStageIds.has(stage.stage_id))
				return { ok: false, reason: `stage id ${stage.stage_id} is not unique across the Campaign` };
			knownStageIds.add(stage.stage_id);
		}
	}
	// Apply the WHOLE batch. Child tasks start `queued` (execution waits for the
	// plan-ready gate + satisfied dependencies); the planning task is not redefined.
	for (const definition of definitions) {
		if (byId.has(definition.task_id)) continue; // idempotent by task id
		const depends = Array.isArray(definition.depends_on) ? definition.depends_on : [];
		const item = makeQueueItem({
			campaign_id,
			task_id: definition.task_id,
			state: depends.length === 0 ? "queued" : "queued",
			depends_on: depends,
			order: definition.order ?? byId.size + 1,
		});
		item.parent_task_id = definition.parent_task_id ?? null;
		item.stage_ids = (definition.stages ?? []).map((stage) => stage.stage_id);
		item.applied_command_ids = [];
		item.is_dynamic = true;
		item.awaiting_plan_ready = true;
		item.plan_id = planId;
		item.definition = definition;
		const reservation = parseBudgetStrict(definition.budget_reservation);
		item.reservation = reservation.ok ? reservation.value : zeroBudget();
		byId.set(definition.task_id, item);
		dynamicDefinitions.set(definition.task_id, definition);
		addBudget(budget.reserved, item.reservation);
	}
	plans.set(planId, {
		...prior,
		digest: declared,
		status: "admitted",
		reasons: [],
		normalized: definitions.map((definition) => definition.task_id),
		planning_task_id: envelope.planning_task_id ?? prior?.planning_task_id ?? null,
	});
	return { ok: true };
}

/**
 * INT-DYNAMIC: `campaign.proposal.admitted` MUST reference a previously
 * submitted proposal (same campaign) whose digest matches, and re-validate the
 * admission against the live policy. The durable admitted record carries the
 * FULL task definition so the scheduler can recover it without an external array.
 */
function applyAdmitted({ envelope, offset, byId, budget, proposals, manifest, tasks, campaign_id }) {
	const taskId = envelope.task_id;
	if (!taskId) return { ok: false, reason: "task_id is required for an admitted proposal" };
	if (byId.has(taskId)) return { ok: true }; // idempotent by task id
	const proposalId = envelope.proposal_id;
	if (!proposalId) return { ok: false, reason: "admitted event must reference a submitted proposal_id" };
	const submitted = proposals.get(proposalId);
	if (!submitted) return { ok: false, reason: `no submitted proposal ${proposalId} in this stream` };
	if (envelope.proposal_digest && submitted.digest && envelope.proposal_digest !== submitted.digest) {
		return { ok: false, reason: `admitted proposal digest does not match the submitted proposal ${proposalId}` };
	}
	const proposal = submitted.proposal;
	if (!manifest) return { ok: false, reason: "no validated Manifest available to confirm admission" };
	const admission = envelope.admission;
	if (!admission || typeof admission !== "object" || admission.status !== "admitted") {
		return { ok: false, reason: "admitted event has no dynamic-policy 'admitted' decision" };
	}
	const consideredTasks = [...tasks, ...[...byId.values()].filter((t) => t.is_dynamic).map(dynamicRowToTask)];
	const derived = zeroBudget();
	addBudget(derived, budget.reserved);
	addBudget(derived, budget.consumed);
	const revalidated = admitTaskProposal({
		proposal,
		manifest,
		queueState: { tasks: consideredTasks, derived_budget: derived },
		depth: proposal.depth ?? admission.depth ?? 1,
	});
	if (revalidated.status !== "admitted") {
		return { ok: false, reason: `admission re-validation failed: ${revalidated.reasons.join("; ")}` };
	}
	if (proposal.proposed_task_id !== taskId) {
		return { ok: false, reason: `admitted task_id ${taskId} does not match proposal ${proposal.proposed_task_id}` };
	}
	// Build the FULL recoverable task definition from the proposal.
	const definition = buildDynamicTaskDefinition({ proposal, envelope, campaign_id, admission });
	const validation = validateDynamicDefinition(definition);
	if (!validation.ok)
		return { ok: false, reason: `admitted task definition invalid: ${validation.reasons.join("; ")}` };
	// F5: a Stage ID must be unique across the WHOLE Campaign, not only within a
	// task. Refuse a definition whose stage ids collide with any known task.
	const knownStageIds = new Set();
	for (const existing of byId.values())
		for (const sid of existing.definition?.stages ?? []) knownStageIds.add(sid.stage_id);
	for (const task of tasks) for (const stage of task.stages ?? []) knownStageIds.add(stage.stage_id);
	const collision = definition.stages.map((s) => s.stage_id).find((id) => knownStageIds.has(id));
	if (collision) return { ok: false, reason: `dynamic stage id ${collision} is not unique across the Campaign` };
	const item = makeQueueItem({ campaign_id, task_id: taskId, state: "ready", depends_on: [], order: byId.size + 1 });
	item.parent_task_id = proposal.parent_task_id ?? null;
	item.stage_ids = definition.stages.map((stage) => stage.stage_id);
	item.applied_command_ids = [envelope.command_id];
	const reservation = parseBudgetStrict(revalidated.reserved_budget);
	item.reservation = reservation.ok ? reservation.value : zeroBudget();
	item.is_dynamic = true;
	item.definition = definition;
	item.semantic_key = semanticKey(proposal);
	item.proposal_id = proposalId;
	item.proposal_offset = offset;
	byId.set(taskId, item);
	addBudget(budget.reserved, item.reservation);
	return { ok: true };
}

/** Build a full, recoverable Task definition from an admitted proposal. */
function buildDynamicTaskDefinition({ proposal, envelope, campaign_id, admission }) {
	const stages =
		Array.isArray(proposal.stages) && proposal.stages.length > 0
			? proposal.stages
			: [
					{
						stage_id: proposal.proposed_stage_id ?? `stage-${proposal.proposed_task_id}`,
						criteria: proposal.goal?.success_criteria ?? [],
						required: true,
					},
				];
	const definition = {
		task_id: proposal.proposed_task_id,
		campaign_id,
		order: proposal.priority ?? 1,
		depends_on: [],
		parent_task_id: proposal.parent_task_id ?? null,
		parent_stage_id: proposal.parent_stage_id ?? null,
		target_ref: proposal.target_ref,
		task_type: proposal.task_type,
		required_capabilities: [...(proposal.required_capabilities ?? [])],
		goal: {
			goal_id: proposal.goal?.goal_id ?? proposal.goal?.success_criteria?.[0] ?? proposal.proposed_task_id,
			description: proposal.goal?.description ?? "",
			success_criteria: [...(proposal.goal?.success_criteria ?? [])],
		},
		stages,
		scope: proposal.scope ?? null,
		oracle_ref: proposal.oracle_ref ?? envelope.oracle_ref ?? null,
		execution_adapter: proposal.execution_adapter ?? null,
		expected_evidence: [...(proposal.expected_evidence ?? [])],
		stop_condition: proposal.stop_condition ?? null,
		priority: proposal.priority ?? 0,
		budget_reservation: { ...(proposal.budget_reservation ?? {}) },
		admission_ref: {
			proposal_id: envelope.proposal_id,
			digest: envelope.proposal_digest ?? null,
			status: admission.status,
		},
	};
	// A stable digest over the FULL definition (identity, scope, capabilities,
	// stages, budget, stop condition, expected evidence) so a restart recovers the
	// exact same definition. The ONE normalized executable shape is produced from
	// the same alias so workers read only `task_budget`.
	const normalized = normalizeExecutableTask({ definition, origin: "proposal" });
	if (normalized.ok) return { ...normalized.task, admission_ref: definition.admission_ref, execution_adapter: definition.execution_adapter };
	definition.task_budget = { ...(proposal.budget_reservation ?? {}) };
	definition.task_digest = digest(withoutTaskDigest(definition));
	return definition;
}

/**
 * Remove the definition digest before recomputing it. Uses the existing SHA256
 * helper (`digest` from the fixture contracts).
 */
export function withoutTaskDigest(value) {
	const clone = { ...value };
	delete clone.task_digest;
	return clone;
}

/** A dynamic definition is not usable unless it is fully specified. */
export function validateDynamicDefinition(definition) {
	const reasons = [];
	if (!definition || typeof definition !== "object") return { ok: false, reasons: ["definition must be an object"] };
	if (typeof definition.task_id !== "string" || !definition.task_id) reasons.push("task_id is required");
	if (!definition.goal || typeof definition.goal !== "object" || typeof definition.goal.goal_id !== "string") {
		reasons.push("goal.goal_id is required");
	}
	if (!Array.isArray(definition.stages) || definition.stages.length === 0)
		reasons.push("at least one stage is required");
	else {
		for (const stage of definition.stages) {
			if (!stage || typeof stage.stage_id !== "string" || !stage.stage_id) reasons.push("each stage needs a stage_id");
			if (!Array.isArray(stage.criteria) || stage.criteria.length === 0)
				reasons.push(`stage ${stage?.stage_id} needs criteria`);
		}
	}
	if (typeof definition.target_ref !== "string" || !definition.target_ref) reasons.push("target_ref is required");
	if (typeof definition.task_type !== "string" || !definition.task_type) reasons.push("task_type is required");
	if (typeof definition.stop_condition !== "string" || !definition.stop_condition)
		reasons.push("stop_condition is required");
	if (!Array.isArray(definition.expected_evidence) || definition.expected_evidence.length === 0) {
		reasons.push("expected_evidence is required");
	}
	return { ok: reasons.length === 0, reasons };
}

/** A stable semantic identity so a re-proposal with a new id is still a duplicate. */
export function semanticKey(proposal) {
	return canonicalKey({
		parent_task_id: proposal?.parent_task_id ?? null,
		parent_stage_id: proposal?.parent_stage_id ?? null,
		target_ref: proposal?.target_ref ?? null,
		task_type: proposal?.task_type ?? null,
		goal: proposal?.goal?.success_criteria ?? null,
		capabilities: [...(proposal?.required_capabilities ?? [])].sort(),
	});
}

function dynamicRowToTask(item) {
	return {
		task_id: item.task_id,
		parent_task_id: item.parent_task_id ?? null,
		target_ref: item.definition?.target_ref ?? null,
		task_type: item.definition?.task_type ?? null,
		stage_ids: item.stage_ids ?? [],
	};
}

function releasedReservationFor(item, budget, delta) {
	item.reservation = parseBudgetStrict(item.reservation).value ?? zeroBudget();
	subBudget(item.reservation, delta);
	subBudget(budget.reserved, delta);
	return true;
}

/**
 * F8: a canonical, complete projection of a Stage-level Outcome. Every semantic
 * field that the aggregation/supersede logic reads is preserved so two outcomes
 * that differ only by status/criterion/scope/evidence are NOT collapsed.
 */
export function canonicalStageOutcome(outcome, overrides = {}) {
	const src = outcome ?? {};
	return {
		outcome_id: overrides.outcome_id ?? src.outcome_id ?? null,
		level: src.level ?? "step",
		status: src.status ?? null,
		task_id: overrides.task_id ?? src.task_id ?? null,
		episode_id: src.episode_id ?? null,
		step_id: overrides.step_id ?? src.step_id ?? src.stage_id ?? null,
		criterion: src.criterion ?? { criterion_id: src.criterion_id ?? null, expected: src.criterion?.expected ?? null },
		observed: src.observed ?? null,
		scope: src.scope ?? src.provenance?.scope ?? null,
		oracle: src.oracle ?? null,
		provenance: src.provenance ?? null,
		evidence_refs: Array.isArray(src.evidence_refs) ? src.evidence_refs : [],
		supersedes: src.supersedes ?? null,
		failure_mode: src.failure_mode ?? null,
	};
}

/**
 * F9: the trusted CURRENT scope for a task. Resolution order:
 *   task.definition.scope -> task.scope -> null (fail-closed).
 * The top-level `manifest.scope` is NOT used: a Task's environment lives on the
 * Task definition, and a missing scope is fail-closed rather than skipped.
 */
export function currentTaskScope(task) {
	if (!task || typeof task !== "object") return null;
	return task.definition?.scope ?? task.scope ?? null;
}

function canonicalKey(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalKey).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonicalKey(value[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * F6: a deterministic, COMPLETE snapshot of a projection for equivalence checks.
 * Covers task definitions, task states/outcome refs, stage outcomes, the proposal
 * index, budget (reserved/consumed/released), control (state/reason), pending
 * reconciliation, and the committed tail. Two projections are equivalent iff
 * their snapshots are deep-equal.
 */
export function projectionSnapshot(projection) {
	return {
		tasks: [...projection.tasks]
			.map((task) => ({
				task_id: task.task_id,
				state: task.state,
				is_dynamic: task.is_dynamic === true,
				definition_digest: task.definition?.task_digest ?? null,
				definition: task.definition ?? null,
				stage_ids: [...(task.stage_ids ?? [])],
				depends_on: [...(task.depends_on ?? [])],
				awaiting_plan_ready: task.awaiting_plan_ready === true,
				plan_ready: task.plan_ready === true,
				plan_id: task.plan_id ?? null,
				reservation: task.reservation ?? null,
				budget_consumed: task.budget_consumed ?? null,
				task_outcome_status: task.task_outcome_status ?? null,
				task_outcome_ref: task.task_outcome_ref ?? null,
				// F8: the COMPLETE canonical stage-Outcome projection, not only ids.
				stage_outcomes: [...(task.stage_outcomes ?? [])]
					.map((o) => canonicalStageOutcome(o))
					.sort((a, b) => String(a.outcome_id).localeCompare(String(b.outcome_id))),
				reconciliation_state: task.reconciliation_state ?? "none",
				stop_reason: task.stop_reason ?? null,
			}))
			.sort((a, b) => a.task_id.localeCompare(b.task_id)),
		proposals: [...projection.proposals.entries()]
			.map(([id, entry]) => ({ id, digest: entry.digest, offset: entry.offset }))
			.sort((a, b) => a.id.localeCompare(b.id)),
		plans: (projection.plans ?? [])
			.map((plan) => ({ id: plan.id, status: plan.status, digest: plan.digest, normalized: plan.normalized }))
			.sort((a, b) => String(a.id).localeCompare(String(b.id))),
		dynamic_definitions: (projection.dynamic_definitions ?? [])
			.map((entry) => ({ task_id: entry.task_id, definition: entry.definition }))
			.sort((a, b) => a.task_id.localeCompare(b.task_id)),
		// F8: the outcome index carries the full task AND stage Outcomes.
		outcomes: [...projection.outcomes.entries()]
			.map(([id, entry]) => ({ id, outcome: entry }))
			.sort((a, b) => a.id.localeCompare(b.id)),
		outcome_ids: [...projection.outcomes.keys()].sort(),
		budget: projection.budget,
		control: { state: projection.control.state, reason: projection.control.reason, offset: projection.control.offset },
		tail_offset: projection.tail_offset,
		tail_digest: projection.tail_digest,
	};
}
