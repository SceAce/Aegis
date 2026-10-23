#!/usr/bin/env node
// WC-06 / WC-11 / WC-14 / EXP-NT (RAM projection, board/state negative, negative transfer).
//
// Uses the REAL Board/RuntimeState projections (no duplicated reducer) and the
// real RAM projection. Expected trust classes come from the contracts:
//   * facts = verified, claims/references = unverified, rules never authorize;
//   * work_cycle is part of the mandatory core and cannot be displaced;
//   * a complete/blocked work checkpoint creates NO Fact/Outcome/Experience/Episode.

import assert from "node:assert/strict";
import { projectBoard } from "../memory/board.mjs";
import { buildRamProjection } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";
import { evaluateWorkCycleGate, projectWorkCycle, recommendWorkHandoff } from "../memory/work-cycle.mjs";

const episode = "ep-ram-work-cycle";
const goal = "Inspect the parser boundary under the frozen task goal";
function ev(event_id, event_type, kind, payload, episode_id = episode) {
	return { event_id, event_type, episode_id, source: { kind }, payload };
}
const policy = { repeat_limit: 3, action_window: 8, min_distinct_routes: 4 };
const events = [
	ev("start", "episode.started", "runtime", {
		task_id: "task-ram",
		goal: { description: goal },
		authorization: "workspace:read+write (operator)",
		budget: { tool_calls: 20 },
	}),
	ev("intent-1", "proposal.submitted", "llm", {
		kind: "intent",
		text: "probe parser boundary with variant A",
		scope: "unit:parser-boundary",
	}),
];
for (const [id, args] of [
	["a", "same"],
	["b", "same"],
	["c", "same"],
]) {
	events.push(
		ev(`req-${id}`, "action.requested", "runtime", {
			action_id: id,
			tool_name: "bash",
			arguments_digest: args,
			input: { command: "probe" },
		}),
		ev(
			`done-${id}`,
			"action.completed",
			"runtime",
			{
				action_id: id,
				tool_name: "bash",
				content_digest: "sha256:same-output",
				status: "unknown",
			},
			episode,
		),
	);
}
// An unresolved side effect: it must stay visible and never be displaced.
events.push(
	ev("req-pending", "action.requested", "runtime", {
		action_id: "pending-1",
		tool_name: "write",
		arguments_digest: "pending-args",
		input: { path: "out.txt" },
	}),
);
// A retrieved knowledge row selected by the work review, plus an explicit query
// selection. Both are references, never rules/facts.
const knowledge = {
	knowledge_id: "web/parser.json#2",
	source_kind: "external_reference",
	source_uri: "file:///knowledge/web/parser.json",
	source_digest: "sha256:seed",
	topic: "parser",
	section: ["When", "Do"],
	line_start: 10,
	line_end: 20,
	content: "When the parser rejects an encoding, try a different boundary probe.",
	truncated: false,
	bundle_source_ids: ["web/parser.json#2", "web/parser.json#3"],
};
const modelKnowledge = {
	...knowledge,
	knowledge_id: "web/parser.json#9",
	content: "Explicit model query result: compare parser error modes.",
};
const cycleStall = projectWorkCycle(events, episode, policy);
assert.equal(cycleStall.review_required, true);
events.push(
	ev("sel-review", "runtime.note", "runtime", {
		kind: "knowledge.selected",
		version: "knowledge-selection-1",
		mode: "work_review",
		work_review_trigger_id: cycleStall.trigger_id,
		query: "parser boundary encoding",
		status: "ready",
		selected: [knowledge],
	}),
	ev("review-1", "runtime.note", "runtime", {
		kind: "work.review",
		version: "work-cycle-1",
		trigger_id: cycleStall.trigger_id,
		work_unit_id: "unit:parser-boundary",
		evidence_event_ids: ["req-a", "done-a", "req-b", "done-b", "req-c", "done-c"],
		blocker: { text: "three identical probes returned the same output", trust: "unverified_model_summary" },
		attempted_routes: ["bash: probe variant A"],
		retrieval: {
			query: "parser boundary encoding",
			selection_event_id: "sel-review",
			status: "ready",
			selected_knowledge_ids: ["web/parser.json#2"],
			limits: { max_results: 4, max_chars: 7000 },
		},
		next_step: { text: "probe a different parser encoding", trust: "unverified_model_summary" },
		trust: "unverified_model_summary",
	}),
	ev("sel-model", "runtime.note", "runtime", {
		kind: "knowledge.selected",
		version: "knowledge-selection-1",
		mode: "model_query",
		query: "parser error modes",
		status: "ready",
		selected: [modelKnowledge],
	}),
	// Trusted active Experience hint (a RULE, not authorization) recorded as a
	// routing decision. A stale/unmatched decision must not suppress the gate.
	ev("exp-decision", "experience.decision", "runtime", {
		mode: "router",
		considered: ["exp-old@1"],
		matched: [],
		rejected: [{ id: "exp-old", revision: 1, reason: "scope mismatch" }],
		selected: null,
		reason: "no scoped match",
	}),
	// A complete checkpoint for the CURRENT unit: planning metadata only.
	ev("cp-1", "runtime.note", "runtime", {
		kind: "work.checkpoint",
		version: "work-cycle-1",
		work_unit_id: "unit:parser-boundary",
		unit_status: "complete",
		model_claim: { summary: "boundary probe finished for variant A", blocker: null, next_step: "verify outcome" },
		evidence_event_ids: ["done-a"],
		context_usage: { known: false },
		trust: "unverified_model_summary",
	}),
);
// A foreign Episode work note must never appear in this projection.
const foreign = { ...ev("review-foreign", "runtime.note", "runtime", { kind: "work.review" }), episode_id: "ep-other" };

