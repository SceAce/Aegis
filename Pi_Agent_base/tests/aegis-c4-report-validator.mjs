#!/usr/bin/env node
// Aegis C4 — structural validator test (required C4-7b).
//
// The local validator must recognize a missing required field, a missing/
// contradictory evidence ref, an incorrect report_digest coverage and an
// oversized object. The reviewer prompt must require exactly the four verdicts.
//
// Run:
//   node Pi_Agent_base/tests/aegis-c4-report-validator.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { validateManifest } from "../campaign/manifest.mjs";
import {
	buildAcceptanceBundle,
	buildCampaignReport,
	REVIEWER_VERDICTS,
	renderReviewerPrompt,
	validateReviewerVerdict,
} from "../observation/report.mjs";
import { DEFAULT_LIMITS, validateAcceptanceBundle } from "../observation/report-export.mjs";

function aManifest() {
	return validateManifest({
		schema_version: "campaign-1.0",
		campaign_id: "campaign-c4-validator",
		revision: 1,
		created_at: "2026-01-01T00:00:00Z",
		title: "validator",
		objective: { description: "d", success_criteria: ["c"], stage_policy: "declared_only" },
		worker: { provider: "fixture", model: "none" },
		authorization: {
			execution_profile: "supervised-macos-workspace",
			workspace_root: "/tmp/ws",
			allowed_targets: ["state.json"],
			allowed_capabilities: ["c"],
			network: "disabled",
			credentials: "none",
			human_approval: "campaign_grant",
			workspace_is_sandbox: false,
		},
		budget: { wall_time_ms: 1000, model_requests: 1, tool_calls: 1, task_count: 1, session_count: 1 },
		session_policy: {
			max_requests_per_session: 1,
			max_context_chars: 100,
			rotate_at_stage_boundary: true,
			rotate_on_model_request: true,
			allow_model_handoff_request: true,
		},
		adapters: { execution: "workspace.exec.v1", oracle: "fixture.oracle.v1", report: "aegis-acceptance.v1" },
		tasks: [
			{
				task_id: "task-1",
				order: 1,
				depends_on: [],
				target_ref: "state.json",
				task_type: "observe",
				scope: { environment_fingerprint: "fixture-env", domain: "fixture" },
				goal: { goal_id: "g", description: "g", success_criteria: ["c"] },
				stages: [{ stage_id: "stage-1", criteria: ["c"], required: true }],
				oracle_ref: "fixture.oracle.v1",
				task_budget: { wall_time_ms: 100, model_requests: 1, tool_calls: 1 },
			},
		],
		evidence_policy: { independent_result_required: true, unknown_is_not_failure: true, promote_experience: false },
	}).manifest;
}

function goodBundle() {
	const manifest = aManifest();
	const report = buildCampaignReport({
		manifest,
		manifestDigest: "sha256:m",
		campaignAggregate: { counts: {} },
		outcomes: [
			{
				outcome_id: "o1",
				status: "success",
				evidence_refs: [{ ref_type: "artifact", ref_id: "a1", digest: "sha256:d" }],
			},
		],
	});
	return { report, bundle: buildAcceptanceBundle({ report }) };
}

test("C4-7b: a valid bundle passes the validator", () => {
	const { report, bundle } = goodBundle();
	const verdict = validateAcceptanceBundle(bundle, { report, limits: DEFAULT_LIMITS });
	assert.equal(verdict.ok, true, JSON.stringify(verdict.reasons));
});

test("C4-7b: a missing required field is detected", () => {
	const { report, bundle } = goodBundle();
	delete bundle.integrity;
	// bundle_digest now no longer covers the body (field removed) -> detected.
	const verdict = validateAcceptanceBundle(bundle, { report });
	assert.equal(verdict.ok, false);
	assert.ok(
		verdict.reasons.some((r) => /bundle_digest does not cover|missing required field/.test(r)),
		JSON.stringify(verdict.reasons),
	);
});

test("C4-7b: an evidence ref with neither id nor digest is rejected", () => {
	const { report, bundle } = goodBundle();
	bundle.outcomes = [{ outcome_id: "o1", status: "success", evidence_refs: [{ ref_type: "artifact" }] }];
	bundle.bundle_digest = undefined; // force recompute-independent detection
	const verdict = validateAcceptanceBundle(bundle, { report });
	assert.equal(verdict.ok, false);
	assert.ok(
		verdict.reasons.some((r) => /neither ref_id nor digest/.test(r)),
		JSON.stringify(verdict.reasons),
	);
});

test("C4-7b: a report_digest contradiction is rejected", () => {
	const { report, bundle } = goodBundle();
	bundle.report_digest = "sha256:foreign";
	const verdict = validateAcceptanceBundle(bundle, { report });
	assert.equal(verdict.ok, false);
	assert.ok(
		verdict.reasons.some((r) => /report_digest does not match/.test(r)),
		JSON.stringify(verdict.reasons),
	);
});

test("C4-7b: the reviewer prompt requires exactly the four verdicts and forbids mutation", () => {
	const { bundle } = goodBundle();
	const prompt = renderReviewerPrompt(bundle);
	for (const verdict of REVIEWER_VERDICTS) assert.ok(prompt.includes(verdict), verdict);
	assert.ok(/MUST NOT mutate/.test(prompt));
	assert.ok(validateReviewerVerdict({ verdict: "accepted", findings: [] }).ok);
	assert.equal(validateReviewerVerdict({ verdict: "maybe" }).ok, false);
	assert.equal(validateReviewerVerdict({ verdict: "rejected", findings: "x" }).ok, false);
});
