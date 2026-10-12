// Offline regression tests for the Aegis contest launcher (contest/run.sh).
//
// Negative checks MUST fail BEFORE Pi is ever exec'd, so no model, network,
// credentials, or Pi session is touched. Positive launch checks use a FAKE Pi
// source entry point in a temp layout, so they also never call a real model,
// read auth/config, or touch the real checkout state.
//
// Pinned rules:
//   * AEGIS_CONTEST_WORKSPACE is optional and defaults to the caller's cwd
//     (pwd -P) captured before any cd; an explicit value still overrides it,
//   * the whole Aegis checkout root, its descendants, and any ancestor that
//     exposes it (e.g. $HOME or /) are refused as a workspace,
//   * no Pi passthrough flags are accepted (short aliases and `--` included),
//   * the anonymous task id and workspace checks happen up front.
//
// Run:
//   node Pi_Agent_base/tests/contest-launcher-smoke.mjs

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKOUT_ROOT = resolve(BASE_DIR, "..");
const RUN = join(BASE_DIR, "contest", "run.sh");

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log(`ok - ${name}`);
	} else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

function runLauncher({ args = [], workspace = null, taskId = "task-launch-001", cwd = undefined, env: extraEnv = {}, script = RUN } = {}) {
	const env = { ...process.env, ...extraEnv };
	delete env.AEGIS_CONTEST_WORKSPACE;
	delete env.AEGIS_CONTEST_TASK_ID;
	if (workspace !== null) env.AEGIS_CONTEST_WORKSPACE = workspace;
	if (taskId !== null) env.AEGIS_CONTEST_TASK_ID = taskId;
	const options = { encoding: "utf8", env };
	if (cwd !== undefined) options.cwd = cwd;
	return spawnSync("bash", [script, ...args], options);
}

