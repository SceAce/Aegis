// Offline Aegis-orchestrator <-> Pi integration test for the fixture direct
// slice. This is the test that pins the THINK.md `direct` semantics.
//
// Same task, two branches:
//   * active Experience -> the orchestrator checks the Router BEFORE any model
//     call, executes the registered primitive through the Host and verifies it
//     with the independent Oracle. Assertions: 0 model requests, 0 Pi session
//     startups, route=direct, oracle success.
//   * no Experience     -> the orchestrator starts the tightly constrained Pi
//     SDK session (faux provider, no network), obtains the single
//     `aegis_fixture_unlock` tool call, then executes the registered primitive
//     through the same Host + Oracle. Assertions: >=1 model request, exactly one
//     Pi session, the same constrained tool, oracle success.
//
// The faux provider only replays a scripted tool call. This proves orchestration
// wiring and separation of duties; it does NOT prove that a real model's
// behavior improves. That claim needs a real (or controlled-simulation) DeepSeek
// A/B with an experience-free planner and a comparison of model/tool calls and
// correctness. See the printed honest boundary.
//
// Run (offline, isolated temp dirs):
//
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/fixture-pi-orchestrator.mjs
//
// The nested Pi repository is only read, never modified.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";

import { compile } from "../fixtures/compiler.mjs";
import { readJson, readJsonl } from "../shared/contracts.mjs";
import { makeTask, runFixtureTask } from "../fixtures/host.mjs";
import { judgeRun } from "../fixtures/oracle.mjs";
import { runOrchestratedTask } from "../fixtures/orchestrator.mjs";

const TOOL_NAME = "aegis_fixture_unlock";
const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_PATH = join(BASE_DIR, "extensions", "aegis-fixture-tool.ts");

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log(`ok - ${name}`);
	} else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

function makeFauxModelDetails(model) {
	return {
		baseUrl: model.baseUrl,
		api: model.api,
		apiKey: "faux-key",
		models: [{
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		}],
	};
}

