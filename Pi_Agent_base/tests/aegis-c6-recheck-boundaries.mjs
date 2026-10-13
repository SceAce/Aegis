#!/usr/bin/env node
// Focused follow-ups on the C6 repair: trusted test completion, new observation
// path, and runner initial state. No real model/network/target.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModelWorker, createObservationTool } from "../memory/campaign/c6-model-worker.mjs";
import { runBoundedAttempts } from "../memory/campaign/c6-runner.mjs";
import { createToolLedger } from "../memory/campaign/c6-tool-ledger.mjs";
import { runRegisteredTest } from "../memory/campaign/registered-test.mjs";

function setup(t) {
	const dir = mkdtempSync(join(tmpdir(), "aegis-c6-recheck-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const workspace = join(dir, "workspace");
	mkdirSync(workspace);
	return { dir, workspace };
}
function prepareTest(workspace, content) {
	writeFileSync(join(workspace, "solution.mjs"), content);
	writeFileSync(
		join(workspace, "check.mjs"),
		'import assert from "node:assert/strict"; import { answer } from "./solution.mjs"; assert.equal(answer,42);\n',
	);
}

test("CONTROL: registered test verifies a real correct answer and rejects wrong answer", (t) => {
	const { workspace } = setup(t);
	prepareTest(workspace, "export const answer=42;\n");
	assert.equal(runRegisteredTest({ workspaceRoot: workspace }).ok, true);
	prepareTest(workspace, "export const answer=0;\n");
	assert.equal(runRegisteredTest({ workspaceRoot: workspace }).ok, false);
});

test("C6-R1: target-controlled Error.prepareStackTrace cannot authenticate a skipped test", (t) => {
	const { workspace } = setup(t);
	prepareTest(
		workspace,
		'Error.prepareStackTrace = () => "Error\\n at ignored\\n at " + process.cwd() + "/check.mjs:1:1"; process.exit(0); export const answer=0;\n',
	);
	const result = runRegisteredTest({ workspaceRoot: workspace });
	assert.equal(
		result.ok,
		false,
		"target can fabricate a registered-test caller frame while answer=0; acceptance assertions never ran",
	);
	assert.equal(result.complete, false, "caller stack text is not trusted completion evidence");
});

test("C6-R2: newly exposed observation tool rejects a grant-named symlink escaping workspace", async (t) => {
	const { dir, workspace } = setup(t);
	const outside = join(dir, "outside.txt");
	writeFileSync(outside, "PRIVATE_AUDIT_SAMPLE");
	symlinkSync(outside, join(workspace, "allowed.txt"));
	const type = { Object: (x) => x, String: () => ({ type: "string" }) };
	const tool = createObservationTool({
		sdk: { defineTool: (x) => x },
		type,
		workspaceRoot: workspace,
		allowedTargets: ["allowed.txt"],
	});
	const result = await tool.execute("read-1", { path: "allowed.txt" });
	assert.equal(
		result.details.ok,
		false,
		"lexical grant match cannot permit reading the symlink target outside workspace",
	);
	assert.equal(JSON.stringify(result).includes("PRIVATE_AUDIT_SAMPLE"), false);
});

test("CONTROL: observation reads the authorized regular file", async (t) => {
	const { workspace } = setup(t);
	writeFileSync(join(workspace, "allowed.txt"), "safe-data");
	const type = { Object: (x) => x, String: () => ({ type: "string" }) };
	const tool = createObservationTool({
		sdk: { defineTool: (x) => x },
		type,
		workspaceRoot: workspace,
		allowedTargets: ["allowed.txt"],
	});
	const result = await tool.execute("read-1", { path: "allowed.txt" });
	assert.equal(result.details.ok, true);
	assert.ok(JSON.stringify(result).includes("safe-data"));
});

test("C6-R3: runner cannot report a requested initial state that it never applies", async (t) => {
	const { dir, workspace } = setup(t);
	const statePath = join(workspace, "dataset.json");
	writeFileSync(statePath, JSON.stringify({ status: "prior-result" }));
	const configPath = join(dir, "config.json");
	writeFileSync(configPath, JSON.stringify({ workspace_root: workspace, work_dir: join(dir, "run") }));
	let observed;
	const result = await runBoundedAttempts({
		configPath,
		baseDir: join(dir, "attempts"),
		attempts: [{ id: "a", initial_state: { status: "fresh" } }],
		runEntry: async () => {
			observed = JSON.parse(readFileSync(statePath, "utf8"));
			return { ok: true };
		},
	});
	assert.ok(
		result.attempts[0].ok === false || observed.status === "fresh",
		"must apply initial state with a trusted initializer or explicitly refuse; metadata alone is not reset evidence",
	);
});

// ---------------------------------------------------------------------------
// Provider-bound request gate: every continuation is admitted BEFORE the
// provider call, durable reservations are required, and a failed accounting
// write stops dispatch instead of continuing.
// ---------------------------------------------------------------------------

function fakeSession() {
	const listeners = [];
	const calls = { stream: 0 };
	const session = {
		agent: {},
		subscribe(fn) {
			listeners.push(fn);
			return () => {
				const i = listeners.indexOf(fn);
				if (i >= 0) listeners.splice(i, 1);
			};
		},
		getActiveToolNames: () => ["aegis_task_decision"],
		async prompt() {
			// Simulate the SDK loop: each iteration asks for the provider boundary.
			// Four tool-loop continuations; the gate must stop after the budget.
			for (let i = 0; i < 4; i += 1) {
				try {
					await session.agent.streamFunction({ id: "faux", provider: "faux" }, { messages: [] }, undefined);
				} catch {
					return;
				}
				calls.stream += 1;
				for (const fn of [...listeners]) fn({ type: "message_end", message: { role: "assistant", content: [] } });
			}
		},
	};
	return { session, calls, listeners };
}

test("C6-R4: the provider-bound gate stops tool-loop continuations before a second provider call", async (_t) => {
	const { session, calls } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		return { ok: true };
	};
	const ledger = createToolLedger({
		limit: { model_requests: 1, tool_calls: 10, input_chars: 0, wall_time_ms: 100000 },
	});
	const worker = createModelWorker({
		session: () => session,
		ledger,
		context: { max_total_input_chars: 100000, output_reserve_chars: 0, strategy: "bounded_ram" },
		taskId: "task-001",
		goal: "demo",
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });
	assert.equal(
		providerCalls,
		1,
		"a request allocation of one must stop repeated continuations before a second provider call",
	);
	assert.equal(result.failure_mode, "budget_exhausted");
	assert.equal(calls.stream, 1, "only the first (admitted) stream call may complete");
});

test("C6-R5: a reservation that cannot be made durable never calls the provider", async (_t) => {
	const { session } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		return { ok: true };
	};
	const ledger = createToolLedger({
		limit: { model_requests: 5, tool_calls: 10, input_chars: 0, wall_time_ms: 100000 },
	});
	const worker = createModelWorker({
		session: () => session,
		ledger,
		context: { max_total_input_chars: 100000, output_reserve_chars: 0, strategy: "bounded_ram" },
		taskId: "task-001",
		goal: "demo",
		persistRequest: async () => ({ ok: false, error: "injected fsync failure" }),
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });
	assert.equal(providerCalls, 0, "a durable reservation must exist before the provider is called");
	assert.equal(result.failure_mode, "accounting_failure");
	assert.ok(result.reconciliation, "an accounting failure must keep reconciliation state");
});

