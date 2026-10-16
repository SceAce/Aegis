#!/usr/bin/env node
// Parse source imports without executing product modules or contacting providers.
// Catch missing paths and dependencies on experimental code before dispatch.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "../pi/node_modules/esbuild/lib/main.js";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const production = [
	"memory",
	"campaign",
	"execution",
	"session",
	"orchestration",
	"verification",
	"observation",
	"shared",
	"contest",
];
const roots = [...production, "fixtures", "extensions", "tests"];
const errors = [];
let files = 0;
let imports = 0;

function walk(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(dir, entry.name);
		return entry.isDirectory() ? walk(path) : /\.(mjs|ts)$/.test(entry.name) ? [path] : [];
	});
}

for (const root of roots) {
	for (const path of walk(resolve(base, root))) {
		files += 1;
		// All dependencies remain external: esbuild parses this file only. No
		// extension, CLI or test top-level code is imported/executed by the guard.
		const result = buildSync({
			entryPoints: [path],
			bundle: true,
			write: false,
			metafile: true,
			external: ["*"],
			platform: "node",
			format: "esm",
			logLevel: "silent",
		});
		for (const input of Object.values(result.metafile.inputs)) {
			for (const dependency of input.imports) {
				const value = dependency.path;
				if (!value.startsWith(".")) continue;
				imports += 1;
				const target = resolve(dirname(path), value);
				if (!existsSync(target)) errors.push(`${relative(base, path)}: missing ${value}`);
				if (production.includes(root) && relative(base, target).startsWith("fixtures/"))
					errors.push(`${relative(base, path)}: production code depends on fixture ${value}`);
			}
		}
	}
}

for (const old of ["memory/campaign", "memory/runtime", "memory/fixture"])
	if (existsSync(resolve(base, old))) errors.push(`obsolete source directory was recreated: ${old}`);

for (const file of readdirSync(resolve(base, "memory"))) {
	if (
		/^(?:action-|authorization\.|script-|workspace-|handoff|session-|workflow-|broker-|observation-|report|.*-adapter\.)/.test(
			file,
		)
	)
		errors.push(`non-memory responsibility in memory/: ${file}`);
}

for (const name of ["tsconfig.aegis.json", "tsconfig.aegis-campaign.json"]) {
	// These two checked-in configs use whole-line comments, without inline JSONC.
	const config = JSON.parse(readFileSync(resolve(base, name), "utf8").replace(/^\s*\/\/.*$/gm, ""));
	for (const path of config.include ?? [])
		if (!existsSync(resolve(base, path))) errors.push(`${name}: missing included source ${path}`);
}

assert.deepEqual(errors, [], errors.join("\n"));
console.log(
	`Module layout: ${files} source/test files, ${imports} relative module references; no missing modules, fixture dependencies or obsolete source trees`,
);
