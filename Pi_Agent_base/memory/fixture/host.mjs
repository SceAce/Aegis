// Trusted fixture Host.
//
// The Host is the only writer for the fixture slice. It:
//   1. creates a clean per-task experiment directory,
//   2. writes the fixture and observes/hashes the real initial state,
//   3. optionally asks the Router (after writing the manifest) for a decision,
//   4. re-checks a direct decision and the final parameters against the trusted
//      manifest and registered primitive immediately before execution (fail
//      closed on refusal, authorization mismatch, or a forged/rewritten direct
//      decision),
//   5. records the action intent before execution,
//   6. executes a registered action primitive through the broker,
//   7. records transport completion and closes the episode.
//
// It does not judge success. The Oracle does that independently.

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { actionSpecDigest, executeAction, getAction, validateActionArguments } from "./action-registry.mjs";
import {
	HOST_VERSION,
	SCHEMA_VERSION,
	createEventWriter,
	digest,
	evaluatePredicates,
	isoNow,
	newId,
	readJson,
	resolveInside,
	source,
	stable,
	writeJson,
} from "./contracts.mjs";

// Re-check a direct Router decision against the trusted manifest and the
// registered primitive immediately before execution. A forged/rewritten
// decision (or final parameters) must fail closed: no action is executed.
function validateDirectDecision({ decision, manifest, action, fixtureRoot, args }) {
	const reasons = [];
	const msg = (error) => (error instanceof Error ? error.message : String(error));
	const experience = decision?.experience;
	if (!experience || typeof experience !== "object") {
		reasons.push("direct decision has no experience object");
	} else {
		if (experience.status !== "active") reasons.push("direct experience is not active");
		if (experience.scope?.mode !== "live") reasons.push("direct experience scope is not live");
		if (experience.do?.action_ref !== action.id) reasons.push("direct experience action_ref does not match the executed action");
		if (experience.do?.action_spec_digest !== actionSpecDigest(action)) reasons.push("direct experience action_spec_digest does not match the registered action");
		if (experience.do?.tool !== action.tool) reasons.push("direct experience tool does not match the registered action");
		if (experience.do?.operation !== action.operation) reasons.push("direct experience operation does not match the registered action");
		const when = Array.isArray(experience.when) ? experience.when : null;
		if (!when || when.length === 0) reasons.push("direct experience has no verified when predicates");
		const expect = Array.isArray(experience.expect) ? experience.expect : null;
		if (!expect || expect.length === 0) reasons.push("direct experience has no expected state");
		if (expect && stable(expect) !== stable(manifest.state.postconditions)) reasons.push("direct experience expected state does not match the manifest postconditions");
		const templatePath = experience.do?.arguments_template?.path;
		if (templatePath !== manifest.action.target_path) reasons.push("direct experience target does not match the manifest target");
	}

	// Final parameters: validate against the registered schema and require the
	// declared target, then re-read the live pre-state and recheck it.
	const argCheck = validateActionArguments(action, args);
	if (!argCheck.ok) reasons.push(`final arguments invalid: ${argCheck.reason}`);
	if (args?.path !== manifest.action.target_path) reasons.push("final argument path does not match the manifest target");
	let preState = null;
	try {
		preState = readJson(resolveInside(fixtureRoot, manifest.action.target_path, { mustExist: true }));
	} catch (error) {
		reasons.push(`final pre-state unreadable: ${msg(error)}`);
	}
	if (preState !== null) {
		const preconditions = Array.isArray(manifest.state.preconditions) ? manifest.state.preconditions : [];
		if (preconditions.length === 0) reasons.push("manifest has no preconditions to re-check");
		else if (!evaluatePredicates(preState, preconditions)) reasons.push("final pre-state does not satisfy the manifest preconditions");
	}
	return { ok: reasons.length === 0, reasons };
}

