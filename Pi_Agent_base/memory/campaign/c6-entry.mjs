// Aegis C6 — product entry: automatic SDK runtime + model Worker + Campaign
// learning, on top of the accepted C1-C5 stack.
//
// One command runs the whole product chain from a trusted config file:
//
//   config -> validated Manifest -> SDK runtime (isolated creds, allowlist
//   ResourceLoader, shared gate) -> Host (one EventLog owner, one Broker
//   Worker, one Oracle) -> Router -> model structured decision -> Broker ->
//   local effect -> independent Oracle -> committed evidence / replay /
//   compiler -> safe Session rotation / control / recovery -> read-only
//   observation, report and measurement export.
//
// It reuses the existing Scheduler/Host/Broker/Observer/Oracle/Compiler/Router/
// learning bridge/Replay. It creates NO second scheduler, evidence, learning or
// model-call framework. It never contacts a real provider/target by default.
//
// Honest boundaries: the workspace is NOT an OS sandbox; the development default
// provider is the offline `faux`; token/currency usage is `unknown` unless the
// backend reports it (faux reports an ESTIMATE, labelled as such).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectBoard } from "../runtime/board.mjs";
import { bindHostEventLog, parseJsonl, verifyChain } from "../runtime/events.mjs";
import { evaluateHandoff } from "../runtime/handoff.mjs";
import { buildRam } from "../runtime/ram.mjs";
import { createSessionSupervisor } from "../runtime/session-supervisor.mjs";
import { projectState } from "../runtime/state.mjs";
import { artifactIndexFromEvents, assembleCampaignHost } from "./c3-entry.mjs";
import { createDecisionCaptureTool, createModelPlan, createModelWorker } from "./c6-model-worker.mjs";
import { createCampaignSdkRuntime } from "./c6-sdk-runtime.mjs";
import { createToolLedger } from "./c6-tool-ledger.mjs";
import { loadCampaignConfig } from "./campaign-config.mjs";
import { createObservationServer } from "./observation-server.mjs";
import { projectQueueFromEvents } from "./projection.mjs";
import { describeCredentialRef, resolveProviderConfig } from "./provider-config.mjs";
import { runReportExport } from "./report-entry.mjs";

export const C6_ENTRY_VERSION = "1.0.0";

const SUBCOMMANDS = ["run", "status", "pause", "resume", "cancel", "export", "observe", "rotate", "measure"];

