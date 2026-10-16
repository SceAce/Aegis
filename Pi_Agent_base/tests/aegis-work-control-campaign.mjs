// Real Campaign entry + SDK/faux: waiting prevents buffered Broker dispatch and restart.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdkCore from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";

const sdk = { ...sdkCore, AuthStorage };

import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { buildC3FixtureManifest } from "../campaign/c3-entry.mjs";
import { runC6FromConfig } from "../campaign/c6-entry.mjs";
import { validateManifest } from "../campaign/manifest.mjs";
import { projectWorkControl } from "../orchestration/work-control.mjs";
import { EventLog, verifyChain } from "../shared/events.mjs";

const root = mkdtempSync(join(tmpdir(), "aegis-work-campaign-"));
const workspace = join(root, "workspace");
mkdirSync(workspace);
writeFileSync(join(workspace, "door.json"), '{"locked":true}\n');
const manifest = validateManifest(buildC3FixtureManifest({ workspaceRoot: workspace }));
assert.equal(manifest.ok, true);
const manifestPath = join(root, "manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest.manifest));
const config = join(root, "config.json");
const work = join(root, "run");
writeFileSync(
	config,
	JSON.stringify({
		schema_version: "campaign-config-1.1",
		manifest_path: manifestPath,
		workspace_root: workspace,
		work_dir: work,
		mode: "auto",
		provider: { kind: "faux", model: "work-test" },
		context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
		learning: { policy: "off", promote_experience: false },
		task_family: "fixture-state",
		session: { session_count: 5, max_requests_per_session: 10 },
		observation: { enabled: false, port: 0 },
		oracle: { kind: "fixture" },
	}),
);
const path = join(work, "events.jsonl");
let calls = 0;
const events = () => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
try {
	const result = await runC6FromConfig({
		configPath: config,
		sdk,
		print() {},
		fauxProviderFactory(options) {
			const faux = registerFauxProvider(options);
			faux.setResponses([
				() => {
					calls++;
					return fauxAssistantMessage([fauxToolCall("aegis_read", { path: "door.json" })]);
				},
				() => {
					calls++;
					const rows = events();
					const done = rows.findLast(
						(r) => r.event_type === "action.completed" && r.payload.tool_name === "aegis_read",
					);
					return fauxAssistantMessage([
						fauxToolCall("aegis_task_decision", {
							actions: [
								{ action_ref: "fixture.state.set", arguments: { target: "door.json", key: "locked", value: false } },
							],
						}),
						fauxToolCall("aegis_submit_candidate", {
							target_ref: "door.json",
							criterion_id: manifest.manifest.tasks[0].goal.success_criteria[0],
							evidence_event_ids: [done.event_id],
						}),
						fauxToolCall("aegis_read", { path: "door.json" }),
					]);
				},
			]);
			return faux;
		},
	});
	assert.equal(result.ok, true, JSON.stringify(result.reasons));
	assert.equal(calls, 2);
	assert.equal(result.work_control.find((row) => row.task_id === "task-001").state, "waiting_external");
	const control = projectWorkControl(events(), "task-001");
	assert.equal(control.state, "waiting_external");
	assert.equal(control.candidate.episode_id, "ep-task-001", "Observer candidate uses Host accepted Episode identity");
	assert.equal(
		events().filter((r) => r.event_type === "action.completed" && r.payload.tool_name === "aegis_read").length,
		1,
		"same-batch read after candidate is blocked",
	);
	const candidateIndex = events().findIndex((r) => r.payload?.kind === "work.candidate");
	assert.ok(
		events()
			.slice(candidateIndex + 1)
			.some(
				(r) =>
					r.payload?.kind === "c6.tool" &&
					r.payload.phase === "finished" &&
					r.payload.tool_name === "aegis_submit_candidate",
			),
		"candidate charged unit finishes durably before settle",
	);
	assert.equal(JSON.parse(readFileSync(join(workspace, "door.json"), "utf8")).locked, true);
	assert.equal(
		events().filter((r) => r.source?.adapter === "c3-broker-worker" && r.event_type === "action.requested").length,
		0,
	);
	assert.equal(events().filter((r) => r.payload?.kind === "campaign.task.completed").length, 0);
	let restarted = 0;
	const again = await runC6FromConfig({
		configPath: config,
		sdk,
		print() {},
		fauxProviderFactory(options) {
			const f = registerFauxProvider(options);
			f.setResponses([
				() => {
					restarted++;
					return fauxAssistantMessage("must not run");
				},
			]);
			return f;
		},
	});
	assert.equal(again.ok, true, JSON.stringify(again.reasons));
	assert.equal(restarted, 0);
	assert.equal(projectWorkControl(events(), "task-001").state, "waiting_external");
	assert.equal(verifyChain(events()).ok, true);
	const chargesBeforeResume = events().filter((r) => r.payload?.kind === "campaign.budget.consumed").length;
	let continued = 0;
	await runC6FromConfig({
		configPath: config,
		scenario: "resume",
		sdk,
		print() {},
		fauxProviderFactory(options) {
			const f = registerFauxProvider(options);
			f.setResponses([
				() => {
					continued++;
					return fauxAssistantMessage("No new decision; stop safely");
				},
			]);
			return f;
		},
	});
	assert.equal(continued, 1, "Host CLI resume clears candidate wait and permits one current-task continuation");
	assert.equal(projectWorkControl(events(), "task-001").state, "exploring");
	assert.equal(
		events().filter((r) => r.payload?.kind === "campaign.budget.consumed").length,
		chargesBeforeResume,
		"continuation does not double-charge synthetic dispatch cost",
	);
	assert.equal(events().filter((r) => r.payload?.kind === "work.continuation.started").length, 1);
	assert.equal(
		events().filter((r) => r.source?.adapter === "c3-broker-worker" && r.event_type === "action.requested").length,
		0,
	);
	// An established legacy stream must remain inspectable, with its side-aware
	// consumption intact, and refuse entry before creating any provider.
	const legacyWork = join(root, "legacy");
	mkdirSync(legacyWork);
	const legacyConfig = join(root, "legacy-config.json");
	const legacySettings = JSON.parse(readFileSync(config, "utf8"));
	legacySettings.work_dir = legacyWork;
	writeFileSync(legacyConfig, JSON.stringify(legacySettings));
	const legacyPath = join(legacyWork, "events.jsonl");
	const legacyLog = new EventLog(legacyPath);
	assert.equal((await legacyLog.open()).ok, true);
	const identity = {
		kind: "c6.request",
		request_id: "legacy-r",
		task_id: "task-001",
		campaign_id: manifest.manifest.campaign_id,
		task_reservation_id: "legacy-t",
		campaign_reservation_id: "legacy-c",
		input_chars: 123,
		tool_calls: 7,
	};
	for (const phase of ["reserved", "committed"]) {
		const written = await legacyLog.append({
			event_type: "runtime.note",
			episode_id: "ep-task-001",
			source: { kind: "runtime", component: "test" },
			payload: { ...identity, phase },
		});
		assert.equal(written.ok, true);
	}
	await legacyLog.close();
	const legacyBytes = readFileSync(legacyPath, "utf8");
	let legacyProviders = 0;
	const refused = await runC6FromConfig({
		configPath: legacyConfig,
		sdk,
		print() {},
		fauxProviderFactory() {
			legacyProviders++;
			throw new Error("legacy provider must not be constructed");
		},
	});
	assert.equal(refused.ok, false);
	assert.match(refused.reasons.join(" "), /migration_required/);
	assert.equal(refused.consumed.tool_calls, 7);
	assert.equal(refused.consumed.model_requests, 1);
	assert.equal(legacyProviders, 0);
	assert.equal(readFileSync(legacyPath, "utf8"), legacyBytes);
	const status = await runC6FromConfig({ configPath: legacyConfig, scenario: "status", sdk, print() {} });
	assert.equal(status.ok, true, JSON.stringify(status.reasons));
	assert.equal(status.ledger.consumed.tool_calls, 7, "status retains legacy tool consumption");
	assert.equal(readFileSync(legacyPath, "utf8"), legacyBytes, "legacy status is read-only");
	console.log(
		"Campaign candidate wait: two real faux requests, zero Broker effects/completion, restart zero provider calls",
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
