// Deterministic stage / task / Campaign aggregation (C0 contract).
//
// A stage is a named criterion with Outcome references — NOT a model-written
// checkbox (docs/CAMPAIGN_ARCHITECTURE.md §3.4). Aggregation is deterministic:
//
//   * all required stages success + task criterion success -> task success;
//   * a required safety/authorization violation -> task invalid/blocked;
//   * an unresolved required stage -> task unknown;
//   * task failure requires an Oracle-verified failed criterion, not a tool error;
//   * scheduler crash / timeout / transport failure alone -> unknown;
//   * a correction (`supersedes`) replaces a prior Outcome and NEVER increases
//     the independent count.
//
// `pending` is a projection-only state; the persisted Outcome status stays
// `success|failure|unknown|invalid` (MEMORY_SCHEMA §5.2).

import { canonicalJson } from "./manifest.mjs";

export const STAGE_STATUSES = Object.freeze(["success", "failure", "unknown", "invalid", "pending"]);
export const TASK_STATUSES = Object.freeze(["success", "failure", "unknown", "invalid", "pending"]);
export const PERSISTED_OUTCOME_STATUSES = Object.freeze(["success", "failure", "unknown", "invalid"]);

/**
 * Aggregate one stage from its Outcome references.
 *
 * @param {{[key: string]: any}} args
 */
export function aggregateStage({ stage, outcomes = [] }) {
	const required = stage.required !== false;
	// A superseded outcome is replaced, never counted. Build the effective set.
	const effective = effectiveOutcomes(outcomes);
	const criterionIds = new Set(stage.criterion_ids ?? []);

	const relevant = effective.filter((outcome) => {
		const cid = outcome?.criterion?.criterion_id;
		return criterionIds.size === 0 ? true : criterionIds.has(cid);
	});

	// No evidence at all -> pending projection (never a failure).
	if (relevant.length === 0) {
		return {
			stage_id: stage.stage_id,
			task_id: stage.task_id,
			status: "pending",
			required,
			outcome_ids: [],
			independence: independenceOf([]),
		};
	}

	// Per-criterion status: build the map criterion_id -> derived status, then
	// require EVERY declared criterion to be present and successful (CLOSE-08).
	// Requesting a subset of outcomes must never satisfy a stage.
	const derived = deriveStatuses(relevant);
	let status;
	const reasons = derived.reasons;
	if (criterionIds.size > 0) {
		const missing = [...criterionIds].filter((cid) => !derived.byCriterion.has(cid));
		if (missing.length > 0) {
			// Some declared criterion has no evidence: the stage is unresolved, not
			// a failure. Surface which criteria are missing.
			return {
				stage_id: stage.stage_id,
				task_id: stage.task_id,
				status: derived.status === "invalid" ? "invalid" : "pending",
				reasons: [...reasons, `missing evidence for required criterion: ${missing.join(", ")}`],
				required,
				outcome_ids: relevant.map((outcome) => outcome.outcome_id),
				criterion_ids: [...criterionIds],
				missing_criterion_ids: missing,
				data_refs: relevant.flatMap((outcome) => evidenceIds(outcome)),
				independence: independenceOf(relevant),
			};
		}
		// Aggregate the per-criterion derived statuses conservatively.
		status = combineStatuses([...derived.byCriterion.values()]);
	} else {
		status = derived.status;
	}

	return {
		stage_id: stage.stage_id,
		task_id: stage.task_id,
		status,
		reasons,
		required,
		outcome_ids: relevant.map((outcome) => outcome.outcome_id),
		criterion_ids: [...criterionIds],
		data_refs: relevant.flatMap((outcome) => evidenceIds(outcome)),
		independence: independenceOf(relevant),
	};
}

function evidenceIds(outcome) {
	return (outcome.evidence_refs ?? []).map((ref) => ref?.ref_id ?? ref);
}

/**
 * Derive a conservative status from a set of Outcomes, and (optionally) the
 * per-criterion map a stage needs to require every declared criterion.
 * Illegal statuses are surfaced as `invalid`, never treated as success.
 */
