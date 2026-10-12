// Offline unit test for the Aegis runtime core library (no Pi, no model).
//
// Covers the A/B core contract from docs/IMPLEMENTATION_TASK.md:
//   * single-writer append-only EventLog: append, replay, digest/chain verify,
//     duplicate/corrupt rejection, and refusal to append after corruption;
//   * six-node board projection and the fact-write gate (an LLM can never write
//     Fact/Refuted);
//   * replaying the same events rebuilds the SAME board;
//   * one Episode kept for one task across prompts;
//   * a handoff is refused while an action is unfinished and allowed after;
//   * RAM separates verified facts from claims and lists pending actions.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, digest, eventDigest, verifyChain, LEGACY_SCHEMA_VERSION, RUNTIME_SCHEMA_VERSION } from "../memory/runtime/events.mjs";
import { projectBoard, summarizeBoard } from "../memory/runtime/board.mjs";
import { projectState, resolveOpenEpisode, pendingActionsFor } from "../memory/runtime/state.mjs";
import { buildRam } from "../memory/runtime/ram.mjs";
import { validateProposal } from "../memory/runtime/proposal.mjs";
import { evaluateHandoff } from "../memory/runtime/handoff.mjs";
import { appendContestOutcome, resultToOutcome, outcomeEvidenceRefs } from "../memory/runtime/contest-bridge.mjs";

let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

const temp = await mkdtemp(join(tmpdir(), "aegis-runtime-core-"));
const logPath = join(temp, "events.jsonl");
const log = new EventLog(logPath);
const opened = await log.open();
check("fresh log opens and is healthy", opened.ok && log.isAuditAvailable());

const src = (kind) => ({ actor_id: "test", kind, adapter: "aegis-runtime-test", version: "0.1.0" });
const ep = "ep-0001";

const r1 = await log.append({
	event_type: "episode.started",
	episode_id: ep,
	payload: { task_id: "task-1", goal: { description: "unlock the fixture door" }, authorization: { allowed: ["fixture.unlock"] }, budget: { model_requests: 2 } },
	source: src("runtime"),
});
check("episode.started appended", r1.ok && r1.event.schema_version === LEGACY_SCHEMA_VERSION);

await log.append({ event_type: "prompt.received", episode_id: ep, payload: { prompt_digest: digest("p1") }, source: src("runtime") });
await log.append({ event_type: "prompt.received", episode_id: ep, payload: { prompt_digest: digest("p2") }, source: src("runtime") });
await log.append({
	event_type: "proposal.submitted",
	episode_id: ep,
	payload: { kind: "claim", node_kind: "hint", text: "the door is probably locked", source_refs: [] },
	source: src("llm"),
});
await log.append({
	event_type: "proposal.submitted",
	episode_id: ep,
	payload: { kind: "intent", node_kind: "intent", text: "read door.json to observe state" },
	source: src("llm"),
});
// An LLM claiming a verified observation must be downgraded to Hint.
await log.append({
	event_type: "observation.captured",
	episode_id: ep,
	payload: { verified: true, text: "LLM says the door is unlocked" },
	source: src("llm"),
});
// An Oracle-verified observation becomes a Fact. Per the hardened board gate it
// must carry an observed value, its own evidence, and a target revision
// (digest/fingerprint); a bare `{verified:true}` claim is only a Hint.
await log.append({
	event_type: "observation.captured",
	episode_id: ep,
	payload: { verified: true, observation_kind: "file_identity", subject: "door.json", text: "door.json locked=true", value: { format: "JSON", locked: true, file_digest: "sha256:door" }, target_fingerprint: "sha256:door", source_refs: ["file:door.json"] },
	source: src("oracle"),
	evidence_refs: [{ ref_type: "artifact", ref_id: "door.json", digest: "sha256:door" }],
});
await log.append({
	event_type: "outcome.recorded",
	episode_id: ep,
	payload: {
		status: "success",
		source: "platform",
		independent: true,
		task_id: "task-1",
		criterion: { criterion_id: "c1", description: "door unlocked", expected: true },
		observed: true,
		oracle: { oracle_id: "platform", method: "platform_score", version: "1.0", independence_group: null },
	},
	source: src("human"),
	evidence_refs: [{ ref_type: "platform_result", ref_id: "r-1" }],
});
await log.append({
	event_type: "outcome.recorded",
	episode_id: ep,
	payload: {
		status: "failure",
		source: "human",
		independent: true,
		text: "attempt with wrong target",
		criterion: { criterion_id: "c2", description: "door unlocked", expected: true },
		observed: false,
		failure_mode: "postcondition_failed",
		preconditions_verified: true,
		oracle: { oracle_id: "human", method: "human_review", version: "1.0", independence_group: null },
	},
	source: src("human"),
	evidence_refs: [{ ref_type: "human_review", ref_id: "r-2" }],
});
// Negative: a bare human status with no criterion/evidence must NOT create a
// Fact/Refuted; it degrades to a Hint.
await log.append({
	event_type: "outcome.recorded",
	episode_id: ep,
	payload: { status: "success", source: "human" },
	source: src("human"),
});
// Negative: a transport error/timeout is unknown, not a refutation.
await log.append({
	event_type: "outcome.recorded",
	episode_id: ep,
	payload: {
		status: "failure",
		source: "platform",
		independent: true,
		criterion: { criterion_id: "c3", description: "x", expected: true },
		failure_mode: "timeout",
	},
	source: src("human"),
	evidence_refs: [{ ref_type: "platform_result", ref_id: "r-3" }],
});
// Negative (audit item 3): `postcondition_failed` alone must NOT create a
// Refuted node — the preconditions must ALSO have been verified. Without
// `preconditions_verified: true` this is a Hint, never a refutation.
await log.append({
	event_type: "outcome.recorded",
	episode_id: ep,
	payload: {
		status: "failure",
		source: "platform",
		independent: true,
		criterion: { criterion_id: "c4", description: "fail-without-verified-preconditions", expected: true },
		observed: false,
		failure_mode: "postcondition_failed",
	},
	source: src("human"),
	evidence_refs: [{ ref_type: "platform_result", ref_id: "r-4" }],
});
await log.append({ event_type: "action.requested", episode_id: ep, payload: { action_id: "a1", tool_name: "bash" }, source: src("runtime") });
await log.append({ event_type: "action.completed", episode_id: ep, payload: { action_id: "a1", tool_name: "bash" }, source: src("runtime") });

