#!/usr/bin/env node
// Aegis C6 request-lifecycle convergence (this round).
//
// Focused behaviour tests for the four reproduced defects (A memory-commit
// masking, B provider-error reconciliation, C per-Task pending isolation,
// D partial-commit acceptance) and the directly related reconstruction
// semantics (`reconciliation_required` means unresolved, not released).
//
// Expected values come from the frozen contract, not from the implementation.
// A test helper may inject a failure, but it never manufactures the product's
// expected result.
//
// Run:
//   node --test Pi_Agent_base/tests/aegis-c6-lifecycle-convergence.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompositeWorker, summarizeRequestLedger } from "../campaign/c6-entry.mjs";
import { createModelWorker } from "../campaign/c6-model-worker.mjs";
import { classifyStopReason, reservedSeedForTask } from "../campaign/c6-request-lifecycle.mjs";
import { createToolLedger } from "../campaign/c6-tool-ledger.mjs";

const LIMIT = { model_requests: 5, tool_calls: 10, input_chars: 0, wall_time_ms: 100000 };
const CONTEXT = { max_total_input_chars: 100000, output_reserve_chars: 0, strategy: "bounded_ram" };

/** A fake SDK session that exposes the real provider boundary. */
function fakeSession() {
	const listeners = [];
	const session = {
		agent: {},
		subscribe(fn) {
			listeners.push(fn);
			return () => {
				const index = listeners.indexOf(fn);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		getActiveToolNames: () => ["aegis_task_decision"],
		async prompt() {
			throw new Error("fake session: prompt not configured");
		},
	};
	return { session, listeners };
}

/** Delegate to a real ledger but force `commitRequest` to fail or throw. */
function unhealthyLedger(real, { failCommit = false, throwCommit = false } = {}) {
	return {
		...real,
		commitRequest: (...args) => {
			if (throwCommit) throw new Error("injected commit throw");
			if (failCommit) return { ok: false, failure_mode: "injected", reason: "injected commit failure" };
			return real.commitRequest(...args);
		},
	};
}

function makeLedgers() {
	return {
		campaign: createToolLedger({ limit: { ...LIMIT } }),
		task: createToolLedger({ limit: { ...LIMIT } }),
	};
}

function emitMessageEnd(listeners, message = { role: "assistant", content: [] }) {
	for (const listener of [...listeners]) listener({ type: "message_end", message });
}

// ---------------------------------------------------------------------------
// A. An in-memory commit failure must not be masked by a durable success.
// ---------------------------------------------------------------------------

test("LC-A1: a Task in-memory commit failure is not masked by a durable success", async () => {
	const { session, listeners } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		return { ok: true };
	};
	session.prompt = async () => {
		await session.agent.streamFunction({}, { messages: [] });
		emitMessageEnd(listeners);
	};
	const { campaign, task } = makeLedgers();
	const taskReal = task;
	const taskUnhealthy = unhealthyLedger(taskReal, { failCommit: true });
	const persisted = [];
	const worker = createModelWorker({
		session: () => session,
		ledger: campaign,
		ledgerFactory: () => taskUnhealthy,
		context: CONTEXT,
		taskId: "task-001",
		goal: "demo",
		decisionBuffer: { list: () => [{ action_ref: "data.record.set", arguments: {} }] },
		persistRequest: async (record) => {
			persisted.push(record);
			return { ok: true };
		},
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });

	assert.equal(providerCalls, 1, "the provider request really happened");
	assert.equal(result.ok, false, "a failed Task memory commit cannot be masked by a durable success");
	assert.equal(result.failure_mode, "accounting_failure");
	assert.equal(result.reconciliation.commit_status.task, "failed");
	assert.equal(campaign.consumed().model_requests, 1, "the committed Campaign side is charged once");
	assert.equal(taskReal.pending().length, 1, "the unresolved Task hold is retained");
	assert.equal(
		persisted.some((record) => record.phase === "committed"),
		false,
		"no joint-success durable record may be written when one side failed",
	);
	assert.ok(
		persisted.some((record) => record.phase === "reconciliation_required"),
		"a reconciliation record preserves the failure",
	);
});

test("LC-A2: a Campaign in-memory commit failure is not masked by a durable success", async () => {
	const { session, listeners } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		return { ok: true };
	};
	session.prompt = async () => {
		await session.agent.streamFunction({}, { messages: [] });
		emitMessageEnd(listeners);
	};
	const { campaign, task } = makeLedgers();
	const campaignReal = campaign;
	const campaignUnhealthy = unhealthyLedger(campaignReal, { failCommit: true });
	const persisted = [];
	const worker = createModelWorker({
		session: () => session,
		ledger: campaignUnhealthy,
		ledgerFactory: () => task,
		context: CONTEXT,
		taskId: "task-001",
		goal: "demo",
		decisionBuffer: { list: () => [{ action_ref: "data.record.set", arguments: {} }] },
		persistRequest: async (record) => {
			persisted.push(record);
			return { ok: true };
		},
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });

	assert.equal(providerCalls, 1);
	assert.equal(result.ok, false);
	assert.equal(result.failure_mode, "accounting_failure");
	assert.equal(result.reconciliation.commit_status.campaign, "failed");
	assert.equal(task.consumed().model_requests, 1, "the committed Task side is charged once");
	assert.equal(campaignReal.pending().length, 1, "the unresolved Campaign hold is retained");
	assert.equal(
		persisted.some((record) => record.phase === "committed"),
		false,
		"no joint-success durable record may be written when one side failed",
	);
});

