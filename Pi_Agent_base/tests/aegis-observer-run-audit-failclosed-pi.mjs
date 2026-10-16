// Aegis — REAL Pi/faux negative test: `/aegis run` must FAIL CLOSED when the
// append-only audit log is unavailable.
//
// This is the run-specific integration negative that `OVERNIGHT_G_REPORT.md` §4
// item 2 left open ("the guard is code-reviewed, not separately executed"). It
// is deliberately NOT a "the command returned text X" test. It proves, by real
// side effects on disk and by the immutable committed log, that:
//
//   * the trusted setup really WOULD execute the registered action: the SAME
//     committed log + active Experience + verified state route `direct`;
//   * a library-level `run` through the SAME engine/broker/registration really
//     DOES execute the registered script and write its post-state;
//   * the exact same `/aegis run` command, over a byte-identical copy of that
//     committed log whose append/fsync boundary is unwritable, does NOT execute
//     the broker/script: no sentinel, no post-state, no append at all, and no
//     fabricated `action.completed` / `outcome.recorded` / `experience.run`.
//
// How the audit is made unavailable while still READABLE (so the active
// Experience loads and the route is genuinely direct): the seeded log is copied,
// the copy is chmod'ed read-only (0o444). `EventLog.open()` can still read and
// verify the chain (so `log.replay()` returns the committed rows), but the first
// `append` cannot open the append handle (EACCES) — the honest "cannot be
// opened for durable append" case. Nothing in Pi core or the Aegis runtime is
// modified; the fault is injected purely with filesystem permissions.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-observer-run-audit-failclosed-pi.mjs

import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { ActionRegistry, createActionBroker } from "../execution/action-contract.mjs";
import { createScriptRegistry, executableDigest, scriptContracts } from "../execution/script-registry.mjs";
import { createEvidenceResolver } from "../memory/evidence-resolver.mjs";
import { buildProductionResolver, createLearningBridge, loadReplayAdapter } from "../memory/learning-bridge.mjs";
import * as learningCommands from "../memory/learning-commands.mjs";
import { createLearningStore } from "../memory/learning-store.mjs";
import { createWorkflowEngine } from "../orchestration/workflow-engine.mjs";
import { digest, EventLog } from "../shared/events.mjs";

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
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

const SRC = {
	runtime: { actor_id: "aegis-runtime", kind: "runtime", adapter: "h-run-neg", version: "1.0.0" },
	oracle: { actor_id: "registered-stage-oracle", kind: "oracle", adapter: "json-post-state", version: "1.0.0" },
};

