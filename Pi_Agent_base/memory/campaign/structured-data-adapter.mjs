// Aegis C6-B — structured data repair/transform task family.
//
// The FIRST C6 task family: a small structured dataset in a temp directory that
// must be repaired/transformed to a declared target shape. It reuses the
// existing Broker/ActionContract path (ONE capability per operation) and an
// INDEPENDENT Oracle that re-reads the REAL output file.
//
// Trust boundaries (identical to the fixture adapter):
//   * the target path is resolved with `resolveInside` (no absolute path, no
//     `..`, no symlink escape);
//   * the model supplies DATA ONLY (a record key + a JSON value); it never
//     supplies a program, argv, authorization or verdict;
//   * `verify()` re-reads the real file and compares it to the declared
//     expectation; the procedure's own `ok` is never a verdict;
//   * an unreadable/malformed output is `unknown`, never a silent success.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { digest, resolveInside } from "../fixture/contracts.mjs";
import { defineContract } from "../runtime/action-contract.mjs";

export const DATA_REPAIR_ACTION_REF = "data.record.set";

/**
 * @param {{workspaceRoot: string, id?: string, version?: number}} args
 */
export function createStructuredDataAdapter(
	{ workspaceRoot, id = DATA_REPAIR_ACTION_REF, version = 1 } = /** @type {any} */ ({}),
) {
	if (typeof workspaceRoot !== "string" || !workspaceRoot)
		throw new Error("createStructuredDataAdapter requires a workspaceRoot");

	function readObject(target) {
		try {
			const absolute = resolveInside(workspaceRoot, target, { mustExist: true });
			const text = readFileSync(absolute, "utf8");
			const parsed = JSON.parse(text);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return { ok: false, reason: "data is not a JSON object" };
			return { ok: true, absolute, state: parsed, content_digest: digest(text) };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	return defineContract({
		id,
		version,
		tool: "aegis_workspace",
		operation: "data.record.set",
		description:
			"Set one top-level string field of a JSON data file inside the authorized workspace. Offline; no network, no shell, no model code.",
		risk_class: "low",
		network: false,
		parameters: {
			target: { type: "string", required: true, min_length: 1 },
			field: { type: "string", required: true, min_length: 1 },
			value: { type: "string", required: true },
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
				let state = {};
				let preState = {};
				if (existsSync(absolute)) {
					try {
						state = JSON.parse(readFileSync(absolute, "utf8"));
					} catch (error) {
						return { ok: false, failure_mode: "precondition_unmet", detail: `data unreadable: ${String(error)}` };
					}
					if (!state || typeof state !== "object" || Array.isArray(state)) {
						return { ok: false, failure_mode: "precondition_unmet", detail: "existing data is not an object" };
					}
					// X8: record the REAL prior state so a later isolated replay can rebuild
					// the same pre-state rather than guessing it.
					preState = structuredClone(state);
				} else {
					const parent = dirname(absolute);
					if (!existsSync(parent))
						return { ok: false, failure_mode: "precondition_unmet", detail: `target dir missing: ${args.target}` };
				}
				state[args.field] = String(args.value);
				writeFileSync(absolute, `${JSON.stringify(state)}\n`, "utf8");
				const content = readFileSync(absolute, "utf8");
				const observed = {
					target: args.target,
					field: args.field,
					value: String(args.value),
					state,
					pre_state: preState,
					arguments: { target: args.target, field: args.field, value: String(args.value) },
					file_digest: digest(content),
					content_digest: digest(content),
				};
				return { ok: true, observed, content_digest: observed.file_digest };
			},
		},
		verification: {
			check: ({ observed }) => {
				if (!observed || typeof observed !== "object") return { ok: false, reason: "no observed state" };
				const recheck = readObject(observed.target);
				if (!recheck.ok) return { ok: false, reason: `post-state unreadable: ${recheck.reason}` };
				const actual = recheck.state?.[observed.field];
				if (actual !== observed.value)
					return {
						ok: false,
						reason: `post-state ${observed.field}=${String(actual)}, expected ${String(observed.value)}`,
						expected: observed.value,
						observed: actual,
					};
				return {
					ok: true,
					reason: "post-state matches the declared value",
					expected: observed.value,
					observed: actual,
				};
			},
		},
		scope: {
			environment_fingerprint: "data-repair-env",
			domain: "structured-data",
			permissions: ["data.record.write"],
			task_types: ["repair", "transform"],
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
					observation_kind: "data_record",
					subject: observed?.target ?? context.target_path ?? null,
					predicate: observed?.field ?? null,
					value: observed ?? null,
					source: "data_repair_adapter",
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
					scope: "data.record.set",
					criterion: { criterion_id: context.criterion_id ?? null, expected: observed?.value ?? null },
					status,
					observed: status === "success" || status === "failure" ? (observed ?? null) : null,
					oracle: { oracle_id: "data-repair.verify", method: "post_state_recheck", independence_group: "data-local" },
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
 * Build a manifest for the structured data repair/transform task family. Two
 * static tasks: `task-001` repairs `name`, `task-002` transforms `status`. The
 * independent Oracle re-reads the real output file.
 *
 * @param {{workspaceRoot: string, campaignId?: string, target?: string}} args
 */
export function buildDataRepairManifest({ workspaceRoot, campaignId = "campaign-c6-data", target = "dataset.json" }) {
	return {
		schema_version: "campaign-1.0",
		campaign_id: campaignId,
		revision: 1,
		created_at: "2026-01-01T00:00:00Z",
		title: "C6 structured data repair fixture",
		objective: {
			description: "Repair/transform a JSON dataset verified by an independent local oracle.",
			success_criteria: ["dataset.name repaired", "dataset.status transformed"],
			stage_policy: "declared_only",
		},
		worker: { provider: "fixture", model: "deterministic-no-model" },
		authorization: {
			execution_profile: "supervised-macos-workspace",
			workspace_root: workspaceRoot,
			allowed_targets: [target],
			allowed_capabilities: ["data.record.write"],
			network: "disabled",
			credentials: "none",
			human_approval: "campaign_grant",
			workspace_is_sandbox: false,
		},
		budget: { wall_time_ms: 600000, model_requests: 100, tool_calls: 200, task_count: 4, session_count: 20 },
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
				scope: {
					environment_fingerprint: "data-repair-env",
					domain: "structured-data",
					permissions: ["data.record.write"],
					task_types: ["verify", "reproduce"],
				},
				initial_state: { name: "before" },
				goal: { goal_id: "repair_name", description: "Repair the name field.", success_criteria: ["data.name == Ada"] },
				stages: [{ stage_id: "stage-001-name", criteria: ["data.name == Ada"], required: true }],
				oracle_ref: "fixture.oracle.v1",
				task_budget: { wall_time_ms: 120000, model_requests: 20, tool_calls: 40 },
			},
			{
				task_id: "task-002",
				order: 2,
				depends_on: ["task-001"],
				target_ref: target,
				task_type: "reproduce",
				scope: {
					environment_fingerprint: "data-repair-env",
					domain: "structured-data",
					permissions: ["data.record.write"],
					task_types: ["verify", "reproduce"],
				},
				initial_state: { name: "Ada" },
				goal: {
					goal_id: "transform_status",
					description: "Transform the status field.",
					success_criteria: ["data.status == active"],
				},
				stages: [{ stage_id: "stage-002-status", criteria: ["data.status == active"], required: true }],
				oracle_ref: "fixture.oracle.v1",
				task_budget: { wall_time_ms: 120000, model_requests: 20, tool_calls: 40 },
			},
		],
		dynamic_task_policy: {
			enabled: true,
			allowed_task_types: ["verify", "reproduce"],
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
		evidence_policy: { independent_result_required: true, unknown_is_not_failure: true, promote_experience: false },
	};
}

/**
 * The INDEPENDENT Oracle judge for a data-repair task. It re-reads the real
 * output file and compares each expected field to the target shape. It never
 * consults the worker's `ok` or an exit code. Supported criterion forms:
 *   - `data.<field> == <string>`   (string equality)
 *   - `data.<field> is <string>`   (same)
 *
 * @param {{workspaceRoot: string, target?: string}} args
 * @returns {(args: {task: any, attempt: number, onEvidence?: Function}) => object}
 */
export function createDataRepairJudge({ workspaceRoot, target = "dataset.json" } = /** @type {any} */ ({})) {
	return ({ task, onEvidence, action_pin: actionPin }) => {
		const file = task?.target_ref ?? target;
		let absolute;
		try {
			absolute = resolveInside(workspaceRoot, file, { mustExist: false });
		} catch (error) {
			return { status: "unknown", failure_mode: "effect_absent", detail: String(error) };
		}
		if (!existsSync(absolute)) return { status: "unknown", failure_mode: "effect_absent" };
		let state;
		try {
			state = JSON.parse(readFileSync(absolute, "utf8"));
		} catch (error) {
			return { status: "unknown", failure_mode: "malformed_output", detail: String(error) };
		}
		if (!state || typeof state !== "object" || Array.isArray(state))
			return { status: "unknown", failure_mode: "malformed_output" };

		const stageOverrides = {};
		let anyUnknown = false;
		let allSuccess = true;
		for (const stage of task?.stages ?? []) {
			const criteria = stage.criteria ?? [];
			const expectations = [];
			for (const criterion of criteria) {
				const match = /^data\.([A-Za-z0-9_]+)\s+(?:==|is)\s+(.+)$/.exec(String(criterion).trim());
				if (!match) {
					expectations.push({ unsupported: true, criterion });
					continue;
				}
				expectations.push({ field: match[1], expected: match[2].replace(/^["']|["']$/g, "") });
			}
			if (expectations.some((e) => e.unsupported)) {
				stageOverrides[stage.stage_id] = { status: "unknown", failure_mode: "unregistered_criterion" };
				anyUnknown = true;
				continue;
			}
			const matched = expectations.every((e) => state[e.field] === e.expected);
			stageOverrides[stage.stage_id] = {
				status: matched ? "success" : "failure",
				expected: expectations[0]?.expected ?? null,
				observed: Object.fromEntries(expectations.map((e) => [e.field, state[e.field] ?? null])),
			};
			if (!matched) allSuccess = false;
		}
		const evidence = [
			{ ref_id: `artifact:${task.task_id}`, digest: digest(readFileSync(absolute, "utf8")), path: absolute },
		];
		if (typeof onEvidence === "function") onEvidence(evidence);
		const artifactRef = { ref_type: "artifact", ref_id: `artifact:${task.task_id}`, digest: evidence[0].digest };
		// X8: record the real pre-state and the final action arguments so a later
		// isolated replay can rebuild the same run and pin its inputs. The pre-state
		// is the task's DECLARED initial state (trusted Host input), never a model
		// value and never guessed from the post-state.
		const preState = task?.initial_state && typeof task.initial_state === "object" ? task.initial_state : null;
		const args = actionPin?.arguments && typeof actionPin.arguments === "object" ? actionPin.arguments : null;
		const observedWithReplay = {
			state,
			pre_state: preState,
			arguments: args,
		};
		// X8: `when`/`expect` are STRUCTURED predicates produced by the trusted
		// verification, never declaration strings. `verified_by` names the evidence
		// ref the Oracle re-read, so the Compiler's predicate gate can accept them.
		const when = [
			{
				path: "environment.fingerprint",
				op: "eq",
				value: task?.scope?.environment_fingerprint ?? "data-repair-env",
				verified_by: [artifactRef],
			},
		];
		// Also carry the REAL pre-state preconditions (from the declared initial
		// state) so a reused rule can verify its `when` against a trusted current
		// state at route time. Only fields the action actually changes are relevant.
		for (const [field, value] of Object.entries(preState ?? {})) {
			when.push({ path: field, op: "eq", value, verified_by: [artifactRef] });
		}
		const expect = [];
		for (const stage of task?.stages ?? []) {
			for (const criterion of stage.criteria ?? []) {
				const match = /^data\.([A-Za-z0-9_]+)\s+(?:==|is)\s+(.+)$/.exec(String(criterion).trim());
				if (!match) continue;
				expect.push({
					path: `data.${match[1]}`,
					op: "eq",
					value: match[2].replace(/^["']|["']$/g, ""),
					verified_by: [artifactRef],
				});
			}
		}
		if (anyUnknown)
			return {
				status: "unknown",
				failure_mode: "unregistered_criterion",
				stage_overrides: stageOverrides,
				evidence,
				when,
				expect,
			};
		for (const stage of Object.values(stageOverrides)) Object.assign(stage, { evidence });
		return {
			status: allSuccess ? "success" : "failure",
			observed: observedWithReplay,
			evidence,
			when,
			expect,
			stage_overrides: stageOverrides,
			...(allSuccess ? {} : { failure_mode: "criterion_not_met" }),
		};
	};
}

/**
 * Build a manifest for the C6-C learning closure: TWO INDEPENDENT tasks that use
 * the SAME method (data.record.set on the same field/value) with compatible
 * `expect`, so the reviewed Compiler can derive ONE rule from two independently
 * reset Episodes. A third task then exercises the `direct` reuse path (zero
 * planning requests). The tasks have no dependency so each is a genuinely
 * independent Episode.
 *
 * @param {{workspaceRoot: string, campaignId?: string, target?: string}} args
 */
export function buildDataRepairLearningManifest({
	workspaceRoot,
	campaignId = "campaign-c6-learn",
	target = "dataset.json",
}) {
	const base = buildDataRepairManifest({ workspaceRoot, campaignId, target });
	const scope = {
		environment_fingerprint: "data-repair-env",
		domain: "structured-data",
		permissions: ["data.record.write"],
		task_types: ["verify", "reproduce"],
	};
	const criteria = ["data.status == active"];
	const makeTask = (id, order, initial) => ({
		task_id: id,
		order,
		depends_on: [],
		target_ref: target,
		task_type: "verify",
		scope,
		initial_state: initial,
		goal: { goal_id: "normalize_status", description: "Normalize the status field.", success_criteria: criteria },
		stages: [{ stage_id: `stage-${id}`, criteria, required: true }],
		oracle_ref: "fixture.oracle.v1",
		task_budget: { wall_time_ms: 120000, model_requests: 20, tool_calls: 40 },
	});
	return {
		...base,
		campaign_id: campaignId,
		title: "C6 learning closure fixture",
		objective: {
			description: "Two independent episodes normalize the same field; a third repeats the verified method.",
			success_criteria: criteria,
			stage_policy: "declared_only",
		},
		tasks: [
			makeTask("task-001", 1, { status: "pending" }),
			makeTask("task-002", 2, { status: "pending" }),
			makeTask("task-003", 3, { status: "pending" }),
		],
		dynamic_task_policy: { ...base.dynamic_task_policy, max_task_count: 4 },
	};
}