test("LC-A3: a throwing in-memory commit is a failure, not a success", async () => {
	const { session, listeners } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		return { ok: true };
	};
	session.prompt = async () => {
		await session.agent.streamFunction({}, { messages: [] });
		emitMessageEnd(listeners);
	};
	const { campaign, task } = makeLedgers();
	const taskReal = task;
	const taskThrowing = unhealthyLedger(taskReal, { throwCommit: true });
	const persisted = [];
	const worker = createModelWorker({
		session: () => session,
		ledger: campaign,
		ledgerFactory: () => taskThrowing,
		context: CONTEXT,
		taskId: "task-001",
		goal: "demo",
		decisionBuffer: { list: () => [{ action_ref: "data.record.set", arguments: {} }] },
		persistRequest: async (record) => {
			persisted.push(record);
			return { ok: true };
		},
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });

	assert.equal(providerCalls, 1);
	assert.equal(result.ok, false);
	assert.equal(result.failure_mode, "accounting_failure");
	assert.match(String(result.reconciliation.commit_error), /in-memory commit failed|injected commit throw/);
	assert.equal(taskReal.pending().length, 1);
	assert.equal(
		persisted.some((record) => record.phase === "committed"),
		false,
	);
});

// ---------------------------------------------------------------------------
// B. A provider error after dispatch is recoverable, never a refund.
// ---------------------------------------------------------------------------

test("LC-B1: a provider throw keeps the hold, persists reconciliation and restores the gate", async () => {
	const { session, listeners } = fakeSession();
	let providerCalls = 0;
	const originalStream = async () => {
		providerCalls += 1;
		return { ok: true };
	};
	session.agent.streamFunction = originalStream;
	// The provider boundary throws and the SDK emits NO completion event.
	session.prompt = async () => {
		await session.agent.streamFunction({}, { messages: [] });
	};
	const { campaign, task } = makeLedgers();
	const persisted = [];
	const worker = createModelWorker({
		session: () => session,
		ledger: campaign,
		ledgerFactory: () => task,
		context: CONTEXT,
		taskId: "task-001",
		goal: "demo",
		decisionBuffer: { list: () => [{ action_ref: "data.record.set", arguments: {} }] },
		persistRequest: async (record) => {
			persisted.push(record);
			return { ok: true };
		},
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });

	assert.equal(providerCalls, 1, "the real provider request count is retained");
	assert.equal(result.ok, false);
	assert.equal(result.failure_mode, "reconciliation_required");
	assert.equal(result.reconciliation.provider_status, "unknown");
	assert.equal(result.reconciliation.pending.campaign.model_requests, 1);
	assert.equal(result.reconciliation.pending.task.model_requests, 1);
	assert.equal(campaign.pending().length, 1, "the Campaign hold is not refunded");
	assert.equal(task.pending().length, 1, "the Task hold is not refunded");
	assert.ok(
		persisted.some((record) => record.phase === "reconciliation_required" && record.provider_status === "unknown"),
		"a durable reconciliation record is written",
	);
	assert.equal(
		persisted.some((record) => record.phase === "committed"),
		false,
		"nothing is settled as success",
	);
	assert.equal(session.agent.streamFunction, originalStream, "the provider gate is restored after the run");
	void listeners;
});

test("LC-B2: a synthetic error message after dispatch is a provider error, not a success", async () => {
	const { session, listeners } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		return { ok: true };
	};
	session.prompt = async () => {
		await session.agent.streamFunction({}, { messages: [] });
		// The SDK turns a provider failure into a synthetic assistant message.
		emitMessageEnd(listeners, {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "provider boom",
		});
	};
	const { campaign, task } = makeLedgers();
	const persisted = [];
	const worker = createModelWorker({
		session: () => session,
		ledger: campaign,
		ledgerFactory: () => task,
		context: CONTEXT,
		taskId: "task-001",
		goal: "demo",
		decisionBuffer: { list: () => [{ action_ref: "data.record.set", arguments: {} }] },
		persistRequest: async (record) => {
			persisted.push(record);
			return { ok: true };
		},
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });

	assert.equal(providerCalls, 1);
	assert.equal(result.ok, false, "a synthetic error with no usage cannot be success");
	assert.equal(result.failure_mode, "provider_error");
	assert.equal(result.reconciliation.provider_status, "error");
	assert.equal(campaign.consumed().model_requests, 1, "the dispatched request is charged once");
	assert.equal(task.consumed().model_requests, 1);
	const committed = persisted.find((record) => record.phase === "committed");
	assert.ok(committed, "the dispatched request has a durable settlement");
	assert.equal(committed.provider_status, "error", "the settlement records the provider error");
});

