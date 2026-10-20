// Real Pi SDK + faux provider: a mandatory RAM overflow must abort before provider I/O.
// No credentials, network, or target access.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { EventLog } from "../shared/events.mjs";

const base = resolve("Pi_Agent_base");
const root = mkdtempSync(join(tmpdir(), "aegis-ram-overflow-pi-"));
const cwd = join(root, "workspace");
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
const eventLogPath = join(root, "events.jsonl");
for (const dir of [cwd, agentDir, sessionDir]) mkdirSync(dir);
const episodeId = "ep-overflow";
const taskId = "task-overflow";
const env = {
	AEGIS_EVENT_LOG: eventLogPath,
	AEGIS_RAM_DIR: join(root, "ram"),
	AEGIS_HANDOFF_FILE: join(root, "ram", "handoff.json"),
	AEGIS_ROM_FILE: join(base, "agent", "ROM.md"),
	AEGIS_TASK_ID: taskId,
};
const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);

let session;
let fetches = 0;
try {
	const log = new EventLog(eventLogPath);
	assert.equal((await log.open()).ok, true);
	const started = await log.append({
		event_type: "episode.started",
		episode_id: episodeId,
		source: { actor_id: "overflow-fixture", kind: "runtime", adapter: "offline", version: "1" },
		payload: {
			task_id: taskId,
			goal: { description: "preserve the current task while RAM overflows" },
			authorization: { allowed: ["read"] },
			budget: { model_requests: 1 },
		},
	});
	assert.equal(started.ok, true);
	for (let index = 0; index < 700; index += 1) {
		const action = await log.append({
			event_type: "action.requested",
			episode_id: episodeId,
			source: { actor_id: "overflow-fixture", kind: "runtime", adapter: "offline", version: "1" },
			payload: {
				action_id: `pending-${index}-${"x".repeat(24)}`,
				tool_name: "read",
				input: { path: `unresolved-target-${index}-${"y".repeat(24)}.txt` },
			},
		});
		assert.equal(action.ok, true);
	}
	await log.close();

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "overflow", name: "RAM overflow" }] });
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "offline" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: join(root, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		apiKey: "offline",
		models: [model],
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [join(base, "extensions", "aegis-observer.ts")],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		fetches += 1;
		return new Response("unexpected provider call", { status: 200 });
	};
	try {
		const created = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.create(cwd, sessionDir),
			settingsManager: SettingsManager.inMemory({}),
			tools: ["read"],
		});
		session = created.session;
		await session.bindExtensions({});
		faux.setResponses([() => fauxAssistantMessage("must not reach provider")]);
		await session.prompt("Continue the task.").catch(() => undefined);
	} finally {
		globalThis.fetch = originalFetch;
	}

	const events = readFileSync(eventLogPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const projections = events.filter((event) => event.event_type === "request.projected");
	assert.equal(fetches, 0, "RAM overflow must stop before provider I/O");
	assert.equal(projections.length, 1);
	assert.equal(projections[0].payload.provider_bound, false);
	assert.equal(projections[0].payload.refusal_reason, "ram_overflow");
	assert.equal(projections[0].payload.ram_overflow, true);
	console.log("aegis-observer-ram-overflow-pi ok");
} finally {
	session?.dispose();
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
}
