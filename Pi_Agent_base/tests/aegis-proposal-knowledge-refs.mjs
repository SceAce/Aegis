// Proposal source refs: every alias RAM prints must be either citable or
// diagnosed accurately.
//
// Regression origin: a real session cited a knowledge row's `ref` alias (e.g.
// "r2") as a source. `resolveAlias` only understood event/action/node/outcome,
// so a `knowledge` alias fell through to the literal-string path and was
// rejected as "missing, foreign or ineffective" — 19 times. RAM had printed the
// handle itself, and the message misdiagnosed the cause.
import assert from "node:assert/strict";
import test from "node:test";
import { projectBoard } from "../memory/board.mjs";
import { inspectProposalRefs } from "../memory/proposal-refs.mjs";
import { buildRamProjection } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";

const ep = "ep-refs";

function event({ id, type, payload = {}, episodeId = ep, sourceKind = "runtime" }) {
	return {
		event_id: id,
		event_type: type,
		episode_id: episodeId,
		recorded_at: "2026-10-20T00:00:00.000Z",
		event_digest: `sha256:digest-${id}`,
		source: { actor_id: "pi", kind: sourceKind, adapter: "test", version: "1" },
		evidence_refs: [],
		payload,
	};
}

/** An Episode with one knowledge selection recorded as a runtime.note. */
function fixture() {
	const selected = event({
		id: "ev-knowledge",
		type: "runtime.note",
		payload: {
			kind: "knowledge.selected",
			selected: [
				{
					knowledge_id: "card-a.json#1",
					source_kind: "external_reference",
					source_uri: "file:///kb/card-a.md",
					source_digest: "sha256:abc",
					topic: "upload bypass",
					line_start: 1,
					line_end: 9,
					content: "upload a .htaccess",
				},
			],
		},
	});
	const rows = [
		event({
			id: "ev-origin",
			type: "episode.started",
			payload: { task_id: "task-1", goal: { description: "probe" } },
		}),
		selected,
	];
	return rows;
}

function ram(rows, aliasRegistry) {
	return buildRamProjection({
		board: projectBoard(rows),
		state: projectState(rows),
		seed: null,
		episodeId: ep,
		aliasRegistry,
	});
}

test("a knowledge row's ref alias resolves to the event that recorded the selection", () => {
	const rows = fixture();
	const registry = {};
	const projection = ram(rows, registry);
	const row = projection.data.references.find((entry) => entry.kind === "knowledge");
	assert.ok(row, "the fixture exposes a knowledge reference");
	assert.equal(row.ref, "r0");

	const result = inspectProposalRefs([row.ref], {
		events: rows,
		board: projectBoard(rows),
		episodeId: ep,
		aliases: projection.data.refs,
	});
	assert.equal(result.ok, true, result.reason);
	assert.equal(result.refs[0].ref_id, "ev-knowledge", "resolves to the committed selection note");
});

test("the knowledge alias entry carries the backing event id", () => {
	const rows = fixture();
	const projection = ram(rows, {});
	const alias = projection.data.refs.r0;
	assert.equal(alias.type, "knowledge");
	assert.equal(alias.eventId, "ev-knowledge");
});

test("citing a knowledge alias from another Episode is diagnosed as foreign", () => {
	const rows = fixture();
	const projection = ram(rows, {});
	const aliases = projection.data.refs;
	// Same alias map, but the caller claims a different Episode.
	const result = inspectProposalRefs(["r0"], {
		events: rows,
		board: projectBoard(rows),
		episodeId: "ep-other",
		aliases,
	});
	assert.equal(result.ok, false);
	assert.match(result.reason, /does not resolve|another Episode/);
});

test("an unknown alias is diagnosed as unresolved rather than silently accepted", () => {
	const rows = fixture();
	const projection = ram(rows, {});
	const result = inspectProposalRefs(["r99"], {
		events: rows,
		board: projectBoard(rows),
		episodeId: ep,
		aliases: projection.data.refs,
	});
	assert.equal(result.ok, false);
	assert.match(result.reason, /does not resolve to any committed event/);
});

test("an observability event that creates no board node is named as such", () => {
	const rows = [
		...fixture(),
		event({ id: "ev-projected", type: "request.projected", payload: { provider_bound: true } }),
	];
	const result = inspectProposalRefs(["ev-projected"], {
		events: rows,
		board: projectBoard(rows),
		episodeId: ep,
		aliases: {},
	});
	assert.equal(result.ok, false);
	assert.match(result.reason, /creates no board node/);
});

test("a superseded node is diagnosed as superseded, not missing", () => {
	const rows = [
		...fixture(),
		event({
			id: "ev-proposal-1",
			type: "proposal.submitted",
			payload: { kind: "claim", text: "first claim", node_kind: "hint" },
			sourceKind: "llm",
		}),
		event({
			id: "ev-proposal-2",
			type: "proposal.submitted",
			payload: { kind: "claim", text: "replacement claim", node_kind: "hint", replace_event_id: "ev-proposal-1" },
			sourceKind: "llm",
		}),
	];
	const result = inspectProposalRefs(["ev-proposal-1"], {
		events: rows,
		board: projectBoard(rows),
		episodeId: ep,
		aliases: {},
	});
	assert.equal(result.ok, false);
	assert.match(result.reason, /superseded or invalidated/);
});

test("a committed effective proposal event stays citable", () => {
	const rows = [
		...fixture(),
		event({
			id: "ev-proposal",
			type: "proposal.submitted",
			payload: { kind: "claim", text: "supported claim", node_kind: "hint" },
			sourceKind: "llm",
		}),
	];
	const result = inspectProposalRefs(["ev-proposal"], {
		events: rows,
		board: projectBoard(rows),
		episodeId: ep,
		aliases: {},
	});
	assert.equal(result.ok, true, result.reason);
});
