#!/usr/bin/env node
// C4 external review: source preservation, integrity, privacy, counts and bounds.
import assert from "node:assert/strict";
import { copyFile, link, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runReportExport } from "../observation/report-entry.mjs";
import {
	countCommitted,
	DEFAULT_LIMITS,
	generateCampaignArtifacts,
	validateAcceptanceBundle,
} from "../observation/report-export.mjs";
import { digest } from "../shared/contracts.mjs";
import { readEvents, runFixtureCampaign } from "./helpers/c4-report-helpers.mjs";

async function fixture(t) {
	const src = await runFixtureCampaign();
	t.after(() => rm(src.dir, { recursive: true, force: true }));
	return src;
}
function redigest(bundle) {
	const copy = { ...bundle };
	delete copy.bundle_digest;
	bundle.bundle_digest = digest(copy);
	return bundle;
}

test("CONTROL: same trusted input exports valid results and distinct semantic changes alter digests", async (t) => {
	const src = await fixture(t);
	const events = await readEvents(src.eventsPath);
	const a = generateCampaignArtifacts({ manifest: src.manifest, events });
	assert.equal(validateAcceptanceBundle(a.bundle, { report: a.report }).ok, true);
	const b = generateCampaignArtifacts({
		manifest: { ...src.manifest, objective: { ...src.manifest.objective, description: "changed" } },
		events,
	});
	assert.notEqual(a.digests.report_digest, b.digests.report_digest);
	assert.notEqual(a.digests.bundle_digest, b.digests.bundle_digest);
});

test("C4-X1: an output filename colliding with Manifest is rejected before modifying source", async (t) => {
	const src = await fixture(t);
	const manifestPath = join(src.dir, "campaign-report.json");
	await copyFile(src.manifestPath, manifestPath);
	const before = await readFile(manifestPath);
	const r = await runReportExport({ manifestPath, eventsPath: src.eventsPath, outDir: src.dir });
	assert.equal(r.ok, false);
	assert.deepEqual(await readFile(manifestPath), before);
});

test("C4-X1: output symlink to events cannot destroy source bytes", async (t) => {
	const src = await fixture(t);
	const before = await readFile(src.eventsPath);
	await symlink(src.eventsPath, join(src.dir, "campaign-report.json"));
	const r = await runReportExport({ manifestPath: src.manifestPath, eventsPath: src.eventsPath, outDir: src.dir });
	assert.equal(r.ok, false);
	assert.deepEqual(await readFile(src.eventsPath), before);
});

test("C4-X1: output hardlink to events is rejected before source mutation", async (t) => {
	const src = await fixture(t);
	const before = await readFile(src.eventsPath);
	await link(src.eventsPath, join(src.dir, "campaign-report.json"));
	const r = await runReportExport({ manifestPath: src.manifestPath, eventsPath: src.eventsPath, outDir: src.dir });
	assert.equal(r.ok, false);
	assert.deepEqual(await readFile(src.eventsPath), before);
});

test("C4-X2: tampered authoritative stream cannot yield successful Task evidence", async (t) => {
	const src = await fixture(t);
	const events = await readEvents(src.eventsPath);
	events[2].payload.tampered = true;
	const g = generateCampaignArtifacts({ manifest: src.manifest, events });
	assert.equal(g.report.integrity.event_chain_ok, false);
	assert.equal(
		g.report.tasks.some((x) => x.status === "success"),
		false,
	);
});

test("C4-X3: post-projection lifecycle/refs are redacted in every public artifact", async (t) => {
	const src = await fixture(t);
	const manifest = structuredClone(src.manifest);
	manifest.tasks[0].task_id = "task-api_key=abcdefgh12345678";
	manifest.tasks = manifest.tasks.slice(0, 1);
	const g = generateCampaignArtifacts({ manifest, events: [] });
	for (const text of [JSON.stringify(g.report), JSON.stringify(g.bundle), g.markdown, g.reviewerPrompt])
		assert.equal(text.includes("abcdefgh12345678"), false);
});

test("C4-X4: rejected completion is not counted as an executed effect", () => {
	const c = countCommitted([
		{ event_type: "action.requested", source: { kind: "runtime" }, payload: { action_id: "a" } },
		{ event_type: "action.completed", source: { kind: "runtime" }, payload: { action_id: "a", status: "rejected" } },
	]);
	assert.equal(c.actions.rejected, 1);
	assert.equal(c.actions.executed, 0);
});

test("C4-X4: model-source transport and handoff claims cannot increase trusted counts", () => {
	const c = countCommitted([
		{ event_type: "action.completed", source: { kind: "llm" }, payload: { action_id: "forged", status: "success" } },
		{ event_type: "handoff.completed", source: { kind: "llm" }, payload: { request_id: "forged" } },
	]);
	assert.equal(c.actions.executed, 0);
	assert.equal(c.sessions.rotations_committed, 0);
});

test("C4-X5: malformed bundle arrays return a validation failure rather than throw", async (t) => {
	const src = await fixture(t);
	const g = generateCampaignArtifacts({ manifest: src.manifest, events: await readEvents(src.eventsPath) });
	const bad = redigest({ ...g.bundle, outcomes: { unexpected: true } });
	assert.equal(validateAcceptanceBundle(bad, { report: g.report }).ok, false);
});

test("C4-X5: missing integrity is rejected even after correctly rehashing bundle", async (t) => {
	const src = await fixture(t);
	const g = generateCampaignArtifacts({ manifest: src.manifest, events: await readEvents(src.eventsPath) });
	const bad = structuredClone(g.bundle);
	delete bad.integrity;
	redigest(bad);
	assert.equal(validateAcceptanceBundle(bad, { report: g.report }).ok, false);
});

test("C4-X5: a changed report body cannot retain its stale digest", async (t) => {
	const src = await fixture(t);
	const g = generateCampaignArtifacts({ manifest: src.manifest, events: await readEvents(src.eventsPath) });
	g.report.objective.description = "tampered report";
	assert.equal(validateAcceptanceBundle(g.bundle, { report: g.report }).ok, false);
});

test("C4-X6: UTF-8 bytes and per-outcome reference bounds are enforced", async (t) => {
	const src = await fixture(t);
	const g = generateCampaignArtifacts({ manifest: src.manifest, events: await readEvents(src.eventsPath) });
	const large = redigest({ ...g.bundle, unicode_description: "界".repeat(1000) });
	const limit = JSON.stringify(large, null, 2).length + 2;
	assert.equal(
		validateAcceptanceBundle(large, { report: g.report, limits: { ...DEFAULT_LIMITS, max_bundle_bytes: limit } }).ok,
		false,
	);
	assert.equal(
		validateAcceptanceBundle(g.bundle, {
			report: g.report,
			limits: { ...DEFAULT_LIMITS, max_evidence_refs_per_outcome: 0 },
		}).ok,
		false,
	);
});

test("C4-X6: actual report byte bound is enforced independently of bundle size", async (t) => {
	const src = await fixture(t);
	const r = await runReportExport({
		manifestPath: src.manifestPath,
		eventsPath: src.eventsPath,
		outDir: join(src.dir, "report"),
		limits: { ...DEFAULT_LIMITS, max_report_bytes: 128 },
	});
	assert.equal(r.ok, false);
	assert.ok(r.reasons.some((x) => /report.*bytes|report.*size/.test(x)));
});
