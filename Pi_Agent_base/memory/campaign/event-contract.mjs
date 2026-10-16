// Aegis Campaign C1-A — Campaign event contract.
//
// The Campaign reuses the EXISTING runtime EventLog. There is no second event
// schema and no new top-level event type: campaign events are `runtime.note`
// (schema_version 1.1, already registered in `memory/runtime/events.mjs`) with a
// `payload.kind` drawn from the frozen `campaign.*` vocabulary below.
//
// The model may only ever submit a PROPOSAL. Every state transition is written
// by the trusted Host/Runtime source kind; an `llm`-sourced event is a claim,
// not a transition, and is refused here.
//
// This module is PURE (no fs, no scheduler loop): it defines the vocabulary and
// validates one event's shape. The projection (projection.mjs) consumes
// validated events.

import { isKnownSourceKind } from "../runtime/events.mjs";
import { assertIdType } from "./identifiers.mjs";

/**
 * FROZEN campaign event kind vocabulary (docs/DS_MASTER_PROMPT.md C1-A).
 * Unknown `campaign.*` kinds MUST NOT drive a state transition.
 */
export const CAMPAIGN_EVENT_KINDS = Object.freeze([
	"campaign.task.started",
	"campaign.task.completed",
	"campaign.task.failed",
	"campaign.task.unknown",
	"campaign.task.paused",
	"campaign.task.resumed",
	"campaign.task.cancelled",
	"campaign.proposal.submitted",
	"campaign.proposal.admitted",
	"campaign.proposal.blocked",
	"campaign.proposal.rejected",
	"campaign.plan.submitted",
	"campaign.plan.admitted",
	"campaign.plan.blocked",
	"campaign.plan.rejected",
	"campaign.plan.ready",
	"campaign.budget.reserved",
	"campaign.budget.consumed",
	"campaign.budget.released",
	"campaign.oracle.result",
	"campaign.reconciliation.requested",
	"campaign.reconciliation.resolved",
	"campaign.handoff.requested",
	"campaign.handoff.completed",
	"campaign.campaign.paused",
	"campaign.campaign.resumed",
	"campaign.campaign.cancelled",
	"campaign.campaign.stopped",
]);

export const CAMPAIGN_EVENT_SCHEMA_VERSION = "1.1";
export const CAMPAIGN_EVENT_TYPE = "runtime.note";

/**
 * PER-KIND source permissions (docs/C1_CLOSURE_BASELINE.md §3.1).
 *
 * `runtime.note` is a generic envelope: being a known source kind does NOT grant
 * the right to drive every Campaign transition. `agent`/`observer`/
 * `environment` never gain a state-writing permission merely by not being `llm`.
 * An `llm`/`agent` proposal may be RECORDED, but can never be admitted or
 * complete a task.
 */
export const CAMPAIGN_KIND_SOURCES = Object.freeze({
	"campaign.proposal.submitted": Object.freeze(["llm", "agent", "human", "runtime"]),
	"campaign.proposal.blocked": Object.freeze(["runtime", "human"]),
	"campaign.proposal.rejected": Object.freeze(["runtime", "human"]),
	"campaign.proposal.admitted": Object.freeze(["runtime", "human"]),
	"campaign.plan.submitted": Object.freeze(["llm", "agent", "human", "runtime"]),
	"campaign.plan.admitted": Object.freeze(["runtime", "human"]),
	"campaign.plan.blocked": Object.freeze(["runtime", "human"]),
	"campaign.plan.rejected": Object.freeze(["runtime", "human"]),
	"campaign.plan.ready": Object.freeze(["oracle", "human"]),
	"campaign.task.started": Object.freeze(["runtime", "human"]),
	"campaign.task.paused": Object.freeze(["runtime", "human"]),
	"campaign.task.resumed": Object.freeze(["runtime", "human"]),
	"campaign.task.cancelled": Object.freeze(["runtime", "human"]),
	"campaign.task.completed": Object.freeze(["runtime"]),
	"campaign.task.failed": Object.freeze(["runtime"]),
	"campaign.task.unknown": Object.freeze(["runtime", "oracle", "human"]),
	"campaign.oracle.result": Object.freeze(["oracle", "human"]),
	"campaign.budget.reserved": Object.freeze(["runtime"]),
	"campaign.budget.consumed": Object.freeze(["runtime"]),
	"campaign.budget.released": Object.freeze(["runtime"]),
	"campaign.reconciliation.requested": Object.freeze(["runtime", "oracle", "human"]),
	"campaign.reconciliation.resolved": Object.freeze(["runtime", "oracle", "human"]),
	"campaign.handoff.requested": Object.freeze(["runtime", "human"]),
	"campaign.handoff.completed": Object.freeze(["runtime", "human"]),
	"campaign.campaign.paused": Object.freeze(["runtime", "human"]),
	"campaign.campaign.resumed": Object.freeze(["runtime", "human"]),
	"campaign.campaign.cancelled": Object.freeze(["runtime", "human"]),
	"campaign.campaign.stopped": Object.freeze(["runtime", "human"]),
});