export function makeTask(overrides = {}) {
	const base = {
		goal_id: "unlock_fixture",
		description: "Unlock the fixture door",
		task_type: "unlock",
		environment_fingerprint: "live-fixture-v1",
		domain: "fixture",
		target: "door",
		permissions: ["fixture-only"],
		allowed_actions: ["fixture.unlock"],
		// Path convention: relative to the per-task fixture root, never absolute.
		fixture_relative_path: "door.json",
		initialState: { target: "door", locked: true, version: 1 },
		preconditions: [{ path: "locked", op: "eq", value: true }],
		postconditions: [
			{ path: "target", op: "eq", value: "door" },
			{ path: "locked", op: "eq", value: false },
			{ path: "version", op: "eq", value: 1 },
		],
	};
	return { ...base, ...overrides };
}

// Read the current fixture state through the boundary. Used by the Router to
// check "current verified preconditions" before it decides to go direct.
export function readTrustedFixtureState(fixtureRoot, relativePath) {
	try {
		const targetPath = resolveInside(fixtureRoot, relativePath, { mustExist: true });
		return { ok: true, state: readJson(targetPath), path: targetPath };
	} catch (error) {
		return { ok: false, state: null, error: error instanceof Error ? error.message : String(error) };
	}
}

export function buildManifest({ experimentId, task, action, independenceGroup, declaredState }) {
	return {
		schema_version: SCHEMA_VERSION,
		experiment_id: experimentId,
		source_kind: "live",
		goal: {
			goal_id: task.goal_id,
			description: task.description,
			success_criteria: task.postconditions.map((predicate) => `${predicate.path} ${predicate.op} ${JSON.stringify(predicate.value)}`),
		},
		authorization: { allowed_actions: task.allowed_actions, target: task.target, side_effects: "fixture-only" },
		environment: { environment_fingerprint: task.environment_fingerprint, domain: task.domain, permissions: task.permissions },
		state: {
			format: "json",
			path: task.fixture_relative_path,
			initial_snapshot: declaredState,
			preconditions: task.preconditions,
			postconditions: task.postconditions,
		},
		action: {
			action_id: action.id,
			tool_names: [action.tool],
			target_path: task.fixture_relative_path,
			operation: action.operation,
			risk_class: action.risk_class,
		},
		task_types: [task.task_type],
		independence_group: independenceGroup,
	};
}

