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
import { runC6FromConfig } from "../../campaign/c6-entry.mjs";
import { validateManifest } from "../../campaign/manifest.mjs";
import { buildDataRepairManifest } from "../../execution/adapters/structured-data-adapter.mjs";
import { EventLog } from "../../shared/events.mjs";

const [workDir, scenario = "recover"] = process.argv.slice(2);
let sdkPersistenceFailures = 0;
const sdkErrors = [];
const sdk = {
	...sdkBase,
	AuthStorage,
	async createAgentSessionFromServices(options) {
		const created = await sdkBase.createAgentSessionFromServices(options);
		if (scenario === "sdk_result_persist_error") {
			const manager = created.session.sessionManager;
			const append = manager.appendMessage.bind(manager);
			manager.appendMessage = (message) => {
				if (sdkPersistenceFailures === 0 && message.role === "toolResult") {
					sdkPersistenceFailures += 1;
					throw new Error("injected SDK tool-result persistence failure");
				}
				return append(message);
			};
			created.session.subscribe((event) => {
				if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error")
					sdkErrors.push(event.message.errorMessage);
			});
		}
		return created;
	},
};
mkdirSync(workDir, { recursive: true });
const workspaceRoot = join(workDir, "workspace");
mkdirSync(workspaceRoot, { recursive: true });
const datasetPath = join(workspaceRoot, "dataset.json");
if (!existsSync(datasetPath)) writeFileSync(datasetPath, JSON.stringify({ name: "??", status: "pending" }), "utf8");

const baseManifest = buildDataRepairManifest({ workspaceRoot, campaignId: "campaign-c6-lifecycle" });
const independentTasks = ["durable_commit_failure_kill", "recover_independent"].includes(scenario);
const validated = validateManifest({
	...baseManifest,
	tasks: independentTasks ? baseManifest.tasks.map((task) => ({ ...task, depends_on: [] })) : [baseManifest.tasks[0]],
});
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
const seen = new Map();
const factory = (options) => {
	const faux = registerFauxProvider(options);
	const response = (context) => {
		providerCalls += 1;
		if (scenario === "kill_after_reserved") {
			// The gate has already persisted the durable reservation and called the
			// provider boundary; kill BEFORE any completion/commit.
			process.kill(process.pid, "SIGKILL");
		}
		if (scenario === "provider_error") {
			throw new Error("injected provider transport failure");
		}
		const taskId = [...JSON.stringify(context.messages).matchAll(/TASK (task-\d+)/g)].at(-1)?.[1] ?? "task-001";
		const count = (seen.get(taskId) ?? 0) + 1;
		seen.set(taskId, count);
		if (["normal", "aborted_followup", "error_followup", "recover_independent"].includes(scenario) && count > 1) {
			if (scenario === "error_followup") throw new Error("injected follow-up transport failure");
			return fauxAssistantMessage("decision recorded", {
				stopReason: scenario === "aborted_followup" ? "aborted" : "stop",
			});
		}
		return fauxAssistantMessage([
			fauxToolCall("aegis_task_decision", {
				actions: [
					{
						action_ref: "data.record.set",
						arguments: {
							target: "dataset.json",
							field: taskId === "task-002" ? "status" : "name",
							value: taskId === "task-002" ? "active" : "Ada",
						},
					},
				],
			}),
		]);
	};
	faux.setResponses(Array.from({ length: 12 }, () => response));
	return faux;
};

// Inject only the durable writer failure, keeping the real SDK, worker,
// reservation, reconciliation payload and hash-chained EventLog unchanged.
// Kill immediately after the fallback reconciliation is truly written: the
// second, independent Task remains queued for the recovery entry to examine.
if (scenario === "durable_commit_failure_kill") {
	const append = EventLog.prototype.append;
	EventLog.prototype.append = async function (event) {
		if (event.payload?.kind === "c6.request" && event.payload.phase === "committed") {
			return { ok: false, error: "injected transient committed append failure" };
		}
		const written = await append.call(this, event);
		if (written.ok && event.payload?.kind === "c6.request" && event.payload.phase === "reconciliation_required") {
			process.kill(process.pid, "SIGKILL");
		}
		return written;
	};
}

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
			dataset: JSON.parse(readFileSync(datasetPath, "utf8")),
			reconciliation: outcome.reconciliation ?? null,
			requests: events
				.filter((event) => event.payload?.kind === "c6.request")
				.map((event) => ({
					phase: event.payload.phase,
					request_id: event.payload.request_id,
					task_id: event.payload.task_id,
					provider_status: event.payload.provider_status ?? null,
					stop_reason: event.payload.stop_reason ?? null,
					commit_status: event.payload.commit_status ?? null,
					failure_reason: event.payload.failure_reason ?? null,
				})),
			failure_modes: events
				.filter((event) => event.payload?.kind === "campaign.reconciliation.requested")
				.map((event) => event.payload.failure_mode ?? null),
			sdk_persistence_failures: sdkPersistenceFailures,
			sdk_errors: sdkErrors,
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