function readEventsSafe(path) {
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Build a decision buffer shared between the SDK custom tool and the model plan.
 * @returns {{push: (d: any) => void, list: () => any[], reset: () => void, byTask: () => Map<string, any[]>}}
 */
export function createDecisionBuffer() {
	let currentTask = null;
	const byTask = new Map();
	const taskProposals = [];
	const proposalKeys = new Set();
	return {
		setTask(taskId) {
			currentTask = taskId;
		},
		push(decision) {
			const key = currentTask ?? "unbound";
			const list = byTask.get(key) ?? [];
			list.push(decision);
			byTask.set(key, list);
		},
		/** Record a bounded dynamic task proposal (deduped by semantic identity). */
		pushTask(proposal) {
			const key = `${proposal?.parent_task_id ?? ""}|${proposal?.proposed_task_id ?? ""}|${proposal?.task_type ?? ""}|${proposal?.target_ref ?? ""}`;
			if (proposalKeys.has(key)) return false;
			proposalKeys.add(key);
			taskProposals.push(proposal);
			return true;
		},
		listTasks() {
			return taskProposals.slice();
		},
		list() {
			return byTask.get(currentTask ?? "unbound") ?? [];
		},
		reset() {
			byTask.clear();
			taskProposals.length = 0;
			proposalKeys.clear();
		},
		byTask: () => byTask,
	};
}

/**
 * The COMPOSITE worker the Scheduler drives: it first asks the bound SDK model
 * for a structured decision (driving the SDK + ledger), then executes the
 * admitted plan through the ORIGINAL Broker Worker. One Broker path only.
 */
export function createCompositeWorker({ modelWorker, brokerWorker, buffer, onTaskSettled = null }) {
	return {
		bindCampaign(manifest) {
			brokerWorker.bindCampaign?.(manifest);
		},
		async run({ task }) {
			buffer.setTask(task.task_id);
			const planned = await modelWorker.run({ task });
			if (!planned.ok) return planned;
			// Execute the model's admitted decision through the existing Broker.
			const result = await brokerWorker.run({ task });
			// A safe settle boundary: the caller may rotate the Session here. The
			// caller only rotates when idle/settled/committed with no pending effect
			// and budget allowing; this callback never forces a rotation.
			if (typeof onTaskSettled === "function") await onTaskSettled({ task, result });
			return result;
		},
	};
}

/**
 * Run the C6 product chain from a trusted config.
 *
 * @param {{
 *   configPath: string, scenario?: string, observe?: boolean, export?: boolean,
 *   outDir?: string|null, port?: number|null, sdk?: any, createSeam?: Function|null,
 *   fauxProviderFactory?: Function|null, print?: (text: string) => void,
 *   installSignalHandlers?: boolean, signalSource?: any,
 * }} args
 */
export async function runC6FromConfig(
	{
		configPath,
		scenario = "run",
		observe = false,
		export: doExport = false,
		outDir = null,
		port = null,
		sdk = null,
		createSeam = null,
		fauxProviderFactory = null,
		print = null,
		installSignalHandlers = false,
		signalSource = process,
	} = /** @type {any} */ ({}),
) {
	const out = typeof print === "function" ? print : (text) => process.stdout.write(`${text}\n`);
	if (!SUBCOMMANDS.includes(scenario)) return { ok: false, reasons: ["unknown Campaign command"], stage: "config" };
	if (port !== null && (!Number.isInteger(port) || port < 0 || port > 65535))
		return { ok: false, reasons: ["observation port is invalid"], stage: "config" };

	const loaded = loadCampaignConfig({ configPath });
	if (!loaded.ok) return { ok: false, reasons: loaded.reasons, stage: "config" };
	const { config, manifest } = loaded;

	// Provider must be EXPLICIT and recognized; no silent fallback to faux.
	const providerCheck = resolveProviderConfig(config.provider);
	if (!providerCheck.ok) return { ok: false, reasons: providerCheck.reasons, stage: "provider" };
	const credentialInfo = describeCredentialRef(providerCheck.provider.credential_ref);
	if (!credentialInfo.ok) return { ok: false, reasons: [credentialInfo.reason], stage: "provider" };

	// The SDK is injected in tests; the real SDK is imported lazily in CLI mode.
	let sdkImpl = sdk;
	if (!sdkImpl && createSeam) {
		sdkImpl = await createSeam({ provider: providerCheck.provider, config });
		if (!sdkImpl?.ok) return { ok: false, reasons: [sdkImpl?.reason ?? "SDK creation failed"], stage: "sdk" };
		sdkImpl = sdkImpl.sdk;
	}
	if (!sdkImpl) {
		try {
			sdkImpl = await importSdk();
		} catch (error) {
			return { ok: false, reasons: [`Pi SDK is unavailable: ${String(error)}`], stage: "sdk" };
		}
	}

	mkdirSync(config.work_dir, { recursive: true });
	config.session.handoff_path = config.session.handoff_path ?? join(config.work_dir, "runtime", "handoff.json");
	mkdirSync(dirname(config.session.handoff_path), { recursive: true });
	const cwd = join(config.work_dir, "cwd");
	const agentDir = join(config.work_dir, "agent");
	const sessionDir = join(config.work_dir, "sessions");
	for (const d of [cwd, agentDir, sessionDir]) mkdirSync(d, { recursive: true });

	const eventLogPath = join(config.work_dir, "events.jsonl");

	// Provider model. For the offline default we register the faux provider.
	let modelRuntime;
	let model;
	let faux = null;
	try {
		if (providerCheck.provider.kind === "faux") {
			const fauxFactory = fauxProviderFactory ?? (await importFauxFactory());
			faux = fauxFactory({ provider: "faux", models: [{ id: providerCheck.provider.model }] });
			model = faux.getModel();
			const authDir = join(config.work_dir, "sdk");
			mkdirSync(authDir, { recursive: true });
			const credentials = sdkImpl.AuthStorage.inMemory();
			await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-offline-key" }));
			modelRuntime = await sdkImpl.ModelRuntime.create({
				credentials,
				modelsPath: join(authDir, "models.json"),
				allowModelNetwork: false,
			});
			modelRuntime.registerProvider(model.provider, modelDetails(model));
		} else {
			return {
				ok: false,
				reasons: [`provider "${providerCheck.provider.kind}" is not implemented in offline C6`],
				stage: "sdk",
			};
		}
	} catch (error) {
		return { ok: false, reasons: [`SDK model runtime creation failed: ${String(error)}`], stage: "sdk" };
	}

	// The shared gate + the SDK runtime. The gate object is injected into EVERY
	// session's resource loader; the Host owns the same object.
	const { createCampaignActionGate } = await import("./campaign-mode.mjs");
	const gate = createCampaignActionGate();

	const ledger = createToolLedger({
		limit: {
			model_requests: manifest.budget.model_requests,
			tool_calls: manifest.budget.tool_calls,
			input_chars: (config.context?.max_total_input_chars ?? 24000) * Math.max(1, manifest.budget.model_requests),
			wall_time_ms: manifest.budget.wall_time_ms,
		},
		onEvent: (record) => {
			// Count REAL provider requests (including the automatic tool loop) so a
			// declared requests-per-session threshold can trigger a safe rotation.
			if (record.kind === "request.committed") requestsSinceRotation += 1;
		},
	});

	const buffer = createDecisionBuffer();
	let TypeSchema = null;
	try {
		TypeSchema = (await importPiAi()).Type;
	} catch {
		TypeSchema = null;
	}
	const decisionCapture = {
		tool: createDecisionCaptureTool({ sdk: sdkImpl, buffer, type: TypeSchema ?? undefined }),
		buffer,
	};

	// The real SDK runtime (or an injected seam for tests).
	let sdkRuntime;
	try {
		sdkRuntime = createSeam
			? await createSeam({
					provider: providerCheck.provider,
					model,
					modelRuntime,
					gate,
					cwd,
					agentDir,
					sessionDir,
					sdk: sdkImpl,
					decisionCapture,
				})
			: await createCampaignSdkRuntime({
					provider: providerCheck.provider,
					model,
					modelRuntime,
					gate,
					cwd,
					agentDir,
					sessionDir,
					sdk: sdkImpl,
					decisionCapture,
				});
	} catch (error) {
		return { ok: false, reasons: [`SDK runtime creation failed: ${String(error)}`], stage: "sdk" };
	}
	if (!sdkRuntime || typeof sdkRuntime.session !== "function") {
		return { ok: false, reasons: ["SDK runtime seam did not return a runtime handle"], stage: "sdk" };
	}

	let server = null;
	let unbind = null;
	let controlResult = null;
	let runResult = null;
	let exportResult = null;
	let rotationResult = null;
	const rotationAttempts = [];
	const dynamicAdmissions = [];
	let requestsSinceRotation = 0;
	let hostRef = null;

	/** A C2-shaped budget ledger derived from the trusted config (session_count only). */
	function sessionLedger() {
		const limit = config.session.budget_ledger?.limit ?? { session_count: config.session.session_count };
		const consumed = config.session.budget_ledger?.consumed ?? { session_count: 0 };
		const reserved = config.session.budget_ledger?.reserved ?? { session_count: 0 };
		return { limit, consumed, reserved, max_requests_per_session: config.session.max_requests_per_session };
	}

	function buildSessionController() {
		// Reuse the accepted C2 supervisor through the SDK runtime's newSession seam.
		// The Host stages a handoff decision into the shared handoff file, then the
		// supervisor applies it through the REAL SDK and verifies that exactly one
		// `handoff.completed` is committed for the request (no false completion).
		const supervisor = createSessionSupervisor({
			eventLogPath,
			handoffPath: config.session.handoff_path,
			runtime: {
				newSession: (options) => sdkRuntime.runtime.newSession(options),
				get session() {
					return sdkRuntime.session();
				},
			},
			taskId: config.label ?? "campaign-task",
			budget: sessionLedger(),
		});
		return {
			committedRotations: () => readEventsSafe(eventLogPath).filter((e) => e.event_type === "handoff.completed").length,
			canRotate: () => supervisor.canRotate(),
			rotate: async (options = {}) => {
				const before = sdkRuntime.session();
				// Stage the Host's rotation request so the observer writes exactly one
				// completion at the post-bind boundary (the same path as a model request).
				const staged = stageHostHandoff({
					eventLogPath,
					handoffPath: config.session.handoff_path,
					taskId: config.label ?? "campaign-task",
					reason: options.reason ?? "auto_request_threshold",
				});
				if (!staged.ok) return { applied: false, reason: staged.reason };
				const result = await supervisor.rotate({ requestId: staged.request_id, reason: staged.reason });
				if (result.applied === true && result.reused !== true) {
					// Rebind the SDK subscriptions to the new session (C6-A rebind seam).
					const after = sdkRuntime.session();
					await sdkRuntime.rebind?.(after);
					result.new_session_id = safeSessionId(after);
					result.new_object = after !== before;
				}
				return result;
			},
			recoverInterrupted: () => supervisor.recoverInterrupted(),
		};
	}

	let assembled;
	let modelWorker;
	let brokerRef = null;
	// Select the registered adapter + judge for the configured task family. The
	// fixture-state family keeps the accepted C3 behavior; structured-data-repair
	// registers the reviewed data adapter and its INDEPENDENT file-recheck judge.
	let extraContracts = [];
	let judgeFactory = null;
	if (config.task_family === "structured-data-repair") {
		const { createStructuredDataAdapter, createDataRepairJudge } = await import("./structured-data-adapter.mjs");
		extraContracts = [createStructuredDataAdapter({ workspaceRoot: config.workspace_root })];
		judgeFactory = ({ workspaceRoot }) => createDataRepairJudge({ workspaceRoot });
	}
	try {
		// Build the model ledger/plan worker wiring. The composite worker is
		// injected as the Host worker so ONE broker path executes the plan.
		assembled = await assembleCampaignHost({
			manifest,
			workspaceRoot: config.workspace_root,
			workDir: config.work_dir,
			eventLogPath,
			mode: config.mode,
			actionGate: gate,
			extraContracts,
			judgeFactory,
			sessionController: buildSessionController(),
			wrapWorker: (brokerWorker) => {
				modelWorker = createModelWorker({
					session: () => sdkRuntime.session(),
					ledger,
					romPath: join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "agent", "ROM.md"),
					context: config.context ?? { max_total_input_chars: 24000, output_reserve_chars: 2000 },
					taskId: config.label ?? "campaign-task",
					goal: manifest.objective?.description ?? manifest.title ?? "",
					actionCatalog: null,
					getActionCatalog: () => ({ actions: safeDescribe(brokerRef) }),
					ramProvider: () => {
						const events = readEventsSafe(eventLogPath);
						const board = projectBoard(events);
						const state = projectState(events);
						const episodeId = Object.keys(state.episodes)[0] ?? "ep-none";
						return buildRam({ board, state, episodeId, goal: manifest.objective?.description ?? "" });
					},
					decisionBuffer: buffer,
					onEvent: (record) => {
						if (record.kind === "request.committed") requestsSinceRotation += 1;
						out(`  [ledger] ${JSON.stringify(record)}`);
					},
				});
				const plan = createModelPlan({ decisionsByTask: buffer.byTask() });
				// Rebuild the Broker Worker with the MODEL plan instead of the fixture plan.
				brokerWorker.setPlan?.(plan);
				return createCompositeWorker({
					modelWorker,
					brokerWorker,
					buffer,
					onTaskSettled: async () => {
						// Admit any model-proposed bounded dynamic tasks through the ONE policy.
						if (hostRef && buffer.listTasks().length > 0) {
							for (const proposal of buffer.listTasks()) {
								const admission = await hostRef.proposeDynamicTask({ proposal });
								dynamicAdmissions.push(admission);
							}
						}
						// A safe settle boundary: rotate only when the declared threshold is
						// reached, an idle/settled/committed Host exists and budget allows.
						const threshold = config.session.max_requests_per_session;
						if (!hostRef || !Number.isInteger(threshold) || threshold < 1) return;
						if (requestsSinceRotation < threshold) return;
						const rotation = await hostRef.rotateSession({ reason: "auto_request_threshold" });
						rotationAttempts.push(rotation);
						if (rotation?.applied === true && rotation.reused !== true) requestsSinceRotation = 0;
					},
				});
			},
		});
	} catch (error) {
		await sdkRuntime.dispose?.().catch?.(() => undefined);
		return { ok: false, reasons: [error instanceof Error ? error.message : String(error)], stage: "assembly" };
	}
	const { host, sink } = assembled;
	brokerRef = assembled.broker ?? null;
	hostRef = host;

	try {
		unbind = bindHostEventLog(eventLogPath, sink.log);

		if (installSignalHandlers && signalSource && typeof signalSource.on === "function") {
			signalSource.on("SIGTERM", () => {
				void host.stop("sigterm_drain");
			});
		}

		if (observe || scenario === "observe" || config.observation.enabled) {
			server = createObservationServer({
				manifestPath: config.manifest_path,
				eventsPath: eventLogPath,
				host: config.observation.host,
				port: port ?? config.observation.port,
			});
			try {
				await server.listen();
				out(`observation board: ${server.url}`);
			} catch (error) {
				await server.close();
				server = null;
				out(`observation unavailable: ${error instanceof Error ? error.message : "bind failed"}`);
			}
		}

		try {
			if (scenario === "pause") {
				controlResult = await host.pause("cli_pause");
				if (controlResult.ok) runResult = await host.run();
			} else if (scenario === "resume") {
				controlResult = await host.resume("cli_resume");
				if (controlResult.ok) runResult = await host.run();
			} else if (scenario === "cancel") {
				controlResult = await host.cancel("cli_cancel");
				if (controlResult.ok) runResult = await host.run();
			} else if (scenario === "rotate") {
				rotationResult = await host.rotateSession({ reason: "cli_rotate" });
				runResult = await host.run();
			} else if (["status", "export", "observe", "measure"].includes(scenario)) {
				const { rows: events, errors } = parseJsonl(existsSync(eventLogPath) ? readFileSync(eventLogPath, "utf8") : "");
				if (errors.length || !verifyChain(events).ok) throw new Error("committed event log is corrupt");
				const projection = projectQueueFromEvents({
					campaign_id: manifest.campaign_id,
					tasks: manifest.tasks ?? [],
					events,
					revision: manifest.revision ?? 0,
					manifest,
					artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
				});
				runResult = {
					ok: projection.ok,
					status: { projection, campaign_state: projection.control?.state ?? "unknown" },
				};
			} else {
				runResult = await host.run();
			}
		} finally {
			host.releaseOwnership();
		}

		if (doExport || scenario === "export") {
			const target = outDir ?? join(config.work_dir, "report");
			exportResult = await runReportExport({
				manifestPath: config.manifest_path,
				eventsPath: eventLogPath,
				outDir: target,
			});
			out(`report exported: ${target} (ok=${exportResult.ok})`);
		}

		let measureResult = null;
		if (scenario === "measure") {
			measureResult = buildMeasurement({
				config,
				manifest,
				ledger,
				events: readEventsSafe(eventLogPath),
				outDir: config.measure?.out_dir ?? join(config.work_dir, "measure"),
			});
			out(`measurement exported: ${measureResult.out_dir}`);
		}

		const status = runResult?.status ?? host.status();
		const summary = status.projection ?? status;
		const taskStates = Object.fromEntries((summary?.tasks ?? []).map((t) => [t.task_id, t.state]));
		out(
			`campaign ${manifest.campaign_id}: ${status.campaign_state} | tasks ${JSON.stringify(taskStates)} | ledger ${JSON.stringify(ledger.consumed())}`,
		);
		const events = readEventsSafe(eventLogPath);
		return {
			ok:
				(runResult?.ok ?? true) &&
				(controlResult?.ok ?? true) &&
				(exportResult?.ok ?? true) &&
				(rotationResult?.applied ?? true),
			reasons: [
				...(runResult?.reasons ?? []),
				...(exportResult?.reasons ?? []),
				...(controlResult?.ok === false ? [controlResult.error ?? "control command failed"] : []),
			],
			campaign_id: manifest.campaign_id,
			observation_url: server ? server.url : null,
			task_states: taskStates,
			gate: assembled.gate,
			export_dir: exportResult?.outDir ?? null,
			measurement: measureResult,
			rotation: rotationResult,
			rotation_attempts: rotationAttempts,
			dynamic_admissions: dynamicAdmissions,
			ledger: ledger.snapshot(),
			chain_ok: verifyChain(events).ok,
			config,
		};
	} catch (error) {
		return { ok: false, reasons: [error instanceof Error ? error.message : String(error)], stage: "run" };
	} finally {
		try {
			host.releaseOwnership();
			if (server) await server.close();
		} finally {
			try {
				await sdkRuntime.dispose?.();
			} finally {
				try {
					if (sink.close) await sink.close();
				} finally {
					if (unbind) unbind();
				}
			}
		}
	}
}

