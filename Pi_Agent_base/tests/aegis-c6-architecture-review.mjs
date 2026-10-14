#!/usr/bin/env node
// Independent C6 architectural checks. The live worker produces the records;
// assertions compare budget responsibility and dispatch across reconstruction.
// Product checks use a real SDK/faux child, EventLog, Broker and Oracle.
// No real provider, credentials or target network is used.
// Run: node --test Pi_Agent_base/tests/aegis-c6-architecture-review.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createModelWorker } from "../memory/campaign/c6-model-worker.mjs";
import { reservedSeedForTask, summarizeRequestLedger } from "../memory/campaign/c6-request-lifecycle.mjs";
import { createToolLedger } from "../memory/campaign/c6-tool-ledger.mjs";
import { verifyChain } from "../memory/runtime/events.mjs";

const LIMIT = { model_requests: 5, tool_calls: 10, input_chars: 0, wall_time_ms: 100000 };
const CONTEXT = { max_total_input_chars: 100000, output_reserve_chars: 0 };
const BASE = fileURLToPath(new URL("..", import.meta.url));
const CHILD = join(BASE, "tests", "helpers", "c6-lifecycle-child.mjs");
const RESOLVER = join(BASE, "pi", "packages", "coding-agent", "src", "experimental", "source-resolver.ts");

async function liveRequest({ failSide = null, durableFailure = null, providerThrow = false } = {}) {
	const campaign = createToolLedger({ limit: LIMIT });
	const task = createToolLedger({ limit: LIMIT });
	const events = [];
	const listeners = new Set();
	let providerCalls = 0;
	const session = {
		agent: {
			streamFunction: async () => {
				providerCalls += 1;
				if (providerThrow) throw new Error("injected provider transport failure");
				return {};
			},
		},
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		getActiveToolNames: () => [],
		async prompt() {
			await session.agent.streamFunction({}, { messages: [{ role: "user", content: "inspect authorized data" }] });
			for (const listener of listeners) {
				listener({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } });
			}
		},
	};
	const failing = (ledger, side) =>
		failSide === side
			? { ...ledger, commitRequest: () => ({ ok: false, error: "injected memory commit failure" }) }
			: ledger;
	const worker = createModelWorker({
		session: () => session,
		ledger: failing(campaign, "campaign"),
		ledgerFactory: () => failing(task, "task"),
		taskId: "task-a",
		campaignId: "campaign-a",
		context: CONTEXT,
		goal: "repair data",
		decisionBuffer: { list: () => [{ action_ref: "data.record.set", arguments: {} }] },
		persistRequest: async (record) => {
			if (record.phase === "committed" && durableFailure) {
				if (durableFailure === "throw") throw new Error("injected durable throw");
				return { ok: false, error: "injected durable failure" };
			}
			events.push({
				event_type: "runtime.note",
				payload: { kind: "c6.request", campaign_id: "campaign-a", ...record },
			});
			return { ok: true };
		},
	});
	const result = await worker.run({ task: { task_id: "task-a", goal: { description: "repair data" } } });
	return { campaign, task, events, result, providerCalls };
}

function reconstructedLedgers(summary) {
	return {
		campaign: createToolLedger({
			limit: LIMIT,
			baseConsumed: summary.consumed,
			baseReserved: {
				model_requests: summary.campaignPending.length,
				input_chars: summary.campaignPending.reduce((sum, note) => sum + note.inputChars, 0),
				pending: summary.campaignPending,
				committed: [...summary.committedReservations],
			},
		}),
		task: createToolLedger({
			limit: LIMIT,
			baseConsumed: { wall_time_ms: 0, ...summary.byTask.get("task-a") },
			baseReserved: reservedSeedForTask(summary.taskPending, summary.taskCommittedByTask, "task-a"),
		}),
	};
}

