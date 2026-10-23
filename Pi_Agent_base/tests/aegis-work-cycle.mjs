#!/usr/bin/env node
// WC-01..WC-05 + WC-09/WC-11/WC-12 (pure reducer level).
//
// These cases assert the FROZEN T0 contract:
//   * deterministic projection over a committed Episode prefix;
//   * repeat / multi-route stall thresholds at limit-1 / limit / limit+1;
//   * same arguments with a DIFFERENT (or unknown) result is not a repeat and
//     never becomes a failure;
//   * only Board-accepted trusted progress resets the no-progress window;
//   * a review is a retrieval-backed record, and only a NEW scoped Intent that
//     cites it clears the hold;
//   * checkpoints are unverified planning metadata; handoff is advisory.
//
// Expected values come from the task contract, never from the reducer output.

import assert from "node:assert/strict";
import {
	indexEvents,
	normalizeContextUsage,
	normalizeWorkCyclePolicy,
	projectWorkCycle,
	readWorkCheckpoint,
	readWorkReview,
	recommendWorkHandoff,
	resolveWorkCyclePolicy,
	validateWorkEvidence,
	WORK_CYCLE_POLICY_DEFAULTS,
} from "../memory/work-cycle.mjs";

const episode = "ep-work-cycle";
const other = "ep-foreign";
function ev(event_id, event_type, kind, payload, episode_id = episode) {
	return { event_id, event_type, episode_id, source: { kind }, payload };
}
const start = ev("start", "episode.started", "runtime", {
	task_id: "task-work-cycle",
	goal: { description: "work-cycle pure contract" },
});
const POLICY = { repeat_limit: 3, action_window: 8, min_distinct_routes: 4 };

function pair(
	id,
	{ signature = "sig", result = "sha256:same", tool = "bash", status = "unknown", ep = episode, digest = true } = {},
) {
	return [
		ev(
			`req-${id}`,
			"action.requested",
			"runtime",
			{
				action_id: id,
				tool_name: tool,
				arguments_digest: signature,
				input: { tool, signature },
			},
			ep,
		),
		ev(
			`done-${id}`,
			"action.completed",
			"runtime",
			{
				action_id: id,
				tool_name: tool,
				status,
				...(digest ? { content_digest: result } : {}),
				transport: { tool_ok: status !== "failed" },
			},
			ep,
		),
	];
}
function actions(entries) {
	return entries.flatMap((entry, index) =>
		pair(`${entry.id ?? `a${index}`}`, {
			signature: entry.signature ?? `sig-${index}`,
			result: entry.result ?? `sha256:r${index}`,
			tool: entry.tool ?? "bash",
			status: entry.status ?? "unknown",
			digest: entry.digest !== false,
			ep: entry.ep ?? episode,
		}),
	);
}
const loop = [
	...pair("one", { signature: "same", result: "sha256:same" }),
	...pair("two", { signature: "same", result: "sha256:same" }),
	...pair("three", { signature: "same", result: "sha256:same" }),
];
const loopEvents = [start, ...loop];
const loopCycle = projectWorkCycle(loopEvents, episode, POLICY);
assert.equal(loopCycle.status, "review_required");
assert.equal(loopCycle.review_required, true);
assert.deepEqual(loopCycle.reasons, ["same_action_same_result_repeated"]);
assert.equal(loopCycle.repeat_count, 3);
assert.equal(loopCycle.work_unit_id, null);
assert.equal(loopCycle.policy.repeat_limit, 3);

// WC-01: a committed prefix is deterministic; a foreign Episode's identical
// actions never contribute to this Episode's counters.
const foreignNoise = actions([
	{ signature: "same", result: "sha256:same" },
	{ signature: "same", result: "sha256:same" },
	{ signature: "same", result: "sha256:same" },
]).map((row) => ({ ...row, episode_id: other }));
const withForeign = [start, ...foreignNoise, ...loop];
const a = projectWorkCycle(withForeign, episode, POLICY);
const b = projectWorkCycle(withForeign, episode, POLICY);
assert.deepEqual(a, b, "same committed prefix must project identically");
assert.equal(a.action_count, 3, "foreign Episode actions are ignored");
assert.equal(a.trusted_progress_event_id, null);
assert.equal(projectWorkCycle([start, ...loop], other, POLICY).status, "inactive");
assert.equal(projectWorkCycle([], episode, POLICY).status, "inactive");

