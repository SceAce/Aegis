#!/usr/bin/env node
// Bounded external C6 engineering review. Failing cases are current blockers,
// not an efficacy experiment. Real SDK uses faux; effects only in temp dirs.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createToolLedger } from "../campaign/c6-tool-ledger.mjs";
import { resolveProviderConfig } from "../campaign/provider-config.mjs";
import { createCodeRepairJudge } from "../execution/adapters/code-repair-adapter.mjs";
import { runRegisteredTest } from "../verification/registered-test.mjs";

const resolver = fileURLToPath(
	new URL("../pi/packages/coding-agent/src/experimental/source-resolver.ts", import.meta.url),
);
const child = fileURLToPath(new URL("./helpers/c6-audit-child.mjs", import.meta.url));
function scenario(t, name) {
	const dir = mkdtempSync(join(tmpdir(), "aegis-c6-review-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const run = spawnSync(process.execPath, ["--import", resolver, child, name, dir], {
		encoding: "utf8",
		timeout: 15000,
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(run.status, 0, `audit harness exited ${run.status}: ${run.stderr.slice(-1500)}`);
	assert.ok(existsSync(join(dir, "audit-result.json")), "harness must produce actual product evidence");
	return { dir, ...JSON.parse(readFileSync(join(dir, "audit-result.json"), "utf8")) };
}

test("CONTROL: SHA256 standard vector, semantic change and UUID uniqueness work", () => {
	assert.equal(
		createHash("sha256").update("abc").digest("hex"),
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	);
	assert.notEqual(createHash("sha256").update("a").digest("hex"), createHash("sha256").update("b").digest("hex"));
	assert.notEqual(randomUUID(), randomUUID());
});
test("CONTROL: ordinary real SDK/faux run completes both local tasks", (t) => {
	const r = scenario(t, "normal");
	assert.equal(r.outcome.ok, true);
	assert.deepEqual(Object.values(r.outcome.task_states), ["completed", "completed"]);
	assert.equal(r.effect.name, "Ada");
	assert.equal(r.effect.status, "active");
});
test("C6-X1: pending request reservations cannot grant a second request at limit 1", () => {
	const ledger = createToolLedger({
		limit: { model_requests: 1, tool_calls: 1, input_chars: 1000, wall_time_ms: 1000 },
		clock: () => 0,
	});
	assert.equal(ledger.admitRequest({ inputChars: 100 }).ok, true);
	assert.equal(
		ledger.admitRequest({ inputChars: 100 }).ok,
		false,
		"outstanding reservation must consume remaining budget before commit",
	);
});
test("C6-X1: duplicate request commit cannot charge an already consumed reservation", () => {
	const ledger = createToolLedger({
		limit: { model_requests: 2, tool_calls: 1, input_chars: 1000, wall_time_ms: 1000 },
		clock: () => 0,
	});
	const r = ledger.admitRequest({ inputChars: 100 });
	ledger.commitRequest({ reservation_id: r.reservation_id, inputChars: 100 });
	ledger.commitRequest({ reservation_id: r.reservation_id, inputChars: 100 });
	assert.equal(ledger.snapshot().consumed.model_requests, 1);
});
test("C6-X1: elapsed wall-time exhausts the request gate", () => {
	let now = 0;
	const ledger = createToolLedger({
		limit: { model_requests: 10, tool_calls: 10, input_chars: 1000, wall_time_ms: 1 },
		clock: () => now,
	});
	now = 2;
	assert.equal(ledger.admitRequest({ inputChars: 10 }).ok, false);
	assert.equal(ledger.admitTool().ok, false);
});
test("C6-X2: ledger counts every provider request in the real SDK tool loop", (t) => {
	const r = scenario(t, "normal");
	assert.ok(r.requests >= 4, "two tasks need decision and follow-up requests");
	assert.equal(r.outcome.ledger.consumed.model_requests, r.requests, "prompt count is not provider request count");
});
test("C6-X2: observation/tool-loop continuations consume the same request budget", (t) => {
	const r = scenario(t, "read-budget");
	assert.equal(
		r.requests,
		1,
		"a request allocation of one must stop repeated read continuations before a second provider call",
	);
});
test("C6-X2: per-task request limit 1 refuses SDK automatic follow-up before provider", (t) => {
	const r = scenario(t, "task-budget");
	const taskOneStarts = r.events.filter(
		(e) => e.payload?.kind === "campaign.task.started" && e.payload.task_id === "task-001",
	);
	assert.equal(taskOneStarts.length, 1);
	assert.equal(r.requests, 1, "task allocation 1 cannot fund a second provider request or advance dependency");
});
test("C6-X2: broker effects consume the actual task tool allocation", (t) => {
	const r = scenario(t, "tool-budget");
	const requested = r.events.filter((e) => e.event_type === "action.requested" && e.payload?.task_id === "task-001");
	assert.ok(requested.length <= 1, `task tool allocation=1 but ${requested.length} real broker intents landed`);
});
test("C6-X3: total context limit applies per provider request, not multiplied by request budget", (t) => {
	const r = scenario(t, "context-limit");
	assert.equal(
		r.requests,
		0,
		"1000 characters cannot hold ROM/tools/RAM/task/history even with 100 requests of total budget",
	);
});
test("C6-X4: measure rebuilds committed request usage after the executing process returns", (t) => {
	const r = scenario(t, "measure");
	assert.equal(r.measure.ledger.consumed.model_requests, r.requests);
	assert.ok(r.measure.attempts.length > 0, "measurement must retain source attempt/request records");
});
test("C6-X4: restart cannot regain a spent campaign model request budget", (t) => {
	const r = scenario(t, "restart-budget");
	assert.equal(r.requestsAfter, r.requestsBefore, "completed tasks must not repeat");
	assert.equal(
		r.repeatConsumed.model_requests,
		r.requestsBefore,
		"restart must retain committed consumption even with no new dispatch",
	);
});
test("C6-X5: SDK audit binds to config stream, even with a conflicting inherited AEGIS_EVENT_LOG", (t) => {
	const r = scenario(t, "log-binding");
	assert.equal(r.decoyEvents.length, 0, "SDK must not write inherited decoy stream");
	assert.ok(
		r.events.some((e) => e.event_type === "request.projected"),
		"provider-bound RAM audit belongs in campaign stream",
	);
});
test("C6-X5: provider RAM identity follows the actual current Host task", (t) => {
	const r = scenario(t, "normal");
	const sdkStarts = r.events.filter((e) => e.event_type === "episode.started");
	assert.ok(sdkStarts.length > 0);
	assert.equal(
		sdkStarts.some((e) => e.payload?.task_id === "external-unrelated-label"),
		false,
		"caller test label must not override Host task binding",
	);
	assert.ok(sdkStarts.every((e) => ["task-001", "task-002"].includes(e.payload?.task_id)));
});
test("C6-X6: bounded runner executes in the attempt directories it reports", (t) => {
	const r = scenario(t, "runner");
	assert.deepEqual(
		r.attemptLogs,
		[true, true],
		"reported isolated work_dir must contain each run's actual committed source",
	);
});
test("C6-X7: local provider configuration is implemented independently of a real network call", () => {
	const result = resolveProviderConfig({
		kind: "local-openai",
		model: "review-model",
		base_url: "http://127.0.0.1:1234/v1",
		credential_ref: "env:REVIEW_ONLY_KEY",
	});
	assert.equal(
		result.ok,
		true,
		"C6-D must implement SDK startup selection; endpoint execution remains untested/offline",
	);
});
test("C6-X8: compiled Campaign proof contains verified predicate and replay prerequisites", (t) => {
	const r = scenario(t, "learning");
	const records = r.events
		.filter((e) => e.payload?.kind === "campaign.oracle.result" && !e.payload.step_id)
		.map((e) => e.payload.outcome);
	assert.ok(records.length >= 2);
	assert.ok(
		records.every(
			(o) =>
				o.when?.length > 0 && o.when.every((p) => typeof p === "object" && p.path && p.op && p.verified_by?.length),
		),
		"declaration strings cannot support Compiler when gate",
	);
	assert.ok(
		records.every((o) => o.expect?.length > 0 && o.run_id),
		"proof needs postcondition and trusted run identity",
	);
});
test("C6-X9: observe CLI keeps its own listener alive until SIGTERM", async (t) => {
	const r = scenario(t, "normal");
	const entry = fileURLToPath(new URL("../campaign/c6-entry.mjs", import.meta.url));
	const proc = spawn(
		process.execPath,
		["--import", resolver, entry, "--config", join(r.dir, "config.json"), "observe", "--port", "0"],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	t.after(() => {
		if (proc.exitCode === null) proc.kill("SIGKILL");
	});
	const exit = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
	const ready = new Promise((resolve, reject) => {
		let text = "";
		const timer = setTimeout(() => reject(new Error("observe did not print its URL")), 5000);
		proc.stdout.on("data", (buf) => {
			text += buf.toString();
			const m = /observation board: (http:\/\/[^\s]+)/.exec(text);
			if (m) {
				clearTimeout(timer);
				resolve(m[1]);
			}
		});
		proc.once("exit", () => {
			clearTimeout(timer);
			reject(new Error("observe exited before readiness"));
		});
	});
	const url = await ready;
	const ended = await Promise.race([exit, new Promise((resolve) => setTimeout(() => resolve(null), 200))]);
	assert.equal(ended, null, "observe must remain alive for a reader, rather than close its printed URL immediately");
	const response = await fetch(new URL("/healthz", url));
	assert.equal(response.status, 200);
	proc.kill("SIGTERM");
	const stopped = await Promise.race([
		exit,
		new Promise((_, reject) => setTimeout(() => reject(new Error("SIGTERM failed to close observe")), 3000)),
	]);
	assert.equal(stopped.code, 0);
});

test("C6-X10: code repair cannot claim success by exiting the test child before assertions", (t) => {
	const r = scenario(t, "code-false-success");
	assert.equal(
		r.outcome.task_states?.["task-001"] === "completed",
		false,
		"process.exit(0) left answer=0 and skipped the external assert for answer=42",
	);
	const rerun = runRegisteredTest({ workspaceRoot: join(r.dir, "workspace") });
	assert.equal(rerun.ok, false, "exit 0 with no trusted complete test evidence is unknown, not passed");
});

test("C6-X10: code repair judge respects unsupported declared criteria", (t) => {
	const r = scenario(t, "normal");
	const judge = createCodeRepairJudge({
		workspaceRoot: join(r.dir, "workspace"),
		runTests: () => ({ ok: true, passed: 1, failed: 0, exit_code: 0 }),
	});
	const verdict = judge({
		task: {
			task_id: "task-x",
			target_ref: "dataset.json",
			stages: [{ stage_id: "s", criteria: ["prove unregistered property"], required: true }],
		},
	});
	assert.equal(verdict.status, "unknown", "passing one test cannot satisfy any arbitrary declared property");
});

test("C6-X11: model receives an authorized observation path and data-only action schema", (t) => {
	const r = scenario(t, "normal");
	const input = r.providerInputs[0];
	assert.ok(
		input.tools.some((name) => ["aegis_observe", "aegis_workspace", "aegis_read"].includes(name)),
		"model has no declared tool to inspect target state before deciding a repair",
	);
	assert.ok(
		input.messages.includes("dataset.json") && input.messages.includes("data.name == Ada"),
		"current target and exact acceptance condition must reach provider",
	);
	assert.ok(
		input.messages.includes("field") && input.messages.includes("value"),
		"registered parameter schemas, not only action names, must reach provider",
	);
});

test("CONTROL: corrupted source cannot report a completed status", (t) => {
	const r = scenario(t, "readonly-integrity");
	assert.equal(r.readonlyThrown, undefined, "bad source must return a structured refusal, not a cleanup TypeError");
	assert.equal(r.readonly.ok, false);
	assert.equal(Object.values(r.readonly.task_states ?? {}).includes("completed"), false);
});
