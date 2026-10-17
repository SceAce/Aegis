import assert from "node:assert/strict";
import { buildE1Explorer, parseExplorerQuery } from "../observation/e1-explorer.mjs";
import { buildE1View } from "../observation/e1-observation.mjs";

const manifest = { campaign_id: "campaign-pages", revision: 1, tasks: [], objective: { description: "inspect" } };
const events = Array.from({ length: 230 }, (_, i) => ({
	event_type: "proposal.submitted",
	episode_id: "ep-page",
	event_id: `p-${i}`,
	source: { kind: "llm" },
	payload: { kind: "claim", node_kind: "hint", text: `claim ${i}` },
	recorded_at: "2026-01-01T00:00:00Z",
	event_digest: `sha256:${i}`,
}));
const view = buildE1View({ manifest, events });
const first = buildE1Explorer({
	manifest,
	events,
	board: { ...view.board, truncated: true },
	query: { kind: "board", page_size: 30 },
});
assert.equal(first.ok, true);
assert.equal(first.total, 230);
assert.equal(first.nodes.length, 30);
const second = buildE1Explorer({
	manifest,
	events,
	board: { ...view.board, truncated: true },
	query: { kind: "board", page_size: 30, cursor: first.next_cursor },
});
assert.equal(second.ok, true);
assert.equal(second.offset, 30);
assert.equal(new Set([...first.nodes, ...second.nodes].map((n) => n.node_id)).size, 60);
const changedFilter = buildE1Explorer({
	manifest,
	events,
	query: { kind: "board", q: "claim", cursor: first.next_cursor },
});
assert.equal(changedFilter.ok, false);
assert.equal(parseExplorerQuery({ page_size: "-1" }).ok, false);
assert.equal(parseExplorerQuery({ path: "/tmp/private" }).ok, false);
const changed = buildE1Explorer({
	manifest,
	events: [...events, { ...events[0], event_id: "new", event_digest: "different" }],
	query: { kind: "board", since_state_revision: first.version.state_revision },
});
assert.equal(changed.version.state_changed, true);
console.log("E1 explorer: full board paging, cursor filters, query rejection and committed revision change passed");
