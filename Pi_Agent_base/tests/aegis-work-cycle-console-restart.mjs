#!/usr/bin/env node
// Phase 3 (HC-12/13/15) — console process lifecycle, ownership, recovery, budget.
//
// A Host-lifecycle fixture (the real-SDK Session path is covered by
// `aegis-work-cycle-console-sdk.mjs` and by the existing
// `aegis-work-cycle-zero-budget-recovery.mjs`). Here the "Session" is a small
// adapter that writes the SAME post-bind event contract the real Observer
// writes, so the console's recovery/ownership/bounded-stop logic is exercised
// against a real EventLog, the real SessionSupervisor and the real handoff
// attempt grant.
//
// Covered:
//   * one live owner per experiment label; a second console is refused;
//   * a pending/unpaired action blocks dispatch and rotation (no effect replay);
//   * an interrupted handoff with EXHAUSTED session budget keeps refusing, and
//     an initial Session that merely sees the staged file writes no completion;
//   * after the owner corrects the budget, the console recovers through the real
//     Supervisor exactly once (one completion, one Session generation);
//   * restart reuses the SAME Episode and does not rotate the same boundary twice;
//   * pause / terminal states never auto-resume or auto-rotate; a user prompt is
//     not permission.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExperimentConsole } from "../session/experiment-console.mjs";
import { consumeHandoffAttempt, handoffAttemptAuthorizes, readHandoffAttemptSync } from "../session/handoff-grant.mjs";
import { EventLog, eventId, verifyChain } from "../shared/events.mjs";

const POLICY = { repeat_limit: 2, action_window: 8, min_distinct_routes: 4, context_pressure_percent: 85 };
const TASK = "restart-task";
let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

const readRows = (path) =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];

async function nodeAppend(eventLogPath, row) {
	const log = new EventLog(eventLogPath);
	const opened = await log.open();
	if (!opened.ok) throw new Error(opened.error);
	const result = await log.append(row);
	await log.close();
	if (!result.ok) throw new Error(result.error);
	return result.event;
}

/**
 * Minimal Session adapter that mirrors the real Observer's post-bind completion
 * contract. The initial bind never completes a staged request (that is the R2
 * defect the Supervisor/attempt grant fixed).
 */
function createFixtureSession({ eventLogPath, handoffPath, onPrompt = null }) {
	let creations = 0;
	let current = "session-1";
	const files = new Map();
	files.set(current, `${eventLogPath}.session-1.jsonl`);
	const api = {
		sessionId: () => current,
		sessionFile: () => files.get(current) ?? null,
		creations: () => creations,
		prompt: async (text) => {
			if (onPrompt) await onPrompt({ sessionId: current, text, api });
		},
		waitForIdle: async () => undefined,
		dispose: async () => undefined,
		newSession: async ({ withSession } = {}) => {
			if (api.failNextCreate) {
				api.failNextCreate = false;
				throw new Error("injected create failure");
			}
			creations += 1;
			current = `session-${creations + 1}`;
			files.set(current, `${eventLogPath}.${current}.jsonl`);
			if (withSession) {
				await withSession({
					sendUserMessage: async (text) => {
						// Post-bind Observer behaviour: only a LIVE Host attempt authorizes
						// the single `handoff.completed`.
						let staged = null;
						try {
							staged = JSON.parse(readFileSync(handoffPath, "utf8"));
						} catch {
							staged = null;
						}
						if (!staged?.request_id) return;
						const attempt = readHandoffAttemptSync(handoffPath);
						const authority = handoffAttemptAuthorizes({ handoff: staged, attempt, sessionId: current });
						if (!authority.ok) return;
						await nodeAppend(eventLogPath, {
							event_type: "handoff.completed",
							episode_id: staged.episode_id,
							payload: {
								request_id: staged.request_id,
								to_session: current,
								from_session: attempt.from_session,
								attempt_id: attempt.attempt_id,
								episode_id: staged.episode_id,
								...(staged.work_cycle?.boundary_identity
									? { work_cycle_identity: staged.work_cycle.boundary_identity }
									: {}),
							},
						});
						await consumeHandoffAttempt(handoffPath);
						const { rename } = await import("node:fs/promises");
						await rename(handoffPath, `${handoffPath}.applied.json`).catch(() => undefined);
						// The continuation prompt then settles in the replacement Session.
						await nodeAppend(eventLogPath, {
							event_type: "agent.settled",
							episode_id: staged.episode_id,
							payload: { session_id: current, settle_reason: "continuation" },
						});
						void text;
					},
				});
			}
			return {};
		},
	};
	return api;
}

