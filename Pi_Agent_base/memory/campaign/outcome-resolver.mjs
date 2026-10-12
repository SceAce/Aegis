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

import { digest } from "../fixture/contracts.mjs";
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

	// 2. Scope binding: when the caller supplies the current scope, the outcome's
	//    scope must match canonically. A missing scope on either side is not a
	//    match (fail-closed).
	if (scope !== null) {
		const outcomeScope = result.scope ?? result.provenance?.scope ?? null;
		if (outcomeScope === null || canonicalKey(outcomeScope) !== canonicalKey(scope)) {
			return {
				ok: false,
				status: "invalid",
				reasons: ["oracle scope does not match the current scope"],
				outcome: null,
			};
		}
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
	for (const stage of task?.stages ?? []) {
		const stageOutcomes = stageResults.filter((o) => o?.step_id === stage.stage_id || o?.stage_id === stage.stage_id);
		const agg = aggregateStage({
			stage: {
				stage_id: stage.stage_id,
				task_id: task.task_id,
				required: stage.required !== false,
				criterion_ids: stage.criteria ?? [],
			},
			outcomes: stageOutcomes,
		});
		stageAggregates.push(agg);
	}
	let taskOracle = null;
	if (taskResult) {
		const verdict = resolveTaskOutcome({ result: taskResult, task, episodeId, scope, artifacts, eventSource });
		if (!verdict.ok) {
			return { status: verdict.status, reasons: verdict.reasons, stage_aggregates: stageAggregates };
		}
		taskOracle = verdict.outcome;
	}
	const aggregate = aggregateTask({ task, stages: stageAggregates, taskOracle, episodeId });
	return { ...aggregate, stage_aggregates: stageAggregates };
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
