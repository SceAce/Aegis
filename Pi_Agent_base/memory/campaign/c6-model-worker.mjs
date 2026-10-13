// Aegis C6-B — model-driven Worker.
//
// The current task's action is decided by the SDK model's STRUCTURED tool
// decision, not a hardcoded plan. This Worker drives the bound SDK session for
// one task and lets the model's `aegis_observe`/`aegis_execute` calls perform
// the effects through the EXISTING Observer runtime + Action Broker (durable
// intent, registered contract, independent verification).
//
// It is a C1-shaped worker (`run({task}) -> {ok, outcome_ref}`) so it drops into
// the unchanged Scheduler/Host. It NEVER parses model prose, accepts an
// executable/argv/authorization from the model, or treats a tool exit code as a
// task verdict. The independent Host Oracle decides the criterion by reading the
// real post-state.
//
// Budget: every provider request and every tool call is admitted BEFORE it
// happens through the injected tool ledger. The request's total input estimate
// includes the ROM, tool definitions, RAM section and the output reserve.

import * as nodeFs from "node:fs";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";

import { digest } from "../fixture/contracts.mjs";

export const MODEL_WORKER_VERSION = "1.0.0";

/**
 * A read-only, grant-bounded observation tool. It lets the model INSPECT the real
 * current target before deciding an action, so a single hard-coded decision is
 * not mistaken for the observe -> decide -> verify loop. It performs NO effect:
 * it only reads a file inside the authorized workspace root (the same target the
 * Task grant names). A path outside the root is refused, never read.
 *
 * @param {{ sdk: any, type?: any, workspaceRoot: string, allowedTargets?: string[] }} args
 */
export function createObservationTool({ sdk, type, workspaceRoot, allowedTargets = [] } = /** @type {any} */ ({})) {
	const Type = type ?? sdk.Type;
	if (!Type) throw new Error("createObservationTool requires a Type schema builder");
	const { resolve, relative, isAbsolute } = nodePath;
	const { readFileSync, existsSync } = nodeFs;
	return sdk.defineTool({
		name: "aegis_observe_workspace",
		label: "Aegis: read a file in the authorized workspace",
		description:
			"Read the real content of a file INSIDE the authorized task workspace (read-only; no effect). Use it to inspect the current target before proposing a registered action.",
		promptSnippet: "Read a workspace file to inspect the current target state (read-only)",
		parameters: Type.Object({
			path: Type.String({ description: "Workspace-relative path to read" }),
		}),
		async execute(_toolCallId, params) {
			const requested = typeof params?.path === "string" ? params.path : "";
			const absolute = resolve(workspaceRoot, requested);
			const rel = relative(workspaceRoot, absolute);
			if (!requested || isAbsolute(requested) || rel.startsWith("..")) {
				return {
					content: [{ type: "text", text: `Aegis refused to read outside the authorized workspace: ${requested}` }],
					details: { ok: false, reason: "outside_workspace" },
				};
			}
			if (allowedTargets.length > 0 && !allowedTargets.some((target) => resolve(workspaceRoot, target) === absolute)) {
				return {
					content: [{ type: "text", text: `Aegis refused to read a path outside the Task grant: ${requested}` }],
					details: { ok: false, reason: "outside_grant" },
				};
			}
			if (!existsSync(absolute)) {
				return {
					content: [{ type: "text", text: `no such file: ${requested}` }],
					details: { ok: false, reason: "missing" },
				};
			}
			let text;
			try {
				text = readFileSync(absolute, "utf8");
			} catch (error) {
				return {
					content: [{ type: "text", text: `unreadable: ${requested}` }],
					details: { ok: false, reason: String(error) },
				};
			}
			return {
				content: [{ type: "text", text: `contents of ${requested}:\n${text.slice(0, 4000)}` }],
				details: { ok: true, path: requested, chars: text.length },
			};
		},
	});
}

/**
 * Turn captured model decisions into a Broker `ActionPlan` for one task. Only
 * registered action_refs are accepted; the Broker re-validates arguments,
 * version/digest and grant again at the execution boundary. An unregistered
 * action_ref is passed through (the Broker will reject it), so the failure is
 * recorded honestly rather than silently dropped.
 *
 * @param {{ decisionsByTask: Map<string, any[]>, evidenceRefFor?: (task: any, step: any) => string }} args
 * @returns {(task: any) => ({task_id: string, steps: any[]}|null)}
 */
