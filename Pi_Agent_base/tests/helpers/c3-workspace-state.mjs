#!/usr/bin/env node
// Aegis C3 workspace-adapter helper script (REAL supervised local subprocess).
//
// A tiny, data-only state setter for the supervised macOS workspace adapter. It
// is executed by the registered `node` interpreter through the existing
// script-registry contract: fixed executable, pinned script digest, data-only
// argv, explicit cwd, no shell, no network.
//
// Usage: node c3-workspace-state.mjs <state-file> <key> <true|false>
//   * <state-file> must be a path inside the registered workspace root (the
//     registry bounds it with a declared direction=out parameter);
//   * it reads the existing JSON object (or starts empty) and sets key=value;
//   * it writes the file and prints a one-line JSON result.

import { readFileSync, writeFileSync } from "node:fs";

const [stateFile, key, rawValue] = process.argv.slice(2);
if (!stateFile || !key || rawValue === undefined) {
	process.stderr.write("usage: c3-workspace-state.mjs <state-file> <key> <true|false>\n");
	process.exit(2);
}
if (rawValue !== "true" && rawValue !== "false") {
	process.stderr.write(`value must be true|false, got ${rawValue}\n`);
	process.exit(2);
}
let state = {};
try {
	const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed;
} catch {
	// A missing/empty file starts from an empty state (the parent directory is
	// guaranteed to exist by the registry's resource binding).
}
state[key] = rawValue === "true";
writeFileSync(stateFile, `${JSON.stringify(state)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ok: true, state_file: stateFile, key, value: state[key] })}\n`);
