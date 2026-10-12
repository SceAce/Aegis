// Offline Aegis contest <-> Pi integration test (REAL Pi SDK, faux provider).
//
// This is the end-to-end regression for the P0 contest slice. Unlike
// `contest-smoke.mjs` (which drives the extension's handlers with mocks), this
// test boots a REAL Pi agent session through the SDK and asserts on the ACTUAL
// model-bound request:
//
//   1. `off` and `hint` run the SAME model/provider/tools/session setup and
//      differ ONLY in the system-prompt section `aegis_hints`; the difference
//      is observed in the request the provider actually receives
//      (`TranscriptContext.messages`), not in a mock.
//   2. A matched `hint` request carries the low-trust `<aegis_hints>` section;
//      an `off` request does not; a `candidate` card is never auto-injected.
//   3. Stale hints are removed from the NEXT request: after hint injection, a
//      later request is sent with `aegis_hints: null` (a real section removal).
//   4. Tool activity is recorded by the extension as `tool_call`/`tool_result`
//      metadata linked to the session and task id, so `daily.mjs` has a real
//      authoritative source instead of guessing the session JSONL shape.
//   5. When the metadata log cannot be written, the extension does NOT inject
//      an unlogged hint (fail-closed) and surfaces the failure on stderr.
//
// No network, no real model, no credentials. The nested Pi repository is only
// read, never modified.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-contest-pi-integration.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_PATH = join(BASE_DIR, "extensions", "aegis-contest.ts");

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log(`ok - ${name}`);
	} else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

function makeFauxModelDetails(model) {
	return {
		baseUrl: model.baseUrl,
		api: model.api,
		apiKey: "faux-key",
		models: [{
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		}],
	};
}