export function createModelPlan({ decisionsByTask, evidenceRefFor = null }) {
	return function planFor(task) {
		const decisions = decisionsByTask.get(task?.task_id) ?? [];
		if (decisions.length === 0) return null;
		const stages = Array.isArray(task?.stages) ? task.stages : [];
		const steps = decisions.map((decision, index) => ({
			step_id: `${task.task_id}:model:${index}`,
			stage_id: stages[index]?.stage_id ?? stages[0]?.stage_id ?? null,
			action_ref: decision.action_ref,
			arguments: decision.arguments ?? {},
			criterion_id: decision.criterion_id ?? stages[index]?.criteria?.[0] ?? stages[0]?.criteria?.[0] ?? null,
			evidence_ref: typeof evidenceRefFor === "function" ? evidenceRefFor(task, decision) : `artifact:${task.task_id}`,
		}));
		return { task_id: task.task_id, steps };
	};
}

/**
 * A structured, data-only tool the model uses to STATE how it wants to act on the
 * current task. It performs NO effect: it records the decision so the Host's
 * Broker Worker can admit and execute it through the ONE Broker path. The model
 * can never supply an executable, argv, authorization, or a verdict.
 *
 * @param {{ sdk: any, buffer: any, type?: any }} args
 */
export function createDecisionCaptureTool({ sdk, buffer, type, admitTool = null, remainingRequests = null }) {
	const Type = type ?? sdk.Type;
	if (!Type) throw new Error("createDecisionCaptureTool requires a Type schema builder");
	return sdk.defineTool({
		name: "aegis_task_decision",
		label: "Aegis: propose a task action decision",
		description:
			"State how to act on the CURRENT task. Provide one or more registered action_refs with DATA-ONLY arguments. This records a decision; it does NOT execute. The Aegis broker admits and executes it, and an independent oracle judges the result.",
		promptSnippet: "Propose a registered action decision for the current task (data-only; never executed here)",
		parameters: Type.Object({
			actions: Type.Array(
				Type.Object({
					action_ref: Type.String({ description: "A registered action id from the catalog" }),
					arguments: Type.Optional(
						Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
					),
					criterion_id: Type.Optional(Type.String()),
				}),
			),
			propose_task: Type.Optional(
				Type.Object(
					{
						proposed_task_id: Type.String(),
						parent_task_id: Type.String(),
						task_type: Type.String({ description: "A registered task type the Campaign policy allows" }),
						target_ref: Type.String(),
						goal: Type.Object({
							description: Type.String(),
							success_criteria: Type.Array(Type.String()),
						}),
						required_capabilities: Type.Array(Type.String()),
						expected_evidence: Type.Array(Type.String()),
						stop_condition: Type.String(),
						priority: Type.Number(),
						budget_reservation: Type.Object({
							wall_time_ms: Type.Number(),
							model_requests: Type.Number(),
							tool_calls: Type.Number(),
						}),
					},
					{ description: "Optional bounded dynamic task proposal (data only; never a grant)" },
				),
			),
		}),
		async execute(_toolCallId, params) {
			const actions = Array.isArray(params?.actions) ? params.actions : [];
			let admitted = 0;
			let refused = 0;
			for (const action of actions) {
				if (!action || typeof action.action_ref !== "string" || action.action_ref.length === 0) continue;
				// X2: each Broker action in a batch decision consumes the task's tool
				// allocation. An action beyond the allocation is refused, never executed.
				if (typeof admitTool === "function") {
					const permit = admitTool({ tool_name: action.action_ref });
					if (permit?.ok !== true) {
						refused += 1;
						continue;
					}
				}
				buffer.push({
					action_ref: action.action_ref,
					arguments: action.arguments && typeof action.arguments === "object" ? action.arguments : {},
					criterion_id: typeof action.criterion_id === "string" ? action.criterion_id : null,
				});
				admitted += 1;
			}
			if (params?.propose_task && typeof params.propose_task === "object" && typeof buffer.pushTask === "function") {
				buffer.pushTask(params.propose_task);
			}
			// X2: when the task's request allocation cannot fund the SDK's automatic
			// follow-up, terminate so NO further provider request is sent for this task.
			const noFollowUp = typeof remainingRequests === "function" && remainingRequests() < 1;
			return {
				content: [
					{
						type: "text",
						text: `Aegis recorded ${admitted} task decision(s)${refused ? ` (${refused} refused by the task tool allocation)` : ""} for broker admission.`,
					},
				],
				details: { recorded: admitted, refused },
				...(noFollowUp ? { terminate: true } : {}),
			};
		},
	});
}

/**
 * @param {{
 *   session: () => any,
 *   ledger: any,
 *   romPath?: string|null,
 *   context: { max_total_input_chars: number, output_reserve_chars: number, strategy: string },
 *   taskId: string,
 *   goal: string,
 *   actionCatalog?: object|null,
 *   getActionCatalog?: (() => any)|null,
 *   ramProvider?: () => string,
 *   historyCharsProvider?: () => number,
 *   onEvent?: (record: object) => void,
 *   decisionBuffer?: any,
 *   router?: any,
 *   onEvent?: (record: object) => void,
 *   ledgerFactory?: ((task: any) => any)|null,
 *   onRequestCommitted?: ((record: object) => void)|null,
 *   setTaskBinding?: ((task: any) => void)|null,
 *   contextWindowChars?: number|null,
 *   remainingRequestsForTask?: (() => number)|null,
 * }} args
 */
