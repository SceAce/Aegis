// Aegis verify-first action runtime (batch C adapter).
//
// This is a THIN adapter, not a new framework. It wires the already-reviewed
// batch-B libraries into the Observer's single EventLog:
//
//   action-contract.mjs       the reviewed ActionContract engine + broker
//   workspace-info-actions.mjs the read-only ELF identify action
//   script-registry.mjs       human-registered script actions
//   authorization.mjs         auto/normal target authorization
//
// It owns NO execution logic of its own and never appends events: it returns
// `observation.captured` / `outcome.recorded` / `runtime.note` payloads and the
// Observer (single writer) is the only thing that commits them. Keeping the
// adapter separate means the B2 contribution/compiler APIs get ONE resolver
// (`resolveRef`) to wire against later, without this file calling any
// under-review function to grant success.
//
// Honest boundaries (do not weaken):
//   * The model can never pass a callback, an executable, argv text or an
//     authorization object. It names a registered action id + data-only
//     arguments. Everything executable comes from the reviewed registry.
//   * `verified` is decided by the registered contract Verification, which reads
//     the real artifact/post-state; the model's claim is never consulted.
//   * normal mode does not effect without an explicit approval; the workspace is
//     never claimed to be an OS sandbox.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { digest, getPath, resolveInside } from "../shared/contracts.mjs";
import { ActionRegistry, createActionBroker } from "./action-contract.mjs";
import { workspaceObservationContracts } from "./workspace-info-actions.mjs";
import { createScriptRegistry, scriptContracts, executableDigest } from "./script-registry.mjs";
import { createAuthorization, authorizeAction, describeAuthorization } from "./authorization.mjs";

/**
 * The one place the Observer (and later B2) may look up a real record from a
 * ref. It is deliberately a plain, synchronous, local resolver: refs resolve to
 * records that are already committed in this runtime, never to network state.
 *
 * `data`   -> a recorded observation payload captured this run (the raw
 *             artifact bytes/str remain in the private task runtime).
 * `action` -> the action.requested/completed record for an action id.
 * `outcome`-> a recorded step outcome.
 */
export function createRefResolver({ observations = new Map(), actions = new Map(), outcomes = new Map() } = {}) {
	return function resolveRef({ kind, ref } = {}) {
		if (!ref || typeof ref !== "object") return { ok: false, reason: "no ref" };
		const refId = ref.ref_id ?? ref.id ?? null;
		if (!refId) return { ok: false, reason: "ref has no ref_id" };
		const table = kind === "data" ? observations : kind === "action" ? actions : kind === "outcome" ? outcomes : null;
		if (!table) return { ok: false, reason: `unsupported ref kind: ${String(kind)}` };
		const record = table.get(refId);
		if (!record) return { ok: false, reason: `no ${kind} record for ${refId}` };
		// When the ref pins a digest, the resolver must confirm the content digest,
		// never merely echo the ref back.
		if (ref.digest !== undefined && ref.digest !== null) {
			const contentDigest = record.content_digest ?? record.digest ?? null;
			if (contentDigest !== ref.digest) return { ok: false, reason: `${kind} content_digest does not match the ref digest` };
		}
		return { ok: true, record, content_digest: record.content_digest ?? record.digest ?? null };
	};
}

/**
 * The REAL resolver the Observer and B2 contribution API use: it is rebuilt
 * from the COMMITTED event log (plus private artifact bytes) on every call, so
 * a ref still resolves after a process restart. It is deliberately not a live
 * Map that only works inside one run.
 *
 * Records:
 *   data    -> a verified `observation.captured` event, re-checked against the
 *              current workspace file at resolve time (stale targets are
 *              surfaced, never silently reused);
 *   action  -> the paired `action.requested`/`action.completed` record, with the
 *              final bound argument refs (`use_refs`) and the actual final
 *              argument values;
 *   outcome -> a recorded step/episode Outcome, flagged if superseded.
 *
 * @param {object} input
 * @param {object[]} input.events  committed EventLog rows
 * @param {string} [input.workspaceRoot]
 * @param {string[]} [input.supersededOutcomeIds] outcome ids retired in the effective view
 */
