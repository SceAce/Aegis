#!/usr/bin/env node
// Focused follow-ups on the C6 repair: trusted test completion, new observation
// path, and runner initial state. No real model/network/target.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createObservationTool } from "../memory/campaign/c6-model-worker.mjs";
import { runBoundedAttempts } from "../memory/campaign/c6-runner.mjs";
import { runRegisteredTest } from "../memory/campaign/registered-test.mjs";

function setup(t) {
	const dir = mkdtempSync(join(tmpdir(), "aegis-c6-recheck-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const workspace = join(dir, "workspace");
	mkdirSync(workspace);
	return { dir, workspace };
}
function prepareTest(workspace, content) {
	writeFileSync(join(workspace, "solution.mjs"), content);
	writeFileSync(
		join(workspace, "check.mjs"),
		'import assert from "node:assert/strict"; import { answer } from "./solution.mjs"; assert.equal(answer,42);\n',
	);
}

test("CONTROL: registered test verifies a real correct answer and rejects wrong answer", (t) => {
	const { workspace } = setup(t);
	prepareTest(workspace, "export const answer=42;\n");
	assert.equal(runRegisteredTest({ workspaceRoot: workspace }).ok, true);
	prepareTest(workspace, "export const answer=0;\n");
	assert.equal(runRegisteredTest({ workspaceRoot: workspace }).ok, false);
});

test("C6-R1: target-controlled Error.prepareStackTrace cannot authenticate a skipped test", (t) => {
	const { workspace } = setup(t);
	prepareTest(
		workspace,
		'Error.prepareStackTrace = () => "Error\\n at ignored\\n at " + process.cwd() + "/check.mjs:1:1"; process.exit(0); export const answer=0;\n',
	);
	const result = runRegisteredTest({ workspaceRoot: workspace });
	assert.equal(
		result.ok,
		false,
		"target can fabricate a registered-test caller frame while answer=0; acceptance assertions never ran",
	);
	assert.equal(result.complete, false, "caller stack text is not trusted completion evidence");
});

test("C6-R2: newly exposed observation tool rejects a grant-named symlink escaping workspace", async (t) => {
	const { dir, workspace } = setup(t);
	const outside = join(dir, "outside.txt");
	writeFileSync(outside, "PRIVATE_AUDIT_SAMPLE");
	symlinkSync(outside, join(workspace, "allowed.txt"));
	const type = { Object: (x) => x, String: () => ({ type: "string" }) };
	const tool = createObservationTool({
		sdk: { defineTool: (x) => x },
		type,
		workspaceRoot: workspace,
		allowedTargets: ["allowed.txt"],
	});
	const result = await tool.execute("read-1", { path: "allowed.txt" });
	assert.equal(
		result.details.ok,
		false,
		"lexical grant match cannot permit reading the symlink target outside workspace",
	);
	assert.equal(JSON.stringify(result).includes("PRIVATE_AUDIT_SAMPLE"), false);
});

test("CONTROL: observation reads the authorized regular file", async (t) => {
	const { workspace } = setup(t);
	writeFileSync(join(workspace, "allowed.txt"), "safe-data");
	const type = { Object: (x) => x, String: () => ({ type: "string" }) };
	const tool = createObservationTool({
		sdk: { defineTool: (x) => x },
		type,
		workspaceRoot: workspace,
		allowedTargets: ["allowed.txt"],
	});
	const result = await tool.execute("read-1", { path: "allowed.txt" });
	assert.equal(result.details.ok, true);
	assert.ok(JSON.stringify(result).includes("safe-data"));
});

test("C6-R3: runner cannot report a requested initial state that it never applies", async (t) => {
	const { dir, workspace } = setup(t);
	const statePath = join(workspace, "dataset.json");
	writeFileSync(statePath, JSON.stringify({ status: "prior-result" }));
	const configPath = join(dir, "config.json");
	writeFileSync(configPath, JSON.stringify({ workspace_root: workspace, work_dir: join(dir, "run") }));
	let observed;
	const result = await runBoundedAttempts({
		configPath,
		baseDir: join(dir, "attempts"),
		attempts: [{ id: "a", initial_state: { status: "fresh" } }],
		runEntry: async () => {
			observed = JSON.parse(readFileSync(statePath, "utf8"));
			return { ok: true };
		},
	});
	assert.ok(
		result.attempts[0].ok === false || observed.status === "fresh",
		"must apply initial state with a trusted initializer or explicitly refuse; metadata alone is not reset evidence",
	);
});
