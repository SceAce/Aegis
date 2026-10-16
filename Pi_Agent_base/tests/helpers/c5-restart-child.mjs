#!/usr/bin/env node
// Aegis C5 crash/restart child: run the unified entry, optionally SIGKILL right
// after the durable intent + effect, or recover on restart. Real EventLog.
//
// Usage: node c5-restart-child.mjs <dir> kill|recover
// Reads <dir>/campaign.config.json (written by the parent test).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCampaignFromConfig } from "../../campaign/c5-entry.mjs";

const [dir, mode = "recover"] = process.argv.slice(2);
const effectsPath = join(dir, "effects.json");
const configPath = join(dir, "campaign.config.json");

function readEffects() {
	return existsSync(effectsPath) ? (JSON.parse(readFileSync(effectsPath, "utf8")).effects ?? 0) : 0;
}
function bumpEffect() {
	const next = readEffects() + 1;
	writeFileSync(effectsPath, JSON.stringify({ effects: next }));
	return next;
}

const outcome = await runCampaignFromConfig({
	configPath,
	scenario: "run",
	wrapWorker: (inner) => ({
		async run({ task }) {
			const result = await inner.run({ task });
			// Count a REAL effect only for steps that reached the adapter.
			const realEffects = Array.isArray(result.effects)
				? result.effects.filter((e) => e.effect_probe === true).length
				: 0;
			for (let i = 0; i < realEffects; i += 1) bumpEffect();
			if (mode === "kill") process.kill(process.pid, "SIGKILL");
			return result;
		},
	}),
});

if (mode === "recover") {
	writeFileSync(
		join(dir, "recover-summary.json"),
		JSON.stringify({
			effects: readEffects(),
			reconciled: outcome.ok === true || existsSync(join(dir, "run", "report")),
			task_001_state: outcome.task_states?.["task-001"] ?? null,
		}),
	);
}
process.exit(0);
