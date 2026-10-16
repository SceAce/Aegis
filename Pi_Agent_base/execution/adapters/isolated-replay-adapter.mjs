// Aegis C6-C — a trusted, ISOLATED replay adapter for the structured-data family.
//
// This is a HUMAN-configured adapter module referenced only by the trusted config
// (`learning.replay_adapter`); the model can never set or replace it, and the
// path is imported as a module, never `eval`'d. It performs a REAL isolated
// replay: it rebuilds the prior pre-state in a fresh temp directory (never the
// live workspace), re-runs the registered action, and re-verifies the pinned
// criterion on the new post-state.
//
// Honest boundary: the workspace is not an OS sandbox; isolation here means a
// fresh temp directory + a fresh deterministic pre-state, and the adapter states
// `isolated:true` so the engine can refuse an un-isolated replay.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { digest } from "../../shared/contracts.mjs";
import { createStructuredDataAdapter } from "./structured-data-adapter.mjs";

export const ISOLATED_REPLAY_ADAPTER_ID = "c6.structured-data.isolated-replay";

/**
 * Build the adapter object the workflow engine accepts
 * (`{ id, isolated: true, replay(args) }`).
 *
 * The adapter rebuilds the recorded pre-state, runs the SAME registered action
 * (data.record.set) against a fresh temp copy, and re-checks the criterion.
 */
export function createStructuredDataReplayAdapter() {
	return {
		id: ISOLATED_REPLAY_ADAPTER_ID,
		isolated: true,
		replay({ action_ref, arguments: args, priorPreState }) {
			if (action_ref !== "data.record.set") {
				return { ok: false, reason: `the adapter only replays data.record.set, got ${String(action_ref)}` };
			}
			if (!priorPreState || typeof priorPreState !== "object") {
				return { ok: false, reason: "the adapter needs the recorded prior pre-state to rebuild an isolated run" };
			}
			const dir = mkdtempSync(join(tmpdir(), "aegis-c6-replay-"));
			try {
				const root = join(dir, "workspace");
				mkdirSync(root, { recursive: true });
				const target = typeof args?.target === "string" ? args.target : "dataset.json";
				writeFileSync(join(root, target), `${JSON.stringify(priorPreState)}\n`, "utf8");
				const _preState = readFileSync(join(root, target), "utf8");
				const adapter = createStructuredDataAdapter({ workspaceRoot: root });
				const result = adapter.procedure.run({ arguments: { target, field: args.field, value: args.value } });
				if (!result || result.ok !== true) {
					return { ok: false, reason: `isolated replay action did not succeed: ${result?.detail ?? "unknown"}` };
				}
				const postState = readFileSync(join(root, target), "utf8");
				const parsed = JSON.parse(postState);
				const expectOk = parsed?.[args.field] === String(args.value);
				if (!expectOk) {
					return { ok: false, reason: "isolated replay post-state does not satisfy the pinned criterion" };
				}
				return {
					ok: true,
					isolated: true,
					action_ref,
					implementation_digest: adapter.implementation_digest,
					arguments_digest: digest({ target, field: args.field, value: args.value }),
					pre_state_digest: digest(priorPreState),
					post_state_digest: digest(postState),
					criterion_verified: true,
					replay_count: 1,
					replay_hash: digest({ pre: digest(priorPreState), post: digest(postState), action_ref, target }),
					isolation_ref: `isolated:${digest(dir)}`,
					transport: { adapter: ISOLATED_REPLAY_ADAPTER_ID, isolated_dir: resolve(root) },
				};
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

export default { id: ISOLATED_REPLAY_ADAPTER_ID, isolated: true, replay: createStructuredDataReplayAdapter().replay };

// The loader accepts `mod.replayAdapter ?? mod.default ?? mod`.
export const replayAdapter = {
	id: ISOLATED_REPLAY_ADAPTER_ID,
	isolated: true,
	replay: createStructuredDataReplayAdapter().replay,
};
