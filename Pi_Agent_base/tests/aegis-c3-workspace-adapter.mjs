#!/usr/bin/env node
// Aegis C3-C — supervised macOS workspace script adapter test.
//
// Exercises the REAL script-registry path with a REAL local subprocess:
//   * fixed executable (node) + pinned executable/script digests;
//   * data-only argv; cwd inside allowed_root; timeout; network:false;
//   * a registered post-condition that re-reads the real state file.
//
// Cases: C3-POS (workspace positive), C3-DENY-2 (foreign target refused),
//        C3-DENY-3 (digest change + undeclared param refused), C3-ORACLE-1
//        (transport success but wrong post-state => not success).
//
// Run:
//   node Pi_Agent_base/tests/aegis-c3-workspace-adapter.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrokerWorker } from "../memory/campaign/broker-worker.mjs";
import { createCampaignHost } from "../memory/campaign/host.mjs";
import { createHostOracle } from "../memory/campaign/host-oracle.mjs";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { createWorkspaceScriptRegistration } from "../memory/campaign/script-workspace-adapter.mjs";
import { digest } from "../memory/fixture/contracts.mjs";
import { ActionRegistry, createActionBroker } from "../memory/runtime/action-contract.mjs";
import { createAuthorization } from "../memory/runtime/authorization.mjs";
import { EventLog } from "../memory/runtime/events.mjs";
import { createScriptRegistry, scriptContracts } from "../memory/runtime/script-registry.mjs";

const failures = [];
async function test(name, fn) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures.push({ name, error });
		console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
