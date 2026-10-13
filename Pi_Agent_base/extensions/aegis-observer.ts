// Aegis Observer + Runtime (thin Pi adapter).
//
// This extension keeps the Observer's real event collection and adds the
// event-sourced Runtime projection. It is the single writer for one run/task
// event log (`AEGIS_EVENT_LOG`) and delegates all projection/validation to the
// small Aegis core library under `memory/runtime/`:
//
//   events.mjs   append-only hash-chained EventLog + replay
//   board.mjs    Origin/Fact/Refuted/Intent/Hint/Artifact projection + write gate
//   state.mjs    task/episode binding, pending actions, routing/handoff state
//   ram.mjs      bounded per-request RAM projection
//   proposal.mjs LLM proposal validation (claims/intents/hints only)
//   handoff.mjs  short-session switch safety
//
// Key behaviour:
//   * ROM and RAM are injected through Pi's STRUCTURED prompt sections
//     (`aegis_rom`, `aegis_ram`), never by replacing the whole system prompt, so
//     the contest extension's `aegis_hints` section composes cleanly.
//   * RAM is rebuilt for EVERY provider-bound request through the
//     `context_with_system` seam (not once per prompt), so a tool the model just
//     ran is reflected in the very next request of the same prompt. Each
//     request records a `request.projected` audit row (digest + state version);
//     the row creates no board node and does not bump RuntimeState.
//   * One Episode is kept for one task id across prompts and sessions; a new
//     task id starts a new Episode.
//   * The model may only propose (`aegis_propose`) and request a handoff
//     (`aegis_switch_session`). It can never write Fact/Refuted/active state.
//   * A handoff completion is recorded by the NEW session's `session_start`
//     exactly once; the old session's `/aegis switch` `withSession` callback is
//     idempotent and never appends through a torn-down log. The switch is
//     cancelled/failed closed without renaming the staged request (no fake
//     success). `agent.settled` records `handoff_ready` for the thin host helper
//     (`memory/runtime/handoff-host.mjs`) to apply on the real runtime.
//   * If the audit log cannot be written, side-effect tools fail closed; read
//     tools may continue.
//
// Configuration (env so tests isolate every path):
//   AEGIS_EVENT_LOG     append-only event JSONL (default runtime/events.jsonl)
//   AEGIS_ROM_FILE      stable ROM markdown
//   AEGIS_RAM_DIR       RAM + handoff projection dir
//   AEGIS_HANDOFF_FILE  optional explicit handoff path
//   AEGIS_TASK_ID       task binding; defaults to the Pi session id

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { observationConfigFromEnv, runObservationCommand } from "../memory/campaign/observation-command.mjs";
import {
	createObserveActionRuntime,
	dataUseNote,
	inspectScriptRegistration,
	observationDataNote,
	observeEventPayloads,
	rejectionNote,
} from "../memory/runtime/action-runtime.mjs";
import { projectBoard, summarizeBoard } from "../memory/runtime/board.mjs";
import { appendContestOutcome, readContestResults, resolveContestOutcome } from "../memory/runtime/contest-bridge.mjs";
import { contributionPayload, recordStageContribution } from "../memory/runtime/contribution.mjs";
import { digest, EventLog, eventId, schemaForEventType } from "../memory/runtime/events.mjs";
import { normalizeExperienceDecision } from "../memory/runtime/experience.mjs";
import { evaluateHandoff } from "../memory/runtime/handoff.mjs";
import { createLearningBridge } from "../memory/runtime/learning-bridge.mjs";
import * as learningCommands from "../memory/runtime/learning-commands.mjs";
import { createLearningStore } from "../memory/runtime/learning-store.mjs";
import { proposalPayload, validateProposal } from "../memory/runtime/proposal.mjs";
import { buildRam } from "../memory/runtime/ram.mjs";
import { validateResourceParams } from "../memory/runtime/script-registry.mjs";
import { episodeHasSession, projectState, resolveOpenEpisode } from "../memory/runtime/state.mjs";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVER_VERSION = "0.2.0";
const MAX_EXCERPT = 800;

// Tools that never mutate the workspace. They are allowed to continue while the
// audit log is unavailable; everything else fails closed.
const READ_ONLY_TOOLS = new Set(["read", "ls", "grep", "find", "glob", "webfetch", "websearch", "aegis_observe"]);

function eventLogPath() {
	return process.env.AEGIS_EVENT_LOG || join(BASE_DIR, "runtime", "events.jsonl");
}
function romPath() {
	return process.env.AEGIS_ROM_FILE || join(BASE_DIR, "agent", "ROM.md");
}
function ramDir() {
	return process.env.AEGIS_RAM_DIR || join(BASE_DIR, "runtime", "ram");
}
function handoffPath() {
	return process.env.AEGIS_HANDOFF_FILE || join(ramDir(), "handoff.json");
}
function projectionDir() {
	return process.env.AEGIS_PROJECTION_DIR || join(dirname(eventLogPath()), "projections");
}
function contestResultsPath() {
	return process.env.AEGIS_CONTEST_RESULTS || join(BASE_DIR, "runtime", "contest", "results.jsonl");
}

// --- Batch E: controlled learning-loop configuration ----------------------
// The compiled-Experience store is a DERIVED, rebuildable view; the
// authoritative record is an append-only `runtime.note`. Both paths default
// below the run's runtime dir so tests can isolate them.
function experienceDir() {
	return process.env.AEGIS_EXPERIENCE_DIR || join(dirname(eventLogPath()), "experiences");
}
// A human/launcher-configured TRUSTED isolated replay adapter module. Absent =>
// unconfigured; a replay is never attempted and never fabricated. The MODEL can
// never set this path and the string is never `eval`'d (it is imported as a
// module).
function replayAdapterPath() {
	const configured = process.env.AEGIS_REPLAY_ADAPTER;
	return configured?.trim() ? configured : null;
}
// --- Batch C: verify-first action runtime configuration -------------------
// The TASK workspace is the user-given target. It is never an OS sandbox; it
// only bounds which files the observe/execute actions may touch.
function workspaceRootOrCwd(cwd?: string): string {
	return process.env.AEGIS_CONTEST_WORKSPACE || process.env.AEGIS_WORKSPACE || cwd || process.cwd();
}
// auto | normal. Default `normal`: without an explicit approval the runtime does
// not effect. `auto` is a user-granted default path, NOT a verification result.
function actionMode(): "auto" | "normal" {
	return String(process.env.AEGIS_ACTION_MODE || "normal").toLowerCase() === "auto" ? "auto" : "normal";
}
// Optional human-provided script registration source. Absent => unconfigured; the
// runtime NEVER self-registers a contest/remote script. A `.json` file may only
// declare data fields; a `.mjs`/`.js` module may additionally export real
// `verify()` post-condition Oracles as trusted local code. The MODEL can never
// set this path (it comes from the human/launcher environment).
function scriptConfigPath(): string | null {
	const configured = process.env.AEGIS_SCRIPT_CONFIG;
	return configured?.trim() ? configured : null;
}
async function loadScriptConfig(): Promise<{ scripts: unknown[] }> {
	const path = scriptConfigPath();
	if (!path) return { scripts: [] };
	try {
		if (path.endsWith(".json")) {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			return { scripts: parsed && Array.isArray(parsed.scripts) ? parsed.scripts : [] };
		}
		const mod = (await import(pathToFileURL(resolve(path)).href)) as { scripts?: unknown; default?: unknown };
		const candidate = Array.isArray(mod.scripts)
			? mod.scripts
			: Array.isArray((mod.default as { scripts?: unknown })?.scripts)
				? (mod.default as { scripts: unknown[] }).scripts
				: Array.isArray(mod.default)
					? mod.default
					: [];
		return { scripts: candidate };
	} catch (error) {
		process.stderr.write(`[aegis-observer] script config unreadable (${path}): ${String(error)}\n`);
		return { scripts: [] };
	}
}

/**
 * Build the action runtime for the current workspace. Kept lazy + cached per
 * extension instance so the registry/authorization mirrors the real run. The
 * model can never influence this construction.
 */

function redact(value) {
	return String(value)
		.replace(/(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
		.replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[REDACTED_KEY]");
}
function excerpt(value, limit = MAX_EXCERPT) {
	const text = redact(value).replaceAll("\0", "");
	return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}
function textFromContent(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && part.type === "text")
		.map((part) => part.text || "")
		.join("\n");
}

/** Render a named prompt section the same way `buildSystemPromptSections` does. */
function sectionWrapped(name: string, value: string): string {
	return `<${name}>\n${value}\n</${name}>`;
}
function sessionKey(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return "unknown-session";
	}
}
function source(kind = "runtime") {
	return { actor_id: "pi", kind, adapter: "aegis-observer", version: OBSERVER_VERSION };
}
function summarizeToolInput(toolName: string, input: unknown) {
	const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const keys = Object.keys(value).sort();
	const result: Record<string, unknown> = { keys, input_digest: digest(value) };
	if ((toolName === "bash" || toolName === "powershell") && typeof value.command === "string") {
		result.command_excerpt = excerpt(value.command);
	} else if (typeof value.path === "string") {
		result.path = excerpt(value.path, 300);
	} else if (typeof value.operation === "string") {
		result.operation = excerpt(value.operation, 300);
	}
	return result;
}

