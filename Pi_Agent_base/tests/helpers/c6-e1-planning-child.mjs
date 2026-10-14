#!/usr/bin/env node
// Aegis E1 planning harness — REAL SDK/faux + real EventLog through the product
// entry. The initial Manifest contains ONLY the root goal and the planning task;
// the model submits a complete candidate plan through the structured
// `aegis_submit_plan` tool; the Host admits it as a batch and the Scheduler runs
// the dynamic tasks by dependency.
//
// Usage: node c6-e1-planning-child.mjs <workDir> <scenario>
//   scenario ∈ normal_plan | illegal_plan | unknown_plan | restart
//
// Files under <workDir>:
//   events.jsonl                  real EventLog
//   effects.json                  Broker effect counter (Host-owned)
//   summary-<scenario>.json       derived result for the parent

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { artifactIndexFromEvents } from "../../memory/campaign/c3-entry.mjs";
import { runC6FromConfig } from "../../memory/campaign/c6-entry.mjs";
import { buildPlanningManifest } from "../../memory/campaign/e1-planning.mjs";
import { projectQueueFromEvents } from "../../memory/campaign/projection.mjs";
import { buildDataRepairManifest } from "../../memory/campaign/structured-data-adapter.mjs";

const sdk = { ...sdkBase, AuthStorage };
const [workDir, scenario = "normal_plan"] = process.argv.slice(2);
mkdirSync(workDir, { recursive: true });
const workspaceRoot = join(workDir, "workspace");
mkdirSync(workspaceRoot, { recursive: true });
const datasetPath = join(workspaceRoot, "dataset.json");
if (!existsSync(datasetPath)) writeFileSync(datasetPath, JSON.stringify({ name: "??", status: "pending" }), "utf8");
const effectsPath = join(workDir, "effects.json");
const readEffects = () => (existsSync(effectsPath) ? (JSON.parse(readFileSync(effectsPath, "utf8")).effects ?? 0) : 0);

// Build a VALID base manifest, then replace its business tree with the single
// Host planning task. The on-disk Manifest therefore contains NO business tasks.
const base = buildDataRepairManifest({ workspaceRoot, campaignId: "campaign-e1-plan" });
const planningConfig = {
	enabled: true,
	templates: [
		{
			template_ref: "verify",
			task_type: "verify",
			oracle_ref: "fixture.oracle.v1",
			required_capabilities: ["data.record.write"],
			scope: {
				environment_fingerprint: "data-repair-env",
				domain: "structured-data",
				permissions: ["data.record.write"],
				task_types: ["verify", "reproduce"],
			},
		},
		{
			template_ref: "reproduce",
			task_type: "reproduce",
			oracle_ref: "fixture.oracle.v1",
			required_capabilities: ["data.record.write"],
			scope: {
				environment_fingerprint: "data-repair-env",
				domain: "structured-data",
				permissions: ["data.record.write"],
				task_types: ["verify", "reproduce"],
			},
		},
	],
};
const manifestPath = join(workDir, "manifest.json");
const planningManifest = buildPlanningManifest({ base, planningConfig });
writeFileSync(manifestPath, JSON.stringify(planningManifest), "utf8");
const configPath = join(workDir, "config.json");
writeFileSync(
	configPath,
	JSON.stringify({
		schema_version: "campaign-config-1.1",
		manifest_path: manifestPath,
		workspace_root: workspaceRoot,
		work_dir: workDir,
		mode: "auto",
		provider: { kind: "faux", model: "c6-e1" },
		context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
		learning: { policy: "off", promote_experience: false },
		task_family: "structured-data-repair",
		session: { session_count: 8, max_requests_per_session: 10 },
		observation: { enabled: false, port: 0 },
		oracle: { kind: "fixture" },
		planning: planningConfig,
	}),
	"utf8",
);

let providerCalls = 0;
const seen = new Map();

/** The complete candidate plan the model "decides" to submit (scenario-dependent). */
function candidatePlan(illegal = false) {
	const tasks = [
		{
			proposed_task_id: "dyn-a",
			parent_task_id: "task-plan",
			depends_on: [],
			goal: { description: "Repair the name field.", success_criteria: ["data.name == Ada"] },
			task_type: "verify",
			target_ref: "dataset.json",
			required_capabilities: ["data.record.write"],
			expected_evidence: ["artifact:dyn-a"],
			stop_condition: "name repaired",
			priority: 1,
			budget_reservation: { wall_time_ms: 30000, model_requests: 4, tool_calls: 8 },
		},
		{
			proposed_task_id: "dyn-b",
			parent_task_id: "task-plan",
			depends_on: [],
			goal: { description: "Normalize the status field.", success_criteria: ["data.status == active"] },
			task_type: "reproduce",
			target_ref: "dataset.json",
			required_capabilities: ["data.record.write"],
			expected_evidence: ["artifact:dyn-b"],
			stop_condition: "status normalized",
			priority: 2,
			budget_reservation: { wall_time_ms: 30000, model_requests: 4, tool_calls: 8 },
		},
		// The diamond: c waits for BOTH a and b.
		{
			proposed_task_id: "dyn-c",
			parent_task_id: "task-plan",
			depends_on: ["dyn-a", "dyn-b"],
			goal: {
				description: "Re-verify the repaired dataset.",
				success_criteria: ["data.name == Ada", "data.status == active"],
			},
			task_type: "verify",
			target_ref: "dataset.json",
			required_capabilities: ["data.record.write"],
			expected_evidence: ["artifact:dyn-c"],
			stop_condition: "dataset re-verified",
			priority: 3,
			budget_reservation: { wall_time_ms: 30000, model_requests: 4, tool_calls: 8 },
		},
	];
	if (illegal) {
		// One node references an UNAUTHORIZED target: the WHOLE batch must reject.
		tasks.push({
			proposed_task_id: "dyn-bad",
			parent_task_id: "task-plan",
			depends_on: [],
			goal: { description: "Read a forbidden file.", success_criteria: ["dataset.name repaired"] },
			task_type: "verify",
			target_ref: "forbidden.txt",
			required_capabilities: ["data.record.write"],
			expected_evidence: ["artifact:dyn-bad"],
			stop_condition: "read",
			priority: 4,
			budget_reservation: { wall_time_ms: 30000, model_requests: 4, tool_calls: 8 },
		});
	}
	// Intentionally out-of-order input: the Host must build the graph by id.
	return {
		version: "aegis-plan-1.0",
		plan_id: "plan-e1",
		root_goal_ref: "campaign-root",
		tasks: [tasks[2], tasks[0], tasks[1], ...tasks.slice(3)],
	};
}

