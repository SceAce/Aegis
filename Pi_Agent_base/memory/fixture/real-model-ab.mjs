#!/usr/bin/env node
// Aegis-owned OPTIONAL real-model A/B runner for the fixture direct slice.
//
// This file is NOT an offline test and is NEVER executed by the offline suites.
// It makes real network requests to the configured `relay` provider and costs
// money, so it refuses to start without the explicit `--run-real` flag.
//
// It runs the SAME task twice through `runOrchestratedTask`:
//   * WITH a compiled active Experience -> the Router must hit direct, so there
//     must be 0 model requests and no Pi session (the planner is booby-trapped).
//   * WITHOUT any Experience -> the constrained Pi planner runs the single
//     `aegis_fixture_unlock` tool in plan-only mode, and the orchestrator then
//     executes the registered primitive through the Host and verifies it with
//     the independent Oracle. At most two provider requests are allowed.
//
// The Oracle decides success from the trusted filesystem state and the
// hash-chained event log, never from the model's final prose. Provider request,
// tool-call, token and cost metrics are printed and written to the report when
// the provider reports them.
//
// Run (requires the isolated agent dir credential and explicit consent):
//
//   node --import Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/memory/fixture/real-model-ab.mjs \
//     --run-real --output-dir /tmp/aegis-real-ab [--timeout-ms 120000]
//
// The nested Pi repository and the model configuration are only read, never
// modified. Credentials are never printed.

import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

import { compile } from "./compiler.mjs";
import { makeTask, runFixtureTask } from "./host.mjs";
import { judgeRun } from "./oracle.mjs";
import { runOrchestratedTask } from "./orchestrator.mjs";
import { writeJson } from "./contracts.mjs";

const TOOL_NAME = "aegis_fixture_unlock";
const PROVIDER = "relay";
const MODEL_ID = "deepseek-v4.1-flash";
const MAX_PROVIDER_REQUESTS = 2;
const BANNED_TOOLS = ["bash", "powershell", "edit", "write", "read", "grep", "find", "ls", "mcp", "codemode"];
const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENT_DIR = join(BASE_DIR, "config", "agent");
const EXTENSION_PATH = join(BASE_DIR, "extensions", "aegis-fixture-tool.ts");

const USAGE = `Aegis optional real-model A/B runner (makes real provider calls).

Usage:
  node --import Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \\
    Pi_Agent_base/memory/fixture/real-model-ab.mjs --run-real [options]

Required:
  --run-real                 Explicitly acknowledge real network/provider spend.

Options:
  --output-dir DIR           Report/experiment/report dir (default: fresh temp dir).
  --timeout-ms N             Per planner-run wall-clock timeout (default 120000, max 600000).
  --help                     Print this help and exit 0.

Environment: the isolated provider credential is read from
  ${AGENT_DIR}
and is never printed.`;

function parseArgs(argv) {
	const options = { runReal: false, timeoutMs: 120000 };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") options.help = true;
		else if (argument === "--run-real") options.runReal = true;
		else if (argument === "--output-dir") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) throw new Error("--output-dir requires a value");
			options.outputDir = value;
			index += 1;
		} else if (argument === "--timeout-ms") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) throw new Error("--timeout-ms requires a value");
			const parsed = Number(value);
			if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--timeout-ms must be a positive integer");
			options.timeoutMs = Math.min(parsed, 600000);
			index += 1;
		} else {
			throw new Error(`unknown option: ${argument}`);
		}
	}
	return options;
}

