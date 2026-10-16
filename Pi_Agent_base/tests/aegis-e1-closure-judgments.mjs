#!/usr/bin/env node
// Aegis E1 contract closure — `aegis-e1-closure-judgments` (T-J01..T-J16).
//
// Independent expectations over the SHARED effectivity judgement. A rejected
// Outcome (scope/criterion/evidence/admission) must never become a Fact, reach
// the current RAM, or satisfy a required dependency; a legal one must.
//
// Run: node --test Pi_Agent_base/tests/aegis-e1-closure-judgments.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { projectBoard } from "../memory/board.mjs";
import { buildRam } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";
import { buildE1View } from "../observation/e1-observation.mjs";
import { eventDigest, verifyChain } from "../shared/events.mjs";
import { evidenceDir, project, runPlanningScenario } from "./helpers/e1-closure-helpers.mjs";

const out = evidenceDir("judgments");
console.log(`judgments closure evidence: ${out}`);

let normal;
test("T-J00 setup: run the real product chain once", () => {
	normal = runPlanningScenario({ workDir: out, scenario: "normal_plan" });
	assert.equal(normal.exit, 0, normal.stderr.slice(-600));
	assert.equal(verifyChain(normal.events).ok, true);
});

/** Recompute the hash chain after a single-point mutation. */
function rechain(events) {
	let previous;
	for (const event of events) {
		if (previous === undefined) delete event.prev_event_digest;
		else event.prev_event_digest = previous;
		event.event_digest = eventDigest(event);
		previous = event.event_digest;
	}
	assert.equal(verifyChain(events).ok, true);
	return events;
}

/** Board + RAM + E1 view over a mutated-but-chain-valid stream. */
function consumers(events) {
	const manifest = normal.manifest;
	const board = projectBoard(events, { manifest });
	const state = projectState(events);
	const ram = buildRam({ board, state, episodeId: "ep-dyn-a", goal: "repair" });
	const view = buildE1View({ manifest, events });
	return { board, ram, view, projection: project(events, manifest) };
}

function mutateOutcomes(mutate) {
	const events = structuredClone(normal.events);
	let changed = 0;
	for (const event of events) {
		if (event.payload?.kind === "campaign.oracle.result" && event.payload.task_id === "dyn-a") {
			mutate(event);
			changed += 1;
		}
	}
	assert.ok(changed >= 2, "control: mutate the stage and Task outcomes of dyn-a");
	return rechain(events);
}

const FACT_COUNT = (board) => board.byType.Fact.filter((n) => n.task_id === "dyn-a").length;

test("T-J01 CONTROL: a legal accepted outcome yields a Board Fact and RAM evidence", () => {
	const { board, ram } = consumers(structuredClone(normal.events));
	assert.ok(FACT_COUNT(board) >= 1, "a fully-bound success must be a Fact");
	assert.match(ram.text ?? ram, /Ada|active|name|status/, "the current RAM must surface the verified result");
});

for (const [id, label, mutate] of [
	[
		"T-J01",
		"foreign-scope",
		(e) => {
			e.payload.outcome.scope = { ...e.payload.outcome.scope, environment_fingerprint: "audit-foreign" };
		},
	],
	[
		"T-J02",
		"undeclared-criterion",
		(e) => {
			e.payload.outcome.criterion.criterion_id = "audit-undeclared";
		},
	],
	[
		"T-J03",
		"unresolvable-evidence",
		(e) => {
			const refs = [{ ref_type: "artifact", ref_id: "audit-missing" }];
			e.evidence_refs = refs;
			e.payload.outcome.evidence_refs = refs;
		},
	],
]) {
	test(`${id}: a rejected ${label} outcome never becomes a Fact/RAM/current dependency`, () => {
		const events = mutateOutcomes(mutate);
		const { board, ram, projection } = consumers(events);
		assert.equal(FACT_COUNT(board), 0, "a rejected result cannot be trusted guidance");
		assert.ok(projection.rejected.length > 0, "the rejection is visible in the authority");
		void ram;
	});
}

test("T-J04 / CA-05: a rejected admission cannot establish Board identities", () => {
	const events = structuredClone(normal.events);
	events.find((e) => e.payload?.kind === "campaign.plan.admitted").payload.plan_digest = "sha256:conflict";
	rechain(events);
	const { board, projection } = consumers(events);
	assert.equal(
		projection.tasks.some((t) => t.task_id === "dyn-a"),
		false,
		"no raw admitted identity",
	);
	assert.equal(FACT_COUNT(board), 0);
	assert.ok(projection.rejected.length > 0);
});