function deriveStatuses(relevant) {
	const reasons = [];
	const byCriterion = new Map();
	let overall;
	const statuses = relevant.map((outcome) => outcome.status);
	if (statuses.some((value) => !PERSISTED_OUTCOME_STATUSES.includes(value))) overall = "invalid";
	else if (statuses.includes("invalid")) overall = "invalid";
	else if (statuses.includes("failure")) overall = "failure";
	else if (statuses.includes("unknown")) overall = "unknown";
	else overall = "success";
	if (overall === "invalid") {
		const illegal = statuses.filter((value) => !PERSISTED_OUTCOME_STATUSES.includes(value));
		if (illegal.length > 0) reasons.push(`illegal persisted Outcome status: ${[...new Set(illegal)].join(", ")}`);
	}
	for (const outcome of relevant) {
		const cid = outcome?.criterion?.criterion_id;
		if (typeof cid !== "string") continue;
		const next = byCriterion.get(cid);
		byCriterion.set(cid, next === undefined ? outcome.status : combineStatuses([next, outcome.status]));
	}
	return { status: overall, reasons, byCriterion };
}

/** Combine already-classified persisted statuses with a fail-closed priority. */
function combineStatuses(statuses) {
	if (statuses.some((value) => !PERSISTED_OUTCOME_STATUSES.includes(value))) return "invalid";
	if (statuses.includes("invalid")) return "invalid";
	if (statuses.includes("failure")) return "failure";
	if (statuses.includes("unknown")) return "unknown";
	return "success";
}

/**
 * Aggregate a task from its stage aggregations. `taskOracle` is the task-level
 * criterion Outcome (or null when unresolved).
 *
 * CLOSE-04 / P1-1: a task success requires the TaskOracle to be genuinely BOUND
 * to this task. The binding is checked against the task definition and the
 * trusted provenance:
 *   * status must be `success`;
 *   * `task_id` (where present) must equal the task;
 *   * the criterion must match the task goal id;
 *   * `episode_id` must be present and match the expected episode (when known);
 *   * provenance.source must be trusted (never `llm`), and independent; the
 *     judge must be reached through a trusted adapter (evidence).
 * A missing/foreign/self-reported Oracle yields `unknown` or `invalid`, never
 * `success`.
 *
 * CLOSE-08: the required stage set is derived from the TASK DEFINITION, not
 * from the caller's `stages` array. If the caller omits a required stage the
 * task can never succeed.
 *
 * @param {{[key: string]: any}} args
 */
