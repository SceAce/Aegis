#!/usr/bin/env node
// Phase 3 (HC-14) — verified projection checkpoint + committed tail.
//
// The console Host may reuse a derived projection to avoid replaying an
// immutable prefix on every settle. This test proves:
//   * full replay and checkpoint reuse produce the SAME projection digest for
//     Board/current Intent, R1 consumptions, review hold, both counters, budget,
//     pending actions, handoff completions and Task state;
//   * a committed tail falls back to the same reducers and stays equal;
//   * stale / foreign / tampered / version-unknown / missing checkpoints fall
//     back to a complete replay (or are ignored) and change no authority;
//   * deleting the cache yields the same projection.
//
// Cost is reported as diagnostics (rows processed, elapsed ms) — no brittle
// millisecond gate, and no O(1) claim when the tail is replayed.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROJECTION_CHECKPOINT_VERSION,
	PROJECTION_REDUCER_VERSION,
	projectCommitted,
	projectionDigest,
	projectWithCheckpoint,
	readProjectionCheckpoint,
	verifyProjectionCheckpoint,
} from "../memory/projection-checkpoint.mjs";
import { EventLog, eventId } from "../shared/events.mjs";

const POLICY = { repeat_limit: 2, action_window: 8, min_distinct_routes: 4, context_pressure_percent: 85 };
const TASK = "checkpoint-task";
let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

