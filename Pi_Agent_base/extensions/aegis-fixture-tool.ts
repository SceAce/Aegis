// Aegis-owned, thin Pi integration for the fixture direct slice.
//
// This extension is the ONLY bridge between Pi's tool loop and the Aegis
// fixture Host/Oracle. It is deliberately constrained:
//
//   * It registers exactly one model-callable tool, `aegis_fixture_unlock`,
//     with exactly one parameter, `path`, whose only accepted value is the
//     fixture target `door.json`.
//   * A `tool_call` guard fails closed: any other tool, any extra parameter,
//     any other path, and any traversal attempt is blocked before execution.
//   * The tool body never executes free text. It routes the call through the
//     existing Aegis Host (`runFixtureTask`), which executes the registered
//     `fixture.unlock` primitive through the action broker, and then through the
//     independent Oracle (`judgeRun`), which re-hashes the real fixture state.
//   * Every Pi-side decision is appended to an Aegis audit log that links the
//     Pi tool-call id to the Aegis experiment directory and the Oracle status.
//
// Configuration is read from the environment at call time so a test can point
// the same extension at an isolated temp workspace:
//
//   AEGIS_FIXTURE_WORK_DIR        base dir for per-call experiment dirs
//   AEGIS_FIXTURE_EXPERIENCE_DIR  dir containing a compiled `experiences.json`
//                                 (optional; when present the Router may hit an
//                                 active Experience and the Host runs direct)
//   AEGIS_FIXTURE_AUDIT_LOG       JSONL audit trail (defaults under the work dir)
//   AEGIS_FIXTURE_PLAN_ONLY       when "1", record the proposed call and return
//                                 its data-only arguments without executing, so
//                                 the Aegis orchestrator can run Host+Oracle once
//
// The nested Pi repository is not modified.

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readJson } from "../memory/fixture/contracts.mjs";
import { makeTask, runFixtureTask } from "../memory/fixture/host.mjs";
import { judgeRun } from "../memory/fixture/oracle.mjs";
import { route } from "../memory/fixture/router.mjs";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_NAME = "aegis_fixture_unlock";
const ALLOWED_PATH = "door.json";
const ALLOWED_PARAMETER = "path";
const AUDIT_SCHEMA_VERSION = "1.0";

function workDir() {
	return process.env.AEGIS_FIXTURE_WORK_DIR || join(BASE_DIR, "runtime", "fixture-pi");
}

function auditLogPath() {
	return process.env.AEGIS_FIXTURE_AUDIT_LOG || join(workDir(), "pi-audit.jsonl");
}

