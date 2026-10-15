#!/usr/bin/env node
// Aegis E1 planning harness — REAL SDK/faux + real EventLog through the product
// entry. The initial Manifest contains ONLY the root goal and the planning task;
// the model submits a complete candidate plan through the structured
// `aegis_submit_plan` tool; the Host admits it as a batch and the Scheduler runs
// the dynamic tasks by dependency.
//
// Usage: node c6-e1-planning-child.mjs <workDir> <scenario>
//   scenario ∈ normal_plan | illegal_plan | unknown_plan | error_plan |
//              aborted_plan | sdk_result_persist_error_plan |
//              plan_ready_persist_error | task_budget_plan | double_plan |
//              foreign_root_plan | restart
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
import { hostEventLog } from "../../memory/runtime/events.mjs";

const [workDir, scenario = "normal_plan"] = process.argv.slice(2);
let sdkPersistenceFailures = 0;
let readyPersistenceFailures = 0;
const sdk = {
	...sdkBase,
	AuthStorage,
	async createAgentSessionFromServices(options) {
		const created = await sdkBase.createAgentSessionFromServices(options);
		if (scenario === "sdk_result_persist_error_plan") {
			const manager = created.session.sessionManager;
			const append = manager.appendMessage.bind(manager);
			manager.appendMessage = (message) => {
				if (sdkPersistenceFailures === 0 && message.role === "toolResult") {
					sdkPersistenceFailures += 1;
					throw new Error("injected planning tool-result persistence failure");
				}
				return append(message);
			};
		}
		return created;
	},
};
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
			success_criteria: ["data.name == Ada", "data.status == active"],
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
			success_criteria: ["data.status == active"],
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

/** Collect every string from a provider context (message content parts, etc.). */
function collectStrings(value, out = []) {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
	else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out);
	return out;
}

/** Recover the authoritative planning contract embedded in the actual prompt. */
function extractPlanningContract(context) {
	const text = collectStrings(context).join("\n");
	const marker = "PLANNING CONTRACT (authoritative JSON): ";
	const at = text.lastIndexOf(marker);
	if (at < 0) throw new Error("planning contract marker not found in provider input");
	const jsonStart = text.indexOf("{", at + marker.length);
	let depth = 0;
	for (let index = jsonStart; index < text.length; index += 1) {
		if (text[index] === "{") depth += 1;
		else if (text[index] === "}") {
			depth -= 1;
			if (depth === 0) return JSON.parse(text.slice(jsonStart, index + 1));
		}
	}
	throw new Error("planning contract JSON is not balanced");
}

/**
 * Build the candidate plan FROM the contract the provider actually received.
 * Nothing about the root criteria or the template binding is hardcoded here.
 */
function derivePlanFromContext(context) {
	const contract = extractPlanningContract(context);
	const required = contract.root_goal?.required_criteria ?? [];
	const templates = contract.templates ?? [];
	const tasks = [];
	required.forEach((criterion, index) => {
		const template = templates.find((entry) => (entry.success_criteria ?? []).includes(criterion));
		if (!template) throw new Error(`no trusted template offers criterion ${criterion}`);
		const id = `dyn-${String.fromCharCode(97 + index)}`;
		tasks.push({
			proposed_task_id: id,
			parent_task_id: contract.planning_task_id ?? "task-plan",
			depends_on: [],
			goal: { description: `Satisfy ${criterion}`, success_criteria: [criterion] },
			task_type: template.task_type,
			template_ref: template.template_ref,
			target_ref: (contract.allowed_targets ?? [])[0],
			required_capabilities: [...(template.required_capabilities ?? [])],
			expected_evidence: [`artifact:${id}`],
			stop_condition: "oracle judged",
			priority: index + 1,
			budget_reservation: { wall_time_ms: 30000, model_requests: 4, tool_calls: 8 },
		});
	});
	const covering = templates.find((entry) => required.every((c) => (entry.success_criteria ?? []).includes(c)));
	if (!covering) throw new Error("no trusted template covers every required criterion");
	const finalId = `dyn-${String.fromCharCode(97 + required.length)}`;
	tasks.push({
		proposed_task_id: finalId,
		parent_task_id: contract.planning_task_id ?? "task-plan",
		depends_on: tasks.map((task) => task.proposed_task_id),
		goal: { description: "Re-verify the repaired dataset.", success_criteria: [...required] },
		task_type: covering.task_type,
		template_ref: covering.template_ref,
		target_ref: (contract.allowed_targets ?? [])[0],
		required_capabilities: [...(covering.required_capabilities ?? [])],
		expected_evidence: [`artifact:${finalId}`],
		stop_condition: "dataset re-verified",
		priority: required.length + 1,
		budget_reservation: { wall_time_ms: 30000, model_requests: 4, tool_calls: 8 },
	});
	return {
		version: "aegis-plan-1.0",
		plan_id: "plan-derived",
		root_goal_ref: contract.root_goal_ref ?? "campaign-root",
		tasks,
	};
}