test("LC-B3: a synthetic error BEFORE a refusal does not count a real request", async () => {
	const { session, listeners } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		return { ok: true };
	};
	session.prompt = async () => {
		try {
			await session.agent.streamFunction({}, { messages: [] });
		} catch {
			// The gate refuses before the provider; the SDK synthesizes an error.
		}
		emitMessageEnd(listeners, { role: "assistant", content: [], stopReason: "error", errorMessage: "refused" });
	};
	const campaign = createToolLedger({
		limit: { model_requests: 0, tool_calls: 10, input_chars: 0, wall_time_ms: 100000 },
	});
	const task = createToolLedger({ limit: { ...LIMIT } });
	const persisted = [];
	const worker = createModelWorker({
		session: () => session,
		ledger: campaign,
		ledgerFactory: () => task,
		context: CONTEXT,
		taskId: "task-001",
		goal: "demo",
		persistRequest: async (record) => {
			persisted.push(record);
			return { ok: true };
		},
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });

	assert.equal(providerCalls, 0, "a refusal before dispatch sends no provider request");
	assert.equal(result.failure_mode, "budget_exhausted");
	assert.equal(campaign.consumed().model_requests, 0, "the synthetic error is not charged");
	assert.equal(task.consumed().model_requests, 0);
	assert.equal(persisted.length, 0, "no reservation is written for a refused request");
});

test("LC-B4: an unresolved provider error cannot dispatch a Broker effect", async () => {
	const { session } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		throw new Error("provider transport boom");
	};
	session.prompt = async () => {
		await session.agent.streamFunction({}, { messages: [] });
	};
	const { campaign, task } = makeLedgers();
	const modelWorker = createModelWorker({
		session: () => session,
		ledger: campaign,
		ledgerFactory: () => task,
		context: CONTEXT,
		taskId: "task-001",
		goal: "demo",
		decisionBuffer: { list: () => [{ action_ref: "data.record.set", arguments: {} }] },
		persistRequest: async () => ({ ok: true }),
	});
	let brokerEffects = 0;
	const composite = createCompositeWorker({
		modelWorker,
		buffer: { setTask() {} },
		brokerWorker: {
			async run() {
				brokerEffects += 1;
				return { ok: true };
			},
		},
	});
	const result = await composite.run({ task: { task_id: "task-001", goal: { description: "demo" } } });

	assert.equal(providerCalls, 1);
	assert.equal(result.ok, false);
	assert.equal(result.failure_mode, "reconciliation_required");
	assert.equal(brokerEffects, 0, "no Broker effect after an unresolved provider request");
});

test("LC-B6: a failed reconciliation append still leaves the reserved hold on disk", async () => {
	const { session } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		throw new Error("provider transport boom");
	};
	session.prompt = async () => {
		await session.agent.streamFunction({}, { messages: [] });
	};
	const { campaign, task } = makeLedgers();
	const persisted = [];
	const worker = createModelWorker({
		session: () => session,
		ledger: campaign,
		ledgerFactory: () => task,
		context: CONTEXT,
		taskId: "task-001",
		goal: "demo",
		persistRequest: async (record) => {
			persisted.push(record);
			// The reservation succeeds; the reconciliation append fails.
			return record.phase === "reserved" ? { ok: true } : { ok: false, error: "injected reconciliation fsync failure" };
		},
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });

	assert.equal(providerCalls, 1);
	assert.equal(result.ok, false);
	assert.equal(result.failure_mode, "reconciliation_required");
	assert.equal(result.reconciliation.reconciliation_persisted, false, "the failure is reported, never hidden");
	assert.match(String(result.reconciliation.reconciliation_error), /reconciliation fsync failure/);
	assert.equal(campaign.pending().length, 1, "the Campaign hold survives a failed reconciliation append");
	assert.equal(task.pending().length, 1, "the Task hold survives a failed reconciliation append");
	assert.ok(
		persisted.some((record) => record.phase === "reserved"),
		"the earlier durable reserved record is the restart source",
	);
});

// ---------------------------------------------------------------------------
// B5. A reconciliation-only restart (durable): the hold is kept and a new
// provider dispatch is refused, using the REAL seeding path.
// ---------------------------------------------------------------------------