// Append one audit row and confirm it reached disk before returning. The audit
// trail must never silently drop a Pi-side decision.
function appendAudit(row) {
	const path = auditLogPath();
	mkdirSync(dirname(path), { recursive: true });
	const line = JSON.stringify({ schema_version: AUDIT_SCHEMA_VERSION, recorded_at: new Date().toISOString(), ...row });
	const fd = openSync(path, "a");
	try {
		writeSync(fd, `${line}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

// The only accepted call shape. Returns a human-readable violation or null.
function scopeViolation(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return "arguments must be an object with a single `path` field";
	}
	const keys = Object.keys(input).sort();
	if (keys.length !== 1 || keys[0] !== ALLOWED_PARAMETER) {
		return `only the single argument \`${ALLOWED_PARAMETER}\` is allowed (received: ${keys.length ? keys.join(", ") : "none"})`;
	}
	const value = input[ALLOWED_PARAMETER];
	if (typeof value !== "string" || value.length === 0) {
		return `\`${ALLOWED_PARAMETER}\` must be a non-empty string`;
	}
	if (value !== ALLOWED_PATH) {
		return `path "${value}" is outside the allowed fixture scope ("${ALLOWED_PATH}")`;
	}
	return null;
}

// Load a compiled Experience set if one has been configured and written. A
// missing/invalid file simply means "no experience": the Host stays deliberate.
function loadExperiences() {
	const dir = process.env.AEGIS_FIXTURE_EXPERIENCE_DIR;
	if (!dir) return null;
	const file = join(dir, "experiences.json");
	if (!existsSync(file)) return null;
	try {
		const experiences = readJson(file);
		return Array.isArray(experiences) ? experiences : null;
	} catch {
		return null;
	}
}

function makeRouter(experiences) {
	if (!experiences) return null;
	return ({ manifest, fixtureRoot }) => route({ experiences, manifest, fixtureRoot });
}

const fixtureUnlockTool = defineTool({
	name: TOOL_NAME,
	label: "Aegis Fixture Unlock",
	description:
		'Unlock the single Aegis JSON fixture target. The only accepted argument is path and the only accepted value is "door.json". Execution is routed through the Aegis Host and verified by the independent Oracle.',
	parameters: Type.Object(
		{
			path: Type.String({
				description: `Fixture path relative to the per-task fixture root. Must be exactly "${ALLOWED_PATH}".`,
			}),
		},
		{ additionalProperties: false },
	),

	async execute(toolCallId, params) {
		const violation = scopeViolation(params);
		if (violation) {
			appendAudit({
				audit_event: "pi_tool_result",
				tool_call_id: toolCallId,
				tool_name: TOOL_NAME,
				ok: false,
				reason: violation,
			});
			return { isError: true, content: [{ type: "text", text: violation }], details: { ok: false, reason: violation } };
		}

		// Plan-only mode is used by the Aegis orchestrator on the no-Experience
		// branch: Pi proposes the constrained tool call, then the orchestrator runs
		// the same Host + Oracle. This keeps the single constrained tool identity
		// while avoiding a second execution inside the Pi session.
		if (process.env.AEGIS_FIXTURE_PLAN_ONLY === "1") {
			appendAudit({
				audit_event: "pi_tool_planned",
				tool_call_id: toolCallId,
				tool_name: TOOL_NAME,
				input: params,
			});
			return {
				isError: false,
				content: [
					{
						type: "text",
						text: `Aegis fixture plan accepted: ${ALLOWED_PATH}. Execution is deferred to the Aegis Host.`,
					},
				],
				details: { ok: true, plan_only: true, action_ref: "fixture.unlock", arguments: { path: params.path } },
			};
		}

		const root = join(workDir(), `pi-call-${randomUUID()}`);
		try {
			const experiences = loadExperiences();
			const run = runFixtureTask({
				root,
				task: makeTask({ fixture_relative_path: ALLOWED_PATH }),
				actionId: "fixture.unlock",
				args: { path: params.path },
				router: makeRouter(experiences),
			});
			const judged = judgeRun(root);
			const routeKind = run.request.payload.route;
			const experienceId = run.request.payload.experience_id || null;
			appendAudit({
				audit_event: "pi_tool_result",
				tool_call_id: toolCallId,
				tool_name: TOOL_NAME,
				ok: judged.status === "success",
				experiment_dir: root,
				episode_id: run.episodeId,
				action_ref: run.action.id,
				route: routeKind,
				experience_id: experienceId,
				oracle_status: judged.status,
				oracle_failure_mode: judged.episodeOutcome?.failure_mode ?? null,
			});
			const text = [
				`Aegis fixture action ${run.action.id} (${run.action.tool}.${run.action.operation}) executed.`,
				`route=${routeKind}${experienceId ? ` experience=${experienceId}` : ""}`,
				`host transport ok=${run.transport.tool_ok === true}`,
				`oracle status=${judged.status}${judged.episodeOutcome?.failure_mode ? ` failure_mode=${judged.episodeOutcome.failure_mode}` : ""}`,
				`experiment=${root}`,
			].join("\n");
			return {
				isError: judged.status !== "success",
				content: [{ type: "text", text }],
				details: {
					ok: judged.status === "success",
					experiment_dir: root,
					episode_id: run.episodeId,
					action_ref: run.action.id,
					route: routeKind,
					experience_id: experienceId,
					oracle_status: judged.status,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			appendAudit({
				audit_event: "pi_tool_result",
				tool_call_id: toolCallId,
				tool_name: TOOL_NAME,
				ok: false,
				experiment_dir: root,
				error: message,
			});
			return {
				isError: true,
				content: [{ type: "text", text: `Aegis fixture action failed: ${message}` }],
				details: { ok: false, error: message },
			};
		}
	},
});

export default function aegisFixtureTool(pi: ExtensionAPI) {
	// Defense in depth: the session allowlist already restricts tools, but fail
	// closed on every tool call that is not the single Aegis fixture tool.
	pi.on("tool_call", async (event) => {
		if (event.toolName !== TOOL_NAME) {
			appendAudit({
				audit_event: "pi_tool_denied",
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				reason: "tool is not exposed by the Aegis fixture integration",
			});
			return {
				block: true,
				reason: `Aegis fixture session only exposes ${TOOL_NAME}; "${event.toolName}" is disabled.`,
			};
		}
		const violation = scopeViolation(event.input);
		if (violation) {
			appendAudit({
				audit_event: "pi_tool_denied",
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				input: event.input,
				reason: violation,
			});
			return { block: true, reason: `Aegis fixture scope denial: ${violation}` };
		}
		appendAudit({
			audit_event: "pi_tool_allowed",
			tool_call_id: event.toolCallId,
			tool_name: event.toolName,
			input: event.input,
		});
		return undefined;
	});

	pi.registerTool(fixtureUnlockTool);
}
