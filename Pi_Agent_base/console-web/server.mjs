// Aegis Web Console — the local HTTP server.
//
// One loopback process that:
//   * lists/creates Experiments using the EXISTING launcher (`run-experiment.sh`)
//     and its isolated layout, so initialization never forks;
//   * keeps ONE Host child process per active experiment (`--control stdio`),
//     because the Observer's configuration is process-global: two experiments in
//     one process would leak policy/paths into each other;
//   * forwards messages/pause/resume/stop to that Host (never to the SDK);
//   * streams committed EventLog rows and Host status to browsers over SSE;
//   * serves the Pocket-derived web app and its theme/static assets.
//
// It is NOT a second task ledger, Session manager, scheduler or knowledge store.
// Board/RAM/work-cycle/actions come from the Host's own projection (live) or the
// same Aegis projection modules over the committed log (stopped experiments).
//
// Security posture (local single-user tool):
//   * binds 127.0.0.1 by default;
//   * rejects a request whose Host header is not the bound host:port, and any
//     state-changing request whose Origin is present and not the same origin;
//   * no CORS, no GET writes, no credentials in URLs;
//   * workspace paths are resolved with realpath and confined to the workspace;
//   * all responses are field-whitelisted, bounded and never include auth/Cookie
//     or full private logs.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectBoard } from "../memory/board.mjs";
import { projectState } from "../memory/state.mjs";
import { normalizeWorkCyclePolicy, projectWorkCycle } from "../memory/work-cycle.mjs";
import { CONTROL_ERRORS } from "./control.mjs";
import { AEGIS_TOOLS, CODING_TOOLS, DEFAULT_CODING_TOOLS, resolveToolSelection } from "./tools.mjs";
import { buildWebView, transcriptEntry, VIEW_LIMITS } from "./view.mjs";
import { listWorkspace, readWorkspaceFile, WorkspacePathError } from "./workspace-files.mjs";

const BASE_DIR = resolve(fileURLToPath(import.meta.url), "..", "..");
const REPO_ROOT = resolve(BASE_DIR, "..");
const LAUNCHER = join(REPO_ROOT, "run-experiment.sh");
const POCKET_WEB = join(BASE_DIR, "UI", "Aegis-pocket", "web");
const POCKET_MODULES = join(BASE_DIR, "UI", "Aegis-pocket", "node_modules");
const AEGIS_WEB = join(POCKET_WEB, "aegis");

export const WEB_SERVER_VERSION = "aegis-web-console-1";

const VENDOR = Object.freeze({
	"preact.mjs": join(POCKET_MODULES, "preact", "dist", "preact.mjs"),
	"preact-hooks.mjs": join(POCKET_MODULES, "preact", "hooks", "dist", "hooks.mjs"),
	"htm.mjs": join(POCKET_MODULES, "htm", "dist", "htm.module.js"),
	"marked.mjs": join(POCKET_MODULES, "marked", "lib", "marked.esm.js"),
	"purify.mjs": join(POCKET_MODULES, "dompurify", "dist", "purify.es.mjs"),
});

const TYPES = Object.freeze({
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webmanifest": "application/manifest+json",
	".woff2": "font/woff2",
	".json": "application/json; charset=utf-8",
});

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,119}$/;
const MAX_BODY = 256 * 1024;
/** Attachment uploads carry base64 (≈4/3 of the file), so they get their own cap. */
const MAX_ATTACHMENT_BODY = 24 * 1024 * 1024;

class HttpError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

function json(res, status, body) {
	const payload = `${JSON.stringify(body)}\n`;
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store",
	});
	res.end(payload);
}

function readBody(req, limit = MAX_BODY) {
	return new Promise((resolveBody, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new HttpError(413, "body_too_large", "request body is too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) return resolveBody({});
			try {
				resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new HttpError(400, "invalid_json", "body is not valid JSON"));
			}
		});
		req.on("error", (error) => reject(new HttpError(400, "body_error", String(error))));
	});
}

function assertLabel(label) {
	if (typeof label !== "string" || !LABEL_RE.test(label) || label.includes(".."))
		throw new HttpError(400, "invalid_label", "invalid experiment label");
	return label;
}

function policyFromRunJson(runJson) {
	const raw = runJson?.work_cycle;
	if (!raw || typeof raw !== "object") return normalizeWorkCyclePolicy({});
	return normalizeWorkCyclePolicy({
		repeat_limit: raw.repeat_limit,
		action_window: raw.action_window,
		min_distinct_routes: raw.min_distinct_routes,
		context_pressure_percent: raw.context_pressure_percent,
	});
}

function readJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** Upload bounds for the composer's attachment button. */
export const ATTACHMENT_LIMITS = Object.freeze({
	bytes: 16 * 1024 * 1024,
	name: 120,
});

/**
 * Save one uploaded attachment INTO the experiment's workspace.
 *
 * The name is reduced to a basename (no directory part), control characters and
 * path separators are refused, and the write uses `wx` so nothing is overwritten
 * (an existing file or symlink is a conflict, never a target). The file lands in
 * the workspace root, which is exactly where the model's tools can read it.
 */