export function createEventRefResolver({ events = [], workspaceRoot = null, supersededOutcomeIds = [] } = {}) {
	const observations = new Map();
	const actions = new Map();
	const outcomes = new Map();
	const requested = new Map();
	const superseded = new Set(Array.isArray(supersededOutcomeIds) ? supersededOutcomeIds.filter((id) => typeof id === "string" && id) : []);

	for (const event of events) {
		if (!event || typeof event !== "object") continue;
		const payload = event.payload ?? {};
		if (event.event_type === "action.requested" && payload.action_id) {
			requested.set(payload.action_id, event);
		} else if (event.event_type === "observation.captured") {
			const value = payload.value ?? null;
			observations.set(event.event_id, {
				observation_id: event.event_id,
				event_id: event.event_id,
				episode_id: event.episode_id ?? payload.episode_id ?? null,
				kind: payload.observation_kind ?? null,
				subject: payload.subject ?? null,
				predicate: payload.predicate ?? null,
				data: value,
				verified: payload.verified === true,
				trusted: event.source?.kind === "oracle" || event.source?.kind === "human",
				target_fingerprint: payload.target_fingerprint ?? value?.target_fingerprint ?? null,
				content_digest: value?.file_digest ?? value?.stdout_digest ?? digest(value),
				scope: payload.scope ?? null,
				source_kind: event.source?.kind ?? null,
			});
		} else if (event.event_type === "action.completed" && payload.action_id) {
			const completed = actions.get(payload.action_id) ?? {};
			actions.set(payload.action_id, {
				...completed,
				action_id: payload.action_id,
				episode_id: event.episode_id ?? payload.episode_id ?? completed.episode_id ?? null,
				action_ref: payload.action_ref ?? completed.action_ref ?? null,
				tool_name: payload.tool_name ?? completed.tool_name ?? null,
				status: "completed",
				completed: true,
				rejection_reason: payload.rejection_reason ?? null,
				transport: payload.transport ?? null,
				outcome_status: payload.status ?? null,
				use_refs: Array.isArray(payload.use_refs) ? payload.use_refs : [],
				// B2's contribution gate reads `bound_arguments` as an array of refs.
				bound_arguments: Array.isArray(payload.use_refs) ? payload.use_refs : [],
				final_arguments: payload.final_arguments ?? null,
			});
		} else if (event.event_type === "outcome.recorded" && payload.outcome_id) {
			// The Outcome's own evidence must union the payload refs AND the row's
			// event-level `evidence_refs`: the Observer attaches the data ref at the row
			// level, while the contract attaches its artifact/action refs in the payload.
			// Reading only the payload would silently drop the data ref and make an
			// `obtain` contribution unresolvable.
			const refs = [];
			const seen = new Set();
			const push = (ref) => {
				if (!ref || typeof ref !== "object") return;
				const key = `${ref.ref_type ?? ref.type ?? "?"}:${ref.ref_id ?? ref.id ?? "?"}:${ref.digest ?? ""}`;
				if (seen.has(key)) return;
				seen.add(key);
				refs.push(ref);
			};
			for (const ref of Array.isArray(payload.evidence_refs) ? payload.evidence_refs : []) push(ref);
			for (const ref of Array.isArray(event.evidence_refs) ? event.evidence_refs : []) push(ref);
			outcomes.set(payload.outcome_id, {
				...payload,
				outcome_id: payload.outcome_id,
				episode_id: event.episode_id ?? payload.episode_id ?? null,
				evidence_refs: refs,
				source_kind: event.source?.kind ?? null,
				superseded: superseded.has(payload.outcome_id),
			});
		}
	}
	// Requested-but-never-completed actions stay PENDING records so a resolver can
	// prove an action did NOT complete (never an absent record mistaken for one).
	for (const [actionId, event] of requested) {
		if (actions.has(actionId)) continue;
		actions.set(actionId, {
			action_id: actionId,
			episode_id: event.episode_id ?? event.payload?.episode_id ?? null,
			action_ref: event.payload?.action_ref ?? null,
			tool_name: event.payload?.tool_name ?? null,
			status: "pending",
			completed: false,
			use_refs: [],
			bound_arguments: [],
			final_arguments: null,
			transport: null,
		});
	}

	/** Re-check a recorded data target against the CURRENT workspace file. */
	function dataCurrent(record) {
		if (!record) return { current: null, reason: "no record" };
		if (!workspaceRoot || !record.subject || record.kind !== "file_identity") return { current: null, reason: "no re-checkable workspace target" };
		const value = record.data;
		if (!value || typeof value !== "object") return { current: null, reason: "no observed value to re-check" };
		try {
			const absolute = resolveInside(workspaceRoot, record.subject, { mustExist: true });
			const buffer = readFileSync(absolute);
			const fileDigest = digest(buffer.toString("hex"));
			if (value.file_digest && fileDigest !== value.file_digest) {
				return { current: false, reason: "target content changed since the observation", expected: value.file_digest, observed: fileDigest };
			}
			return { current: true, reason: "target matches the recorded revision" };
		} catch (error) {
			return { current: false, reason: `target cannot be re-read: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	const resolver = function resolveRef({ kind, ref } = {}) {
		if (!ref || typeof ref !== "object") return { ok: false, reason: "no ref" };
		const refId = ref.ref_id ?? ref.id ?? null;
		if (!refId) return { ok: false, reason: "ref has no ref_id" };
		if (kind === "data") {
			const record = observations.get(refId);
			if (!record) return { ok: false, reason: `no data record for ${refId}` };
			if (ref.digest !== undefined && ref.digest !== null && record.content_digest !== ref.digest) {
				return { ok: false, reason: "data content_digest does not match the ref digest" };
			}
			const current = dataCurrent(record);
			return { ok: true, record: { ...record, current: current.current, current_reason: current.reason, current_expected: current.expected ?? null, current_observed: current.observed ?? null }, content_digest: record.content_digest };
		}
		if (kind === "action") {
			const record = actions.get(refId);
			if (!record) return { ok: false, reason: `no action record for ${refId}` };
			return { ok: true, record, content_digest: record.content_digest ?? null };
		}
		if (kind === "outcome") {
			const record = outcomes.get(refId);
			if (!record) return { ok: false, reason: `no outcome record for ${refId}` };
			if (record.superseded) return { ok: false, reason: `outcome ${refId} was superseded in the current effective view` };
			return { ok: true, record, content_digest: record.content_digest ?? null };
		}
		return { ok: false, reason: `unsupported ref kind: ${String(kind)}` };
	};
	resolver.currentFor = dataCurrent;
	resolver.tables = { observations, actions, outcomes };
	return resolver;
}

/**
 * Build the runtime-facing action catalog.
 *
 * @param {object} input
 * @param {string} input.workspaceRoot                 the user-given task workspace
 * @param {object} [input.scriptRegistrationConfig]    human-provided script config
 *                                                     (`{scripts:[...]}`); absent -> unconfigured
 * @param {object} [input.authorizationConfig]         `createAuthorization` input (auto/normal)
 * @param {object} [input.resolver]                    trusted ref resolver (optional)
 */
export function createObserveActionRuntime({ workspaceRoot, scriptRegistrationConfig = {}, authorizationConfig = null, resolver = null } = {}) {
	if (typeof workspaceRoot !== "string" || !workspaceRoot) throw new Error("createObserveActionRuntime requires a workspaceRoot");

	// Human-registered scripts. Empty config is VALID and means unconfigured: the
	// runtime never self-registers a contest/remote script. A malformed/invalid
	// registration is REFUSED (fail-safe) rather than crashing the tool: no
	// script runs and the reason is surfaced for a human to fix.
	let scriptRegistry;
	let scriptRegistryError = null;
	try {
		scriptRegistry = createScriptRegistry(scriptRegistrationConfig ?? {});
	} catch (error) {
		scriptRegistryError = error instanceof Error ? error.message : String(error);
		scriptRegistry = createScriptRegistry({});
	}
	const contracts = [...workspaceObservationContracts(), ...scriptContracts(scriptRegistry)];
	const registry = new ActionRegistry(contracts);
	const broker = createActionBroker({ registry });

	// Authorization default: normal mode, no approval, tools declared explicitly.
	// A caller (Observer) may pass an auto config; the model can never.
	const authorization = createAuthorization(
		authorizationConfig ?? {
			mode: "normal",
			workspaceRoot,
			allowedTools: registry.list().map((contract) => contract.tool),
			allowNetwork: false,
			approved: false,
		},
	);

	/** Only these contracts may be invoked by the model through the Observer. */
	const OBSERVE_ACTIONS = new Set(["workspace.identify_elf"]);
	const EXECUTE_PREFIX = "script.";

	function catalog() {
		return {
			workspace_root: workspaceRoot,
			authorization: describeAuthorization(authorization),
			scripts_configured: scriptRegistry.configured,
			...(scriptRegistryError ? { script_registry_error: scriptRegistryError } : {}),
			scripts: scriptRegistry.describe(),
			actions: broker.describe(),
		};
	}

	/**
	 * Normalize the model's proposal into explicit, registered action data. Prose
	 * is never parsed. Unknown action/checker/scope yields explicit gaps.
	 */
	function resolveProposal(proposal) {
		return broker.bindProposal(proposal ?? {});
	}

	/**
	 * Run one registered action through the broker. The Observer supplies the
	 * episode/action event ids and (for normal mode) an explicit human approval.
	 *
	 * @param {object} input
	 * @param {string} input.action_ref   registered contract id (model-named)
	 * @param {object} input.arguments    data-only arguments
	 * @param {string} input.episodeId
	 * @param {string} input.actionEventId  action.requested event id (for refs)
	 * @param {boolean} [input.approved]  explicit human approval (normal mode only)
	 * @param {string} [input.target_path] workspace-relative target (ELF)
	 */
	async function run({ action_ref, arguments: args = {}, episodeId = null, actionEventId = null, approved = false, target_path = null, data_bindings = {}, resolver = null } = {}) {
		const contract = registry.get(action_ref);
		if (!contract) return { ok: false, status: "rejected", reason: `unknown action: ${String(action_ref)}`, gaps: [{ field: "action_ref", value: action_ref, reason: "not a registered action" }] };
		if (!OBSERVE_ACTIONS.has(contract.id) && !contract.id.startsWith(EXECUTE_PREFIX)) {
			return { ok: false, status: "rejected", reason: `action ${contract.id} is not exposed to the model` };
		}

		// Resolve `data_bindings` to the EXACT verified, same-Episode observed field
		// BEFORE any effect. A binding may never contradict an explicit argument, a
		// foreign/missing/stale ref is refused, and the resolved value becomes the
		// final argument. The actual bound refs are logged as `use_refs`.
		const finalArgs = { ...args };
		const useRefs = [];
		const resolvedBindings = [];
		const bindingReasons = [];
		// Target-mutation facts surfaced so the Observer can retire the now-stale
		// Fact in the effective view with a TRUSTED, SPECIFIC scope (never a broad
		// clearing). Each entry names the exact ref + expected/observed revision.
		const staleTargets = [];
		for (const [name, binding] of Object.entries(data_bindings ?? {})) {
			if (!contract.parameters || !Object.hasOwn(contract.parameters, name)) {
				bindingReasons.push(`binding ${name} is not a declared parameter`);
				continue;
			}
			if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
				bindingReasons.push(`binding ${name} must be an object`);
				continue;
			}
			const dataRef = { ref_type: binding.ref_type ?? "data", ref_id: binding.ref_id ?? binding.id ?? null };
			if (typeof binding.digest === "string" && binding.digest) dataRef.digest = binding.digest;
			if (!dataRef.ref_id) bindingReasons.push(`binding ${name} has no ref_id`);
			if (typeof binding.field !== "string" || !binding.field) bindingReasons.push(`binding ${name} needs a field`);
			if (!dataRef.ref_id || typeof binding.field !== "string" || !binding.field) continue;
			const resolved = typeof resolver === "function" ? resolver({ kind: "data", ref: dataRef }) : { ok: false, reason: "no trusted resolver is available" };
			if (!resolved?.ok) {
				bindingReasons.push(`binding ${name}: ${resolved?.reason ?? "the data ref did not resolve"}`);
				continue;
			}
			const record = resolved.record ?? {};
			if (record.episode_id && episodeId && record.episode_id !== episodeId) {
				bindingReasons.push(`binding ${name}: the data belongs to a different episode (${record.episode_id})`);
				continue;
			}
			if (record.verified !== true || record.trusted !== true) {
				bindingReasons.push(`binding ${name}: the data is not a same-episode verified observation`);
				continue;
			}
			if (record.current === false) {
				bindingReasons.push(`binding ${name}: ${record.current_reason ?? "the target changed"}; refusing to bind stale data`);
				staleTargets.push({
					name,
					ref: dataRef,
					episode_id: record.episode_id ?? episodeId ?? null,
					scope: record.scope ?? record.subject ?? record.target_fingerprint ?? null,
					previous_fingerprint: record.current_expected ?? record.previous_fingerprint ?? null,
					current_fingerprint: record.current_observed ?? record.current_fingerprint ?? null,
					reason: record.current_reason ?? "target content changed since the observation",
				});
				continue;
			}
			const value = getPath(record.data, binding.field);
			if (value === undefined || value === null) {
				bindingReasons.push(`binding ${name}: field ${binding.field} is missing from the resolved data`);
				continue;
			}
			const scalar = value !== null && typeof value === "object" ? JSON.stringify(value) : value;
			if (args[name] !== undefined && args[name] !== null && value !== null && typeof value !== "object" && String(args[name]) !== String(scalar)) {
				bindingReasons.push(`binding ${name}: explicit argument "${String(args[name])}" contradicts the resolved field value "${String(scalar)}"`);
				continue;
			}
			// Coerce the bound value to the DECLARED parameter type so a numeric
			// observed field (e.g. ELF bits=64) can bind a string parameter without
			// the argument validator silently rejecting it. The coercion is explicit
			// and type-checked; an impossible coercion is a refusal.
			const spec = contract.parameters[name] ?? {};
			let bound = scalar;
			if (spec.type === "string") bound = String(scalar);
			else if (spec.type === "integer") bound = Number.isInteger(Number(scalar)) ? Number(scalar) : scalar;
			else if (spec.type === "number") bound = Number.isNaN(Number(scalar)) ? scalar : Number(scalar);
			else if (spec.type === "boolean") bound = scalar === true || scalar === "true" ? true : scalar === false || scalar === "false" ? false : scalar;
			finalArgs[name] = bound;
			useRefs.push(dataRef);
			resolvedBindings.push({ name, field: binding.field, ref: dataRef, value: scalar, bound_value: bound, parameter_type: spec.type ?? null, current: record.current, content_digest: resolved.content_digest ?? null });
		}
		if (bindingReasons.length > 0) {
			return {
				ok: false,
				status: "rejected",
				reason: `data bindings refused: ${bindingReasons.join("; ")}`,
				binding_reasons: bindingReasons,
				stale_targets: staleTargets,
				use_refs: useRefs,
				resolved_bindings: resolvedBindings,
				final_arguments: finalArgs,
			};
		}

		// Re-derive the authorization config for THIS call. A normal-mode call only
		// proceeds when the Observer received an explicit human approval; the model
		// can never set `approved`.
		const effectiveAuth = { ...authorization, approved: authorization.mode === "normal" ? approved === true : authorization.approved };
		// Re-derive the authorization target from the REGISTERED action, never from
		// the model. An ELF observation targets the named workspace file; a script
		// action targets its human-registered cwd (which must still be inside the
		// task workspace for authorization to pass).
		let derivedTargetPath = target_path ?? null;
		if (contract.id === "workspace.identify_elf") derivedTargetPath = target_path ?? finalArgs.path ?? null;
		else if (contract.id.startsWith("script.")) {
			const registration = scriptRegistry.get(contract.id.slice("script.".length), contract.version);
			derivedTargetPath = registration?.cwd ?? registration?.allowed_root ?? null;
		}
		const context = {
			workspaceRoot,
			episode_id: episodeId,
			step_id: `step_${contract.id}`,
			action_event_id: actionEventId,
			target_path: derivedTargetPath,
			network: contract.network === true,
			// The contract's build() reads these so the stage Outcome's own evidence
			// names the data refs the FINAL arguments actually used.
			use_refs: useRefs,
			final_arguments: finalArgs,
		};

		// Re-derive the permit from the real context; a model-supplied permit object
		// is never accepted (this adapter passes `authorization`, never `permit`).
		const decision = authorizeAction(effectiveAuth, {
			action_ref: contract.id,
			tool: contract.tool,
			contract,
			arguments: finalArgs,
			target_path: context.target_path,
			target: context.target,
			network: contract.network === true,
		});

		const result = await broker.invoke({ action_ref: contract.id, arguments: finalArgs, context, authorization: effectiveAuth, state: {} });
		return {
			...result,
			authorization_decision: decision,
			final_arguments: finalArgs,
			use_refs: useRefs,
			resolved_bindings: resolvedBindings,
		};
	}

	return {
		workspaceRoot,
		registry,
		broker,
		scriptRegistry,
		scriptRegistryError,
		authorization,
		resolver,
		catalog,
		resolveProposal,
		run,
		buildRefResolver: (tables) => createRefResolver(tables),
		buildEventResolver: (input) => createEventRefResolver({ workspaceRoot, ...input }),
	};
}

/**
 * Turn a broker result into the exact EventLog payloads the Observer appends.
 *
 * Trusted-ness is a property of the SOURCE KIND the Observer chooses, not of
 * this function: the Observer records `observation.captured`/`outcome.recorded`
 * with `source.kind = "oracle"` ONLY because the registered Verification read
 * the real artifact. This function only shapes the data.
 */
export function observeEventPayloads(result, { episodeId = null, evidenceRefs = [] } = {}) {
	const observation = result.observation ?? null;
	const outcome = result.step_outcome ?? null;
	const payloads = [];
	// The registered contract emits an artifact evidence ref whose digest is the
	// REAL content digest (stdout digest for a script, the file digest for a
	// workspace observation). Persist that SAME ref ON the observation row so the
	// trusted evidence resolver can index a resolver-visible artifact record. The
	// resolver recomputes the digest from the committed value; the ref string is
	// never treated as evidence, and a non-matching digest stays unresolved.
	const artifactEvidence = [
		...(Array.isArray(evidenceRefs) ? evidenceRefs : []),
		...(Array.isArray(outcome?.evidence_refs) ? outcome.evidence_refs : []),
	].find((ref) => ref && typeof ref === "object" && (ref.ref_type ?? ref.type) === "artifact");
	if (observation) {
		payloads.push({
			event_type: "observation.captured",
			payload: {
				...observation,
				...(artifactEvidence && !observation.artifact_ref ? { artifact_ref: artifactEvidence } : {}),
				kind: "observation.captured",
				verified: result.status === "success" && result.verification?.ok === true,
				refuted: false,
				episode_id: episodeId,
			},
			evidence_refs: evidenceRefs,
		});
	}
	if (outcome) {
		payloads.push({
			event_type: "outcome.recorded",
			payload: { ...outcome, episode_id: episodeId },
			evidence_refs: Array.isArray(outcome.evidence_refs) ? outcome.evidence_refs : evidenceRefs,
		});
	}
	return payloads;
}

/**
 * A `runtime.note` recording that a verified observation's value is available
 * as OBTAINABLE data at a stable `data_ref`. The evidence resolver indexes this
 * as the committed data record a later proof resolves. The `value` is the real
 * committed observation value, so the resolver derives the content digest from
 * it (never from a claimed string); a non-durable write stays a failure and the
 * data ref is simply not resolvable (fail-closed). This records that data was
 * obtained, never that a task succeeded.
 */
export function observationDataNote({ dataRef, value = null, episodeId = null, actionEventId = null } = {}) {
	return {
		event_type: "runtime.note",
		payload: {
			kind: "data.obtained",
			episode_id: episodeId,
			data_ref: dataRef ?? null,
			value,
			action_id: actionEventId ?? null,
		},
		evidence_refs: dataRef ? [dataRef] : [],
	};
}

/**
 * A `runtime.note` payload recording an honest pre-effect rejection (e.g. an
 * unknown action, a missing approval, an out-of-workspace target). It records
 * the gap explicitly; it never records success.
 */
export function rejectionNote({ action_ref = null, reason, episodeId = null, arguments: args = null, target_path = null } = {}) {
	// Never echo raw arguments that could carry a secret; keep a redacted digest.
	return {
		event_type: "runtime.note",
		payload: {
			kind: "action.rejected",
			action_ref,
			reason: String(reason ?? "rejected"),
			episode_id: episodeId,
			arguments_digest: digest(args ?? {}),
			target_path: target_path ?? null,
		},
		evidence_refs: [],
	};
}

/**
 * A `runtime.note` recording that data was USED by an actual completed action.
 * It is association-only: the data ref and the action ref are recorded
 * separately and no success is claimed here (a verified stage Outcome is what
 * may later support an `advance` contribution through the B2 API).
 */
export function dataUseNote({ dataRef, actionRef, episodeId = null, basis = null }) {
	return {
		event_type: "runtime.note",
		payload: {
			kind: "data.use.bound",
			episode_id: episodeId,
			data_ref: dataRef ?? null,
			action_ref: actionRef ?? null,
			basis: basis ?? null,
			association_only: true,
			causal: false,
		},
		evidence_refs: [dataRef, actionRef].filter(Boolean),
	};
}

/**
 * A `runtime.note` recording an admitted ENVIRONMENT observation (e.g. a
 * discovered interpreter version or a symlink-resolved script path) that is
 * needed before an execute action runs. It is a claim, not a verification.
 */
export function environmentNote({ scope, detail, episodeId = null, targetFingerprint = null }) {
	return {
		event_type: "runtime.note",
		payload: {
			kind: "environment.observed",
			episode_id: episodeId,
			scope: scope ?? null,
			detail: detail ?? null,
			target_fingerprint: targetFingerprint,
			verified: false,
		},
		evidence_refs: [],
	};
}

/**
 * Read-only inspection of a human-registered script BEFORE execution: resolves
 * the executable and (for an interpreter) the script body through real paths,
 * hashes them, and returns the pinned digests. This lets the Observer record the
 * "registered state after registration" check as an admission step. It performs
 * no execution and does not approve anything.
 */
export function inspectScriptRegistration(registration) {
	if (!registration || typeof registration !== "object") return { ok: false, reason: "no registration" };
	const executable = registration.executable;
	if (typeof executable !== "string" || !existsSync(executable) || !statSync(executable).isFile()) {
		return { ok: false, reason: "registered executable is missing or not a regular file" };
	}
	const info = {
		id: registration.id ?? null,
		version: registration.version ?? null,
		executable,
		executable_digest_now: executableDigest(executable),
		executable_digest_pinned: registration.executable_digest ?? null,
		script_path: registration.script_path ?? null,
		script_digest_now: null,
		script_digest_pinned: registration.script_digest ?? null,
		interpreter: null,
	};
	if (typeof registration.script_path === "string" && registration.script_path) {
		if (!existsSync(registration.script_path)) return { ok: false, reason: "registered script_path is missing", ...info };
		// Re-hash the REAL script body so a symlink swap is visible before running.
		const real = resolve(registration.script_path);
		info.script_path_real = real;
		info.script_digest_now = executableDigest(real);
		// Also hash what a symlink points at, if it is a symlink, so an escape is
		// surfaced as a mismatch rather than silently accepted.
		try {
			info.script_bytes = readFileSync(real).length;
		} catch {
			return { ok: false, reason: "registered script_path is unreadable", ...info };
		}
	}
	info.pins_match =
		info.executable_digest_now === info.executable_digest_pinned &&
		(info.script_digest_now === null || info.script_digest_now === info.script_digest_pinned);
	return { ok: info.pins_match, reason: info.pins_match ? "registered pins match the current files" : "registered file(s) changed since registration; a new version and re-verification are required", ...info };
}

export { executableDigest };