test("LC-B5: a reconciliation-only restart refuses a new provider dispatch", async () => {
	const summary = summarizeRequestLedger([
		requestEvent({
			phase: "reserved",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
		}),
		requestEvent({
			phase: "reconciliation_required",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
			provider_started: true,
			provider_status: "unknown",
		}),
	]);
	assert.ok(summary.unresolved >= 1, "the reconciliation keeps the request unresolved");
	const campaign = createToolLedger({
		limit: { ...LIMIT },
		baseReserved: {
			model_requests: summary.campaignPending.length,
			input_chars: summary.campaignPending.reduce((sum, note) => sum + note.inputChars, 0),
			pending: summary.campaignPending,
			committed: [...summary.committedReservations],
		},
	});
	const task = createToolLedger({
		limit: { ...LIMIT },
		baseReserved: reservedSeedForTask(summary.taskPending, summary.taskCommittedByTask, "task-001"),
	});
	const { session } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		return { ok: true };
	};
	session.prompt = async () => {
		await session.agent.streamFunction({}, { messages: [] });
	};
	const worker = createModelWorker({
		session: () => session,
		ledger: campaign,
		ledgerFactory: () => task,
		context: CONTEXT,
		taskId: "task-001",
		goal: "demo",
		reconciliationGuard: {
			unresolved: summary.unresolved,
			diagnostics: summary.diagnostics.length,
			runtimeBlocked: false,
		},
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });

	assert.equal(providerCalls, 0, "a reconciliation-only restart must not re-send a provider request");
	assert.equal(result.failure_mode, "reconciliation_required");
	assert.equal(result.provider_requests, 0);
	assert.equal(campaign.pending().length, 1, "the Campaign hold is retained");
	assert.equal(task.pending().length, 1, "the Task hold is retained");
});

// ---------------------------------------------------------------------------
// B7. SDK termination: aborted is a hard exit, never an executable decision.
// ---------------------------------------------------------------------------

test("LC-B7: an aborted SDK response is a hard exit, not an executable decision", async () => {
	const { session, listeners } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		return { ok: true };
	};
	session.prompt = async () => {
		await session.agent.streamFunction({}, { messages: [] });
		emitMessageEnd(listeners, { role: "assistant", content: [], stopReason: "aborted" });
	};
	const { campaign, task } = makeLedgers();
	const persisted = [];
	const worker = createModelWorker({
		session: () => session,
		ledger: campaign,
		ledgerFactory: () => task,
		context: CONTEXT,
		taskId: "task-001",
		goal: "demo",
		decisionBuffer: { list: () => [{ action_ref: "data.record.set", arguments: {} }] },
		persistRequest: async (record) => {
			persisted.push(record);
			return { ok: true };
		},
	});
	const result = await worker.run({ task: { task_id: "task-001", goal: { description: "demo" } } });

	assert.equal(providerCalls, 1);
	assert.equal(result.ok, false, "an aborted planning is a hard exit");
	assert.equal(result.failure_mode, "provider_aborted");
	assert.equal(campaign.consumed().model_requests, 1, "the occurred request stays charged");
	assert.equal(task.consumed().model_requests, 1);
	const committed = persisted.find((record) => record.phase === "committed");
	assert.ok(committed, "the request is durably settled");
	assert.equal(committed.provider_status, "aborted", "the durable record keeps the aborted category");
	assert.equal(committed.stop_reason, "aborted", "the durable record keeps the raw stopReason");
});

for (const stopReason of ["error", "aborted", "prompt_throw"]) {
	test(`LC-B8-${stopReason}: a synthetic SDK termination after settlement blocks the buffered decision`, async () => {
		const { session, listeners } = fakeSession();
		let providerCalls = 0;
		session.agent.streamFunction = async () => {
			providerCalls += 1;
			return {};
		};
		session.prompt = async () => {
			await session.agent.streamFunction({}, { messages: [] });
			emitMessageEnd(listeners, { role: "assistant", content: [], stopReason: "stop" });
			// The SDK can fail after the provider response, without a new reservation.
			if (stopReason === "prompt_throw") throw new Error("SDK planning failed after response settlement");
			emitMessageEnd(listeners, { role: "assistant", content: [], stopReason });
		};
		const { campaign, task } = makeLedgers();
		const persisted = [];
		const guard = { unresolved: 0, diagnostics: 0, runtimeBlocked: false };
		const worker = createModelWorker({
			session: () => session,
			ledger: campaign,
			ledgerFactory: () => task,
			context: CONTEXT,
			taskId: "task-001",
			goal: "demo",
			reconciliationGuard: guard,
			decisionBuffer: { list: () => [{ action_ref: "data.record.set", arguments: {} }] },
			persistRequest: async (record) => {
				persisted.push(record);
				return { ok: true };
			},
		});
		const result = await worker.run({ task: { task_id: "task-001" } });
		assert.equal(result.ok, false);
		assert.equal(result.failure_mode, stopReason === "aborted" ? "planning_aborted" : "planning_error");
		assert.equal(result.reconciliation.planning_status, stopReason === "aborted" ? "aborted" : "error");
		assert.equal(result.reconciliation.provider_status, "ok", "a synthetic message does not rewrite the provider fact");
		assert.equal(result.decisions, undefined);
		assert.equal(guard.runtimeBlocked, true);
		assert.equal(providerCalls, 1);
		assert.equal(campaign.consumed().model_requests, 1);
		assert.equal(task.consumed().model_requests, 1);
		assert.deepEqual(
			persisted.map((record) => record.phase),
			["reserved", "committed"],
		);
		assert.equal(summarizeRequestLedger(persisted.map((record) => requestEvent(record))).unresolved, 0);
	});
}