async function saveAttachment(record, body) {
	const raw = String(body.name);
	if (raw.includes("/") || raw.includes("\\") || raw.includes(".."))
		throw new HttpError(400, "invalid_attachment", "the name must be a plain file name, without a path");
	const base = raw.trim();
	if (!base || base === "." || base.startsWith("."))
		throw new HttpError(400, "invalid_attachment", "a plain file name is required");
	if (base.length > ATTACHMENT_LIMITS.name) throw new HttpError(400, "invalid_attachment", "the file name is too long");
	if (/[\u0000-\u001f<>:"|?*]/.test(base))
		throw new HttpError(400, "invalid_attachment", "the file name contains characters that are not allowed");
	let buffer;
	try {
		buffer = Buffer.from(String(body.data_base64), "base64");
	} catch {
		throw new HttpError(400, "invalid_attachment", "the content is not valid base64");
	}
	if (buffer.length === 0) throw new HttpError(400, "invalid_attachment", "the file is empty");
	if (buffer.length > ATTACHMENT_LIMITS.bytes)
		throw new HttpError(413, "attachment_too_large", `attachments are limited to ${ATTACHMENT_LIMITS.bytes} bytes`);
	let root;
	try {
		root = await realpath(record.workspace);
	} catch {
		throw new HttpError(409, "workspace_missing", "the workspace does not exist yet");
	}
	const target = join(root, base);
	try {
		await writeFile(target, buffer, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (error?.code === "EEXIST")
			throw new HttpError(409, "attachment_exists", "a file with that name is already in the workspace");
		throw new HttpError(500, "attachment_failed", `the file could not be written: ${String(error)}`);
	}
	return { name: base, size: buffer.length, path: base };
}

/**
 * Read committed rows for a READ-ONLY view.
 *
 * A live writer can leave a partial trailing line; rows before it are still
 * committed. The reader reports that state instead of pretending the log is
 * complete, and never writes anything.
 *
 * @returns {{rows: any[], integrity: {ok: boolean, reason: string|null, complete: boolean}}}
 */
function readCommittedRows(eventLogPath) {
	if (!existsSync(eventLogPath))
		return { rows: [], integrity: { ok: true, reason: "no event log yet", complete: true } };
	let text;
	try {
		text = readFileSync(eventLogPath, "utf8");
	} catch (error) {
		return { rows: [], integrity: { ok: false, reason: `event log is unreadable: ${String(error)}`, complete: false } };
	}
	const rows = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			const isTail = lines.slice(index + 1).every((rest) => !rest.trim());
			return {
				rows,
				integrity: {
					ok: false,
					reason: `unparseable line ${index + 1}${isTail ? " (partial trailing line; the rest is committed)" : ""}`,
					complete: false,
				},
			};
		}
	}
	return { rows, integrity: { ok: true, reason: null, complete: true } };
}

/**
 * Selectable models from the trusted Pi configuration in this process' agent dir.
 *
 * Read-only, and never touches `auth.json`: `models.json` describes providers and
 * their models, `settings.json` names the default. A missing/unreadable file
 * returns an empty list and the UI falls back to the free-text field.
 */
function listModels(agentDirPath) {
	if (typeof agentDirPath !== "string" || !agentDirPath) return { models: [], default: null, source: null };
	const modelsPath = join(agentDirPath, "models.json");
	const settingsPath = join(agentDirPath, "settings.json");
	if (!existsSync(modelsPath)) return { models: [], default: null, source: null };
	let raw;
	try {
		raw = JSON.parse(readFileSync(modelsPath, "utf8"));
	} catch {
		return { models: [], default: null, source: null };
	}
	const providers = raw && typeof raw === "object" ? (raw.providers ?? raw) : {};
	const models = [];
	for (const [providerId, provider] of Object.entries(providers)) {
		if (!provider || typeof provider !== "object") continue;
		const declared = Array.isArray(provider.models) ? provider.models : [];
		for (const model of declared) {
			const id = typeof model === "string" ? model : (model?.id ?? null);
			if (typeof id !== "string" || !id) continue;
			models.push({
				provider: providerId,
				id,
				name: typeof model?.name === "string" ? model.name : id,
				context_window: Number.isFinite(model?.contextWindow) ? model.contextWindow : null,
			});
		}
	}
	let fallback = null;
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (typeof settings?.defaultProvider === "string" && typeof settings?.defaultModel === "string")
			fallback = { provider: settings.defaultProvider, id: settings.defaultModel };
	} catch {
		fallback = null;
	}
	return { models: models.slice(0, 500), default: fallback, source: "pi-config" };
}

/** Experiment metadata from disk (never inferred from a report). */
function experimentRecord(home, label) {
	const dir = join(home, "experiments", label);
	const runJson = readJsonFile(join(dir, "run.json"));
	if (!runJson) return null;
	const eventLogPath = runJson.paths?.event_log ?? join(dir, "runtime", "events.jsonl");
	const { rows, integrity } = readCommittedRows(eventLogPath);
	return {
		label,
		dir,
		integrity,
		run_json: runJson,
		event_log_path: eventLogPath,
		handoff_path: runJson.paths?.handoff_file ?? join(dir, "runtime", "ram", "handoff.json"),
		workspace: runJson.workspace ?? join(dir, "workspace"),
		agent_dir: runJson.paths?.agent_dir ?? null,
		session_dir: runJson.paths?.session_dir ?? join(dir, "sessions"),
		task_id: runJson.task_id ?? label,
		tools: Array.isArray(runJson.tools) ? runJson.tools : null,
		row_count: rows.length,
		last_event_at: rows[rows.length - 1]?.recorded_at ?? null,
		episodes: rows.filter((row) => row.event_type === "episode.started").length,
	};
}

