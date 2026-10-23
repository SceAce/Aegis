#!/usr/bin/env node
// Phase-two pure contract regressions: P2-01..04, P2-06, P2-14, P2-16,
// plus the reference-usage projection (P2-13).
//
// These cases encode the INDEPENDENT review findings F1/F2/F3 and the approved
// second-phase contract:
//   * one review consumes exactly one trigger/window;
//   * cumulative attempts since trustworthy progress never reset;
//   * the current work unit is an EFFECTIVE Intent event id + scope;
//   * checkpoints bind to that exact Intent (old complete cannot follow a new unit);
//   * unusable retrieval keeps the hold but can be retried for the same trigger;
//   * frozen policy/rotation identities are replay-stable.

import assert from "node:assert/strict";
import { projectBoard } from "../memory/board.mjs";
import {
	completedWorkCycleBoundaries,
	projectKnowledgeUsage,
	projectWorkCycle,
	readFrozenWorkCyclePolicy,
	recommendWorkHandoff,
} from "../memory/work-cycle.mjs";

const episode = "ep-phase2";
const POLICY = { repeat_limit: 3, action_window: 8, min_distinct_routes: 4, context_pressure_percent: 85 };
const ev = (event_id, event_type, kind, payload, episode_id = episode) => ({
	event_id,
	event_type,
	episode_id,
	source: { kind },
	payload,
});
const start = ev("start", "episode.started", "runtime", { task_id: "task-phase2" });
const intent = (id, scope, refs = [], extra = {}) =>
	ev(id, "proposal.submitted", "llm", {
		kind: "intent",
		text: `unit ${scope}`,
		scope,
		...(refs.length ? { source_refs: refs } : {}),
		...extra,
	});
const ref = (id) => ({ ref_type: "event", ref_id: id });
let actionSeq = 0;
const action = (options = {}) => {
	actionSeq += 1;
	const id = options.id ?? `a${actionSeq}`;
	const signature = options.signature ?? "same";
	const result = options.result ?? "sha256:same";
	const sourceRefs = options.source_refs ?? [];
	return [
		ev(`req-${id}`, "action.requested", "runtime", {
			action_id: id,
			tool_name: options.tool ?? "bash",
			arguments_digest: signature,
			input: { signature },
			...(sourceRefs.length ? { source_refs: sourceRefs } : {}),
		}),
		ev(`done-${id}`, "action.completed", "runtime", {
			action_id: id,
			tool_name: options.tool ?? "bash",
			content_digest: result,
			status: "unknown",
		}),
	];
};
const selection = (id, trigger_id, knowledge_id = "web/x.json#1") =>
	ev(id, "runtime.note", "runtime", {
		kind: "knowledge.selected",
		version: "knowledge-selection-1",
		mode: "work_review",
		work_review_trigger_id: trigger_id,
		query: "technique",
		status: "ready",
		selected: [{ knowledge_id }],
	});
const review = (id, { trigger_id, unit_event, unit_scope, selection_id, status = "ready", evidence = [] }) =>
	ev(id, "runtime.note", "runtime", {
		kind: "work.review",
		version: "work-cycle-1",
		trigger_id,
		work_unit_event_id: unit_event,
		work_unit_id: unit_scope,
		evidence_event_ids: evidence,
		blocker: { text: "same result repeatedly", trust: "unverified_model_summary" },
		attempted_routes: ["bash same"],
		retrieval: {
			query: "technique",
			selection_event_id: selection_id,
			status,
			selected_knowledge_ids: status === "ready" ? ["web/x.json#1"] : [],
			limits: { max_results: 4, max_chars: 7000 },
		},
		next_step: { text: "try another route", trust: "unverified_model_summary" },
		trust: "unverified_model_summary",
	});
const checkpoint = (id, { unit_event, unit_scope, status = "complete", evidence = [] }) =>
	ev(id, "runtime.note", "runtime", {
		kind: "work.checkpoint",
		version: "work-cycle-1",
		work_unit_event_id: unit_event,
		work_unit_id: unit_scope,
		unit_status: status,
		model_claim: { summary: `checkpoint ${id}`, blocker: null, next_step: "next" },
		evidence_event_ids: evidence,
		trust: "unverified_model_summary",
	});
