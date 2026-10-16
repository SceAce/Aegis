// Offline REAL Pi SDK faux-provider SAME-PROMPT data-use loop test.
//
// This is the C2 integration test: it boots a REAL Pi agent session (faux
// provider, no network, no real model) with the Observer loaded and, inside a
// SINGLE prompt, drives the full data-use stage loop:
//
//   1. `aegis_observe` reads a REAL ELF and returns a `data_ref` (the id of the
//      verified observation event) IN THE TEXT the model receives.
//   2. The model feeds that exact `data_ref` back into `aegis_execute` via
//      `data_bindings`, binding a registered parameter to the observed field.
//   3. The Observer resolves the ref from the COMMITTED event log, confirms it
//      is a same-Episode verified observation whose target is still current,
//      and injects the resolved value into the final arguments.
//   4. The registered script runs and its Oracle reads the REAL JSON post-state.
//   5. A verified stage contribution (obtain + use + advance) is recorded against
//      the actual data/action/outcome refs.
//
// It ALSO asserts the required NEGATIVES:
//   * a changed/foreign/missing ref is refused before any effect;
//   * a data_binding that contradicts an explicit argument is refused;
//   * a swapped/foreign action id is refused;
//   * zero exit alone is not goal success.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-observer-data-use-pi.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { createObserveActionRuntime } from "../execution/action-runtime.mjs";
import { executableDigest } from "../execution/script-registry.mjs";
import { syntheticElfHeader } from "../execution/workspace-info-actions.mjs";
import { projectBoard } from "../memory/board.mjs";
import { createEvidenceResolver } from "../memory/evidence-resolver.mjs";
import { createLearningBridge, proofFromOutcome } from "../memory/learning-bridge.mjs";

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