function listExperiments(home) {
	const root = join(home, "experiments");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && LABEL_RE.test(entry.name))
		.map((entry) => experimentRecord(home, entry.name))
		.filter(Boolean)
		.sort((a, b) => String(b.last_event_at ?? "").localeCompare(String(a.last_event_at ?? "")));
}

/**
 * The Host child process for one experiment.
 *
 * The child is the only writer: it owns the lease, the EventLog and the SDK
 * runtime. This class only speaks the control protocol and tracks liveness.
 */
class HostProcess {
	constructor({ home, label, workspace, agentDir, tools = null, env, onEvent }) {
		this.home = home;
		this.label = label;
		this.workspace = workspace;
		this.agentDir = agentDir;
		this.tools = tools;
		this.env = env;
		this.onEvent = onEvent;
		this.child = null;
		this.state = "stopped"; // stopped | starting | ready | conflict | unavailable
		this.reason = null;
		this.lastStatus = null;
		this.pending = new Map();
		this.nextId = 1;
		this.stdoutBuffer = "";
		this.stderrTail = [];
		this.exited = null;
	}

	async start(extraArgs = []) {
		if (this.state === "ready") return { ok: true, status: this.lastStatus };
		if (this.child) return { ok: false, reason: "the Host process is already starting" };
		this.state = "starting";
		const args = [
			LAUNCHER,
			this.label,
			"--resume",
			"--workspace",
			this.workspace,
			...(this.agentDir ? ["--agent-dir", this.agentDir] : []),
			...(Array.isArray(this.tools) && this.tools.length > 0 ? ["--tools", this.tools.join(",")] : []),
			"--",
			"--control",
			"stdio",
			...extraArgs,
		];
		const child = spawn("bash", args, {
			cwd: REPO_ROOT,
			env: { ...process.env, ...this.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		const ready = new Promise((resolveReady) => {
			this.resolveReady = resolveReady;
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => this.#onStdout(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			for (const line of chunk.split("\n")) {
				if (!line.trim()) continue;
				this.stderrTail.push(line.slice(0, 400));
				if (this.stderrTail.length > 30) this.stderrTail.shift();
			}
		});
		this.exited = new Promise((resolveExit) => {
			child.on("exit", (code, signal) => {
				const wasConflict = this.state === "conflict";
				if (!wasConflict) this.state = "unavailable";
				this.reason = this.reason ?? `the Host exited (code ${code ?? "null"}, signal ${signal ?? "none"})`;
				for (const { reject } of this.pending.values())
					reject(new HttpError(503, CONTROL_ERRORS.unavailable, this.reason));
				this.pending.clear();
				this.child = null;
				this.#resolveReadyOnce({ ok: false, reason: this.reason, code });
				resolveExit({ code, signal });
			});
		});
		const outcome = await Promise.race([
			ready,
			new Promise((resolveTimeout) =>
				setTimeout(() => resolveTimeout({ ok: false, reason: "Host start timed out" }), 180_000),
			),
		]);
		if (!outcome.ok) {
			if (this.state !== "conflict") this.state = "unavailable";
			this.reason = outcome.reason ?? this.reason;
		}
		return outcome;
	}

	#resolveReadyOnce(value) {
		if (this.resolveReady) {
			const resolveReady = this.resolveReady;
			this.resolveReady = null;
			resolveReady(value);
		}
	}

	#onStdout(chunk) {
		this.stdoutBuffer += chunk;
		let index = this.stdoutBuffer.indexOf("\n");
		while (index >= 0) {
			const line = this.stdoutBuffer.slice(0, index).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
			if (line.startsWith("{")) {
				let message = null;
				try {
					message = JSON.parse(line);
				} catch {
					message = null;
				}
				if (message) this.#onMessage(message);
			} else if (line) {
				this.stderrTail.push(`stdout: ${line.slice(0, 200)}`);
				if (this.stderrTail.length > 30) this.stderrTail.shift();
			}
			index = this.stdoutBuffer.indexOf("\n");
		}
	}

	#onMessage(message) {
		if (message.type === "ready") {
			this.state = "ready";
			this.reason = null;
			this.lastStatus = message.status ?? null;
			this.#resolveReadyOnce({ ok: true, status: this.lastStatus });
			this.onEvent?.({ type: "host", state: "ready" });
			return;
		}
		if (message.type === "refused") {
			this.state = message.ownership_conflict ? "conflict" : "unavailable";
			this.reason = message.reason ?? "the Host refused to start";
			this.lastStatus = message.status ?? null;
			this.#resolveReadyOnce({ ok: false, reason: this.reason, conflict: message.ownership_conflict === true });
			this.onEvent?.({ type: "host", state: this.state, reason: this.reason });
			return;
		}
		if (Object.hasOwn(message, "id") && this.pending.has(message.id)) {
			const { resolvePending, reject, timer } = this.pending.get(message.id);
			clearTimeout(timer);
			this.pending.delete(message.id);
			if (message.ok === false) {
				const error = new HttpError(409, message.code ?? "command_failed", message.reason ?? "command failed");
				error.payload = message;
				reject(error);
			} else resolvePending(message);
			return;
		}
		this.onEvent?.({ type: "host-notice", message });
	}

	request(cmd, params = {}, { timeout = 60_000 } = {}) {
		if (!this.child)
			return Promise.reject(new HttpError(503, CONTROL_ERRORS.unavailable, this.reason ?? "the Host is not running"));
		const id = this.nextId++;
		const line = `${JSON.stringify({ id, cmd, params })}\n`;
		return new Promise((resolveRequest, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const error = new HttpError(504, "timeout", `the Host did not answer ${cmd} within ${timeout}ms`);
				reject(error);
			}, timeout);
			this.pending.set(id, { resolvePending: resolveRequest, reject, timer });
			try {
				this.child.stdin.write(line);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new HttpError(503, CONTROL_ERRORS.unavailable, String(error)));
			}
		});
	}

	async stop(reason = "web stop") {
		if (!this.child) {
			this.state = "stopped";
			return { ok: true };
		}
		try {
			await this.request("stop", { reason }, { timeout: 30_000 });
		} catch {
			// fall through to a bounded kill
		}
		if (this.child) {
			const exited = await Promise.race([
				this.exited.then(() => true),
				new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 20_000)),
			]);
			if (!exited && this.child) {
				this.child.kill("SIGTERM");
				await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000));
				if (this.child) this.child.kill("SIGKILL");
			}
		}
		this.state = "stopped";
		return { ok: true };
	}
}

