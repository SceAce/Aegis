// A1 -- effective/current board projection with canonical Outcome.supersedes.
//
// The board keeps HISTORY (`byType`) and adds an EFFECTIVE view
// (`currentByType`). A correction supersedes the fact it replaces; an
// environment change marks dependent facts stale; nothing is deleted, and an
// untrusted or out-of-scope supersede must never retire a verified fact.
//
// Run: node tests/aegis-runtime-effective-board.mjs

import { projectBoard, summarizeBoard, resolveEffective } from "../memory/board.mjs";
import { projectState } from "../memory/state.mjs";
import { buildRam } from "../memory/ram.mjs";
import { evaluateHandoff } from "../session/handoff.mjs";

let failures = 0;
function check(name, condition, detail = "") {
	if (condition) {
		console.log(`ok - ${name}`);
	} else {
		failures += 1;
		console.log(`not ok - ${name}${detail ? ` :: ${detail}` : ""}`);
	}
}

let counter = 0;
function ev(event_type, payload, { episode = "ep-1", kind = "oracle", recordedAt } = {}) {
	counter += 1;
	return {
		event_type,
		episode_id: episode,
		payload,
		source: { kind, actor_id: "test", source_id: "test" },
		event_id: `evt-${counter}`,
		evidence_refs: payload?.evidence_refs ?? [],
		recorded_at: recordedAt ?? new Date(1_700_000_000_000 + counter * 1000).toISOString(),
	};
}

function started(episode = "ep-1", taskId = "task-1", goal = "open the door") {
	return ev("episode.started", { task_id: taskId, session_id: "s1", goal: { description: goal }, authorization: "task", budget: "unknown" }, { episode });
}

function outcome(outcomeId, { status = "success", criterionId = "c1", expected = "door opens", observed = "open", taskId = "task-1", episode = "ep-1", kind = "oracle", independent = true, supersedes, scope, source = "platform" } = {}) {
	return ev(
		"outcome.recorded",
		{
			schema_version: "1.0",
			outcome_id: outcomeId,
			status,
			criterion: { criterion_id: criterionId, description: criterionId, expected },
			observed,
			oracle: { oracle_id: "grader" },
			evidence_refs: [{ ref_type: "file", ref_id: `${outcomeId}.txt` }],
			transport: {},
			failure_mode: null,
			provenance: { independent, source, task_id: taskId },
			...(supersedes ? { supersedes } : {}),
			...(scope ? { scope } : {}),
		},
		{ episode, kind },
	);
}

function boardOf(events) {
	return projectBoard(events);
}
function stateOf(events) {
	return projectState(events);
}

// ---------------------------------------------------------------------------
// 1. A valid correction retires the prior fact from the EFFECTIVE view only.
// ---------------------------------------------------------------------------
{
	const events = [started(), outcome("out-1"), outcome("out-2", { observed: "closed", supersedes: "out-1" })];
	const board = boardOf(events);
	check("history keeps both facts", board.byType.Fact.length === 2, JSON.stringify(board.byType.Fact.map((n) => n.outcome_id)));
	check("the correction is the only effective fact", board.currentByType.Fact.length === 1 && board.currentByType.Fact[0].outcome_id === "out-2", JSON.stringify(board.currentByType.Fact.map((n) => n.outcome_id)));
	const original = board.byType.Fact.find((n) => n.outcome_id === "out-1");
	const corrected = board.byType.Fact.find((n) => n.outcome_id === "out-2");
	check("the superseded fact is retained with effective_status=superseded", original?.effective_status === "superseded" && original?.superseded_by === "out-2", JSON.stringify(original));
	check("the superseding fact is effective", corrected?.effective_status === "current");
	check("no invalid supersede was recorded", board.effective.invalid_supersedes.length === 0, JSON.stringify(board.effective.invalid_supersedes));
	check("effective_digest differs from history digest when a fact retires", board.effective_digest !== board.digest);
	// RAM/Handoff must see only the effective fact.
	const ram = buildRam({ board, state: stateOf(events), episodeId: "ep-1", goal: "open the door" });
	check("RAM names the corrected observation but not the retired one", ram.includes("observed: closed") && !ram.includes("observed: open"), ram.slice(0, 600));
	const verdict = evaluateHandoff({ state: stateOf(events), board, ram, episodeId: "ep-1", reason: "resume", requestId: "r1" });
	check("handoff carries only the effective fact", verdict.allowed && verdict.handoff.facts.length === 1 && /observed: closed/.test(verdict.handoff.facts[0]), JSON.stringify(verdict.handoff?.facts));
	check("handoff exposes the effective digest", verdict.allowed && verdict.handoff.effective_digest === board.effective_digest);
}

