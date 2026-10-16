// Aegis Campaign C1 (INT-OUTCOME) — trusted Outcome resolver.
//
// Source permissions are necessary but NOT sufficient: a `campaign.oracle.result`
// must reference a resolvable, fully-bound trusted Outcome. This module reuses the
// C0 binding check (`validateTaskOracleBinding`) and the C0 stage/task aggregation
// so C1 never invents a second, weaker "status === success" judgment.
//
// Trusted evidence in tests is a REAL temporary artifact (a small file with a
// content digest) listed in an artifact index. A fixture/synthetic judgment is
// explicitly labelled. A missing/unresolvable ref, a foreign episode/task/scope,
// a criterion mismatch, or an unresolved conflict yields `unknown`/`invalid`,
// never `success`.

import { digest } from "../shared/contracts.mjs";
import { aggregateStage, aggregateTask, validateTaskOracleBinding } from "./aggregate.mjs";

/**
 * Resolve a task-level Oracle result against the current task, episode, scope and
 * an artifact index.
 *
 * @param {{[key: string]: any}} args
 * @returns {{ok, status, reasons, outcome}}
 */
export function resolveTaskOutcome({
	result,
	task,
	episodeId = null,
	scope = null,
	artifacts = {},
	eventSource = null,
} = {}) {
	const reasons = [];
	if (!result || typeof result !== "object") {
		return { ok: false, status: "unknown", reasons: ["no oracle result"], outcome: null };
	}
	if (!["success", "failure", "unknown", "invalid"].includes(result.status)) {
		return { ok: false, status: "invalid", reasons: [`illegal oracle status ${String(result.status)}`], outcome: null };
	}

	// F2: the committed event's OUTER source must agree with the Outcome's inner
	// provenance. `runtime` records structure/scheduling only; it never produces an
	// Oracle verdict. A payload cannot self-declare `oracle`/`human` trust.
	if (eventSource !== null) {
		const innerSource = result.provenance?.source ?? result.oracle?.source ?? null;
		if (innerSource === null) {
			return { ok: false, status: "unknown", reasons: ["outcome has no inner provenance source"], outcome: null };
		}
		const trusted = ["oracle", "human"];
		if (!trusted.includes(eventSource)) {
			return {
				ok: false,
				status: "invalid",
				reasons: [`event source "${eventSource}" may not produce an Oracle result`],
				outcome: null,
			};
		}
		if (innerSource !== eventSource) {
			return {
				ok: false,
				status: "invalid",
				reasons: [`outcome provenance source "${innerSource}" does not match the event source "${eventSource}"`],
				outcome: null,
			};
		}
	}

	// 1. Structural binding (task/episode/criterion/provenance) via the C0 check.
	const binding = validateTaskOracleBinding({ task, taskOracle: result, episodeId });
	if (!binding.ok) {
		return { ok: false, status: binding.status, reasons: binding.reasons, outcome: null };
	}

	// 2. Scope binding (F10): the CURRENT scope is trusted authority. A missing
	//    current scope is `unknown` authority, NOT a wildcard, so scope validation
	//    is NEVER skipped. A missing Outcome scope is likewise fail-closed. Only a
	//    canonical match of two PRESENT scopes may succeed.
	const outcomeScope = result.scope ?? result.provenance?.scope ?? null;
	if (scope === null || scope === undefined) {
		return {
			ok: false,
			status: "unknown",
			reasons: ["no trusted current scope; scope validation cannot be skipped"],
			outcome: null,
		};
	}
	if (outcomeScope === null || outcomeScope === undefined || canonicalKey(outcomeScope) !== canonicalKey(scope)) {
		return {
			ok: false,
			status: "invalid",
			reasons: ["oracle scope does not match the current scope"],
			outcome: null,
		};
	}

	// 3. Evidence: a `success`/`failure` judgment must reference resolvable
	//    evidence. `unknown` may legitimately carry no evidence. A reference is
	//    resolvable when the artifact index contains it with a content digest.
	if (result.status === "success" || result.status === "failure") {
		const refs = Array.isArray(result.evidence_refs) ? result.evidence_refs : [];
		if (refs.length === 0) {
			return { ok: false, status: "unknown", reasons: ["a trusted judgment requires evidence_refs"], outcome: null };
		}
		const unresolved = refs.filter((ref) => !isResolvableRef(ref, artifacts));
		if (unresolved.length > 0) {
			return {
				ok: false,
				status: "unknown",
				reasons: [`unresolvable evidence ref(s): ${unresolved.map((r) => r?.ref_id ?? String(r)).join(", ")}`],
				outcome: null,
			};
		}
	}

	// 4. A `success` requires an observed value (the Oracle actually saw something).
	if (result.status === "success" && (result.observed === undefined || result.observed === null)) {
		reasons.push("a success judgment requires an observed value");
		return { ok: false, status: "unknown", reasons, outcome: null };
	}

	return { ok: true, status: result.status, reasons: [], outcome: normalizeResolvedOutcome(result, task) };
}