const events = log.replay();
const board = projectBoard(events);
const summary = summarizeBoard(board);
check("board projects Origin/Fact/Refuted/Intent/Hint/Artifact", ["Origin", "Fact", "Refuted", "Intent", "Hint", "Artifact"].every((t) => summary.counts[t] >= 1), JSON.stringify(summary.counts));
check("LLM-claimed verified observation is downgraded, not a Fact", board.byType.Hint.some((n) => n.text.includes("LLM says the door is unlocked") && n.downgraded_from === "Fact"));
check("Oracle observation creates a verified Fact", board.byType.Fact.some((n) => n.status === "verified" && n.text.includes("locked=true")));
// Contract change (documented in docs/MEMORY_SCHEMA_NOTES.md): a Fact/Refuted
// node now states the PROPOSITION that was verified (criterion.expected plus the
// observed value), not a bare `outcome:<status>`. The provenance block carries
// the canonical source/independent fields.
check("human success creates a Fact and human failure a Refuted", board.byType.Fact.some((n) => n.text.includes("true [observed: true]") && n.text.includes("platform")) && board.byType.Refuted.some((n) => n.text.includes("true [observed: false]")));
// Audit item 3: postcondition_failed WITHOUT verified preconditions must NOT
// refute. The c4 outcome degrades to a Hint and never becomes a Refuted node.
check("postcondition_failed without preconditions_verified is NOT a Refuted", board.byType.Hint.some((n) => /preconditions were not verified/.test(n.downgrade_reason || "")) && !board.byType.Refuted.some((n) => n.text.includes("fail-without-verified-preconditions")) && board.byType.Refuted.length === 1);
// Negative gates: the bare status and the timeout must be Hints, never Fact/Refuted.
check("bare human status without criterion/evidence is NOT a Fact", !board.byType.Fact.some((n) => n.text.includes("outcome:success (human)")));
check("timeout outcome is NOT a Refuted", !board.byType.Refuted.some((n) => n.text.includes("outcome:failure (platform)")));
check("downgraded outcomes carry their reason", board.byType.Hint.some((n) => /not from an independent|outcome status has no observed value|failure_mode=timeout/.test(n.downgrade_reason || "")));
const outcomeFact = board.byType.Fact.find((n) => n.text.includes("true [observed: true]"));
check("Fact evidence refs are normalized objects, not bare strings", Array.isArray(outcomeFact.evidence_refs) && outcomeFact.evidence_refs.every((ref) => typeof ref === "object" && typeof ref.ref_type === "string"));