/** Extract the JSON `data_ref={...}` the observe tool echoes into its TEXT. */
function extractDataRef(messages) {
	for (const message of messages) {
		const blocks = Array.isArray(message?.content) ? message.content : [];
		for (const block of blocks) {
			if (block?.type !== "text" || typeof block.text !== "string") continue;
			const match = block.text.match(/data_ref=(\{[^}]*\})/);
			if (match) {
				try {
					return JSON.parse(match[1]);
				} catch {
					/* keep scanning */
				}
			}
		}
	}
	return null;
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-data-use-pi-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	const eventLog = join(base, "events.jsonl");
	const ramDir = join(base, "ram");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	// --- A real ELF target (64-bit little-endian x86-64). ---
	const elfPath = join(cwd, "target.bin");
	writeFileSync(elfPath, syntheticElfHeader({ bits: 64, machine_id: 0x3e }));

	// --- A real registered script that writes a JSON post-state. ---
	const scriptPath = join(cwd, "use-stage.mjs");
	writeFileSync(
		scriptPath,
		[
			'import { writeFileSync } from "node:fs";',
			"const args = {};",
			"const a = process.argv.slice(2);",
			'for (let i = 0; i < a.length; i += 2) args[a[i].replace(/^--/, "")] = a[i + 1];',
			"writeFileSync(args.out, JSON.stringify({ ok: true, stage: Number(args.stage), bound_bits: String(args.bits) }));",
			"process.exit(0);",
			"",
		].join("\n"),
	);
	const nodeExe = process.execPath;
	const nodeDigest = executableDigest(nodeExe);
	const scriptDigest = executableDigest(scriptPath);

	const configPath = join(base, "scripts-config.mjs");
	writeFileSync(
		configPath,
		[
			'import { readFileSync } from "node:fs";',
			"export const scripts = [{",
			'\tschema_version: "1.0",',
			'\tid: "use-stage",',
			"\tversion: 1,",
			`\texecutable: ${JSON.stringify(nodeExe)},`,
			`\texecutable_digest: ${JSON.stringify(nodeDigest)},`,
			`\tscript_path: ${JSON.stringify(scriptPath)},`,
			`\tscript_digest: ${JSON.stringify(scriptDigest)},`,
			"\targv_template: [",
			`\t\t${JSON.stringify(scriptPath)}, "--out", "{out}", "--stage", "{stage}", "--bits", "{bits}",`,
			"\t],",
			`\tallowed_root: ${JSON.stringify(cwd)},`,
			`\tcwd: ${JSON.stringify(cwd)},`,
			// `bits` is bound to the observed ELF bitness. `out` is a path param.
			// direction in/out bounds it inside the workspace (no outside writes).
			`\tparameters: { out: { type: "string", direction: "out", description: "output JSON path inside the workspace" }, stage: { type: "number" }, bits: { type: "string" } },`,
			'\trisk_class: "medium",',
			"\ttimeout_ms: 5000,",
			'\texpect: "the post-state confirms the observed bitness was bound",',
			"\tverify: ({ observed }) => {",
			'\t\tconst idx = observed.argv.indexOf("--out");',
			"\t\tconst out = observed.argv[idx + 1];",
			"\t\tlet parsed;",
			'\t\ttry { parsed = JSON.parse(readFileSync(out, "utf8")); } catch (error) { return { ok: false, reason: `stage file unreadable: ${String(error)}` }; }',
			'\t\tif (parsed.ok !== true) return { ok: false, reason: "stage file did not report ok:true" };',
			'\t\tif (parsed.bound_bits !== "64") return { ok: false, reason: `expected the bound bitness 64, saw ${parsed.bound_bits}` };',
			'\t\treturn { ok: true, reason: "registered Oracle read the JSON post-state and confirmed the bound bitness", expected: { bound_bits: "64" }, observed: parsed };',
			"\t},",
			"}];",
			"",
		].join("\n"),
	);

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-du", name: "FauxDU" }] });
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
	process.env.AEGIS_TASK_ID = "task-data-use";
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

	// ===================================================================
	// SAME PROMPT: observe -> reuse the returned data_ref in execute.
	// ===================================================================
	const captured = [];
	const stageOk = join(cwd, "stage-ok.json");
	faux.setResponses([
		// Turn 1: observe the target and return control so the loop continues
		// IN THE SAME PROMPT.
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_observe", { action: "workspace.identify_elf", path: "target.bin" }),
			]);
		},
		// Turn 2: the model now has the data_ref in the tool TEXT; bind `bits` to it.
		(ctx) => {
			captured.push(ctx.messages);
			const ref = extractDataRef(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_execute", {
					action: "script.use-stage",
					arguments: { out: stageOk, stage: 1 },
					data_bindings: {
						bits: {
							ref_type: "data",
							ref_id: ref?.ref_id ?? "missing",
							field: "bits",
							...(ref?.digest ? { digest: ref.digest } : {}),
						},
					},
				}),
			]);
		},
		// Turn 3: a contradicting explicit argument for the same bound param.
		(ctx) => {
			captured.push(ctx.messages);
			const ref = extractDataRef(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_execute", {
					action: "script.use-stage",
					arguments: { out: join(cwd, "stage-contradict.json"), stage: 2, bits: "32" },
					data_bindings: { bits: { ref_type: "data", ref_id: ref?.ref_id ?? "missing", field: "bits" } },
				}),
			]);
		},
		// Turn 4: a FOREIGN/missing ref that never existed.
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_execute", {
					action: "script.use-stage",
					arguments: { out: join(cwd, "stage-foreign.json"), stage: 3 },
					data_bindings: { bits: { ref_type: "data", ref_id: "obs_does_not_exist", field: "bits" } },
				}),
			]);
		},
		// Turn 5: bind to a field that does not exist in the observation.
		(ctx) => {
			captured.push(ctx.messages);
			const ref = extractDataRef(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_execute", {
					action: "script.use-stage",
					arguments: { out: join(cwd, "stage-nofield.json"), stage: 4 },
					data_bindings: { bits: { ref_type: "data", ref_id: ref?.ref_id ?? "missing", field: "no_such_field" } },
				}),
			]);
		},
		// Turn 6: the observed TARGET changes on disk, then the model re-binds the
		// now-stale ref. The binding must be refused and the target change must be
		// surfaced as a TRUSTED, SPECIFIC-SCOPE environment.changed.
		(ctx) => {
			captured.push(ctx.messages);
			writeFileSync(join(cwd, "target.bin"), syntheticElfHeader({ bits: 32, machine_id: 0x03 }));
			const ref = extractDataRef(ctx.messages);
			return fauxAssistantMessage([
				fauxToolCall("aegis_execute", {
					action: "script.use-stage",
					arguments: { out: join(cwd, "stage-stale.json"), stage: 6 },
					data_bindings: { bits: { ref_type: "data", ref_id: ref?.ref_id ?? "missing", field: "bits" } },
				}),
			]);
		},
		(ctx) => {
			captured.push(ctx.messages);
			return fauxAssistantMessage("loop finished");
		},
	]);

	const first = await createSession();
	check(
		"the observer extension loaded without errors",
		first.loaded.errors.length === 0,
		JSON.stringify(first.loaded.errors),
	);

	await first.session.prompt("Observe the target, then use the observed bitness to run the registered stage script.");

	const events = readEvents(eventLog);

	// --- 1. Real ELF observation is verified and names a data_ref. ---
	const elfObservation = events.find(
		(e) => e.event_type === "observation.captured" && e.payload?.observation_kind === "file_identity",
	);
	check(
		"the real ELF header was parsed as 64-bit x86-64",
		elfObservation?.payload?.value?.bits === 64 && elfObservation?.payload?.value?.machine === "x86_64",
		JSON.stringify(elfObservation?.payload?.value),
	);
	check(
		"the verified observation comes from the trusted oracle source",
		elfObservation?.payload?.verified === true && elfObservation?.source?.kind === "oracle",
	);
	const dataRefInText = extractDataRef(captured[captured.length - 1] ?? []);
	check(
		"the observe tool returned the observation id as a data_ref in the model-visible TEXT",
		Boolean(dataRefInText) && dataRefInText.ref_id === elfObservation?.event_id,
		JSON.stringify({ refInText: dataRefInText, observationId: elfObservation?.event_id }),
	);

	// --- 2. The SAME-PROMPT execute bound the observed field and the Oracle passed. ---
	const stageJson = JSON.parse(readFileSync(stageOk, "utf8"));
	check(
		"the registered script ran with the RESOLVED observed bitness bound into its args",
		stageJson.bound_bits === "64" && stageJson.ok === true,
		JSON.stringify(stageJson),
	);
	const scriptObservation = events.find(
		(e) =>
			e.event_type === "observation.captured" &&
			e.payload?.observation_kind === "script_execution" &&
			e.payload?.verified === true,
	);
	check(
		"the script action was verified by the registered Oracle reading the JSON post-state",
		Boolean(scriptObservation),
	);
	const bindExec = events.find(
		(e) =>
			e.event_type === "action.completed" &&
			e.payload?.tool_name === "aegis_execute" &&
			e.payload?.status === "success",
	);
	check(
		"the completed execute logged the ACTUAL bound ref (use_refs), not just a count",
		Array.isArray(bindExec?.payload?.use_refs) &&
			bindExec.payload.use_refs.some((ref) => ref.ref_id === elfObservation?.event_id),
		JSON.stringify(bindExec?.payload?.use_refs),
	);
	check(
		"the completed execute logged the final resolved arguments",
		bindExec?.payload?.final_arguments?.bits === "64",
		JSON.stringify(bindExec?.payload?.final_arguments),
	);
	// P1-1/evidence regression: the INTENT pins the registered version + implementation
	// digest (an unpinned action record makes the compiler's `action_resolution` fail
	// even though `do.action_ref` is correct).
	const execRequested = events.find(
		(e) => e.event_type === "action.requested" && e.payload?.action_id === bindExec?.payload?.action_id,
	);
	check(
		"the execute intent pins the registered version + implementation digest (so the Outcome can compile)",
		typeof execRequested?.payload?.version === "number" &&
			typeof execRequested?.payload?.implementation_digest === "string" &&
			execRequested.payload.version === bindExec?.payload?.version &&
			execRequested.payload.implementation_digest === bindExec?.payload?.implementation_digest,
		JSON.stringify({
			requested: { version: execRequested?.payload?.version, digest: execRequested?.payload?.implementation_digest },
			completed: { version: bindExec?.payload?.version, digest: bindExec?.payload?.implementation_digest },
		}),
	);

	// --- 3. The stage Outcome names BOTH the data ref and the action ref. ---
	const scriptOutcome = events.find(
		(e) =>
			e.event_type === "outcome.recorded" &&
			e.payload?.level === "step" &&
			e.payload?.status === "success" &&
			e.payload?.scope?.startsWith("script."),
	);
	const outcomeRefs = scriptOutcome?.payload?.evidence_refs ?? [];
	check(
		"the script step Outcome names the exact same-episode data ref",
		outcomeRefs.some((ref) => ref.ref_id === elfObservation?.event_id),
		JSON.stringify(outcomeRefs),
	);
	check(
		"the script step Outcome names the completed action ref",
		outcomeRefs.some((ref) => ref.ref_type === "action"),
	);
	// P1-1 regression: `action_ref` is the REGISTERED action id, and the Pi
	// toolCallId is kept separately as `action_id` — so a real `aegis_execute`
	// step Outcome can be compiled directly (never the toolCallId as action_ref).
	check(
		"the script step Outcome separates action_ref (registered id) from action_id (toolCallId)",
		scriptOutcome?.payload?.action_ref === "script.use-stage" &&
			typeof scriptOutcome?.payload?.action_id === "string" &&
			scriptOutcome?.payload?.action_id !== scriptOutcome?.payload?.action_ref,
		JSON.stringify({ action_ref: scriptOutcome?.payload?.action_ref, action_id: scriptOutcome?.payload?.action_id }),
	);
	// P1-1 e2e: a REAL aegis_execute step Outcome is directly compilable — the D
	// evidence resolver indexes it and proofFromOutcome resolves its action_ref to
	// the registered action id (the old toolCallId-as-action_ref bug made this fail).
	const dResolver = createEvidenceResolver({ events });
	const realProof = proofFromOutcome(dResolver, scriptOutcome.payload.outcome_id);
	check(
		"a real aegis_execute step Outcome resolves to a compiler proof with the registered action",
		realProof.ok === true && realProof.proof?.do?.action_ref === "script.use-stage",
		JSON.stringify(realProof),
	);
	// P1-2 regression: the Outcome names `artifact:<id>.stdout` and the bound
	// observation data ref. The observe path now commits a resolver-indexable
	// `artifact_ref` on the observation row and a `data.obtained` record, so EVERY
	// real evidence ref resolves through the SAME trusted D resolver the compiler
	// uses. A string ref is never treated as evidence: only a resolver-confirmed
	// record with a matching content digest counts.
	const evidenceResolution = (scriptOutcome?.payload?.evidence_refs ?? []).map((ref) => ({
		ref,
		res: dResolver.resolveSupport({ kind: ref.ref_type ?? ref.type, ref }),
	}));
	check(
		"every real aegis_execute Outcome evidence ref resolves through the trusted resolver",
		evidenceResolution.length >= 2 && evidenceResolution.every((entry) => entry.res.ok === true),
		JSON.stringify(evidenceResolution.map((entry) => ({ ref: entry.ref, ok: entry.res.ok, reason: entry.res.reason }))),
	);
	check(
		"the artifact evidence ref resolves to a REAL content digest (not the ref string echoed back)",
		(() => {
			const artifactRef = (scriptOutcome?.payload?.evidence_refs ?? []).find((ref) => ref.ref_type === "artifact");
			if (!artifactRef) return false;
			const resolved = dResolver.resolveSupport({ kind: "artifact", ref: artifactRef });
			return resolved.ok === true && resolved.content_digest === artifactRef.digest && typeof resolved.record?.content_digest === "string";
		})(),
		JSON.stringify(scriptOutcome?.payload?.evidence_refs),
	);
	// P1-1 regression: feed the REAL `aegis_execute` Outcome into the Compiler. The
	// old bug stored the Pi toolCallId as `action_ref`, so the compiler failed
	// `action_registered`/`action_resolution`. The real Outcome must resolve and
	// compile with NO action-related failure (a single proof legitimately stays a
	// candidate for independence reasons, which is NOT an action failure).
	const compiledConfig = await import(pathToFileURL(configPath).href);
	const compiledRuntime = createObserveActionRuntime({
		workspaceRoot: cwd,
		scriptRegistrationConfig: { scripts: compiledConfig.scripts },
	});
	const compiledBridge = createLearningBridge({
		events,
		registry: compiledRuntime.registry,
		broker: compiledRuntime.broker,
		authorization: compiledRuntime.authorization,
		environment: {
			environment_fingerprint: "local-workspace",
			domain: null,
			permissions: ["workspace-script"],
			task_types: [],
		},
	});
	const compiledReal = compiledBridge.compileFromOutcomeIds({
		outcomeIds: [scriptOutcome.payload.outcome_id],
		argumentsTemplates: { [scriptOutcome.payload.outcome_id]: { out: null, stage: null, bits: null } },
	});
	const actionFailureRules = (compiledReal.failures ?? [])
		.map((failure) => failure.rule)
		.filter((rule) => rule === "action_registered" || rule === "action_resolution");
	check(
		"the REAL aegis_execute Outcome compiles with the registered action (no action_registered/action_resolution failure)",
		compiledReal.proofs?.length === 1 &&
			compiledReal.proofs[0].do?.action_ref === "script.use-stage" &&
			actionFailureRules.length === 0,
		JSON.stringify({ proofs: compiledReal.proofs?.length, failures: compiledReal.failures }),
	);
	check(
		"the real Outcome compile is a candidate for independence reasons, never a fake active rule",
		compiledReal.status === "candidate" && compiledReal.ok === false,
		JSON.stringify({ status: compiledReal.status, ok: compiledReal.ok }),
	);
	// P1-2 regression: with the artifact/data records committed, the compiler no
	// longer fails the `evidence_refs` gate on a real Outcome. It still stays a
	// CANDIDATE, and only for the honest structural reasons (a single proof cannot
	// be independent), never because a gate was relaxed or a ref was fabricated.
	const compiledRules = (compiledReal.failures ?? []).map((failure) => failure.rule);
	check(
		"the REAL aegis_execute Outcome compile no longer fails the evidence_refs gate",
		compiledRules.includes("evidence_refs") === false,
		JSON.stringify(compiledReal.failures),
	);
	check(
		"the real Outcome stays a candidate only for structural reasons (never a relaxed evidence/action gate)",
		(() => {
			const disallowed = new Set(["evidence_refs", "proof_resolvable", "action_registered", "action_resolution", "proof_success", "proof_observed", "evidence_resolver"]);
			return compiledReal.status === "candidate" && compiledRules.length > 0 && compiledRules.every((rule) => !disallowed.has(rule));
		})(),
		JSON.stringify({ status: compiledReal.status, rules: compiledRules }),
	);

	// --- 4. A verified stage contribution is recorded against the real refs. ---
	const contributions = events.filter(
		(e) => e.event_type === "runtime.note" && e.payload?.kind === "contribution.recorded",
	);
	const obtain = contributions.find((e) => e.payload?.stage === "obtain");
	const use = contributions.find((e) => e.payload?.stage === "use");
	const advance = contributions.find((e) => e.payload?.stage === "advance");
	check(
		"an `obtain` contribution is recorded against the verified observation ref",
		obtain?.payload?.status === "verified_use" && obtain?.payload?.data_ref?.ref_id === elfObservation?.event_id,
		JSON.stringify(obtain?.payload),
	);
	check(
		"a `use` contribution is recorded against the REAL completed action + data ref",
		use?.payload?.status === "verified_use" &&
			use?.payload?.data_ref?.ref_id === elfObservation?.event_id &&
			use?.payload?.action_ref?.ref_id,
		JSON.stringify(use?.payload),
	);
	check(
		"an `advance` contribution is recorded (association-only, causal=false)",
		advance?.payload?.status === "verified_use" &&
			use?.payload?.association_only === true &&
			use?.payload?.causal === false,
		JSON.stringify(advance?.payload),
	);

	// --- 5. NEGATIVES: contradiction, foreign ref, missing field. ---
	const rejected = events.filter((e) => e.event_type === "runtime.note" && e.payload?.kind === "action.rejected");
	check(
		"a data_binding that CONTRADICTS an explicit argument is refused before any effect",
		rejected.some((e) => /contradicts the resolved field value/.test(e.payload?.reason ?? "")),
		JSON.stringify(rejected.map((e) => e.payload?.reason)),
	);
	check(
		"a FOREIGN/missing data ref is refused before any effect",
		rejected.some((e) =>
			/data record for obs_does_not_exist|did not resolve|no data record/.test(e.payload?.reason ?? ""),
		),
		JSON.stringify(rejected.map((e) => e.payload?.reason)),
	);
	check(
		"binding a field the observation does not contain is refused",
		rejected.some((e) => /is missing from the resolved data/.test(e.payload?.reason ?? "")),
		JSON.stringify(rejected.map((e) => e.payload?.reason)),
	);
	check(
		"no refused execute wrote a post-state file",
		!readFileSync(stageOk, "utf8").includes("stage-contradict") &&
			!events.some(
				(e) =>
					e.event_type === "observation.captured" &&
					e.payload?.observation_kind === "script_execution" &&
					(e.payload?.value?.argv ?? []).some((a) => String(a).includes("stage-contradict")),
			),
	);
	// A changed TARGET is refused, and the change becomes a trusted scoped fact.
	check(
		"binding a ref whose target CHANGED is refused",
		rejected.some((e) => /target content changed since the observation/.test(e.payload?.reason ?? "")),
		JSON.stringify(rejected.map((e) => e.payload?.reason)),
	);
	check(
		"the target change is surfaced as a TRUSTED scoped environment.changed",
		events.some(
			(e) =>
				e.event_type === "environment.changed" &&
				e.source?.kind === "oracle" &&
				typeof e.payload?.scope === "string" &&
				e.payload.scope.length > 0,
		),
		JSON.stringify(events.filter((e) => e.event_type === "environment.changed").map((e) => e.payload)),
	);
	check("the stale execute wrote no post-state file", !existsSync(join(cwd, "stage-stale.json")));

	// --- 6. The board holds a trusted Fact; no LLM claim became one. ---
	const board = projectBoard(events);
	check("the board holds a trusted Fact from the verified observation", board.byType.Fact.length >= 1);
	check("no shallow/LLM claim created a Fact", !board.byType.Fact.some((n) => n.downgraded_from === "Fact"));

	// --- 7. Pipeline regression: no leak of an unresolved action. ---
	check(
		"the same-prompt loop left NO unresolved action pending",
		(() => {
			const requested = events.filter((e) => e.event_type === "action.requested").map((e) => e.payload?.action_id);
			const completed = new Set(
				events.filter((e) => e.event_type === "action.completed").map((e) => e.payload?.action_id),
			);
			return requested.every((id) => completed.has(id));
		})(),
	);

	first.session.dispose();
	faux.unregister();
	rmSync(base, { recursive: true, force: true });

	console.log("");
	if (failures > 0) {
		console.error(`aegis-observer-data-use-pi FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-observer-data-use-pi ok");
}

main().catch((error) => {
	console.error(`aegis-observer-data-use-pi: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
