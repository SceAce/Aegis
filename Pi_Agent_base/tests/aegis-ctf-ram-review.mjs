// Independent reproduction of CTF RAM feedback. No real provider or target.
// CR-01 is repaired by the RAM transport change; CR-02 remains a separate detail gap.
// Run with the embedded Pi source resolver, as documented in the review.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { projectBoard } from "../memory/runtime/board.mjs";
import { digest, verifyChain } from "../memory/runtime/events.mjs";
import { buildRam } from "../memory/runtime/ram.mjs";
import { projectState } from "../memory/runtime/state.mjs";

const baseDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Effective structured system sections in a provider-bound message list. */
function sectionsOf(messages) {
	const sections = {};
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const [key, value] of Object.entries(message.sections ?? {})) {
			if (value === null) delete sections[key];
			else sections[key] = value;
		}
	}
	return sections;
}

function ramContextOf(messages) {
	// Pi converts custom context messages to user messages before the provider.
	const ramMessages = messages.filter(
		(message) => message.role === "user" && messageText(message).startsWith("<aegis_ram>\n"),
	);
	if (ramMessages.length !== 1) throw new Error(`expected one provider-bound RAM message, got ${ramMessages.length}`);
	return messageText(ramMessages[0]);
}

function messageText(message) {
	return typeof message.content === "string"
		? message.content
		: (message.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
}

async function main() {
	const root = mkdtempSync(join(tmpdir(), "aegis-ctf-ram-review-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	for (const dir of [cwd, agentDir, sessionDir]) mkdirSync(dir);
	const eventLog = join(root, "events.jsonl");
	const marker = "response_marker_94721";
	writeFileSync(join(cwd, "probe.txt"), `field=user_id\nobserved=${marker}\n`);
	const environment = {
		AEGIS_EVENT_LOG: eventLog,
		AEGIS_RAM_DIR: join(root, "ram"),
		AEGIS_HANDOFF_FILE: join(root, "ram", "handoff.json"),
		AEGIS_PROJECTION_DIR: join(root, "projections"),
		AEGIS_EXPERIENCE_DIR: join(root, "experiences"),
		AEGIS_ROM_FILE: join(baseDir, "agent", "ROM.md"),
		AEGIS_TASK_ID: "ctf-ram-review",
		AEGIS_MANIFEST_FILE: "",
		AEGIS_SCRIPT_CONFIG: "",
		AEGIS_REPLAY_ADAPTER: "",
	};
	const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
	Object.assign(process.env, environment);
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "ctf-ram-review", name: "CTF RAM review" }],
	});
	let session;
	let failures = 0;
	function check(id, assertion) {
		try {
			assertion();
			console.log(`ok - ${id}`);
		} catch (error) {
			failures += 1;
			console.error(`not ok - ${id}: ${error.message}`);
		}
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
			models: [{ ...model }],
		});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [join(baseDir, "extensions", "aegis-observer.ts")],
		});
		await loader.reload();
		assert.equal(loader.getExtensions().errors.length, 0, "observer must actually load");
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.create(cwd, sessionDir),
			settingsManager: SettingsManager.inMemory({}),
			tools: ["read"],
		}));
		await session.bindExtensions({});
		const requests = [];
		faux.setResponses([
			(context) => {
				requests.push(structuredClone(context.messages));
				return fauxAssistantMessage([fauxToolCall("read", { path: "probe.txt" })]);
			},
			(context) => {
				requests.push(structuredClone(context.messages));
				return fauxAssistantMessage("Observation received; external verification is still absent.");
			},
		]);
		await session.prompt("Inspect the task input using read; keep observed data separate from verified success.");
		assert.equal(requests.length, 2, "must exercise a real tool continuation");
		const events = readFileSync(eventLog, "utf8").trim().split("\n").map(JSON.parse);
		const episodeId = events.find((event) => event.event_type === "episode.started").episode_id;
		const board = projectBoard(events);
		const state = projectState(events);
		const first = sectionsOf(requests[0]);
		const second = sectionsOf(requests[1]);
		const firstRam = ramContextOf(requests[0]);
		const secondRam = ramContextOf(requests[1]);
		const projected = events.filter((event) => event.event_type === "request.projected");
		const ram = buildRam({ board, state, episodeId });

		check("CR-01 RAM refresh preserves system message bytes", () => {
			const systemContent = (messages) =>
				messages.filter((message) => message.role === "system").map(({ content, sections }) => ({ content, sections }));
			assert.ok(
				JSON.stringify(systemContent(requests[0])) === JSON.stringify(systemContent(requests[1])),
				"system content changes after a normal read",
			);
		});
		check("CR-02 RAM retains actual input and response detail", () => {
			assert.ok(
				events.some((event) => event.payload?.input?.path === "probe.txt"),
				"input must first exist in the log",
			);
			assert.ok(
				events.some((event) => event.payload?.content_excerpt?.includes(marker)),
				"real response must first exist in the log",
			);
			assert.ok(
				ram.includes("probe.txt") && ram.includes(marker),
				"RAM loses the recorded input path and observed response marker",
			);
		});
		check("CR-03 real response reaches continuation", () => {
			assert.ok(
				requests[1].some(
					(message) => message.role === "toolResult" && JSON.stringify(message.content).includes(marker),
				),
			);
		});
		check("CR-04 tool completion does not declare verified success", () => {
			assert.equal(board.byType.Fact.length, 0);
			assert.equal(events.filter((event) => event.event_type === "outcome.recorded").length, 0);
		});
		check("CR-05 request RAM matches audited bytes without state recursion", () => {
			assert.equal(verifyChain(events).ok, true);
			assert.equal(projected.length, requests.length);
			const inner = (value) =>
				String(value)
					.replace(/^<aegis_ram>\n/, "")
					.replace(/\n<\/aegis_ram>$/, "");
			assert.equal(first.aegis_ram, undefined, "dynamic RAM must not be stored in the system prefix");
			assert.equal(second.aegis_ram, undefined, "dynamic RAM must not be stored in the system prefix");
			assert.equal(projected[0].payload.ram_digest, digest(inner(firstRam)));
			assert.equal(projected[1].payload.ram_digest, digest(inner(secondRam)));
			assert.notEqual(firstRam, secondRam);
			assert.equal(
				projectState(events.filter((event) => event.event_type !== "request.projected")).version,
				state.version,
			);
		});
		check("CR-06 foreign Episode data stays out of current RAM", () => {
			const foreign = buildRam({ board, state, episodeId: "foreign-episode" });
			assert.ok(!foreign.includes(marker));
			assert.ok(!foreign.includes("probe.txt"));
			assert.ok(!foreign.includes(events.find((event) => event.event_type === "action.requested").payload.action_id));
		});
		console.log(`CTF RAM review: ${6 - failures} pass / ${failures} fail`);
		if (failures > 0) process.exitCode = 1;
	} finally {
		session?.dispose();
		faux.unregister();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(`CTF RAM review failed to run: ${error.stack ?? error}`);
	process.exitCode = 1;
});
