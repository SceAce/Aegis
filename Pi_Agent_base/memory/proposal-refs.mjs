// Proposal references are display associations, never proof or execution grants.

/**
 * Resolve one RAM reference alias to a committed event/node/action ref. The
 * model sees the alias in RAM, either as a bare string or inside the canonical
 * ref object; both forms must resolve to the same committed identity.
 *
 * RAM rows expose several alias kinds. Only event/action/node/outcome are
 * evidence identities. A `knowledge` alias names a RETRIEVED document, which is
 * not an event id, so citing it used to fall through to the literal-string path
 * and be rejected as "missing or foreign" — a misleading diagnosis for a handle
 * RAM itself printed. Such aliases carry `eventId` (the `runtime.note` that
 * recorded the selection) so their citation resolves to that auditable event.
 */
function resolveAlias(rawRef, aliases, { events, nodes, episodeId }) {
	// A model may wrap an alias in the same object shape used for canonical
	// refs: {ref_type:"event",ref_id:"r7"}. Resolve that shape as well instead of
	// treating "r7" as a literal event id. Canonical objects still pass through.
	const aliasId =
		typeof rawRef === "string"
			? rawRef
			: rawRef && typeof rawRef === "object" && typeof rawRef.ref_id === "string"
				? rawRef.ref_id
				: null;
	if (!aliasId || !aliases || !Object.hasOwn(aliases, aliasId)) return rawRef;
	const alias = aliases[aliasId];
	if (!alias) return rawRef;
	// Non-evidence aliases (knowledge retrieval, external documents) resolve to
	// the event that recorded them. They still pass the same Episode/effectiveness
	// check below, so this cannot turn retrieval material into proof.
	if (typeof alias.eventId === "string" && alias.eventId) {
		const event = events.find((entry) => entry.event_id === alias.eventId && entry.episode_id === episodeId);
		return event
			? { ref_type: "event", ref_id: alias.eventId, ...(event.event_digest ? { digest: event.event_digest } : {}) }
			: rawRef;
	}
	if (typeof alias.id !== "string" || !alias.id) return rawRef;
	if (alias.type === "event" || alias.type === "action")
		return { ref_type: alias.type, ref_id: alias.id, ...(alias.digest ? { digest: alias.digest } : {}) };
	if (alias.type === "node" || alias.type === "outcome") {
		const node = nodes.find(
			(entry) =>
				entry.node_id === alias.id ||
				entry.origin_event_id === alias.id ||
				`ev:${entry.origin_event_id}` === alias.id ||
				(alias.type === "outcome" && entry.outcome_id === alias.id),
		);
		const eventId = node?.origin_event_id;
		if (!eventId) return rawRef;
		const event = events.find((entry) => entry.event_id === eventId && entry.episode_id === episodeId);
		return event
			? { ref_type: "event", ref_id: eventId, ...(event.event_digest ? { digest: event.event_digest } : {}) }
			: rawRef;
	}
	return rawRef;
}

/** Validate refs against THIS committed Episode prefix and effective Board. */
export function inspectProposalRefs(refs, { events, board, episodeId, aliases = null }) {
	if (!Array.isArray(refs) || refs.length > 12)
		return { ok: false, reason: "source_refs must be an array of at most 12 refs", refs: [] };
	const nodes = board?.nodes ?? [];
	const out = [];
	for (const rawRef of refs) {
		const ref = resolveAlias(rawRef, aliases, { events, nodes, episodeId });
		const kind = typeof ref === "string" ? "event" : ref?.ref_type;
		const id = typeof ref === "string" ? ref : ref?.ref_id;
		if (!["event", "node", "action"].includes(kind) || typeof id !== "string" || !id || id.length > 200)
			return { ok: false, reason: "source ref requires event/node/action identity", refs: [] };
		let row;
		if (kind === "node") row = events.find((event) => `ev:${event.event_id}` === id);
		else if (kind === "action")
			row = [...events]
				.reverse()
				.find(
					(event) =>
						event.episode_id === episodeId &&
						event.payload?.action_id === id &&
						event.event_type === "action.completed",
				);
		else row = events.find((event) => event.event_id === id);
		const node = row ? nodes.find((entry) => entry.origin_event_id === row.event_id) : null;
		if (!row || row.episode_id !== episodeId || !node || node.effective === false) {
			// Distinguish the three causes that used to collapse into one message.
			// A model acting on this needs to know whether the handle was never RAM's,
			// belonged to another Episode, or was retired.
			const shown = typeof rawRef === "string" ? rawRef : rawRef?.ref_id;
			const alias = aliases && typeof shown === "string" && Object.hasOwn(aliases, shown) ? aliases[shown] : null;
			if (!row) {
				if (alias && typeof alias.eventId === "string" && alias.eventId) {
					const foreign = events.some((event) => event.event_id === alias.eventId);
					if (foreign)
						return {
							ok: false,
							reason: `source ref ${shown} was recorded in another Episode; aliases do not carry across Episodes`,
							refs: [],
						};
					return {
						ok: false,
						reason: `source ref ${shown} is a ${alias.type ?? "retrieval"} reference whose backing event is not in this Episode`,
						refs: [],
					};
				}
				if (alias?.type && !["event", "node", "action"].includes(alias.type))
					return {
						reason: `source ref ${shown} is a ${alias.type} reference, not an auditable event; cite its event ref instead`,
						refs: [],
						ok: false,
					};
				return {
					reason: `source ref ${shown} does not resolve to any committed event in this Episode`,
					refs: [],
					ok: false,
				};
			}
			if (row.episode_id !== episodeId)
				return { ok: false, reason: `source ref ${id} belongs to another Episode`, refs: [] };
			if (!node)
				return {
					ok: false,
					reason: `source ref ${id} is a committed event that creates no board node (observability row)`,
					refs: [],
				};
			return { ok: false, reason: `source ref ${id} was superseded or invalidated`, refs: [] };
		}
		if (ref?.digest && ref.digest !== row.event_digest)
			return { ok: false, reason: `source ref digest mismatch: ${id}`, refs: [] };
		out.push({ ref_type: "event", ref_id: row.event_id, ...(row.event_digest ? { digest: row.event_digest } : {}) });
	}
	return { ok: true, refs: out, reason: null };
}

/** A model can revise only its own explicit same-Episode proposal. */
export function inspectProposalReplacement(id, events, episodeId, board = null) {
	if (id === undefined || id === null) return { ok: true };
	const prior = events.find((event) => event.event_id === id);
	const node = board?.nodes?.find((entry) => entry.origin_event_id === id);
	return prior?.event_type === "proposal.submitted" &&
		prior.episode_id === episodeId &&
		prior.source?.kind === "llm" &&
		node?.episode_id === episodeId &&
		node.effective === true &&
		["Hint", "Intent"].includes(node.type)
		? { ok: true }
		: { ok: false, reason: "replace_event_id must reference an accepted effective same-Episode model proposal" };
}