function metricsOf(session, providerRequests, extras = {}) {
	const stats = session.getSessionStats();
	return {
		provider_requests: providerRequests,
		assistant_messages: stats.assistantMessages,
		tool_calls: stats.toolCalls,
		tool_results: stats.toolResults,
		tokens: stats.tokens,
		cost: stats.cost,
		...extras,
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(`${USAGE}\n`);
		return;
	}
	if (!options.runReal) {
		process.stderr.write("Refusing to run: pass --run-real to acknowledge real provider spend.\n\n");
		process.stderr.write(`${USAGE}\n`);
		process.exitCode = 2;
		return;
	}
	if (!existsSync(join(AGENT_DIR, "models.json")) || !existsSync(join(AGENT_DIR, "auth.json"))) {
		throw new Error(`isolated agent config is missing under ${AGENT_DIR}`);
	}

	const outputDir = options.outputDir ? resolve(options.outputDir) : mkdtempSync(join(tmpdir(), "aegis-real-ab-"));
	const experimentsRoot = join(outputDir, "experiments");
	const cwd = join(outputDir, "cwd");
	mkdirSync(experimentsRoot, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
	process.env.PI_CODING_AGENT_SESSION_DIR = join(outputDir, "sessions");

	// Explicit provider/model resolution from the isolated agent dir. No network
	// catalog refresh is requested; the model stream is the only provider call.
	const modelRuntime = await ModelRuntime.create({
		authPath: join(AGENT_DIR, "auth.json"),
		modelsPath: join(AGENT_DIR, "models.json"),
	});
	const model = modelRuntime.getModel(PROVIDER, MODEL_ID);
	if (!model) throw new Error(`configured model not found: ${PROVIDER}/${MODEL_ID}`);

	// The only callable tool is the Aegis-owned constrained fixture tool. The
	// loader disables discovered extensions/skills/prompts/themes/context files,
	// so no shell/edit/write/MCP/codemode tool or project resource can appear.
	async function createRealSession() {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: AGENT_DIR,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [EXTENSION_PATH],
		});
		await loader.reload();
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir: AGENT_DIR,
			model,
			modelRuntime,
			resourceLoader: loader,
			sessionManager,
			settingsManager: SettingsManager.inMemory({}),
			tools: [TOOL_NAME],
		});
		const executions = [];
		const state = { providerRequests: 0, abortedForBudget: false, timedOut: false };
		session.subscribe((event) => {
			if (event.type === "tool_execution_start") executions.push(event.toolName);
			if (event.type === "message_end" && event.message?.role === "assistant") {
				state.providerRequests += 1;
				if (state.providerRequests > MAX_PROVIDER_REQUESTS && !state.abortedForBudget) {
					state.abortedForBudget = true;
					void session.abort();
				}
			}
		});
		return { session, executions, state };
	}

	// --- Two independent offline live episodes -> one active Experience -----
	const episodeOne = join(experimentsRoot, "episode-1");
	const episodeTwo = join(experimentsRoot, "episode-2");
	runFixtureTask({ root: episodeOne });
	const judgedOne = judgeRun(episodeOne);
	runFixtureTask({ root: episodeTwo });
	const judgedTwo = judgeRun(episodeTwo);
	if (judgedOne.status !== "success" || judgedTwo.status !== "success") {
		throw new Error(`offline episodes did not verify: ${judgedOne.status}/${judgedTwo.status}`);
	}
	const compiled = compile({ projectionDirs: [episodeOne, episodeTwo], outputDir: join(experimentsRoot, "compiled") });
	if (compiled.experience.status !== "active") {
		throw new Error(`compiled Experience is not active: ${compiled.report.gate.reasons.join("; ")}`);
	}

	// --- Direct branch: active Experience must not touch the model ----------
	const directRoot = join(experimentsRoot, "direct");
	let directPlannerCalls = 0;
	const direct = await runOrchestratedTask({
		root: directRoot,
		task: makeTask(),
		experiences: [compiled.experience],
		planner: () => {
			directPlannerCalls += 1;
			throw new Error("planner must not run on a direct hit");
		},
	});

	// --- No-memory branch: constrained real Pi planner ----------------------
	process.env.AEGIS_FIXTURE_PLAN_ONLY = "1";
	process.env.AEGIS_FIXTURE_WORK_DIR = join(outputDir, "pi-work");
	process.env.AEGIS_FIXTURE_AUDIT_LOG = join(outputDir, "pi-audit.jsonl");
	const noMemoryRoot = join(experimentsRoot, "no-experience");
	let piPlan = null;
	let noMemory = null;
	let noMemoryError = null;
	async function planWithRealModel() {
		const { session, executions, state } = await createRealSession();
		try {
			const timer = setTimeout(() => {
				state.timedOut = true;
				void session.abort();
			}, options.timeoutMs);
			try {
				await session.prompt(
					"Unlock the fixture door. Call the aegis_fixture_unlock tool exactly once with path \"door.json\" and nothing else.",
				);
			} finally {
				clearTimeout(timer);
			}
			// Oracle-irrelevant prose is intentionally not captured. The only plan
			// signal used is the tool call's data-only arguments.
			const toolResult = session.messages.find((message) => message.role === "toolResult" && message.toolName === TOOL_NAME);
			piPlan = {
				arguments: toolResult?.details?.arguments ?? null,
				tool_name: toolResult?.toolName ?? null,
				tool_executions: [...executions],
				active_tools: session.getActiveToolNames(),
				metrics: metricsOf(session, state.providerRequests, {
					timed_out: state.timedOut,
					budget_aborted: state.abortedForBudget,
				}),
			};
			return {
				arguments: piPlan.arguments,
				model_requests: state.providerRequests,
				pi_session_started: true,
				tool_name: piPlan.tool_name,
			};
		} finally {
			session.dispose();
		}
	}
	try {
		noMemory = await runOrchestratedTask({ root: noMemoryRoot, task: makeTask(), experiences: [], planner: planWithRealModel });
	} catch (error) {
		noMemoryError = error instanceof Error ? error.message : String(error);
	} finally {
		delete process.env.AEGIS_FIXTURE_PLAN_ONLY;
	}

	// --- Verification: Oracle decides, never the model's prose --------------
	const activeTools = Array.isArray(piPlan?.active_tools) ? piPlan.active_tools : [];
	const bannedActiveTools = activeTools.filter((name) => BANNED_TOOLS.includes(name));
	const directZeroModelCalls =
		direct.route === "direct" && direct.model_requests === 0 && direct.pi_session_started === false && directPlannerCalls === 0;
	const noMemoryWithinBudget = Boolean(piPlan) && piPlan.metrics.provider_requests <= MAX_PROVIDER_REQUESTS && !piPlan.metrics.timed_out;
	const noMemoryUsedConstrainedTool =
		Boolean(piPlan) &&
		piPlan.tool_name === TOOL_NAME &&
		piPlan.tool_executions.length === 1 &&
		piPlan.tool_executions[0] === TOOL_NAME &&
		piPlan.arguments?.path === "door.json" &&
		bannedActiveTools.length === 0;
	const noMemoryOracleSuccess = Boolean(noMemory) && noMemory.route === "deliberate" && noMemory.judged?.status === "success";
	const directOracleSuccess = direct.judged?.status === "success";
	const passed = directZeroModelCalls && directOracleSuccess && noMemoryWithinBudget && noMemoryUsedConstrainedTool && noMemoryOracleSuccess;

	const report = {
		schema_version: "1.0",
		runner: "aegis-real-model-ab",
		real_model: true,
		provider: PROVIDER,
		model: MODEL_ID,
		output_dir: outputDir,
		offline_episodes: { first: judgedOne.status, second: judgedTwo.status },
		experience: {
			status: compiled.experience.status,
			experience_id: compiled.experience.experience_id,
			gate_reasons: compiled.report.gate.reasons,
		},
		direct: {
			route: direct.route,
			model_requests: direct.model_requests,
			pi_session_started: direct.pi_session_started,
			planner_calls: directPlannerCalls,
			oracle_status: direct.judged?.status ?? null,
			oracle_checks: direct.judged?.checks ?? null,
		},
		no_experience: {
			route: noMemory?.route ?? null,
			model_requests: noMemory?.model_requests ?? null,
			pi_session_started: noMemory?.pi_session_started ?? null,
			planner_arguments: piPlan?.arguments ?? null,
			tool_name: piPlan?.tool_name ?? null,
			tool_executions: piPlan?.tool_executions ?? [],
			active_tools: activeTools,
			metrics: piPlan?.metrics ?? null,
			oracle_status: noMemory?.judged?.status ?? null,
			oracle_checks: noMemory?.judged?.checks ?? null,
			error: noMemoryError,
		},
		budget: { max_provider_requests: MAX_PROVIDER_REQUESTS, timeout_ms: options.timeoutMs },
		verified: {
			direct_zero_model_calls: directZeroModelCalls,
			direct_oracle_success: directOracleSuccess,
			no_memory_within_budget: noMemoryWithinBudget,
			no_memory_used_constrained_tool: noMemoryUsedConstrainedTool,
			no_memory_oracle_success: noMemoryOracleSuccess,
		},
		honest_notes: [
			"Success is decided only by the Aegis Oracle over trusted state/events; the model's final prose is never used as an oracle.",
			"This runner is optional and is not part of any offline test; it spends real provider budget.",
		],
	};
	const reportPath = join(outputDir, "real-model-ab-report.json");
	writeJson(reportPath, report);

	console.log(JSON.stringify({
		report: reportPath,
		provider: PROVIDER,
		model: MODEL_ID,
		direct: report.direct,
		no_experience: report.no_experience,
		verified: report.verified,
	}, null, 2));

	if (!passed) {
		console.error("real-model-ab FAILED: one or more invariants did not hold (see report)");
		process.exitCode = 1;
		return;
	}
	console.log("real-model-ab ok");
}

main().catch((error) => {
	console.error(`real-model-ab: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
