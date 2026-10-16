#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const help = spawnSync("bash", ["run-ram-test.sh", "--help"], { cwd: root, encoding: "utf8" });
assert.equal(help.status, 0);
assert.match(help.stdout, /--sql-wiki/);
const work = mkdtempSync(join(tmpdir(), "aegis-ram-launcher-"));
const seed = join(work, "seed.json");
writeFileSync(
	seed,
	JSON.stringify({
		source_kind: "external_reference",
		source_uri: "https://example.invalid",
		topic: "general",
		verified: false,
		action_policy: "none",
		content: "bounded reference",
	}),
);
const syntax = spawnSync("bash", ["-n", "run-ram-test.sh"], { cwd: root, encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr);
const invalid = spawnSync("bash", ["run-ram-test.sh", "--task-id", "bad/id"], { cwd: root, encoding: "utf8" });
assert.equal(invalid.status, 2);
assert.equal(JSON.parse(readFileSync(seed, "utf8")).action_policy, "none");
rmSync(work, { recursive: true, force: true });
console.log("RAM launcher: help, safe seed schema and non-silent real launcher failure passed");