// Determinism: replaying the same events rebuilds the same board digest.
const rebuilt = projectBoard(log.replay());
check("event replay rebuilds the same board", rebuilt.digest === board.digest, `${rebuilt.digest} != ${board.digest}`);

// State: same task, same Episode, prompts counted, not restarted.
const state = projectState(events);
check("task maps to the original episode", state.tasks["task-1"] === ep);
check("same task resolves to the SAME open episode", resolveOpenEpisode(state, "task-1")?.episode_id === ep);
check("prompts are counted on the one episode", state.episodes[ep].prompts === 2);
check("only one episode.started for the task", events.filter((e) => e.event_type === "episode.started").length === 1);

// Handoff safety: pending actions block, completion allows.
const sw = src("llm");
const ramText = buildRam({ board, state, episodeId: ep, goal: "unlock the fixture door" });
check("RAM names verified facts separately from claims", ramText.includes("Verified facts") && ramText.includes("Historical proposals") && ramText.includes("NOT guidance"));
check("RAM lists unfinished actions section", ramText.includes("Unfinished actions"));
check("RAM states its character budget", /ram_estimated_chars/.test(ramText));
const tinyRam = buildRam({ board, state, episodeId: ep, goal: "unlock the fixture door", budgetChars: 200 });
check("an over-budget RAM reports what it dropped", /budget_drops:/.test(tinyRam));
check("an over-budget RAM still keeps the mandatory task/authorization/pending block", /total_goal:/.test(tinyRam) && /authorization:/.test(tinyRam) && /Unfinished actions/.test(tinyRam) && /ram_estimated_chars/.test(tinyRam));

await log.append({ event_type: "action.requested", episode_id: ep, payload: { action_id: "a2", tool_name: "edit" }, source: sw });
let stateWithPending = projectState(log.replay());
check("pending action is tracked", pendingActionsFor(stateWithPending, ep).length === 1);
const refused = evaluateHandoff({ state: stateWithPending, board: projectBoard(log.replay()), ram: ramText, episodeId: ep, reason: "too long", requestId: "r1" });
check("handoff is refused while an action is unfinished", refused.allowed === false && /unfinished/.test(refused.reason));
await log.append({ event_type: "action.completed", episode_id: ep, payload: { action_id: "a2", tool_name: "edit" }, source: sw });
stateWithPending = projectState(log.replay());
const allowed = evaluateHandoff({ state: stateWithPending, board: projectBoard(log.replay()), ram: ramText, episodeId: ep, reason: "context is long", requestId: "r2" });
check("handoff is allowed once no action is pending", allowed.allowed === true, allowed.reason);
check("handoff carries episode/authorization/budget/board digest", allowed.handoff?.episode_id === ep && allowed.handoff?.authorization && allowed.handoff?.budget && /^sha256:/.test(allowed.handoff?.board_digest || ""));
check("handoff preserves zero unfinished actions", Array.isArray(allowed.handoff?.pending_actions) && allowed.handoff.pending_actions.length === 0);

// Proposal validation.
check("valid claim accepted", validateProposal({ kind: "claim", text: "door is locked" }).accepted === true);
check("invalid kind 'fact' rejected", validateProposal({ kind: "fact", text: "x" }).accepted === false);
check("self-declared verified/active rejected", validateProposal({ kind: "claim", text: "x", verified: true, active: true }).accepted === false);
check("authorization override rejected", validateProposal({ kind: "intent", text: "x", authorization: { allow: "all" } }).accepted === false);

// Corruption handling: a duplicate event_id in a hand-edited file is refused.
const corruptPath = join(temp, "corrupt.jsonl");
const first = events[0];
const dup = { ...events[1], event_id: first.event_id };
dup.event_digest = eventDigest(dup);
await writeFile(corruptPath, `${JSON.stringify(first)}\n${JSON.stringify(dup)}\n`, "utf8");
const corruptLog = new EventLog(corruptPath);
const corruptOpen = await corruptLog.open();
check("corrupt chain is detected on open", corruptOpen.ok === false && corruptLog.isAuditAvailable() === false);
const refusedAppend = await corruptLog.append({ event_type: "runtime.note", episode_id: ep, payload: {}, source: src("runtime") });
check("append is refused on a corrupt log", refusedAppend.ok === false);

