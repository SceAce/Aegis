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

export const MODEL_WORKER_VERSION = "1.1.0";

/** A typed, distinguishable refusal from the provider-bound request gate. */
function budgetRefused(message, category) {
	/** @type {Error & {aegis_budget_refused?: boolean, aegis_category?: string}} */
	const error = new Error(message);
	error.name = "AegisBudgetRefused";
	error.aegis_budget_refused = true;
	error.aegis_category = category;
	return error;
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
 *   persistRequest?: ((record: {phase: string, task_id: string, reservation_id?: string, input_chars: number, usage?: any, usage_source?: string, tool_calls?: number}) => Promise<{ok: boolean, error?: string}>)|null,
 *   setTaskBinding?: ((task: any) => void)|null,
 *   contextWindowChars?: number|null,
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
	function installProviderGate(
		activeSession,
		gate,
		{ effectiveTaskId: gateTaskId, prompt, toolChars, outputReserveChars, activeLedger },
	) {
		const agent = activeSession?.agent;
		if (!agent || typeof agent.streamFunction !== "function") return false;
		const realStream = agent.streamFunction;
		gate.originalStreamFunction = realStream;
		gate.sessionRef = activeSession;
		const window = typeof contextWindowChars === "number" ? contextWindowChars : (context?.max_total_input_chars ?? 0);
		agent.streamFunction = async (model, llmContext, options) => {
			// Durable-before-provider: the previous request's commit must be durable
			// before another provider request can start. A failed commit stops the run
			// instead of silently continuing (reconciliation state is preserved).
			const flushed = await gate.pendingCommit;
			if (flushed && flushed.ok === false) {
				gate.stopped = true;
				gate.refused = true;
				gate.reason = `previous provider request could not be durably committed: ${flushed.error ?? "unknown"}`;
				throw budgetRefused(gate.reason, "accounting_failure");
			}
			if (gate.stopped) {
				gate.refused = true;
				gate.reason = gate.reason ?? "dispatch stopped after a budget/accounting failure";
				throw budgetRefused(gate.reason, "stopped");
			}
			const estimate = estimateInputChars({
				prompt: typeof prompt === "string" ? prompt : "",
				toolChars,
				outputReserveChars,
			});
			// Per-request input WINDOW (never multiplied by the request budget).
			if (window > 0 && estimate > window) {
				gate.refused = true;
				gate.reason = `input estimate ${estimate} exceeds the per-request window ${window}`;
				throw budgetRefused(gate.reason, "context_window_exceeded");
			}
			// Durable reservation BEFORE the provider is called. A persistence failure
			// must not call the provider.
			if (typeof persistRequest === "function") {
				let persisted;
				try {
					persisted = await persistRequest({
						phase: "reserved",
						task_id: gateTaskId,
						input_chars: estimate,
					});
				} catch (error) {
					persisted = { ok: false, error: String(error) };
				}
				if (persisted?.ok !== true) {
					gate.refused = true;
					gate.stopped = true;
					gate.reason = `request reservation could not be made durable: ${persisted?.error ?? "unknown"}`;
					throw budgetRefused(gate.reason, "reservation_persist_failed");
				}
			}
			const admission = activeLedger.admitRequest({ inputChars: estimate, kind: "provider_bound" });
			if (!admission.ok) {
				gate.refused = true;
				gate.stopped = true;
				gate.reason = admission.reason;
				throw budgetRefused(admission.reason, "budget_exhausted");
			}
			gate.outstanding = { reservation_id: admission.reservation_id, inputChars: estimate };
			gate.providerRequests += 1;
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

		// The provider gate state. `outstanding` holds the reservation created by
		// the gate for the request currently in flight; `pendingCommit` is the
		// durable commit of the previous request that the next admission awaits.
		const gate = {
			refused: false,
			stopped: false,
			reason: null,
			outstanding: null,
			pendingCommit: Promise.resolve({ ok: true }),
			providerRequests: 0,
		};
		const installed = installProviderGate(activeSession, gate, {
			effectiveTaskId,
			prompt,
			toolChars,
			outputReserveChars,
			activeLedger,
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
				const content = Array.isArray(event.message.content) ? event.message.content : [];
				const text = content
					.filter((part) => part?.type === "text")
					.map((part) => part.text)
					.join("\n");
				// A synthetic failure message (stopReason "error") carries no real
				// reservation; never charge a request for it. Only commit the reservation
				// the gate created for a REAL provider request.
				if (gate.outstanding) {
					const reservation = gate.outstanding;
					gate.outstanding = null;
					usage = event.message.usage ?? usage;
					assistantText = text;
					const committedRecord = activeLedger.commitRequest({
						reservation_id: reservation.reservation_id,
						usage,
						inputChars: reservation.inputChars,
					});
					// Mirror the SAME usage into the cumulative campaign ledger once.
					if (ledger !== activeLedger) ledger.commitRequest({ usage, inputChars: reservation.inputChars });
					// Durable commit; the NEXT admission awaits this before its provider call.
					if (typeof persistRequest === "function") {
						gate.pendingCommit = Promise.resolve(
							persistRequest({
								phase: "committed",
								task_id: effectiveTaskId,
								reservation_id: reservation.reservation_id,
								input_chars: reservation.inputChars,
								usage,
								usage_source: usage?.source ?? "unknown",
							}),
						).catch((error) => ({ ok: false, error: String(error) }));
					}
					if (typeof onRequestCommitted === "function") onRequestCommitted(committedRecord);
				} else if (text) {
					assistantText = text;
				}
			}
		});
		let stopReason = "completed";
		try {
			await activeSession.prompt(prompt);
		} catch (error) {
			// The gate refuses by throwing; the SDK's run loop converts it into a
			// synthetic failure message, so this path is unexpected. Treat any throw as
			// a transport failure but still flush the durable commit.
			stopReason = "transport_failure";
			if (!gate.refused) {
				if (onEvent) onEvent({ kind: "task.error", task_id: effectiveTaskId, error: String(error) });
				await gate.pendingCommit.catch(() => undefined);
				return { ok: false, failure_mode: "transport_failure", detail: String(error) };
			}
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
		const decisions = decisionBuffer ? decisionBuffer.list() : [];
		// X2: an admission refusal is a hard, pre-provider stop. Report it as a
		// budget/accounting failure so no half-observed decision executes and no
		// dependency advances on an incomplete run. Reconciliation state is kept.
		if (gate.refused) {
			if (onEvent) onEvent({ kind: "task.blocked", task_id: effectiveTaskId, reason: gate.reason });
			const failureMode = /input estimate/.test(String(gate.reason))
				? "context_window_exceeded"
				: /durab|reservation could not/.test(String(gate.reason))
					? "accounting_failure"
					: "budget_exhausted";
			return {
				ok: false,
				failure_mode: failureMode,
				detail: gate.reason ?? "the provider request gate refused the request",
				provider_requests: gate.providerRequests,
				reconciliation: {
					category: failureMode,
					task_id: effectiveTaskId,
					reason: gate.reason ?? null,
					provider_requests: gate.providerRequests,
				},
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
		// The Worker returns the TRANSPORT fact only. The Oracle judges the effect.
		// The evidence ref is the task sentinel; the Oracle reads the real artifact.
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
		run,
	};
}