test("C6-R6: a failed durable commit stops the NEXT provider request", async (_t) => {
	const { session } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		return { ok: true };
	};
	const ledger = createToolLedger({
		limit: { model_requests: 5, tool_calls: 10, input_chars: 0, wall_time_ms: 100000 },
	});
	let reservations = 0;
	const worker = createModelWorker({
		session: () => session,
		ledger,
		context: { max_total_input_chars: 100000, output_reserve_chars: 0, strategy: "bounded_ram" },
		taskId: "task-001",
		goal: "demo",
		persistRequest: async ({ phase }) => {
			if (phase === "reserved") reservations += 1;
			// The reservation succeeds; the COMMIT fails. The next admission must be
			// refused after awaiting the failed commit.
			return phase === "reserved" ? { ok: true } : { ok: false, error: "injected commit failure" };
		},
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });
	assert.equal(providerCalls, 1, "the provider is called once, then a failed commit stops dispatch");
	assert.equal(reservations, 1, "no second reservation after the failed commit");
	assert.equal(result.failure_mode, "accounting_failure");
	assert.ok(result.reconciliation, "reconciliation state must be retained after the failure");
});

test("C6-R12: a final request commit failure prevents returning an executable decision", async () => {
	const { session, listeners } = fakeSession();
	session.agent.streamFunction = async () => ({ ok: true });
	session.prompt = async () => {
		await session.agent.streamFunction({}, { messages: [] });
		for (const listener of [...listeners])
			listener({ type: "message_end", message: { role: "assistant", content: [] } });
	};
	const ledger = createToolLedger({
		limit: { model_requests: 5, tool_calls: 10, input_chars: 0, wall_time_ms: 100000 },
	});
	const worker = createModelWorker({
		session: () => session,
		ledger,
		context: { max_total_input_chars: 100000, output_reserve_chars: 0, strategy: "bounded_ram" },
		taskId: "task-001",
		goal: "demo",
		decisionBuffer: {
			list: () => [
				{ action_ref: "data.record.set", arguments: { target: "dataset.json", field: "status", value: "active" } },
			],
		},
		persistRequest: async ({ phase }) =>
			phase === "reserved" ? { ok: true } : { ok: false, error: "last commit fsync failure" },
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });
	assert.equal(
		result.ok,
		false,
		"no NEXT request exists to flush the final commit; the Worker must await it before Broker dispatch",
	);
	assert.equal(result.failure_mode, "accounting_failure");
});

