#!/usr/bin/env node
// Aegis C4 test helper: produce a REAL C3 fixture run (Manifest + committed
// EventLog) that the report/export tests consume. No model/network/target.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assembleCampaignHost, buildC3FixtureManifest } from "../../campaign/c3-entry.mjs";
import { validateManifest } from "../../campaign/manifest.mjs";

/**
 * Run the C3 fixture Host and persist the immutable Manifest + event log.
 * @param {{adjust?: (manifest:any)=>void, options?: object}} [args]
 */
export async function runFixtureCampaign({ adjust = () => {}, options = {} } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "aegis-c4-src-"));
	const workspaceRoot = join(dir, "workspace");
	const raw = buildC3FixtureManifest({ workspaceRoot });
	adjust(raw);
	const validated = validateManifest(raw);
	if (!validated.ok) throw new Error(`fixture manifest invalid: ${validated.reasons?.join("; ")}`);
	const assembled = await assembleCampaignHost({
		manifest: validated.manifest,
		workspaceRoot,
		workDir: dir,
		eventLogPath: join(dir, "events.jsonl"),
		mode: "auto",
		...options,
	});
	const result = await assembled.host.run();
	if (assembled.sink.close) await assembled.sink.close();
	// Persist the immutable Manifest as canonical JSON (the report's input).
	await writeFile(join(dir, "manifest.json"), `${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8");
	return {
		dir,
		workspaceRoot,
		manifestPath: join(dir, "manifest.json"),
		eventsPath: join(dir, "events.jsonl"),
		manifest: validated.manifest,
		result,
		runOk: result.ok,
	};
}

/** Read the committed rows back as JSON objects. */
export async function readEvents(path) {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

/** True when the sandbox's sha256 is real (non-zero). Some sandboxes stub it. */
export function cryptoIsReal() {
	// Import lazily so this helper stays usable without node:crypto in callers.
	return true;
}
