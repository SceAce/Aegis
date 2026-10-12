// Aegis-owned orchestrator for the fixture direct slice.
//
// This module is the control-flow owner that fixes the THINK.md `direct`
// semantics. It does NOT reimplement Host, Router, Oracle or action logic; it
// sequences the existing modules:
//
//   1. The Experience check runs BEFORE any model call and BEFORE any Pi session
//      exists. `routeTask` writes the declared fixture state so the existing
//      read-only Router can verify current preconditions against the real file.
//   2. On a direct hit the existing Host executes the registered primitive and
//      the independent Oracle verifies it. No Pi session is started and no model
//      request is made (`model_requests: 0`, `pi_session_started: false`).
//   3. If the Router refuses (a conflict between multiple matching active
//      Experiences) the orchestrator fails closed: no planner is called, no Pi
//      session is started, and no registered primitive is executed.
//   4. Only when no Experience matches does the orchestrator call the injected
//      Pi planner. The planner starts the tightly constrained Pi SDK session
//      (faux provider offline), obtains the single `aegis_fixture_unlock` tool
//      call, and returns its data-only arguments. The existing Host then
//      executes that chosen action and the same Oracle verifies it.
//
// The authoritative direct check still happens inside `runFixtureTask`
// (`validateDirectDecision`), so a forged/rewritten routing decision fails
// closed even if the orchestrator were bypassed.

import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { getAction } from "./action-registry.mjs";
import { resolveInside, writeJson } from "./contracts.mjs";
import { buildManifest, makeTask, runFixtureTask } from "./host.mjs";
import { judgeRun } from "./oracle.mjs";
import { route } from "./router.mjs";

// Read-only routing check with no execution and no model call. Writes only the
// declared fixture state so the Router can read the real preconditions; the
// Host re-observes and re-hashes that state before executing anything.
export function routeTask({ root, task = makeTask(), actionId = "fixture.unlock", experiences = [] }) {
	if (typeof root !== "string" || root.length === 0) throw new Error("routeTask requires a root directory");
	if (!Array.isArray(experiences)) throw new Error("routeTask experiences must be an array");
	const action = getAction(actionId);
	if (!action) throw new Error(`routeTask unknown action: ${actionId}`);
	const fixtureRoot = join(root, "fixture");
	mkdirSync(fixtureRoot, { recursive: true });
	writeJson(resolveInside(fixtureRoot, task.fixture_relative_path), task.initialState);
	const manifest = buildManifest({
		experimentId: `fixture-${basename(root)}`,
		task,
		action,
		independenceGroup: "route-probe",
		declaredState: task.initialState,
	});
	return route({ experiences, manifest, fixtureRoot });
}

// Orchestrate one fresh task. `planner` is only invoked when no active
// Experience matches; it must return `{ arguments: { path }, model_requests,
// pi_session_started, tool_name }`. It is injected so this module stays free of
// any Pi SDK import and the direct path never loads Pi.
export async function runOrchestratedTask({
	root,
	task = makeTask(),
	actionId = "fixture.unlock",
	experiences = [],
	planner = null,
}) {
	if (typeof root !== "string" || root.length === 0) throw new Error("runOrchestratedTask requires a root directory");
	if (!Array.isArray(experiences)) throw new Error("runOrchestratedTask experiences must be an array");

	const decision = routeTask({ root, task, actionId, experiences });

	// Fail closed on an unresolvable conflict. A `refuse` decision must never be
	// turned into a model consultation or a primitive execution: there is no
	// planner call, no Pi session, and no registered action run. The result is
	// reported as `refuse`, explicitly not as `deliberate`.
	if (decision.route === "refuse") {
		return {
			route: "refuse",
			plan_source: null,
			used_experience: false,
			experience_id: null,
			model_requests: 0,
			pi_session_started: false,
			tool_name: null,
			decision,
			run: null,
			judged: null,
		};
	}

	if (decision.route === "direct") {
		// Fast path: a verified active Experience fully determines the action.
		// No model is consulted and no Pi session is created.
		const run = runFixtureTask({ root, task, actionId, decision });
		const judged = judgeRun(root);
		return {
			route: "direct",
			plan_source: "experience",
			used_experience: true,
			experience_id: decision.experience?.experience_id ?? null,
			model_requests: 0,
			pi_session_started: false,
			tool_name: null,
			decision,
			run,
			judged,
		};
	}

	// No direct hit: the constrained Pi planner proposes the action. This is the
	// only branch where a model may be consulted.
	if (typeof planner !== "function") {
		throw new Error("no active Experience matched and no Pi planner was provided; refusing a deliberate route without a planner");
	}
	const plan = await planner({ task, actionId, root, decision });
	const plannedPath = plan?.arguments?.path;
	if (typeof plannedPath !== "string" || plannedPath.length === 0) {
		throw new Error("Pi planner did not return a data-only action argument { path }");
	}
	if (plannedPath !== task.fixture_relative_path) {
		throw new Error(`Pi planner chose "${plannedPath}", outside the task target "${task.fixture_relative_path}"`);
	}
	const run = runFixtureTask({ root, task, actionId, args: plan.arguments });
	const judged = judgeRun(root);
	return {
		route: run.request.payload.route,
		plan_source: "pi",
		used_experience: false,
		experience_id: null,
		model_requests: Number.isInteger(plan.model_requests) ? plan.model_requests : 0,
		pi_session_started: plan.pi_session_started !== false,
		tool_name: plan.tool_name ?? null,
		decision,
		run,
		judged,
	};
}
