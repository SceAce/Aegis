// Actual provider context and callable seed path for every experiment condition.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { compileDocumentSeed } from "../memory/document-seed.mjs";
import { verifyChain } from "../shared/events.mjs";

const root = mkdtempSync(join(tmpdir(), "aegis-context-policy-sdk-"));
const envNames = [
	"AEGIS_EVENT_LOG",
	"AEGIS_TASK_ID",
	"AEGIS_RAM_DIR",
	"AEGIS_PROJECTION_DIR",
	"AEGIS_EXPERIENCE_DIR",
	"AEGIS_HANDOFF_FILE",
	"AEGIS_ROM_FILE",
	"AEGIS_KNOWLEDGE_DIR",
	"AEGIS_RAM_SEED_FILE",
	"AEGIS_TASK_CONTRACT_FILE",
	"AEGIS_MANIFEST_FILE",
	"AEGIS_SCRIPT_CONFIG",
	"AEGIS_REPLAY_ADAPTER",
	"AEGIS_BOARD_FEEDBACK",
	"AEGIS_KNOWLEDGE_ENABLED",
];
const previous = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
const faux = registerFauxProvider({ provider: "faux", models: [{ id: "policy-sdk", name: "Policy SDK" }] });
let session;
const messageText = (m) =>
	typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("\n");
function ram(messages) {
	const rows = messages.filter((m) => m.role === "user" && messageText(m).startsWith("<aegis_ram>\n"));
	assert.equal(rows.length, 1);
	return JSON.parse(
		messageText(rows[0])
			.replace(/^<aegis_ram>\n/, "")
			.replace(/\n<\/aegis_ram>$/, ""),
	);
}
try {
	const credentials = AuthStorage.inMemory(),
		model = faux.getModel();
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
	for (const board of [true, false])
		for (const knowledge of [true, false]) {
			const dir = join(root, `${board}-${knowledge}`);
			for (const name of ["workspace", "agent", "sessions", "knowledge"])
				mkdirSync(join(dir, name), { recursive: true });
			for (const key of envNames) process.env[key] = "";
			Object.assign(process.env, {
				AEGIS_EVENT_LOG: join(dir, "events.jsonl"),
				AEGIS_TASK_ID: "policy-sdk",
				AEGIS_RAM_DIR: join(dir, "ram"),
				AEGIS_PROJECTION_DIR: join(dir, "projections"),
				AEGIS_EXPERIENCE_DIR: join(dir, "experiences"),
				AEGIS_HANDOFF_FILE: join(dir, "handoff.json"),
				AEGIS_ROM_FILE: resolve("Pi_Agent_base/agent/ROM.md"),
				AEGIS_KNOWLEDGE_DIR: join(dir, "knowledge"),
				AEGIS_BOARD_FEEDBACK: board ? "on" : "off",
				AEGIS_KNOWLEDGE_ENABLED: knowledge ? "on" : "off",
			});
			writeFileSync(
				join(dir, "knowledge", "seed.json"),
				JSON.stringify(
					compileDocumentSeed({
						markdown: "# polynomial fixture\n\nKNOWLEDGE_POLICY_MARKER is bounded reference data.\n",
						source: { source_uri: "https://example.invalid", source_kind: "external_reference", approved: true },
					}),
				),
			);
			const services = await createAgentSessionServices({
				cwd: join(dir, "workspace"),
				agentDir: join(dir, "agent"),
				modelRuntime,
				settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noContextFiles: true,
					noThemes: true,
					noPromptTemplates: true,
					additionalExtensionPaths: [resolve("Pi_Agent_base/extensions/aegis-observer.ts")],
				},
			});
			({ session } = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.create(join(dir, "workspace"), join(dir, "sessions")),
				model,
				tools: ["aegis_propose", "aegis_knowledge"],
			}));
			assert.deepEqual(services.diagnostics?.extensions?.errors ?? [], []);
			await session.bindExtensions({ mode: "print" });
			let calls = 0;
			faux.setResponses([
				(context) => {
					calls++;
					assert.equal(JSON.stringify(ram(context.messages)).includes("KNOWLEDGE_POLICY_MARKER"), knowledge);
					return fauxAssistantMessage([fauxToolCall("aegis_propose", { kind: "claim", text: "BOARD_POLICY_MARKER" })]);
				},
				(context) => {
					calls++;
					const r = ram(context.messages);
					assert.equal(JSON.stringify(r).includes("BOARD_POLICY_MARKER"), board);
					return fauxAssistantMessage([
						fauxToolCall("aegis_knowledge", { query: "polynomial fixture", max_results: 1 }),
					]);
				},
				(context) => {
					calls++;
					const result = context.messages.findLast((m) => m.role === "toolResult" && m.toolName === "aegis_knowledge");
					assert.equal(messageText(result).includes("knowledge_disabled"), !knowledge);
					return fauxAssistantMessage("Observed only.");
				},
			]);
			await session.prompt("Inspect polynomial fixture.");
			assert.equal(calls, 3);
			await session.dispose();
			session = null;
			const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
			assert.equal(verifyChain(events).ok, true);
			assert.ok(
				events.some((e) => e.event_type === "proposal.submitted"),
				"board-off retains source audit",
			);
			assert.ok(
				events
					.filter((e) => e.event_type === "request.projected")
					.every((e) => e.payload.context_policy.board === board && e.payload.context_policy.knowledge === knowledge),
			);
		}
	console.log(
		"Context policy SDK: all four actual provider conditions, disabled knowledge tool, retained audit and per-request policy passed",
	);
} finally {
	await session?.dispose();
	faux.unregister();
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
}