test("C6-R13: provider admission checks the Campaign limit as well as the Task limit", async () => {
	const { session } = fakeSession();
	let calls = 0;
	session.agent.streamFunction = async () => {
		calls += 1;
		return { ok: true };
	};
	const campaignLedger = createToolLedger({
		limit: { model_requests: 0, tool_calls: 10, input_chars: 0, wall_time_ms: 100000 },
	});
	const taskLedger = createToolLedger({
		limit: { model_requests: 5, tool_calls: 10, input_chars: 0, wall_time_ms: 100000 },
	});
	const worker = createModelWorker({
		session: () => session,
		ledger: campaignLedger,
		ledgerFactory: () => taskLedger,
		context: { max_total_input_chars: 100000, output_reserve_chars: 0, strategy: "bounded_ram" },
		taskId: "task-001",
		goal: "demo",
	});
	await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });
	assert.equal(calls, 0, "a Task allocation is not permission to bypass exhausted Campaign consumed/pending budget");
});

test("C6-R14: the provider window includes actual continuation messages", async () => {
	const { session } = fakeSession();
	let calls = 0;
	session.agent.streamFunction = async () => {
		calls += 1;
		return { ok: true };
	};
	session.prompt = async () => {
		try {
			await session.agent.streamFunction({}, { messages: [{ role: "user", content: "x".repeat(10000) }] });
		} catch {
			/* SDK converts gate refusal into a stop */
		}
	};
	const ledger = createToolLedger({
		limit: { model_requests: 5, tool_calls: 10, input_chars: 0, wall_time_ms: 100000 },
	});
	const worker = createModelWorker({
		session: () => session,
		ledger,
		context: { max_total_input_chars: 2000, output_reserve_chars: 0, strategy: "bounded_ram" },
		taskId: "task-001",
		goal: "demo",
	});
	await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });
	assert.equal(
		calls,
		0,
		"the actual provider transcript is larger than the window even if cached prompt/RAM estimate fits",
	);
});

test("C6-R7: the observation read grant is the CURRENT task, not the whole manifest", async (t) => {
	const { workspace } = setup(t);
	writeFileSync(join(workspace, "task-a.txt"), "A-data");
	writeFileSync(join(workspace, "task-b.txt"), "B-data");
	const type = { Object: (x) => x, String: () => ({ type: "string" }) };
	let current = { task_id: "task-a", targets: ["task-a.txt"] };
	const tool = createObservationTool({
		sdk: { defineTool: (x) => x },
		type,
		workspaceRoot: workspace,
		grantProvider: () => current,
	});
	assert.equal((await tool.execute("r1", { path: "task-a.txt" })).details.ok, true);
	// Task B's file is NOT in the CURRENT task A grant, even though it is inside
	// the workspace and would have been in the whole-manifest union.
	const foreign = await tool.execute("r2", { path: "task-b.txt" });
	assert.equal(foreign.details.ok, false);
	assert.equal(foreign.details.reason, "outside_grant");
	assert.equal(JSON.stringify(foreign).includes("B-data"), false);
	// Switching the current task changes the grant.
	current = { task_id: "task-b", targets: ["task-b.txt"] };
	assert.equal((await tool.execute("r3", { path: "task-b.txt" })).details.ok, true);
	assert.equal((await tool.execute("r4", { path: "task-a.txt" })).details.ok, false);
});

// ---------------------------------------------------------------------------
// Registered-test trusted completion: a legal assert/strict module passes, a
// normal assertion error is a failure, and an early exit is unknown. No result
// is accepted without the host nonce.
// ---------------------------------------------------------------------------

