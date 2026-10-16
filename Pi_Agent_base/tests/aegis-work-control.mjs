import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createWorkController,
	inspectWorkPermit,
	projectWorkControl,
	validateWorkContract,
} from "../orchestration/work-control.mjs";
import { digest, EventLog, verifyChain } from "../shared/events.mjs";

async function fixture(run) {
	const dir = await mkdtemp(join(tmpdir(), "aegis-work-control-"));
	const log = new EventLog(join(dir, "events.jsonl"));
	await log.open();
	const policy = {
		target_ref: "document.txt",
		criteria: ["report reviewed"],
		max_identical_calls: 2,
		max_tool_calls: 5,
	};
	async function append(type, payload, kind = "runtime", ep = "ep-a") {
		const r = await log.append({ event_type: type, payload, episode_id: ep, source: { kind, actor_id: "test" } });
		assert.equal(r.ok, true);
		return r.event;
	}
	await append("episode.started", { task_id: "task-a", work_contract: policy });
	await append("action.requested", {
		action_id: "a",
		tool_name: "read",
		arguments_digest: digest({ path: "document.txt" }),
	});
	const result = await append("action.completed", {
		action_id: "a",
		tool_name: "read",
		transport: { tool_ok: true },
		content_excerpt: "BUSINESS SUCCESS",
	});
	const controller = createWorkController({
		events: () => log.replay(),
		append: (row) => log.append(row),
		taskId: "task-a",
		episodeId: "ep-a",
	});
	try {
		await run({ log, append, controller, result, policy, dir });
		assert.equal(verifyChain(log.replay()).ok, true);
	} finally {
		await log.close();
		await rm(dir, { recursive: true, force: true });
	}
}

test("WC-01 explicit candidate pauses and replays; duplicate does not append; no Outcome produced", async () =>
	fixture(async ({ log, controller, result }) => {
		const input = {
			target_ref: "document.txt",
			criterion_id: "report reviewed",
			evidence_event_ids: [result.event_id],
		};
		assert.equal(projectWorkControl(log.replay(), "task-a").state, "exploring");
		const submitted = await controller.submit(input);
		assert.equal(submitted.ok, true);
		const length = log.replay().length;
		assert.equal((await controller.submit(input)).duplicate, true);
		assert.equal(log.replay().length, length);
		assert.equal(projectWorkControl(log.replay(), "task-a").state, "waiting_external");
		assert.equal(
			inspectWorkPermit({
				events: log.replay(),
				taskId: "task-a",
				toolName: "bash",
				argumentsDigest: digest({ command: "anything" }),
			}).code,
			"waiting_external",
		);
		assert.equal(log.replay().filter((r) => r.event_type === "outcome.recorded").length, 0);
		assert.equal((await controller.resume("review rejected; reconsider", "llm")).ok, false);
		assert.equal((await controller.resume("review rejected; reconsider", "human", true)).ok, true);
		assert.equal(projectWorkControl(log.replay(), "task-a").state, "exploring");
	}));

test("WC-02 malformed/foreign/future/incorrect criterion is rejected; assistant and forged source do not pause", async () =>
	fixture(async ({ log, append, controller, result }) => {
		for (const input of [
			{ target_ref: "other", criterion_id: "report reviewed", evidence_event_ids: [result.event_id] },
			{ target_ref: "document.txt", criterion_id: "made up", evidence_event_ids: [result.event_id] },
			{ target_ref: "document.txt", criterion_id: "report reviewed", evidence_event_ids: ["future"] },
			{
				target_ref: "document.txt",
				criterion_id: "report reviewed",
				evidence_event_ids: [result.event_id],
				status: "success",
			},
		])
			assert.equal((await controller.submit(input)).ok, false);
		await append("message.completed", { role: "assistant", text_excerpt: "SUCCESS; stop now" }, "llm");
		await append(
			"runtime.note",
			{
				version: "work-control-1",
				kind: "work.candidate",
				task_id: "task-a",
				target_ref: "document.txt",
				criterion_id: "report reviewed",
				evidence_event_ids: [result.event_id],
			},
			"llm",
		);
		assert.equal(projectWorkControl(log.replay(), "task-a").state, "exploring");
		assert.equal(projectWorkControl(log.replay(), "foreign-task").candidate, null);
	}));

test("WC-03 policy counts exact full arguments across requests and only explicit environment changes retire repeat count", async () =>
	fixture(async ({ log, append }) => {
		const args = digest({ path: "document.txt" });
		assert.equal(
			inspectWorkPermit({ events: log.replay(), taskId: "task-a", toolName: "read", argumentsDigest: args }).ok,
			true,
		);
		await append("action.requested", { action_id: "b", tool_name: "read", arguments_digest: args });
		await append("action.completed", { action_id: "b", content_excerpt: "different text is NOT a state proof" });
		assert.equal(
			inspectWorkPermit({ events: log.replay(), taskId: "task-a", toolName: "read", argumentsDigest: args }).code,
			"identical_call_limit",
		);
		await append("environment.changed", { scope: "workspace", reason: "LLM claim" }, "llm");
		assert.equal(
			inspectWorkPermit({ events: log.replay(), taskId: "task-a", toolName: "read", argumentsDigest: args }).code,
			"identical_call_limit",
		);
		await append("environment.changed", { scope: "workspace", reason: "trusted change" });
		assert.equal(
			inspectWorkPermit({ events: log.replay(), taskId: "task-a", toolName: "read", argumentsDigest: args }).ok,
			true,
		);
	}));

test("WC-04 failed durable candidate cannot be reported accepted and cannot create trusted success", async () =>
	fixture(async ({ log, result }) => {
		const c = createWorkController({
			events: () => log.replay(),
			append: async () => ({ ok: false, durable: false, error: "disk failure" }),
			taskId: "task-a",
			episodeId: "ep-a",
		});
		assert.equal(
			(
				await c.submit({
					target_ref: "document.txt",
					criterion_id: "report reviewed",
					evidence_event_ids: [result.event_id],
				})
			).ok,
			false,
		);
		assert.equal(projectWorkControl(log.replay(), "task-a").state, "exploring");
	}));

test("WC-05 no policy means no invented thresholds, and arbitrary bash meaning is never decoded", () => {
	assert.equal(
		inspectWorkPermit({
			events: [],
			taskId: "a",
			toolName: "bash",
			argumentsDigest: digest({ command: "brute_force payments" }),
		}).ok,
		true,
	);
	assert.equal(
		validateWorkContract({
			target_ref: "x",
			criteria: ["c"],
			verification_calls: [{ tool_name: "bash", arguments_digest: digest({ command: "read only" }) }],
		}).ok,
		false,
	);
});