// An unknown event type is refused even with an explicit schema_version.
const fresh = new EventLog(join(temp, "strict.jsonl"));
await fresh.open();
const unknown = await fresh.append({ event_type: "totally.new.event", episode_id: ep, payload: {}, source: src("runtime") });
check("unknown event type without explicit schema is refused", unknown.ok === false && /unknown event_type/.test(unknown.error || ""));
const unknownExplicit = await fresh.append({ event_type: "totally.new.event", episode_id: ep, payload: {}, source: src("runtime"), schema_version: "2.0-experimental" });
check("unknown event type is refused even with an explicit schema_version (no ad-hoc writes)", unknownExplicit.ok === false);
const unknownMajor = await fresh.append({ event_type: "runtime.note", episode_id: ep, payload: {}, source: src("runtime"), schema_version: "2.0-experimental" });
check("known event type with an unknown major schema_version is refused", unknownMajor.ok === false && /unknown schema_version/.test(unknownMajor.error || ""));
const knownMinor = await fresh.append({ event_type: "runtime.note", episode_id: ep, payload: {}, source: src("runtime"), schema_version: "1.1" });
check("known event type with a known schema_version is accepted", knownMinor.ok === true);
const badKind = await fresh.append({ event_type: "runtime.note", episode_id: ep, payload: {}, source: { actor_id: "x", kind: "wizard", adapter: "a", version: "1" } });
check("an unknown source.kind is refused at the append boundary", badKind.ok === false && /source.kind/.test(badKind.error || ""));

// verifyChain exposes errors directly too.
const broken = verifyChain([{ ...events[0], payload: { tampered: true } }]);
check("verifyChain detects a tampered payload", broken.ok === false);

// Durability is fail-closed: if fsync fails, the append reports NOT ok and the
// log is marked unhealthy so no side effect is permitted on a non-durable row.
const syncFailPath = join(temp, "sync-fail.jsonl");
const syncFailLog = new EventLog(syncFailPath, {
	sync: async () => {
		throw new Error("simulated fsync failure");
	},
});
await syncFailLog.open();
const syncFailResult = await syncFailLog.append({ event_type: "runtime.note", episode_id: ep, payload: {}, source: src("runtime") });
check("a failed fsync makes the append fail (not silently durable)", syncFailResult.ok === false && /write\/fsync failed/.test(syncFailResult.error || ""));
check("a failed fsync marks the audit log unhealthy (fail-closed)", syncFailLog.isAuditAvailable() === false);
await syncFailLog.close();