/**
 * Replay a transcript's system-message section patches into the section state
 * the model currently holds. `null` removes a section (real Pi semantics).
 */
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

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-contest-pi-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	const cardsPath = join(base, "cards.json");
	writeFileSync(cardsPath, JSON.stringify({
		cards: [
			{
				id: "verified-observe-first",
				revision: "3",
				title: "Observe before acting",
				status: "verified",
				source_refs: ["fixture:integration"],
				scope: { task_category: "demo", environment: "linux" },
				when: ["task_started"],
				hint: ["State the observed state before changing anything."],
				expect: "An explicit observation line.",
			},
			{
				id: "candidate-never-auto",
				revision: "1",
				title: "Candidate must not auto-inject",
				status: "candidate",
				source_refs: ["fixture:integration"],
				scope: { task_category: "demo", environment: "linux" },
				when: ["task_started"],
				hint: ["This candidate text must never appear automatically."],
			},
		],
	}) + "\n");
	// A real file so the `read` tool call succeeds and produces tool activity.
	const readTarget = join(cwd, "note.txt");
	writeFileSync(readTarget, "hello from the faux-model fixture\n");

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(base, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, makeFauxModelDetails(model));

	// Each session gets its own extension load so the module-level MetaLog picks
	// up the env for that session.
	async function createSession({ logPath }) {
		process.env.AEGIS_CONTEST_CARDS = cardsPath;
		process.env.AEGIS_CONTEST_LOG = logPath;
		process.env.AEGIS_CONTEST_TASK_CATEGORY = "demo";
		process.env.AEGIS_CONTEST_ENV = "linux";
		process.env.AEGIS_CONTEST_OBSERVATIONS = "task_started";
		process.env.AEGIS_CONTEST_TASK_ID = "task-int-001";

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [EXTENSION_PATH],
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
			tools: ["read"],
		});
		// SDK sessions must bind extensions explicitly: this is what fires the
		// `session_start` event the extension uses to load cards and observations.
		await session.bindExtensions({});
		return { session, loaded };
	}

	// ---- Session 1: hint, then stale removal ------------------------------
	const hintLog = join(base, "hint-decisions.jsonl");
	const hintCaptured = [];
	process.env.AEGIS_CONTEST_MODE = "hint";
	faux.setResponses([
		(ctx) => {
			hintCaptured.push(ctx.messages);
			return fauxAssistantMessage("ok (hint request 1)");
		},
		(ctx) => {
			hintCaptured.push(ctx.messages);
			return fauxAssistantMessage("ok (hint request 2)");
		},
	]);
	const hintSession = await createSession({ logPath: hintLog });
	check("hint session loaded the extension without errors", hintSession.loaded.errors.length === 0, JSON.stringify(hintSession.loaded.errors));

	await hintSession.session.prompt("Do the demo task.");
	const req1 = currentSections(hintCaptured[0] ?? []);
	check("model-bound request 1 actually carries the aegis_hints section", typeof req1.aegis_hints === "string", JSON.stringify(Object.keys(req1)));
	check("hint section is the low-trust XML-tagged section", /^<aegis_hints>/.test(req1.aegis_hints ?? ""), String(req1.aegis_hints).slice(0, 80));
	check("hint section names the matched verified card", (req1.aegis_hints ?? "").includes("verified-observe-first"));
	check("hint section never auto-injects a candidate card", !(req1.aegis_hints ?? "").includes("candidate-never-auto"));
	check("hint section is explicitly untrusted", /NOT instructions/i.test(req1.aegis_hints ?? ""));

	// Flip to record-only: the next real request must drop the section.
	process.env.AEGIS_CONTEST_MODE = "off";
	await hintSession.session.prompt("Do the demo task again.");
	const req2Raw = hintCaptured[1] ?? [];
	const removalPatch = req2Raw
		.filter((message) => message.role === "system" && message.sections)
		.reduce((acc, message) => Object.assign(acc, message.sections), {});
	check("stale hint is removed from the next model-bound request", removalPatch.aegis_hints === null, JSON.stringify(removalPatch.aegis_hints));
	const req2 = currentSections(req2Raw);
	check("removed hint no longer appears in the request's section state", req2.aegis_hints === undefined, JSON.stringify(Object.keys(req2)));
	hintSession.session.dispose();

	// ---- Session 2: off (control) -----------------------------------------
	const offLog = join(base, "off-decisions.jsonl");
	const offCaptured = [];
	process.env.AEGIS_CONTEST_MODE = "off";
	faux.setResponses([
		(ctx) => {
			offCaptured.push(ctx.messages);
			return fauxAssistantMessage([fauxToolCall("read", { path: readTarget })]);
		},
		(ctx) => {
			offCaptured.push(ctx.messages);
			return fauxAssistantMessage("ok (off request 2)");
		},
	]);
	const offSession = await createSession({ logPath: offLog });
	check("off session loaded the extension without errors", offSession.loaded.errors.length === 0, JSON.stringify(offSession.loaded.errors));

	await offSession.session.prompt("Do the demo task.");
	const off1 = currentSections(offCaptured[0] ?? []);
	check("off request never carries an aegis_hints section", off1.aegis_hints === undefined, JSON.stringify(Object.keys(off1)));

	// The A/B claim: same setup, but the actual requests differ by the section.
	check(
		"A/B off vs hint differ in the actual model-bound request",
		typeof req1.aegis_hints === "string" && off1.aegis_hints === undefined,
		`hint=${typeof req1.aegis_hints}, off=${typeof off1.aegis_hints}`,
	);
	check("off request 1 and hint request 1 share the same non-hint sections", JSON.stringify({ ...off1, aegis_hints: undefined }) === JSON.stringify({ ...req1, aegis_hints: undefined }), `off=${JSON.stringify(Object.keys(off1))} hint=${JSON.stringify(Object.keys(req1))}`);

	await offSession.session.prompt("Follow up.");
	offSession.session.dispose();

	// ---- Extension metadata: real tool activity for daily.mjs -------------
	const offRows = readFileSync(offLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const toolCalls = offRows.filter((row) => row.event === "tool_call");
	const toolResults = offRows.filter((row) => row.event === "tool_result");
	check("extension logged exactly one tool_call for the off session", toolCalls.length === 1 && toolCalls[0].tool_name === "read", JSON.stringify(toolCalls.map((r) => r.tool_name)));
	check("extension logged one matching tool_result", toolResults.length === 1 && toolResults[0].tool_name === "read", JSON.stringify(toolResults));
	check("tool activity metadata links session and anonymous task id", toolCalls[0]?.session_id === toolResults[0]?.session_id && toolCalls[0]?.session_id.length > 0 && toolCalls[0]?.task_id === "task-int-001", JSON.stringify({ call: toolCalls[0]?.session_id, result: toolResults[0]?.session_id, task: toolCalls[0]?.task_id }));
	check("tool activity metadata carries a call id and input digest", typeof toolCalls[0]?.tool_call_id === "string" && /^sha256:/.test(toolCalls[0]?.input_digest ?? ""), JSON.stringify(toolCalls[0]));
	check("off session recorded an injection_decision with mode=off", offRows.some((row) => row.event === "injection_decision" && row.mode === "off" && row.prompt_section_applied === false && row.injected === ""), JSON.stringify(offRows.filter((r) => r.event === "injection_decision")));
	const hintRows = readFileSync(hintLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	check("hint session recorded an injection that was actually applied", hintRows.some((row) => row.event === "injection_decision" && row.mode === "hint" && row.prompt_section_applied === true && row.injected.includes("verified-observe-first")), JSON.stringify(hintRows.filter((r) => r.event === "injection_decision")));
	check("hint session recorded the later section removal", hintRows.some((row) => row.event === "injection_decision" && row.mode === "off" && row.prompt_section_applied === false), JSON.stringify(hintRows.filter((r) => r.event === "injection_decision")));
	check("metadata rows all carry the anonymous task id", [...offRows, ...hintRows].filter((row) => row.event !== undefined && "task_id" in row).every((row) => row.task_id === "task-int-001"), JSON.stringify([...offRows, ...hintRows].map((r) => r.task_id)));
	check("metadata never contains raw tool output or secrets", !/(flag\{|BEGIN [A-Z ]*PRIVATE KEY|api_key=)/.test(readFileSync(offLog, "utf8") + readFileSync(hintLog, "utf8")));

	// ---- Session 3: log write failure must fail closed --------------------
	// Point the log at a DIRECTORY so every append fails, and capture stderr.
	process.env.AEGIS_CONTEST_MODE = "hint";
	const unwritableLog = join(base, "cannot-write-here");
	mkdirSync(unwritableLog, { recursive: true });
	const failCaptured = [];
	faux.setResponses([
		(ctx) => {
			failCaptured.push(ctx.messages);
			return fauxAssistantMessage("ok (fail-closed request)");
		},
	]);
	const failSession = await createSession({ logPath: unwritableLog });
	const stderrChunks = [];
	const realStderrWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk, ...rest) => {
		stderrChunks.push(String(chunk));
		return realStderrWrite(chunk, ...rest);
	};
	let promptError = null;
	try {
		await failSession.session.prompt("Do the demo task with a broken log.");
	} catch (error) {
		promptError = error;
	} finally {
		process.stderr.write = realStderrWrite;
	}
	const fail1 = currentSections(failCaptured[0] ?? []);
	check("unlogged hint is NOT injected (fail closed)", fail1.aegis_hints === undefined, JSON.stringify(Object.keys(fail1)));
	check("log write failure is surfaced on stderr", stderrChunks.some((text) => /metadata log write failed/.test(text)), stderrChunks.join("").slice(0, 300));
	check("log write failure marks the episode invalid for A/B", stderrChunks.some((text) => /invalid for A\/B/.test(text)), stderrChunks.join("").slice(0, 300));
	// A failed write must not poison the queue: once the path is fixable, later
	// writes recover. Re-point at a file and confirm a fresh session writes.
	failSession.session.dispose();
	const recoveredLog = join(base, "recovered-decisions.jsonl");
	process.env.AEGIS_CONTEST_MODE = "off";
	const recovered = await createSession({ logPath: recoveredLog });
	await recovered.session.prompt("Recover.");
	recovered.session.dispose();
	const recoveredRows = readFileSync(recoveredLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	check("a later write recovers after a failure", recoveredRows.some((row) => row.event === "session_start"), `${recoveredRows.length} rows`);
	if (promptError) console.log(`note - prompt with a broken log returned an error: ${String(promptError).slice(0, 120)}`);

	// ---- Session 4: hint injects, then the SAME session's log breaks ------ -
	// Regression (P0 #2): the decision log succeeds for request 1 (hint is
	// injected), then the log path becomes unwritable. Request 2 must NOT leave
	// the stale request-1 hint in place: it must remove it, surface stderr, and
	// mark the session invalid for A/B. Previously the failure path returned
	// before removing the section.
	process.env.AEGIS_CONTEST_MODE = "hint";
	const sameSessionLog = join(base, "same-session-decisions.jsonl");
	const sameCaptured = [];
	faux.setResponses([
		(ctx) => {
			sameCaptured.push(ctx.messages);
			return fauxAssistantMessage("ok (same-session hint request 1)");
		},
		(ctx) => {
			sameCaptured.push(ctx.messages);
			return fauxAssistantMessage("ok (same-session hint request 2)");
		},
	]);
	const sameSession = await createSession({ logPath: sameSessionLog });
	await sameSession.session.prompt("First hint request.");
	const same1 = currentSections(sameCaptured[0] ?? []);
	check("same-session request 1 injected a hint", typeof same1.aegis_hints === "string", JSON.stringify(Object.keys(same1)));

	// Break the already-used log path between the two requests of ONE session.
	rmSync(sameSessionLog, { force: true });
	mkdirSync(sameSessionLog, { recursive: true });
	const sameStderr = [];
	const realStderrSame = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk, ...rest) => {
		sameStderr.push(String(chunk));
		return realStderrSame(chunk, ...rest);
	};
	try {
		await sameSession.session.prompt("Second hint request after the log broke.");
	} finally {
		process.stderr.write = realStderrSame;
	}
	const same2Raw = sameCaptured[1] ?? [];
	const sameRemovalPatch = same2Raw
		.filter((message) => message.role === "system" && message.sections)
		.reduce((acc, message) => Object.assign(acc, message.sections), {});
	const same2 = currentSections(same2Raw);
	check(
		"same-session log failure removes the stale previously-injected hint",
		sameRemovalPatch.aegis_hints === null && same2.aegis_hints === undefined,
		JSON.stringify({ removalPatch: sameRemovalPatch.aegis_hints, state: same2.aegis_hints }),
	);
	check("same-session log failure is surfaced on stderr", sameStderr.some((text) => /metadata log write failed/.test(text)), sameStderr.join("").slice(0, 300));
	check("same-session log failure marks the session invalid for A/B", sameStderr.some((text) => /invalid for A\/B/.test(text)), sameStderr.join("").slice(0, 300));
	sameSession.session.dispose();

	faux.unregister();
	rmSync(base, { recursive: true, force: true });

	console.log("");
	if (failures > 0) {
		console.error(`aegis-contest-pi-integration FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-contest-pi-integration ok");
}

main().catch((error) => {
	console.error(`aegis-contest-pi-integration: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