export function createModelWorker(
	{
		session,
		ledger,
		romPath = null,
		context,
		taskId,
		goal,
		actionCatalog = null,
		getActionCatalog = null,
		ramProvider = () => "",
		historyCharsProvider = () => 0,
		onEvent = null,
		decisionBuffer = null,
		router = null,
		ledgerFactory = null,
		onRequestCommitted = null,
		setTaskBinding = null,
		contextWindowChars = null,
		remainingRequestsForTask = null,
	} = /** @type {any} */ ({}),
) {
	if (typeof session !== "function") throw new Error("createModelWorker requires a session() accessor");
	if (!ledger) throw new Error("createModelWorker requires a tool ledger");

	let rom = "";
	if (romPath) {
		try {
			rom = readFileSync(romPath, "utf8");
		} catch {
			rom = "";
		}
	}

	/** The full prompt the model receives for this task (data-only fields). */
	function buildPrompt(task = null) {
		const catalog = typeof getActionCatalog === "function" ? getActionCatalog() : actionCatalog;
		const catalogLines = [];
		if (catalog && Array.isArray(catalog.actions)) {
			for (const action of catalog.actions) {
				const id = action.id ?? action.action_ref ?? "?";
				const params = action.parameters && typeof action.parameters === "object" ? Object.keys(action.parameters) : [];
				catalogLines.push(
					`- ${id} (${action.kind ?? "action"})` +
						(params.length ? ` parameters: ${params.join(", ")}` : " parameters: (none)"),
				);
				for (const [name, spec] of Object.entries(action.parameters ?? {})) {
					catalogLines.push(`    - ${name}: ${spec?.type ?? "any"}${spec?.required ? " (required)" : ""}`);
				}
			}
		}
		const effectiveTaskId = task?.task_id ?? taskId;
		const effectiveGoal = task?.goal?.description ?? task?.goal?.goal_id ?? goal;
		const target = task?.target_ref ?? task?.definition?.target_ref ?? null;
		const criteria = (task?.stages ?? []).flatMap((stage) => stage.criteria ?? []);
		const lines = [
			`TASK ${effectiveTaskId}`,
			`GOAL: ${effectiveGoal}`,
			target ? `TARGET: ${target}` : "TARGET: (none declared)",
			criteria.length ? `ACCEPTANCE: ${criteria.join(" ; ")}` : "ACCEPTANCE: (none declared)",
			catalogLines.length ? `REGISTERED ACTIONS:\n${catalogLines.join("\n")}` : "REGISTERED ACTIONS: (see catalog)",
			"Use aegis_observe_workspace to inspect the target file first, then state your decision with aegis_task_decision (data-only arguments). Do not write files directly.",
		];
		return lines.join("\n");
	}

	/**
	 * Estimate the TOTAL input for one provider request: ROM + tool definitions +
	 * RAM + history + output reserve. It is an ESTIMATE (characters), labelled as
	 * such; the ledger treats `input_chars` as estimated.
	 */
	function estimateInputChars({ prompt, toolChars, outputReserveChars }) {
		return rom.length + toolChars + ramProvider().length + historyCharsProvider() + prompt.length + outputReserveChars;
	}

	async function run({ task }) {
		const activeSession = session();
		if (!activeSession) {
			return { ok: false, failure_mode: "no_session", detail: "no bound SDK session for the model worker" };
		}
		const effectiveTaskId = task?.task_id ?? taskId;
		// Bind the current Task/Episode for the Observer (X5): the trusted Host task
		// decides the SDK episode, not a stale env label.
		if (typeof setTaskBinding === "function") setTaskBinding(task);

		// A PER-TASK ledger enforces the task's own allocation; the cumulative
		// campaign ledger is mirrored on each commit for cross-restart accounting.
		const activeLedger = typeof ledgerFactory === "function" ? ledgerFactory(task) : ledger;

		// ROUTE BEFORE THE MODEL. `direct` executes the confirmed action with ZERO
		// provider requests; `habit` still needs the model to fill only the reported
		// missing parameters. Anything else plans deliberately.
		if (router) {
			const decision = await router({ task, session: activeSession });
			if (onEvent)
				onEvent({
					kind: "task.routed",
					task_id: effectiveTaskId,
					route: decision?.route ?? "unknown",
					planning_requests: decision?.planning_requests ?? 1,
				});
			if (decision?.route === "direct" && Array.isArray(decision.actions) && decision.actions.length > 0) {
				for (const action of decision.actions) if (decisionBuffer) decisionBuffer.push(action);
				return {
					ok: true,
					outcome_ref: `artifact:${effectiveTaskId}`,
					route: "direct",
					planning_requests: 0,
					decisions: decision.actions,
				};
			}
		}
		const prompt = buildPrompt(task);
		// X3: the TOTAL input for ONE request = ROM + tool definitions (schema) + RAM +
		// history + output reserve. This is the per-request WINDOW, compared against
		// `max_total_input_chars` -- never multiplied by the request budget.
		let toolChars = 0;
		try {
			const catalog = typeof getActionCatalog === "function" ? getActionCatalog() : actionCatalog;
			toolChars = JSON.stringify(catalog ?? {}).length;
			const names = activeSession.getActiveToolNames?.() ?? [];
			toolChars += names.reduce((sum, name) => sum + name.length + 40, 0);
		} catch {
			toolChars = 0;
		}
		const inputChars = estimateInputChars({
			prompt,
			toolChars,
			outputReserveChars: context?.output_reserve_chars ?? 0,
		});
		const window = typeof contextWindowChars === "number" ? contextWindowChars : (context?.max_total_input_chars ?? 0);
		if (window > 0 && inputChars > window) {
			if (onEvent)
				onEvent({
					kind: "task.blocked",
					task_id: effectiveTaskId,
					reason: `input estimate ${inputChars} exceeds the per-request window ${window}`,
				});
			return {
				ok: false,
				failure_mode: "context_window_exceeded",
				detail: `the required context (${inputChars} chars) cannot fit the per-request window (${window} chars)`,
				input_chars_estimated: inputChars,
			};
		}

		// PRE-CALL admission for the first provider request. If the task/campaign
		// allocation cannot fund it, no request is sent.
		const admission = activeLedger.admitRequest({ inputChars, kind: "task_plan" });
		if (!admission.ok) {
			if (onEvent) onEvent({ kind: "task.blocked", task_id: effectiveTaskId, reason: admission.reason });
			return {
				ok: false,
				failure_mode: "budget_exhausted",
				detail: admission.reason,
				input_chars_estimated: inputChars,
			};
		}

		// Count EVERY provider request the SDK issues for this task (including the
		// automatic tool loop / continuation) by committing one request per
		// assistant message. The first reservation is consumed by the first message.
		let usage = null;
		let assistantText = "";
		let providerRequests = 0;
		let pendingReservation = admission.reservation_id;
		const unsubscribe = activeSession.subscribe((event) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				providerRequests += 1;
				usage = event.message.usage ?? usage;
				const content = Array.isArray(event.message.content) ? event.message.content : [];
				assistantText = content
					.filter((part) => part?.type === "text")
					.map((part) => part.text)
					.join("\n");
				const committedRecord = activeLedger.commitRequest({
					reservation_id: pendingReservation,
					usage,
					inputChars,
				});
				// Mirror the SAME usage into the cumulative campaign ledger once.
				if (ledger !== activeLedger) ledger.commitRequest({ usage, inputChars });
				if (typeof onRequestCommitted === "function") onRequestCommitted(committedRecord);
				// Reserve the NEXT request optimistically; the decision tool consults
				// `remaining()` and terminates the turn if it cannot be funded.
				pendingReservation = null;
			}
		});
		let stopReason = "completed";
		try {
			await activeSession.prompt(prompt);
		} catch (error) {
			stopReason = "transport_failure";
			if (pendingReservation) activeLedger.commitRequest({ reservation_id: pendingReservation, usage, inputChars });
			if (onEvent) onEvent({ kind: "task.error", task_id: effectiveTaskId, error: String(error) });
			return { ok: false, failure_mode: "transport_failure", detail: String(error) };
		} finally {
			try {
				unsubscribe();
			} catch {
				// ignore
			}
		}
		const decisions = decisionBuffer ? decisionBuffer.list() : [];
		if (onEvent) {
			onEvent({
				kind: "task.planned",
				task_id: effectiveTaskId,
				provider_requests: providerRequests,
				decisions: decisions.length,
				assistant_chars: assistantText.length,
				usage,
			});
		}
		if (decisions.length === 0) {
			return {
				ok: false,
				failure_mode: "no_model_decision",
				detail: "the model did not submit a structured task decision",
				stop_reason: stopReason,
			};
		}
		// The Worker returns the TRANSPORT fact only. The Oracle judges the effect.
		// The evidence ref is the task sentinel; the Oracle reads the real artifact.
		return {
			ok: true,
			outcome_ref: `artifact:${effectiveTaskId}`,
			assistant_digest: digest(assistantText),
			provider_requests: providerRequests,
			stop_reason: stopReason,
			decisions,
		};
	}

	return {
		version: MODEL_WORKER_VERSION,
		buildPrompt,
		estimateInputChars,
		run,
	};
}
