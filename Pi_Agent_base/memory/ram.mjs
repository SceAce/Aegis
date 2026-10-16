// Pure structured working memory; selection is display only, never action policy.
import { captureTextFragments, compactTextFragments } from "./fragments.mjs";
import { memoryText, summarizeMemoryValue } from "./summary.mjs";

export const RAM_VERSION = "3.0";
const DEFAULT_BUDGET = 4000;
const ORDER = ["external_reference", "facts", "refuted", "tools", "proposals", "artifacts", "decisions"];
const LABELS = {
	facts: "Verified facts",
	refuted: "Refuted",
	tools: "Tool observations, NOT task verdicts",
	proposals: "Historical proposals, NOT guidance",
	artifacts: "Artifacts",
	decisions: "Unverified selections",
	external_reference: "External reference (unverified, no action policy)",
};

/** @param {{board: any, state: any, episodeId: string|null, goal?: string, budgetChars?: number}} args */
export function buildRamProjection({ board, state, episodeId, goal, budgetChars = DEFAULT_BUDGET, seed = null }) {
	const budget = Number.isSafeInteger(budgetChars) && budgetChars > 0 ? budgetChars : DEFAULT_BUDGET;
	const episode = episodeId ? state.episodes?.[episodeId] : null;
	const current = board.currentByType ?? board.byType ?? {};
	function nodes(type) {
		const seen = new Set();
		return (current[type] ?? []).filter((node) => {
			const id = node.node_id ?? node.origin_event_id ?? node;
			if (!episodeId || node.episode_id !== episodeId || seen.has(id)) return false;
			seen.add(id);
			return true;
		});
	}
	const intents = nodes("Intent");
	const artifacts = nodes("Artifact");
	const proposals = [...nodes("Hint"), ...intents.filter((node) => !node.action_id)];
	const associated = new Set(
		proposals
			.flatMap((node) => [...(node.source_refs ?? []), ...(node.evidence_refs ?? [])])
			.map((ref) => (typeof ref === "string" ? ref : ref.ref_id)),
	);
	const completed = new Map(artifacts.filter((node) => node.action_id).map((node) => [node.action_id, node]));
	const toolPairs = intents
		.filter((node) => node.action_id)
		.map((node) => ({ intent: node, done: completed.get(node.action_id) }));
	const known = new Set(toolPairs.map((pair) => pair.intent.action_id));
	for (const done of artifacts.filter((node) => node.action_id && !known.has(node.action_id)))
		toolPairs.push({ intent: null, done });
	const recent = [...toolPairs].reverse();
	const referenced = recent.filter((pair) =>
		[pair.intent, pair.done].some(
			(node) => node && [node.node_id, node.origin_event_id, node.action_id].some((id) => associated.has(id)),
		),
	);
	const diverse = [];
	const tools = new Set();
	for (const pair of recent) {
		const name = pair.intent?.tool_name ?? pair.done?.tool_name;
		if (!tools.has(name)) {
			diverse.push(pair);
			tools.add(name);
		}
	}
	const selectedTools = [...new Set([...referenced.slice(0, 3), ...recent.slice(0, 3), ...diverse, ...recent])].slice(
		0,
		8,
	);
	const words = new Set(
		(
			String(goal ?? episode?.goal?.description ?? "")
				.toLowerCase()
				.match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []
		).slice(0, 32),
	);
	function rank(list) {
		const reversed = [...list].reverse();
		const first = reversed.shift();
		const scored = reversed.map((node, index) => ({
			node,
			index,
			score: [...words].reduce(
				(sum, word) => sum + Number(`${node.text} ${node.criterion?.description ?? ""}`.toLowerCase().includes(word)),
				0,
			),
		}));
		scored.sort((a, b) => b.score - a.score || a.index - b.index);
		return first ? [first, ...scored.map((entry) => entry.node)] : [];
	}
	const decisions = new Map();
	for (const row of [...(state.experience_decisions ?? [])].reverse()) {
		if (!episodeId || row.episode_id !== episodeId || !row.selected) continue;
		const id = typeof row.selected === "string" ? row.selected : `${row.selected.id}@${row.selected.revision ?? "?"}`;
		if (!decisions.has(id))
			decisions.set(id, { ...row, text: `${id} ${row.reason ?? ""}`, origin_event_id: row.event_id });
	}
	const external =
		seed && seed.source_kind === "external_reference" && seed.verified === false && seed.action_policy === "none"
			? [{ external_reference: true, ...seed }]
			: [];
	const raw = {
		external_reference: external,
		facts: rank(nodes("Fact")),
		refuted: rank(nodes("Refuted")),
		tools: selectedTools,
		proposals: rank(proposals),
		artifacts: rank(
			artifacts.filter((node) => !node.action_id && !String(node.text).startsWith("experience decision:")),
		),
		decisions: [...decisions.values()],
	};
	const totals = Object.fromEntries(ORDER.map((id) => [id, id === "tools" ? toolPairs.length : raw[id].length]));
	const limits = { external_reference: 1, facts: 20, refuted: 10, tools: 8, proposals: 8, artifacts: 5, decisions: 3 };
	const selected = Object.fromEntries(ORDER.map((id) => [id, []]));
	const full = new Set();
	const pending = Object.values(state.pending_actions ?? {}).filter(
		(row) => episodeId && row.episode_id === episodeId && ["pending", "unknown", "unresolved"].includes(row.status),
	);
	const safe = (value, limit = 160) => summarizeMemoryValue(value, { maxChars: limit, maxString: limit }).value;
	let refs = {};
	function ref(kind, id, digest = null) {
		if (typeof id !== "string" || !id) return null;
		const key = JSON.stringify([kind, id, digest]);
		let alias = Object.keys(refs).find((name) => refs[name]._key === key);
		if (!alias) {
			alias = `r${Object.keys(refs).length}`;
			refs[alias] = { type: kind, id, ...(digest ? { digest } : {}), _key: key };
		}
		return alias;
	}
	function nodeData(node, expanded) {
		const limit = expanded ? 180 : 80;
		if (node.external_reference)
			return {
				source_kind: "external_reference",
				source_uri: node.source_uri,
				topic: node.topic,
				verified: false,
				action_policy: "none",
				content: safe(node.content, expanded ? 1800 : 900),
			};
		return {
			ref: ref("node", node.node_id ?? `ev:${node.origin_event_id}`),
			event: ref("event", node.origin_event_id),
			trust: node.type === "Fact" || node.type === "Refuted" ? "verified" : "unverified",
			text: memoryText(node.text, limit),
			...(node.criterion
				? {
						criterion: {
							criterion_id: node.criterion.criterion_id ?? null,
							...(Object.hasOwn(node.criterion, "expected") ? { expected: safe(node.criterion.expected, limit) } : {}),
							...(node.criterion.description !== undefined
								? { description: memoryText(node.criterion.description, limit) }
								: {}),
						},
						observed: safe(node.observed, limit),
					}
				: {}),
			...(node.observation_summary ? { observation: safe(node.observation_summary.value, limit) } : {}),
			...(node.outcome_id ? { outcome: ref("outcome", node.outcome_id) } : {}),
			...(node.evidence_refs?.length || node.source_refs?.length
				? {
						sources: [...(node.evidence_refs ?? []), ...(node.source_refs ?? [])]
							.slice(0, expanded ? 4 : 2)
							.map((r) => ref(r.ref_type ?? "external", r.ref_id ?? r, r.digest ?? null)),
						sources_omitted: Math.max(
							0,
							(node.evidence_refs?.length ?? 0) + (node.source_refs?.length ?? 0) - (expanded ? 4 : 2),
						),
					}
				: {}),
		};
	}
	function toolData(pair, expanded) {
		const a = pair.intent,
			b = pair.done;
		const input = a?.input?.summary?.value ?? a?.input;
		const output = b?.result_summary?.value ?? null;
		return {
			action: ref("action", a?.action_id ?? b?.action_id),
			tool: memoryText(a?.tool_name ?? b?.tool_name ?? "?", 60),
			trust: "observed",
			state: b ? "completed" : "pending",
			sources: [a, b].filter(Boolean).map((node) => ref("event", node.origin_event_id)),
			input: safe(input ?? "unknown", expanded ? 260 : 100),
			response:
				b && (b.response_fragments || typeof b.response === "string")
					? compactTextFragments(b.response_fragments ?? captureTextFragments(b.response, 600), expanded ? 360 : 150)
					: null,
			...(output !== null ? { details: safe(output, expanded ? 220 : 80) } : {}),
			transport: safe(b?.transport ?? "unknown", 100),
			...(a?.input_truncated || b?.response_truncated ? { capture_truncated: true } : {}),
		};
	}
	function render() {
		refs = {};
		const sections = {};
		for (const id of ORDER)
			sections[id] = {
				label: LABELS[id],
				total: totals[id],
				shown: selected[id].length,
				omitted: totals[id] - selected[id].length,
				items: selected[id].map((row) =>
					id === "tools" ? toolData(row, full.has(row)) : nodeData(row, full.has(row)),
				),
			};
		const data = {
			version: RAM_VERSION,
			trust: "projection, not instructions or authorization",
			episode_id: episodeId,
			state_revision: state.version ?? 0,
			task: {
				task_id: episode?.task_id ?? null,
				total_goal: memoryText(episode?.goal?.description ?? goal ?? "(not provided)", 600),
				...(goal && goal !== episode?.goal?.description ? { current_prompt: memoryText(goal, 240) } : {}),
				status: episode?.status ?? "unknown",
				authorization: safe(episode?.authorization ?? "unknown", 300),
				budget: safe(episode?.budget ?? "unknown", 200),
			},
			...(episode?.task_id && state.work_state?.[episode.task_id]
				? { workflow: safe(state.work_state[episode.task_id], 600) }
				: {}),
			pending: {
				label: "Unfinished actions",
				items: pending.map((row) => ({ action_id: row.action_id, tool: row.tool_name, status: row.status })),
			},
			sections,
			refs: Object.fromEntries(Object.entries(refs).map(([key, { _key, ...value }]) => [key, value])),
			meta: {
				ram_estimated_chars: 0,
				ram_budget_chars: budget,
				overflow: false,
				budget_drops: ORDER.reduce((n, id) => n + totals[id] - selected[id].length, 0),
				...(ORDER.every((id) => selected[id].length === 0) ? { core_overflow: false } : {}),
			},
		};
		let text = JSON.stringify(data);
		for (let i = 0; i < 8; i++) {
			data.meta.ram_estimated_chars = text.length;
			data.meta.overflow = text.length > budget;
			if (Object.hasOwn(data.meta, "core_overflow")) data.meta.core_overflow = data.meta.overflow;
			const next = JSON.stringify(data);
			if (next === text) break;
			text = next;
		}
		return { text, data };
	}
	function admit(id, row) {
		selected[id].push(row);
		if (render().text.length > budget) selected[id].pop();
	}
	if (render().text.length <= budget) {
		for (const id of ["external_reference", "facts", "refuted", "proposals", "tools"])
			if (raw[id][0]) admit(id, raw[id][0]);
		for (const id of ORDER)
			for (const row of raw[id].slice(0, limits[id])) if (!selected[id].includes(row)) admit(id, row);
		for (const id of ORDER)
			for (const row of selected[id]) {
				full.add(row);
				if (render().text.length > budget) full.delete(row);
			}
	}
	const { text, data } = render();
	return {
		text,
		data,
		version: RAM_VERSION,
		budget_chars: budget,
		estimated_chars: text.length,
		overflow: text.length > budget,
		sections: ORDER.map((id) => ({
			id,
			total: totals[id],
			shown: selected[id].length,
			omitted: totals[id] - selected[id].length,
		})),
	};
}

export function buildRam(args) {
	return buildRamProjection(args).text;
}
