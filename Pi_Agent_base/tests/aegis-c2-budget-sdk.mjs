#!/usr/bin/env node
// Limited C2 budget acceptance at the actual Pi SDK + Observer product entry.
// node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c2-budget-sdk.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
import { createSessionSupervisor } from "../memory/runtime/session-supervisor.mjs";

const base = await mkdtemp(join(tmpdir(), "aegis-c2-budget-sdk-"));
let runtime;
try {
	const cwd = join(base, "cwd"),
		agentDir = join(base, "agent"),
		sessionDir = join(base, "sessions");
	for (const dir of [cwd, agentDir, sessionDir]) await mkdir(dir, { recursive: true });
	const eventLogPath = join(base, "events.jsonl"),
		handoffPath = join(base, "ram", "handoff.json");
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_RAM_DIR: join(base, "ram"),
		AEGIS_HANDOFF_FILE: handoffPath,
		AEGIS_TASK_ID: "task-c2-budget-sdk",
		AEGIS_ROM_FILE: fileURLToPath(new URL("../agent/ROM.md", import.meta.url)),
	});
	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-c2-budget", name: "C2 Budget" }] });
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
	let creations = 0;
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
					additionalExtensionPaths: [fileURLToPath(new URL("../extensions/aegis-observer.ts", import.meta.url))],
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
				tools: ["aegis_switch_session"],
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
	faux.setResponses([() => fauxAssistantMessage("ready")]);
	await runtime.session.prompt("Observe the authorized local task.");
	const budget = { limit: { session_count: 2 }, consumed: { session_count: 1 } };
	function supervisor() {
		return createSessionSupervisor({ eventLogPath, handoffPath, runtime, taskId: process.env.AEGIS_TASK_ID, budget });
	}
	async function stage() {
		faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("aegis_switch_session", { reason: "automatic settle boundary" })]),
			() => fauxAssistantMessage("staged"),
		]);
		await runtime.session.prompt("Request a fresh short Session.");
	}
	await stage();
	if (process.argv[2] === "bind-failure") {
		// Real Host rebind path initializes extensions, then fails before the
		// overall bind operation succeeds. Completion must not precede it.
		runtime.setRebindSession(async () => {
			await bind();
			throw new Error("external injected Host bind failure");
		});
		const failed = await supervisor().rotate();
		assert.equal(failed.applied, false, "Host bind failure must be reported");
		const completed = (await readFile(eventLogPath, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse)
			.filter((e) => e.event_type === "handoff.completed");
		assert.equal(completed.length, 0, "handoff completion must not be committed before Host bind succeeds");
		console.log("C2 real SDK bind failure: pass");
	} else {
		faux.setResponses([() => fauxAssistantMessage("continued")]);
		const first = await supervisor().rotate();
		assert.equal(first.applied, true, "funded real SDK rotation succeeds");
		assert.equal(first.budget_after.remaining.session_count, 0);
		const before = runtime.session;
		const createdBefore = creations;
		const completedBefore = (await readFile(eventLogPath, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse)
			.filter((e) => e.event_type === "handoff.completed").length;
		assert.equal(completedBefore, 1);
		await stage();
		faux.setResponses([() => fauxAssistantMessage("unexpected second rotation")]);
		const second = await supervisor().rotate();
		assert.equal(second.applied, false, "committed last-session use must block another real SDK creation");
		assert.equal(runtime.session, before);
		assert.equal(creations, createdBefore);
		console.log("C2 real SDK cumulative budget: pass");
	}
} finally {
	if (runtime) await runtime.dispose();
	await rm(base, { recursive: true, force: true });
}