const oracleSuccess = (id, evidenceId) => {
	const event = ev(id, "outcome.recorded", "oracle", {
		status: "success",
		criterion: { criterion_id: "c1", expected: "probe accepted" },
		observed: "accepted",
		provenance: { source: "oracle", independent: true },
		evidence_refs: [{ ref_type: "event", ref_id: evidenceId }],
	});
	event.evidence_refs = [{ ref_type: "event", ref_id: evidenceId }];
	return event;
};

// ---------------------------------------------------------------------------
// P2-01 / F1: a consumed review cannot be re-used to reset a new window.
// ---------------------------------------------------------------------------
const A = intent("intent-a", "unit:a");
const initialLoops = [
	start,
	A,
	...action({ id: "i1", signature: "s", result: "r" }),
	...action({ id: "i2", signature: "s", result: "r" }),
	...action({ id: "i3", signature: "s", result: "r" }),
];
const trigger1 = projectWorkCycle(initialLoops, episode, POLICY);
assert.equal(trigger1.status, "review_required");
assert.equal(trigger1.work_unit_event_id, "intent-a");
const sel1 = selection("sel-1", trigger1.trigger_id);
const review1 = review("review-1", {
	trigger_id: trigger1.trigger_id,
	unit_event: "intent-a",
	unit_scope: "unit:a",
	selection_id: "sel-1",
	evidence: ["req-i1", "done-i1"],
});
const B = intent("intent-b", "unit:b", [ref("review-1")]);
const afterB = [...initialLoops, sel1, review1, B, ...action({ id: "post-b" })];
const consumed = projectWorkCycle(afterB, episode, POLICY);
assert.equal(consumed.status, "clear");
assert.equal(consumed.action_count, 4, "cumulative attempts since trustworthy progress never reset");
assert.equal(consumed.review_round_action_count, 1, "the new round starts after the consumed review");
assert.equal(consumed.consumptions.length, 1);
assert.equal(consumed.consumptions[0].review_event_id, "review-1");
assert.equal(consumed.consumptions[0].intent_event_id, "intent-b");
// Re-citing the old review in a later scope is only a historical association.
const C = intent("intent-c", "unit:c", [ref("review-1")]);
const afterC = [...afterB, C];
const reused = projectWorkCycle(afterC, episode, POLICY);
assert.equal(reused.status, "clear");
assert.equal(reused.action_count, 4, "F1: reusing the old review must not zero the count");
assert.equal(reused.review_round_action_count, 1);
assert.equal(reused.consumptions.length, 1);
// ---------------------------------------------------------------------------
// R1 / P2-01: a legal `replace_event_id` must not move the historical
// consumption or re-open the review window. The replacement becomes the CURRENT
// unit, but consumption stays on the Intent that consumed the review first.
// ---------------------------------------------------------------------------
const CReplace = intent("intent-c-replace", "unit:c-replace", [ref("review-1")], {
	replace_event_id: "intent-b",
});
const afterCReplace = [...afterB, CReplace];
const prefixBeforeReplace = projectWorkCycle(afterB, episode, POLICY);
assert.equal(prefixBeforeReplace.consumptions.length, 1);
assert.equal(prefixBeforeReplace.consumptions[0].intent_event_id, "intent-b");
const replacedConsumed = projectWorkCycle(afterCReplace, episode, POLICY);
assert.equal(replacedConsumed.review_round_action_count, 1, "R1: replace must not zero the round counter");
assert.equal(replacedConsumed.action_count, 4, "R1: replace must not change cumulative attempts");
assert.equal(replacedConsumed.work_unit_event_id, "intent-c-replace", "R1: the replacement is the current unit");
assert.deepEqual(
	replacedConsumed.consumptions.map((item) => item.intent_event_id),
	["intent-b"],
	"R1: consumption remains bound to the original consuming Intent",
);
// A second legal replacement that still cites the same review changes nothing.
const DReplace = intent("intent-d-replace", "unit:d-replace", [ref("review-1")], {
	replace_event_id: "intent-c-replace",
});
const afterDReplace = [...afterCReplace, DReplace];
const twiceReplaced = projectWorkCycle(afterDReplace, episode, POLICY);
assert.equal(twiceReplaced.review_round_action_count, 1, "R1: a second replace keeps the same round");
assert.equal(twiceReplaced.consumptions.length, 1, "R1: a second replace adds no consumption");
assert.equal(twiceReplaced.consumptions[0].intent_event_id, "intent-b");
assert.equal(twiceReplaced.work_unit_event_id, "intent-d-replace");
assert.deepEqual(
	projectWorkCycle(afterDReplace, episode, POLICY),
	twiceReplaced,
	"R1: replaying the same prefix after multiple replacements is deterministic",
);
// A NEW stall after the consumed window forms a fresh trigger; it does not
// resurrect the consumed review even though later Intents still reference it.
const replaceStallRows = [
	...afterDReplace,
	...action({ id: "rn1", signature: "n", result: "nr" }),
	...action({ id: "rn2", signature: "n", result: "nr" }),
	...action({ id: "rn3", signature: "n", result: "nr" }),
];
const replaceStall = projectWorkCycle(replaceStallRows, episode, POLICY);
assert.equal(replaceStall.review_required, true);
assert.notEqual(replaceStall.trigger_id, trigger1.trigger_id);
assert.equal(replaceStall.action_count, 7);
assert.equal(replaceStall.review_round_action_count, 4, "R1: the new window starts after the first consumption");
assert.equal(replaceStall.consumptions.length, 1);
// A real second review is consumed once by a new Intent that also cites the old
// review; only the CURRENT review moves the window.
const selReplace = selection("sel-replace", replaceStall.trigger_id);
const reviewReplace = review("review-replace", {
	trigger_id: replaceStall.trigger_id,
	unit_event: "intent-d-replace",
	unit_scope: "unit:d-replace",
	selection_id: "sel-replace",
	evidence: ["req-rn1", "done-rn1"],
});
const E = intent("intent-e", "unit:e", [ref("review-1"), ref("review-replace")]);
const reviewedAgain = projectWorkCycle(
	[...replaceStallRows, selReplace, reviewReplace, E, ...action({ id: "post-e", signature: "p", result: "pr" })],
	episode,
	POLICY,
);
assert.equal(reviewedAgain.status, "clear");
assert.equal(reviewedAgain.action_count, 8, "cumulative attempts continue across the new review");
assert.equal(reviewedAgain.review_round_action_count, 1, "only the post-Intent action is in the new round");
assert.deepEqual(
	reviewedAgain.consumptions.map((item) => [item.review_event_id, item.intent_event_id]),
	[
		["review-1", "intent-b"],
		["review-replace", "intent-e"],
	],
	"R1: old consumption stays on the original Intent; only the current review advances",
);