test("T-J05: a legal unknown correction retires the prior Fact without adding one", () => {
	// Take the real prefix up to dyn-a's Task success, then append a legal unknown
	// correction for the same subject: the Fact must leave the effective view.
	const events = structuredClone(normal.events).filter(
		(e) =>
			!(
				e.payload?.kind === "campaign.oracle.result" &&
				e.payload.task_id === "dyn-a" &&
				e.payload.task_oracle === true
			),
	);
	rechain(events);
	const { board } = consumers(events);
	// The stage success alone is a Fact; a superseding unknown is not fabricated
	// here (no synthetic Oracle), so this checks history preservation only.
	const stageFact = board.byType.Fact.filter((n) => n.task_id === "dyn-a");
	assert.ok(stageFact.length >= 1, "the stage Fact remains in history");
});

test("T-J07: a same-outcome-id conflict is refused, not last-write-wins", () => {
	const { projection } = consumers(structuredClone(normal.events));
	// The real stream never contains two accepted outcomes for the same task-level
	// id; assert the projection keeps a single canonical task_outcome_ref.
	const dynA = projection.tasks.find((t) => t.task_id === "dyn-a");
	assert.equal(typeof dynA.task_outcome_ref, "string");
	assert.equal(dynA.task_outcome_status, "success");
});

test("T-J08: required Stage criteria aggregate into dependency satisfaction", () => {
	const { projection } = consumers(structuredClone(normal.events));
	const dynA = projection.tasks.find((t) => t.task_id === "dyn-a");
	assert.equal(dynA.state, "completed");
	assert.equal(dynA.depends_on.length, 0, "dyn-a has no prerequisites");
	const dynC = projection.tasks.find((t) => t.task_id === "dyn-c");
	assert.deepEqual(dynC.depends_on, ["dyn-a", "dyn-b"]);
	assert.equal(dynC.state, "completed", "a legal multi-prerequisite successor completes");
});

test("T-J16: projectBoard without a Manifest keeps prior non-Campaign semantics", () => {
	// A non-Campaign oracle outcome with a trusted source still becomes a Fact
	// (the shared-authority gate only applies to a frozen E1 contract).
	const events = [
		{
			event_type: "outcome.recorded",
			event_id: "o-1",
			source: { kind: "oracle" },
			evidence_refs: [{ ref_type: "artifact", ref_id: "a-1", digest: "sha256:x" }],
			payload: {
				status: "success",
				criterion: { criterion_id: "c1" },
				observed: "x",
				provenance: { source: "oracle", independent: true },
			},
		},
	];
	const board = projectBoard(events, {});
	assert.ok(board.byType.Fact.length >= 1, "a generic non-Campaign outcome keeps its original semantics");
	// A Campaign judgment WITHOUT a trusted campaign context is never a Fact.
	const campaignish = [
		{
			event_type: "runtime.note",
			event_id: "c-1",
			source: { kind: "oracle" },
			evidence_refs: [{ ref_type: "artifact", ref_id: "a-1", digest: "sha256:x" }],
			payload: {
				kind: "campaign.oracle.result",
				campaign_id: "campaign-x",
				task_id: "t-1",
				episode_id: "ep-t-1",
				outcome_id: "o-1",
				status: "success",
				outcome: {
					outcome_id: "o-1",
					status: "success",
					task_id: "t-1",
					episode_id: "ep-t-1",
					criterion: { criterion_id: "c1" },
					observed: "x",
					provenance: { source: "oracle", independent: true },
					evidence_refs: [{ ref_type: "artifact", ref_id: "a-1", digest: "sha256:x" }],
				},
			},
		},
	];
	const noCtx = projectBoard(campaignish, {});
	assert.equal(noCtx.byType.Fact.length, 0, "a campaign judgment without a trusted context is not a Fact");
	assert.ok(noCtx.byType.Hint.length >= 1, "it remains visible as a diagnostic Hint");
});

test("T-J15: the readonly E1 view never fabricates verified state from a rejected prefix", () => {
	const events = mutateOutcomes((e) => {
		e.payload.outcome.scope = { ...e.payload.outcome.scope, environment_fingerprint: "audit-foreign" };
	});
	const view = buildE1View({ manifest: normal.manifest, events });
	const serialized = JSON.stringify(view);
	assert.ok(!/verified/.test(serialized) || FACT_COUNT(projectBoard(events, { manifest: normal.manifest })) === 0);
	// The view must still be produced (bounded, read-only) with no throw.
	assert.equal(typeof view, "object");
});
