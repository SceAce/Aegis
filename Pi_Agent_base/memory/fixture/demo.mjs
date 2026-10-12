// Offline 2+1 fixture direct demo.
//
// Run:  node Pi_Agent_base/memory/fixture/demo.mjs [--work DIR] [--json]
//
// Full vertical slice, no model calls and no network:
//   1. two genuinely independent live fixture tasks (fresh reset + fresh event
//      log each, trusted initial-state observation),
//   2. the Compiler promotes a fixture-only `active` Experience from that
//      verified live evidence + the registered `fixture.unlock` primitive,
//   3. a third fresh task where the Router hits the active Experience and the
//      Host executes the primitive directly (no re-planning), then the Oracle
//      verifies again,
//   4. a no-experience control task through the same authorization / execution
//      / verification boundary, reported for comparison.
//
// It writes an auditable `demo-report.json` next to the run.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runFixtureTask } from "./host.mjs";
import { judgeRun } from "./oracle.mjs";
import { compile } from "./compiler.mjs";
import { route } from "./router.mjs";
import { writeJson } from "./contracts.mjs";

function parseArgs(argv) {
	const options = { json: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--work") {
			options.work = argv[index + 1];
			index += 1;
		} else if (argument === "--json") options.json = true;
		else if (argument === "--help" || argument === "-h") options.help = true;
		else throw new Error(`unknown option: ${argument}`);
	}
	return options;
}

export function runDemo({ work } = {}) {
	const base = work ? resolve(work) : mkdtempSync(join(tmpdir(), "aegis-fixture-demo-"));
	mkdirSync(base, { recursive: true });

	const report = {
		schema_version: "1.0",
		demo: "fixture-direct-2plus1",
		base_dir: base,
		offline: true,
		model_calls: 0,
		pi_integration_verified: false,
		steps: {},
		honest_notes: [],
	};

	// --- Episodes 1 & 2: two independent live successes -------------------
	const firstRoot = join(base, "episode-1");
	const secondRoot = join(base, "episode-2");
	const firstRun = runFixtureTask({ root: firstRoot });
	const firstJudged = judgeRun(firstRoot);
	const secondRun = runFixtureTask({ root: secondRoot });
	const secondJudged = judgeRun(secondRoot);

	report.steps.episodes = [firstRun, secondRun].map((bundle, index) => ({
		index: index + 1,
		root: index === 0 ? firstRoot : secondRoot,
		run_id: bundle.run.run_id,
		independence_group: bundle.run.independence_group,
		reset_nonce: bundle.run.reset_nonce,
		initial_state_digest: bundle.run.initial_state_digest,
		oracle_status: index === 0 ? firstJudged.status : secondJudged.status,
	}));

	const bothSuccess = firstJudged.status === "success" && secondJudged.status === "success";
	if (!bothSuccess) report.honest_notes.push("one or both live episodes did not reach verified success; compilation must not activate");

	// --- Compile ----------------------------------------------------------
	const compiled = compile({ projectionDirs: [firstRoot, secondRoot], outputDir: join(base, "compiled") });
	const experience = compiled.experience;
	report.steps.compile = {
		status: experience.status,
		experience_id: experience.experience_id,
		independent_episode_count: experience.support.independent_episode_count,
		gate_reasons: compiled.report.gate.reasons,
		do: experience.do,
	};

	// --- Third fresh task with Router ------------------------------------
	const thirdRoot = join(base, "episode-3");
	let thirdDecision = null;
	const thirdRun = runFixtureTask({
		root: thirdRoot,
		router: ({ manifest, fixtureRoot }) => {
			thirdDecision = route({ experiences: [experience], manifest, fixtureRoot });
			return thirdDecision;
		},
	});
	const thirdJudged = judgeRun(thirdRoot);

	report.steps.route_third = {
		route: thirdDecision?.route || null,
		router_decision: thirdDecision?.routerDecision || null,
		experience_id: thirdDecision?.experience?.experience_id || null,
		action_id: thirdDecision?.actionId || null,
		reason: thirdDecision?.reason || null,
		checks: thirdDecision?.checks || [],
	};
	report.steps.third_task = {
		root: thirdRoot,
		oracle_status: thirdJudged.status,
		executed_action: thirdRun.action.id,
		action_ref: thirdRun.request.payload.action_ref,
		route: thirdRun.request.payload.route,
		used_experience: thirdRun.request.payload.route === "direct",
	};
	if (thirdRun.request.payload.route !== "direct") {
		report.honest_notes.push("third task did NOT hit the active experience; it fell back to deliberate routing");
	}

	// --- No-experience control -------------------------------------------
	const controlRoot = join(base, "control");
	let controlDecision = null;
	const controlRun = runFixtureTask({
		root: controlRoot,
		router: ({ manifest, fixtureRoot }) => {
			controlDecision = route({ experiences: [], manifest, fixtureRoot });
			return controlDecision;
		},
	});
	const controlJudged = judgeRun(controlRoot);
	report.steps.control = {
		root: controlRoot,
		route: controlDecision?.route || null,
		router_decision: controlDecision?.routerDecision || null,
		oracle_status: controlJudged.status,
		executed_action: controlRun.action.id,
		action_ref: controlRun.request.payload.action_ref,
		used_experience: false,
	};
	report.honest_notes.push("control task uses the same authorization/execution/verification boundary but no Experience; it re-plans and executes the declared primitive instead of a direct hit");

	report.verified = {
		two_independent_live_successes: bothSuccess,
		experience_active: experience.status === "active",
		third_task_direct_hit: thirdRun.request.payload.route === "direct",
		third_task_oracle_success: thirdJudged.status === "success",
		control_oracle_success: controlJudged.status === "success",
	};
	report.honest_notes.push("fixture direct demo passes as a deterministic Node Host; Pi integration is not verified");

	return report;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write("Usage: node demo.mjs [--work DIR] [--json]\n");
		return;
	}
	const report = runDemo({ work: options.work });
	const reportPath = join(report.base_dir, "demo-report.json");
	writeJson(reportPath, report);
	console.log(JSON.stringify({
		report: reportPath,
		episodes: report.steps.episodes.map((item) => item.oracle_status),
		experience_status: report.steps.compile.status,
		third_route: report.steps.route_third.route,
		third_oracle: report.steps.third_task.oracle_status,
		control_route: report.steps.control.route,
		control_oracle: report.steps.control.oracle_status,
		verified: report.verified,
	}, null, 2));
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
	main().catch((error) => {
		console.error(`fixture-demo: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
