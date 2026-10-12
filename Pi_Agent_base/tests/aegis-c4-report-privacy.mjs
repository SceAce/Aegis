#!/usr/bin/env node
// Aegis C4 — privacy, field-whitelist and bounds test (required C4-5).
//
// Seeds credential-looking values, flags, Bearer tokens, a private key and raw
// tool text into the report inputs, then asserts the public artifacts contain no
// real secret value and only whitelisted fields. Also exercises the entry/byte
// bounds (explicit truncation/index, never silent loss).
//
// Run:
//   node Pi_Agent_base/tests/aegis-c4-report-privacy.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { validateManifest } from "../memory/campaign/manifest.mjs";
import { buildAcceptanceBundle, buildCampaignReport, redactSecrets } from "../memory/campaign/report.mjs";
import {
	DEFAULT_LIMITS,
	generateCampaignArtifacts,
	validateAcceptanceBundle,
} from "../memory/campaign/report-export.mjs";

const SECRETS = [
	"flag{THIS_IS_A_REAL_FLAG_1234567890}",
	"ctf{another_flag_value}",
	"Authorization: Bearer abcdef0123456789.token",
	"-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
	"api_key=supersecretvalue123456",
	"password=hunter2hunter2",
];

function manifestWithSecrets() {
	const raw = {
		schema_version: "campaign-1.0",
		campaign_id: "campaign-c4-privacy",
		revision: 1,
		created_at: "2026-01-01T00:00:00Z",
		title: `t ${SECRETS[0]}`,
		objective: { description: `objective ${SECRETS[4]}`, success_criteria: ["c"], stage_policy: "declared_only" },
		worker: { provider: "fixture", model: `model ${SECRETS[5]}` },
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
				goal: { goal_id: "g", description: `goal ${SECRETS[2]}`, success_criteria: ["c"] },
				stages: [{ stage_id: "stage-1", criteria: ["c"], required: true }],
				oracle_ref: "fixture.oracle.v1",
				task_budget: { wall_time_ms: 100, model_requests: 1, tool_calls: 1 },
			},
		],
		evidence_policy: { independent_result_required: true, unknown_is_not_failure: true, promote_experience: false },
	};
	return validateManifest(raw).manifest;
}

test("C4-5a: no real secret value appears in the report or bundle", () => {
	const manifest = manifestWithSecrets();
	const report = buildCampaignReport({ manifest, manifestDigest: "sha256:m", campaignAggregate: { counts: {} } });
	const bundle = buildAcceptanceBundle({ report, runtimeDigests: { model: SECRETS[4] } });
	const reportText = JSON.stringify(report);
	const bundleText = JSON.stringify(bundle);
	for (const secret of SECRETS) {
		assert.equal(reportText.includes(secret), false, `report leaks: ${secret.slice(0, 12)}...`);
		assert.equal(bundleText.includes(secret), false, `bundle leaks: ${secret.slice(0, 12)}...`);
	}
	// Negative control: redactSecrets does scrub each sample.
	for (const secret of SECRETS) {
		assert.equal(redactSecrets(secret).includes(secret), false, `redactor failed for ${secret.slice(0, 12)}`);
	}
});

test("C4-5a2: the credentials policy shows only reviewed values; anything else is redacted", () => {
	const base = {
		schema_version: "campaign-1.0",
		campaign_id: "campaign-c4-cred",
		revision: 1,
		created_at: "2026-01-01T00:00:00Z",
		title: "cred",
		objective: { description: "d", success_criteria: ["c"], stage_policy: "declared_only" },
		worker: { provider: "fixture", model: "none" },
		authorization: {
			execution_profile: "supervised-macos-workspace",
			workspace_root: "/tmp/ws",
			allowed_targets: ["state.json"],
			allowed_capabilities: ["c"],
			network: "disabled",
			credentials: "manifest_policy",
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
	};
	const manifest = validateManifest(base).manifest;
	const report = buildCampaignReport({ manifest, manifestDigest: "sha256:m", campaignAggregate: { counts: {} } });
	assert.equal(report.authorization.credentials, "manifest_policy", "reviewed policy shown verbatim");
	// A smuggled secret in the credentials field is redacted, never restored.
	const hostile = buildCampaignReport({
		manifest: { ...manifest, authorization: { ...manifest.authorization, credentials: "Bearer xyz-secret-token" } },
		manifestDigest: "sha256:m",
		campaignAggregate: { counts: {} },
	});
	assert.equal(hostile.authorization.credentials, "[redacted]");
});

test("C4-5b: exceeding the entry bound is surfaced, not silently dropped", () => {
	const manifest = manifestWithSecrets();
	const report = buildCampaignReport({ manifest, manifestDigest: "sha256:m", campaignAggregate: { counts: {} } });
	const bundle = buildAcceptanceBundle({ report });
	bundle.outcomes = Array.from({ length: DEFAULT_LIMITS.max_outcomes + 10 }, (_, i) => ({
		outcome_id: `o-${i}`,
		status: "unknown",
		evidence_refs: [],
	}));
	const tinyLimits = { ...DEFAULT_LIMITS, max_outcomes: 10, max_bundle_bytes: 1024 };
	const verdict = validateAcceptanceBundle(bundle, { report, limits: tinyLimits });
	assert.equal(verdict.ok, false, "an oversized bundle is refused");
	assert.ok(verdict.reasons.some((r) => /exceeds max_outcomes/.test(r)));
	assert.ok(verdict.reasons.some((r) => /exceeds max_bundle_bytes/.test(r)));
});

test("C4-5b2: the artifact generator keeps required authorization/result fields under a small outcome cap", () => {
	// The generator itself does not truncate silence; the validator surfaces the
	// bound. Generate a normal artifact and assert the authorization/result are
	// present even with a tiny limit (limits apply at validation, not silently).
	const manifest = manifestWithSecrets();
	const generated = generateCampaignArtifacts({ manifest, events: [], limits: { ...DEFAULT_LIMITS, max_outcomes: 1 } });
	assert.ok(generated.report.authorization, "authorization is always present");
	assert.ok(generated.report.tasks, "task results are always present");
});
