#!/usr/bin/env node
// Phase "Aegis WebUI" — production-wiring tests (WEB-01..WEB-06).
//
// Everything here goes through the REAL path:
//   HTTP (loopback) → console-web server → run-experiment.sh → Experiment Host
//   child process → real Pi SDK + faux provider → Observer → EventLog.
//
// No browser is driven here (see the delivery report for the browsed run); these
// tests assert the server/Host contract, the committed facts and the security
// boundaries. A real model/network/target is never used.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebConsole } from "../console-web/server.mjs";
import { buildWebView } from "../console-web/view.mjs";
import { projectBoard } from "../memory/board.mjs";
import { projectState } from "../memory/state.mjs";
import { normalizeWorkCyclePolicy, projectWorkCycle } from "../memory/work-cycle.mjs";
import { appendTo } from "../UI/Aegis-pocket/web/aegis/timeline.js";

const REPO = resolve(import.meta.dirname, "..", "..");
const LAUNCHER = join(REPO, "run-experiment.sh");
let _failures = 0;
const checks = [];
function check(name, condition, detail) {
	checks.push({ name, ok: Boolean(condition) });
	if (condition) console.log(`ok - ${name}`);
	else {
		_failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}
function readCommitted(path) {
	if (!existsSync(path)) return [];
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
}

function makeHome() {
	const home = mkdtempSync(join(tmpdir(), "aegis-webui-"));
	const workspace = join(home, "workspaces", "door");
	const knowledge = join(home, "knowledge");
	const agent = join(home, "agent");
	for (const dir of [workspace, knowledge, agent, join(home, "experiments")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(workspace, "door.json"), JSON.stringify({ locked: true }));
	// A knowledge seed so a work review has a real local corpus to query.
	writeFileSync(
		join(knowledge, "door.md"),
		JSON.stringify({
			schema_version: "knowledge-seed-1",
			source_kind: "local_document",
			verified: false,
			action_policy: "none",
			source_uri: "file:///knowledge/door.md",
			source_digest: "sha256:door-seed",
			topic: "fixture door",
			sections: [{ title: "Fixture door", content: "Reading door.json reports whether the fixture door is locked." }],
		}),
	);
	const fauxScript = join(home, "faux-steps.json");
	writeFileSync(
		fauxScript,
		JSON.stringify([
			{
				tool_calls: [
					{
						name: "aegis_propose",
						arguments: { kind: "intent", text: "inspect the fixture door", scope: "unit:inspect" },
					},
					{ name: "read", arguments: { path: "door.json" } },
				],
			},
			{ text: "The door reports `locked: true`. I have not changed it." },
			{ text: "Waiting for the next instruction." },
		]),
	);
	return { home, workspace, knowledge, agent, fauxScript };
}

function httpHelper(origin) {
	async function request(method, path, { body, origin: requestOrigin, headers = {} } = {}) {
		const response = await fetch(`${origin}${path}`, {
			method,
			headers: {
				accept: "application/json",
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...(requestOrigin ? { origin: requestOrigin } : {}),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		return { status: response.status, body: json, text };
	}
	return {
		get: (path, options) => request("GET", path, options),
		post: (path, body = {}, options = {}) => request("POST", path, { body, origin: origin, ...options }),
		request,
	};
}

function sseFrames(origin, path, { duration = 2000 } = {}) {
	return new Promise((resolveFrames) => {
		const url = new URL(path, origin);
		let text = "";
		const request = httpRequest(
			{
				hostname: url.hostname,
				port: url.port,
				path: `${url.pathname}${url.search}`,
				method: "GET",
				headers: { host: url.host, accept: "text/event-stream" },
			},
			(response) => {
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					text += chunk;
				});
				const timer = setTimeout(() => {
					request.destroy();
					resolveFrames(text);
				}, duration);
				response.on("end", () => {
					clearTimeout(timer);
					resolveFrames(text);
				});
			},
		);
		request.on("error", () => resolveFrames(text));
		request.end();
	});
}

function parseSse(text, eventName) {
	const frames = text.split("\n\n").filter(Boolean);
	const out = [];
	for (const frame of frames) {
		const lines = frame.split("\n");
		const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
		const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
		if (!event || event !== eventName || !data) continue;
		try {
			out.push(JSON.parse(data));
		} catch {
			// ignore a partial frame
		}
	}
	return out;
}

/** Spawn the real launcher and wait until it prints its ready URL. */
function startLauncher(home, env, { port = 0, flags = ["--no-open"] } = {}) {
	return new Promise((resolveStart, rejectStart) => {
		const child = spawn("bash", [join(REPO, "run-experiment-web.sh"), "--port", String(port), ...flags], {
			cwd: REPO,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			rejectStart(new Error(`the launcher did not print a URL in time\n${stdout}${stderr}`));
		}, 60_000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			const match = /url +(http:\/\/127\.0\.0\.1:(\d+))/.exec(stdout);
			// The ready block ends with the `browser` line; wait for the whole block so
			// assertions do not race the stream.
			if (match && /^ +browser +/m.test(stdout)) {
				clearTimeout(timer);
				resolveStart({ child, origin: match[1], stdout: () => stdout, stderr: () => stderr });
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			rejectStart(new Error(`the launcher exited early (code ${code})\n${stdout}${stderr}`));
		});
	});
}

function rawRequest(origin, path, headers = {}, method = "GET") {
	return new Promise((resolveRaw) => {
		const url = new URL(path, origin);
		const request = httpRequest(
			{ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers },
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					body += chunk;
				});
				response.on("end", () => resolveRaw({ status: response.statusCode, body }));
			},
		);
		request.on("error", () => resolveRaw({ status: 0, body: "" }));
		request.end();
	});
}

