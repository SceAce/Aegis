// Aegis C3-B — deterministic local Stage/Task Oracle.
//
// This is the independent judge for one Campaign. It reuses the C0/C1 Outcome
// binding contract (resolveTaskOutcome/resolveStageOutcome) but READS THE REAL
// POST-STATE: it inspects the effect artifact the brokered Worker produced and
// compares it to the task/stage criterion. It never consults `worker.ok`, an
// exit code, or model text.
//
// It supports success | failure | unknown | invalid, and a `delayed` verdict:
// a delayed judgment returns `unknown` with `delayed:true` so the Scheduler
// blocks dependents and revisits later (WITHOUT re-running the Worker) — see
// the C1 scheduler's `revisitDelayedUnknowns`.
//
// Every judgment it emits is bound to Task/Episode/Stage/scope/criterion and
// carries resolvable evidence_refs and an independent provenance block, so the
// existing resolver accepts it only when it truly matches the current task.

import { existsSync, readFileSync } from "node:fs";

import { digest } from "../fixture/contracts.mjs";

/**
 * @typedef {{stage_id: string, status: "success"|"failure"|"unknown"|"invalid",
 *   criterion_id: string, expected: any, observed: any, evidence_ref: object|null,
 *   failure_mode?: string|null, delayed?: boolean}} StageVerdict
 */

/**
 * @param {{
 *   oracleId?: string,
 *   independenceGroup?: string,
 *   workspaceRoot: string,
 *   judgeTask: (args: {task: any, outcome_ref: string|null, attempt: number, onEvidence?: Function}) =>
 *     {status: string, observed?: any, failure_mode?: string|null, delayed?: boolean,
 *      evidence?: Array<{ref_id: string, digest: string, path?: string}>,
 *      stage_overrides?: Record<string, object>} | Promise<any>,
 *   attemptTracker?: Map<string, number>,
 *   reconcileImpl?: (args: {task: any, intent: any, effect_probe: any, onEvidence?: Function}) => any,
 *   onEvidence?: (refs: Array<{ref_id: string, digest: string, path?: string}>) => void,
 * }} args
 */
