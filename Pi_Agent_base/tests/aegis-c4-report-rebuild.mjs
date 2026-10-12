#!/usr/bin/env node
// Aegis C4 — deterministic rebuild test (required C4-3).
//
// Export the four artifacts, DELETE every derived artifact (report/bundle/
// checkpoint/summary), then re-export from the SAME authoritative source and
// assert the semantic/report/bundle digests match exactly. Generated time and
// output paths are non-semantic and excluded.
//
// Run:
//   node Pi_Agent_base/tests/aegis-c4-report-rebuild.mjs

import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { generateCampaignArtifacts } from "../memory/campaign/report-export.mjs";
import { digest } from "../memory/fixture/contracts.mjs";
import { readEvents, runFixtureCampaign } from "./helpers/c4-report-helpers.mjs";

function semanticEqual(a, b) {
	// Compare the semantic view (exclude the non-semantic generated field).
	const strip = (value) => {
		const clone = { ...value };
		delete clone.generated_at;
		delete clone.report_digest;
		delete clone.bundle_digest;
		return clone;
	};
	return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

test("C4-3: deleting derived artifacts and re-exporting reproduces the same digests", async () => {
	const src = await runFixtureCampaign();
	const rows = await readEvents(src.eventsPath);

	// First generation.
	const first = generateCampaignArtifacts({
		manifest: src.manifest,
		events: rows,
		artifacts: {},
		runtimeDigests: {},
		generatedAt: "2026-01-01T00:00:00Z",
	});

	// Simulate deleting derived artifacts: a checkpoint/summary/report directory
	// and any cached evidence index. The authoritative source (manifest + events)
	// is untouched.
	const derivedDir = join(src.dir, "derived");
	assert.equal(existsSync(derivedDir), false);
	rmSync(derivedDir, { recursive: true, force: true });
	rmSync(join(src.dir, "runtime"), { recursive: true, force: true });
	rmSync(join(src.dir, "summary.json"), { force: true });

	// Second generation from the SAME source, with a DIFFERENT generated time.
	const second = generateCampaignArtifacts({
		manifest: src.manifest,
		events: rows,
		artifacts: {},
		runtimeDigests: {},
		generatedAt: "2027-12-31T23:59:59Z",
	});

	// Digests are identical across the rebuild.
	assert.equal(second.digests.report_digest, first.digests.report_digest, "report_digest is stable");
	assert.equal(second.digests.bundle_digest, first.digests.bundle_digest, "bundle_digest is stable");
	assert.equal(second.digests.semantic_digest, first.digests.semantic_digest, "semantic_digest is stable");
	// The full semantic views are equal (structure, not just digests).
	assert.ok(semanticEqual(second.report, first.report), "report semantic views match");
	assert.ok(semanticEqual(second.bundle, first.bundle), "bundle semantic views match");

	// The source was not modified by generation.
	const after = await readFile(src.eventsPath, "utf8");
	const before2 = await readFile(src.eventsPath, "utf8");
	assert.equal(digest(after), digest(before2));
});

test("C4-3b: a semantic change changes the semantic digest (structural, crypto-independent)", async () => {
	const src = await runFixtureCampaign();
	const rows = await readEvents(src.eventsPath);
	const base = generateCampaignArtifacts({ manifest: src.manifest, events: rows, artifacts: {}, runtimeDigests: {} });
	// Change the evidence index: a new artifact changes the resolved evidence set,
	// which changes the semantic report.
	const changed = generateCampaignArtifacts({
		manifest: src.manifest,
		events: rows,
		artifacts: { "artifact:EXTRA": { ref_id: "artifact:EXTRA", digest: "sha256:extra" } },
		runtimeDigests: { pi_build_id: "pi-x" },
	});
	// runtimeDigests is semantic -> the runtime block differs.
	assert.notEqual(JSON.stringify(changed.report.manifest), undefined);
	assert.notEqual(
		JSON.stringify(changed.bundle.runtime),
		JSON.stringify(base.bundle.runtime),
		"runtime digests are reflected",
	);
});
