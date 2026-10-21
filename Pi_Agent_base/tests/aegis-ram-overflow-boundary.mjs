// RAM footer / compression boundary: a projection must never abort because of
// its OWN serialized bookkeeping. The footer (overflow flags, section counts,
// drop counters) is part of the byte budget; it is written before the final
// length is measured, not after.
//
// This is a regression for the 2026-10-21 tanzhijian-003 session: a RAM with
// 3 knowledge references, 8 proposals, 1 checkpoint and 2 tool pairs was
// serialized as 8019/8000 bytes, the observer aborted the provider request, and
// the user saw an empty assistant reply six times. The optional rows were all
// still present, so the "overflow" was bookkeeping, not missing responsibility.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRamProjection } from "../memory/ram.mjs";

const ep = "ep-overflow-boundary";
const long = (label, size) => `${label} ${"x".repeat(size)}`;

function board() {
	const currentByType = { Intent: [], Hint: [], Artifact: [] };
	currentByType.Intent.push({
		node_id: "subgoal",
		origin_event_id: "ev-subgoal",
		episode_id: ep,
		type: "Intent",
		text: long("switch to the new target and confirm code execution", 20),
		scope: "exploit",
		status: "candidate",
	});
	for (let i = 0; i < 8; i += 1) {
		currentByType.Hint.push({
			node_id: `hint-${i}`,
			origin_event_id: `ev-hint-${i}`,
			episode_id: ep,
			type: "Hint",
			text: long(`claim-${i}`, 250),
			scope: "exploit",
			status: "candidate",
		});
	}
	for (let i = 0; i < 2; i += 1) {
		currentByType.Intent.push({
			node_id: `call-${i}`,
			origin_event_id: `ev-call-${i}`,
			episode_id: ep,
			action_id: `a-${i}`,
			tool_name: "bash",
			input: { summary: { value: { cmd: long(`cmd-${i}`, 240) } } },
		});
		currentByType.Artifact.push({
			node_id: `done-${i}`,
			origin_event_id: `ev-done-${i}`,
			episode_id: ep,
			action_id: `a-${i}`,
			tool_name: "bash",
			result_summary: { value: { out: long(`out-${i}`, 240) } },
			transport: { tool_ok: true },
		});
	}
	return { currentByType };
}

function state() {
	return {
		version: 150,
		episodes: {
			[ep]: {
				episode_id: ep,
				task_id: "task",
				status: "open",
				goal: { description: long("goal", 300) },
				authorization: { workspace: "/x" },
				budget: { model_requests: 100 },
			},
		},
		pending_actions: {},
		round_checkpoints: [1, 2, 3].map((n) => ({
			episode_id: ep,
			text: long(`checkpoint-${n}`, 300),
			turn_index: n,
			tool_count: n * 4,
		})),
		knowledge_selections: [0, 1, 2].map((i) => ({
			episode_id: ep,
			knowledge_id: `k-${i}`,
			source_uri: `https://example.com/k-${i}`,
			source_kind: "external_reference",
			source_digest: `sha256:${String(i).repeat(64)}`,
			topic: long(`topic-${i}`, 40),
			section: ["section", "sub", "subsub"],
			content: long(`knowledge-content-${i}`, 600),
			line_start: 10,
			line_end: 20,
		})),
		experience_decisions: [],
	};
}

test("optional RAM content never produces a false overflow at the footer boundary", () => {
	// 7278..7299 used to serialize as 7300 bytes with `core_overflow: false` and
	// several droppable rows still present. Scan a wider band so a future footer
	// change cannot reintroduce a 1-2 byte cliff.
	for (let budget = 6000; budget <= 8000; budget += 1) {
		const p = buildRamProjection({ board: board(), state: state(), episodeId: ep, budgetChars: budget });
		const parsed = JSON.parse(p.text);
		assert.deepEqual(parsed, p.data, `budget=${budget}: data and text disagree`);
		assert.equal(p.data.meta.ram_estimated_chars, p.text.length, `budget=${budget}: stale footer`);
		assert.equal(p.data.meta.ram_budget_chars, budget);
		assert.equal(p.overflow, p.text.length > budget, `budget=${budget}: overflow flag disagrees with text`);
		if (!p.core_overflow) {
			assert.ok(p.text.length <= budget, `budget=${budget}: optional content overflowed (${p.text.length})`);
			assert.equal(p.data.meta.overflow, false, `budget=${budget}: false overflow flag`);
			assert.equal(p.data.meta.core_overflow, false, `budget=${budget}: false core overflow`);
			assert.equal(p.data.meta.pad, "", `budget=${budget}: padding should be relaxed when it fits`);
		}
		for (const section of p.sections) {
			assert.equal(section.shown + section.omitted, section.total, `budget=${budget}: section ${section.id}`);
		}
	}
});

test("a genuine mandatory-core overflow is still reported and keeps task/pending", () => {
	const fixture = state();
	for (let i = 0; i < 700; i += 1) {
		fixture.pending_actions[`pending-${i}`] = {
			action_id: `pending-identity-${i}-${"z".repeat(20)}`,
			episode_id: ep,
			tool_name: "write",
			status: "unknown",
		};
	}
	const p = buildRamProjection({ board: board(), state: fixture, episodeId: ep, budgetChars: 4000 });
	assert.equal(p.text.length > 4000, true);
	assert.equal(p.overflow, true);
	assert.equal(p.core_overflow, true);
	assert.equal(p.data.meta.overflow, true);
	assert.equal(p.data.meta.core_overflow, true);
	assert.equal(p.data.meta.pad, "xx");
	assert.equal(p.data.meta.ram_estimated_chars, p.text.length);
	assert.ok(p.text.includes("pending-identity-0"), "pending responsibility survives");
	assert.ok(p.text.includes("task"), "task identity survives");
});

test("a selected knowledge row remains reserved in a full but non-core-overflow working set", () => {
	const p = buildRamProjection({ board: board(), state: state(), episodeId: ep, budgetChars: 5000 });
	assert.equal(p.core_overflow, false);
	assert.ok(p.text.length <= 5000);
	const knowledge = p.sections.find((section) => section.id === "knowledge");
	assert.ok(knowledge && knowledge.shown >= 1, "deliberate knowledge was dropped before optional history");
	assert.ok(p.text.includes("knowledge-content-0"), "selected knowledge content is visible");
});
