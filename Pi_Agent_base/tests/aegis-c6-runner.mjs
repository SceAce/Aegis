#!/usr/bin/env node
// Aegis C6-E — bounded runner / measurement support.
//
// Proves: the runner fixes the config per attempt, runs a bounded list
// sequentially, keeps EVERY attempt including failures, and never fabricates a
// backend token/currency measurement.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-runner.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";

const sdk = { ...sdkBase, AuthStorage };

import { runC6FromConfig } from "../memory/campaign/c6-entry.mjs";
import { readRunnerManifest, runBoundedAttempts } from "../memory/campaign/c6-runner.mjs";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { buildDataRepairManifest } from "../memory/campaign/structured-data-adapter.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-runner-"));
const failures = [];
function check(name, condition, detail) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures.push(name);
		console.log(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

try {
	const workspaceRoot = join(base, "workspace");
	const workDir = join(base, "run");
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(join(workspaceRoot, "dataset.json"), `${JSON.stringify({ name: "??" })}\n`, "utf8");
	const validated = validateManifest(buildDataRepairManifest({ workspaceRoot }));
	assert.equal(validated.ok, true, validated.reasons?.join("; "));
	const manifestPath = join(base, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8");
	const configPath = join(base, "campaign.config.json");
	writeFileSync(
		configPath,
		`${JSON.stringify({
			schema_version: "campaign-config-1.1",
			manifest_path: manifestPath,
			workspace_root: workspaceRoot,
			work_dir: workDir,
			mode: "auto",
			provider: { kind: "faux", model: "faux-c6" },
			context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
			learning: { policy: "off", promote_experience: false },
			task_family: "structured-data-repair",
			session: { session_count: 4, max_requests_per_session: 10 },
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
		})}\n`,
		"utf8",
	);

	Object.assign(process.env, {
		AEGIS_EVENT_LOG: join(workDir, "events.jsonl"),
		AEGIS_RAM_DIR: join(workDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
		AEGIS_TASK_ID: "task-c6-runner",
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	mkdirSync(join(workDir, "runtime"), { recursive: true });

	const fauxFactory = (options) => {
		const faux = registerFauxProvider(options);
		const seen = new Map();
		const mk = (context) => {
			const text = JSON.stringify(context.messages);
			const taskId = [...text.matchAll(/TASK (task-\d+)/g)].at(-1)?.[1] ?? "task-001";
			const count = (seen.get(taskId) ?? 0) + 1;
			seen.set(taskId, count);
			if (count > 1) return fauxAssistantMessage("done");
			return fauxAssistantMessage([
				fauxToolCall("aegis_task_decision", {
					actions: [
						{
							action_ref: "data.record.set",
							arguments: {
								target: "dataset.json",
								field: taskId === "task-001" ? "name" : "status",
								value: taskId === "task-001" ? "Ada" : "active",
							},
						},
					],
				}),
			]);
		};
		faux.setResponses(Array.from({ length: 16 }, () => mk));
		return faux;
	};

	const applyInitialState = (_attempt, initial) => {
		// The trusted task-family initializer actually rewrites the shared target to
		// the declared state and re-reads it, so the attempt starts from a real,
		// verified pre-state rather than whatever the previous attempt left.
		writeFileSync(join(workspaceRoot, "dataset.json"), `${JSON.stringify(initial)}\n`, "utf8");
		return { ok: true, applied: JSON.parse(readFileSync(join(workspaceRoot, "dataset.json"), "utf8")) };
	};
	const runner = await runBoundedAttempts({
		runEntry: runC6FromConfig,
		configPath,
		baseDir: join(base, "attempts"),
		applyInitialState,
		attempts: [
			{ id: "attempt-a", seed: 1, initial_state: { name: "??" }, work_dir: join(base, "work-a") },
			{ id: "attempt-b", seed: 2, initial_state: { name: "??" }, work_dir: join(base, "work-b") },
		],
		sdk,
		fauxProviderFactory: fauxFactory,
	});
	check("the runner completed", runner.ok === true, JSON.stringify(runner.reason));
	check("both attempts ran", runner.attempts.length === 2, JSON.stringify(runner.attempts.length));
	check("every attempt is recorded", Boolean(readRunnerManifest(join(base, "attempts"))), "manifest missing");
	const manifest = readRunnerManifest(join(base, "attempts"));
	check(
		"the manifest records the seed per attempt",
		manifest.attempts[0].seed === 1 && manifest.attempts[1].seed === 2,
	);
	check("the manifest records the initial state per attempt", manifest.attempts[0].initial_state?.name === "??");
	check(
		"the manifest records the ACTUALLY applied initial state",
		manifest.attempts.every((a) => a.initial_state_applied === true && a.applied_initial_state?.name === "??"),
		JSON.stringify(manifest.attempts.map((a) => a.applied_initial_state)),
	);
	// A declared initial state with no trusted initializer is refused, not run.
	const noInitRunner = await runBoundedAttempts({
		runEntry: async () => {
			throw new Error("must not run without an initializer");
		},
		configPath,
		baseDir: join(base, "no-init"),
		attempts: [{ id: "no-init", work_dir: join(base, "work-no-init"), initial_state: { name: "fresh" } }],
	});
	check(
		"an unapplicable initial state is refused, never run",
		noInitRunner.attempts[0].ok === false && noInitRunner.attempts[0].reasons?.includes("initial_state_not_applicable"),
		JSON.stringify(noInitRunner.attempts[0]),
	);
	check(
		"backend tokens stay null in every attempt",
		manifest.attempts.every((a) => a.backend_tokens === null),
	);
	check(
		"backend currency stays null in every attempt",
		manifest.attempts.every((a) => a.backend_currency === null),
	);
	check("the manifest reports a completion count", manifest.completed + manifest.failed === manifest.attempts.length);

	// A failing attempt is kept, not hidden.
	const failingRunner = await runBoundedAttempts({
		runEntry: async () => {
			throw new Error("simulated failure");
		},
		configPath,
		baseDir: join(base, "failing"),
		attempts: [{ id: "attempt-fail", work_dir: join(base, "work-fail") }],
		sdk,
	});
	check(
		"a failing attempt is kept with ok:false",
		failingRunner.attempts[0].ok === false,
		JSON.stringify(failingRunner.attempts[0]),
	);
	check(
		"the failure reason is recorded",
		/simulated failure/.test(failingRunner.attempts[0].error ?? ""),
		JSON.stringify(failingRunner.attempts[0].error),
	);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 runner: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 runner: all checks passed");
