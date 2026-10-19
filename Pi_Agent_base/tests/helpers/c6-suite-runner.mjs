#!/usr/bin/env node
// Private C6 suite runner: runs each named script with the source resolver and
// records the REAL exit code + private log. Never pipes through a success tail.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? "Pi_Agent_base/runtime/dev/c6-recheck-2";
const resolver = "./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts";
const names = process.argv.slice(3);
const results = [];
mkdirSync(OUT, { recursive: true });
for (const name of names) {
	const log = join(OUT, `${name}.log`);
	const testPath = `Pi_Agent_base/tests/${name}.mjs`;
	// SDK tests need the source resolver; plain node tests must NOT load it (it
	// changes module resolution and can surface unrelated GC finalizer errors).
	// A test that imports an extension transitively needs it too; such a test
	// declares `// aegis-resolver: required` so detection is not a content guess.
	const source = readFileSync(testPath, "utf8");
	const needsResolver = /@earendil-works\/pi-|aegis-resolver:\s*required/.test(source);
	const args = needsResolver ? ["--import", resolver, testPath] : [testPath];
	const run = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
	writeFileSync(log, output, "utf8");
	results.push({ name, command: ["node", ...args], exit: run.status, log });
	process.stdout.write(`${String(run.status).padStart(2)}  ${name}\n`);
}
writeFileSync(join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
const failed = results.filter((r) => r.exit !== 0);
process.stdout.write(`\n${results.length} scripts, ${failed.length} failed\n`);
process.exit(failed.length > 0 ? 1 : 0);