// WC-02: boundary limit-1 / limit / limit+1 for "same action + same result".
const twoLoops = [
	start,
	...actions([
		{ signature: "s", result: "r1" },
		{ signature: "s", result: "r1" },
	]),
];
assert.equal(projectWorkCycle(twoLoops, episode, POLICY).review_required, false);
const fourLoops = [
	start,
	...actions([
		{ signature: "s", result: "r1" },
		{ signature: "s", result: "r1" },
		{ signature: "s", result: "r1" },
		{ signature: "s", result: "r1" },
	]),
];
const fourCycle = projectWorkCycle(fourLoops, episode, POLICY);
assert.equal(fourCycle.review_required, true);
assert.equal(fourCycle.repeat_count, 4);

// A different configured limit is honored (host policy, not a hardcoded 3).
const limitTwo = projectWorkCycle(twoLoops, episode, { ...POLICY, repeat_limit: 2 });
assert.equal(limitTwo.reasons.includes("same_action_same_result_repeated"), true);
assert.equal(limitTwo.repeat_count, 2);

// WC-03: same tool/args with a CHANGED result is not the same action+result.
const changedResults = [
	start,
	...actions([
		{ signature: "s", result: "r1" },
		{ signature: "s", result: "r2" },
		{ signature: "s", result: "r3" },
	]),
];
const changedCycle = projectWorkCycle(changedResults, episode, POLICY);
assert.equal(changedCycle.review_required, false);
assert.equal(changedCycle.status, "clear");
// A missing content digest is UNKNOWN: it must never be treated as "same
// result" or as a failure/Refuted state.
const unknownResults = [
	start,
	...actions([
		{ signature: "s", digest: false },
		{ signature: "s", digest: false },
		{ signature: "s", digest: false },
	]),
];
const unknownCycle = projectWorkCycle(unknownResults, episode, POLICY);
assert.equal(unknownCycle.review_required, false);
assert.equal(unknownCycle.status, "clear");
assert.equal(Object.hasOwn(unknownCycle, "failed"), false);
assert.equal(Object.hasOwn(unknownCycle, "refuted"), false);

// WC-04: several distinct effect routes without trusted progress.
const sevenRoutes = [start, ...actions(Array.from({ length: 7 }, (_, i) => ({ signature: `route-${i}` })))];
assert.equal(projectWorkCycle(sevenRoutes, episode, POLICY).review_required, false, "window-1 is not enough");
const eightRoutes = [start, ...actions(Array.from({ length: 8 }, (_, i) => ({ signature: `route-${i}` })))];
const broad = projectWorkCycle(eightRoutes, episode, POLICY);
assert.equal(broad.review_required, true);
assert.deepEqual(broad.reasons, ["multiple_routes_without_verified_progress"]);
assert.equal(broad.action_count, 8);
assert.equal(broad.unique_routes, 8);
// 8 effect completions but only 3 distinct routes is below min_distinct_routes.
const fewRoutes = [start, ...actions(Array.from({ length: 8 }, (_, i) => ({ signature: `route-${i % 3}` })))];
const fewCycle = projectWorkCycle(fewRoutes, episode, POLICY);
assert.equal(fewCycle.reviews ?? null, null);
assert.equal(fewCycle.reasons.includes("multiple_routes_without_verified_progress"), false);

// Read-only tools do not count as effect routes, even in large numbers.
const reads = [start, ...actions(Array.from({ length: 20 }, (_, i) => ({ tool: "read", signature: `read-${i}` })))];
assert.equal(projectWorkCycle(reads, episode, POLICY).review_required, false);
assert.equal(projectWorkCycle(reads, episode, POLICY).action_count, 0);

