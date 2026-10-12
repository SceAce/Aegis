// Offline Aegis <-> Pi integration test for the fixture direct slice.
//
// This test drives a REAL Pi agent session (faux provider, no network, no real
// model) whose model issues a tool call for the single Aegis-owned fixture
// tool. It proves:
//
//   1. the Aegis extension registers exactly one constrained tool and no
//      default bash/edit/write/MCP/codemode tool is active,
//   2. a real Pi tool call executes the registered `fixture.unlock` primitive
//      through the Aegis Host and is independently judged by the Oracle,
//   3. when a compiled active Experience is configured, the Host takes the
//      direct route for the Pi-initiated call,
//   4. out-of-scope parameters are denied fail-closed (no execution, no
//      experiment directory),
//   5. the Node-only Host path stays deterministic.
//
// Run (offline, isolated temp dirs):
//
//   node --import Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/fixture-pi-integration.mjs
//
// The nested Pi repository is only read, never modified.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";

import { compile } from "../memory/fixture/compiler.mjs";
import { readJson, readJsonl } from "../memory/fixture/contracts.mjs";
import { runFixtureTask } from "../memory/fixture/host.mjs";
import { judgeRun } from "../memory/fixture/oracle.mjs";
import { route } from "../memory/fixture/router.mjs";

const TOOL_NAME = "aegis_fixture_unlock";
const BANNED_TOOLS = ["bash", "powershell", "edit", "write", "read", "grep", "find", "ls", "mcp", "codemode"];
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

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-pi-integration-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const workDir = join(base, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(workDir, { recursive: true });

	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_SESSION_DIR = join(base, "sessions");
	process.env.AEGIS_FIXTURE_WORK_DIR = workDir;
	process.env.AEGIS_FIXTURE_EXPERIENCE_DIR = join(base, "compiled");

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
		const loaded = loader.getExtensions();
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
		const executionEnds = [];
		session.subscribe((event) => {
			if (event.type === "tool_execution_start") executions.push(event.toolName);
			if (event.type === "tool_execution_end") executionEnds.push({ toolName: event.toolName, isError: event.isError, ran: event.durationMs !== undefined });
		});
		return { session, loaded, executions, executionEnds };
	}

	// --- Phase 1: two independent Node episodes -> active Experience --------
	const episodeOne = join(base, "node-episode-1");
	const episodeTwo = join(base, "node-episode-2");
	runFixtureTask({ root: episodeOne });
	const judgedOne = judgeRun(episodeOne);
	runFixtureTask({ root: episodeTwo });
	const judgedTwo = judgeRun(episodeTwo);
	check("two independent live episodes succeed", judgedOne.status === "success" && judgedTwo.status === "success", `${judgedOne.status}/${judgedTwo.status}`);
	const compiled = compile({
		projectionDirs: [episodeOne, episodeTwo],
		outputDir: process.env.AEGIS_FIXTURE_EXPERIENCE_DIR,
	});
	check("compiler promotes an active fixture Experience", compiled.experience.status === "active", compiled.report.gate.reasons.join("; "));

	// --- Phase 2: real Pi session executes the direct route ----------------
	process.env.AEGIS_FIXTURE_AUDIT_LOG = join(base, "audit-direct.jsonl");
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall(TOOL_NAME, { path: "door.json" })]),
		fauxAssistantMessage("The fixture door is unlocked."),
	]);
	const directSession = await createSession();
	check("extension loads without errors", directSession.loaded.errors.length === 0, JSON.stringify(directSession.loaded.errors));
	const registeredTools = directSession.loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
	check("extension registers exactly one tool", registeredTools.length === 1 && registeredTools[0] === TOOL_NAME, registeredTools.join(", "));
	const activeTools = directSession.session.getActiveToolNames();
	check("active tools are exactly the Aegis fixture tool", activeTools.length === 1 && activeTools[0] === TOOL_NAME, activeTools.join(", "));
	for (const banned of BANNED_TOOLS) {
		check(`default tool "${banned}" is disabled`, !activeTools.includes(banned));
	}

	await directSession.session.prompt("Unlock the fixture door.");
	check("Pi issued the tool call through the real tool loop", directSession.executions.filter((name) => name === TOOL_NAME).length === 1, directSession.executions.join(", "));
	check("the executed Pi tool call actually ran the tool body", directSession.executionEnds.some((end) => end.toolName === TOOL_NAME && end.ran === true), JSON.stringify(directSession.executionEnds));
	const directResults = directSession.session.messages.filter((message) => message.role === "toolResult" && message.toolName === TOOL_NAME);
	check("Pi produced exactly one tool result", directResults.length === 1, String(directResults.length));
	const directResult = directResults[0];
	const directDetails = directResult?.details;
	check("tool result is not an error", directResult?.isError !== true, JSON.stringify(directResult?.content));
	check("Host took the direct route for the Pi call", directDetails?.route === "direct", JSON.stringify(directDetails));
	check("Oracle independently judged success", directDetails?.oracle_status === "success", JSON.stringify(directDetails));
	check("direct hit names the active Experience", typeof directDetails?.experience_id === "string" && directDetails.experience_id.length > 0, String(directDetails?.experience_id));

	const experimentDir = directDetails?.experiment_dir;
	check("experiment directory exists", typeof experimentDir === "string" && existsSync(experimentDir), String(experimentDir));
	if (experimentDir && existsSync(experimentDir)) {
		const hostEvents = readJsonl(join(experimentDir, "events.jsonl"));
		const requested = hostEvents.find((event) => event.event_type === "action.requested");
		check("Host event log records a direct action.requested", requested?.payload?.route === "direct", JSON.stringify(requested?.payload));
		check("Host executed the registered fixture.unlock primitive", requested?.payload?.action_ref === "fixture.unlock", String(requested?.payload?.action_ref));
		const report = readJson(join(experimentDir, "oracle-report.json"));
		check("Oracle report verifies postconditions", report.status === "success" && report.checks.postconditions_verified === true, JSON.stringify(report.checks));
		const finalState = readJson(join(experimentDir, "fixture", "door.json"));
		check("fixture file is actually unlocked on disk", finalState.locked === false && finalState.target === "door", JSON.stringify(finalState));
	}

	const directAudit = readJsonl(process.env.AEGIS_FIXTURE_AUDIT_LOG);
	const allowedRows = directAudit.filter((row) => row.audit_event === "pi_tool_allowed");
	const resultRows = directAudit.filter((row) => row.audit_event === "pi_tool_result" && row.ok === true);
	check("audit trail records the allowed Pi tool call", allowedRows.length === 1, String(allowedRows.length));
	check(
		"audit trail links the Pi call to the Host experiment and Oracle",
		resultRows.length === 1 && resultRows[0].experiment_dir === experimentDir && resultRows[0].oracle_status === "success" && resultRows[0].route === "direct",
		JSON.stringify(resultRows[0]),
	);
	directSession.session.dispose();

	// --- Phase 3: out-of-scope parameters are denied fail-closed -----------
	process.env.AEGIS_FIXTURE_AUDIT_LOG = join(base, "audit-denied.jsonl");
	const experimentsBefore = readdirSync(workDir).filter((name) => name.startsWith("pi-call-"));
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall(TOOL_NAME, { path: "../escape.json" })]),
		fauxAssistantMessage("Blocked."),
		fauxAssistantMessage([fauxToolCall(TOOL_NAME, { path: "door.json", command: "rm -rf /" })]),
		fauxAssistantMessage("Blocked too."),
	]);
	const deniedSession = await createSession();
	await deniedSession.session.prompt("Try to escape the fixture scope.");
	await deniedSession.session.prompt("Try to smuggle an extra parameter.");
	check(
		"denied Pi calls fail closed before the tool body runs",
		deniedSession.executionEnds.length >= 1 && deniedSession.executionEnds.every((end) => end.isError === true && end.ran === false),
		JSON.stringify(deniedSession.executionEnds),
	);
	const deniedResults = deniedSession.session.messages.filter((message) => message.role === "toolResult" && message.toolName === TOOL_NAME);
	check("denied Pi calls produced error tool results", deniedResults.length === 2 && deniedResults.every((message) => message.isError === true), JSON.stringify(deniedResults.map((message) => message.isError)));
	const experimentsAfter = readdirSync(workDir).filter((name) => name.startsWith("pi-call-"));
	check("denied Pi calls created no experiment directory", experimentsAfter.length === experimentsBefore.length, `${experimentsBefore.length} -> ${experimentsAfter.length}`);
	const deniedAudit = readJsonl(process.env.AEGIS_FIXTURE_AUDIT_LOG);
	const deniedRows = deniedAudit.filter((row) => row.audit_event === "pi_tool_denied");
	const deniedResults2 = deniedAudit.filter((row) => row.audit_event === "pi_tool_result");
	check("audit trail records the scope denial", deniedRows.some((row) => row.reason.includes("outside the allowed fixture scope")), JSON.stringify(deniedRows));
	check("audit trail records no executed result for a scoped denial", deniedResults2.length === 0, JSON.stringify(deniedResults2));
	deniedSession.session.dispose();

	// --- Phase 4: Node-only Host paths stay deterministic ------------------
	const experiences = [compiled.experience];
	const directRouter = ({ manifest, fixtureRoot }) => route({ experiences, manifest, fixtureRoot });
	const detDirectOne = runFixtureTask({ root: join(base, "det-direct-1"), router: directRouter });
	const detDirectJudgedOne = judgeRun(detDirectOne.root);
	const detDirectTwo = runFixtureTask({ root: join(base, "det-direct-2"), router: directRouter });
	const detDirectJudgedTwo = judgeRun(detDirectTwo.root);
	check(
		"Node direct route is deterministic",
		detDirectOne.request.payload.route === "direct" && detDirectTwo.request.payload.route === "direct" && detDirectJudgedOne.status === "success" && detDirectJudgedTwo.status === "success",
		`${detDirectOne.request.payload.route}/${detDirectJudgedOne.status} ${detDirectTwo.request.payload.route}/${detDirectJudgedTwo.status}`,
	);
	const deliberateOne = runFixtureTask({ root: join(base, "det-node-1") });
	const deliberateJudgedOne = judgeRun(deliberateOne.root);
	check(
		"Node-only Host path still succeeds deterministically",
		deliberateOne.request.payload.route === "deliberate" && deliberateJudgedOne.status === "success",
		`${deliberateOne.request.payload.route}/${deliberateJudgedOne.status}`,
	);

	faux.unregister();
	rmSync(base, { recursive: true, force: true });

	console.log("");
	if (failures > 0) {
		console.error(`fixture-pi-integration FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("fixture-pi-integration ok");
}

main().catch((error) => {
	console.error(`fixture-pi-integration: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
