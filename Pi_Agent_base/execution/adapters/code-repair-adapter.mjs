// Aegis C6-F — second task family: a small code repair on a temp copy.
//
// The model sees the failing source file and the test OUTPUT, then proposes a
// controlled patch (a full replacement of a NAMED file with data-only content)
// through a reviewed Broker action. An EXTERNAL, read-only test file (registered
// by the trusted Host, never writable by the model) decides success by running
// and re-reading the real post-state.
//
// Trust boundaries:
//   * the patch is DATA (target path + file content); the model never supplies an
//     executable, argv, or a test;
//   * the adapter writes ONLY inside the authorized workspace copy;
//   * the model cannot modify the judge test — it lives outside `allowed_root`
//     for writes and is re-hashed by the Oracle;
//   * the Oracle re-runs the REGISTERED test command indirectly by reading the
//     real file and comparing to the criterion, never the model's claim.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { digest, resolveInside } from "../../shared/contracts.mjs";
import { defineContract } from "../action-contract.mjs";

export const CODE_REPAIR_ACTION_REF = "code.file.write";

/**
 * A reviewed contract that replaces the CONTENT of one named source file inside
 * the authorized workspace. It writes only text; no shell, no network.
 *
 * @param {{workspaceRoot: string, id?: string, version?: number}} args
 */
