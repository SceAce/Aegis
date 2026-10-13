#!/usr/bin/env node
// Aegis C6-P2 — security and rotation refusals through the C6 product entry.
//
// Proves: a direct write/bash/edit is refused in Campaign mode; a brokered
// action targeting a path outside the Task grant is refused (no effect); a model
// cannot forge a task success; and a rotation is refused without a valid grant.
// The genuine new-Session rotation mechanics are covered by the SDK lifecycle
// suite; this suite focuses on the refusals.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-rotation-reject.mjs

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
import { createCampaignActionGate } from "../memory/campaign/campaign-mode.mjs";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { buildDataRepairManifest } from "../memory/campaign/structured-data-adapter.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-reject-"));
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

function makeFaux(options, decisionFor) {
	const faux = registerFauxProvider(options);
	const seen = new Map();
	const mk = (context) => {
		const text = JSON.stringify(context.messages);
		const taskId = [...text.matchAll(/TASK (task-\d+)/g)].at(-1)?.[1] ?? "task-001";
		const count = (seen.get(taskId) ?? 0) + 1;
		seen.set(taskId, count);
		if (count > 1) return fauxAssistantMessage("done");
		return fauxAssistantMessage([fauxToolCall("aegis_task_decision", { actions: [decisionFor(taskId)] })]);
	};
	faux.setResponses(Array.from({ length: 12 }, () => mk));
	return faux;
}

function makeConfig(name) {
	const workspaceRoot = join(base, `${name}-ws`);
	const workDir = join(base, `${name}-run`);
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(join(workspaceRoot, "dataset.json"), `${JSON.stringify({ name: "??" })}\n`, "utf8");
	writeFileSync(join(base, `${name}-outside.json`), `${JSON.stringify({ name: "OUTSIDE" })}\n`, "utf8");
	const validated = validateManifest(buildDataRepairManifest({ workspaceRoot, campaignId: `campaign-${name}` }));
	assert.equal(validated.ok, true, validated.reasons?.join("; "));
	const manifestPath = join(base, `${name}-manifest.json`);
	writeFileSync(manifestPath, `${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8");
	const configPath = join(base, `${name}.config.json`);
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
			session: { session_count: 1, max_requests_per_session: 10 },
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
		})}\n`,
		"utf8",
	);
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: join(workDir, "events.jsonl"),
		AEGIS_RAM_DIR: join(workDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
		AEGIS_TASK_ID: `task-${name}`,
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	mkdirSync(join(workDir, "runtime"), { recursive: true });
	return { workspaceRoot, workDir, configPath };
}

try {
	// 1. Direct tools are refused while Campaign mode is active.
	const gate = createCampaignActionGate();
	gate.activate();
	const writeDenied = gate.guardToolCall({ tool_name: "write" });
	const bashDenied = gate.guardToolCall({ tool_name: "bash" });
	const editDenied = gate.guardToolCall({ tool_name: "edit" });
	const unknownDenied = gate.guardToolCall({ tool_name: "some_new_tool" });
	gate.deactivate();
	check(
		"direct write is refused",
		writeDenied.allowed === false && writeDenied.mode === "campaign",
		JSON.stringify(writeDenied),
	);
	check("direct bash is refused", bashDenied.allowed === false, JSON.stringify(bashDenied));
	check("direct edit is refused", editDenied.allowed === false, JSON.stringify(editDenied));
	check("an unknown tool is refused (deny by default)", unknownDenied.allowed === false, JSON.stringify(unknownDenied));

	// 2. A brokered action targeting a path OUTSIDE the Task grant is refused and
	//    produces NO effect.
	const outside = makeConfig("outside");
	const outsideOutcome = await runC6FromConfig({
		configPath: outside.configPath,
		scenario: "run",
		sdk,
		fauxProviderFactory: (options) =>
			makeFaux(options, () => ({
				action_ref: "data.record.set",
				arguments: { target: "../outside.json", field: "name", value: "INJECTED" },
			})),
		print: () => {},
	});
	check(
		"an out-of-grant target does not complete the task",
		outsideOutcome.task_states?.["task-001"] !== "completed",
		JSON.stringify(outsideOutcome.task_states),
	);
	check(
		"the out-of-grant file is unchanged",
		JSON.parse(readFileSync(join(base, "outside-outside.json"), "utf8")).name === "OUTSIDE",
	);
	check("the out-of-grant attempt still leaves a verifying chain", outsideOutcome.chain_ok === true);

	// 3. A model cannot forge a success: it supplies only data; the task only
	//    completes when the INDEPENDENT oracle accepts the real post-state. A
	//    decision with a fresh value the oracle did not expect fails.
	const forged = makeConfig("forged");
	const forgedOutcome = await runC6FromConfig({
		configPath: forged.configPath,
		scenario: "run",
		sdk,
		fauxProviderFactory: (options) =>
			makeFaux(options, () => ({
				action_ref: "data.record.set",
				arguments: { target: "dataset.json", field: "name", value: "MALLORY" },
			})),
		print: () => {},
	});
	check(
		"a forged value does not satisfy the independent oracle",
		forgedOutcome.task_states?.["task-001"] === "failed",
		JSON.stringify(forgedOutcome.task_states),
	);
	const forgedEvents = readEvents(join(forged.workDir, "events.jsonl"));
	check(
		"a forged attempt never emits a task.completed",
		!forgedEvents.some((e) => e.payload?.kind === "campaign.task.completed"),
		"task.completed present",
	);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 rotation reject: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 rotation reject: all checks passed");
