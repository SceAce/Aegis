// Registered, reviewed action primitives.
//
// An Experience never contains executable text. It references an action id from
// this registry plus a data-only argument template. The Host binds arguments and
// calls the implementation below. This is the only execution path for the
// fixture slice.

import { digest, evaluatePredicates, readJson, resolveInside, writeJsonAtomic } from "./contracts.mjs";

const fixtureUnlock = {
	id: "fixture.unlock",
	tool: "fixture",
	operation: "unlock",
	description: "Set `locked` to false in a JSON fixture while preserving `target` and `version`.",
	risk_class: "low",
	parameters: {
		path: {
			type: "string",
			required: true,
			description: "JSON fixture path, relative to the per-task fixture root.",
		},
	},
	preconditions: [{ path: "locked", op: "eq", value: true }],
	postconditions: [
		{ path: "target", op: "eq", value: "door" },
		{ path: "locked", op: "eq", value: false },
		{ path: "version", op: "eq", value: 1 },
	],
	execute({ fixtureRoot, arguments: args }) {
		const started = Date.now();
		const elapsed = () => Date.now() - started;
		let targetPath;
		try {
			targetPath = resolveInside(fixtureRoot, args.path, { mustExist: true });
		} catch (error) {
			return {
				tool_ok: false,
				exit_code: 2,
				timed_out: false,
				duration_ms: elapsed(),
				failure_mode: "action_rejected",
				error: error instanceof Error ? error.message : String(error),
			};
		}
		let state;
		try {
			state = readJson(targetPath);
		} catch (error) {
			return {
				tool_ok: false,
				exit_code: 4,
				timed_out: false,
				duration_ms: elapsed(),
				failure_mode: "tool_error",
				error: error instanceof Error ? error.message : String(error),
			};
		}
		if (!evaluatePredicates(state, fixtureUnlock.preconditions)) {
			return { tool_ok: false, exit_code: 3, timed_out: false, duration_ms: elapsed(), failure_mode: "precondition_unmet" };
		}
		const nextState = { ...state, locked: false };
		try {
			// Re-validate the write target against the fixture root immediately
			// before mutating, so the boundary governs the write itself.
			const writePath = resolveInside(fixtureRoot, args.path, { mustExist: true });
			writeJsonAtomic(writePath, nextState);
		} catch (error) {
			return {
				tool_ok: false,
				exit_code: 4,
				timed_out: false,
				duration_ms: elapsed(),
				failure_mode: "tool_error",
				error: error instanceof Error ? error.message : String(error),
			};
		}
		return { tool_ok: true, exit_code: 0, timed_out: false, duration_ms: elapsed() };
	},
};

export const ACTIONS = {
	[fixtureUnlock.id]: fixtureUnlock,
};

export function getAction(actionId) {
	return ACTIONS[actionId] || null;
}

export function actionSpecDigest(action) {
	return digest({
		id: action.id,
		tool: action.tool,
		operation: action.operation,
		parameters: action.parameters,
		preconditions: action.preconditions,
		postconditions: action.postconditions,
	});
}

export function validateActionArguments(action, args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return { ok: false, reason: "arguments must be an object" };
	}
	for (const [name, spec] of Object.entries(action.parameters)) {
		if (spec.required && (args[name] === undefined || args[name] === null || args[name] === "")) {
			return { ok: false, reason: `missing required argument: ${name}` };
		}
		if (args[name] !== undefined && spec.type === "string" && typeof args[name] !== "string") {
			return { ok: false, reason: `argument ${name} must be a string` };
		}
	}
	const extra = Object.keys(args).filter((name) => !Object.hasOwn(action.parameters, name));
	if (extra.length > 0) return { ok: false, reason: `unexpected arguments: ${extra.join(", ")}` };
	return { ok: true };
}

// Execute a registered action. The Experience supplies only data; the code that
// runs is always a reviewed registry implementation.
export function executeAction(actionId, { fixtureRoot, arguments: args }) {
	const action = getAction(actionId);
	if (!action) {
		return { tool_ok: false, exit_code: 2, timed_out: false, duration_ms: 0, failure_mode: "action_rejected", error: `unknown action: ${actionId}` };
	}
	const validation = validateActionArguments(action, args);
	if (!validation.ok) {
		return { tool_ok: false, exit_code: 2, timed_out: false, duration_ms: 0, failure_mode: "action_rejected", error: validation.reason };
	}
	return action.execute({ fixtureRoot, arguments: args });
}
