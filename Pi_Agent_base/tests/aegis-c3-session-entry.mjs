#!/usr/bin/env node
// Aegis C3-C — C2 session-rotation wiring through the product Campaign Host.
//
// Proves the Host really calls the accepted C2 entry (`createSessionSupervisor`)
// at a safe settle boundary, that a genuinely new AgentSession is created, that
// the Pi episode is preserved, and that the Host's SINGLE budget ledger charges
// exactly one session generation per committed rotation (and refuses once the
// session budget is exhausted). Real Pi SDK + faux provider; no real model or
// network.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c3-session-entry.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { createCampaignHost } from "../memory/campaign/host.mjs";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { EventLog } from "../memory/runtime/events.mjs";
import { committedRotations, createSessionSupervisor } from "../memory/runtime/session-supervisor.mjs";
import { projectState } from "../memory/runtime/state.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OBSERVER_PATH = join(BASE_DIR, "extensions", "aegis-observer.ts");

const base = mkdtempSync(join(tmpdir(), "aegis-c3-session-"));
let runtime;
let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}
function readEvents(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}
function makeFauxModelDetails(model) {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		api: model.api,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		baseUrl: model.baseUrl,
	};
}

try {
	const cwd = join(base, "cwd");
	const agentDir = join(base, "agent");
	const sessionDir = join(base, "sessions");
	const workspaceRoot = join(base, "ws");
	const eventLogPath = join(base, "events.jsonl");
	const ramDir = join(base, "ram");
	const handoffPath = join(ramDir, "handoff.json");
	for (const dir of [cwd, agentDir, sessionDir, workspaceRoot]) mkdirSync(dir, { recursive: true });
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_RAM_DIR: ramDir,
		AEGIS_HANDOFF_FILE: handoffPath,
		AEGIS_TASK_ID: "task-c3-session",
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-c3", name: "FauxC3" }] });
	const model = faux.getModel();
	const credentials = AuthStorage.inMemory();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: join(base, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, makeFauxModelDetails(model));

	let creations = 0;
	runtime = await createAgentSessionRuntime(
		async ({ cwd: sessionCwd, agentDir: sessionAgentDir, sessionManager, sessionStartEvent }) => {
			creations += 1;
			const services = await createAgentSessionServices({
				cwd: sessionCwd,
				agentDir: sessionAgentDir,
				modelRuntime,
				settingsManager: SettingsManager.inMemory({}),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [OBSERVER_PATH],
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
				tools: ["aegis_switch_session"],
			});
			return { ...created, services, diagnostics: services.diagnostics };
		},
		{ cwd, agentDir, sessionManager: SessionManager.create(cwd, sessionDir) },
	);
	async function bind() {
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
	}
	runtime.setRebindSession(bind);
	await bind();

	// Open a Pi episode + stage a handoff through the real observer/SDK.
	faux.setResponses([() => fauxAssistantMessage("ready")]);
	await runtime.session.prompt("C3 campaign session continuity.");
	faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("aegis_switch_session", { reason: "settle boundary" })]),
		() => fauxAssistantMessage("staged"),
	]);
	await runtime.session.prompt("Please hand over to a fresh session.");
	const episodeId = Object.keys(projectState(readEvents(eventLogPath)).episodes)[0];
	check("a Pi episode was opened", typeof episodeId === "string", JSON.stringify(episodeId));
	check("a handoff was staged", existsSync(handoffPath));

	// Build a real Campaign Host over the SAME event log, with a synthetic worker
	// and oracle (C3 session wiring is what is under test here).
	const validation = validateManifest({
		schema_version: "campaign-1.0",
		campaign_id: "campaign-c3-session",
		revision: 1,
		created_at: "2026-01-01T00:00:00Z",
		title: "C3 session wiring",
		objective: { description: "rotate once", success_criteria: ["noop"], stage_policy: "declared_only" },
		worker: { provider: "fixture", model: "deterministic-no-model" },
		authorization: {
			execution_profile: "supervised-macos-workspace",
			workspace_root: workspaceRoot,
			allowed_targets: ["state.json"],
			allowed_capabilities: ["noop"],
			network: "disabled",
			credentials: "none",
			human_approval: "campaign_grant",
			workspace_is_sandbox: false,
		},
		budget: { wall_time_ms: 60000, model_requests: 10, tool_calls: 20, task_count: 1, session_count: 2 },
		session_policy: {
			max_requests_per_session: 10,
			max_context_chars: 8000,
			rotate_at_stage_boundary: true,
			rotate_on_model_request: true,
			allow_model_handoff_request: true,
		},
		adapters: { execution: "workspace.exec.v1", oracle: "fixture.oracle.v1", report: "aegis-acceptance.v1" },
		tasks: [
			{
				task_id: "task-c3-session",
				order: 1,
				depends_on: [],
				target_ref: "state.json",
				task_type: "observe",
				scope: { environment_fingerprint: "fixture-env", domain: "fixture" },
				goal: { goal_id: "noop", description: "noop", success_criteria: ["noop"] },
				stages: [{ stage_id: "stage-noop", criteria: ["noop"], required: true }],
				oracle_ref: "fixture.oracle.v1",
				task_budget: { wall_time_ms: 10000, model_requests: 2, tool_calls: 4 },
			},
		],
		evidence_policy: { independent_result_required: true, unknown_is_not_failure: true, promote_experience: false },
	});
	assert.equal(validation.ok, true, validation.reasons?.join("; "));
	const manifest = validation.manifest;

	const sinkLog = new EventLog(eventLogPath);
	const opened = await sinkLog.open();
	assert.equal(opened.ok, true, opened.error);
	const sink = {
		async append(event) {
			return sinkLog.append({
				event_type: event.event_type,
				episode_id: event.episode_id ?? null,
				payload: event.payload ?? {},
				source: event.source,
			});
		},
		replay: () => sinkLog.replay(),
	};

	// The C2 controller adapter: the Host calls THIS, which delegates to the real
	// accepted supervisor. `rotateCalls` proves the real entry was used.
	let rotateCalls = 0;
	const baseBudget = {
		limit: { wall_time_ms: 600000, model_requests: 100, tool_calls: 200, session_count: 1 },
		consumed: { wall_time_ms: 0, model_requests: 0, tool_calls: 0, session_count: 0 },
		max_requests_per_session: 10,
	};
	function makeSupervisor(budget) {
		return createSessionSupervisor({ eventLogPath, handoffPath, runtime, taskId: process.env.AEGIS_TASK_ID, budget });
	}
	const controller = {
		committedRotations: () => committedRotations(readEvents(eventLogPath), episodeId),
		canRotate: () => makeSupervisor(baseBudget).canRotate(),
		rotate: (opts) => {
			rotateCalls += 1;
			return makeSupervisor(baseBudget).rotate(opts);
		},
	};

	const host = createCampaignHost({
		manifest,
		ownedTasks: manifest.tasks,
		baseDir: join(base, "runtime"),
		workspaceRoot,
		sink,
		worker: {
			async run() {
				return { ok: true, outcome_ref: "artifact:task-c3-session" };
			},
		},
		oracle: {
			async judge() {
				return { status: "unknown", failure_mode: "noop_worker", task_oracle: true, outcome_id: "o-noop" };
			},
			async reconcile() {
				return { status: "unknown", failure_mode: "noop_worker" };
			},
		},
		sessionController: controller,
	});

	// ---- the Host really calls the C2 entry ---------------------------------
	faux.setResponses([() => fauxAssistantMessage("continued")]);
	const before = runtime.session;
	const createdBefore = creations;
	const rotation = await host.rotateSession({ reason: "c3 host settle" });
	check("the Host invoked the real C2 supervisor", rotateCalls === 1);
	check("the real rotation applied", rotation.applied === true, JSON.stringify(rotation));
	check("a genuinely NEW AgentSession was created", runtime.session !== before);
	check("exactly one new runtime session was created", creations === createdBefore + 1);
	check(
		"rotation charged exactly one session generation",
		rotation.session_charges.delta === 1,
		JSON.stringify(rotation.session_charges),
	);

	// ---- the same Pi episode survived ---------------------------------------
	const afterState = projectState(readEvents(eventLogPath));
	check(
		"the SAME Pi episode survived the rotation",
		Object.keys(afterState.episodes).length === 1 && afterState.episodes[episodeId]?.status === "open",
		JSON.stringify(Object.keys(afterState.episodes)),
	);

	// ---- the Host ledger charges exactly once -------------------------------
	const ledger = host.budgetLedger();
	check(
		"the Host ledger reports one committed rotation",
		ledger.sessions_committed === 1,
		JSON.stringify(ledger.sessions_committed),
	);
	check(
		"the ledger consumed session_count is exactly 1",
		ledger.consumed.session_count === 1,
		JSON.stringify(ledger.consumed),
	);
	check("the ledger names the single charge owner", ledger.charge_owner === "campaign_host");
	check(
		"the ledger marks tokens/currency as unobservable",
		ledger.unobservable.includes("tokens") && ledger.unobservable.includes("currency"),
	);

	// ---- exhausted budget refuses a second rotation -------------------------
	// The supervisor's session limit is 1 and one rotation already committed;
	// a second rotation must be refused with no new session and no extra charge.
	const beforeSecond = runtime.session;
	const createdBeforeSecond = creations;
	faux.setResponses([() => fauxAssistantMessage("unexpected")]);
	const second = await host.rotateSession({ reason: "second" });
	check("an exhausted session budget refuses the second rotation", second.applied === false, JSON.stringify(second));
	check("the runtime was NOT replaced on refusal", runtime.session === beforeSecond);
	check("no extra session was created on refusal", creations === createdBeforeSecond);
	check("the ledger still reports one charge", host.budgetLedger().consumed.session_count === 1);

	await sinkLog.close();
	await runtime.dispose();
	runtime = undefined;
} finally {
	if (runtime) await runtime.dispose();
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
	console.log(`campaign C3 session entry: ${failures} failure(s)`);
	process.exit(1);
}
console.log("campaign C3 session entry: all assertions passed");