// A new stall after the consumed round forms a NEW trigger.
const trigger2Rows = [
	...afterC,
	...action({ id: "n1", signature: "n", result: "nr" }),
	...action({ id: "n2", signature: "n", result: "nr" }),
	...action({ id: "n3", signature: "n", result: "nr" }),
];
const trigger2 = projectWorkCycle(trigger2Rows, episode, POLICY);
assert.equal(trigger2.review_required, true);
assert.notEqual(trigger2.trigger_id, trigger1.trigger_id);
assert.equal(trigger2.action_count, 7, "cumulative still includes the first round");
assert.equal(
	trigger2.review_round_action_count,
	4,
	"the new round starts at the consumed review (post-B action + 3 new)",
);

// Control/planning tool actions are NOT effect routes; a real effect path is.
const controlRows = [
	start,
	A,
	...action({ tool: "aegis_task_decision", signature: "d", result: "dr" }),
	...action({ tool: "aegis_task_decision", signature: "d", result: "dr" }),
	...action({ tool: "aegis_task_decision", signature: "d", result: "dr" }),
];
const controlCycle = projectWorkCycle(controlRows, episode, POLICY);
assert.equal(controlCycle.review_required, false, "planning decisions are not effect routes");
assert.equal(controlCycle.action_count, 0);
const executeRows = [start, A, ...action({ tool: "aegis_execute", signature: "e", result: "er" })];
assert.equal(projectWorkCycle(executeRows, episode, POLICY).action_count, 1, "aegis_execute is an effect route");