/**
 * Start the Aegis Web Console.
 *
 * @param {{
 *   home: string,
 *   port?: number,
 *   hostname?: string,
 *   workspaceRoots?: string[],
 *   env?: Record<string,string>,
 *   defaultAgentDir?: string|null,
 *   log?: (line: string) => void,
 * }} options
 */
export async function startWebConsole({
	home,
	port = 0,
	hostname = "127.0.0.1",
	workspaceRoots = [],
	env = {},
	defaultAgentDir = null,
	log = () => {},
} = {}) {
	if (typeof home !== "string" || !isAbsolute(home)) throw new Error("startWebConsole requires an absolute AEGIS_HOME");
	const experimentsRoot = join(home, "experiments");
	const hosts = new Map();
	const subscribers = new Map(); // label -> Set<res>
	const tailers = new Map(); // label -> {rows, timer}
	// Compare REAL paths: a symlinked root (e.g. /tmp -> /private/tmp on macOS) must
	// match a workspace that was resolved through the same link.
	const realRoot = (path) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	const allowedRoots = [home, experimentsRoot, ...workspaceRoots.map((root) => resolve(root))].map(realRoot);

	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			if (error instanceof HttpError) json(res, error.status, { ok: false, code: error.code, error: error.message });
			else if (error instanceof WorkspacePathError)
				json(res, 400, { ok: false, code: error.code, error: error.message });
			else {
				log(`[aegis-web] ${req.method} ${req.url}: ${error instanceof Error ? error.stack : String(error)}`);
				json(res, 500, { ok: false, code: "internal_error", error: "internal error" });
			}
		});
	});

	function boundOrigin() {
		const address = server.address();
		const actualPort = typeof address === "object" && address ? address.port : port;
		return `http://${hostname}:${actualPort}`;
	}

	function checkHostHeader(req) {
		const expected = `${hostname}:${new URL(boundOrigin()).port}`;
		const header = req.headers.host;
		if (typeof header !== "string" || header.length === 0) throw new HttpError(403, "bad_host", "missing Host header");
		const normalized = header.replace(/^localhost:/, `${hostname}:`);
		if (normalized !== expected && normalized !== `localhost:${expected.split(":")[1]}`)
			throw new HttpError(403, "bad_host", "unexpected Host header");
	}

	function checkOrigin(req) {
		const origin = req.headers.origin;
		if (origin === undefined) return; // same-origin fetch from a non-browser client
		if (origin === "null") throw new HttpError(403, "bad_origin", "null origin is not allowed");
		if (origin !== boundOrigin() && origin !== boundOrigin().replace("127.0.0.1", "localhost"))
			throw new HttpError(403, "bad_origin", "cross-origin requests are not allowed");
	}

	/**
	 * Get (or start) the ONE Host process for an experiment.
	 * Always resolves to `{ok, host, state, reason, status}`.
	 */
	async function hostFor(record, { create = true } = {}) {
		const existing = hosts.get(record.label);
		if (existing?.state === "ready" && existing.child)
			return { ok: true, host: existing, state: "ready", reason: null, status: existing.lastStatus };
		if (existing?.child)
			return {
				ok: existing.state === "ready",
				host: existing,
				state: existing.state,
				reason: existing.reason,
				status: existing.lastStatus,
			};
		if (!create)
			return {
				ok: existing?.state === "ready",
				host: existing ?? null,
				state: existing?.state ?? "stopped",
				reason: existing?.reason ?? null,
				status: existing?.lastStatus ?? null,
			};
		const host =
			existing ??
			new HostProcess({
				home,
				label: record.label,
				workspace: record.workspace,
				agentDir: record.agent_dir ?? agentDir(),
				tools: record.tools,
				env,
				onEvent: (event) => broadcast(record.label, "host", event),
			});
		hosts.set(record.label, host);
		const outcome = await host.start();
		if (!outcome.ok) broadcast(record.label, "host", { state: host.state, reason: host.reason });
		return { ok: host.state === "ready", host, state: host.state, reason: host.reason, status: host.lastStatus };
	}

	async function liveStatus(record) {
		const host = hosts.get(record.label);
		if (host?.state === "ready") {
			try {
				const answer = await host.request("status", {}, { timeout: 10_000 });
				return { status: answer.status ?? null, live: true, host_state: "ready" };
			} catch (error) {
				return { status: host.lastStatus, live: false, host_state: host.state, reason: error.message };
			}
		}
		return {
			status: host?.lastStatus ?? null,
			live: false,
			host_state: host?.state ?? "stopped",
			reason: host?.reason ?? null,
		};
	}

	/** Read-only view from the committed log (used when no Host is running). */
	function committedView(record) {
		const { rows, integrity } = readCommittedRows(record.event_log_path);
		const board = projectBoard(rows);
		const state = projectState(rows);
		const policy = policyFromRunJson(record.run_json);
		const episodeId =
			Object.entries(state.episodes ?? {})
				.map(([id, episode]) => ({ id, episode }))
				.filter(({ episode }) => episode.status === "open" || episode.status === "active")
				.map(({ id }) => id)
				.at(-1) ??
			Object.keys(state.episodes ?? {}).at(-1) ??
			null;
		const workCycle = projectWorkCycle(rows, episodeId, { policy, board });
		const files = readdirSync(record.workspace, { withFileTypes: true })
			.filter((entry) => !entry.name.startsWith("."))
			.slice(0, VIEW_LIMITS.nodes)
			.map((entry) => ({
				path: entry.name,
				kind: entry.isDirectory() ? "directory" : "file",
				size: null,
				modified_at: null,
			}));
		return {
			rows,
			integrity,
			view: buildWebView({
				label: record.label,
				taskId: record.task_id,
				events: rows,
				board,
				state,
				workCycle,
				status: null,
				workspaceFiles: files,
				limits: VIEW_LIMITS,
			}),
		};
	}

	// ---- SSE ---------------------------------------------------------------
	function broadcast(label, event, data) {
		const set = subscribers.get(label);
		if (!set) return;
		const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const res of set) res.write(frame);
	}

	function ensureTailer(record) {
		if (tailers.has(record.label)) return;
		const tailer = { rows: record.row_count, timer: null, statusTimer: null, lastStatusJson: null };
		tailer.timer = setInterval(() => {
			const { rows } = readCommittedRows(record.event_log_path);
			if (rows.length > tailer.rows) {
				const fresh = rows
					.slice(tailer.rows)
					.map((row, index) => ({ cursor: tailer.rows + index + 1, entry: transcriptEntry(row) }))
					.filter((item) => item.entry !== null);
				tailer.rows = rows.length;
				broadcast(record.label, "events", { rows: fresh, cursor: rows.length });
			}
		}, 500);
		tailer.timer.unref?.();
		// Host status: polled only while a browser is listening, and only sent when
		// it changed. This is the Host's own derived status, not a browser guess.
		tailer.statusTimer = setInterval(async () => {
			if ((subscribers.get(record.label)?.size ?? 0) === 0) return;
			const host = hosts.get(record.label);
			if (!host?.child) {
				const payload = {
					state: host?.state ?? "stopped",
					reason: host?.reason ?? null,
					status: host?.lastStatus ?? null,
				};
				const encoded = JSON.stringify(payload);
				if (encoded !== tailer.lastStatusJson) {
					tailer.lastStatusJson = encoded;
					broadcast(record.label, "status", payload);
				}
				return;
			}
			try {
				const answer = await host.request("status", {}, { timeout: 8_000 });
				const payload = { state: "ready", status: answer.status ?? null, reason: null };
				const encoded = JSON.stringify(payload);
				if (encoded !== tailer.lastStatusJson) {
					tailer.lastStatusJson = encoded;
					broadcast(record.label, "status", payload);
				}
			} catch (error) {
				const payload = { state: host.state, status: host.lastStatus, reason: error.message };
				const encoded = JSON.stringify(payload);
				if (encoded !== tailer.lastStatusJson) {
					tailer.lastStatusJson = encoded;
					broadcast(record.label, "status", payload);
				}
			}
		}, 1_500);
		tailer.statusTimer.unref?.();
		tailers.set(record.label, tailer);
	}

	// ---- routing -----------------------------------------------------------
	async function serveStatic(_req, res, pathname) {
		let file = null;
		if (pathname === "/" || pathname === "/index.html") file = join(AEGIS_WEB, "index.html");
		else if (pathname.startsWith("/aegis/")) file = join(AEGIS_WEB, pathname.slice("/aegis/".length));
		else if (pathname === "/style.css") file = join(POCKET_WEB, "style.css");
		else if (pathname.startsWith("/fonts/")) file = join(POCKET_WEB, "fonts", pathname.slice("/fonts/".length));
		else if (pathname === "/icon.svg") file = join(POCKET_WEB, "icon.svg");
		else if (pathname.startsWith("/vendor/")) {
			const name = pathname.slice("/vendor/".length);
			file = VENDOR[name] ?? null;
		}
		if (!file) throw new HttpError(404, "not_found", "not found");
		const real = resolve(file);
		const allowed = [AEGIS_WEB, join(POCKET_WEB, "fonts")].some((root) =>
			real.startsWith(`${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`),
		);
		const vendored = Object.values(VENDOR).some((path) => resolve(path) === real);
		const pocketFile = real === join(POCKET_WEB, "style.css") || real === join(POCKET_WEB, "icon.svg");
		if (!allowed && !vendored && !pocketFile) throw new HttpError(403, "not_allowed", "not served");
		let content;
		try {
			content = await readFile(real);
		} catch {
			throw new HttpError(404, "not_found", "not found");
		}
		// Revalidate every load: the app is edited in place while it runs, and a
		// stale bundle would show a screen nobody can reproduce.
		const etag = `"${createHash("sha1").update(content).digest("hex").slice(0, 16)}"`;
		if (_req.headers["if-none-match"] === etag) {
			res.writeHead(304, { etag, "cache-control": "no-cache" });
			res.end();
			return;
		}
		res.writeHead(200, {
			"content-type": TYPES[extname(real)] ?? "application/octet-stream",
			"content-length": content.length,
			"cache-control": "no-cache",
			etag,
			"x-content-type-options": "nosniff",
		});
		res.end(content);
	}

	function parsePath(pathname) {
		const parts = pathname.split("/").filter(Boolean);
		return parts;
	}

	async function handle(req, res) {
		checkHostHeader(req);
		const url = new URL(req.url ?? "/", boundOrigin());
		const pathname = url.pathname;
		if (!pathname.startsWith("/api/")) return serveStatic(req, res, pathname);

		if (req.method !== "GET" && req.method !== "HEAD") checkOrigin(req);
		const parts = parsePath(pathname);

		// GET /api/health
		if (pathname === "/api/health" && req.method === "GET") {
			return json(res, 200, {
				ok: true,
				version: WEB_SERVER_VERSION,
				home,
				experiments: listExperiments(home).length,
			});
		}

		// GET /api/models — selectable models from the trusted Pi config (read-only)
		if (pathname === "/api/models" && req.method === "GET") {
			return json(res, 200, { ok: true, ...listModels(agentDir()) });
		}

		// GET /api/tools — the coding-tool allowlist (Aegis tools are always on)
		if (pathname === "/api/tools" && req.method === "GET") {
			return json(res, 200, {
				ok: true,
				coding: CODING_TOOLS.map((tool) => ({ ...tool })),
				defaults: [...DEFAULT_CODING_TOOLS],
				always_on: [...AEGIS_TOOLS],
			});
		}

		// /api/experiments
		if (parts.length === 2 && parts[1] === "experiments" && req.method === "GET") {
			const rows = listExperiments(home).map((record) => {
				const host = hosts.get(record.label);
				return {
					label: record.label,
					task_id: record.task_id,
					workspace: record.workspace,
					created_at: record.run_json.created_at ?? null,
					rows: record.row_count,
					episodes: record.episodes,
					last_event_at: record.last_event_at,
					host_state: host?.state ?? "stopped",
					host_reason: host?.reason ?? null,
					model: record.run_json.model ?? null,
				};
			});
			return json(res, 200, { ok: true, experiments: rows });
		}

		// POST /api/experiments  { label, workspace?, provider?, model? }
		if (parts.length === 2 && parts[1] === "experiments" && req.method === "POST") {
			const body = await readBody(req);
			const label = assertLabel(body.label);
			if (experimentRecord(home, label)) throw new HttpError(409, "exists", `experiment ${label} already exists`);
			if (body.provider !== undefined && !PROVIDER_RE.test(String(body.provider)))
				throw new HttpError(400, "invalid_provider", "invalid provider");
			if (body.model !== undefined && !MODEL_RE.test(String(body.model)))
				throw new HttpError(400, "invalid_model", "invalid model");
			const selection = resolveToolSelection(Array.isArray(body.tools) && body.tools.length > 0 ? body.tools : null);
			if (!selection.ok) throw new HttpError(400, "invalid_tools", selection.error);
			let workspace = null;
			if (typeof body.workspace === "string" && body.workspace.trim()) {
				workspace = resolve(body.workspace.trim());
				if (!isAbsolute(workspace)) throw new HttpError(400, "invalid_workspace", "workspace must be absolute");
				let real;
				try {
					real = realpathSync(workspace);
				} catch {
					throw new HttpError(400, "invalid_workspace", "workspace does not exist");
				}
				if (!statSync(real).isDirectory())
					throw new HttpError(400, "invalid_workspace", "workspace must be a directory");
				const permitted = allowedRoots.some((root) => {
					const rel = relative(resolve(root), real);
					return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
				});
				if (!permitted)
					throw new HttpError(
						403,
						"workspace_not_allowed",
						"workspace is outside the allowed roots (set AEGIS_WEBUI_WORKSPACE_ROOTS)",
					);
				workspace = real;
			}
			const args = [LAUNCHER, label, "--agent-dir", agentDir()];
			if (workspace) args.push("--workspace", workspace);
			if (body.provider) args.push("--provider", String(body.provider));
			if (body.model) args.push("--model", String(body.model));
			if (selection.coding.length > 0) args.push("--tools", selection.coding.join(","));
			// Create the isolated layout through the launcher itself (ONE init path:
			// paths, run.json, workspace, knowledge). `--dry-run` writes nothing else
			// and starts no Host, no SDK Session and no EventLog writer; the Host is
			// started on demand by `attach`.
			args.push("--dry-run");
			const created = await runLauncher(args, { timeout: 60_000 });
			if (created.code !== 0)
				throw new HttpError(
					400,
					"create_failed",
					`the launcher refused the experiment: ${created.stderr.trim() || created.stdout.trim() || "unknown error"}`,
				);
			const record = experimentRecord(home, label);
			if (!record)
				throw new HttpError(
					500,
					"create_failed",
					`the launcher did not create the experiment: ${created.stderr || created.stdout || "unknown error"}`,
				);
			ensureTailer(record);
			return json(res, 201, { ok: true, experiment: { label, workspace: record.workspace } });
		}

		// /api/experiments/:label[/...]
		if (parts.length >= 3 && parts[1] === "experiments") {
			const label = assertLabel(parts[2]);
			const record = experimentRecord(home, label);
			if (!record) throw new HttpError(404, "unknown_experiment", `no experiment ${label}`);
			const action = parts[3];
			const host = hosts.get(label);

			if (!action && req.method === "GET") {
				const live = await liveStatus(record);
				const committed = committedView(record);
				return json(res, 200, {
					ok: true,
					experiment: {
						label,
						task_id: record.task_id,
						workspace: record.workspace,
						created_at: record.run_json.created_at ?? null,
						work_cycle: policyFromRunJson(record.run_json),
						console: record.run_json.console ?? null,
					},
					host: { state: live.host_state, live: live.live, reason: live.reason ?? null },
					status: live.status,
					view: live.live ? null : committed.view,
					integrity: committed.integrity,
					cursor: committed.rows.length,
				});
			}

			if (action === "view" && req.method === "GET") {
				const live = await liveStatus(record);
				if (live.live && host?.state === "ready") {
					try {
						const answer = await host.request("view", {}, { timeout: 20_000 });
						return json(res, 200, {
							ok: true,
							live: true,
							host: { state: "ready", reason: null },
							status: answer.status,
							view: answer.view,
							cursor: answer.cursor ?? null,
						});
					} catch (error) {
						// fall back to the committed view; the response says it is not live
						log(`[aegis-web] live view failed for ${label}: ${error.message}`);
					}
				}
				const committed = committedView(record);
				return json(res, 200, {
					ok: true,
					live: false,
					status: live.status,
					view: committed.view,
					integrity: committed.integrity,
					cursor: committed.rows.length,
					host: { state: live.host_state, reason: live.reason ?? null },
				});
			}

			if (action === "attach" && req.method === "POST") {
				const attached = await hostFor(record);
				return json(res, attached.ok ? 200 : 409, {
					ok: attached.ok,
					state: attached.state,
					reason: attached.ok ? null : (attached.reason ?? "the Host did not start"),
					status: attached.status ?? null,
				});
			}

			if (action === "detach" && req.method === "POST") {
				if (host) await host.stop("web detach");
				return json(res, 200, { ok: true, state: "stopped" });
			}

			if (action === "messages" && req.method === "POST") {
				const body = await readBody(req);
				if (typeof body.text !== "string" || !body.text.trim())
					throw new HttpError(400, "invalid_message", "text is required");
				if (typeof body.request_id !== "string" || !body.request_id)
					throw new HttpError(400, "invalid_request_id", "request_id is required");
				const ready = await hostFor(record);
				if (!ready.ok) {
					const state = hosts.get(label)?.state ?? "unavailable";
					return json(res, state === "conflict" ? 409 : 503, {
						ok: false,
						code: state === "conflict" ? CONTROL_ERRORS.conflict_owner : CONTROL_ERRORS.unavailable,
						error: ready.reason ?? "the Host is not available",
					});
				}
				try {
					const answer = await hosts
						.get(label)
						.request("dispatch", { request_id: body.request_id, text: body.text }, { timeout: 900_000 });
					return json(res, answer.ok ? 202 : 409, {
						ok: answer.ok === true,
						duplicate: answer.duplicate === true,
						action: answer.action ?? null,
						reason: answer.reason ?? null,
						turns: answer.turns ?? null,
						receipt_status: answer.receipt_status ?? null,
						status: answer.status_snapshot ?? null,
					});
				} catch (error) {
					if (error instanceof HttpError)
						return json(res, error.status, { ok: false, code: error.code, error: error.message });
					throw error;
				}
			}

			if (action === "models" && req.method === "GET") {
				const attached = await hostFor(record, { create: false });
				if (attached.ok) {
					try {
						const answer = await attached.host.request("models", {}, { timeout: 10_000 });
						if (answer.ok !== false) return json(res, 200, { ok: true, live: true, models: answer.models ?? [] });
					} catch {
						// fall through to the config catalog below
					}
				}
				const catalog = listModels(record.agent_dir ?? agentDir());
				return json(res, 200, {
					ok: true,
					live: false,
					models: catalog.models,
					default: catalog.default,
				});
			}

			if (action === "model" && req.method === "POST") {
				const body = await readBody(req);
				if (typeof body.provider !== "string" || !body.provider || typeof body.model !== "string" || !body.model)
					throw new HttpError(400, "invalid_model", "provider and model are required");
				if (!PROVIDER_RE.test(body.provider) || !MODEL_RE.test(body.model))
					throw new HttpError(400, "invalid_model", "invalid provider or model");
				const attached = await hostFor(record);
				if (!attached.ok)
					return json(res, attached.state === "conflict" ? 409 : 503, {
						ok: false,
						code: attached.state === "conflict" ? CONTROL_ERRORS.conflict_owner : CONTROL_ERRORS.unavailable,
						error: attached.reason ?? "the Host is not available",
					});
				try {
					const answer = await attached.host.request(
						"set_model",
						{ provider: body.provider, model: body.model },
						{ timeout: 30_000 },
					);
					return json(res, answer.ok === false ? 409 : 200, {
						ok: answer.ok !== false,
						reason: answer.reason ?? null,
						model: answer.model ?? null,
						status: answer.status ?? null,
					});
				} catch (error) {
					if (error instanceof HttpError)
						return json(res, error.status, { ok: false, code: error.code, error: error.message });
					throw error;
				}
			}

			if (action === "pause" && req.method === "POST") {
				const attached = hosts.get(label);
				if (!attached?.child || attached.state !== "ready")
					throw new HttpError(409, CONTROL_ERRORS.unavailable, "no Host is attached");
				const answer = await attached.request("pause", { reason: "web pause" });
				return json(res, 200, { ok: answer.ok !== false });
			}

			if (action === "resume" && req.method === "POST") {
				const ready = await hostFor(record);
				if (!ready.ok)
					return json(res, ready.state === "conflict" ? 409 : 503, {
						ok: false,
						code: ready.state === "conflict" ? CONTROL_ERRORS.conflict_owner : CONTROL_ERRORS.unavailable,
						error: ready.reason ?? "the Host is not available",
					});
				try {
					const answer = await ready.host.request("resume", { reason: "web resume" }, { timeout: 120_000 });
					return json(res, answer.ok === false ? 409 : 200, {
						ok: answer.ok !== false,
						reason: answer.reason ?? null,
					});
				} catch (error) {
					if (error instanceof HttpError)
						return json(res, error.status, { ok: false, code: error.code, error: error.message });
					throw error;
				}
			}

			if (action === "stop" && req.method === "POST") {
				const host = hosts.get(label);
				if (host) await host.stop("web stop");
				return json(res, 200, { ok: true, state: "stopped" });
			}

			if (action === "attachments" && req.method === "POST") {
				const body = await readBody(req, MAX_ATTACHMENT_BODY);
				if (typeof body.name !== "string" || !body.name.trim())
					throw new HttpError(400, "invalid_attachment", "a file name is required");
				if (typeof body.data_base64 !== "string" || body.data_base64.length === 0)
					throw new HttpError(400, "invalid_attachment", "file content is required");
				const uploaded = await saveAttachment(record, body);
				return json(res, 201, { ok: true, ...uploaded });
			}

			if (action === "files" && req.method === "GET") {
				const requested = url.searchParams.get("path") ?? "";
				const listing = await listWorkspace(record.workspace, requested);
				return json(res, 200, { ok: true, ...listing });
			}

			if (action === "file" && req.method === "GET") {
				const requested = url.searchParams.get("path") ?? "";
				const file = await readWorkspaceFile(record.workspace, requested);
				return json(res, 200, { ok: true, ...file });
			}

			if (action === "stream" && req.method === "GET") {
				const cursor = Number(url.searchParams.get("cursor") ?? "0");
				ensureTailer(record);
				res.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-store",
					connection: "keep-alive",
					"x-accel-buffering": "no",
				});
				res.write(`retry: 2000\n\n`);
				const set = subscribers.get(label) ?? new Set();
				subscribers.set(label, set);
				set.add(res);
				const { rows } = readCommittedRows(record.event_log_path);
				const from = Number.isFinite(cursor) && cursor >= 0 ? Math.min(cursor, rows.length) : 0;
				const initial = rows
					.slice(from)
					.map((row, index) => ({ cursor: from + index + 1, entry: transcriptEntry(row) }))
					.filter((item) => item.entry !== null);
				res.write(
					`event: events\ndata: ${JSON.stringify({ rows: initial, cursor: rows.length, reset: from !== cursor })}\n\n`,
				);
				const ping = setInterval(() => res.write(`event: ping\ndata: {}\n\n`), 15_000);
				ping.unref?.();
				req.on("close", () => {
					clearInterval(ping);
					set.delete(res);
				});
				return;
			}

			throw new HttpError(404, "not_found", "unknown experiment action");
		}

		// POST /api/requests/:request_id  -> committed receipt lookup (idempotency)
		if (parts.length === 3 && parts[1] === "requests" && req.method === "POST") {
			const body = await readBody(req);
			const label = assertLabel(body.label);
			const record = experimentRecord(home, label);
			if (!record) throw new HttpError(404, "unknown_experiment", "unknown experiment");
			const { rows } = readCommittedRows(record.event_log_path);
			const receipt = rows
				.filter((row) => row.event_type === "runtime.note" && row.payload?.kind === "web.control.receipt")
				.filter((row) => row.payload?.request_id === parts[2])
				.at(-1);
			return json(res, 200, {
				ok: true,
				found: Boolean(receipt),
				receipt: receipt
					? {
							request_id: receipt.payload.request_id,
							status: receipt.payload.status ?? null,
							prompt_digest: receipt.payload.prompt_digest ?? null,
							event_id: receipt.event_id,
							recorded_at: receipt.recorded_at ?? null,
						}
					: null,
			});
		}

		throw new HttpError(404, "not_found", "not found");
	}

	function agentDir() {
		return defaultAgentDir ?? join(home, "agent");
	}

	async function runLauncher(args, { timeout = 30_000 } = {}) {
		return new Promise((resolveRun) => {
			const child = spawn("bash", args, { cwd: REPO_ROOT, env: { ...process.env, ...env } });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
			}, timeout);
			child.on("exit", (code) => {
				clearTimeout(timer);
				resolveRun({ code, stdout, stderr });
			});
		});
	}

	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(port, hostname, resolveListen);
	});
	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;
	const origin = `http://${hostname}:${actualPort}`;
	log(`[aegis-web] listening on ${origin} (home=${home})`);

	return {
		version: WEB_SERVER_VERSION,
		server,
		origin,
		port: actualPort,
		home,
		experimentsRoot,
		async close() {
			for (const tailer of tailers.values()) {
				clearInterval(tailer.timer);
				if (tailer.statusTimer) clearInterval(tailer.statusTimer);
			}
			tailers.clear();
			for (const set of subscribers.values()) for (const res of set) res.end();
			subscribers.clear();
			await Promise.all([...hosts.values()].map((host) => host.stop("server shutdown")));
			await new Promise((resolveClose) => server.close(resolveClose));
		},
		hostProcess(label) {
			return hosts.get(label) ?? null;
		},
	};
}
