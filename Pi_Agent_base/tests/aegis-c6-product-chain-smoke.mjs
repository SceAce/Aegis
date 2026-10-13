#!/usr/bin/env node
// Aegis C6-A/B smoke — real SDK + faux through the automatic product entry.
//
// Verifies the product wiring: the entry creates the SDK runtime itself (no
// caller runtime/beforeRun), binds the current Campaign Task/Episode, drives the
// model's STRUCTURED decision, executes it through the ONE Broker, and judges it
// with the independent Oracle.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-product-chain-smoke.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";

const sdk = { ...sdkBase, AuthStorage };

import { buildC3FixtureManifest } from "../memory/campaign/c3-entry.mjs";
import { runC6FromConfig } from "../memory/campaign/c6-entry.mjs";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { verifyChain } from "../memory/runtime/events.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-smoke-"));
const failures = [];
const providerRequests = [];
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

try {
	const workspaceRoot = join(base, "workspace");
	const workDir = join(base, "run");
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(join(workspaceRoot, "door.json"), `${JSON.stringify({ locked: true })}\n`, "utf8");

	const validated = validateManifest(buildC3FixtureManifest({ workspaceRoot }));
	assert.equal(validated.ok, true, validated.reasons?.join("; "));
	const manifestPath = join(base, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8");
	const configPath = join(base, "campaign.config.json");
	writeFileSync(
		configPath,
		`${JSON.stringify(
			{
				schema_version: "campaign-config-1.1",
				manifest_path: manifestPath,
				workspace_root: workspaceRoot,
				work_dir: workDir,
				mode: "auto",
				provider: { kind: "faux", model: "faux-c6" },
				context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
				learning: { policy: "off", promote_experience: false },
				task_family: "fixture-state",
				session: { session_count: 2, max_requests_per_session: 10 },
				observation: { enabled: false, port: 0 },
				oracle: { kind: "fixture" },
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	const eventLogPath = join(workDir, "events.jsonl");
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_RAM_DIR: join(workDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
		AEGIS_TASK_ID: "task-c6-smoke",
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	mkdirSync(join(workDir, "runtime"), { recursive: true });

	// A dynamic faux response: read the task id from the prompt and state a
	// structured decision that writes locked=false via the registered action.
	const fauxFactory = (options) => {
		const faux = registerFauxProvider(options);
		const seen = new Map();
		const makeResponse = (context) => {
			const text = JSON.stringify(context.messages);
			const taskId = [...text.matchAll(/TASK (task-\d+)/g)].at(-1)?.[1] ?? "task-001";
			const target = "door.json";
			const count = (seen.get(taskId) ?? 0) + 1;
			seen.set(taskId, count);
			providerRequests.push(taskId);
			// First request per task states the decision; the follow-up request
			// (after the decision tool result) ends the turn with plain text.
			if (count > 1) return fauxAssistantMessage("decision recorded");
			const locked = taskId === "task-001";
			return fauxAssistantMessage([
				fauxToolCall("aegis_task_decision", {
					actions: [
						{
							action_ref: "fixture.state.set",
							arguments: { target, key: "locked", value: locked },
						},
					],
				}),
			]);
		};
		faux.setResponses(Array.from({ length: 8 }, () => makeResponse));
		return faux;
	};

	const outcome = await runC6FromConfig({
		configPath,
		scenario: "run",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});

	check("entry returned ok", outcome.ok === true, JSON.stringify(outcome.reasons));
	check("event chain verifies", outcome.chain_ok === true);
	const events = readEvents(eventLogPath);
	check("chain verifyChain on disk", verifyChain(events).ok, JSON.stringify(verifyChain(events).errors));
	check(
		"a model provider request was admitted and committed",
		outcome.ledger?.consumed?.model_requests >= 1,
		JSON.stringify(outcome.ledger?.consumed),
	);
	check(
		"usage source is labelled estimated/unknown",
		["estimated", "unknown"].includes(outcome.ledger?.usage_sources?.tokens),
		JSON.stringify(outcome.ledger?.usage_sources),
	);
	check("task-001 completed", outcome.task_states?.["task-001"] === "completed", JSON.stringify(outcome.task_states));
	check("task-002 completed", outcome.task_states?.["task-002"] === "completed", JSON.stringify(outcome.task_states));
	check(
		"the real effect was written through the Broker",
		JSON.parse(readFileSync(join(workspaceRoot, "door.json"), "utf8")).locked === false,
		readFileSync(join(workspaceRoot, "door.json"), "utf8"),
	);
	const completions = events.filter(
		(e) => e.event_type === "runtime.note" && e.payload?.kind === "campaign.task.completed",
	);
	check("two tasks completed durably", completions.length === 2, `count=${completions.length}`);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 product-chain smoke: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 product-chain smoke: all checks passed");
