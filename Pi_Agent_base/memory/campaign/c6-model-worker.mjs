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

import { digest, resolveInside } from "../fixture/contracts.mjs";
import { classifyStopReason } from "./c6-request-lifecycle.mjs";

export const MODEL_WORKER_VERSION = "2.0.0";

/** A typed, distinguishable refusal from the provider-bound request gate. */
function budgetRefused(message, category, extra = null) {
	/** @type {Error & {aegis_budget_refused?: boolean, aegis_category?: string, aegis_detail?: object|null}} */
	const error = new Error(message);
	error.name = "AegisBudgetRefused";
	error.aegis_budget_refused = true;
	error.aegis_category = category;
	if (extra) error.aegis_detail = extra;
	return error;
}

/**
 * Count the characters of one message's content, regardless of the concrete
 * content shape the SDK produced (string, text/thinking/toolCall/result parts,
 * or an image placeholder). The estimate only has to be honest and monotonic;
 * it is never presented as an exact tokenizer.
 *
 * @param {any} content
 * @returns {number}
 */
function countContentChars(content) {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const part of content) {
		if (typeof part === "string") {
			total += part.length;
			continue;
		}
		if (!part || typeof part !== "object") continue;
		if (typeof part.text === "string") total += part.text.length;
		if (typeof part.thinking === "string") total += part.thinking.length;
		if (part.type === "toolCall") {
			total += String(part.name ?? "").length;
			try {
				total += JSON.stringify(part.arguments ?? {}).length;
			} catch {
				total += 0;
			}
		}
		if (typeof part.data === "string") total += part.data.length;
		if (part.type === "image" && typeof part.data !== "string") total += 0;
	}
	return total;
}

/**
 * Measure the ACTUAL provider input for ONE request from the normalized SDK
 * `llmContext` (the object the SDK passes to `streamFunction`).
 *
 * Honest, SDK-accurate coverage:
 *   * every message of `llmContext.messages` (system/user/assistant/toolResult),
 *     using the real content shapes (string or text/thinking/toolCall parts);
 *   * tool schema from `messages[*].toolsAdded` (where `normalizeContext` folds
 *     `Context.tools`) AND from a top-level `llmContext.tools` (some controlled
 *     callers pass it directly); name/description/parameters are all counted;
 *   * a small per-message structural overhead so the count is not an undercount;
 *   * the configured output reserve.
 *
 * `promptMetadata` may carry constraints NOT present in the transcript (e.g. an
 * explicit ROM section). Anything already inside `messages` is NOT counted twice.
 * Backend tokens/currency are never fabricated.
 *
 * @param {{
 *   llmContext?: any,
 *   promptMetadata?: {extraChars?: number, source?: string}|null,
 *   outputReserveChars?: number,
 * }} args
 * @returns {{chars: number, coverage: string[], source: string, details: object}}
 */
export function measureProviderInput({ llmContext = null, promptMetadata = null, outputReserveChars = 0 } = {}) {
	const messages = Array.isArray(llmContext?.messages) ? llmContext.messages : [];
	const coverage = [];
	let messageChars = 0;
	let toolsChars = 0;
	let messageCount = 0;
	/** @type {Set<any>} */
	const seenTools = new Set();
	function addTools(tools) {
		if (!Array.isArray(tools)) return;
		for (const tool of tools) {
			if (!tool || typeof tool !== "object" || seenTools.has(tool)) continue;
			seenTools.add(tool);
			try {
				toolsChars += JSON.stringify({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				}).length;
			} catch {
				toolsChars += String(tool.name ?? "").length + String(tool.description ?? "").length;
			}
		}
	}
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		messageCount += 1;
		// ~12 chars of role/JSON structural overhead per message.
		messageChars += countContentChars(message.content) + 12;
		if (Array.isArray(message.sections)) messageChars += JSON.stringify(message.sections).length;
		addTools(message.toolsAdded);
	}
	if (messageCount > 0) coverage.push("messages");
	// A top-level tools array is a controlled-caller convenience; the real SDK
	// folds tools into the leading system message's `toolsAdded`.
	addTools(llmContext?.tools);
	if (seenTools.size > 0) coverage.push("tools");
	const extra = Number.isFinite(promptMetadata?.extraChars) ? Math.max(0, promptMetadata.extraChars) : 0;
	if (extra > 0) coverage.push("prompt_metadata");
	const reserve = Number.isFinite(outputReserveChars) ? Math.max(0, outputReserveChars) : 0;
	if (reserve > 0) coverage.push("output_reserve");
	const chars = messageChars + toolsChars + extra + reserve;
	return {
		chars,
		source: "estimated",
		coverage,
		details: {
			message_count: messageCount,
			message_chars: messageChars,
			tool_count: seenTools.size,
			tools_chars: toolsChars,
			extra_chars: extra,
			output_reserve_chars: reserve,
		},
	};
}

