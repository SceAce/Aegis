// Offline REAL Pi SDK faux-provider multi-turn test: verify-first actions.
//
// This is the batch-C vertical slice. It boots a REAL Pi agent session (faux
// provider, no network, no real model) with the Observer loaded and drives a
// real multi-turn tool loop, asserting on the actual model-bound requests and
// the actual EventLog:
//
//   1. `aegis_observe` reads a REAL ELF header (format/bitness/machine) and the
//      registered re-check marks the observation verified -> a Fact that is
//      VISIBLE in the next request's RAM section.
//   2. `aegis_execute` runs a HUMAN-REGISTERED script bound to the observed
//      bitness DATA. The registered post-condition Oracle reads the REAL JSON
//      post-state (`stage.json`) to confirm stage progress. A zero exit code
//      ALONE is not success: a run whose Oracle rejects records `unknown`.
//   3. The action INTENT (`action.requested`) is durably recorded BEFORE the
//      effect, and a pre-effect registration admission note is recorded.
//   4. `normal` mode without an explicit approval does NOT effect; `auto` still
//      requires the registered Oracle to pass.
//   5. The model can never name an executable/argv/oracle; only a registered
//      action id + data-only arguments.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-observer-verify-first-pi.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { executableDigest } from "../execution/script-registry.mjs";
import { syntheticElfHeader } from "../execution/workspace-info-actions.mjs";
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

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-verify-first-pi-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	const eventLog = join(base, "events.jsonl");
	const ramDir = join(base, "ram");
	const handoffFile = join(ramDir, "handoff.json");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	// --- A real ELF target (64-bit little-endian x86-64) in the workspace. ---
	const elfPath = join(cwd, "target.bin");
	writeFileSync(elfPath, syntheticElfHeader({ bits: 64, machine_id: 0x3e }));

	// --- A real registered script: writes a JSON post-state. ---
	const scriptPath = join(cwd, "write-stage.mjs");
	writeFileSync(
		scriptPath,
		[
			'import { writeFileSync } from "node:fs";',
			"const args = {};",
			"const a = process.argv.slice(2);",
			'for (let i = 0; i < a.length; i += 2) args[a[i].replace(/^--/, "")] = a[i + 1];',
			'writeFileSync(args.out, JSON.stringify({ ok: args.mode === "good", stage: Number(args.stage), bits: String(args.bits) }));',
			"process.exit(0);",
			"",
		].join("\n"),
	);
	const stageOut = join(cwd, "stage.json");
	const stageGood = join(cwd, "stage-good.json");
	const stageBad = join(cwd, "stage-bad.json");
	const nodeExe = process.execPath;
	const nodeDigest = executableDigest(nodeExe);
	const scriptDigest = executableDigest(scriptPath);

	// --- The trusted HUMAN registration module (a real verify() Oracle). ---
	const configPath = join(base, "scripts-config.mjs");
	writeFileSync(
		configPath,
		[
			'import { readFileSync } from "node:fs";',
			"export const scripts = [{",
			'\tschema_version: "1.0",',
			'\tid: "write-stage",',
			"\tversion: 1,",
			`\texecutable: ${JSON.stringify(nodeExe)},`,
			`\texecutable_digest: ${JSON.stringify(nodeDigest)},`,
			`\tscript_path: ${JSON.stringify(scriptPath)},`,
			`\tscript_digest: ${JSON.stringify(scriptDigest)},`,
			"\targv_template: [",
			`\t\t${JSON.stringify(scriptPath)}, "--out", "{out}", "--stage", "{stage}", "--bits", "{bits}", "--mode", "{mode}",`,
			"\t],",
			`\tallowed_root: ${JSON.stringify(cwd)},`,
			`\tcwd: ${JSON.stringify(cwd)},`,
			'\tparameters: { out: { type: "string" }, stage: { type: "number" }, bits: { type: "string" }, mode: { type: "string" } },',
			'\trisk_class: "medium",',
			"\ttimeout_ms: 5000,",
			'\texpect: "stage.json reports ok:true for the forwarded bitness",',
			"\tverify: ({ observed }) => {",
			'\t\tconst idx = observed.argv.indexOf("--out");',
			"\t\tconst out = observed.argv[idx + 1];",
			"\t\tlet parsed;",
			'\t\ttry { parsed = JSON.parse(readFileSync(out, "utf8")); } catch (error) { return { ok: false, reason: `stage file unreadable: ${String(error)}` }; }',
			'\t\tif (parsed.ok !== true) return { ok: false, reason: "stage file did not report ok:true" };',
			'\t\treturn { ok: true, reason: "registered Oracle read the stage JSON and confirmed progress", expected: { ok: true }, observed: parsed };',
			"\t},",
			"}];",
			"",
		].join("\n"),
	);

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-vf", name: "FauxVF" }] });
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
	process.env.AEGIS_TASK_ID = "task-verify-first";
	process.env.AEGIS_WORKSPACE = cwd;
	process.env.AEGIS_SCRIPT_CONFIG = configPath;
	process.env.AEGIS_ACTION_MODE = "auto";
	delete process.env.AEGIS_ACTION_APPROVED;
	delete process.env.AEGIS_ALLOW_NETWORK;

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
			tools: ["aegis_observe", "aegis_execute", "aegis_propose", "aegis_switch_session"],
		});
		await session.bindExtensions({});
		return { session, loaded };
	}

	// ================= Session 1: observe -> execute =================
	const captured = [];
	faux.setResponses([
		// Turn 1: observe the real ELF.
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_observe", { action: "workspace.identify_elf", path: "target.bin" }),
			]);
		},
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage("observed the target");
		},
		// Turn 2: run the registered script bound to the observed bitness data.
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_execute", {
					action: "script.write-stage",
					arguments: { out: stageGood, stage: 1, bits: "64", mode: "good" },
				}),
			]);
		},
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage("ran the registered stage script");
		},
		// Turn 3: same registered script, but the oracle will reject the post-state.
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_execute", {
					action: "script.write-stage",
					arguments: { out: stageBad, stage: 2, bits: "64", mode: "bad" },
				}),
			]);
		},
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage("second run finished");
		},
		// Turn 4: try to name an arbitrary executable (must be refused).
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage([fauxToolCall("aegis_execute", { action: "/bin/sh", arguments: { out: stageOut } })]);
		},
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage("done");
		},
	]);

	const first = await createSession();
	check(
		"the observer extension loaded without errors",
		first.loaded.errors.length === 0,
		JSON.stringify(first.loaded.errors),
	);

	await first.session.prompt("Observe the target file.");
	await first.session.prompt("Run the registered stage script with the observed bitness.");
	await first.session.prompt("Run it again with mode bad.");
	await first.session.prompt("Now try to run a shell command.");

	let events = readEvents(eventLog);

	// --- 1. Real ELF observation is verified and reaches the board. ---
	const observeReq = events.find(
		(e) => e.event_type === "action.requested" && e.payload?.tool_name === "aegis_observe",
	);
	const elfObservation = events.find(
		(e) => e.event_type === "observation.captured" && e.payload?.observation_kind === "file_identity",
	);
	check("an aegis_observe action.requested intent was recorded", Boolean(observeReq));
	check(
		"the real ELF header was parsed (bits=64, machine=x86_64)",
		elfObservation?.payload?.value?.bits === 64 && elfObservation?.payload?.value?.machine === "x86_64",
		JSON.stringify(elfObservation?.payload?.value),
	);
	check(
		"the verified observation comes from the trusted oracle source",
		elfObservation?.payload?.verified === true && elfObservation?.source?.kind === "oracle",
	);
	const observeOrder = events.findIndex(
		(e) => e.event_type === "action.requested" && e.payload?.tool_name === "aegis_observe",
	);
	const obsOrder = events.findIndex(
		(e) => e.event_type === "observation.captured" && e.payload?.observation_kind === "file_identity",
	);
	check(
		"the observation intent was durably recorded BEFORE the observation effect",
		observeOrder >= 0 && observeOrder < obsOrder,
		`intent=${observeOrder} obs=${obsOrder}`,
	);
	const elfStepOutcome = events.find((e) => e.event_type === "outcome.recorded" && e.payload?.level === "step");
	check(
		"a verified step outcome was recorded for the ELF observation",
		elfStepOutcome?.payload?.status === "success" && Boolean(elfStepOutcome?.payload?.criterion),
	);

	// --- 2. The verified data is VISIBLE in the NEXT request's RAM. ---
	const reqAfterObserve = currentSections(captured[2] ?? []);
	const ramAfterObserve = ramContext(captured[2] ?? []);
	check(
		"the next request's RAM carries the verified ELF observation as data",
		typeof ramAfterObserve === "string" && /x86_64|bits=64|ELF/.test(ramAfterObserve),
		typeof ramAfterObserve === "string" ? ramAfterObserve.slice(0, 400) : "no ram",
	);
	check("the verified observation is not written into the system prefix", reqAfterObserve.aegis_ram === undefined);

	// --- 3. The registered script ran; the Oracle read the real post-state. ---
	const stageJson = JSON.parse(readFileSync(stageGood, "utf8"));
	const scriptObservation = events.find(
		(e) =>
			e.event_type === "observation.captured" &&
			e.payload?.observation_kind === "script_execution" &&
			e.payload?.verified === true,
	);
	check(
		"the registered script wrote the JSON post-state with the bound bitness",
		stageJson.bits === "64" && stageJson.ok === true,
		JSON.stringify(stageJson),
	);
	check(
		"the script action was verified by the registered Oracle reading the JSON post-state",
		Boolean(scriptObservation),
		"no verified script_execution observation",
	);
	const scriptAdmission = events.find(
		(e) =>
			e.event_type === "runtime.note" &&
			e.payload?.kind === "environment.observed" &&
			e.payload?.scope === "script.registration",
	);
	check(
		"a pre-effect registration admission note was recorded",
		Boolean(scriptAdmission) && scriptAdmission.payload?.detail?.pins_match === true,
		JSON.stringify(scriptAdmission?.payload?.detail),
	);
	const scriptRequested = events.find(
		(e) => e.event_type === "action.requested" && e.payload?.tool_name === "aegis_execute",
	);
	const scriptObs = events.find(
		(e) => e.event_type === "observation.captured" && e.payload?.observation_kind === "script_execution",
	);
	const reqIdx = events.findIndex(
		(e) => e.event_type === "action.requested" && e.payload?.tool_name === "aegis_execute",
	);
	const scrIdx = events.findIndex(
		(e) => e.event_type === "observation.captured" && e.payload?.observation_kind === "script_execution",
	);
	check(
		"the script intent was durably recorded BEFORE the script effect",
		Boolean(scriptRequested) && reqIdx >= 0 && reqIdx < scrIdx,
		`intent=${reqIdx} effect=${scrIdx}`,
	);

	// --- 4. Exit 0 alone is NOT success: the Oracle-rejected run is unknown. ---
	const badRunOutcomes = events.filter(
		(e) => e.event_type === "outcome.recorded" && e.payload?.level === "step" && e.payload?.status === "unknown",
	);
	check(
		"the Oracle-rejected run is recorded as unknown, not success",
		badRunOutcomes.length >= 1,
		JSON.stringify(
			badRunOutcomes.map((e) => ({
				status: e.payload?.status,
				failure: e.payload?.failure_mode,
				exit: e.payload?.transport?.exit_code,
			})),
		),
	);
	check(
		"its zero exit code is preserved as transport, not conflated with the verdict",
		badRunOutcomes.some((e) => e.payload?.transport?.exit_code === 0),
		JSON.stringify(badRunOutcomes.map((e) => e.payload?.transport)),
	);
	check(
		"no Oracle-rejected observation was marked verified",
		!events.some(
			(e) =>
				e.event_type === "observation.captured" &&
				e.payload?.observation_kind === "script_execution" &&
				(e.payload?.value?.argv ?? []).includes("bad") &&
				e.payload?.verified === true,
		),
	);

	// --- 5. The model cannot name an arbitrary executable. ---
	const shellAttempt = events.find(
		(e) =>
			e.event_type === "runtime.note" && e.payload?.kind === "action.rejected" && e.payload?.action_ref === "/bin/sh",
	);
	check(
		"naming an arbitrary executable was rejected (no /bin/sh action)",
		Boolean(shellAttempt),
		JSON.stringify(
			events
				.filter((e) => e.event_type === "runtime.note" && e.payload?.kind === "action.rejected")
				.map((e) => e.payload?.action_ref),
		),
	);
	check(
		"no shell was ever executed",
		!events.some((e) => e.event_type === "observation.captured" && JSON.stringify(e.payload ?? {}).includes("/bin/sh")),
	);

	// --- 6. A verified script Fact is visible to the next request. ---
	const board = projectBoard(events);
	check(
		"the board holds a trusted Fact node from the verified action",
		board.byType.Fact.length >= 1,
		`facts=${board.byType.Fact.length}`,
	);
	check("no LLM proposal created a Fact", !board.byType.Fact.some((n) => n.text.includes("shell")));

	first.session.dispose();

	// ================= Session 2: normal mode does not effect =================
	process.env.AEGIS_ACTION_MODE = "normal";
	const stageNormal = join(cwd, "stage-normal.json");
	writeFileSync(stageNormal, JSON.stringify({ ok: true, stage: 0, bits: "64" }));
	const stageBefore = readFileSync(stageNormal, "utf8");
	const captured2 = [];
	faux.setResponses([
		(ctx) => {
			captured2.push(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_execute", {
					action: "script.write-stage",
					arguments: { out: stageNormal, stage: 3, bits: "64", mode: "good" },
				}),
			]);
		},
		(ctx) => {
			captured2.push(ctx.messages);
			return fauxAssistantMessage("normal-mode attempt done");
		},
	]);
	const second = await createSession();
	await second.session.prompt("Run the registered script.");
	await second.session.prompt("Report.");

	events = readEvents(eventLog);
	const pendingRejections = events.filter(
		(e) =>
			e.event_type === "runtime.note" &&
			e.payload?.kind === "action.rejected" &&
			/approval/.test(e.payload?.reason ?? ""),
	);
	check(
		"normal mode without approval recorded a pending-approval rejection",
		pendingRejections.length >= 1,
		JSON.stringify(pendingRejections.map((e) => e.payload?.reason)),
	);
	check(
		"normal mode without approval did NOT modify the post-state",
		readFileSync(stageNormal, "utf8") === stageBefore,
	);
	check(
		"normal mode refusal produced no new verified script observation",
		events.filter(
			(e) =>
				e.event_type === "observation.captured" &&
				e.payload?.observation_kind === "script_execution" &&
				e.payload?.verified === true,
		).length === 1,
	);

	second.session.dispose();

	// ============ Session 3: normal mode WITH an explicit env approval =========
	// The SAME semantics as `auto`/the run path: a per-call AEGIS_ACTION_APPROVED=1
	// grant is honored in normal mode, and the source is recorded on the intent.
	process.env.AEGIS_ACTION_MODE = "normal";
	process.env.AEGIS_ACTION_APPROVED = "1";
	const stageApproved = join(cwd, "stage-approved.json");
	const captured3 = [];
	faux.setResponses([
		(ctx) => {
			captured3.push(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_execute", {
					action: "script.write-stage",
					arguments: { out: stageApproved, stage: 5, bits: "64", mode: "good" },
				}),
			]);
		},
		(ctx) => {
			captured3.push(ctx.messages);
			return fauxAssistantMessage("approved run done");
		},
	]);
	const third = await createSession();
	await third.session.prompt("Run the registered script with an explicit approval.");
	await third.session.prompt("Report.");

	events = readEvents(eventLog);
	check(
		"normal mode WITH AEGIS_ACTION_APPROVED=1 runs the registered action (unified approval semantics)",
		existsSync(stageApproved) && JSON.parse(readFileSync(stageApproved, "utf8")).stage === 5,
		JSON.stringify(existsSync(stageApproved) ? JSON.parse(readFileSync(stageApproved, "utf8")) : null),
	);
	const approvedRequested = events
		.filter((e) => e.event_type === "action.requested" && e.payload?.tool_name === "aegis_execute")
		.at(-1);
	check(
		"the env approval source is recorded on the intent",
		approvedRequested?.payload?.authorization?.source === "env:AEGIS_ACTION_APPROVED" &&
			approvedRequested?.payload?.authorization?.granted === true,
		JSON.stringify(approvedRequested?.payload?.authorization),
	);
	third.session.dispose();
	delete process.env.AEGIS_ACTION_APPROVED;

	faux.unregister();
	rmSync(base, { recursive: true, force: true });

	console.log("");
	if (failures > 0) {
		console.error(`aegis-observer-verify-first-pi FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-observer-verify-first-pi ok");
}

main().catch((error) => {
	console.error(
		`aegis-observer-verify-first-pi: ${error instanceof Error ? error.stack || error.message : String(error)}`,
	);
	process.exitCode = 1;
});