test("AR-01: normal live settlement preserves both budgets and task ownership on restart", async () => {
	const live = await liveRequest();
	assert.equal(live.result.ok, true);
	assert.equal(live.providerCalls, 1);
	const summary = summarizeRequestLedger(live.events);
	assert.equal(summary.consumed.model_requests, 1);
	assert.equal(summary.byTask.get("task-a").model_requests, 1);
	assert.equal(summary.unresolved, 0);
	assert.equal(summary.diagnostics.length, 0);
	const rebuilt = reconstructedLedgers(summary);
	assert.equal(rebuilt.campaign.remaining().model_requests, 4);
	assert.equal(rebuilt.task.remaining().model_requests, 4);
	assert.equal(reservedSeedForTask(summary.taskPending, summary.taskCommittedByTask, "task-b").model_requests, 0);
});

for (const side of ["task", "campaign"]) {
	test(`AR-02-${side}: partial memory commit preserves each side's liability after replay`, async () => {
		const live = await liveRequest({ failSide: side });
		assert.equal(live.providerCalls, 1);
		assert.equal(live.result.ok, false);
		assert.equal(live.result.failure_mode, "accounting_failure");
		const summary = summarizeRequestLedger(live.events);
		assert.equal(summary.unresolved, 1);
		const rebuilt = reconstructedLedgers(summary);
		assert.equal(rebuilt.campaign.remaining().model_requests, 4, "restart cannot refund the Campaign side");
		assert.equal(rebuilt.task.remaining().model_requests, 4, "restart cannot refund the Task side");
	});
}

test("AR-03: two memory commits plus a failed durable commit retain charges AND unresolved state", async () => {
	const live = await liveRequest({ durableFailure: "return_false" });
	assert.equal(live.result.ok, false);
	assert.equal(live.result.failure_mode, "accounting_failure");
	assert.equal(live.campaign.consumed().model_requests, 1);
	assert.equal(live.task.consumed().model_requests, 1);
	assert.deepEqual(
		live.events.map((event) => event.payload.phase),
		["reserved", "reconciliation_required"],
	);
	const summary = summarizeRequestLedger(live.events);
	assert.equal(summary.unresolved, 1, "two side commits do not establish a successful durable joint settlement");
	const rebuilt = reconstructedLedgers(summary);
	assert.equal(rebuilt.campaign.remaining().model_requests, 4);
	assert.equal(rebuilt.task.remaining().model_requests, 4);
});

test("AR-04: rebuilding the failed durable commit blocks the next independent provider dispatch", async () => {
	const live = await liveRequest({ durableFailure: "return_false" });
	const summary = summarizeRequestLedger(live.events);
	const { campaign } = reconstructedLedgers(summary);
	let providerCalls = 0;
	const session = {
		agent: {
			streamFunction: async () => {
				providerCalls += 1;
			},
		},
		subscribe: () => () => {},
		getActiveToolNames: () => [],
		async prompt() {
			await session.agent.streamFunction({}, { messages: [] });
		},
	};
	const worker = createModelWorker({
		session: () => session,
		ledger: campaign,
		ledgerFactory: () => createToolLedger({ limit: LIMIT }),
		taskId: "task-b",
		context: CONTEXT,
		goal: "independent next task",
		reconciliationGuard: { unresolved: summary.unresolved, diagnostics: summary.diagnostics.length },
		persistRequest: async () => ({ ok: true }),
	});
	const result = await worker.run({ task: { task_id: "task-b" } });
	assert.equal(providerCalls, 0, "an unresolved prior request must stop dispatch even without pending holds");
	assert.equal(result.failure_mode, "reconciliation_required");
});

test("AR-05: a throwing durable writer leaves the original reservation as a conservative recovery source", async () => {
	const live = await liveRequest({ durableFailure: "throw" });
	assert.equal(live.result.ok, false);
	const summary = summarizeRequestLedger(live.events);
	assert.equal(summary.unresolved, 1);
	const rebuilt = reconstructedLedgers(summary);
	assert.equal(rebuilt.campaign.remaining().model_requests, 4);
	assert.equal(rebuilt.task.remaining().model_requests, 4);
});

