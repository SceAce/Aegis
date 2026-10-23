#!/usr/bin/env node
// Aegis Experiment Console entry point (real Pi SDK).
//
// `run-experiment.sh` execs THIS file once. It creates the real Pi
// `AgentSessionRuntime`, hands it to `session/experiment-console.mjs` (the Host
// lifecycle owner), and then reads human input from the terminal. There is no
// second Pi CLI writing the same EventLog: the Host opens the EventLog and binds
// it in-process so the Observer borrows the same single writer.
//
// Interaction (documented by `run-experiment.sh --help`):
//   <text>          send a prompt to the CURRENT Task/Episode
//   /status         derived Host/session/work-cycle status
//   /pause          stop dispatching; the current Session is kept
//   /resume         clear a pause/block after recovery checks
//   /stop or /quit  dispose the SDK runtime and release the experiment lease
//   /help           this list
//
// The console is deliberately line-oriented (readline), not a new TUI. Pi's
// interactive TUI is NOT claimed to work through this entry.
//
// Provider selection is explicit and never guessed:
//   * `AEGIS_CONSOLE_PROVIDER=faux` (tests/dev) registers the offline faux model.
//   * otherwise the configured Pi agent dir's ModelRuntime/Settings are used, so
//     the model/auth come from the user's existing configuration exactly as
//     before. No real request is made by this module itself.

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createControlChannel } from "../console-web/control.mjs";
import { DEFAULT_CODING_TOOLS, resolveToolSelection } from "../console-web/tools.mjs";
import { buildWebView, VIEW_LIMITS } from "../console-web/view.mjs";
import { listWorkspace } from "../console-web/workspace-files.mjs";
import { createExperimentConsole, EXPERIMENT_CONSOLE_VERSION, resolveConsolePolicy } from "./experiment-console.mjs";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVER_PATH = join(BASE_DIR, "extensions", "aegis-observer.ts");

/**
 * Active tool set for an Experiment Console Session: the ordinary Pi coding
 * tools PLUS the Aegis Observer tools. A tool that is not listed is not active,
 * so this list is the console's explicit allowlist (it is NOT authorization:
 * the Observer/Broker still gate each real effect).
 */
const DEFAULT_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"ls",
	"grep",
	"find",
	"glob",
	"aegis_propose",
	"aegis_knowledge",
	"aegis_work_review",
	"aegis_work_checkpoint",
	"aegis_submit_candidate",
	"aegis_switch_session",
	"aegis_tools",
	"aegis_toolbox",
	"aegis_tool_note",
	"aegis_read",
	"aegis_observe",
	"aegis_execute",
	"aegis_artifact_read",
	"aegis_web_search",
	"aegis_remote_request",
	"aegis_run",
];

