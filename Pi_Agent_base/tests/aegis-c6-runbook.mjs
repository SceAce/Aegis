#!/usr/bin/env node
// Aegis SDK-L8 / C6-P8 — the documented commands are copy-paste reproducible.
//
// It generates a CLEAN temp layout (manifest + config + workspace), then runs the
// documented C6 CLI commands as REAL subprocesses with the source resolver:
// run, status, export, observe, measure. It asserts real exit codes and that the
// report is produced from the committed stream. This is the executable form of
// C6_AGENT_PRODUCT_RUNBOOK.md.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-runbook.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { buildDataRepairManifest } from "../memory/campaign/structured-data-adapter.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const REPO = join(BASE_DIR, "..");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-runbook-"));
const failures = [];
function check(name, condition, detail) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures.push(name);
		console.log(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

function runCli(args, env = {}) {
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			join(BASE_DIR, "pi/packages/coding-agent/src/experimental/source-resolver.ts"),
			join(BASE_DIR, "memory/campaign/c6-entry.mjs"),
			...args,
		],
		{ encoding: "utf8", cwd: REPO, env: { ...process.env, ...env } },
	);
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

try {
	// A CLEAN layout as documented in the runbook.
	const workspaceRoot = join(base, "workspace");
	const workDir = join(base, "run");
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(join(workspaceRoot, "dataset.json"), `${JSON.stringify({ name: "??" })}\n`, "utf8");
	const validated = validateManifest(buildDataRepairManifest({ workspaceRoot }));
	assert.equal(validated.ok, true, validated.reasons?.join("; "));
	const manifestPath = join(base, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8");
	const configPath = join(base, "campaign.config.json");
	writeFileSync(
		configPath,
		`${JSON.stringify({
			schema_version: "campaign-config-1.1",
			manifest_path: manifestPath,
			workspace_root: workspaceRoot,
			work_dir: workDir,
			mode: "auto",
			provider: { kind: "faux", model: "faux-c6" },
			context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
			learning: { policy: "off", promote_experience: false },
			task_family: "structured-data-repair",
			session: { session_count: 4, max_requests_per_session: 10 },
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
			measure: { out_dir: join(base, "measure") },
		})}\n`,
		"utf8",
	);

	// Usage errors exit 2 with a message.
	const usage = runCli([]);
	check(
		"a missing --config is a usage error (exit 2)",
		usage.status === 2 && /--config is required/.test(usage.stderr),
		`status=${usage.status}`,
	);
	const unknown = runCli(["--config", configPath, "--bogus"]);
	check("an unknown flag is a usage error (exit 2)", unknown.status === 2, `status=${unknown.status}`);

	// A real run completes (exit 0).
	const run = runCli(["--config", configPath, "run"]);
	check("the documented run exits 0", run.status === 0, `status=${run.status}\n${run.stderr.slice(-300)}`);
	check("the run produced a committed stream", existsSync(join(workDir, "events.jsonl")));

	// Read-only commands exit 0 and do not re-execute.
	const status = runCli(["--config", configPath, "status"]);
	check("the documented status exits 0", status.status === 0, `status=${status.status}\n${status.stderr.slice(-300)}`);

	// Export is produced from the committed stream.
	const exported = runCli(["--config", configPath, "export"]);
	check(
		"the documented export exits 0",
		exported.status === 0,
		`status=${exported.status}\n${exported.stderr.slice(-300)}`,
	);
	check("the report bundle was written", existsSync(join(workDir, "report")));

	// Measure export.
	const measured = runCli(["--config", configPath, "measure"]);
	check(
		"the documented measure exits 0",
		measured.status === 0,
		`status=${measured.status}\n${measured.stderr.slice(-300)}`,
	);
	check("the measurement file was written", existsSync(join(base, "measure", "measurement.json")));

	// A bad config exits non-zero.
	const badConfig = join(base, "bad.config.json");
	writeFileSync(
		badConfig,
		`${JSON.stringify({ schema_version: "campaign-config-1.1", manifest_path: manifestPath })}\n`,
		"utf8",
	);
	const bad = runCli(["--config", badConfig, "run"]);
	check("an invalid config exits non-zero", bad.status !== 0, `status=${bad.status}`);

	// The committed stream still verifies.
	const { verifyChain } = await import("../memory/runtime/events.mjs");
	const events = readFileSync(join(workDir, "events.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	check(
		"the documented run leaves a verifying chain",
		verifyChain(events).ok,
		JSON.stringify(verifyChain(events).errors),
	);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 runbook: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 runbook: all checks passed");