// ---------------------------------------------------------------------------
// 2. `unknown` is not a lucky guess: it retires the prior fact and adds no fact.
// ---------------------------------------------------------------------------
{
	const events = [started(), outcome("u1"), outcome("u2", { status: "unknown", observed: null, supersedes: "u1" })];
	const board = boardOf(events);
	check("an unknown re-observation retires the old fact", board.currentByType.Fact.length === 0, JSON.stringify(board.currentByType.Fact.map((n) => n.outcome_id)));
	check("the unknown stays a Hint, never a Fact", board.currentByType.Hint.length === 1 && board.currentByType.Fact.length === 0);
	check("the retired fact is marked superseded, not deleted", board.byType.Fact.find((n) => n.outcome_id === "u1")?.effective_status === "superseded");
}

// ---------------------------------------------------------------------------
// 3. Untrusted / foreign / missing supersedes are refused.
// ---------------------------------------------------------------------------
{
	const llm = boardOf([started(), outcome("l1"), outcome("l2", { supersedes: "l1", kind: "llm" })]);
	check("an LLM supersede cannot retire a verified fact", llm.currentByType.Fact.length === 1 && llm.currentByType.Fact[0].outcome_id === "l1", JSON.stringify(llm.effective.invalid_supersedes));
	check("the LLM supersede is reported invalid with reason=llm", llm.effective.invalid_supersedes[0]?.reason === "llm", JSON.stringify(llm.effective.invalid_supersedes));

	const foreign = boardOf([started(), outcome("f1"), outcome("f2", { supersedes: "f1", episode: "ep-2" })]);
	check("a supersede from another episode cannot retire a fact", foreign.currentByType.Fact.length >= 1 && foreign.currentByType.Fact.some((n) => n.outcome_id === "f1"), JSON.stringify(foreign.effective.invalid_supersedes));
	check("the foreign supersede is reported invalid with reason=foreign", foreign.effective.invalid_supersedes.some((x) => x.reason === "foreign"), JSON.stringify(foreign.effective.invalid_supersedes));

	const missing = boardOf([started(), outcome("m1", { supersedes: "does-not-exist" })]);
	check("a supersede of a missing target is refused", missing.effective.invalid_supersedes.some((x) => x.reason === "missing"), JSON.stringify(missing.effective.invalid_supersedes));
	check("the new fact remains effective despite the bogus supersede", missing.currentByType.Fact.some((n) => n.outcome_id === "m1"));

	// A bare `runtime` note (e.g. an unverified contest correction) is NOT oracle/human.
	const runtimeSrc = boardOf([
		started(),
		outcome("r1"),
		ev("outcome.recorded", { outcome_id: "r2", status: "success", criterion: { criterion_id: "c1", expected: "door opens" }, observed: "x", evidence_refs: [{ ref_type: "file", ref_id: "r2.txt" }], provenance: { independent: true, source: "platform", task_id: "task-1" }, supersedes: "r1" }, { episode: "ep-1", kind: "runtime" }),
	]);
	check("a runtime-source supersede is refused as untrusted", runtimeSrc.effective.invalid_supersedes.some((x) => x.reason === "untrusted"), JSON.stringify(runtimeSrc.effective.invalid_supersedes));
	check("the original fact stays effective after an untrusted supersede", runtimeSrc.currentByType.Fact.some((n) => n.outcome_id === "r1"));

	// An evidence-free `unknown` is silence, not a retraction.
	const noEvidence = boardOf([
		started(),
		outcome("ne1"),
		ev("outcome.recorded", { outcome_id: "ne2", status: "unknown", criterion: { criterion_id: "c1", expected: "door opens" }, observed: null, evidence_refs: [], provenance: { independent: true, source: "platform", task_id: "task-1" }, supersedes: "ne1" }, { episode: "ep-1", kind: "oracle" }),
	]);
	check("an evidence-free unknown supersede is refused", noEvidence.effective.invalid_supersedes.some((x) => x.reason === "no_evidence"), JSON.stringify(noEvidence.effective.invalid_supersedes));
	check("the original fact stays effective after a no-evidence supersede", noEvidence.currentByType.Fact.some((n) => n.outcome_id === "ne1"));

	// A correction can never point at the FUTURE (a target recorded later).
	const future = boardOf([started(), outcome("fu2", { supersedes: "fu1" }), outcome("fu1")]);
	check("a supersede of a future outcome is refused as missing", future.effective.invalid_supersedes.some((x) => x.reason === "missing"), JSON.stringify(future.effective.invalid_supersedes));
	check("the future target stays effective", future.currentByType.Fact.some((n) => n.outcome_id === "fu1"));
}

