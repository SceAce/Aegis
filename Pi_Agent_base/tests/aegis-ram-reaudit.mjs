// Independent RAM working-memory audit. Expected failures remain red until repaired.
// Real temporary EventLog, offline synthetic Oracle rows; no provider or target.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectBoard } from "../memory/board.mjs";
import { buildRam } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";
import { evaluateHandoff } from "../session/handoff.mjs";
import { EventLog, verifyChain } from "../shared/events.mjs";

const root = await mkdtemp(join(tmpdir(), "aegis-ram-reaudit-"));
const episodeId = "ep-current";
let passed = 0;
let failed = 0;
let serial = 0;

async function fixture(rows = []) {
	const log = new EventLog(join(root, `${serial++}.jsonl`));
	assert.equal((await log.open()).ok, true);
	try {
		const all = [
			{
				event_type: "episode.started",
				episode_id: episodeId,
				payload: {
					task_id: "task-current",
					goal: { description: "Inspect the current task" },
					authorization: { allowed: ["read"] },
					budget: { model_requests: 5 },
				},
			},
			...rows,
		];
		for (const row of all) {
			const result = await log.append({
				episode_id: episodeId,
				source: { actor_id: "audit", kind: "runtime", adapter: "offline-audit", version: "1" },
				...row,
			});
			assert.equal(result.ok, true, result.error);
		}
		const events = log.replay();
		assert.equal(verifyChain(events).ok, true);
		return { events, board: projectBoard(events), state: projectState(events), episodeId };
	} finally {
		await log.close();
	}
}

function observation(index, text = `verified observation ${index}`, foreign = false) {
	return {
		event_type: "observation.captured",
		episode_id: foreign ? "ep-foreign" : episodeId,
		source: { actor_id: "audit-oracle", kind: "oracle", adapter: "offline-audit", version: "1" },
		payload: {
			verified: true,
			text,
			value: { file_digest: `sha256:revision-${index}`, field: index },
			target_fingerprint: `sha256:revision-${index}`,
		},
		evidence_refs: [{ ref_type: "artifact", ref_id: `observation-${index}`, digest: `sha256:revision-${index}` }],
	};
}

function outcome(id, expected, observed, description = "response independently checked") {
	return {
		event_type: "outcome.recorded",
		source: { actor_id: "audit-oracle", kind: "oracle", adapter: "offline-audit", version: "1" },
		payload: {
			outcome_id: id,
			status: "success",
			source: "oracle",
			independent: true,
			criterion: { criterion_id: id, expected, description },
			observed,
			oracle: { oracle_id: "audit-oracle" },
		},
		evidence_refs: [{ ref_type: "artifact", ref_id: `evidence-${id}` }],
	};
}

async function check(id, run) {
	try {
		await run();
		passed++;
		console.log(`ok - ${id}`);
	} catch (error) {
		failed++;
		console.error(`not ok - ${id}: ${error.message}`);
	}
}