const board = projectBoard([...events, foreign]);
const state = projectState([...events, foreign]);
const cycle = projectWorkCycle([...events, foreign], episode, policy);
assert.equal(cycle.status, "awaiting_scoped_intent");
assert.equal(cycle.work_unit_id, "unit:parser-boundary");

// WC-11: a complete checkpoint is an unverified Artifact, never Fact/Outcome.
const artifacts = board.currentByType.Artifact.filter((node) => node.episode_id === episode);
assert.equal(
	artifacts.some((node) => node.origin_event_id === "cp-1"),
	true,
	"checkpoint must project as Artifact",
);
assert.equal(
	artifacts.some((node) => node.origin_event_id === "review-1"),
	true,
	"review must project as Artifact",
);
for (const type of ["Fact", "Refuted"]) {
	assert.equal(
		board.currentByType[type].some((node) => node.origin_event_id === "cp-1" || node.origin_event_id === "review-1"),
		false,
		`work notes must never appear as ${type}`,
	);
}
assert.equal(state.work_checkpoints.length, 1);
assert.equal(state.work_checkpoints[0].unit_status, "complete");
assert.equal(state.work_checkpoints[0].event_id, "cp-1");
assert.equal(state.work_reviews.length, 1);
assert.equal(state.work_reviews[0].event_id, "review-1");
assert.equal(state.work_reviews[0].trust, "unverified_model_summary");
assert.equal(state.experience_decisions.length, 1);
assert.equal(state.episodes[episode].status, "open");
// The stale/unmatched Experience decision is recorded as a decision, not active
// state and not an independent Episode.
assert.equal(state.experience_decisions[0].selected, null);
assert.equal(Object.keys(state.episodes).length, 1);
for (const [kind, row] of [
	["checkpoint", state.work_checkpoints[0]],
	["review", state.work_reviews[0]],
]) {
	assert.equal(row.trust, "unverified_model_summary", `${kind} trust must stay unverified`);
	assert.equal(Object.hasOwn(row, "verified"), false);
}

const usage = { known: true, used_tokens: 175000, limit_tokens: 200000, percent: 88 };
const handoff = recommendWorkHandoff({ cycle, contextUsage: usage, policy });
const projection = buildRamProjection({
	board,
	state,
	episodeId: episode,
	goal,
	workCycle: { ...cycle, handoff },
	contextUsage: usage,
	rules: [
		{
			kind: "active_experience",
			text: "PROCEDURE: when the parser rejects, compare boundary encodings",
			experience_id: "exp-match",
			revision: 2,
			route: "hint",
		},
	],
});

// WC-06: work-cycle status/reasons/evidence and review text are visible and
// classified as advisory/unverified; core fields remain.
const frame = projection.data.task.work_cycle;
assert.equal(frame.status, "awaiting_scoped_intent");
assert.deepEqual(frame.reasons, ["same_action_same_result_repeated"]);
assert.equal(frame.work_unit_id, "unit:parser-boundary");
assert.equal(frame.trust, "runtime_advisory_not_outcome");
assert.equal(frame.review.trust, "unverified_model_summary");
assert.equal(frame.review.retrieval, "ready");
assert.equal(frame.checkpoint.unit_status, "complete");
assert.equal(frame.checkpoint.trust, "unverified_model_summary");
// A real context-pressure signal MAY carry the unsettled review across a safe
// rotation; the review itself is not a rotation reason.
assert.equal(frame.handoff.recommended, true);
assert.deepEqual(frame.handoff.reasons, ["context_pressure"]);
assert.equal(frame.handoff.context_usage.known, true);
assert.equal(frame.handoff.advisory, true);
for (const alias of frame.evidence) {
	assert.equal(typeof projection.data.refs[alias]?.id, "string", `evidence alias ${alias} must resolve in refs`);
}
assert.equal(typeof projection.data.refs[frame.review.event]?.id, "string");
assert.equal(typeof projection.data.refs[frame.checkpoint.event]?.id, "string");
assert.equal(projection.data.task.authorization, "workspace:read+write (operator)");
assert.equal(projection.data.task.total_goal, goal);
assert.equal(projection.data.episode_id, episode);
assert.equal(projection.data.pending.items.length, 1, "pending side-effect responsibility must stay visible");
assert.equal(projection.data.pending.items[0].tool, "write");
assert.equal(projection.text.length <= 8000, true, "default projection must respect the JSON budget");
assert.equal(projection.data.meta.omitted.references >= 0, true);