// ---------------------------------------------------------------------------
// 4. Cycle: mutually superseding facts are both refused (no arbitrary winner).
// ---------------------------------------------------------------------------
{
	const a = outcome("a1");
	const b = outcome("b1", { supersedes: "a1" });
	const a2 = outcome("a2", { supersedes: "b1" });
	const cyc = boardOf([started(), a, b, a2]);
	check("a supersede chain without a cycle resolves", cyc.effective.invalid_supersedes.length === 0, JSON.stringify(cyc.effective.invalid_supersedes));

	// Direct 2-cycle via named ids.
	const e1 = ev("outcome.recorded", { outcome_id: "x1", status: "success", criterion: { criterion_id: "c", expected: "e" }, observed: "o", evidence_refs: [{ ref_type: "file", ref_id: "x" }], provenance: { independent: true, source: "platform", task_id: "task-1" }, supersedes: "x2" }, { episode: "ep-1" });
	const e2 = ev("outcome.recorded", { outcome_id: "x2", status: "success", criterion: { criterion_id: "c", expected: "e" }, observed: "o", evidence_refs: [{ ref_type: "file", ref_id: "x" }], provenance: { independent: true, source: "platform", task_id: "task-1" }, supersedes: "x1" }, { episode: "ep-1" });
	const cycleBoard = boardOf([started(), e1, e2]);
	check("both sides of a cycle are refused with reason=cycle", cycleBoard.effective.invalid_supersedes.length === 2 && cycleBoard.effective.invalid_supersedes.every((x) => x.reason === "cycle"), JSON.stringify(cycleBoard.effective.invalid_supersedes));
	check("no fact is retired by a cycle", cycleBoard.currentByType.Fact.length === 2, JSON.stringify(cycleBoard.currentByType.Fact.map((n) => n.outcome_id)));
}