function safeSessionId(session) {
	try {
		return session?.sessionId ?? session?.sessionFile ?? null;
	} catch {
		return null;
	}
}

/**
 * Stage a Host-initiated handoff request into the shared handoff file. It
 * re-validates against the COMMITTED stream (open episode, no pending effect)
 * through the accepted `evaluateHandoff`, so an unsafe switch is refused, never
 * forced. The observer writes the single `handoff.completed` at the post-bind
 * boundary; the Host never writes a completion itself.
 *
 * @param {{eventLogPath: string, handoffPath: string, taskId: string, reason: string}} args
 */
export function stageHostHandoff({ eventLogPath, handoffPath, taskId, reason }) {
	const events = readEventsSafe(eventLogPath);
	const state = projectState(events);
	const board = projectBoard(events);
	const episodeId = state.open_handoff?.episode_id ?? resolveOpenEpisodeId(state, taskId);
	if (!episodeId) return { ok: false, reason: "no open episode to hand over" };
	const ram = buildRam({ board, state, episodeId, goal: state.episodes[episodeId]?.goal?.description ?? "" });
	const requestId = `host-rotate-${events.length}-${Date.now()}`;
	const verdict = evaluateHandoff({ state, board, ram, episodeId, reason, requestId });
	if (!verdict.allowed) return { ok: false, reason: verdict.reason, blocking: verdict.pending_actions ?? [] };
	mkdirSync(dirname(handoffPath), { recursive: true });
	writeFileSync(handoffPath, JSON.stringify({ ...verdict.handoff, request_id: requestId }, null, 2), "utf8");
	return { ok: true, request_id: requestId, episode_id: episodeId, reason };
}

