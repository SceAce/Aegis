// Aegis C3-B — isolated fixture execution adapter.
//
// ONE small, reviewed ActionContract for the offline C3 fixture: it reads and
// writes a deterministic JSON state file inside an EXPLICITLY-authorized temp
// target. It is NOT a new fixture framework — it is a single registered
// capability exercised through the existing Broker.
//
// Boundaries:
//   * the target path is resolved with `resolveInside` (no absolute paths, no
//     `..`, no symlink escape);
//   * the state is a bounded JSON object; a missing/unreadable/malformed file is
//     `unknown`, never a silent success;
//   * the post-condition `verify()` re-reads the REAL file and compares it to
//     the declared expectation; the procedure's own `ok` is never a verdict.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { digest, resolveInside } from "../fixture/contracts.mjs";
import { defineContract } from "../runtime/action-contract.mjs";

export const FIXTURE_ADAPTER_ACTION_REF = "fixture.state.set";

/**
 * Build the fixture adapter contract bound to a specific workspace root.
 *
 * @param {{workspaceRoot: string, id?: string, version?: number}} args
 */
export function createFixtureAdapterContract(
	{ workspaceRoot, id = FIXTURE_ADAPTER_ACTION_REF, version = 1 } = /** @type {any} */ ({}),
) {
	if (typeof workspaceRoot !== "string" || !workspaceRoot)
		throw new Error("createFixtureAdapterContract requires a workspaceRoot");

	function readState(target) {
		try {
			const absolute = resolveInside(workspaceRoot, target, { mustExist: true });
			const parsed = JSON.parse(readFileSync(absolute, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return { ok: false, reason: "state is not an object" };
			return { ok: true, absolute, state: parsed, content_digest: digest(readFileSync(absolute, "utf8")) };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	return defineContract({
		id,
		version,
		tool: "aegis_workspace",
		operation: "fixture.state.set",
		description:
			"Read/modify one deterministic JSON state file inside the authorized fixture workspace. Offline; no network, no shell, no model code.",
		risk_class: "low",
		network: false,
		parameters: {
			target: { type: "string", required: true, min_length: 1 },
			key: { type: "string", required: true, min_length: 1 },
			value: { type: "boolean", required: true },
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
			// A reviewed, data-only procedure. `arguments` are validated by the
			// Broker against the schema above before this runs.
			run: ({ arguments: args }) => {
				let absolute;
				try {
					absolute = resolveInside(workspaceRoot, args.target, { mustExist: false });
				} catch (error) {
					return { ok: false, failure_mode: "action_rejected", detail: String(error) };
				}
				let state = {};
				if (existsSync(absolute)) {
					try {
						state = JSON.parse(readFileSync(absolute, "utf8"));
						if (!state || typeof state !== "object" || Array.isArray(state)) {
							return { ok: false, failure_mode: "precondition_unmet", detail: "existing state is not an object" };
						}
					} catch (error) {
						return { ok: false, failure_mode: "tool_error", detail: `state unreadable: ${String(error)}` };
					}
				} else {
					// Ensure the parent directory exists INSIDE the root (the caller
					// created the authorized target directory).
					const parent = dirname(absolute);
					if (!existsSync(parent)) {
						return {
							ok: false,
							failure_mode: "precondition_unmet",
							detail: `target directory does not exist: ${args.target}`,
						};
					}
				}
				state[args.key] = args.value;
				writeFileSync(absolute, `${JSON.stringify(state)}\n`, "utf8");
				const content = readFileSync(absolute, "utf8");
				const observed = {
					target: args.target,
					key: args.key,
					value: args.value,
					state,
					file_digest: digest(content),
					content_digest: digest(content),
				};
				return { ok: true, observed, content_digest: observed.file_digest };
			},
		},
		verification: {
			check: ({ observed }) => {
				if (!observed || typeof observed !== "object") return { ok: false, reason: "no observed state" };
				// Re-read the REAL file; never trust the procedure's own result object.
				const recheck = readState(observed.target);
				if (!recheck.ok) return { ok: false, reason: `post-state unreadable: ${recheck.reason}` };
				const actual = recheck.state?.[observed.key];
				if (actual !== observed.value) {
					return {
						ok: false,
						reason: `post-state key ${observed.key}=${String(actual)}, expected ${String(observed.value)}`,
						expected: observed.value,
						observed: actual,
					};
				}
				return {
					ok: true,
					reason: "post-state matches the declared value",
					expected: observed.value,
					observed: actual,
				};
			},
		},
		scope: {
			environment_fingerprint: "fixture-env",
			domain: "fixture",
			permissions: ["fixture.state.write"],
			task_types: ["verify", "reproduce", "observe"],
		},
		authorization: {
			target_kinds: ["workspace_file"],
			allowed_actions: [id],
		},
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
					observation_kind: "fixture_state",
					subject: observed?.target ?? context.target_path ?? null,
					predicate: observed?.key ?? null,
					value: observed ?? null,
					source: "fixture_adapter",
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
					scope: "fixture.state.set",
					criterion: { criterion_id: context.criterion_id ?? null, expected: observed?.value ?? null },
					status,
					observed: status === "success" || status === "failure" ? (observed ?? null) : null,
					oracle: {
						oracle_id: "fixture-adapter.verify",
						method: "post_state_recheck",
						independence_group: "fixture-local",
					},
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

export { readFixtureState };
function readFixtureState(workspaceRoot, target) {
	const absolute = resolveInside(workspaceRoot, target, { mustExist: true });
	return JSON.parse(readFileSync(absolute, "utf8"));
}