function env(name, fallback = null) {
	const value = process.env[name];
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function parseConsoleArgs(argv) {
	const args = {
		label: null,
		taskId: null,
		workspace: null,
		eventLogPath: null,
		handoffPath: null,
		checkpointPath: null,
		sessionDir: null,
		agentDir: null,
		ownershipBaseDir: null,
		provider: null,
		model: null,
		prompts: [],
		promptFile: null,
		nonInteractive: false,
		control: "console",
		tools: process.env.AEGIS_CONSOLE_TOOLS ?? null,
		thinking: process.env.AEGIS_THINKING_LEVEL ?? null,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const take = () => {
			index += 1;
			return argv[index] ?? null;
		};
		switch (arg) {
			case "--label":
				args.label = take();
				break;
			case "--task-id":
				args.taskId = take();
				break;
			case "--workspace":
				args.workspace = take();
				break;
			case "--event-log":
				args.eventLogPath = take();
				break;
			case "--handoff":
				args.handoffPath = take();
				break;
			case "--checkpoint":
				args.checkpointPath = take();
				break;
			case "--session-dir":
				args.sessionDir = take();
				break;
			case "--agent-dir":
				args.agentDir = take();
				break;
			case "--ownership-dir":
				args.ownershipBaseDir = take();
				break;
			case "--provider":
				args.provider = take();
				break;
			case "--model":
				args.model = take();
				break;
			case "--prompt":
				args.prompts.push(take() ?? "");
				break;
			case "--prompt-file":
				args.promptFile = take();
				break;
			case "--non-interactive":
				args.nonInteractive = true;
				break;
			case "--control":
				args.control = take();
				break;
			case "--tools":
				args.tools = take();
				break;
			case "--thinking":
				args.thinking = take();
				break;
			case "-h":
			case "--help":
				args.help = true;
				break;
			default:
				throw new Error(`unknown console argument: ${arg}`);
		}
	}
	return args;
}

export function usage(stream = process.stdout) {
	stream.write(
		[
			"Aegis Experiment Console (resident Host)",
			"",
			"Usage: node Pi_Agent_base/session/experiment-console-entry.mjs --label L --task-id T [options]",
			"",
			"Normally started by run-experiment.sh, which exports AEGIS_EVENT_LOG,",
			"AEGIS_HANDOFF_FILE, AEGIS_PI_AGENT_DIR, AEGIS_PI_SESSION_DIR and the frozen",
			"work-cycle/console policy.",
			"",
			"Options:",
			"  --workspace DIR       session cwd (default: cwd)",
			"  --event-log PATH      committed EventLog (default: $AEGIS_EVENT_LOG)",
			"  --handoff PATH        staged handoff file (default: $AEGIS_HANDOFF_FILE)",
			"  --checkpoint FILE     projection checkpoint cache (default: $AEGIS_PROJECTION_DIR/console-projection.json)",
			"  --session-dir DIR     Pi session files (default: $AEGIS_PI_SESSION_DIR)",
			"  --agent-dir DIR       Pi agent config/auth (default: $AEGIS_PI_AGENT_DIR)",
			"  --ownership-dir DIR   single-writer lease root (default: <runtime>/console)",
			"  --provider NAME       'faux' for the offline provider; otherwise Pi config",
			"  --model ID            faux model id (with --provider faux)",
			"  --prompt TEXT         dispatch one input (repeatable)",
			"  --prompt-file PATH    dispatch each non-empty line of PATH",
			"  --non-interactive     exit after the given prompts",
			"  --control console|stdio",
			"                        'stdio' serves the Aegis Web Console control channel:",
			"                        newline-delimited JSON commands on stdin and one JSON",
			"                        response per command on stdout. No prompt is read from",
			"                        the terminal in that mode.",
			"",
			"Console controls: <text> | /status | /pause | /resume | /stop | /quit | /help",
			"",
		].join("\n"),
	);
}

/**
 * Create the real SDK runtime handle used by the Console Host.
 *
 * Mirrors `campaign/c6-sdk-runtime.mjs`: an explicit resource allowlist (ONLY the
 * Aegis Observer), the same model/auth the run was configured with, and a rebind
 * of extension bindings + subscriptions after every `newSession`.
 */
export async function createConsoleSdkRuntime({
	sdk,
	providerKind,
	fauxProviderFactory = null,
	model,
	cwd,
	agentDir,
	sessionDir,
	tools = DEFAULT_TOOLS,
	thinkingLevel = null,
	onText = null,
}) {
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	let modelRuntime;
	let resolvedModel = null;
	if (providerKind === "faux") {
		const factory = fauxProviderFactory ?? (await import("@earendil-works/pi-ai/compat")).registerFauxProvider;
		// `reasoning: true` only so the offline demo/tests can exercise the thinking
		// level control; the faux provider ignores the level it is given.
		const faux = factory({
			provider: "faux",
			models: [{ id: model ?? "console-faux", reasoning: true }],
		});
		// Offline dev/demo only: a scripted faux conversation so the ordinary entry can
		// be exercised end to end without a model. Read only when provider=faux.
		const scriptPath = process.env.AEGIS_CONSOLE_FAUX_SCRIPT;
		if (scriptPath) {
			const compat = await import("@earendil-works/pi-ai/compat");
			const { readFileSync } = await import("node:fs");
			const steps = JSON.parse(readFileSync(scriptPath, "utf8"));
			let index = 0;
			const responder = () => {
				const step = Array.isArray(steps) ? steps[Math.min(index, steps.length - 1)] : null;
				index += 1;
				if (!step) return compat.fauxAssistantMessage("(no scripted step)");
				const calls = (Array.isArray(step.tool_calls) ? step.tool_calls : []).map((call) =>
					compat.fauxToolCall(call.name, call.arguments ?? {}),
				);
				if (calls.length > 0) return compat.fauxAssistantMessage(calls);
				return compat.fauxAssistantMessage(step.text ?? "");
			};
			faux.setResponses(Array.from({ length: 200 }, () => responder));
		}
		resolvedModel = faux.getModel();
		const credentials = sdk.AuthStorage.inMemory();
		await credentials.modify(resolvedModel.provider, async () => ({ type: "api_key", key: "faux-offline-key" }));
		modelRuntime = await sdk.ModelRuntime.create({
			credentials,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		modelRuntime.registerProvider(resolvedModel.provider, {
			api: resolvedModel.api,
			baseUrl: resolvedModel.baseUrl,
			models: [resolvedModel],
		});
	} else {
		// The user's configured Pi credentials/models. Read-only auth storage: the
		// console never writes or prints credentials. No model is forced, so Pi's
		// own settings/default resolution applies exactly as for a normal run.
		modelRuntime = await sdk.ModelRuntime.create({
			credentials: new sdk.ReadOnlyAuthStorage(join(agentDir, "auth.json")),
			modelsPath: join(agentDir, "models.json"),
			modelsStorePath: join(agentDir, "models-store.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		// An EXPLICIT provider/model pair (from --provider/--model) is resolved from
		// the same configuration. An unknown pair is refused rather than silently
		// falling back to a different model.
		if (providerKind !== "pi-config" && model) {
			resolvedModel = modelRuntime.getModel(providerKind, model);
			if (!resolvedModel)
				throw new Error(
					`the configured provider/model ${providerKind}/${model} is not present in this agent configuration`,
				);
		}
	}

	let creations = 0;
	let unsubscribe = null;
	let streamed = false;
	const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const requestedThinking =
		typeof thinkingLevel === "string" && THINKING_LEVELS.includes(thinkingLevel) ? thinkingLevel : null;
	const runtime = await sdk.createAgentSessionRuntime(
		async ({ cwd: sessionCwd, agentDir: sessionAgentDir, sessionManager, sessionStartEvent }) => {
			creations += 1;
			const services = await sdk.createAgentSessionServices({
				cwd: sessionCwd,
				agentDir: sessionAgentDir,
				modelRuntime,
				settingsManager: sdk.SettingsManager.create(sessionCwd, sessionAgentDir),
				resourceLoaderOptions: {
					// Explicit allowlist: the user's default extensions/skills/prompts/
					// themes/context files are NOT loaded by the console.
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [OBSERVER_PATH],
				},
			});
			const created = await sdk.createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				...(resolvedModel ? { model: resolvedModel } : {}),
				...(requestedThinking ? { thinkingLevel: requestedThinking } : {}),
				tools,
			});
			return { ...created, services, diagnostics: services.diagnostics };
		},
		{ cwd, agentDir, sessionManager: sdk.SessionManager.create(cwd, sessionDir) },
	);

	async function rebind(session) {
		if (unsubscribe) {
			try {
				unsubscribe();
			} catch {
				// ignore: the old session may already be disposed
			}
			unsubscribe = null;
		}
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
		unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				streamed = true;
				// Live tokens are EPHEMERAL UI (never a Fact/Outcome). The control mode
				// forwards them as a transient notification; the committed record stays
				// `message.completed`.
				if (typeof onText === "function") onText(event.assistantMessageEvent.delta);
				else process.stdout.write(event.assistantMessageEvent.delta);
			}
			if (event.type === "agent_settled" && streamed) {
				streamed = false;
				if (typeof onText === "function") onText(null);
				else process.stdout.write("\n");
			}
		});
	}
	runtime.setRebindSession(rebind);
	// Bind the initial Session/Observer. If THIS fails, the runtime we just
	// created is ours: dispose it before propagating so no half-bound Session is
	// left behind (and its shutdown still goes through the caller's writer).
	try {
		await rebind(runtime.session);
	} catch (error) {
		try {
			await runtime.dispose();
		} catch {
			// disposal failure must not replace the original bind error
		}
		throw error;
	}

	return {
		runtime,
		modelRuntime,
		creations: () => creations,
		sessionId: () => {
			try {
				return runtime.session?.sessionId ?? null;
			} catch {
				return null;
			}
		},
		sessionFile: () => {
			try {
				return runtime.session?.sessionFile ?? null;
			} catch {
				return null;
			}
		},
		model: () => {
			try {
				const model = runtime.session?.model;
				if (!model) return null;
				return { provider: model.provider ?? null, id: model.id ?? null, context_window: model.contextWindow ?? null };
			} catch {
				return null;
			}
		},
		/**
		 * Switch the CURRENT Session's model. Only a model known to this run's
		 * ModelRuntime is accepted (no arbitrary provider), and Pi itself refuses a
		 * model without configured auth. This is session configuration: it is not a
		 * task fact, not an Outcome and it changes no authorization or budget.
		 */
		/** Current thinking level and the levels this model actually supports. */
		thinking: () => {
			try {
				const current = runtime.session?.thinkingLevel ?? null;
				const levels = runtime.session?.getAvailableThinkingLevels?.() ?? [];
				return { level: current, levels, supported: levels.length > 1 };
			} catch {
				return { level: null, levels: [], supported: false };
			}
		},
		/** Set the thinking level; the SDK clamps it to the model's capabilities. */
		setThinking: (level) => {
			if (typeof level !== "string" || !THINKING_LEVELS.includes(level))
				throw new Error(`unknown thinking level ${String(level)}`);
			runtime.session.setThinkingLevel(level);
			const current = runtime.session.thinkingLevel ?? null;
			const levels = runtime.session.getAvailableThinkingLevels?.() ?? [];
			return { level: current, levels, supported: levels.length > 1 };
		},
		/** Models this run's runtime actually knows (what a switch may choose). */
		models: () =>
			modelRuntime
				.getModels()
				// Only providers this run actually has credentials for: listing the
				// whole built-in catalog would offer switches that must fail.
				.filter((model) => {
					try {
						return modelRuntime.hasConfiguredAuth(model.provider);
					} catch {
						return false;
					}
				})
				.map((model) => ({
					provider: model.provider,
					id: model.id,
					name: model.name ?? model.id,
					context_window: model.contextWindow ?? null,
				}))
				.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)),
		setModel: async ({ provider, id } = {}) => {
			if (typeof provider !== "string" || !provider || typeof id !== "string" || !id)
				throw new Error("provider and model id are required");
			const model = modelRuntime.getModel(provider, id);
			if (!model) throw new Error(`unknown model ${provider}/${id}`);
			await runtime.session.setModel(model);
			return { provider: model.provider, id: model.id };
		},
		prompt: (text) => runtime.session.prompt(text),
		waitForIdle: () => runtime.session.waitForIdle(),
		newSession: (options) => runtime.newSession(options),
		abort: () => runtime.session.abort(),
		dispose: async () => {
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// ignore
				}
				unsubscribe = null;
			}
			await runtime.dispose();
		},
	};
}

