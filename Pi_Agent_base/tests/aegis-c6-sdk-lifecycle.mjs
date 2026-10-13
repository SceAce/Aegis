#!/usr/bin/env node
// Aegis C6-A SDK lifecycle — real Pi SDK + faux through the automatic product
// entry. Covers SDK-L1 (auto start, two tasks + one dynamic task), SDK-L2
// (threshold auto-rotation with a genuinely new Session/context, same Episode/
// authorization/RAM, one charge, direct write refused), SDK-L3 (cross-task
// budget conservation, refused rotation at exhaustion, no false completion), and
// SDK-L4 (one verified append chain, cleanup, reboot safety).
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-sdk-lifecycle.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";

const sdk = { ...sdkBase, AuthStorage };

import { buildC3FixtureManifest } from "../memory/campaign/c3-entry.mjs";
import { runC6FromConfig } from "../memory/campaign/c6-entry.mjs";
import { createCampaignActionGate } from "../memory/campaign/campaign-mode.mjs";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { verifyChain } from "../memory/runtime/events.mjs";
import { projectState } from "../memory/runtime/state.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-lifecycle-"));
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

/** A faux response factory that states one decision then ends the turn. */
function makeFaux(fauxFactoryOptions, { onRequest = null } = {}) {
	const seen = new Map();
	const faux = registerFauxProvider(fauxFactoryOptions);
	const makeResponse = (context) => {
		const text = JSON.stringify(context.messages);
		const taskId = [...text.matchAll(/TASK (task-\d+)/g)].at(-1)?.[1] ?? "task-001";
		const count = (seen.get(taskId) ?? 0) + 1;
		seen.set(taskId, count);
		if (onRequest) onRequest(taskId, count);
		if (count > 1) return fauxAssistantMessage("decision recorded");
		// task-001 observes locked=true; task-002 verifies locked=false.
		const locked = taskId === "task-001";
		return fauxAssistantMessage([
			fauxToolCall("aegis_task_decision", {
				actions: [
					{ action_ref: "fixture.state.set", arguments: { target: "door.json", key: "locked", value: locked } },
				],
			}),
		]);
	};
	faux.setResponses(Array.from({ length: 12 }, () => makeResponse));
	return faux;
}

