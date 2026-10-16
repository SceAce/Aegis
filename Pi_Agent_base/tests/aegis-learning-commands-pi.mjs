// Aegis Batch E — product-level test of the controlled `/aegis learn|compile|
// route|run|replay` commands through the REAL Pi SDK.
//
// This is the item-6 "product-level real Pi faux verification": a real Pi
// session with the observer extension loaded, driven by `/aegis ...` command
// prompts, over a PRE-SEEDED committed event log (the same committed rows a
// restarted process would read). It proves the command surface wires the
// already-tested library honestly:
//
//   * `/aegis learn <json>` binds a complete proposal but records it as a
//     CANDIDATE (never active, never executed).
//   * `/aegis compile --proof <id> ...` imports ONLY the named committed proof
//     ids; two independent resolved proofs reach ACTIVE (and the derived store
//     is written); a single proof stays a CANDIDATE.
//   * `/aegis route` uses the active Experience + the committed, currently-valid
//     state; with no verified state it never routes direct.
//   * `/aegis replay` with NO configured adapter is refused (no fabricated
//     isolation record); with a configured isolated adapter it commits a real
//     durable replay.
//   * `/aegis run` executes the registered broker through the confirmed direct
//     Experience with 0 model calls, and the Oracle confirms the post-state.
//
// The proof writer is the trusted Runtime/Oracle (the pre-seeded committed
// rows); the model proposes nothing here. No network is used.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-learning-commands-pi.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
	buildProductionResolver,
	createLearningBridge,
	loadReplayAdapter,
	proofFromOutcome,
} from "../memory/learning-bridge.mjs";
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
	runtime: { actor_id: "aegis-runtime", kind: "runtime", adapter: "e-product", version: "1.0.0" },
	oracle: { actor_id: "registered-stage-oracle", kind: "oracle", adapter: "json-post-state", version: "1.0.0" },
};

