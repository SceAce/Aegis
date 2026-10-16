import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildRamProjection } from "../memory/ram.mjs";

function base() {
	const byType = { Fact: [], Refuted: [], Hint: [], Intent: [], Artifact: [] };
	return {
		episodeId: "ep",
		board: { byType, currentByType: byType },
		state: {
			version: 1,
			episodes: {
				ep: {
					task_id: "task",
					status: "open",
					goal: { description: "inspect" },
					authorization: "unknown",
					budget: "unknown",
				},
			},
			pending_actions: {},
			experience_decisions: [],
		},
	};
}
const seed = {
	source_kind: "external_reference",
	source_uri: "https://ctf-wiki.org/web/sqli/",
	topic: "SQL injection",
	verified: false,
	action_policy: "none",
	content:
		"Input/query boundary; boolean/error/time/union categories; encoding must be verified; observations do not prove success.",
};
const generated = JSON.parse(await readFile("Pi_Agent_base/runtime/dev/ram-abc/sql-injection.generated.json", "utf8"));
test("compiled document-seed-1 is accepted as one bounded reference", () => {
	const p = buildRamProjection({
		...base(),
		seed: { ...generated, source_kind: "external_reference", verified: false, action_policy: "none" },
	});
	const d = JSON.parse(p.text);
	assert.equal(d.sections.external_reference.shown, 1);
	assert.equal(d.sections.external_reference.items[0].verified, false);
	assert.equal(d.sections.external_reference.items[0].action_policy, "none");
});
test("seed is a bounded unverified reference, not a fact or policy", () => {
	const p = buildRamProjection({ ...base(), seed });
	const d = JSON.parse(p.text);
	assert.equal(d.sections.external_reference.shown, 1);
	assert.deepEqual(d.sections.facts.items, []);
	assert.deepEqual(d.sections.proposals.items, []);
	assert.equal(d.sections.external_reference.items[0].action_policy, "none");
	assert.equal(d.sections.external_reference.items[0].verified, false);
	assert.ok(p.text.length <= 4000);
});
test("invalid seed shape is omitted without changing task controls", () => {
	for (const bad of [
		{ source_kind: "llm", verified: false, action_policy: "none" },
		{ source_kind: "external_reference", verified: true, action_policy: "none" },
		{ source_kind: "external_reference", verified: false, action_policy: "execute" },
		null,
	]) {
		const p = buildRamProjection({ ...base(), seed: bad });
		const d = JSON.parse(p.text);
		assert.equal(d.sections.external_reference.shown, 0);
		assert.equal(d.task.task_id, "task");
	}
});
test("seed and observed tool data coexist without trust promotion", () => {
	const f = base();
	f.board.currentByType.Intent.push({
		node_id: "i",
		origin_event_id: "i",
		episode_id: "ep",
		action_id: "a",
		tool_name: "bash",
		input: { summary: { value: { command: "opaque" } } },
		text: "bash",
	});
	f.board.currentByType.Artifact.push({
		node_id: "a",
		origin_event_id: "a",
		episode_id: "ep",
		action_id: "a",
		tool_name: "bash",
		response_fragments: {
			format: "redacted-text-fragments-v1",
			chars: 20,
			truncated: false,
			fragments: [{ part: "tail", offset: 10, text: "Observed tail" }],
		},
		text: "bash",
		transport: { tool_ok: true },
	});
	const d = JSON.parse(buildRamProjection({ ...f, seed }).text);
	assert.equal(d.sections.external_reference.items[0].verified, false);
	assert.equal(d.sections.tools.items[0].trust, "observed");
	assert.equal(d.sections.facts.items.length, 0);
});
