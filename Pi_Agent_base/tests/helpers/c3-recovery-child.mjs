#!/usr/bin/env node
// Aegis C3 durability/recovery child harness (REAL EventLog + real process).
//
// Usage: node c3-recovery-child.mjs <workDir> <scenario>
//   scenario ∈ intent_fault | effect_then_kill | recover | result_fault
//
// Files under <workDir>:
//   events.jsonl  real EventLog
//   effects.json  {effects:N} real side-effect counter
//   summary.json  derived summary

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleCampaignHost, buildC3FixtureManifest, validateManifest } from "../../memory/campaign/index.mjs";
import { EventLog } from "../../memory/runtime/events.mjs";

const [workDir, scenario = "recover"] = process.argv.slice(2);
mkdirSync(workDir, { recursive: true });
const workspaceRoot = join(workDir, "ws");
mkdirSync(workspaceRoot, { recursive: true });
const eventsPath = join(workDir, "events.jsonl");
const effectsPath = join(workDir, "effects.json");
const summaryPath = join(workDir, "summary.json");

const validation = validateManifest(buildC3FixtureManifest({ workspaceRoot }));
if (!validation.ok) {
	process.stderr.write(`manifest invalid: ${validation.reasons.join("; ")}\n`);
	process.exit(3);
}
const manifest = validation.manifest;

function readEffects() {
	return existsSync(effectsPath) ? (JSON.parse(readFileSync(effectsPath, "utf8")).effects ?? 0) : 0;
}
function bumpEffects() {
	const next = readEffects() + 1;
	writeFileSync(effectsPath, JSON.stringify({ effects: next }));
	return next;
}

// Fault injection into the sink: fail a specific append kind.
const sinkFault = process.env.AEGIS_C3_FAULT ?? null;
const baseProductSink = {
	async append(event) {
		if (sinkFault === "intent" && event.event_type === "action.requested") {
			return { ok: false, error: "injected intent append failure" };
		}
		if (sinkFault === "result" && event.event_type === "action.completed") {
			return { ok: false, error: "injected result append failure" };
		}
		return log.append({
			event_type: event.event_type,
			episode_id: event.episode_id ?? null,
			payload: event.payload ?? {},
			source: event.source,
		});
	},
	replay: () => log.replay(),
};

const log = new EventLog(eventsPath);
const opened = await log.open();
if (!opened.ok) {
	process.stderr.write(`eventlog open failed: ${opened.error}\n`);
	process.exit(3);
}

const killAfterEffect = scenario === "effect_then_kill";
const assembled = await assembleCampaignHost({
	manifest,
	workspaceRoot,
	workDir,
	eventLogPath: eventsPath,
	mode: "auto",
	sinkImpl: baseProductSink,
	// A wrapper worker that bumps the real effect counter and, for the kill
	// scenario, kills the process right AFTER the effect but BEFORE any result.
	wrapWorker: (inner) => ({
		async run({ task }) {
			const result = await inner.run({ task });
			// Count a REAL effect only for steps that actually reached the adapter
			// (effect_probe true). An intent failure never produced an effect.
			const realEffects = Array.isArray(result.effects)
				? result.effects.filter((e) => e.effect_probe === true).length
				: 0;
			for (let i = 0; i < realEffects; i += 1) bumpEffects();
			if (killAfterEffect) process.kill(process.pid, "SIGKILL");
			return result;
		},
	}),
});
const { host } = assembled;
const result = await host.run();
host.releaseOwnership();

const projection = result.status;
const kinds = log.replay().map((e) => e.payload?.kind ?? e.event_type);
writeFileSync(
	summaryPath,
	JSON.stringify({
		scenario,
		effects: readEffects(),
		task_states: Object.fromEntries((projection?.tasks ?? []).map((t) => [t.task_id, t.state])),
		action_requested: kinds.filter((k) => k === "action.requested").length,
		action_completed: kinds.filter((k) => k === "action.completed").length,
		reconciliations: kinds.filter((k) => k === "campaign.reconciliation.resolved").length,
		unknowns: kinds.filter((k) => k === "campaign.task.unknown").length,
		campaign_state: result.status?.campaign_state ?? null,
		ok: result.ok,
	}),
);
await log.close();
process.exit(0);
void fileURLToPath;
