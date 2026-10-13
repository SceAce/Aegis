// C6 external review harness: isolated real SDK/faux + local files only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { runC6FromConfig } from "../../memory/campaign/c6-entry.mjs";
import {
	buildCampaignLearningBridge,
	compileExperienceFromProofs,
	createCampaignLearningStore,
} from "../../memory/campaign/c6-learning.mjs";
import { runBoundedAttempts } from "../../memory/campaign/c6-runner.mjs";
import { buildCodeRepairManifest } from "../../memory/campaign/code-repair-adapter.mjs";
import {
	buildDataRepairManifest,
	createStructuredDataAdapter,
} from "../../memory/campaign/structured-data-adapter.mjs";
import { ActionRegistry, createActionBroker } from "../../memory/runtime/action-contract.mjs";
import { createAuthorization } from "../../memory/runtime/authorization.mjs";

const [scenario, base] = process.argv.slice(2);
const workspace = join(base, "workspace");
const workDir = join(base, "run");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "dataset.json"), JSON.stringify({ name: "before", status: "before" }));
const manifest =
	scenario === "code-false-success"
		? buildCodeRepairManifest({ workspaceRoot: workspace })
		: buildDataRepairManifest({ workspaceRoot: workspace });
if (scenario === "code-false-success") {
	writeFileSync(join(workspace, "solution.mjs"), "export const answer = 0;\n");
	writeFileSync(
		join(workspace, "check.mjs"),
		'import assert from "node:assert/strict"; import { answer } from "./solution.mjs"; assert.equal(answer, 42); console.log("PASSED=1 FAILED=0");\n',
	);
}
if (scenario === "task-budget" || scenario === "read-budget") manifest.tasks[0].task_budget.model_requests = 1;
if (scenario === "restart-budget") {
	manifest.budget.model_requests = 4;
	for (const task of manifest.tasks) task.task_budget.model_requests = 2;
}
if (scenario === "tool-budget") manifest.tasks[0].task_budget.tool_calls = 1;
const config = {
	schema_version: "campaign-config-1.1",
	manifest_path: join(base, "manifest.json"),
	workspace_root: workspace,
	work_dir: workDir,
	mode: "auto",
	provider: { kind: "faux", model: "c6-external" },
	task_family: scenario === "code-false-success" ? "code-repair" : "structured-data-repair",
	context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
	learning: { policy: "off", promote_experience: false },
	session: { session_count: 4, max_requests_per_session: 10 },
	observation: { enabled: false, port: 0 },
	oracle: { kind: "fixture" },
};
if (scenario === "context-limit") config.context.max_total_input_chars = 1000;
writeFileSync(config.manifest_path, JSON.stringify(manifest));
const configPath = join(base, "config.json");
writeFileSync(configPath, JSON.stringify(config));
const eventPath = join(workDir, "events.jsonl");
Object.assign(process.env, {
	AEGIS_EVENT_LOG: scenario === "log-binding" ? join(base, "decoy", "events.jsonl") : eventPath,
	AEGIS_RAM_DIR: join(workDir, "ram"),
	AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
	AEGIS_TASK_ID: "external-unrelated-label",
	AEGIS_ROM_FILE: resolve("Pi_Agent_base/agent/ROM.md"),
});
let requests = 0;
const providerInputs = [];
const seen = new Map();
const factory = (options) => {
	const faux = registerFauxProvider(options);
	const response = (context) => {
		requests++;
		// The SDK normalizes the transcript so the prompt and tool declarations live
		// on the LEADING SYSTEM MESSAGE (`toolsAdded`), never on the context itself.
		// (The original harness read `context.tools`, which the real Pi SDK contract
		// does not populate, so it could never observe the model's tool set.)
		const leadingSystem = Array.isArray(context.messages)
			? context.messages.find((m) => m && m.role === "system")
			: null;
		providerInputs.push({
			tools: (leadingSystem?.toolsAdded ?? []).map((tool) => tool.name),
			messages: JSON.stringify(context.messages),
		});
		const text = JSON.stringify(context.messages);
		const task = [...text.matchAll(/TASK (task-\d+)/g)].at(-1)?.[1] ?? "task-001";
		const n = (seen.get(task) ?? 0) + 1;
		seen.set(task, n);
		if (scenario === "read-budget" && task === "task-001") {
			if (n <= 3) return fauxAssistantMessage([fauxToolCall("aegis_read", { path: "dataset.json" })]);
			if (n >= 5) return fauxAssistantMessage("done");
		} else if (n % 2 === 0) return fauxAssistantMessage("done");
		const action =
			scenario === "code-false-success"
				? {
						action_ref: "code.file.write",
						arguments: { target: "solution.mjs", content: "process.exit(0); export const answer = 0;\n" },
					}
				: {
						action_ref: "data.record.set",
						arguments: {
							target: "dataset.json",
							field: task === "task-001" ? "name" : "status",
							value: task === "task-001" ? "Ada" : "active",
						},
					};
		return fauxAssistantMessage([
			fauxToolCall("aegis_task_decision", {
				actions: scenario === "tool-budget" ? [action, action, action] : [action],
			}),
		]);
	};
	faux.setResponses(Array.from({ length: 24 }, () => response));
	return faux;
};
const args = { configPath, sdk: { ...sdkBase, AuthStorage }, fauxProviderFactory: factory, print: () => {} };
const outcome = await runC6FromConfig(args);
const parseEvents = (p) =>
	existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const events = parseEvents(eventPath);
