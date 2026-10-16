import assert from "node:assert/strict";
import { test } from "node:test";
import { projectBoard } from "../memory/board.mjs";
import { buildRamProjection } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";

const ep = "ep-generic";
const src = (kind) => ({ kind, actor_id: "test" });
function event(id, type, payload, kind = "runtime", episode = ep) {
	return {
		event_id: id,
		event_type: type,
		episode_id: episode,
		source: src(kind),
		payload,
		recorded_at: "2026-01-01T00:00:00Z",
	};
}
function start() {
	return event("start", "episode.started", {
		task_id: "task-generic",
		goal: { description: "Inspect a document and compile a local report" },
		authorization: { read: ["document.txt"] },
		budget: { tool_calls: 10 },
	});
}
function projection(events, budgetChars = 4000) {
	return buildRamProjection({ board: projectBoard(events), state: projectState(events), episodeId: ep, budgetChars });
}

test("ABC-A1 RAM is parseable JSON with complete size and explicit observed trust", () => {
	const rows = [
		start(),
		event("request", "action.requested", {
			action_id: "a",
			tool_name: "bash",
			input: { command: "opaque document processing" },
		}),
		event("result", "action.completed", {
			action_id: "a",
			tool_name: "bash",
			content_excerpt: "report complete",
			transport: { tool_ok: true },
		}),
	];
	const p = projection(rows);
	const data = JSON.parse(p.text);
	assert.equal(data.version, "3.0");
	assert.equal(data.meta.ram_estimated_chars, p.text.length);
	assert.ok(p.text.length <= 4000);
	assert.equal(data.sections.tools.items[0].trust, "observed");
	assert.equal(data.sections.facts.items.length, 0);
	assert.equal(data.task.total_goal, "Inspect a document and compile a local report");
});

test("ABC-A2 arbitrary shell success-like text is opaque and does not acquire domain meaning", () => {
	for (const text of [
		"HTTP 200 Login Success!",
		"BUILD SUCCEEDED",
		"payments settled",
		"42 tests passed",
		"all permissions granted",
	]) {
		const rows = [
			start(),
			event("r", "action.requested", { action_id: "a", tool_name: "bash", input: { command: "opaque" } }),
			event("c", "action.completed", {
				action_id: "a",
				tool_name: "bash",
				content_excerpt: text,
				transport: { tool_ok: true },
			}),
		];
		const data = JSON.parse(projection(rows).text);
		assert.equal(data.sections.facts.items.length, 0);
		assert.equal(data.sections.refuted.items.length, 0);
		assert.ok(!("http_status" in data.sections.tools.items[0]));
		assert.ok(!("business_status" in data.sections.tools.items[0]));
	}
});

test("ABC-B1 explicit proposal can retain older action without promoting its conclusion", () => {
	const rows = [start()];
	for (let i = 0; i < 12; i++) {
		rows.push(
			event(`r-${i}`, "action.requested", { action_id: `a-${i}`, tool_name: "read", input: { path: `part-${i}.txt` } }),
		);
		rows.push(
			event(`c-${i}`, "action.completed", {
				action_id: `a-${i}`,
				tool_name: "read",
				content_excerpt: `RESULT_${i}_END`,
				transport: { tool_ok: true },
			}),
		);
	}
	rows.push(
		event(
			"claim",
			"proposal.submitted",
			{
				kind: "claim",
				text: "Earlier document might explain the issue",
				source_refs: [{ ref_type: "event", ref_id: "c-0" }],
			},
			"llm",
		),
	);
	const data = JSON.parse(projection(rows).text);
	assert.ok(JSON.stringify(data.sections.tools.items).includes("RESULT_0_END"));
	assert.equal(data.sections.proposals.items[0].trust, "unverified");
	assert.equal(data.sections.facts.items.length, 0);
});

test("ABC-B2 ordinary assistant text is not a proposal", () => {
	const data = JSON.parse(
		projection([
			start(),
			event(
				"assistant",
				"message.completed",
				{ role: "assistant", text_excerpt: "The build is definitely correct" },
				"llm",
			),
		]).text,
	);
	assert.equal(data.sections.proposals.items.length, 0);
	assert.equal(data.sections.facts.items.length, 0);
});
