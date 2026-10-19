// A proposal may cite the RAM ref aliases (r0, r1, ...) it actually saw.
// The alias must resolve to a committed same-Episode event/node/action; aliases
// never grant proof and a foreign/unknown alias is still rejected.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectProposalRefs } from "../memory/proposal-refs.mjs";

const ep = "ep-1";
const events = [
	{ event_id: "e-event", episode_id: ep, event_digest: "sha256:e", event_type: "observation.captured", payload: {} },
	{
		event_id: "e-action",
		episode_id: ep,
		event_digest: "sha256:a",
		event_type: "action.completed",
		payload: { action_id: "act-1" },
	},
	{ event_id: "e-node", episode_id: ep, event_digest: "sha256:n", event_type: "proposal.submitted", payload: {} },
	{
		event_id: "e-outcome",
		episode_id: ep,
		event_digest: "sha256:o",
		event_type: "outcome.recorded",
		payload: { outcome_id: "out-1" },
	},
	{
		event_id: "e-foreign",
		episode_id: "ep-2",
		event_digest: "sha256:f",
		event_type: "observation.captured",
		payload: {},
	},
];
const board = {
	nodes: [
		{ node_id: "n-event", origin_event_id: "e-event", episode_id: ep, effective: true, type: "Hint" },
		{ node_id: "n-action", origin_event_id: "e-action", episode_id: ep, effective: true, type: "Artifact" },
		{ node_id: "n-node", origin_event_id: "e-node", episode_id: ep, effective: true, type: "Intent" },
		{
			node_id: "n-out",
			origin_event_id: "e-outcome",
			episode_id: ep,
			effective: true,
			type: "Fact",
			outcome_id: "out-1",
		},
	],
};
const aliases = {
	r0: { type: "event", id: "e-event", digest: "sha256:e" },
	r1: { type: "node", id: "n-node" },
	r2: { type: "action", id: "act-1" },
	r3: { type: "outcome", id: "out-1" },
	r4: { type: "event", id: "e-foreign" },
	r5: { type: "node", id: "n-missing" },
};
const inspect = (refs, extra = {}) => inspectProposalRefs(refs, { events, board, episodeId: ep, aliases, ...extra });

test("an event alias resolves to its committed event", () => {
	const r = inspect(["r0"]);
	assert.equal(r.ok, true, r.reason);
	assert.deepEqual(r.refs[0], { ref_type: "event", ref_id: "e-event", digest: "sha256:e" });
});

test("a node/outcome alias resolves through the board to the origin event", () => {
	for (const [alias, id] of [
		["r1", "e-node"],
		["r3", "e-outcome"],
	]) {
		const r = inspect([alias]);
		assert.equal(r.ok, true, `${alias}: ${r.reason}`);
		assert.equal(r.refs[0].ref_id, id);
	}
});

test("an action alias resolves to its completed action event", () => {
	const r = inspect(["r2"]);
	assert.equal(r.ok, true, r.reason);
	assert.equal(r.refs[0].ref_id, "e-action");
});

test("foreign, missing and digest-mismatched aliases are still rejected", () => {
	assert.equal(inspect(["r4"]).ok, false);
	assert.equal(inspect(["r5"]).ok, false);
	const mismatch = inspect([{ ref_type: "event", ref_id: "e-event", digest: "sha256:other" }]);
	assert.equal(mismatch.ok, false);
	assert.match(mismatch.reason, /digest mismatch/);
});

test("raw event ids and object refs keep working without an alias map", () => {
	assert.equal(inspect(["e-event"], { aliases: null }).ok, true);
	assert.equal(inspect([{ ref_type: "event", ref_id: "e-event" }], { aliases: null }).ok, true);
});