/**
 * Backwards-compatible flattened view: the UNION of all per-kind sources. NOTE:
 * this is NOT the authorization rule — use `sourcesForKind(kind)`. It exists so
 * older callers that only need "is this a plausible driver kind" keep working.
 */
export const TRUSTED_EVENT_SOURCES = Object.freeze([...new Set(Object.values(CAMPAIGN_KIND_SOURCES).flat())]);

/** The source kinds allowed to drive a given campaign event kind (empty if unknown). */
export function sourcesForKind(kind) {
	return CAMPAIGN_KIND_SOURCES[kind] ?? Object.freeze([]);
}

export function isCampaignEventKind(kind) {
	return typeof kind === "string" && Object.keys(CAMPAIGN_KIND_SOURCES).includes(kind);
}

/**
 * Validate one candidate campaign event. Returns `{ok, reasons}`; never throws.
 *
 * A `runtime.note` envelope carries the campaign id in `payload.campaign_id`.
 * `expected_revision` (when present) is checked by the projection against the
 * current revision, not here (this function has no revision context).
 */
export function validateCampaignEvent(event) {
	const reasons = [];
	if (!event || typeof event !== "object" || Array.isArray(event)) {
		return { ok: false, reasons: ["event must be an object"] };
	}
	if (event.event_type !== CAMPAIGN_EVENT_TYPE) {
		reasons.push(`event_type must be "${CAMPAIGN_EVENT_TYPE}" (campaign events reuse runtime.note)`);
	}
	if (event.schema_version !== undefined && !/^1\.[0-9]+$/.test(String(event.schema_version))) {
		reasons.push(`schema_version must be a 1.x version, got ${String(event.schema_version)}`);
	}
	const kind = event.payload?.kind;
	if (!isCampaignEventKind(kind)) {
		reasons.push(`payload.kind must be a frozen campaign.* kind, got ${String(kind)}`);
	}
	const campaignId = event.payload?.campaign_id;
	reasons.push(...assertIdType(campaignId, "campaign", "payload.campaign_id").reasons);

	// Per-kind source authorization. A source that is not registered, or not
	// allowed for THIS kind, can never drive the transition. This is checked at
	// the event boundary, before projection.
	const sourceKind = event.source?.kind;
	if (!isKnownSourceKind(sourceKind)) {
		reasons.push(`source.kind is not a registered source kind: ${String(sourceKind)}`);
	} else if (isCampaignEventKind(kind)) {
		const allowed = sourcesForKind(kind);
		if (!allowed.includes(sourceKind)) {
			reasons.push(`source.kind "${sourceKind}" is not authorized to drive ${kind} (allowed: ${allowed.join(", ")})`);
		}
	}
	return { ok: reasons.length === 0, reasons };
}

/**
 * Normalize the shape the projection relies on. Kept tiny and explicit so the
 * projection never has to guess at payload field names.
 */
export function campaignEventEnvelope(event) {
	return {
		kind: event?.payload?.kind ?? null,
		campaign_id: event?.payload?.campaign_id ?? null,
		source_kind: event?.source?.kind ?? null,
		task_id: event?.payload?.task_id ?? null,
		proposal_id: event?.payload?.proposal_id ?? null,
		command_id: event?.payload?.command_id ?? event?.payload?.proposal_id ?? null,
		episode_id: event?.payload?.episode_id ?? event?.episode_id ?? null,
		expected_revision: event?.payload?.expected_revision ?? null,
		outcome_id: event?.payload?.outcome_id ?? null,
		step_id: event?.payload?.step_id ?? null,
		status: event?.payload?.status ?? null,
		task_oracle: event?.payload?.task_oracle === true,
		reservation: event?.payload?.reservation ?? null,
		consumed: event?.payload?.consumed ?? null,
		released: event?.payload?.released ?? null,
		parent_task_id: event?.payload?.parent_task_id ?? null,
		proposal: event?.payload?.proposal ?? null,
		proposal_digest: event?.payload?.proposal_digest ?? null,
		admission: event?.payload?.admission ?? null,
		plan: event?.payload?.plan ?? null,
		plan_id: event?.payload?.plan_id ?? null,
		plan_digest: event?.payload?.plan_digest ?? null,
		planning_task_id: event?.payload?.planning_task_id ?? null,
		plan_tasks: event?.payload?.plan_tasks ?? null,
		planning_status: event?.payload?.planning_status ?? null,
		outcome: event?.payload?.outcome ?? null,
		reason: event?.payload?.reason ?? null,
		reasons: Array.isArray(event?.payload?.reasons) ? event.payload.reasons : [],
		oracle_ref: event?.payload?.oracle_ref ?? null,
		event_digest: event?.event_digest ?? null,
		event_sequence: event?.sequence ?? null,
	};
}
