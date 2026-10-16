// Real SDK + faux provider. No credentials, network or personal knowledge files.
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
import { projectBoard } from "../memory/board.mjs";
import { compileDocumentSeed } from "../memory/document-seed.mjs";
import { projectState } from "../memory/state.mjs";
import { verifyChain } from "../shared/events.mjs";

const root = mkdtempSync(join(tmpdir(), "aegis-knowledge-sdk-"));
const cwd = join(root, "workspace"),
	agentDir = join(root, "agent"),
	sessions = join(root, "sessions"),
	knowledge = join(root, "knowledge");
for (const dir of [cwd, agentDir, sessions, knowledge]) mkdirSync(dir);
const env = {
	AEGIS_EVENT_LOG: join(root, "events.jsonl"),
	AEGIS_RAM_DIR: join(root, "ram"),
	AEGIS_PROJECTION_DIR: join(root, "projections"),
	AEGIS_EXPERIENCE_DIR: join(root, "experiences"),
	AEGIS_TASK_ID: "knowledge-sdk",
	AEGIS_KNOWLEDGE_DIR: knowledge,
	AEGIS_RAM_SEED_FILE: "",
	AEGIS_TASK_CONTRACT_FILE: "",
	AEGIS_MANIFEST_FILE: "",
	AEGIS_SCRIPT_CONFIG: "",
	AEGIS_REPLAY_ADAPTER: "",
	AEGIS_HANDOFF_FILE: join(root, "handoff.json"),
	AEGIS_ROM_FILE: resolve("Pi_Agent_base/agent/ROM.md"),
};
const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);
const seed = compileDocumentSeed({
	markdown:
		"# Nullbyte boundary\n\nKNOWLEDGE_AUTO_624 observe a nullbyte boundary before considering a parser hypothesis.\n\n# Offset encoding\n\nKNOWLEDGE_REFINED_624 offset encoding requires a separately observed constraint.\n",
	source: { source_kind: "external_reference", source_uri: "https://example.invalid/reference", approved: true },
});
writeFileSync(join(knowledge, "reference.json"), JSON.stringify(seed));
const faux = registerFauxProvider({
	provider: "faux",
	models: [{ id: "knowledge-sdk", name: "Knowledge SDK offline" }],
});
let session;
const rows = () => readFileSync(env.AEGIS_EVENT_LOG, "utf8").trim().split("\n").map(JSON.parse);
const messageText = (message) =>
	typeof message.content === "string" ? message.content : (message.content ?? []).map((p) => p.text ?? "").join("\n");
function ram(messages) {
	const rams = messages.filter(
		(message) => message.role === "user" && messageText(message).startsWith("<aegis_ram>\n"),
	);
	assert.equal(rams.length, 1);
	return JSON.parse(
		messageText(rams[0])
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
	async function create() {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
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
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(cwd, sessions),
			model,
			tools: ["aegis_knowledge", "aegis_propose"],
		});
		assert.deepEqual(services.diagnostics?.extensions?.errors ?? [], []);
		session = created.session;
		await session.bindExtensions({ mode: "print" });
	}
	await create();
	let requests = 0;
	const systems = [];
	faux.setResponses([
		(context) => {
			requests++;
			systems.push(context.messages.filter((m) => m.role === "system"));
			const first = ram(context.messages);
			assert.ok(
				JSON.stringify(first.sections.knowledge).includes("KNOWLEDGE_AUTO_624"),
				"user-message recall reaches the first real provider request",
			);
			return fauxAssistantMessage([fauxToolCall("aegis_knowledge", { query: "offset encoding", max_results: 1 })]);
		},
		(context) => {
			requests++;
			systems.push(context.messages.filter((m) => m.role === "system"));
			const next = ram(context.messages);
			assert.ok(
				JSON.stringify(next.sections.knowledge).includes("KNOWLEDGE_REFINED_624"),
				"model query replaces selection in the very next RAM",
			);
			assert.equal(next.sections.knowledge.items[0].verified, false);
			assert.equal(next.sections.facts.shown, 0);
			const selection = rows().findLast((r) => r.payload?.kind === "knowledge.selected");
			return fauxAssistantMessage([
				fauxToolCall("aegis_propose", {
					kind: "candidate",
					text: "Parser hypothesis",
					when: ["offset constrained"],
					do: "inspect existing encoding",
					expect: "observable parser distinction",
					source_refs: [{ ref_type: "event", ref_id: selection.event_id }],
				}),
			]);
		},
		(context) => {
			requests++;
			systems.push(context.messages.filter((m) => m.role === "system"));
			const next = ram(context.messages);
			assert.ok(
				JSON.stringify(next.sections.proposals).includes("observable parser distinction"),
				"candidate conditions/procedure/verification survive projection",
			);
			return fauxAssistantMessage("A candidate only, awaiting observation.");
		},
	]);
	await session.prompt("Examine the nullbyte boundary in the supplied artifact.");
	assert.equal(requests, 3);
	assert.deepEqual(systems[0], systems[1]);
	assert.deepEqual(systems[1], systems[2]);
	assert.ok(!JSON.stringify(session.messages).includes("aegis_ram_context"));
	const before = rows();
	assert.equal(verifyChain(before).ok, true);
	const selected = before.filter((row) => row.payload?.kind === "knowledge.selected");
	assert.equal(selected.length, 2);
	assert.equal(selected[1].payload.mode, "model_query");
	const board = projectBoard(before),
		candidate = board.byType.Hint.find((n) => n.text === "Parser hypothesis");
	assert.ok(
		board.edges.some(
			(edge) =>
				edge.from === candidate.node_id && edge.to === `ev:${selected[1].event_id}` && edge.relation === "references",
		),
	);
	assert.equal(board.byType.Fact.length, 0);
	assert.equal(projectState(before).knowledge_selections[0].content.includes("KNOWLEDGE_REFINED_624"), true);
	await session.dispose();
	session = null;
	await create();
	faux.setResponses([
		(context) => {
			requests++;
			assert.ok(
				JSON.stringify(ram(context.messages).sections.proposals).includes("Parser hypothesis"),
				"new session recovers same Episode candidate from events",
			);
			assert.ok(JSON.stringify(ram(context.messages).sections.knowledge).includes("KNOWLEDGE_REFINED_624"));
			return fauxAssistantMessage("Recovered same task without declaring success.");
		},
	]);
	await session.prompt("Continue checking offset encoding.");
	assert.equal(requests, 4);
	assert.equal(rows().filter((row) => row.event_type === "episode.started").length, 1);
	assert.equal(verifyChain(rows()).ok, true);
	assert.equal(rows().filter((row) => row.event_type === "outcome.recorded").length, 0);
	console.log(
		"Knowledge SDK: automatic recall, model refinement, next-request RAM, graph associations and new-session recovery passed",
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