async function seedEpisode({ eventLogPath, taskId = TASK }) {
	const episodeId = eventId();
	await nodeAppend(eventLogPath, {
		event_type: "episode.started",
		episode_id: episodeId,
		payload: { task_id: taskId, goal: { description: "restart fixture" }, authorization: "read", budget: "unknown" },
	});
	await nodeAppend(eventLogPath, {
		event_type: "proposal.submitted",
		episode_id: episodeId,
		payload: { kind: "intent", text: "unit one", scope: "unit:one", source_refs: [] },
		source: { actor_id: "pi", kind: "llm", adapter: "fixture", version: "1" },
	});
	return episodeId;
}

async function seedSettledEffect({ eventLogPath, episodeId, sessionId = "session-1" }) {
	await nodeAppend(eventLogPath, {
		event_type: "action.requested",
		episode_id: episodeId,
		payload: { action_id: "a1", tool_name: "bash", arguments_digest: "sha256:x" },
	});
	await nodeAppend(eventLogPath, {
		event_type: "action.completed",
		episode_id: episodeId,
		payload: { action_id: "a1", tool_name: "bash", status: "ok", content_digest: "sha256:y" },
	});
	await nodeAppend(eventLogPath, {
		event_type: "agent.settled",
		episode_id: episodeId,
		payload: { session_id: sessionId, work_cycle_status: "clear" },
	});
}

