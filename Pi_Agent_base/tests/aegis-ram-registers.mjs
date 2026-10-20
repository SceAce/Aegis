// RAM v4 working-set contract: LLM-selected subgoal, scoped claims, relevant
// judgments, multiple knowledge references, explicit rules, and a bounded view.
import assert from "node:assert/strict";
import test from "node:test";
import { buildRamProjection } from "../memory/ram.mjs";

const ep = "ep-registers";
function node(id, type, text, extra = {}) {
	return {
		node_id: id,
		origin_event_id: `ev-${id}`,
		episode_id: ep,
		type,
		text,
		status: "candidate",
		scope: null,
		...extra,
	};
}
function fixture() {
	const board = {
		currentByType: {
			Fact: [
				node("fact-old", "Fact", "older verified fact", { status: "verified" }),
				node("fact-new", "Fact", "newest verified fact", { status: "verified" }),
			],
			Intent: [
				node("subgoal-1", "Intent", "first subgoal", { scope: "s1" }),
				node("subgoal-2", "Intent", "second subgoal", { scope: "s2" }),
			],
			Hint: [
				node("claim-1", "Hint", "claim for first subgoal", { scope: "s1" }),
				node("claim-2", "Hint", "claim for second subgoal", { scope: "s2" }),
				node("claim-main", "Hint", "mainline unresolved claim"),
			],
		},
		byType: {},
	};
	const state = {
		version: 7,
		episodes: {
			[ep]: {
				task_id: "task-registers",
				goal: { description: "MAINLINE TASK: explain the target" },
				status: "active",
				authorization: { read: ["target"] },
				budget: { tool_calls: 12 },
			},
		},
		pending_actions: {},
		round_checkpoints: [],
		experience_decisions: [],
		knowledge_selections: [
			{
				episode_id: ep,
				knowledge_id: "k/web",
				source_uri: "web.json#1",
				topic: "web",
				section: ["web"],
				content: "WEB_REFERENCE",
			},
			{
				episode_id: ep,
				knowledge_id: "k/pwn",
				source_uri: "pwn.json#2",
				topic: "pwn",
				section: ["pwn"],
				content: "PWN_REFERENCE",
			},
			{
				episode_id: ep,
				knowledge_id: "k/crypto",
				source_uri: "crypto.json#3",
				topic: "crypto",
				section: ["crypto"],
				content: "CRYPTO_REFERENCE",
			},
			{
				episode_id: ep,
				knowledge_id: "k/misc",
				source_uri: "misc.json#4",
				topic: "misc",
				section: ["misc"],
				content: "MISC_REFERENCE",
			},
		],
	};
	return { board, state };
}

test("latest effective Intent drives the subgoal; claims are scoped but main task remains", () => {
	const { board, state } = fixture();
	const p = buildRamProjection({
		board,
		state,
		episodeId: ep,
		goal: "current prompt",
		rules: [{ kind: "active_experience", text: "check the parser first", experience_id: "exp-1", revision: 3 }],
	});
	const data = JSON.parse(p.text);
	assert.equal(data.version, "4.0");
	assert.equal(data.task.total_goal, "MAINLINE TASK: explain the target");
	assert.equal(data.task.subgoal.text, "second subgoal");
	assert.equal(data.task.subgoal.scope, "s2");
	assert.deepEqual(
		data.claims.map((row) => row.text),
		["claim for second subgoal"],
	);
	assert.ok(!p.text.includes("claim for first subgoal"), "older subgoal claim is not current working memory");
	assert.ok(p.text.includes("MAINLINE TASK"), "mainline goal remains visible");
	assert.equal(p.registers.subgoal.scope, "s2");
});

test("relevant judgments and multiple knowledge references are selected, with trust classes separated", () => {
	const { board, state } = fixture();
	const p = buildRamProjection({ board, state, episodeId: ep });
	const data = JSON.parse(p.text);
	assert.deepEqual(data.facts.map((row) => row.text).sort(), ["newest verified fact", "older verified fact"]);
	assert.ok(data.facts.every((row) => row.trust === "verified" && row.kind === "Fact"));
	assert.equal(data.references.filter((row) => row.kind === "knowledge").length, 4);
	assert.ok(
		data.references
			.filter((row) => row.kind === "knowledge")
			.every((row) => row.verified === false && row.action_policy === "none"),
	);
	assert.ok(p.text.includes("WEB_REFERENCE") && p.text.includes("PWN_REFERENCE"), "cross-direction cards coexist");
	assert.deepEqual(data.rules, []);
	assert.deepEqual(JSON.parse(p.text), p.data);
	assert.equal(p.data.meta.ram_budget_chars, 8000);
});