export function aggregateTask({ task, stages = [], taskOracle = null, safetyViolation = false, episodeId = null }) {
	const requiredStages = stages.filter((stage) => stage.required !== false);
	const reasons = [];

	// A required safety/authorization violation invalidates the task outright.
	if (safetyViolation === true) {
		return {
			task_id: task.task_id,
			status: "invalid",
			reasons: ["required safety/authorization violation"],
			stage_statuses: Object.fromEntries(stages.map((stage) => [stage.stage_id, stage.status])),
			outcome_ids: stages.flatMap((stage) => stage.outcome_ids),
			independent_stage_count: independentStageCount(requiredStages),
			task_oracle_status: taskOracle?.status ?? null,
		};
	}

	// Any required stage invalid -> task invalid.
	if (requiredStages.some((stage) => stage.status === "invalid")) {
		reasons.push("a required stage is invalid");
		return {
			task_id: task.task_id,
			status: "invalid",
			reasons,
			stage_statuses: stageStatusMap(stages),
			outcome_ids: stageOutcomeIds(stages),
			independent_stage_count: independentStageCount(requiredStages),
			task_oracle_status: taskOracle?.status ?? null,
		};
	}

	// Any required stage failure -> task failure ONLY because an Oracle judged it
	// failed (a stage status of failure is already Oracle-verified by construction).
	if (requiredStages.some((stage) => stage.status === "failure")) {
		reasons.push("a required stage is Oracle-verified failed");
		return {
			task_id: task.task_id,
			status: "failure",
			reasons,
			stage_statuses: stageStatusMap(stages),
			outcome_ids: stageOutcomeIds(stages),
			independent_stage_count: independentStageCount(requiredStages),
			task_oracle_status: taskOracle?.status ?? null,
		};
	}

	// CLOSE-08: derive the required stages from the TASK definition and ensure
	// every one is present in the caller's stage aggregations. A missing required
	// stage makes the task unresolved, never successful.
	const declaredRequiredStageIds = (task?.stages ?? [])
		.filter((stage) => stage.required !== false)
		.map((stage) => stage.stage_id);
	const providedStageIds = new Set(stages.map((stage) => stage.stage_id));
	const missingStageIds = declaredRequiredStageIds.filter((id) => !providedStageIds.has(id));
	if (missingStageIds.length > 0) {
		reasons.push(`required stage(s) not aggregated: ${missingStageIds.join(", ")}`);
		return {
			task_id: task.task_id,
			status: "unknown",
			reasons,
			stage_statuses: stageStatusMap(stages),
			outcome_ids: stageOutcomeIds(stages),
			independent_stage_count: independentStageCount(requiredStages),
			task_oracle_status: taskOracle?.status ?? null,
			missing_stage_ids: missingStageIds,
		};
	}

	// Unresolved required stage or missing task criterion -> unknown.
	const unresolved = requiredStages.some((stage) => stage.status === "unknown" || stage.status === "pending");
	if (unresolved) {
		reasons.push("a required stage is unresolved (unknown/pending)");
		return {
			task_id: task.task_id,
			status: "unknown",
			reasons,
			stage_statuses: stageStatusMap(stages),
			outcome_ids: stageOutcomeIds(stages),
			independent_stage_count: independentStageCount(requiredStages),
			task_oracle_status: taskOracle?.status ?? null,
		};
	}

	// All required stages resolved success; the task criterion must also succeed.
	if (!taskOracle) {
		reasons.push("task Oracle criterion has not been judged");
		return {
			task_id: task.task_id,
			status: "unknown",
			reasons,
			stage_statuses: stageStatusMap(stages),
			outcome_ids: stageOutcomeIds(stages),
			independent_stage_count: independentStageCount(requiredStages),
			task_oracle_status: null,
		};
	}
	// CLOSE-04 / P1-1: verify the TaskOracle is genuinely bound to THIS task
	// before its `success` can be trusted. Every binding field that is present in
	// the task definition must match; trusted provenance is mandatory.
	const binding = validateTaskOracleBinding({ task, taskOracle, episodeId });
	if (!binding.ok) {
		reasons.push(...binding.reasons);
		return {
			task_id: task.task_id,
			status: binding.status,
			reasons,
			stage_statuses: stageStatusMap(stages),
			outcome_ids: stageOutcomeIds(stages),
			independent_stage_count: independentStageCount(requiredStages),
			task_oracle_status: taskOracle.status ?? null,
		};
	}
	// Illegal task Oracle status must NEVER be treated as success (P1-4).
	if (!PERSISTED_OUTCOME_STATUSES.includes(taskOracle.status)) {
		reasons.push(`illegal task Oracle status: ${String(taskOracle.status)}`);
		return {
			task_id: task.task_id,
			status: "invalid",
			reasons,
			stage_statuses: stageStatusMap(stages),
			outcome_ids: stageOutcomeIds(stages),
			independent_stage_count: independentStageCount(requiredStages),
			task_oracle_status: taskOracle.status ?? null,
		};
	}
	if (taskOracle.status === "unknown") {
		reasons.push("task Oracle criterion is unknown");
		return {
			task_id: task.task_id,
			status: "unknown",
			reasons,
			stage_statuses: stageStatusMap(stages),
			outcome_ids: stageOutcomeIds(stages),
			independent_stage_count: independentStageCount(requiredStages),
			task_oracle_status: "unknown",
		};
	}
	if (taskOracle.status === "failure") {
		reasons.push("task Oracle criterion failed");
		return {
			task_id: task.task_id,
			status: "failure",
			reasons,
			stage_statuses: stageStatusMap(stages),
			outcome_ids: stageOutcomeIds(stages),
			independent_stage_count: independentStageCount(requiredStages),
			task_oracle_status: "failure",
		};
	}
	if (taskOracle.status === "invalid") {
		reasons.push("task Oracle criterion is invalid");
		return {
			task_id: task.task_id,
			status: "invalid",
			reasons,
			stage_statuses: stageStatusMap(stages),
			outcome_ids: stageOutcomeIds(stages),
			independent_stage_count: independentStageCount(requiredStages),
			task_oracle_status: "invalid",
		};
	}

	return {
		task_id: task.task_id,
		status: "success",
		reasons: ["all required stages and the task Oracle criterion succeeded"],
		stage_statuses: stageStatusMap(stages),
		outcome_ids: [...stageOutcomeIds(stages), taskOracle.outcome_id],
		independent_stage_count: independentStageCount(requiredStages),
		task_oracle_status: "success",
	};
}

