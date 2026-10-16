// Local CLI scope and independent answer check. No provider calls.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCandidate, pythonCli } from "../fixtures/ctf-board-pilot.mjs";

const root = mkdtempSync(join(tmpdir(), "aegis-ctf-cli-"));
try {
	const ok = await pythonCli(
		root,
		"from pathlib import Path\nPath('candidate.txt').write_text('DUCTF{offline_fixture}')\nprint(19*17)",
	);
	assert.equal(ok.exit_code, 0, ok.stderr);
	assert.ok(ok.stdout.includes("323"));
	assert.equal(checkCandidate(root, "DUCTF{offline_fixture}"), true);
	assert.equal(checkCandidate(root, "DUCTF{different}"), false);
	assert.equal(checkCandidate(root, "DUCTF{different}", "tool ok success"), false);
	assert.equal(readFileSync(join(root, "candidate.txt"), "utf8"), "DUCTF{offline_fixture}");
	for (const code of [
		"open('/etc/passwd').read()",
		"open('/tmp/aegis-outside-write','w').write('x')",
		"import subprocess;subprocess.run(['true'])",
		"import socket;socket.socket()",
	]) {
		const rejected = await pythonCli(root, code);
		assert.notEqual(rejected.exit_code, 0);
		assert.ok(rejected.stderr.includes("PermissionError"), rejected.stderr);
	}
	const timed = await pythonCli(root, "while True: pass", undefined, 100);
	assert.equal(timed.timed_out, true);
	console.log(
		"CTF pilot CLI: bounded Python, workspace data, denied outside IO/process/network, timeout and exact answer check passed",
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