/**
 * Resolve a STAGE-level Outcome against the current task, stage, episode, scope
 * and artifact index (F11). Mirrors `resolveTaskOutcome` but binds to a declared
 * stage/criterion instead of the task goal. Missing episode/scope, non-independent
 * provenance, empty/unresolvable evidence, and a missing `observed` on success
 * are all fail-closed.
 *
 * @param {{[key: string]: any}} args
 * @returns {{ok, status, reasons, outcome}}
 */
export function resolveStageOutcome({
	result,
	task,
	stage,
	episodeId = null,
	scope = null,
	artifacts = {},
	eventSource = null,
} = {}) {
	if (!result || typeof result !== "object")
		return { ok: false, status: "unknown", reasons: ["no stage outcome"], outcome: null };
	if (!["success", "failure", "unknown", "invalid"].includes(result.status)) {
		return { ok: false, status: "invalid", reasons: [`illegal oracle status ${String(result.status)}`], outcome: null };
	}
	if (!stage || typeof stage !== "object")
		return { ok: false, status: "invalid", reasons: ["no declared stage"], outcome: null };

	// F2: outer event source agrees with the inner provenance source.
	if (eventSource !== null) {
		const innerSource = result.provenance?.source ?? null;
		if (innerSource === null)
			return { ok: false, status: "unknown", reasons: ["stage outcome has no inner provenance source"], outcome: null };
		if (!["oracle", "human"].includes(eventSource)) {
			return {
				ok: false,
				status: "invalid",
				reasons: [`event source "${eventSource}" may not judge a stage`],
				outcome: null,
			};
		}
		if (innerSource !== eventSource) {
			return {
				ok: false,
				status: "invalid",
				reasons: [`stage outcome provenance source "${innerSource}" does not match the event source "${eventSource}"`],
				outcome: null,
			};
		}
	}

	// Task binding.
	const outcomeTaskId = result.task_id ?? result.provenance?.task_id ?? null;
	if (outcomeTaskId === null)
		return { ok: false, status: "unknown", reasons: ["stage outcome is missing its task_id binding"], outcome: null };
	if (outcomeTaskId !== task?.task_id)
		return {
			ok: false,
			status: "invalid",
			reasons: [`stage outcome belongs to ${outcomeTaskId}, not ${task?.task_id}`],
			outcome: null,
		};

	// Episode binding: REQUIRED, and must match the current task episode.
	const outcomeEpisode = result.episode_id ?? null;
	if (outcomeEpisode === null || episodeId === null || outcomeEpisode !== episodeId) {
		return {
			ok: false,
			status: "invalid",
			reasons: ["stage outcome episode does not match the current task episode"],
			outcome: null,
		};
	}

	// Criterion binding.
	const criterionId = result.criterion?.criterion_id ?? result.criterion_id ?? null;
	if (criterionId === null || !(stage.criteria ?? []).includes(criterionId)) {
		return {
			ok: false,
			status: "invalid",
			reasons: [`stage outcome criterion ${String(criterionId)} is not declared by stage ${stage.stage_id}`],
			outcome: null,
		};
	}

	// F14: independent provenance must be explicitly PRESENT and true. A missing or
	// null provenance block is not "unchecked": it is unknown authority, and an
	// inner `oracle.source` alone does not supply independent-judgment rights.
	const provenance = result.provenance;
	if (!provenance || typeof provenance !== "object") {
		return { ok: false, status: "unknown", reasons: ["stage outcome has no independent provenance"], outcome: null };
	}
	if (provenance.independent !== true) {
		return { ok: false, status: "invalid", reasons: ["stage outcome provenance is not independent"], outcome: null };
	}

	// F14: the Outcome's OWN stage binding, when present, must match the declared
	// stage. Canonicalization must never relabel a foreign Stage Outcome as the
	// current Stage success.
	const declaredStageId = stage.stage_id ?? stage.stageId ?? null;
	const innerStageId = result.step_id ?? result.stage_id ?? null;
	if (innerStageId !== null && declaredStageId !== null && innerStageId !== declaredStageId) {
		return {
			ok: false,
			status: "invalid",
			reasons: [`stage outcome is bound to ${innerStageId}, not the declared stage ${declaredStageId}`],
			outcome: null,
		};
	}

	// Scope binding (F10/F11): a missing current scope never disables the check.
	const outcomeScope = result.scope ?? result.provenance?.scope ?? null;
	if (scope === null || scope === undefined) {
		return { ok: false, status: "unknown", reasons: ["no trusted current scope for the stage"], outcome: null };
	}
	if (outcomeScope === null || outcomeScope === undefined || canonicalKey(outcomeScope) !== canonicalKey(scope)) {
		return {
			ok: false,
			status: "invalid",
			reasons: ["stage outcome scope does not match the current scope"],
			outcome: null,
		};
	}

	// Evidence: a success/failure judgment needs non-empty, resolvable evidence.
	if (result.status === "success" || result.status === "failure") {
		const refs = Array.isArray(result.evidence_refs) ? result.evidence_refs : [];
		if (refs.length === 0)
			return {
				ok: false,
				status: "unknown",
				reasons: ["a trusted stage judgment requires evidence_refs"],
				outcome: null,
			};
		const unresolved = refs.filter((ref) => !isResolvableRef(ref, artifacts));
		if (unresolved.length > 0) {
			return {
				ok: false,
				status: "unknown",
				reasons: [`unresolvable stage evidence ref(s): ${unresolved.map((r) => r?.ref_id ?? String(r)).join(", ")}`],
				outcome: null,
			};
		}
	}
	// A success requires an observed value.
	if (result.status === "success" && (result.observed === undefined || result.observed === null)) {
		return {
			ok: false,
			status: "unknown",
			reasons: ["a success stage judgment requires an observed value"],
			outcome: null,
		};
	}
	// A success whose structured observed value CONTRADICTS a machine-checkable
	// criterion is internally inconsistent: it is not a judgment of this criterion.
	if (result.status === "success") {
		const check = checkStructuredCriterion(criterionId, result.observed);
		if (check.checked && !check.satisfied)
			return {
				ok: false,
				status: "invalid",
				reasons: [`criterion_contradiction: observed ${check.detail} does not satisfy "${criterionId}"`],
				outcome: null,
			};
	}
	return { ok: true, status: result.status, reasons: [], outcome: normalizeResolvedOutcome(result, task) };
}