const factory = (options) => {
	const faux = registerFauxProvider(options);
	const response = (context) => {
		providerCalls += 1;
		const text = JSON.stringify(context.messages);
		const taskId = [...text.matchAll(/TASK ([\w-]+)/g)].at(-1)?.[1] ?? "task-plan";
		const count = (seen.get(taskId) ?? 0) + 1;
		seen.set(taskId, count);
		if (taskId === "task-plan") {
			if (count === 1) {
				// External review: capture the actual provider input before the fixture
				// reveals its hard-coded plan. This is synthetic/offline data only.
				writeFileSync(join(workDir, "planning-input.json"), JSON.stringify(context), "utf8");
			}
			if (count === 1) {
				return fauxAssistantMessage([fauxToolCall("aegis_submit_plan", candidatePlan(scenario === "illegal_plan"))]);
			}
			const terminal = fauxAssistantMessage("plan recorded");
			if (scenario === "unknown_plan") delete terminal.stopReason;
			if (scenario === "error_plan") terminal.stopReason = "error";
			if (scenario === "aborted_plan") terminal.stopReason = "aborted";
			return terminal;
		}
		// Business tasks: perform the data repair action for dyn-a/dyn-b, and a
		// read-only re-verify for dyn-c. A plain terminal message ends the planning
		// normally after the decision is recorded.
		if (count > 1) return fauxAssistantMessage("decision recorded");
		const field = taskId === "dyn-a" ? "name" : taskId === "dyn-b" ? "status" : null;
		if (field) {
			return fauxAssistantMessage([
				fauxToolCall("aegis_task_decision", {
					actions: [
						{
							action_ref: "data.record.set",
							arguments: { target: "dataset.json", field, value: field === "name" ? "Ada" : "active" },
						},
					],
				}),
			]);
		}
		// dyn-c: a re-verification. Submit an idempotent decision so the planning
		// ends normally and the independent Oracle can re-read the repaired file.
		return fauxAssistantMessage([
			fauxToolCall("aegis_task_decision", {
				actions: [
					{ action_ref: "data.record.set", arguments: { target: "dataset.json", field: "status", value: "active" } },
				],
			}),
		]);
	};
	faux.setResponses(Array.from({ length: 48 }, () => response));
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

writeFileSync(effectsPath, JSON.stringify({ effects: readEffects() + brokerEffects }));
const eventsPath = join(workDir, "events.jsonl");
const events = existsSync(eventsPath)
	? readFileSync(eventsPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
	: [];
const planEvents = events.filter((e) => String(e.payload?.kind ?? "").startsWith("campaign.plan."));
// Re-derive the FINAL task states from the committed stream + the Host artifact
// index, so the summary reflects the durable truth (the Host's mid-loop snapshot
// can lag the last completion).
const finalProjection = projectQueueFromEvents({
	campaign_id: planningManifest.campaign_id,
	tasks: planningManifest.tasks ?? [],
	events,
	revision: planningManifest.revision ?? 0,
	manifest: planningManifest,
	artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
});
const finalTaskStates = Object.fromEntries(finalProjection.tasks.map((t) => [t.task_id, t.state]));
const admitted = planEvents.find((e) => e.payload.kind === "campaign.plan.admitted");
writeFileSync(
	join(workDir, `summary-${scenario}.json`),
	JSON.stringify(
		{
			scenario,
			provider_calls: providerCalls,
			broker_effects: brokerEffects,
			ok: outcome.ok,
			task_states: finalTaskStates,
			dataset: JSON.parse(readFileSync(datasetPath, "utf8")),
			ledger: outcome.ledger ?? null,
			dynamic_admissions: outcome.dynamic_admissions ?? [],
			reconciliation: outcome.reconciliation ?? null,
			plan_kinds: planEvents.map((e) => e.payload.kind),
			admitted_task_ids: (admitted?.payload?.plan_tasks ?? []).map((t) => t.task_id),
			admitted_depends: Object.fromEntries((admitted?.payload?.plan_tasks ?? []).map((t) => [t.task_id, t.depends_on])),
			plan_ready: events.some((e) => e.payload?.kind === "campaign.plan.ready"),
		},
		null,
		2,
	),
	"utf8",
);
process.exit(0);
void resolve;
