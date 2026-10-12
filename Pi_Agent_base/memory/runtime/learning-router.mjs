// Aegis learning Router (batch B): direct / habit / hint / deliberate.
//
// The Router is read-only. It never executes, never writes verified state, and
// never feeds a NEW candidate back to the model as if it were experience. It
// answers: given the CURRENT environment, task, arguments and state, which
// already-verified Experience (if any) can be reused, and in which mode?
//
//   direct      active + verified current `when` + every parameter bound + no
//               conflict -> 0 LLM planning.
//   habit       active + scope/`when` match but arguments are missing -> the LLM
//               may ONLY bind the missing parameters; the path is already fixed.
//   hint        a reliable (active) Experience partially matches; give a short
//               hint about the difference. A `candidate` is never a hint.
//   deliberate  no match, conflict, unknown state or anomaly -> full planning.
//   paused      a trusted environment change or a verified counterexample
//               suspends this binding (recoverable by re-verification). One
//               failure never retires a method permanently.
//
// Scope fields are exact-match. An unset/wildcard scope field does NOT match:
// "unknown" is not "any".

import { getPath, matchesPredicate, stable } from "../fixture/contracts.mjs";
import { validateParameters } from "./action-contract.mjs";

const WILDCARDS = new Set(["*", "any", "all", "unknown", "null", ""]);

function isWildcard(value) {
	if (value === null || value === undefined) return true;
	if (typeof value !== "string") return false;
	return WILDCARDS.has(value.trim().toLowerCase());
}

function scopeChecks(experience, environment) {
	const scope = experience.scope || {};
	const checks = [];
	const push = (name, expected, actual) => {
		let ok;
		if (isWildcard(expected)) ok = false;
		else if (Array.isArray(expected)) ok = Array.isArray(actual) && expected.every((value) => actual.includes(value));
		else ok = expected === actual;
		checks.push({ name, ok, expected, actual });
	};
	push("environment_fingerprint", scope.environment_fingerprint, environment.environment_fingerprint);
	push("domain", scope.domain, environment.domain);
	push("permissions", scope.permissions, environment.permissions);
	push("task_types", scope.task_types, environment.task_types);
	return checks;
}

/**
 * The scope dimensions OTHER than the environment fingerprint. When these all
 * match but the fingerprint differs, the SAME binding is being applied to a
 * changed environment -> pause (recoverable), not "not applicable".
 */
function scopeMatchesExceptFingerprint(checks) {
	const stable = checks.filter((check) => check.name !== "environment_fingerprint");
	return stable.length > 0 && stable.every((check) => check.ok);
}

function actionChecks(experience, registry, taskArgs) {
	const checks = [];
	const doSpec = experience.do || {};
	const contract = doSpec.action_ref ? registry?.get(doSpec.action_ref) : null;
	const registered = Boolean(contract);
	checks.push({ name: "action_registered", ok: registered, expected: doSpec.action_ref ?? null, actual: contract ? contract.id : null });

	// Version and implementation digest MUST be explicitly pinned and match. A
	// missing pin is NOT "wildcard" and must fail the binding (audit).
	const versionPinned = doSpec.action_version !== undefined && doSpec.action_version !== null;
	const versionOk = Boolean(contract && versionPinned && doSpec.action_version === contract.version);
	checks.push({
		name: "action_version_matches",
		ok: versionOk,
		expected: contract ? contract.version : null,
		actual: doSpec.action_version ?? null,
		reason: versionPinned ? null : "the experience does not pin action_version",
	});
	const digestPinned = typeof doSpec.implementation_digest === "string" && doSpec.implementation_digest.length > 0;
	const digestOk = Boolean(contract && digestPinned && doSpec.implementation_digest === contract.implementation_digest);
	checks.push({
		name: "implementation_digest_matches",
		ok: digestOk,
		expected: contract ? contract.implementation_digest : null,
		actual: doSpec.implementation_digest ?? null,
		reason: digestPinned ? null : "the experience does not pin implementation_digest",
	});
	const bindingOk = registered && versionOk && digestOk;

	// Unify the template and the task arguments into ONE candidate argument set,
	// then validate it against the contract's data-only schema. A literal
	// template value that disagrees with a supplied task argument is a conflict;
	// extra/unknown, wrong-typed or missing required arguments must NEVER be direct.
	const template = doSpec.arguments_template && typeof doSpec.arguments_template === "object" ? doSpec.arguments_template : {};
	const supplied = taskArgs && typeof taskArgs === "object" ? taskArgs : {};
	const args = { ...supplied };
	const conflicts = [];
	for (const [name, value] of Object.entries(template)) {
		if (value === null || value === undefined) continue; // placeholder -> taken from task args
		if (Object.hasOwn(supplied, name) && stable(supplied[name]) !== stable(value)) conflicts.push(name);
		args[name] = value;
	}
	const schema = contract ? validateParameters(contract.parameters, args, "arguments") : { ok: false, reasons: ["the action is not registered"] };
	const missing = [];
	if (contract) {
		for (const [name, spec] of Object.entries(contract.parameters ?? {})) {
			if (spec.required && (args[name] === undefined || args[name] === null || args[name] === "")) missing.push(name);
		}
		for (const [name, value] of Object.entries(template)) {
			if ((value === null || value === undefined) && (args[name] === undefined || args[name] === null)) if (!missing.includes(name)) missing.push(name);
		}
	}
	const schemaOk = bindingOk && conflicts.length === 0 && missing.length === 0 && schema.ok;
	// Hard errors (type/enum/pattern/unknown-field/conflict) invalidate the binding
	// for BOTH direct and habit. Missing required params only block DIRECT.
	const hardErrors = schema.reasons.filter((reason) => !/ is required$/.test(reason));
	const hardOk = bindingOk && conflicts.length === 0 && hardErrors.length === 0;
	checks.push({
		name: "arguments_schema",
		ok: schemaOk,
		reasons: [
			...schema.reasons,
			...conflicts.map((name) => `template and task arguments disagree on ${name}`),
			...missing.map((name) => `arguments.${name} is missing`),
		],
	});
	return { checks, contract, missing, arguments: args, bindingOk, hardOk, schemaOk };
}

