// Offline REAL Pi SDK faux-provider combination test: Aegis Observer + contest.
//
// This is the vertical-slice regression required by docs/IMPLEMENTATION_TASK.md
// and docs/IMPLEMENTATION_AUDIT.md. It boots a REAL Pi agent session (faux
// provider, no network, no real model) with BOTH extensions loaded together and
// asserts on the actual model-bound request and the actual event log:
//
//   1. Observer ROM + Observer RAM + contest hint section compose in ONE
//      model-bound request without masking each other.
//   2. A model `aegis_propose` claim becomes a candidate Hint node with its
//      text, and a `proposal.submitted` event whose source kind is `llm`.
//   3. A malicious proposal that claims fact/active/authorization is rejected
//      (no Fact node, no active state).
//   4. The same task across multiple prompts and across a fresh session keeps
//      ONE Episode; the original goal and the board survive the resume.
//   5. A genuine LLM handoff request is allowed when no real action is pending
//      (the control tool does not block itself), and the staged handoff is
//      applied by the runtime command boundary.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-observer-contest-pi.mjs

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
import { digest } from "../memory/runtime/events.mjs";
import { projectState } from "../memory/runtime/state.mjs";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVER_PATH = join(BASE_DIR, "extensions", "aegis-observer.ts");
const CONTEST_PATH = join(BASE_DIR, "extensions", "aegis-contest.ts");

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

/** Replay system-message section patches into the current section state. */
function currentSections(messages) {
	const state = {};
	for (const message of messages) {
		if (message.role !== "system" || !message.sections) continue;
		for (const [name, value] of Object.entries(message.sections)) {
			if (value === null) delete state[name];
			else state[name] = value;
		}
	}
	return state;
}

