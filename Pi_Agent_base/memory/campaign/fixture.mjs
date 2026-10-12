// Deterministic fixture Campaign (C0).
//
// A tiny, fully offline Campaign used to exercise the contract layer:
//   * two tasks with a dependency (task-002 depends on task-001);
//   * at least two stages in one task;
//   * one successful stage and one `unknown`/delayed Oracle case;
//   * NO network, credentials, remote targets, or real model calls.
//
// The fixture uses a deterministic id factory (a counter), so two builds produce
// byte-identical manifests. This is the ONLY id source C0 fixtures use.

import { newCampaignId, newEpisodeId, newSessionId, newStageId, newTaskId } from "./identifiers.mjs";
import {
	CAMPAIGN_SCHEMA_VERSION,
	canonicalManifestDigest,
	persistImmutableManifest,
	validateManifest,
} from "./manifest.mjs";

export const FIXTURE_CREATED_AT = "2026-01-01T00:00:00Z";

/**
 * The deterministic fixture environment scope. Tasks and their Outcomes share
 * this declared scope so a trusted judgment can match it (F10). It is a
 * synthetic fixture environment, NOT a real target.
 */
export const FIXTURE_SCOPE = Object.freeze({ environment_fingerprint: "fixture-env", domain: "fixture" });

/** Deterministic id factory: prefix + zero-padded counter. */
export function deterministicIdFactory(seed = 0) {
	let counter = seed;
	return () => {
		counter += 1;
		return String(counter).padStart(6, "0");
	};
}

/**
 * Build the fixture Campaign. Returns the Manifest plus the stage/oracle case
 * descriptions a test can assert against. Pure and deterministic.
 * @param {{[key: string]: any}} args
 */
export function buildFixtureCampaign({
	workspaceRoot = "/tmp/aegis-fixture-workspace",
	make = deterministicIdFactory(),
} = {}) {
	const campaignId = newCampaignId(make);
	const task1 = newTaskId(make);
	const task2 = newTaskId(make);
	const stageObserve = newStageId(make);
	const stageSolve = newStageId(make);
	const stageVerify = newStageId(make);

	const manifest = {
		schema_version: CAMPAIGN_SCHEMA_VERSION,
		campaign_id: campaignId,
		revision: 1,
		created_at: FIXTURE_CREATED_AT,
		title: "fixture two-task campaign",
		objective: {
			description: "Deterministic offline fixture Campaign; never a real target.",
			success_criteria: ["task-001 stage-observe verified", "task-002 verified or explicitly unknown"],
			stage_policy: "declared_only",
		},
		worker: {
			provider: "fixture",
			model: "deterministic-no-model",
			pi_build_id: "fixture",
			rom_digest: "sha256:fixture-rom",
			tool_schema_digest: "sha256:fixture-tools",
		},
		authorization: {
			execution_profile: "supervised-macos-workspace",
			workspace_root: workspaceRoot,
			allowed_targets: ["fixture/door.json"],
			allowed_capabilities: ["fixture.observe", "fixture.unlock"],
			network: "disabled",
			credentials: "none",
			human_approval: "campaign_grant",
			workspace_is_sandbox: false,
		},
		budget: {
			wall_time_ms: 600000,
			model_requests: 100,
			tool_calls: 200,
			task_count: 4,
			session_count: 20,
		},
		session_policy: {
			max_requests_per_session: 10,
			max_context_chars: 20000,
			rotate_at_stage_boundary: true,
			rotate_on_model_request: true,
			allow_model_handoff_request: true,
		},
		adapters: {
			execution: "workspace.exec.v1",
			oracle: "fixture.oracle.v1",
			report: "aegis-acceptance.v1",
		},
		tasks: [
			{
				task_id: task1,
				order: 1,
				depends_on: [],
				target_ref: "fixture/door.json",
				task_type: "verify",
				scope: { ...FIXTURE_SCOPE },
				goal: {
					goal_id: "unlock_fixture",
					description: "Observe then unlock the fixture door.",
					success_criteria: ["door.locked observed true", "door.locked verified false"],
				},
				stages: [
					{ stage_id: stageObserve, criteria: ["door.locked == true"], required: true },
					{ stage_id: stageSolve, criteria: ["door.locked == false"], required: true },
				],
				oracle_ref: "fixture.oracle.v1",
				task_budget: { wall_time_ms: 120000, model_requests: 20, tool_calls: 40 },
			},
			{
				task_id: task2,
				order: 2,
				depends_on: [task1],
				target_ref: "fixture/door.json",
				task_type: "reproduce",
				scope: { ...FIXTURE_SCOPE },
				goal: {
					goal_id: "verify_fixture",
					description: "Reproduce the observed door state.",
					success_criteria: ["door state reproduced"],
				},
				stages: [{ stage_id: stageVerify, criteria: ["door state reproduced"], required: true }],
				oracle_ref: "fixture.oracle.v1",
				task_budget: { wall_time_ms: 120000, model_requests: 20, tool_calls: 40 },
			},
		],
		dynamic_task_policy: {
			enabled: true,
			allowed_task_types: ["observe", "verify"],
			max_depth: 2,
			max_fan_out: 2,
			max_task_count: 4,
			required_stop_condition: "no remaining authorized target or budget",
			allow_new_target: false,
			allow_new_capability: false,
			allow_new_adapter: false,
			allow_network: false,
			allow_credentials: false,
			allow_budget_increase: false,
		},
		evidence_policy: {
			independent_result_required: true,
			unknown_is_not_failure: true,
			promote_experience: false,
		},
	};

	// The fixture's Oracle case descriptions: one success, one unknown/delayed.
	const oracleCases = {
		[task1]: {
			stages: {
				[stageObserve]: { status: "success", criterion: "door.locked == true", observed: { locked: true } },
				[stageSolve]: { status: "success", criterion: "door.locked == false", observed: { locked: false } },
			},
			task: { status: "success", criterion: "door.locked verified false", observed: { locked: false } },
		},
		[task2]: {
			stages: {
				[stageVerify]: {
					status: "unknown",
					criterion: "door state reproduced",
					observed: null,
					failure_mode: "insufficient_evidence",
					delayed: true,
				},
			},
			task: {
				status: "unknown",
				criterion: "door state reproduced",
				observed: null,
				failure_mode: "insufficient_evidence",
			},
		},
	};

	return {
		manifest,
		ids: {
			campaign_id: campaignId,
			task_ids: [task1, task2],
			stage_ids: [stageObserve, stageSolve, stageVerify],
			episode_id: newEpisodeId(make),
			session_id: newSessionId(make),
		},
		oracleCases,
		depends_on: { [task2]: [task1] },
	};
}

