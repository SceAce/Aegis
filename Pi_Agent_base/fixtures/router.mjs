// Read-only applicability Router for the fixture direct slice.
//
// The Router answers one question: "Can one active Experience be used directly
// for this fresh task?" It never executes anything. It checks:
//   - the Experience is `active` with a live scope,
//   - non-empty, verified `when` and non-empty `expect`,
//   - scope matches (environment fingerprint, domain, permissions, task type),
//   - the current trusted preconditions are verified against the real file,
//   - the registered action ref, spec digest, tool/operation/risk and argument
//     template target all match the registry and the manifest whitelist,
//   - there is no conflict with a competing rule.
//
// A forged or rewritten active Experience (empty conditions, bogus spec digest,
// non-live scope, mismatched target) is never a hit. On a hit it returns the
// registered action id + data-only arguments. The Host runs that primitive; the
// Oracle verifies the result again.

import { join } from "node:path";
import { digest, evaluatePredicates, getPath, readJson, resolveInside } from "../shared/contracts.mjs";
import { actionSpecDigest, getAction } from "./action-registry.mjs";

function scopeMatches(experience, manifest) {
	const scope = experience.scope || {};
	const env = manifest.environment || {};
	const checks = [];
	const push = (name, expected, actual) => {
		if (expected === undefined || expected === null) {
			checks.push({ name, ok: false, expected, actual, reason: "scope field is unset" });
			return;
		}
		const ok = Array.isArray(expected)
			? Array.isArray(actual) && expected.every((value) => actual.includes(value))
			: expected === actual;
		checks.push({ name, ok, expected, actual });
	};
	push("environment_fingerprint", scope.environment_fingerprint, env.environment_fingerprint);
	push("domain", scope.domain, env.domain);
	push("permissions", scope.permissions, env.permissions);
	push("task_types", scope.task_types, manifest.task_types);
	return checks;
}