// Trusted scoped Oracle success resets the window. This reuses the Board's Fact
// gate: a bare status is NOT enough.
const bareOracle = ev("oracle-bare", "outcome.recorded", "oracle", { status: "success" });
const assertedAfterBare = [
	start,
	...actions(Array.from({ length: 8 }, (_, i) => ({ signature: `r${i}` }))),
	bareOracle,
];
assert.equal(
	projectWorkCycle(assertedAfterBare, episode, POLICY).review_required,
	true,
	"an Oracle row without criterion/observed/evidence is not trusted progress",
);
const oracleSuccess = ev("oracle-1", "outcome.recorded", "oracle", {
	status: "success",
	criterion: { criterion_id: "c1", expected: "parser accepts input" },
	observed: "accepted",
	provenance: { source: "oracle", independent: true },
	evidence_refs: [{ ref_type: "event", ref_id: "done-a0" }],
});
oracleSuccess.evidence_refs = [{ ref_type: "event", ref_id: "done-a0" }];
const afterTrusted = [
	start,
	...actions(Array.from({ length: 8 }, (_, i) => ({ signature: `r${i}` }))),
	oracleSuccess,
	...actions([{ id: "later", signature: "later" }]),
];
const trustedCycle = projectWorkCycle(afterTrusted, episode, POLICY);
assert.equal(trustedCycle.review_required, false);
assert.equal(trustedCycle.trusted_progress_event_id, "oracle-1");
// A verified observation with value + evidence + target revision is progress too.
const verifiedObservation = ev("obs-1", "observation.captured", "human", {
	verified: true,
	value: { stdin: "ok" },
	evidence_refs: [{ ref_type: "event", ref_id: "done-a0" }],
	target_fingerprint: "sha256:target",
});
verifiedObservation.evidence_refs = [{ ref_type: "event", ref_id: "done-a0" }];
assert.equal(
	projectWorkCycle([start, ...eightRoutes.slice(1), verifiedObservation], episode, POLICY).review_required,
	false,
);
// LLM-claimed verified observation is not progress.
const llmObservation = ev("obs-llm", "observation.captured", "llm", {
	verified: true,
	value: { stdin: "ok" },
	evidence_refs: ["done-a0"],
	target_fingerprint: "sha256:target",
});
assert.equal(projectWorkCycle([start, ...eightRoutes.slice(1), llmObservation], episode, POLICY).review_required, true);

// WC-05: model Intent / assistant prose / checkpoint / transport success do not
// reset the count and do not clear the hold.
const intentAfterLoop = ev("intent-1", "proposal.submitted", "llm", {
	kind: "intent",
	text: "try again",
	scope: "unit:next",
});
const prose = ev("msg-1", "message.completed", "runtime", { role: "assistant", text_digest: "sha256:x" });
const checkpoint = ev("cp-1", "runtime.note", "runtime", {
	kind: "work.checkpoint",
	version: "work-cycle-1",
	work_unit_id: "unit:next",
	unit_status: "continue",
	model_claim: { summary: "still blocked" },
	evidence_event_ids: ["req-one"],
	trust: "unverified_model_summary",
});
const notProgress = projectWorkCycle([...loopEvents, intentAfterLoop, prose, checkpoint], episode, POLICY);
assert.equal(notProgress.review_required, true);
assert.equal(notProgress.status, "review_required");
assert.equal(notProgress.repeat_count, 3);
assert.equal(notProgress.work_unit_id, "unit:next");

