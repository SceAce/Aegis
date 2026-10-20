// Independent projection boundary checks; no provider or user data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectBoard } from "../memory/board.mjs";
import { buildRam, buildRamProjection } from "../memory/ram.mjs";
import { redactMemoryText, summarizeMemoryValue } from "../memory/summary.mjs";

function fixture() {
	const byType = { Fact: [], Refuted: [], Hint: [], Intent: [], Artifact: [] };
	return {
		episodeId: "ep-local",
		goal: "inspect target.txt",
		board: { byType, currentByType: byType },
		state: {
			episodes: {
				"ep-local": {
					task_id: "t-local",
					status: "open",
					goal: { description: "inspect target.txt" },
					authorization: { read: ["target.txt"] },
					budget: { model_requests: 8 },
				},
			},
			pending_actions: {},
			experience_decisions: [],
		},
	};
}
function node(id, text, fields = {}) {
	return { node_id: id, origin_event_id: id, episode_id: "ep-local", text, ...fields };
}
function footer(text) {
	return JSON.parse(text).meta.ram_estimated_chars;
}

test("RP-01 complete output including footer fits budgets when mandatory context fits", () => {
	const f = fixture();
	f.board.byType.Fact.push(
		...Array.from({ length: 30 }, (_, i) => node(`fact-${i}`, `current evidence ${i} ${"x".repeat(400)}`)),
	);
	f.board.byType.Hint.push(...Array.from({ length: 30 }, (_, i) => node(`hint-${i}`, "hypothesis ".repeat(50))));
	for (const budgetChars of [1200, 1500, 2000, 3999, 4000, 6000]) {
		const p = buildRamProjection({ ...f, budgetChars });
		assert.ok(p.text.length <= budgetChars, `budget=${budgetChars} actual=${p.text.length}`);
		assert.equal(footer(p.text), p.text.length, `serialized footer budget=${budgetChars}`);
		assert.equal(p.data.meta.ram_estimated_chars, p.text.length, `data footer budget=${budgetChars}`);
		assert.deepEqual(p.data, JSON.parse(p.text));
		assert.equal(p.data.meta.overflow, false);
		assert.equal(p.overflow, false);
		assert.equal(p.estimated_chars, p.text.length);
		for (const section of p.sections) assert.equal(section.shown + section.omitted, section.total);
	}
});

test("RP-02 tiny budget preserves unknown/pending responsibility and discloses overflow", () => {
	const f = fixture();
	for (const status of ["pending", "unknown", "unresolved"])
		f.state.pending_actions[status] = {
			action_id: `action-${status}`,
			episode_id: f.episodeId,
			tool_name: "write",
			status,
		};
	f.state.pending_actions.foreign = {
		action_id: "FOREIGN",
		episode_id: "ep-other",
		tool_name: "write",
		status: "pending",
	};
	const p = buildRamProjection({ ...f, budgetChars: 100 });
	assert.equal(p.overflow, true);
	assert.equal(footer(p.text), p.text.length);
	for (const status of ["pending", "unknown", "unresolved"]) assert.ok(p.text.includes(`action-${status}`));
	assert.ok(!p.text.includes("FOREIGN"));
	assert.equal(JSON.parse(p.text).meta.overflow, true);
	assert.deepEqual(JSON.parse(p.text).task.authorization, { read: ["target.txt"] });
	assert.equal(typeof JSON.parse(p.text).meta.budget_drops, "number");
});

test("RP-03 same prose with distinct judgment identities retains false/0/empty structured values", () => {
	const f = fixture();
	for (const [i, expected] of [false, 0, [], {}].entries())
		f.board.byType.Fact.push(
			node(`judge-${i}`, "same prose", {
				criterion: { criterion_id: `criterion-${i}`, description: "checked", expected },
				observed: { value: expected },
			}),
		);
	const p = buildRamProjection({ ...f, budgetChars: 6000 });
	assert.equal(p.sections.find((s) => s.id === "facts").shown, 4);
	for (const i of [0, 1, 2, 3]) assert.ok(p.text.includes(`criterion-${i}`));
	const expected = JSON.parse(p.text).facts.map((item) => item.criterion.expected);
	assert.ok(expected.includes(false));
	assert.ok(expected.includes(0));
	assert.ok(expected.some((value) => Array.isArray(value) && value.length === 0));
	assert.ok(
		expected.some(
			(value) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0,
		),
	);
});

