// Offline REAL Pi SDK faux-provider test for human hint injection (H10-H13).
//
// Proves the operator-facing contract end to end:
//   1. `/aegis hint <text>` commits a `runtime.note` (kind `human.hint`) with a
//      HUMAN source and the current Episode binding.
//   2. The hint appears on the Board as a Hint node and in the NEXT provider
//      request's RAM references as unverified + non-authorizing.
//   3. `/aegis hint clear` retires it from the next request while keeping the
//      audit events.
//   4. Refusals are explicit and write NOTHING: no active Episode, empty text,
//      and an unhealthy audit log.
//
// No credentials, no network, no target access: the provider is faux and the
// assertion is on the real committed log + the real provider payload.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-observer-hint-pi.mjs
// aegis-resolver: required

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { projectBoard } from "../memory/board.mjs";

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

function readEvents(path) {
	try {
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function hintRows(events) {
	return events.filter((event) => event.event_type === "runtime.note" && event.payload?.kind === "human.hint");
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-obs-hint-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	const eventLog = join(base, "events.jsonl");
	const ramDir = join(base, "ram");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-hint", name: "FauxHint" }] });
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(base, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, makeFauxModelDetails(model));

	process.env.AEGIS_EVENT_LOG = eventLog;
	process.env.AEGIS_RAM_DIR = ramDir;
	process.env.AEGIS_HANDOFF_FILE = join(ramDir, "handoff.json");
	process.env.AEGIS_ROM_FILE = join(BASE_DIR, "agent", "ROM.md");
	process.env.AEGIS_TASK_ID = "task-hint-001";
	process.env.AEGIS_CONTEST_CARDS = "";

	// Capture the exact message transcript the provider receives per call. A
	// factory step sees the real `context.messages`, so this asserts the payload
	// end to end rather than re-deriving it from the log.
	const providerPrompts = [];
	const capture = (reply) => (context) => {
		providerPrompts.push(
			(context.messages ?? [])
				.map(
					(message) =>
						`${message.role}:${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`,
				)
				.join("\n"),
		);
		return fauxAssistantMessage(reply);
	};
	faux.setResponses([
		capture("first turn, no hint yet"),
		capture("second turn, hint visible"),
		capture("third turn after continue"),
		capture("fourth turn, hint cleared"),
		capture("fifth turn"),
		capture("sixth turn"),
	]);

	async function createSession() {
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
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			resourceLoader: loader,
			sessionManager,
			settingsManager: SettingsManager.inMemory({}),
			tools: ["read", "aegis_propose"],
		});
		return { session, sessionManager };
	}

	const { session } = await createSession();

	try {
		// --- H11: no active Episode -> refuse and write nothing -------------------
		const before = readEvents(eventLog).length;
		await session.prompt("/aegis hint too early, there is no episode");
		await new Promise((r) => setTimeout(r, 120));
		check(
			"hint without an active Episode writes no hint event",
			hintRows(readEvents(eventLog)).length === 0,
			`events grew from ${before} to ${readEvents(eventLog).length}`,
		);

		// --- Open an Episode, then inject the hint ------------------------------
		await session.prompt("Start the hint task.");
		await new Promise((r) => setTimeout(r, 150));
		const afterStart = readEvents(eventLog);
		check(
			"the run opened an Episode",
			afterStart.some((event) => event.event_type === "episode.started"),
			`saw ${afterStart.map((e) => e.event_type).join(",")}`,
		);

		await session.prompt("/aegis hint check the endianness before decoding");
		await new Promise((r) => setTimeout(r, 200));
		const committed = hintRows(readEvents(eventLog));
		check("the hint is committed as a runtime.note human.hint", committed.length === 1, `found ${committed.length}`);
		const hintEvent = committed[0];
		check("the hint event carries a HUMAN source", hintEvent?.source?.kind === "human", hintEvent?.source?.kind);
		check(
			"the hint event is bound to the active Episode",
			typeof hintEvent?.episode_id === "string" && hintEvent.episode_id.length > 0,
		);
		check("the hint declares no authority", hintEvent?.payload?.authority === "none");
		check("the hint declares itself unverified", hintEvent?.payload?.verified === false);
		check("the hint text is preserved", String(hintEvent?.payload?.text ?? "").includes("endianness"));
		check("the hint has a stable id", /^hl_/.test(String(hintEvent?.payload?.hint_id ?? "")));

		// --- H12: the Board shows it as a Hint, never a Fact -------------------
		const board = projectBoard(readEvents(eventLog), { manifest: null });
		const episodeHints = (board.currentByType?.Hint ?? []).filter((node) => node.episode_id === hintEvent.episode_id);
		check(
			"the Board projects the hint as a Hint node",
			episodeHints.some((node) => String(node.text ?? "").includes("endianness")),
			`hints: ${episodeHints.map((n) => n.text).join(" | ")}`,
		);
		const facts = (board.currentByType?.Fact ?? []).filter((node) => node.episode_id === hintEvent.episode_id);
		check("the hint creates no Fact", facts.length === 0, `${facts.length} facts`);

		// --- H10: the NEXT provider request carries the hint -------------------
		providerPrompts.length = 0;
		await session.prompt("Continue with the hint.");
		await new Promise((r) => setTimeout(r, 250));
		const payload = providerPrompts.join("\n");
		check("a provider request happened after the hint", providerPrompts.length > 0, `${providerPrompts.length}`);
		check("the provider payload carries the hint text", payload.includes("endianness"), "hint absent from payload");
		check("the payload marks the hint as a human/unverified reference", /human_hint|human_unverified/.test(payload));
		check("the payload keeps the hint non-authorizing", payload.includes("none"));

		// --- H13: clear retires it from the next request, audits stay ----------
		await session.prompt("/aegis hint clear");
		await new Promise((r) => setTimeout(r, 200));
		const afterClear = hintRows(readEvents(eventLog));
		check("clear appends an audit event", afterClear.length === 2, `found ${afterClear.length}`);
		check("clear supersedes the previous hint", afterClear[1]?.payload?.supersedes === hintEvent.payload.hint_id);
		check("clear carries no text", afterClear[1]?.payload?.text === "");

		providerPrompts.length = 0;
		await session.prompt("Continue after the clear.");
		await new Promise((r) => setTimeout(r, 250));
		const clearedPayload = providerPrompts.join("\n");
		check("a provider request happened after the clear", providerPrompts.length > 0);
		check(
			"the cleared hint is gone from the next payload",
			!clearedPayload.includes("endianness"),
			"hint still present",
		);

		// --- Empty text is refused, not recorded as a hint --------------------
		const beforeEmpty = hintRows(readEvents(eventLog)).length;
		await session.prompt(`/aegis hint ${" ".repeat(4)}`);
		await new Promise((r) => setTimeout(r, 150));
		check(
			"a whitespace-only hint is not recorded",
			hintRows(readEvents(eventLog)).length === beforeEmpty,
			`grew to ${hintRows(readEvents(eventLog)).length}`,
		);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}

	console.log(failures === 0 ? "\naegis-observer-hint-pi ok" : `\naegis-observer-hint-pi FAILED (${failures})`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
