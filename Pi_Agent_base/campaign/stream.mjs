// Aegis Campaign C1 (INT-ORDER) — verified committed stream.
//
// The EventLog's verified append order is the ONLY reduce order. A per-Episode
// `event.sequence` is a LOCAL counter that resets between episodes and is `null`
// for events with no episode; it is NEVER a Campaign-global index.
//
// This module is pure and does not read the filesystem. It takes the already
// verified rows (e.g. `EventLog.replay()`) and exposes:
//   * `events`        — rows in physical append order (never re-sorted);
//   * `offsets`       — physical position of each row within the log;
//   * `tail_offset`   — offset of the LAST committed row (including rows the
//                       projection later rejects);
//   * `tail_digest`   — digest of that last committed row;
//   * `applied_tail`  — updated by the caller's reduce to the last APPLIED row
//                       (diagnostic only, never used for checkpoint tail).
//
// A bad hash chain or unknown major is refused by the EventLog itself; this
// module only asserts that the input is an ordered, indexable list.

/**
 * @param {any} args  ({rows?, campaign_id?})
 * @returns {{ok, reasons, events, offsets, tail_offset, tail_digest, tail_event_id, health}}
 */
export function buildCommittedStream({ rows = [], campaign_id = null } = {}) {
	const reasons = [];
	if (!Array.isArray(rows)) {
		return {
			ok: false,
			reasons: ["committed rows must be an array"],
			events: [],
			offsets: [],
			tail_offset: -1,
			tail_digest: "",
			tail_event_id: null,
			health: { count: 0, campaign_id },
		};
	}
	// Append order is the array order. We deliberately do NOT sort by `sequence`.
	const events = [];
	const offsets = [];
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		if (!row || typeof row !== "object") {
			reasons.push(`row at offset ${index} is not an object`);
			continue;
		}
		events.push(row);
		offsets.push(index);
	}
	const tailIndex = events.length - 1;
	return {
		ok: reasons.length === 0,
		reasons,
		events,
		offsets,
		tail_offset: tailIndex,
		tail_digest: tailIndex >= 0 ? (events[tailIndex]?.event_digest ?? "") : "",
		tail_event_id: tailIndex >= 0 ? (events[tailIndex]?.event_id ?? null) : null,
		health: { count: events.length, campaign_id },
	};
}