function resolveOpenEpisodeId(state, taskId) {
	for (const [id, episode] of Object.entries(state.episodes ?? {})) {
		if (episode.status === "open" || episode.status === "active") {
			if (!taskId || episode.task_id === taskId) return id;
		}
	}
	for (const [id, episode] of Object.entries(state.episodes ?? {})) {
		if (episode.status === "open" || episode.status === "active") return id;
	}
	return null;
}

function safeDescribe(broker) {
	try {
		return broker?.describe?.() ?? [];
	} catch {
		return [];
	}
}

function modelDetails(model) {
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

/** Measurement export: keeps every attempt, failure and unknown; no fake gains. */
export function buildMeasurement({ config, manifest, ledger, events, outDir }) {
	const attempts = [];
	for (const event of events) {
		if (event?.event_type === "runtime.note" && event.payload?.kind === "c6.attempt") {
			attempts.push(event.payload.attempt);
		}
	}
	const measurement = {
		schema_version: "1.0",
		campaign_id: manifest.campaign_id,
		config: {
			schema_version: config.schema_version,
			provider: config.provider,
			context: config.context,
			task_family: config.task_family,
			learning_policy: config.learning?.policy ?? "off",
		},
		seed: config.measure?.attempts?.[0]?.seed ?? null,
		attempts,
		ledger: ledger.snapshot(),
		// Not observable offline: keep null/unknown, never 0.
		backend_tokens: null,
		backend_currency: null,
		measured_at: new Date().toISOString(),
	};
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "measurement.json"), `${JSON.stringify(measurement, null, 2)}\n`, "utf8");
	return { ok: true, out_dir: outDir, attempts: attempts.length, measurement };
}

