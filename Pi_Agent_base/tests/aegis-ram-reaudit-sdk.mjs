// Real SDK + faux provider: acquisition gaps and actual Session replacement.
// No real provider/target, credentials or user runtime logs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
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
import { applyStagedHandoff } from "../session/handoff-host.mjs";
import { verifyChain } from "../shared/events.mjs";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "aegis-ram-reaudit-sdk-"));
const cwd = join(root, "workspace");
const agentDir = join(root, "agent");
const sessionDir = join(root, "sessions");
for (const path of [cwd, agentDir, sessionDir]) mkdirSync(path);
const fileMarker = "READ_DETAIL_MUST_SURVIVE_ROTATION_917";
const inputMarker = "INPUT_PARAMETER_VALUE_917";
const structuredMarker = "STRUCTURED_RETURN_VALUE_917";
writeFileSync(join(cwd, "probe.txt"), fileMarker);
const environment = {
	AEGIS_EVENT_LOG: join(root, "events.jsonl"),
	AEGIS_RAM_DIR: join(root, "ram"),
	AEGIS_HANDOFF_FILE: join(root, "ram", "handoff.json"),
	AEGIS_PROJECTION_DIR: join(root, "projections"),
	AEGIS_EXPERIENCE_DIR: join(root, "experiences"),
	AEGIS_ROM_FILE: join(base, "agent", "ROM.md"),
	AEGIS_TASK_ID: "ram-reaudit-sdk",
	AEGIS_MANIFEST_FILE: "",
	AEGIS_SCRIPT_CONFIG: "",
	AEGIS_REPLAY_ADAPTER: "",
};
const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
const faux = registerFauxProvider({ provider: "faux", models: [{ id: "ram-reaudit-sdk", name: "RAM reaudit SDK" }] });
let runtime;
let passed = 0;
let failed = 0;
function check(id, run) {
	try {
		run();
		passed++;
		console.log(`ok - ${id}`);
	} catch (error) {
		failed++;
		console.error(`not ok - ${id}: ${error.message}`);
	}
}
function messageText(message) {
	return typeof message.content === "string"
		? message.content
		: (message.content ?? []).map((part) => part.text ?? "").join("\n");
}
function ramText(messages) {
	const rams = messages.filter(
		(message) => message.role === "user" && messageText(message).startsWith("<aegis_ram>\n"),
	);
	assert.equal(rams.length, 1);
	return messageText(rams[0]);
}
try {
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: join(root, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		apiKey: "faux-key",
		models: [model],
	});
	const probe = {
		name: "audit_probe",
		label: "Offline audit probe",
		description: "Return deterministic local data for an audit; no network or mutation.",
		parameters: Type.Object({ url: Type.String(), parameter: Type.String(), value: Type.String() }),
		async execute() {
			return {
				content: [{ type: "text", text: "LOCAL_PROBE_COMPLETED" }],
				details: { field: "user_id", observed: structuredMarker },
			};
		},
	};
	runtime = await createAgentSessionRuntime(
		async ({ cwd: nextCwd, agentDir: nextAgentDir, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd: nextCwd,
				agentDir: nextAgentDir,
				modelRuntime,
				settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [join(base, "extensions", "aegis-observer.ts")],
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
				tools: ["read", "audit_probe", "aegis_switch_session"],
				customTools: [probe],
			});
			assert.deepEqual(services.diagnostics?.extensions?.errors ?? [], []);
			return { ...created, services, diagnostics: services.diagnostics };
		},
		{ cwd, agentDir, sessionManager: SessionManager.create(cwd, sessionDir) },
	);
	const bind = async () => {
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
	};
	runtime.setRebindSession(bind);
	await bind();
	const requests = [];
	const respond = (response) => (context) => {
		requests.push(structuredClone(context.messages));
		return response;
	};
	faux.setResponses([
		respond(
			fauxAssistantMessage([
				fauxToolCall("audit_probe", { url: "https://offline.invalid/probe", parameter: "user_id", value: inputMarker }),
			]),
		),
		respond(fauxAssistantMessage([fauxToolCall("read", { path: "probe.txt" })])),
		respond(
			fauxAssistantMessage([
				fauxToolCall("aegis_switch_session", { reason: "carry observations to the next session" }),
			]),
		),
		respond(fauxAssistantMessage("Observations obtained; no task verdict.")),
	]);
	await runtime.session.prompt(
		"Run the local probe, read probe.txt, then request a handoff. Keep observed data separate from task success.",
	);
	assert.equal(requests.length, 4);
	let events = readFileSync(environment.AEGIS_EVENT_LOG, "utf8").trim().split("\n").map(JSON.parse);
	assert.equal(verifyChain(events).ok, true);
	const requested = events.find(
		(event) => event.event_type === "action.requested" && event.payload.tool_name === "audit_probe",
	);
	const completed = events.find(
		(event) => event.event_type === "action.completed" && event.payload.tool_name === "audit_probe",
	);
	assert.ok(requested && completed, "real tool hooks must execute");
	check("RS-01 structured input values are retained before projection", () => {
		assert.ok(
			JSON.stringify(requested.payload.input).includes(inputMarker),
			"only argument names and an irreversible digest survive",
		);
	});
	check("RS-02 structured output values are retained before projection", () => {
		assert.ok(JSON.stringify(completed.payload).includes(structuredMarker), "tool details retain keys but lose values");
	});
	check("RS-03 actual read result reaches the original session continuation", () => {
		assert.ok(
			requests[2].some((message) => message.role === "toolResult" && messageText(message).includes(fileMarker)),
		);
	});
	const oldSession = runtime.session;
	faux.setResponses([respond(fauxAssistantMessage("Continued after the real session replacement."))]);
	const result = await applyStagedHandoff({
		eventLogPath: environment.AEGIS_EVENT_LOG,
		handoffPath: environment.AEGIS_HANDOFF_FILE,
		runtime,
		taskId: environment.AEGIS_TASK_ID,
	});
	assert.equal(result.applied, true, result.reason);
	assert.notEqual(runtime.session, oldSession);
	assert.equal(requests.length, 5);
	check("RS-04 read details survive actual session replacement in RAM", () => {
		const next = requests.at(-1);
		assert.ok(
			!next.some((message) => message.role === "toolResult" && messageText(message).includes(fileMarker)),
			"new Session must have a fresh transcript",
		);
		assert.ok(
			ramText(next).includes("probe.txt") && ramText(next).includes(fileMarker),
			"new Session loses the observed path and response despite durable log retention",
		);
	});
	events = readFileSync(environment.AEGIS_EVENT_LOG, "utf8").trim().split("\n").map(JSON.parse);
	check("RS-05 replacement keeps one Episode, one committed handoff and no false Outcome", () => {
		assert.equal(verifyChain(events).ok, true);
		assert.equal(events.filter((event) => event.event_type === "episode.started").length, 1);
		assert.equal(events.filter((event) => event.event_type === "handoff.completed").length, 1);
		assert.equal(events.filter((event) => event.event_type === "outcome.recorded").length, 0);
	});
	console.log(`RAM SDK reaudit: ${passed} pass / ${failed} fail; ${requests.length} faux requests`);
	if (failed) process.exitCode = 1;
} finally {
	await runtime?.dispose();
	faux.unregister();
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
}
