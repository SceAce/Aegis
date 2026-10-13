// Aegis D: Evidence resolver — the ONE trusted mapping from a committed EventLog
// (+ its effective board projection) to REAL records that the Compiler / Router /
// Contribution gates can resolve proof against.
//
// Why this module exists (D task): the batch-B Compiler/Router/Contribution
// gates require a `resolveSupport({kind, ref, ref_key})` resolver that returns a
// REAL record. Until now the only resolver in the tree was built by the same
// caller that supplied the proof, so a caller could fabricate a proof and a
// matching Map at the same time. This module builds the resolver from the
// ALREADY-COMMITTED, hash-chained event history and the canonical effective
// board projection, so proof is confirmed against the same state source the
// Observer/Host use — not a second demo schema.
//
// Trust rules (fail closed):
//   * The chain must verify (`verifyChain`). A corrupt/unknown-version log
//     resolves NOTHING (`ok:false` for every query).
//   * Only events whose `source.kind` is a trusted runtime kind are indexed.
//     `llm` events are NEVER evidence. `runtime`/`observer` structure events are
//     trusted for STRUCTURE (episode/session bookkeeping); a task VERDICT still
//     requires a successful, oracle-attributed Outcome, enforced downstream by
//     the Compiler's `proof_success`/`proof_oracle` rules. This resolver does not
//     add a second verdict gate; it refuses to resolve an `llm` record at all.
//   * An Outcome superseded (or stale) in the effective view is NOT resolvable.
//   * A ref that pins a `digest` must match the REAL computed content digest.
//   * A foreign-episode / foreign-task record is not resolvable when the
//     resolver is bound to a task scope.
//   * An arbitrary object handed in by a caller is NOT evidence; the resolver
//     only reads its own committed index.
//
// The resolver is a TRUSTED LIBRARY API. It takes no callback, no model text,
// and no caller-provided record map. The model must never be able to pass a
// resolver or a callback (the workflow engine only ever passes this one).

import { projectBoard } from "./board.mjs";
import { digest, verifyChain } from "./events.mjs";
import { projectState } from "./state.mjs";

// Source kinds that may contribute a resolvable record. `llm` is excluded by
// construction (it is the model). This is a subset of `events.mjs SOURCE_KINDS`.
const TRUSTED_SOURCE_KINDS = new Set(["agent", "environment", "observer", "oracle", "replay", "human", "runtime"]);
// A task VERDICT may only enter the index from a source that can actually
// attest it. A `runtime`/`agent` oracle-SHAPED payload is a claim, not proof.
const OUTCOME_SOURCE_KINDS = new Set(["oracle", "human"]);
const OUTCOME_STATUS_VALUES = new Set(["success", "failure", "unknown", "invalid"]);
// A replay is only real evidence when the trusted replay adapter recorded an
// ISOLATED execution; a runtime/model `replayable:true` note is data.
const REPLAY_SOURCE_KIND = "replay";
// A reset/isolation reference must be recorded by a trusted, non-model source.
// `agent` is intentionally excluded: an agent may drive actions but the reset
// proof itself must come from the runtime, a human, or an Oracle.
const RESET_SOURCE_KINDS = new Set(["runtime", "observer", "oracle", "human", "replay", "environment"]);

function idOf(ref) {
	return ref?.ref_id ?? ref?.id ?? null;
}

function kindOf(ref) {
	return ref?.ref_type ?? ref?.type ?? null;
}

function refKey(ref) {
	if (!ref || typeof ref !== "object") return null;
	return `${kindOf(ref) ?? ""}:${idOf(ref) ?? ""}`;
}

function tuple(record) {
	return {
		run_id: record?.run_id ?? null,
		episode_id: record?.episode_id ?? null,
		independence_group: record?.independence_group ?? null,
		isolation_ref: record?.isolation_ref ?? null,
	};
}

/**
 * The content digest of a committed observation/artifact value, computed from
 * the REAL value using the runtime's documented convention (`file_digest` /
 * `stdout_digest` for a private file/stream, otherwise the structured value).
 * The resolver NEVER echoes a payload's claimed `content_digest` back.
 */
function committedContentDigest(value) {
	if (value && typeof value === "object") {
		if (typeof value.file_digest === "string" && value.file_digest) return value.file_digest;
		if (typeof value.stdout_digest === "string" && value.stdout_digest) return value.stdout_digest;
	}
	return digest(value);
}

