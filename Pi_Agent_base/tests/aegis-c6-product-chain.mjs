#!/usr/bin/env node
// Aegis C6-P1 product chain — real SDK + faux through the automatic product
// entry on the structured data repair/transform task family.
//
// Proves: the model's structured decision drives the action; a legal dynamic
// proposal is really admitted and dispatched; the independent Oracle judges the
// real output with success/failure/unknown samples; no caller runtime/beforeRun.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-product-chain.mjs

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
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { buildDataRepairManifest, createDataRepairJudge } from "../memory/campaign/structured-data-adapter.mjs";
import { verifyChain } from "../memory/runtime/events.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-chain-"));
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

// A scripted model: repair `name` on task-001, transform `status` on task-002,
// and propose a bounded dynamic follow-up task after task-001.
function makeFaux(options, { proposeDynamic = false } = {}) {
	const seen = new Map();
	const faux = registerFauxProvider(options);
	const makeResponse = (context) => {
		const text = JSON.stringify(context.messages);
		const taskId = [...text.matchAll(/TASK (task-\d+)/g)].at(-1)?.[1] ?? "task-001";
		const count = (seen.get(taskId) ?? 0) + 1;
		seen.set(taskId, count);
		if (count > 1) return fauxAssistantMessage("decision recorded");
		if (taskId === "task-001") {
			const decision = {
				actions: [
					{ action_ref: "data.record.set", arguments: { target: "dataset.json", field: "name", value: "Ada" } },
				],
			};
			if (proposeDynamic) {
				decision.propose_task = {
					proposed_task_id: "task-003",
					parent_task_id: "task-001",
					task_type: "reproduce",
					target_ref: "dataset.json",
					goal: { description: "Re-verify the normalized status field.", success_criteria: ["data.status == active"] },
					required_capabilities: ["data.record.write"],
					expected_evidence: ["artifact:task-003"],
					stop_condition: "status is normalized",
					priority: 5,
					budget_reservation: { wall_time_ms: 30000, model_requests: 5, tool_calls: 10 },
				};
			}
			return fauxAssistantMessage([fauxToolCall("aegis_task_decision", decision)]);
		}
		return fauxAssistantMessage([
			fauxToolCall("aegis_task_decision", {
				actions: [
					{ action_ref: "data.record.set", arguments: { target: "dataset.json", field: "status", value: "active" } },
				],
			}),
		]);
	};
	faux.setResponses(Array.from({ length: 16 }, () => makeResponse));
	return faux;
}

try {
	const workspaceRoot = join(base, "workspace");
	const workDir = join(base, "run");
	mkdirSync(workspaceRoot, { recursive: true });
	// A malformed starting dataset: name is wrong, status is missing.
	writeFileSync(join(workspaceRoot, "dataset.json"), `${JSON.stringify({ name: "??", other: 1 })}\n`, "utf8");

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

	const eventLogPath = join(workDir, "events.jsonl");
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_RAM_DIR: join(workDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
		AEGIS_TASK_ID: "task-c6-chain",
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	mkdirSync(join(workDir, "runtime"), { recursive: true });

	const outcome = await runC6FromConfig({
		configPath,
		scenario: "run",
		sdk,
		fauxProviderFactory: (options) => makeFaux(options, { proposeDynamic: true }),
		print: () => {},
	});

	check("entry returned ok", outcome.ok === true, JSON.stringify(outcome.reasons));
	check("event chain verifies", outcome.chain_ok === true);
	const events = readEvents(eventLogPath);
	check("verifyChain on disk", verifyChain(events).ok, JSON.stringify(verifyChain(events).errors));
	check(
		"task-001 completed (repair)",
		outcome.task_states?.["task-001"] === "completed",
		JSON.stringify(outcome.task_states),
	);
	check(
		"task-002 completed (transform)",
		outcome.task_states?.["task-002"] === "completed",
		JSON.stringify(outcome.task_states),
	);
	check(
		"the real output was repaired by the Broker decision",
		JSON.parse(readFileSync(join(workspaceRoot, "dataset.json"), "utf8")).name === "Ada",
		readFileSync(join(workspaceRoot, "dataset.json"), "utf8"),
	);

	// C6-P1: a legal dynamic proposal is really admitted and dispatched.
	const admitted = events.filter(
		(e) => e.event_type === "runtime.note" && e.payload?.kind === "campaign.proposal.admitted",
	);
	const submitted = events.filter(
		(e) => e.event_type === "runtime.note" && e.payload?.kind === "campaign.proposal.submitted",
	);
	check("a proposal was submitted", submitted.length >= 1, `count=${submitted.length}`);
	check("a dynamic proposal was admitted", admitted.length >= 1, `count=${admitted.length}`);
	check(
		"the admitted dynamic task really ran",
		Object.hasOwn(outcome.task_states ?? {}, "task-003"),
		JSON.stringify(outcome.task_states),
	);
	check(
		"the dynamic admission is reported",
		(outcome.dynamic_admissions ?? []).some((a) => a?.status === "admitted"),
		JSON.stringify(outcome.dynamic_admissions),
	);

	// The independent Oracle distinguishes success/failure/unknown.
	const judge = createDataRepairJudge({ workspaceRoot });
	const okTask = {
		task_id: "j1",
		target_ref: "dataset.json",
		stages: [{ stage_id: "s1", criteria: ["data.name == Ada"] }],
	};
	const wrongTask = {
		task_id: "j2",
		target_ref: "dataset.json",
		stages: [{ stage_id: "s2", criteria: ["data.name == Grace"] }],
	};
	const unknownTask = {
		task_id: "j3",
		target_ref: "missing.json",
		stages: [{ stage_id: "s3", criteria: ["data.name == Ada"] }],
	};
	const unregisteredTask = {
		task_id: "j4",
		target_ref: "dataset.json",
		stages: [{ stage_id: "s4", criteria: ["free text"] }],
	};
	check("Oracle judges a correct sample success", judge({ task: okTask, attempt: 1 }).status === "success");
	check("Oracle judges a wrong sample failure", judge({ task: wrongTask, attempt: 1 }).status === "failure");
	check("Oracle keeps a missing target unknown", judge({ task: unknownTask, attempt: 1 }).status === "unknown");
	check(
		"Oracle keeps an unregistered criterion unknown",
		judge({ task: unregisteredTask, attempt: 1 }).status === "unknown",
	);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 product chain: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 product chain: all checks passed");