/** The complete candidate plan the model "decides" to submit (scenario-dependent). */
function candidatePlan(scenario = "normal_plan", context = null) {
	if (scenario === "derived_plan") return derivePlanFromContext(context);
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
	if (scenario === "illegal_plan") {
		// One node references an UNAUTHORIZED target: the WHOLE batch must reject.
		tasks.push({
			proposed_task_id: "dyn-bad",
			parent_task_id: "task-plan",
			depends_on: [],
			goal: { description: "Read a forbidden file.", success_criteria: ["data.name == Ada"] },
			task_type: "verify",
			target_ref: "forbidden.txt",
			required_capabilities: ["data.record.write"],
			expected_evidence: ["artifact:dyn-bad"],
			stop_condition: "read",
			priority: 4,
			budget_reservation: { wall_time_ms: 30000, model_requests: 4, tool_calls: 8 },
		});
	}
	if (scenario === "attacker_criterion_plan") {
		// Keep root-criteria coverage, but attach a criterion the trusted template
		// never offered. The Host must block the WHOLE batch.
		tasks[0].goal.success_criteria.push("data.status == attacker_chosen");
	}
	if (scenario === "task_budget_plan") {
		for (const task of tasks) task.budget_reservation.model_requests = 1;
	}
	if (scenario === "double_plan") {
		// Each batch fits the remaining 92 requests; two batches reserve 120.
		for (const task of tasks) task.budget_reservation.model_requests = 20;
	}
	// Intentionally out-of-order input: the Host must build the graph by id.
	return {
		version: "aegis-plan-1.0",
		plan_id: "plan-e1",
		root_goal_ref: scenario === "foreign_root_plan" ? "foreign-root" : "campaign-root",
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
				// reveals its plan. This is synthetic/offline data only.
				writeFileSync(join(workDir, "planning-input.json"), JSON.stringify(context), "utf8");
				const plan = candidatePlan(scenario, context);
				writeFileSync(join(workDir, "submitted-plan.json"), JSON.stringify(plan), "utf8");
				if (scenario === "double_plan") {
					const second = structuredClone(plan);
					second.plan_id = "plan-second";
					for (const task of second.tasks) {
						task.proposed_task_id = `alt-${task.proposed_task_id}`;
						task.depends_on = task.depends_on.map((id) => `alt-${id}`);
						task.expected_evidence = [`artifact:${task.proposed_task_id}`];
					}
					return fauxAssistantMessage([
						fauxToolCall("aegis_submit_plan", plan),
						fauxToolCall("aegis_submit_plan", second),
					]);
				}
				return fauxAssistantMessage([fauxToolCall("aegis_submit_plan", plan)]);
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
		const businessId = taskId.replace(/^alt-/, "");
		const field = businessId === "dyn-a" ? "name" : businessId === "dyn-b" ? "status" : null;
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
const eventsPath = join(workDir, "events.jsonl");
const outcome = await runC6FromConfig({
	configPath,
	scenario: "run",
	sdk,
	fauxProviderFactory: factory,
	workerSeam: (inner) => ({
		async run(args) {
			if (scenario === "plan_ready_persist_error" && args.task.task_id === "task-plan") {
				// Fault the Host's actual writer; every other event still uses the real
				// EventLog. No Oracle success or completion is supplied by this seam.
				const log = hostEventLog(eventsPath);
				if (!log) throw new Error("missing bound Host EventLog");
				const append = log.append.bind(log);
				log.append = async (event) => {
					if (event.payload?.kind === "campaign.plan.ready" && readyPersistenceFailures === 0) {
						readyPersistenceFailures += 1;
						return { ok: false, durable: false, error: "injected planning completion gate write failure" };
					}
					return append(event);
				};
			}
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
			injected_failures: { sdk_tool_result: sdkPersistenceFailures, plan_ready_append: readyPersistenceFailures },
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
