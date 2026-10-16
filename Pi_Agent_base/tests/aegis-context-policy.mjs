import assert from "node:assert/strict";
import { contextPolicy, contextProjectionInput } from "../memory/context-policy.mjs";
import { buildRamProjection } from "../memory/ram.mjs";

const byType = {
	Fact: [],
	Refuted: [],
	Hint: [{ node_id: "hint", origin_event_id: "hint", episode_id: "ep", text: "BOARD_MARKER" }],
	Intent: [],
	Artifact: [],
};
const state = {
	version: 1,
	episodes: {
		ep: {
			task_id: "task",
			goal: { description: "goal" },
			authorization: "read workspace",
			budget: { requests: 8 },
			status: "open",
		},
	},
	pending_actions: { action: { action_id: "action", episode_id: "ep", tool_name: "cli", status: "unknown" } },
	knowledge_selections: [
		{ episode_id: "ep", knowledge_id: "k", source_uri: "https://example.invalid", content: "KNOWLEDGE_MARKER" },
	],
	experience_decisions: [],
};
const board = { byType, currentByType: byType };
for (const boardOn of [true, false])
	for (const knowledgeOn of [true, false]) {
		const policy = { board: boardOn, knowledge: knowledgeOn };
		const input = contextProjectionInput({ board, state, seed: null, policy });
		const p = buildRamProjection({ ...input, episodeId: "ep" });
		assert.equal(p.text.includes("BOARD_MARKER"), boardOn);
		assert.equal(p.text.includes("KNOWLEDGE_MARKER"), knowledgeOn);
		assert.ok(p.text.includes("action"));
		assert.ok(p.text.includes("unknown"));
		assert.ok(p.text.includes("read workspace"));
	}
assert.deepEqual(contextPolicy({}), { board: true, knowledge: true });
assert.throws(() => contextPolicy({ AEGIS_BOARD_FEEDBACK: "unknown" }));
assert.equal(state.knowledge_selections.length, 1);
assert.equal(board.byType.Hint.length, 1);
console.log(
	"Context policy: independent board/seed interventions preserve task, permissions and unknown actions without mutating source state",
);
