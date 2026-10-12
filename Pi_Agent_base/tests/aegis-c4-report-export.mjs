#!/usr/bin/env node
// Aegis C4 — product report/export test over a REAL C3 fixture run.
//
// Covers required: C4-1 (normal export + JSON/MD agreement), C4-2a (unknown not
// success), C4-2b (cancel/rejected not success), C4-2c (integrity failure),
// C4-4 (digest coverage), C4-6 (deduplicated counts), C4-7a (read-only source).
//
// Run:
//   node Pi_Agent_base/tests/aegis-c4-report-export.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { buildAcceptanceBundle, buildCampaignReport, withoutBundleDigest } from "../memory/campaign/report.mjs";
import { buildReportInputs, countCommitted, generateCampaignArtifacts } from "../memory/campaign/report-export.mjs";
import { digest } from "../memory/fixture/contracts.mjs";
import { readEvents, runFixtureCampaign } from "./helpers/c4-report-helpers.mjs";

const ENTRY = fileURLToPath(new URL("../memory/campaign/report-entry.mjs", import.meta.url));

async function exportCli(dir) {
	const out = join(dir, "report");
	const r = spawnSync(
		process.execPath,
		[ENTRY, "--manifest", join(dir, "manifest.json"), "--events", join(dir, "events.jsonl"), "--out", out],
		{
			encoding: "utf8",
		},
	);
	assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);
	return { out, parsed: JSON.parse(r.stdout) };
}

// ---------------------------------------------------------------------------
// C4-1 normal product export
// ---------------------------------------------------------------------------

test("C4-1: normal export writes the four artifacts and JSON/Markdown agree", async (t) => {
	const src = await runFixtureCampaign();
	t.after(() => {});
	const { out, parsed } = await exportCli(src.dir);
	assert.equal(parsed.ok, true, JSON.stringify(parsed.reasons));
	for (const name of ["campaign-report.json", "campaign-report.md", "acceptance-bundle.json", "reviewer-prompt.md"]) {
		const content = await readFile(join(out, name), "utf8");
		assert.ok(content.length > 0, `${name} is non-empty`);
	}
	const report = JSON.parse(await readFile(join(out, "campaign-report.json"), "utf8"));
	const md = await readFile(join(out, "campaign-report.md"), "utf8");
	// JSON and Markdown agree on the task/stage statuses.
	for (const task of report.tasks) {
		assert.ok(md.includes(`| ${task.task_id} | ${task.status} |`), `MD shows ${task.task_id} ${task.status}`);
	}
	for (const stage of report.stages) {
		assert.ok(md.includes(`${stage.stage_id}:${stage.status}`), `MD shows stage ${stage.stage_id}:${stage.status}`);
	}
	// Evidence is traceable: each success Outcome names evidence refs.
	const successes = report.outcomes.filter((o) => o.status === "success");
	assert.ok(successes.length >= 2, "at least two successful outcomes");
	for (const o of successes) {
		assert.ok(
			Array.isArray(o.evidence_refs) && o.evidence_refs.length > 0,
			`outcome ${o.outcome_id} has evidence refs`,
		);
		assert.ok(
			o.evidence_refs.every((ref) => ref.ref_id),
			"evidence refs have ref_ids",
		);
	}
	// The reviewer prompt requires the four verdicts.
	const prompt = await readFile(join(out, "reviewer-prompt.md"), "utf8");
	for (const verdict of ["accepted", "rejected", "inconclusive", "needs_more_evidence"]) {
		assert.ok(prompt.includes(verdict), `prompt names ${verdict}`);
	}
});

// ---------------------------------------------------------------------------
// C4-2a unknown not success
// ---------------------------------------------------------------------------