// WC-08/09: a review is a retrieval-backed record. It becomes awaiting, and a
// NEW scoped Intent must cite THAT exact committed review.
function reviewRows(triggerId, overrides = {}) {
	const selection = ev("sel-1", "runtime.note", "runtime", {
		kind: "knowledge.selected",
		version: "knowledge-selection-1",
		mode: "work_review",
		work_review_trigger_id: triggerId,
		query: "parser technique",
		status: "ready",
		selected: [{ knowledge_id: "web/parser.json#1" }],
	});
	const review = ev("review-1", "runtime.note", "runtime", {
		kind: "work.review",
		version: "work-cycle-1",
		trigger_id: triggerId,
		work_unit_id: "unit:next",
		evidence_event_ids: ["req-one", "done-one"],
		blocker: { text: "same result three times", trust: "unverified_model_summary" },
		attempted_routes: ["bash: same"],
		retrieval: {
			query: "parser technique",
			selection_event_id: "sel-1",
			status: "ready",
			selected_knowledge_ids: ["web/parser.json#1"],
			limits: { max_results: 4, max_chars: 7000 },
		},
		next_step: { text: "try a different parser probe", trust: "unverified_model_summary" },
		trust: "unverified_model_summary",
		...overrides.review,
	});
	return { selection, review };
}
const seeded = [start, ...loop, ...pair("w", { signature: "same", result: "sha256:same" })];
const trigger = projectWorkCycle([start, ...loop], episode, POLICY);
const { selection, review } = reviewRows(trigger.trigger_id);
const reviewed = projectWorkCycle([...loopEvents, intentAfterLoop, selection, review], episode, POLICY);
assert.equal(reviewed.status, "awaiting_scoped_intent");
assert.equal(reviewed.review_required, true);
assert.equal(reviewed.review.event_id, "review-1");
assert.equal(reviewed.review.selection_event_id, "sel-1");
assert.equal(reviewed.review.retrieval_status, "ready");
assert.deepEqual(reviewed.review.selected_knowledge_ids, ["web/parser.json#1"]);
assert.equal(reviewed.review.trust, "unverified_model_summary");

// Foreign / future / broken review evidence is ignored (fail-closed).
const foreignEvidence = reviewRows(trigger.trigger_id, {
	review: { evidence_event_ids: ["req-foreign"] },
});
const foreignRows = [start, ...loop, ...pair("f", { ep: other }), foreignEvidence.selection, foreignEvidence.review];
const foreignCycle = projectWorkCycle(foreignRows, episode, POLICY);
assert.equal(foreignCycle.review, null, "a review with foreign evidence cannot be used");
assert.equal(foreignCycle.status, "review_required");
const missingSelection = reviewRows(trigger.trigger_id, {
	review: { retrieval: { query: "q", selection_event_id: "nope" } },
});
const missingCycle = projectWorkCycle(
	[...loopEvents, missingSelection.selection, missingSelection.review],
	episode,
	POLICY,
);
assert.equal(missingCycle.review, null, "a review without a committed retrieval event is unusable");
const wrongMode = reviewRows(trigger.trigger_id);
wrongMode.selection = { ...wrongMode.selection, payload: { ...wrongMode.selection.payload, mode: "automatic" } };
assert.equal(
	projectWorkCycle([...loopEvents, wrongMode.selection, wrongMode.review], episode, POLICY).review,
	null,
	"automatic recall cannot stand in for a work review retrieval",
);
// A selection event AFTER the review is a future reference.
const neverEarlier = projectWorkCycle([...loopEvents, review, selection], episode, POLICY);
assert.equal(neverEarlier.review, null);

// Same-scope Intent and uncited Intent do NOT clear the hold.
const sameScope = ev("intent-same", "proposal.submitted", "llm", {
	kind: "intent",
	text: "same unit again",
	scope: "unit:next",
	source_refs: [{ ref_type: "event", ref_id: "review-1" }],
});
assert.equal(
	projectWorkCycle([...loopEvents, intentAfterLoop, selection, review, sameScope], episode, POLICY).status,
	"awaiting_scoped_intent",
);
const uncited = ev("intent-uncited", "proposal.submitted", "llm", {
	kind: "intent",
	text: "new unit",
	scope: "unit:different",
});
assert.equal(
	projectWorkCycle([...loopEvents, intentAfterLoop, selection, review, uncited], episode, POLICY).status,
	"awaiting_scoped_intent",
);
const claimOnly = ev("claim-1", "proposal.submitted", "llm", {
	kind: "claim",
	text: "I reviewed it",
	scope: "unit:different",
	source_refs: [{ ref_type: "event", ref_id: "review-1" }],
});
assert.equal(
	projectWorkCycle([...loopEvents, intentAfterLoop, selection, review, claimOnly], episode, POLICY).status,
	"awaiting_scoped_intent",
);