/**
 * A read-only, grant-bounded observation tool. It lets the model INSPECT the real
 * current target before deciding an action, so a single hard-coded decision is
 * not mistaken for the observe -> decide -> verify loop. It performs NO effect:
 * it only reads a file inside the authorized workspace root, resolved with the
 * SAME realpath semantics as the fixture boundary (`resolveInside`), so a
 * lexical match on a symlink that points OUTSIDE the workspace is refused and
 * the external content is never returned.
 *
 * The read grant is the CURRENT Task's targets, not the union of every target in
 * the Manifest. The caller supplies a `grantProvider()` that follows the Host's
 * current Task binding, so task A can never read a file only task B was granted.
 * A static `allowedTargets` array is still accepted for callers that have a
 * single fixed grant.
 *
 * Honest boundary: this verifies the REAL resolved location at read time; it does
 * not claim to resist a malicious OS process concurrently swapping a directory
 * between the check and the read.
 *
 * @param {{
 *   sdk: any,
 *   type?: any,
 *   workspaceRoot: string,
 *   allowedTargets?: string[],
 *   grantProvider?: (() => { task_id?: string, targets?: string[] })|null,
 * }} args
 */
export function createObservationTool(
	{ sdk, type, workspaceRoot, allowedTargets = [], grantProvider = null } = /** @type {any} */ ({}),
) {
	const Type = type ?? sdk.Type;
	if (!Type) throw new Error("createObservationTool requires a Type schema builder");
	const { readFileSync, existsSync } = nodeFs;

	/** The CURRENT Task's read grant, or the static list when no provider is set. */
	function currentGrant() {
		if (typeof grantProvider === "function") {
			const provided = grantProvider();
			if (provided && typeof provided === "object") {
				return {
					task_id: provided.task_id ?? null,
					targets: Array.isArray(provided.targets) ? provided.targets.filter((t) => typeof t === "string") : [],
				};
			}
		}
		return { task_id: null, targets: allowedTargets.filter((t) => typeof t === "string") };
	}

	return sdk.defineTool({
		name: "aegis_read",
		label: "Aegis: read a file in the authorized workspace",
		description:
			"Read the real content of a file INSIDE the authorized task workspace (read-only; no effect). Use it to inspect the current target before proposing a registered action.",
		promptSnippet: "Read a workspace file to inspect the current target state (read-only)",
		parameters: Type.Object({
			path: Type.String({ description: "Workspace-relative path to read" }),
		}),
		async execute(_toolCallId, params) {
			const requested = typeof params?.path === "string" ? params.path : "";
			if (!requested) {
				return {
					content: [{ type: "text", text: "Aegis refused an empty read path" }],
					details: { ok: false, reason: "empty_path" },
				};
			}
			// Real path resolution: reject absolute paths, `..`, and ANY symlink
			// escape from the real workspace root (the real target is what matters,
			// not the lexical path string).
			let absolute;
			try {
				absolute = resolveInside(workspaceRoot, requested, { mustExist: true });
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				const reason = /symlink/.test(detail)
					? "symlink_escape"
					: /does not exist/.test(detail)
						? "missing"
						: "outside_workspace";
				return {
					content: [{ type: "text", text: `Aegis refused to read ${requested}: ${detail}` }],
					details: { ok: false, reason },
				};
			}
			const grant = currentGrant();
			if (grant.targets.length > 0) {
				// Compare the REAL resolved locations, so a symlink cannot masquerade as
				// a granted target. A granted target that is itself a symlink must still
				// resolve inside the workspace to authorize the read.
				let granted = false;
				for (const target of grant.targets) {
					let targetAbs;
					try {
						targetAbs = resolveInside(workspaceRoot, target, { mustExist: false });
					} catch {
						continue;
					}
					if (targetAbs === absolute) {
						granted = true;
						break;
					}
				}
				if (!granted) {
					return {
						content: [
							{ type: "text", text: `Aegis refused to read a path outside the current Task grant: ${requested}` },
						],
						details: { ok: false, reason: "outside_grant", task_id: grant.task_id },
					};
				}
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
				details: { ok: true, path: requested, chars: text.length, task_id: grant.task_id },
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
 * @param {{ sdk: any, buffer: any, type?: any, admitTool?: any, remainingRequests?: any, state?: any }} args
 */
export function createDecisionCaptureTool({
	sdk,
	buffer,
	type,
	admitTool = null,
	remainingRequests = null,
	state = null,
}) {
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
			if (noFollowUp && state) state.budget_terminated = true;
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
 *   decisionState?: any,
 *   router?: any,
 *   ledgerFactory?: ((task: any) => any)|null,
 *   onRequestCommitted?: ((record: object) => void)|null,
 *   persistRequest?: ((record: {phase: string, task_id: string, request_id?: string|null, task_reservation_id?: string|null, campaign_reservation_id?: string|null, input_chars: number, coverage?: string[], source?: string, usage?: any, usage_source?: string, tool_calls?: number, provider_started?: boolean, provider_status?: string|null, stop_reason?: string|null, commit_status?: object|null, failure_reason?: string|null}) => Promise<{ok: boolean, error?: string}>)|null,
 *   setTaskBinding?: ((task: any) => void)|null,
 *   contextWindowChars?: number|null,
 *   clock?: () => number,
 *   campaignId?: string|null,
 *   reconciliationGuard?: {unresolved: number, diagnostics: number, runtimeBlocked?: boolean}|null,
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
		decisionState = null,
		router = null,
		ledgerFactory = null,
		onRequestCommitted = null,
		persistRequest = null,
		setTaskBinding = null,
		contextWindowChars = null,
		clock = () => Date.now(),
		campaignId = null,
		reconciliationGuard = null,
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
	function buildPrompt(task = null, habit = null) {
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
		// A `habit` route fixes the method; the model may ONLY bind the reported
		// missing parameters, never re-plan the whole path.
		const habitLines = habit?.action_ref
			? [
					`HABIT MATCH: the verified method is ${habit.action_ref}. Do NOT choose another action.`,
					`ALREADY BOUND: ${JSON.stringify(habit.bound_arguments ?? {})}`,
					`MISSING PARAMETERS TO BIND: ${JSON.stringify(habit.missing_parameters ?? [])}`,
				]
			: [];
		const lines = [
			`TASK ${effectiveTaskId}`,
			`GOAL: ${effectiveGoal}`,
			target ? `TARGET: ${target}` : "TARGET: (none declared)",
			criteria.length ? `ACCEPTANCE: ${criteria.join(" ; ")}` : "ACCEPTANCE: (none declared)",
			catalogLines.length ? `REGISTERED ACTIONS:\n${catalogLines.join("\n")}` : "REGISTERED ACTIONS: (see catalog)",
			...habitLines,
			"Use aegis_read to inspect the target file first, then state your decision with aegis_task_decision (data-only arguments). Do not write files directly.",
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

	/** Restore the SDK session's original provider boundary after the task. */
	function restoreProviderGate(activeSession, gate) {
		if (gate?.sessionRef === activeSession && typeof gate.originalStreamFunction === "function") {
			activeSession.agent.streamFunction = gate.originalStreamFunction;
		}
	}

	/**
	 * Install the REAL provider-bound request gate on the bound SDK session.
	 *
	 * `agent.streamFunction` is the SDK's actual provider boundary: it is called
	 * immediately before EVERY provider request, including the first, the
	 * automatic tool loop and any continuation. Wrapping it is therefore a single
	 * admission point that no particular tool's return value can bypass.
	 *
	 * The gate:
	 *   * flushes the PREVIOUS request's durable commit before admitting the next
	 *     (durable-before-provider);
	 *   * re-checks the per-request input window and wall-time on every call;
	 *   * reserves the task/campaign request budget BEFORE the provider is called;
	 *   * refuses (and does NOT call the provider) when a reservation cannot be
	 *     made durable, when the budget is exhausted, or after a commit failure;
	 *   * records one committed request per real provider response via the
	 *     message_end subscriber, with the backend usage when observable.
	 *
	 * @returns {boolean} whether the gate was installed
	 */
	function installProviderGate(activeSession, gate, { effectiveTaskId: gateTaskId, activeLedger, campaignLedger }) {
		const agent = activeSession?.agent;
		if (!agent || typeof agent.streamFunction !== "function") return false;
		const realStream = agent.streamFunction;
		gate.originalStreamFunction = realStream;
		gate.sessionRef = activeSession;
		const window = typeof contextWindowChars === "number" ? contextWindowChars : (context?.max_total_input_chars ?? 0);
		const outputReserve = context?.output_reserve_chars ?? 0;
		const sameLedger = activeLedger === campaignLedger;
		agent.streamFunction = async (model, llmContext, options) => {
			// 1. Durable-before-provider: the previous request's commit must be durable
			// before another provider request starts. A failed commit stops the run.
			const flushed = await gate.pendingCommit;
			if (flushed && flushed.ok === false) {
				gate.stopped = true;
				gate.refused = true;
				gate.failure_mode = "accounting_failure";
				gate.reason = `previous provider request could not be durably committed: ${flushed.error ?? "unknown"}`;
				throw budgetRefused(gate.reason, "accounting_failure");
			}
			if (gate.stopped) {
				gate.refused = true;
				gate.failure_mode = gate.failure_mode ?? "accounting_failure";
				gate.reason = gate.reason ?? "dispatch stopped after a budget/accounting failure";
				throw budgetRefused(gate.reason, gate.failure_mode);
			}

			// 1b. Unresolved prior request. A pending hold or an invalid/conflicting
			// rebuild means a PRIOR request may already have reached the provider. Re-
			// dispatching would risk a double charge/effect, so the run stops here and
			// keeps the budget responsibility until an explicit reconciliation.
			if (!gate.guardReported) {
				const outstandingHolds =
					(campaignLedger.pending?.() ?? []).length + (sameLedger ? 0 : (activeLedger.pending?.() ?? []).length);
				const guardUnresolved = (reconciliationGuard?.unresolved ?? 0) + outstandingHolds;
				const guardDiagnostics = reconciliationGuard?.diagnostics ?? 0;
				if (guardUnresolved > 0 || guardDiagnostics > 0 || reconciliationGuard?.runtimeBlocked === true) {
					gate.guardReported = true;
					gate.refused = true;
					gate.stopped = true;
					gate.failure_mode = "reconciliation_required";
					gate.category = "unresolved_prior_request";
					gate.reason = `an unresolved prior provider request must be reconciled before a new dispatch (unresolved=${guardUnresolved}, diagnostics=${guardDiagnostics})`;
					throw budgetRefused(gate.reason, "reconciliation_required");
				}
			}

			// 2. Measure the ACTUAL request context (messages + tool schema), never a
			// cached copy. First request and every continuation use the same function.
			const measurement = measureProviderInput({ llmContext, outputReserveChars: outputReserve });
			const estimate = measurement.chars;
			const requestId = `req-${gateTaskId}-${gate.requestSeq + 1}-${clock()}`;
			gate.inputMeasurement = measurement;
			if (window > 0 && estimate > window) {
				gate.refused = true;
				gate.stopped = true;
				gate.failure_mode = "context_window_exceeded";
				gate.reason = `provider input estimate ${estimate} exceeds the per-request window ${window} (coverage: ${measurement.coverage.join(",") || "none"})`;
				throw budgetRefused(gate.reason, "context_window_exceeded", { request_id: requestId, measurement });
			}

			// 3. Joint in-memory admission. Campaign envelope first, then the Task
			// allocation. Either refusal means ZERO provider calls; the first hold is
			// compensated before returning, and nothing is persisted yet.
			const campaignAdmission = campaignLedger.admitRequest({
				inputChars: estimate,
				kind: "provider_bound",
				request_id: requestId,
				ledger_id: gate.campaignLedgerId,
			});
			if (!campaignAdmission.ok) {
				gate.refused = true;
				gate.stopped = true;
				gate.failure_mode = "budget_exhausted";
				gate.reason = `campaign ${campaignAdmission.reason}`;
				throw budgetRefused(gate.reason, "budget_exhausted", { request_id: requestId, layer: "campaign" });
			}
			let taskAdmission = campaignAdmission;
			if (!sameLedger) {
				taskAdmission = activeLedger.admitRequest({
					inputChars: estimate,
					kind: "provider_bound",
					request_id: requestId,
					ledger_id: gate.taskLedgerId,
				});
				if (!taskAdmission.ok) {
					// Compensate the campaign hold: the provider has NOT been called, so a
					// release is legal and keeps the campaign budget honest.
					campaignLedger.cancelReservation({
						reservation_id: campaignAdmission.reservation_id,
						reason: "task_admission_refused",
					});
					gate.refused = true;
					gate.stopped = true;
					gate.failure_mode = "budget_exhausted";
					gate.reason = `task ${taskAdmission.reason}`;
					throw budgetRefused(gate.reason, "budget_exhausted", { request_id: requestId, layer: "task" });
				}
			}

			// 4. Durable reservation BEFORE the provider call. One record links the
			// request to BOTH reservations. A persistence failure means no provider call
			// and the in-memory holds are compensated (provider not yet started).
			if (typeof persistRequest === "function") {
				let persisted;
				try {
					persisted = await persistRequest({
						phase: "reserved",
						task_id: gateTaskId,
						request_id: requestId,
						task_reservation_id: taskAdmission.reservation_id,
						campaign_reservation_id: campaignAdmission.reservation_id,
						input_chars: estimate,
						coverage: measurement.coverage,
						source: measurement.source,
					});
				} catch (error) {
					persisted = { ok: false, error: String(error) };
				}
				if (persisted?.ok !== true) {
					if (!sameLedger) {
						activeLedger.cancelReservation({
							reservation_id: taskAdmission.reservation_id,
							reason: "durable_reservation_failed",
						});
					}
					campaignLedger.cancelReservation({
						reservation_id: campaignAdmission.reservation_id,
						reason: "durable_reservation_failed",
					});
					gate.refused = true;
					gate.stopped = true;
					// The structured failure is `accounting_failure`; the reconciliation
					// category distinguishes the exact root cause.
					gate.failure_mode = "accounting_failure";
					gate.category = "reservation_persist_failed";
					gate.reason = `request reservation could not be made durable: ${persisted?.error ?? "unknown"}`;
					throw budgetRefused(gate.reason, "accounting_failure", { request_id: requestId });
				}
			}

			// 5. All admissions + durable reservation succeeded: call the provider.
			gate.requestSeq += 1;
			gate.outstanding = {
				request_id: requestId,
				task_reservation_id: taskAdmission.reservation_id,
				campaign_reservation_id: campaignAdmission.reservation_id,
				inputChars: estimate,
				coverage: measurement.coverage,
				source: measurement.source,
			};
			gate.providerRequests += 1;
			gate.providerStarted = true;
			return realStream(model, llmContext, options);
		};
		return true;
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

		// RESTART/DISPATCH BLOCK: an unresolved prior request (or an invalid rebuild)
		// means a previous provider request may already have happened. No provider AND
		// no Broker dispatch may proceed until it is reconciled; the budget hold is
		// kept. This is the running stop path -- showing `unknown` in a report is not
		// enough.
		if (
			reconciliationGuard &&
			(reconciliationGuard.unresolved > 0 ||
				reconciliationGuard.diagnostics > 0 ||
				reconciliationGuard.runtimeBlocked === true)
		) {
			const guardReason = `an unresolved prior provider request must be reconciled before dispatch (unresolved=${reconciliationGuard.unresolved}, diagnostics=${reconciliationGuard.diagnostics})`;
			if (onEvent)
				onEvent({
					kind: "task.blocked",
					task_id: effectiveTaskId,
					reason: guardReason,
					failure_mode: "reconciliation_required",
				});
			return {
				ok: false,
				failure_mode: "reconciliation_required",
				detail: guardReason,
				provider_requests: 0,
				reconciliation: {
					category: "unresolved_prior_request",
					task_id: effectiveTaskId,
					campaign_id: campaignId,
					provider_started: false,
					provider_requests: 0,
					unresolved_requests: reconciliationGuard.unresolved,
					diagnostics: reconciliationGuard.diagnostics,
					pending: { campaign: ledger.reserved?.() ?? null, task: activeLedger.reserved?.() ?? null },
					consumed: { campaign: ledger.consumed?.() ?? null, task: activeLedger.consumed?.() ?? null },
				},
			};
		}

		// ROUTE BEFORE THE MODEL. `direct` executes the confirmed action with ZERO
		// provider requests; `habit` gives the model ONLY the missing parameters to
		// bind (the method is fixed). Anything else plans deliberately. A paused or
		// conflicting route is surfaced with its reason and does NOT silently become
		// an ordinary hint.
		let habit = null;
		if (router) {
			const decision = await router({ task, session: activeSession });
			if (onEvent)
				onEvent({
					kind: "task.routed",
					task_id: effectiveTaskId,
					route: decision?.route ?? "unknown",
					reason: decision?.reason ?? null,
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
			if (decision?.route === "habit") {
				habit = {
					action_ref: decision.action_ref ?? null,
					missing_parameters: decision.missing_parameters ?? [],
					bound_arguments: decision.arguments ?? decision.bound_arguments ?? {},
				};
			}
		}
		const prompt = buildPrompt(task, habit);
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
		const outputReserveChars = context?.output_reserve_chars ?? 0;
		const inputChars = estimateInputChars({ prompt, toolChars, outputReserveChars });
		const window = typeof contextWindowChars === "number" ? contextWindowChars : (context?.max_total_input_chars ?? 0);
		// A cheap early window check before the first request; the provider gate
		// re-checks the window on EVERY request (including continuations).
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

		// --- one shared settlement rule for every exit path ---------------------
		/** Commit one reservation on a ledger; a throw becomes a typed failure. */
		function safeCommit(targetLedger, reservationId, usageValue, inputChars) {
			try {
				const result = targetLedger.commitRequest({ reservation_id: reservationId, usage: usageValue, inputChars });
				return result ?? { ok: false, error: "commit returned no result" };
			} catch (error) {
				return { ok: false, error: String(error) };
			}
		}

		/**
		 * Persist a reconciliation record for a request whose settlement is NOT a
		 * clean joint commit. Best-effort: a failure is reported, never hidden. The
		 * earlier durable `reserved` record still lets a restart rebuild the hold.
		 */
		async function persistReconciliation({
			reservation,
			usage: usageValue,
			providerStatus,
			stopReason: endReason,
			commitStatus,
			failureReason,
		}) {
			if (typeof persistRequest !== "function") return { persisted: false, ok: false, error: "no durable writer" };
			try {
				const written = await persistRequest({
					phase: "reconciliation_required",
					task_id: effectiveTaskId,
					request_id: reservation?.request_id ?? null,
					task_reservation_id: reservation?.task_reservation_id ?? null,
					campaign_reservation_id: reservation?.campaign_reservation_id ?? null,
					input_chars: reservation?.inputChars ?? 0,
					coverage: reservation?.coverage ?? [],
					source: reservation?.source ?? "estimated",
					usage: usageValue ?? null,
					usage_source: usageValue ? "estimated" : "unknown",
					provider_started: true,
					provider_status: providerStatus ?? "unknown",
					stop_reason: endReason ?? null,
					commit_status: commitStatus ?? null,
					failure_reason: failureReason ?? null,
				});
				return { persisted: written?.ok === true, ok: written?.ok === true, error: written?.error ?? null };
			} catch (error) {
				return { persisted: false, ok: false, error: String(error) };
			}
		}

		/**
		 * Settle ONE provider request. A joint success requires BOTH in-memory
		 * commits AND the durable commit; a memory commit failure is NEVER written
		 * as a joint-success record even when the durable writer would succeed.
		 */
		async function finalizeRequest({ reservation, usage: usageValue, providerStatus, stopReason: endReason }) {
			const taskCommit = safeCommit(activeLedger, reservation.task_reservation_id, usageValue, reservation.inputChars);
			const campaignCommit =
				ledger === activeLedger
					? { ok: true }
					: safeCommit(ledger, reservation.campaign_reservation_id, usageValue, reservation.inputChars);
			const commitStatus = {
				task: taskCommit.ok === false ? "failed" : "committed",
				campaign: campaignCommit.ok === false ? "failed" : "committed",
			};
			if (commitStatus.task === "failed" || commitStatus.campaign === "failed") {
				const failureReason = `in-memory commit failed (task=${commitStatus.task}, campaign=${commitStatus.campaign}; task_error=${taskCommit.error ?? "none"}; campaign_error=${campaignCommit.error ?? "none"})`;
				const reconciliation = await persistReconciliation({
					reservation,
					usage: usageValue,
					providerStatus,
					stopReason: endReason,
					commitStatus,
					failureReason,
				});
				return { ok: false, error: failureReason, commit_status: commitStatus, reconciliation };
			}
			if (typeof persistRequest === "function") {
				try {
					const written = await persistRequest({
						phase: "committed",
						task_id: effectiveTaskId,
						request_id: reservation.request_id,
						task_reservation_id: reservation.task_reservation_id,
						campaign_reservation_id: reservation.campaign_reservation_id,
						input_chars: reservation.inputChars,
						coverage: reservation.coverage ?? [],
						source: reservation.source ?? "estimated",
						usage: usageValue,
						usage_source: usageValue ? "estimated" : "unknown",
						provider_started: true,
						provider_status: providerStatus,
						stop_reason: endReason,
						commit_status: commitStatus,
					});
					if (written?.ok === true) return { ok: true, commit_status: commitStatus };
					// The durable joint commit failed. The in-memory charge stands, so do
					// not release it; try to persist the reconciliation (the writer may be
					// transiently failing, and a second record gives a precise restart).
					const failureReason = `durable committed append failed: ${written?.error ?? "unknown"}`;
					const reconciliation = await persistReconciliation({
						reservation,
						usage: usageValue,
						providerStatus,
						stopReason: endReason,
						commitStatus,
						failureReason,
					});
					return { ok: false, error: failureReason, commit_status: commitStatus, reconciliation };
				} catch (error) {
					return { ok: false, error: String(error), commit_status: commitStatus };
				}
			}
			return { ok: true, commit_status: commitStatus };
		}

		// The provider gate state. `outstanding` holds the joint reservations created
		// by the gate for the request currently in flight; `pendingCommit` is the
		// durable commit of the previous request that the next admission awaits.
		const gate = {
			refused: false,
			stopped: false,
			reason: null,
			failure_mode: null,
			category: null,
			outstanding: null,
			pendingCommit: Promise.resolve({ ok: true }),
			lastCommit: null,
			providerRequests: 0,
			providerStarted: false,
			providerStatus: null,
			planningStatus: null,
			reconciliationPersisted: null,
			requestSeq: 0,
			inputMeasurement: null,
			guardReported: false,
			campaignLedgerId: campaignId ? `campaign-${campaignId}` : "campaign",
			taskLedgerId: `task-${effectiveTaskId}`,
			lastRequest: null,
		};
		const installed = installProviderGate(activeSession, gate, {
			effectiveTaskId,
			activeLedger,
			campaignLedger: ledger,
		});
		if (!installed) {
			return {
				ok: false,
				failure_mode: "no_provider_boundary",
				detail: "the bound SDK session does not expose a provider-boundary stream function",
			};
		}

		let usage = null;
		let assistantText = "";
		const unsubscribe = activeSession.subscribe((event) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				// SDK failures can arrive after the provider response was settled (for
				// example, while saving a tool result). Planning termination belongs to
				// the whole run, independently of whether a request is outstanding.
				const classified = classifyStopReason(event.message.stopReason);
				if (classified.planningStatus === "error" || classified.planningStatus === "aborted")
					gate.planningStatus = classified.planningStatus;
				else if (gate.planningStatus !== "error" && gate.planningStatus !== "aborted")
					gate.planningStatus = classified.planningStatus;
				const content = Array.isArray(event.message.content) ? event.message.content : [];
				const text = content
					.filter((part) => part?.type === "text")
					.map((part) => part.text)
					.join("\n");
				if (gate.outstanding) {
					// A REAL provider request the gate admitted. A synthetic SDK error
					// message (stopReason "error") is NOT a successful settlement; it is
					// classified as a provider error with the reservations still charged.
					const reservation = gate.outstanding;
					gate.outstanding = null;
					gate.lastRequest = reservation;
					usage = event.message.usage ?? usage;
					assistantText = text;
					const providerStatus = classified.providerStatus;
					gate.providerStatus = providerStatus;
					const pending = finalizeRequest({
						reservation,
						usage,
						providerStatus,
						stopReason: event.message.stopReason ?? null,
					})
						.then((result) => {
							gate.lastCommit = result;
							if (result?.reconciliation) gate.reconciliationPersisted = result.reconciliation;
							return result;
						})
						.catch((error) => {
							gate.lastCommit = { ok: false, error: String(error) };
							return gate.lastCommit;
						});
					gate.pendingCommit = pending;
					if (typeof onRequestCommitted === "function")
						onRequestCommitted({ ...reservation, usage, provider_status: providerStatus });
				} else if (text) {
					assistantText = text;
				}
			}
		});
		let stopReason = "completed";
		let promptError = null;
		try {
			await activeSession.prompt(prompt);
		} catch (error) {
			// A gate refusal is converted by the real SDK into a synthetic message; a
			// raw throw is a transport failure. Either way the unified finalization
			// below decides the outcome -- there is no early return.
			promptError = error;
			if (gate.planningStatus !== "aborted") gate.planningStatus = "error";
			stopReason = "transport_failure";
			if (onEvent) onEvent({ kind: "task.error", task_id: effectiveTaskId, error: String(error) });
		} finally {
			try {
				unsubscribe();
			} catch {
				// ignore
			}
		}
		// The gate is scoped to this task; restore the original stream function so a
		// later task gets a fresh gate (and never double-counts).
		try {
			restoreProviderGate(activeSession, gate);
		} catch {
			// ignore
		}

		// An admitted request that produced NO completion event is UNKNOWN, not a
		// refund: keep the hold, persist a durable reconciliation, and stop.
		let unresolvedOutstanding = false;
		if (gate.outstanding) {
			const reservation = gate.outstanding;
			gate.outstanding = null;
			gate.lastRequest = reservation;
			gate.providerStatus = gate.providerStatus ?? "unknown";
			unresolvedOutstanding = true;
			const reconciliation = await persistReconciliation({
				reservation,
				usage: null,
				providerStatus: "unknown",
				stopReason,
				commitStatus: null,
				failureReason: promptError ? String(promptError) : "provider started without a completion event",
			});
			gate.reconciliationPersisted = reconciliation;
			gate.pendingCommit = Promise.resolve({
				ok: false,
				error: promptError ? String(promptError) : "provider result unknown (no completion event)",
			});
		}

		// 6. FINAL FLUSH: even when there is no next continuation, the last provider
		// request's durable commit must settle before ANY decision can be returned
		// (and therefore before the CompositeWorker can enter the Broker).
		const finalCommit = /** @type {any} */ (
			await gate.pendingCommit.catch((error) => ({ ok: false, error: String(error) }))
		);
		const commitOk = !finalCommit || finalCommit.ok !== false;
		const commitError = commitOk ? null : (finalCommit?.error ?? "durable commit failed");

		const decisions = decisionBuffer ? decisionBuffer.list() : [];
		const reconciliation = {
			category: gate.category ?? gate.failure_mode ?? (commitOk ? null : "accounting_commit_failed"),
			task_id: effectiveTaskId,
			campaign_id: campaignId,
			request_id: gate.lastRequest?.request_id ?? null,
			task_reservation_id: gate.lastRequest?.task_reservation_id ?? null,
			campaign_reservation_id: gate.lastRequest?.campaign_reservation_id ?? null,
			provider_started: gate.providerStarted,
			provider_requests: gate.providerRequests,
			provider_status: gate.providerStatus,
			planning_status: gate.planningStatus,
			commit_status: finalCommit?.commit_status ?? gate.lastCommit?.commit_status ?? null,
			reconciliation_persisted: gate.reconciliationPersisted?.persisted ?? null,
			reconciliation_error: gate.reconciliationPersisted?.error ?? null,
			commit_error: commitError,
			reason: gate.reason ?? null,
			pending: { campaign: ledger.reserved?.() ?? null, task: activeLedger.reserved?.() ?? null },
			consumed: { campaign: ledger.consumed?.() ?? null, task: activeLedger.consumed?.() ?? null },
		};

		// Every failure path below stops the chain: no decision reaches the Broker
		// and no dependency advances.
		let failureMode = null;
		let failureDetail = null;
		if (gate.refused) {
			failureMode = gate.failure_mode ?? "budget_exhausted";
			failureDetail = gate.reason ?? reconciliation.commit_error ?? "the provider request gate refused the request";
		} else if (unresolvedOutstanding) {
			failureMode = "reconciliation_required";
			failureDetail = reconciliation.commit_error ?? "provider result unknown (no completion event)";
		} else if (!commitOk) {
			failureMode = "accounting_failure";
			failureDetail = reconciliation.commit_error;
		} else if (promptError) {
			failureMode = gate.providerStarted ? "planning_error" : "transport_failure";
			failureDetail = String(promptError);
		} else if (gate.planningStatus === "error") {
			failureMode = gate.providerStatus === "error" ? "provider_error" : "planning_error";
			failureDetail = "the SDK planning ended with an error; occurred request settlements are retained";
		} else if (gate.planningStatus === "aborted") {
			failureMode = gate.providerStatus === "aborted" ? "provider_aborted" : "planning_aborted";
			failureDetail =
				"the model planning was aborted; occurred requests stay charged and no decision reaches the Broker";
		} else if ((gate.planningStatus === "unknown" || gate.planningStatus === null) && decisions.length > 0) {
			failureMode = "planning_termination_unknown";
			failureDetail = "no trustworthy SDK termination evidence; the buffered decision is not executable";
		}
		if (failureMode) {
			reconciliation.category = failureMode;
			// A post-provider failure (unknown/accounting/provider error) leaves a
			// budget responsibility or an unbalanced settlement. Block later dispatch
			// in THIS run until that is reconciled. A pre-call budget/window refusal is
			// certain (provider 0) and does not block independent tasks.
			if (
				reconciliationGuard &&
				[
					"reconciliation_required",
					"accounting_failure",
					"provider_error",
					"provider_aborted",
					"planning_error",
					"planning_aborted",
					"planning_termination_unknown",
				].includes(failureMode)
			)
				reconciliationGuard.runtimeBlocked = true;
			if (onEvent)
				onEvent({
					kind: "task.blocked",
					task_id: effectiveTaskId,
					reason: failureDetail,
					failure_mode: failureMode,
				});
			return {
				ok: false,
				failure_mode: failureMode,
				detail: failureDetail,
				provider_requests: gate.providerRequests,
				reconciliation,
			};
		}

		// The decision tool may also have terminated the turn because the task
		// allocation could not fund the SDK's automatic follow-up. Keep that as a
		// secondary, explicit budget stop.
		if (decisionState?.budget_terminated === true) {
			if (onEvent)
				onEvent({
					kind: "task.blocked",
					task_id: effectiveTaskId,
					reason: "task request allocation cannot fund the automatic follow-up",
				});
			return {
				ok: false,
				failure_mode: "task_request_budget_exhausted",
				detail: "the task request allocation was spent before the model could complete its loop",
				provider_requests: gate.providerRequests,
			};
		}
		if (onEvent) {
			onEvent({
				kind: "task.planned",
				task_id: effectiveTaskId,
				provider_requests: gate.providerRequests,
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
		// The Worker returns the TRANSPORT fact only, and ONLY after the final
		// durable commit settled. The Oracle judges the effect.
		return {
			ok: true,
			outcome_ref: `artifact:${effectiveTaskId}`,
			assistant_digest: digest(assistantText),
			provider_requests: gate.providerRequests,
			stop_reason: stopReason,
			decisions,
		};
	}

	return {
		version: MODEL_WORKER_VERSION,
		buildPrompt,
		estimateInputChars,
		measureProviderInput,
		run,
	};
}