function reliabilityChecks(experience) {
	const checks = [];
	const support = experience.support || {};
	const successIds = Array.isArray(support.success_outcome_ids) ? support.success_outcome_ids : [];
	checks.push({ name: "status_active", ok: experience.status === "active", expected: "active", actual: experience.status ?? null });
	// Independence is proven by DISTINCT identity dimensions, not by a count of
	// outcome ids. A count of two outcomes from one run/group/nonce is ONE proof.
	const distinct = (values) => new Set(Array.isArray(values) ? values.filter((value) => value !== null && value !== undefined && value !== "") : []).size;
	const runIds = distinct(support.run_ids);
	const episodeIds = distinct(support.episode_ids);
	const groups = distinct(support.independence_groups);
	const isolation = distinct(support.isolation_refs);
	const replayHashes = distinct(support.replay_hashes);
	// Independence comes from distinct episode/group/isolation identities. Distinct
	// replay hashes are NOT required: two legal re-executions may produce the same
	// content hash, and forcing hash differences would fabricate support.
	const independent = successIds.length >= 2 && episodeIds >= 2 && groups >= 2 && isolation >= 2;
	checks.push({
		name: "independent_support",
		ok: independent,
		expected: ">=2 distinct outcomes, episodes, groups and isolation refs",
		actual: { outcomes: successIds.length, runs: runIds, episodes: episodeIds, groups, isolation_refs: isolation, replay_hashes: replayHashes },
	});
	const when = Array.isArray(experience.when) ? experience.when : [];
	const whenVerified = when.length > 0 && when.every((predicate) => Array.isArray(predicate.verified_by) && predicate.verified_by.length > 0);
	checks.push({ name: "when_verified", ok: whenVerified, expected: "non-empty verified when", actual: when.length });
	return checks;
}

/**
 * Resolve the claimed support OUTCOMES / EPISODES / REPLAYS against a trusted
 * resolver. A count of ids and a `verified_by` string are NOT proof: the real
 * records must exist and confirm the same episode identity, success status and
 * isolated replay. Returns a check; when no resolver is supplied the support is
 * `unverified` and can never make a binding reliable.
 */
