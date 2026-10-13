#!/usr/bin/env node
// Aegis C6-P3 / SDK-L3 — request/tool ledger and total-input gate.
//
// Proves: every provider request and tool call is admitted BEFORE the call; a
// 0/1/exhausted budget boundary is exact; the total-input estimate that would
// exceed the configured limit is refused before the request; usage sources are
// labelled measured/estimated and unobservable tokens/currency stay unknown.
//
// Run:
//   node --test Pi_Agent_base/tests/aegis-c6-ledger-input.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelWorker } from "../memory/campaign/c6-model-worker.mjs";
import { createToolLedger, normalizeUsage } from "../memory/campaign/c6-tool-ledger.mjs";

test("the ledger gates provider requests before the call", () => {
	const ledger = createToolLedger({
		limit: { model_requests: 1, tool_calls: 1, input_chars: 1000, wall_time_ms: 1000 },
		clock: () => 0,
	});
	const admitted = ledger.admitRequest({ inputChars: 100 });
	assert.equal(admitted.ok, true, admitted.reason);
	// The reservation exists BEFORE the request commits.
	assert.equal(ledger.snapshot().pending_reservations.length, 1);
	ledger.commitRequest({
		reservation_id: admitted.reservation_id,
		inputChars: 100,
		usage: { input: 10, output: 5, totalTokens: 15 },
	});
	const second = ledger.admitRequest({ inputChars: 100 });
	assert.equal(second.ok, false, "a second request must be refused at the exact limit");
	assert.match(second.reason, /exhausted/);
});

test("the ledger gates tool calls before the call", () => {
	const ledger = createToolLedger({
		limit: { model_requests: 10, tool_calls: 1, input_chars: 0, wall_time_ms: 1000 },
		clock: () => 0,
	});
	assert.equal(ledger.admitTool({ tool_name: "aegis_observe" }).ok, true);
	const second = ledger.admitTool({ tool_name: "aegis_observe" });
	assert.equal(second.ok, false, "a second tool call must be refused at the exact limit");
	assert.match(second.reason, /exhausted/);
});

test("a total-input estimate over the limit is refused before the request", () => {
	const ledger = createToolLedger({
		limit: { model_requests: 10, tool_calls: 10, input_chars: 100, wall_time_ms: 1000 },
		clock: () => 0,
	});
	const refused = ledger.admitRequest({ inputChars: 101 });
	assert.equal(refused.ok, false);
	assert.match(refused.reason, /exceed/);
});

test("the ledger reports measured vs estimated vs unknown sources", () => {
	const ledger = createToolLedger({
		limit: { model_requests: 1, tool_calls: 1, input_chars: 1000, wall_time_ms: 1000 },
		clock: () => 0,
	});
	const admitted = ledger.admitRequest({ inputChars: 50 });
	ledger.commitRequest({
		reservation_id: admitted.reservation_id,
		inputChars: 50,
		usage: { input: 10, output: 2, totalTokens: 12 },
	});
	const snap = ledger.snapshot();
	assert.equal(snap.usage_sources.model_requests, "measured");
	assert.equal(snap.usage_sources.input_chars, "estimated");
	assert.equal(snap.usage_sources.tokens, "unknown");
	assert.equal(snap.usage_sources.currency, "unknown");
	assert.equal(snap.consumed.model_requests, 1);
});

test("normalizeUsage never fabricates a number when usage is missing", () => {
	const missing = normalizeUsage(null);
	assert.equal(missing.input, null);
	assert.equal(missing.totalTokens, null);
	assert.equal(missing.source, "unknown");
	const present = normalizeUsage({ input: 5, output: 3, totalTokens: 8 });
	assert.equal(present.source, "estimated");
	assert.equal(present.input, 5);
});

test("the model worker refuses a request whose input estimate exceeds the limit", async () => {
	const ledger = createToolLedger({
		limit: { model_requests: 10, tool_calls: 10, input_chars: 10, wall_time_ms: 1000 },
		clock: () => 0,
	});
	let prompted = 0;
	const worker = createModelWorker({
		session: () => ({
			getActiveToolNames: () => [],
			subscribe: () => () => {},
			prompt: async () => {
				prompted += 1;
			},
		}),
		ledger,
		context: { max_total_input_chars: 10, output_reserve_chars: 0, strategy: "bounded_ram" },
		taskId: "task-x",
		goal: "a goal long enough to exceed the tiny limit",
		ramProvider: () => "ram",
	});
	const result = await worker.run({ task: { task_id: "task-x" } });
	assert.equal(result.ok, false);
	// The per-request context WINDOW is a distinct gate from the cumulative request
	// budget: an input that cannot fit the window is refused before the call.
	assert.equal(result.failure_mode, "context_window_exceeded");
	assert.equal(prompted, 0, "the model must NOT be prompted when the input estimate exceeds the limit");
});