/** Stage a handoff request directly (simulating a process that crashed after staging). */
async function stageRequest({ eventLogPath, handoffPath, episodeId, requestId, identity }) {
	const { stageHostHandoff } = await import("../session/handoff-stage.mjs");
	void episodeId;
	return stageHostHandoff({
		eventLogPath,
		handoffPath,
		taskId: TASK,
		reason: "interrupted recovery fixture",
		workCyclePolicy: POLICY,
		workCycleIdentity: identity,
		requestId,
	});
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-console-restart-"));
	try {
		// ---- 1. ownership: one live writer per label -------------------------
		{
			const root = join(base, "own");
			mkdirSync(root, { recursive: true });
			const eventLogPath = join(root, "events.jsonl");
			const handoffPath = join(root, "handoff.json");
			const episodeId = await seedEpisode({ eventLogPath });
			await seedSettledEffect({ eventLogPath, episodeId });
			const mk = () =>
				createExperimentConsole({
					label: "own-label",
					taskId: TASK,
					eventLogPath,
					handoffPath,
					checkpointPath: join(root, "projection.json"),
					ownershipBaseDir: join(root, "console"),
					session: createFixtureSession({ eventLogPath, handoffPath }),
					workCyclePolicy: POLICY,
					consolePolicy: { max_auto_rotations: 1, max_continuations: 3, invalid: [], source: "host_policy" },
				});
			const first = mk();
			const second = mk();
			const firstStart = await first.start();
			check("the first console owns the experiment", firstStart.ok === true, firstStart.reason);
			const secondStart = await second.start();
			check(
				"a second console on the same label is refused",
				secondStart.ok === false && secondStart.ownership_conflict === true,
				JSON.stringify(secondStart),
			);
			check("the refused console reports a blocked status", (await second.status()).console_status === "blocked");
			await first.shutdown("first console done");
			const third = mk();
			const thirdStart = await third.start();
			check("after release a console can attach again", thirdStart.ok === true, thirdStart.reason);
			const rows = readRows(eventLogPath);
			check(
				"re-attaching does not create a second Episode",
				rows.filter((row) => row.event_type === "episode.started").length === 1,
			);
			await third.shutdown("done");
			check("EventLog chain verifies after the ownership cycle", verifyChain(readRows(eventLogPath)).ok === true);
		}

		// ---- 2. pending / unpaired action blocks dispatch and rotation ------
		{
			const root = join(base, "pending");
			mkdirSync(root, { recursive: true });
			const eventLogPath = join(root, "events.jsonl");
			const handoffPath = join(root, "handoff.json");
			const episodeId = await seedEpisode({ eventLogPath });
			// Unpaired request: the real result is UNKNOWN.
			await nodeAppend(eventLogPath, {
				event_type: "action.requested",
				episode_id: episodeId,
				payload: { action_id: "unknown-1", tool_name: "bash", arguments_digest: "sha256:u" },
			});
			await nodeAppend(eventLogPath, {
				event_type: "agent.settled",
				episode_id: episodeId,
				payload: { session_id: "session-1" },
			});
			const host = createExperimentConsole({
				label: "pending-label",
				taskId: TASK,
				eventLogPath,
				handoffPath,
				checkpointPath: join(root, "projection.json"),
				ownershipBaseDir: join(root, "console"),
				session: createFixtureSession({ eventLogPath, handoffPath }),
				workCyclePolicy: POLICY,
				consolePolicy: { max_auto_rotations: 2, max_continuations: 3, invalid: [], source: "host_policy" },
			});
			const started = await host.start();
			check("an unpaired side effect blocks the console at startup", started.ok === false, started.reason);
			const dispatch = await host.dispatch("TASK: continue");
			check("dispatch is refused while the responsibility is open", dispatch.ok === false);
			const rows = readRows(eventLogPath);
			check(
				"no rotation and no completion were written",
				rows.filter((row) => row.event_type === "handoff.completed").length === 0,
			);
			check("no new Episode was created", rows.filter((row) => row.event_type === "episode.started").length === 1);
			await host.shutdown("done");
		}

		// ---- 3. exhausted budget -> refusal, corrected -> ONE recovery ------
		{
			const root = join(base, "budget");
			mkdirSync(root, { recursive: true });
			const eventLogPath = join(root, "events.jsonl");
			const handoffPath = join(root, "handoff.json");
			const episodeId = await seedEpisode({ eventLogPath });
			await seedSettledEffect({ eventLogPath, episodeId });
			const readRowsLocal = () => readRows(eventLogPath);
			const localSession = createFixtureSession({ eventLogPath, handoffPath });
			const staged = await stageRequest({
				eventLogPath,
				handoffPath,
				episodeId,
				requestId: "interrupted-req-1",
				identity: "context:session-1:1:2",
			});
			check("the interrupted handoff request is staged", staged.ok === true, staged.reason);

			// Exhausted session budget: the initial bind must NOT complete it.
			const exhausted = createExperimentConsole({
				label: "budget-label",
				taskId: TASK,
				eventLogPath,
				handoffPath,
				checkpointPath: join(root, "projection.json"),
				ownershipBaseDir: join(root, "console"),
				session: localSession,
				sessionBudget: { limit: { session_count: 0 }, consumed: {}, reserved: {} },
				workCyclePolicy: POLICY,
				consolePolicy: { max_auto_rotations: 2, max_continuations: 3, invalid: [], source: "host_policy" },
			});
			const exhaustedStart = await exhausted.start();
			check(
				"zero session budget refuses recovery",
				exhaustedStart.ok === false,
				JSON.stringify(exhaustedStart.recovery ?? exhaustedStart.reason),
			);
			const afterRefusal = readRowsLocal();
			check(
				"a refusal writes no completion",
				afterRefusal.filter((row) => row.event_type === "handoff.completed").length === 0,
			);
			check(
				"the refusal is reported as blocked with the budget reason",
				(await exhausted.status()).console_status === "blocked" &&
					/session budget is exhausted/.test((await exhausted.status()).block_reason ?? ""),
				(await exhausted.status()).block_reason,
			);
			check(
				"the initial bind did not complete the staged request",
				existsSync(handoffPath) && !existsSync(`${handoffPath}.applied.json`),
			);
			const refusedDispatch = await exhausted.dispatch("TASK: keep going");
			check("a user prompt does not clear the blocked state", refusedDispatch.ok === false);
			await exhausted.shutdown("refusal recorded");

			// Owner corrects the budget: recovery goes through the real Supervisor.
			const corrected = createExperimentConsole({
				label: "budget-label",
				taskId: TASK,
				eventLogPath,
				handoffPath,
				checkpointPath: join(root, "projection.json"),
				ownershipBaseDir: join(root, "console"),
				session: localSession,
				sessionBudget: { limit: { session_count: 4 }, consumed: {}, reserved: {} },
				workCyclePolicy: POLICY,
				consolePolicy: { max_auto_rotations: 2, max_continuations: 3, invalid: [], source: "host_policy" },
			});
			const correctedStart = await corrected.start();
			check(
				"corrected budget recovers the interrupted handoff",
				correctedStart.ok === true,
				JSON.stringify(correctedStart.recovery ?? correctedStart.reason),
			);
			const recoveredRows = readRowsLocal();
			const completions = recoveredRows.filter((row) => row.event_type === "handoff.completed");
			check("recovery wrote exactly one completion", completions.length === 1, `count=${completions.length}`);
			check("the completion names the real replacement Session", completions[0]?.payload?.to_session === "session-2");
			check("the completion names the real source Session", completions[0]?.payload?.from_session === "session-1");
			check(
				"the recovery created exactly one replacement",
				localSession.creations() === 1,
				`creations=${localSession.creations()}`,
			);
			check(
				"the staged request was retired only after the completion",
				existsSync(`${handoffPath}.applied.json`) && !existsSync(handoffPath),
			);
			check(
				"no Episode was created by the recovery",
				recoveredRows.filter((row) => row.event_type === "episode.started").length === 1,
			);
			const secondRecovery = await corrected.recover();
			check("a second recovery is a no-op", secondRecovery.ok === true && secondRecovery.action === "clean");
			check(
				"no duplicate completion appears",
				readRowsLocal().filter((row) => row.event_type === "handoff.completed").length === 1,
			);
			await corrected.shutdown("recovered");
			check("EventLog chain verifies after recovery", verifyChain(readRowsLocal()).ok === true);
		}

		// ---- 4. injected bind failure keeps the responsibility --------------
		{
			const root = join(base, "bindfail");
			mkdirSync(root, { recursive: true });
			const eventLogPath = join(root, "events.jsonl");
			const handoffPath = join(root, "handoff.json");
			const episodeId = await seedEpisode({ eventLogPath });
			await seedSettledEffect({ eventLogPath, episodeId });
			const session = createFixtureSession({ eventLogPath, handoffPath });
			const staged = await stageRequest({
				eventLogPath,
				handoffPath,
				episodeId,
				requestId: "interrupted-req-2",
				identity: "context:session-1:9:10",
			});
			check("the second interrupted request is staged", staged.ok === true);
			session.failNextCreate = true;
			const host = createExperimentConsole({
				label: "bindfail-label",
				taskId: TASK,
				eventLogPath,
				handoffPath,
				checkpointPath: join(root, "projection.json"),
				ownershipBaseDir: join(root, "console"),
				session,
				sessionBudget: { limit: { session_count: 4 }, consumed: {}, reserved: {} },
				workCyclePolicy: POLICY,
				consolePolicy: { max_auto_rotations: 2, max_continuations: 3, invalid: [], source: "host_policy" },
			});
			const started = await host.start();
			check("a failed create leaves the console blocked", started.ok === false, started.reason);
			check(
				"no completion was faked",
				readRows(eventLogPath).filter((row) => row.event_type === "handoff.completed").length === 0,
			);
			check("the staged request is preserved for recovery", existsSync(handoffPath));
			check("the attempt grant is cleared in finally", !existsSync(`${handoffPath}.attempt.json`));
			await host.shutdown("done");
		}

		// ---- 4b. a corrupt EventLog refuses the Host (no silent append) ------
		{
			const root = join(base, "corrupt");
			mkdirSync(root, { recursive: true });
			const eventLogPath = join(root, "events.jsonl");
			const handoffPath = join(root, "handoff.json");
			const episodeId = await seedEpisode({ eventLogPath });
			await seedSettledEffect({ eventLogPath, episodeId });
			writeFileSync(eventLogPath, `${readFileSync(eventLogPath, "utf8")}{"event_id":"tampered"}\n`);
			const host = createExperimentConsole({
				label: "corrupt-label",
				taskId: TASK,
				eventLogPath,
				handoffPath,
				checkpointPath: join(root, "projection.json"),
				ownershipBaseDir: join(root, "console"),
				session: createFixtureSession({ eventLogPath, handoffPath }),
				workCyclePolicy: POLICY,
				consolePolicy: { max_auto_rotations: 2, max_continuations: 3, invalid: [], source: "host_policy" },
			});
			const started = await host.start();
			check("a corrupt EventLog blocks the Host", started.ok === false, started.reason);
			check(
				"the blocked status names the chain problem",
				/corrupt|unparseable|chain/i.test((await host.status()).block_reason ?? ""),
				(await host.status()).block_reason,
			);
			const dispatch = await host.dispatch("TASK: continue");
			check("no dispatch happens on a corrupt log", dispatch.ok === false);
			check(
				"no events were appended to the corrupt log",
				!readFileSync(eventLogPath, "utf8").includes("handoff.completed"),
			);
			await host.shutdown("done");
		}

		// ---- 5. pause / terminal states never auto-resume -------------------
		{
			const root = join(base, "pause");
			mkdirSync(root, { recursive: true });
			const eventLogPath = join(root, "events.jsonl");
			const handoffPath = join(root, "handoff.json");
			const episodeId = await seedEpisode({ eventLogPath });
			await seedSettledEffect({ eventLogPath, episodeId });
			const host = createExperimentConsole({
				label: "pause-label",
				taskId: TASK,
				eventLogPath,
				handoffPath,
				checkpointPath: join(root, "projection.json"),
				ownershipBaseDir: join(root, "console"),
				session: createFixtureSession({ eventLogPath, handoffPath }),
				workCyclePolicy: POLICY,
				consolePolicy: { max_auto_rotations: 2, max_continuations: 3, invalid: [], source: "host_policy" },
			});
			await host.start();
			host.pause("operator pause");
			const paused = await host.dispatch("TASK: continue");
			check("a paused console refuses dispatch", paused.ok === false && /paused/.test(paused.reason), paused.reason);
			await host.resume();
			check("resume returns to running", host.phase() === "running");
			await host.shutdown("done");

			// Terminal Episode: close it and confirm no auto-continuation.
			await nodeAppend(eventLogPath, {
				event_type: "episode.closed",
				episode_id: episodeId,
				payload: { reason: "fixture terminal" },
			});
			const terminated = createExperimentConsole({
				label: "pause-label",
				taskId: TASK,
				eventLogPath,
				handoffPath,
				checkpointPath: join(root, "projection.json"),
				ownershipBaseDir: join(root, "console"),
				session: createFixtureSession({ eventLogPath, handoffPath }),
				workCyclePolicy: POLICY,
				consolePolicy: { max_auto_rotations: 2, max_continuations: 3, invalid: [], source: "host_policy" },
			});
			const started = await terminated.start();
			const terminalDispatch = await terminated.dispatch("TASK: continue anyway");
			check("a closed Episode is not auto-resumed", terminalDispatch.ok === false, terminalDispatch.reason);
			void started;
			check(
				"no rotation happened for a terminal Episode",
				readRows(eventLogPath).filter((row) => row.event_type === "handoff.completed").length === 0,
			);
			await terminated.shutdown("done");
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exitCode = 1;
	} else {
		console.log(
			"\nconsole lifecycle: ownership, pending block, budget refusal/recovery, bind failure, pause/terminal passed",
		);
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