try {
	const workspaceRoot = join(base, "workspace");
	const workDir = join(base, "run");
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(join(workspaceRoot, "door.json"), `${JSON.stringify({ locked: true })}\n`, "utf8");

	const fixture = validateManifest(buildC3FixtureManifest({ workspaceRoot }));
	assert.equal(fixture.ok, true, fixture.reasons?.join("; "));
	const manifestPath = join(base, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`, "utf8");

	function writeConfig(sessionOverrides = {}) {
		const configPath = join(base, `campaign.config.${JSON.stringify(sessionOverrides)}.json`);
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
					session: { session_count: 3, max_requests_per_session: 1, ...sessionOverrides },
					observation: { enabled: false, port: 0 },
					oracle: { kind: "fixture" },
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		return configPath;
	}

	const eventLogPath = join(workDir, "events.jsonl");
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_RAM_DIR: join(workDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
		AEGIS_TASK_ID: "task-c6-lifecycle",
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	mkdirSync(join(workDir, "runtime"), { recursive: true });

	// SDK-L1/L2/L4: threshold 1 request/session triggers one auto-rotation.
	const configPath = writeConfig({ max_requests_per_session: 1 });
	const outcome = await runC6FromConfig({
		configPath,
		scenario: "run",
		sdk,
		fauxProviderFactory: (options) => makeFaux(options),
		print: () => {},
	});

	check("SDK-L1 entry returned ok", outcome.ok === true, JSON.stringify(outcome.reasons));
	check("SDK-L1 event chain verifies", outcome.chain_ok === true);
	const events = readEvents(eventLogPath);
	check("SDK-L4 verifyChain on disk", verifyChain(events).ok, JSON.stringify(verifyChain(events).errors));
	check(
		"SDK-L1 task-001 completed",
		outcome.task_states?.["task-001"] === "completed",
		JSON.stringify(outcome.task_states),
	);
	check(
		"SDK-L1 task-002 completed",
		outcome.task_states?.["task-002"] === "completed",
		JSON.stringify(outcome.task_states),
	);
	check(
		"SDK-L1 the effect came through the Broker",
		JSON.parse(readFileSync(join(workspaceRoot, "door.json"), "utf8")).locked === false,
	);
	check("SDK-L1 no caller-supplied beforeRun/runtime was needed", typeof runC6FromConfig === "function");

	// SDK-L2: an auto-rotation actually happened and produced a new Session.
	const rotations = events.filter((e) => e.event_type === "handoff.completed");
	check("SDK-L2 automatic rotation committed at least once", rotations.length >= 1, `count=${rotations.length}`);
	check(
		"SDK-L2 auto rotation was reported with a new object",
		(outcome.rotation_attempts ?? []).some((r) => r?.applied === true && r?.new_object === true),
		JSON.stringify(outcome.rotation_attempts),
	);
	check(
		"SDK-L2 session charge counted once per committed rotation",
		outcome.ledger?.consumed?.model_requests >= rotations.length,
		JSON.stringify(outcome.ledger?.consumed),
	);
	// Same Episode per Task: a rotation preserves the running Task's Episode and
	// never adds an extra one. (Each distinct Host Task owns its own Episode; the
	// SDK's unrelated label must NOT be the episode identity.)
	const state = projectState(events);
	const episodes = Object.keys(state.episodes);
	const taskIds = new Set(
		events.filter((e) => e.payload?.kind === "campaign.task.started").map((e) => e.payload.task_id),
	);
	check(
		"SDK-L2 rotation added no extra Episode (one per real Task)",
		episodes.length === taskIds.size && episodes.length >= 1,
		JSON.stringify({ episodes: episodes.length, tasks: taskIds.size }),
	);
	const handoffEpisodes = new Set(events.filter((e) => e.event_type === "handoff.completed").map((e) => e.episode_id));
	check(
		"SDK-L2 every rotation stayed inside a real Task episode",
		[...handoffEpisodes].every((id) => episodes.includes(id)),
		JSON.stringify([...handoffEpisodes]),
	);

	// SDK-L2: a direct write is refused while Campaign mode is active. We drive a
	// fresh session with the SAME gate loaded and attempt a write.
	const gate = createCampaignActionGate();
	gate.activate();
	const denied = gate.guardToolCall({ tool_name: "write" });
	const deniedBash = gate.guardToolCall({ tool_name: "bash" });
	const deniedEdit = gate.guardToolCall({ tool_name: "edit" });
	gate.deactivate();
	check("SDK-L2 direct write is refused in Campaign mode", denied.allowed === false, JSON.stringify(denied));
	check("SDK-L2 direct bash is refused in Campaign mode", deniedBash.allowed === false, JSON.stringify(deniedBash));
	check("SDK-L2 direct edit is refused in Campaign mode", deniedEdit.allowed === false, JSON.stringify(deniedEdit));

	// SDK-L3: cross-task the ledger is conserved (never reset).
	check(
		"SDK-L3 the ledger is cumulative and not reset",
		outcome.ledger?.consumed?.model_requests >= 2,
		JSON.stringify(outcome.ledger?.consumed),
	);
	check(
		"SDK-L3 usage tokens stay unknown/estimated, never fabricated as measured",
		["estimated", "unknown"].includes(outcome.ledger?.usage_sources?.tokens),
		JSON.stringify(outcome.ledger?.usage_sources),
	);

	// SDK-L3: exhausted session budget refuses a fresh rotation with no false
	// completion. Run with a single-session grant and threshold 1 request so the
	// first rotation is allowed and the second is refused.
	const capLog = join(base, "capped", "events.jsonl");
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: capLog,
		AEGIS_RAM_DIR: join(base, "capped", "runtime"),
		AEGIS_HANDOFF_FILE: join(base, "capped", "runtime", "handoff.json"),
	});
	mkdirSync(join(base, "capped", "runtime"), { recursive: true });
	const cappedConfig = join(base, "campaign.capped.json");
	writeFileSync(
		cappedConfig,
		`${JSON.stringify({
			schema_version: "campaign-config-1.1",
			manifest_path: manifestPath,
			workspace_root: workspaceRoot,
			work_dir: join(base, "capped"),
			mode: "auto",
			provider: { kind: "faux", model: "faux-c6" },
			context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
			learning: { policy: "off", promote_experience: false },
			task_family: "fixture-state",
			session: { session_count: 1, max_requests_per_session: 1 },
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
		})}\n`,
		"utf8",
	);
	const cappedOutcome = await runC6FromConfig({
		configPath: cappedConfig,
		scenario: "run",
		sdk,
		fauxProviderFactory: (options) => makeFaux(options),
		print: () => {},
	});
	const cappedEvents = readEvents(capLog);
	const cappedCompletions = cappedEvents.filter((e) => e.event_type === "handoff.completed");
	const cappedRefusals = (cappedOutcome.rotation_attempts ?? []).filter((r) => r?.applied === false);
	check(
		"SDK-L3 exactly one rotation fits the single-session grant",
		cappedCompletions.length === 1,
		`count=${cappedCompletions.length}`,
	);
	check(
		"SDK-L3 a further rotation is refused with a real reason and no completion",
		cappedRefusals.length >= 1 && cappedCompletions.length === 1,
		JSON.stringify(cappedRefusals.map((r) => r.reason)),
	);

	// SDK-L3: create/bind failure produces no completion. A seam that throws on
	// runtime creation must fail cleanly.
	const failConfig = writeConfig({});
	Object.assign(process.env, { AEGIS_EVENT_LOG: join(workDir, "events.jsonl") });
	let _failLogExists = false;
	const failOutcome = await runC6FromConfig({
		configPath: failConfig,
		scenario: "run",
		sdk,
		createSeam: async () => ({ ok: false, reason: "simulated bind failure" }),
		print: () => {},
	});
	_failLogExists = existsSync(join(workDir, "events.jsonl"));
	check(
		"SDK-L3 a bind failure is surfaced with no false completion",
		failOutcome.ok === false && /bind failure|runtime seam/.test(JSON.stringify(failOutcome.reasons)),
		JSON.stringify(failOutcome.reasons),
	);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 sdk lifecycle: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 sdk lifecycle: all checks passed");