// ---------------------------------------------------------------------------
// P2-02: mixed old/current refs consume ONLY the current review; replay/foreign/
// wrong-trigger reviews cannot clear the hold.
// ---------------------------------------------------------------------------
const sel2 = selection("sel-2", trigger2.trigger_id);
const review2 = review("review-2", {
	trigger_id: trigger2.trigger_id,
	unit_event: "intent-c",
	unit_scope: "unit:c",
	selection_id: "sel-2",
	evidence: ["req-n1", "done-n1"],
});
const D = intent("intent-d", "unit:d", [ref("review-1"), ref("review-2")]);
const mixed = projectWorkCycle([...trigger2Rows, sel2, review2, D], episode, POLICY);
assert.equal(mixed.status, "clear");
assert.equal(mixed.consumptions.length, 2);
assert.deepEqual(
	mixed.consumptions.map((item) => item.review_event_id),
	["review-1", "review-2"],
);
// Old review alone cannot clear trigger 2.
const oldOnly = intent("intent-old", "unit:old", [ref("review-1")]);
assert.equal(
	projectWorkCycle([...trigger2Rows, sel2, review2, oldOnly], episode, POLICY).status,
	"awaiting_scoped_intent",
);
// Same-scope Intent cannot consume.
const sameScope = intent("intent-same", "unit:c", [ref("review-2")]);
assert.equal(
	projectWorkCycle([...trigger2Rows, sel2, review2, sameScope], episode, POLICY).status,
	"awaiting_scoped_intent",
);
// Foreign/future evidence in a review makes it unusable.
const foreignStall = [
	start,
	intent("intent-f", "unit:f"),
	...action({ id: "f1" }),
	...action({ id: "f2" }),
	...action({ id: "f3" }),
];
const fTrigger = projectWorkCycle(foreignStall, episode, POLICY);
const fSel = selection("sel-f", fTrigger.trigger_id);
const fReview = review("review-f", {
	trigger_id: fTrigger.trigger_id,
	unit_event: "intent-f",
	unit_scope: "unit:f",
	selection_id: "sel-f",
	evidence: ["foreign-event"],
});
assert.equal(projectWorkCycle([...foreignStall, fSel, fReview], episode, POLICY).review, null);
// A review whose selection uses a different trigger id is unusable.
const wrongSelection = selection("sel-wrong", "wrev_wrong");
const wrongReview = review("review-wrong", {
	trigger_id: fTrigger.trigger_id,
	unit_event: "intent-f",
	unit_scope: "unit:f",
	selection_id: "sel-wrong",
});
assert.equal(projectWorkCycle([...foreignStall, wrongSelection, wrongReview], episode, POLICY).review, null);

// ---------------------------------------------------------------------------
// P2-06: `unavailable` keeps the hold but the SAME trigger can be retried.
// ---------------------------------------------------------------------------
const uSel = selection("sel-u", fTrigger.trigger_id);
const uReview = review("review-u", {
	trigger_id: fTrigger.trigger_id,
	unit_event: "intent-f",
	unit_scope: "unit:f",
	selection_id: "sel-u",
	status: "unavailable",
});
const failedRetrieval = projectWorkCycle([...foreignStall, uSel, uReview], episode, POLICY);
assert.equal(failedRetrieval.status, "review_required");
assert.equal(failedRetrieval.review, null);
assert.deepEqual(failedRetrieval.failed_review_event_ids, ["review-u"]);
const okSel = selection("sel-ok", fTrigger.trigger_id);
const okReview = review("review-ok", {
	trigger_id: fTrigger.trigger_id,
	unit_event: "intent-f",
	unit_scope: "unit:f",
	selection_id: "sel-ok",
});
const retried = projectWorkCycle([...foreignStall, uSel, uReview, okSel, okReview], episode, POLICY);
assert.equal(retried.status, "awaiting_scoped_intent");
assert.equal(retried.review.event_id, "review-ok", "the latest usable review is used for the same trigger");
const F = intent("intent-after-retry", "unit:g", [ref("review-u"), ref("review-ok")]);
assert.equal(projectWorkCycle([...foreignStall, uSel, uReview, okSel, okReview, F], episode, POLICY).status, "clear");

