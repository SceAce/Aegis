#!/usr/bin/env node
// Limited C2 external checks: durable budget gating and verified completion.
// These tests use real EventLog plus explicit synthetic runtime boundary doubles.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSessionSupervisor } from "../session/session-supervisor.mjs";
import { EventLog } from "../shared/events.mjs";

async function fixture(t, { recordCompletion = true, previousSessions = 1 } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "aegis-c2-external-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const eventLogPath = join(dir, "events.jsonl");
	const handoffPath = join(dir, "handoff.json");
	const episodeId = "episode-c2-external";
	const taskId = "task-c2-external";
	const source = { kind: "runtime", actor_id: "external-host", adapter: "synthetic-runtime", version: "1" };
	async function append(event) {
		const log = new EventLog(eventLogPath);
		try {
			assert.equal((await log.open()).ok, true);
			assert.equal((await log.append({ ...event, episode_id: episodeId, source })).ok, true);
		} finally {
			await log.close();
		}
	}
	await append({
		event_type: "episode.started",
		payload: { task_id: taskId, goal: { description: "rotate safely" }, authorization: { workspace: dir } },
	});
	const budget = { limit: { session_count: previousSessions + 1 }, consumed: { session_count: previousSessions } };
	let calls = 0;
	const runtime = {
		session: { sessionId: "session-initial" },
		async newSession() {
			calls += 1;
			runtime.session = { sessionId: `session-${calls}` };
			if (recordCompletion) {
				const staged = JSON.parse(await readFile(handoffPath, "utf8"));
				// The replacement consumes the Host attempt that is live during this
				// newSession call (never a bare staged file).
				const attempt = JSON.parse(await readFile(`${handoffPath}.attempt.json`, "utf8"));
				await append({
					event_type: "handoff.completed",
					payload: {
						request_id: staged.request_id,
						to_session: runtime.session.sessionId,
						from_session: attempt.from_session,
						attempt_id: attempt.attempt_id,
						episode_id: episodeId,
					},
				});
			}
			return { cancelled: false };
		},
	};
	async function stage(requestId) {
		await writeFile(
			handoffPath,
			JSON.stringify({ request_id: requestId, episode_id: episodeId, task_id: taskId, reason: "external rotation" }),
		);
	}
	function supervisor() {
		return createSessionSupervisor({ eventLogPath, handoffPath, runtime, taskId, budget });
	}
	return { stage, supervisor, calls: () => calls, budget };
}

test("CONTROL: a funded rotation with committed completion succeeds and replay does not replace again", async (t) => {
	const f = await fixture(t);
	await f.stage("request-1");
	const first = await f.supervisor().rotate({ requestId: "request-1" });
	assert.equal(first.applied, true);
	assert.equal(first.budget_after.consumed.session_count, 2);
	const replay = await f.supervisor().rotate({ requestId: "request-1" });
	assert.equal(replay.reused, true);
	assert.equal(f.calls(), 1);
});

test("C2-E1: committed rotation exhausts the budget before a second distinct request", async (t) => {
	const f = await fixture(t);
	await f.stage("request-1");
	const first = await f.supervisor().rotate();
	assert.equal(first.applied, true);
	assert.equal(first.budget_after.remaining.session_count, 0);
	await f.stage("request-2");
	// Recreate the supervisor, as on Host resume. Durable completion must be used
	// by the gate, rather than trusting an unchanged input ledger or return value.
	const next = await f.supervisor().rotate();
	assert.equal(next.applied, false, "the committed first rotation consumed the last allowed Session");
	assert.equal(f.calls(), 1, "budget refusal must precede newSession");
});

test("C2-E1: pre-existing cumulative usage increments once even when greater than this episode's generation", async (t) => {
	const f = await fixture(t, { previousSessions: 7 });
	await f.stage("request-1");
	const first = await f.supervisor().rotate();
	assert.equal(first.applied, true);
	assert.equal(
		first.budget_after.consumed.session_count,
		8,
		"max(old usage, local generation) must not erase the new charge",
	);
});

test("C2-E2: SDK return without committed binding/completion is not verified rotation success", async (t) => {
	const f = await fixture(t, { recordCompletion: false });
	await f.stage("request-1");
	const rotated = await f.supervisor().rotate();
	assert.equal(f.calls(), 1, "the SDK boundary was reached");
	assert.equal(rotated.applied, false, "no committed handoff completion exists to verify the new binding");
});
