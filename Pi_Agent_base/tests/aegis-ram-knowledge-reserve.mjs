// A selected knowledge row is a deliberate retrieval: a full RAM must not
// silently drop it behind optional checkpoints/tool history. Facts and pending
// responsibility keep priority; the reserve only guarantees one knowledge row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRamProjection } from "../memory/ram.mjs";

const ep = "ep-knowledge-reserve";
const long = (label) => `${label} ${"x".repeat(240)}`;

function board() {
	const currentByType = { Intent: [], Artifact: [] };
	for (let i = 0; i < 10; i += 1) {
		currentByType.Intent.push({
			node_id: `intent-${i}`,
			origin_event_id: `ev-intent-${i}`,
			episode_id: ep,
			action_id: `act-${i}`,
			tool_name: "cli",
			input: { summary: { value: { code: long(`input-${i}`) } } },
		});
		currentByType.Artifact.push({
			node_id: `artifact-${i}`,
			origin_event_id: `ev-artifact-${i}`,
			episode_id: ep,
			action_id: `act-${i}`,
			tool_name: "cli",
			result_summary: { value: { observed: long(`output-${i}`) } },
			transport: { tool_ok: true },
		});
	}
	return { currentByType };
}

function state(withKnowledge) {
	return {
		episodes: { [ep]: { episode_id: ep, task_id: "task-web", status: "open" } },
		pending_actions: {},
		round_checkpoints: [1, 2, 3].map((n) => ({
			episode_id: ep,
			text: long(`checkpoint-${n}`),
			turn_index: n,
			tool_count: n * 4,
		})),
		knowledge_selections: withKnowledge
			? [
					{
						episode_id: ep,
						knowledge_id: "web-sqli-union-blind.json#5",
						source_uri: "file:///cards/web-sqli-union-blind.md",
						source_kind: "local_document",
						topic: "SQL 注入：联合查询与盲注",
						section: ["SQL 注入：联合查询与盲注", "Do"],
						content: long("KNOWLEDGE_RESERVE_624"),
						line_start: 14,
						line_end: 17,
					},
				]
			: [],
	};
}

test("a selected knowledge row survives a full RAM", () => {
	const p = buildRamProjection({ board: board(), state: state(true), episodeId: ep, budgetChars: 3000 });
	assert.ok(p.text.length <= 3000, `RAM exceeded budget: ${p.text.length}`);
	const knowledge = p.sections.find((section) => section.id === "knowledge");
	assert.ok(knowledge, "knowledge section missing");
	assert.equal(knowledge.shown >= 1, true, "selected knowledge was dropped");
	assert.ok(p.text.includes("KNOWLEDGE_RESERVE_624"), "knowledge content is not visible");
});

test("without a selection the knowledge section is absent", () => {
	const p = buildRamProjection({ board: board(), state: state(false), episodeId: ep, budgetChars: 3000 });
	assert.equal(
		p.sections.some((section) => section.id === "knowledge"),
		false,
	);
});
