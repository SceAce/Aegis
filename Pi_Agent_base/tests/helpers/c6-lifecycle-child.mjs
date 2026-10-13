#!/usr/bin/env node
// Aegis C6 request-lifecycle restart harness — REAL SDK/faux + real EventLog +
// real process. It drives the product entry so the provider gate persists a
// durable `reserved` request record, then either SIGKILLs the process before the
// request settles or fails the provider (persisting a reconciliation record).
// A later "recover" run through the SAME entry must keep the budget
// responsibility and refuse a blind re-dispatch.
//
// Usage: node c6-lifecycle-child.mjs <workDir> <scenario>
//   scenario ∈ kill_after_reserved | provider_error | recover
//
// Files under <workDir>:
//   events.jsonl          real EventLog
//   summary-<scenario>.json  derived result for the parent

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { runC6FromConfig } from "../../memory/campaign/c6-entry.mjs";
import { validateManifest } from "../../memory/campaign/manifest.mjs";
import { buildDataRepairManifest } from "../../memory/campaign/structured-data-adapter.mjs";

const sdk = { ...sdkBase, AuthStorage };
const [workDir, scenario = "recover"] = process.argv.slice(2);
mkdirSync(workDir, { recursive: true });
const workspaceRoot = join(workDir, "workspace");
mkdirSync(workspaceRoot, { recursive: true });
const datasetPath = join(workspaceRoot, "dataset.json");
if (!existsSync(datasetPath)) writeFileSync(datasetPath, JSON.stringify({ name: "??", status: "pending" }), "utf8");

const baseManifest = buildDataRepairManifest({ workspaceRoot, campaignId: "campaign-c6-lifecycle" });
const validated = validateManifest({ ...baseManifest, tasks: [baseManifest.tasks[0]] });
if (!validated.ok) {
	process.stderr.write(`manifest invalid: ${validated.reasons.join("; ")}\n`);
	process.exit(3);
}
const manifestPath = join(workDir, "manifest.json");
writeFileSync(manifestPath, JSON.stringify(validated.manifest), "utf8");
const configPath = join(workDir, "config.json");
writeFileSync(
	configPath,
	JSON.stringify({
		schema_version: "campaign-config-1.1",
		manifest_path: manifestPath,
		workspace_root: workspaceRoot,
		work_dir: workDir,
		mode: "auto",
		provider: { kind: "faux", model: "c6-lifecycle" },
		context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
		learning: { policy: "off", promote_experience: false },
		task_family: "structured-data-repair",
		session: { session_count: 4, max_requests_per_session: 10 },
		observation: { enabled: false, port: 0 },
		oracle: { kind: "fixture" },
	}),
	"utf8",
);

let providerCalls = 0;
const factory = (options) => {
	const faux = registerFauxProvider(options);
	const response = () => {
		providerCalls += 1;
		if (scenario === "kill_after_reserved") {
			// The gate has already persisted the durable reservation and called the
			// provider boundary; kill BEFORE any completion/commit.
			process.kill(process.pid, "SIGKILL");
		}
		if (scenario === "provider_error") {
			throw new Error("injected provider transport failure");
		}
		return fauxAssistantMessage([
			fauxToolCall("aegis_task_decision", {
				actions: [
					{ action_ref: "data.record.set", arguments: { target: "dataset.json", field: "name", value: "Ada" } },
				],
			}),
		]);
	};
	faux.setResponses(Array.from({ length: 12 }, () => response));
	return faux;
};

let brokerEffects = 0;
const outcome = await runC6FromConfig({
	configPath,
	scenario: "run",
	sdk,
	fauxProviderFactory: factory,
	workerSeam: (inner) => ({
		async run(args) {
			const result = await inner.run(args);
			brokerEffects += Array.isArray(result.effects)
				? result.effects.filter((effect) => effect.effect_probe === true).length
				: 0;
			return result;
		},
	}),
	print: () => {},
});

const eventsPath = join(workDir, "events.jsonl");
const events = existsSync(eventsPath)
	? readFileSync(eventsPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
	: [];
writeFileSync(
	join(workDir, `summary-${scenario}.json`),
	JSON.stringify(
		{
			scenario,
			providerCalls,
			brokerEffects,
			ok: outcome.ok,
			task_states: outcome.task_states ?? null,
			ledger: outcome.ledger ?? null,
			reconciliation: outcome.reconciliation ?? null,
			requests: events
				.filter((event) => event.payload?.kind === "c6.request")
				.map((event) => ({
					phase: event.payload.phase,
					request_id: event.payload.request_id,
					task_id: event.payload.task_id,
					provider_status: event.payload.provider_status ?? null,
					commit_status: event.payload.commit_status ?? null,
					failure_reason: event.payload.failure_reason ?? null,
				})),
			task_unknown: events.filter((event) => event.payload?.kind === "campaign.task.unknown").length,
			reconciliation_events: events.filter((event) =>
				String(event.payload?.kind ?? "").startsWith("campaign.reconciliation"),
			).length,
		},
		null,
		2,
	),
	"utf8",
);
process.exit(0);
