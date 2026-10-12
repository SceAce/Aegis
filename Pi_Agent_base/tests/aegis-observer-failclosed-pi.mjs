// Offline REAL Pi SDK faux-provider fail-closed test for the Aegis Observer.
//
// Proves the audit-failure contract end to end: when the append-only event log
// cannot be durably opened/written, a model `aegis_propose` call must NOT be
// reported as an accepted candidate, and no proposal.submitted event may exist.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-observer-failclosed-pi.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVER_PATH = join(BASE_DIR, "extensions", "aegis-observer.ts");

let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
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
	const base = mkdtempSync(join(tmpdir(), "aegis-obs-failclosed-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	// Point the audit log at a path whose parent is a REGULAR FILE, so both the
	// durable open and every append fail. The runtime must fail closed.
	const blockedParent = join(base, "blocked");
	writeFileSync(blockedParent, "this is a file, not a directory\n");
	const blockedLog = join(blockedParent, "events.jsonl");

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-closed", name: "FauxClosed" }] });
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(base, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, makeFauxModelDetails(model));

	process.env.AEGIS_EVENT_LOG = blockedLog;
	process.env.AEGIS_RAM_DIR = join(base, "ram");
	process.env.AEGIS_HANDOFF_FILE = join(base, "ram", "handoff.json");
	process.env.AEGIS_ROM_FILE = join(BASE_DIR, "agent", "ROM.md");
	process.env.AEGIS_TASK_ID = "task-closed-001";

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [OBSERVER_PATH],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	check("the observer extension loaded", loaded.errors.length === 0, JSON.stringify(loaded.errors));

	const sessionManager = SessionManager.create(cwd, sessionDir);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		resourceLoader: loader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({}),
		tools: ["read", "write", "aegis_propose"],
	});
	await session.bindExtensions({});

	const captured = [];
	faux.setResponses([
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage([fauxToolCall("aegis_propose", { kind: "claim", text: "a claim that cannot be audited" })]);
		},
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage("done");
		},
	]);

	await session.prompt("Propose something even though the audit log is unusable.");

	// The tool result text is carried into the second model request's messages.
	const secondRequest = JSON.stringify(captured[1] ?? []);
	check(
		"a proposal whose append cannot be durably recorded is NOT reported accepted",
		/could NOT record the proposal/.test(secondRequest) && !/recorded the claim as an UNVERIFIED/.test(secondRequest),
		secondRequest.slice(0, 500),
	);
	// The log path's parent is still a file: nothing was silently created.
	const blockedParentStillFile = readFileSync(blockedParent, "utf8").startsWith("this is a file");
	check("no audit file was silently created next to the blocked path", blockedParentStillFile);

	// A SIDE-EFFECTING real Pi tool must FAIL CLOSED: when the audit log is
	// unavailable, the observer blocks the tool in `tool_call`, so Pi's real
	// write tool execution NEVER happens and no file is created. A tool that only
	// returns accepted=false from a proposal is not enough proof.
	const unsafeTarget = join(cwd, "must-not-exist.txt");
	const captured2 = [];
	faux.setResponses([
		(ctx) => {
			captured2.push(ctx.messages);
			return fauxAssistantMessage([fauxToolCall("write", { path: unsafeTarget, content: "this write must never land\n" })]);
		},
		(ctx) => {
			captured2.push(ctx.messages);
			return fauxAssistantMessage("done");
		},
	]);
	await session.prompt("Write a file even though the audit log is unusable.");
	const writeRequest = JSON.stringify(captured2[1] ?? []);
	check(
		"a side-effecting write is BLOCKED at tool_call when the audit is unavailable",
		/audit log is unavailable/.test(writeRequest) && /refusing a side-effecting tool/.test(writeRequest),
		writeRequest.slice(0, 800),
	);
	check("the blocked write tool did NOT execute (no file was created)", !existsSync(unsafeTarget), unsafeTarget);

	session.dispose();
	faux.unregister();
	rmSync(base, { recursive: true, force: true });

	console.log("");
	if (failures > 0) {
		console.error(`aegis-observer-failclosed-pi FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-observer-failclosed-pi ok");
}

main().catch((error) => {
	console.error(`aegis-observer-failclosed-pi: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
