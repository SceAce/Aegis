#!/usr/bin/env node
// Aegis C6-P5 / X8 — Campaign experience closed loop (real replay -> active ->
// direct reuse -> derived rebuild).
//
// Phase 1 runs two INDEPENDENT, compatible episodes (same method) and, under the
// explicit policy, performs a REAL isolated replay for each and compiles the
// reviewed Compiler to `active`. The training manifest contains ONLY those two
// tasks, so the reuse task has NOT executed when compilation happens.
//
// Phase 2 runs a THIRD, genuinely undispatched task (its own manifest/campaign)
// whose target is reset to the pinned pre-state BEFORE dispatch. The Router must
// resolve it DIRECT from the active Experience with ZERO planning provider
// requests, and the resulting effect is judged by the independent Oracle. The
// derived store is then deleted and rebuilt from the committed authoritative
// note and a NEW task reuses it again.
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

import { runC6FromConfig } from "../campaign/c6-entry.mjs";
import { validateManifest } from "../campaign/manifest.mjs";
import {
	buildDataRepairLearningManifest,
	buildDataRepairReuseManifest,
} from "../execution/adapters/structured-data-adapter.mjs";
import { authoritativeActiveExperiences, createLearningStore } from "../memory/learning-store.mjs";

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
const ADAPTER_PATH = join(BASE_DIR, "execution", "adapters", "isolated-replay-adapter.mjs");