const STAGE_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";
const [inputPath, outPath] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const post = { stage: "done", token: input.token, applied: input.token, from: input.stage };
writeFileSync(outPath, JSON.stringify(post));
process.stdout.write(JSON.stringify({ ok: true, out: outPath }) + "\\n");
`;

/**
 * Pre-seed a COMMITTED event log with two real registered-script runs (distinct
 * episodes/resets/outcomes) plus a resolver-verified current state. Returns the
 * ids the commands will name. This is the trusted proof writer, not the model.
 */
async function seedCommittedLog({ base, workspaceRoot, environment, registration, loadedReplay }) {
	const scriptRegistry = createScriptRegistry({ scripts: [registration] });
	const contract = scriptContracts(scriptRegistry)[0];
	const registry = new ActionRegistry([contract]);
	const broker = createActionBroker({ registry });
	const log = new EventLog(join(base, "events.jsonl"));
	await log.open();
	// The runner engine uses a vacuous resolver (execution needs no proofs); the
	// real broker is the only executor.
	const runEngine = createWorkflowEngine({
		registry,
		broker,
		resolver: createEvidenceResolver({ events: [] }),
		environment,
		authorization: { mode: "auto", workspaceRoot, allowedTools: ["aegis_script"], allowNetwork: false, approved: true },
	});

	const ids = { outcomes: [], stateRef: null, contract, registry, broker };
	for (const i of [0, 1, 2]) {
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
				adapter: "e-product",
			},
			source: SRC.runtime,
		});
		await log.append({
			event_type: "runtime.note",
			episode_id: epId,
			payload: { kind: "data.obtained", data_ref: dataRef, content_digest: digest(preState) },
			source: SRC.runtime,
		});
		const stateRef = { ref_type: "data", ref_id: `state-${i}` };
		await log.append({
			event_type: "runtime.note",
			episode_id: epId,
			payload: { kind: "data.obtained", data_ref: stateRef, value: { token: "shared" } },
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
		ids.outcomes.push(outId);
		if (i === 0) ids.stateRef = stateRef;

		// A genuine isolated replay record is produced by the REAL configured
		// adapter (fresh bridge over the now-committed rows), not a hand-written
		// note. This is what the compiler's replay_proof rule resolves. `out-2`
		// is left WITHOUT a replay so the `/aegis replay` command can be proven to
		// commit a NEW record against a fresh outcome.
		if (i !== 2) {
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
	}
	await log.close();
	// Expose a trusted current-state ref the command surface can pin `when` to.
	ids.stateValue = { token: "shared" };
	ids.stateRef = { ref_type: "data", ref_id: "state-0", digest: digest(ids.stateValue) };
	return ids;
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-learning-cmd-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	const eventLog = join(base, "events.jsonl");
	const ramDir = join(base, "ram");
	const handoffFile = join(ramDir, "handoff.json");
	const experienceDir = join(base, "experiences");
	const scriptConfigPath = join(base, "scripts.mjs");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	const workspaceRoot = cwd;
	const scriptPath = join(base, "stage.mjs");
	writeFileSync(scriptPath, STAGE_SCRIPT);
	for (const i of [0, 1, 2])
		writeFileSync(join(cwd, `${i}-in.json`), JSON.stringify({ stage: "start", token: "shared" }));

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
	// The registry needs a REAL verify() Oracle, which JSON cannot carry; write a
	// module that supplies the function. (A JSON file would silently drop it and
	// the runtime would refuse the registration — the honest fail-safe.)
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

	// A configured isolated replay adapter module (human-written, imported as a
	// module — never eval'd, never a model string).
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
	id: "e-product-readonly",
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

	// Seed the committed log BEFORE the session starts (the trusted proof writer).
	const seeded = await seedCommittedLog({ base, workspaceRoot, environment, registration, loadedReplay });

	// Environment for the observer extension.
	process.env.AEGIS_EVENT_LOG = eventLog;
	process.env.AEGIS_RAM_DIR = ramDir;
	process.env.AEGIS_HANDOFF_FILE = handoffFile;
	process.env.AEGIS_ROM_FILE = join(BASE_DIR, "agent", "ROM.md");
	process.env.AEGIS_TASK_ID = "task-E2E";
	process.env.AEGIS_EXPERIENCE_DIR = experienceDir;
	process.env.AEGIS_SCRIPT_CONFIG = scriptConfigPath;
	process.env.AEGIS_WORKSPACE = workspaceRoot;
	process.env.AEGIS_ACTION_MODE = "auto";
	process.env.AEGIS_ENVIRONMENT_FINGERPRINT = environment.environment_fingerprint;
	process.env.AEGIS_DOMAIN = environment.domain;
	delete process.env.AEGIS_REPLAY_ADAPTER; // start unconfigured
	process.env.AEGIS_CONTEST_MODE = "off";
	process.env.AEGIS_CONTEST_CARDS = "";
	process.env.AEGIS_CONTEST_LOG = join(base, "contest.jsonl");

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-e2e", name: "FauxE2E" }] });
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
	check(
		"observer extension loads with the learning commands",
		loaded.errors.length === 0,
		JSON.stringify(loaded.errors),
	);

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

	const templates = JSON.stringify({
		[seeded.outcomes[0]]: { input: null, out: null },
		[seeded.outcomes[1]]: { input: null, out: null },
	});

	// ---- 1. learn: a complete proposal is bound but stays a CANDIDATE --------
	const proposal = JSON.stringify({
		when: [{ path: "token", op: "eq", value: "shared" }],
		scope: { environment_fingerprint: environment.environment_fingerprint, domain: environment.domain },
		do: seeded.contract.id,
		arguments_template: { input: null, out: null },
	});
	await session.prompt(`/aegis learn ${proposal}`);
	let notes = readEvents(eventLog).filter(
		(e) => e.event_type === "runtime.note" && String(e.payload?.kind ?? "").startsWith("experience.candidate"),
	);
	check(
		"`/aegis learn` records a candidate note (never active)",
		notes.length === 1 && notes[0].payload.active === false && notes[0].payload.eval_used === false,
		JSON.stringify(notes[0]?.payload),
	);

	// ---- 2. compile with NO proof ids: refused, nothing active ---------------
	await session.prompt("/aegis compile");
	notes = readEvents(eventLog).filter((e) => e.payload?.kind === "experience.compiled");
	check("`/aegis compile` with no proof ids records nothing active", notes.length === 0);

	// ---- 2b. compile with INVALID --templates JSON: refused, not silently {} --
	await session.prompt(`/aegis compile --proof ${seeded.outcomes[0]} --templates {not-json --id exp-bad-templates`);
	notes = readEvents(eventLog).filter((e) => e.payload?.kind === "experience.compiled");
	check(
		"`/aegis compile` with invalid --templates JSON is REFUSED (no note written, never a silent empty template)",
		notes.length === 0,
		`compiled notes=${notes.length}`,
	);

	// ---- 3. compile with ONE committed proof: stays a CANDIDATE --------------
	await session.prompt(`/aegis compile --proof ${seeded.outcomes[0]} --templates ${templates} --id exp-single`);
	notes = readEvents(eventLog).filter((e) => e.payload?.kind === "experience.compiled");
	const single = notes[notes.length - 1];
	check(
		"`/aegis compile` with one proof stays a candidate",
		single?.payload.status === "candidate" && single?.payload.active === false,
		JSON.stringify(single?.payload),
	);

	// ---- 4. compile with TWO independent proofs: ACTIVE ----------------------
	await session.prompt(
		`/aegis compile --proof ${seeded.outcomes[0]} --proof ${seeded.outcomes[1]} --templates ${templates} --id exp-active`,
	);
	notes = readEvents(eventLog).filter((e) => e.payload?.kind === "experience.compiled");
	const active = notes[notes.length - 1];
	check(
		"`/aegis compile` with two independent proofs reaches ACTIVE",
		active?.payload.status === "active" && active?.payload.active === true && active?.payload.stored === true,
		JSON.stringify(active?.payload),
	);
	check(
		"the active compile names exactly the committed proofs it imported",
		Array.isArray(active?.payload.source_outcome_ids) && active.payload.source_outcome_ids.length === 2,
		JSON.stringify(active?.payload.source_outcome_ids),
	);

	// ---- 4b. recompiling the SAME rule: not_copied gate fires, active survives --
	await session.prompt(
		`/aegis compile --proof ${seeded.outcomes[0]} --proof ${seeded.outcomes[1]} --templates ${templates} --id exp-active`,
	);
	notes = readEvents(eventLog).filter((e) => e.payload?.kind === "experience.compiled");
	const duplicate = notes[notes.length - 1];
	check(
		"`/aegis compile` refuses to copy an already-active do-clause (not_copied gate fires on the product path)",
		duplicate?.payload.active === false &&
			Array.isArray(duplicate?.payload.failures) &&
			duplicate.payload.failures.some((f) => f.rule === "not_copied"),
		JSON.stringify(duplicate?.payload.failures),
	);
	check(
		"the duplicate candidate compile does NOT overwrite/downgrade the stored active Experience",
		duplicate?.payload.stored === false,
		JSON.stringify({ stored: duplicate?.payload.stored }),
	);
	const activeRecord = JSON.parse(readFileSync(join(experienceDir, "exp-active.json"), "utf8"));
	check(
		"the previously-active stored projection is preserved after the duplicate compile",
		activeRecord.active === true && activeRecord.experience?.status === "active",
		JSON.stringify({ active: activeRecord.active, status: activeRecord.experience?.status }),
	);

	// ---- 5. route with no verified state: never direct -----------------------
	await session.prompt("/aegis route");
	notes = readEvents(eventLog).filter((e) => e.payload?.kind === "experience.routed");
	check(
		"`/aegis route` records a routed note with 0 model calls",
		notes.length === 1 && notes[0].payload.model_calls === 0,
		JSON.stringify(notes[0]?.payload),
	);
	check(
		"`/aegis route` with no verified state never routes direct",
		notes[0].payload.route !== "direct",
		JSON.stringify({ route: notes[0].payload.route }),
	);

	// ---- 6. replay with NO adapter: refused, no fabricated record ------------
	const replayRowsBefore = readEvents(eventLog).filter((e) => e.payload?.kind === "replay.performed").length;
	await session.prompt(`/aegis replay --outcome ${seeded.outcomes[0]}`);
	const replayRowsAfter = readEvents(eventLog).filter((e) => e.payload?.kind === "replay.performed").length;
	check(
		"`/aegis replay` with no configured adapter fabricates no NEW replay record",
		replayRowsAfter === replayRowsBefore,
		`before=${replayRowsBefore} after=${replayRowsAfter}`,
	);

	// ---- 7. replay WITH the configured adapter: commits a real record --------
	process.env.AEGIS_REPLAY_ADAPTER = adapterPath;
	await session.prompt(`/aegis replay --outcome ${seeded.outcomes[2]}`);
	const replayRowsConfigured = readEvents(eventLog).filter((e) => e.payload?.kind === "replay.performed").length;
	check(
		"`/aegis replay` with a configured isolated adapter commits a NEW resolved replay record",
		replayRowsConfigured === replayRowsBefore + 1,
		`before=${replayRowsBefore} after=${replayRowsConfigured}`,
	);

	// ---- 7b. direct route + ACTUAL broker execution through the active Experience
	// A third committed run gives the hinted missing resource params a real
	// verified state to bind against, so the route can be confirmed direct and run
	// through the registered broker (0 model calls), then the Oracle re-checks.
	const stateRefJson = JSON.stringify(seeded.stateRef);
	const stateJson = JSON.stringify(seeded.stateValue);
	// Route with the trusted committed state -> habit (missing params), then bind
	// the per-task resource params (a controlled human step) -> direct.
	await session.prompt(`/aegis route --state ${stateJson} --state-ref ${stateRefJson}`);
	notes = readEvents(eventLog).filter((e) => e.payload?.kind === "experience.routed");
	const routed2 = notes[notes.length - 1];
	check(
		"`/aegis route` with a verified committed state reaches habit (params to bind)",
		routed2?.payload.route === "habit" && routed2?.payload.state_trusted === true,
		JSON.stringify({
			route: routed2?.payload.route,
			trusted: routed2?.payload.state_trusted,
			reason: routed2?.payload.reason,
		}),
	);

	await session.prompt(
		`/aegis bind --input 2-in.json --out 2-out.json --state ${stateJson} --state-ref ${stateRefJson}`,
	);
	const bindNotes = readEvents(eventLog).filter(
		(e) => e.event_type === "runtime.note" && String(e.payload?.kind ?? "").startsWith("experience.candidate.bound"),
	);
	const bound = bindNotes[bindNotes.length - 1];
	check(
		"`/aegis bind` re-checks the missing params to a direct route",
		bound?.payload.ok === true && bound?.payload.recheck_route === "direct",
		JSON.stringify(bound?.payload),
	);

	await session.prompt(
		`/aegis run --args ${JSON.stringify({ input: "2-in.json", out: "2-out.json" })} --state ${stateJson} --state-ref ${stateRefJson}`,
	);
	const runNotes = readEvents(eventLog).filter((e) => e.payload?.kind === "experience.run");
	const ran = runNotes[runNotes.length - 1];
	check(
		"`/aegis run` executes the confirmed direct Experience with 0 model calls",
		ran?.payload.direct === true && ran?.payload.model_calls === 0,
		JSON.stringify(ran?.payload),
	);
	check(
		"the actual broker produced the post-state the Oracle independently confirmed",
		ran?.payload.ok === true,
		JSON.stringify({ ok: ran?.payload.ok, reason: ran?.payload.reason }),
	);
	const ranPost = JSON.parse(readFileSync(join(workspaceRoot, "2-out.json"), "utf8"));
	check(
		"the post-state on disk is the real registered-script output",
		ranPost.stage === "done" && ranPost.token === "shared",
		JSON.stringify(ranPost),
	);

	// ---- 7c. `/aegis run` uses the SAME side-effect audit boundary -----------
	const allEvents = readEvents(eventLog);
	const runRequested = allEvents.filter(
		(e) => e.event_type === "action.requested" && e.payload?.tool_name === "aegis_run",
	);
	const runCompleted = allEvents.filter(
		(e) => e.event_type === "action.completed" && e.payload?.tool_name === "aegis_run",
	);
	check(
		"`/aegis run` records one durable action.requested with the FINAL arguments",
		runRequested.length === 1 &&
			runRequested[0].payload.final_arguments?.input === "2-in.json" &&
			runRequested[0].payload.final_arguments?.out === "2-out.json",
		JSON.stringify(runRequested[0]?.payload?.final_arguments),
	);
	check(
		"`/aegis run` records the authorization source on the intent",
		Boolean(runRequested[0]?.payload?.authorization?.source),
		JSON.stringify(runRequested[0]?.payload?.authorization),
	);
	check(
		"`/aegis run` pins the registered version + implementation digest on the intent",
		typeof runRequested[0]?.payload?.version === "number" &&
			typeof runRequested[0]?.payload?.implementation_digest === "string" &&
			runRequested[0].payload.version === runCompleted[0]?.payload?.version &&
			runRequested[0].payload.implementation_digest === runCompleted[0]?.payload?.implementation_digest,
		JSON.stringify({
			requested: {
				version: runRequested[0]?.payload?.version,
				digest: runRequested[0]?.payload?.implementation_digest,
			},
			completed: {
				version: runCompleted[0]?.payload?.version,
				digest: runCompleted[0]?.payload?.implementation_digest,
			},
		}),
	);
	check(
		"`/aegis run` records a matching action.completed",
		runCompleted.length === 1 && runCompleted[0].payload.action_id === runRequested[0].payload.action_id,
		JSON.stringify({ requested: runRequested[0]?.payload?.action_id, completed: runCompleted[0]?.payload?.action_id }),
	);
	check(
		"the run's action.requested row precedes its action.completed row",
		allEvents.indexOf(runRequested[0]) >= 0 && allEvents.indexOf(runRequested[0]) < allEvents.indexOf(runCompleted[0]),
		JSON.stringify({ requested: allEvents.indexOf(runRequested[0]), completed: allEvents.indexOf(runCompleted[0]) }),
	);
	const runOutcome = allEvents.find(
		(e) =>
			e.event_type === "outcome.recorded" &&
			e.payload?.action_ref === seeded.contract.id &&
			e.causation_id === runRequested[0]?.payload?.action_id,
	);
	check(
		"`/aegis run` records a standard step Outcome under the registered action_ref (not just experience.run)",
		Boolean(runOutcome) &&
			typeof runOutcome.payload.outcome_id === "string" &&
			runOutcome.payload.outcome_id.length > 0,
		JSON.stringify(runOutcome?.payload?.outcome_id),
	);
	check(
		"`/aegis run` records the verified step Outcome under the trusted oracle source",
		runOutcome?.source?.kind === "oracle",
		JSON.stringify(runOutcome?.source),
	);
	const runResolver = createEvidenceResolver({ events: allEvents });
	const runProof = proofFromOutcome(runResolver, runOutcome?.payload?.outcome_id);
	check(
		"the run Outcome is resolver-visible and compiles to a proof pinned to the registered action_ref",
		runProof.ok === true && runProof.proof?.do?.action_ref === seeded.contract.id,
		JSON.stringify({ ok: runProof.ok, reason: runProof.reason, action_ref: runProof.proof?.do?.action_ref }),
	);

	// ---- cleanup handled by rmSync; report ----------------------------------
	await session.dispose?.();
	rmSync(base, { recursive: true, force: true });
	if (failures > 0) {
		console.error(`aegis-learning-commands-pi FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-learning-commands-pi ok");
}

main().catch((error) => {
	console.error(`aegis-learning-commands-pi: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