function stageStatusMap(stages) {
	return Object.fromEntries(stages.map((stage) => [stage.stage_id, stage.status]));
}

/**
 * Verify a TaskOracle is bound to the current task. Returns
 * `{ok, status, reasons}`; when `ok` is false, `status` is the fail-closed task
 * status (`invalid` for a structural/foreign/illegal binding, `unknown` for a
 * missing binding that could still be resolved later).
 *
 * This is intentionally strict: model self-report (`llm`), a foreign task id, a
 * missing criterion/episode, or non-independent provenance can NEVER produce a
 * task success.
 *
 * @param {{[key: string]: any}} args
 */
export function validateTaskOracleBinding({ task, taskOracle, episodeId = null }) {
	const reasons = [];
	const foreign = [];
	if (!taskOracle || typeof taskOracle !== "object")
		return { ok: false, status: "unknown", reasons: ["no task Oracle"] };

	// Trusted provenance is mandatory. `llm`/self-report is invalid, not unknown:
	// it can never become a trusted result by waiting.
	const source = taskOracle.provenance?.source ?? taskOracle.oracle?.source ?? null;
	if (source === "llm") foreign.push("task Oracle provenance is model self-report (llm); not a result");
	else if (source === null || !["oracle", "human", "runtime"].includes(source))
		foreign.push(`task Oracle provenance source is not trusted: ${String(source)}`);
	if (taskOracle.provenance && taskOracle.provenance.independent !== true)
		foreign.push("task Oracle provenance is not independent");

	// Task binding: the Oracle must carry the SAME task_id as the task. Accept the
	// id either at the top level or under `provenance` (both are common producer
	// shapes). A missing task id is a missing binding (unknown).
	const oracleTaskId = taskOracle.task_id ?? taskOracle.provenance?.task_id ?? null;
	if (oracleTaskId === null) reasons.push("task Oracle is missing its task_id binding");
	else if (oracleTaskId !== task.task_id) foreign.push(`task Oracle belongs to ${oracleTaskId}, not ${task.task_id}`);

	// Episode binding: when the caller (trusted projection) supplies the expected
	// episode, the Oracle MUST carry a matching episode. A missing episode on the
	// Oracle is a missing binding; a present-but-different one is foreign.
	const oracleEpisode = taskOracle.episode_id ?? taskOracle.provenance?.episode_id ?? null;
	if (oracleEpisode === null) reasons.push("task Oracle is missing its episode_id binding");
	else if (episodeId !== null && oracleEpisode !== episodeId)
		foreign.push(`task Oracle episode ${oracleEpisode} does not match expected ${episodeId}`);

	// Criterion binding: the Oracle criterion must match the task goal id.
	const goalId = task?.goal?.goal_id ?? null;
	const criterionId = taskOracle.criterion?.criterion_id ?? taskOracle.criterion_id ?? null;
	if (criterionId === null) reasons.push("task Oracle is missing its criterion binding");
	else if (goalId !== null && criterionId !== goalId)
		foreign.push(`task Oracle criterion ${criterionId} does not match task goal ${goalId}`);

	if (foreign.length > 0) return { ok: false, status: "invalid", reasons: foreign };
	if (reasons.length > 0) return { ok: false, status: "unknown", reasons };
	return { ok: true, status: null, reasons: [] };
}
function stageOutcomeIds(stages) {
	return stages.flatMap((stage) => stage.outcome_ids ?? []);
}
function independentStageCount(requiredStages) {
	return requiredStages.filter((stage) => stage.status === "success" || stage.status === "failure").length;
}