try {
	const workspaceRoot = join(base, "workspace");
	const workDir = join(base, "run");
	mkdirSync(workspaceRoot, { recursive: true });
	const writeDataset = (state) =>
		writeFileSync(join(workspaceRoot, "dataset.json"), `${JSON.stringify(state)}\n`, "utf8");
	writeDataset({ status: "pending" });
	// Training manifests: each run contains ONLY one compatible episode. The reuse
	// task does NOT exist in training, so it cannot have completed before the
	// compiled rule is applied. Each training episode is a SEPARATE campaign with
	// its own real reset to the pinned pre-state.
	// The DECLARED initial_state is deliberately DIFFERENT from the real reset, so a
	// rule whose `when` came from the declaration (not a real observation) would
	// not match the real current state and could not route `direct`.
	const DECLARED_STALE = { status: "declared-stale" };
	const trainingAManifest = buildDataRepairLearningManifest({
		workspaceRoot,
		campaignId: "campaign-c6-learn-a",
		taskIds: ["task-001"],
	});
	trainingAManifest.tasks[0].initial_state = DECLARED_STALE;
	const trainingA = validateManifest(trainingAManifest);
	assert.equal(trainingA.ok, true, trainingA.reasons?.join("; "));
	const manifestAPath = join(base, "manifest-a.json");
	writeFileSync(manifestAPath, `${JSON.stringify(trainingA.manifest, null, 2)}\n`, "utf8");
	const trainingBManifest = buildDataRepairLearningManifest({
		workspaceRoot,
		campaignId: "campaign-c6-learn-b",
		taskIds: ["task-002"],
	});
	trainingBManifest.tasks[0].initial_state = DECLARED_STALE;
	const trainingB = validateManifest(trainingBManifest);
	assert.equal(trainingB.ok, true, trainingB.reasons?.join("; "));
	const manifestBPath = join(base, "manifest-b.json");
	writeFileSync(manifestBPath, `${JSON.stringify(trainingB.manifest, null, 2)}\n`, "utf8");
	const reuseValidated = validateManifest(
		buildDataRepairReuseManifest({ workspaceRoot, taskId: "task-003", initial: DECLARED_STALE }),
	);
	assert.equal(reuseValidated.ok, true, reuseValidated.reasons?.join("; "));
	const reuseManifestPath = join(base, "reuse-manifest.json");
	writeFileSync(reuseManifestPath, `${JSON.stringify(reuseValidated.manifest, null, 2)}\n`, "utf8");

	function makeConfig(name, { policy, proofIds = [], manifest = manifestAPath }) {
		const configPath = join(base, `${name}.config.json`);
		writeFileSync(
			configPath,
			`${JSON.stringify({
				schema_version: "campaign-config-1.1",
				manifest_path: manifest,
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

	// PHASE 1: two independent, separately-reset episodes normalize the same field.
	writeDataset({ status: "pending" });
	const runA = await runC6FromConfig({
		configPath: makeConfig("run-a", { policy: "off", manifest: manifestAPath }),
		scenario: "run",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check(
		"training episode A completed",
		runA.task_states?.["task-001"] === "completed",
		JSON.stringify(runA.task_states),
	);
	writeDataset({ status: "pending" });
	const runB = await runC6FromConfig({
		configPath: makeConfig("run-b", { policy: "off", manifest: manifestBPath }),
		scenario: "run",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check(
		"training episode B completed",
		runB.task_states?.["task-002"] === "completed",
		JSON.stringify(runB.task_states),
	);
	const eventsAfterRun = readEvents(eventLogPath);
	const proofIds = eventsAfterRun
		.filter((e) => e.payload?.kind === "campaign.oracle.result" && e.payload.status === "success" && !e.payload.step_id)
		.map((e) => e.payload.outcome_id);
	check("two independent success proofs were committed", proofIds.length >= 2, JSON.stringify(proofIds));
	check(
		"the reuse task did not exist before compilation",
		reuseValidated.manifest.tasks.every(
			(t) => !eventsAfterRun.some((e) => e.payload?.task_id === t.task_id && e.event_type === "action.requested"),
		),
		JSON.stringify(reuseValidated.manifest.tasks.map((t) => t.task_id)),
	);

	// Compile with a REAL isolated replay under the explicit policy, driving the
	// SAME executing entry so the replay + compile happens with the Host writer.
	const _phase2EventsBefore = readEvents(eventLogPath).length;
	const phase2 = await runC6FromConfig({
		configPath: makeConfig("phase2", { policy: "explicit", proofIds, manifest: manifestBPath }),
		scenario: "run",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check("phase 2 ran", phase2.ok !== undefined, JSON.stringify(phase2.reasons));
	console.error("DEBUG learning=", JSON.stringify(phase2.learning, null, 2).slice(0, 4000));

	const events = readEvents(eventLogPath);
	const compiledNotes = events.filter((e) => e.payload?.kind === "experience.compiled" && e.payload.active === true);
	const replayNotes = events.filter((e) => e.payload?.kind === "replay.performed");
	const resetNotes = events.filter((e) => e.payload?.kind === "episode.isolated_reset");
	check("a real isolated replay was performed and committed", replayNotes.length >= 1, `count=${replayNotes.length}`);
	check("a real isolated reset was recorded", resetNotes.length >= 1, `count=${resetNotes.length}`);
	check(
		"the reviewed Compiler reached an active experience",
		compiledNotes.length >= 1,
		JSON.stringify({ notes: compiledNotes.length, learning: phase2.learning?.status }),
	);
	check("the committed stream verifies", phase2.chain_ok === true);
	// The proof `when` predicates come from the REAL observed pre-state, not the
	// declarative initial_state label, and are backed by a committed evidence ref.
	const successOutcomes = events
		.filter((e) => e.payload?.kind === "campaign.oracle.result" && e.payload.status === "success" && !e.payload.step_id)
		.map((e) => e.payload.outcome);
	check(
		"proof when predicates are pre-state observations with trusted refs",
		successOutcomes.length >= 2 &&
			successOutcomes.every(
				(o) =>
					Array.isArray(o.when) &&
					o.when.length > 0 &&
					o.when.every(
						(p) => typeof p.path === "string" && p.op && Array.isArray(p.verified_by) && p.verified_by.length > 0,
					) &&
					o.when.every((p) => p.path !== "environment.fingerprint"),
			),
		JSON.stringify(successOutcomes.map((o) => o.when)),
	);
	check(
		"proof recorded the real pre-state, not the declared initial_state",
		successOutcomes.every((o) => o.observed?.pre_state?.status === "pending") &&
			successOutcomes.every((o) => o.when?.every((p) => p.value !== DECLARED_STALE.status)),
		JSON.stringify(successOutcomes.map((o) => o.when)),
	);

	// Derived rebuild: delete the store, rebuild from committed notes.
	const _store = createLearningStore({ dir: join(workDir, "experiences") });
	if (compiledNotes.length > 0) {
		rmSync(join(workDir, "experiences"), { recursive: true, force: true });
		const rebuiltStore = createLearningStore({ dir: join(workDir, "experiences") });
		for (const note of compiledNotes) {
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

	// PHASE 3: reset the target to the pinned pre-state, then run a genuinely
	// undispatched reuse task with the active experience present. The Router must
	// resolve it DIRECT (zero planning requests) and the resulting effect must be
	// judged by the independent Oracle with NEW intent/effect/outcome.
	const _phase3Base = readEvents(eventLogPath).length;
	writeDataset({ status: "pending" });
	const requestsBeforeP3 = requests;
	const phase3 = await runC6FromConfig({
		configPath: makeConfig("phase3", { policy: "explicit", manifest: reuseManifestPath }),
		scenario: "run",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	const phase3Requests = requests - requestsBeforeP3;
	check("phase 3 completed the reuse task", phase3.ok === true, JSON.stringify(phase3.reasons));
	check("a direct route issued ZERO planning provider requests", phase3Requests === 0, `requests=${phase3Requests}`);
	const eventsAfterP3 = readEvents(eventLogPath);
	const p3NewEvents = eventsAfterP3.slice(_phase3Base);
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
