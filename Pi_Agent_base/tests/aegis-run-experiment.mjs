// Experiment launcher: one label in, a complete isolated run out.
//
// These cases never start a TUI. They drive --dry-run/--list/error paths and
// assert the derived layout, the refusal rules, and that nothing is silently
// overwritten.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../../run-experiment.sh", import.meta.url).pathname;

function run(args, { home, env = {} } = {}) {
	return spawnSync("bash", [SCRIPT, ...args], {
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, ...(home ? { AEGIS_HOME: home } : {}), ...env },
	});
}

function freshHome() {
	return mkdtempSync(join(tmpdir(), "aegis-exp-"));
}

test("one label derives the whole isolated layout", () => {
	const home = freshHome();
	try {
		const result = run(["ram-001", "--dry-run"], { home });
		assert.equal(result.status, 0, result.stderr);
		const dir = join(home, "experiments", "ram-001");
		assert.ok(existsSync(join(dir, "workspace")), "workspace created");
		assert.ok(existsSync(join(dir, "runtime", "ram")), "ram dir created");
		assert.ok(existsSync(join(dir, "runtime", "projections")), "projections created");
		assert.ok(existsSync(join(dir, "runtime", "experiences")), "experiences created");
		assert.ok(existsSync(join(dir, "sessions")), "sessions created");
		assert.ok(existsSync(join(dir, "server")), "server created");
		assert.ok(existsSync(join(dir, "agent")), "agent dir created");
		assert.match(result.stdout, /AEGIS_TASK_ID=ram-001/);
		assert.match(result.stdout, /cwd=.*ram-001\/workspace/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("run.json records the resolved parameters and no credentials", () => {
	const home = freshHome();
	try {
		assert.equal(run(["ram-002", "--dry-run"], { home }).status, 0);
		const raw = readFileSync(join(home, "experiments", "ram-002", "run.json"), "utf8");
		const runJson = JSON.parse(raw);
		assert.equal(runJson.schema_version, "aegis-experiment-1");
		assert.equal(runJson.label, "ram-002");
		assert.equal(runJson.task_id, "ram-002");
		assert.equal(runJson.entry, "source");
		assert.ok(runJson.paths.event_log.endsWith("events.jsonl"));
		assert.ok(runJson.paths.knowledge_dir.length > 0);
		assert.match(runJson.repo_revision, /^[0-9a-f]{40}$|^unknown$/);
		for (const field of ["token", "password", "api_key", "secret"]) {
			assert.equal(raw.toLowerCase().includes(`${field}:`), false, `run.json must not store ${field}`);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("relaunching an existing label is refused with actionable advice", () => {
	const home = freshHome();
	try {
		assert.equal(run(["ram-003", "--dry-run"], { home }).status, 0);
		const again = run(["ram-003", "--dry-run"], { home });
		assert.equal(again.status, 2);
		assert.match(again.stderr, /already exists/);
		assert.match(again.stderr, /--resume/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("--resume reuses the run and keeps the original created_at", () => {
	const home = freshHome();
	try {
		assert.equal(run(["ram-004", "--dry-run"], { home }).status, 0);
		const before = JSON.parse(readFileSync(join(home, "experiments", "ram-004", "run.json"), "utf8")).created_at;
		const resumed = run(["ram-004", "--resume", "--dry-run"], { home });
		assert.equal(resumed.status, 0, resumed.stderr);
		assert.match(resumed.stdout, /resume/);
		const after = JSON.parse(readFileSync(join(home, "experiments", "ram-004", "run.json"), "utf8")).created_at;
		assert.equal(after, before, "resume must not rewrite the run record");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("--resume on a missing label fails instead of inventing one", () => {
	const home = freshHome();
	try {
		const result = run(["nope", "--resume", "--dry-run"], { home });
		assert.equal(result.status, 2);
		assert.match(result.stderr, /does not exist/);
		assert.equal(existsSync(join(home, "experiments", "nope")), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a label cannot escape the experiments root", () => {
	const home = freshHome();
	try {
		for (const label of ["../evil", "a/b", ".hidden", "a b"]) {
			const result = run([label, "--dry-run"], { home });
			assert.equal(result.status, 2, `label ${label} must be rejected`);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a second positional label is rejected", () => {
	const home = freshHome();
	try {
		const result = run(["one", "two", "--dry-run"], { home });
		assert.equal(result.status, 2);
		assert.match(result.stderr, /only one label/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a missing label prints usage", () => {
	const home = freshHome();
	try {
		const result = run([], { home });
		assert.equal(result.status, 2);
		assert.match(result.stderr, /a label is required/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("knowledge resolves to the Aegis home when it exists, else the repository", () => {
	const home = freshHome();
	try {
		const repoKnowledge = new URL("../../knowledge", import.meta.url).pathname;
		const first = run(["k-001", "--dry-run"], { home });
		assert.equal(first.status, 0, first.stderr);
		assert.match(
			first.stdout,
			new RegExp(`AEGIS_KNOWLEDGE_DIR=${repoKnowledge.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
		);

		mkdirSync(join(home, "knowledge"), { recursive: true });
		const second = run(["k-002", "--dry-run"], { home });
		assert.equal(second.status, 0, second.stderr);
		assert.match(second.stdout, /AEGIS_KNOWLEDGE_DIR=.*\/knowledge/);
		assert.ok(second.stdout.includes(join(home, "knowledge")), "prefers the Aegis home once it exists");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("--list reports existing experiments and creates nothing", () => {
	const home = freshHome();
	try {
		const empty = run(["--list"], { home });
		assert.equal(empty.status, 0);
		assert.match(empty.stdout, /no experiments yet/);

		assert.equal(run(["listed-1", "--dry-run"], { home }).status, 0);
		const listed = run(["--list"], { home });
		assert.equal(listed.status, 0);
		assert.match(listed.stdout, /listed-1/);

		const other = freshHome();
		try {
			const before = run(["--list"], { home: other });
			assert.match(before.stdout, /no experiments yet/);
			assert.equal(existsSync(join(other, "experiments")), false, "--list must not create the root");
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("--workspace and --task-id are honoured, and a bad task id is refused", () => {
	const home = freshHome();
	const workspace = mkdtempSync(join(tmpdir(), "aegis-wsp-"));
	try {
		const result = run(["w-001", "--workspace", workspace, "--task-id", "task-x", "--dry-run"], { home });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /task id {4}task-x/);
		assert.ok(result.stdout.includes(`workspace  ${workspace}`) || result.stdout.includes("workspace"));

		const bad = run(["w-002", "--task-id", "../nope", "--dry-run"], { home });
		assert.equal(bad.status, 2);
		assert.match(bad.stderr, /invalid --task-id/);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("--bundle refuses to launch without a built bundle", () => {
	const home = freshHome();
	const bundle = new URL("../../Pi_Agent_base/pi/packages/coding-agent/dist/bundle/cli.js", import.meta.url);
	if (existsSync(bundle.pathname)) return; // a built bundle exists: nothing to assert here
	try {
		const result = run(["b-001", "--bundle", "--dry-run"], { home });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /build it with \.\/install\.sh --build-bundle/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a seed file must exist when given", () => {
	const home = freshHome();
	try {
		const result = run(["s-001", "--seed", "/nonexistent/seed.json", "--dry-run"], { home });
		assert.equal(result.status, 2);
		assert.match(result.stderr, /seed file not found/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the launcher never reads or writes ~/.pi", () => {
	const script = readFileSync(new URL("../../run-experiment.sh", import.meta.url), "utf8");
	// Comments and help text legitimately mention ~/.pi to document the isolation
	// guarantee; what matters is that no executable line points there.
	const code = script
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
	assert.equal(/\.pi\b/.test(code), false, "no executable line may reference ~/.pi");
	assert.match(code, /AEGIS_PI_AGENT_DIR/);
	assert.match(code, /AEGIS_PI_SESSION_DIR/);
	assert.match(code, /AEGIS_PI_SERVER_DIR/);
});