/**
 * Aggregate Campaign facts. This reports per-task facts AND raw counts, but it
 * NEVER converts counts into a statistical claim (no success-rate field).
 *
 * @param {{[key: string]: any}} args
 */
export function aggregateCampaign({ manifest, taskAggregates = [], faults = [], budgetUsed = {} }) {
	const counts = { total: taskAggregates.length, success: 0, failure: 0, unknown: 0, invalid: 0, pending: 0 };
	for (const task of taskAggregates) {
		if (Object.hasOwn(counts, task.status)) counts[task.status] += 1;
	}
	return {
		campaign_id: manifest.campaign_id,
		schema_version: manifest.schema_version,
		revision: manifest.revision,
		manifest_digest: null, // filled by report.mjs (kept out of this pure aggregator)
		tasks: taskAggregates.map((task) => ({ task_id: task.task_id, status: task.status, reasons: task.reasons ?? [] })),
		counts,
		faults: faults.map((fault) => ({ kind: fault.kind, task_id: fault.task_id ?? null, detail: fault.detail ?? null })),
		budget: {
			limit: manifest.budget,
			used: {
				wall_time_ms: budgetUsed.wall_time_ms ?? 0,
				model_requests: budgetUsed.model_requests ?? 0,
				tool_calls: budgetUsed.tool_calls ?? 0,
				session_count: budgetUsed.session_count ?? 0,
			},
		},
		// Explicit: counts are raw observations, NOT a quality claim.
		statistical_claim: null,
	};
}

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a superseding Outcome may legally retire the Outcome named
 * by `outcome.supersedes`. Returns `{valid, reason}`. `reason` uses the vocabulary
 * documented in MEMORY_SCHEMA_NOTES §3: cycle / missing / llm / foreign /
 * malformed / subject_mismatch / scope_mismatch.
 *
 * ALL of these must hold (fail-closed on any missing binding field):
 *   1. the superseding source is trusted (oracle/human/runtime), never `llm`;
 *   2. the superseded Outcome exists in the same input set;
 *   3. both are in the same episode_id;
 *   4. the criterion/subject matches (no cross-proposition replacement);
 *   5. the scope matches (no cross-environment replacement);
 *   6. the supersede chain does not cycle;
 *   7. the correction carries legal provenance and evidence structure.
 */
export function classifySupersede(
	outcome,
	{ outcomes = [], trustedKinds = ["oracle", "human", "runtime"], byId = null } = {},
) {
	if (!outcome || typeof outcome !== "object") return { valid: false, reason: "malformed" };
	const targetId = outcome.supersedes;
	if (typeof targetId !== "string" || targetId.length === 0) return { valid: false, reason: "malformed" };
	if (targetId === outcome.outcome_id) return { valid: false, reason: "cycle" };

	// 1. Trusted source only; `llm` (and unknown provenance) never retire a Fact.
	const source = outcome.provenance?.source ?? outcome.oracle?.source ?? null;
	if (source === "llm") return { valid: false, reason: "llm" };
	if (source === null || !trustedKinds.includes(source)) return { valid: false, reason: "malformed" };

	// 7. Legal provenance/evidence structure for a correction.
	if (
		typeof outcome.provenance !== "object" ||
		outcome.provenance === null ||
		outcome.provenance.independent !== true
	) {
		return { valid: false, reason: "malformed" };
	}

	const index = byId ?? new Map(outcomes.map((entry) => [entry.outcome_id, entry]));
	const prior = index.get(targetId);
	// 2. Target must exist.
	if (!prior) return { valid: false, reason: "missing" };

	// 3. Same episode. A correction with a null episode on EITHER side is not a
	//    trusted same-episode binding: fail closed (P0-2).
	const outcomeEpisode = outcome.episode_id ?? null;
	const priorEpisode = prior.episode_id ?? null;
	if (outcomeEpisode === null || priorEpisode === null || outcomeEpisode !== priorEpisode)
		return { valid: false, reason: "foreign" };

	// 4. Same criterion/subject. Compared CANONICALLY so object key order never
	//    changes the verdict (P0-2). Scope is validated separately so an audit can
	//    tell "the proposition changed" from "the environment changed".
	const outcomeCriterion = criterionKey(outcome);
	const priorCriterion = criterionKey(prior);
	if (outcomeCriterion === null || priorCriterion === null || outcomeCriterion !== priorCriterion)
		return { valid: false, reason: "subject_mismatch" };

	// 5. Same scope. A missing scope on EITHER side is never a match (P0-2):
	//    absence of a declared environment is not evidence of the same one.
	const outcomeScope = scopeKey(outcome);
	const priorScope = scopeKey(prior);
	if (outcomeScope === null || priorScope === null || outcomeScope !== priorScope)
		return { valid: false, reason: "scope_mismatch" };

	// 6. No cycle: walking `supersedes` from the target must never reach the
	//    superseding outcome.
	if (createsSupersedeCycle(outcome.outcome_id, targetId, index)) return { valid: false, reason: "cycle" };

	return { valid: true, reason: null };
}

