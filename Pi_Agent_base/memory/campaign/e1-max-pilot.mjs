#!/usr/bin/env node
// User-operated E1 bootstrap. prepare/status never call a provider.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../fixture/contracts.mjs";
import { verifyChain } from "../runtime/events.mjs";
import { artifactIndexFromEvents } from "./c3-entry.mjs";
import { runC6FromConfig } from "./c6-entry.mjs";
import { summarizeRequestLedger } from "./c6-request-lifecycle.mjs";
import { loadCampaignConfig } from "./campaign-config.mjs";
import { buildCodeRepairManifest } from "./code-repair-adapter.mjs";
import { validateManifest } from "./manifest.mjs";
import { projectQueueFromEvents } from "./projection.mjs";
import { runRegisteredTest } from "./registered-test.mjs";
import { buildDataRepairManifest } from "./structured-data-adapter.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_ROOT = join(REPO, "Pi_Agent_base", "runtime", "pilot", "e1-max-first");
const PROVIDER = {
	kind: "remote-openai",
	model: "deepseek-v4.1-flash",
	base_url: "https://ai.max66.xyz/v1",
	credential_ref: "env:AEGIS_MAX_API_KEY",
};
const SOURCE = "export function normalizeName(value) {\n  return value.trim();\n}\n";
const TEST = [
	'import assert from "node:assert/strict";',
	'import { normalizeName } from "./solution.mjs";',
	'assert.equal(normalizeName(" Ada   Lovelace "), "Ada Lovelace");',
	'assert.equal(normalizeName("Ada\\tLovelace"), "Ada Lovelace");',
	'assert.equal(normalizeName("  "), "");',
	"assert.equal(normalizeName(null), null);",
	"assert.equal(normalizeName(42), null);",
	"assert.equal(normalizeName({}), null);",
	'assert.equal(normalizeName("Ada"), "Ada");',
	"",
].join("\n");

/** Generate two bounded input packages without credentials or provider calls. */
export function prepareMaxPilot(root = DEFAULT_ROOT) {
	root = resolve(root);
	if (existsSync(root))
		throw new Error("pilot directory already exists; inspect the existing attempt instead of overwriting it");
	mkdirSync(root, { recursive: true });
	const configs = {};
	for (const family of ["smoke", "code"]) {
		const base = join(root, family);
		const workspace = join(base, "workspace");
		mkdirSync(workspace, { recursive: true });
		const code = family === "code";
		const requests = code ? 8 : 4;
		const manifest = code
			? buildCodeRepairManifest({ workspaceRoot: workspace, campaignId: "campaign-e1-max-code" })
			: buildDataRepairManifest({ workspaceRoot: workspace, campaignId: "campaign-e1-max-smoke" });
		manifest.created_at = new Date().toISOString();
		manifest.title = code
			? "E1 representative code task (not a user-project bug)"
			: "E1 real-provider connectivity task";
		manifest.worker = { provider: PROVIDER.kind, model: PROVIDER.model };
		manifest.tasks = [manifest.tasks[0]];
		manifest.budget = {
			wall_time_ms: 180000,
			model_requests: requests,
			tool_calls: requests * 2,
			task_count: 1,
			session_count: 2,
		};
		manifest.tasks[0].task_budget = { wall_time_ms: 180000, model_requests: requests, tool_calls: requests * 2 };
		manifest.dynamic_task_policy.enabled = false;
		manifest.tasks[0].goal.description = code
			? "Repair normalizeName in solution.mjs while keeping its export. For strings, trim leading/trailing whitespace and collapse each internal whitespace run to a single space; empty/whitespace-only strings return an empty string. Non-string inputs return null without throwing. Read the file first. Do not add dependencies, network calls, or import-time side effects. Submit one code.file.write decision with target and full content, then end planning; the Host runs its independent tests."
			: "Read dataset.json. Set the top-level name field to Ada, preserving other fields. Submit one data.record.set decision with target, field and value, then end planning; the Host verifies the file.";
		if (code) {
			writeFileSync(join(workspace, "solution.mjs"), SOURCE);
			writeFileSync(join(workspace, "check.mjs"), TEST);
			const initial = runRegisteredTest({ workspaceRoot: workspace, env: {} });
			if (!initial.complete || initial.ok)
				throw new Error("the frozen code task must have a complete failing initial test");
		} else writeFileSync(join(workspace, "dataset.json"), '{"name":"??","status":"pending"}\n');
		const validated = validateManifest(manifest);
		if (!validated.ok) throw new Error(validated.reasons.join("; "));
		const manifestPath = join(base, "manifest.json");
		writeFileSync(manifestPath, `${JSON.stringify(validated.manifest, null, 2)}\n`);
		const configPath = join(base, "campaign.config.json");
		writeFileSync(
			configPath,
			`${JSON.stringify(
				{
					schema_version: "campaign-config-1.1",
					manifest_path: manifestPath,
					workspace_root: workspace,
					work_dir: join(base, "run"),
					mode: "auto",
					provider: PROVIDER,
					context: { strategy: "bounded_ram", max_total_input_chars: 50000, output_reserve_chars: 4000 },
					learning: { policy: "off", promote_experience: false },
					task_family: code ? "code-repair" : "structured-data-repair",
					...(code ? { registered_test: "check.mjs" } : {}),
					session: { session_count: 2, max_requests_per_session: 10 },
					observation: { enabled: false, port: 0 },
					oracle: { kind: "fixture" },
					measure: { out_dir: join(base, "measure") },
				},
				null,
				2,
			)}\n`,
		);
		const loaded = loadCampaignConfig({ configPath });
		if (!loaded.ok) throw new Error(loaded.reasons.join("; "));
		writeFileSync(
			join(base, "input-digests.json"),
			`${JSON.stringify(
				{
					manifest: digest(readFileSync(manifestPath, "utf8")),
					config: digest(readFileSync(configPath, "utf8")),
					target: digest(readFileSync(join(workspace, code ? "solution.mjs" : "dataset.json"), "utf8")),
					registered_test: code ? digest(TEST) : null,
				},
				null,
				2,
			)}\n`,
		);
		configs[family] = configPath;
	}
	return { prepared: true, root, provider: PROVIDER, configs, provider_calls: 0 };
}

