// MEM-01 board-off isolation + MEM-03 category trust/omission/proposal regressions.
// Pure projections over committed-shape rows; no provider, no target.
import assert from "node:assert/strict";
import { projectBoard } from "../memory/board.mjs";
import { contextProjectionInput } from "../memory/context-policy.mjs";
import { buildRamProjection } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";

const episodeId = "ep-mem";
const base = [
	{
		event_id: "start",
		event_type: "episode.started",
		episode_id: episodeId,
		source: { kind: "runtime" },
		payload: {
			task_id: "task-mem",
			goal: { description: "recover the handout secret" },
			authorization: { allowed: ["read", "cli"] },
			budget: { model_requests: 12, tool_calls: 20 },
		},
	},
	{
		event_id: "cp1",
		event_type: "runtime.note",
		episode_id: episodeId,
		source: { kind: "runtime" },
		payload: { kind: "round.checkpoint", turn_index: 1, text: "CP_MARKER_ONE", tool_count: 1, state_revision: 2 },
	},
	{
		event_id: "cp2",
		event_type: "runtime.note",
		episode_id: episodeId,
		source: { kind: "runtime" },
		payload: { kind: "round.checkpoint", turn_index: 2, text: "CP_MARKER_TWO", tool_count: 1, state_revision: 3 },
	},
	{
		event_id: "hint",
		event_type: "proposal.submitted",
		episode_id: episodeId,
		source: { kind: "llm" },
		payload: { kind: "claim", node_kind: "hint", text: "HINT_MARKER_ORIGINAL" },
	},
	{
		event_id: "action",
		event_type: "action.requested",
		episode_id: episodeId,
		source: { kind: "llm" },
		payload: { action_id: "a1", tool_name: "cli", input: { summary: { value: "print(1)" } } },
	},
	{
		event_id: "unresolved",
		event_type: "action.requested",
		episode_id: episodeId,
		source: { kind: "llm" },
		payload: { action_id: "a2", tool_name: "cli", input: { summary: { value: "print(2)" } } },
	},
];
const events = structuredClone(base);
const board = projectBoard(events);
const state = projectState(events);
// Mark a2 as an unknown/unresolved responsibility (committed shape used by RAM).
state.pending_actions = {
	...(state.pending_actions ?? {}),
	a2: { action_id: "a2", episode_id: episodeId, tool_name: "cli", status: "unknown" },
};

function projection(policy) {
	const input = contextProjectionInput({ board, state, seed: null, policy });
	return buildRamProjection({ ...input, episodeId });
}

// MEM01-01: board-off drops every board-derived feedback section, including the
// derived round checkpoints, while keeping task, permission, budget and unknown work.
const off = projection({ board: false, knowledge: true });
assert.ok(!off.text.includes("CP_MARKER_ONE"), "board-off must not inject round checkpoints");
assert.ok(!off.text.includes("CP_MARKER_TWO"), "board-off must not inject round checkpoints");
assert.equal(off.data.sections.checkpoints?.shown ?? 0, 0, "board-off checkpoint section must be empty");
assert.ok(!off.text.includes("HINT_MARKER_ORIGINAL"), "board-off must not inject proposals");
assert.ok(off.text.includes("read") && off.text.includes("cli"), "authorization must survive board-off");
assert.ok(off.text.includes("12") && off.text.includes("20"), "budget must survive board-off");
assert.ok(off.data.pending.items.some((row) => row.action_id === "a2" && row.status === "unknown"));
assert.ok(off.text.includes("recover the handout secret"), "goal must survive board-off");
assert.equal(off.data.task.status, "open");

// MEM01-02: board-on keeps the same checkpoints visible (no regression).
const on = projection({ board: true, knowledge: true });
assert.ok(on.text.includes("CP_MARKER_TWO"));
assert.ok(on.data.sections.checkpoints.shown >= 1);

// MEM01-03: knowledge-off drops automatic recall but not task/permission/budget.
const noKnowledge = projection({ board: true, knowledge: false });
assert.equal(noKnowledge.data.sections.knowledge?.shown ?? 0, 0);
assert.ok(noKnowledge.text.includes("cli"));
assert.ok(noKnowledge.data.pending.items.some((row) => row.status === "unknown"));

// MEM01-04: inputs are never mutated by policy application.
assert.deepEqual(board.byType.Hint.length, 1);
assert.equal(state.round_checkpoints.length, 2);
const frozen = Object.freeze({ ...state });
assert.doesNotThrow(() =>
	contextProjectionInput({ board, state: frozen, seed: null, policy: { board: false, knowledge: false } }),
);

// MEM03-01: an explicitly replaced proposal is superseded, and a round checkpoint
// never displaces a verified Fact or becomes one.
const replaced = projectBoard([
	...events,
	{
		event_id: "hint-replace",
		event_type: "proposal.submitted",
		episode_id: episodeId,
		source: { kind: "llm" },
		payload: {
			kind: "claim",
			node_kind: "hint",
			text: "HINT_MARKER_REVISED",
			replace_event_id: "hint",
		},
	},
]);
assert.equal(replaced.byType.Hint.filter((node) => node.effective !== false).length, 1);
const replacedProjection = buildRamProjection({ board: replaced, state, episodeId });
assert.ok(replacedProjection.text.includes("HINT_MARKER_REVISED"), "effective proposal stays visible");
assert.ok(!replacedProjection.text.includes("HINT_MARKER_ORIGINAL"), "replaced proposal must not stay as guidance");
assert.equal(
	replacedProjection.data.sections.checkpoints.items.every((row) => row.trust === "unverified"),
	true,
	"checkpoints are model claims, never verified",
);

// MEM03-02: category trust classes stay explicit and every section exposes omission.
const trustOf = (section) => new Set((on.data.sections[section]?.items ?? []).map((row) => row.trust));
assert.deepEqual([...trustOf("checkpoints")], ["unverified"]);
assert.deepEqual([...trustOf("tools")], ["observed"]);
for (const row of on.data.sections.checkpoints.items) assert.notEqual(row.trust, "verified");
for (const section of Object.values(on.data.sections))
	assert.ok(
		Number.isInteger(section.total) &&
			Number.isInteger(section.shown) &&
			Number.isInteger(section.omitted) &&
			section.total === section.shown + section.omitted,
		"each section must expose consistent total/shown/omitted",
	);

// MEM03-03: at the fixed 4k budget, knowledge stays bounded and core state is preserved.
const knowledgeState = {
	...state,
	knowledge_selections: Array.from({ length: 4 }, (_, i) => ({
		episode_id: episodeId,
		knowledge_id: `k${i}`,
		source_uri: "https://reference.invalid/x",
		content: `KNOWLEDGE_ITEM_${i} ${"k".repeat(220)}`,
	})),
};
const capped = buildRamProjection({ board, state: knowledgeState, episodeId });
assert.ok(capped.data.sections.knowledge.shown <= 4, "knowledge selection stays capped");
assert.equal(capped.data.sections.knowledge.total, 4);
assert.ok(capped.text.length <= 4000, "RAM stays inside the fixed budget");
assert.ok(
	capped.data.pending.items.some((row) => row.status === "unknown"),
	"pending responsibility survives",
);
assert.ok(capped.text.includes("recover the handout secret"), "goal survives budget pressure");

console.log(
	"RAM memory defects: board-off drops derived checkpoints while keeping task/auth/budget/unknown; category trust, proposal replacement and 4k omission passed",
);