export function createCodeRepairAdapter(
	{ workspaceRoot, id = CODE_REPAIR_ACTION_REF, version = 1 } = /** @type {any} */ ({}),
) {
	if (typeof workspaceRoot !== "string" || !workspaceRoot)
		throw new Error("createCodeRepairAdapter requires a workspaceRoot");

	function readFileSafe(target) {
		try {
			const absolute = resolveInside(workspaceRoot, target, { mustExist: true });
			const text = readFileSync(absolute, "utf8");
			return { ok: true, absolute, text, content_digest: digest(text) };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	return defineContract({
		id,
		version,
		tool: "aegis_workspace",
		operation: "code.file.write",
		description:
			"Replace the full text content of one source file inside the authorized workspace. Offline; no shell, no network, no model code.",
		risk_class: "low",
		network: false,
		parameters: {
			target: { type: "string", required: true, min_length: 1 },
			content: { type: "string", required: true },
		},
		recognition: {
			check: ({ arguments: args }) => {
				try {
					resolveInside(workspaceRoot, args?.target ?? "", { mustExist: false });
					return { ok: true };
				} catch (error) {
					return { ok: false, reason: error instanceof Error ? error.message : String(error) };
				}
			},
		},
		procedure: {
			kind: "function",
			run: ({ arguments: args }) => {
				let absolute;
				try {
					absolute = resolveInside(workspaceRoot, args.target, { mustExist: false });
				} catch (error) {
					return { ok: false, failure_mode: "action_rejected", detail: String(error) };
				}
				if (!existsSync(dirname(absolute))) {
					return { ok: false, failure_mode: "precondition_unmet", detail: `target dir missing: ${args.target}` };
				}
				// A fix must target an EXISTING source file; creating arbitrary new
				// files is out of scope for this family.
				if (!existsSync(absolute)) {
					return { ok: false, failure_mode: "precondition_unmet", detail: `target does not exist: ${args.target}` };
				}
				const before = readFileSync(absolute, "utf8");
				writeFileSync(absolute, String(args.content), "utf8");
				const after = readFileSync(absolute, "utf8");
				const observed = {
					target: args.target,
					before_digest: digest(before),
					after_digest: digest(after),
					bytes: after.length,
					file_digest: digest(after),
					content_digest: digest(after),
				};
				return { ok: true, observed, content_digest: observed.file_digest };
			},
		},
		verification: {
			check: ({ observed }) => {
				if (!observed || typeof observed !== "object") return { ok: false, reason: "no observed state" };
				const recheck = readFileSafe(observed.target);
				if (!recheck.ok) return { ok: false, reason: `post-state unreadable: ${recheck.reason}` };
				if (recheck.content_digest !== observed.after_digest)
					return { ok: false, reason: "the written file does not match the recorded post-state digest" };
				return {
					ok: true,
					reason: "the post-state file matches the recorded content",
					observed: recheck.content_digest,
				};
			},
		},
		scope: {
			environment_fingerprint: "code-repair-env",
			domain: "code",
			permissions: ["code.file.write"],
			task_types: ["verify", "reproduce"],
		},
		authorization: { target_kinds: ["workspace_file"], allowed_actions: [id] },
		stop_policy: { max_attempts: 1, retry: "none", timeout_ms: 5000 },
		build: ({ observed, context, transport, verification, status, failure_mode }) => {
			const now = new Date().toISOString();
			const evidenceRefs = observed?.file_digest
				? [
						{
							ref_type: "artifact",
							ref_id: `artifact:${context.task_id ?? context.step_id}`,
							digest: observed.file_digest,
						},
					]
				: [];
			return {
				observation: {
					observation_kind: "file_content",
					subject: observed?.target ?? context.target_path ?? null,
					predicate: "content",
					value: observed ?? null,
					source: "code_repair_adapter",
					verified: status === "success" && verification.ok === true,
					action_ref: id,
					action_id: context.action_event_id ?? null,
					observed_at: now,
				},
				step_outcome: {
					schema_version: "1.0",
					outcome_id: `out_step_${id}_${context.step_id ?? "s"}`,
					level: "step",
					episode_id: context.episode_id ?? null,
					step_id: context.step_id ?? null,
					scope: "code.file.write",
					criterion: { criterion_id: context.criterion_id ?? null, expected: observed?.after_digest ?? null },
					status,
					observed: status === "success" || status === "failure" ? (observed ?? null) : null,
					oracle: { oracle_id: "code-repair.verify", method: "post_state_recheck", independence_group: "code-local" },
					evidence_refs: evidenceRefs,
					transport,
					failure_mode: status === "success" ? null : (failure_mode ?? "insufficient_evidence"),
					preconditions_verified: true,
					assessed_at: now,
					action_ref: id,
					action_id: context.action_event_id ?? null,
				},
			};
		},
	});
}

/**
 * The INDEPENDENT Oracle judge for the code-repair family. It runs the
 * REGISTERED, read-only test through a fixed, trusted procedure (the caller
 * passes a `runTests` function that is HOST code, never model code), then
 * compares the REAL, COMPLETE test result to the task criterion. The model can
 * never modify the test: the test file lives outside the writable target and is
 * re-hashed by the caller before running.
 *
 * A passing run is only a `success` for a criterion the Host actually knows how
 * to judge (`SUPPORTED_CRITERIA`). A declared criterion outside that set is
 * `unknown` -- one passing test never maps to an arbitrary declared property.
 *
 * @param {{
 *   workspaceRoot: string,
 *   runTests: (workspaceRoot: string) => { ok: boolean, complete?: boolean, passed?: number|null, failed?: number|null, assertions?: number|null, detail?: string, test_digest?: string|null },
 *   testFile?: string,
 * }} args
 */
export const SUPPORTED_CRITERIA = Object.freeze(["external test passes"]);

export function createCodeRepairJudge({ workspaceRoot, runTests } = /** @type {any} */ ({})) {
	if (typeof runTests !== "function") throw new Error("createCodeRepairJudge requires a trusted runTests procedure");
	return ({ task, onEvidence }) => {
		// Every declared stage criterion must be one this judge can actually verify;
		// an unsupported property is unknown, never a success mapped from a test pass.
		const declared = (task?.stages ?? []).flatMap((stage) => stage.criteria ?? []);
		const unsupported = declared.filter((criterion) => !SUPPORTED_CRITERIA.includes(String(criterion).trim()));
		if (unsupported.length > 0) {
			return {
				status: "unknown",
				failure_mode: "unregistered_criterion",
				detail: `the judge cannot verify declared criterion: ${unsupported.join(", ")}`,
			};
		}
		let result;
		try {
			result = runTests(workspaceRoot);
		} catch (error) {
			return { status: "unknown", failure_mode: "harness_error", detail: String(error) };
		}
		if (!result || typeof result !== "object") return { status: "unknown", failure_mode: "harness_error" };
		// The result must be a COMPLETE trusted run. A transport-only exit code with no
		// completed assertion set is unknown, not a pass (and not a failure).
		const complete = result.complete === true;
		const allPassed = complete && result.ok === true && (result.failed ?? 0) === 0;
		const stageOverrides = {};
		for (const stage of task?.stages ?? []) {
			stageOverrides[stage.stage_id] = {
				status: allPassed ? "success" : complete ? "failure" : "unknown",
				observed: {
					passed: result.passed ?? null,
					failed: result.failed ?? null,
					assertions: result.assertions ?? null,
					detail: result.detail ?? null,
				},
			};
		}
		const targetFile = task?.target_ref ?? "solution.mjs";
		const absolute = resolve(workspaceRoot, targetFile);
		const evidence = existsSync(absolute)
			? [{ ref_id: `artifact:${task.task_id}`, digest: digest(readFileSync(absolute, "utf8")), path: absolute }]
			: [];
		if (typeof onEvidence === "function" && evidence.length) onEvidence(evidence);
		if (!complete) {
			return {
				status: "unknown",
				observed: { passed: result.passed ?? null, failed: result.failed ?? null, detail: result.detail ?? null },
				failure_mode: "incomplete_test",
				stage_overrides: stageOverrides,
				evidence,
			};
		}
		if (!allPassed) {
			return {
				status: "failure",
				observed: { passed: result.passed ?? null, failed: result.failed ?? null, detail: result.detail ?? null },
				failure_mode: "test_failed",
				stage_overrides: stageOverrides,
				evidence,
			};
		}
		for (const stage of Object.values(stageOverrides)) Object.assign(stage, { evidence });
		return {
			status: "success",
			observed: { passed: result.passed ?? null, failed: result.failed ?? null, assertions: result.assertions ?? null },
			evidence,
			stage_overrides: stageOverrides,
		};
	};
}

/**
 * Build the code-repair manifest. The task repairs `solution.mjs`; the
 * INDEPENDENT `check.mjs` test lives in the workspace but is written by the
 * Host (trusted) and is not the model's target.
 *
 * @param {{workspaceRoot: string, campaignId?: string, target?: string}} args
 */
export function buildCodeRepairManifest({ workspaceRoot, campaignId = "campaign-c6-code", target = "solution.mjs" }) {
	return {
		schema_version: "campaign-1.0",
		campaign_id: campaignId,
		revision: 1,
		created_at: "2026-01-01T00:00:00Z",
		title: "C6 code repair fixture",
		objective: {
			description: "Repair a small module so an external read-only test passes.",
			success_criteria: ["external test passes"],
			stage_policy: "declared_only",
		},
		worker: { provider: "fixture", model: "deterministic-no-model" },
		authorization: {
			execution_profile: "supervised-macos-workspace",
			workspace_root: workspaceRoot,
			allowed_targets: [target],
			allowed_capabilities: ["code.file.write"],
			network: "disabled",
			credentials: "none",
			human_approval: "campaign_grant",
			workspace_is_sandbox: false,
		},
		budget: { wall_time_ms: 600000, model_requests: 100, tool_calls: 200, task_count: 2, session_count: 20 },
		session_policy: {
			max_requests_per_session: 10,
			max_context_chars: 20000,
			rotate_at_stage_boundary: true,
			rotate_on_model_request: true,
			allow_model_handoff_request: true,
		},
		adapters: { execution: "workspace.exec.v1", oracle: "fixture.oracle.v1", report: "aegis-acceptance.v1" },
		tasks: [
			{
				task_id: "task-001",
				order: 1,
				depends_on: [],
				target_ref: target,
				task_type: "verify",
				scope: { environment_fingerprint: "code-repair-env", domain: "code" },
				goal: {
					goal_id: "fix_module",
					description: "Make the external test pass.",
					success_criteria: ["external test passes"],
				},
				stages: [{ stage_id: "stage-001-fix", criteria: ["external test passes"], required: true }],
				oracle_ref: "fixture.oracle.v1",
				task_budget: { wall_time_ms: 120000, model_requests: 20, tool_calls: 40 },
			},
		],
		dynamic_task_policy: {
			enabled: false,
			allowed_task_types: ["verify", "reproduce"],
			max_depth: 1,
			max_fan_out: 0,
			max_task_count: 1,
			required_stop_condition: "no remaining work",
			allow_new_target: false,
			allow_new_capability: false,
			allow_new_adapter: false,
			allow_network: false,
			allow_credentials: false,
			allow_budget_increase: false,
		},
		evidence_policy: { independent_result_required: true, unknown_is_not_failure: true, promote_experience: false },
	};
}
