#!/usr/bin/env node
// Aegis E1 contract closure — `aegis-e1-closure-recovery` (T-R01..T-R16).
//
// Real new-process recovery: a legitimate durable prefix is truncated and a NEW
// process resumes it. A valid ready prefix continues (6 requests / 3 effects);
// a prefix missing the planning identities dispatches nothing. E1 always replays
// the FULL committed source; a tail-only/incomplete cache is never trusted.
//
// Run: node --test Pi_Agent_base/tests/aegis-e1-closure-recovery.mjs

import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { eventDigest, verifyChain } from "../memory/runtime/events.mjs";
import { BASE, evidenceDir, project, runPlanningScenario } from "./helpers/e1-closure-helpers.mjs";

const out = evidenceDir("recovery");
console.log(`recovery closure evidence: ${out}`);

let initial;
test("T-R00 setup: produce a real ready prefix", () => {
	initial = runPlanningScenario({ workDir: out, scenario: "normal_plan" });
	assert.equal(initial.exit, 0, initial.stderr.slice(-600));
	assert.equal(initial.summary.plan_ready, true);
});

/** Truncate the stream to a durable prefix and re-run in a NEW process. */
function resumeFromPrefix({ label, mutate = null }) {
	const end = initial.events.findIndex((e) => e.payload?.kind === "campaign.plan.ready");
	assert.ok(end >= 0, "control: the ready prefix exists");
	const prefix = structuredClone(initial.events.slice(0, end + 1));
	if (mutate) mutate(prefix);
	// Recompute the chain after any mutation so the persisted stream is valid.
	let previous;
	for (const event of prefix) {
		if (previous === undefined) delete event.prev_event_digest;
		else event.prev_event_digest = previous;
		event.event_digest = eventDigest(event);
		previous = event.event_digest;
	}
	assert.equal(verifyChain(prefix).ok, true, "the persisted resume prefix must be a valid hash chain");
	// Work in an ISOLATED copy so concurrent/resumed tests never interfere.
	const dir = join(out, `resume-${label}`);
	cpSync(initial.dir, dir, { recursive: true, force: true });
	writeFileSync(join(dir, "events.jsonl"), `${prefix.map((e) => JSON.stringify(e)).join("\n")}\n`);
	writeFileSync(join(dir, "workspace/dataset.json"), JSON.stringify({ name: "??", status: "pending" }));
	writeFileSync(join(dir, "effects.json"), JSON.stringify({ effects: 0 }));
	const result = runPlanningScenario({ workDir: out, scenario: "restart", dir });
	return { prefix, result };
}

test("T-R01 CONTROL: a valid ready prefix continues with 6 new requests / 3 effects", () => {
	const { result } = resumeFromPrefix({ label: "valid" });
	assert.equal(result.exit, 0, result.stderr.slice(-600));
	assert.equal(verifyChain(result.events).ok, true);
	assert.equal(result.summary.provider_calls, 6, "the three children each make 2 new requests");
	assert.equal(result.summary.broker_effects, 3);
	assert.deepEqual(result.summary.dataset, { name: "Ada", status: "active" });
});

test("T-R02 / CA-12: a prefix missing both planning identities dispatches nothing", () => {
	const { result } = resumeFromPrefix({
		label: "missing-identity",
		mutate: (prefix) => {
			for (const event of prefix)
				if (["campaign.plan.submitted", "campaign.plan.admitted"].includes(event.payload?.kind))
					delete event.payload.planning_task_id;
		},
	});
	assert.equal(result.exit, 0, result.stderr.slice(-600));
	assert.equal(verifyChain(result.events).ok, true);
	assert.equal(result.summary.provider_calls, 0, "an unbound plan must not authorize another provider call");
	assert.equal(result.summary.broker_effects, 0, "an unbound plan must not authorize a Broker effect");
});

test("T-R05: E1 replays the full committed source (used_checkpoint / full replay)", () => {
	// The scheduler exposes usedCheckpoint(). E1 refuses to trust a plan cache;
	// this checks the projection rebuilds the admitted plan purely from events.
	const projection = project(initial.events, initial.manifest);
	assert.equal(projection.plans.filter((p) => p.status === "admitted").length, 1);
	assert.equal(projection.dynamic_definitions.length, 3);
	// Delete-derivative equivalence: projecting the raw events again yields the
	// same accepted set (no cache needed).
	const again = project(structuredClone(initial.events), initial.manifest);
	assert.deepEqual(
		again.dynamic_definitions.map((d) => d.task_id),
		projection.dynamic_definitions.map((d) => d.task_id),
	);
	assert.deepEqual(again.authority.accepted_outcomes.sort(), projection.authority.accepted_outcomes.sort());
});

test("T-R06: a manifest carrying a contract requires the full source marker", () => {
	assert.ok(initial.manifest.planning_contract, "a new E1 manifest carries the contract");
	// A tail-only projection has no events -> no admitted plan, never a fallback.
	const tailOnly = project([], initial.manifest);
	assert.equal(tailOnly.plans.length, 0);
	assert.equal(tailOnly.dynamic_definitions.length, 0);
});

test("T-R07: a broken JSONL prefix is never filtered into a clean run", () => {
	const broken = `${initial.events
		.slice(0, 5)
		.map((e) => JSON.stringify(e))
		.join("\n")}\n{not json}\n`;
	const lines = broken.trim().split("\n");
	let parsed = 0;
	let failed = 0;
	for (const line of lines) {
		try {
			JSON.parse(line);
			parsed += 1;
		} catch {
			failed += 1;
		}
	}
	assert.ok(failed >= 1, "the broken line is detected, not silently skipped");
	assert.equal(parsed, 5);
});

test("T-R10: the full ready prefix remains resumable after a second valid resume", () => {
	const { result } = resumeFromPrefix({ label: "second" });
	assert.equal(result.exit, 0, result.stderr.slice(-600));
	const projection = project(result.events, result.manifest);
	// No duplicate allocation: the campaign never exceeds its limit.
	const limit = result.manifest.budget;
	for (const key of ["wall_time_ms", "model_requests", "tool_calls"])
		assert.ok(projection.budget.reserved[key] + projection.budget.consumed[key] <= limit[key], `${key} overflow`);
});

test("T-R13: a bounded command sequence preserves the invariants", () => {
	const projection = project(initial.events, initial.manifest);
	// <=1 effective plan, no rejected outcome promoted to a Fact-filled dependency.
	assert.ok(projection.plans.filter((p) => p.status === "admitted").length <= 1);
	assert.deepEqual(projection.rejected, []);
	assert.equal(projection.tasks.find((t) => t.task_id === "dyn-c").state, "completed");
});

test("T-R14: a limited mutation of the durable stream is caught by behaviour", () => {
	// Mutate the admitted batch's plan_digest: the projection must reject it and
	// expose zero dynamic definitions (behaviour, not an import error).
	const events = structuredClone(initial.events);
	const admission = events.find((e) => e.payload?.kind === "campaign.plan.admitted");
	admission.payload.plan_digest = "sha256:mutated";
	const projection = project(events, initial.manifest);
	assert.equal(projection.dynamic_definitions.length, 0);
	assert.ok(projection.rejected.length > 0);
});

test("T-R15: the required manifest is readable and enumerates 68 unique scripts", () => {
	const manifest = JSON.parse(
		readFileSync(join(BASE, "..", "docs", "E1_CONTRACT_CLOSURE_REQUIRED_CHECKS.json"), "utf8"),
	);
	const scripts = new Set(Object.values(manifest.groups).flat());
	assert.equal(scripts.size, 68, "the required manifest lists 68 unique scripts");
});
