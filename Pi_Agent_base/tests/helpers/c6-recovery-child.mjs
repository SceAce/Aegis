#!/usr/bin/env node
// Aegis C6 recovery child harness — REAL SDK/faux + real EventLog + real process.
//
// Usage: node c6-recovery-child.mjs <workDir> <scenario>
//   scenario ∈ recover | request_then_kill | effect_then_kill
//
// Files under <workDir>:
//   events.jsonl  real EventLog
//   effects.json  {effects:N} real Broker side-effect counter (Host-owned)
//   result.json   derived summary (written by the parent-facing entry)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { runC6FromConfig } from "../../memory/campaign/c6-entry.mjs";
import { validateManifest } from "../../memory/campaign/manifest.mjs";
import { buildDataRepairManifest } from "../../memory/campaign/structured-data-adapter.mjs";

const sdk = { ...sdkBase, AuthStorage };
const [workDir, scenario = "recover"] = process.argv.slice(2);
mkdirSync(workDir, { recursive: true });
const workspaceRoot = join(workDir, "workspace");
mkdirSync(workspaceRoot, { recursive: true });
const datasetPath = join(workspaceRoot, "dataset.json");
if (!existsSync(datasetPath)) writeFileSync(datasetPath, JSON.stringify({ status: "pending" }), "utf8");
const effectsPath = join(workDir, "effects.json");
const summaryPath = join(workDir, "summary.json");

function readEffects() {
	return existsSync(effectsPath) ? (JSON.parse(readFileSync(effectsPath, "utf8")).effects ?? 0) : 0;
}
function bumpEffects() {
	const next = readEffects() + 1;
	writeFileSync(effectsPath, JSON.stringify({ effects: next }));
	return next;
}

const validated = validateManifest(buildDataRepairLearningManifestSafe());
if (!validated.ok) {
	process.stderr.write(`manifest invalid: ${validated.reasons.join("; ")}\n`);
	process.exit(3);
}
const manifest = validated.manifest;
const manifestPath = join(workDir, "manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
const configPath = join(workDir, "config.json");
writeFileSync(
	configPath,
	JSON.stringify({
		schema_version: "campaign-config-1.1",
		manifest_path: manifestPath,
		workspace_root: workspaceRoot,
		work_dir: workDir,
		mode: "auto",
		provider: { kind: "faux", model: "c6-recovery" },
		context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
		learning: { policy: "off", promote_experience: false },
		task_family: "structured-data-repair",
		session: { session_count: 4, max_requests_per_session: 10 },
		observation: { enabled: false, port: 0 },
		oracle: { kind: "fixture" },
	}),
);

function buildDataRepairLearningManifestSafe() {
	// A single-task manifest keeps the recovery scenario focused on one effect.
	const base = buildDataRepairManifest({ workspaceRoot, campaignId: "campaign-c6-recovery" });
	return { ...base, tasks: [base.tasks[0]] };
}

const killAfter = scenario === "request_then_kill" ? "request" : scenario === "effect_then_kill" ? "effect" : null;
let killed = false;

const factory = (options) => {
	const faux = registerFauxProvider(options);
	const seen = new Map();
	const mk = () => {
		const n = (seen.get("t") ?? 0) + 1;
		seen.set("t", n);
		if (n === 1 && killAfter === "request") {
			// Kill right after the durable task intent but before the decision is
			// applied: the process dies with a stranded `running` task.
			process.kill(process.pid, "SIGKILL");
		}
		if (n > 1) return fauxAssistantMessage("done");
		return fauxAssistantMessage([
			fauxToolCall("aegis_task_decision", {
				actions: [
					{ action_ref: "data.record.set", arguments: { target: "dataset.json", field: "status", value: "active" } },
				],
			}),
		]);
	};
	faux.setResponses(Array.from({ length: 12 }, () => mk));
	return faux;
};

const outcome = await runC6FromConfig({
	configPath,
	scenario: "run",
	sdk,
	fauxProviderFactory: factory,
	// Count the REAL Broker effect and, for the effect scenario, kill AFTER the
	// effect is durable but before the run finishes.
	workerSeam: (inner) => ({
		async run(args) {
			const result = await inner.run(args);
			const realEffects = Array.isArray(result.effects)
				? result.effects.filter((e) => e.effect_probe === true).length
				: 0;
			for (let i = 0; i < realEffects; i += 1) bumpEffects();
			if (killAfter === "effect" && realEffects > 0 && !killed) {
				killed = true;
				process.kill(process.pid, "SIGKILL");
			}
			return result;
		},
	}),
	print: () => {},
});

const summary = {
	scenario,
	effects: readEffects(),
	task_states: outcome.task_states ?? null,
	chain_ok: outcome.chain_ok ?? null,
	ok: outcome.ok,
	dataset: existsSync(datasetPath) ? JSON.parse(readFileSync(datasetPath, "utf8")) : null,
};
writeFileSync(summaryPath, JSON.stringify(summary));
process.exit(0);
void resolve;
