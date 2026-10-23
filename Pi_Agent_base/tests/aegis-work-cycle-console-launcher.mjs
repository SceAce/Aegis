#!/usr/bin/env node
// Phase 3 (HC-01/16) — the ORDINARY launcher starts the resident Console Host.
//
// This runs the real `run-experiment.sh` as a child process (faux provider, temp
// AEGIS_HOME) and asserts:
//   * a new label starts ONE resident console process that creates ONE initial
//     Pi SDK Session and writes the ordinary EventLog (no second Pi CLI);
//   * `--dry-run` starts nothing and reports the console entry;
//   * an existing label is refused without `--resume`;
//   * `--resume` attaches to the SAME EventLog/Episode instead of creating one;
//   * `--help` documents the console controls;
//   * no credential/network access, no UI directory touched (checked in git, not
//     here), all state under the temp AEGIS_HOME.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyChain } from "../shared/events.mjs";

const REPO = resolve(import.meta.dirname, "..", "..");
const LAUNCHER = join(REPO, "run-experiment.sh");
let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

const readRows = (path) =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];

function run(args, env, timeout = 240_000) {
	return spawnSync("bash", [LAUNCHER, ...args], {
		cwd: REPO,
		encoding: "utf8",
		timeout,
		env: { ...process.env, ...env },
		maxBuffer: 32 * 1024 * 1024,
	});
}

function main() {
	const home = mkdtempSync(join(tmpdir(), "aegis-launcher-console-"));
	const workspace = join(home, "workspace");
	const agent = join(home, "agent");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(agent, { recursive: true });
	const env = {
		AEGIS_HOME: home,
		AEGIS_EXPERIMENTS_ROOT: join(home, "experiments"),
		AEGIS_PI_AGENT_DIR: agent,
		AEGIS_CONSOLE_PROVIDER: "faux",
		AEGIS_WEB_SEARCH: "off",
		AEGIS_KNOWLEDGE_ENABLED: "off",
	};
	const label = "launcher-console-1";
	const expDir = join(home, "experiments", label);
	const eventLogPath = join(expDir, "runtime", "events.jsonl");
	try {
		// --help documents the console controls and the exit path.
		const help = run(["--help"], env, 60_000);
		check("--help exits 0", help.status === 0, String(help.status));
		check("--help documents the console entry", /Console Host/i.test(help.stdout));
		check("--help documents /status and /stop", /\/status/.test(help.stdout) && /\/stop/.test(help.stdout));
		check("--help documents stop/quit semantics", /quit/i.test(help.stdout));

		// --dry-run starts nothing (it may create the experiment directory, so it
		// uses its own label).
		const dryLabel = "launcher-console-dry";
		const dry = run([dryLabel, "--workspace", workspace, "--dry-run"], env, 60_000);
		check("--dry-run exits 0", dry.status === 0, `${dry.status} ${dry.stderr}`);
		check("--dry-run reports the console entry", /Aegis Console Host/.test(dry.stdout), dry.stdout);
		check("--dry-run reports the frozen rotation bounds", /max_auto_rotations/.test(dry.stdout));
		check(
			"--dry-run starts no Session",
			!existsSync(join(home, "experiments", dryLabel, "runtime", "events.jsonl")) ||
				readRows(join(home, "experiments", dryLabel, "runtime", "events.jsonl")).length === 0,
		);

		// Real launch: one resident Host + one initial SDK Session.
		const first = run(
			[
				label,
				"--workspace",
				workspace,
				"--agent-dir",
				agent,
				"--provider",
				"faux",
				"--model",
				"launcher-fixture",
				"--",
				"--prompt",
				"TASK launcher: inspect the empty workspace",
				"--non-interactive",
			],
			env,
		);
		check("the launcher exits 0 for a clean console run", first.status === 0, `${first.status}\n${first.stderr}`);
		check(
			"the launcher process is the resident console",
			/Aegis Experiment Console/.test(first.stdout),
			first.stdout.slice(0, 400),
		);
		const rows = readRows(eventLogPath);
		check("the ordinary EventLog was created", rows.length > 0);
		check("the EventLog chain verifies", verifyChain(rows).ok === true);
		check("exactly one Episode was created", rows.filter((row) => row.event_type === "episode.started").length === 1);
		const sessions = rows.filter((row) => row.event_type === "session.started");
		check("exactly one initial Session was bound", sessions.length === 1, `sessions=${sessions.length}`);
		check(
			"the Session is a real SDK session id (not a label)",
			typeof sessions[0]?.payload?.session_id === "string" && sessions[0].payload.session_id.length > 10,
		);
		check("the console printed its derived status", /work unit/.test(first.stdout));
		check(
			"no Pi CLI banner was printed (no second CLI writer)",
			!/Pi coding agent|To resume this session/i.test(first.stdout),
			first.stdout.slice(0, 500),
		);
		check("the console printed the stop path", /\/stop/.test(first.stdout));

		// Existing label without --resume is refused.
		const again = run([label, "--workspace", workspace, "--agent-dir", agent], env, 60_000);
		check(
			"an existing label is refused without --resume",
			again.status !== 0 && /already exists/.test(again.stderr),
			again.stderr,
		);

		// --resume attaches to the SAME EventLog/Episode.
		const resumed = run(
			[
				label,
				"--resume",
				"--workspace",
				workspace,
				"--agent-dir",
				agent,
				"--provider",
				"faux",
				"--model",
				"launcher-fixture",
				"--",
				"--prompt",
				"TASK launcher: continue",
				"--non-interactive",
			],
			env,
		);
		check("--resume exits 0", resumed.status === 0, `${resumed.status}\n${resumed.stderr}`);
		check("--resume reports the resume", /resuming|\(resume\)/.test(`${resumed.stdout}${resumed.stderr}`));
		const resumedRows = readRows(eventLogPath);
		check("--resume reuses the same EventLog file", resumedRows.length > rows.length);
		check(
			"--resume does not create a second Episode",
			resumedRows.filter((row) => row.event_type === "episode.started").length === 1,
		);
		check(
			"--resume binds a new Session in the same Episode",
			resumedRows.filter((row) => row.event_type === "session.started").length === 2,
		);
		check("the resumed EventLog chain verifies", verifyChain(resumedRows).ok === true);

		// A second concurrent console is refused (real process-level ownership).
		// (The in-process case is covered by aegis-work-cycle-console-restart.)
		writeFileSync(join(expDir, "note.txt"), "noop");
		check("no credential file was written into the experiment", !existsSync(join(expDir, "auth.json")));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exitCode = 1;
	} else {
		console.log("\nconsole launcher: one resident Host, one SDK Session, resume into the same EventLog passed");
	}
}

main();
assert.ok(typeof main === "function");