/**
 * Check the registered machine-checkable criterion forms against a structured
 * observed value. Free-form criteria are not parsed (the Oracle owns them):
 *   * `data.<field> == <string>` / `data.<field> is <string>`
 *   * `door.locked == true|false` / `state.locked == true|false`
 *
 * @param {string|null} criterionId
 * @param {any} observed
 * @returns {{checked: boolean, satisfied: boolean, detail: string|null}}
 */
export function checkStructuredCriterion(criterionId, observed) {
	const text = String(criterionId ?? "").trim();
	const data = /^data\.([A-Za-z0-9_]+)\s+(?:==|is)\s+(.+)$/.exec(text);
	const lock = /^(?:door|state)\.locked == (true|false)$/.exec(text);
	if (!data && !lock) return { checked: false, satisfied: true, detail: null };
	// Only a value that NAMES the criterion field can contradict it; an observed
	// value that does not mention the field is left to the Oracle's judgment.
	if (!observed || typeof observed !== "object" || Array.isArray(observed))
		return { checked: false, satisfied: true, detail: null };
	const field = data ? data[1] : "locked";
	const expected = data ? data[2].replace(/^["']|["']$/g, "") : lock[1] === "true";
	const holder = Object.hasOwn(observed, field)
		? observed
		: observed.state && typeof observed.state === "object" && Object.hasOwn(observed.state, field)
			? observed.state
			: null;
	if (!holder) return { checked: false, satisfied: true, detail: null };
	return { checked: true, satisfied: holder[field] === expected, detail: `${field}=${JSON.stringify(holder[field])}` };
}

/**
 * Resolve a whole task from its stage Outcomes plus the task-level Outcome,
 * reusing C0 aggregation. `task.stages` defines the required stages/criteria.
 *
 * @param {any} args
 */
export function resolveTaskFromOutcomes({
	task,
	stageResults = [],
	taskResult = null,
	episodeId = null,
	scope = null,
	artifacts = {},
	eventSource = null,
} = {}) {
	const stageAggregates = [];
	const stageRejections = [];
	for (const stage of task?.stages ?? []) {
		const declared = {
			stage_id: stage.stage_id,
			criteria: stage.criteria ?? [],
		};
		const candidates = stageResults.filter((o) => o?.step_id === stage.stage_id || o?.stage_id === stage.stage_id);
		// F11: each candidate must pass the full stage binding before it can enter
		// the aggregation. A rejected (foreign/missing-scope/missing-episode/etc.)
		// stage Outcome contributes NOTHING.
		const validStageOutcomes = [];
		for (const candidate of candidates) {
			const verdict = resolveStageOutcome({
				result: candidate,
				task,
				stage: declared,
				episodeId,
				scope,
				artifacts,
				eventSource,
			});
			if (verdict.ok) validStageOutcomes.push(candidate);
			else
				stageRejections.push({
					stage_id: stage.stage_id,
					outcome_id: candidate?.outcome_id ?? null,
					reason: verdict.reasons.join("; "),
				});
		}
		const agg = aggregateStage({
			stage: {
				stage_id: stage.stage_id,
				task_id: task.task_id,
				required: stage.required !== false,
				criterion_ids: stage.criteria ?? [],
			},
			outcomes: validStageOutcomes,
		});
		stageAggregates.push(agg);
	}
	let taskOracle = null;
	if (taskResult) {
		const verdict = resolveTaskOutcome({ result: taskResult, task, episodeId, scope, artifacts, eventSource });
		if (!verdict.ok) {
			return {
				status: verdict.status,
				reasons: verdict.reasons,
				stage_aggregates: stageAggregates,
				stage_rejections: stageRejections,
			};
		}
		taskOracle = verdict.outcome;
	}
	const aggregate = aggregateTask({ task, stages: stageAggregates, taskOracle, episodeId });
	return { ...aggregate, stage_aggregates: stageAggregates, stage_rejections: stageRejections };
}

function normalizeResolvedOutcome(result, task) {
	return {
		outcome_id: result.outcome_id ?? null,
		task_id: task?.task_id ?? null,
		episode_id: result.episode_id ?? null,
		level: result.level ?? (result.task_oracle ? "episode" : "step"),
		status: result.status,
		criterion: result.criterion ?? { criterion_id: result.criterion_id ?? null },
		observed: result.observed ?? null,
		scope: result.scope ?? result.provenance?.scope ?? null,
		oracle: result.oracle ?? null,
		provenance: result.provenance ?? null,
		evidence_refs: Array.isArray(result.evidence_refs) ? result.evidence_refs : [],
		task_oracle: result.task_oracle === true,
	};
}

/** A ref is resolvable when the artifact index carries it with a content digest. */
export function isResolvableRef(ref, artifacts) {
	if (!ref || typeof ref !== "object") return false;
	const id = ref.ref_id ?? ref.ref;
	if (typeof id !== "string" || id.length === 0) return false;
	const entry = artifacts?.[id];
	if (!entry) return false;
	if (typeof entry.digest !== "string" || entry.digest.length === 0) return false;
	// When the ref carries its own digest, it must match the indexed artifact.
	if (typeof ref.digest === "string" && ref.digest.length > 0 && ref.digest !== entry.digest) return false;
	return true;
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
 * Content digest of a real artifact's bytes. Reuses the existing SHA256 helper
 * (`digest` from the fixture contracts) so this stays consistent with the rest of
 * the runtime. This harness stubs crypto to a placeholder, so tests assert
 * cross-path equality, never a hard-coded real hash.
 */
export function contentDigest(content) {
	const text = typeof content === "string" ? content : JSON.stringify(content ?? null);
	return digest(text);
}