// Directory-fsync failure: the ROW is written and file-synced, but the new
// directory entry is not durable. The log must (a) record the row in-memory so a
// retry cannot reuse its sequence/prev_digest and silently corrupt the chain,
// (b) report it as NOT durable, and (c) fail closed for all later appends.
const dirFailPath = join(temp, "dir-fail.jsonl");
const dirFailLog = new EventLog(dirFailPath, {
	dirSync: async () => {
		throw new Error("simulated directory fsync failure");
	},
});
await dirFailLog.open();
const dirFailFirst = await dirFailLog.append({ event_type: "runtime.note", episode_id: ep, payload: { note: "first" }, source: src("runtime") });
check("a failed directory fsync reports the append as not durable", dirFailFirst.ok === false && dirFailFirst.durable === false && /directory could not be fsynced/.test(dirFailFirst.error || ""));
check("a failed directory fsync still records the row in-memory exactly once", dirFailLog.replay().length === 1 && dirFailLog.replay()[0].event_id === dirFailFirst.event.event_id);
check("a failed directory fsync marks the log unhealthy (fail-closed)", dirFailLog.isAuditAvailable() === false);
const dirFailRetry = await dirFailLog.append({ event_type: "runtime.note", episode_id: ep, payload: { note: "retry" }, source: src("runtime") });
check("a retry after a directory-fsync failure does NOT append a second row", dirFailRetry.ok === false && dirFailLog.replay().length === 1);
await dirFailLog.close();
const dirFailOnDisk = (await readFile(dirFailPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
check("the on-disk chain after a directory-fsync failure is still a valid single row", dirFailOnDisk.length === 1 && verifyChain(dirFailOnDisk).ok);

// RAM must not leak another episode's facts/goal.
const ramOther = buildRam({ board, state, episodeId: "ep-other", goal: "a different task" });
check("RAM for an unknown episode shows no other episode's facts", !ramOther.includes("locked=true"));
check("RAM preserves the original goal, not the latest prompt", buildRam({ board, state, episodeId: ep, goal: "unlock the fixture door" }).includes("total_goal: unlock the fixture door"));

// A closed episode must be refused even with no pending actions.
await log.append({ event_type: "episode.closed", episode_id: ep, payload: { reason: "done" }, source: src("human") });
const closedState = projectState(log.replay());
const closedHandoff = evaluateHandoff({ state: closedState, board: projectBoard(log.replay()), ram: "", episodeId: ep, reason: "context long", requestId: "r-closed" });
check("handoff is refused for a closed episode", closedHandoff.allowed === false && /closed|is /.test(closedHandoff.reason));

// Contest bridge: the canonical source field is `result_source`, and an
// independent + evidenced result becomes a verified Fact; anything else is an
// unknown Hint. This is the negative test for the old bug where every row was
// written with human/oracle provenance.
const bridgeLog = new EventLog(join(temp, "bridge.jsonl"));
await bridgeLog.open();
const successRow = { task_id: "task-b", result: "success", result_source: "platform", independent: true, evidence: "score=100" };
const bridgeOk = await appendContestOutcome(bridgeLog, successRow, { episodeId: "ep-b" });
check("bridge reads result_source and returns a durable outcome", bridgeOk.ok === true && bridgeOk.event.event_type === "outcome.recorded");
check("bridge writes an independent platform outcome with a trusted source kind", bridgeOk.event.source.kind === "oracle" && bridgeOk.outcome.provenance.independent === true);
check("bridge outcome carries criterion + oracle + evidence refs", bridgeOk.outcome.criterion?.criterion_id !== undefined && bridgeOk.outcome.oracle?.oracle_id === "platform" && outcomeEvidenceRefs(successRow).length === 1);
const bridgeBoard = projectBoard(bridgeLog.replay());
check("an independent evidenced platform success creates a verified Fact", bridgeBoard.byType.Fact.some((n) => n.text.includes("score=100") || n.text.includes("outcome:success")));

const fakeRow = { task_id: "task-c", result: "success", result_source: "agent", independent: true, evidence: "model says so" };
const fakeOutcome = resultToOutcome(fakeRow);
check("a non-independent source degrades success to unknown", fakeOutcome.status === "unknown" && fakeOutcome.failure_mode === "insufficient_evidence");
const bridgeFake = await appendContestOutcome(bridgeLog, fakeRow, { episodeId: "ep-b" });
check("a non-independent result is written with an untrusted source kind", bridgeFake.event.source.kind === "runtime");
const fakeBoardNode = projectBoard(bridgeLog.replay()).byType.Hint.find((n) => n.text.includes("\"status\":\"unknown\"") || n.text.includes("outcome:unknown"));
check("a non-independent result never creates a Fact", !projectBoard(bridgeLog.replay()).byType.Fact.some((n) => n.text.includes("outcome:success (agent)")) && fakeBoardNode !== undefined);

const bareRow = { task_id: "task-d", result: "failure", result_source: "human", independent: true, evidence: "" };
const bareOutcome = resultToOutcome(bareRow);
check("failure without an evidence ref degrades to unknown (not Refuted)", bareOutcome.status === "unknown");
await bridgeLog.close();

check("schema version constants are explicit", LEGACY_SCHEMA_VERSION === "1.0" && RUNTIME_SCHEMA_VERSION === "1.1");
const persisted = await readFile(logPath, "utf8");
// The log must only ever GROW: every event ever appended is still on disk, in
// order, and the on-disk chain still verifies. Compare against the FINAL replay
// (the handoff section appends more events after the first replay()).
const finalEvents = log.replay();
const persistedRows = persisted.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
check("event log is append-only JSONL on disk", persistedRows.length === finalEvents.length && persistedRows.length > events.length && verifyChain(persistedRows).ok);
await log.close();
await corruptLog.close();
await fresh.close();

console.log("");
if (failures > 0) {
	console.error(`aegis-runtime-core-smoke FAILED (${failures} check${failures === 1 ? "" : "s"})`);
	process.exitCode = 1;
} else {
	console.log("aegis-runtime-core-smoke ok");
}