// The registered script writes a `.ran` sentinel BEFORE it reads any input, so
// the file's presence proves the OS process was actually spawned; its absence
// proves the broker never executed the script (not merely that it failed).
const STAGE_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";
const [inputPath, outPath] = process.argv.slice(2);
writeFileSync(outPath + ".ran", "ran");
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const post = { stage: "done", token: input.token, applied: input.token, from: input.stage };
writeFileSync(outPath, JSON.stringify(post));
process.stdout.write(JSON.stringify({ ok: true, out: outPath }) + "\\n");
`;

/**
 * Pre-seed a COMMITTED event log with two real registered-script runs and their
 * genuine isolated replays (the trusted proof writer), then compile the active
 * Experience through the exact library the `/aegis compile` command calls and
 * append the authoritative `experience.compiled` note in the Observer's shape.
 *
 * Returns the committed ids + the trusted registry/broker/environment so the
 * caller can independently route/run over the SAME truth.
 */
async function seedActiveExperience({
	workspaceRoot,
	environment,
	registration,
	loadedReplay,
	eventLogPath,
	experienceDir,
}) {
	const scriptRegistry = createScriptRegistry({ scripts: [registration] });
	const contract = scriptContracts(scriptRegistry)[0];
	const registry = new ActionRegistry([contract]);
	const broker = createActionBroker({ registry });
	const log = new EventLog(eventLogPath);
	await log.open();
	const runEngine = createWorkflowEngine({
		registry,
		broker,
		resolver: createEvidenceResolver({ events: [] }),
		environment,
		authorization: { mode: "auto", workspaceRoot, allowedTools: ["aegis_script"], allowNetwork: false, approved: true },
	});

	const outcomes = [];
	for (const i of [0, 1]) {
		const epId = `ep-${i}`;
		const runId = `run-${i}`;
		const outId = `out-${i}`;
		const group = `group-${i}`;
		const isolation = `reset-${i}`;
		const dataRef = { ref_type: "data", ref_id: `data-${i}` };
		const actionRef = { ref_type: "action", ref_id: contract.id };
		const preState = { stage: "start", token: "shared" };
		const taskArg = { input: `${i}-in.json`, out: `${i}-out.json` };
		await log.append({
			event_type: "episode.started",
			episode_id: epId,
			payload: { task_id: "task-E2E", goal: "advance the staged fixture" },
			source: SRC.runtime,
		});
		await log.append({
			event_type: "runtime.note",
			episode_id: epId,
			payload: {
				kind: "episode.isolated_reset",
				isolation_ref: isolation,
				independence_group: group,
				run_id: runId,
				adapter: "h-run-neg",
			},
			source: SRC.runtime,
		});
		await log.append({
			event_type: "runtime.note",
			episode_id: epId,
			payload: { kind: "data.obtained", data_ref: dataRef, content_digest: digest(preState) },
			source: SRC.runtime,
		});
		await log.append({
			event_type: "runtime.note",
			episode_id: epId,
			payload: {
				kind: "data.obtained",
				data_ref: { ref_type: "data", ref_id: `state-${i}` },
				value: { token: "shared" },
			},
			source: SRC.runtime,
		});
		await log.append({
			event_type: "action.requested",
			episode_id: epId,
			payload: {
				action_id: `act-${i}`,
				action_ref: contract.id,
				version: contract.version,
				implementation_digest: contract.implementation_digest,
				tool_name: contract.tool,
				run_id: runId,
				bound_arguments: [dataRef],
			},
			source: SRC.runtime,
		});

		// A REAL execution through the registered broker (no re-implementation).
		const invoked = await runEngine.invokeExploratory({
			action_ref: contract.id,
			arguments: taskArg,
			context: { workspaceRoot, target_path: join(workspaceRoot, `${i}-in.json`) },
			episodeId: epId,
			currentState: preState,
		});
		check(
			`seeded run ${i} runs the registered script and the Oracle confirms success`,
			invoked.status === "success",
			JSON.stringify({ status: invoked.status, reason: invoked.verification?.reasons }),
		);
		const post = JSON.parse(readFileSync(join(workspaceRoot, `${i}-out.json`), "utf8"));
		const artifactValueDigest = digest(post);
		const artifactRef = { ref_type: "artifact", ref_id: `art-${i}`, digest: artifactValueDigest };
		await log.append({
			event_type: "observation.captured",
			episode_id: epId,
			payload: {
				kind: "observation.captured",
				value: post,
				artifact_ref: artifactRef,
				content_digest: artifactValueDigest,
				verified: invoked.status === "success",
				run_id: runId,
			},
			source: SRC.oracle,
			evidence_refs: [artifactRef],
		});
		await log.append({
			event_type: "action.completed",
			episode_id: epId,
			payload: {
				action_id: `act-${i}`,
				action_ref: contract.id,
				version: contract.version,
				implementation_digest: contract.implementation_digest,
				tool_name: contract.tool,
				run_id: runId,
			},
			source: SRC.runtime,
		});
		await log.append({
			event_type: "outcome.recorded",
			episode_id: epId,
			payload: {
				...invoked.step_outcome,
				outcome_id: outId,
				episode_id: epId,
				run_id: runId,
				level: "episode",
				status: "success",
				independent: true,
				criterion: { criterion_id: "stage-done", path: "stage", op: "eq", value: "done" },
				observed: { ...post, pre_state: preState, token: "shared", arguments: taskArg },
				oracle: {
					oracle_id: "registered-stage-oracle",
					method: "independent_json_state_rehash",
					version: "1.0.0",
					independence_group: group,
					isolation_ref: isolation,
				},
				expect: [{ path: "stage", op: "eq", value: "done" }],
				when: [{ path: "token", op: "eq", value: "shared", verified_by: [outId] }],
				preconditions_verified: true,
				action_ref: contract.id,
				action_version: contract.version,
				implementation_digest: contract.implementation_digest,
				evidence_refs: [dataRef, actionRef, artifactRef],
				scope: { ...environment },
				transport: invoked.transport,
			},
			source: SRC.oracle,
			evidence_refs: [dataRef, actionRef, artifactRef],
		});
		outcomes.push(outId);

		// A genuine isolated replay record produced by the REAL configured adapter.
		const replayBridge = createLearningBridge({
			events: log.replay(),
			registry,
			broker,
			resolver: buildProductionResolver({ events: log.replay(), supersededOutcomeIds: [] }),
			authorization: {
				mode: "auto",
				workspaceRoot,
				allowedTools: ["aegis_script"],
				allowNetwork: false,
				approved: true,
			},
			environment,
			replayAdapter: loadedReplay.adapter,
			sink: { append: (row) => log.append(row) },
		});
		const replayed = await replayBridge.replayOutcome({ outcomeId: outId, episodeId: epId });
		check(
			`seeded run ${i} replays through the real isolated adapter`,
			replayed.ok === true && replayed.isolated === true,
			JSON.stringify({ ok: replayed.ok, reason: replayed.reason }),
		);
	}

	// Compile the active Experience through the EXACT library the command calls,
	// over the just-committed proofs, then append the authoritative note the
	// Observer's `/aegis compile` would append (same shape + runtime source).
	const store = createLearningStore({ dir: experienceDir });
	const compileBridge = createLearningBridge({
		events: log.replay(),
		registry,
		broker,
		resolver: buildProductionResolver({ events: log.replay(), supersededOutcomeIds: [] }),
		authorization: { mode: "auto", workspaceRoot, allowedTools: ["aegis_script"], allowNetwork: false, approved: true },
		environment,
	});
	const templates = Object.fromEntries(outcomes.map((id) => [id, { input: null, out: null }]));
	const compiled = await learningCommands.compile({
		proofIds: outcomes,
		bridge: compileBridge,
		store,
		argumentsTemplates: templates,
		existingExperiences: [],
		experienceId: "exp-active",
		revision: 1,
		recordedAt: new Date().toISOString(),
	});
	check(
		"the seeded active Experience compiles from two independent replayed proofs",
		compiled.active === true && compiled.experience?.status === "active",
		JSON.stringify({ status: compiled.status, failures: compiled.failures, gaps: compiled.gaps }),
	);
	await log.append({
		event_type: "runtime.note",
		payload: {
			kind: "experience.compiled",
			status: compiled.status,
			active: compiled.active,
			experience_id: compiled.experience?.experience_id ?? null,
			revision: compiled.experience?.revision ?? null,
			source_outcome_ids: outcomes,
			content_digest: compiled.content_digest ?? null,
			stored: compiled.stored,
			failures: compiled.failures,
			gaps: compiled.gaps,
		},
		source: SRC.runtime,
	});
	await log.close();

	const stateValue = { token: "shared" };
	const stateRef = { ref_type: "data", ref_id: "state-0", digest: digest(stateValue) };
	return { contract, registry, broker, store, outcomes, stateValue, stateRef, templates };
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-run-audit-closed-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	const eventLog = join(base, "events.jsonl");
	const ramDir = join(base, "ram");
	const experienceDir = join(base, "experiences");
	const scriptConfigPath = join(base, "scripts.mjs");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	const workspaceRoot = cwd;
	const scriptPath = join(base, "stage.mjs");
	writeFileSync(scriptPath, STAGE_SCRIPT);
	for (const i of [0, 1]) writeFileSync(join(cwd, `${i}-in.json`), JSON.stringify({ stage: "start", token: "shared" }));

	const environment = {
		environment_fingerprint: "local-workspace",
		domain: "script.stage",
		permissions: ["workspace-script"],
		task_types: [],
	};
	const registration = {
		schema_version: "1.0",
		id: "stage-advance",
		version: 1,
		executable: process.execPath,
		executable_digest: executableDigest(process.execPath),
		script_path: scriptPath,
		script_digest: executableDigest(scriptPath),
		argv_template: [scriptPath, "{input}", "{out}"],
		allowed_root: workspaceRoot,
		cwd: workspaceRoot,
		parameters: {
			input: { type: "string", required: true, direction: "in" },
			out: { type: "string", required: true, direction: "out" },
		},
		environment_fingerprint: environment.environment_fingerprint,
		domain: environment.domain,
		permissions: [...environment.permissions],
		task_types: [...environment.task_types],
		independence_group: null,
		verify: ({ observed }) => {
			const outPath = observed?.resource_bindings?.out;
			if (!outPath) return { ok: false, reason: "no bound output path to re-read" };
			let post;
			try {
				post = JSON.parse(readFileSync(outPath, "utf8"));
			} catch (error) {
				return {
					ok: false,
					reason: `could not re-read the JSON post-state: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			if (post.stage !== "done") return { ok: false, reason: `post-state stage is ${post.stage}`, observed: post };
			return {
				ok: true,
				reason: "independent JSON post-state re-read agrees",
				expected: { stage: "done" },
				observed: post,
			};
		},
	};
	// The registry needs a REAL verify() Oracle, which JSON cannot carry.
	writeFileSync(
		scriptConfigPath,
		`import { readFileSync } from "node:fs";
export const scripts = [
	{
		schema_version: "1.0",
		id: ${JSON.stringify(registration.id)},
		version: ${registration.version},
		executable: ${JSON.stringify(process.execPath)},
		executable_digest: ${JSON.stringify(registration.executable_digest)},
		script_path: ${JSON.stringify(scriptPath)},
		script_digest: ${JSON.stringify(registration.script_digest)},
		argv_template: ${JSON.stringify(registration.argv_template)},
		allowed_root: ${JSON.stringify(workspaceRoot)},
		cwd: ${JSON.stringify(workspaceRoot)},
		parameters: ${JSON.stringify(registration.parameters)},
		environment_fingerprint: ${JSON.stringify(environment.environment_fingerprint)},
		domain: ${JSON.stringify(environment.domain)},
		permissions: ${JSON.stringify(environment.permissions)},
		task_types: ${JSON.stringify(environment.task_types)},
		verify: ({ observed }) => {
			const outPath = observed?.resource_bindings?.out;
			if (!outPath) return { ok: false, reason: "no bound output path to re-read" };
			let post;
			try { post = JSON.parse(readFileSync(outPath, "utf8")); }
			catch (error) { return { ok: false, reason: "could not re-read the JSON post-state: " + error.message }; }
			if (post.stage !== "done") return { ok: false, reason: "post-state stage is " + post.stage, observed: post };
			return { ok: true, reason: "independent JSON post-state re-read agrees", expected: { stage: "done" }, observed: post };
		},
	},
];
`,
	);

	const adapterPath = join(base, "replay-adapter.mjs");
	writeFileSync(
		adapterPath,
		`import { createHash } from "node:crypto";
function stable(value) {
	if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
	if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
	return JSON.stringify(value);
}
const digest = (v) => "sha256:" + createHash("sha256").update(stable(v)).digest("hex");
export const replayAdapter = {
	id: "h-run-neg-readonly",
	isolated: true,
	replay({ priorPreState, arguments: args, contract, criterion }) {
		const post = { stage: "done", token: priorPreState.token, applied: args?.input ?? null };
		const ok = post.stage === criterion.value;
		return {
			ok, isolated: true, isolation_ref: "fresh-" + (args?.input ?? "reset"), action_ref: contract.id,
			implementation_digest: contract.implementation_digest,
			arguments_digest: digest(args),
			pre_state_digest: digest(priorPreState),
			post_state_digest: digest(post),
			criterion_verified: ok, replay_count: 1, replay_hash: digest({ post, ok }),
		};
	}
};
`,
	);
	const loadedReplay = await loadReplayAdapter(adapterPath);

	const seeded = await seedActiveExperience({
		workspaceRoot,
		environment,
		registration,
		loadedReplay,
		eventLogPath: eventLog,
		experienceDir,
	});

	// -------------------------------------------------------------------------
	// Positive control: the SAME engine/broker/registration really DOES execute.
	// `learningCommands.run` is exactly what `/aegis run` calls after its audit
	// guard, so this proves the negative below is not "the action was wrong".
	// -------------------------------------------------------------------------
	const posIn = join(workspaceRoot, "pos-in.json");
	const posOut = join(workspaceRoot, "pos-out.json");
	writeFileSync(posIn, JSON.stringify({ stage: "start", token: "shared" }));
	if (existsSync(posOut)) rmSync(posOut, { force: true });
	if (existsSync(`${posOut}.ran`)) rmSync(`${posOut}.ran`, { force: true });
	const posBridge = createLearningBridge({
		events: readEvents(eventLog),
		registry: seeded.registry,
		broker: seeded.broker,
		authorization: { mode: "auto", workspaceRoot, allowedTools: ["aegis_script"], allowNetwork: false, approved: true },
		environment,
	});
	const posRun = await learningCommands.run({
		store: seeded.store,
		bridge: posBridge,
		task: { task_id: "task-E2E", arguments: { input: "pos-in.json", out: "pos-out.json" } },
		currentState: seeded.stateValue,
		currentStateRef: seeded.stateRef,
		context: { workspaceRoot, target_path: posIn },
		approved: true,
	});
	check(
		"positive control: the registered action executes through the SAME engine and writes its sentinel + post-state",
		posRun.ok === true &&
			existsSync(`${posOut}.ran`) &&
			existsSync(posOut) &&
			JSON.parse(readFileSync(posOut, "utf8")).stage === "done",
		JSON.stringify({
			ok: posRun.ok,
			reason: posRun.reason,
			sentinel: existsSync(`${posOut}.ran`),
			post: existsSync(posOut),
		}),
	);

	// -------------------------------------------------------------------------
	// Negative setup: a byte-identical copy of the committed log whose APPEND
	// boundary is unwritable (readable, so the active Experience still loads).
	// -------------------------------------------------------------------------
	const blockedLog = join(base, "blocked-events.jsonl");
	copyFileSync(eventLog, blockedLog);
	const blockedBytesBefore = readFileSync(blockedLog);
	chmodSync(blockedLog, 0o444);
	const blockedExpDir = join(base, "blocked-experiences");
	cpSync(experienceDir, blockedExpDir, { recursive: true });

	// (a) The construction is honest: the copy VERIFIES + loads its rows, yet an
	// append/fsync to it fails. This is the "EventLog cannot be opened for append"
	// case, not a fake.
	const probe = new EventLog(blockedLog);
	const probeOpen = await probe.open();
	const probeAppend = await probe.append({ event_type: "runtime.note", payload: { kind: "unreachable-probe" } });
	check(
		"the blocked log opens + verifies (rows load) but a durable append FAILS",
		probeOpen.ok === true && probe.replay().length > 0 && probeAppend.ok === false,
		JSON.stringify({ open: probeOpen.ok, rows: probe.replay().length, append: probeAppend }),
	);

	// (b) Non-vacuity: over the byte-identical blocked copy + active store, the
	// SAME task/state routes `direct` — so the only thing that can stop the run is
	// the audit boundary, not a failed route.
	const blockedEvents = readEvents(blockedLog);
	const blockedStore = createLearningStore({ dir: blockedExpDir });
	const blockedBridge = createLearningBridge({
		events: blockedEvents,
		registry: seeded.registry,
		broker: seeded.broker,
		authorization: { mode: "auto", workspaceRoot, allowedTools: ["aegis_script"], allowNetwork: false, approved: true },
		environment,
	});
	const blockedRoute = await learningCommands.route({
		store: blockedStore,
		bridge: blockedBridge,
		task: { task_id: "task-E2E", arguments: { input: "neg-in.json", out: "neg-out.json" } },
		currentState: seeded.stateValue,
		currentStateRef: seeded.stateRef,
	});
	check(
		"over the blocked-log copy the SAME active Experience still routes DIRECT (the negative is not a route failure)",
		blockedRoute.route === "direct",
		JSON.stringify({ route: blockedRoute.route, reason: blockedRoute.reason }),
	);

	// -------------------------------------------------------------------------
	// Negative: drive the REAL `/aegis run` command over the unwritable log.
	// -------------------------------------------------------------------------
	process.env.AEGIS_EVENT_LOG = blockedLog;
	process.env.AEGIS_RAM_DIR = ramDir;
	process.env.AEGIS_HANDOFF_FILE = join(ramDir, "handoff.json");
	process.env.AEGIS_ROM_FILE = join(BASE_DIR, "agent", "ROM.md");
	process.env.AEGIS_TASK_ID = "task-E2E";
	process.env.AEGIS_EXPERIENCE_DIR = blockedExpDir;
	process.env.AEGIS_SCRIPT_CONFIG = scriptConfigPath;
	process.env.AEGIS_WORKSPACE = workspaceRoot;
	process.env.AEGIS_ACTION_MODE = "auto";
	process.env.AEGIS_ENVIRONMENT_FINGERPRINT = environment.environment_fingerprint;
	process.env.AEGIS_DOMAIN = environment.domain;
	delete process.env.AEGIS_REPLAY_ADAPTER;
	process.env.AEGIS_CONTEST_MODE = "off";
	process.env.AEGIS_CONTEST_CARDS = "";
	process.env.AEGIS_CONTEST_LOG = join(base, "contest.jsonl");

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-run-closed", name: "FauxRunClosed" }] });
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(base, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, makeFauxModelDetails(model));

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
	check("observer extension loads over the unwritable log", loaded.errors.length === 0, JSON.stringify(loaded.errors));

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
	await session.bindExtensions({
		commandContextActions: {
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: true }),
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			reload: async () => {},
		},
	});

	const negIn = join(workspaceRoot, "neg-in.json");
	const negOut = join(workspaceRoot, "neg-out.json");
	writeFileSync(negIn, JSON.stringify({ stage: "start", token: "shared" }));
	if (existsSync(negOut)) rmSync(negOut, { force: true });
	if (existsSync(`${negOut}.ran`)) rmSync(`${negOut}.ran`, { force: true });

	const stateJson = JSON.stringify(seeded.stateValue);
	const stateRefJson = JSON.stringify(seeded.stateRef);
	await session.prompt(
		`/aegis run --args ${JSON.stringify({ input: "neg-in.json", out: "neg-out.json" })} --state ${stateJson} --state-ref ${stateRefJson}`,
	);

	// The run must NOT have spawned the script (sentinel proves spawn) and must
	// NOT have written the post-state.
	check(
		"the would-be run's registered script did NOT spawn (no `.ran` sentinel)",
		!existsSync(`${negOut}.ran`),
		`${negOut}.ran`,
	);
	check("the would-be run's post-state file was NOT created", !existsSync(negOut), negOut);

	// No audit row may have been appended at all: the bytes are identical to the
	// pre-run copy. (This is the "no fabricated evidence" assertion, not text.)
	const blockedBytesAfter = readFileSync(blockedLog);
	check(
		"the unwritable audit log is byte-identical after the refused run (no append, no fabricated row)",
		Buffer.compare(blockedBytesBefore, blockedBytesAfter) === 0,
		`before=${blockedBytesBefore.length} after=${blockedBytesAfter.length}`,
	);

	const blockedBefore = blockedEvents;
	const afterEvents = readEvents(blockedLog);
	const countOf = (events, predicate) => events.filter(predicate).length;
	const fabricatedRunIntent = countOf(
		afterEvents,
		(e) => e.event_type === "action.requested" && e.payload?.tool_name === "aegis_run",
	);
	const fabricatedRunCompleted = countOf(
		afterEvents,
		(e) => e.event_type === "action.completed" && e.payload?.tool_name === "aegis_run",
	);
	const fabricatedOutcome = countOf(
		afterEvents,
		(e) => e.event_type === "outcome.recorded" && e.payload?.action_ref === seeded.contract.id,
	);
	const fabricatedRunNote = countOf(afterEvents, (e) => e.payload?.kind === "experience.run");
	const baselineIntent = countOf(
		blockedBefore,
		(e) => e.event_type === "action.requested" && e.payload?.tool_name === "aegis_run",
	);
	const baselineCompleted = countOf(
		blockedBefore,
		(e) => e.event_type === "action.completed" && e.payload?.tool_name === "aegis_run",
	);
	const baselineOutcome = countOf(
		blockedBefore,
		(e) => e.event_type === "outcome.recorded" && e.payload?.action_ref === seeded.contract.id,
	);
	const baselineRunNote = countOf(blockedBefore, (e) => e.payload?.kind === "experience.run");
	check(
		"the refused run fabricated NO new action.requested/action.completed/outcome/experience.run success row",
		fabricatedRunIntent === baselineIntent &&
			fabricatedRunCompleted === baselineCompleted &&
			fabricatedOutcome === baselineOutcome &&
			fabricatedRunNote === baselineRunNote,
		JSON.stringify({
			intent: [baselineIntent, fabricatedRunIntent],
			completed: [baselineCompleted, fabricatedRunCompleted],
			outcomes: [baselineOutcome, fabricatedOutcome],
			runNotes: [baselineRunNote, fabricatedRunNote],
		}),
	);

	await session.dispose();
	faux.unregister();
	rmSync(base, { recursive: true, force: true });

	console.log("");
	if (failures > 0) {
		console.error(`aegis-observer-run-audit-failclosed-pi FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-observer-run-audit-failclosed-pi ok");
}

main().catch((error) => {
	console.error(
		`aegis-observer-run-audit-failclosed-pi: ${error instanceof Error ? error.stack || error.message : String(error)}`,
	);
	process.exitCode = 1;
});
