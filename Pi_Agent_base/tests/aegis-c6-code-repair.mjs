#!/usr/bin/env node
// Aegis C6-P8 — second task family: a small code repair on a temp copy, judged
// by an EXTERNAL read-only test the model cannot modify.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-code-repair.mjs

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
import { buildCodeRepairManifest, createCodeRepairJudge } from "../memory/campaign/code-repair-adapter.mjs";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { runRegisteredTest } from "../memory/campaign/registered-test.mjs";
import { verifyChain } from "../memory/runtime/events.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-code-"));
const failures = [];
function check(name, condition, detail) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures.push(name);
		console.log(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}
function readEvents(path) {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

const BROKEN_SOLUTION = `export function add(a, b) {\n\treturn a - b;\n}\n`;
const FIXED_SOLUTION = `export function add(a, b) {\n\treturn a + b;\n}\n`;
// The EXTERNAL test is written by the HOST, not the model. It imports the
// solution and prints a machine-readable summary.
const CHECK_TEST = `import { add } from "./solution.mjs";\nlet passed = 0, failed = 0;\nif (add(2, 3) === 5) passed++; else failed++;\nif (add(-1, 1) === 0) passed++; else failed++;\nconsole.log(\`PASSED=\${passed} FAILED=\${failed}\`);\nprocess.exit(failed === 0 ? 0 : 1);\n`;

try {
	const workspaceRoot = join(base, "workspace");
	const workDir = join(base, "run");
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(join(workspaceRoot, "solution.mjs"), BROKEN_SOLUTION, "utf8");
	writeFileSync(join(workspaceRoot, "check.mjs"), CHECK_TEST, "utf8");

	const validated = validateManifest(buildCodeRepairManifest({ workspaceRoot }));
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
			task_family: "code-repair",
			registered_test: "check.mjs",
			session: { session_count: 2, max_requests_per_session: 10 },
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
		})}\n`,
		"utf8",
	);

	const eventLogPath = join(workDir, "events.jsonl");
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_RAM_DIR: join(workDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
		AEGIS_TASK_ID: "task-c6-code",
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	mkdirSync(join(workDir, "runtime"), { recursive: true });

	const seen = new Map();
	const outcome = await runC6FromConfig({
		configPath,
		scenario: "run",
		sdk,
		fauxProviderFactory: (options) => {
			const faux = registerFauxProvider(options);
			const mk = () => {
				const count = (seen.get("t") ?? 0) + 1;
				seen.set("t", count);
				if (count > 1) return fauxAssistantMessage("done");
				// The model proposes the fixed content as DATA via the reviewed adapter.
				return fauxAssistantMessage([
					fauxToolCall("aegis_task_decision", {
						actions: [
							{ action_ref: "code.file.write", arguments: { target: "solution.mjs", content: FIXED_SOLUTION } },
						],
					}),
				]);
			};
			faux.setResponses(Array.from({ length: 8 }, () => mk));
			return faux;
		},
		print: () => {},
	});

	check("the code-repair chain completed", outcome.ok === true, JSON.stringify(outcome.reasons));
	check("the product chain's events verify", outcome.chain_ok === true);
	check("task-001 completed", outcome.task_states?.["task-001"] === "completed", JSON.stringify(outcome.task_states));
	const events = readEvents(eventLogPath);
	check("verifyChain on disk", verifyChain(events).ok, JSON.stringify(verifyChain(events).errors));
	check(
		"the model's patch repaired the real file",
		readFileSync(join(workspaceRoot, "solution.mjs"), "utf8") === FIXED_SOLUTION,
	);
	check("the external test now passes", runRegisteredTest({ workspaceRoot, testFile: "check.mjs" }).ok === true);
	check(
		"the external test file was not modified by the model",
		readFileSync(join(workspaceRoot, "check.mjs"), "utf8") === CHECK_TEST,
	);

	// The independent Oracle judges by RUNNING the registered test, and it can
	// distinguish a wrong patch (failure) from a harness error (unknown).
	const judge = createCodeRepairJudge({
		workspaceRoot,
		runTests: (root) => runRegisteredTest({ workspaceRoot: root, testFile: "check.mjs" }),
	});
	const passTask = {
		task_id: "j1",
		target_ref: "solution.mjs",
		stages: [{ stage_id: "s1", criteria: ["external test passes"] }],
	};
	check("Oracle judges the repaired state success", judge({ task: passTask, attempt: 1 }).status === "success");

	// Break the file and re-judge: a real failure, not a fake pass.
	writeFileSync(join(workspaceRoot, "solution.mjs"), BROKEN_SOLUTION, "utf8");
	check("Oracle judges the broken state failure", judge({ task: passTask, attempt: 1 }).status === "failure");

	// A missing test is a harness error (unknown), never a pass.
	const unknownJudge = createCodeRepairJudge({
		workspaceRoot,
		runTests: (root) => runRegisteredTest({ workspaceRoot: root, testFile: "missing.mjs" }),
	});
	check("Oracle keeps a missing test unknown", unknownJudge({ task: passTask, attempt: 1 }).status === "unknown");

	// A model patch targeting the test file itself is refused by the grant (the
	// Task grant only authorizes solution.mjs). Use a FRESH workspace + work dir so
	// task-001 is undispatched.
	const tamperWorkspace = join(base, "tamper-ws");
	const tamperWorkDir = join(base, "tamper-run");
	mkdirSync(tamperWorkspace, { recursive: true });
	writeFileSync(join(tamperWorkspace, "solution.mjs"), BROKEN_SOLUTION, "utf8");
	writeFileSync(join(tamperWorkspace, "check.mjs"), CHECK_TEST, "utf8");
	const tamperManifest = validateManifest(
		buildCodeRepairManifest({ workspaceRoot: tamperWorkspace, campaignId: "campaign-c6-code-tamper" }),
	);
	assert.equal(tamperManifest.ok, true, tamperManifest.reasons?.join("; "));
	const tamperManifestPath = join(base, "tamper-manifest.json");
	writeFileSync(tamperManifestPath, `${JSON.stringify(tamperManifest.manifest, null, 2)}\n`, "utf8");
	const tamperConfig = join(base, "tamper.config.json");
	writeFileSync(
		tamperConfig,
		`${JSON.stringify({
			schema_version: "campaign-config-1.1",
			manifest_path: tamperManifestPath,
			workspace_root: tamperWorkspace,
			work_dir: tamperWorkDir,
			mode: "auto",
			provider: { kind: "faux", model: "faux-c6" },
			context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
			learning: { policy: "off", promote_experience: false },
			task_family: "code-repair",
			registered_test: "check.mjs",
			session: { session_count: 2, max_requests_per_session: 10 },
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
		})}\n`,
		"utf8",
	);
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: join(tamperWorkDir, "events.jsonl"),
		AEGIS_RAM_DIR: join(tamperWorkDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(tamperWorkDir, "runtime", "handoff.json"),
	});
	mkdirSync(join(tamperWorkDir, "runtime"), { recursive: true });
	const seen2 = new Map();
	const tamper = await runC6FromConfig({
		configPath: tamperConfig,
		scenario: "run",
		sdk,
		fauxProviderFactory: (options) => {
			const faux = registerFauxProvider(options);
			const mk = () => {
				const count = (seen2.get("t") ?? 0) + 1;
				seen2.set("t", count);
				if (count > 1) return fauxAssistantMessage("done");
				return fauxAssistantMessage([
					fauxToolCall("aegis_task_decision", {
						actions: [
							{ action_ref: "code.file.write", arguments: { target: "check.mjs", content: "process.exit(0)" } },
						],
					}),
				]);
			};
			faux.setResponses(Array.from({ length: 8 }, () => mk));
			return faux;
		},
		print: () => {},
	});
	check(
		"a model patch to the judge test is refused",
		tamper.task_states?.["task-001"] !== "completed",
		JSON.stringify(tamper.task_states),
	);
	check(
		"the judge test is unchanged after the tamper attempt",
		readFileSync(join(tamperWorkspace, "check.mjs"), "utf8") === CHECK_TEST,
	);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 code repair: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 code repair: all checks passed");