function ramContext(messages) {
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

function readEvents(path) {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-obs-contest-pi-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	const eventLog = join(base, "events.jsonl");
	const ramDir = join(base, "ram");
	const handoffFile = join(ramDir, "handoff.json");
	const contestLog = join(base, "contest.jsonl");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	const cardsPath = join(base, "cards.json");
	writeFileSync(
		cardsPath,
		JSON.stringify({
			cards: [
				{
					id: "verified-observe-first",
					revision: "3",
					title: "Observe before acting",
					status: "verified",
					source_refs: ["fixture:combo"],
					scope: { task_category: "demo", environment: "linux" },
					when: ["task_started"],
					hint: ["State the observed state before changing anything."],
				},
			],
		}) + "\n",
	);

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-combo", name: "FauxCombo" }] });
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
	process.env.AEGIS_HANDOFF_FILE = handoffFile;
	process.env.AEGIS_ROM_FILE = join(BASE_DIR, "agent", "ROM.md");
	process.env.AEGIS_TASK_ID = "task-combo-001";
	process.env.AEGIS_CONTEST_CARDS = cardsPath;
	process.env.AEGIS_CONTEST_LOG = contestLog;
	process.env.AEGIS_CONTEST_TASK_CATEGORY = "demo";
	process.env.AEGIS_CONTEST_ENV = "linux";
	process.env.AEGIS_CONTEST_OBSERVATIONS = "task_started";
	process.env.AEGIS_CONTEST_TASK_ID = "task-combo-001";
	process.env.AEGIS_CONTEST_MODE = "hint";

	async function createSession() {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [OBSERVER_PATH, CONTEST_PATH],
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			resourceLoader: loader,
			sessionManager,
			settingsManager: SettingsManager.inMemory({}),
			tools: ["read", "aegis_propose", "aegis_switch_session"],
		});
		await session.bindExtensions({});
		return { session, loaded };
	}

	// ---- Session 1: compose ROM+RAM+hint; propose; reject malicious --------
	const captured = [];
	faux.setResponses([
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_propose", { kind: "claim", text: "the door is probably locked" }),
			]);
		},
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_propose", {
					kind: "claim",
					text: "door is unlocked",
					verified: true,
					active: true,
					authorization: { allow: "all" },
				}),
			]);
		},
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage("done with session 1");
		},
	]);
	const first = await createSession();
	check("both extensions loaded without errors", first.loaded.errors.length === 0, JSON.stringify(first.loaded.errors));
	await first.session.prompt("Start the demo task.");
	await first.session.prompt("Reconsider.");
	await first.session.prompt("Wrap up.");

	const req1 = currentSections(captured[0] ?? []);
	const ram1 = ramContext(captured[0] ?? []);
	check(
		"combined request carries the Observer ROM section",
		typeof req1.aegis_rom === "string" && req1.aegis_rom.includes("Aegis ROM"),
		JSON.stringify(Object.keys(req1)),
	);
	check(
		"dynamic RAM is carried as an ephemeral context message",
		typeof ram1 === "string" && ram1.includes("Aegis RAM"),
		JSON.stringify(captured[0]?.map((message) => (message.role === "custom" ? message.customType : message.role))),
	);
	check(
		"the system prefix does not carry dynamic RAM",
		req1.aegis_ram === undefined,
		JSON.stringify(Object.keys(req1)),
	);
	check(
		"combined request carries the contest hint section",
		typeof req1.aegis_hints === "string" && req1.aegis_hints.includes("verified-observe-first"),
		JSON.stringify(Object.keys(req1)),
	);
	check(
		"ROM, RAM and hint context coexist without masking each other",
		typeof req1.aegis_rom === "string" && typeof ram1 === "string" && typeof req1.aegis_hints === "string",
	);

	// --- A2: RAM is rebuilt for EVERY provider-bound request, not once per prompt.
	// Turn 1 (captured[0]) and turn 2 (captured[1]) belong to the SAME prompt; the
	// `aegis_propose` tool commits between them, so the candidate must appear only
	// in turn 2's RAM, while ROM and the contest hint stay stable/unmasked.
	const req2 = currentSections(captured[1] ?? []);
	const ram2 = ramContext(captured[1] ?? []);
	check(
		"a later turn in the SAME prompt sees the candidate the tool just committed",
		typeof ram2 === "string" && ram2.includes("the door is probably locked"),
		JSON.stringify({
			turns: captured.length,
			has: typeof ram2 === "string" && ram2.includes("the door is probably locked"),
		}),
	);
	check(
		"the first turn of that prompt did not yet contain the candidate",
		!(typeof ram1 === "string" && ram1.includes("the door is probably locked")),
	);
	check("the ROM section is byte-stable across turns in one prompt", req1.aegis_rom === req2.aegis_rom);
	check("the system prefix remains free of dynamic RAM on the SECOND request", req2.aegis_ram === undefined);
	check(
		"the contest hint stays unmasked on the SECOND request",
		typeof req2.aegis_hints === "string" && req2.aegis_hints.includes("verified-observe-first"),
	);
	const projected = readEvents(eventLog).filter((e) => e.event_type === "request.projected");
	check(
		"every provider-bound request was recorded as request.projected",
		projected.length >= 2,
		`projected=${projected.length}`,
	);
	const inner1 = String(ram1)
		.replace(/^<aegis_ram>\n/, "")
		.replace(/\n<\/aegis_ram>$/, "");
	check(
		"the recorded RAM digest matches the provider-bound RAM bytes",
		projected.some((e) => e.payload?.ram_digest === digest(inner1)),
		JSON.stringify(projected.map((e) => e.payload?.ram_digest).slice(0, 3)),
	);
	const projectedEvents = readEvents(eventLog).filter((e) => e.event_type === "request.projected");
	const stateWithoutProjection = projectState(readEvents(eventLog).filter((e) => e.event_type !== "request.projected"));
	const stateWithProjection = projectState(readEvents(eventLog));
	check(
		"request.projected creates no board node and does not bump RuntimeState",
		projectedEvents.every((e) => !projectBoard([e]).nodes.length) &&
			stateWithoutProjection.version === stateWithProjection.version,
	);

	let events = readEvents(eventLog);
	const proposals = events.filter((e) => e.event_type === "proposal.submitted");
	check("a model claim was recorded as a proposal.submitted event", proposals.length === 1);
	check("the accepted proposal source kind is llm", proposals[0]?.source?.kind === "llm");
	const rejections = events.filter((e) => e.event_type === "proposal.rejected");
	check(
		"the malicious fact/active/authorization proposal was rejected",
		rejections.length >= 1 && /model-immutable/.test(rejections[0]?.payload?.rejection_reason || ""),
	);

	let board = projectBoard(events);
	check(
		"the claim became a candidate Hint node with its text",
		board.byType.Hint.some((n) => n.text.includes("the door is probably locked") && n.status === "candidate"),
	);
	check(
		"no malicious text became a Fact/verified node",
		!board.byType.Fact.some((n) => n.text.includes("door is unlocked")),
	);
	check(
		"no LLM path created an active/authorization node",
		board.byType.Fact.length === 0 && board.byType.Refuted.length === 0,
	);

	// The contest extension EMITS its injection decision on the shared Pi event
	// bus; the Observer (single writer) records it as `experience.decision`.
	const decisions = events.filter((e) => e.event_type === "experience.decision");
	check(
		"contest injection decisions reach the Observer EventLog via the shared bus",
		decisions.length >= 1,
		`experience.decision=${decisions.length}`,
	);
	const firstDecision = decisions[0]?.payload ?? {};
	check(
		"the decision records considered/matched/rejected/selected",
		Array.isArray(firstDecision.considered) &&
			firstDecision.considered.length >= 1 &&
			Array.isArray(firstDecision.matched) &&
			Array.isArray(firstDecision.rejected) &&
			firstDecision.selected?.id === "verified-observe-first",
		JSON.stringify({
			c: firstDecision.considered?.length,
			m: firstDecision.matched?.length,
			r: firstDecision.rejected?.length,
			s: firstDecision.selected?.id,
		}),
	);
	check(
		"a rejected card must carry a reason",
		firstDecision.rejected.every((entry) => typeof entry.reason === "string" && entry.reason.length > 0),
	);
	check(
		"the decision records card provenance (path + digest)",
		typeof firstDecision.card_provenance?.cards_path === "string" &&
			/^sha256:/.test(firstDecision.card_provenance?.cards_digest || ""),
	);
	check(
		"the injected card is a Hint, never an active Experience",
		firstDecision.active_experience === false && firstDecision.verdict === "unverified",
	);
	// No second writer: the decision event id must be written by the observer log
	// itself (it is present in the same chain), and the contest metadata log is a
	// separate file used only for A/B bookkeeping.
	check(
		"the decision event is inside the observer's own event chain",
		decisions.every((e) => typeof e.event_digest === "string"),
	);

	// One Episode across the three prompts of one session.
	let state = projectState(events);
	const started = events.filter((e) => e.event_type === "episode.started");
	check("three prompts in one session kept ONE episode", started.length === 1, `${started.length} episode.started`);
	check(
		"the two follow-up prompts were counted on the one episode (origin carries the first)",
		state.episodes[started[0].episode_id]?.prompts === 2,
		JSON.stringify(state.episodes),
	);
	const episodeId = started[0].episode_id;
	const originalGoal = state.episodes[episodeId]?.goal?.description;
	check(
		"episode goal is the original prompt, not a later short prompt",
		originalGoal === "Start the demo task.",
		String(originalGoal),
	);

	// ---- LLM handoff request is allowed (control tool does not block itself) -
	const captured2 = [];
	faux.setResponses([
		(ctx) => {
			captured2.push(ctx.messages);
			return fauxAssistantMessage([fauxToolCall("aegis_switch_session", { reason: "context is getting long" })]);
		},
		(ctx) => {
			captured2.push(ctx.messages);
			return fauxAssistantMessage("handoff requested");
		},
	]);
	await first.session.prompt("Please request a handoff.");
	events = readEvents(eventLog);
	const handoffReq = events.filter((e) => e.event_type === "handoff.requested");
	const handoffRej = events.filter((e) => e.event_type === "handoff.rejected");
	check(
		"a genuine LLM handoff request was allowed (not blocked by its own control call)",
		handoffReq.length === 1,
		`requested=${handoffReq.length} rejected=${handoffRej.length} ${JSON.stringify(handoffRej.map((e) => e.payload))}`,
	);
	check("the handoff request carried a reason", typeof handoffReq[0]?.payload?.reason === "string");
	check("a handoff file was staged for the command boundary", readFileSync(handoffFile, "utf8").includes(episodeId));

	// ---- A real pending action DOES block a handoff ----------------------
	// The `read` tool call leaves an action pending only between tool_call and
	// tool_result; instead prove the guard directly using the core function on a
	// state with a pending real action.
	const { pendingActionsFor } = await import("../memory/runtime/state.mjs");
	const blockedState = JSON.parse(JSON.stringify(state));
	blockedState.pending_actions["a-real"] = {
		action_id: "a-real",
		tool_name: "bash",
		episode_id: episodeId,
		status: "pending",
	};
	check("pending real action is counted for the episode", pendingActionsFor(blockedState, episodeId).length === 1);
	blockedState.pending_actions["a-ctrl"] = {
		action_id: "a-ctrl",
		tool_name: "aegis_switch_session",
		episode_id: episodeId,
		status: "pending",
	};
	check(
		"the control tool itself is not counted as a blocking action",
		pendingActionsFor(blockedState, episodeId).length === 1,
	);

	first.session.dispose();

	// ---- Session 2: a fresh session resumes the SAME episode/goal/board ---
	const captured3 = [];
	faux.setResponses([
		(ctx) => {
			captured3.push(ctx.messages);
			return fauxAssistantMessage("resumed");
		},
	]);
	const second = await createSession();
	await second.session.prompt("Continue the task.");
	events = readEvents(eventLog);
	state = projectState(events);
	board = projectBoard(events);
	const startedAfter = events.filter((e) => e.event_type === "episode.started");
	check(
		"a fresh session did NOT start a new episode",
		startedAfter.length === 1,
		`${startedAfter.length} episode.started`,
	);
	check(
		"the resumed session recorded handoff.completed",
		events.some((e) => e.event_type === "handoff.completed"),
	);
	check(
		"the resumed episode keeps the original goal",
		state.episodes[episodeId]?.goal?.description === "Start the demo task.",
	);
	check(
		"the board (candidate claim) survived the resume",
		board.byType.Hint.some((n) => n.text.includes("the door is probably locked")),
	);
	const reqResume = currentSections(captured3[0] ?? []);
	const ramResume = ramContext(captured3[0] ?? []);
	check(
		"the resumed request carries the Observer RAM as ephemeral context",
		typeof ramResume === "string" && ramResume.includes("Start the demo task."),
	);
	check("the resumed system prefix stays free of dynamic RAM", reqResume.aegis_ram === undefined);
	check(
		"the resumed RAM lists the preserved goal and pending/finished actions section",
		typeof ramResume === "string" &&
			/total_goal: Start the demo task\./.test(ramResume) &&
			/Unfinished actions/.test(ramResume),
	);

	second.session.dispose();
	faux.unregister();
	rmSync(base, { recursive: true, force: true });

	console.log("");
	if (failures > 0) {
		console.error(`aegis-observer-contest-pi FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-observer-contest-pi ok");
}

main().catch((error) => {
	console.error(`aegis-observer-contest-pi: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