test("LC-B9: an unknown final response cannot inherit normal termination from an earlier response", async () => {
	const { session, listeners } = fakeSession();
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls += 1;
		return {};
	};
	session.prompt = async () => {
		for (const stopReason of ["toolUse", "pending"]) {
			await session.agent.streamFunction({}, { messages: [] });
			emitMessageEnd(listeners, { role: "assistant", content: [], stopReason });
		}
	};
	const { campaign, task } = makeLedgers();
	const worker = createModelWorker({
		session: () => session,
		ledger: campaign,
		ledgerFactory: () => task,
		context: CONTEXT,
		taskId: "task-001",
		goal: "demo",
		decisionBuffer: { list: () => [{ action_ref: "data.record.set", arguments: {} }] },
		persistRequest: async () => ({ ok: true }),
	});
	const result = await worker.run({ task: { task_id: "task-001" } });
	assert.equal(providerCalls, 2);
	assert.equal(result.ok, false);
	assert.equal(result.failure_mode, "planning_termination_unknown");
	assert.equal(result.reconciliation.planning_status, "unknown");
	assert.equal(campaign.consumed().model_requests, 2);
	assert.equal(task.consumed().model_requests, 2);
});

// ---------------------------------------------------------------------------
// C. Per-Task pending isolation and Campaign aggregation.
// ---------------------------------------------------------------------------
function requestEvent(payload) {
	return {
		event_type: "runtime.note",
		payload: { kind: "c6.request", campaign_id: "campaign-x", ...payload },
	};
}

test("LC-C1: each Task ledger is seeded with only its own pending and committed ids", () => {
	const events = [
		requestEvent({
			phase: "reserved",
			task_id: "task-A",
			request_id: "req-A",
			task_reservation_id: "task-res-A",
			campaign_reservation_id: "camp-res-A",
			input_chars: 100,
		}),
		requestEvent({
			phase: "reserved",
			task_id: "task-B",
			request_id: "req-B",
			task_reservation_id: "task-res-B",
			campaign_reservation_id: "camp-res-B",
			input_chars: 40,
		}),
		requestEvent({
			phase: "reserved",
			task_id: "task-C",
			request_id: "req-C",
			task_reservation_id: "task-res-C",
			campaign_reservation_id: "camp-res-C",
			input_chars: 7,
		}),
		requestEvent({
			phase: "committed",
			task_id: "task-C",
			request_id: "req-C",
			task_reservation_id: "task-res-C",
			campaign_reservation_id: "camp-res-C",
			input_chars: 7,
		}),
	];
	const summary = summarizeRequestLedger(events);
	const seedA = reservedSeedForTask(summary.taskPending, summary.taskCommittedByTask, "task-A");
	const seedB = reservedSeedForTask(summary.taskPending, summary.taskCommittedByTask, "task-B");
	const seedC = reservedSeedForTask(summary.taskPending, summary.taskCommittedByTask, "task-C");

	assert.deepEqual(
		seedA.pending.map((note) => note.reservation_id),
		["task-res-A"],
		"Task A's ledger contains only Task A's hold",
	);
	assert.deepEqual(
		seedB.pending.map((note) => note.reservation_id),
		["task-res-B"],
		"Task B's ledger contains only Task B's hold",
	);
	assert.equal(seedA.model_requests, 1);
	assert.equal(seedA.input_chars, 100);
	assert.equal(seedB.model_requests, 1);
	assert.equal(seedB.input_chars, 40);
	assert.equal(seedC.model_requests, 0, "the committed Task C has no pending hold");
	assert.deepEqual(seedC.committed, ["task-res-C"], "Task C's committed identity is its own");
	assert.equal(seedA.committed.length, 0, "Task A did not inherit Task C's committed id");

	// The Campaign ledger aggregates the union of the two Task holds.
	assert.deepEqual(summary.campaignPending.map((note) => note.reservation_id).sort(), ["camp-res-A", "camp-res-B"]);
	assert.equal(summary.unresolved, 2, "two unresolved requests remain");
});