test("RP-04 newest fact and tool observation survive history growth; selection is deterministic", () => {
	const f = fixture();
	for (let i = 0; i < 100; i++) f.board.byType.Fact.push(node(`f-${i}`, `FACT_${i}_END ${"x".repeat(90)}`));
	f.board.byType.Intent.push(
		node("request", "read", { action_id: "a-1", tool_name: "read", input: { path: "target.txt" } }),
	);
	f.board.byType.Artifact.push(
		node("response", "read", {
			action_id: "a-1",
			tool_name: "read",
			response: "LATEST_RESPONSE",
			transport: { tool_ok: false },
		}),
	);
	const p = buildRamProjection({ ...f, budgetChars: 2500 });
	assert.ok(p.text.includes("FACT_99_END"));
	assert.ok(p.text.includes("LATEST_RESPONSE"));
	assert.ok(p.text.includes("target.txt"));
	assert.match(p.text, /tool_ok[^\n]*false/);
	assert.equal(buildRam({ ...f, budgetChars: 2500 }), p.text);
	assert.ok(p.sections.find((s) => s.id === "facts").omitted > 0);
});

test("RP-05 historical decisions are bounded, newest revision is shown and repeated identity is retired", () => {
	const f = fixture();
	for (let i = 0; i < 100; i++)
		f.state.experience_decisions.push({
			episode_id: f.episodeId,
			event_id: `d-${i}`,
			selected: { id: "one-rule", revision: "1" },
			reason: `DECISION_${i}_END`,
			mode: "hint",
		});
	const p = buildRamProjection(f);
	assert.ok(p.text.includes("DECISION_99_END"));
	assert.ok(!p.text.includes("DECISION_0_END"));
	assert.equal(p.sections.find((s) => s.id === "decisions").shown, 1);
	assert.ok(p.text.length <= 4000);
});

test("RP-06 sensitive nested fields and free text are redacted before bounding", () => {
	const input = {
		apiKey: "CAMEL_SECRET",
		quoted: '{"password":"QUOTED_SECRET"}',
		url: "https://offline.invalid/?token=URL_SECRET&ok=1",
		authorization: "Bearer HEADER_SECRET",
		nested: {
			access_token: "ACCESS_SECRET",
			password: "PASSWORD_SECRET",
			normal: "KEEP_ME",
			zero: 0,
			off: false,
			empty: [],
		},
		text: "Authorization: Bearer TEXT_SECRET",
		key: "-----BEGIN PRIVATE KEY-----\nKEY_SECRET\n-----END PRIVATE KEY-----",
	};
	const summary = summarizeMemoryValue(input, { maxChars: 2000 });
	const text = JSON.stringify(summary);
	for (const secret of [
		"CAMEL_SECRET",
		"QUOTED_SECRET",
		"URL_SECRET",
		"HEADER_SECRET",
		"ACCESS_SECRET",
		"PASSWORD_SECRET",
		"TEXT_SECRET",
		"KEY_SECRET",
	])
		assert.ok(!text.includes(secret), secret);
	assert.ok(text.includes("KEEP_ME"));
	assert.equal(summary.redacted, true);
	assert.equal(summary.value.nested.zero, 0);
	assert.equal(summary.value.nested.off, false);
	assert.deepEqual(summary.value.nested.empty, []);
	assert.equal(summarizeMemoryValue({ length: 0 }).value.length, 0);
	assert.deepEqual(
		summarizeMemoryValue(Array.from({ length: 12 }, (_, i) => i)).value,
		Array.from({ length: 12 }, (_, i) => i),
	);
	assert.ok(!redactMemoryText("Bearer TOKEN_BODY").includes("TOKEN_BODY"));
});

test("RP-07 large/deep/cyclic values remain bounded with explicit loss; accessors are never executed", () => {
	let accesses = 0;
	const value = { text: "x".repeat(50_000), rows: Array.from({ length: 100 }, (_, i) => ({ i })) };
	value.self = value;
	Object.defineProperty(value, "getter", {
		enumerable: true,
		get() {
			accesses++;
			return "should not read";
		},
	});
	const summary = summarizeMemoryValue(value, { maxChars: 700 });
	assert.equal(accesses, 0);
	assert.equal(summary.truncated, true);
	assert.ok(JSON.stringify(summary.value).length <= 700);
	assert.match(JSON.stringify(summary), /truncated/);
	for (const maxChars of [32, 64, 128, 700]) {
		const escaped = summarizeMemoryValue('"\\\\'.repeat(2000), { maxChars });
		assert.ok(JSON.stringify(escaped.value).length <= maxChars);
	}
});