export function runFixtureTask({ root, task = makeTask(), actionId = "fixture.unlock", args, decision = null, router = null, simulate = {} }) {
	const action = getAction(actionId);
	if (!action) throw new Error(`unknown action: ${actionId}`);
	const experimentId = `fixture-${basename(root)}`;
	mkdirSync(root, { recursive: true });
	const fixtureRoot = join(root, "fixture");
	mkdirSync(fixtureRoot, { recursive: true });
	if (simulate.seedSymlinkEscape) {
		// Used only by negative tests: a symlink inside the fixture root that
		// points outside it must be rejected by resolveInside.
		const linkPath = join(fixtureRoot, "escape.json");
		try {
			symlinkSync(simulate.seedSymlinkEscape, linkPath);
		} catch {
			/* link may already exist across repeated runs */
		}
	}
	// Every actual fixture access uses the same root boundary as the action
	// primitive. This rejects absolute paths and `..` before any write.
	const fixturePath = resolveInside(fixtureRoot, task.fixture_relative_path);
	const declaredState = simulate.initialStateOverride || task.initialState;
	writeJson(fixturePath, declaredState);

	// Trusted observation: read the real file, not the declaration.
	const observedState = readJson(fixturePath);
	const initialDigest = digest(observedState);
	// Persist an immutable copy of the trusted pre-action observation outside the
	// fixture root so the Oracle can independently re-hash it after the action
	// mutates the live fixture.
	writeJson(join(root, "trusted-initial-state.json"), observedState);
	const runId = newId();
	const resetNonce = newId();
	const independenceGroup = `fixture-run-${digest({
		run_id: runId,
		reset_nonce: resetNonce,
		experiment_id: experimentId,
		fixture_root: fixtureRoot,
	}).slice(7, 23)}`;

	const writer = createEventWriter([], { persistPath: join(root, "events.jsonl") });
	const episodeId = newId();
	let sequence = 0;
	const hostSource = source("aegis-host", "environment", "fixture-host", HOST_VERSION);
	const goal = {
		goal_id: task.goal_id,
		description: task.description,
		success_criteria: task.postconditions.map((predicate) => `${predicate.path} ${predicate.op} ${JSON.stringify(predicate.value)}`),
	};

	const started = writer.emit(
		"episode.started",
		episodeId,
		sequence++,
		{
			source_kind: "live",
			goal,
			environment: { environment_fingerprint: task.environment_fingerprint, domain: task.domain, permissions: task.permissions },
			task_type: task.task_type,
			run_id: runId,
			independence_group: independenceGroup,
		},
		hostSource,
	);

	let observation = null;
	if (!simulate.omitObservation) {
		observation = writer.emit(
			"observation.captured",
			episodeId,
			sequence++,
			{
				observation_kind: "state",
				path: task.fixture_relative_path,
				value: observedState,
				value_digest: initialDigest,
				source: "trusted_runner",
				run_id: runId,
				independence_group: independenceGroup,
			},
			hostSource,
			{ evidence_refs: [{ ref_type: "event", ref_id: started.event_id }] },
		);
	}

	// Write the manifest before routing so the Router checks real scope.
	const manifest = buildManifest({ experimentId, task, action, independenceGroup, declaredState });
	writeJson(join(root, "manifest.json"), manifest);

	let effectiveDecision = decision;
	if (router) {
		try {
			effectiveDecision = router({ manifest, fixtureRoot, run: { run_id: runId, independence_group: independenceGroup } });
		} catch (error) {
			effectiveDecision = {
				route: "refuse",
				routerDecision: "error",
				experience: null,
				reason: `router error: ${error instanceof Error ? error.message : String(error)}`,
				checks: [],
			};
		}
	}

	let routerNote = null;
	if (effectiveDecision) {
		routerNote = writer.emit(
			"note",
			episodeId,
			sequence++,
			{
				kind: "router.decision",
				decision: effectiveDecision.routerDecision || (effectiveDecision.experience ? "direct" : "no_match"),
				route: effectiveDecision.route,
				experience_id: effectiveDecision.experience?.experience_id || null,
				reason: effectiveDecision.reason || null,
				checks: effectiveDecision.checks || [],
			},
			source("aegis-router", "observer", "experience-router", HOST_VERSION),
			{ evidence_refs: observation ? [{ ref_type: "event", ref_id: observation.event_id }] : [] },
		);
	}

	// Direct route: only run if the router authorizes this exact action.
	const direct = effectiveDecision?.route === "direct";
	if (direct && effectiveDecision.actionId && effectiveDecision.actionId !== actionId) {
		throw new Error(`router authorized ${effectiveDecision.actionId} but host was asked to run ${actionId}`);
	}
	const allowedActions = Array.isArray(task.allowed_actions) ? task.allowed_actions : [];
	const actionAuthorized = allowedActions.includes(actionId);
	const actionArgs = direct && effectiveDecision.arguments ? effectiveDecision.arguments : args || { path: task.fixture_relative_path };

	// Fail closed. Re-check the final decision and parameters against the trusted
	// manifest and registered primitive immediately before execution. Refusal,
	// an authorization mismatch, or a forged direct decision blocks execution.
	let executionBlock = null;
	let blockReasons = [];
	if (effectiveDecision?.route === "refuse") {
		executionBlock = "refused";
	} else if (!actionAuthorized) {
		executionBlock = "unauthorized";
	} else if (direct) {
		const guard = validateDirectDecision({ decision: effectiveDecision, manifest, action, fixtureRoot, args: actionArgs });
		if (!guard.ok) {
			executionBlock = "forged_direct_decision";
			blockReasons = guard.reasons;
		}
	}

	const request = writer.emit(
		"action.requested",
		episodeId,
		sequence++,
		{
			action_id: newId(),
			tool_name: action.tool,
			operation: action.operation,
			action_ref: action.id,
			route: direct ? "direct" : "deliberate",
			experience_id: direct ? effectiveDecision.experience?.experience_id || null : null,
			arguments: actionArgs,
			...(executionBlock ? { blocked: executionBlock } : {}),
			...(blockReasons.length ? { block_reasons: blockReasons } : {}),
		},
		source("aegis-host", "agent", "fixture-host", HOST_VERSION),
		{ evidence_refs: observation ? [{ ref_type: "event", ref_id: observation.event_id }] : [] },
	);

	if (simulate.corruptBeforeAction) writeFileSync(fixturePath, "{not-json", "utf8");

	let transport;
	if (executionBlock) {
		transport = {
			tool_ok: false,
			exit_code: 2,
			timed_out: false,
			duration_ms: 0,
			failure_mode: executionBlock,
			error:
				executionBlock === "refused"
					? "router refused execution"
					: executionBlock === "unauthorized"
						? `action not authorized by task: ${actionId}`
						: `direct decision failed re-check: ${blockReasons.join("; ")}`,
		};
	} else if (simulate.skipAction) {
		transport = { tool_ok: false, exit_code: null, timed_out: true, duration_ms: 0, failure_mode: "timeout" };
	} else {
		transport = executeAction(actionId, { fixtureRoot, arguments: actionArgs });
	}

	const completed = writer.emit(
		"action.completed",
		episodeId,
		sequence++,
		{
			action_id: request.payload.action_id,
			tool_name: action.tool,
			operation: action.operation,
			transport: {
				tool_ok: transport.tool_ok,
				exit_code: transport.exit_code ?? null,
				timed_out: transport.timed_out ?? null,
				duration_ms: transport.duration_ms ?? null,
			},
			...(transport.failure_mode ? { failure_mode: transport.failure_mode } : {}),
			...(transport.error ? { error: transport.error } : {}),
		},
		source("aegis-host", "environment", "fixture-host", HOST_VERSION),
		{ causation_id: request.event_id, evidence_refs: [request.event_id] },
	);

	if (simulate.removePostState) rmSync(fixturePath, { force: true });
	if (simulate.corruptPostState) writeFileSync(fixturePath, "{not-json", "utf8");

	const closed = writer.emit(
		"episode.closed",
		episodeId,
		sequence++,
		{ status: "pending_oracle" },
		source("aegis-host", "environment", "fixture-host", HOST_VERSION),
		{ causation_id: completed.event_id, evidence_refs: [completed.event_id] },
	);

	const events = writer.all();

	const run = {
		schema_version: SCHEMA_VERSION,
		run_id: runId,
		reset_nonce: resetNonce,
		independence_group: independenceGroup,
		experiment_id: experimentId,
		fixture_root: fixtureRoot,
		fixture_relative_path: task.fixture_relative_path,
		initial_state: observedState,
		initial_state_digest: initialDigest,
		host_version: HOST_VERSION,
		created_at: isoNow(),
		trusted_initial_state_path: "trusted-initial-state.json",
	};
	if (simulate.tamperRunState) {
		run.initial_state = { ...run.initial_state, locked: false };
		// keep the original digest on purpose: the Oracle must re-hash and detect it.
	}
	writeJson(join(root, "run.json"), run);

	return {
		root,
		experimentDir: root,
		fixtureRoot,
		fixturePath,
		episodeId,
		run,
		manifest,
		events,
		action,
		actionArgs,
		transport,
		request,
		completed,
		observation,
		decision: effectiveDecision,
		closed,
		independenceGroup,
	};
}