// --help works without a workspace or task id, and documents the new contract.
let r = runLauncher({ args: ["--help"], taskId: null, workspace: null });
check("--help exits 0", r.status === 0, r.stderr);
check("--help documents workspace configuration", /AEGIS_CONTEST_WORKSPACE/.test(r.stdout), r.stdout.slice(0, 200));
check("--help shows the absolute-path one-line start", r.stdout.includes(`AEGIS_CONTEST_TASK_ID=<anonymous-id> ${RUN}`), r.stdout);
check("--help says the workspace defaults to the caller cwd", /defaults to pwd -P/i.test(r.stdout) && /caller's current directory/i.test(r.stdout), r.stdout);
check("--help does not claim the cwd is a sandbox", /NOT an OS sandbox/i.test(r.stdout), r.stdout);
check("--help keeps the anonymous task id required", /AEGIS_CONTEST_TASK_ID\s+anonymous task id/.test(r.stdout), r.stdout);

// Missing / path-like task id.
r = runLauncher({ taskId: null, workspace: null });
check("missing task id is refused", r.status === 2 && /AEGIS_CONTEST_TASK_ID is required/.test(r.stderr), r.stderr);
r = runLauncher({ taskId: "../escape", workspace: null });
check("path-like task id is refused", r.status === 2 && /path separators/.test(r.stderr), r.stderr);

// A non-directory workspace is still refused.
r = runLauncher({ workspace: join(BASE_DIR, "contest", "run.sh") });
check("non-directory workspace is refused", r.status === 2 && /existing directory/.test(r.stderr), r.stderr);

// The default workspace is now the caller cwd; from inside the checkout it is
// still refused (it is NOT required to set the env explicitly anymore).
r = runLauncher({ workspace: null, cwd: CHECKOUT_ROOT });
check("default cwd inside the checkout is refused", r.status === 2 && /inside the Aegis checkout/.test(r.stderr), r.stderr);

// The Aegis checkout root, its config dir, descendants, and ancestors are all
// refused after realpath, not just Pi_Agent_base.
r = runLauncher({ workspace: BASE_DIR });
check("Pi_Agent_base as workspace is refused", r.status === 2 && /inside the Aegis checkout/.test(r.stderr), r.stderr);
r = runLauncher({ workspace: CHECKOUT_ROOT });
check("Aegis checkout root as workspace is refused", r.status === 2 && /inside the Aegis checkout/.test(r.stderr), r.stderr);
const configDir = join(BASE_DIR, "config");
if (existsSync(configDir)) {
	r = runLauncher({ workspace: configDir });
	check("Aegis config dir as workspace is refused", r.status === 2 && /inside the Aegis checkout/.test(r.stderr), r.stderr);
} else {
	console.log("ok - Aegis config dir as workspace is refused (skipped: config/ absent)");
}
r = runLauncher({ workspace: dirname(CHECKOUT_ROOT) });
check("ancestor of the checkout is refused", r.status === 2 && /inside the Aegis checkout/.test(r.stderr), r.stderr);
r = runLauncher({ workspace: "/" });
check("filesystem root is refused", r.status === 2 && /inside the Aegis checkout/.test(r.stderr), r.stderr);
if (process.env.HOME && existsSync(process.env.HOME) && CHECKOUT_ROOT.startsWith(`${process.env.HOME}/`)) {
	r = runLauncher({ workspace: process.env.HOME });
	check("user HOME exposing the checkout is refused", r.status === 2 && /inside the Aegis checkout/.test(r.stderr), r.stderr);
}

// Any Pi passthrough (long flags, short aliases, `--`, positionals) is refused
// before Pi can start, so it cannot change the controlled A/B conditions.
const temp = mkdtempSync(join(tmpdir(), "aegis-launcher-"));
try {
	const badArgSets = [
		["--model", "some-other-model"],
		["--provider", "other"],
		["--no-session"],
		["-ne"],
		["-e", "evil.ts"],
		["-nt"],
		["-t", "read"],
		["-nc"],
		["--"],
		["--", "--model", "x"],
		["-p"],
		["positional-task-prompt"],
	];
	for (const bad of badArgSets) {
		r = runLauncher({ args: bad, workspace: temp });
		check(`launcher refuses Pi passthrough ${JSON.stringify(bad)}`, r.status === 2 && /refusing|unexpected argument/.test(r.stderr), r.stderr.slice(0, 200));
	}
} finally {
	rmSync(temp, { recursive: true, force: true });
}

// Positive launch checks: a temp checkout with a FAKE pi/pi-test.sh. This
// exercises the real control flow (cwd capture, workspace resolution, cd, exec)
// without a real model, network, credential, or the real checkout state.
const fakeRoot = mkdtempSync(join(tmpdir(), "aegis-launcher-fake-"));
try {
	const fakeCheckout = join(fakeRoot, "checkout");
	const fakeBase = join(fakeCheckout, "Pi_Agent_base");
	mkdirSync(join(fakeBase, "contest"), { recursive: true });
	mkdirSync(join(fakeBase, "pi"), { recursive: true });
	mkdirSync(join(fakeBase, "extensions"), { recursive: true });
	mkdirSync(join(fakeBase, "agent"), { recursive: true });
	const fakeRun = join(fakeBase, "contest", "run.sh");
	cpSync(RUN, fakeRun);
	writeFileSync(join(fakeBase, "extensions", "aegis-observer.ts"), "// fake observer\n");
	writeFileSync(join(fakeBase, "extensions", "aegis-contest.ts"), "// fake contest\n");
	writeFileSync(join(fakeBase, "agent", "ROM.md"), "fake rom\n");
	const fakePi = join(fakeBase, "pi", "pi-test.sh");
	writeFileSync(
		fakePi,
		'#!/usr/bin/env bash\n' +
			'printf "FAKE_PI cwd=%s\\n" "$(pwd -P)"\n' +
			'printf "FAKE_PI task=%s mode=%s ws=%s\\n" "$AEGIS_CONTEST_TASK_ID" "$AEGIS_CONTEST_MODE" "$AEGIS_CONTEST_WORKSPACE"\n' +
			'printf "FAKE_PI args=%s\\n" "$*"\n' +
			'printf "FAKE_TASK_DIR=%s\\n" "$AEGIS_EVENT_LOG" "$AEGIS_RAM_DIR" "$AEGIS_HANDOFF_FILE"\n' +
			'printf "FAKE_ROM=%s\\n" "$AEGIS_ROM_FILE"\n',
	);
	chmodSync(fakePi, 0o755);

	const defaultWorkspace = join(fakeRoot, "task-default");
	const explicitWorkspace = join(fakeRoot, "task-explicit");
	const otherCwd = join(fakeRoot, "elsewhere");
	for (const dir of [defaultWorkspace, explicitWorkspace, otherCwd]) mkdirSync(dir, { recursive: true });
	const realDefault = realpathSync(defaultWorkspace);
	const realExplicit = realpathSync(explicitWorkspace);
	const realOther = realpathSync(otherCwd);

	// Default: workspace == caller cwd.
	r = runLauncher({ script: fakeRun, cwd: realDefault, taskId: "task-default" });
	check("default workspace launch exits 0", r.status === 0, r.stderr);
	check("default workspace cd's into the caller cwd", r.stdout.includes(`FAKE_PI cwd=${realDefault}`), r.stdout);
	check("default workspace exports the caller cwd", r.stdout.includes(`ws=${realDefault}`), r.stdout);
	check("default workspace keeps the anonymous task id", r.stdout.includes("FAKE_PI task=task-default"), r.stdout);
	check("default workspace defaults to mode=off", r.stdout.includes("mode=off"), r.stdout);

	// Explicit override: workspace != caller cwd.
	r = runLauncher({ script: fakeRun, cwd: realOther, workspace: realExplicit, taskId: "task-explicit" });
	check("explicit workspace launch exits 0", r.status === 0, r.stderr);
	check("explicit workspace overrides the caller cwd", r.stdout.includes(`FAKE_PI cwd=${realExplicit}`) && !r.stdout.includes(`FAKE_PI cwd=${realOther}`), r.stdout);
	check("explicit workspace exports the override", r.stdout.includes(`ws=${realExplicit}`), r.stdout);

	// Mode still reaches the fixed off/hint config.
	r = runLauncher({ script: fakeRun, cwd: realDefault, taskId: "task-hint", args: ["--hint"] });
	check("hint mode is passed through in the fake layout", r.status === 0 && r.stdout.includes("mode=hint"), r.stdout);

	// The fake checkout root and an ancestor exposing it are refused too.
	r = runLauncher({ script: fakeRun, cwd: realDefault, workspace: fakeCheckout, taskId: "task-root" });
	check("fake checkout root is refused as workspace", r.status === 2 && /inside the Aegis checkout/.test(r.stderr), r.stderr);
	r = runLauncher({ script: fakeRun, cwd: realDefault, workspace: fakeRoot, taskId: "task-ancestor" });
	check("fake checkout ancestor is refused as workspace", r.status === 2 && /inside the Aegis checkout/.test(r.stderr), r.stderr);

	// The observer and contest extensions are BOTH loaded (the composition fix).
	r = runLauncher({ script: fakeRun, cwd: realDefault, taskId: "task-exts" });
	const extArgs = r.stdout.includes("args=") ? r.stdout.slice(r.stdout.indexOf("args=")) : "";
	check("launcher passes both extension flags to Pi", extArgs.includes("aegis-observer.ts") && extArgs.includes("aegis-contest.ts"), extArgs);

	// The `--tools` allowlist must expose the model-callable runtime tools. The
	// observer's aegis_propose and aegis_switch_session were previously hidden.
	const toolsMatch = /--tools(?:=|\s+)(\S+)/.exec(extArgs);
	const toolsList = toolsMatch ? toolsMatch[1] : "";
	for (const tool of ["read", "bash", "edit", "write", "aegis_propose", "aegis_switch_session"]) {
		check(`launcher --tools exposes ${tool}`, toolsList.split(",").includes(tool), toolsList);
	}

	// The Observer owns the stable ROM injection (structured `aegis_rom`
	// section). The launcher must NOT also append agent/ROM.md at the CLI, or the
	// real launch combination would carry the ROM text twice (addendum + ROM
	// section). The Observer reads the single source via AEGIS_ROM_FILE.
	check("launcher does NOT duplicate the ROM via --append-system-prompt", !/--append-system-prompt/.test(extArgs), extArgs);
	r = runLauncher({ script: fakeRun, cwd: realDefault, taskId: "task-rom-src" });
	const romFileReal = realpathSync(join(fakeBase, "agent", "ROM.md"));
	check("launcher exports AEGIS_ROM_FILE pointing at agent/ROM.md", r.status === 0 && r.stdout.includes(`FAKE_ROM=${romFileReal}`), r.stdout);

	// Per-task isolation: the runtime event log, RAM dir and handoff file must be
	// scoped to the task id, so two tasks can never cross handoff or episodes.
	r = runLauncher({ script: fakeRun, cwd: realDefault, taskId: "task-iso-a" });
	const taskDirsA = r.stdout.match(/FAKE_TASK_DIR=(\S+)/g) || [];
	r = runLauncher({ script: fakeRun, cwd: realDefault, taskId: "task-iso-b" });
	const taskDirsB = r.stdout.match(/FAKE_TASK_DIR=(\S+)/g) || [];
	check("launcher exports a task-scoped runtime dir (current task id in the path)", taskDirsA.some((line) => line.includes("task-iso-a")), JSON.stringify(taskDirsA));
	check("two tasks resolve to DIFFERENT runtime event/ram/handoff dirs", taskDirsA.length >= 3 && taskDirsB.length >= 3 && JSON.stringify(taskDirsA) !== JSON.stringify(taskDirsB), `${JSON.stringify(taskDirsA)} vs ${JSON.stringify(taskDirsB)}`);
	check("the task-scoped event/ram/handoff paths all carry the task id", taskDirsA.every((line) => line.includes("task-iso-a")), JSON.stringify(taskDirsA));
} finally {
	rmSync(fakeRoot, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
	console.error(`contest-launcher-smoke FAILED (${failures} check${failures === 1 ? "" : "s"})`);
	process.exitCode = 1;
} else {
	console.log("contest-launcher-smoke ok");
}
