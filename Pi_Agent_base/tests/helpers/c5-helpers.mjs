#!/usr/bin/env node
// Aegis C5 test helper: build a trusted config + run the unified entry.
// Real temp workspace, real EventLog, no model/network/target.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildC3FixtureManifest } from "../../memory/campaign/c3-entry.mjs";
import { runCampaignFromConfig } from "../../memory/campaign/c5-entry.mjs";
import { validateManifest } from "../../memory/campaign/manifest.mjs";

/**
 * Create a temp dir with a validated Manifest and a matching trusted config.
 * @param {{adjustManifest?: (m:any)=>void, observation?: boolean, session?: object, mode?: string}} [args]
 */
export async function makeConfig({ adjustManifest = () => {}, observation = false, session = {}, mode = "auto" } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "aegis-c5-"));
	const workspaceRoot = join(dir, "workspace");
	await mkdir(workspaceRoot, { recursive: true });
	const raw = buildC3FixtureManifest({ workspaceRoot });
	adjustManifest(raw);
	const validated = validateManifest(raw);
	if (!validated.ok) throw new Error(`fixture manifest invalid: ${validated.reasons?.join("; ")}`);
	const manifestPath = join(dir, "manifest.json");
	await writeFile(manifestPath, `${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8");
	const configPath = join(dir, "campaign.config.json");
	await writeFile(
		configPath,
		`${JSON.stringify(
			{
				schema_version: "campaign-config-1.0",
				manifest_path: manifestPath,
				workspace_root: workspaceRoot,
				work_dir: join(dir, "run"),
				mode,
				session: { session_count: 2, max_requests_per_session: 10, ...session },
				observation: { enabled: observation, port: 0 },
				oracle: { kind: "fixture" },
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return { dir, workspaceRoot, manifestPath, configPath, manifest: validated.manifest };
}

/** Run the unified entry with a captured print stream. */
export async function runEntry(ctx, options = {}) {
	const lines = [];
	const result = await runCampaignFromConfig({
		configPath: ctx.configPath,
		print: (text) => lines.push(text),
		...options,
	});
	return { ...result, lines };
}

export async function readEvents(ctx) {
	const path = join(ctx.dir, "run", "events.jsonl");
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}