test("RP-08 selected identity dedup and current-task relevance do not promote proposals", () => {
	const f = fixture();
	const first = node("first", "target.txt contains relevant older evidence");
	f.board.byType.Fact.push(
		first,
		first,
		node("irrelevant", "unrelated prior material"),
		node("latest", "newest evidence"),
	);
	f.board.byType.Hint.push(node("proposal", "CLAIM_NOT_FACT"));
	const p = buildRamProjection(f);
	assert.equal(p.sections.find((s) => s.id === "facts").total, 3);
	assert.ok(p.text.indexOf("newest evidence") < p.text.indexOf("relevant older evidence"));
	assert.ok(p.text.indexOf("relevant older evidence") < p.text.indexOf("unrelated prior material"));
	const factText = JSON.stringify(JSON.parse(p.text).facts);
	assert.ok(!factText.includes("CLAIM_NOT_FACT"));
	assert.ok(p.text.includes("NOT guidance"));
});

test("RP-09 captured observation structure survives Board to RAM with evidence identity", () => {
	const f = fixture();
	f.board = projectBoard([
		{
			event_id: "observed-event",
			event_type: "observation.captured",
			episode_id: f.episodeId,
			source: { kind: "oracle" },
			recorded_at: "2026-01-01T00:00:00Z",
			payload: {
				verified: true,
				text: "Independent file observation",
				value: { field: "OBSERVED_FIELD", count: 0, enabled: false },
				target_fingerprint: "sha256:abc",
			},
			evidence_refs: [{ ref_type: "artifact", ref_id: "observation-proof" }],
		},
	]);
	assert.equal(f.board.currentByType.Fact.length, 1);
	const text = buildRam(f);
	assert.ok(text.includes("OBSERVED_FIELD"));
	assert.ok(text.includes('"count":0'));
	assert.ok(text.includes('"enabled":false'));
	assert.ok(text.includes("observed-event"));
	assert.ok(
		Object.values(JSON.parse(text).refs).some((ref) => ref.type === "artifact" && ref.id === "observation-proof"),
	);
});

test("RP-11 foreign evidence and tool pairs cannot enter local or missing-Episode RAM", () => {
	const f = fixture();
	f.board.byType.Fact.push(node("local", "LOCAL_FACT"), node("foreign", "FOREIGN_FACT", { episode_id: "ep-other" }));
	f.board.byType.Intent.push(
		node("foreign-tool", "FOREIGN_TOOL", {
			episode_id: "ep-other",
			action_id: "FOREIGN_ACTION",
			tool_name: "FOREIGN_TOOL",
		}),
	);
	f.board.byType.Artifact.push(
		node("foreign-result", "FOREIGN_RESPONSE", {
			episode_id: "ep-other",
			action_id: "FOREIGN_ACTION",
			response: "FOREIGN_RESPONSE",
		}),
	);
	assert.ok(buildRam(f).includes("LOCAL_FACT"));
	assert.ok(!buildRam(f).includes("FOREIGN_"));
	const missing = buildRam({ ...f, episodeId: null });
	assert.ok(!missing.includes("LOCAL_FACT"));
	assert.ok(!missing.includes("FOREIGN_"));
});

test("RP-10 oversized newest item does not prevent smaller older evidence from fitting", () => {
	const f = fixture();
	f.board.byType.Fact.push(node("small", "SMALL_EVIDENCE"));
	f.board.byType.Fact.push(
		node("big", "new", {
			criterion: { criterion_id: "big", description: "large description ".repeat(80), expected: "e".repeat(800) },
			observed: "o".repeat(800),
		}),
	);
	const baseline = buildRamProjection(fixture()).estimated_chars;
	const p = buildRamProjection({ ...f, budgetChars: baseline + 260 });
	assert.ok(p.text.includes("SMALL_EVIDENCE"));
	assert.ok(p.text.length <= baseline + 260);
});
