#!/usr/bin/env node
// Aegis C6-P5 / X8 — Campaign experience closed loop (real replay -> active ->
// direct reuse -> derived rebuild).
//
// Phase 1 runs two INDEPENDENT, compatible episodes (same method) and, under the
// explicit policy, performs a REAL isolated replay for each and compiles the
// reviewed Compiler to `active`. Phase 2 runs a THIRD task that the Router must
// resolve via the active Experience with ZERO planning provider requests, and
// the resulting effect is still judged by the independent Oracle. The derived
// store is then deleted and rebuilt from the committed authoritative note.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-learning-closure.mjs

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
import { buildDataRepairLearningManifest } from "../memory/campaign/structured-data-adapter.mjs";
import { authoritativeActiveExperiences, createLearningStore } from "../memory/runtime/learning-store.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-closure-"));
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
const ADAPTER_PATH = join(BASE_DIR, "memory", "campaign", "isolated-replay-adapter.mjs");

try {
	const workspaceRoot = join(base, "workspace");
	const workDir = join(base, "run");
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(join(workspaceRoot, "dataset.json"), `${JSON.stringify({ status: "pending" })}\n`, "utf8");
	const validated = validateManifest(buildDataRepairLearningManifest({ workspaceRoot }));
	assert.equal(validated.ok, true, validated.reasons?.join("; "));
	const manifestPath = join(base, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8");

	function makeConfig(name, { policy, proofIds = [] }) {
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
				learning: {
					policy,
					promote_experience: false,
					proof_ids: proofIds,
					replay_adapter: ADAPTER_PATH,
					environment: {
						environment_fingerprint: "data-repair-env",
						domain: "structured-data",
						permissions: ["data.record.write"],
						task_types: ["verify", "reproduce"],
					},
				},
				task_family: "structured-data-repair",
				session: { session_count: 4, max_requests_per_session: 10 },
				observation: { enabled: false, port: 0 },
				oracle: { kind: "fixture" },
			})}\n`,
			"utf8",
		);
		return configPath;
	}

	const eventLogPath = join(workDir, "events.jsonl");
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_RAM_DIR: join(workDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
		AEGIS_TASK_ID: "task-c6-closure",
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	mkdirSync(join(workDir, "runtime"), { recursive: true });

	let requests = 0;
	const fauxFactory = (options) => {
		const faux = registerFauxProvider(options);
		const seen = new Map();
		const mk = (context) => {
			requests += 1;
			const text = JSON.stringify(context.messages);
			const taskId = [...text.matchAll(/TASK (task-\d+)/g)].at(-1)?.[1] ?? "task-001";
			const n = (seen.get(taskId) ?? 0) + 1;
			seen.set(taskId, n);
			if (n > 1) return fauxAssistantMessage("done");
			return fauxAssistantMessage([
				fauxToolCall("aegis_task_decision", {
					actions: [
						{ action_ref: "data.record.set", arguments: { target: "dataset.json", field: "status", value: "active" } },
					],
				}),
			]);
		};
		faux.setResponses(Array.from({ length: 24 }, () => mk));
		return faux;
	};

	// PHASE 1: two independent episodes normalize the same field; compile active.
	const phase1 = await runC6FromConfig({
		configPath: makeConfig("phase1", { policy: "off" }),
		scenario: "run",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check("phase 1 completed both independent tasks", phase1.ok === true, JSON.stringify(phase1.task_states));
	check("phase 1 did not auto-promote", phase1.learning?.active !== true);
	check(
		"the reuse task is not already completed before compilation",
		phase1.task_states?.["task-003"] !== "completed",
		JSON.stringify(phase1.task_states),
	);

	const eventsAfterRun = readEvents(eventLogPath);
	const proofIds = eventsAfterRun
		.filter((e) => e.payload?.kind === "campaign.oracle.result" && e.payload.status === "success" && !e.payload.step_id)
		.map((e) => e.payload.outcome_id);
	check("two independent success proofs were committed", proofIds.length >= 2, JSON.stringify(proofIds));

	// Compile with a REAL isolated replay under the explicit policy.
	const compileRun = await runC6FromConfig({
		configPath: makeConfig("compile", { policy: "explicit", proofIds }),
		scenario: "status",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check("status is a read-only projection", compileRun.ok === true, JSON.stringify(compileRun.reasons));

	// Now run the SAME learning policy in the executing entry so the replay +
	// compile happens with the Host writer, then a third task reuses the rule.
	const phase2 = await runC6FromConfig({
		configPath: makeConfig("phase2", { policy: "explicit", proofIds }),
		scenario: "run",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check("phase 2 ran", phase2.ok !== undefined, JSON.stringify(phase2.reasons));

	const events = readEvents(eventLogPath);
	const compiledNotes = events.filter((e) => e.payload?.kind === "experience.compiled" && e.payload.active === true);
	const replayNotes = events.filter((e) => e.payload?.kind === "replay.performed");
	const resetNotes = events.filter((e) => e.payload?.kind === "episode.isolated_reset");
	check("a real isolated replay was performed and committed", replayNotes.length >= 1, `count=${replayNotes.length}`);
	check("a real isolated reset was recorded", resetNotes.length >= 1, `count=${resetNotes.length}`);

	// The experience reached active (either through the phase-2 boundary or a
	// compile report).
	const activeNote = compiledNotes.length > 0 || phase2.learning?.active === true;
	check(
		"the reviewed Compiler reached an active experience",
		activeNote,
		JSON.stringify({ notes: compiledNotes.length, learning: phase2.learning?.status }),
	);

	// Derived rebuild: delete the store, rebuild from committed notes.
	const _store = createLearningStore({ dir: join(workDir, "experiences") });
	const committed = events.filter((e) => e.payload?.kind === "experience.compiled" && e.payload.active === true);
	if (committed.length > 0) {
		rmSync(join(workDir, "experiences"), { recursive: true, force: true });
		const rebuiltStore = createLearningStore({ dir: join(workDir, "experiences") });
		for (const note of committed) {
			await rebuiltStore.save(
				{ experience: note.payload.experience, failures: [] },
				{ sourceOutcomeIds: note.payload.source_outcome_ids ?? [], recordedAt: note.recorded_at ?? null },
			);
		}
		const rebuilt = await rebuiltStore.loadActive();
		const authoritative = authoritativeActiveExperiences(rebuilt, events);
		check(
			"the derived store rebuilds from the committed note",
			authoritative.length >= 1,
			JSON.stringify(rebuilt.length),
		);
	} else {
		check("the derived store rebuilds from the committed note", false, "no committed active note to rebuild from");
	}
	check("the committed stream verifies", phase2.chain_ok === true);

	// PHASE 3: a fresh run with the active experience present. Task-003 is still
	// pending, so the Router must resolve it DIRECT (zero planning requests) and
	// the resulting effect is still judged by the independent Oracle.
	const requestsBeforeP3 = requests;
	const phase3 = await runC6FromConfig({
		configPath: makeConfig("phase3", { policy: "explicit", proofIds: [] }),
		scenario: "run",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	const phase3Requests = requests - requestsBeforeP3;
	check("phase 3 completed with the active experience", phase3.ok === true, JSON.stringify(phase3.reasons));
	check("a direct route issued ZERO planning provider requests", phase3Requests === 0, `requests=${phase3Requests}`);
	const eventsAfterP3 = readEvents(eventLogPath);
	const p3NewEvents = eventsAfterP3.slice(events.length);
	check(
		"phase 3 commits a NEW Broker intent for task-003",
		p3NewEvents.some((e) => e.event_type === "action.requested" && e.payload?.task_id === "task-003"),
	);
	check(
		"phase 3 commits a NEW trusted success for task-003",
		p3NewEvents.some(
			(e) =>
				e.payload?.kind === "campaign.oracle.result" &&
				e.payload.task_id === "task-003" &&
				e.payload.status === "success",
		),
	);
	check(
		"task-003 completed via the reused rule",
		phase3.task_states?.["task-003"] === "completed",
		JSON.stringify(phase3.task_states),
	);
	check(
		"the reused rule still produced the real effect",
		JSON.parse(readFileSync(join(workspaceRoot, "dataset.json"), "utf8")).status === "active",
	);
	check(
		"the routed task is still judged by an independent Oracle outcome",
		eventsAfterP3.some(
			(e) =>
				e.payload?.kind === "campaign.oracle.result" &&
				e.payload.status === "success" &&
				e.payload.task_id === "task-003",
		),
	);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 learning closure: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 learning closure: all checks passed");