const root = mkdtempSync(join(tmpdir(), "aegis-c3-ws-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const helperScript = fileURLToPath(new URL("./helpers/c3-workspace-state.mjs", import.meta.url));
const noopScript = fileURLToPath(new URL("./helpers/c3-workspace-noop.mjs", import.meta.url));

function manifestFor(workspaceRoot) {
	const raw = {
		schema_version: "campaign-1.0",
		campaign_id: "campaign-c3-workspace",
		revision: 1,
		created_at: "2026-01-01T00:00:00Z",
		title: "C3 workspace adapter",
		objective: {
			description: "Run one pinned local script and verify the real post-state.",
			success_criteria: ["state.locked == false"],
			stage_policy: "declared_only",
		},
		worker: { provider: "fixture", model: "deterministic-no-model" },
		authorization: {
			execution_profile: "supervised-macos-workspace",
			workspace_root: workspaceRoot,
			allowed_targets: ["state.json"],
			allowed_capabilities: ["workspace-script"],
			network: "disabled",
			credentials: "none",
			human_approval: "campaign_grant",
			workspace_is_sandbox: false,
		},
		budget: { wall_time_ms: 60000, model_requests: 10, tool_calls: 20, task_count: 2, session_count: 5 },
		session_policy: {
			max_requests_per_session: 5,
			max_context_chars: 8000,
			rotate_at_stage_boundary: true,
			rotate_on_model_request: true,
			allow_model_handoff_request: true,
		},
		adapters: { execution: "workspace.exec.v1", oracle: "fixture.oracle.v1", report: "aegis-acceptance.v1" },
		tasks: [
			{
				task_id: "task-ws",
				order: 1,
				depends_on: [],
				target_ref: "state.json",
				task_type: "verify",
				scope: { environment_fingerprint: "fixture-env", domain: "fixture" },
				goal: {
					goal_id: "unlock_state",
					description: "Unlock the state.",
					success_criteria: ["state.locked == false"],
				},
				stages: [{ stage_id: "stage-ws", criteria: ["state.locked == false"], required: true }],
				oracle_ref: "fixture.oracle.v1",
				task_budget: { wall_time_ms: 20000, model_requests: 4, tool_calls: 8 },
			},
		],
		evidence_policy: { independent_result_required: true, unknown_is_not_failure: true, promote_experience: false },
	};
	const v = validateManifest(raw);
	assert.equal(v.ok, true, `manifest invalid: ${v.reasons?.join("; ")}`);
	return v.manifest;
}

async function buildWorkspaceHost({
	dir,
	workspaceRoot,
	manifest,
	scriptPath = helperScript,
	planFactory = null,
	registryMutator = null,
}) {
	mkdirSync(workspaceRoot, { recursive: true });
	const eventLogPath = join(dir, "events.jsonl");
	const log = new EventLog(eventLogPath);
	const opened = await log.open();
	assert.equal(opened.ok, true, opened.error);
	const sink = {
		async append(event) {
			return log.append({
				event_type: event.event_type,
				episode_id: event.episode_id ?? null,
				payload: event.payload ?? {},
				source: event.source,
			});
		},
		replay: () => log.replay(),
		close: () => log.close(),
	};

	const registration = createWorkspaceScriptRegistration({ workspaceRoot, scriptPath });
	const scriptRegistry = createScriptRegistry({ scripts: [registration] });
	const contracts = scriptContracts(scriptRegistry);
	if (registryMutator) registryMutator(contracts, scriptRegistry);
	const registry = new ActionRegistry(contracts);
	const broker = createActionBroker({ registry });
	const authorization = createAuthorization({
		mode: "auto",
		workspaceRoot,
		allowedTools: ["aegis_script", "aegis_workspace"],
		allowNetwork: false,
		approved: true,
	});
	const artifactIndex = new Map();

	const plan =
		planFactory ??
		((task) => ({
			task_id: task.task_id,
			steps: (task.stages ?? []).map((stage) => ({
				step_id: `${task.task_id}:${stage.stage_id}`,
				stage_id: stage.stage_id,
				action_ref: "script.aegis.workspace.state",
				arguments: { state_file: "state.json", key: "locked", value: false },
				criterion_id: stage.criteria?.[0] ?? null,
				evidence_ref: `artifact:${task.task_id}`,
			})),
		}));

	const worker = createBrokerWorker({
		broker,
		authorization,
		plan,
		sink,
		workspaceRoot,
		artifactIndex,
		probePath: () => join(workspaceRoot, "state.json"),
		targetPathFor: () => join(workspaceRoot, "state.json"),
	});

	const oracle = createHostOracle({
		workspaceRoot,
		judgeTask: ({ task }) => {
			const path = join(workspaceRoot, "state.json");
			let state = {};
			try {
				state = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				return { status: "unknown", failure_mode: "effect_absent" };
			}
			const expected = false; // state.locked == false
			const evidence = [{ ref_id: `artifact:${task.task_id}`, digest: digestFile(path), path }];
			if (state.locked === expected)
				return { status: "success", observed: { locked: state.locked }, expected, evidence };
			return {
				status: "failure",
				observed: { locked: state.locked },
				expected,
				failure_mode: "criterion_not_met",
				evidence,
			};
		},
		onEvidence: (refs) => {
			for (const ref of refs) {
				if (ref && typeof ref.ref_id === "string" && typeof ref.digest === "string") artifactIndex.set(ref.ref_id, ref);
			}
		},
	});

	const host = createCampaignHost({
		manifest,
		ownedTasks: manifest.tasks,
		baseDir: join(dir, "runtime"),
		workspaceRoot,
		sink,
		worker,
		oracle,
		artifacts: new Proxy(
			{},
			{
				get: (_t, p) => (typeof p === "string" ? artifactIndex.get(p) : undefined),
				has: (_t, p) => typeof p === "string" && artifactIndex.has(p),
				ownKeys: () => [...artifactIndex.keys()],
				getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
			},
		),
	});
	return { host, sink, registry, authorization, artifactIndex, broker };
}

function digestFile(path) {
	return digest(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// C3-POS (workspace)
// ---------------------------------------------------------------------------

await test("C3-POS-WS: the registered local script runs and its real post-state is verified", async () => {
	const dir = join(root, "pos");
	const workspaceRoot = join(dir, "ws");
	const manifest = manifestFor(workspaceRoot);
	const { host, sink } = await buildWorkspaceHost({ dir, workspaceRoot, manifest });
	const result = await host.run();
	assert.equal(result.ok, true, `host run failed: ${result.reasons?.join("; ")}`);
	const task = result.status.tasks.find((t) => t.task_id === "task-ws");
	assert.equal(task.state, "completed");
	assert.deepEqual(JSON.parse(readFileSync(join(workspaceRoot, "state.json"), "utf8")), { locked: false });
	// The transport fact is preserved (exit code 0) but success came from verify().
	const completed = sink.replay().find((e) => e.event_type === "action.completed");
	assert.equal(completed.payload.transport.exit_code, 0);
	host.releaseOwnership();
});

// ---------------------------------------------------------------------------
// C3-DENY-2 (foreign target)
// ---------------------------------------------------------------------------

await test("C3-DENY-2: a resource path escaping allowed_root is refused with no effect", async () => {
	const dir = join(root, "deny-target");
	const workspaceRoot = join(dir, "ws");
	const manifest = manifestFor(workspaceRoot);
	const outside = join(dir, "outside.json");
	const { host, sink } = await buildWorkspaceHost({
		dir,
		workspaceRoot,
		manifest,
		planFactory: (task) => ({
			task_id: task.task_id,
			steps: [
				{
					step_id: "escape",
					stage_id: task.stages[0].stage_id,
					action_ref: "script.aegis.workspace.state",
					arguments: { state_file: outside, key: "locked", value: false },
					criterion_id: task.stages[0].criteria[0],
					evidence_ref: `artifact:${task.task_id}`,
				},
			],
		}),
	});
	const result = await host.run();
	const task = result.status.tasks.find((t) => t.task_id === "task-ws");
	assert.notEqual(task.state, "completed", "the escaping target must not complete");
	const completed = sink.replay().find((e) => e.event_type === "action.completed");
	assert.ok(["rejected", "unknown"].includes(completed.payload.status), `status ${completed.payload.status}`);
	assert.match(String(completed.payload.detail), /inside the allowed root|escapes/i);
	assert.equal(existsSync(outside), false, "the outside file was never created");
	host.releaseOwnership();
});

// ---------------------------------------------------------------------------
// C3-DENY-3 (digest change, undeclared param)
// ---------------------------------------------------------------------------

await test("C3-DENY-3a: a changed script body invalidates the pinned digest", async () => {
	const dir = join(root, "deny-digest");
	const workspaceRoot = join(dir, "ws");
	const manifest = manifestFor(workspaceRoot);
	const copiedScript = join(dir, "c3-workspace-state.mjs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(copiedScript, readFileSync(helperScript, "utf8"));
	const { host, sink } = await buildWorkspaceHost({ dir, workspaceRoot, manifest, scriptPath: copiedScript });
	// Swap the script body AFTER registration: the pinned script_digest no longer
	// matches, so recognition must refuse before any effect.
	writeFileSync(copiedScript, `${readFileSync(copiedScript, "utf8")}\n// tampered\n`);
	const result = await host.run();
	const task = result.status.tasks.find((t) => t.task_id === "task-ws");
	assert.notEqual(task.state, "completed");
	const completed = sink.replay().find((e) => e.event_type === "action.completed");
	assert.equal(completed.payload.status, "rejected");
	assert.match(String(completed.payload.rejection_reason), /changed|re-verification/i);
	host.releaseOwnership();
});

await test("C3-DENY-3b: an undeclared parameter is refused by the data-only schema", async () => {
	const dir = join(root, "deny-param");
	const workspaceRoot = join(dir, "ws");
	const manifest = manifestFor(workspaceRoot);
	const { host, sink } = await buildWorkspaceHost({
		dir,
		workspaceRoot,
		manifest,
		planFactory: (task) => ({
			task_id: task.task_id,
			steps: [
				{
					step_id: "extra",
					stage_id: task.stages[0].stage_id,
					action_ref: "script.aegis.workspace.state",
					arguments: { state_file: "state.json", key: "locked", value: false, executable: "/bin/sh" },
					criterion_id: task.stages[0].criteria[0],
					evidence_ref: `artifact:${task.task_id}`,
				},
			],
		}),
	});
	const result = await host.run();
	const completed = sink.replay().find((e) => e.event_type === "action.completed");
	assert.equal(completed.payload.status, "rejected");
	assert.match(String(completed.payload.rejection_reason), /not a declared parameter/i);
	assert.notEqual(result.status.tasks.find((t) => t.task_id === "task-ws").state, "completed");
	host.releaseOwnership();
});

// ---------------------------------------------------------------------------
// C3-ORACLE-1 (transport success, wrong post-state)
// ---------------------------------------------------------------------------

await test("C3-ORACLE-1: exit 0 with a wrong post-state is NOT a success", async () => {
	const dir = join(root, "oracle-wrong");
	const workspaceRoot = join(dir, "ws");
	const manifest = manifestFor(workspaceRoot);
	// The NO-OP script exits 0 but never sets the value.
	const { host, sink } = await buildWorkspaceHost({ dir, workspaceRoot, manifest, scriptPath: noopScript });
	const result = await host.run();
	const task = result.status.tasks.find((t) => t.task_id === "task-ws");
	assert.notEqual(task.state, "completed", "a wrong post-state must not complete the task");
	const completed = sink.replay().find((e) => e.event_type === "action.completed");
	assert.equal(completed.payload.transport.exit_code, 0, "the transport exit code was 0");
	assert.equal(completed.payload.status, "unknown", "the registered verification refused to auto-pass");
	host.releaseOwnership();
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C3 workspace adapter: ${failures.length} failure(s)`);
	for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
	process.exit(1);
}
console.log("campaign C3 workspace adapter: all assertions passed");