/**
 * One JSON line on stdout for the Web control channel (never mixed with human
 * console output: control mode does not print the banner or the status block).
 */
function writeControlLine(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Buffered live-token emitter for the control channel (ephemeral UI only). */
let deltaBuffer = "";
let deltaTimer = null;
function flushDelta() {
	if (deltaTimer) {
		clearTimeout(deltaTimer);
		deltaTimer = null;
	}
	if (!deltaBuffer) return;
	const text = deltaBuffer;
	deltaBuffer = "";
	writeControlLine({ type: "delta", text });
}
function emitDelta(text) {
	if (text === null) {
		flushDelta();
		return;
	}
	deltaBuffer += text;
	if (deltaBuffer.length > 4000) flushDelta();
	if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 80);
}

/**
 * Serve the Aegis Web Console control channel on stdio.
 *
 * The Web server is a thin supervisor: it spawns ONE Host process per active
 * experiment and forwards requests here. The Host keeps its ownership, its
 * EventLog writer, its SDK runtime, its recovery order and its execution gates;
 * the HTTP layer can only ask for these commands.
 */
async function serveControlChannel({ host, label, taskId, workspace }) {
	const control = createControlChannel({ host });
	const ready = await host.status();
	writeControlLine({ type: "ready", label, task_id: taskId, status: ready });
	let closed = false;
	const shutdown = async (reason) => {
		if (closed) return;
		closed = true;
		await host.shutdown(reason);
	};
	const handle = async (line) => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			writeControlLine({ id: null, ok: false, code: "invalid_request", reason: "not JSON" });
			return;
		}
		const { id = null, cmd, params = {} } = message ?? {};
		try {
			let result;
			switch (cmd) {
				case "ping":
					result = { ok: true, phase: host.phase() };
					break;
				case "status":
					result = { ok: true, status: await host.status() };
					break;
				case "view": {
					const snapshot = await host.snapshot();
					if (!snapshot.ok) {
						result = { ok: false, reason: snapshot.reason };
						break;
					}
					const committed = await host.committedEvents();
					if (!committed.ok) {
						result = { ok: false, reason: committed.reason };
						break;
					}
					const status = await host.status();
					const files =
						params.files === false
							? null
							: await listWorkspace(workspace)
									.then((row) =>
										row.entries.map((entry) => ({
											path: entry.name,
											kind: entry.kind,
											size: entry.size,
											modified_at: entry.modified_at,
										})),
									)
									.catch(() => null);
					result = {
						ok: true,
						status,
						view: buildWebView({
							label,
							taskId,
							events: committed.events ?? [],
							board: snapshot.board,
							state: snapshot.state,
							workCycle: snapshot.workCycle,
							status,
							workspaceFiles: files,
							limits: VIEW_LIMITS,
						}),
						cursor: {
							offset: (committed.events ?? []).length,
						},
					};
					break;
				}
				case "dispatch":
					result = await control.dispatch({ requestId: params.request_id, text: params.text });
					break;
				case "models":
					result = await control.models();
					break;
				case "set_thinking":
					result = await control.setThinking(params.level);
					break;
				case "set_model":
					result = await control.setModel({ provider: params.provider, id: params.model });
					break;
				case "pause":
					result = await control.pause(params.reason);
					break;
				case "resume":
					result = await control.resume(params.reason);
					break;
				case "stop":
					writeControlLine({ id, ok: true, result: { ok: true } });
					await shutdown(params.reason ?? "web stop");
					return;
				case "request_status":
					result = await control.requestStatus(params.request_id);
					break;
				default:
					result = { ok: false, code: "invalid_request", reason: `unknown command ${String(cmd)}` };
			}
			writeControlLine({ id, ...(result ?? { ok: false, reason: "no result" }) });
		} catch (error) {
			writeControlLine({
				id,
				ok: false,
				code: "internal_error",
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	};
	let buffer = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line) await handle(line);
			index = buffer.indexOf("\n");
		}
	}
	await shutdown("control channel closed");
	return 0;
}