// ---------------------------------------------------------------------------
// P2-03: cumulative is stable across replay and a Session rotation; trusted
// progress resets BOTH counters.
// ---------------------------------------------------------------------------
const handoff = ev("handoff-completed", "handoff.completed", "runtime", {
	request_id: "req-rotate",
	to_session: "session-2",
	episode_id: episode,
});
const beforeReplay = projectWorkCycle([...trigger2Rows, sel2, review2], episode, POLICY);
const afterReplay = projectWorkCycle([...trigger2Rows, sel2, review2, handoff], episode, POLICY);
assert.equal(afterReplay.action_count, beforeReplay.action_count, "rotation does not change cumulative attempts");
assert.equal(afterReplay.review_round_action_count, beforeReplay.review_round_action_count);
assert.deepEqual(afterReplay.consumptions, beforeReplay.consumptions);
// A committed trusted Fact resets the no-progress window (Board gate, not prose).
const fact = oracleSuccess("oracle-1", "done-n3");
const afterFact = projectWorkCycle([...trigger2Rows, fact], episode, POLICY);
assert.equal(afterFact.trusted_progress_event_id, "oracle-1");
assert.equal(afterFact.action_count, 0, "trusted progress resets the cumulative window");
assert.equal(afterFact.review_required, false);

// ---------------------------------------------------------------------------
// P2-04 / F3: checkpoint binds to the CURRENT effective Intent event.
// ---------------------------------------------------------------------------
const iA = intent("intent-a", "unit:a");
const cpA = checkpoint("cp-a", { unit_event: "intent-a", unit_scope: "unit:a", evidence: ["intent-a"] });
const iB = intent("intent-b", "unit:b");
const stale = projectWorkCycle([start, iA, cpA, iB], episode, POLICY);
assert.equal(stale.work_unit_event_id, "intent-b");
assert.equal(stale.checkpoint, null, "F3: an old unit's complete checkpoint is not current");
assert.equal(stale.historical_checkpoint.event_id, "cp-a");
assert.equal(recommendWorkHandoff({ cycle: stale, contextUsage: null, policy: POLICY }).recommended, false);
// Same scope but a NEW Intent event is still a different unit.
const iA2 = intent("intent-a2", "unit:a");
const sameScopeStale = projectWorkCycle([start, iA, cpA, iA2], episode, POLICY);
assert.equal(sameScopeStale.work_unit_event_id, "intent-a2");
assert.equal(sameScopeStale.checkpoint, null, "same scope does not inherit an old checkpoint");
const cpA2 = checkpoint("cp-a2", { unit_event: "intent-a2", unit_scope: "unit:a", evidence: ["intent-a2"] });
const current = projectWorkCycle([start, iA, cpA, iA2, cpA2], episode, POLICY);
assert.equal(current.checkpoint.event_id, "cp-a2");
const handoffNow = recommendWorkHandoff({ cycle: current, contextUsage: null, policy: POLICY });
assert.equal(handoffNow.recommended, true);
assert.equal(handoffNow.identity, "unit-complete:intent-a2");
// A checkpoint naming a REPLACED Intent is rejected.
const replacedIntent = intent("intent-r", "unit:r");
const replacement = ev("proposal-replace", "proposal.submitted", "llm", {
	kind: "intent",
	text: "replacement",
	scope: "unit:r2",
	replace_event_id: "intent-r",
});
const cpReplaced = checkpoint("cp-replaced", { unit_event: "intent-r", unit_scope: "unit:r", evidence: ["intent-r"] });
const replacedCycle = projectWorkCycle([start, replacedIntent, cpReplaced, replacement], episode, POLICY);
assert.equal(replacedCycle.work_unit_event_id, "proposal-replace");
assert.equal(replacedCycle.checkpoint, null, "a replaced Intent cannot carry a current checkpoint");

