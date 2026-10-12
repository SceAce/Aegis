// Verified data-use-stage contribution (batch B / B2 hardening).
//
// This records whether obtained data was actually USED and whether that use was
// followed by a VERIFIED advance. It is deliberately weak and association-only:
//   * (a) the data was really OBTAINED (a resolved data record at a
//         stage/hash in the SAME episode),
//   * (b) a specific action actually COMPLETED, whose final bound arguments
//     explicitly reference that data ref (the "use" binding),
//   * (c) the stage was VERIFIED by a resolved, trusted (oracle/human) stage
//     Outcome that exactly references BOTH the data ref and the action ref.
//   * it is NEVER a causal claim. `causal` stays false and `association_only`
//     stays true, no matter how strong the association looks.
//
// HARDENING (B2 audit) — the previous version accepted a caller's
// `data_obtained` boolean and any `status:"success"` outcome whose
// `evidence_refs` merely *contained* a ref of the same type/id. It could be
// fooled by:
//   * `data_obtained:true` with no resolved data record at all,
//   * an outcome that was not resolved to a real record,
//   * an outcome from another episode (only the string was compared),
//   * "some action" ref instead of the exact action that used the data, and
//   * an outcome superseded in the current effective view.
//
// The rules below REQUIRE a trusted resolver (`resolveSupport`) that returns the
// REAL data / action / outcome records. Without it, every stage stays `unknown`.
// `obtained`, `used` and `advance` are recorded as SEPARATE stage associations;
// no stage implies the next.

import { digest, stable } from "../fixture/contracts.mjs";

export const DATA_STAGES = ["obtain", "use", "advance"];
// Only an independent observer may turn a stage into `verified_use`. An agent
// self-report never can. The RESOLVED outcome record must carry one of these as
// its source kind (or an explicit oracle identity).
const TRUSTED_OUTCOME_SOURCES = new Set(["oracle", "human", "platform"]);

function refKey(ref) {
	if (!ref || typeof ref !== "object") return null;
	return `${ref.ref_type ?? ref.type ?? ""}:${ref.ref_id ?? ref.id ?? ""}`;
}

function kindOf(ref) {
	return ref?.ref_type ?? ref?.type ?? null;
}
function idOf(ref) {
	return ref?.ref_id ?? ref?.id ?? null;
}

/**
 * Resolve ONE ref to a real record through the trusted resolver. A bare digest
 * string is never accepted: the resolver must return `{ok:true, record}` and,
 * when the ref carries a digest, a matching `content_digest`.
 */
