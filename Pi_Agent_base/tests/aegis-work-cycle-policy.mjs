#!/usr/bin/env node
// P2-14 — trusted work-cycle policy validation, run binding and replay safety.
//
//   * no `work_cycle` section => disabled (existing configs are compatible);
//   * invalid thresholds are refused by the strict config loader;
//   * the first run FREEZES the policy into the committed stream;
//   * a later config with different thresholds is refused (no silent change);
//   * the same frozen policy can be replayed without writing a second note;
//   * a mutable env value cannot change a projection that uses the frozen policy.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { buildC3FixtureManifest } from "../campaign/c3-entry.mjs";
import { runC6FromConfig } from "../campaign/c6-entry.mjs";
import { loadCampaignConfig } from "../campaign/campaign-config.mjs";
import { projectWorkCycle } from "../memory/work-cycle.mjs";

const base = mkdtempSync(join(tmpdir(), "aegis-work-cycle-policy-"));
const workspace = join(base, "workspace");
const work = join(base, "run");
mkdirSync(workspace);
mkdirSync(work);
writeFileSync(join(workspace, "door.json"), JSON.stringify({ locked: true }));
const manifest = buildC3FixtureManifest({ workspaceRoot: workspace, campaignId: "campaign-work-cycle-policy" });
manifest.tasks = [{ ...manifest.tasks[0], task_id: "task-001", order: 1, depends_on: [] }];
manifest.budget.task_count = 1;
manifest.budget.session_count = 4;
manifest.dynamic_task_policy.max_task_count = 1;
writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest));

function configPath(name, workCycle) {
	const path = join(base, `${name}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			schema_version: "campaign-config-1.1",
			manifest_path: join(base, "manifest.json"),
			workspace_root: workspace,
			work_dir: work,
			mode: "auto",
			provider: { kind: "faux", model: "work-cycle-policy" },
			context: { strategy: "bounded_ram", max_total_input_chars: 100000, output_reserve_chars: 1000 },
			learning: { policy: "off", promote_experience: false },
			task_family: "fixture-state",
			session: { session_count: 4, max_requests_per_session: 10 },
			...(workCycle === undefined ? {} : { work_cycle: workCycle }),
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
		}),
	);
	return path;
}

const responder = (context) => {
	const messages = context.messages ?? [];
	const lastAssistant = messages.map((m) => m?.role).lastIndexOf("assistant");
	if (messages.slice(lastAssistant + 1).some((m) => m?.role === "toolResult" || m?.role === "tool"))
		return fauxAssistantMessage("done");
	const hasTask = messages.some(
		(m) =>
			m?.role === "user" &&
			(typeof m.content === "string"
				? m.content.startsWith("TASK task-001")
				: Array.isArray(m.content) && m.content.some((part) => String(part?.text ?? "").startsWith("TASK task-001"))),
	);
	if (!hasTask) return fauxAssistantMessage("continuing");
	return fauxAssistantMessage([
		fauxToolCall("aegis_task_decision", {
			actions: [{ action_ref: "fixture.state.set", arguments: { target: "door.json", key: "locked", value: false } }],
		}),
	]);
};
const factory = (options) => {
	const faux = registerFauxProvider(options);
	faux.setResponses(Array.from({ length: 10 }, () => responder));
	return faux;
};
const readEvents = () =>
	readFileSync(join(work, "events.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

try {
	// Disabled by default.
	const disabled = loadCampaignConfig({ configPath: configPath("disabled", undefined) });
	assert.equal(disabled.ok, true, JSON.stringify(disabled.reasons));
	assert.equal(disabled.config.work_cycle.enabled, false);
	// Invalid thresholds are refused.
	const invalid = loadCampaignConfig({
		configPath: configPath("invalid", {
			enabled: true,
			repeat_limit: 1,
			action_window: 8,
			min_distinct_routes: 9,
		}),
	});
	assert.equal(invalid.ok, false);
	assert.ok(invalid.reasons.some((reason) => reason.includes("work_cycle.repeat_limit")));
	assert.ok(invalid.reasons.some((reason) => reason.includes("work_cycle.min_distinct_routes")));

	const policyA = {
		enabled: true,
		repeat_limit: 3,
		action_window: 8,
		min_distinct_routes: 4,
		context_pressure_percent: 85,
		max_auto_rotations: 1,
		max_continuations: 2,
	};
	const run1 = await runC6FromConfig({
		configPath: configPath("a", policyA),
		sdk: { ...sdkBase, AuthStorage },
		print() {},
		fauxProviderFactory: factory,
	});
	assert.equal(run1.ok, true, JSON.stringify(run1.reasons));
	const afterRun1 = readEvents();
	const notes = afterRun1.filter((row) => row.payload?.kind === "campaign.work_cycle.policy");
	assert.equal(notes.length, 1, "the policy is frozen exactly once");
	assert.equal(notes[0].payload.policy.repeat_limit, 3);
	const triggerBefore = projectWorkCycle(afterRun1, "ep-task-001", {
		policy: notes[0].payload.policy,
	});
	const envBefore = process.env.AEGIS_WORK_CYCLE_REPEAT_LIMIT;
	process.env.AEGIS_WORK_CYCLE_REPEAT_LIMIT = "9";
	const triggerAfterEnv = projectWorkCycle(afterRun1, "ep-task-001", { policy: notes[0].payload.policy });
	if (envBefore === undefined) delete process.env.AEGIS_WORK_CYCLE_REPEAT_LIMIT;
	else process.env.AEGIS_WORK_CYCLE_REPEAT_LIMIT = envBefore;
	assert.equal(triggerAfterEnv.trigger_id, triggerBefore.trigger_id);
	assert.equal(triggerAfterEnv.policy.repeat_limit, 3, "the frozen policy wins over a mutable env value");

	// A different config for the same committed run is refused (no silent change).
	const eventsBeforeConflict = readEvents().length;
	const conflict = await runC6FromConfig({
		configPath: configPath("b", { ...policyA, repeat_limit: 4 }),
		sdk: { ...sdkBase, AuthStorage },
		print() {},
		fauxProviderFactory: factory,
	});
	assert.equal(conflict.ok, false);
	assert.equal(conflict.stage, "config");
	assert.ok(
		conflict.reasons.some((reason) => reason.includes("work_cycle_policy_conflict")),
		JSON.stringify(conflict.reasons),
	);
	assert.equal(readEvents().length, eventsBeforeConflict, "a policy conflict writes no new event");

	// The SAME frozen policy replays without a second note.
	const replay = await runC6FromConfig({
		configPath: configPath("c", policyA),
		sdk: { ...sdkBase, AuthStorage },
		print() {},
		fauxProviderFactory: factory,
	});
	assert.equal(replay.ok, true, JSON.stringify(replay.reasons));
	const finalEvents = readEvents();
	assert.equal(
		finalEvents.filter((row) => row.payload?.kind === "campaign.work_cycle.policy").length,
		1,
		"a replay does not duplicate the frozen policy note",
	);
	console.log(
		"Work-cycle policy: disabled default, strict validation, frozen run binding, conflict refusal and env-proof replay passed",
	);
} finally {
	rmSync(base, { recursive: true, force: true });
}