test("LC-C2: a rebuilt Task ledger counts only its own pending hold", () => {
	const summary = summarizeRequestLedger([
		requestEvent({
			phase: "reserved",
			task_id: "task-A",
			request_id: "req-A",
			task_reservation_id: "task-res-A",
			campaign_reservation_id: "camp-res-A",
			input_chars: 100,
		}),
		requestEvent({
			phase: "reserved",
			task_id: "task-B",
			request_id: "req-B",
			task_reservation_id: "task-res-B",
			campaign_reservation_id: "camp-res-B",
			input_chars: 40,
		}),
	]);
	const ledgerA = createToolLedger({
		limit: { ...LIMIT },
		baseReserved: reservedSeedForTask(summary.taskPending, summary.taskCommittedByTask, "task-A"),
	});
	const ledgerB = createToolLedger({
		limit: { ...LIMIT },
		baseReserved: reservedSeedForTask(summary.taskPending, summary.taskCommittedByTask, "task-B"),
	});
	assert.equal(ledgerA.pending().length, 1);
	assert.equal(ledgerA.pending()[0].reservation_id, "task-res-A");
	assert.equal(ledgerB.pending().length, 1);
	assert.equal(ledgerB.pending()[0].reservation_id, "task-res-B");
	assert.equal(ledgerA.remaining().model_requests, LIMIT.model_requests - 1);
	assert.equal(ledgerB.remaining().model_requests, LIMIT.model_requests - 1);
});

// ---------------------------------------------------------------------------
// D. A joint commit requires BOTH reservation ids; partial/mismatched/
//    conflicting records never settle the request or release the other side.
// ---------------------------------------------------------------------------

test("LC-D1: a Task-only committed record does not settle the joint request", () => {
	const summary = summarizeRequestLedger([
		requestEvent({
			phase: "reserved",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
		}),
		requestEvent({
			phase: "committed",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			input_chars: 100,
		}),
	]);
	assert.equal(summary.consumed.model_requests, 0, "a partial committed record is not a joint success");
	assert.deepEqual(
		summary.campaignPending.map((note) => note.reservation_id),
		["camp-res-1"],
		"the Campaign side is not released",
	);
	assert.deepEqual(
		summary.taskPending.map((note) => note.reservation_id),
		["task-res-1"],
		"the Task side stays pending until a legal joint commit",
	);
	assert.ok(
		summary.diagnostics.some((d) => d.code === "invalid_committed"),
		"the invalid record is visible as a diagnostic",
	);
});

test("LC-D2: a Campaign-only committed record does not settle the joint request", () => {
	const summary = summarizeRequestLedger([
		requestEvent({
			phase: "reserved",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
		}),
		requestEvent({
			phase: "committed",
			task_id: "task-001",
			request_id: "req-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
		}),
	]);
	assert.equal(summary.consumed.model_requests, 0);
	assert.equal(summary.taskPending.length, 1);
	assert.equal(summary.campaignPending.length, 1);
	assert.ok(summary.diagnostics.some((d) => d.code === "invalid_committed"));
});

test("LC-D3: a mismatched committed record does not settle another request", () => {
	const summary = summarizeRequestLedger([
		requestEvent({
			phase: "reserved",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
		}),
		requestEvent({
			phase: "committed",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-OTHER",
			campaign_reservation_id: "camp-res-OTHER",
			input_chars: 100,
		}),
	]);
	assert.equal(summary.consumed.model_requests, 0);
	assert.equal(summary.taskPending.length, 1);
	assert.equal(summary.campaignPending.length, 1);
	assert.ok(
		summary.diagnostics.some((d) => d.reason === "task_reservation_mismatch"),
		"the mismatch is diagnosed",
	);
});

test("LC-D4: a full matching joint commit settles exactly once despite duplicates", () => {
	const committed = {
		phase: "committed",
		task_id: "task-001",
		request_id: "req-1",
		task_reservation_id: "task-res-1",
		campaign_reservation_id: "camp-res-1",
		input_chars: 100,
		tool_calls: 2,
	};
	const summary = summarizeRequestLedger([
		requestEvent({
			phase: "reserved",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
		}),
		requestEvent(committed),
		requestEvent(committed),
	]);
	assert.deepEqual(summary.consumed, { model_requests: 1, tool_calls: 2, input_chars: 100, wall_time_ms: 0 });
	assert.equal(summary.byTask.get("task-001").model_requests, 1);
	assert.equal(summary.campaignPending.length, 0);
	assert.equal(summary.taskPending.length, 0);
	assert.equal(summary.unresolved, 0);
});

test("LC-D5: reconciliation_required keeps the request pending and is not a release", () => {
	const summary = summarizeRequestLedger([
		requestEvent({
			phase: "reserved",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
		}),
		requestEvent({
			phase: "reconciliation_required",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
			provider_started: true,
			provider_status: "unknown",
		}),
	]);
	assert.equal(summary.consumed.model_requests, 0);
	assert.deepEqual(
		summary.campaignPending.map((note) => note.reservation_id),
		["camp-res-1"],
		"reconciliation is unresolved, not cancelled",
	);
	assert.deepEqual(
		summary.taskPending.map((note) => note.reservation_id),
		["task-res-1"],
	);
	assert.equal(summary.unresolved, 1);
});

