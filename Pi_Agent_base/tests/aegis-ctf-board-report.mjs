// Report accounting for the CTF board/seed pilot: every attempt on disk is
// counted, provider/transport stops are separated from budget/time/debug stops,
// missing usage stays unknown (never 0), and an all-groups-failed calibration is
// not declared invalid by itself. Offline synthetic runs under a temp dir only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportCtfPilot } from "../fixtures/ctf-board-report.mjs";

const root = mkdtempSync(join(tmpdir(), "aegis-ctf-report-"));
const events = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");
function attempt(task, id, files) {
	const dir = join(root, task, "runs", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "events.jsonl"),
		events([
			{ event_id: "e1", event_type: "episode.started", payload: {} },
			...(files.requestPolicy
				? [{ event_id: "e2", event_type: "request.projected", payload: { context_policy: files.requestPolicy } }]
				: []),
		]),
	);
	if (files.result) writeFileSync(join(dir, "result.json"), JSON.stringify(files.result));
	if (files.experiment) writeFileSync(join(dir, "experiment.json"), JSON.stringify(files.experiment));
	if (files.assistants) writeFileSync(join(dir, "assistant.json"), JSON.stringify(files.assistants));
	if (files.requests) writeFileSync(join(dir, "requests.json"), JSON.stringify(files.requests));
	if (files.operations) writeFileSync(join(dir, "operations.json"), JSON.stringify(files.operations));
	return dir;
}
const baseResult = {
	task: "task-a",
	attempt_id: "a-base",
	verified_success: false,
	elapsed_ms: 1000,
	requests: 4,
	tool_calls: 3,
	cli_calls: 2,
	proposal_count: 1,
	knowledge_queries: [],
	knowledge_visible_requests: 0,
	stop: "budget",
	error: null,
	chain_ok: true,
};
try {
	// 1. Provider transport error recorded as the last assistant stop.
	attempt("task-a", "p-provider", {
		result: { ...baseResult, attempt_id: "p-provider", mode: "A", stop: "settled", error: null },
		assistants: [
			{ role: "assistant", stopReason: "stop", content: [], usage: { input: 10, output: 2 } },
			{ role: "assistant", stopReason: "error", errorMessage: "Connection error", content: [] },
		],
	});
	// 2. Harness budget stop whose synthetic terminal message is stopReason "error".
	attempt("task-a", "p-budget", {
		result: { ...baseResult, attempt_id: "p-budget", mode: "B", stop: "budget", error: "pilot_budget_exhausted" },
		assistants: [{ role: "assistant", stopReason: "error", errorMessage: "pilot_budget_exhausted", content: [] }],
		requests: [{ request: 1, input_chars: 100, ram: { sections: {} } }],
	});
	// 3. Debug harness attempt with only experiment.json (no result.json at all).
	attempt("task-a", "p-debug", { experiment: { attempt_id: "p-debug", mode: "D", debug: true } });
	// 4. Successful attempt with provider-unknown usage.
	attempt("task-b", "p-ok", {
		result: { ...baseResult, task: "task-b", attempt_id: "p-ok", mode: "C", verified_success: true, stop: "settled" },
		assistants: [{ role: "assistant", stopReason: "stop", content: [] }],
		requestPolicy: { board: false, knowledge: true },
	});

	const report = reportCtfPilot(root);
	const byId = Object.fromEntries(report.attempts.map((row) => [row.attempt_id, row]));
	assert.deepEqual(Object.keys(byId).sort(), ["p-budget", "p-debug", "p-ok", "p-provider"]);
	assert.equal(report.totals.attempts, 4, "every attempt on disk must be counted");
	assert.equal(report.totals.attempts_with_result, 3);

	// Provider error and budget stop are separate categories.
	assert.equal(byId["p-provider"].outcome, "provider_error");
	assert.equal(byId["p-budget"].outcome, "request_limit", "harness budget stop is not a provider error");
	assert.equal(byId["p-budget"].provider_error, false);
	assert.equal(byId["p-debug"].outcome, "debug_incomplete");
	assert.equal(byId["p-ok"].outcome, "success");
	assert.equal(report.totals.provider_errors, 1);
	assert.equal(report.totals.budget_stops, 1);
	assert.equal(report.totals.incomplete_attempts, 1);

	// Usage: reported only when actually present; otherwise literal unknown.
	assert.deepEqual(byId["p-ok"].usage, {
		input: null,
		output: null,
		cacheRead: null,
		cacheWrite: null,
		totalTokens: null,
		source: "unknown",
	});
	assert.equal(byId["p-provider"].usage.source, "provider_reported");
	assert.equal(byId["p-provider"].usage.input, 10);

	// Recording arbitrary, incomplete groups does not prove paired conditions.
	// Conversely, task failure alone is not the reason for invalidating a group.
	assert.equal(report.totals.effect_comparison_valid, false);
	assert.equal(report.totals.effect_comparison_reason, "paired_conditions_not_verified");
	assert.equal(report.totals.verified_success, 1);

	// Recorded policy stays visible per attempt.
	assert.deepEqual(byId["p-ok"].recorded_policy, [{ board: false, knowledge: true }]);

	const written = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
	assert.equal(written.totals.attempts, 4);
	const md = readFileSync(join(root, "REPORT.md"), "utf8");
	assert.match(md, /p-debug/, "incomplete/debug attempts are listed, not dropped");
	assert.match(md, /p-budget/);

	// Second pass with only failures must not flip validity to false.
	const empty = mkdtempSync(join(tmpdir(), "aegis-ctf-report-empty-"));
	try {
		const emptyReport = reportCtfPilot(empty);
		assert.equal(emptyReport.totals.attempts, 0);
		assert.equal(emptyReport.totals.effect_comparison_valid, false);
		assert.equal(emptyReport.totals.effect_comparison_reason, "no_attempts");
	} finally {
		rmSync(empty, { recursive: true, force: true });
	}
	console.log(
		"CTF board report: all attempts counted, provider/budget/debug stops separated, usage unknown, failed groups not declared invalid",
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