function describeStatus(status) {
	const lines = [
		`console   ${status.console_status}${status.block_reason ? ` (${status.block_reason})` : ""}`,
		`task      ${status.task_id}   episode ${status.episode_id ?? "none"} (${status.episode_status ?? "none"})`,
		`session   ${status.session_id ?? "none"}  file=${status.session_file ?? "none"}`,
		`rotation  applied=${status.auto_rotations}/${status.policy.max_auto_rotations} committed=${status.rotations_completed} continuations=${status.continuations}/${status.policy.max_continuations}`,
		`work unit ${status.work_unit_state ?? "unknown"}  scope=${status.work_unit_id ?? "none"}  cycle=${status.work_cycle_status ?? "unknown"}`,
	];
	if (status.trigger_id)
		lines.push(`hold      trigger=${status.trigger_id} review=${status.review_event_id ?? "none"}`);
	if (status.bootstrap_review) lines.push("hold      bootstrap (no work unit at stall)");
	if (status.pending_actions?.length) lines.push(`pending   ${status.pending_actions.length} unfinished action(s)`);
	if (status.unknown_actions?.length)
		lines.push(`unknown   ${status.unknown_actions.length} unresolved side effect(s)`);
	if (status.last_committed_cursor)
		lines.push(
			`cursor    ${status.last_committed_cursor.offset} events (projection=${status.last_committed_cursor.projection_source}, tail=${status.last_committed_cursor.tail_rows})`,
		);
	if (status.stop_reason) lines.push(`stopped   ${status.stop_reason}`);
	return lines.join("\n");
}

