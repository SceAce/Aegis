import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixtureCampaign, fixtureOutcomes } from "../campaign/fixture.mjs";
import { projectBoard } from "../memory/board.mjs";
import { captureTextFragments, compactTextFragments } from "../memory/fragments.mjs";
import { validateProposal } from "../memory/proposal.mjs";
import { inspectProposalReplacement } from "../memory/proposal-refs.mjs";
import { buildRamProjection } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";
import { redactMemoryText, summarizeMemoryValue } from "../memory/summary.mjs";

const ep = "episode-boundary";
function event(id, type, payload, kind = "runtime", episode = ep) {
	return {
		event_id: id,
		event_type: type,
		episode_id: episode,
		payload,
		source: { kind },
		recorded_at: "2026-01-01T00:00:00Z",
	};
}
const start = () => event("start", "episode.started", { task_id: "task", goal: { description: "inspect" } });
const proposal = (id, extra = {}) =>
	event(id, "proposal.submitted", { kind: "claim", text: id, source_refs: [], ...extra }, "llm");
function outcome(id, extra = {}) {
	return {
		...event(
			id,
			"outcome.recorded",
			{
				outcome_id: id,
				status: "success",
				criterion: { criterion_id: "criterion", expected: false },
				observed: false,
				provenance: { independent: true, source: "oracle", task_id: "task" },
				scope: "local",
				...extra,
			},
			"oracle",
		),
		evidence_refs: [{ ref_type: "artifact", ref_id: "proof" }],
	};
}

test("structured summaries and RAM preserve criterion identity and escaped expected/observed containers", () => {
	const criterion = {
		criterion_id: "complete-criterion-identity",
		description: '"\\'.repeat(2000),
		expected: { enabled: false, count: 0, text: '"\\'.repeat(2000) },
	};
	const summary = summarizeMemoryValue(criterion, { maxChars: 180, maxString: 180 });
	assert.equal(typeof summary.value, "object");
	assert.equal(summary.value.criterion_id, criterion.criterion_id);
	assert.ok(JSON.stringify(summary.value).length <= 180);
	const rows = [
		start(),
		outcome("judgment", { criterion, observed: { count: 0, enabled: false, text: '"\\'.repeat(2000) } }),
	];
	const p = buildRamProjection({ board: projectBoard(rows), state: projectState(rows), episodeId: ep });
	const item = p.data.facts[0];
	assert.equal(item.criterion.criterion_id, criterion.criterion_id);
	assert.equal(typeof item.criterion.expected, "object");
	assert.equal(item.criterion.expected.enabled, false);
	assert.equal(item.observed.count, 0);
	assert.equal(item.observed.enabled, false);
	assert.deepEqual(JSON.parse(p.text), p.data);
	assert.equal(p.data.meta.ram_estimated_chars, p.text.length);
	assert.ok(p.text.length <= 4000);
});

test("mechanical head/middle/tail retain actual redacted offsets through compacting", () => {
	const raw = `HEAD ${"x".repeat(1700)} password=PRIVATE ${"x".repeat(1700)} MIDDLE ${"x".repeat(3400)} TAIL`;
	const safe = redactMemoryText(raw);
	for (const captured of [captureTextFragments(raw, 900), compactTextFragments(captureTextFragments(raw, 900), 180)]) {
		assert.equal(captured.chars, safe.length);
		assert.equal(captured.offset_unit, "redacted_utf16");
		assert.equal(captured.truncated, true);
		assert.deepEqual(
			captured.fragments.map((part) => part.part),
			["head", "middle", "tail"],
		);
		for (const part of captured.fragments)
			assert.equal(part.text, safe.slice(part.offset, part.offset + part.text.length));
		assert.ok(!JSON.stringify(captured).includes("PRIVATE"));
		assert.ok(captured.fragments[0].text.includes("HEAD"));
		assert.ok(captured.fragments[1].text.includes("MIDDLE"));
		assert.ok(captured.fragments[2].text.includes("TAIL"));
	}
});

test("whole-output budgeting retains bounded observations and explicit core overflow", () => {
	const rows = [start(), event("x".repeat(5000), "action.completed", { action_id: "a", tool_name: "read" })];
	const board = projectBoard(rows);
	const state = projectState(rows);
	const p = buildRamProjection({ board, state, episodeId: ep, budgetChars: 4000 });
	assert.ok(p.text.length <= 4000);
	assert.equal(p.data.sections.tools.total, 1);
	const large = buildRamProjection({ board, state, episodeId: ep, budgetChars: 12000 });
	assert.ok(Object.values(large.data.refs).some((ref) => ref.id === "x".repeat(5000)));
	assert.equal(large.data.recent.response, null);
	assert.ok(!Object.values(large.data.refs).some((ref) => ref.type === "artifact"));
	state.pending_actions.a = { action_id: "pending-identity", episode_id: ep, tool_name: "write", status: "unknown" };
	const tiny = buildRamProjection({ board, state, episodeId: ep, budgetChars: 30 });
	assert.equal(tiny.data.meta.core_overflow, true);
	assert.equal(tiny.data.pending.items[0].action_id, "pending-identity");
	assert.equal(tiny.data.meta.ram_estimated_chars, tiny.text.length);
});

test("invalid source refs are rejected instead of discarded", () => {
	for (const ref of [
		null,
		{},
		[],
		"",
		0,
		{ ref_type: "external", ref_id: "x" },
		{ ref_type: "event", ref_id: "x", digest: 2 },
	])
		assert.equal(
			validateProposal({ kind: "claim", text: "claim", source_refs: [ref] }).accepted,
			false,
			JSON.stringify(ref),
		);
});

