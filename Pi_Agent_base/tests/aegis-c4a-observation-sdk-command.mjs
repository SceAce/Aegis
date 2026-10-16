#!/usr/bin/env node
// Aegis C4a — Pi view command through the REAL Pi SDK + faux extension.
//
// Proves the `/aegis tasks` (and `dashboard`/`url`) subcommand is registered by
// the real Observer extension and, when invoked through a real AgentSession,
// reads the SAME committed projection and prints a readable summary + URL.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c4a-observation-sdk-command.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { assembleCampaignHost, buildC3FixtureManifest } from "../campaign/c3-entry.mjs";
import { validateManifest } from "../campaign/manifest.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OBSERVER_PATH = join(BASE_DIR, "extensions", "aegis-observer.ts");

let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

const base = mkdtempSync(join(tmpdir(), "aegis-c4a-sdk-"));
let session;
const originalStderr = process.stderr.write.bind(process.stderr);
let captured = "";
process.stderr.write = (chunk) => {
	captured += typeof chunk === "string" ? chunk : chunk.toString();
	return true;
};

try {
	const cwd = join(base, "cwd");
	const agentDir = join(base, "agent");
	const sessionDir = join(base, "sessions");
	const workspaceRoot = join(base, "workspace");
	const eventLog = join(base, "events.jsonl");
	for (const dir of [cwd, agentDir, sessionDir, workspaceRoot]) mkdirSync(dir, { recursive: true });

	// Run a REAL C3 fixture campaign to produce committed events + a manifest.
	const validated = validateManifest(buildC3FixtureManifest({ workspaceRoot }));
	const assembled = await assembleCampaignHost({
		manifest: validated.manifest,
		workspaceRoot,
		workDir: base,
		eventLogPath: eventLog,
		mode: "auto",
	});
	await assembled.host.run();
	if (assembled.sink.close) await assembled.sink.close();
	const manifestPath = join(base, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8");

	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLog,
		AEGIS_CAMPAIGN_MANIFEST: manifestPath,
		AEGIS_RAM_DIR: join(base, "ram"),
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
		AEGIS_TASK_ID: "task-c4a-sdk",
	});

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-c4a", name: "FauxC4a" }] });
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: join(base, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		id: model.id,
		name: model.name,
		provider: model.provider,
		api: model.api,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		baseUrl: model.baseUrl,
	});

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
	check("observer extension loaded without errors", loaded.errors.length === 0, JSON.stringify(loaded.errors));

	const sessionManager = SessionManager.create(cwd, sessionDir);
	const created = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		resourceLoader: loader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({}),
		tools: ["read"],
	});
	session = created.session;
	await session.bindExtensions({
		commandContextActions: {
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: true }),
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			reload: async () => {},
		},
	});

	faux.setResponses([fauxAssistantMessage("ready")]);
	await session.prompt("Open the observation task.");

	// Invoke the real command through the SDK; the printed text lands on stderr
	// (print mode has no UI) or the UI seam.
	captured = "";
	faux.setResponses([fauxAssistantMessage("tasks")]);
	await session.prompt("/aegis tasks");
	check("the /aegis tasks command printed the campaign summary", /Aegis tasks:/.test(captured), captured.slice(-200));
	check("the command shows the committed task counts", /tasks total=2/.test(captured), captured.slice(-200));
	check("the command shows the action counts", /actions requested=2/.test(captured), captured.slice(-200));

	captured = "";
	faux.setResponses([fauxAssistantMessage("url")]);
	await session.prompt("/aegis url");
	check(
		"the /aegis url command reports the observation URL/configuration",
		/Aegis url:|Aegis observation URL:|start the observation server/.test(captured),
		captured.slice(-200),
	);

	check("no write/effect happened during the view commands", !/observer.*error/i.test(captured));
} finally {
	process.stderr.write = originalStderr;
	if (session && typeof session.dispose === "function") {
		try {
			await session.dispose();
		} catch {
			/* best-effort */
		}
	}
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
	console.log(`c4a sdk command: ${failures} failure(s)`);
	process.exit(1);
}
console.log("c4a sdk command: all checks passed");
