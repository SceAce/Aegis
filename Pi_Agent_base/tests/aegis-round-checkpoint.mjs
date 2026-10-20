import assert from "node:assert/strict";
import { projectBoard } from "../memory/board.mjs";
import { buildRamProjection } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";

const events = [
	{
		event_id: "episode",
		event_type: "episode.started",
		episode_id: "ep",
		source: { kind: "runtime" },
		payload: { task_id: "task", goal: { description: "solve" }, authorization: "workspace", budget: "unknown" },
	},
	{
		event_id: "cp1",
		event_type: "runtime.note",
		episode_id: "ep",
		source: { kind: "runtime" },
		payload: { kind: "round.checkpoint", turn_index: 1, text: "first conclusion", tool_count: 2, state_revision: 2 },
	},
	{
		event_id: "cp2",
		event_type: "runtime.note",
		episode_id: "ep",
		source: { kind: "runtime" },
		payload: { kind: "round.checkpoint", turn_index: 2, text: "second conclusion", tool_count: 1, state_revision: 3 },
	},
	{
		event_id: "cp3",
		event_type: "runtime.note",
		episode_id: "ep",
		source: { kind: "runtime" },
		payload: { kind: "round.checkpoint", turn_index: 3, text: "third conclusion", tool_count: 1, state_revision: 4 },
	},
];
const state = projectState(events);
assert.equal(state.round_checkpoints.length, 3);
const board = projectBoard(events);
assert.equal(board.byType.Artifact.length, 3);
assert.ok(board.byType.Artifact.every((node) => node.checkpoint));
const projection = buildRamProjection({ board, state, episodeId: "ep", budgetChars: 4000 });
assert.equal(projection.data.sections.checkpoints.shown, 1);
assert.equal(projection.data.checkpoints.length, 1, "RAM keeps only the latest checkpoint");
assert.ok(projection.text.includes("third conclusion"));
assert.equal(projection.data.sections.artifacts.shown, 0);
console.log(
	"Round checkpoint: every turn persists an unverified Board artifact and RAM carries bounded recent conclusions",
);