// Knowledge rows keep their reference trust class, work-review selection keeps
// explicit priority, and an active Experience is a RULE that is explicitly not
// authorization. The stale/unmatched Experience does not suppress retrieval or
// clear the review gate.
const knowledgeRows = projection.data.references.filter((row) => row.kind === "knowledge");
assert.equal(knowledgeRows.length >= 1, true);
for (const row of knowledgeRows) {
	assert.equal(row.trust, "reference");
	assert.equal(row.verified, false);
	assert.equal(row.action_policy, "none");
}
assert.equal(
	projection.data.references.some((row) => row.kind === "knowledge" && row.selection_mode === "work_review"),
	true,
);
const rule = projection.data.rules.find((row) => row.kind === "active_experience");
assert.ok(rule, "a matched active Experience must still be able to appear as a rule");
assert.equal(rule.trust, "rule");
assert.equal(rule.not_authorization, true);
assert.equal(projection.data.facts.length, 0, "work notes and experiences never become facts");
// The gate still blocks effects after the stale Experience decision and the
// complete checkpoint; retrieval/review remain available.
const effect = evaluateWorkCycleGate(cycle, { tool_name: "bash", input: { command: "probe" } });
assert.equal(effect.allowed, false);
assert.equal(effect.terminate, true);
assert.equal(evaluateWorkCycleGate(cycle, { tool_name: "aegis_knowledge", input: { query: "x" } }).allowed, true);
assert.equal(evaluateWorkCycleGate(cycle, { tool_name: "aegis_work_review", input: {} }).allowed, true);
assert.equal(evaluateWorkCycleGate(cycle, { tool_name: "aegis_work_checkpoint", input: {} }).allowed, true);
assert.equal(evaluateWorkCycleGate(cycle, { tool_name: "read", input: { path: "x" } }).allowed, true);
assert.equal(evaluateWorkCycleGate(cycle, { tool_name: "aegis_submit_candidate", input: {} }).allowed, false);

// WC-14: many old work notes/knowledge rows cannot displace the core or pending
// responsibility, and the omission is reported. A tight budget either fits or
// reports a genuine core overflow (never a silent incomplete request).
const noisy = [
	...events,
	...Array.from({ length: 12 }, (_, i) =>
		ev(`old-cp-${i}`, "runtime.note", "runtime", {
			kind: "work.checkpoint",
			version: "work-cycle-1",
			work_unit_id: `unit:old-${i}`,
			unit_status: "continue",
			model_claim: { summary: `old summary ${i} `.repeat(40) },
			evidence_event_ids: ["done-a"],
			trust: "unverified_model_summary",
		}),
	),
	ev("sel-auto-old", "runtime.note", "runtime", {
		kind: "knowledge.selected",
		version: "knowledge-selection-1",
		mode: "automatic",
		selected: [{ ...knowledge, knowledge_id: "web/old.json#1", content: "old ".repeat(500) }],
	}),
];
const noisyBoard = projectBoard(noisy);
const noisyState = projectState(noisy);
const tight = buildRamProjection({
	board: noisyBoard,
	state: noisyState,
	episodeId: episode,
	goal,
	budgetChars: 1400,
	workCycle: { ...cycle, handoff },
	contextUsage: usage,
});
assert.equal(
	tight.text.length <= 1400 || tight.core_overflow === true,
	true,
	"a projection must fit its budget or report core overflow",
);
assert.equal(tight.data.pending.items.length >= 1, true, "pending action survives budget pressure");
assert.equal(tight.data.task.authorization, "workspace:read+write (operator)");
assert.equal(tight.data.task.work_cycle.status, "awaiting_scoped_intent");
assert.equal(tight.data.meta.core_overflow, tight.core_overflow);
const tiny = buildRamProjection({
	board: noisyBoard,
	state: noisyState,
	episodeId: episode,
	goal,
	budgetChars: 260,
	workCycle: { ...cycle, handoff },
});
assert.equal(tiny.core_overflow, true, "an impossible budget must report a core overflow, not a silent cut");
assert.equal(tiny.data.pending.items.length >= 1, true);
assert.equal(tiny.data.task.total_goal, goal);

// A foreign Episode review/checkpoint is not projected for this Episode.
assert.equal(
	buildRamProjection({ board, state, episodeId: episode, goal, workCycle: cycle }).data.task.work_cycle.review.event !==
		undefined,
	true,
);
const foreignState = {
	...state,
	work_reviews: state.work_reviews.map((row) => ({ ...row, episode_id: "ep-other" })),
	work_checkpoints: state.work_checkpoints.map((row) => ({ ...row, episode_id: "ep-other" })),
};
const withoutReview = buildRamProjection({
	board,
	state: foreignState,
	episodeId: episode,
	goal,
	workCycle: { ...cycle, review: null, checkpoint: null },
});
assert.equal(withoutReview.data.task.work_cycle.review, undefined);
assert.equal(withoutReview.data.task.work_cycle.checkpoint, undefined);

console.log(
	"Work cycle RAM: work frame/trust labels, core+pending retention, work_review knowledge priority, budget/omission, board Artifact-only checkpoints/reviews and negative-transfer gate passed",
);