test("LC-D6: a release after settlement cannot erase a real charge", () => {
	const summary = summarizeRequestLedger([
		requestEvent({
			phase: "reserved",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
		}),
		requestEvent({
			phase: "committed",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
		}),
		requestEvent({ phase: "released", request_id: "req-1", reason: "late_release" }),
	]);
	assert.equal(summary.consumed.model_requests, 1, "the committed charge survives a late release");
	assert.equal(summary.campaignPending.length, 0);
	assert.ok(summary.diagnostics.some((d) => d.code === "release_after_settlement"));
});

test("LC-D7: a legal release before dispatch cancels the hold without charging", () => {
	const summary = summarizeRequestLedger([
		requestEvent({
			phase: "reserved",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
		}),
		requestEvent({ phase: "released", request_id: "req-1", reason: "task_admission_refused" }),
	]);
	assert.equal(summary.consumed.model_requests, 0);
	assert.equal(summary.campaignPending.length, 0);
	assert.equal(summary.taskPending.length, 0);
	assert.equal(summary.unresolved, 0);
});

test("LC-D8: a release that contradicts a reconciliation cannot erase the unresolved hold", () => {
	const summary = summarizeRequestLedger([
		requestEvent({
			phase: "reserved",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
		}),
		requestEvent({
			phase: "reconciliation_required",
			task_id: "task-001",
			request_id: "req-1",
			task_reservation_id: "task-res-1",
			campaign_reservation_id: "camp-res-1",
			input_chars: 100,
			provider_started: true,
			provider_status: "unknown",
		}),
		requestEvent({ phase: "released", request_id: "req-1", reason: "foreign_release" }),
	]);
	assert.equal(summary.unresolved, 1, "a conflicting release must not resolve the request");
	assert.equal(summary.campaignPending.length, 1);
	assert.equal(summary.taskPending.length, 1);
	assert.ok(summary.diagnostics.some((d) => d.code === "release_after_reconciliation"));
});

/** Limit used by the per-side numeric table (5 requests / 1000 input each side). */
const TABLE_LIMIT = { model_requests: 5, tool_calls: 10, input_chars: 1000, wall_time_ms: 100000 };
function tableReserved() {
	return requestEvent({
		phase: "reserved",
		task_id: "task-a",
		campaign_id: "campaign-a",
		request_id: "req-1",
		task_reservation_id: "task-res-1",
		campaign_reservation_id: "camp-res-1",
		input_chars: 100,
	});
}
function tableReconciliation(commitStatus) {
	return requestEvent({
		phase: "reconciliation_required",
		task_id: "task-a",
		campaign_id: "campaign-a",
		request_id: "req-1",
		task_reservation_id: "task-res-1",
		campaign_reservation_id: "camp-res-1",
		input_chars: 100,
		provider_started: true,
		provider_status: "unknown",
		commit_status: commitStatus,
	});
}
function tableCommitted() {
	return requestEvent({
		phase: "committed",
		task_id: "task-a",
		campaign_id: "campaign-a",
		request_id: "req-1",
		task_reservation_id: "task-res-1",
		campaign_reservation_id: "camp-res-1",
		input_chars: 100,
		usage: { input: 1 },
		commit_status: { task: "committed", campaign: "committed" },
	});
}
function tableRebuild(summary) {
	return {
		campaign: createToolLedger({
			limit: { ...TABLE_LIMIT },
			baseConsumed: summary.consumed,
			baseReserved: {
				model_requests: summary.campaignPending.length,
				input_chars: summary.campaignPending.reduce((sum, note) => sum + note.inputChars, 0),
				pending: summary.campaignPending,
				committed: [...summary.committedReservations],
			},
		}),
		task: createToolLedger({
			limit: { ...TABLE_LIMIT },
			baseConsumed: { wall_time_ms: 0, ...(summary.byTask.get("task-a") ?? {}) },
			baseReserved: reservedSeedForTask(summary.taskPending, summary.taskCommittedByTask, "task-a"),
		}),
	};
}