/**
 * Build a trusted resolver over a committed event history.
 *
 * @param {object} input
 * @param {object[]} input.events     the committed events (e.g. `eventLog.replay()`)
 * @param {object} [input.board]      a board projection; rebuilt from `events` when absent
 * @param {object} [input.state]      a RuntimeState projection; rebuilt from `events` when absent
 * @param {{task_id?:string, episode_ids?:string[]}} [input.scope]  trusted task binding:
 *   when set, a record from another task/episode resolves to `{ok:false}` ("foreign")
 */
export function createEvidenceResolver({ events = [], board = null, state = null, scope = null } = {}) {
	const verification = verifyChain(events);
	const errors = [...verification.errors];
	const chainOk = verification.ok;
	// Fail closed: an invalid chain resolves nothing. There is deliberately NO
	// `requireChainOk:false` bypass — a caller must never trade the committed
	// chain check for convenience.
	const resolvable = chainOk;

	const scopeTaskId = scope?.task_id ?? null;
	const scopeEpisodeIds = Array.isArray(scope?.episode_ids) ? new Set(scope.episode_ids) : null;

	const effectiveBoard = board ?? projectBoard(events);
	const effectiveState = state ?? projectState(events);
	const superseded = new Set(effectiveBoard.effective?.superseded_outcome_ids ?? []);
	const staleNodeIds = new Set(effectiveBoard.effective?.stale_node_ids ?? []);

	// Index the committed events.
	const eventById = new Map();
	const eventsByEpisode = new Map();
	const trustedEvents = [];
	for (const event of events) {
		if (!event || typeof event !== "object") continue;
		eventById.set(event.event_id, event);
		if (event.episode_id) {
			if (!eventsByEpisode.has(event.episode_id)) eventsByEpisode.set(event.episode_id, []);
			eventsByEpisode.get(event.episode_id).push(event);
		}
		if (TRUSTED_SOURCE_KINDS.has(event.source?.kind)) trustedEvents.push(event);
	}

	// ----- Outcome index (full Outcome payloads only) --------------------------
	// The runtime Observer records the WHOLE outcome object in the
	// `outcome.recorded` payload, so the resolver reads the real criterion /
	// observed / oracle / expect / evidence_refs straight from the committed log.
	const outcomes = new Map();
	for (const event of trustedEvents) {
		// C6: the Campaign Host commits Oracle verdicts as `runtime.note` with
		// `kind: campaign.oracle.result` from an `oracle` source. They carry the
		// SAME bound Outcome contract (id/status/criterion/observed/evidence/pin), so
		// they are indexed through this one resolver -- there is no second evidence
		// framework. The nested `payload.outcome` is the authoritative verdict object.
		if (
			event.event_type === "runtime.note" &&
			event.payload?.kind === "campaign.oracle.result" &&
			OUTCOME_SOURCE_KINDS.has(event.source?.kind)
		) {
			const nested = event.payload.outcome && typeof event.payload.outcome === "object" ? event.payload.outcome : null;
			const payload = nested
				? { ...event.payload, ...nested, outcome_id: nested.outcome_id ?? event.payload.outcome_id }
				: event.payload;
			if (payload?.oracle === undefined && event.payload?.oracle) payload.oracle = event.payload.oracle;
			indexOutcome({ event, payload, outcomes });
			continue;
		}
		if (event.event_type !== "outcome.recorded") continue;
		// A verdict is only evidence when an oracle/human RECORDED it. A runtime or
		// agent oracle-shaped payload is a claim, never proof.
		if (!OUTCOME_SOURCE_KINDS.has(event.source?.kind)) continue;
		indexOutcome({ event, payload: event.payload || {}, outcomes });
	}

	function indexOutcome({ event, payload, outcomes }) {
		const outcomeId = payload.outcome_id;
		if (typeof outcomeId !== "string" || !outcomeId) return;
		if (outcomes.has(outcomeId)) return; // first occurrence wins
		const evidenceRefs =
			Array.isArray(payload.evidence_refs) && payload.evidence_refs.length > 0
				? payload.evidence_refs
				: Array.isArray(event.evidence_refs)
					? event.evidence_refs
					: [];
		const record = {
			outcome_id: outcomeId,
			episode_id: event.episode_id ?? payload.episode_id ?? null,
			run_id: payload.run_id ?? null,
			level: payload.level ?? null,
			status: payload.status ?? null,
			criterion: payload.criterion ?? null,
			observed: payload.observed ?? null,
			oracle: payload.oracle ?? null,
			action_ref: payload.action_ref ?? null,
			action_version: payload.action_version ?? null,
			implementation_digest: payload.implementation_digest ?? null,
			expect: payload.expect ?? payload.expected ?? null,
			when: Array.isArray(payload.when) ? payload.when : null,
			evidence_refs: evidenceRefs,
			transport: payload.transport ?? null,
			failure_mode: payload.failure_mode ?? null,
			preconditions_verified: payload.preconditions_verified === true,
			supersedes: payload.supersedes ?? null,
			scope: payload.scope ?? payload.environment_fingerprint ?? null,
			source_kind: event.source?.kind ?? null,
			event_id: event.event_id,
			recorded_at: event.recorded_at ?? null,
		};
		// Only a complete, auditable Outcome is indexed: valid status, a criterion,
		// evidence, and (for a success/failure) a real observed value.
		if (!OUTCOME_STATUS_VALUES.has(record.status)) return;
		if (!record.criterion || typeof record.criterion !== "object") return;
		if (record.evidence_refs.length === 0) return;
		if (
			(record.status === "success" || record.status === "failure") &&
			(record.observed === null || record.observed === undefined || record.observed === "")
		)
			return;
		outcomes.set(outcomeId, record);
	}

	// ----- Episode index (structure + canonical reset relation) ----------------
	const episodes = new Map();
	for (const event of trustedEvents) {
		if (event.event_type !== "episode.started") continue;
		const episodeId = event.episode_id;
		if (!episodeId || episodes.has(episodeId)) continue;
		const payload = event.payload || {};
		episodes.set(episodeId, {
			episode_id: episodeId,
			task_id: payload.task_id ?? episodeId,
			run_id: payload.run_id ?? null,
			goal: payload.goal ?? null,
			scope: payload.scope ?? payload.environment_fingerprint ?? null,
			source_kind: event.source?.kind ?? "runtime",
			started_event_id: event.event_id,
			started_at: event.recorded_at ?? null,
			// A reset/isolation reference is ONLY canonical when a trusted source
			// RECORDED it — never synthesised from the episode id (a UUID would
			// satisfy an independence count without proving a reset).
			isolated_reset: null,
			independence_group:
				typeof payload.independence_group === "string" && payload.independence_group
					? payload.independence_group
					: null,
		});
		// A fixture-shaped episode.started may carry the reset fields directly; but
		// only a RESET_SOURCE_KIND may supply them (payload is untrusted for a
		// model-authored event).
		if (RESET_SOURCE_KINDS.has(event.source?.kind)) {
			const isolationRef = payload.isolation_ref ?? payload.reset_nonce ?? null;
			if (typeof isolationRef === "string" && isolationRef) {
				episodes.get(episodeId).isolated_reset = {
					isolation_ref: isolationRef,
					event_id: event.event_id,
					source_kind: event.source.kind,
					adapter: payload.adapter ?? null,
				};
			}
		}
	}
	// C6: the Campaign Host commits `campaign.task.started` (runtime.note) with the
	// bound episode at the event level. Index it as an episode so a Campaign
	// Outcome resolves to a REAL episode (the compiler's independence gate needs
	// it). It carries no reset proof by itself; a reset must still be recorded by
	// a trusted source below.
	for (const event of trustedEvents) {
		if (event.event_type !== "runtime.note" || event.payload?.kind !== "campaign.task.started") continue;
		const episodeId = event.episode_id ?? event.payload?.episode_id;
		if (!episodeId || episodes.has(episodeId)) continue;
		if (!TRUSTED_SOURCE_KINDS.has(event.source?.kind)) continue;
		episodes.set(episodeId, {
			episode_id: episodeId,
			task_id: event.payload?.task_id ?? episodeId,
			run_id: null,
			goal: null,
			scope: null,
			source_kind: event.source?.kind ?? "runtime",
			started_event_id: event.event_id,
			started_at: event.recorded_at ?? null,
			isolated_reset: null,
			independence_group: null,
		});
	}

	// Explicit reset notes attach the canonical relation to an episode.
	for (const event of trustedEvents) {
		const episodeId = event.episode_id;
		if (!episodeId || !episodes.has(episodeId)) continue;
		if (!RESET_SOURCE_KINDS.has(event.source?.kind)) continue;
		const payload = event.payload || {};
		if (payload.kind !== "episode.isolated_reset") continue;
		const isolationRef = payload.isolation_ref ?? payload.reset_nonce ?? null;
		if (typeof isolationRef !== "string" || !isolationRef) continue;
		const record = episodes.get(episodeId);
		record.isolated_reset = {
			isolation_ref: isolationRef,
			event_id: event.event_id,
			source_kind: event.source.kind,
			adapter: payload.adapter ?? null,
		};
		if (typeof payload.independence_group === "string" && payload.independence_group)
			record.independence_group = payload.independence_group;
		if (typeof payload.run_id === "string" && payload.run_id) record.run_id = payload.run_id;
	}

	// ----- Action index (paired by execution action_id, aliased by action_ref) --
	// Each execution is keyed by its action_id and pairs an exact same-episode
	// request/completion. An action_ref is only an alias to the FIRST execution
	// seen, so a later episode's completion can never overwrite it. The requested
	// version/digest/args are authoritative and are never replaced by a completion.
	const actions = new Map();
	const actionAliases = new Map();
	const putAlias = (actionRef, actionId) => {
		if (typeof actionRef !== "string" || !actionRef || !actionId) return;
		const list = actionAliases.get(actionRef);
		if (list) {
			if (!list.includes(actionId)) list.push(actionId);
		} else {
			actionAliases.set(actionRef, [actionId]);
		}
	};
	for (const event of trustedEvents) {
		const payload = event.payload || {};
		if (event.event_type === "action.requested") {
			const actionId = payload.action_id ?? payload.action_ref ?? null;
			if (!actionId || actions.has(actionId)) continue;
			const actionRef = payload.action_ref ?? null;
			actions.set(actionId, {
				action_id: actionId,
				action_ref: actionRef,
				version: payload.version ?? null,
				implementation_digest: payload.implementation_digest ?? null,
				episode_id: event.episode_id ?? null,
				run_id: payload.run_id ?? null,
				tool_name: payload.tool_name ?? null,
				bound_arguments: Array.isArray(payload.bound_arguments) ? [...payload.bound_arguments] : [],
				observation: null,
				status: "requested",
				requested_event_id: event.event_id,
				completed_event_id: null,
			});
			putAlias(actionRef, actionId);
		} else if (event.event_type === "action.completed") {
			const actionId = payload.action_id ?? payload.action_ref ?? null;
			if (!actionId) continue;
			const record = actions.get(actionId);
			if (!record) {
				// A completion with no request is kept, but its request-owned
				// identity (version/digest/args) is NOT back-filled from the completion.
				const orphan = {
					action_id: actionId,
					action_ref: payload.action_ref ?? null,
					version: null,
					implementation_digest: null,
					episode_id: event.episode_id ?? null,
					run_id: payload.run_id ?? null,
					tool_name: payload.tool_name ?? null,
					bound_arguments: [],
					observation: payload.observation ?? null,
					status: "completion_without_request",
					requested_event_id: null,
					completed_event_id: event.event_id,
				};
				actions.set(actionId, orphan);
				putAlias(orphan.action_ref, actionId);
				continue;
			}
			const sameEpisode = record.episode_id === (event.episode_id ?? null);
			const versionMatches =
				payload.version === undefined ||
				payload.version === null ||
				record.version === null ||
				payload.version === record.version;
			const digestMatches =
				payload.implementation_digest === undefined ||
				payload.implementation_digest === null ||
				record.implementation_digest === null ||
				payload.implementation_digest === record.implementation_digest;
			if (sameEpisode && versionMatches && digestMatches) {
				if (record.status !== "completed") {
					record.status = "completed";
					record.completed_event_id = event.event_id;
					record.observation = payload.observation ?? null;
				}
			} else if (record.status !== "completed") {
				// A foreign-episode or identity-mismatched completion must not
				// overwrite the requested record.
				record.status = "unpaired";
			}
		}
		if (payload.kind === "data.use.bound") {
			const actionRef =
				idOf(payload.action_ref) ?? (typeof payload.action_ref === "string" ? payload.action_ref : null);
			const actionId = idOf(payload.action_id) ?? (typeof payload.action_id === "string" ? payload.action_id : null);
			const dataRef = payload.data_ref ?? null;
			const aliasIds = actionRef ? (actionAliases.get(actionRef) ?? []) : [];
			const targetId = actionId ?? aliasIds[0] ?? null;
			const record = targetId ? actions.get(targetId) : null;
			if (record && dataRef) record.bound_arguments = [...(record.bound_arguments ?? []), dataRef];
		}
	}

	// ----- Artifact index ------------------------------------------------------
	// A pinned artifact ref carries a real content digest, so the index keeps a
	// digest-keyed secondary map: two runs of the SAME action can produce the same
	// fixed artifact ref id with different digests, and a proof pinning either
	// digest must resolve to the matching record — not merely the latest by id.
	const artifacts = new Map();
	const artifactsByDigest = new Map();
	const putArtifact = (artifactId, record) => {
		if (!artifactId) return;
		artifacts.set(artifactId, record);
		if (typeof record.content_digest === "string" && record.content_digest)
			artifactsByDigest.set(`${artifactId}#${record.content_digest}`, record);
	};
	for (const event of trustedEvents) {
		const payload = event.payload || {};
		if (event.event_type === "observation.captured") {
			const value = payload.value ?? null;
			const artifactId = idOf(payload.artifact_ref) ?? payload.artifact_id ?? `${event.event_id}:value`;
			const contentDigest = committedContentDigest(value);
			putArtifact(artifactId, {
				artifact_id: artifactId,
				episode_id: event.episode_id ?? null,
				run_id: payload.run_id ?? null,
				kind: payload.observation_kind ?? payload.kind ?? "observation",
				subject: payload.subject ?? null,
				value,
				verified: payload.verified === true,
				// Computed from the committed value; a claimed digest that disagrees is
				// recorded as a mismatch and can never be resolved as proof.
				content_digest: contentDigest,
				digest_mismatch:
					typeof payload.content_digest === "string" &&
					payload.content_digest.length > 0 &&
					payload.content_digest !== contentDigest,
				event_id: event.event_id,
			});
		}
		if (payload.kind === "artifact.recorded" && payload.artifact_id) {
			const value = payload.value ?? null;
			const contentDigest = committedContentDigest(value);
			putArtifact(payload.artifact_id, {
				artifact_id: payload.artifact_id,
				episode_id: event.episode_id ?? null,
				run_id: payload.run_id ?? null,
				kind: payload.artifact_kind ?? "artifact",
				value,
				content_digest: contentDigest,
				digest_mismatch:
					typeof payload.content_digest === "string" &&
					payload.content_digest.length > 0 &&
					payload.content_digest !== contentDigest,
				event_id: event.event_id,
			});
		}
		// C6: the Campaign Broker commits the REAL effect artifact on
		// `action.completed` with a content digest. Index it so a Campaign Outcome's
		// artifact evidence ref resolves to the same record the Oracle re-read.
		if (event.event_type === "action.completed" && typeof payload.evidence_ref === "string" && payload.evidence_ref) {
			const contentDigest = typeof payload.content_digest === "string" ? payload.content_digest : null;
			putArtifact(payload.evidence_ref, {
				artifact_id: payload.evidence_ref,
				episode_id: event.episode_id ?? payload.episode_id ?? null,
				run_id: null,
				kind: "action_effect",
				value: payload.observed ?? null,
				content_digest: contentDigest,
				digest_mismatch: false,
				event_id: event.event_id,
			});
		}
	}

	// ----- Replay index (explicit isolated-replay records only) ----------------
	// A replay record is only created by a trusted replay note the workflow
	// engine writes AFTER it actually performed an isolated replay. A producer's
	// own `replayable:true` flag on an outcome is data, not a record.
	const replays = new Map();
	for (const event of trustedEvents) {
		const payload = event.payload || {};
		if (payload.kind !== "replay.performed") continue;
		// Only a trusted replay adapter's ACTUAL isolated execution is evidence.
		// A runtime/model note that merely asserts `replayable:true` is a claim.
		if (event.source?.kind !== REPLAY_SOURCE_KIND) continue;
		if (payload.isolated !== true) continue;
		if (typeof payload.adapter !== "string" || !payload.adapter) continue;
		const replayId =
			payload.replay_id ??
			(payload.episode_id || event.episode_id
				? `replay:${payload.episode_id ?? event.episode_id}:${payload.outcome_id}`
				: null);
		if (!replayId) continue;
		replays.set(replayId, {
			replay_id: replayId,
			episode_id: payload.episode_id ?? event.episode_id ?? null,
			outcome_id: payload.outcome_id ?? null,
			replayable: payload.replayable === true,
			replay_count: Number.isInteger(payload.replay_count) ? payload.replay_count : 0,
			replay_hash: payload.replay_hash ?? null,
			isolated: payload.isolated === true,
			adapter: payload.adapter ?? null,
			pre_state_digest: payload.pre_state_digest ?? null,
			post_state_digest: payload.post_state_digest ?? null,
			implementation_digest: payload.implementation_digest ?? null,
			event_id: event.event_id,
		});
	}

	// ----- Obtained-data index -------------------------------------------------
	const data = new Map();
	for (const event of trustedEvents) {
		const payload = event.payload || {};
		if (payload.kind !== "data.obtained") continue;
		const dataRef = payload.data_ref ?? {};
		const dataId = idOf(dataRef) ?? payload.data_id ?? null;
		if (!dataId) continue;
		const value = payload.value ?? null;
		// The digest is derived from the REAL value when one was committed; a
		// claimed `content_digest` alone is never echoed back as the record digest.
		const contentDigest = value === null || value === undefined ? null : committedContentDigest(value);
		const claimedDigest =
			typeof payload.content_digest === "string"
				? payload.content_digest
				: typeof dataRef.digest === "string"
					? dataRef.digest
					: null;
		data.set(dataId, {
			data_id: dataId,
			episode_id: event.episode_id ?? null,
			ref_type: kindOf(dataRef) ?? "data",
			value,
			content_digest: contentDigest,
			digest_mismatch: contentDigest !== null && claimedDigest !== null && claimedDigest !== contentDigest,
			value_digest: payload.value_digest ?? null,
			source: payload.source ?? null,
			event_id: event.event_id,
		});
	}

	/**
	 * Canonical episode relation. Distinguishes an OPEN/PROJECTED episode (an
	 * ordinary RuntimeState initial episode object — no recorded reset proof)
	 * from an episode with a REAL canonical reset relation. A missing reset stays
	 * a `candidate`; we never invent a UUID to satisfy an independence count.
	 */
	function episodeRelation(episodeId) {
		const episode = episodes.get(episodeId);
		if (!episode) return { ok: false, episode_id: episodeId ?? null, reason: "unknown episode", candidate: true };
		const hasReset = Boolean(episode.isolated_reset?.isolation_ref);
		return {
			ok: hasReset,
			episode_id: episodeId,
			task_id: episode.task_id,
			source_kind: episode.source_kind,
			status: hasReset ? "canonical" : "candidate",
			candidate: !hasReset,
			reason: hasReset
				? "trusted isolation reset recorded"
				: "no trusted isolation/reset proof was recorded; the episode remains a projected candidate and cannot count toward independence",
			independence_group: episode.independence_group,
			isolation_ref: hasReset ? episode.isolated_reset.isolation_ref : null,
			reset_event_id: hasReset ? episode.isolated_reset.event_id : null,
		};
	}

	/** True when a record belongs to the bound task scope (if any). */
	function inScope(recordEpisodeId) {
		if (!scopeTaskId && !scopeEpisodeIds) return true;
		if (recordEpisodeId && scopeEpisodeIds?.has(recordEpisodeId)) return true;
		if (recordEpisodeId && episodes.has(recordEpisodeId)) {
			const episode = episodes.get(recordEpisodeId);
			if (scopeTaskId && episode.task_id === scopeTaskId) return true;
			if (scopeEpisodeIds?.has(recordEpisodeId)) return true;
			return false;
		}
		return false;
	}

	/** Resolve ONE reference against the committed index. Never consults caller data. */
	function resolveSupport({ kind, ref } = {}) {
		if (!resolvable) return { ok: false, reason: `event chain is not verified; refusing to resolve ${String(kind)}` };
		if (!ref || typeof ref !== "object") return { ok: false, reason: "no ref object supplied" };
		const id = idOf(ref);
		if (!id) return { ok: false, reason: "ref has no ref_id" };
		const wantedKind = kind ?? kindOf(ref);

		// A ref may pin the episode it must belong to; a mismatch is foreign.
		const pinnedEpisode = ref.episode_id ?? null;

		/** Shared digest check: a pinned digest must match the real content. */
		const finish = (result) => {
			if (!result.ok) return result;
			const record = result.record;
			// A record retired by a trusted environment change (stale) is not proof.
			// The board's effective view names stale nodes by node_id (`ev:<event>`).
			const originEventId =
				record?.event_id ??
				(wantedKind === "action" ? (record?.completed_event_id ?? record?.requested_event_id) : null) ??
				null;
			if (originEventId && staleNodeIds.has(`ev:${originEventId}`)) {
				return { ok: false, reason: `${wantedKind} record is stale in the current effective view` };
			}
			if (record?.digest_mismatch) {
				return { ok: false, reason: `${wantedKind} committed content does not match its recorded content_digest` };
			}
			const recordEpisode = record?.episode_id ?? null;
			const scopeEpisode = record?.scope_episode_id ?? recordEpisode;
			if (pinnedEpisode && recordEpisode && pinnedEpisode !== recordEpisode) {
				return {
					ok: false,
					reason: `foreign reference: ref pins episode ${pinnedEpisode} but the record belongs to ${recordEpisode}`,
				};
			}
			if (!inScope(scopeEpisode))
				return { ok: false, reason: "foreign reference: record is outside the bound task scope" };
			if (ref.digest !== undefined && ref.digest !== null) {
				const contentDigest = result.content_digest ?? record?.content_digest ?? null;
				if (contentDigest !== ref.digest)
					return { ok: false, reason: `${wantedKind} content_digest does not match the ref digest` };
			}
			return result;
		};

		if (wantedKind === "outcome") {
			const record = outcomes.get(id);
			if (!record) return { ok: false, reason: `no committed outcome record for ${id}` };
			if (superseded.has(id))
				return { ok: false, reason: `outcome ${id} was superseded in the current effective view` };
			return finish({ ok: true, record, content_digest: digest(record.observed) });
		}

		if (wantedKind === "episode") {
			const episode = episodes.get(id);
			if (!episode) return { ok: false, reason: `no committed episode record for ${id}` };
			const relation = episodeRelation(id);
			// The record always carries the canonical relation so the Compiler sees a
			// CANDIDATE (no reset proof) rather than a fabricated UUID.
			const record = {
				episode_id: episode.episode_id,
				task_id: episode.task_id,
				run_id: episode.run_id,
				independence_group: relation.independence_group,
				isolation_ref: relation.isolation_ref,
				reset_proven: relation.ok,
				relation_status: relation.status,
			};
			return finish({ ok: true, record, content_digest: digest(tuple(record)) });
		}

		if (wantedKind === "action") {
			const direct = actions.get(id);
			if (direct) {
				if (
					ref.version !== undefined &&
					ref.version !== null &&
					direct.version !== null &&
					ref.version !== direct.version
				) {
					return {
						ok: false,
						reason: `action version ${direct.version} does not match the pinned version ${ref.version}`,
					};
				}
				return finish({
					ok: true,
					record: direct,
					content_digest: digest({ action_ref: direct.action_ref, version: direct.version, status: direct.status }),
				});
			}
			// Resolve an action_ref across its executions. A single execution resolves
			// directly; multiple executions may only resolve when they agree on the
			// pinned identity (version/digest). They are never collapsed by `overwrite`.
			const family = (actionAliases.get(id) ?? []).map((actionId) => actions.get(actionId)).filter(Boolean);
			if (family.length === 0) return { ok: false, reason: `no committed action record for ${id}` };
			const scoped = pinnedEpisode
				? family.filter((record) => record.episode_id === null || record.episode_id === pinnedEpisode)
				: family;
			if (scoped.length === 0)
				return { ok: false, reason: `no committed action record for ${id} in episode ${pinnedEpisode}` };
			const versions = new Set(scoped.map((record) => record.version));
			const digests = new Set(scoped.map((record) => record.implementation_digest));
			if (scoped.length > 1 && (versions.size > 1 || digests.size > 1)) {
				return {
					ok: false,
					reason: `action_ref ${id} is ambiguous across episodes with different version/digest; pin action_id or episode_id`,
				};
			}
			if (!scoped.every((record) => inScope(record.episode_id))) {
				return {
					ok: false,
					reason: "foreign reference: one or more action executions are outside the bound task scope",
				};
			}
			const aggregate = {
				action_id: id,
				action_ref: id,
				version: versions.size === 1 ? [...versions][0] : null,
				implementation_digest: digests.size === 1 ? [...digests][0] : null,
				episode_id: scoped.length === 1 ? scoped[0].episode_id : null,
				scope_episode_id: scoped[0].episode_id ?? null,
				status: scoped.every((record) => record.status === "completed") ? "completed" : "pending",
				bound_arguments: scoped.flatMap((record) => record.bound_arguments ?? []),
				requested_event_id: scoped.length === 1 ? scoped[0].requested_event_id : null,
				completed_event_id: scoped.length === 1 ? scoped[0].completed_event_id : null,
			};
			if (
				ref.version !== undefined &&
				ref.version !== null &&
				aggregate.version !== null &&
				ref.version !== aggregate.version
			) {
				return {
					ok: false,
					reason: `action version ${aggregate.version} does not match the pinned version ${ref.version}`,
				};
			}
			return finish({
				ok: true,
				record: aggregate,
				content_digest: digest({
					action_ref: aggregate.action_ref,
					version: aggregate.version,
					status: aggregate.status,
				}),
			});
		}

		if (wantedKind === "artifact") {
			const record = ref.digest ? artifactsByDigest.get(`${id}#${ref.digest}`) : artifacts.get(id);
			if (!record)
				return {
					ok: false,
					reason: ref.digest
						? `no committed artifact record for ${id} with the pinned digest`
						: `no committed artifact record for ${id}`,
				};
			return finish({ ok: true, record, content_digest: record.content_digest });
		}

		if (wantedKind === "data") {
			const record = data.get(id);
			if (!record) return { ok: false, reason: `no committed data record for ${id}` };
			return finish({ ok: true, record, content_digest: record.content_digest });
		}

		if (wantedKind === "replay") {
			const record = replays.get(id);
			if (!record) return { ok: false, reason: `no committed replay record for ${id}` };
			return finish({ ok: true, record, content_digest: record.replay_hash ?? digest(tuple(record)) });
		}

		if (wantedKind === "event") {
			const record = eventById.get(id);
			if (!record) return { ok: false, reason: `no committed event for ${id}` };
			if (record.source?.kind === "llm") return { ok: false, reason: "an llm event is never evidence" };
			return finish({
				ok: true,
				record: {
					event_id: record.event_id,
					event_type: record.event_type,
					episode_id: record.episode_id ?? null,
					source_kind: record.source?.kind ?? null,
					payload: record.payload ?? null,
				},
				content_digest: digest(record.payload ?? null),
			});
		}

		return { ok: false, reason: `unsupported ref kind: ${String(wantedKind)}` };
	}

	return {
		ok: chainOk,
		errors,
		chain_ok: chainOk,
		resolveSupport,
		getOutcome: (id) => outcomes.get(id) ?? null,
		getEpisode: (id) => episodes.get(id) ?? null,
		getAction: (id) => actions.get(id) ?? null,
		getArtifact: (id) => artifacts.get(id) ?? null,
		getReplay: (id) => replays.get(id) ?? null,
		getData: (id) => data.get(id) ?? null,
		getEvent: (id) => eventById.get(id) ?? null,
		episodeRelation,
		supersededOutcomeIds: [...superseded],
		eventsByEpisode: (episodeId) => eventsByEpisode.get(episodeId) ?? [],
		board: effectiveBoard,
		state: effectiveState,
		scope,
		index: { outcomes, episodes, actions, artifacts, replays, data, events: eventById },
	};
}

/**
 * Build the trusted environment object the Compiler/Router expect: the ONE
 * resolver plus the current effective view. Only verified effective data may be
 * routed — the environment carries no fabricated candidate support.
 */
export function evidenceEnvironment(
	resolver,
	{ environment_fingerprint = null, domain = null, permissions, task_types, registry = null } = {},
) {
	return {
		environment_fingerprint,
		domain,
		permissions,
		task_types,
		registry,
		resolveSupport: resolver.resolveSupport,
	};
}

export { refKey, idOf, kindOf };