function criterionKey(outcome) {
	const id = outcome?.criterion?.criterion_id ?? outcome?.criterion_id ?? null;
	if (typeof id !== "string" || id.length === 0) return null;
	// The expected value is part of the proposition identity when present. Use the
	// canonical (sorted-key) JSON so key order never changes identity.
	const expected = outcome?.criterion?.expected;
	return expected === undefined ? id : `${id}:${canonicalJson(expected)}`;
}

/** Canonical scope key; null when no scope is declared (never a match). */
function scopeKey(outcome) {
	const scope = outcome?.scope ?? outcome?.provenance?.scope ?? null;
	if (scope === null || scope === undefined) return null;
	return canonicalJson(scope);
}

/** Walk the supersede chain from `fromId`; true when it reaches `needleId`. */
function createsSupersedeCycle(needleId, fromId, byId) {
	const seen = new Set();
	let current = fromId;
	while (typeof current === "string" && current.length > 0) {
		if (current === needleId) return true;
		if (seen.has(current)) return true; // pre-existing cycle is also unsafe
		seen.add(current);
		current = byId.get(current)?.supersedes ?? null;
	}
	return false;
}

/**
 * Collapse a list of Outcomes into the EFFECTIVE set.
 *
 * An outcome named by a LEGAL `supersedes` is retired from the effective view.
 * A superseding `unknown` retires the prior and adds NO new Fact (no lucky
 * guess). An illegal supersede (foreign episode, criterion/scope mismatch,
 * missing target, cycle, `llm` source, malformed provenance) is IGNORED, so the
 * prior Outcome stays effective and nothing about it is silently altered.
 */
export function effectiveOutcomes(outcomes = [], options = {}) {
	const index = new Map(outcomes.map((outcome) => [outcome.outcome_id, outcome]));
	const superseded = new Set();
	const ignored = [];
	// A correction only fully retires a prior when it is LEGAL. An ILLEGAL
	// correction (llm/foreign/malformed/missing/cycle/scope mismatch) is not a
	// judgment at all: it is excluded from the effective view AND does not retire
	// its target (CLOSE-01 / P0-1).
	const illegalCorrectionIds = new Set();
	const legalCorrectionIds = new Set();
	for (const outcome of outcomes) {
		if (!outcome.supersedes) continue;
		const verdict = classifySupersede(outcome, { outcomes, byId: index, ...options });
		if (verdict.valid) {
			legalCorrectionIds.add(outcome.outcome_id);
			superseded.add(outcome.supersedes);
		} else {
			illegalCorrectionIds.add(outcome.outcome_id);
			ignored.push({ outcome_id: outcome.outcome_id, target: outcome.supersedes, reason: verdict.reason });
		}
	}
	const effective = [];
	for (const outcome of outcomes) {
		// An illegal correction is never an effective judgment.
		if (illegalCorrectionIds.has(outcome.outcome_id)) continue;
		if (superseded.has(outcome.outcome_id)) continue;
		// A LEGAL superseding `unknown` retires the old Fact but must itself remain
		// visible in the effective judgment view (CLOSE-09) so downstream never
		// silently drops the latest unknown.
		effective.push(outcome);
	}
	// Attach the audit of ignored supersedes onto the returned array (non-enumerable
	// so the array itself stays a plain list for callers).
	Object.defineProperty(effective, "ignored_supersedes", { value: ignored, enumerable: false });
	Object.defineProperty(effective, "legal_correction_ids", { value: [...legalCorrectionIds], enumerable: false });
	return effective;
}