// Stable subset that must be identical for both branches to call it "the same
// task"; experiment ids / independence groups differ by directory by design.
function taskProjection(manifest) {
	return {
		goal: manifest.goal,
		authorization: manifest.authorization,
		environment: manifest.environment,
		preconditions: manifest.state.preconditions,
		postconditions: manifest.state.postconditions,
		action: manifest.action,
		task_types: manifest.task_types,
	};
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-pi-orchestrator-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_SESSION_DIR = join(base, "sessions");

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(base, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, makeFauxModelDetails(model));

	let sessionStarts = 0;
	let toolExecutions = 0;
	async function createSession() {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
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
			agentDir,
			model,
			modelRuntime,
			resourceLoader: loader,
			sessionManager,
			settingsManager: SettingsManager.inMemory({}),
			tools: [TOOL_NAME],
		});
		const executions = [];
		session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				executions.push(event.toolName);
				toolExecutions += 1;
			}
		});
		sessionStarts += 1;
		return { session, loader, executions };
	}

	// --- Active Experience from two independent live Node episodes ---------
	const episodeOne = join(base, "episode-1");
	const episodeTwo = join(base, "episode-2");
	runFixtureTask({ root: episodeOne });
	const judgedOne = judgeRun(episodeOne);
	runFixtureTask({ root: episodeTwo });
	const judgedTwo = judgeRun(episodeTwo);
	check("two independent live episodes succeed", judgedOne.status === "success" && judgedTwo.status === "success", `${judgedOne.status}/${judgedTwo.status}`);
	const compiled = compile({ projectionDirs: [episodeOne, episodeTwo], outputDir: join(base, "compiled") });
	check("compiler promotes an active fixture Experience", compiled.experience.status === "active", compiled.report.gate.reasons.join("; "));

	// --- Branch A: active Experience routes before any model call ----------
	const directRoot = join(base, "direct-task");
	let plannerCalls = 0;
	const directCallsBefore = faux.state.callCount;
	const directSessionsBefore = sessionStarts;
	const direct = await runOrchestratedTask({
		root: directRoot,
		task: makeTask(),
		experiences: [compiled.experience],
		planner: () => {
			plannerCalls += 1;
			throw new Error("the planner must not run when an active Experience matches");
		},
	});
	check("active Experience routes direct", direct.route === "direct" && direct.plan_source === "experience", `${direct.route}/${direct.plan_source}`);
	check("direct branch names the active Experience", direct.experience_id === compiled.experience.experience_id, String(direct.experience_id));
	check("direct branch made 0 model requests", direct.model_requests === 0 && faux.state.callCount === directCallsBefore, `${direct.model_requests}/${faux.state.callCount - directCallsBefore}`);
	check("direct branch started no Pi session and never called the planner", direct.pi_session_started === false && sessionStarts === directSessionsBefore && plannerCalls === 0, `sessions=${sessionStarts - directSessionsBefore} planner=${plannerCalls}`);
	check("direct branch Oracle verifies success", direct.judged.status === "success", direct.judged.status);
	check("direct branch Host actually executed the primitive", direct.run.request.payload.route === "direct" && direct.run.request.payload.action_ref === "fixture.unlock", JSON.stringify(direct.run.request.payload));
	check("direct branch unlocked the fixture on disk", readJson(join(directRoot, "fixture", "door.json")).locked === false, "still locked");
	const directReport = readJson(join(directRoot, "oracle-report.json"));
	check("direct branch oracle report verifies postconditions", directReport.status === "success" && directReport.checks.postconditions_verified === true, JSON.stringify(directReport.checks));

	// --- Branch A2: conflicting active Experiences refuse before any call ---
	// Two independently matching active Experiences are an unresolvable conflict.
	// The orchestrator must fail closed: no planner/model call, no Pi session, no
	// registered action execution, and the fixture state must stay untouched. The
	// refused route must NOT be reported as `deliberate`.
	const refuseRoot = join(base, "refuse-task");
	let refusePlannerCalls = 0;
	const refuseCallsBefore = faux.state.callCount;
	const refuseSessionsBefore = sessionStarts;
	const refuseExecutionsBefore = toolExecutions;
	const refused = await runOrchestratedTask({
		root: refuseRoot,
		task: makeTask(),
		experiences: [compiled.experience, { ...compiled.experience, experience_id: "experience-fixture-conflict-clone" }],
		planner: () => {
			refusePlannerCalls += 1;
			throw new Error("the planner must not run for a refused conflict");
		},
	});
	check("conflicting experiences are refused, not deliberate", refused.route === "refuse" && refused.route !== "deliberate" && refused.decision.routerDecision === "conflict", `${refused.route}/${refused.decision?.routerDecision}`);
	check("refuse branch names no plan source and no experience", refused.plan_source === null && refused.used_experience === false && refused.experience_id === null, JSON.stringify({ plan_source: refused.plan_source, used_experience: refused.used_experience, experience_id: refused.experience_id }));
	check("refuse branch made 0 model requests and started no Pi session", refused.model_requests === 0 && refused.pi_session_started === false && faux.state.callCount === refuseCallsBefore && sessionStarts === refuseSessionsBefore, `models=${refused.model_requests}/${faux.state.callCount - refuseCallsBefore} sessions=${sessionStarts - refuseSessionsBefore}`);
	check("refuse branch never called the planner and executed no tool", refusePlannerCalls === 0 && toolExecutions === refuseExecutionsBefore, `planner=${refusePlannerCalls} tool_executions=${toolExecutions - refuseExecutionsBefore}`);
	check("refuse branch executed no registered action", refused.run === null && refused.judged === null, JSON.stringify({ run: refused.run, judged: refused.judged }));
	check("refuse branch left the fixture locked and unchanged", readJson(join(refuseRoot, "fixture", "door.json")).locked === true, "fixture changed");
	check(
		"refuse branch wrote no experiment artifacts",
		!existsSync(join(refuseRoot, "run.json")) && !existsSync(join(refuseRoot, "events.jsonl")) && !existsSync(join(refuseRoot, "oracle-report.json")),
		"experiment artifacts exist",
	);

	// --- Branch B: no Experience launches the constrained Pi session -------
	const noExpRoot = join(base, "no-experience-task");
	process.env.AEGIS_FIXTURE_PLAN_ONLY = "1";
	process.env.AEGIS_FIXTURE_WORK_DIR = join(base, "work");
	process.env.AEGIS_FIXTURE_AUDIT_LOG = join(base, "audit-planned.jsonl");
	const piCallsBefore = faux.state.callCount;
	const piSessionsBefore = sessionStarts;
	let piPlan = null;
	async function planWithPi() {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(TOOL_NAME, { path: "door.json" })]),
			fauxAssistantMessage("The fixture door is unlocked."),
		]);
		const { session, executions } = await createSession();
		await session.prompt("Unlock the fixture door.");
		const toolResult = session.messages.find((message) => message.role === "toolResult" && message.toolName === TOOL_NAME);
		piPlan = {
			arguments: toolResult?.details?.arguments ?? null,
			tool_name: toolResult?.toolName ?? null,
			executions: [...executions],
		};
		const modelRequests = faux.state.callCount - piCallsBefore;
		session.dispose();
		return { arguments: piPlan.arguments, model_requests: modelRequests, pi_session_started: true, tool_name: piPlan.tool_name };
	}
	const noExp = await runOrchestratedTask({
		root: noExpRoot,
		task: makeTask(),
		experiences: [],
		planner: planWithPi,
	});
	delete process.env.AEGIS_FIXTURE_PLAN_ONLY;

	check("no-Experience branch made >=1 Pi model request", noExp.model_requests >= 1 && faux.state.callCount > piCallsBefore, `planner=${noExp.model_requests} faux=${faux.state.callCount - piCallsBefore}`);
	check("no-Experience branch started exactly one Pi session", noExp.pi_session_started === true && sessionStarts === piSessionsBefore + 1, `sessions=${sessionStarts - piSessionsBefore}`);
	check("no-Experience branch used the same constrained tool", piPlan?.executions?.length === 1 && piPlan.executions[0] === TOOL_NAME && piPlan.tool_name === TOOL_NAME, JSON.stringify(piPlan));
	check("Pi planner proposed the task target", piPlan?.arguments?.path === "door.json", JSON.stringify(piPlan?.arguments));
	check("no-Experience branch Oracle verifies success", noExp.judged.status === "success", noExp.judged.status);
	check("no-Experience branch Host used the deliberate route", noExp.route === "deliberate" && noExp.run.request.payload.route === "deliberate", `${noExp.route}/${noExp.run.request.payload.route}`);
	check("no-Experience branch Host executed the same primitive", noExp.run.request.payload.action_ref === "fixture.unlock", String(noExp.run.request.payload.action_ref));
	check("no-Experience branch unlocked the fixture on disk", readJson(join(noExpRoot, "fixture", "door.json")).locked === false, "still locked");
	const plannedAudit = readJsonl(process.env.AEGIS_FIXTURE_AUDIT_LOG);
	check(
		"Pi branch audit records the planned constrained call",
		plannedAudit.some((row) => row.audit_event === "pi_tool_allowed" && row.tool_name === TOOL_NAME)
			&& plannedAudit.some((row) => row.audit_event === "pi_tool_planned" && row.input?.path === "door.json"),
		JSON.stringify(plannedAudit.map((row) => row.audit_event)),
	);

	// --- Same-task proof ---------------------------------------------------
	const directProjection = JSON.stringify(taskProjection(direct.run.manifest));
	const noExpProjection = JSON.stringify(taskProjection(noExp.run.manifest));
	check("both branches executed the SAME task", directProjection === noExpProjection, "task projections differ");

	faux.unregister();
	delete process.env.AEGIS_FIXTURE_PLAN_ONLY;
	delete process.env.AEGIS_FIXTURE_WORK_DIR;
	delete process.env.AEGIS_FIXTURE_AUDIT_LOG;
	rmSync(base, { recursive: true, force: true });

	console.log("");
	console.log("honest boundary: the faux provider only replays a scripted tool call.");
	console.log("This proves orchestration wiring (route-before-model, direct Host+Oracle, constrained Pi fallback),");
	console.log("NOT real-model behavioral improvement. A real DeepSeek A/B with an experience-free planner is still required.");
	console.log("");
	if (failures > 0) {
		console.error(`fixture-pi-orchestrator FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("fixture-pi-orchestrator ok");
}

main().catch((error) => {
	console.error(`fixture-pi-orchestrator: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