// A NEW scoped Intent citing the review (or its selection event) clears the hold.
const cleared = ev("intent-new", "proposal.submitted", "llm", {
	kind: "intent",
	text: "probe the parser with a different encoding",
	scope: "unit:candidate-probe",
	source_refs: [
		{ ref_type: "event", ref_id: "review-1" },
		{ ref_type: "event", ref_id: "sel-1" },
	],
});
const clearedCycle = projectWorkCycle([...loopEvents, intentAfterLoop, selection, review, cleared], episode, POLICY);
assert.equal(clearedCycle.status, "clear");
assert.equal(clearedCycle.review_required, false);
assert.equal(clearedCycle.work_unit_id, "unit:candidate-probe");
// The next work unit can stall again under a NEW trigger id.
const secondLoop = [
	...loopEvents,
	intentAfterLoop,
	selection,
	review,
	cleared,
	...pair("two-a", { signature: "again", result: "sha256:again" }),
	...pair("two-b", { signature: "again", result: "sha256:again" }),
	...pair("two-c", { signature: "again", result: "sha256:again" }),
];
const second = projectWorkCycle(secondLoop, episode, POLICY);
assert.equal(second.review_required, true);
assert.equal(second.status, "review_required");
assert.notEqual(second.trigger_id, trigger.trigger_id);
assert.equal(second.work_unit_id, "unit:candidate-probe");

// WC-10: a retrieval that committed but whose review row did NOT become durable
// (or failed to append) leaves the gate held. The hold is derived from the
// committed review only.
const selectionOnly = projectWorkCycle([...loopEvents, selection], episode, POLICY);
assert.equal(selectionOnly.status, "review_required");
assert.equal(selectionOnly.review, null);

// Retrieved IDs are bounded, so a replayed/oversized selection cannot grow the
// review record without limit.
const manySelection = {
	...selection,
	payload: {
		...selection.payload,
		selected: Array.from({ length: 20 }, (_, i) => ({ knowledge_id: `web/x.json#${i}` })),
	},
};
const manyReview = reviewRows(trigger.trigger_id).review;
const bounded = projectWorkCycle([...loopEvents, intentAfterLoop, manySelection, manyReview], episode, POLICY);
assert.equal(bounded.review.selected_knowledge_ids.length, 8);

// Duplicate replayed review rows stay idempotent in the projection: the same
// trigger is still awaiting, and only a new scoped Intent clears it.
const duplicateReview = { ...review, event_id: "review-2" };
const duplicated = projectWorkCycle(
	[...loopEvents, intentAfterLoop, selection, review, duplicateReview],
	episode,
	POLICY,
);
assert.equal(duplicated.status, "awaiting_scoped_intent");
assert.equal(duplicated.review.event_id, "review-2");

// WC-11: checkpoints are planning metadata only and never clear a review.
const checkpointOf = (event_id, overrides = {}) =>
	ev(event_id, "runtime.note", "runtime", {
		kind: "work.checkpoint",
		version: "work-cycle-1",
		work_unit_id: "unit:next",
		unit_status: "continue",
		model_claim: { summary: "attempted the probe", blocker: null, next_step: "retry" },
		evidence_event_ids: ["req-one"],
		context_usage: { known: false },
		trust: "unverified_model_summary",
		...overrides,
	});
const complete = projectWorkCycle(
	[...loopEvents, intentAfterLoop, checkpointOf("cp-complete", { unit_status: "complete" })],
	episode,
	POLICY,
);
assert.equal(complete.review_required, true, "a complete checkpoint cannot clear a stalled review");
assert.equal(complete.checkpoint.unit_status, "complete");
assert.equal(complete.checkpoint.trust, "unverified_model_summary");
assert.equal(complete.status, "review_required");
const invalidCp = projectWorkCycle(
	[loopEvents[0], checkpointOf("cp-bad", { evidence_event_ids: ["req-from-foreign-episode"] })],
	episode,
	POLICY,
);
assert.equal(invalidCp.checkpoint, null, "checkpoint with foreign evidence is rejected");