async function importSdk() {
	const mod = await import("@earendil-works/pi-coding-agent");
	// `AuthStorage` is not re-exported from the package index; the CLI resolves it
	// through the documented core module path. Tests may supply their own `sdk`
	// object with `AuthStorage` attached.
	if (!mod.AuthStorage) {
		try {
			const auth = await import("@earendil-works/pi-coding-agent/core/auth-storage");
			return { ...mod, AuthStorage: auth.AuthStorage };
		} catch {
			return mod;
		}
	}
	return mod;
}
async function importPiAi() {
	return import("@earendil-works/pi-ai/compat");
}
async function importFauxFactory() {
	const mod = await import("@earendil-works/pi-ai/compat");
	return mod.registerFauxProvider;
}

// ---------------------------------------------------------------------------
// CLI parser
// ---------------------------------------------------------------------------

export function parseC6Args(argv) {
	const args = { configPath: null, subcommand: null, observe: false, export: false, outDir: null, port: null };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (["--config", "--out", "--port"].includes(token) && (!argv[i + 1] || argv[i + 1].startsWith("--")))
			return { ok: false, reason: `missing value for ${token}` };
		if (token === "--config") {
			args.configPath = argv[i + 1];
			i += 1;
		} else if (token === "--observe") {
			args.observe = true;
		} else if (token === "--export") {
			args.export = true;
		} else if (token === "--out") {
			args.outDir = argv[i + 1];
			i += 1;
		} else if (token === "--port") {
			const value = argv[i + 1];
			if (!/^\d+$/.test(value) || Number(value) > 65535)
				return { ok: false, reason: "--port must be an integer from 0 to 65535" };
			args.port = Number(value);
			i += 1;
		} else if (!token.startsWith("--") && !args.subcommand) {
			args.subcommand = token;
		} else {
			return { ok: false, reason: `unknown argument: ${token}` };
		}
	}
	if (!args.configPath) return { ok: false, reason: "--config is required" };
	const sub = args.subcommand ?? "run";
	if (!SUBCOMMANDS.includes(sub)) return { ok: false, reason: `subcommand must be one of ${SUBCOMMANDS.join(", ")}` };
	args.subcommand = sub;
	return { ok: true, args };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	const parsed = parseC6Args(process.argv.slice(2));
	if (!parsed.ok) {
		process.stderr.write(`c6-entry: ${parsed.reason}\n`);
		process.exit(2);
	}
	const outcome = await runC6FromConfig({
		configPath: parsed.args.configPath,
		scenario: parsed.args.subcommand,
		observe: parsed.args.observe,
		export: parsed.args.export,
		outDir: parsed.args.outDir,
		port: parsed.args.port,
		installSignalHandlers: parsed.args.subcommand === "observe",
	});
	if (!outcome.ok) {
		for (const reason of outcome.reasons ?? []) process.stderr.write(`c6-entry: ${reason}\n`);
	}
	process.exit(outcome.ok ? 0 : 1);
}
