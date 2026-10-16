// Target authorization for batch B (auto / normal).
//
// Authorization answers ONE question: may this exact action run against this
// exact target? It never answers "did it work". A permit produced here is
// re-checked by the broker against the final arguments, and success is decided
// by the registered Verification/Oracle, never by the permit.
//
//   * normal mode: every side-effecting/unknown action is `pending_approval`
//     until an explicit human approval exists. With no UI to approve, it stays
//     pending forever; it is never silently promoted.
//   * auto mode: granted only inside a user-given workspace/target and only for
//     declared tools; network access requires an explicit `allow_network`.
//   * the cwd/workspace is NOT claimed to be a sandbox.

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { digest } from "../shared/contracts.mjs";
import { contractDigest } from "./action-contract.mjs";

export const MODES = ["normal", "auto"];
const WILDCARDS = new Set(["*", "any", "all", "unknown", "null", ""]);

function isWildcard(value) {
	if (value === null || value === undefined) return true;
	if (typeof value !== "string") return true;
	return WILDCARDS.has(value.trim().toLowerCase());
}

function insideRoot(root, candidate) {
	if (typeof root !== "string" || !root) return { ok: false, reason: "no workspace root configured" };
	if (typeof candidate !== "string" || !candidate) return { ok: false, reason: "no candidate path" };
	let rootReal;
	try {
		rootReal = existsSync(root) ? realpathSync(root) : resolve(root);
	} catch (error) {
		return { ok: false, reason: `workspace root is not accessible: ${error instanceof Error ? error.message : String(error)}` };
	}
	// Resolve the deepest EXISTING ancestor so a not-yet-created target can still
	// be checked for escape without trusting a lexical `..` only.
	let resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(rootReal, candidate);
	try {
		let probe = resolved;
		while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
		if (existsSync(probe)) {
			const realProbe = realpathSync(probe);
			resolved = resolve(realProbe, relative(probe, resolved));
		}
	} catch (error) {
		return { ok: false, reason: `cannot resolve target: ${error instanceof Error ? error.message : String(error)}` };
	}
	const rel = relative(rootReal, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false, reason: `target escapes the workspace root: ${candidate}` };
	return { ok: true, resolved };
}

export function createAuthorization({
	mode = "normal",
	workspaceRoot = null,
	target = null,
	allowedTools = [],
	allowNetwork = false,
	approved = false,
	approvalNote = null,
	budget = null,
} = {}) {
	if (!MODES.includes(mode)) throw new Error(`authorization mode must be one of ${MODES.join(", ")}`);
	return {
		schema_version: "1.0",
		mode,
		workspaceRoot,
		target,
		allowedTools: [...allowedTools],
		allowNetwork: allowNetwork === true,
		approved: approved === true,
		approvalNote,
		budget,
	};
}

function matchesTarget(authorization, request) {
	if (request.target_path) {
		const check = insideRoot(authorization.workspaceRoot, request.target_path);
		if (!check.ok) return check;
		if (authorization.target && /[\\/]/.test(authorization.target)) {
			const targetCheck = insideRoot(authorization.target, check.resolved);
			if (!targetCheck.ok) return targetCheck;
		}
		return { ok: true, resolved: check.resolved };
	}
	if (isWildcard(request.target) || isWildcard(authorization.target)) return { ok: false, reason: "target is missing or a wildcard" };
	if (request.target !== authorization.target) return { ok: false, reason: `request target ${request.target} does not match authorized target ${authorization.target}` };
	return { ok: true, resolved: null };
}

/**
 * Decide whether an action is authorized. Never returns a verification result.
 *
 * @param {object} authorization from createAuthorization
 * @param {object} request `{action_ref, tool, contract, arguments, target, target_path, network}`
 */
export function authorizeAction(authorization, request) {
	const reasons = [];
	const base = { ok: false, is_verification: false, mode: authorization?.mode ?? null };
	if (!authorization || !MODES.includes(authorization.mode)) return { ...base, status: "rejected", reasons: ["invalid authorization"] };
	if (!request || typeof request !== "object") return { ...base, status: "rejected", reasons: ["invalid request"] };

	if (!Array.isArray(authorization.allowedTools) || authorization.allowedTools.length === 0) reasons.push("no tools are authorized");
	else if (!request.tool || !authorization.allowedTools.includes(request.tool)) reasons.push(`tool ${String(request.tool)} is not authorized`);

	const targetCheck = matchesTarget(authorization, request);
	if (!targetCheck.ok) reasons.push(targetCheck.reason);

	if (request.network === true && authorization.allowNetwork !== true) reasons.push("network access is not authorized (no remote configuration)");

	if (reasons.length > 0) return { ...base, status: "rejected", reasons, target: targetCheck.resolved ?? null };

	if (authorization.mode === "normal" && authorization.approved !== true) {
		return {
			...base,
			status: "pending_approval",
			reasons: ["normal mode requires explicit human approval before this action runs"],
			target: targetCheck.resolved ?? null,
		};
	}

	const contract = request.contract ?? null;
	const permit = {
		ok: true,
		mode: authorization.mode,
		action_ref: contract?.id ?? request.action_ref ?? null,
		version: contract?.version ?? request.version ?? null,
		implementation_digest: contract?.implementation_digest ?? request.implementation_digest ?? null,
		arguments_digest: digest(request.arguments ?? {}),
		// Bind the FULL reviewed implementation: procedure + recognition + the
		// verification checker source. A reviewer changing any of them invalidates
		// an outstanding permit, not just the procedure.
		scope_digest: digest({ scope: contract?.scope ?? null, authorization: contract?.authorization ?? null }),
		target: targetCheck.resolved ?? request.target ?? null,
		network: request.network === true,
		expires_at: request.expires_at ?? null,
		granted_at: new Date().toISOString(),
	};
	if (contract) permit.contract_digest = contractDigest(contract);
	return {
		...base,
		ok: true,
		status: "authorized",
		reasons: ["action is authorized; authorization is NOT verification"],
		authorization_digest: digest({ mode: authorization.mode, target: authorization.target, tools: [...authorization.allowedTools].sort(), network: authorization.allowNetwork }),
		target: targetCheck.resolved ?? null,
		permit,
		workspace_is_sandbox: false,
	};
}

export function describeAuthorization(authorization) {
	return {
		mode: authorization.mode,
		workspace_root: authorization.workspaceRoot,
		target: authorization.target,
		allowed_tools: authorization.allowedTools,
		allow_network: authorization.allowNetwork,
		approved: authorization.approved,
		budget: authorization.budget,
		workspace_is_sandbox: false,
	};
}
