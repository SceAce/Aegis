#!/usr/bin/env node
// Aegis C5 — operational reproduction test (required C5-O1).
//
// Follows the runbook from a clean temp dir: creates the layout, runs the
// documented CLI commands as REAL subprocesses, checks the documented exit codes
// and that a rerun reproduces (no duplicate effects).
//
// Run:
//   node Pi_Agent_base/tests/aegis-c5-runbook.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildC3FixtureManifest } from "../memory/campaign/c3-entry.mjs";
import { validateManifest } from "../memory/campaign/manifest.mjs";

const ENTRY = fileURLToPath(new URL("../memory/campaign/c5-entry.mjs", import.meta.url));

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "aegis-c5-runbook-"));
	const workspaceRoot = join(dir, "workspace");
	mkdirSync(workspaceRoot, { recursive: true });
	const validated = validateManifest(buildC3FixtureManifest({ workspaceRoot }));
	assert.equal(validated.ok, true, validated.reasons?.join("; "));
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8");
	writeFileSync(
		join(dir, "campaign.config.json"),
		`${JSON.stringify(
			{
				schema_version: "campaign-config-1.0",
				manifest_path: "manifest.json",
				workspace_root: "workspace",
				work_dir: "run",
				mode: "auto",
				session: { session_count: 2, max_requests_per_session: 10 },
				observation: { enabled: false, host: "127.0.0.1", port: 0 },
				oracle: { kind: "fixture" },
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return { dir, workspaceRoot, config: join(dir, "campaign.config.json") };
}

function run(config, args) {
	return spawnSync(process.execPath, [ENTRY, "--config", config, ...args], { encoding: "utf8" });
}

test("C5-O1: the documented commands run with the documented exit codes and reproduce", async (t) => {
	const ctx = setup();
	t.after(() => rmSync(ctx.dir, { recursive: true, force: true }));

	// run --export -> exit 0; artifacts written.
	const run1 = run(ctx.config, ["run", "--export"]);
	assert.equal(run1.status, 0, run1.stderr);
	assert.ok(readFileSync(join(ctx.dir, "run", "report", "campaign-report.json"), "utf8").length > 0);
	const effectsAfter1 = countActions(ctx);

	// A second run over the same work_dir must not duplicate effects.
	const run2 = run(ctx.config, ["run"]);
	assert.equal(run2.status, 0, run2.stderr);
	assert.equal(countActions(ctx), effectsAfter1, "no duplicate effects on rerun");

	// status -> exit 0.
	const status = run(ctx.config, ["status"]);
	assert.equal(status.status, 0, status.stderr);

	// A bad subcommand -> exit 2; a missing config -> exit 1.
	assert.equal(run(ctx.config, ["bogus"]).status, 2);
	assert.equal(
		spawnSync(process.execPath, [ENTRY, "--config", "/nonexistent.json", "run"], { encoding: "utf8" }).status,
		1,
	);
});

function countActions(ctx) {
	const text = readFileSync(join(ctx.dir, "run", "events.jsonl"), "utf8");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((e) => e.event_type === "action.completed" && e.payload?.status !== "rejected").length;
}