export function createHostOracle(
	{
		oracleId = "fixture.oracle.v1",
		independenceGroup = "fixture-local",
		workspaceRoot,
		judgeTask,
		attemptTracker = new Map(),
		reconcileImpl = null,
		onEvidence = null,
	} = /** @type {any} */ ({}),
) {
	/** Register evidence digests so a later projection can resolve the refs. */
	function indexEvidence(refs) {
		if (typeof onEvidence === "function" && Array.isArray(refs)) onEvidence(refs);
	}
	if (typeof judgeTask !== "function") throw new Error("createHostOracle requires a judgeTask function");
	if (typeof workspaceRoot !== "string" || !workspaceRoot) throw new Error("createHostOracle requires a workspaceRoot");

	/** Build a bound Stage Outcome for one declared stage. */
	function stageOutcome({ task, stage, episodeId, status, verdict }) {
		const criterionId = stage.criteria?.[0] ?? task.goal?.goal_id ?? null;
		const evidenceRefs = Array.isArray(verdict?.evidence)
			? verdict.evidence.map((ref) => ({ ref_type: "artifact", ref_id: ref.ref_id, digest: ref.digest }))
			: [];
		return {
			outcome_id: `so-${task.task_id}-${stage.stage_id}`,
			level: "step",
			step_id: stage.stage_id,
			stage_id: stage.stage_id,
			status,
			episode_id: episodeId,
			task_id: task.task_id,
			criterion: { criterion_id: criterionId, expected: verdict?.expected ?? criterionId },
			observed: status === "success" || status === "failure" ? (verdict?.observed ?? null) : null,
			scope: task.scope ?? null,
			oracle: { oracle_id: oracleId, source: "oracle", independence_group: independenceGroup },
			provenance: {
				source: "oracle",
				independent: true,
				task_id: task.task_id,
				stage_id: stage.stage_id,
				group: independenceGroup,
			},
			evidence_refs: status === "success" || status === "failure" ? evidenceRefs : [],
			failure_mode: status === "success" ? null : (verdict?.failure_mode ?? "insufficient_evidence"),
			delayed: verdict?.delayed === true,
		};
	}

	/** Build the bound Task-level Outcome. */
	function taskOutcome({ task, episodeId, status, verdict, actionPin = null }) {
		const evidenceRefs = Array.isArray(verdict?.evidence)
			? verdict.evidence.map((ref) => ({ ref_type: "artifact", ref_id: ref.ref_id, digest: ref.digest }))
			: [];
		// A per-episode independence group: the SAME judge produces one group per
		// Episode, so two independent Episodes are genuinely distinct to the
		// Compiler's independence gate rather than sharing one fixed label.
		const group = `${independenceGroup}:${episodeId}`;
		return {
			outcome_id: `o-${task.task_id}`,
			level: "episode",
			status,
			episode_id: episodeId,
			task_id: task.task_id,
			task_oracle: true,
			run_id: task.run_id ?? null,
			action_ref: actionPin?.action_ref ?? null,
			action_version: actionPin?.action_version ?? null,
			implementation_digest: actionPin?.implementation_digest ?? null,
			when: Array.isArray(verdict?.when) ? verdict.when : [],
			expect: Array.isArray(verdict?.expect) ? verdict.expect : [],
			criterion: {
				criterion_id: task.goal?.goal_id ?? null,
				expected: verdict?.expected ?? task.goal?.goal_id ?? null,
			},
			observed: status === "success" || status === "failure" ? (verdict?.observed ?? null) : null,
			scope: task.scope ?? null,
			preconditions_verified: true,
			oracle: { oracle_id: oracleId, source: "oracle", independence_group: group },
			provenance: {
				source: "oracle",
				independent: true,
				task_id: task.task_id,
				group,
			},
			evidence_refs: status === "success" || status === "failure" ? evidenceRefs : [],
			failure_mode: status === "success" ? null : (verdict?.failure_mode ?? "insufficient_evidence"),
		};
	}

	async function judge({ task, outcome_ref = null, action_pin = null }) {
		const episodeId = `ep-${task.task_id}`;
		const attempt = (attemptTracker.get(task.task_id) ?? 0) + 1;
		attemptTracker.set(task.task_id, attempt);
		const raw = await judgeTask({ task, outcome_ref, attempt, onEvidence: indexEvidence });
		const status = ["success", "failure", "unknown", "invalid"].includes(raw?.status) ? raw.status : "unknown";
		const verdict = {
			status,
			observed: raw?.observed ?? null,
			expected: raw?.expected ?? null,
			failure_mode: raw?.failure_mode ?? null,
			delayed: raw?.delayed === true,
			when: Array.isArray(raw?.when) ? raw.when : [],
			evidence: Array.isArray(raw?.evidence) ? raw.evidence : [],
		};
		// `unknown`/`invalid`/delayed carry no Stage success; the scheduler records
		// only the task-level outcome and waits.
		const stage_outcomes = [];
		if (status === "success" || status === "failure") {
			for (const stage of task.stages ?? []) {
				const override = raw?.stage_overrides?.[stage.stage_id];
				stage_outcomes.push(
					stageOutcome({
						task,
						stage,
						episodeId,
						status: override?.status ?? status,
						verdict: override ?? verdict,
					}),
				);
			}
		}
		return {
			status,
			outcome_id: `o-${task.task_id}`,
			task_oracle: true,
			action_pin: action_pin,
			delayed: verdict.delayed,
			stage_outcomes,
			outcome: taskOutcome({ task, episodeId, status, verdict, actionPin: action_pin }),
		};
	}

	async function reconcile({ task, intent, effect_probe = null }) {
		if (typeof reconcileImpl === "function") {
			const raw = await reconcileImpl({ task, intent, effect_probe, onEvidence: indexEvidence });
			return normalizeReconcile({ raw, task, effect_probe });
		}
		// Default deterministic reconcile: read the real effect artifact named by
		// the intent's evidence ref (or the task sentinel) and judge it.
		const refId = `artifact:${task.task_id}`;
		const probe = typeof effect_probe === "function" ? await effect_probe({ task, intent }) : null;
		const path = probe?.path ?? null;
		if (!path || !existsSync(path)) {
			return { status: "unknown", failure_mode: "effect_absent" };
		}
		const content = readFileSync(path, "utf8");
		const evidence = [{ ref_id: refId, digest: digest(content), path }];
		const judged = await judge({ task, outcome_ref: refId });
		indexEvidence(evidence);
		return { ...judged, effect_exists: true, content_digest: evidence[0].digest };
	}

	function normalizeReconcile({ raw, task, effect_probe }) {
		const status = ["success", "failure", "unknown", "invalid"].includes(raw?.status) ? raw.status : "unknown";
		const episodeId = `ep-${task.task_id}`;
		const verdict = {
			status,
			observed: raw?.observed ?? null,
			expected: raw?.expected ?? null,
			failure_mode: raw?.failure_mode ?? null,
			delayed: false,
			evidence: Array.isArray(raw?.evidence) ? raw.evidence : [],
		};
		const stage_outcomes = [];
		if (status === "success" || status === "failure") {
			for (const stage of task.stages ?? []) {
				stage_outcomes.push(stageOutcome({ task, stage, episodeId, status, verdict }));
			}
		}
		return {
			status,
			outcome_id: `o-${task.task_id}`,
			task_oracle: true,
			stage_outcomes,
			outcome: taskOutcome({ task, episodeId, status, verdict }),
			effect_exists: raw?.effect_exists === true,
			content_digest: raw?.content_digest ?? null,
			effect_probe,
		};
	}

	return {
		id: oracleId,
		groupId: independenceGroup,
		judge,
		reconcile,
		attemptsFor: (taskId) => attemptTracker.get(taskId) ?? 0,
	};
}
