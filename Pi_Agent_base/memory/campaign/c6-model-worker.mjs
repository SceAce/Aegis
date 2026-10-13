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

import { readFileSync } from "node:fs";

import { digest } from "../fixture/contracts.mjs";

export const MODEL_WORKER_VERSION = "1.0.0";

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
 * @param {{ sdk: any, buffer: { push: (decision: any) => void, list: () => any[], reset: () => void } }} args
 */
export function createDecisionCaptureTool({ sdk, buffer, type }) {
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
		}),
		async execute(_toolCallId, params) {
			const actions = Array.isArray(params?.actions) ? params.actions : [];
			for (const action of actions) {
				if (!action || typeof action.action_ref !== "string" || action.action_ref.length === 0) continue;
				buffer.push({
					action_ref: action.action_ref,
					arguments: action.arguments && typeof action.arguments === "object" ? action.arguments : {},
					criterion_id: typeof action.criterion_id === "string" ? action.criterion_id : null,
				});
			}
			return {
				content: [{ type: "text", text: `Aegis recorded ${actions.length} task decision(s) for broker admission.` }],
				details: { recorded: actions.length },
			};
		},
	});
}

/**
 * @param {{
 *   session: () => any,
 *   ledger: ReturnType<import("./c6-tool-ledger.mjs").createToolLedger>,
 *   romPath?: string|null,
 *   context: { max_total_input_chars: number, output_reserve_chars: number, strategy: string },
 *   taskId: string,
 *   goal: string,
 *   actionCatalog: object|null,
 *   ramProvider?: () => string,
 *   historyCharsProvider?: () => number,
 *   maxTurnsPerTask?: number,
 *   onEvent?: (record: object) => void,
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
				catalogLines.push(`- ${action.id ?? action.action_ref ?? "?"} (${action.kind ?? "action"})`);
			}
		}
		const effectiveTaskId = task?.task_id ?? taskId;
		const effectiveGoal = task?.goal?.description ?? task?.goal?.goal_id ?? goal;
		return [
			`TASK ${effectiveTaskId}`,
			`GOAL: ${effectiveGoal}`,
			catalogLines.length ? `REGISTERED ACTIONS:\n${catalogLines.join("\n")}` : "REGISTERED ACTIONS: (see catalog)",
			"Use the registered aegis tools to inspect the workspace and perform the task. Do not write files directly.",
		].join("\n");
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
		const prompt = buildPrompt(task);
		// Tool definitions are part of the total input estimate; the bound session
		// reports its active tools.
		let toolChars = 0;
		try {
			const names = activeSession.getActiveToolNames?.() ?? [];
			toolChars = names.reduce((sum, name) => sum + name.length + 40, 0);
		} catch {
			toolChars = 0;
		}
		const inputChars = estimateInputChars({
			prompt,
			toolChars,
			outputReserveChars: context?.output_reserve_chars ?? 0,
		});

		// PRE-CALL budget gate: refuse BEFORE the request when the estimate would
		// exceed the configured total-input limit or the request budget.
		const admission = ledger.admitRequest({ inputChars, kind: "task_plan" });
		if (!admission.ok) {
			if (onEvent) onEvent({ kind: "task.blocked", task_id: effectiveTaskId, reason: admission.reason });
			return {
				ok: false,
				failure_mode: "budget_exhausted",
				detail: admission.reason,
				input_chars_estimated: inputChars,
			};
		}

		let usage = null;
		let assistantText = "";
		let toolCalls = 0;
		const unsubscribe = activeSession.subscribe((event) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				usage = event.message.usage ?? usage;
				const content = Array.isArray(event.message.content) ? event.message.content : [];
				assistantText = content
					.filter((part) => part?.type === "text")
					.map((part) => part.text)
					.join("\n");
			}
			if (event.type === "tool_execution_start") toolCalls += 1;
		});
		let stopReason = "completed";
		try {
			await activeSession.prompt(prompt);
		} catch (error) {
			stopReason = "transport_failure";
			ledger.commitRequest({ reservation_id: admission.reservation_id, usage, inputChars });
			if (onEvent) onEvent({ kind: "task.error", task_id: effectiveTaskId, error: String(error) });
			return { ok: false, failure_mode: "transport_failure", detail: String(error) };
		} finally {
			try {
				unsubscribe();
			} catch {
				// ignore
			}
		}
		const committed = ledger.commitRequest({ reservation_id: admission.reservation_id, usage, inputChars });
		const decisions = decisionBuffer ? decisionBuffer.list() : [];
		if (onEvent) {
			onEvent({
				kind: "task.planned",
				task_id: effectiveTaskId,
				tool_calls: toolCalls,
				decisions: decisions.length,
				assistant_chars: assistantText.length,
				usage: committed.usage,
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
			tool_calls: toolCalls,
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
