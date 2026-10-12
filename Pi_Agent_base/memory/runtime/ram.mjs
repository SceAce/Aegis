// Aegis RAM: a bounded, per-request projection built from the board and
// RuntimeState. It separates verified facts from hypotheses/claims, lists
// unfinished actions and unknowns, and states its own context budget. It is an
// estimate in characters, not a tokenizer-exact count.
//
// Correctness rules (audit fixes):
//   * Only nodes of the CURRENT episode enter the RAM. Facts from a different
//     task must never leak into a new task's request.
//   * The total goal is the ORIGINAL goal from Origin/RuntimeState, not the
//     latest short prompt.
//   * Pending actions and the authorization/budget block are never silently
//     sliced away. When the budget is exceeded the RAM is shrunk by dropping
//     low-priority evidence first and it explicitly reports what was dropped.
//   * Facts/assumptions stay separated and each carries its provenance.

const DEFAULT_BUDGET = 4000;

function clip(text, limit) {
	const value = String(text ?? "").replace(/\s+/g, " ").trim();
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function nodesForEpisode(nodes, episodeId) {
	if (!episodeId) return [];
	return nodes.filter((node) => node.episode_id === episodeId);
}

/** Remove exact duplicate lines while preserving first-seen order. */
function dedupe(lines) {
	const seen = new Set();
	const out = [];
	for (const line of lines) {
		if (seen.has(line)) continue;
		seen.add(line);
		out.push(line);
	}
	return out;
}

function nodeLine(node, limit = 220) {
	const refs = Array.isArray(node.source_refs) && node.source_refs.length > 0 ? ` [${node.source_refs.slice(0, 2).join(", ")}]` : "";
	const downgraded = node.downgraded_from ? ` (downgraded from ${node.downgraded_from})` : "";
	const why = node.downgrade_reason ? ` — ${node.downgrade_reason}` : "";
	return `- ${clip(node.text, limit)}${downgraded}${why}${refs}`;
}

/**
 * @param {{board: object, state: object, episodeId: string, goal?: string, budgetChars?: number}} args
 */
export function buildRam({ board, state, episodeId, goal, budgetChars = DEFAULT_BUDGET }) {
	const episode = episodeId ? state.episodes[episodeId] : null;
	// Original goal comes from the episode's Origin/RuntimeState, not this prompt.
	const originalGoal = episode?.goal?.description || goal || "(not provided)";
	const currentPrompt = goal && goal !== originalGoal ? goal : null;

	// The EFFECTIVE view: a superseded/stale record is still auditable in
	// `board.byType`, but it must not enter the current request RAM or support a
	// current rule. `currentByType` falls back to `byType` for older boards.
	const current = board.currentByType ?? board.byType;
	const facts = dedupe(nodesForEpisode(current.Fact, episodeId).map((node) => nodeLine(node)));
	const refuted = dedupe(nodesForEpisode(current.Refuted, episodeId).map((node) => nodeLine(node)));
	// Candidates are HISTORICAL PROPOSALS pending verification. They are listed so the
	// model knows they exist, but they are NOT re-injected as guidance/hints and are
	// never presented as facts. Only a committed verification can promote one.
	const hypotheses = dedupe([...nodesForEpisode(current.Hint, episodeId), ...nodesForEpisode(current.Intent, episodeId)].map((node) => nodeLine(node)));
	const artifacts = dedupe(nodesForEpisode(current.Artifact, episodeId).map((node) => nodeLine(node)));
	// Pair each action.requested (Intent) with its action.completed (Artifact) by
	// action_id, so the tool call/result relationship survives the projection.
	const artifactByAction = new Map(
		nodesForEpisode(current.Artifact, episodeId)
			.filter((node) => node.action_id)
			.map((node) => [node.action_id, node]),
	);
	const toolPairs = [];
	for (const intent of nodesForEpisode(current.Intent, episodeId).filter((node) => node.action_id)) {
		const done = artifactByAction.get(intent.action_id);
		const tool = intent.tool_name || done?.tool_name || "?";
		toolPairs.push(`- ${tool}(${intent.action_id}) → ${done ? "completed" : "pending"}`);
	}
	const pending = Object.values(state.pending_actions).filter(
		(action) => action.status === "pending" && (!episodeId || action.episode_id === episodeId),
	);
	const unknown = state.experience_decisions
		.filter((decision) => decision.episode_id === episodeId && decision.selected)
		.map((decision) => {
			const selected = decision.selected;
			const label = typeof selected === "string" ? selected : `${selected?.id ?? "?"}@${selected?.revision ?? "?"}`;
			const mode = decision.mode ? `mode=${decision.mode} ` : "";
			return `${mode}${label} (${decision.reason || "no reason recorded"}) [unverified hint]`;
		});
	const toolPairsDedup = dedupe(toolPairs);

	// Mandatory (never dropped): task header + authorization/budget + pending actions.
	const header = [
		"# Aegis RAM",
		"",
		"> Runtime projection rebuilt from the event log. Claims and hints are NOT verified facts. Only this episode's nodes are shown.",
		"",
		"## Task",
		`- total_goal: ${clip(originalGoal, 600)}`,
	];
	if (currentPrompt) header.push(`- current_prompt: ${clip(currentPrompt, 300)}`);
	header.push(
		`- episode_id: ${episodeId || "(none)"}`,
		`- status: ${episode?.status || "unknown"}`,
		`- authorization: ${clip(JSON.stringify(episode?.authorization ?? "unknown"), 300)}`,
		`- budget: ${clip(JSON.stringify(episode?.budget ?? "unknown"), 200)}`,
	);
	const pendingBlock = [
		"",
		`## Unfinished actions (${pending.length})`,
		...(pending.length ? pending.map((action) => `- ${action.tool_name} (${action.status})`) : ["- (none)"]),
	];
	const unknownBlock = [
		"",
		"## Unknown / open decisions",
		...(unknown.length ? unknown.map((entry) => `- ${clip(entry, 220)}`) : ["- outcome: unknown until an oracle or human decides"]),
	];

	// Droppable (in priority order): tool pairs, artifacts, refuted, hypotheses, facts.
	const optionalSections = [
		{ title: `## Recent tool calls (${toolPairsDedup.length})`, lines: toolPairsDedup.slice(-6), priority: 0 },
		{ title: `## Recent artifacts (${artifacts.length})`, lines: artifacts.slice(-5), priority: 1 },
		{ title: `## Refuted (${refuted.length})`, lines: refuted, priority: 2 },
		{ title: `## Historical proposals (pending verification, NOT guidance) (${hypotheses.length})`, lines: hypotheses, priority: 3 },
		{ title: `## Verified facts (${facts.length})`, lines: facts, priority: 4 },
	];

	const mandatory = [...header, ...pendingBlock, ...unknownBlock].join("\n");
	const dropped = [];

	function renderOptional(limits) {
		const parts = [];
		let droppedAny = false;
		for (const section of optionalSections) {
			const limit = limits[section.priority] ?? 0;
			const kept = section.lines.slice(0, limit);
			if (kept.length !== section.lines.length) droppedAny = true;
			parts.push("");
			parts.push(section.title);
			parts.push(...(kept.length ? kept : ["- (none shown)"]));
		}
		return { text: parts.join("\n"), droppedAny };
	}

	// Progressively shrink the droppable sections until the RAM fits.
	let text = mandatory + renderOptional({ 0: 6, 1: 5, 2: 10, 3: 20, 4: 20 }).text;
	if (text.length > budgetChars) {
		const limits = { 0: 3, 1: 3, 2: 5, 3: 10, 4: 10 };
		while (limits[0] >= 0 && text.length > budgetChars) {
			const rendered = renderOptional(limits).text;
			text = mandatory + rendered;
			if (text.length <= budgetChars) {
				dropped.push(`optional evidence reduced to tool_calls=${limits[0]}, artifacts=${limits[1]}, refuted=${limits[2]}, proposals=${limits[3]}, facts=${limits[4]}`);
				break;
			}
			limits[0] -= 1;
			limits[1] = Math.max(0, limits[1] - 1);
			limits[2] = Math.max(0, limits[2] - 1);
			limits[3] = Math.max(0, limits[3] - 1);
			limits[4] = Math.max(0, limits[4] - 1);
			if (limits[0] < 0) {
				dropped.push("context budget is too small to include optional evidence; mandatory task/authorization/pending block preserved");
				text = mandatory + "\n\n> (optional evidence omitted to respect the context budget)";
				break;
			}
		}
	}

	const estimatedChars = text.length;
	text += `\n\n<!-- ram_estimated_chars: ${estimatedChars}, ram_budget_chars: ${budgetChars} (character estimate, not tokenizer-exact)`;
	if (dropped.length > 0) text += `; budget_drops: ${dropped.join("; ")}`;
	text += " -->";
	return text;
}