/** Read the authoritative local stream; no SDK session or credentials required. */
export function inspectMaxPilot(root = DEFAULT_ROOT, family = "smoke") {
	if (!["smoke", "code"].includes(family)) throw new Error("task must be smoke or code");
	const base = join(resolve(root), family);
	const loaded = loadCampaignConfig({ configPath: join(base, "campaign.config.json") });
	if (!loaded.ok) throw new Error(loaded.reasons.join("; "));
	const eventPath = join(base, "run", "events.jsonl");
	const events = existsSync(eventPath)
		? readFileSync(eventPath, "utf8")
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line))
		: [];
	const chain = verifyChain(events);
	if (!chain.ok) throw new Error("event chain verification failed; do not run more tasks");
	const ledger = summarizeRequestLedger(events);
	const manifest = loaded.manifest;
	const queue = projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: manifest.tasks,
		events,
		manifest,
		budgetLimit: manifest.budget,
		artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
	});
	const latest = events
		.filter((e) => e.event_type === "runtime.note" && e.payload?.kind === "campaign.oracle.result")
		.at(-1);
	return {
		task: family,
		event_log: eventPath,
		chain_ok: chain.ok,
		task_states: Object.fromEntries((queue.tasks ?? []).map((task) => [task.task_id, task.state])),
		model_requests: ledger.consumed.model_requests,
		pending_requests: ledger.campaignPending.length,
		unresolved_requests: ledger.unresolved,
		ledger_diagnostics: ledger.diagnostics,
		projection_diagnostics: queue.rejected,
		oracle_status: latest?.payload?.status ?? latest?.payload?.outcome?.status ?? null,
		provider_terminations: ledger.records
			.filter((record) => record.phase === "committed")
			.map((record) => record.provider_status),
		last_worker_failure:
			events
				.filter((e) => e.event_type === "runtime.note" && e.payload?.kind === "campaign.reconciliation.requested")
				.at(-1)?.payload?.failure_mode ?? null,
		backend_currency: null,
		...(family === "smoke"
			? { artifact: JSON.parse(readFileSync(join(base, "workspace", "dataset.json"), "utf8")) }
			: {}),
	};
}

async function main() {
	const args = process.argv.slice(2);
	const command = args.shift();
	const options = { root: DEFAULT_ROOT, task: "smoke", runReal: false };
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--run-real") options.runReal = true;
		else if (["--dir", "--task"].includes(args[index]) && args[index + 1] && !args[index + 1].startsWith("--")) {
			options[args[index] === "--dir" ? "root" : "task"] = args[++index];
		} else throw new Error("usage: e1-max-pilot.mjs prepare|status|run [--dir PATH] [--task smoke|code] [--run-real]");
	}
	if (!["smoke", "code"].includes(options.task)) throw new Error("task must be smoke or code");
	if (command === "prepare") console.log(JSON.stringify(prepareMaxPilot(options.root), null, 2));
	else if (command === "status") console.log(JSON.stringify(inspectMaxPilot(options.root, options.task), null, 2));
	else if (command === "run") {
		if (!options.runReal) throw new Error("run requires --run-real; this command sends paid provider requests");
		if (options.task === "code") {
			const smoke = inspectMaxPilot(options.root, "smoke");
			if (
				smoke.task_states["task-001"] !== "completed" ||
				smoke.unresolved_requests ||
				smoke.ledger_diagnostics.length ||
				smoke.projection_diagnostics.length
			)
				throw new Error("complete and inspect the smoke task before running the code sample");
		}
		const base = join(resolve(options.root), options.task);
		const outcome = await runC6FromConfig({ configPath: join(base, "campaign.config.json"), export: true });
		await runC6FromConfig({ configPath: join(base, "campaign.config.json"), scenario: "measure", print: () => {} });
		const summary = {
			...inspectMaxPilot(options.root, options.task),
			entry_ok: outcome.ok,
			reasons: outcome.reasons ?? [],
		};
		writeFileSync(join(base, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
		console.log(JSON.stringify(summary, null, 2));
		process.exitCode =
			outcome.ok &&
			summary.task_states["task-001"] === "completed" &&
			!summary.unresolved_requests &&
			!summary.ledger_diagnostics.length &&
			!summary.projection_diagnostics.length
				? 0
				: 1;
	} else throw new Error("usage: e1-max-pilot.mjs prepare|status|run [--dir PATH] [--task smoke|code] [--run-real]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