// WC-12: advisory handoff recommendation (no Session is created here).
const completedClear = projectWorkCycle(
	[start, intentAfterLoop, checkpointOf("cp-done", { unit_status: "complete", evidence_event_ids: ["intent-1"] })],
	episode,
	POLICY,
);
assert.equal(completedClear.status, "clear");
const unitBoundary = recommendWorkHandoff({ cycle: completedClear, contextUsage: null, policy: POLICY });
assert.equal(unitBoundary.recommended, true);
assert.deepEqual(unitBoundary.reasons, ["work_unit_complete"]);
assert.equal(unitBoundary.advisory, true);
assert.equal(unitBoundary.context_usage.known, false);
const stalled = recommendWorkHandoff({ cycle: loopCycle, contextUsage: null, policy: POLICY });
assert.equal(stalled.recommended, false, "a review-required cycle is not a handoff boundary");
const pressure = recommendWorkHandoff({
	cycle: completedClear,
	contextUsage: { tokens: 170000, contextWindow: 200000 },
	policy: { ...POLICY, context_pressure_percent: 85 },
});
assert.equal(pressure.recommended, true);
assert.equal(pressure.reasons.includes("context_pressure"), true);
assert.equal(pressure.context_usage.known, true);
assert.equal(pressure.context_usage.percent, 85);
const unknownUsage = recommendWorkHandoff({
	cycle: projectWorkCycle([start], episode, POLICY),
	contextUsage: { tokens: null, contextWindow: 200000 },
	policy: POLICY,
});
assert.equal(unknownUsage.recommended, false);
assert.equal(unknownUsage.context_usage.known, false);
assert.deepEqual(normalizeContextUsage(undefined), { known: false });
assert.deepEqual(normalizeContextUsage({ tokens: 10, contextWindow: 0 }), { known: false });

// Policy is trusted-host only, bounded and reported when invalid.
assert.deepEqual(normalizeWorkCyclePolicy({}), {
	...WORK_CYCLE_POLICY_DEFAULTS,
	source: "host_policy",
	invalid: [],
});
const resolved = resolveWorkCyclePolicy({ AEGIS_WORK_CYCLE_REPEAT_LIMIT: "4" });
assert.equal(resolved.repeat_limit, 4);
assert.equal(resolved.origin, "host_env");
assert.deepEqual(resolved.invalid, []);
const invalidPolicy = resolveWorkCyclePolicy({
	AEGIS_WORK_CYCLE_REPEAT_LIMIT: "1",
	AEGIS_WORK_CYCLE_ACTION_WINDOW: "0",
	AEGIS_WORK_CYCLE_MIN_DISTINCT_ROUTES: "99",
	AEGIS_WORK_CYCLE_CONTEXT_PERCENT: "100",
});
assert.equal(invalidPolicy.repeat_limit, WORK_CYCLE_POLICY_DEFAULTS.repeat_limit);
assert.deepEqual(
	[...invalidPolicy.invalid].sort(),
	["action_window", "context_pressure_percent", "min_distinct_routes", "repeat_limit"].sort(),
);
assert.equal(normalizeWorkCyclePolicy({ repeat_limit: "3" }).repeat_limit, WORK_CYCLE_POLICY_DEFAULTS.repeat_limit);

// Evidence validation for the product tools.
const eventsWithForeign = [start, ...loop, ...pair("foreign", { ep: other })];
assert.equal(validateWorkEvidence(eventsWithForeign, episode, ["req-one"]).ok, true);
assert.equal(validateWorkEvidence(eventsWithForeign, episode, ["req-foreign"]).ok, false);
assert.equal(validateWorkEvidence(eventsWithForeign, episode, ["req-one", "req-one"]).ok, false);
assert.equal(validateWorkEvidence(eventsWithForeign, episode, []).ok, false);
assert.equal(validateWorkEvidence(eventsWithForeign, episode, [42]).ok, false);

// A checkpoint/review row for ANOTHER Episode is not projected for this one.
const byId = indexEvents([start, ...loop, selection, review]);
assert.equal(readWorkReview(review, byId.get("review-1").index, byId, other), null);
assert.equal(readWorkCheckpoint(checkpointOf("cp-x"), 0, byId, episode), null);
assert.equal(readWorkCheckpoint(checkpointOf("cp-two"), 999, byId, episode).event_id, "cp-two");

console.log(
	`Work cycle: deterministic projection, repeat/broad boundaries (limit-1/limit/limit+1), unknown-result negative, trusted-progress reset, review/scope gate, checkpoint metadata and advisory handoff passed (${seeded.length} seed rows)`,
);