export function route({ experiences, manifest, fixtureRoot }) {
	const candidates = [];
	const reasons = [];

	for (const experience of experiences) {
		const checks = [];
		checks.push({ name: "status_active", ok: experience.status === "active", expected: "active", actual: experience.status });
		const scopeChecks = scopeMatches(experience, manifest);
		checks.push(...scopeChecks);
		checks.push({
			name: "scope_mode_live",
			ok: experience.scope?.mode === "live",
			expected: "live",
			actual: experience.scope?.mode ?? null,
		});

		// A forged or rewritten active rule must not be able to match on empty
		// conditions: `every` over [] is true, so require non-empty verified
		// when/expect and an independently verified live source.
		const when = Array.isArray(experience.when) ? experience.when : null;
		const expect = Array.isArray(experience.expect) ? experience.expect : null;
		checks.push({ name: "when_nonempty", ok: Boolean(when && when.length > 0), expected: "non-empty when", actual: when ? when.length : null });
		checks.push({ name: "expect_nonempty", ok: Boolean(expect && expect.length > 0), expected: "non-empty expect", actual: expect ? expect.length : null });
		const whenVerified = Boolean(when && when.length > 0 && when.every((predicate) => Array.isArray(predicate.verified_by) && predicate.verified_by.length > 0));
		checks.push({
			name: "when_verified",
			ok: whenVerified,
			expected: "every when predicate carries verified_by",
			actual: when ? when.map((predicate) => (Array.isArray(predicate.verified_by) ? predicate.verified_by.length : 0)) : null,
		});

		const provenance = experience.provenance || {};
		const sourceKind = Array.isArray(provenance.source_kind) ? provenance.source_kind : null;
		const successIds = Array.isArray(experience.support?.success_outcome_ids) ? experience.support.success_outcome_ids : [];
		checks.push({ name: "source_live", ok: Boolean(sourceKind && sourceKind.includes("live")), expected: ["live"], actual: sourceKind });
		checks.push({ name: "source_compiler", ok: provenance.compiled_by === "aegis-fixture-compiler", expected: "aegis-fixture-compiler", actual: provenance.compiled_by ?? null });
		checks.push({ name: "independent_support", ok: successIds.length >= 2, expected: ">=2 success outcome ids", actual: successIds.length });

		const actionRef = experience.do?.action_ref;
		const action = actionRef ? getAction(actionRef) : null;
		const allowed = Array.isArray(manifest.authorization?.allowed_actions) ? manifest.authorization.allowed_actions : [];
		checks.push({
			name: "action_registered",
			ok: Boolean(action),
			expected: actionRef || null,
			actual: action ? action.id : null,
		});
		checks.push({
			name: "action_authorized",
			ok: action ? allowed.includes(action.id) : false,
			expected: allowed,
			actual: action ? action.id : null,
		});
		checks.push({
			name: "action_spec_digest_matches",
			ok: Boolean(action && experience.do?.action_spec_digest === actionSpecDigest(action)),
			expected: action ? actionSpecDigest(action) : null,
			actual: experience.do?.action_spec_digest ?? null,
		});
		const manifestTools = Array.isArray(manifest.action?.tool_names) ? manifest.action.tool_names : [];
		checks.push({
			name: "action_tool_matches",
			ok: Boolean(action && experience.do?.tool === action.tool && manifestTools.includes(action.tool)),
			expected: action ? action.tool : null,
			actual: experience.do?.tool ?? null,
		});
		checks.push({
			name: "action_operation_matches",
			ok: Boolean(action && experience.do?.operation === action.operation && manifest.action?.operation === action.operation),
			expected: manifest.action?.operation ?? null,
			actual: experience.do?.operation ?? null,
		});
		checks.push({
			name: "action_risk_matches",
			ok: Boolean(action && experience.do?.risk_class === action.risk_class),
			expected: action ? action.risk_class : null,
			actual: experience.do?.risk_class ?? null,
		});
		const template = experience.do?.arguments_template || null;
		const templateKeys = template ? Object.keys(template) : [];
		const parameterKeys = action ? Object.keys(action.parameters) : [];
		const templateShapeOk = Boolean(action) && templateKeys.length === parameterKeys.length && templateKeys.every((key) => parameterKeys.includes(key));
		checks.push({
			name: "arguments_template_shape",
			ok: templateShapeOk,
			expected: parameterKeys,
			actual: templateKeys,
		});
		checks.push({
			name: "target_path_matches",
			ok: template?.path === manifest.action?.target_path,
			expected: manifest.action?.target_path ?? null,
			actual: template?.path ?? null,
		});

		// Current verified preconditions. Read the real file through the boundary.
		let preState = null;
		let preStateError = null;
		try {
			const targetPath = resolveInside(fixtureRoot, template?.path, { mustExist: true });
			preState = readJson(targetPath);
		} catch (error) {
			preStateError = error instanceof Error ? error.message : String(error);
		}
		const preconditionsVerified = preState !== null && Boolean(when && when.length > 0) && evaluatePredicates(preState, when);
		checks.push({
			name: "current_preconditions_verified",
			ok: preconditionsVerified,
			expected: (when || []).map((predicate) => `${predicate.path} ${predicate.op} ${JSON.stringify(predicate.value)}`),
			actual: preState ? (when || []).map((predicate) => getPath(preState, predicate.path)) : null,
			...(preStateError ? { reason: preStateError } : {}),
		});

		const ok = checks.every((check) => check.ok);
		const failed = checks.filter((check) => !check.ok);
		candidates.push({ experience: experience.experience_id, ok, checks });
		if (!ok) {
			reasons.push(`${experience.experience_id}: ${failed.map((check) => check.name).join(", ")}`);
		}
	}

	const hits = candidates.filter((candidate) => candidate.ok);
	if (hits.length > 1) {
		const ids = hits.map((hit) => hit.experience.experience_id).join(", ");
		reasons.push(`conflict: multiple active experiences match: ${ids}`);
		return {
			route: "refuse",
			routerDecision: "conflict",
			experience: null,
			reason: `multiple matching active experiences: ${ids}`,
			checks: candidates.flatMap((candidate) => candidate.checks),
		};
	}
	if (hits.length === 0) {
		return {
			route: "deliberate",
			routerDecision: "no_match",
			experience: null,
			reason: reasons.join("; ") || "no active experience matched",
			checks: candidates.flatMap((candidate) => candidate.checks),
		};
	}

	const winner = experiences.find((experience) => experience.experience_id === hits[0].experience);
	const decision = {
		route: "direct",
		routerDecision: "direct",
		experience: winner,
		reason: "active experience scope and verified preconditions match",
		checks: hits[0].checks,
		arguments: { ...winner.do.arguments_template },
		actionId: winner.do.action_ref,
		experienceDigest: digest(winner),
	};
	return decision;
}
