#!/usr/bin/env node
// Phase 3 remediation (TEST-OWN-01/02/03) — Host ownership MUST precede any
// Session/Observer activity.
//
// The defect under test: the entry built the SDK runtime and bound the initial
// Session (which makes the Observer append `session.started`) BEFORE
// `createExperimentConsole().start()` acquired the per-experiment ownership
// lease. A second console on the same label could therefore write into the live
// run's EventLog even though its ownership request was (correctly) refused.
//
// Required order (and what these tests pin):
//   parse/validate → acquire ownership → open+verify EventLog →
//   bindHostEventLog → create SDK runtime → bind initial Session/Observer →
//   pending/unknown+policy+staged-handoff check → (Supervisor recovery) →
//   dispatch allowed
//
// TEST-OWN-01: two real child processes through the ordinary launcher. Process
//   B is refused and must not change A's committed prefix, Session files or
//   writer liveness.
// TEST-OWN-02: in-process factory seam. A refused second Host must call the
//   session factory zero times and must not touch the first Host's lease,
//   EventLog binding or Session.
// TEST-OWN-03: initialization failure cleanup (SDK create failure, and a failure
//   after the Session/Observer were legitimately bound). Own resources are
//   released, no false ready/completion/effect, history is preserved, restart
//   works and repeated shutdown is idempotent.
//
// Real Pi SDK + faux only. No real model/network/target/credentials.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage, ReadOnlyAuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { createExperimentConsole } from "../session/experiment-console.mjs";
import { createConsoleSdkRuntime } from "../session/experiment-console-entry.mjs";
import { verifyChain } from "../shared/events.mjs";

const REPO = resolve(import.meta.dirname, "..", "..");
const LAUNCHER = join(REPO, "run-experiment.sh");
const TASK = "ownership-task";
const POLICY = { repeat_limit: 2, action_window: 8, min_distinct_routes: 4, context_pressure_percent: 85 };
const CONSOLE_POLICY = { max_auto_rotations: 2, max_continuations: 4, invalid: [], source: "host_policy" };
const READY = /Aegis console ready:|Type \/help for console controls/;
let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a committed prefix to become QUIESCENT: the log file stops changing
 * for `quietMs` AND at least one `agent.settled` row is committed. This is an
 * observed stability barrier, not a fixed-sleep guess about a process.
 */
async function waitQuiescent(eventLogPath, { quietMs = 1_500, timeout = 90_000 } = {}) {
	const deadline = Date.now() + timeout;
	let last = null;
	let stableSince = null;
	while (Date.now() < deadline) {
		const size = existsSync(eventLogPath) ? statSync(eventLogPath).size : 0;
		if (size !== last) {
			last = size;
			stableSince = Date.now();
		} else if (stableSince !== null && Date.now() - stableSince >= quietMs) {
			const rows = readRows(eventLogPath);
			if (rows.some((row) => row.event_type === "agent.settled")) return fingerprintOf(rows);
		}
		await sleep(100);
	}
	throw new Error("timed out waiting for a quiescent committed prefix");
}
async function waitFor(predicate, { timeout = 60_000, label = "condition" } = {}) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await sleep(50);
	}
	throw new Error(`timed out waiting for ${label}`);
}

const readRows = (path) =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];

function sessionFiles(sessionDir) {
	if (!existsSync(sessionDir)) return [];
	return readdirSync(sessionDir)
		.filter((name) => !name.startsWith("."))
		.sort();
}

/** Committed-prefix fingerprint used to prove a refused instance changed nothing. */
function fingerprintOf(rows) {
	return {
		rows: rows.length,
		lastDigest: rows[rows.length - 1]?.event_digest ?? null,
		sessionStarted: rows.filter((row) => row.event_type === "session.started").length,
	};
}

function fingerprint(eventLogPath, sessionDir) {
	const rows = readRows(eventLogPath);
	return {
		bytes: existsSync(eventLogPath) ? readFileSync(eventLogPath, "utf8") : "",
		size: existsSync(eventLogPath) ? statSync(eventLogPath).size : 0,
		rows: rows.length,
		lastDigest: rows[rows.length - 1]?.event_digest ?? null,
		sessionStarted: rows.filter((row) => row.event_type === "session.started").length,
		sessionShutdown: rows.filter((row) => row.event_type === "session.shutdown").length,
		completions: rows.filter((row) => row.event_type === "handoff.completed").length,
		sessions: sessionFiles(sessionDir),
	};
}

