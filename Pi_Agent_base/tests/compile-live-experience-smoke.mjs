#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const COMPILER = join(ROOT, "Pi_Agent_base", "memory", "compile-live-experience.mjs");

function writeProjection(root, index) {
	const directory = join(root, `projection-${index}`);
	mkdirSync(directory, { recursive: true });
	const episodeId = `episode-${index}`;
	const stepOutcomeId = `step-outcome-${index}`;
	const episodeOutcomeId = `episode-outcome-${index}`;
	const experienceId = `experience-${index}`;
	const group = `live-group-${index}`;
	const experience = {
		schema_version: "1.0",
		experience_id: experienceId,
		status: "candidate",
		when: [{ path: "locked", op: "eq", value: true, verified_by: [`observation-${index}`] }],
		do: { tool: "edit", operation: "edit", arguments_template: { path: join(root, "fixture", "door.json") }, risk_class: "low" },
		expect: [{ path: "locked", op: "eq", value: false }],
		scope: { environment_fingerprint: "live-fixture-v1", domain: "fixture", permissions: ["fixture-only"], task_types: ["reproduce"], mode: "live" },
		support: { success_outcome_ids: [episodeOutcomeId], failure_outcome_ids: [], unknown_outcome_ids: [], independent_episode_count: 1, success_count: 1, failure_count: 0, unknown_count: 0 },
		provenance: { compiled_by: "test", compiler_version: "1", source_outcome_ids: [stepOutcomeId, episodeOutcomeId], source_episode_ids: [episodeId], source_kind: ["live"], compiled_at: "2026-09-28T00:00:00Z" },
		validation: { last_validated_at: "2026-09-28T00:00:00Z", replay_hash: `hash-${index}`, conflicts: [] },
		revision: 1,
		created_at: "2026-09-28T00:00:00Z",
		updated_at: "2026-09-28T00:00:00Z",
	};
	const episode = {
		schema_version: "1.0",
		episode_id: episodeId,
		status: "completed",
		source_kind: "live",
		goal: { goal_id: "unlock_fixture", description: "Unlock the fixture door", success_criteria: ["locked == false"] },
		authorization: { allowed_tools: ["edit"], target: "fixture/door.json", side_effects: "fixture-only" },
		environment: { environment_fingerprint: "live-fixture-v1", domain: "fixture", permissions: ["fixture-only"] },
		started_at: "2026-09-28T00:00:00Z",
		ended_at: "2026-09-28T00:00:01Z",
		event_ids: [`event-${index}`],
		steps: [{ step_id: `step-${index}`, index: 0, action_event_id: `action-${index}`, observation_event_ids: [`observation-${index}`], step_outcome_id: stepOutcomeId }],
		episode_outcome_id: episodeOutcomeId,
		provenance: { source_refs: [`experiment:test-${index}`], adapter: "test", adapter_version: "1" },
		episode_digest: `episode-hash-${index}`,
	};
	const outcome = (level, outcomeId, stepId) => ({
		schema_version: "1.0",
		outcome_id: outcomeId,
		level,
		episode_id: episodeId,
		...(stepId ? { step_id: stepId } : {}),
		status: "success",
		criterion: { criterion_id: "unlock_fixture", description: "Unlock the fixture door", expected: { locked: false } },
		observed: { locked: false },
		oracle: { oracle_id: "live-file-state-oracle", method: "deterministic_json_state_read", version: "0.1.0", independence_group: group },
		evidence_refs: [{ ref_type: "event", ref_id: `event-${index}` }],
		transport: { tool_ok: true, exit_code: null, timed_out: null, duration_ms: null },
		reproducibility: { replayable: false, replay_hash: `hash-${index}`, replay_count: 0, checked_at: "2026-09-28T00:00:01Z" },
		assessed_at: "2026-09-28T00:00:01Z",
	});
	const report = { schema_version: "1.0", experiment_id: `test-${index}`, outcome_status: "success", counts: { raw_events: 1, events: 1, episodes: 1, outcomes: 2, experiences: 1 } };
	writeFileSync(join(directory, "report.json"), `${JSON.stringify(report)}\n`);
	writeFileSync(join(directory, "episodes.json"), `${JSON.stringify([episode])}\n`);
	writeFileSync(join(directory, "outcomes.json"), `${JSON.stringify([outcome("step", stepOutcomeId, `step-${index}`), outcome("episode", episodeOutcomeId)])}\n`);
	writeFileSync(join(directory, "experiences.json"), `${JSON.stringify([experience])}\n`);
	return directory;
}

const root = mkdtempSync(join(tmpdir(), "aegis-live-compiler-"));
try {
	const first = writeProjection(root, 1);
	const second = writeProjection(root, 2);
	const output = join(root, "compiled");
	execFileSync(process.execPath, [COMPILER, "--projection", first, "--projection", second, "--output", output], { cwd: ROOT, stdio: "pipe" });
	const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
	const experience = JSON.parse(readFileSync(join(output, "experiences.json"), "utf8"))[0];
	if (report.counts.episodes !== 2 || report.counts.outcomes !== 4) throw new Error("compiler counts are incorrect");
	if (experience.support.independent_episode_count !== 2) throw new Error("independent episode count is incorrect");
	if (experience.status !== "candidate") throw new Error("live compiler must produce candidate");
	if (experience.do.arguments_template.path !== "fixture/door.json") throw new Error("absolute action paths were not normalized");
	if (!report.gate.reasons.includes("requires replayable evidence for activation")) throw new Error("replayability gate is missing");
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("live compiler smoke ok");