async function appendEpisode(log, count) {
	const episodeId = eventId();
	await log.append({
		event_type: "episode.started",
		episode_id: episodeId,
		payload: { task_id: TASK, goal: { description: "checkpoint fixture" }, authorization: "read", budget: "unknown" },
		source: { actor_id: "pi", kind: "runtime", adapter: "test", version: "1" },
	});
	let unit = null;
	for (let index = 0; index < count; index += 1) {
		const actionId = `a${index}`;
		await log.append({
			event_type: "action.requested",
			episode_id: episodeId,
			payload: { action_id: actionId, tool_name: "bash", arguments_digest: `sha256:args-${index % 3}` },
		});
		await log.append({
			event_type: "action.completed",
			episode_id: episodeId,
			payload: { action_id: actionId, tool_name: "bash", status: "unknown", content_digest: `sha256:r-${index % 3}` },
		});
	}
	// A scoped Intent, a review with a real selection, and one consumption.
	unit = await log.append({
		event_type: "proposal.submitted",
		episode_id: episodeId,
		payload: { kind: "intent", text: "checkpoint unit", scope: "unit:a", source_refs: [] },
		source: { actor_id: "pi", kind: "llm", adapter: "test", version: "1" },
	});
	// Drive a real stall inside the unit window.
	for (let index = 0; index < 2; index += 1) {
		const actionId = `b${index}`;
		await log.append({
			event_type: "action.requested",
			episode_id: episodeId,
			payload: { action_id: actionId, tool_name: "bash", arguments_digest: "sha256:same" },
		});
		await log.append({
			event_type: "action.completed",
			episode_id: episodeId,
			payload: { action_id: actionId, tool_name: "bash", status: "unknown", content_digest: "sha256:same" },
		});
	}
	const { projectWorkCycle } = await import("../memory/work-cycle.mjs");
	const trigger = projectWorkCycle(log.replay(), episodeId, { policy: POLICY }).trigger_id;
	const selection = await log.append({
		event_type: "runtime.note",
		episode_id: episodeId,
		payload: {
			kind: "knowledge.selected",
			version: "knowledge-selection-1",
			mode: "work_review",
			work_review_trigger_id: trigger,
			query: "condition",
			status: "ready",
			selected: [{ knowledge_id: "web/x.json#1" }],
		},
		source: { actor_id: "pi", kind: "runtime", adapter: "test", version: "1" },
	});
	const review = await log.append({
		event_type: "runtime.note",
		episode_id: episodeId,
		payload: {
			kind: "work.review",
			version: "work-cycle-1",
			trigger_id: trigger,
			work_unit_id: "unit:a",
			work_unit_event_id: unit.event.event_id,
			evidence_event_ids: [],
			retrieval: { selection_event_id: selection.event.event_id, status: "ready", selected_knowledge_ids: [] },
			blocker: { text: "stalled" },
			next_step: { text: "try another condition" },
		},
		source: { actor_id: "pi", kind: "runtime", adapter: "test", version: "1" },
	});
	await log.append({
		event_type: "proposal.submitted",
		episode_id: episodeId,
		payload: {
			kind: "intent",
			text: "next unit",
			scope: "unit:b",
			source_refs: [{ ref_type: "event", ref_id: review.event.event_id }],
		},
		source: { actor_id: "pi", kind: "llm", adapter: "test", version: "1" },
	});
	await log.append({
		event_type: "agent.settled",
		episode_id: episodeId,
		payload: { session_id: "session-1", handle_ready: false, work_cycle_status: "awaiting_intent" },
	});
	await log.append({
		event_type: "handoff.completed",
		episode_id: episodeId,
		payload: {
			request_id: "req-1",
			from_session: "session-1",
			to_session: "session-2",
			work_cycle_identity: "review-hold:t:session-1",
		},
	});
	return episodeId;
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-checkpoint-"));
	const eventLogPath = join(base, "events.jsonl");
	const checkpointPath = join(base, "projections", "console-projection.json");
	mkdirSync(join(base, "projections"), { recursive: true });
	const log = new EventLog(eventLogPath);
	try {
		await log.open();
		const episodeId = await appendEpisode(log, 4);
		const rows = log.replay();
		const full = projectCommitted(rows, { taskId: TASK, policy: POLICY });
		const fullDigest = projectionDigest(full);
		check(
			"the fixture projects a real stall/review/consumption state",
			full.workCycle.consumptions.length === 1,
			JSON.stringify(full.workCycle.consumptions),
		);

		const first = await projectWithCheckpoint({ events: rows, taskId: TASK, policy: POLICY, checkpointPath });
		check("the first projection is a full replay", first.source === "full_replay");
		check("a checkpoint was written", (await readProjectionCheckpoint(checkpointPath)) !== null);
		check("full replay and the checkpoint agree", projectionDigest(first) === fullDigest);

		const reused = await projectWithCheckpoint({ events: rows, taskId: TASK, policy: POLICY, checkpointPath });
		check("an unchanged prefix reuses the checkpoint", reused.source === "checkpoint", reused.cache_reason);
		check("the reused projection is byte-identical in digest", projectionDigest(reused) === fullDigest);
		check("no reducer work was repeated for the unchanged prefix", reused.replayed_rows === 0);

		// Committed tail: same reducers, same answer.
		await log.append({
			event_type: "runtime.note",
			episode_id: episodeId,
			payload: { kind: "work.checkpoint", version: "work-cycle-1", unit_status: "complete", work_unit_id: "unit:b" },
			source: { actor_id: "pi", kind: "runtime", adapter: "test", version: "1" },
		});
		const tailRows = log.replay();
		const tailFull = projectCommitted(tailRows, { taskId: TASK, policy: POLICY });
		const withTail = await projectWithCheckpoint({ events: tailRows, taskId: TASK, policy: POLICY, checkpointPath });
		check("a committed tail falls back to the shared reducers", withTail.source === "full_replay");
		check(
			"the tail fallback is reported",
			String(withTail.cache_reason).startsWith("committed_tail_present"),
			withTail.cache_reason,
		);
		check("checkpoint+tail equals a full replay", projectionDigest(withTail) === projectionDigest(tailFull));
		check("the tail projection refreshes the cache", withTail.checkpoint.event_offset === tailRows.length);

		const current = await readProjectionCheckpoint(checkpointPath);
		const verifies = verifyProjectionCheckpoint(current, tailRows, {
			taskId: TASK,
			policyDigest: current.policy_digest,
			configDigest: current.config_digest,
		});
		check("the refreshed checkpoint verifies against the committed prefix", verifies.ok === true, verifies.reason);

		// Tampering must never change the answer.
		const tampered = structuredClone(current);
		tampered.projection.workCycle.review_required = !current.projection.workCycle.review_required;
		tampered.projection.workCycle.status = "tampered";
		tampered.projection.workCycle.action_count = 999;
		writeFileSync(checkpointPath, JSON.stringify(tampered));
		const afterTamper = await projectWithCheckpoint({ events: tailRows, taskId: TASK, policy: POLICY, checkpointPath });
		check(
			"a tampered projection is rejected",
			afterTamper.source === "full_replay" && afterTamper.cache_reason === "projection_digest_mismatch",
			JSON.stringify({ source: afterTamper.source, reason: afterTamper.cache_reason }),
		);
		check(
			"tampering cannot change the hold or the counters",
			projectionDigest(afterTamper) === projectionDigest(tailFull) &&
				afterTamper.workCycle.action_count === tailFull.workCycle.action_count,
			JSON.stringify({ count: afterTamper.workCycle.action_count }),
		);

		const offsetTamper = structuredClone(current);
		offsetTamper.event_offset = current.event_offset - 1;
		writeFileSync(checkpointPath, JSON.stringify(offsetTamper));
		const afterOffset = await projectWithCheckpoint({ events: tailRows, taskId: TASK, policy: POLICY, checkpointPath });
		check("a stale offset is rejected", afterOffset.source === "full_replay", afterOffset.cache_reason);
		check("a stale offset cannot change the projection", projectionDigest(afterOffset) === projectionDigest(tailFull));

		const policyTamper = structuredClone(current);
		policyTamper.policy_digest = "sha256:foreign";
		writeFileSync(checkpointPath, JSON.stringify(policyTamper));
		const afterPolicy = await projectWithCheckpoint({ events: tailRows, taskId: TASK, policy: POLICY, checkpointPath });
		check(
			"a foreign policy digest is rejected",
			afterPolicy.cache_reason === "policy_digest_mismatch",
			afterPolicy.cache_reason,
		);

		const foreignTask = structuredClone(current);
		foreignTask.task_id = "another-task";
		writeFileSync(checkpointPath, JSON.stringify(foreignTask));
		const afterForeign = await projectWithCheckpoint({
			events: tailRows,
			taskId: TASK,
			policy: POLICY,
			checkpointPath,
		});
		check(
			"a foreign task checkpoint is rejected",
			afterForeign.cache_reason === "foreign_task",
			afterForeign.cache_reason,
		);

		const versionTamper = structuredClone(current);
		versionTamper.version = "aegis-projection-checkpoint-999";
		writeFileSync(checkpointPath, JSON.stringify(versionTamper));
		const afterVersion = await projectWithCheckpoint({
			events: tailRows,
			taskId: TASK,
			policy: POLICY,
			checkpointPath,
		});
		check(
			"an unknown checkpoint version is rejected",
			afterVersion.cache_reason === "checkpoint_version_unknown",
			afterVersion.cache_reason,
		);

		const reducerTamper = structuredClone(current);
		reducerTamper.reducer_version = "another-reducer";
		writeFileSync(checkpointPath, JSON.stringify(reducerTamper));
		const afterReducer = await projectWithCheckpoint({
			events: tailRows,
			taskId: TASK,
			policy: POLICY,
			checkpointPath,
		});
		check(
			"an unknown reducer version is rejected",
			afterReducer.cache_reason === "reducer_version_unknown",
			afterReducer.cache_reason,
		);
		check("the current reducer version is pinned", current.reducer_version === PROJECTION_REDUCER_VERSION);

		// Missing cache: identical answer.
		rmSync(checkpointPath, { force: true });
		const afterDelete = await projectWithCheckpoint({ events: tailRows, taskId: TASK, policy: POLICY, checkpointPath });
		check("a deleted cache replays identically", projectionDigest(afterDelete) === projectionDigest(tailFull));
		writeFileSync(checkpointPath, "{ not json");
		const afterCorrupt = await projectWithCheckpoint({
			events: tailRows,
			taskId: TASK,
			policy: POLICY,
			checkpointPath,
		});
		check("an unreadable cache falls back to a full replay", afterCorrupt.source === "full_replay");
		check(
			"an unreadable cache cannot change the projection",
			projectionDigest(afterCorrupt) === projectionDigest(tailFull),
		);

		// Large synthetic prefix (diagnostics only, no brittle threshold).
		const big = new EventLog(join(base, "big.jsonl"));
		await big.open();
		await appendEpisode(big, 400);
		const bigRows = big.replay();
		await big.close();
		const bigPath = join(base, "projections", "big.json");
		const startCold = Date.now();
		const cold = await projectWithCheckpoint({
			events: bigRows,
			taskId: TASK,
			policy: POLICY,
			checkpointPath: bigPath,
		});
		const coldMs = Date.now() - startCold;
		const startWarm = Date.now();
		const warm = await projectWithCheckpoint({
			events: bigRows,
			taskId: TASK,
			policy: POLICY,
			checkpointPath: bigPath,
		});
		const warmMs = Date.now() - startWarm;
		check("the large prefix is equal cold vs warm", projectionDigest(cold) === projectionDigest(warm));
		check("the warm path used the checkpoint", warm.source === "checkpoint");
		check("the warm path processed no reducer rows", warm.replayed_rows === 0);
		console.log(
			`CHECKPOINT_PERF ${JSON.stringify({
				events: bigRows.length,
				cold_replayed_rows: cold.replayed_rows,
				cold_ms: coldMs,
				warm_replayed_rows: warm.replayed_rows,
				warm_ms: warmMs,
				checkpoint_version: PROJECTION_CHECKPOINT_VERSION,
			})}`,
		);
		check(
			"the checkpoint file is a plain deletable JSON cache",
			JSON.parse(readFileSync(bigPath, "utf8")).version === PROJECTION_CHECKPOINT_VERSION,
		);
	} finally {
		await log.close().catch(() => undefined);
		rmSync(base, { recursive: true, force: true });
	}

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exitCode = 1;
	} else {
		console.log("\nprojection checkpoint: full-replay/prefix+tail equality and fail-closed fallbacks passed");
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