// ---------------------------------------------------------------------------
// P2-14: frozen policy + rotation identities; unknown usage is not a number.
// ---------------------------------------------------------------------------
const policyNote = ev("policy-note", "runtime.note", "runtime", {
	kind: "campaign.work_cycle.policy",
	version: "work-cycle-1",
	campaign_id: "campaign-x",
	policy: { repeat_limit: 4, action_window: 9, min_distinct_routes: 5, context_pressure_percent: 90 },
	policy_digest: "sha256:frozen",
});
const frozen = readFrozenWorkCyclePolicy([policyNote, start], "campaign-x");
assert.equal(frozen.ok, true);
assert.equal(frozen.policy.repeat_limit, 4);
assert.equal(frozen.event_id, "policy-note");
const boundaries = completedWorkCycleBoundaries([
	ev("hc1", "handoff.completed", "runtime", { request_id: "r1", work_cycle_identity: "unit-complete:intent-a2" }),
	ev("hc2", "handoff.completed", "runtime", { request_id: "r2" }),
]);
assert.deepEqual([...boundaries], ["unit-complete:intent-a2"]);
const unknownUsage = recommendWorkHandoff({
	cycle: current,
	contextUsage: { tokens: null, contextWindow: 200000 },
	policy: POLICY,
});
assert.equal(unknownUsage.context_usage.known, false);
assert.equal(unknownUsage.identity, "unit-complete:intent-a2");
const pressure = recommendWorkHandoff({
	cycle: projectWorkCycle([start, iA], episode, POLICY),
	contextUsage: { used_tokens: 170000, limit_tokens: 200000, percent: 85 },
	policy: POLICY,
	sourceSessionId: "session-1",
});
assert.deepEqual(pressure.reasons, ["context_pressure"]);
assert.equal(pressure.identity, "context:session-1:170000:200000");

// ---------------------------------------------------------------------------
// P2-13: selection -> Intent adoption -> explicit action ref -> independent Fact.
// ---------------------------------------------------------------------------
const knowledgeEvent = ev("knowledge-1", "runtime.note", "runtime", {
	kind: "knowledge.selected",
	version: "knowledge-selection-1",
	mode: "model_query",
	selected: [{ knowledge_id: "web/usage.json#1" }],
});
const usageIntent = intent("intent-usage", "unit:usage", [ref("knowledge-1")]);
const usageRows = [
	start,
	knowledgeEvent,
	usageIntent,
	...action({
		id: "use-1",
		signature: "use",
		result: "use-result",
		source_refs: [ref("knowledge-1"), ref("intent-usage")],
	}),
];
const boardWithoutFact = projectBoard(usageRows);
const adopted = projectKnowledgeUsage(usageRows, episode, boardWithoutFact);
assert.equal(adopted.length, 1);
assert.equal(adopted[0].status, "adopted", "no independent Outcome -> not used");
assert.equal(adopted[0].intent_event_id, "intent-usage");
assert.equal(adopted[0].action_event_id, "req-use-1");
const factUsage = oracleSuccess("oracle-usage", "done-use-1");
const usageWithFact = [...usageRows, factUsage];
const used = projectKnowledgeUsage(usageWithFact, episode, projectBoard(usageWithFact));
assert.equal(used[0].status, "used");
assert.equal(used[0].outcome_event_id, "oracle-usage");
// A selection with no Intent/action evidence stays selected (unknown usage).
const loneSelection = projectKnowledgeUsage([start, knowledgeEvent], episode, projectBoard([start, knowledgeEvent]));
assert.equal(loneSelection[0].status, "selected");
assert.equal(loneSelection[0].intent_event_id, null);
assert.equal(loneSelection[0].action_event_id, null);

console.log(
	"Work cycle phase2: review consumption, two counters, unit binding, retrieval retry, frozen policy, rotation identity and usage refs passed",
);