test("LC-D9: the per-side responsibility table restores exact consumed/pending/remaining/input", () => {
	// Row 1: reserved only, result unknown → both sides hold, unresolved 1.
	{
		const summary = summarizeRequestLedger([tableReserved()]);
		assert.equal(summary.consumed.model_requests, 0);
		assert.equal(summary.byTask.size, 0);
		assert.equal(summary.campaignPending[0].inputChars, 100);
		assert.equal(summary.taskPending[0].inputChars, 100);
		assert.equal(summary.unresolved, 1);
		const rebuilt = tableRebuild(summary);
		assert.equal(rebuilt.campaign.remaining().model_requests, 4);
		assert.equal(rebuilt.campaign.remaining().input_chars, 900);
		assert.equal(rebuilt.task.remaining().model_requests, 4);
		assert.equal(rebuilt.task.remaining().input_chars, 900);
	}
	// Row 2: reconciliation Task committed / Campaign unknown → Task consumed, Campaign hold.
	{
		const summary = summarizeRequestLedger([
			tableReserved(),
			tableReconciliation({ task: "committed", campaign: "unknown" }),
		]);
		assert.deepEqual(summary.byTask.get("task-a"), { model_requests: 1, tool_calls: 0, input_chars: 100 });
		assert.equal(summary.consumed.model_requests, 0);
		assert.equal(summary.taskPending.length, 0);
		assert.equal(summary.campaignPending[0].inputChars, 100);
		assert.equal(summary.unresolved, 1);
		const rebuilt = tableRebuild(summary);
		assert.equal(rebuilt.task.remaining().model_requests, 4);
		assert.equal(rebuilt.task.remaining().input_chars, 900);
		assert.equal(rebuilt.campaign.remaining().model_requests, 4);
		assert.equal(rebuilt.campaign.remaining().input_chars, 900);
		assert.equal(rebuilt.task.consumed().input_chars, 100);
	}
	// Row 3: reconciliation Campaign committed / Task unknown → mirror.
	{
		const summary = summarizeRequestLedger([
			tableReserved(),
			tableReconciliation({ task: "unknown", campaign: "committed" }),
		]);
		assert.equal(summary.consumed.model_requests, 1);
		assert.equal(summary.consumed.input_chars, 100);
		assert.equal(summary.byTask.size, 0);
		assert.equal(summary.campaignPending.length, 0);
		assert.equal(summary.taskPending[0].inputChars, 100);
		assert.equal(summary.unresolved, 1);
		const rebuilt = tableRebuild(summary);
		assert.equal(rebuilt.campaign.remaining().model_requests, 4);
		assert.equal(rebuilt.campaign.remaining().input_chars, 900);
		assert.equal(rebuilt.task.remaining().model_requests, 4);
		assert.equal(rebuilt.task.remaining().input_chars, 900);
	}
	// Row 4: reconciliation both committed, no joint durable commit → charged but unresolved.
	{
		const summary = summarizeRequestLedger([
			tableReserved(),
			tableReconciliation({ task: "committed", campaign: "committed" }),
		]);
		assert.equal(summary.consumed.model_requests, 1);
		assert.equal(summary.consumed.input_chars, 100);
		assert.equal(summary.byTask.get("task-a").model_requests, 1);
		assert.equal(summary.campaignPending.length, 0);
		assert.equal(summary.taskPending.length, 0);
		assert.equal(summary.unresolved, 1, "both-side reconciliation is not a joint settlement");
		const rebuilt = tableRebuild(summary);
		assert.equal(rebuilt.campaign.remaining().model_requests, 4);
		assert.equal(rebuilt.task.remaining().model_requests, 4);
	}
	// Row 5: a later legal full committed closes it without double-charging.
	{
		const summary = summarizeRequestLedger([
			tableReserved(),
			tableReconciliation({ task: "committed", campaign: "committed" }),
			tableCommitted(),
			tableCommitted(),
		]);
		assert.equal(summary.consumed.model_requests, 1, "no double charge");
		assert.equal(summary.consumed.input_chars, 100);
		assert.equal(summary.byTask.get("task-a").model_requests, 1);
		assert.equal(summary.campaignPending.length, 0);
		assert.equal(summary.taskPending.length, 0);
		assert.equal(summary.unresolved, 0);
		const rebuilt = tableRebuild(summary);
		assert.equal(rebuilt.campaign.remaining().model_requests, 4);
		assert.equal(rebuilt.campaign.remaining().input_chars, 900);
		assert.equal(rebuilt.task.remaining().model_requests, 4);
		assert.equal(rebuilt.task.remaining().input_chars, 900);
	}
	// Row 6: normal full committed → charged, jointly settled.
	{
		const summary = summarizeRequestLedger([tableReserved(), tableCommitted()]);
		assert.equal(summary.consumed.model_requests, 1);
		assert.equal(summary.byTask.get("task-a").model_requests, 1);
		assert.equal(summary.unresolved, 0);
	}
});

test("LC-T1: the SDK termination classifier keeps error/aborted distinct from normal", () => {
	assert.deepEqual(classifyStopReason("error"), { providerStatus: "error", planningStatus: "error" });
	assert.deepEqual(classifyStopReason("aborted"), { providerStatus: "aborted", planningStatus: "aborted" });
	assert.deepEqual(classifyStopReason("stop"), { providerStatus: "ok", planningStatus: "normal" });
	assert.deepEqual(classifyStopReason("toolUse"), { providerStatus: "ok", planningStatus: "normal" });
	assert.deepEqual(classifyStopReason("length"), { providerStatus: "ok", planningStatus: "normal" });
	assert.deepEqual(classifyStopReason("deferred"), { providerStatus: "ok", planningStatus: "normal" });
	assert.deepEqual(classifyStopReason("pending"), { providerStatus: "unknown", planningStatus: "unknown" });
	assert.deepEqual(classifyStopReason(undefined), { providerStatus: "unknown", planningStatus: "unknown" });
	assert.deepEqual(classifyStopReason("unrecognized"), { providerStatus: "unknown", planningStatus: "unknown" });
});
