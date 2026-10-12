#!/usr/bin/env node
// Aegis C3-D — Campaign-mode direct-tool gate.
//
// Proves that in Campaign mode a direct Pi tool (bash/write/edit/...) cannot
// produce an effect outside the Broker, while the brokered action tools still
// pass, and that ordinary Pi behaviour is unchanged when no Campaign is active.
//
// Run:
//   node Pi_Agent_base/tests/aegis-c3-campaign-mode-gate.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCampaignActionGate } from "../memory/campaign/campaign-mode.mjs";

const failures = [];
function test(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures.push({ name, error });
		console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
const root = mkdtempSync(join(tmpdir(), "aegis-c3-gate-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

test("C3-DENY-4a: ordinary Pi behaviour is unchanged when Campaign mode is inactive", () => {
	const gate = createCampaignActionGate();
	const decision = gate.guardToolCall({ tool_name: "bash" });
	assert.equal(decision.allowed, true);
	assert.equal(decision.mode, "standard");
});

test("C3-DENY-4b: in Campaign mode a direct tool is denied with a visible reason", () => {
	const gate = createCampaignActionGate();
	gate.activate();
	for (const tool of ["bash", "write", "edit", "read", "powershell"]) {
		const decision = gate.guardToolCall({ tool_name: tool });
		assert.equal(decision.allowed, false, `${tool} must be denied`);
		assert.equal(decision.mode, "campaign");
		assert.match(decision.reason, /cannot bypass the Broker/i);
	}
});

test("C3-DENY-4c: the brokered action tools are allowed in Campaign mode", () => {
	const gate = createCampaignActionGate();
	gate.activate();
	for (const tool of ["aegis_workspace", "aegis_script"]) {
		const decision = gate.guardToolCall({ tool_name: tool, action_ref: "script.aegis.workspace.state" });
		assert.equal(decision.allowed, true, `${tool} must be allowed`);
		assert.equal(decision.mode, "campaign");
	}
});

test("C3-DENY-4d: an explicit read-only allow-list is honored, but a nameless call is refused", () => {
	const gate = createCampaignActionGate({ allowDirectTools: ["read"] });
	gate.activate();
	assert.equal(gate.guardToolCall({ tool_name: "read" }).allowed, true);
	assert.equal(gate.guardToolCall({ tool_name: "bash" }).allowed, false);
	assert.equal(gate.guardToolCall({}).allowed, false, "a nameless call is refused in campaign mode");
});

test("C3-DENY-4e: deactivating the gate restores standard behaviour", () => {
	const gate = createCampaignActionGate();
	gate.activate();
	assert.equal(gate.guardToolCall({ tool_name: "bash" }).allowed, false);
	gate.deactivate();
	assert.equal(gate.guardToolCall({ tool_name: "bash" }).allowed, true);
});

test("C3-DENY-4f: a denied direct write leaves no effect on disk", () => {
	const gate = createCampaignActionGate();
	gate.activate();
	const target = join(root, "should-not-exist.txt");
	const decision = gate.guardToolCall({ tool_name: "write" });
	// The gate is the admission boundary; only if it allowed would the tool run.
	if (decision.allowed) writeFileSync(target, "leaked");
	assert.equal(decision.allowed, false);
	assert.equal(existsSync(target), false, "no file was written");
});

console.log("");
if (failures.length > 0) {
	console.log(`campaign C3 campaign-mode gate: ${failures.length} failure(s)`);
	for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
	process.exit(1);
}
console.log("campaign C3 campaign-mode gate: all assertions passed");