function supportResolutionChecks(experience, resolveSupport) {
	if (typeof resolveSupport !== "function") {
		return { ok: false, resolver: false, checks: [{ name: "support_resolved", ok: false, expected: "trusted support resolver", actual: "absent", reason: "no trusted resolver supplied; the support cannot be verified" }] };
	}
	const support = experience.support || {};
	const outcomeIds = Array.isArray(support.success_outcome_ids) ? support.success_outcome_ids : [];
	const checks = [];
	const episodes = new Set();
	const groups = new Set();
	const isolations = new Set();
	let resolvedOutcomes = 0;
	for (const outcomeId of outcomeIds) {
		const ref = { ref_type: "outcome", ref_id: outcomeId };
		let resolved;
		try {
			resolved = resolveSupport({ kind: "outcome", ref, ref_key: `outcome:${outcomeId}` });
		} catch (error) {
			resolved = { ok: false, reason: `resolver threw: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!resolved || resolved.ok !== true || !resolved.record) {
			checks.push({ name: `support_outcome:${outcomeId}`, ok: false, reason: resolved?.reason ?? "not resolved" });
			continue;
		}
		const outcome = resolved.record;
		if (outcome.status !== "success") {
			checks.push({ name: `support_outcome:${outcomeId}`, ok: false, reason: `resolved status is ${outcome.status}, not success` });
			continue;
		}
		if (outcome.preconditions_verified !== true) {
			checks.push({ name: `support_outcome:${outcomeId}`, ok: false, reason: "preconditions were not verified" });
			continue;
		}
		const outcomeEpisode = outcome.episode_id ?? null;
		if (!outcomeEpisode) {
			checks.push({ name: `support_outcome:${outcomeId}`, ok: false, reason: "resolved outcome has no episode_id" });
			continue;
		}
		// The episode must itself resolve in the SAME identity.
		let episodeRes;
		try {
			episodeRes = resolveSupport({ kind: "episode", ref: { ref_type: "episode", ref_id: outcomeEpisode }, ref_key: `episode:${outcomeEpisode}` });
		} catch (error) {
			episodeRes = { ok: false, reason: `resolver threw: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!episodeRes || episodeRes.ok !== true || !episodeRes.record) {
			checks.push({ name: `support_episode:${outcomeEpisode}`, ok: false, reason: episodeRes?.reason ?? "not resolved" });
			continue;
		}
		const episode = episodeRes.record;
		// An isolated replay must resolve for this episode too.
		let replayRes;
		try {
			replayRes = resolveSupport({ kind: "replay", ref: { ref_type: "replay", ref_id: `replay:${outcomeEpisode}:${outcomeId}` }, ref_key: `replay:${outcomeEpisode}:${outcomeId}` });
		} catch (error) {
			replayRes = { ok: false, reason: `resolver threw: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!replayRes || replayRes.ok !== true || !replayRes.record || replayRes.record.replayable !== true || !(Number.isInteger(replayRes.record.replay_count) && replayRes.record.replay_count >= 1)) {
			checks.push({ name: `support_replay:${outcomeEpisode}`, ok: false, reason: replayRes?.reason ?? "no resolved isolated replay" });
			continue;
		}
		resolvedOutcomes += 1;
		episodes.add(outcomeEpisode);
		groups.add(outcome.oracle?.independence_group ?? episode.independence_group ?? "missing-group");
		isolations.add(outcome.oracle?.isolation_ref ?? episode.isolation_ref ?? "missing-isolation");
	}
	const independent = resolvedOutcomes >= 2 && episodes.size >= 2 && groups.size >= 2 && isolations.size >= 2;
	checks.push({
		name: "support_resolved",
		ok: independent,
		expected: ">=2 resolved outcomes/episodes/groups/isolation refs",
		actual: { resolved_outcomes: resolvedOutcomes, episodes: episodes.size, groups: groups.size, isolation_refs: isolations.size },
	});
	return { ok: checks.every((check) => check.ok), resolver: true, checks };
}

function whenCheck(experience, currentState) {
	const when = Array.isArray(experience.when) ? experience.when : [];
	if (when.length === 0) return { ok: false, known: true, checks: [{ name: "when_present", ok: false, expected: "non-empty when", actual: 0 }] };
	if (!currentState) return { ok: false, known: false, checks: [{ name: "current_state", ok: false, expected: "trusted current state", actual: null }] };
	const checks = [];
	let ok = true;
	let known = true;
	for (const predicate of when) {
		if (!predicate || typeof predicate.path !== "string") {
			ok = false;
			known = false;
			checks.push({ name: "when_shape", ok: false, expected: "structured predicate", actual: predicate });
			continue;
		}
		const value = getPath(currentState, predicate.path);
		// `exists` is always decidable from the trusted state. For eq/neq an
		// ABSENT field is UNKNOWN, not a match: `undefined !== x` must never be
		// read as a verified `neq` (audit).
		const valueKnown = predicate.op === "exists" ? true : value !== undefined;
		let predicateOk = false;
		if (valueKnown) {
			try {
				predicateOk = matchesPredicate(value, predicate);
			} catch {
				predicateOk = false;
				known = false;
			}
		} else {
			known = false;
		}
		if (!predicateOk) ok = false;
		checks.push({ name: `when:${predicate.path}`, ok: predicateOk, known: valueKnown, expected: predicate, actual: value });
	}
	return { ok, known, checks };
}

function counterexampleState(experience) {
	const support = experience.support || {};
	const validation = experience.validation || {};
	if (Array.isArray(validation.counterexamples) && validation.counterexamples.length > 0) {
		return { present: true, reason: `verified counterexample(s): ${validation.counterexamples.join(", ")}` };
	}
	if (Array.isArray(support.failure_outcome_ids) && support.failure_outcome_ids.length > 0 && support.verified_counterexample === true) {
		return { present: true, reason: `verified counterexample outcome(s): ${support.failure_outcome_ids.join(", ")}` };
	}
	return { present: false, reason: null };
}

function ruleIdentity(experience) {
	const doSpec = experience.do || {};
	return stable({ action_ref: doSpec.action_ref ?? null, arguments_template: doSpec.arguments_template ?? null, tool: doSpec.tool ?? null, operation: doSpec.operation ?? null });
}

/**
 * @param {object} input
 * @param {object[]} input.experiences
 * @param {object} input.task `{task_id, task_types, environment?, permissions?, arguments?}`
 * @param {object} input.environment `{environment_fingerprint, domain, permissions, task_types}`
 * @param {object} [input.currentState] trusted current state for `when` predicates
 * @param {object} input.registry ActionRegistry
 * @param {(query:{kind:string, ref:object, ref_key:string|null})=>object} [input.resolveSupport]
 *   trusted resolver for the REAL support outcomes/episodes/replays. Without it
 *   an active experience is never trusted enough to go direct/habit/hint.
 */
export function routeLearning({ experiences = [], task = {}, environment = {}, currentState = null, registry, resolveSupport = null } = {}) {
	const resolver = typeof resolveSupport === "function" ? resolveSupport : typeof environment.resolveSupport === "function" ? environment.resolveSupport : null;
	const env = {
		environment_fingerprint: environment.environment_fingerprint ?? task.environment?.environment_fingerprint ?? null,
		domain: environment.domain ?? task.environment?.domain ?? null,
		permissions: environment.permissions ?? task.permissions ?? [],
		task_types: environment.task_types ?? task.task_types ?? [],
	};
	const candidates = [];
	for (const experience of experiences) {
		const scope = scopeChecks(experience, env);
		const scopeMatch = scope.every((check) => check.ok);
		const reliability = reliabilityChecks(experience);
		const supportResolution = supportResolutionChecks(experience, resolver);
		// A binding is reliable ONLY when the declared support is shape-correct AND
		// every claimed outcome/episode/replay resolves to a real record.
		const reliable = experience.status === "active" && reliability.every((check) => check.ok) && supportResolution.ok;
		const { checks: actionChk, contract, missing, arguments: boundArgs, bindingOk, hardOk } = actionChecks(experience, registry, task.arguments);
		const actionOk = hardOk;
		const when = whenCheck(experience, currentState);
		const counterexample = counterexampleState(experience);
		const envChanged = scope.some((check) => check.name === "environment_fingerprint" && !check.ok);
		// A paused binding is one whose SCOPE still points at this task but whose
		// trusted environment changed, OR a verified counterexample, OR an active
		// rule whose registered action/version/digest no longer matches (a changed
		// binding, not merely malformed arguments), OR an active rule whose claimed
		// support does not resolve to real records (an unverifiable claim is not
		// reusable and must not silently become a hint).
		const sameTaskDifferentEnv = envChanged && scopeMatchesExceptFingerprint(scope);
		const actionInvalidated = experience.status === "active" && reliable && scopeMatch && !bindingOk;
		const supportUnresolved = experience.status === "active" && scopeMatch && !supportResolution.ok;
		const paused = Boolean(counterexample.present) || sameTaskDifferentEnv || actionInvalidated || supportUnresolved;
		candidates.push({
			experience_id: experience.experience_id ?? null,
			status: experience.status ?? null,
			scope,
			scope_match: scopeMatch,
			same_task_different_env: sameTaskDifferentEnv,
			reliability,
			support_resolution: supportResolution,
			reliable,
			action_checks: actionChk,
			action_ok: actionOk,
			binding_ok: bindingOk,
			contract,
			missing_parameters: missing,
			bound_arguments: boundArgs,
			when,
			action_invalidated: actionInvalidated,
			support_unresolved: supportUnresolved,
			paused,
			pause_reason: counterexample.present
				? counterexample.reason
				: sameTaskDifferentEnv
					? "scope environment fingerprint changed; binding paused until re-verified"
					: actionInvalidated
						? "registered action version/implementation no longer matches; binding paused until re-verified"
						: supportUnresolved
							? "claimed support does not resolve to real outcome/episode/replay records; binding paused until re-verified"
							: null,
			rule_identity: ruleIdentity(experience),
		});
	}

	// Scope-matched candidates only. A candidate Experience is never usable.
	// Paused candidates include those whose scope matches except for a changed
	// environment fingerprint (same task, changed env).
	const scoped = candidates.filter((candidate) => candidate.scope_match);
	const pausedScoped = candidates.filter((candidate) => candidate.paused && (candidate.scope_match || candidate.same_task_different_env));
	const usable = candidates.filter((candidate) => candidate.scope_match && candidate.reliable && candidate.action_ok && !candidate.paused);
	const directReady = usable.filter((candidate) => candidate.when.ok && candidate.missing_parameters.length === 0);

	// A conflict is two DIRECT-ready rules with different effects. A paused rule
	// competing with a direct rule is also ambiguous, so it refuses rather than
	// silently picking one.
	if (directReady.length > 1 && new Set(directReady.map((candidate) => candidate.rule_identity)).size > 1) {
		return {
			route: "refuse",
			router_decision: "conflict",
			reason: `conflicting matching active experiences: ${directReady.map((candidate) => candidate.experience_id).join(", ")}`,
			candidates,
			experience: null,
		};
	}
	if (directReady.length === 1 && pausedScoped.length > 0 && pausedScoped.some((candidate) => candidate.rule_identity !== directReady[0].rule_identity)) {
		return {
			route: "refuse",
			router_decision: "conflict",
			reason: "a direct-ready rule competes with a paused/conflicting rule; refusing to guess",
			candidates,
			experience: null,
		};
	}

	if (directReady.length >= 1) {
		const winner = directReady[0];
		const experience = experiences.find((item) => item.experience_id === winner.experience_id);
		return {
			route: "direct",
			router_decision: "direct",
			reason: "active experience scope, verified when and all parameters match",
			experience,
			action_ref: experience?.do?.action_ref ?? null,
			arguments: winner.bound_arguments,
			candidates,
		};
	}

	// Paused bindings dominate hint/deliberate for their scope: do not use a
	// suspended rule and do not silently fall back to a hint. A changed
	// environment, a verified counterexample, or a changed action binding all
	// suspend the rule until re-verification. (Malformed arguments are NOT a
	// pause; they simply do not satisfy the schema.)
	if (pausedScoped.length > 0) {
		return {
			route: "paused",
			router_decision: "paused",
			reason: pausedScoped.map((candidate) => `${candidate.experience_id}: ${candidate.pause_reason ?? "binding suspended; re-verification required"}`).join("; "),
			recoverable: true,
			candidates,
			experience: null,
		};
	}

	// habit: reliable + action valid + when verified, but parameters missing.
	const habitReady = usable.filter((candidate) => candidate.when.ok && candidate.missing_parameters.length > 0);
	if (habitReady.length === 1) {
		const winner = habitReady[0];
		const experience = experiences.find((item) => item.experience_id === winner.experience_id);
		return {
			route: "habit",
			router_decision: "habit",
			reason: "active experience matches but parameters must be bound",
			experience,
			action_ref: experience?.do?.action_ref ?? null,
			missing_parameters: winner.missing_parameters,
			candidates,
		};
	}

	// hint: reliable + action valid, but `when` is partially unknown/unmet. A
	// candidate is never eligible.
	const hintReady = usable.filter((candidate) => !candidate.when.ok);
	if (hintReady.length >= 1) {
		const winner = hintReady[0];
		const experience = experiences.find((item) => item.experience_id === winner.experience_id);
		return {
			route: "hint",
			router_decision: "hint",
			reason: "an active experience partially matches; the difference must be checked",
			experience,
			action_ref: experience?.do?.action_ref ?? null,
			hint: `Possible match: ${experience?.do?.action_ref ?? "unknown action"}. Confirm the reported difference before reusing it.`,
			differences: winner.when.checks.filter((check) => !check.ok),
			candidates,
		};
	}

	return {
		route: "deliberate",
		router_decision: "no_match",
		reason: scoped.length === 0 ? "no experience scope matched the current environment; explore" : "no reliable experience is reusable in the current state; explore",
		experience: null,
		candidates,
	};
}