test("AR-06: duplicate reconciliation followed by a valid joint commit never charges twice", async () => {
	const live = await liveRequest({ durableFailure: "return_false" });
	const reconciliation = live.events.at(-1);
	const committed = { ...reconciliation, payload: { ...reconciliation.payload, phase: "committed" } };
	const summary = summarizeRequestLedger([...live.events, reconciliation, committed, committed]);
	assert.equal(summary.consumed.model_requests, 1);
	assert.equal(summary.byTask.get("task-a").model_requests, 1);
	assert.equal(summary.unresolved, 0);
	assert.equal(summary.campaignPending.length, 0);
	assert.equal(summary.taskPending.length, 0);
});

test("AR-07: an unknown provider result retains both holds and prevents budget refund after replay", async () => {
	const live = await liveRequest({ providerThrow: true });
	assert.equal(live.providerCalls, 1);
	assert.equal(live.result.failure_mode, "reconciliation_required");
	const summary = summarizeRequestLedger(live.events);
	assert.equal(summary.unresolved, 1);
	const rebuilt = reconstructedLedgers(summary);
	assert.equal(rebuilt.campaign.remaining().model_requests, 4);
	assert.equal(rebuilt.task.remaining().model_requests, 4);
});

function child(workDir, scenario) {
	const run = spawnSync(process.execPath, ["--import", RESOLVER, CHILD, workDir, scenario], {
		encoding: "utf8",
		timeout: 30000,
		maxBuffer: 8 * 1024 * 1024,
	});
	return run;
}
function productSummary(workDir, scenario) {
	return JSON.parse(readFileSync(join(workDir, `summary-${scenario}.json`), "utf8"));
}
function productEvents(workDir) {
	return readFileSync(join(workDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}
function productDir(t) {
	const path = mkdtempSync(join(tmpdir(), "aegis-c6-architecture-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

test("AR-08: normal SDK decision, Broker effect and Oracle completion survive restart without repetition", (t) => {
	const workDir = productDir(t);
	const run = child(workDir, "normal");
	assert.equal(run.status, 0, run.stderr);
	const first = productSummary(workDir, "normal");
	assert.equal(first.providerCalls, 2);
	assert.equal(first.task_states["task-001"], "completed");
	assert.equal(first.brokerEffects, 1);
	assert.equal(first.dataset.name, "Ada");
	assert.equal(first.ledger.consumed.model_requests, 2);
	assert.equal(child(workDir, "recover").status, 0);
	const recovered = productSummary(workDir, "recover");
	assert.equal(recovered.providerCalls, 0);
	assert.equal(recovered.brokerEffects, 0);
	assert.equal(recovered.ledger.consumed.model_requests, 2);
	assert.ok(verifyChain(productEvents(workDir)).ok);
});

for (const scenario of ["error_followup", "aborted_followup"]) {
	test(`AR-09-${scenario}: interrupted SDK follow-up cannot execute the previously buffered decision`, (t) => {
		const workDir = productDir(t);
		const run = child(workDir, scenario);
		assert.equal(run.status, 0, run.stderr);
		const summary = productSummary(workDir, scenario);
		t.diagnostic(
			JSON.stringify({
				scenario,
				providerCalls: summary.providerCalls,
				brokerEffects: summary.brokerEffects,
				taskStates: summary.task_states,
				dataset: summary.dataset,
				consumed: summary.ledger.consumed,
				requests: summary.requests.map((request) => [request.phase, request.provider_status]),
			}),
		);
		assert.equal(summary.providerCalls, 2, "the decision and interrupted follow-up both reached the real SDK");
		assert.ok(verifyChain(productEvents(workDir)).ok);
		assert.equal(summary.brokerEffects, 0, "an interrupted planning loop cannot reach the Broker");
		assert.equal(summary.dataset.name, "??", "the actual authorized file must remain untouched");
		assert.notEqual(summary.task_states["task-001"], "completed");
		assert.equal(summary.ledger.consumed.model_requests, 2, "interruption never refunds dispatched requests");
		// The SDK termination category must survive into the durable record and the
		// Worker result: error and aborted are NOT collapsed into "ok".
		const expectedStatus = scenario === "aborted_followup" ? "aborted" : "error";
		const expectedFailure = scenario === "aborted_followup" ? "provider_aborted" : "provider_error";
		const interrupted = summary.requests.filter((request) => request.provider_status === expectedStatus);
		assert.equal(interrupted.length, 1, `one durable record carries provider_status=${expectedStatus}`);
		assert.equal(interrupted[0].phase, "committed");
		assert.equal(
			interrupted[0].stop_reason,
			expectedStatus,
			"the raw SDK stopReason is preserved on the durable settlement",
		);
		assert.ok(
			summary.failure_modes.includes(expectedFailure),
			`the worker reports ${expectedFailure}: ${JSON.stringify(summary.failure_modes)}`,
		);
	});
}

test("AR-10: SIGKILL after fallback reconciliation cannot erase the charge or unlock an independent queued Task", (t) => {
	const workDir = productDir(t);
	const killed = child(workDir, "durable_commit_failure_kill");
	assert.equal(killed.signal, "SIGKILL", killed.stderr);
	const before = productEvents(workDir);
	assert.ok(verifyChain(before).ok);
	const requests = before.filter((event) => event.payload?.kind === "c6.request");
	assert.deepEqual(
		requests.map((event) => event.payload.phase),
		["reserved", "reconciliation_required"],
	);
	assert.deepEqual(requests.at(-1).payload.commit_status, { task: "committed", campaign: "committed" });
	assert.equal(child(workDir, "recover_independent").status, 0);
	const recovered = productSummary(workDir, "recover_independent");
	t.diagnostic(
		JSON.stringify({
			providerCalls: recovered.providerCalls,
			brokerEffects: recovered.brokerEffects,
			taskStates: recovered.task_states,
			dataset: recovered.dataset,
			reconciliation: recovered.reconciliation,
			consumed: recovered.ledger.consumed,
			reserved: recovered.ledger.reserved,
		}),
	);
	assert.ok(verifyChain(productEvents(workDir)).ok);
	assert.equal(
		recovered.providerCalls,
		0,
		"restart must not start the independent queued Task while request settlement is unresolved",
	);
	assert.equal(recovered.brokerEffects, 0);
	assert.equal(recovered.dataset.status, "pending");
	assert.equal(recovered.reconciliation.blocked, true);
	assert.equal(recovered.reconciliation.unresolved_requests, 1);
	assert.equal(recovered.ledger.consumed.model_requests + recovered.ledger.reserved.model_requests, 1);
});

test("AR-11: an SDK error after request settlement cannot execute the buffered decision", (t) => {
	const workDir = productDir(t);
	const run = child(workDir, "sdk_result_persist_error");
	assert.equal(run.status, 0, run.stderr);
	const summary = productSummary(workDir, "sdk_result_persist_error");
	t.diagnostic(
		JSON.stringify({
			providerCalls: summary.providerCalls,
			brokerEffects: summary.brokerEffects,
			taskStates: summary.task_states,
			dataset: summary.dataset,
			consumed: summary.ledger.consumed.model_requests,
			sdkErrors: summary.sdk_errors,
			failureModes: summary.failure_modes,
		}),
	);
	assert.equal(summary.sdk_persistence_failures, 1, "only the actual SDK tool-result append fails");
	assert.deepEqual(summary.sdk_errors, ["injected SDK tool-result persistence failure"]);
	assert.equal(summary.providerCalls, 1, "the synthetic SDK error is not a second provider request");
	assert.equal(summary.ledger.consumed.model_requests, 1);
	const committed = summary.requests.filter((request) => request.phase === "committed");
	assert.equal(committed.length, 1);
	assert.equal(committed[0].provider_status, "ok", "the completed provider response remains a separate fact");
	assert.equal(summarizeRequestLedger(productEvents(workDir)).unresolved, 0, "request accounting stays settled");
	assert.equal(summary.brokerEffects, 0, "SDK planning failure cannot reach the Broker after settlement");
	assert.equal(summary.dataset.name, "??");
	assert.notEqual(summary.task_states["task-001"], "completed");
	assert.ok(summary.failure_modes.includes("planning_error"));
	assert.ok(verifyChain(productEvents(workDir)).ok);
});