test("replacement requires an accepted effective same-Episode model proposal", () => {
	const rows = [
		start(),
		proposal("rejected", { source_refs: ["missing"] }),
		proposal("replace-rejected", { replace_event_id: "rejected" }),
		proposal("accepted"),
		proposal("bad-replacement", { replace_event_id: "accepted", source_refs: ["missing"] }),
		proposal("good-replacement", { replace_event_id: "accepted" }),
		proposal("duplicate-replacement", { replace_event_id: "accepted" }),
		outcome("fact"),
		proposal("replace-fact", { replace_event_id: "fact" }),
	];
	const board = projectBoard(rows);
	assert.deepEqual(
		board.byType.Hint.map((node) => node.origin_event_id),
		["accepted", "good-replacement"],
	);
	assert.equal(board.nodes.find((node) => node.origin_event_id === "accepted").effective, false);
	assert.equal(inspectProposalReplacement("good-replacement", rows, ep, board).ok, true);
	assert.equal(inspectProposalReplacement("rejected", rows, ep, board).ok, false);
	assert.equal(inspectProposalReplacement("accepted", rows, ep, board).ok, false);
	assert.equal(inspectProposalReplacement("good-replacement", rows, ep).ok, false);
	assert.equal(board.currentByType.Fact.length, 1);
});

test("refs use the effective committed prefix, preserving history without future rescue or retroactive rejection", () => {
	const rows = [
		start(),
		outcome("old"),
		proposal("before-change", { source_refs: ["old"] }),
		event("changed", "environment.changed", { scope: "local" }, "human"),
		proposal("stale", { source_refs: ["old"] }),
		proposal("future", { source_refs: ["later"] }),
		proposal("later"),
		event("foreign", "action.completed", { action_id: "foreign-action" }, "runtime", "other"),
		proposal("foreign-ref", { source_refs: ["foreign"] }),
	];
	const board = projectBoard(rows);
	assert.deepEqual(
		board.byType.Hint.map((node) => node.origin_event_id),
		["before-change", "later"],
	);
	assert.equal(board.currentByType.Fact.length, 0);
	assert.ok(board.rejections.some((row) => row.event_id === "stale"));
	assert.ok(board.rejections.some((row) => row.event_id === "future"));
	assert.ok(board.rejections.some((row) => row.event_id === "foreign-ref"));
});

test("Campaign prefix refs share authority: rejected corrections cannot retire evidence, trusted changes do", () => {
	const fixture = buildFixtureCampaign();
	const first = fixtureOutcomes({ fixture })[0];
	const task = fixture.manifest.tasks[0];
	const campaignEvent = (id, payload, kind = "runtime") =>
		event(
			id,
			"runtime.note",
			{
				campaign_id: fixture.manifest.campaign_id,
				task_id: task.task_id,
				episode_id: first.episode_id,
				...payload,
			},
			kind,
			first.episode_id,
		);
	const judgment = (id, value) =>
		campaignEvent(
			id,
			{
				kind: "campaign.oracle.result",
				outcome_id: value.outcome_id,
				step_id: first.step_id,
				outcome: value,
			},
			"oracle",
		);
	const claim = (id) =>
		event(
			id,
			"proposal.submitted",
			{ kind: "claim", text: id, source_refs: ["campaign-first"] },
			"llm",
			first.episode_id,
		);
	const rows = [
		campaignEvent("campaign-start", { kind: "campaign.task.started" }),
		event(
			"proof",
			"action.completed",
			{ evidence_ref: first.evidence_refs[0].ref_id, content_digest: "proof-digest" },
			"runtime",
			first.episode_id,
		),
		judgment("campaign-first", first),
		judgment("bad-correction", {
			...first,
			outcome_id: "bad-correction",
			supersedes: first.outcome_id,
			evidence_refs: [{ ref_type: "artifact", ref_id: "missing" }],
		}),
		claim("accepted-after-rejected-correction"),
	];
	const before = projectBoard(rows, { manifest: fixture.manifest });
	assert.equal(before.currentByType.Fact.length, 1);
	assert.ok(before.nodes.some((node) => node.origin_event_id === "accepted-after-rejected-correction"));
	assert.ok(before.rejections.some((row) => row.event_id === "bad-correction"));
	rows.push(
		event("campaign-env", "environment.changed", { scope: first.scope }, "human", first.episode_id),
		claim("rejected-after-change"),
	);
	const after = projectBoard(rows, { manifest: fixture.manifest });
	assert.equal(after.currentByType.Fact.length, 0);
	assert.ok(after.nodes.some((node) => node.origin_event_id === "accepted-after-rejected-correction"));
	assert.ok(after.rejections.some((row) => row.event_id === "rejected-after-change"));
});

test("event/node/action refs resolve complete committed evidence and digest mismatches fail", () => {
	const completed = event("completed", "action.completed", {
		action_id: "action-complete",
		tool_name: "bash",
		content_excerpt: "opaque",
	});
	completed.event_digest = "complete-digest";
	const rows = [
		start(),
		completed,
		...["event", "node", "action"].map((kind) =>
			proposal(kind, {
				source_refs: [
					{
						ref_type: kind,
						ref_id: kind === "event" ? "completed" : kind === "node" ? "ev:completed" : "action-complete",
						digest: "complete-digest",
					},
				],
			}),
		),
		proposal("bad-digest", { source_refs: [{ ref_type: "event", ref_id: "completed", digest: "wrong" }] }),
	];
	const board = projectBoard(rows);
	assert.deepEqual(
		board.byType.Hint.map((node) => node.origin_event_id),
		["event", "node", "action"],
	);
	assert.ok(board.rejections.some((row) => row.event_id === "bad-digest"));
});