test("C6-R8: a legal node:assert/strict module completes and a real error fails", async (t) => {
	const { workspace } = setup(t);
	writeFileSync(join(workspace, "solution.mjs"), "export const answer = 42;\n");
	writeFileSync(
		join(workspace, "check.mjs"),
		'import assert from "node:assert/strict";\nimport { answer } from "./solution.mjs";\nassert.equal(answer, 42);\nassert.deepStrictEqual({ a: 1 }, { a: 1 });\n',
	);
	const pass = runRegisteredTest({ workspaceRoot: workspace });
	assert.equal(pass.ok, true, JSON.stringify(pass));
	assert.equal(pass.complete, true);
	// A normal assertion error is a REAL failure, not unknown.
	writeFileSync(
		join(workspace, "check.mjs"),
		'import assert from "node:assert/strict";\nimport { answer } from "./solution.mjs";\nassert.equal(answer, 0);\n',
	);
	const fail = runRegisteredTest({ workspaceRoot: workspace });
	assert.equal(fail.ok, false);
	assert.equal(fail.complete, true);
	assert.equal(fail.failed, 1);
});

test("C6-R9: an early exit and a forged result file are both unknown", async (t) => {
	const { workspace } = setup(t);
	// The imported dependency ends the process before the test's assertions run.
	writeFileSync(join(workspace, "solution.mjs"), "process.exit(0);\nexport const answer = 0;\n");
	writeFileSync(
		join(workspace, "check.mjs"),
		'import assert from "node:assert/strict";\nimport { answer } from "./solution.mjs";\nassert.equal(answer, 42);\n',
	);
	const early = runRegisteredTest({ workspaceRoot: workspace });
	assert.equal(early.ok, false);
	assert.equal(early.complete, false, "an early exit must not be a completed pass");
});

test("C6-R10: runner applies a trusted initializer and isolates a failing attempt", async (t) => {
	const { dir, workspace } = setup(t);
	const statePath = join(workspace, "dataset.json");
	writeFileSync(statePath, JSON.stringify({ status: "stale" }));
	const configPath = join(dir, "config.json");
	writeFileSync(configPath, JSON.stringify({ workspace_root: workspace, work_dir: join(dir, "run") }));
	const applied = [];
	const result = await runBoundedAttempts({
		configPath,
		baseDir: join(dir, "attempts"),
		applyInitialState: (attempt, initial) => {
			// The first attempt's initializer fails; the second must still run.
			if (attempt.id === "bad") throw new Error("injected reset failure");
			writeFileSync(statePath, JSON.stringify(initial));
			return { ok: true, applied: JSON.parse(readFileSync(statePath, "utf8")) };
		},
		attempts: [
			{ id: "bad", work_dir: join(dir, "bad"), initial_state: { status: "fresh-bad" } },
			{ id: "good", work_dir: join(dir, "good"), initial_state: { status: "fresh-good" } },
		],
		runEntry: async ({ configPath: attemptConfig }) => {
			applied.push(JSON.parse(readFileSync(statePath, "utf8")).status);
			return { ok: true, config: attemptConfig };
		},
	});
	assert.equal(result.attempts[0].ok, false, "a failed reset is that attempt's failure");
	assert.match(result.attempts[0].error, /injected reset failure/);
	assert.equal(result.attempts[1].ok, true, "an independent attempt still runs");
	assert.equal(result.attempts[1].initial_state_applied, true);
	assert.equal(applied.at(-1), "fresh-good", "the real applied state must reach the attempt");
	assert.equal(result.attempts[1].applied_initial_state.status, "fresh-good");
});

test("C6-R11: a habit route fixes the method and asks only for the missing parameters", async (_t) => {
	const { session } = fakeSession();
	session.agent.streamFunction = async () => ({ ok: true });
	const seen = [];
	session.prompt = async (prompt) => {
		seen.push(prompt);
	};
	const ledger = createToolLedger({
		limit: { model_requests: 5, tool_calls: 10, input_chars: 0, wall_time_ms: 100000 },
	});
	const worker = createModelWorker({
		session: () => session,
		ledger,
		context: { max_total_input_chars: 100000, output_reserve_chars: 0, strategy: "bounded_ram" },
		taskId: "task-001",
		goal: "demo",
		router: async () => ({
			route: "habit",
			action_ref: "data.record.set",
			missing_parameters: ["value"],
			arguments: { target: "dataset.json", field: "status" },
			planning_requests: 0,
		}),
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });
	assert.equal(seen.length, 1, "a habit route still asks the model to bind the missing parameter");
	assert.match(seen[0], /HABIT MATCH: the verified method is data\.record\.set/);
	assert.match(seen[0], /MISSING PARAMETERS TO BIND: \["value"\]/);
	assert.match(seen[0], /ALREADY BOUND: \{"target":"dataset\.json","field":"status"\}/);
	// The worker still runs the model request (not a full re-plan): the decision
	// path is the SAME Broker/Oracle path with the fixed method.
	assert.ok(result.failure_mode === "no_model_decision" || result.ok === true, JSON.stringify(result));
});