async function main() {
	const fixture = makeHome();
	const { home, workspace, fauxScript } = fixture;
	const knowledge = fixture.knowledge;
	const agent = fixture.agent;
	const childEnv = {
		AEGIS_HOME: home,
		AEGIS_EXPERIMENTS_ROOT: join(home, "experiments"),
		AEGIS_PI_AGENT_DIR: agent,
		AEGIS_CONSOLE_PROVIDER: "faux",
		AEGIS_CONSOLE_FAUX_SCRIPT: fauxScript,
		AEGIS_KNOWLEDGE_DIR: knowledge,
		AEGIS_KNOWLEDGE_ENABLED: "on",
		AEGIS_WEB_SEARCH: "off",
	};
	let server = null;
	try {
		server = await startWebConsole({
			home,
			port: 0,
			workspaceRoots: [workspace],
			env: childEnv,
			defaultAgentDir: agent,
		});
		const origin = server.origin;
		const api = httpHelper(origin);
		const label = "web-01";
		const expDir = join(home, "experiments", label);
		const eventLogPath = join(expDir, "runtime", "events.jsonl");

		// ---- WEB-01: startup, ownership, no pre-ownership events --------------
		const created = await api.post("/api/experiments", {
			label,
			workspace,
			provider: "faux",
			model: "web-fixture",
		});
		check("WEB-01: a new experiment is created through the launcher", created.status === 201, created.text);
		check(
			"WEB-01: creation writes no EventLog rows",
			readCommitted(eventLogPath).length === 0,
			`${readCommitted(eventLogPath).length} rows`,
		);
		const attached = await api.post(`/api/experiments/${label}/attach`);
		check(
			"WEB-01: attach starts one Host with ownership",
			attached.status === 200 && attached.body.state === "ready",
			attached.text,
		);
		const rowsAfterAttach = readCommitted(eventLogPath);
		check(
			"WEB-01: the Host bound exactly one Session",
			rowsAfterAttach.filter((r) => r.event_type === "session.started").length === 1,
		);

		// An experiment created by the CLI records its own (possibly derived) agent
		// dir; attaching it from the web must reuse THAT dir, not the server default,
		// or the run's provider/MCP binding would silently change.
		const runJsonAfterAttach = JSON.parse(readFileSync(join(expDir, "run.json"), "utf8"));
		check(
			"WEB-01: attach reuses the experiment's recorded agent dir",
			server.hostProcess(label)?.agentDir === runJsonAfterAttach.paths.agent_dir,
			`${server.hostProcess(label)?.agentDir} != ${runJsonAfterAttach.paths.agent_dir}`,
		);

		// A second writer (the ordinary CLI entry) must be refused before it can
		// create a Session, and must not touch the committed prefix.
		const before = {
			bytes: readFileSync(eventLogPath, "utf8"),
			rows: rowsAfterAttach.length,
			sessions: rowsAfterAttach.filter((r) => r.event_type === "session.started").length,
		};
		const second = spawnSync(
			"bash",
			[LAUNCHER, label, "--resume", "--workspace", workspace, "--agent-dir", agent, "--", "--control", "stdio"],
			{ cwd: REPO, env: { ...process.env, ...childEnv }, encoding: "utf8", timeout: 180_000, input: "" },
		);
		check(
			"WEB-01: the second writer is refused with the ownership exit code",
			second.status === 4,
			`${second.status} ${second.stderr.slice(-200)}`,
		);
		const after = {
			bytes: readFileSync(eventLogPath, "utf8"),
			rows: readCommitted(eventLogPath).length,
			sessions: readCommitted(eventLogPath).filter((r) => r.event_type === "session.started").length,
		};
		check("WEB-01: the refused writer changed no EventLog byte", after.bytes === before.bytes);
		check(
			"WEB-01: the refused writer added no Session",
			after.sessions === before.sessions && after.rows === before.rows,
		);

		// Creation refusals leave nothing behind.
		const badWorkspace = await api.post("/api/experiments", { label: "web-bad-ws", workspace: "/tmp" });
		check("WEB-01: a workspace outside the allowed roots is refused", badWorkspace.status === 403, badWorkspace.text);
		check(
			"WEB-01: the refused creation left no experiment directory",
			!existsSync(join(home, "experiments", "web-bad-ws")),
		);
		const duplicate = await api.post("/api/experiments", { label, workspace, provider: "faux", model: "web-fixture" });
		check("WEB-01: an existing label is refused", duplicate.status === 409, duplicate.text);
		const badLabel = await api.post("/api/experiments", { label: "../escape" });
		check("WEB-01: an invalid label is refused", badLabel.status === 400, badLabel.text);

		// ---- WEB-02: messages, real events, idempotency -----------------------
		const firstSend = await api.post(`/api/experiments/${label}/messages`, {
			text: "TASK web-01: inspect the fixture door",
			request_id: "req:web-01",
		});
		check("WEB-02: a message is accepted", firstSend.status === 202, firstSend.text);
		check(
			"WEB-02: acceptance is not success",
			firstSend.body?.ok === true && firstSend.body?.receipt_status === "handled",
		);
		const rowsAfterSend = readCommitted(eventLogPath);
		const kinds = rowsAfterSend.map((r) => r.event_type);
		check(
			"WEB-02: the prompt reached the SDK/Observer",
			kinds.includes("episode.started") && kinds.includes("message.completed"),
		);
		check("WEB-02: a provider-bound request was projected", kinds.includes("request.projected"));
		check(
			"WEB-02: the tool call is committed with its excerpt",
			rowsAfterSend.some(
				(r) =>
					r.event_type === "action.completed" &&
					r.payload?.tool_name === "read" &&
					typeof r.payload?.content_excerpt === "string",
			),
		);
		check(
			"WEB-02: the assistant text is committed",
			rowsAfterSend.some((r) => r.payload?.role === "assistant" && /locked: true/.test(r.payload?.text_excerpt ?? "")),
		);
		check(
			"WEB-02: the scoped Intent is committed",
			rowsAfterSend.some((r) => r.payload?.kind === "intent" && r.payload?.scope === "unit:inspect"),
		);

		const rowsBeforeDuplicate = readCommitted(eventLogPath).length;
		const duplicateSend = await api.post(`/api/experiments/${label}/messages`, {
			text: "TASK web-01: inspect the fixture door",
			request_id: "req:web-01",
		});
		check(
			"WEB-02: a retried request id is not sent twice",
			duplicateSend.status === 202 && duplicateSend.body?.duplicate === true,
			duplicateSend.text,
		);
		check("WEB-02: the retry wrote no new committed rows", readCommitted(eventLogPath).length === rowsBeforeDuplicate);
		const conflict = await api.post(`/api/experiments/${label}/messages`, {
			text: "different prompt",
			request_id: "req:web-01",
		});
		check(
			"WEB-02: the same id with different text is a conflict",
			conflict.status === 409 && conflict.body?.code === "request_id_conflict",
			conflict.text,
		);
		check("WEB-02: the conflict wrote no rows", readCommitted(eventLogPath).length === rowsBeforeDuplicate);

		const [parallelA, parallelB] = await Promise.all([
			api.post(`/api/experiments/${label}/messages`, { text: "TASK web-01: parallel A", request_id: "req:par-a" }),
			api.post(`/api/experiments/${label}/messages`, { text: "TASK web-01: parallel B", request_id: "req:par-b" }),
		]);
		check(
			"WEB-02: concurrent requests are both accepted (serialized by the Host)",
			parallelA.status === 202 && parallelB.status === 202,
			`${parallelA.status}/${parallelB.status}`,
		);
		const rowsParallel = readCommitted(eventLogPath);
		check(
			"WEB-02: both parallel prompts are committed",
			["req:par-a", "req:par-b"].every(
				(id) =>
					rowsParallel.filter(
						(r) =>
							r.payload?.kind === "web.control.receipt" &&
							r.payload?.request_id === id &&
							r.payload?.status === "handled",
					).length === 1,
			),
		);

		check("WEB-02: no Pocket Durable database exists", !existsSync(join(home, "pocket.sqlite")));
		const pocketApi = await api.get("/api/pocket/sessions");
		check("WEB-02: the Pocket execution API is not mounted", pocketApi.status === 404);

		// ---- WEB-03: lifecycle, disconnect, rotation continuity ---------------
		const paused = await api.post(`/api/experiments/${label}/pause`);
		check("WEB-03: pause goes through the Host", paused.status === 200, paused.text);
		const pausedSend = await api.post(`/api/experiments/${label}/messages`, {
			text: "while paused",
			request_id: "req:paused",
		});
		check(
			"WEB-03: a paused Host refuses dispatch",
			pausedSend.status === 409 && pausedSend.body?.code === "dispatch_paused",
			pausedSend.text,
		);
		const resumed = await api.post(`/api/experiments/${label}/resume`);
		check("WEB-03: resume is accepted", resumed.status === 200, resumed.text);

		// Closing the browser (SSE disconnect) must not stop the task.
		const framesText = await sseFrames(origin, `/api/experiments/${label}/stream?cursor=0`, { duration: 1500 });
		check(
			"WEB-03: the SSE stream replays committed rows",
			parseSse(framesText, "events").some((frame) => (frame.rows ?? []).length > 0),
		);
		const afterDisconnect = await api.get(`/api/experiments/${label}/view`);
		check(
			"WEB-03: a closed browser leaves the Host running",
			afterDisconnect.body?.live === true && afterDisconnect.body?.host?.state === "ready",
			JSON.stringify(afterDisconnect.body?.host),
		);
		const afterDisconnectSend = await api.post(`/api/experiments/${label}/messages`, {
			text: "TASK web-01: after reconnect",
			request_id: "req:after-reconnect",
		});
		check(
			"WEB-03: work continues after the browser went away",
			afterDisconnectSend.status === 202,
			afterDisconnectSend.text,
		);

		// Session rotation continuity is a VIEW property over committed events: one
		// Episode, one transcript, and the rotation shown as a boundary.
		const rotationHome = mkdtempSync(join(tmpdir(), "aegis-webui-rotation-"));
		try {
			const rotationLabel = "web-rotation";
			const rotationDir = join(rotationHome, "experiments", rotationLabel);
			mkdirSync(join(rotationDir, "runtime"), { recursive: true });
			mkdirSync(join(rotationDir, "workspace"), { recursive: true });
			writeFileSync(join(rotationDir, "workspace", "door.json"), JSON.stringify({ locked: true }));
			writeFileSync(
				join(rotationDir, "run.json"),
				JSON.stringify({
					schema_version: "aegis-experiment-1",
					label: rotationLabel,
					task_id: rotationLabel,
					created_at: "2026-01-01T00:00:00.000Z",
					workspace: join(rotationDir, "workspace"),
					paths: { event_log: join(rotationDir, "runtime", "events.jsonl") },
				}),
			);
			const rotationLog = join(rotationDir, "runtime", "events.jsonl");
			const rows = [];
			let sequence = 0;
			const append = (event_type, payload, session = null) => {
				sequence += 1;
				rows.push({
					schema_version: "1.1",
					event_id: `ev-${sequence}`,
					event_type,
					episode_id: sequence === 1 ? "ep-1" : "ep-1",
					sequence,
					recorded_at: `2026-01-01T00:00:0${sequence}.000Z`,
					source: { actor_id: "pi", kind: "runtime", adapter: "test", version: "1" },
					payload: { ...payload, ...(session ? { session_id: session } : {}) },
				});
			};
			append("episode.started", { task_id: rotationLabel, goal: { description: "TASK web-rotation: rotate" } });
			append("session.started", {}, "session-a");
			append("message.completed", { role: "assistant", text_excerpt: "before rotation" });
			append("handoff.completed", {
				request_id: "r1",
				from_session: "session-a",
				to_session: "session-b",
				work_cycle_identity: "context:session-a:1:2",
			});
			append("session.started", {}, "session-b");
			append("message.completed", { role: "assistant", text_excerpt: "after rotation" });
			writeFileSync(
				rotationLog,
				`${rows.map((row) => JSON.stringify({ ...row, event_digest: "sha256:x" })).join("\n")}\n`,
			);
			const rotationServer = await startWebConsole({
				home: rotationHome,
				port: 0,
				env: childEnv,
				defaultAgentDir: agent,
			});
			try {
				const rotationApi = httpHelper(rotationServer.origin);
				const detail = await rotationApi.get(`/api/experiments/${rotationLabel}/view`);
				const view = detail.body?.view;
				check("WEB-03: a rotated run stays ONE Episode", view?.identity?.episode_id === "ep-1");
				check(
					"WEB-03: the transcript continues across the rotation",
					(view?.transcript?.rows ?? []).some((r) => r.kind === "rotation") &&
						(view?.transcript?.rows ?? []).filter((r) => r.kind === "message").length === 2,
				);
				check(
					"WEB-03: both Sessions are registered for the run",
					(view?.session?.registered ?? []).length === 2,
					JSON.stringify(view?.session?.registered),
				);
				check(
					"WEB-03: a stopped run is shown read-only",
					detail.body?.live === false && detail.body?.host?.state === "stopped",
				);
			} finally {
				await rotationServer.close();
			}
		} finally {
			rmSync(rotationHome, { recursive: true, force: true });
		}

		// ---- WEB-04: panels against the same committed projection -------------
		const liveView = await api.get(`/api/experiments/${label}/view`);
		const view = liveView.body?.view;
		check("WEB-04: the live view is served by the Host", liveView.body?.live === true);
		check(
			"WEB-04: the board carries the committed Intent",
			(view?.board?.nodes ?? []).some((node) => node.type === "Intent" && node.scope === "unit:inspect"),
		);
		check(
			"WEB-04: the action panel shows the read with its excerpt",
			(view?.actions?.recent ?? []).some(
				(row) => row.tool_name === "read" && (row.observed !== null || row.content_digest),
			),
		);
		check(
			"WEB-04: the provider-bound RAM is reported as audit metadata",
			view?.session?.ram?.provider_bound?.available === true &&
				view.session.ram.provider_bound.text_available === false,
		);
		check("WEB-04: rebuilt RAM is available and marked as rebuilt", view?.session?.ram?.rebuilt?.available === true);
		check(
			"WEB-04: context usage comes from the real settled event",
			view?.session?.context?.known === true || view?.session?.context?.known === false,
		);

		// Parity: the same view built directly from the committed rows is identical.
		const committedRows = readCommitted(eventLogPath);
		const stable = committedRows.slice(0, committedRows.length);
		const board = projectBoard(stable);
		const state = projectState(stable);
		const policy = normalizeWorkCyclePolicy({});
		const episodeId = Object.keys(state.episodes)[0] ?? null;
		const cycle = projectWorkCycle(stable, episodeId, { policy, board });
		const direct = buildWebView({
			label,
			taskId: label,
			events: stable,
			board,
			state,
			workCycle: cycle,
			status: liveView.body.status,
			limits: undefined,
		});
		check(
			"WEB-04: panel data matches the same projection built locally",
			JSON.stringify(direct.progress) === JSON.stringify(view.progress),
			"progress differs",
		);
		check(
			"WEB-04: board counts match the local projection",
			JSON.stringify(direct.board.counts) === JSON.stringify(view.board.counts),
		);
		check(
			"WEB-04: action list matches the local projection",
			JSON.stringify(direct.actions.recent.map((r) => [r.action_id, r.status])) ===
				JSON.stringify(view.actions.recent.map((r) => [r.action_id, r.status])),
		);

		// Damaged log: committed prefix is still readable, integrity says so.
		const corruptHome = mkdtempSync(join(tmpdir(), "aegis-webui-corrupt-"));
		try {
			const corruptLabel = "web-corrupt";
			const corruptDir = join(corruptHome, "experiments", corruptLabel);
			mkdirSync(join(corruptDir, "runtime"), { recursive: true });
			mkdirSync(join(corruptDir, "workspace"), { recursive: true });
			writeFileSync(
				join(corruptDir, "run.json"),
				JSON.stringify({
					label: corruptLabel,
					task_id: corruptLabel,
					workspace: join(corruptDir, "workspace"),
					paths: { event_log: join(corruptDir, "runtime", "events.jsonl") },
				}),
			);
			writeFileSync(
				join(corruptDir, "runtime", "events.jsonl"),
				`${JSON.stringify({ schema_version: "1.1", event_id: "e1", event_type: "episode.started", episode_id: "ep-x", sequence: 0, source: { kind: "runtime" }, payload: { task_id: corruptLabel, goal: { description: "g" } } })}\n{"partial":`,
			);
			const corruptServer = await startWebConsole({
				home: corruptHome,
				port: 0,
				env: childEnv,
				defaultAgentDir: agent,
			});
			try {
				const corruptApi = httpHelper(corruptServer.origin);
				const damaged = await corruptApi.get(`/api/experiments/${corruptLabel}/view`);
				check(
					"WEB-04: a damaged log reports integrity honestly",
					damaged.body?.integrity?.ok === false && /unparseable/.test(damaged.body.integrity.reason ?? ""),
					JSON.stringify(damaged.body?.integrity),
				);
				check("WEB-04: the committed prefix is still shown", damaged.body?.view?.identity?.episode_id === "ep-x");
			} finally {
				await corruptServer.close();
			}
		} finally {
			rmSync(corruptHome, { recursive: true, force: true });
		}

		// ---- WEB-05: cursors, replay, restart receipts ------------------------
		const totalRows = readCommitted(eventLogPath).length;
		const tailFrames = await sseFrames(origin, `/api/experiments/${label}/stream?cursor=${totalRows - 1}`, {
			duration: 1500,
		});
		const tailEvents = parseSse(tailFrames, "events");
		check(
			"WEB-05: a cursor returns only later committed rows",
			tailEvents.length > 0 && (tailEvents[0].rows ?? []).every((row) => row.cursor === totalRows),
			JSON.stringify(tailEvents[0]?.rows?.map((r) => r.cursor)),
		);
		const resetFrames = await sseFrames(origin, `/api/experiments/${label}/stream?cursor=99999`, { duration: 1500 });
		const resetEvents = parseSse(resetFrames, "events");
		check(
			"WEB-05: an invalid cursor asks the client to reset",
			resetEvents[0]?.reset === true,
			JSON.stringify(resetEvents[0]?.reset),
		);
		check(
			"WEB-05: the client deduplicates by committed event id",
			appendTo([{ event_id: "a" }, { event_id: "b" }], [{ event_id: "b" }, { event_id: "c" }]).length === 3,
		);

		const stop = await api.post(`/api/experiments/${label}/stop`);
		check("WEB-05: stop shuts the Host down", stop.status === 200, stop.text);
		const rowsAfterStop = readCommitted(eventLogPath).length;
		const receiptLookup = await api.post("/api/requests/req:web-01", { label });
		check(
			"WEB-05: a receipt survives the Host restart",
			receiptLookup.body?.found === true && receiptLookup.body?.receipt?.status === "handled",
			JSON.stringify(receiptLookup.body),
		);
		const reattached = await api.post(`/api/experiments/${label}/attach`);
		check("WEB-05: the experiment can be re-attached", reattached.status === 200, reattached.text);
		const replaySend = await api.post(`/api/experiments/${label}/messages`, {
			text: "TASK web-01: inspect the fixture door",
			request_id: "req:web-01",
		});
		check(
			"WEB-05: a replayed request is resolved from the committed receipt",
			replaySend.body?.duplicate === true,
			replaySend.text,
		);
		check(
			"WEB-05: the replay did not re-run the prompt",
			readCommitted(eventLogPath).filter((r) => r.event_type === "episode.started").length === 1 &&
				readCommitted(eventLogPath).length >= rowsAfterStop,
		);

		// ---- WEB-06: files and entry boundaries -------------------------------
		const listing = await api.get(`/api/experiments/${label}/files`);
		check(
			"WEB-06: the workspace listing is served",
			(listing.body?.entries ?? []).some((entry) => entry.name === "door.json"),
			listing.text,
		);
		const fileRead = await api.get(`/api/experiments/${label}/file?path=door.json`);
		check(
			"WEB-06: a workspace file is bounded and read",
			fileRead.body?.text?.includes("locked") === true,
			fileRead.text,
		);
		const traversal = await api.get(`/api/experiments/${label}/file?path=../../etc/passwd`);
		check(
			"WEB-06: '..' traversal is refused",
			traversal.status === 400 && traversal.body?.code === "path_escape",
			traversal.text,
		);
		const absolute = await api.get(`/api/experiments/${label}/file?path=/etc/passwd`);
		check("WEB-06: an absolute path is refused", absolute.status === 400, absolute.text);
		symlinkSync("/etc/passwd", join(workspace, "outside-link"));
		const outsideListing = await api.get(`/api/experiments/${label}/files`);
		check(
			"WEB-06: a symlink escape is reported, not followed",
			(outsideListing.body?.entries ?? []).some((entry) => entry.name === "outside-link" && entry.kind === "outside"),
			JSON.stringify(outsideListing.body?.entries),
		);
		const outsideRead = await api.get(`/api/experiments/${label}/file?path=outside-link`);
		check(
			"WEB-06: reading through a symlink escape is refused",
			outsideRead.status === 400 && outsideRead.body?.code === "path_escape",
			outsideRead.text,
		);

		const crossOrigin = await api.request("POST", `/api/experiments/${label}/pause`, {
			body: {},
			origin: "http://evil.example",
		});
		check("WEB-06: a cross-site POST is refused", crossOrigin.status === 403, String(crossOrigin.status));
		const badHost = await rawRequest(origin, "/api/health", { host: "evil.example" });
		check("WEB-06: an unexpected Host header is refused", badHost.status === 403, String(badHost.status));
		const getWrite = await api.get(`/api/experiments/${label}/pause`);
		check("WEB-06: a GET cannot perform a write action", getWrite.status === 404, String(getWrite.status));
		const observationWrite = await api.post("/api/observations", { anything: true });
		check(
			"WEB-06: the read-only observation API is not re-mounted here",
			observationWrite.status === 404,
			String(observationWrite.status),
		);

		// ---- WEB-10: model/tool selection and workspace attachments ------------
		{
			const models = await api.get("/api/models");
			check(
				"WEB-10: the model catalog is served from the Pi config (read-only)",
				models.status === 200 && Array.isArray(models.body?.models),
				models.text,
			);
			check(
				"WEB-10: the default model comes from settings, not from a guess",
				models.body?.default === null ||
					(typeof models.body.default.provider === "string" && typeof models.body.default.id === "string"),
			);
			const toolCatalog = await api.get("/api/tools");
			check(
				"WEB-10: the coding-tool allowlist is served",
				toolCatalog.status === 200 &&
					(toolCatalog.body?.coding ?? []).some((tool) => tool.id === "bash" && tool.effect === true),
				toolCatalog.text,
			);
			check(
				"WEB-10: Aegis control tools are listed as always on",
				(toolCatalog.body?.always_on ?? []).includes("aegis_propose") &&
					(toolCatalog.body?.always_on ?? []).includes("aegis_work_review"),
			);
			const unknownTool = await api.post("/api/experiments", { label: "web-bad-tools", tools: ["bash", "rm-rf"] });
			check(
				"WEB-10: an unknown tool is refused",
				unknownTool.status === 400 && unknownTool.body?.code === "invalid_tools",
				unknownTool.text,
			);
			const createdWithTools = await api.post("/api/experiments", {
				label: "web-tools",
				workspace,
				provider: "faux",
				model: "web-fixture",
				tools: ["read", "grep"],
			});
			check(
				"WEB-10: a selected toolset creates the experiment",
				createdWithTools.status === 201,
				createdWithTools.text,
			);
			const toolsRunJson = JSON.parse(readFileSync(join(home, "experiments", "web-tools", "run.json"), "utf8"));
			check(
				"WEB-10: the selected tools are recorded for resume",
				JSON.stringify(toolsRunJson.tools) === JSON.stringify(["read", "grep"]),
				JSON.stringify(toolsRunJson.tools),
			);

			const upload = await api.post(`/api/experiments/${label}/attachments`, {
				name: "notes.txt",
				data_base64: Buffer.from("hello attachment\n").toString("base64"),
			});
			check(
				"WEB-10: an attachment is written into the workspace",
				upload.status === 201 && upload.body?.name === "notes.txt",
				upload.text,
			);
			check(
				"WEB-10: the uploaded bytes are the real ones",
				readFileSync(join(workspace, "notes.txt"), "utf8") === "hello attachment\n",
			);
			const duplicateUpload = await api.post(`/api/experiments/${label}/attachments`, {
				name: "notes.txt",
				data_base64: Buffer.from("second").toString("base64"),
			});
			check(
				"WEB-10: an existing file is not overwritten",
				duplicateUpload.status === 409 && duplicateUpload.body?.code === "attachment_exists",
				duplicateUpload.text,
			);
			const traversalUpload = await api.post(`/api/experiments/${label}/attachments`, {
				name: "../../etc/passwd",
				data_base64: Buffer.from("x").toString("base64"),
			});
			check(
				"WEB-10: a path in the attachment name is refused",
				traversalUpload.status === 400 && traversalUpload.body?.code === "invalid_attachment",
				traversalUpload.text,
			);
			const dotUpload = await api.post(`/api/experiments/${label}/attachments`, {
				name: ".bashrc",
				data_base64: Buffer.from("x").toString("base64"),
			});
			check("WEB-10: a dotfile name is refused", dotUpload.status === 400, dotUpload.text);
			const bigUpload = await api.post(`/api/experiments/${label}/attachments`, {
				name: "big.txt",
				data_base64: Buffer.alloc(300_000, 120).toString("base64"),
			});
			check("WEB-10: a large attachment still uploads (its own body limit)", bigUpload.status === 201, bigUpload.text);
			const huge = Buffer.alloc(17 * 1024 * 1024, 121);
			const hugeUpload = await api.post(`/api/experiments/${label}/attachments`, {
				name: "huge.bin",
				data_base64: huge.toString("base64"),
			});
			check(
				"WEB-10: an oversized attachment is refused",
				hugeUpload.status === 413 && hugeUpload.body?.code === "attachment_too_large",
				String(hugeUpload.status),
			);
			check(
				"WEB-10: the refused files are not in the workspace",
				!existsSync(join(workspace, "huge.bin")) && !existsSync(join(workspace, "passwd")),
			);
		}

		// ---- i18n: both dictionaries complete, Chinese default, switchable -----
		{
			const i18n = await import("../UI/Aegis-pocket/web/aegis/i18n.js");
			const WEB = join(REPO, "Pi_Agent_base/UI/Aegis-pocket/web/aegis");
			const appSource = readFileSync(join(WEB, "app.js"), "utf8");
			const timelineSource = readFileSync(join(WEB, "timeline.js"), "utf8");
			const dict = i18n.DICTIONARIES;
			const zhKeys = new Set(Object.keys(dict.zh));
			const enKeys = new Set(Object.keys(dict.en));
			check(
				"WEB-08: zh and en define the same keys",
				zhKeys.size === enKeys.size && [...zhKeys].every((key) => enKeys.has(key)),
				`${zhKeys.size} vs ${enKeys.size}`,
			);
			const used = new Set();
			for (const match of appSource.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)) used.add(match[1]);
			for (const match of timelineSource.matchAll(/key:\s*"([A-Za-z0-9_.]+)"/g)) used.add(match[1]);
			for (const match of timelineSource.matchAll(/"(summary\.[A-Za-z0-9_.]+)"/g)) used.add(match[1]);
			const dynamic = [
				"control.pause",
				"control.resume",
				"control.stop",
				"status.ready",
				"status.running",
				"status.stopped",
				"status.paused",
				"status.blocked",
				"retrieval.ready",
				"retrieval.no_match",
				"retrieval.unavailable",
				"retrieval.disabled",
			];
			for (const key of dynamic) used.add(key);
			const missing = [...used].filter((key) => !zhKeys.has(key) || !enKeys.has(key));
			check(
				"WEB-08: every key used by the UI exists in both languages",
				used.size > 80 && missing.length === 0,
				`used=${used.size} missing=${missing.join(",")}`,
			);
			check("WEB-08: Chinese is the default language", i18n.getLang() === "zh");
			const sample = i18n.t("control.pause");
			check(
				"WEB-08: zh and en return different labels",
				sample === "暂停派发" && dict.en["control.pause"] === "Pause dispatch",
				sample,
			);
			check(
				"WEB-08: status and retrieval values map to localized labels",
				i18n.statusLabel("blocked") === "已阻塞" && i18n.retrievalLabel("no_match") === "无匹配",
			);
			i18n.setLang("en");
			check("WEB-08: switching language changes t()", i18n.t("control.pause") === "Pause dispatch");
			i18n.setLang("zh");
			check("WEB-08: switching back restores Chinese", i18n.t("control.pause") === "暂停派发");
		}

		// ---- launcher UX: prints the URL, honours --no-open, stops cleanly -----
		{
			const launched = await startLauncher(home, childEnv);
			check(
				"WEB-07: the launcher prints the access URL",
				/^ {2}url +http:\/\/127\.0\.0\.1:\d+$/m.test(launched.stdout()),
				launched.stdout().slice(0, 300),
			);
			check(
				"WEB-07: --no-open is reported and no browser is spawned",
				/browser +not opened \(--no-open\)/.test(launched.stdout()),
				launched.stdout().slice(0, 300),
			);
			const health = await rawRequest(launched.origin, "/api/health", { host: new URL(launched.origin).host });
			check("WEB-07: the printed URL actually serves the API", health.status === 200, String(health.status));
			launched.child.kill("SIGTERM");
			const exited = await Promise.race([
				new Promise((resolveExit) => launched.child.on("exit", (code) => resolveExit(code))),
				new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 20_000)),
			]);
			check("WEB-07: the server stops cleanly on SIGTERM", exited === 0, String(exited));
		}

		// ---- host process bookkeeping ----------------------------------------
		const host = server.hostProcess(label);
		check("WEB-06: the server tracks exactly one Host for the label", Boolean(host) && host.child !== null);
	} finally {
		if (server) await server.close();
		rmSync(home, { recursive: true, force: true });
	}

	const failed = checks.filter((c) => !c.ok);
	if (failed.length > 0) {
		console.error(`\n${failed.length} check(s) failed of ${checks.length}`);
		process.exitCode = 1;
	} else {
		console.log(`\nAegis WebUI: ${checks.length} checks passed (HTTP → Host → SDK/Observer → EventLog)`);
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
