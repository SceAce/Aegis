#!/usr/bin/env node
// Aegis C6-P4 — durable control, restart, and stream integrity through the C6
// product entry on the structured-data family.
//
// The deeper effect-before/after append-failure and SIGKILL reconciliation are
// already proven on the SAME scheduler/Host by the C3 durability suite and the
// C1 eventlog-durability/integration-recovery suites (see the C6 report). This
// suite proves the C6-level wiring: typed pause/cancel are durable and survive a
// restart, a cancelled campaign does not revive, and the whole stream verifies.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-durability-recovery.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";

const sdk = { ...sdkBase, AuthStorage };

import { runC6FromConfig } from "../campaign/c6-entry.mjs";
import { validateManifest } from "../campaign/manifest.mjs";
import { buildDataRepairManifest } from "../execution/adapters/structured-data-adapter.mjs";
import { verifyChain } from "../shared/events.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-dur-"));
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
	const eventLogPath = join(workDir, "events.jsonl");
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_RAM_DIR: join(workDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
		AEGIS_TASK_ID: "task-c6-dur",
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	mkdirSync(join(workDir, "runtime"), { recursive: true });

	const fauxFactory = () => {
		const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-c6" }] });
		faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("no decision")));
		return faux;
	};

	// A pause is durable and survives a restart: a subsequent run does not
	// dispatch (control state comes from the projection).
	const paused = await runC6FromConfig({
		configPath,
		scenario: "pause",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check("a pause command is durable", paused.ok === true, JSON.stringify(paused.reasons));
	const pauseEvents = readEvents(eventLogPath).filter((e) => e.payload?.kind === "campaign.campaign.paused");
	check("the pause is a committed event", pauseEvents.length === 1, `count=${pauseEvents.length}`);

	// A restart with no resume stays paused and does not dispatch a task.
	const afterPause = await runC6FromConfig({
		configPath,
		scenario: "run",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check("a paused campaign does not dispatch on restart", afterPause.ok === true, JSON.stringify(afterPause.reasons));
	const started = readEvents(eventLogPath).filter((e) => e.payload?.kind === "campaign.task.started");
	check("no task started while paused", started.length === 0, `count=${started.length}`);

	// A cancel is durable and does not revive on restart.
	const cancelled = await runC6FromConfig({
		configPath,
		scenario: "cancel",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check("a cancel command is durable", cancelled.ok === true, JSON.stringify(cancelled.reasons));
	const afterCancel = await runC6FromConfig({
		configPath,
		scenario: "run",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check(
		"a cancelled campaign does not revive on restart",
		afterCancel.ok === true,
		JSON.stringify(afterCancel.reasons),
	);
	const events = readEvents(eventLogPath);
	check(
		"the cancellation survives (no redundant stop overwrites it)",
		events.some((e) => e.payload?.kind === "campaign.campaign.cancelled") &&
			!events.some((e) => e.payload?.kind === "campaign.campaign.stopped"),
		JSON.stringify(events.map((e) => e.payload?.kind).filter(Boolean)),
	);
	check(
		"the whole stream verifies after control + restart",
		verifyChain(events).ok,
		JSON.stringify(verifyChain(events).errors),
	);

	// A read-only status never dispatches and leaves the bytes unchanged.
	const bytesBefore = readFileSync(eventLogPath);
	await runC6FromConfig({ configPath, scenario: "status", sdk, fauxProviderFactory: fauxFactory, print: () => {} });
	check("a status read does not append events", Buffer.compare(bytesBefore, readFileSync(eventLogPath)) === 0);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 durability recovery: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 durability recovery: all checks passed");
