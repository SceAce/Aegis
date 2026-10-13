#!/usr/bin/env node
// Aegis C6-P7 / SDK-L5 — read-only observation service and measurement export.
//
// Proves: the observation server is actually reachable over loopback HTTP, has
// NO write route, does not change the source bytes; an occupied port does not
// block execution; and the measure export keeps every attempt and labels
// unobservable usage as unknown/null (never 0).
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-service-measure.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";

const sdk = { ...sdkBase, AuthStorage };

import { runC6FromConfig } from "../memory/campaign/c6-entry.mjs";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { buildDataRepairManifest } from "../memory/campaign/structured-data-adapter.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-service-"));
const failures = [];
function check(name, condition, detail) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures.push(name);
		console.log(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

async function fetchText(url, options = {}) {
	const response = await fetch(url, options);
	const text = await response.text();
	return { status: response.status, text };
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
			measure: { out_dir: join(base, "measure") },
		})}\n`,
		"utf8",
	);

	const eventLogPath = join(workDir, "events.jsonl");
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_RAM_DIR: join(workDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
		AEGIS_TASK_ID: "task-c6-service",
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	mkdirSync(join(workDir, "runtime"), { recursive: true });

	const seen = new Map();
	const fauxFactory = (options) => {
		const faux = registerFauxProvider(options);
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

	// First run completes and commits the source stream.
	const run = await runC6FromConfig({
		configPath,
		scenario: "run",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check("the run completed", run.ok === true, JSON.stringify(run.reasons));

	// Occupied port: bind it first, then run with --port that same port. Execution
	// must still complete (the server is optional).
	const blocker = createServer((_req, res) => res.end("blocked"));
	const blockedPort = await new Promise((resolve) =>
		blocker.listen(0, "127.0.0.1", () => resolve(blocker.address().port)),
	);
	const occupied = await runC6FromConfig({
		configPath,
		scenario: "run",
		observe: true,
		port: blockedPort,
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check(
		"execution completes even when the observation port is occupied",
		occupied.ok === true,
		JSON.stringify(occupied.reasons),
	);
	check(
		"the occupied port is reported as unavailable",
		occupied.observation_url === null,
		JSON.stringify(occupied.observation_url),
	);
	await new Promise((resolve) => blocker.close(resolve));

	// A read-only observation must not touch the committed source stream. Capture
	// the bytes AFTER all executing runs and BEFORE the observe scenario.
	const bytesBefore = readFileSync(eventLogPath);
	const mtimeBefore = statSync(eventLogPath).mtimeMs;

	// Observe: a read-only server that is actually reachable.
	const obs = await runC6FromConfig({
		configPath,
		scenario: "observe",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check(
		"observe is reachable over loopback",
		typeof obs.observation_url === "string" && obs.observation_url.startsWith("http://127.0.0.1:"),
		JSON.stringify(obs.observation_url),
	);
	// Re-open a read-only server directly on an ephemeral port to exercise routes.
	const { createObservationServer } = await import("../memory/campaign/observation-server.mjs");
	const server = createObservationServer({ manifestPath, eventsPath: eventLogPath, host: "127.0.0.1", port: 0 });
	await server.listen();
	const url = server.url;
	const home = await fetchText(url);
	check("the board page is served", home.status === 200 && home.text.length > 0, `status=${home.status}`);
	const status = await fetchText(`${url}/status.json`);
	check("a status projection endpoint is served", status.status === 200, `status=${status.status}`);
	const post = await fetchText(`${url}/status.json`, { method: "POST", body: "{}" });
	check("no write route exists (POST refused)", post.status === 405, `status=${post.status}`);
	await server.close();

	// The source bytes are unchanged by a read-only observation.
	const bytesAfter = readFileSync(eventLogPath);
	check("observation does not change the source bytes", Buffer.compare(bytesBefore, bytesAfter) === 0);
	check("observation does not rewrite the source file", statSync(eventLogPath).mtimeMs === mtimeBefore);

	// Measurement export keeps every attempt and marks unobservable usage unknown.
	const measured = await runC6FromConfig({
		configPath,
		scenario: "measure",
		sdk,
		fauxProviderFactory: fauxFactory,
		print: () => {},
	});
	check(
		"the measure scenario produced an export",
		measured.ok === true && Boolean(measured.measurement),
		JSON.stringify(measured.reasons),
	);
	const measurement = JSON.parse(readFileSync(join(base, "measure", "measurement.json"), "utf8"));
	check("measurement records the config version", measurement.config?.schema_version === "campaign-config-1.1");
	check("measurement keeps the ledger attempts", Array.isArray(measurement.attempts));
	check(
		"backend tokens are null/unknown, never 0",
		measurement.backend_tokens === null,
		JSON.stringify(measurement.backend_tokens),
	);
	check(
		"backend currency is null/unknown, never 0",
		measurement.backend_currency === null,
		JSON.stringify(measurement.backend_currency),
	);
	check(
		"the ledger separates measured/estimated/unknown",
		measurement.ledger?.usage_sources?.tokens === "unknown" &&
			measurement.ledger?.usage_sources?.model_requests === "measured",
		JSON.stringify(measurement.ledger?.usage_sources),
	);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 service measure: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 service measure: all checks passed");
