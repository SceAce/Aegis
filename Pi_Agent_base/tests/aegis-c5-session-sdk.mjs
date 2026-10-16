#!/usr/bin/env node
// Aegis C5 — real SDK/faux Session rotation through the unified entry.
//
// Required C5-S1: the unified entry (not a hand-assembled factory) drives a real
// Pi SDK runtime through a safe rotation, keeps the same Pi Episode and the
// Campaign Task/authorization, charges the ledger once, and the new Session
// loads the same Campaign gate.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c5-session-sdk.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";

import { buildC3FixtureManifest } from "../campaign/c3-entry.mjs";
import { runCampaignFromConfig } from "../campaign/c5-entry.mjs";
import { createCampaignActionGate } from "../campaign/campaign-mode.mjs";
import { validateManifest } from "../campaign/manifest.mjs";
import { projectState } from "../memory/state.mjs";
import { committedRotations } from "../session/session-supervisor.mjs";
import { verifyChain } from "../shared/events.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OBSERVER_PATH = join(BASE_DIR, "extensions", "aegis-observer.ts");

const base = mkdtempSync(join(tmpdir(), "aegis-c5-session-"));
let runtime;
let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}
function readEvents(path) {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}
function modelDetails(model) {
	return {
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
	};
}

try {
	const cwd = join(base, "cwd");
	const agentDir = join(base, "agent");
	const sessionDir = join(base, "sessions");
	const workspaceRoot = join(base, "workspace");
	const workDir = join(base, "run");
	const eventLogPath = join(workDir, "events.jsonl");
	for (const d of [cwd, agentDir, sessionDir, workspaceRoot, workDir]) mkdirSync(d, { recursive: true });

	const validated = validateManifest(buildC3FixtureManifest({ workspaceRoot }));
	assert.equal(validated.ok, true, validated.reasons?.join("; "));
	const manifestPath = join(base, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8");
	const configPath = join(base, "campaign.config.json");
	writeFileSync(
		configPath,
		`${JSON.stringify(
			{
				schema_version: "campaign-config-1.0",
				manifest_path: manifestPath,
				workspace_root: workspaceRoot,
				work_dir: workDir,
				mode: "auto",
				session: { session_count: 1, max_requests_per_session: 10 },
				observation: { enabled: false, port: 0 },
				oracle: { kind: "fixture" },
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_RAM_DIR: join(workDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
		AEGIS_TASK_ID: "task-c5-session",
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	mkdirSync(join(workDir, "runtime"), { recursive: true });

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-c5", name: "FauxC5" }] });
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: join(base, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, modelDetails(model));

	let creations = 0;
	// ONE gate object shared by the runtime (every session) and the Host.
	const gate = createCampaignActionGate();
	runtime = await createAgentSessionRuntime(
		async ({ cwd: sessionCwd, agentDir: sessionAgentDir, sessionManager, sessionStartEvent }) => {
			creations += 1;
			const services = await createAgentSessionServices({
				cwd: sessionCwd,
				agentDir: sessionAgentDir,
				modelRuntime,
				settingsManager: SettingsManager.inMemory({}),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [OBSERVER_PATH],
					// The SAME gate is loaded for the initial AND every rotated session.
					extensionFactories: [gate.extensionFactory],
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
				tools: ["aegis_switch_session", "write"],
			});
			return { ...created, services, diagnostics: services.diagnostics };
		},
		{ cwd, agentDir, sessionManager: SessionManager.create(cwd, sessionDir) },
	);
	async function bind() {
		const session = runtime.session;
		await session.bindExtensions({
			mode: "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: () => session.reload(),
			},
		});
	}
	runtime.setRebindSession(bind);
	await bind();

	// Open a Pi episode and stage a handoff via the real observer/SDK.
	faux.setResponses([() => fauxAssistantMessage("ready")]);
	await runtime.session.prompt("C5 campaign session continuity.");
	faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("aegis_switch_session", { reason: "settle boundary" })]),
		() => fauxAssistantMessage("staged"),
	]);
	await runtime.session.prompt("Please hand over to a fresh session.");
	const episodeId = Object.keys(projectState(readEvents(eventLogPath)).episodes)[0];
	check("a Pi episode was opened", typeof episodeId === "string", JSON.stringify(episodeId));

	let rotation = null;
	let ledgerAfter = null;
	const beforeSession = runtime.session;
	const createdBefore = creations;

	const outcome = await runCampaignFromConfig({
		configPath,
		scenario: "run",
		runtime,
		gate,
		beforeRun: async ({ host }) => {
			// The unified entry injected the C2 session controller; rotate once at
			// the safe boundary before dispatch.
			rotation = await host.rotateSession({ reason: "c5 settle rotation" });
			ledgerAfter = host.budgetLedger();
		},
		print: () => {},
	});

	check("the entry ran", outcome.ok === true, JSON.stringify(outcome.reasons));
	check("the entry really called the C2 supervisor", rotation?.applied === true, JSON.stringify(rotation));
	check("a genuinely NEW AgentSession was created", runtime.session !== beforeSession);
	check("exactly one new runtime session was created", creations === createdBefore + 1);
	check(
		"the rotation charged exactly one Session generation",
		rotation?.session_charges?.delta === 1,
		JSON.stringify(rotation?.session_charges),
	);

	const events = readEvents(eventLogPath);
	check(
		"Observer rotation and Campaign actions share one verified append chain",
		verifyChain(events).ok,
		JSON.stringify(verifyChain(events).errors),
	);
	const completions = events.filter((e) => e.event_type === "handoff.completed");
	check("handoff.completed was committed exactly once", completions.length === 1, `count=${completions.length}`);
	check("the same Pi episode survived", Object.keys(projectState(events).episodes).length === 1);
	check("the committed rotation is counted", committedRotations(events, episodeId) === 1);
	check(
		"the Host ledger charges one session",
		ledgerAfter?.consumed?.session_count === 1,
		JSON.stringify(ledgerAfter?.consumed),
	);
	check("the ledger names the single charge owner", ledgerAfter?.charge_owner === "campaign_host");

	// The ROTATED session loads the SAME gate: while Campaign mode is active a
	// direct write is blocked. Activate the gate, attempt a write in the NEW
	// session, and assert no file was produced.
	const deniedPath = join(workspaceRoot, "denied-after-rotation.txt");
	gate.activate();
	try {
		faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("write", { path: deniedPath, content: "effect" })]),
			() => fauxAssistantMessage("done"),
		]);
		await runtime.session.prompt("Try a direct write in the rotated session.");
	} finally {
		gate.deactivate();
	}
	check("the rotated Session blocks a direct write (same gate loaded)", !existsSync(deniedPath));
	check(
		"standalone SDK activity after Host return preserves the same verified chain",
		verifyChain(readEvents(eventLogPath)).ok,
	);
} finally {
	if (runtime) await runtime.dispose().catch?.(() => undefined);
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
	console.log(`c5 session sdk: ${failures} failure(s)`);
	process.exit(1);
}
console.log("c5 session sdk: all checks passed");