export default function aegisRuntime(pi: ExtensionAPI): void {
	let log: EventLog | null = null;
	let board: ReturnType<typeof projectBoard> = projectBoard([]);
	let state = projectState([]);
	let sessionId = "unknown-session";
	let taskId = "";
	let episodeId: string | undefined;
	let currentGoal = "";
	let currentPromptEventId: string | undefined;
	let cliWorkspace = "";
	let auditUnavailable = false;
	const writeFailures: string[] = [];
	let actionRuntimeCache: { workspaceRoot: string; runtime: ReturnType<typeof createObserveActionRuntime> } | null =
		null;

	/** Build (and cache per instance) the verify-first action runtime. */
	async function actionRuntimeFor(workspaceRoot: string) {
		if (actionRuntimeCache && actionRuntimeCache.workspaceRoot === workspaceRoot) return actionRuntimeCache.runtime;
		const mode = actionMode();
		const allowNetwork = process.env.AEGIS_ALLOW_NETWORK === "1";
		const runtime = createObserveActionRuntime({
			workspaceRoot,
			scriptRegistrationConfig: await loadScriptConfig(),
			authorizationConfig: {
				mode,
				workspaceRoot,
				allowedTools: ["aegis_workspace", "aegis_script"],
				allowNetwork,
				approved: mode === "auto",
			},
		});
		actionRuntimeCache = { workspaceRoot, runtime };
		return runtime;
	}

	/** Rebuild the trusted ref resolver from the COMMITTED event log on demand. */
	function trustedResolver(runtime: ReturnType<typeof createObserveActionRuntime>) {
		const events = log ? log.replay() : [];
		return runtime.buildEventResolver({
			events,
			supersededOutcomeIds: board.effective?.superseded_outcome_ids ?? [],
		});
	}

	/**
	 * Build the production learning bridge over the COMMITTED event log.
	 *
	 * The registry/broker come from the human-configured action runtime (never a
	 * model message); the resolver is rebuilt from the committed rows each call, so
	 * a restarted process sees the same truth. The replay adapter is loaded from an
	 * explicitly configured module path (absent => unconfigured).
	 */
	async function learningBridgeFor(): Promise<ReturnType<typeof createLearningBridge>> {
		const runtime = await actionRuntimeFor(workspaceRootOrCwd(cliWorkspace || undefined));
		const events = log ? log.replay() : [];
		const adapterInfo = await learningCommands.loadReplayAdapterModule(replayAdapterPath());
		const scope = taskId ? { task_id: taskId } : null;
		return createLearningBridge({
			events,
			board,
			state,
			scope,
			registry: runtime.registry,
			broker: runtime.broker,
			authorization: runtime.authorization,
			replayAdapter: adapterInfo.adapter ?? null,
			environment: {
				environment_fingerprint: process.env.AEGIS_ENVIRONMENT_FINGERPRINT || "local-workspace",
				domain: process.env.AEGIS_DOMAIN || null,
				permissions: ["workspace-script"],
				task_types: [],
			},
			sink: log
				? {
						append: (row: Record<string, unknown>) => log!.append(row as Parameters<EventLog["append"]>[0]),
					}
				: null,
		});
	}

	async function ensureLog(ctx: ExtensionContext): Promise<EventLog> {
		if (log) return log;
		log = new EventLog(eventLogPath(), {
			onError: (message) => {
				auditUnavailable = true;
				process.stderr.write(`[aegis-observer] ${message}\n`);
				if (ctx.hasUI) ctx.ui.notify(`Aegis audit failure: ${message}`, "error");
			},
		});
		const opened = await log.open();
		if (!opened.ok) {
			auditUnavailable = true;
			process.stderr.write(`[aegis-observer] audit unavailable: ${opened.error}\n`);
		}
		return log;
	}

	function refreshProjections() {
		if (!log) return;
		const events = log.replay();
		board = projectBoard(events);
		state = projectState(events);
	}

	// Projection snapshots are derived, rebuildable views of the committed
	// event log (board + RuntimeState), NOT a second truth source. They exist so
	// the daily/review tooling can read a stable JSON view without re-implementing
	// the reducer. Only the run's own event log is authoritative; deleting these
	// files loses nothing. Text is redacted before writing so a snapshot never
	// persists a secret the audit log already excerpted.
	let lastSnapshotDigest: string | null = null;
	async function persistProjections(): Promise<void> {
		if (!log || !log.healthy) return;
		const events = log.replay();
		const rebuiltBoard = projectBoard(events);
		const rebuiltState = projectState(events);
		const source = {
			event_count: events.length,
			last_event_digest: events.length ? events[events.length - 1].event_digest : null,
		};
		const snapshotDigest = digest({ board: rebuiltBoard.digest, state_version: rebuiltState.version, source });
		if (snapshotDigest === lastSnapshotDigest) return;
		const dir = projectionDir();
		const redactDeep = (value: unknown): unknown => {
			if (typeof value === "string") return redact(value);
			if (Array.isArray(value)) return value.map(redactDeep);
			if (value && typeof value === "object") {
				return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]));
			}
			return value;
		};
		const payload = {
			schema_version: "1.1",
			rebuildable: true,
			note: "derived projection; the append-only event log is authoritative",
			snapshot_digest: snapshotDigest,
			source,
			board: redactDeep({
				digest: rebuiltBoard.digest,
				counts: summarizeBoard(rebuiltBoard).counts,
				nodes: rebuiltBoard.byType,
				rejections: rebuiltBoard.rejections,
			}),
			state: redactDeep(rebuiltState),
		};
		try {
			await mkdir(dir, { recursive: true });
			const latest = join(dir, "latest.json");
			const tmp = `${latest}.${process.pid}.tmp`;
			await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
			await rename(tmp, latest);
			lastSnapshotDigest = snapshotDigest;
		} catch (error) {
			// A snapshot failure must never break the audit chain or a tool call.
			// It is a derived convenience view, not authoritative state.
			process.stderr.write(`[aegis-observer] projection snapshot failed: ${String(error)}\n`);
		}
	}

	async function emit(
		eventType: string,
		payload: Record<string, unknown>,
		options: {
			episode_id?: string | null;
			source_kind?: string;
			causation_id?: string;
			evidence_refs?: unknown[];
			schema_version?: string;
		} = {},
	) {
		const active = await ensureLog(commandCtx ?? fallbackCtx);
		const schemaVersion = options.schema_version ?? schemaForEventType(eventType) ?? undefined;
		const result = await active.append({
			event_type: eventType,
			episode_id: options.episode_id === undefined ? (episodeId ?? null) : options.episode_id,
			payload,
			source: source(options.source_kind),
			evidence_refs: options.evidence_refs || [],
			causation_id: options.causation_id,
			schema_version: schemaVersion,
		});
		if (!result.ok) {
			auditUnavailable = true;
			writeFailures.push(result.error || "unknown audit failure");
			// A non-durable append (e.g. directory fsync failed) still recorded the
			// event in memory with its sequence reserved, so the in-memory projections
			// stay consistent with what will be retried. Refresh them anyway.
			refreshProjections();
			return result;
		}
		if (eventType === "prompt.received" && result.event) {
			currentPromptEventId = result.event.event_id;
		}
		// Rebuild the derived projections from the just-committed events and persist
		// a rebuildable snapshot. Never blocks or throws into the caller.
		refreshProjections();
		await persistProjections();
		return result;
	}

	// `emit` needs a context only for error UI. Keep the most recent one.
	let commandCtx: ExtensionContext | null = null;
	const fallbackCtx = { hasUI: false, ui: { notify: () => undefined } } as unknown as ExtensionContext;

	async function loadRom() {
		try {
			return (await readFile(romPath(), "utf8")).trim();
		} catch (error) {
			process.stderr.write(`[aegis-observer] ROM unavailable: ${String(error)}\n`);
			return "";
		}
	}

	/**
	 * True when `handoff.completed` for `requestId` is already durable on disk.
	 *
	 * The completion is written by the NEW session's first `before_agent_start`
	 * (`recordStagedHandoffCompletion`), which runs only after the SDK rebound the
	 * Session and its extension bind succeeded. The old session's `withSession`
	 * callback runs before the new prompt and must NOT write a completion, and
	 * must not resurrect a closed EventLog handle. Reading the committed file is
	 * the check that works across both extension instances, so completion stays
	 * idempotent even when a rebind races the callback.
	 */
	async function handoffAlreadyCompleted(requestId: string | undefined): Promise<boolean> {
		if (!requestId) return false;
		let text = "";
		try {
			text = await readFile(eventLogPath(), "utf8");
		} catch {
			return false;
		}
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const row = JSON.parse(line);
				if (row?.event_type === "handoff.completed" && row.payload?.request_id === requestId) return true;
			} catch {
				// trailing partial line: ignore, the committed rows are what matter
			}
		}
		return false;
	}

	/**
	 * HOST-OWNED COMPLETION at the post-bind boundary. A staged handoff whose
	 * episode is still open is recorded as `handoff.completed` exactly once, and
	 * the staged file is retired only after the durable append. Called from
	 * `before_agent_start` (the first prompt of the replacement Session, which is
	 * strictly after the SDK rebind/extension bind succeeded).
	 */
	async function recordStagedHandoffCompletion(): Promise<void> {
		let handoff: { episode_id?: string; request_id?: string } | null = null;
		try {
			handoff = JSON.parse(await readFile(handoffPath(), "utf8"));
		} catch {
			return; // no staged handoff
		}
		if (!handoff?.episode_id || !handoff.request_id) return;
		const episode = state.episodes[handoff.episode_id];
		if (!episode || (episode.status !== "open" && episode.status !== "active")) return;
		// Bind the completion to THIS (the new) session, which is the one that has
		// actually started.
		if (await handoffAlreadyCompleted(handoff.request_id)) {
			await rename(handoffPath(), `${handoffPath()}.applied.json`).catch(() => undefined);
			return;
		}
		const recorded = await emit(
			"handoff.completed",
			{ request_id: handoff.request_id, to_session: sessionId, episode_id: handoff.episode_id },
			{ episode_id: handoff.episode_id, source_kind: "runtime" },
		);
		if (!recorded.ok) {
			process.stderr.write(
				`[aegis-observer] handoff.completed was not committed (${recorded.error || "audit unavailable"}); leaving the staged handoff for recovery\n`,
			);
			return;
		}
		await rename(handoffPath(), `${handoffPath()}.applied.json`).catch(() => undefined);
	}

	async function handleSessionStart(ctx: ExtensionContext) {
		await ensureLog(ctx);
		sessionId = sessionKey(ctx);
		if (!cliWorkspace && ctx.cwd) cliWorkspace = ctx.cwd;
		refreshProjections();
		// A pending handoff from a previous short session: bind the SAME episode so
		// the new Session continues the task. Session != Episode. The COMPLETION
		// record is NOT written here: `session_start` fires inside the SDK bind
		// callback, before the Host has confirmed the whole create/bind/continuation
		// cycle. The trusted Host (handoff-host / the supervisor, or the `/aegis
		// switch` command after `newSession` returns) owns `handoff.completed` and
		// retires the staged file. Only an OPEN episode may be resumed from a staged
		// handoff; a stale file for a closed/moved episode is ignored and left on
		// disk (never silently grants continuation).
		try {
			const raw = await readFile(handoffPath(), "utf8");
			const handoff = JSON.parse(raw);
			const episode = handoff?.episode_id ? state.episodes[handoff.episode_id] : null;
			if (handoff?.episode_id && episode && (episode.status === "open" || episode.status === "active")) {
				episodeId = handoff.episode_id;
				taskId = handoff.task_id || episode.task_id || taskId;
				currentGoal = episode.goal?.description || currentGoal;
			} else if (handoff?.episode_id) {
				process.stderr.write(
					`[aegis-observer] ignoring stale handoff for ${handoff.episode_id}: episode is ${episode ? episode.status : "missing"}\n`,
				);
			}
		} catch {
			// no pending handoff
		}
		await emit(
			"session.started",
			{ reason: "session_start", cwd: ctx.cwd, session_id: sessionId, task_id: taskId || null },
			{ episode_id: episodeId ?? null },
		);
		refreshProjections();
	}

	pi.on("session_start", async (_event, ctx) => {
		commandCtx = ctx;
		await handleSessionStart(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		commandCtx = ctx;
		await ensureLog(ctx);
		sessionId = sessionKey(ctx);
		if (ctx.cwd) cliWorkspace = ctx.cwd;
		taskId = process.env.AEGIS_TASK_ID || taskId || sessionId;
		refreshProjections();

		// HOST-OWNED COMPLETION (post-bind). A switch is only complete once the
		// new Session has actually started its first prompt, which happens AFTER
		// the SDK rebound the Session and its extension bind succeeded. Writing
		// the completion at `session_start` was too early (that fires inside
		// `bindExtensions`, before the Host rebind/continuation finished).
		// This is idempotent and reads the staged request as the trigger.
		await recordStagedHandoffCompletion();

		const existing = resolveOpenEpisode(state, taskId);
		if (existing) {
			episodeId = existing.episode_id;
			// Reuse the ORIGINAL goal from Origin/RuntimeState; a short follow-up
			// prompt must not overwrite the episode's total goal.
			currentGoal = existing.goal?.description || currentGoal;
			await emit(
				"prompt.received",
				{
					prompt_digest: digest(event.prompt || ""),
					prompt_chars: (event.prompt || "").length,
					cwd: ctx.cwd,
					session_id: sessionId,
				},
				{ source_kind: "runtime" },
			);
		} else {
			episodeId = eventId();
			currentPromptEventId = undefined;
			currentGoal = event.prompt || "";
			await emit(
				"episode.started",
				{
					task_id: taskId,
					session_id: sessionId,
					goal: { description: excerpt(currentGoal, 2000), prompt_digest: digest(currentGoal) },
					environment: { cwd: ctx.cwd },
					source_kind: process.env.AEGIS_EPISODE_SOURCE_KIND || "live",
					authorization: process.env.AEGIS_AUTHORIZATION || "unknown",
					budget: process.env.AEGIS_BUDGET || "unknown",
				},
				{ source_kind: "runtime" },
			);
		}
		refreshProjections();

		const ram = buildRam({ board, state, episodeId, goal: currentGoal });
		const rom = await loadRom();
		const options = event.systemPromptOptions as { sections?: Record<string, string> } | undefined;
		if (options?.sections) {
			if (rom) options.sections.aegis_rom = rom;
			options.sections.aegis_ram = ram;
		}
		return undefined;
	});

	// -----------------------------------------------------------------------
	// Per-request RAM refresh. `before_agent_start` fires once per prompt, so its
	// RAM goes stale as tools execute WITHIN the same prompt. This handler fires
	// immediately before every provider-bound request (Pi's `transformContext`
	// seam) and rebuilds the effective RAM from the committed Events, then patches
	// only the Aegis sections of the leading system message for THIS request. The
	// result is not persisted, so the transcript never accumulates stale RAM
	// copies and the contest's `aegis_hints` section is preserved untouched.
	// -----------------------------------------------------------------------
	pi.on("context_with_system", async (event, ctx) => {
		commandCtx = ctx;
		if (!log || !episodeId) return undefined;
		sessionId = sessionKey(ctx);
		refreshProjections();
		const messages = event.messages as Array<Record<string, unknown>>;
		if (!Array.isArray(messages) || messages.length === 0) return undefined;
		const systemIndex = messages.findIndex((message) => message && message.role === "system");
		if (systemIndex < 0) return undefined;
		const target = messages[systemIndex];
		const sections: Record<string, string | null> = {
			...((target.sections as Record<string, string | null> | undefined) ?? {}),
		};
		// Only the leading system message owns the Aegis sections; strip them from
		// any later system patch so a trailing `aegis_ram` cannot revive old RAM.
		for (let i = systemIndex + 1; i < messages.length; i += 1) {
			const message = messages[i];
			if (!message || message.role !== "system") continue;
			const other = message.sections as Record<string, string | null> | undefined;
			if (!other || (!("aegis_ram" in other) && !("aegis_rom" in other))) continue;
			const cleaned = { ...other };
			delete cleaned.aegis_ram;
			delete cleaned.aegis_rom;
			message.sections = cleaned;
		}
		const ram = buildRam({ board, state, episodeId, goal: currentGoal });
		const rom = await loadRom();
		sections.aegis_ram = sectionWrapped("aegis_ram", ram);
		if (rom) sections.aegis_rom = sectionWrapped("aegis_rom", rom);
		else delete sections.aegis_rom;
		target.sections = sections;
		// Audit that this genuinely provider-bound request was projected from the
		// committed Events: the RAM digest + state revision are recorded, and the
		// event creates no board node and does not bump RuntimeState, so it can
		// never recurse into the next RAM.
		await emit(
			"request.projected",
			{
				ram_digest: digest(ram),
				ram_estimated_chars: ram.length,
				state_version: state.version,
				board_digest: board.digest,
				effective_digest: board.effective_digest,
				provider_bound: true,
			},
			{ episode_id: episodeId, source_kind: "runtime" },
		);
		return { messages: messages as never };
	});

	pi.on("agent_start", async () => {
		await emit("agent.started", {});
	});

	// -----------------------------------------------------------------------
	// Contest injection decision via the SHARED Pi event bus.
	//
	// The contest extension matches hint cards and decides what to inject into
	// the next request. It EMITS that decision; the Observer owns the ONE
	// durable write. This is deliberately not a second EventLog writer: the
	// bus is a message channel, the observer is the single writer. The recorded
	// node is an `experience.decision` (a routing fact about what was shown) -
	// NOT an active Experience and NOT verified truth. A card stays a Hint.
	// -----------------------------------------------------------------------
	let unsubscribeDecision = pi.events?.on?.("aegis.contest.decision", (message: Record<string, unknown>) => {
		void (async () => {
			try {
				const payload = normalizeExperienceDecision(message, {
					episodeId: episodeId ?? null,
					promptEventId: currentPromptEventId ?? null,
				});
				await emit("experience.decision", payload, {
					episode_id: episodeId ?? null,
					source_kind: "runtime",
					causation_id: currentPromptEventId,
				});
			} catch (error) {
				process.stderr.write(`[aegis-observer] contest decision record failed: ${String(error)}\n`);
			}
		})();
	});

	pi.on("turn_start", async (event) => {
		await emit("turn.started", { turn_index: event.turnIndex, timestamp_ms: event.timestamp });
	});

	pi.on("tool_call", async (event, ctx) => {
		commandCtx = ctx;
		// Aegis control tools are not workspace side effects: they must not be
		// recorded as pending actions, or a handoff request would count itself
		// and always refuse its own switch. They still fail closed if the audit
		// log is unavailable (accepted below via the generic guard).
		// `aegis_observe`/`aegis_execute` are control tools for the same reason:
		// they record their own action INTENT via the durable `emit` (so the
		// fsync-before-effect ordering is inside the tool, not the generic hook),
		// and they fail closed themselves when the audit is unavailable.
		const isControl =
			event.toolName === "aegis_propose" ||
			event.toolName === "aegis_switch_session" ||
			event.toolName === "aegis_observe" ||
			event.toolName === "aegis_execute";
		if (!isControl) {
			const result = await emit("action.requested", {
				action_id: event.toolCallId,
				tool_name: event.toolName,
				input: summarizeToolInput(event.toolName, event.input),
			});
			refreshProjections();
			if (!result.ok || auditUnavailable) {
				if (!READ_ONLY_TOOLS.has(event.toolName)) {
					return {
						block: true,
						reason: `Aegis: audit log is unavailable (${result.error || "previous write failure"}); refusing a side-effecting tool so no unlogged action runs. Read-only tools may continue.`,
					};
				}
			}
		}
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		// `aegis_observe`/`aegis_execute` record their OWN `action.completed` with the
		// canonical action id (the Pi toolCallId). Emitting another completion here
		// would double-complete the action and orphan the pending entry, so this
		// generic hook skips them.
		if (event.toolName === "aegis_observe" || event.toolName === "aegis_execute") return;
		const text = textFromContent(event.content);
		await emit("action.completed", {
			action_id: event.toolCallId,
			tool_name: event.toolName,
			transport: { tool_ok: !event.isError, content_chars: text.length },
			content_digest: digest(text),
			content_excerpt: excerpt(text),
			result_detail_keys: event.details && typeof event.details === "object" ? Object.keys(event.details).sort() : [],
		});
		refreshProjections();
	});

	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; content?: unknown };
		const content = Array.isArray(message?.content) ? message.content : [];
		const text = textFromContent(content);
		await emit("message.completed", {
			role: message?.role || "unknown",
			content_types: content.map((part: { type?: string }) => part?.type || "unknown"),
			text_chars: text.length,
			text_digest: digest(text),
			text_excerpt: excerpt(text),
		});
	});

	pi.on("turn_end", async (event) => {
		await emit("turn.ended", {
			turn_index: event.turnIndex,
			outcome_hint: event.outcome,
			tool_result_count: event.toolResults.length,
		});
	});
	pi.on("agent_end", async (event) => {
		await emit("agent.ended", { message_count: event.messages.length });
	});
	pi.on("agent_settled", async () => {
		// A handoff staged during this batch is executed only AFTER the current
		// batch is truly idle. Record the settle + whether a switch is ready so the
		// thin Host helper can act outside the agent run (it owns the real
		// `runtime.newSession`); the Observer never tears down its own run here.
		const ready = Boolean(state.open_handoff?.episode_id);
		await emit("agent.settled", {
			outcome_pending: true,
			handoff_ready: ready,
			handoff_request_id: state.open_handoff?.request_id ?? null,
		});
		refreshProjections();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		commandCtx = ctx;
		// Do NOT close the Episode: the same task may resume in a new short
		// session. Pause it and keep task->episode binding for the next start.
		if (episodeId) {
			await emit("episode.paused", { reason: `session_${event.reason}` }, { source_kind: "runtime" });
		}
		await emit(
			"session.shutdown",
			{ reason: event.reason, target_session_file: event.targetSessionFile || null },
			{ episode_id: null },
		);
		refreshProjections();
		// Release the durable-append handle and the shared-bus subscription at the
		// terminal boundary so nothing writes to a closed log. Nulling `log` means a
		// late `withSession` callback can never append through a stale handle (which
		// would fork the hash chain); if it must write, it re-reads the committed
		// file first.
		try {
			unsubscribeDecision?.();
		} catch {
			// ignore: the bus may already be torn down
		}
		unsubscribeDecision = undefined;
		await log?.close().catch(() => undefined);
		log = null;
	});

	// -----------------------------------------------------------------------
	// Verify-first OBSERVE action. The model names a registered action id and
	// data-only arguments. The runtime runs the reviewed contract (real bytes
	// parsed, never a guess) and records the observation + step Outcome. The
	// observation is written as trusted ONLY because the registered Verification
	// re-read the real artifact; the model's claim is never consulted.
	// -----------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "aegis_observe",
			label: "Aegis: verify a workspace observation",
			description:
				"Run a REGISTERED read-only observation against the task workspace (currently workspace.identify_elf: parse a real file's ELF header for format/bitness/machine). Provide the registered action id and its data-only arguments. The runtime reads the real file and independently re-verifies; a missing/truncated/non-ELF/out-of-workspace target is rejected or unknown, never guessed.",
			promptSnippet: "Run a registered read-only Aegis observation (e.g. identify a workspace ELF)",
			parameters: Type.Object({
				action: Type.String({ description: "Registered observation action id, e.g. workspace.identify_elf" }),
				path: Type.String({ description: "Workspace-relative path to the target file" }),
			}),
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				commandCtx = ctx;
				await ensureLog(ctx);
				refreshProjections();
				if (!episodeId) {
					return {
						content: [{ type: "text", text: "Aegis: no open episode; observation refused." }],
						details: { ok: false, reason: "no_open_episode" },
					};
				}
				const actionRef = String((params as { action?: string }).action || "workspace.identify_elf");
				const path = String((params as { path?: string }).path || "");
				const workspaceRoot = workspaceRootOrCwd(cliWorkspace || ctx.cwd);
				const runtime = await actionRuntimeFor(workspaceRoot);

				// Fail closed when a prior audit write failed: never run an effect whose
				// intent cannot be durably recorded.
				if (auditUnavailable || (log && !log.healthy)) {
					return {
						content: [{ type: "text", text: "Aegis: audit log is unavailable; observation refused (fail-closed)." }],
						details: { ok: false, reason: "audit_unavailable" },
					};
				}

				// 1. Record the INTENT under the Pi toolCallId, durably fsync it BEFORE any
				//    effect, and record where the read authorization came from.
				const intent = await emit(
					"action.requested",
					{
						action_id: toolCallId,
						tool_name: "aegis_observe",
						action_ref: actionRef,
						effect_kind: "read_only_observation",
						authorization: {
							mode: actionMode(),
							source: "read_only_observation",
							scope: { workspace_root: workspaceRoot, action_ref: actionRef },
							granted: true,
						},
						input: summarizeToolInput("aegis_observe", { action: actionRef, path }),
					},
					{ source_kind: "runtime", causation_id: currentPromptEventId },
				);
				if (!intent.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Aegis: audit log unavailable (${intent.error || "append failed"}); observation refused (fail-closed).`,
							},
						],
						details: { ok: false, reason: "audit_unavailable" },
					};
				}
				const actionEventId = toolCallId;

				// 2. Run the reviewed contract. Authorization is re-derived inside; the
				//    model never passes an approval or a permit.
				const resolver = trustedResolver(runtime);
				const result = await runtime.run({
					action_ref: actionRef,
					arguments: { path },
					episodeId,
					actionEventId,
					approved: false,
					target_path: path,
					resolver,
				});

				// 3. Record the honest outcome. A rejected/unknown action records a
				//    runtime.note (never a success) + a matching completed row.
				if (result.status === "rejected") {
					const note = rejectionNote({
						action_ref: actionRef,
						reason: result.reason,
						episodeId,
						arguments: { path },
						target_path: path,
					});
					await emit(note.event_type, note.payload, { source_kind: "runtime", causation_id: actionEventId });
					await emit(
						"action.completed",
						{
							action_id: actionEventId,
							tool_name: "aegis_observe",
							action_ref: actionRef,
							transport: { tool_ok: false },
							rejection_reason: result.reason,
						},
						{ source_kind: "runtime" },
					);
					refreshProjections();
					return {
						content: [{ type: "text", text: `Aegis observation rejected: ${result.reason}` }],
						details: { ok: false, reason: result.reason },
					};
				}

				// The registered Verification re-read the real artifact, so the payloads
				// may be recorded with the trusted `oracle` source kind. The DATA ref is the
				// observation event id; it is only produced for a verified observation.
				const verified = result.status === "success" && result.verification?.ok === true;
				const fileDigest = result.observation?.value?.file_digest;
				const evidenceRefs: Array<Record<string, unknown>> = [];
				if (fileDigest) evidenceRefs.push({ ref_type: "artifact", ref_id: path, digest: fileDigest });
				if (actionEventId) evidenceRefs.push({ ref_type: "action", ref_id: actionEventId });
				const payloads = observeEventPayloads(result, { episodeId: episodeId ?? null, evidenceRefs });
				const observationPayload = payloads.find((p) => p.event_type === "observation.captured") ?? null;
				const outcomePayload = payloads.find((p) => p.event_type === "outcome.recorded") ?? null;
				const sourceKind = verified ? "oracle" : "runtime";

				// ALL own-tool audit writes for this action are collected so a post-effect
				// write failure can be surfaced explicitly instead of claiming "recorded".
				const postWrites: Array<{ ok: boolean; error?: string }> = [];
				let observationEventId: string | null = null;
				let dataRef: { ref_type: string; ref_id: string; digest?: string } | null = null;
				if (observationPayload) {
					const written = await emit(observationPayload.event_type, observationPayload.payload, {
						source_kind: sourceKind,
						causation_id: actionEventId,
						evidence_refs: observationPayload.evidence_refs as never,
					});
					postWrites.push(written);
					observationEventId = written.ok ? (written.event?.event_id ?? null) : null;
					if (observationEventId && fileDigest)
						dataRef = { ref_type: "data", ref_id: observationEventId, digest: fileDigest };
				}
				let outcomeId: string | null = null;
				if (outcomePayload) {
					const outcomeRefs = [...((outcomePayload.evidence_refs as Array<Record<string, unknown>>) ?? [])];
					if (
						dataRef &&
						!outcomeRefs.some((ref) => ref.ref_type === dataRef!.ref_type && ref.ref_id === dataRef!.ref_id)
					)
						outcomeRefs.push(dataRef);
					const written = await emit(outcomePayload.event_type, outcomePayload.payload, {
						source_kind: sourceKind,
						causation_id: actionEventId,
						evidence_refs: outcomeRefs as never,
					});
					postWrites.push(written);
					// The contribution API resolves outcomes by `payload.outcome_id` (the
					// JUDGEMENT id), which is distinct from the row's `event_id`.
					outcomeId = written.ok
						? ((written.event?.payload as { outcome_id?: string } | undefined)?.outcome_id ?? null)
						: null;
				}
				const completed = await emit(
					"action.completed",
					{
						action_id: actionEventId,
						tool_name: "aegis_observe",
						action_ref: actionRef,
						transport: result.transport,
						status: result.status,
						final_arguments: result.final_arguments ?? { path },
						use_refs: dataRef ? [dataRef] : [],
						authorization: result.authorization_decision ?? null,
					},
					{ source_kind: "runtime" },
				);
				postWrites.push(completed);
				// The verified observation value is committed as obtainable DATA at the
				// SAME ref the Outcome names, so the trusted evidence resolver can index a
				// real data record (under this episode) rather than an unresolved string.
				// It is emitted before `degraded` is computed so a non-durable write marks
				// the whole action degraded (fail-closed: the ref simply does not resolve).
				if (dataRef && observationEventId) {
					const dataNote = observationDataNote({
						dataRef,
						value: result.observation?.value ?? null,
						episodeId: episodeId ?? null,
						actionEventId,
					});
					postWrites.push(
						await emit(dataNote.event_type, dataNote.payload, {
							source_kind: sourceKind,
							causation_id: actionEventId,
							evidence_refs: dataNote.evidence_refs as never,
						}),
					);
				}
				const degraded = postWrites.some((entry) => !entry.ok);
				refreshProjections();

				// 4. Only after a REAL verified observation + its trusted stage Outcome are
				//    durably recorded may the data be recorded as OBTAINED. A degraded
				//    audit never claims a contribution.
				if (verified && dataRef && observationEventId && outcomeId && !degraded) {
					const liveResolver = trustedResolver(runtime);
					const record = recordStageContribution({
						episode_id: episodeId,
						dataRef,
						actionRef: { ref_type: "action", ref_id: actionEventId },
						stage: "obtain",
						outcome: { ref_type: "outcome", ref_id: outcomeId },
						resolveSupport: liveResolver,
					});
					await emit(contributionPayload(record).event_type, contributionPayload(record), {
						source_kind: "runtime",
						causation_id: actionEventId,
					});
					refreshProjections();
				}

				const value = result.observation?.value ?? null;
				const summary =
					value && value.format === "ELF"
						? `ELF bits=${value.bits} machine=${value.machine} endianness=${value.endianness} file_type=${value.file_type}`
						: `status=${result.status}`;
				const degradedText = degraded
					? " AUDIT DEGRADED: the effect may have happened but the record is NOT durable; treat the result as unverified."
					: "";
				// The data ref is echoed in the TEXT the model actually receives (Pi only
				// sends tool `content` back, not `details`), so a later aegis_execute can
				// bind a parameter to this exact verified observation.
				const fields = value && typeof value === "object" ? Object.keys(value) : [];
				const refText =
					dataRef && !degraded
						? ` data_ref=${JSON.stringify({ ref_type: dataRef.ref_type, ref_id: dataRef.ref_id, ...(dataRef.digest ? { digest: dataRef.digest } : {}) })} fields=${JSON.stringify(fields)}`
						: "";
				return {
					content: [
						{
							type: "text",
							text: `Aegis observation ${result.status}: ${summary}${verified ? " (verified by registered re-check)" : " (NOT verified)"}${refText}${degradedText}`,
						},
					],
					details: {
						ok: verified && !degraded,
						status: result.status,
						verified: verified && !degraded,
						degraded,
						value,
						data_ref: dataRef,
						data_fields: fields,
						failure_mode: result.failure_mode ?? null,
					},
				};
			},
		}),
	);

	// -----------------------------------------------------------------------
	// Verify-first EXECUTE action. Only a HUMAN-REGISTERED script (fixed
	// executable, fixed argv template, pinned digest, data-only params, a
	// registered post-condition Oracle) can run. The model supplies only data
	// arguments; it can never supply an executable, argv text or an Oracle.
	// With no reviewed registration the runtime stays UNCONFIGURED and refuses.
	// -----------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "aegis_execute",
			label: "Aegis: run a registered script action",
			description:
				"Run a HUMAN-REGISTERED script action against the task workspace. You supply only the registered action id and data-only arguments (numbers/strings declared by the registration). The runtime uses the fixed executable + pinned digests, checks the registered post-condition Oracle on the real post-state, and never uses a shell or eval. If no script is registered, the runtime is unconfigured and refuses.",
			promptSnippet: "Run a human-registered Aegis script action (data-only arguments; no shell)",
			parameters: Type.Object({
				action: Type.String({ description: "Registered script action id, e.g. script.parse_leak" }),
				arguments: Type.Optional(
					Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
						description: "Data-only arguments declared by the registration",
					}),
				),
				data_bindings: Type.Optional(
					Type.Record(
						Type.String(),
						Type.Object({
							ref_id: Type.String({
								description: "ref_id of a verified observation returned by aegis_observe (its data_ref)",
							}),
							field: Type.String({ description: "The observed field to bind, e.g. bits or machine" }),
							ref_type: Type.Optional(Type.String()),
							digest: Type.Optional(Type.String()),
						}),
						{ description: "Map a registered parameter to the exact field of a same-Episode verified observation" },
					),
				),
			}),
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				commandCtx = ctx;
				await ensureLog(ctx);
				refreshProjections();
				if (!episodeId) {
					return {
						content: [{ type: "text", text: "Aegis: no open episode; execution refused." }],
						details: { ok: false, reason: "no_open_episode" },
					};
				}
				const actionRef = String((params as { action?: string }).action || "");
				const args = ((params as { arguments?: Record<string, unknown> }).arguments || {}) as Record<string, unknown>;
				const dataBindings = ((params as { data_bindings?: Record<string, unknown> }).data_bindings || {}) as Record<
					string,
					unknown
				>;
				const workspaceRoot = workspaceRootOrCwd(cliWorkspace || ctx.cwd);
				const runtime = await actionRuntimeFor(workspaceRoot);

				// Fail closed when a prior audit write failed: no effect without a durable intent.
				if (auditUnavailable || (log && !log.healthy)) {
					return {
						content: [{ type: "text", text: "Aegis: audit log is unavailable; script NOT executed (fail-closed)." }],
						details: { ok: false, reason: "audit_unavailable" },
					};
				}

				// The authorization SOURCE and SCOPE are recorded with the intent. An env
				// `AEGIS_ACTION_APPROVED=1` is a per-call grant recorded here; it is NOT a
				// stored per-user approval record (see docs/OVERNIGHT_C2_PENDING.md).
				const mode = actionMode();
				const approvedEnv = process.env.AEGIS_ACTION_APPROVED === "1";
				const authorization = {
					mode,
					source: mode === "auto" ? "auto_default" : approvedEnv ? "env:AEGIS_ACTION_APPROVED" : "none",
					scope: { workspace_root: workspaceRoot, action_ref: actionRef },
					granted: mode === "auto" || (mode === "normal" && approvedEnv),
					per_call_human_record: false,
				};

				// Record the INTENT (canonical Pi toolCallId), fsync BEFORE any effect. The
				// registered version/implementation digest are pinned on the intent so the
				// evidence resolver can later pair the completion and a compiled rule can
				// re-verify the SAME contract (an unpinned version can never compile).
				const pendingContract = runtime.registry.get(actionRef);
				const intent = await emit(
					"action.requested",
					{
						action_id: toolCallId,
						tool_name: "aegis_execute",
						action_ref: actionRef,
						version: pendingContract?.version ?? null,
						implementation_digest: pendingContract?.implementation_digest ?? null,
						effect_kind: "side_effect",
						authorization,
						data_bindings: dataBindings,
						input: summarizeToolInput("aegis_execute", {
							action: actionRef,
							arguments: args,
							data_bindings: dataBindings,
						}),
					},
					{ source_kind: "runtime", causation_id: currentPromptEventId },
				);
				if (!intent.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Aegis: audit log unavailable (${intent.error || "append failed"}); script NOT executed (fail-closed).`,
							},
						],
						details: { ok: false, reason: "audit_unavailable" },
					};
				}
				const actionEventId = toolCallId;

				// Unconfigured / unregistered script runtime: refuse explicitly, never
				// self-register, and record the rejection honestly.
				const contract = runtime.registry.get(actionRef);
				if (!contract || !actionRef.startsWith("script.")) {
					const reason = `${actionRef || "(none)"} is not a registered script action (runtime ${runtime.scriptRegistry.configured ? "configured" : "UNCONFIGURED"}${runtime.scriptRegistryError ? `; registration refused: ${runtime.scriptRegistryError}` : ""})`;
					const note = rejectionNote({ action_ref: actionRef, reason, episodeId, arguments: args });
					await emit(note.event_type, note.payload, { source_kind: "runtime", causation_id: actionEventId });
					await emit(
						"action.completed",
						{
							action_id: actionEventId,
							tool_name: "aegis_execute",
							action_ref: actionRef,
							transport: { tool_ok: false },
							rejection_reason: reason,
						},
						{ source_kind: "runtime" },
					);
					refreshProjections();
					return {
						content: [{ type: "text", text: `Aegis: ${reason}, so nothing was executed.` }],
						details: { ok: false, reason: "not_registered", scripts_configured: runtime.scriptRegistry.configured },
					};
				}

				// normal mode requires an explicit human approval that the MODEL cannot set.
				if (mode === "normal" && !approvedEnv) {
					const reason = "normal mode requires explicit human approval before a script runs";
					const note = rejectionNote({ action_ref: actionRef, reason, episodeId, arguments: args });
					await emit(note.event_type, note.payload, { source_kind: "runtime", causation_id: actionEventId });
					await emit(
						"action.completed",
						{
							action_id: actionEventId,
							tool_name: "aegis_execute",
							action_ref: actionRef,
							transport: { tool_ok: false },
							rejection_reason: reason,
						},
						{ source_kind: "runtime" },
					);
					refreshProjections();
					return {
						content: [
							{
								type: "text",
								text: `Aegis: normal mode — ${actionRef} is pending human approval and was NOT executed.`,
							},
						],
						details: { ok: false, reason: "pending_approval", mode },
					};
				}

				// Pre-effect admission: re-hash the registered executable/script body AND
				// bound every declared path parameter to the allowed root. Both are
				// recorded BEFORE the effect; a failure refuses the run.
				const registration = runtime.scriptRegistry.get(actionRef.slice("script.".length), contract.version);
				let resourceBindings: Record<string, string> = {};
				if (registration) {
					const inspection = inspectScriptRegistration(registration);
					const resourceCheck = validateResourceParams(registration, args, { cwd: registration.cwd });
					resourceBindings = resourceCheck.resolved;
					const admission = await emit(
						"runtime.note",
						{
							kind: "environment.observed",
							scope: "script.registration",
							episode_id: episodeId,
							detail: {
								action_ref: actionRef,
								authorization,
								pins_match: inspection.pins_match,
								executable_digest_now: inspection.executable_digest_now,
								executable_digest_pinned: inspection.executable_digest_pinned,
								script_path: inspection.script_path,
								script_path_real: inspection.script_path_real ?? null,
								script_digest_now: inspection.script_digest_now,
								script_digest_pinned: inspection.script_digest_pinned,
								resource_ok: resourceCheck.ok,
								resource_bindings: resourceCheck.resolved,
								resource_reasons: resourceCheck.reasons,
							},
							verified: false,
						},
						{ source_kind: "runtime", causation_id: actionEventId },
					);
					if (!admission.ok) {
						const note = rejectionNote({
							action_ref: actionRef,
							reason: "pre-effect admission could not be recorded durably",
							episodeId,
							arguments: args,
						});
						await emit(note.event_type, note.payload, { source_kind: "runtime", causation_id: actionEventId });
						await emit(
							"action.completed",
							{
								action_id: actionEventId,
								tool_name: "aegis_execute",
								action_ref: actionRef,
								transport: { tool_ok: false },
								rejection_reason: "admission audit failed",
							},
							{ source_kind: "runtime" },
						);
						refreshProjections();
						return {
							content: [
								{
									type: "text",
									text: `Aegis: could not durably record the pre-effect admission (${admission.error || "append failed"}); ${actionRef} was NOT executed.`,
								},
							],
							details: { ok: false, reason: "audit_unavailable" },
						};
					}
					if (!resourceCheck.ok) {
						const reason = `resource binding refused: ${resourceCheck.reasons.join("; ")}`;
						const note = rejectionNote({ action_ref: actionRef, reason, episodeId, arguments: args });
						await emit(note.event_type, note.payload, { source_kind: "runtime", causation_id: actionEventId });
						await emit(
							"action.completed",
							{
								action_id: actionEventId,
								tool_name: "aegis_execute",
								action_ref: actionRef,
								transport: { tool_ok: false },
								rejection_reason: reason,
							},
							{ source_kind: "runtime" },
						);
						refreshProjections();
						return {
							content: [{ type: "text", text: `Aegis: ${reason}, so nothing was executed.` }],
							details: { ok: false, reason: "resource_refused", resource_reasons: resourceCheck.reasons },
						};
					}
				}

				// Resolve data_bindings against the COMMITTED event log BEFORE the effect.
				const resolver = trustedResolver(runtime);
				const result = await runtime.run({
					action_ref: actionRef,
					arguments: args,
					data_bindings: dataBindings,
					episodeId,
					actionEventId,
					approved: mode === "auto" || approvedEnv,
					resolver,
				});

				if (result.status === "rejected") {
					const note = rejectionNote({ action_ref: actionRef, reason: result.reason, episodeId, arguments: args });
					await emit(note.event_type, note.payload, { source_kind: "runtime", causation_id: actionEventId });
					await emit(
						"action.completed",
						{
							action_id: actionEventId,
							tool_name: "aegis_execute",
							action_ref: actionRef,
							transport: { tool_ok: false },
							rejection_reason: result.reason,
						},
						{ source_kind: "runtime" },
					);
					// A refused binding because the TARGET CHANGED is a real environment
					// fact: emit a TRUSTED, SPECIFIC-SCOPE `environment.changed` so the
					// effective view retires exactly the affected Fact (never a broad
					// clearing). The scope names the observed target fingerprint, so only
					// same-episode nodes on that exact subject go stale.
					for (const stale of result.stale_targets ?? []) {
						const scope = stale.scope ?? stale.ref?.ref_id ?? null;
						if (!scope) continue;
						await emit(
							"environment.changed",
							{
								scope,
								episode_id: stale.episode_id ?? episodeId ?? null,
								reason: stale.reason,
								previous_fingerprint: stale.previous_fingerprint ?? null,
								current_fingerprint: stale.current_fingerprint ?? null,
								ref: stale.ref ?? null,
								parameter: stale.name ?? null,
							},
							{ source_kind: "oracle", causation_id: actionEventId },
						);
					}
					refreshProjections();
					return {
						content: [{ type: "text", text: `Aegis execution rejected: ${result.reason}` }],
						details: { ok: false, reason: result.reason, binding_reasons: result.binding_reasons ?? null },
					};
				}

				// The registered Oracle inspected the real post-state; a verified success
				// may be recorded with the trusted oracle source. A non-zero exit/timeout
				// is preserved as transport and stays unknown unless the Oracle passed.
				const verified = result.status === "success" && result.verification?.ok === true;
				const useRefs = Array.isArray(result.use_refs) ? result.use_refs : [];
				const evidenceRefs: Array<Record<string, unknown>> = [];
				for (const ref of result.step_outcome?.evidence_refs ?? []) evidenceRefs.push(ref as Record<string, unknown>);
				const payloads = observeEventPayloads(result, { episodeId: episodeId ?? null, evidenceRefs });
				const observationPayload = payloads.find((p) => p.event_type === "observation.captured") ?? null;
				const outcomePayload = payloads.find((p) => p.event_type === "outcome.recorded") ?? null;
				const sourceKind = verified ? "oracle" : "runtime";
				const postWrites: Array<{ ok: boolean; error?: string }> = [];
				if (observationPayload) {
					postWrites.push(
						await emit(observationPayload.event_type, observationPayload.payload, {
							source_kind: sourceKind,
							causation_id: actionEventId,
							evidence_refs: observationPayload.evidence_refs as never,
						}),
					);
				}
				let outcomeId: string | null = null;
				if (outcomePayload) {
					const written = await emit(outcomePayload.event_type, outcomePayload.payload, {
						source_kind: sourceKind,
						causation_id: actionEventId,
						evidence_refs: outcomePayload.evidence_refs as never,
					});
					postWrites.push(written);
					outcomeId = written.ok
						? ((written.event?.payload as { outcome_id?: string } | undefined)?.outcome_id ?? null)
						: null;
				}
				const completed = await emit(
					"action.completed",
					{
						action_id: actionEventId,
						tool_name: "aegis_execute",
						action_ref: actionRef,
						version: contract.version ?? null,
						implementation_digest: contract.implementation_digest ?? null,
						transport: result.transport,
						status: result.status,
						final_arguments: result.final_arguments ?? args,
						use_refs: useRefs,
						authorization: result.authorization_decision ?? null,
					},
					{ source_kind: "runtime" },
				);
				postWrites.push(completed);
				const degraded = postWrites.some((entry) => !entry.ok);
				refreshProjections();

				// Only after the real completed action + its trusted stage Outcome are
				// durably recorded may the USE and ADVANCE stages be associated. Each is
				// association-only; neither is a causal claim.
				if (!degraded && verified && outcomeId && useRefs.length > 0) {
					for (const dataRef of useRefs) {
						const useNote = dataUseNote({
							dataRef,
							actionRef: { ref_type: "action", ref_id: actionEventId },
							episodeId: episodeId ?? null,
							basis: "final_bound_arguments",
						});
						await emit(useNote.event_type, useNote.payload, {
							source_kind: "runtime",
							causation_id: actionEventId,
							evidence_refs: useNote.evidence_refs as never,
						});
					}
					const liveResolver = trustedResolver(runtime);
					for (const dataRef of useRefs) {
						for (const stage of ["use", "advance"]) {
							const record = recordStageContribution({
								episode_id: episodeId,
								dataRef,
								actionRef: { ref_type: "action", ref_id: actionEventId },
								useRefs,
								stage,
								outcome: { ref_type: "outcome", ref_id: outcomeId },
								resolveSupport: liveResolver,
							});
							await emit(contributionPayload(record).event_type, contributionPayload(record), {
								source_kind: "runtime",
								causation_id: actionEventId,
							});
						}
					}
					refreshProjections();
				}

				const degradedText = degraded
					? " AUDIT DEGRADED: the script may have run but the record is NOT durable; do not treat this as verified."
					: "";
				return {
					content: [
						{
							type: "text",
							text: `Aegis execution ${result.status} for ${actionRef}${verified ? " (post-condition Oracle confirmed)" : " (NOT confirmed)"}${result.transport?.exit_code !== null && result.transport?.exit_code !== undefined ? `, exit=${result.transport.exit_code}` : ""}${degradedText}`,
						},
					],
					details: {
						ok: verified && !degraded,
						status: result.status,
						verified: verified && !degraded,
						degraded,
						transport: result.transport,
						failure_mode: result.failure_mode ?? null,
						use_refs: useRefs,
						resolved_bindings: result.resolved_bindings ?? [],
						final_arguments: result.final_arguments ?? args,
						resource_bindings: resourceBindings,
					},
				};
			},
		}),
	);

	// -----------------------------------------------------------------------
	// Constrained LLM proposal tool. The model may only propose; the board write
	// gate confines it to Intent/Hint nodes.
	// -----------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "aegis_propose",
			label: "Aegis: propose claim/intent/hint",
			description:
				"Propose a candidate claim, an intent, a hint, or a candidate EXPERIENCE for the Aegis board. A candidate Experience may carry when/do/expect/scope/source_refs but is recorded as an UNVERIFIED candidate: it is never proof, never compiled into a script, and never an active Experience.",
			promptSnippet: "Propose a candidate claim/intent/hint/Experience to Aegis (never a verified fact)",
			parameters: Type.Object({
				kind: Type.Union([Type.Literal("claim"), Type.Literal("intent"), Type.Literal("candidate")]),
				text: Type.String({
					description:
						"The proposed claim/intent/hint text (for a candidate Experience: a short title of the hypothesis)",
				}),
				scope: Type.Optional(Type.String({ description: "Optional scope label" })),
				source_refs: Type.Optional(
					Type.Array(Type.String(), { description: "Optional non-sensitive source references" }),
				),
				when: Type.Optional(
					Type.Array(Type.String(), {
						description: "candidate Experience only: preconditions that must hold for this to be worth testing",
					}),
				),
				do: Type.Optional(
					Type.String({
						description: "candidate Experience only: the proposed action (a description, never an executable payload)",
					}),
				),
				expect: Type.Optional(
					Type.String({ description: "candidate Experience only: the expected observable if the hypothesis holds" }),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				await ensureLog(ctx);
				const verdict = validateProposal(params);
				if (!verdict.accepted) {
					await emit(
						"proposal.rejected",
						{
							kind: (params as { kind?: string }).kind,
							text_excerpt: excerpt((params as { text?: string }).text || "", 300),
							rejection_reason: verdict.reason,
						},
						{ source_kind: "llm", causation_id: currentPromptEventId },
					);
					return {
						content: [{ type: "text", text: `Aegis rejected the proposal: ${verdict.reason}` }],
						details: { accepted: false, reason: verdict.reason },
					};
				}
				const result = await emit("proposal.submitted", proposalPayload(verdict.proposal), {
					source_kind: "llm",
					causation_id: currentPromptEventId,
					evidence_refs: verdict.proposal.source_refs.map((ref) => ({
						ref_type: ref.ref_type,
						ref_id: ref.ref_id,
						...(ref.digest ? { digest: ref.digest } : {}),
					})),
				});
				refreshProjections();
				if (!result.ok) {
					// The proposal must not be reported as recorded when it was not
					// durably appended. The audit is unavailable, so this is a failure,
					// not an accepted candidate.
					return {
						content: [
							{
								type: "text",
								text: `Aegis could NOT record the proposal: ${result.error || "audit unavailable"}. It was not accepted.`,
							},
						],
						details: { accepted: false, reason: result.error || "audit unavailable", audit_degraded: true },
					};
				}
				return {
					content: [
						{
							type: "text",
							text:
								verdict.proposal.kind === "candidate"
									? `Aegis recorded the candidate EXPERIENCE as UNVERIFIED (when=${JSON.stringify(verdict.proposal.when)} do=${JSON.stringify(verdict.proposal.do)} expect=${JSON.stringify(verdict.proposal.expect)}). It is not proof; it will not be executed or compiled.`
									: `Aegis recorded the ${verdict.proposal.kind} as an UNVERIFIED ${verdict.proposal.node_kind} candidate. It is not a verified fact.`,
						},
					],
					details: {
						accepted: true,
						kind: verdict.proposal.kind,
						event_id: result.event?.event_id,
						candidate: verdict.proposal.kind === "candidate",
					},
				};
			},
		}),
	);

	// -----------------------------------------------------------------------
	// Constrained handoff request tool. It records an auditable request and the
	// safety decision; the actual session switch is performed by `/aegis switch`
	// (a command context), never inside the tool (no command-only API here).
	// -----------------------------------------------------------------------
	pi.registerTool(
		defineTool({
			name: "aegis_switch_session",
			label: "Aegis: request a short-session handoff",
			description:
				"Request handing this task to a fresh short session. The Runtime checks for unfinished actions first and refuses unsafe switches. It never switches by itself.",
			promptSnippet: "Request an Aegis short-session handoff (Runtime enforces safety)",
			parameters: Type.Object({
				reason: Type.String({ description: "Why a fresh session is useful" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				await ensureLog(ctx);
				refreshProjections();
				const requestId = eventId();
				const ram = episodeId ? buildRam({ board, state, episodeId, goal: currentGoal }) : "";
				const verdict = evaluateHandoff({
					state,
					board,
					ram,
					episodeId,
					reason: (params as { reason?: string }).reason || "",
					requestId,
				});
				if (!verdict.allowed) {
					await emit("handoff.rejected", { request_id: requestId, reason: verdict.reason }, { source_kind: "llm" });
					refreshProjections();
					return {
						content: [{ type: "text", text: `Aegis refused the switch: ${verdict.reason}` }],
						details: { allowed: false, reason: verdict.reason },
					};
				}
				const requested = await emit(
					"handoff.requested",
					{ request_id: requestId, reason: params.reason, board_digest: verdict.handoff?.board_digest },
					{ source_kind: "llm" },
				);
				if (!requested.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Aegis could not record the handoff request: ${requested.error || "audit unavailable"}. No switch was staged.`,
							},
						],
						details: { allowed: false, reason: requested.error || "audit unavailable", audit_degraded: true },
					};
				}
				await mkdir(dirname(handoffPath()), { recursive: true });
				await writeFile(handoffPath(), JSON.stringify({ ...verdict.handoff, request_id: requestId }, null, 2), "utf8");
				refreshProjections();
				return {
					content: [
						{
							type: "text",
							text: "Aegis recorded the handoff request. A human/runtime must run `/aegis switch` to open the new session; the Episode, board, RAM, unfinished actions and budget carry over. Session != Episode.",
						},
					],
					details: { allowed: true, request_id: requestId, episode_id: episodeId },
				};
			},
		}),
	);

	// -----------------------------------------------------------------------
	// /aegis runtime command (contest uses /aegis-contest to avoid a clash).
	// -----------------------------------------------------------------------
	pi.registerCommand("aegis", {
		description:
			"Aegis runtime: status | board | ram | switch | close | outcome | learn | compile | route | bind | run | replay",
		handler: async (args, rawCtx) => {
			const ctx = rawCtx as ExtensionCommandContext;
			commandCtx = ctx;
			await ensureLog(ctx);
			refreshProjections();
			const [sub, ...rest] = args.trim().split(/\s+/);
			const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(message, level);
				else process.stderr.write(`[aegis] ${message}\n`);
			};
			switch (sub) {
				case "board": {
					notify(`Aegis board: ${JSON.stringify(summarizeBoard(board))}`);
					return;
				}
				case "ram": {
					notify(
						episodeId ? buildRam({ board, state, episodeId, goal: currentGoal }).slice(0, 1200) : "Aegis: no episode",
					);
					return;
				}
				case "switch": {
					let handoff: { episode_id?: string; task_id?: string; reason?: string; request_id?: string } | null = null;
					try {
						handoff = JSON.parse(await readFile(handoffPath(), "utf8"));
					} catch {
						handoff = null;
					}
					if (!handoff || !handoff.episode_id) {
						notify("Aegis: no pending handoff request; ask the model to use aegis_switch_session first", "warning");
						return;
					}
					// Recheck against the CURRENT state: a staged handoff file must not
					// grant execution permission after the episode closed, the task moved,
					// or a real action became unfinished. Re-validate, do not trust the file.
					refreshProjections();
					const stillOpen = state.episodes[handoff.episode_id];
					const targetEpisode = resolveOpenEpisode(state, handoff.task_id || taskId);
					if (!stillOpen || (stillOpen.status !== "open" && stillOpen.status !== "active")) {
						notify(
							`Aegis: handoff refused — episode ${handoff.episode_id} is ${stillOpen ? stillOpen.status : "missing"}`,
							"warning",
						);
						return;
					}
					if (targetEpisode && targetEpisode.episode_id !== handoff.episode_id) {
						notify("Aegis: handoff refused — the current task maps to a different episode", "warning");
						return;
					}
					const verdict = evaluateHandoff({
						state,
						board,
						ram: buildRam({ board, state, episodeId: handoff.episode_id, goal: currentGoal }),
						episodeId: handoff.episode_id,
						reason: handoff.reason || "human-accepted handoff",
						requestId: handoff.request_id,
					});
					if (!verdict.allowed) {
						notify(`Aegis: handoff refused at execution — ${verdict.reason}`, "warning");
						return;
					}
					await ctx.waitForIdle();
					const episodeForSession = handoff.episode_id;
					const reasonForSession = handoff.reason ?? "";
					const requestForSession = handoff.request_id;
					let switchResult: { cancelled?: boolean } | undefined;
					try {
						switchResult = await ctx.newSession({
							withSession: async (next) => {
								// Continuation only. The completion record is written by the Host
								// AFTER `newSession` returns non-cancelled, so a rebind/continuation
								// failure cannot leave a false completion. The new session's
								// `session_start` no longer writes it (it fires inside the bind).
								await next.sendUserMessage(`[Aegis] continuing episode ${episodeForSession}: ${reasonForSession}`);
							},
						});
					} catch (error) {
						// Creating the replacement failed. Do NOT rename the staged handoff:
						// that would fake a completion that never happened.
						notify(
							`Aegis: session switch failed: ${error instanceof Error ? error.message : String(error)}. The handoff is still staged; nothing was completed.`,
							"error",
						);
						return;
					}
					if (switchResult?.cancelled) {
						// The host refused the switch before teardown: no completion, keep the
						// request staged so it can be retried deliberately.
						notify("Aegis: session switch was cancelled; the handoff is still staged.", "warning");
						return;
					}
					// The Host owns the completion and writes it only now that the whole
					// create/bind/continuation cycle returned non-cancelled. It is idempotent.
					if (!(await handoffAlreadyCompleted(requestForSession))) {
						const recorded = await emit(
							"handoff.completed",
							{ request_id: requestForSession, to_session: sessionKey(commandCtx), episode_id: episodeForSession },
							{ episode_id: episodeForSession, source_kind: "runtime" },
						);
						if (!recorded.ok) {
							notify(
								`Aegis: the session switched but the completion record was not durably committed (${recorded.error || "audit unavailable"}). The staged handoff is kept for recovery.`,
								"error",
							);
							return;
						}
					}
					await rename(handoffPath(), `${handoffPath()}.applied.json`).catch(() => undefined);
					return;
				}
				case "close": {
					if (!episodeId) {
						notify("Aegis: no open episode");
						return;
					}
					await emit(
						"episode.closed",
						{ reason: rest[0] || "human_closed", outcome_pending: true },
						{ source_kind: "human" },
					);
					refreshProjections();
					notify(`Aegis: closed episode ${episodeId}`);
					return;
				}
				case "outcome": {
					// Trusted result import at an explicit boundary. Reads contest
					// results by EXACT task id and (when provided) session id. Never
					// guesses success; never marks independent unless the row says so;
					// a general contest failure is a task failure, not a refuted
					// method, unless the precondition/postcondition really was verified.
					//
					// P0 cross-task binding: the requested task MUST be the current
					// episode's own task, and a hand-supplied session id must be one that
					// actually recorded events for the CURRENT episode. A manual argument
					// can never grant write access to another task's result.
					const flagTask = rest[0] ?? taskId;
					if (!flagTask) {
						notify("Aegis: /aegis outcome <task_id> [session_id] — no task id available", "warning");
						return;
					}
					refreshProjections();
					const currentEpisode = episodeId ? state.episodes[episodeId] : null;
					if (!currentEpisode) {
						notify("Aegis: no open episode; refusing to import an outcome with no episode to bind it to", "warning");
						return;
					}
					if (currentEpisode.task_id !== flagTask) {
						notify(
							`Aegis: refusing outcome for task=${flagTask}: the current episode ${episodeId} is bound to task=${currentEpisode.task_id}. Import it from that task's own session.`,
							"error",
						);
						return;
					}
					const flagSession = rest[1] ?? null;
					if (flagSession && !episodeHasSession(state, episodeId, flagSession)) {
						notify(
							`Aegis: refusing session=${flagSession}: it did not record events for the current episode ${episodeId} (sessions=${JSON.stringify(currentEpisode.sessions ?? [])}). A manual session id grants no cross-task write access.`,
							"error",
						);
						return;
					}
					let read: Awaited<ReturnType<typeof readContestResults>>;
					try {
						read = await readContestResults(contestResultsPath());
					} catch (error) {
						notify(`Aegis: could not read contest results: ${String(error)}`, "error");
						return;
					}
					for (const parseError of read.parse_errors) {
						notify(`Aegis: contest result ${parseError} (ignored)`, "warning");
					}
					const resolved = resolveContestOutcome(read.rows, {
						taskId: flagTask,
						sessionId: flagSession,
						episodeId: episodeId ?? null,
					});
					if (resolved.missing) {
						notify(
							`Aegis: no contest result for task=${flagTask}${flagSession ? ` session=${flagSession}` : ""} (nothing imported; success is never inferred)`,
							"warning",
						);
						return;
					}
					if (resolved.conflict) {
						notify(
							`Aegis: conflicting contest results for task=${flagTask}; imported as unknown (${JSON.stringify(resolved.outcome.provenance.conflict_states)})`,
							"warning",
						);
					}
					const result = await appendContestOutcome(log as EventLog, resolved.outcome, {
						episodeId: episodeId ?? null,
						alreadyNormalized: true,
					});
					refreshProjections();
					if (!result.ok) {
						notify("Aegis: outcome could not be recorded (audit unavailable)", "error");
						return;
					}
					if (result.duplicate) {
						// Same outcome_id/row_digest already durably recorded: no second
						// outcome event was written, so independence cannot be inflated.
						notify(`Aegis: outcome already recorded for task=${flagTask} (idempotent; no duplicate event)`);
						return;
					}
					await persistProjections();
					const verdict = resolved.outcome.status;
					const proposition = resolved.outcome.criterion?.expected ?? "(no criterion)";
					const supersedeNote = result.superseded
						? ` supersedes=${result.superseded} (correction, not a new independent attempt)`
						: "";
					notify(
						`Aegis: recorded outcome=${verdict} for task=${flagTask} proposition=${JSON.stringify(proposition)} independent=${resolved.outcome.provenance?.independent === true}${supersedeNote}`,
					);
					return;
				}
				case "learn": {
					// Human/Host-proposed candidate. Never activates, never executes.
					const parsed = learningCommands.parseJsonArg(rest.join(" "));
					if (!parsed.ok) {
						notify(`Aegis learn: ${parsed.reason}`, "warning");
						return;
					}
					const bridge = await learningBridgeFor();
					const learned = learningCommands.learn(parsed.value, bridge);
					await emit(
						"runtime.note",
						{
							kind: learned.status === "bound" ? "experience.candidate.bound" : "experience.candidate",
							status: learned.status,
							active: false,
							action_ref: learned.action_ref,
							when: learned.when,
							do_prose_parsed: learned.model_text_parsed,
							eval_used: learned.eval_used,
							gaps: learned.gaps,
						},
						{ source_kind: "human" },
					);
					notify(
						learned.status === "bound"
							? `Aegis learn: proposal maps to ${learned.action_ref}; it is a CANDIDATE until compiled from committed proofs (never active).`
							: `Aegis learn: proposal stays a candidate; gaps=${JSON.stringify(learned.gaps)}`,
						learned.status === "bound" ? "info" : "warning",
					);
					return;
				}
				case "compile": {
					// Only EXPLICITLY named committed proof outcome ids are imported.
					const flags = learningCommands.parseFlags(rest);
					const proofIds = Array.isArray(flags.proof)
						? flags.proof.filter((value): value is string => typeof value === "string")
						: [];
					if (proofIds.length === 0) {
						notify(
							"Aegis compile: name the committed proof outcomes, e.g. /aegis compile --proof <outcome_id> --proof <outcome_id>",
							"warning",
						);
						return;
					}
					const templatesRaw = learningCommands.lastFlag(flags, "templates");
					const templatesProvided = typeof templatesRaw === "string";
					const templatesArg = learningCommands.parseJsonArg(templatesProvided ? (templatesRaw as string) : "");
					if (templatesProvided && !templatesArg.ok) {
						notify(
							`Aegis compile: invalid --templates JSON (${templatesArg.reason}); refusing to compile with a silently empty template`,
							"warning",
						);
						return;
					}
					const bridge = await learningBridgeFor();
					const store = createLearningStore({ dir: experienceDir() });
					const existingActive = await store.loadActive();
					const result = await learningCommands.compile({
						proofIds,
						bridge,
						store,
						argumentsTemplates: templatesArg.ok ? templatesArg.value : {},
						existingExperiences: existingActive.map((record) => record.experience),
						experienceId:
							typeof learningCommands.lastFlag(flags, "id") === "string"
								? (learningCommands.lastFlag(flags, "id") as string)
								: null,
						revision:
							typeof learningCommands.lastFlag(flags, "revision") === "string"
								? Number(learningCommands.lastFlag(flags, "revision"))
								: 1,
						supersedes:
							typeof learningCommands.lastFlag(flags, "supersedes") === "string"
								? (learningCommands.lastFlag(flags, "supersedes") as string)
								: null,
						recordedAt: new Date().toISOString(),
					});
					await emit(
						"runtime.note",
						{
							kind: "experience.compiled",
							status: result.status,
							active: result.active,
							experience_id: result.experience?.experience_id ?? null,
							revision: result.experience?.revision ?? null,
							source_outcome_ids: proofIds,
							content_digest: result.content_digest ?? null,
							stored: result.stored,
							failures: result.failures,
							gaps: result.gaps,
						},
						{ source_kind: "runtime" },
					);
					notify(
						result.active
							? `Aegis compile: Experience ${result.experience?.experience_id} is ACTIVE from ${proofIds.length} committed proofs (stored=${result.stored}).`
							: `Aegis compile: stays a CANDIDATE (never written active). failures=${JSON.stringify(result.failures.map((f) => f.rule))} gaps=${JSON.stringify(result.gaps)}`,
						result.active ? "info" : "warning",
					);
					return;
				}
				case "route": {
					const flags = learningCommands.parseFlags(rest);
					const stateRefArg = learningCommands.parseJsonArg(
						typeof learningCommands.lastFlag(flags, "state-ref") === "string"
							? (learningCommands.lastFlag(flags, "state-ref") as string)
							: "",
					);
					const stateArg = learningCommands.parseJsonArg(
						typeof learningCommands.lastFlag(flags, "state") === "string"
							? (learningCommands.lastFlag(flags, "state") as string)
							: "",
					);
					const bridge = await learningBridgeFor();
					const store = createLearningStore({ dir: experienceDir() });
					const decision = await learningCommands.route({
						store,
						bridge,
						task: { task_id: taskId, task_types: [], permissions: ["workspace-script"], arguments: {} },
						currentState: stateArg.ok ? stateArg.value : undefined,
						currentStateRef: stateRefArg.ok ? stateRefArg.value : null,
						episodeId: episodeId ?? null,
					});
					await emit(
						"runtime.note",
						{
							kind: "experience.routed",
							route: decision.route,
							state_trusted: decision.state_trusted === true,
							action_ref: decision.action_ref ?? null,
							reason: decision.reason ?? null,
							active_experiences: decision.active_experiences ?? null,
							model_calls: 0,
						},
						{ source_kind: "runtime" },
					);
					notify(
						`Aegis route: ${decision.route} (state_trusted=${decision.state_trusted === true}, 0 model calls). ${decision.reason ?? ""}`,
					);
					return;
				}
				case "bind": {
					const flags = learningCommands.parseFlags(rest);
					const bindings: Record<string, unknown> = {};
					// Reserved control flags are never treated as bindable parameters.
					const RESERVED = new Set(["state", "state-ref"]);
					for (const [name, value] of Object.entries(flags)) {
						if (value === true || RESERVED.has(name)) continue;
						bindings[name] = Array.isArray(value) ? value[value.length - 1] : value;
					}
					const stateRefArg = learningCommands.parseJsonArg(
						typeof learningCommands.lastFlag(flags, "state-ref") === "string"
							? (learningCommands.lastFlag(flags, "state-ref") as string)
							: "",
					);
					const bindStateArg = learningCommands.parseJsonArg(
						typeof learningCommands.lastFlag(flags, "state") === "string"
							? (learningCommands.lastFlag(flags, "state") as string)
							: "",
					);
					const bridge = await learningBridgeFor();
					const store = createLearningStore({ dir: experienceDir() });
					const bound = await learningCommands.bind({
						store,
						bridge,
						task: { task_id: taskId, arguments: {} },
						currentState: bindStateArg.ok ? bindStateArg.value : undefined,
						currentStateRef: stateRefArg.ok ? stateRefArg.value : null,
						bindings,
						episodeId: episodeId ?? null,
					});
					await emit(
						"runtime.note",
						{
							kind: "experience.candidate.bound",
							ok: bound.ok === true,
							recheck_route: bound.recheck?.route ?? null,
							action_ref: bound.action_ref ?? null,
							reason: bound.reason ?? null,
							bindings,
						},
						{ source_kind: "runtime" },
					);
					notify(
						bound.ok
							? `Aegis bind: re-checks to ${bound.recheck?.route} for ${bound.action_ref}`
							: `Aegis bind refused: ${bound.reason}`,
						bound.ok ? "info" : "warning",
					);
					return;
				}
				case "run": {
					const flags = learningCommands.parseFlags(rest);
					const argsArg = learningCommands.parseJsonArg(
						typeof learningCommands.lastFlag(flags, "args") === "string"
							? (learningCommands.lastFlag(flags, "args") as string)
							: "{}",
					);
					const stateRefArg = learningCommands.parseJsonArg(
						typeof learningCommands.lastFlag(flags, "state-ref") === "string"
							? (learningCommands.lastFlag(flags, "state-ref") as string)
							: "",
					);
					const stateArg = learningCommands.parseJsonArg(
						typeof learningCommands.lastFlag(flags, "state") === "string"
							? (learningCommands.lastFlag(flags, "state") as string)
							: "",
					);
					const bridge = await learningBridgeFor();
					const store = createLearningStore({ dir: experienceDir() });
					// The task target is the human-named resource the run may touch. It is
					// never inferred from model prose: it comes from `--target` (a path inside
					// the allowed workspace) or the bound `input` parameter.
					const runWorkspaceRoot = workspaceRootOrCwd(cliWorkspace || undefined);
					const boundArgs =
						argsArg.ok && argsArg.value && typeof argsArg.value === "object"
							? (argsArg.value as Record<string, unknown>)
							: {};
					const explicitTarget =
						typeof learningCommands.lastFlag(flags, "target") === "string"
							? (learningCommands.lastFlag(flags, "target") as string)
							: null;
					const inputArg = typeof boundArgs.input === "string" ? (boundArgs.input as string) : null;
					const targetPath = explicitTarget ?? (inputArg ? resolve(runWorkspaceRoot, inputArg) : null);
					const runApproved = actionMode() === "auto" || process.env.AEGIS_ACTION_APPROVED === "1";
					const runApprovalSource =
						actionMode() === "auto" ? "auto_default" : runApproved ? "env:AEGIS_ACTION_APPROVED" : "none";
					// Fail closed BEFORE any side effect: the direct run's intent must be
					// durably recordable or the broker is never called (the same boundary as
					// `aegis_execute`).
					if (auditUnavailable || (log && !log.healthy)) {
						notify("Aegis run: audit log is unavailable; side-effecting run refused (fail-closed).", "warning");
						return;
					}
					// Resolve the direct action + final arguments WITHOUT executing, so the
					// intent can be durably recorded before the broker runs.
					const taskForRun = { task_id: taskId, arguments: boundArgs };
					const runDecision = await learningCommands.route({
						store,
						bridge,
						task: taskForRun,
						currentState: stateArg.ok ? stateArg.value : undefined,
						currentStateRef: stateRefArg.ok ? stateRefArg.value : null,
						episodeId: episodeId ?? null,
					});
					if (runDecision.route !== "direct") {
						notify(`Aegis run: cannot execute (route=${runDecision.route}): ${runDecision.reason ?? ""}`, "warning");
						return;
					}
					const runActionRef = typeof runDecision.action_ref === "string" ? runDecision.action_ref : null;
					const runArgs =
						runDecision.arguments && typeof runDecision.arguments === "object" ? runDecision.arguments : boundArgs;
					const runActionId = eventId();
					// Pin the registered version/digest on the intent (the same boundary as
					// `aegis_execute`), so a real run Outcome is resolvable/compilable.
					const runRuntime = await actionRuntimeFor(runWorkspaceRoot);
					const runContract = runActionRef ? runRuntime.registry.get(runActionRef) : null;

					// 1. Durable intent BEFORE any effect.
					const intent = await emit(
						"action.requested",
						{
							action_id: runActionId,
							tool_name: "aegis_run",
							action_ref: runActionRef,
							version: runContract?.version ?? null,
							implementation_digest: runContract?.implementation_digest ?? null,
							effect_kind: "direct_experience_execution",
							authorization: {
								mode: actionMode(),
								source: runApprovalSource,
								granted: runApproved,
								scope: { workspace_root: runWorkspaceRoot, action_ref: runActionRef },
							},
							final_arguments: runArgs,
							input: { target_path: targetPath },
						},
						{ source_kind: "runtime", causation_id: currentPromptEventId },
					);
					if (!intent.ok) {
						notify(
							`Aegis run: audit log unavailable (${intent.error || "append failed"}); run refused (fail-closed).`,
							"warning",
						);
						return;
					}

					const result = await learningCommands.run({
						store,
						bridge,
						task: taskForRun,
						currentState: stateArg.ok ? stateArg.value : undefined,
						currentStateRef: stateRefArg.ok ? stateRefArg.value : null,
						context: { workspaceRoot: runWorkspaceRoot, target_path: targetPath },
						approved: runApproved,
						episodeId: episodeId ?? null,
						actionEventId: runActionId,
					});

					// 2. Standard completion + the REAL step Outcome/Observation the broker
					//    produced (a verified success is recorded under the trusted oracle
					//    source so the resolver indexes it).
					const runSourceKind = result.status === "success" && result.verification?.ok === true ? "oracle" : "runtime";
					const runPayloads = observeEventPayloads(result, { episodeId: episodeId ?? null });
					for (const payload of runPayloads) {
						await emit(payload.event_type, payload.payload, {
							source_kind: runSourceKind,
							causation_id: runActionId,
							evidence_refs: payload.evidence_refs,
						});
					}
					await emit(
						"action.completed",
						{
							action_id: runActionId,
							tool_name: "aegis_run",
							action_ref: runActionRef,
							version: result.step_outcome?.action_version ?? runContract?.version ?? null,
							implementation_digest:
								result.step_outcome?.implementation_digest ?? runContract?.implementation_digest ?? null,
							status: result.status,
							transport: result.transport ?? null,
							final_arguments: runArgs,
							authorization: result.authorization ?? {
								mode: actionMode(),
								source: runApprovalSource,
								granted: runApproved,
							},
						},
						{ source_kind: "runtime" },
					);
					refreshProjections();

					const described = learningCommands.describe(result);
					await emit(
						"runtime.note",
						{
							kind: "experience.run",
							route: described.route,
							status: described.status,
							ok: described.ok,
							direct: described.direct,
							model_calls: described.model_calls,
							reason: described.reason,
							authorization_source: runApprovalSource,
						},
						{ source_kind: "runtime" },
					);
					notify(
						`Aegis run: route=${described.route} status=${described.status} ok=${described.ok} ${described.reason ?? ""}`,
						described.ok ? "info" : "warning",
					);
					return;
				}
				case "replay": {
					const flags = learningCommands.parseFlags(rest);
					const outcomeId =
						typeof learningCommands.lastFlag(flags, "outcome") === "string"
							? (learningCommands.lastFlag(flags, "outcome") as string)
							: null;
					if (!outcomeId) {
						notify(
							"Aegis replay: /aegis replay --outcome <outcome_id> (requires a configured isolated adapter)",
							"warning",
						);
						return;
					}
					const bridge = await learningBridgeFor();
					const result = await learningCommands.replay({ outcomeId, bridge, adapterPath: replayAdapterPath() });
					notify(
						result.configured === false
							? "Aegis replay: no isolated replay adapter is configured; refusing (a replay is never guessed)."
							: result.ok
								? `Aegis replay: recorded a genuine isolated replay (${result.replay_id}).`
								: `Aegis replay refused: ${result.reason}`,
						result.ok ? "info" : "warning",
					);
					refreshProjections();
					return;
				}
				case "tasks":
				case "dashboard":
				case "boardview":
				case "url": {
					// C4a read-only view over the SAME committed projection as the C4
					// report and the loopback HTTP board. Paths come from the launcher
					// environment, never the model. No browser is auto-opened.
					const cfg = observationConfigFromEnv();
					const viewResult = await runObservationCommand({
						subcommand: sub === "boardview" ? "dashboard" : sub,
						manifestPath: cfg.manifestPath,
						eventsPath: cfg.eventsPath ?? process.env.AEGIS_EVENT_LOG ?? null,
						observationUrl: cfg.observationUrl,
					});
					notify(viewResult.text, viewResult.ok ? "info" : "warning");
					return;
				}
				default:
					notify(
						`Aegis: episode=${episodeId ?? "(none)"} audit=${log?.healthy ? "ok" : "DEGRADED"} board=${JSON.stringify(summarizeBoard(board))}. Usage: /aegis status|board|tasks|dashboard|url|ram|switch|close|outcome <task_id> [session_id]|learn <json>|compile --proof <id>...|route --state-ref <json>|bind --input <path> --out <path>|run --args <json>|replay --outcome <id>`,
					);
			}
		},
	});
}
