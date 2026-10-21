// The system prefix must tell the model that the read-only lookups exist.
//
// Regression origin: a real CTF web session solved nothing and never called
// `aegis_toolbox` or `aegis_knowledge`, even though both were registered and
// described. Nothing in the prompt said looking things up is expected, so the
// model went straight to bash. The fix is one STABLE system section - constant
// text, because anything dynamic there would invalidate the prompt cache.
//
// Run with the source resolver:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-observer-tooling-hint.mjs
// aegis-resolver: required
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

const BASE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVER = join(BASE, "extensions", "aegis-observer.ts");
const ROM = join(BASE, "agent", "ROM.md");

function makeModelDetails(model) {
	return {
		baseUrl: model.baseUrl,
		api: model.api,
		apiKey: "faux-key",
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	};
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-tooling-hint-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	for (const dir of [agentDir, cwd, sessionDir]) mkdirSync(dir, { recursive: true });

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-hint", name: "FauxHint" }] });
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(base, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, makeModelDetails(model));

	process.env.AEGIS_EVENT_LOG = join(base, "events.jsonl");
	process.env.AEGIS_RAM_DIR = join(base, "ram");
	process.env.AEGIS_HANDOFF_FILE = join(base, "ram", "handoff.json");
	process.env.AEGIS_ROM_FILE = ROM;
	process.env.AEGIS_TASK_ID = "tooling-hint";
	process.env.AEGIS_CONTEST_CARDS = "";

	faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok again")]);

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [OBSERVER],
	});
	await loader.reload();
	const sessionManager = SessionManager.create(cwd, sessionDir);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		resourceLoader: loader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({}),
		tools: ["read"],
	});

	await session.prompt("solve the challenge");
	await new Promise((r) => setTimeout(r, 400));

	const transcript = () =>
		readdirSync(sessionDir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => readFileSync(join(sessionDir, name), "utf8"))
			.join("\n");
	const first = transcript();

	assert.equal(first.includes("aegis_tooling"), true, "the tooling section reaches the system prompt");
	assert.equal(first.includes("aegis_toolbox"), true, "it names the CLI toolbox");
	assert.equal(first.includes("aegis_knowledge"), true, "it names the retrieval refinement");
	assert.equal(first.includes("aegis_tools"), true, "it distinguishes the registered-action list");
	// It must stay documentation-only language: no promise of permission.
	assert.match(first, /not authorization|grants nothing/);
	assert.match(first, /unverified observation/);

	// Stability: a second request must carry the identical section, or the system
	// prefix cache would be invalidated on every turn.
	const sectionOf = (text) => {
		const start = text.indexOf("<aegis_tooling>");
		const end = text.indexOf("</aegis_tooling>");
		return start >= 0 && end > start ? text.slice(start, end) : null;
	};
	const before = sectionOf(first);
	await session.prompt("continue");
	await new Promise((r) => setTimeout(r, 400));
	const after = sectionOf(transcript());
	assert.equal(before !== null, true, "section is present");
	assert.equal(after, before, "the tooling section is byte-identical across requests");

	rmSync(base, { recursive: true, force: true });
	console.log("aegis-observer-tooling-hint ok");
}

await main();
