// Proposal references are display associations, never proof or execution grants.
/** Validate refs against THIS committed Episode prefix and effective Board. */
export function inspectProposalRefs(refs, { events, board, episodeId }) {
	if (!Array.isArray(refs) || refs.length > 12)
		return { ok: false, reason: "source_refs must be an array of at most 12 refs", refs: [] };
	const nodes = board?.nodes ?? [];
	const out = [];
	for (const ref of refs) {
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
		if (!row || row.episode_id !== episodeId || !node || node.effective === false)
			return { ok: false, reason: `source ref is missing, foreign or ineffective: ${id}`, refs: [] };
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