// ---------------------------------------------------------------------------
// 5. Criterion / scope / subject mismatches are refused.
// ---------------------------------------------------------------------------
{
	const mismatched = boardOf([started(), outcome("k1", { criterionId: "c1", expected: "door opens" }), outcome("k2", { criterionId: "c2", expected: "alarm silent", supersedes: "k1" })]);
	check("a supersede across criteria is refused", mismatched.effective.invalid_supersedes.some((x) => x.reason === "criterion_mismatch"), JSON.stringify(mismatched.effective.invalid_supersedes));
	check("the original fact stays effective after a criterion mismatch", mismatched.currentByType.Fact.some((n) => n.outcome_id === "k1"));

	const scoped = boardOf([started(), outcome("s1", { scope: "env-A" }), outcome("s2", { scope: "env-B", supersedes: "s1" })]);
	check("a supersede across scopes is refused", scoped.effective.invalid_supersedes.some((x) => x.reason === "scope_mismatch"), JSON.stringify(scoped.effective.invalid_supersedes));

	const subject = boardOf([started(), outcome("j1", { expected: "door opens" }), outcome("j2", { expected: "window opens", supersedes: "j1" })]);
	check("a supersede across subjects is refused", subject.effective.invalid_supersedes.some((x) => x.reason === "subject_mismatch"), JSON.stringify(subject.effective.invalid_supersedes));
}

// ---------------------------------------------------------------------------
// 6. environment.changed marks dependent facts stale, never deletes them.
// ---------------------------------------------------------------------------
{
	const events = [started(), outcome("env1", { scope: "env-A" }), ev("environment.changed", { scope: "env-A", reason: "kernel upgraded" }, { episode: "ep-1", kind: "human" })];
	const board = boardOf(events);
	check("an environment change becomes an Artifact on the board", board.byType.Artifact.length === 1, JSON.stringify(board.byType.Artifact.map((n) => n.type)));
	check("a dependent fact leaves the effective view", board.currentByType.Fact.length === 0, JSON.stringify(board.currentByType.Fact.map((n) => n.outcome_id)));
	check("the stale fact is kept in history with effective_status=stale", board.byType.Fact.find((n) => n.outcome_id === "env1")?.effective_status === "stale");
	check("the stale node id is reported", board.effective.stale_node_ids.length === 1, JSON.stringify(board.effective.stale_node_ids));
	check("the environment change scope is reported", board.effective.environment_changes.some((c) => c.scope === "env-A"), JSON.stringify(board.effective.environment_changes));

	const untrusted = boardOf([started(), outcome("env2", { scope: "env-A" }), ev("environment.changed", { scope: "env-A" }, { episode: "ep-1", kind: "llm" })]);
	check("an LLM environment.changed does NOT mark a fact stale", untrusted.currentByType.Fact.length === 1 && untrusted.byType.Fact.find((n) => n.outcome_id === "env2")?.effective_status === "current", JSON.stringify(untrusted.effective));

	// A change with no scope must NOT stop the whole graph (fail closed).
	const noScope = boardOf([started(), outcome("ns1", { scope: "env-A" }), ev("environment.changed", { reason: "unknown env" }, { episode: "ep-1", kind: "human" })]);
	check("a scope-less environment change stales nothing", noScope.currentByType.Fact.some((n) => n.outcome_id === "ns1") && noScope.effective.stale_node_ids.length === 0, JSON.stringify(noScope.effective));

	// Only bindings recorded BEFORE the change are affected; a re-verification
	// after the change is the new current fact, and the old one stays stale.
	const revalidated = boardOf([
		started(),
		outcome("rv1", { scope: "env-A" }),
		ev("environment.changed", { scope: "env-A" }, { episode: "ep-1", kind: "human" }),
		outcome("rv2", { scope: "env-A", observed: "open again" }),
	]);
	check("a fact re-verified after the change stays current", revalidated.currentByType.Fact.some((n) => n.outcome_id === "rv2"), JSON.stringify(revalidated.currentByType.Fact.map((n) => n.outcome_id)));
	check("the pre-change fact is stale, not current", revalidated.currentByType.Fact.every((n) => n.outcome_id !== "rv1") && revalidated.byType.Fact.find((n) => n.outcome_id === "rv1")?.effective_status === "stale", JSON.stringify(revalidated.effective));

	// A change AFTER the re-verification stales it again.
	const later = boardOf([
		started(),
		outcome("lt1", { scope: "env-A" }),
		ev("environment.changed", { scope: "env-A" }, { episode: "ep-1", kind: "human" }),
		outcome("lt2", { scope: "env-A" }),
		ev("environment.changed", { scope: "env-A" }, { episode: "ep-1", kind: "human" }),
	]);
	check("a change after a re-verification stales it again", later.currentByType.Fact.length === 0 && later.effective.stale_node_ids.length === 2, JSON.stringify(later.effective.stale_node_ids));
}