const extra = {};
if (scenario === "measure") {
	const result = await runC6FromConfig({ ...args, scenario: "measure" });
	extra.measure = result.measurement?.measurement;
}
if (scenario === "readonly-integrity") {
	const rows = events.map((e) => JSON.stringify(e));
	rows[2] = rows[2].replace('"payload":{', '"payload":{"external_tamper":true,');
	writeFileSync(eventPath, `${rows.join("\n")}\n`);
	try {
		extra.readonly = await runC6FromConfig({ ...args, scenario: "status" });
	} catch (error) {
		extra.readonlyThrown = String(error);
	}
}
if (scenario === "restart-budget") {
	extra.requestsBefore = requests;
	extra.second = await runC6FromConfig(args);
	extra.repeatConsumed = extra.second.ledger?.consumed;
	extra.requestsAfter = requests;
}
if (scenario === "learning") {
	const registry = new ActionRegistry([createStructuredDataAdapter({ workspaceRoot: workspace })]);
	const bridge = buildCampaignLearningBridge({
		events,
		registry,
		broker: createActionBroker({ registry }),
		authorization: createAuthorization({
			mode: "auto",
			workspaceRoot: workspace,
			allowedTools: ["aegis_workspace"],
			approved: true,
		}),
		environment: {
			environment_fingerprint: "data-repair-env",
			domain: "structured-data",
			permissions: ["data.record.write"],
			task_types: ["verify", "reproduce"],
		},
	});
	const ids = events
		.filter((e) => e.payload?.kind === "campaign.oracle.result" && e.payload.status === "success" && !e.payload.step_id)
		.map((e) => e.payload.outcome_id);
	extra.compiled = await compileExperienceFromProofs({
		policy: "explicit",
		proofIds: ids,
		bridge,
		store: createCampaignLearningStore(workDir),
	});
}
if (scenario === "runner") {
	extra.runner = await runBoundedAttempts({
		...args,
		runEntry: runC6FromConfig,
		baseDir: join(base, "attempts"),
		attempts: [
			{ id: "a", work_dir: join(base, "attempt-a"), seed: 11, initial_state: { name: "reset-a" } },
			{ id: "b", work_dir: join(base, "attempt-b"), seed: 12, initial_state: { name: "reset-b" } },
		],
	});
	extra.attemptLogs = ["a", "b"].map((id) => existsSync(join(base, `attempt-${id}`, "events.jsonl")));
}
writeFileSync(
	join(base, "audit-result.json"),
	JSON.stringify({
		outcome,
		requests,
		providerInputs,
		events,
		decoyEvents: parseEvents(join(base, "decoy", "events.jsonl")),
		effect: JSON.parse(readFileSync(join(workspace, "dataset.json"), "utf8")),
		...extra,
	}),
);