function resolveRef(resolver, kind, ref) {
	if (typeof resolver !== "function") return { ok: false, reason: "no trusted resolver supplied" };
	let resolved;
	try {
		resolved = resolver({ kind, ref, ref_key: refKey(ref) });
	} catch (error) {
		return { ok: false, reason: `resolver threw: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!resolved || resolved.ok !== true) return { ok: false, reason: resolved?.reason ?? "resolver did not confirm the record" };
	if (!resolved.record || typeof resolved.record !== "object") return { ok: false, reason: "resolver returned no record" };
	if (ref && typeof ref.digest === "string" && ref.digest) {
		if (typeof resolved.content_digest !== "string" || resolved.content_digest !== ref.digest) {
			return { ok: false, reason: "resolver content_digest does not match the ref digest" };
		}
	}
	return { ok: true, record: resolved.record };
}

/** A resolved stage outcome is trustworthy only when it is independently judged. */
function trustedOutcome(outcome) {
	if (!outcome || typeof outcome !== "object") return false;
	if (outcome.oracle && (outcome.oracle.oracle_id || outcome.oracle.method)) return true;
	const source = outcome.provenance?.source ?? outcome.source ?? outcome.origin;
	return typeof source === "string" && TRUSTED_OUTCOME_SOURCES.has(source.trim().toLowerCase());
}

/** The outcome must be a verified success whose own evidence names both refs. */
function outcomeNamesBoth(outcome, dataRef, actionRef) {
	const evidence = Array.isArray(outcome.evidence_refs) ? outcome.evidence_refs : [];
	const names = (wanted) => {
		if (!wanted) return false;
		return evidence.some((ref) => {
			if (!ref || typeof ref !== "object") return false;
			if (kindOf(ref) !== kindOf(wanted)) return false;
			if (idOf(ref) !== idOf(wanted)) return false;
			if (wanted.digest !== undefined && wanted.digest !== null) return ref.digest === wanted.digest;
			return true;
		});
	};
	return { data: names(dataRef), action: names(actionRef) };
}

/**
 * @param {object} input
 * @param {string} input.episode_id
 * @param {object} input.dataRef    `{ref_type:"data", ref_id, digest}` actually obtained
 * @param {object} input.actionRef  `{ref_type:"action", ref_id}` of a COMPLETED action
 * @param {object} [input.useRefs]  explicit data refs the action's final bound
 *   arguments reference; the dataRef must appear here for a `use`/`advance` stage
 * @param {object} [input.actionRecord] resolved action record (from the resolver)
 * @param {object} [input.outcome]  the stage outcome ref to resolve
 * @param {string} [input.stage]    "obtain" | "use" | "advance"
 * @param {(query:{kind:string, ref:object, ref_key:string|null})=>object} input.resolveSupport
 * @param {string[]} [input.supersededOutcomeIds] outcomes superseded in the effective view
 * @param {object} [input.supersedes]
 * @param {boolean} [input.self_reported] explicit agent self-report flag (never proof)
 */
export function recordStageContribution({
	episode_id,
	dataRef = null,
	actionRef = null,
	useRefs = [],
	outcome = null,
	stage = "use",
	resolveSupport = null,
	supersededOutcomeIds = [],
	supersedes = null,
	self_reported = false,
	note = null,
} = {}) {
	const reasons = [];
	const resolver = typeof resolveSupport === "function" ? resolveSupport : null;
	const supersededSet = new Set(Array.isArray(supersededOutcomeIds) ? supersededOutcomeIds.filter((id) => typeof id === "string" && id) : []);

	if (!episode_id) reasons.push({ field: "episode_id", detail: "episode_id is required" });
	if (!refKey(dataRef)) reasons.push({ field: "dataRef", detail: "a data ref is required" });
	if (!DATA_STAGES.includes(stage)) reasons.push({ field: "stage", detail: `stage must be one of ${DATA_STAGES.join(", ")}` });
	if (stage !== "obtain" && !refKey(actionRef)) reasons.push({ field: "actionRef", detail: "a use/advance claim needs an independently observed, completed action ref; self-report is not evidence" });

	// Resolve the real records. Every claim below is checked against them.
	let dataRecord = null;
	let actionRecord = null;
	let outcomeRecord = null;
	if (refKey(dataRef)) {
		const resolved = resolveRef(resolver, kindOf(dataRef) ?? "data", dataRef);
		if (resolved.ok) dataRecord = resolved.record;
		else reasons.push({ field: "dataRef", detail: `the data ref did not resolve: ${resolved.reason}` });
	}
	if (refKey(actionRef)) {
		const resolved = resolveRef(resolver, "action", actionRef);
		if (resolved.ok) actionRecord = resolved.record;
		else reasons.push({ field: "actionRef", detail: `the action ref did not resolve: ${resolved.reason}` });
	}
	if (outcome) {
		const outcomeRef = outcome.outcome_id ? { ref_type: "outcome", ref_id: outcome.outcome_id } : outcome;
		if (outcomeRef?.ref_id && supersededSet.has(outcomeRef.ref_id)) {
			reasons.push({ field: "outcome", detail: `outcome ${outcomeRef.ref_id} was superseded in the current effective view` });
		} else {
			const resolved = resolveRef(resolver, "outcome", outcomeRef);
			if (resolved.ok) outcomeRecord = resolved.record;
			else reasons.push({ field: "outcome", detail: `the stage outcome did not resolve: ${resolved.reason}` });
		}
	}

	// (a) The data record must belong to THIS episode.
	const dataSameEpisode = Boolean(dataRecord && typeof dataRecord.episode_id === "string" && dataRecord.episode_id === episode_id);
	if (dataRecord && !dataSameEpisode) reasons.push({ field: "dataRef", detail: "the resolved data record belongs to a different episode" });

	// (b) The action must have actually COMPLETED and must explicitly reference
	//     the data ref in its FINAL bound arguments (the real "use" binding).
	let actionCompleted = false;
	let actionUsesData = false;
	if (stage !== "obtain" && actionRecord) {
		actionCompleted = actionRecord.status === "completed" || actionRecord.completed === true;
		if (!actionCompleted) reasons.push({ field: "actionRef", detail: "the resolved action has not completed" });
		if (typeof actionRecord.episode_id === "string" && actionRecord.episode_id !== episode_id) reasons.push({ field: "actionRef", detail: "the resolved action belongs to a different episode" });
		const bound = Array.isArray(actionRecord.bound_arguments) ? actionRecord.bound_arguments : [];
		actionUsesData = bound.some((ref) => ref && kindOf(ref) === kindOf(dataRef) && idOf(ref) === idOf(dataRef));
		if (!actionUsesData) {
			const explicit = Array.isArray(useRefs) && useRefs.some((ref) => ref && kindOf(ref) === kindOf(dataRef) && idOf(ref) === idOf(dataRef));
			reasons.push({ field: "useRefs", detail: explicit ? "the action's final bound arguments do not reference the data ref" : "no explicit use ref binds the action to the data" });
		} else if (Array.isArray(useRefs) && useRefs.length > 0 && !useRefs.some((ref) => ref && kindOf(ref) === kindOf(dataRef) && idOf(ref) === idOf(dataRef))) {
			reasons.push({ field: "useRefs", detail: "the explicit use refs do not include the data ref" });
		}
	}

	// (c) The stage outcome must be trusted, a verified success, in the SAME
	//     episode, and exactly name BOTH the data ref and the action ref.
	let outcomeOk = false;
	if (outcomeRecord) {
		const trusted = trustedOutcome(outcomeRecord);
		const sameEpisode = typeof outcomeRecord.episode_id === "string" && outcomeRecord.episode_id === episode_id;
		const success = outcomeRecord.status === "success";
		const named = outcomeNamesBoth(outcomeRecord, dataRef, actionRef);
		const refsOk = named.data && (stage === "obtain" || named.action);
		outcomeOk = trusted && sameEpisode && success && refsOk;
		if (!trusted) reasons.push({ field: "outcome", detail: "the resolved stage outcome is not an independent oracle/human judgment" });
		if (!success) reasons.push({ field: "outcome", detail: `the resolved stage outcome status is ${outcomeRecord.status}, not success` });
		if (!sameEpisode) reasons.push({ field: "outcome", detail: "the resolved stage outcome belongs to a different episode" });
		if (!refsOk) reasons.push({ field: "outcome", detail: "the resolved stage outcome does not exactly name both the same-episode data ref and the completed action ref" });
	}

	let status;
	if (self_reported) {
		status = "self_reported";
		reasons.push({ field: "self_reported", detail: "a self-report is recorded but never verifies a stage" });
	} else if (reasons.length > 0 && (!outcomeRecord || !outcomeOk)) {
		// Distinguish a definite refusal (data/action proved absent) from unknown.
		const definiteRefusal = reasons.some((reason) => reason.field === "dataRef" && /belongs to a different episode/.test(reason.detail));
		status = definiteRefusal ? "refused" : "unknown";
	} else if (outcomeOk && dataSameEpisode && (stage === "obtain" || (actionCompleted && actionUsesData))) {
		status = "verified_use";
	} else {
		status = "unknown";
	}
	// A stage can only be verified when the stage's own preconditions resolved.
	if (status === "verified_use" && stage !== "obtain" && !(actionCompleted && actionUsesData)) {
		status = "unknown";
		reasons.push({ field: "actionRef", detail: "the action did not complete with the data bound" });
	}

	const contributionId = `contrib_${digest(stable({ episode_id, data: refKey(dataRef), action: refKey(actionRef), stage })).slice("sha256:".length, "sha256:".length + 16)}`;
	const record = {
		schema_version: "1.2",
		contribution_id: contributionId,
		episode_id: episode_id ?? null,
		stage,
		status,
		data_ref: dataRef,
		action_ref: actionRef,
		outcome_ref: outcomeRecord?.outcome_id ? { ref_type: "outcome", ref_id: outcomeRecord.outcome_id } : null,
		evidence_refs: Array.isArray(outcomeRecord?.evidence_refs) ? outcomeRecord.evidence_refs : [],
		data_obtained: dataSameEpisode,
		action_completed: actionCompleted,
		action_uses_data: actionUsesData,
		association_only: true,
		causal: false,
		stage_useful: status === "verified_use",
		supersedes: supersedes ?? null,
		reasons,
		note,
		recorded_at: new Date().toISOString(),
	};
	return record;
}

/** Payload for the Observer's existing EventLog (`runtime.note`). */
export function contributionPayload(record) {
	return {
		event_type: "runtime.note",
		kind: "contribution.recorded",
		contribution_id: record.contribution_id,
		episode_id: record.episode_id,
		stage: record.stage,
		status: record.status,
		data_ref: record.data_ref,
		action_ref: record.action_ref,
		outcome_ref: record.outcome_ref,
		association_only: true,
		causal: false,
		stage_useful: record.stage_useful,
		supersedes: record.supersedes ?? null,
		reasons: record.reasons,
		recorded_at: record.recorded_at,
	};
}

/**
 * Data-usefulness across the three stages. Each stage is an independent
 * association: `obtained` (a real data record), `used` (a completed action that
 * bound the data), `advance` (a verified stage outcome). A later stage cannot be
 * "useful" unless every earlier stage is verified; missing/unknown stages make
 * the whole chain unknown, never useful. No stage implies another.
 */
export function dataUsefulness(records = []) {
	const byStage = new Map();
	for (const record of records) byStage.set(record.stage, record);
	const ordered = DATA_STAGES.map((stage) => byStage.get(stage) ?? null);
	const firstGap = ordered.findIndex((record) => !record || record.status !== "verified_use");
	return {
		stages: ordered.map((record, index) => ({
			stage: DATA_STAGES[index],
			status: record?.status ?? "missing",
			useful: record?.status === "verified_use",
			association: DATA_STAGES[index] === "obtain" ? "obtained" : DATA_STAGES[index] === "use" ? "used" : "advance",
		})),
		fully_useful: firstGap === -1,
		first_gap_stage: firstGap === -1 ? null : DATA_STAGES[firstGap],
		association_only: true,
		causal: false,
	};
}