async function main(argv) {
	const args = parseConsoleArgs(argv);
	if (args.help) {
		usage();
		return 0;
	}
	const label = args.label ?? env("AEGIS_EXPERIMENT_LABEL");
	const taskId = args.taskId ?? env("AEGIS_TASK_ID");
	if (!label || !taskId) {
		usage(process.stderr);
		process.stderr.write("experiment-console: --label and --task-id are required\n");
		return 2;
	}
	const workspace = resolve(args.workspace ?? process.cwd());
	const eventLogPath = args.eventLogPath ?? env("AEGIS_EVENT_LOG");
	const handoffPath = args.handoffPath ?? env("AEGIS_HANDOFF_FILE");
	if (!eventLogPath || !handoffPath) {
		process.stderr.write("experiment-console: AEGIS_EVENT_LOG and AEGIS_HANDOFF_FILE are required\n");
		return 2;
	}
	const runtimeDir = dirname(eventLogPath);
	const checkpointPath =
		args.checkpointPath ??
		(env("AEGIS_PROJECTION_DIR", null)
			? join(env("AEGIS_PROJECTION_DIR"), "console-projection.json")
			: join(runtimeDir, "projections", "console-projection.json"));
	const sessionDir = args.sessionDir ?? env("AEGIS_PI_SESSION_DIR", join(runtimeDir, "sessions"));
	const agentDir = args.agentDir ?? env("AEGIS_PI_AGENT_DIR");
	if (!agentDir) {
		process.stderr.write("experiment-console: AEGIS_PI_AGENT_DIR is required (no implicit user default)\n");
		return 2;
	}
	const ownershipBaseDir = args.ownershipBaseDir ?? join(runtimeDir, "console");
	const providerKind = args.provider ?? env("AEGIS_CONSOLE_PROVIDER", "pi-config");
	const model = args.model ?? env("AEGIS_CONSOLE_MODEL", null);

	// The start gate is part of THIS Host's contract: it is bound before the
	// Observer loads, and a caller cannot widen it per prompt.
	if (process.env.AEGIS_WORK_START_GATE === undefined) process.env.AEGIS_WORK_START_GATE = "on";

	const consolePolicy = resolveConsolePolicy(process.env);
	let adapter = null;
	// The SDK runtime is created by the Host AFTER it acquired the experiment
	// ownership and bound the single EventLog writer. Creating (and binding) a
	// Session earlier would let a refused second console append `session.started`
	// to the live run's EventLog.
	const host = createExperimentConsole({
		label,
		taskId,
		eventLogPath,
		handoffPath,
		checkpointPath,
		ownershipBaseDir,
		sessionFactory: async () => {
			const selected = resolveToolSelection(args.tools ?? DEFAULT_CODING_TOOLS);
			if (!selected.ok) throw new Error(selected.error);
			const sdk = await import("@earendil-works/pi-coding-agent");
			const sdkBase = await import("@earendil-works/pi-coding-agent/core/auth-storage").catch(() => null);
			adapter = await createConsoleSdkRuntime({
				sdk: { ...sdk, ...(sdkBase ?? {}) },
				providerKind,
				model,
				cwd: workspace,
				agentDir,
				sessionDir,
				tools: selected.tools,
				thinkingLevel: args.thinking ?? null,
				onText: controlMode ? emitDelta : null,
			});
			return adapter;
		},
		consolePolicy,
		manifest: null,
		continuation: (handoff) =>
			`[Aegis console] continue the SAME task/episode ${handoff.episode_id}. The work-cycle hold (if any) is unchanged: review and a new scoped Intent are still required before any side effect. Do not re-run actions whose result is already committed.`,
	});

	const controlMode = args.control === "stdio";
	if (!controlMode) process.stdout.write(`Aegis Experiment Console ${EXPERIMENT_CONSOLE_VERSION}\n`);
	const started = await host.start();
	if (!started.ok) {
		// A refused/failed start is NOT a console: report the real reason, release
		// our own resources (already done by the Host) and exit non-zero.
		if (!controlMode) {
			process.stdout.write(`console refused at startup: ${started.reason}\n`);
			process.stdout.write(`${describeStatus(await host.status())}\n`);
		}
		process.stderr.write(`experiment-console: startup refused: ${started.reason}\n`);
		if (controlMode)
			writeControlLine({
				type: "refused",
				reason: started.reason,
				ownership_conflict: started.ownership_conflict === true,
				status: await host.status(),
			});
		await host.shutdown("startup refused");
		return started.ownership_conflict ? 4 : 3;
	}
	if (controlMode) return serveControlChannel({ host, label, taskId, workspace, modelLabel: null });
	const startedStatus = await host.status();
	process.stdout.write(`${describeStatus(startedStatus)}\n`);
	// Explicit, machine-usable readiness barrier: ownership is held and the
	// initial Session is bound exactly once.
	process.stdout.write(
		`Aegis console ready: label=${label} ownership=held session=${startedStatus.session_id ?? "none"} episode=${startedStatus.episode_id ?? "none"}\n`,
	);
	process.stdout.write("Type /help for console controls. /stop exits.\n");

	const inputs = [...args.prompts];
	if (args.promptFile) {
		const { readFileSync } = await import("node:fs");
		const text = readFileSync(args.promptFile, "utf8");
		for (const line of text.split("\n")) if (line.trim()) inputs.push(line.trim());
	}

	async function handleInput(raw) {
		const line = raw.trim();
		if (!line) return { continue: true };
		if (line === "/quit" || line === "/stop" || line === "/exit") {
			process.stdout.write("stopping console...\n");
			await host.shutdown("operator stop");
			return { continue: false, exit: 0 };
		}
		if (line === "/help") {
			process.stdout.write(
				[
					"<text>    dispatch a prompt to the current Task/Episode",
					"/status   show the derived Host/session/work-cycle status",
					"/pause    stop dispatching (keeps the Session)",
					"/resume   clear a pause/block after recovery checks",
					"/stop     dispose the Session and release the experiment lease",
					"/quit     alias for /stop",
					"",
				].join("\n"),
			);
			return { continue: true };
		}
		if (line === "/status") {
			process.stdout.write(`${describeStatus(await host.status())}\n`);
			return { continue: true };
		}
		if (line === "/pause") {
			const result = host.pause();
			process.stdout.write(`${result.ok ? "paused" : `not paused: ${result.reason}`}\n`);
			return { continue: true };
		}
		if (line === "/resume") {
			const result = await host.resume();
			process.stdout.write(`${result.ok ? "running" : `blocked: ${result.reason}`}\n`);
			return { continue: true };
		}
		const result = await host.dispatch(line);
		process.stdout.write(`\n${describeStatus(result.status ?? (await host.status()))}\n`);
		if (!result.ok) process.stdout.write(`turn blocked: ${result.reason}\n`);
		return { continue: true };
	}

	let exitCode = 0;
	for (const prompt of inputs) {
		const outcome = await handleInput(prompt);
		if (outcome.continue === false) {
			exitCode = outcome.exit ?? 0;
			return exitCode;
		}
	}
	if (args.nonInteractive) {
		await host.shutdown("non-interactive run finished");
		return exitCode;
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "aegis> " });
	rl.prompt();
	let queued = Promise.resolve();
	rl.on("line", (line) => {
		queued = queued.then(async () => {
			const outcome = await handleInput(line);
			if (outcome.continue === false) {
				rl.close();
				return;
			}
			rl.prompt();
		});
	});
	await new Promise((resolveExit) => rl.on("close", resolveExit));
	await queued;
	if (host.phase() !== "stopped") await host.shutdown("input closed");
	return exitCode;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exit(code ?? 0);
		},
		(error) => {
			process.stderr.write(`experiment-console: ${error instanceof Error ? error.stack : String(error)}\n`);
			process.exit(1);
		},
	);
}