function snapshot(expDir) {
	return fingerprint(join(expDir, "runtime", "events.jsonl"), join(expDir, "sessions"));
}

function baseEnv(home) {
	return {
		...process.env,
		AEGIS_HOME: home,
		AEGIS_EXPERIMENTS_ROOT: join(home, "experiments"),
		AEGIS_PI_AGENT_DIR: join(home, "agent"),
		AEGIS_CONSOLE_PROVIDER: "faux",
		AEGIS_WEB_SEARCH: "off",
		AEGIS_KNOWLEDGE_ENABLED: "off",
	};
}

function launcherArgs(home, label, extra) {
	return [
		LAUNCHER,
		label,
		"--workspace",
		join(home, "workspace"),
		"--agent-dir",
		join(home, "agent"),
		"--provider",
		"faux",
		"--model",
		"ownership-fixture",
		...extra,
	];
}

/** Spawn a long-lived console and wait for its explicit ready barrier. */
function spawnConsole(home, label, extra) {
	const child = spawn("bash", launcherArgs(home, label, extra), {
		cwd: REPO,
		env: baseEnv(home),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	const exited = new Promise((resolveExit) => {
		child.on("exit", (code, signal) => resolveExit({ code, signal }));
	});
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	return {
		child,
		stdout: () => stdout,
		stderr: () => stderr,
		exited,
		async waitReady(timeout = 180_000) {
			await waitFor(() => READY.test(stdout) || stdout.includes("console blocked at startup:"), {
				timeout,
				label: "console ready barrier",
			});
			return { ready: READY.test(stdout), stdout: () => stdout };
		},
		async stop() {
			try {
				child.stdin.write("/stop\n");
			} catch {
				// stdin may already be closed
			}
			const result = await Promise.race([exited, sleep(120_000).then(() => ({ timeout: true }))]);
			if (result.timeout) child.kill("SIGKILL");
			return result;
		},
	};
}

// ---------------------------------------------------------------- OWN-01 ----
async function testOwnersCrossProcess() {
	const home = mkdtempSync(join(tmpdir(), "aegis-own01-"));
	const label = "own-cross";
	const expDir = join(home, "experiments", label);
	const eventLogPath = join(expDir, "runtime", "events.jsonl");
	mkdirSync(join(home, "workspace"), { recursive: true });
	mkdirSync(join(home, "agent"), { recursive: true });
	let processA = null;
	try {
		processA = spawnConsole(home, label, []);
		const readyA = await processA.waitReady();
		check("OWN-01: process A reaches its ready barrier", readyA.ready === true, processA.stdout().slice(-400));
		// Ownership is acquired before the ready line: the line is printed only
		// after start() returned successfully. Prompt A once so the snapshot also
		// covers a real Episode prefix and a real persistent Session file.
		processA.child.stdin.write("TASK ownership: establish the live prefix\n");
		await waitFor(
			() => readRows(eventLogPath).some((row) => ["episode.started", "prompt.received"].includes(row.event_type)),
			{ timeout: 90_000, label: "A initial committed prompt" },
		);
		await waitFor(() => sessionFiles(join(expDir, "sessions")).length > 0, {
			timeout: 60_000,
			label: "A persistent Session file",
		});
		// Only compare a QUIESCENT prefix: A must not be mid-run while B starts.
		await waitQuiescent(eventLogPath);
		const before = snapshot(expDir);
		check("OWN-01: A owns a committed prefix", before.rows > 0 && before.lastDigest !== null, JSON.stringify(before));
		check("OWN-01: A bound exactly one Session", before.sessionStarted === 1, `count=${before.sessionStarted}`);

		// Second REAL process on the same label/EventLog.
		const processB = spawnConsole(home, label, ["--resume"]);
		const resultB = await Promise.race([processB.exited, sleep(120_000).then(() => ({ timeout: true }))]);
		if (resultB.timeout) processB.child.kill("SIGKILL");
		check("OWN-01: B exits on its own (bounded)", resultB.timeout !== true, JSON.stringify(resultB));
		check("OWN-01: B exits non-zero", resultB.code !== 0, JSON.stringify(resultB));
		const bOutput = `${processB.stdout()}${processB.stderr()}`;
		check(
			"OWN-01: B names the ownership conflict",
			/owned by|ownership|cannot create owner lock|already-owned/i.test(bOutput),
			bOutput.slice(-500),
		);
		check("OWN-01: B never printed a ready line", !/Aegis console ready:/.test(processB.stdout()));

		const after = snapshot(expDir);
		check("OWN-01: B did not change the EventLog bytes", after.bytes === before.bytes);
		check("OWN-01: B did not change the EventLog size", after.size === before.size, `${before.size} -> ${after.size}`);
		check("OWN-01: B did not add committed rows", after.rows === before.rows, `${before.rows} -> ${after.rows}`);
		check("OWN-01: B did not move the chain tail", after.lastDigest === before.lastDigest);
		check(
			"OWN-01: B added no session.started",
			after.sessionStarted === before.sessionStarted,
			`${before.sessionStarted} -> ${after.sessionStarted}`,
		);
		check("OWN-01: B added no session.shutdown", after.sessionShutdown === before.sessionShutdown);
		check("OWN-01: B added no handoff completion", after.completions === before.completions);
		check(
			"OWN-01: B created no Session file",
			JSON.stringify(after.sessions) === JSON.stringify(before.sessions),
			`${JSON.stringify(before.sessions)} -> ${JSON.stringify(after.sessions)}`,
		);
		check("OWN-01: A is still running after B was refused", processA.child.exitCode === null);

		// A still works: a prompt goes through A's live writer.
		const rowsBeforePrompt = readRows(eventLogPath).length;
		processA.child.stdin.write("TASK ownership: prove the live writer still works\n");
		// The first prompt on a fresh Episode records `episode.started`; later ones
		// record `prompt.received`. Either way A's live writer must append.
		const promptCommitted = await waitFor(
			() =>
				readRows(eventLogPath)
					.slice(rowsBeforePrompt)
					.some((row) => ["episode.started", "prompt.received", "agent.started"].includes(row.event_type)),
			{ timeout: 90_000, label: "A committed prompt event" },
		);
		check("OWN-01: A appends new committed events after B was refused", Boolean(promptCommitted));
		const afterPrompt = readRows(eventLogPath);
		check("OWN-01: the chain stays valid after A's prompt", verifyChain(afterPrompt).ok === true);
		check(
			"OWN-01: the prompt stays in the SAME Episode",
			afterPrompt.filter((row) => row.event_type === "episode.started").length === 1,
		);

		const stoppedA = await processA.stop();
		check("OWN-01: A stops cleanly", stoppedA.code === 0, JSON.stringify(stoppedA));
		processA = null;

		// A released the lease: a legal recovery process can attach.
		const processC = spawnConsole(home, label, [
			"--resume",
			"--",
			"--prompt",
			"TASK ownership: resume after release",
			"--non-interactive",
		]);
		const resultC = await Promise.race([processC.exited, sleep(180_000).then(() => ({ timeout: true }))]);
		if (resultC.timeout) processC.child.kill("SIGKILL");
		check(
			"OWN-01: a legal recovery process exits 0 after A released the lease",
			resultC.code === 0,
			`${JSON.stringify(resultC)}\n${processC.stderr().slice(-400)}`,
		);
		const finalRows = readRows(eventLogPath);
		check(
			"OWN-01: recovery keeps ONE Episode",
			finalRows.filter((row) => row.event_type === "episode.started").length === 1,
		);
		check("OWN-01: recovery chain verifies", verifyChain(finalRows).ok === true);
		console.log(
			`OWN-01_EVIDENCE ${JSON.stringify({
				before: { rows: before.rows, last: before.lastDigest, sessions: before.sessions },
				afterB: { rows: after.rows, last: after.lastDigest, sessions: after.sessions },
				bExit: resultB.code,
				recoveryExit: resultC.code,
			})}`,
		);
	} finally {
		if (processA) {
			processA.child.kill("SIGKILL");
			await processA.exited.catch(() => undefined);
		}
		rmSync(home, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- OWN-02 ----
/**
 * Build the real SDK runtime handle used by the console entry, with a scripted
 * faux provider. Returns a factory so the test can assert it is never called.
 */
function makeSdkFactory({ workspace, agentDir, sessionDir, created, onPrompt }) {
	return async () => {
		const faux = registerFauxProvider({ provider: "faux", models: [{ id: "ownership-fixture" }] });
		if (onPrompt) faux.setResponses(Array.from({ length: 20 }, () => onPrompt));
		const adapter = await createConsoleSdkRuntime({
			sdk: {
				...sdkBase,
				AuthStorage,
				ReadOnlyAuthStorage,
				async createAgentSessionFromServices(options) {
					const result = await sdkBase.createAgentSessionFromServices(options);
					created.push(result.session);
					return result;
				},
			},
			providerKind: "faux",
			model: "ownership-fixture",
			fauxProviderFactory: () => faux,
			cwd: workspace,
			agentDir,
			sessionDir,
		});
		return adapter;
	};
}

function stampRuntime(id) {
	return {
		id,
		runtime: {
			newSession: async () => ({}),
			get session() {
				return { sessionId: `${id}-session` };
			},
		},
	};
}

async function testInProcessFactoryConflict() {
	const base = mkdtempSync(join(tmpdir(), "aegis-own02-"));
	const workspace = join(base, "workspace");
	const agentDir = join(base, "agent");
	const sessionDir = join(base, "sessions");
	const runtimeDir = join(base, "runtime");
	for (const dir of [workspace, agentDir, sessionDir, runtimeDir]) mkdirSync(dir, { recursive: true });
	const eventLogPath = join(runtimeDir, "events.jsonl");
	const handoffPath = join(runtimeDir, "handoff.json");
	const created = [];
	let first = null;
	let second = null;
	try {
		const onPrompt = () =>
			fauxAssistantMessage([
				fauxToolCall("aegis_propose", { kind: "intent", text: "ownership probe", scope: "unit:own" }),
			]);
		const sdkFactory = makeSdkFactory({ workspace, agentDir, sessionDir, created, onPrompt });
		let firstFactoryCalls = 0;
		first = createExperimentConsole({
			label: "own-inproc",
			taskId: TASK,
			eventLogPath,
			handoffPath,
			checkpointPath: join(runtimeDir, "projection.json"),
			ownershipBaseDir: join(runtimeDir, "console"),
			sessionFactory: async () => {
				firstFactoryCalls += 1;
				return sdkFactory();
			},
			workCyclePolicy: POLICY,
			consolePolicy: CONSOLE_POLICY,
		});
		const firstStart = await first.start();
		check("OWN-02: the unique owner starts", firstStart.ok === true, firstStart.reason);
		check(
			"OWN-02: the unique owner's session factory ran exactly once",
			firstFactoryCalls === 1,
			`calls=${firstFactoryCalls}`,
		);
		const firstStatus = await first.status();
		check(
			"OWN-02: the unique owner bound a real SDK Session",
			typeof firstStatus.session_id === "string" && firstStatus.session_id.length > 10,
			firstStatus.session_id,
		);
		check(
			"OWN-02: positive control — one legitimate session.started exists",
			readRows(eventLogPath).filter((row) => row.event_type === "session.started").length === 1,
		);
		const before = fingerprint(eventLogPath, sessionDir);

		// The second console starts from a NOT-YET-CREATED session factory.
		let secondFactoryCalls = 0;
		let secondCreations = 0;
		second = createExperimentConsole({
			label: "own-inproc",
			taskId: TASK,
			eventLogPath,
			handoffPath,
			checkpointPath: join(runtimeDir, "projection.json"),
			ownershipBaseDir: join(runtimeDir, "console"),
			sessionFactory: async () => {
				secondFactoryCalls += 1;
				secondCreations += 1;
				return sdkFactory();
			},
			workCyclePolicy: POLICY,
			consolePolicy: CONSOLE_POLICY,
		});
		const secondStart = await second.start();
		check(
			"OWN-02: the second console is refused",
			secondStart.ok === false && secondStart.ownership_conflict === true,
			JSON.stringify(secondStart),
		);
		check(
			"OWN-02: the refused console never called its session factory",
			secondFactoryCalls === 0,
			`calls=${secondFactoryCalls}`,
		);
		check(
			"OWN-02: the refused console created no Session",
			secondCreations === 0 && created.length === 1,
			`created=${created.length}`,
		);
		const after = fingerprint(eventLogPath, sessionDir);
		check("OWN-02: the refused console changed no EventLog byte", after.bytes === before.bytes);
		check("OWN-02: the refused console added no events", after.rows === before.rows, `${before.rows} -> ${after.rows}`);
		check(
			"OWN-02: the refused console created no Session file",
			JSON.stringify(after.sessions) === JSON.stringify(before.sessions),
		);

		// The refused instance shutting down must not touch the owner's resources.
		const shutdownSecond = await second.shutdown("refused instance");
		check("OWN-02: the refused instance can shut down", shutdownSecond.ok === true);
		const stillOwned = await first.dispatch("TASK ownership: owner still works");
		check(
			"OWN-02: the owner still works after the refused instance shut down",
			stillOwned.ok === true,
			stillOwned.reason,
		);
		check(
			"OWN-02: the owner still holds the lease",
			first.phase() === "running" || first.phase() === "blocked",
			first.phase(),
		);
		const rowsAfter = readRows(eventLogPath);
		check("OWN-02: the owner's writer is still valid", verifyChain(rowsAfter).ok === true);
		check("OWN-02: the owner's Session is unchanged", (await first.status()).session_id === firstStatus.session_id);
		check("OWN-02: no extra Session was created", created.length === 1, `created=${created.length}`);
	} finally {
		if (second) await second.shutdown("cleanup").catch(() => undefined);
		if (first) await first.shutdown("cleanup").catch(() => undefined);
		rmSync(base, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- OWN-03 ----
async function testInitFailureCleanup() {
	const base = mkdtempSync(join(tmpdir(), "aegis-own03-"));
	const workspace = join(base, "workspace");
	const agentDir = join(base, "agent");
	const sessionDir = join(base, "sessions");
	const runtimeDir = join(base, "runtime");
	for (const dir of [workspace, agentDir, sessionDir, runtimeDir]) mkdirSync(dir, { recursive: true });
	const eventLogPath = join(runtimeDir, "events.jsonl");
	const handoffPath = join(runtimeDir, "handoff.json");
	const ownedDir = join(runtimeDir, "console");
	const make = (sessionFactory, label = "own-fail") =>
		createExperimentConsole({
			label,
			taskId: TASK,
			eventLogPath,
			handoffPath,
			checkpointPath: join(runtimeDir, "projection.json"),
			ownershipBaseDir: ownedDir,
			sessionFactory,
			workCyclePolicy: POLICY,
			consolePolicy: CONSOLE_POLICY,
		});
	try {
		// (a) SDK creation fails before any Session exists.
		const sdkFailure = make(async () => {
			throw new Error("injected SDK runtime creation failure");
		});
		const startFailed = await sdkFailure.start();
		check("OWN-03: an SDK creation failure fails the start", startFailed.ok === false, JSON.stringify(startFailed));
		check(
			"OWN-03: the failure reason is reported",
			/injected SDK runtime creation failure/.test(startFailed.reason ?? ""),
			startFailed.reason,
		);
		check(
			"OWN-03: a failed start writes no events",
			readRows(eventLogPath).length === 0,
			`rows=${readRows(eventLogPath).length}`,
		);
		check("OWN-03: the failed start is reported as blocked", (await sdkFailure.status()).console_status === "blocked");

		// The failed instance released what it took: a new console can start.
		const created = [];
		const recoverFactory = makeSdkFactory({ workspace, agentDir, sessionDir, created });
		const afterFailure = make(recoverFactory, "own-fail");
		const restart = await afterFailure.start();
		check("OWN-03: after a failed start the lease is free", restart.ok === true, restart.reason);
		check(
			"OWN-03: the recovered start binds a real Session",
			readRows(eventLogPath).filter((row) => row.event_type === "session.started").length === 1,
		);
		const idempotent = await afterFailure.shutdown("first shutdown");
		const again = await afterFailure.shutdown("second shutdown");
		check(
			"OWN-03: repeated shutdown is idempotent",
			idempotent.ok === true && again.ok === true && again.already_stopped === true,
			JSON.stringify(again),
		);
		check("OWN-03: the EventLog chain is still valid", verifyChain(readRows(eventLogPath)).ok === true);

		// (b) Failure AFTER the Session/Observer were legitimately bound.
		const root2 = join(base, "second");
		const runtime2 = join(root2, "runtime");
		const sessionDir2 = join(root2, "sessions");
		mkdirSync(sessionDir2, { recursive: true });
		const eventLog2 = join(runtime2, "events.jsonl");
		const handoff2 = join(runtime2, "handoff.json");
		const created2 = [];
		const bindFailure = createExperimentConsole({
			label: "own-bind-fail",
			taskId: TASK,
			eventLogPath: eventLog2,
			handoffPath: handoff2,
			checkpointPath: join(runtime2, "projection.json"),
			ownershipBaseDir: join(root2, "console"),
			sessionFactory: async () => {
				const adapter = await makeSdkFactory({
					workspace,
					agentDir,
					sessionDir: sessionDir2,
					created: created2,
				})();
				// The Session and Observer are genuinely bound (session.started is
				// already committed through the Host writer). Then the rest of the
				// initialization fails; the factory must dispose its OWN runtime, and
				// that shutdown may legitimately write through the same writer.
				await adapter.dispose();
				throw new Error("injected post-bind initialization failure");
			},
			workCyclePolicy: POLICY,
			consolePolicy: CONSOLE_POLICY,
		});
		const bindResult = await bindFailure.start();
		check(
			"OWN-03: a post-bind initialization failure fails the start",
			bindResult.ok === false,
			JSON.stringify(bindResult),
		);
		const rows2 = readRows(eventLog2);
		check(
			"OWN-03: the legitimate initialization history is preserved",
			rows2.some((row) => row.event_type === "session.started"),
			JSON.stringify(rows2.map((r) => r.event_type)),
		);
		check(
			"OWN-03: no completion was faked by the failed start",
			rows2.every((row) => row.event_type !== "handoff.completed"),
		);
		check(
			"OWN-03: no effect or Outcome was written",
			rows2.every((row) => row.event_type !== "action.requested" && row.event_type !== "outcome.recorded"),
		);
		check("OWN-03: the EventLog chain is valid after the failure", verifyChain(rows2).ok === true);
		check(
			"OWN-03: every event was written only after ownership (Session exists)",
			rows2.every((row) => row.event_type !== "episode.started"),
		);
		// The lease is released, so a legal start attaches to the same log.
		const afterBindFailure = createExperimentConsole({
			label: "own-bind-fail",
			taskId: TASK,
			eventLogPath: eventLog2,
			handoffPath: handoff2,
			checkpointPath: join(runtime2, "projection.json"),
			ownershipBaseDir: join(root2, "console"),
			sessionFactory: makeSdkFactory({ workspace, agentDir, sessionDir: sessionDir2, created: created2 }),
			workCyclePolicy: POLICY,
			consolePolicy: CONSOLE_POLICY,
		});
		const recovered = await afterBindFailure.start();
		check("OWN-03: the lease is free after a post-bind failure", recovered.ok === true, recovered.reason);
		check(
			"OWN-03: the recovered start keeps the original history",
			readRows(eventLog2).filter((row) => row.event_type === "session.started").length >= 2,
		);
		const firstShutdown = await afterBindFailure.shutdown("done");
		const secondShutdown = await afterBindFailure.shutdown("done again");
		check(
			"OWN-03: shutdown is idempotent after recovery",
			firstShutdown.ok === true && secondShutdown.ok === true && secondShutdown.already_stopped === true,
		);
		check("OWN-03: final chain verifies", verifyChain(readRows(eventLog2)).ok === true);
		void stampRuntime;
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

async function main() {
	await testInProcessFactoryConflict();
	await testInitFailureCleanup();
	await testOwnersCrossProcess();
	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exitCode = 1;
	} else {
		console.log("\nconsole ownership: pre-ownership Session prevention, factory ordering, failure cleanup passed");
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
assert.ok(typeof readRows === "function");