try {
	await check("RR-01 committed input/response survive RAM projection", async () => {
		const f = await fixture([
			{
				event_type: "action.requested",
				payload: { action_id: "read-1", tool_name: "read", input: { path: "probe.txt" } },
			},
			{
				event_type: "action.completed",
				payload: {
					action_id: "read-1",
					tool_name: "read",
					transport: { tool_ok: true },
					content_excerpt: "OBSERVED_RESPONSE_917",
				},
			},
		]);
		assert.equal(f.events.at(-2).payload.input.path, "probe.txt");
		assert.equal(f.events.at(-1).payload.content_excerpt, "OBSERVED_RESPONSE_917");
		const ram = buildRam(f);
		assert.ok(
			ram.includes("probe.txt") && ram.includes("OBSERVED_RESPONSE_917"),
			"recorded path and response disappear before request RAM",
		);
	});

	await check("RR-02 separate structured Oracle judgments keep identity and observed values", async () => {
		const f = await fixture([
			outcome("criterion-alpha", "response checked", { field: "alpha", value: "OBSERVED_ALPHA_917" }),
			outcome("criterion-beta", "response checked", { field: "beta", value: "OBSERVED_BETA_917" }),
		]);
		assert.equal(f.board.currentByType.Fact.length, 2);
		assert.equal(f.board.currentByType.Fact[0].observed.value, "OBSERVED_ALPHA_917");
		const ram = buildRam(f);
		assert.ok(
			ram.includes("criterion-alpha") &&
				ram.includes("criterion-beta") &&
				ram.includes("OBSERVED_ALPHA_917") &&
				ram.includes("OBSERVED_BETA_917"),
			"distinct structured judgments collapse to generic text",
		);
	});

	const manyFacts = await fixture(
		Array.from({ length: 21 }, (_, i) => observation(i, `UNIQUE_FACT_${String(i).padStart(2, "0")}_END`)),
	);
	await check("RR-03 newest effective evidence remains available at the default budget", async () => {
		assert.equal(manyFacts.board.currentByType.Fact.length, 21);
		const ram = buildRam(manyFacts);
		assert.ok(ram.length < 4000, "fixture leaves room in the default character budget");
		assert.ok(ram.includes("UNIQUE_FACT_20_END"), "21st effective fact is excluded while the first 20 fit");
	});

	await check("RR-04 count limits disclose omitted evidence even below the character budget", () => {
		const ram = buildRam(manyFacts);
		assert.ok(
			ram.includes("UNIQUE_FACT_20_END") || /budget_drops:|omitted|not shown|truncated/i.test(ram),
			"RAM says Verified facts (21) but silently shows only 20",
		);
	});

	await check("RR-05 historical routing decisions remain bounded", async () => {
		const f = await fixture(
			Array.from({ length: 40 }, (_, i) => ({
				event_type: "experience.decision",
				payload: {
					selected: { id: `card-${i}`, revision: "1" },
					mode: "hint",
					reason: `historical selection ${i}: ${"x".repeat(180)}`,
				},
			})),
		);
		assert.equal(Object.keys(f.state.pending_actions).length, 0);
		const ram = buildRam(f);
		console.log(`measurement - RR-05 RAM chars=${ram.length}, budget=4000, decisions=40, pending=0`);
		assert.ok(ram.length <= 4000, "historical selections accumulate in a mandatory block beyond the default budget");
	});

	await check("RR-06 shrinking retains a verified fact that fits", async () => {
		const rows = Array.from({ length: 10 }, (_, i) => observation(i, `BUDGET_FACT_${i} ${"v".repeat(150)}`));
		rows.push(
			...Array.from({ length: 10 }, (_, i) => ({
				event_type: "proposal.submitted",
				payload: { kind: "hint", text: `HYPOTHESIS_${i} ${"h".repeat(180)}` },
			})),
		);
		const f = await fixture(rows);
		const minimal = await fixture([rows[0]]);
		const budgetChars = 1700;
		// Precondition: with THIS budget one fact really fits (a 1500 budget cannot
		// hold the shared RAM skeleton plus a fact, so it would test nothing).
		const minimalRam = buildRam({ ...minimal, budgetChars });
		assert.ok(minimalRam.length <= budgetChars, "one fact fits including the budget footer");
		assert.ok(minimalRam.includes("BUDGET_FACT_0"), "the single fact is present, not silently dropped");
		const ram = buildRam({ ...f, budgetChars });
		assert.ok(ram.includes("BUDGET_FACT_"), "shrinking abandons all evidence before trying a smaller fact count");
	});

	await check("RR-07 handoff carries only the selected Episode's nodes", async () => {
		const foreignOutcome = outcome("foreign-refutation", "FOREIGN_REFUTATION_917", false);
		foreignOutcome.episode_id = "ep-foreign";
		Object.assign(foreignOutcome.payload, {
			status: "failure",
			preconditions_verified: true,
			failure_mode: "postcondition_failed",
		});
		const f = await fixture([
			observation(1, "CURRENT_FACT_917"),
			observation(2, "FOREIGN_FACT_917", true),
			foreignOutcome,
			{
				event_type: "proposal.submitted",
				episode_id: "ep-foreign",
				payload: { kind: "intent", text: "FOREIGN_INTENT_917" },
			},
		]);
		const ram = buildRam(f);
		assert.ok(!ram.includes("FOREIGN_"), "RAM itself already filters the foreign Episode");
		const verdict = evaluateHandoff({ ...f, ram, reason: "continue current task", requestId: "handoff-audit" });
		assert.equal(verdict.allowed, true);
		assert.ok(verdict.handoff.facts.includes("CURRENT_FACT_917"));
		assert.ok(
			!JSON.stringify(verdict.handoff).includes("FOREIGN_"),
			"handoff facts/refuted/intents include foreign Episode nodes",
		);
	});

	await check("RR-08 RAM preserves a completed tool's transport failure", async () => {
		const f = await fixture([
			{
				event_type: "action.requested",
				payload: { action_id: "failed-read", tool_name: "read", input: { path: "missing.txt" } },
			},
			{
				event_type: "action.completed",
				payload: {
					action_id: "failed-read",
					tool_name: "read",
					transport: { tool_ok: false },
					content_excerpt: "ENOENT: missing.txt",
				},
			},
		]);
		assert.equal(f.board.byType.Fact.length, 0, "transport failure remains unverified");
		assert.equal(f.state.pending_actions["failed-read"].status, "completed");
		assert.match(
			buildRam(f),
			/tool_ok[^\n]*false|ENOENT|transport[^\n]*fail/i,
			"RAM reports only completed and loses the error",
		);
	});

	await check("RR-09 ordinary RAM continues to isolate foreign Episode data", async () => {
		const f = await fixture([observation(1, "CURRENT_ONLY_917"), observation(2, "FOREIGN_ONLY_917", true)]);
		const ram = buildRam(f);
		assert.ok(ram.includes("CURRENT_ONLY_917"));
		assert.ok(!ram.includes("FOREIGN_ONLY_917"));
	});

	await check("RR-10 ordinary tool completion cannot manufacture a verified Outcome", async () => {
		const f = await fixture([
			{ event_type: "action.requested", payload: { action_id: "a", tool_name: "read" } },
			{ event_type: "action.completed", payload: { action_id: "a", tool_name: "read", transport: { tool_ok: true } } },
		]);
		assert.equal(f.board.byType.Fact.length, 0);
		assert.equal(f.events.filter((row) => row.event_type === "outcome.recorded").length, 0);
		assert.equal(f.state.pending_actions.a.status, "completed");
	});

	await check("RR-11 false expected values remain visible in verified propositions", async () => {
		const f = await fixture([outcome("disabled-criterion", false, { enabled: false }, "feature must remain disabled")]);
		assert.equal(f.board.currentByType.Fact.length, 1);
		assert.equal(f.board.currentByType.Fact[0].criterion.expected, false);
		assert.ok(buildRam(f).includes("false"), "falsy expected value and structured observed value both disappear");
	});
	console.log(`RAM reaudit: ${passed} pass / ${failed} fail`);
	if (failed) process.exitCode = 1;
} finally {
	await rm(root, { recursive: true, force: true });
}
