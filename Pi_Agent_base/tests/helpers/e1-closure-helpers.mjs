// Aegis E1 contract-closure test helpers.
//
// Shared, NON-product helpers for the four `aegis-e1-closure-*` scripts. They
// build trusted inputs through the REAL product builder and run the REAL
// SDK/faux child; independent expected values live in each script (never derived
// by calling the function under test).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIndexFromEvents } from "../../memory/campaign/artifact-index.mjs";
import { requirePlanningManifest } from "../../memory/campaign/e1-planning.mjs";
import { projectQueueFromEvents } from "../../memory/campaign/projection.mjs";
import { buildDataRepairManifest } from "../../memory/campaign/structured-data-adapter.mjs";

export const BASE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RESOLVER = join(BASE, "pi/packages/coding-agent/src/experimental/source-resolver.ts");
export const PLANNING_CHILD = join(BASE, "tests/helpers/c6-e1-planning-child.mjs");

/** The trusted test planning config (templates/root criteria) shared by scripts. */
export const TEST_PLANNING_CONFIG = Object.freeze({
	enabled: true,
	templates: [
		{
			template_ref: "verify",
			task_type: "verify",
			oracle_ref: "fixture.oracle.v1",
			required_capabilities: ["data.record.write"],
			success_criteria: ["data.name == Ada", "data.status == active"],
			scope: {
				environment_fingerprint: "data-repair-env",
				domain: "structured-data",
				permissions: ["data.record.write"],
				task_types: ["verify", "reproduce"],
			},
		},
		{
			template_ref: "reproduce",
			task_type: "reproduce",
			oracle_ref: "fixture.oracle.v1",
			required_capabilities: ["data.record.write"],
			success_criteria: ["data.status == active"],
			scope: {
				environment_fingerprint: "data-repair-env",
				domain: "structured-data",
				permissions: ["data.record.write"],
				task_types: ["verify", "reproduce"],
			},
		},
	],
});

/**
 * Build a REAL planning Manifest through the product builder, with the explicit
 * test authorization required after removing the old implicit widening.
 * @param {{illegal?: boolean, workDir: string}} args
 */
export function testPlanningManifest({ illegal = false, workDir }) {
	const base = buildDataRepairManifest({
		workspaceRoot: join(workDir, "workspace"),
		campaignId: "campaign-e1-closure",
	});
	const authorized = {
		...base,
		budget: { ...base.budget, task_count: illegal ? 5 : 4 },
		dynamic_task_policy: { ...base.dynamic_task_policy, max_fan_out: 4, max_task_count: illegal ? 5 : 4 },
	};
	return requirePlanningManifest({ base: authorized, planningConfig: TEST_PLANNING_CONFIG });
}

/** Run the real SDK/faux planning child and return its durable evidence. */
export function runPlanningScenario({ workDir, scenario, timeout = 90_000, dir: explicitDir = null }) {
	const dir = explicitDir ?? join(workDir, scenario);
	mkdirSync(dir, { recursive: true });
	const command = ["--import", RESOLVER, PLANNING_CHILD, dir, scenario];
	const run = spawnSync(process.execPath, command, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
	writeFileSync(join(dir, "run.log"), `${run.stdout ?? ""}${run.stderr ?? ""}`);
	writeFileSync(join(dir, "run-command.json"), JSON.stringify({ command: ["node", ...command], exit: run.status }));
	const summaryPath = join(dir, `summary-${scenario}.json`);
	return {
		dir,
		exit: run.status,
		stderr: run.stderr ?? "",
		manifest: existsSync(join(dir, "manifest.json"))
			? JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
			: null,
		events: existsSync(join(dir, "events.jsonl"))
			? readFileSync(join(dir, "events.jsonl"), "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [],
		summary: existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : null,
	};
}

/** Project the committed stream with the real artifact index. */
export function project(events, manifest) {
	return projectQueueFromEvents({
		campaign_id: manifest.campaign_id,
		tasks: manifest.tasks ?? [],
		manifest,
		revision: manifest.revision ?? 0,
		events,
		artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
	});
}

/** Count real provider-started committed requests per task. */
export function providerRequestsByTask(events) {
	const counts = {};
	for (const event of events) {
		const p = event.payload;
		if (p?.kind === "c6.request" && p.phase === "committed" && p.provider_started === true)
			counts[p.task_id] = (counts[p.task_id] ?? 0) + 1;
	}
	return counts;
}

/** A new ignored evidence directory for a closure script run. */
export function evidenceDir(name) {
	const root = join(BASE, "runtime/dev/e1-contract-closure", name);
	mkdirSync(root, { recursive: true });
	return mkdtempSync(join(root, "run-"));
}