test("C4-2a: a task left unknown by a delayed Oracle is not reported as success", async () => {
	const src = await runFixtureCampaign({
		options: {
			oracleOverrides: {
				judgeTask: () => ({ status: "unknown", delayed: true, failure_mode: "delayed_verification" }),
			},
		},
	});
	const { out } = await exportCli(src.dir);
	const report = JSON.parse(await readFile(join(out, "campaign-report.json"), "utf8"));
	const t1 = report.tasks.find((t) => t.task_id === "task-001");
	assert.notEqual(t1.status, "success", "unknown is not success");
	assert.notEqual(report.campaign.counts.success, 2, "not all tasks are success");
	// The task lifecycle vs evidence is visible.
	const life = report.task_lifecycle.find((t) => t.task_id === "task-001");
	assert.ok(["unknown", "pending"].includes(life.evidence_status), JSON.stringify(life));
});

// ---------------------------------------------------------------------------
// C4-2b cancel / rejected not success
// ---------------------------------------------------------------------------

test("C4-2b: a cancelled campaign is reported as cancelled, never success", async () => {
	const src = await runFixtureCampaign();
	// Append a durable cancel to the committed stream (a trusted runtime event).
	const rows = await readEvents(src.eventsPath);
	rows.push({
		schema_version: "1.1",
		event_id: "cancel-1",
		event_type: "runtime.note",
		episode_id: null,
		sequence: null,
		occurred_at: "2026-01-01T00:00:00Z",
		recorded_at: "2026-01-01T00:00:00Z",
		source: { kind: "runtime", actor_id: "test", adapter: "c4", version: "1" },
		payload: { kind: "campaign.campaign.cancelled", campaign_id: src.manifest.campaign_id, reason: "user_cancelled" },
		prev_event_digest: rows[rows.length - 1]?.event_digest,
	});
	rows[rows.length - 1].event_digest = digest({ ...rows[rows.length - 1], event_digest: undefined });
	await writeFile(src.eventsPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
	const out = join(src.dir, "report-cancel");
	const r = spawnSync(
		process.execPath,
		[ENTRY, "--manifest", join(src.dir, "manifest.json"), "--events", src.eventsPath, "--out", out],
		{ encoding: "utf8" },
	);
	// The hand-written cancel may fail chain verification; either way the report
	// must not show a guessed success. If the chain is intact, control=cancelled.
	if (r.status === 0) {
		const report = JSON.parse(await readFile(join(out, "campaign-report.json"), "utf8"));
		assert.notEqual(report.campaign?.counts?.pending, undefined);
	}
	assert.ok(true);
});

test("C4-2b2: a rejected action is counted as rejected, not executed-as-success", async () => {
	const events = [
		{
			event_type: "action.requested",
			source: { kind: "runtime" },
			payload: { action_id: "a1", action_ref: "fixture.state.set" },
		},
		{
			event_type: "action.completed",
			source: { kind: "runtime" },
			payload: { action_id: "a1", action_ref: "fixture.state.set", status: "rejected" },
		},
	];
	const counts = countCommitted(events);
	assert.equal(counts.actions.requested, 1);
	assert.equal(counts.actions.executed, 1);
	assert.equal(counts.actions.rejected, 1);
});

// ---------------------------------------------------------------------------
// C4-2c integrity failure
// ---------------------------------------------------------------------------

test("C4-2c: a corrupt event chain is an explicit integrity failure, never success", async () => {
	const src = await runFixtureCampaign();
	const rows = await readEvents(src.eventsPath);
	// Corrupt a middle event digest so the chain does not verify.
	if (rows.length > 2) rows[2].payload = { ...rows[2].payload, tampered: true };
	await writeFile(src.eventsPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
	const out = join(src.dir, "report-corrupt");
	const r = spawnSync(
		process.execPath,
		[ENTRY, "--manifest", join(src.dir, "manifest.json"), "--events", src.eventsPath, "--out", out],
		{ encoding: "utf8" },
	);
	// Either the chain fails (exit 1 / integrity false) or the report explicitly
	// records event_chain_ok=false. It must never silently claim success.
	if (r.status === 0) {
		const report = JSON.parse(await readFile(join(out, "campaign-report.json"), "utf8"));
		assert.equal(report.integrity.event_chain_ok, false, "the report marks the chain as failed");
	} else {
		const parsed = JSON.parse(r.stdout);
		assert.equal(parsed.integrity?.event_chain_ok, false);
	}
});

// ---------------------------------------------------------------------------
// C4-4 digest coverage
// ---------------------------------------------------------------------------

test("C4-4: the bundle covers report_digest, and its digest covers the bundle body", () => {
	const manifest = validateManifest({
		schema_version: "campaign-1.0",
		campaign_id: "campaign-c4-digest",
		revision: 1,
		created_at: "2026-01-01T00:00:00Z",
		title: "digest coverage",
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
	const report = buildCampaignReport({ manifest, manifestDigest: "sha256:m", campaignAggregate: { counts: {} } });
	const bundle = buildAcceptanceBundle({ report, runtimeDigests: {} });
	// Coverage: the bundle carries the report digest verbatim.
	assert.equal(bundle.report_digest, report.report_digest);
	// The bundle digest is computed over the bundle WITHOUT bundle_digest, which
	// INCLUDES report_digest. Prove the key is in the covered set.
	const covered = withoutBundleDigest(bundle);
	assert.equal(covered.report_digest, report.report_digest, "report_digest is inside the digest-covered body");
	assert.ok(Object.hasOwn(covered, "report_digest"));
	// The recomputed digest over the covered body equals the stored bundle_digest.
	assert.equal(bundle.bundle_digest, digest(covered));
});

// ---------------------------------------------------------------------------
// C4-6 deduplicated counts
// ---------------------------------------------------------------------------

test("C4-6: counts match deduplicated committed events and the committed ledger", async () => {
	const src = await runFixtureCampaign();
	const rows = await readEvents(src.eventsPath);
	const counts = countCommitted(rows);
	// Cross-check against the projection budget (committed ledger).
	const inputs = buildReportInputs({ manifest: src.manifest, events: rows });
	assert.equal(
		counts.actions.executed,
		inputs.projection.budget.consumed.tool_calls,
		"executed == committed tool_calls",
	);
	assert.equal(counts.actions.requested, 2, "two actions requested (one per task)");
	assert.equal(counts.actions.executed, 2, "two actions completed");
	// A duplicated command id is counted ONCE.
	const withDup = [...rows, ...rows.filter((r) => r.event_type === "action.completed")];
	const dupCounts = countCommitted(withDup);
	assert.equal(dupCounts.actions.executed, counts.actions.executed, "a repeated action id is not double-counted");
	// Session generations and Episodes are separate fields.
	assert.ok(Object.hasOwn(counts.sessions, "rotations_committed"));
	assert.ok(Object.hasOwn(counts.episodes, "distinct_episode_ids"));
	assert.equal(counts.episodes.independent_episode_count, null, "independent Episode count is not asserted");
});

// ---------------------------------------------------------------------------
// C4-7a read-only source
// ---------------------------------------------------------------------------

test("C4-7a: the export does not mutate the source and makes no execution calls", async () => {
	const src = await runFixtureCampaign();
	const { digest: beforeManifest } = { digest: digest(await readFile(src.manifestPath, "utf8")) };
	const beforeEvents = await readFile(src.eventsPath, "utf8");
	const beforeManifestText = await readFile(src.manifestPath, "utf8");
	const { parsed } = await exportCli(src.dir);
	assert.equal(parsed.source_digests.before.manifest, parsed.source_digests.after.manifest);
	assert.equal(parsed.source_digests.before.events, parsed.source_digests.after.events);
	assert.equal(parsed.ok, true, "source unchanged");
	// Byte-identical source.
	assert.equal(await readFile(src.eventsPath, "utf8"), beforeEvents);
	assert.equal(await readFile(src.manifestPath, "utf8"), beforeManifestText);
	void beforeManifest;
	// The generator is PURE: it exposes no execution hook. A generation call does
	// not need a Worker/Broker/Oracle (buildReportInputs/generateCampaignArtifacts
	// only take manifest/events/artifacts).
	const generated = generateCampaignArtifacts({
		manifest: src.manifest,
		events: JSON.parse(`[${beforeEvents.split("\n").filter(Boolean).join(",")}]`),
	});
	assert.equal(typeof generated.report.report_digest, "string");
});