/**
 * Materialize deterministic Oracle Outcome rows for the fixture, so aggregation
 * tests have concrete Outcomes without any real Oracle. The `unknown` task stays
 * `unknown` and is NEVER recorded as a failure.
 * @param {{[key: string]: any}} args
 */
export function fixtureOutcomes({ fixture, make = deterministicIdFactory(1000) } = {}) {
	const { manifest, oracleCases } = fixture;
	const outcomes = [];
	for (const task of manifest.tasks) {
		const cases = oracleCases[task.task_id];
		if (!cases) continue;
		for (const stage of task.stages) {
			const entry = cases.stages[stage.stage_id];
			if (!entry) continue;
			outcomes.push(
				makeOutcome({
					make,
					task_id: task.task_id,
					stage_id: stage.stage_id,
					criterion_id: stage.criteria[0],
					...entry,
				}),
			);
		}
		if (cases.task) {
			outcomes.push(
				makeOutcome({
					make,
					task_id: task.task_id,
					stage_id: null,
					criterion_id: task.goal.goal_id,
					level: "task",
					...cases.task,
				}),
			);
		}
	}
	return outcomes;
}

function makeOutcome({
	make,
	task_id,
	stage_id,
	criterion_id,
	status,
	criterion,
	observed,
	failure_mode = null,
	level = "stage",
	delayed = false,
}) {
	const outcome_id = `out_${make()}`;
	return {
		schema_version: "1.0",
		outcome_id,
		level: level === "task" ? "episode" : "step",
		episode_id: `ep_fixture_${task_id}`,
		...(stage_id ? { step_id: stage_id } : {}),
		status,
		criterion: { criterion_id, description: criterion, expected: criterion },
		observed: observed ?? null,
		scope: { ...FIXTURE_SCOPE },
		oracle: {
			oracle_id: "fixture.oracle.v1",
			method: "deterministic_state_check",
			version: "1.0.0",
			independence_group: "fixture-local",
		},
		evidence_refs: status === "unknown" ? [] : [{ ref_type: "artifact", ref_id: `artifact_${outcome_id}` }],
		transport: { tool_ok: true, exit_code: 0, timed_out: false, duration_ms: 1 },
		failure_mode: status === "success" ? null : failure_mode,
		// C0 fixture: NO real execution and NO replay adapter exist, so a successful
		// fixture Outcome is explicitly NOT replayable. It must never be used to
		// justify an Experience promotion or an independent-learning claim.
		reproducibility: { replayable: false, replay_hash: null, replay_count: 0, checked_at: FIXTURE_CREATED_AT },
		assessed_at: FIXTURE_CREATED_AT,
		provenance: {
			source: "oracle",
			independent: true,
			task_id,
			...(stage_id ? { stage_id } : {}),
			delayed,
			// All fixture Outcomes share ONE local group: they are NOT multiple
			// independent pieces of evidence and must not be counted as such.
			group: "fixture-local",
			fixture_only: true,
		},
	};
}

/** Validate + persist the fixture Manifest immutably under `dir`. */
export async function persistFixtureCampaign(fixture, dir) {
	const validation = validateManifest(fixture.manifest);
	if (!validation.ok) return { ok: false, reasons: validation.reasons };
	const persisted = await persistImmutableManifest(fixture.manifest, dir);
	return {
		ok: persisted.ok,
		reasons: persisted.ok ? [] : [persisted.reason],
		digest: persisted.digest,
		path: persisted.path,
	};
}

export { canonicalManifestDigest };
