// RAM aliases are stable when the caller supplies an Episode-level registry.
import assert from "node:assert/strict";
import test from "node:test";
import { buildRamProjection } from "../memory/ram.mjs";

const ep = "ep-alias";
function fact(id, text) {
	return { node_id: id, origin_event_id: `ev-${id}`, episode_id: ep, type: "Fact", text, status: "verified" };
}
function fixture(extra = []) {
	const call = {
		node_id: "call",
		origin_event_id: "ev-call",
		episode_id: ep,
		type: "Intent",
		action_id: "a1",
		tool_name: "read",
		input: { path: "target.txt" },
		text: "read",
	};
	const done = {
		node_id: "done",
		origin_event_id: "ev-done",
		episode_id: ep,
		type: "Artifact",
		action_id: "a1",
		tool_name: "read",
		response: "observed",
		text: "read",
	};
	return {
		board: {
			currentByType: { Fact: [fact("one", "one fact"), ...extra], Intent: [call], Artifact: [done] },
			byType: {},
		},
		state: {
			version: 1,
			episodes: {
				[ep]: {
					task_id: "task",
					goal: { description: "goal" },
					status: "active",
					authorization: {},
					budget: {},
				},
			},
			pending_actions: {},
			knowledge_selections: [],
			round_checkpoints: [],
			experience_decisions: [],
		},
	};
}
function aliasFor(projection, id) {
	return Object.entries(projection.data.refs).find(([, row]) => row.id === id)?.[0] ?? null;
}

test("the same canonical event keeps the same alias across projections", () => {
	const registry = {};
	const first = buildRamProjection({ ...fixture(), episodeId: ep, aliasRegistry: registry });
	const a1 = aliasFor(first, "ev-one");
	assert.ok(a1);
	const second = buildRamProjection({
		...fixture([fact("two", "second fact")]),
		episodeId: ep,
		budgetChars: 3000,
		aliasRegistry: registry,
	});
	const a2 = aliasFor(second, "ev-one");
	assert.equal(a2, a1, "same event must not be renumbered by later selection");
	assert.notEqual(aliasFor(second, "ev-two"), a1);
	assert.equal(aliasFor(second, "one"), aliasFor(first, "one"), "same node stays stable");
	assert.equal(aliasFor(second, "a1"), aliasFor(first, "a1"), "same action stays stable");
	assert.equal(aliasFor(second, "ev-done"), aliasFor(first, "ev-done"), "same action event stays stable");
	assert.equal(
		Object.keys(second.data.refs).length,
		new Set(Object.values(second.data.refs).map((row) => `${row.type}:${row.id}`)).size,
		"each canonical identity has one alias",
	);
});

test("without a registry aliases remain projection-local", () => {
	const first = buildRamProjection({ ...fixture(), episodeId: ep });
	const second = buildRamProjection({ ...fixture([fact("two", "second fact")]), episodeId: ep });
	assert.ok(first.data.refs.r0);
	assert.ok(second.data.refs.r0);
});