// ---------------------------------------------------------------------------
// 6b. A target change stales an OBSERVATION-derived Fact (which has no
//     outcome_id) via a TRUSTED, SPECIFIC scope; a different scope survives.
// ---------------------------------------------------------------------------
{
	const observation = (eventId, scope, digestValue) =>
		ev(
			"observation.captured",
			{ verified: true, text: `bits=64 (${scope})`, value: { bits: 64, file_digest: digestValue }, scope, target_fingerprint: digestValue, observation_kind: "file_identity", evidence_refs: [{ ref_type: "artifact", ref_id: scope, digest: digestValue }] },
			{ kind: "oracle" },
		);
	const board = boardOf([
		started(),
		observation("o-a", "a.bin", "sha256:a"),
		observation("o-b", "b.bin", "sha256:b"),
		ev("environment.changed", { scope: "a.bin", reason: "a.bin content changed" }, { kind: "oracle" }),
	]);
	check("an observation-derived Fact leaves the effective view when its exact scope changes", !board.currentByType.Fact.some((n) => n.scope === "a.bin"), JSON.stringify(board.currentByType.Fact.map((n) => n.scope)));
	check("a DIFFERENT scope's observation Fact is NOT broadly cleared", board.currentByType.Fact.some((n) => n.scope === "b.bin"));
	check("a scope-less change stales no observation Fact", boardOf([started(), observation("o-c", "c.bin", "sha256:c"), ev("environment.changed", { reason: "unknown" }, { kind: "oracle" })]).currentByType.Fact.some((n) => n.scope === "c.bin"));
}

// ---------------------------------------------------------------------------
// 7. Structured node fields survive projection (no bare words).
// ---------------------------------------------------------------------------
{
	const board = boardOf([started(), outcome("st1", { criterionId: "login-ok", expected: "user can log in", observed: "login succeeded" })]);
	const node = board.byType.Fact.find((n) => n.outcome_id === "st1");
	check("the node keeps criterion/observed/outcome_id", node?.criterion?.criterion_id === "login-ok" && node?.observed === "login succeeded" && node?.outcome_id === "st1", JSON.stringify(node));
	check("the node keeps normalized evidence refs", Array.isArray(node?.evidence_refs) && node.evidence_refs.length === 1);
	check("the node exposes a verified status", node?.status === "verified");
	const summary = summarizeBoard(board);
	check("summarizeBoard reports effective counts and digests", summary.effective_counts && typeof summary.effective_digest === "string" && summary.superseded === 0 && summary.invalid_supersedes === 0, JSON.stringify(summary));
}

// ---------------------------------------------------------------------------
// 8. resolveEffective is also directly usable and reports invalid reasons.
// ---------------------------------------------------------------------------
{
	const events = [started(), outcome("d1"), outcome("d2", { supersedes: "d1", kind: "llm" })];
	const nodes = boardOf(events).nodes;
	const resolved = resolveEffective(events, nodes);
	check("resolveEffective returns a superseded Map and invalid list", resolved.superseded instanceof Map && Array.isArray(resolved.invalid));
	check("an invalid supersede yields no retirement", resolved.superseded.size === 0 && resolved.invalid.length === 1);
}

if (failures > 0) {
	console.log(`\naegis-runtime-effective-board FAILED: ${failures} assertion(s)`);
	process.exit(1);
}
console.log("\naegis-runtime-effective-board ok");