test("current-goal relevance can retain older evidence over unrelated newer evidence", () => {
	const { board, state } = fixture();
	board.currentByType.Fact = [
		node("old-relevant", "Fact", "target parser has a length boundary", { status: "verified" }),
		...Array.from({ length: 8 }, (_, i) =>
			node(`new-unrelated-${i}`, "Fact", `recent network observation ${i}`, { status: "verified" }),
		),
	];
	const p = buildRamProjection({ board, state, episodeId: ep, budgetChars: 8000 });
	const data = JSON.parse(p.text);
	assert.ok(data.facts.some((row) => row.text.includes("target parser")));
	assert.equal(data.facts.filter((row) => row.text.includes("recent network")).length, 5);
	assert.equal(data.meta.omitted.facts, 3);
	assert.equal(data.sections.facts.total, 9);
});

test("facts and refutations share the working-set limit and omissions are accurate", () => {
	const { board, state } = fixture();
	board.currentByType.Fact = Array.from({ length: 5 }, (_, i) =>
		node(`fact-${i}`, "Fact", `goal target evidence ${i}`, { status: "verified" }),
	);
	board.currentByType.Refuted = Array.from({ length: 4 }, (_, i) =>
		node(`refuted-${i}`, "Refuted", `goal target rejected condition ${i}`, { status: "verified" }),
	);
	const p = buildRamProjection({ board, state, episodeId: ep });
	const data = JSON.parse(p.text);
	assert.equal(data.facts.length, 6);
	assert.equal(data.facts.filter((row) => row.kind === "Refuted").length, 3);
	assert.equal(data.meta.omitted.facts, 3);
	assert.equal(data.sections.facts.total, 5);
	assert.equal(data.sections.refuted.total, 4);
});

test("artifact omission count matches the one-row artifact register", () => {
	const { board, state } = fixture();
	board.currentByType.Artifact = Array.from({ length: 3 }, (_, i) =>
		node(`artifact-${i}`, "Artifact", `artifact note ${i}`, { status: "candidate" }),
	);
	const p = buildRamProjection({ board, state, episodeId: ep });
	assert.equal(p.data.artifacts.length, 1);
	assert.equal(p.data.meta.omitted.artifacts, 2);
});

test("rules are explicit and never copied from claims or references", () => {
	const { board, state } = fixture();
	const p = buildRamProjection({
		board,
		state,
		episodeId: ep,
		rules: [{ kind: "active_experience", text: "PROCEDURE_RULE", experience_id: "exp-1", revision: 3 }],
	});
	const data = JSON.parse(p.text);
	assert.equal(data.rules.length, 1);
	assert.equal(data.rules[0].trust, "rule");
	assert.equal(data.rules[0].not_authorization, true);
	assert.equal(data.rules[0].text, "PROCEDURE_RULE");
	assert.ok(!JSON.stringify(data.rules).includes("claim for second subgoal"));
	assert.ok(!JSON.stringify(data.rules).includes("WEB_REFERENCE"));
});

test("small budgets compress and disclose optional rows without dropping the main task", () => {
	const { board, state } = fixture();
	const p = buildRamProjection({ board, state, episodeId: ep, budgetChars: 2200 });
	assert.ok(p.text.length <= 2200, `RAM exceeded budget: ${p.text.length}`);
	assert.ok(p.data.meta.register_drops > 0 || p.data.meta.budget_drops > 0, "compression is disclosed");
	assert.ok(p.text.includes("MAINLINE TASK"), "main task survives compression");
	assert.ok(p.data.meta.omitted && typeof p.data.meta.omitted === "object");
});

test("sections remains a bounded compatibility summary alongside the register view", () => {
	const { board, state } = fixture();
	const p = buildRamProjection({ board, state, episodeId: ep });
	for (const section of p.sections) {
		assert.equal(section.shown + section.omitted, section.total);
		assert.ok(Number.isInteger(section.shown));
	}
	assert.ok(p.data.sections.facts.total >= 2);
	assert.ok(p.data.sections.knowledge.shown <= 4);
	assert.ok("facts" in p.data && "claims" in p.data && "references" in p.data);
});