/**
 * Independence summary for a set of Outcomes.
 *
 * A correction NEVER increases the independent count. Counting is by ROOT
 * Outcome of each supersede chain (the outcome no other outcome supersedes in
 * the set) or by an explicit, trusted `provenance.group` when present. An
 * illegal/cyclic correction cannot manufacture a new independent group.
 */
export function independenceOf(outcomes = []) {
	const index = new Map(outcomes.map((outcome) => [outcome.outcome_id, outcome]));
	const supersededIds = new Set();
	// Only a LEGAL correction is counted as a correction and may retire a prior
	// (CLOSE-05 / P1-2). An illegal correction is neither counted nor allowed to
	// manufacture a new independent group.
	const legalCorrectionIds = new Set();
	const illegalCorrectionIds = new Set();
	for (const outcome of outcomes) {
		if (!outcome.supersedes) continue;
		const verdict = classifySupersede(outcome, { byId: index });
		if (verdict.valid) {
			legalCorrectionIds.add(outcome.outcome_id);
			supersededIds.add(outcome.supersedes);
		} else {
			illegalCorrectionIds.add(outcome.outcome_id);
		}
	}
	const groups = new Set();
	for (const outcome of outcomes) {
		// A superseded (non-root) row never founds a new independent group, and an
		// illegal correction is excluded from the group count entirely.
		if (illegalCorrectionIds.has(outcome.outcome_id)) continue;
		if (supersededIds.has(outcome.outcome_id)) continue;
		const explicit = outcome.provenance?.independent === true ? outcome.provenance?.group : null;
		groups.add(explicit ?? `root:${outcome.outcome_id}`);
	}
	return {
		independent_count: groups.size,
		raw_count: outcomes.length,
		corrections: legalCorrectionIds.size,
		invalid_corrections: illegalCorrectionIds.size,
		superseded_ids: [...supersededIds],
	};
}

/**
 * Data-usefulness link (obtain -> use -> advance), contract only in C0.
 *
 * CLOSE-10: usefulness requires a REAL, structurally-identifiable chain, not
 * three truthy values. Each stage must be a structured reference (an object
 * carrying an id/digest), so a bare string or `true` cannot satisfy the link.
 *
 * @param {{[key: string]: any}} args
 */
export function contributionLink({ data_ref, used_by_action, verified_stage_outcome }) {
	const stages = [];
	if (isStructuredRef(data_ref, ["ref_id", "digest", "data_ref"])) stages.push("obtain");
	if (isStructuredRef(used_by_action, ["action_id", "event_digest", "action_ref"])) stages.push("use");
	if (isVerifiedStageOutcome(verified_stage_outcome)) stages.push("advance");
	return {
		data_ref: data_ref ?? null,
		used_by_action: used_by_action ?? null,
		verified_stage_outcome: verified_stage_outcome ?? null,
		stages,
		useful: stages.length === 3,
		// Data is association-only until all three stages are independently present.
		association_only: stages.length < 3,
	};
}

/** True when a value is a structured reference object carrying an identifier. */
function isStructuredRef(value, idKeys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return idKeys.some((key) => typeof value[key] === "string" && value[key].length > 0);
}

/** A verified stage outcome must be a success-stamped, identified Outcome. */
function isVerifiedStageOutcome(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (value.status !== "success") return false;
	return typeof value.outcome_id === "string" && value.outcome_id.length > 0;
}
