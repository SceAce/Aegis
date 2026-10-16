// Compiler for the fixture direct slice.
//
// The Compiler turns independently judged live Oracle projections into one
// fixture-only Experience. It is the only writer allowed to mark an Experience
// `active`. It enforces:
//   - at least two independent successful episodes (distinct trusted run_id +
//     independence_group + reset_nonce + episode_id), each re-validated from the
//     hash-chained event log, the trusted run record, and the authoritative
//     live pre/post state rather than trusted from `oracle-report.json`,
//   - verified preconditions and postconditions with resolving evidence refs,
//   - a single consistent rule (when/do/expect/scope),
//   - replayable evidence: each supporting outcome must carry an isolated replay
//     proof artifact that the Compiler re-hashes and links, through a
//     hash-chained `replay.verified` event, to this exact episode, run, action
//     spec and trusted pre-state (not merely a registered action id).
//
// `active` is never produced from one success, from copied/cloned run JSON, from
// a cross-source swap, from a tampered outcome status, or from two copied
// outputs that merely share a name. Replay-only promotion is not performed here.

import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	SCHEMA_VERSION,
	digest,
	evaluatePredicates,
	isoNow,
	newId,
	readJson,
	readJsonl,
	resolveInside,
	stable,
	unresolvedEventRefs,
	validateEventLog,
	writeJson,
} from "../shared/contracts.mjs";
import { actionSpecDigest, getAction } from "./action-registry.mjs";
import { validateRunRecord } from "./oracle.mjs";

export const COMPILER_VERSION = "0.2.0";

// Load one Oracle-judged experiment directory. Any missing/corrupt projection
// is a rejected source, never an exception that reaches the caller.
function loadJudged(root) {
	try {
		return loadJudgedUnsafe(root);
	} catch (error) {
		return { root, ok: false, reason: `unreadable projection: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// Independently rebuild the trust chain for one projection. The Compiler must
// not grant `active` from the projection's own self-reported status: it
// re-validates the trusted run record, the hash-chained event relationships,
// the action intent/completion pair, the step/episode outcome agreement, and
// the authoritative live pre/post state. Any inconsistency is a rejection.
function revalidateProjection({ root, manifest, run, report, events, episodes, outcomes }) {
	const reasons = [];
	const msg = (error) => (error instanceof Error ? error.message : String(error));

	// 1. Trusted run record: initial_state digest + persisted snapshot.
	const runCheck = validateRunRecord(root);
	if (!runCheck.ok) reasons.push(`trusted run record invalid: ${runCheck.reason}`);

	// 2. The run record must belong to this source directory and manifest. A
	// copied run.json keeps another experiment_id and is rejected here even if
	// the run_id was rewritten.
	if (run.experiment_id !== manifest.experiment_id) reasons.push("run.experiment_id does not match manifest.experiment_id");
	if (manifest.source_kind !== "live") reasons.push("manifest.source_kind is not live");
	if (run.experiment_id !== `fixture-${basename(root)}`) reasons.push("run.json was copied from another experiment directory");

	// 3. Event chain integrity.
	try {
		validateEventLog(events);
	} catch (error) {
		reasons.push(`event chain invalid: ${msg(error)}`);
	}

	// 4. Exactly one episode and its trusted observation.
	const startedEvents = events.filter((event) => event.event_type === "episode.started");
	if (startedEvents.length !== 1) reasons.push(`expected exactly one episode.started, found ${startedEvents.length}`);
	const started = startedEvents[0];
	const episodeId = started?.episode_id;
	if (!episodeId) reasons.push("episode.started has no episode_id");
	if (started && started.payload?.run_id !== run.run_id) reasons.push("episode.started run_id does not match run.json");
	if (started && started.payload?.independence_group !== run.independence_group) reasons.push("episode.started independence_group does not match run.json");
	if (started && started.payload?.source_kind !== "live") reasons.push("episode.started source_kind is not live");

	const episodeEvents = episodeId ? events.filter((event) => event.episode_id === episodeId) : [];
	if (episodeId && events.some((event) => event.episode_id !== episodeId)) reasons.push("event log contains events from a foreign episode");

	const observation = episodeEvents.find(
		(event) => event.event_type === "observation.captured" && event.payload?.source === "trusted_runner" && event.payload?.run_id === run.run_id,
	);
	if (!observation) {
		reasons.push("no trusted observation.captured event for this run");
	} else {
		if (observation.payload.independence_group !== run.independence_group) reasons.push("observation independence_group does not match run.json");
		if (digest(observation.payload.value) !== run.initial_state_digest) reasons.push("observation value digest does not match run.initial_state_digest");
		try {
			if (!evaluatePredicates(observation.payload.value, manifest.state.preconditions)) {
				reasons.push("trusted observed pre-state does not satisfy manifest preconditions");
			}
		} catch (error) {
			reasons.push(`precondition evaluation failed: ${msg(error)}`);
		}
	}

	// 5. The action intent and its completion must exist, be causally linked, and
	// agree with the manifest's registered operation/target.
	const requested = episodeEvents.find((event) => event.event_type === "action.requested");
	const completed = requested
		? episodeEvents.find((event) => event.event_type === "action.completed" && event.payload?.action_id === requested.payload?.action_id)
		: null;
	if (!requested) reasons.push("no action.requested event");
	if (!completed) reasons.push("no action.completed event matching action.requested");
	if (requested && completed) {
		if (!(requested.sequence < completed.sequence)) reasons.push("action.requested must precede action.completed");
		if (completed.causation_id !== requested.event_id) reasons.push("action.completed does not reference action.requested");
	}
	if (requested) {
		if (requested.payload?.action_ref !== manifest.action.action_id) reasons.push("action.requested action_ref does not match manifest.action.action_id");
		const toolNames = Array.isArray(manifest.action.tool_names) ? manifest.action.tool_names : [];
		if (!toolNames.includes(requested.payload?.tool_name)) reasons.push("action.requested tool_name does not match manifest.action.tool_names");
		if (requested.payload?.operation !== manifest.action.operation) reasons.push("action.requested operation does not match manifest.action.operation");
		if (requested.payload?.arguments?.path !== manifest.action.target_path) reasons.push("action.requested argument path does not match manifest.action.target_path");
		if (requested.payload?.blocked) reasons.push(`action.requested was blocked: ${requested.payload.blocked}`);
	}
	if (completed && completed.payload?.transport?.tool_ok !== true) reasons.push("action.completed transport is not tool_ok");

	// 6. Step + episode outcome projections must describe this same episode.
	const episode = Array.isArray(episodes) ? episodes[0] : null;
	const stepOutcome = Array.isArray(outcomes) ? outcomes.find((outcome) => outcome.level === "step") : null;
	const episodeOutcome = Array.isArray(outcomes) ? outcomes.find((outcome) => outcome.level === "episode") : null;
	if (!episode) reasons.push("episodes.json has no episode projection");
	if (!stepOutcome) reasons.push("outcomes.json has no step outcome");
	if (!episodeOutcome) reasons.push("outcomes.json has no episode outcome");
	if (episode && episode.episode_id !== episodeId) reasons.push("episode projection episode_id does not match the event log");
	if (stepOutcome && stepOutcome.episode_id !== episodeId) reasons.push("step outcome episode_id does not match the event log");
	if (episodeOutcome && episodeOutcome.episode_id !== episodeId) reasons.push("episode outcome episode_id does not match the event log");
	if (episode && episodeOutcome && episode.episode_outcome_id !== episodeOutcome.outcome_id) reasons.push("episode projection episode_outcome_id does not match outcomes.json");
	if (episode && stepOutcome && episode.steps?.[0]?.step_outcome_id !== stepOutcome.outcome_id) reasons.push("episode projection step_outcome_id does not match outcomes.json");
	if (episode && episode.status !== "completed") reasons.push(`episode projection status is ${episode.status}`);

	// 7. Outcome status is success and consistent across step, episode, the
	// recorded outcome events, and the Oracle report. A tampered status cannot
	// promote.
	const recordedOutcomes = episodeEvents.filter((event) => event.event_type === "outcome.recorded");
	const recordedStatusById = new Map(recordedOutcomes.map((event) => [event.payload?.outcome_id, event.payload?.status]));
	if (recordedOutcomes.length !== 2) reasons.push(`expected two outcome.recorded events, found ${recordedOutcomes.length}`);
	if (stepOutcome && recordedStatusById.get(stepOutcome.outcome_id) !== stepOutcome.status) reasons.push("step outcome status does not match its outcome.recorded event");
	if (episodeOutcome && recordedStatusById.get(episodeOutcome.outcome_id) !== episodeOutcome.status) reasons.push("episode outcome status does not match its outcome.recorded event");
	if (stepOutcome && stepOutcome.status !== "success") reasons.push(`step outcome status is ${stepOutcome.status}`);
	if (episodeOutcome && episodeOutcome.status !== "success") reasons.push(`episode outcome status is ${episodeOutcome.status}`);
	if (report.status !== "success") reasons.push(`oracle report status is ${report.status}`);
	if (report.failure_mode) reasons.push(`oracle report failure_mode is ${report.failure_mode}`);
	if (episodeOutcome && episodeOutcome.status !== report.status) reasons.push("oracle report status disagrees with episode outcome status");
	if (report.checks?.event_chain_valid !== true) reasons.push("oracle report event chain check is not true");
	if (report.checks?.trusted_run_record !== true) reasons.push("oracle report trusted run record check is not true");
	if (report.checks?.precondition_verified !== true) reasons.push("oracle report precondition check is not true");
	if (report.checks?.post_state_readable !== true) reasons.push("oracle report post-state check is not true");
	if (report.checks?.postconditions_verified !== true) reasons.push("oracle report postcondition check is not true");
	if (episodeOutcome?.oracle?.independence_group !== run.independence_group) reasons.push("episode outcome independence_group does not match run.json");

	// 8. Evidence refs must resolve and tie back to this run's real events.
	if (!episodeOutcome?.evidence_refs?.length) {
		reasons.push("episode outcome has no evidence refs");
	} else {
		const unresolved = unresolvedEventRefs(events, episodeOutcome.evidence_refs);
		if (unresolved.length > 0) reasons.push(`episode outcome evidence refs do not resolve: ${unresolved.join(", ")}`);
		const refIds = new Set(episodeOutcome.evidence_refs.map((ref) => ref.ref_id));
		if (observation && !refIds.has(observation.event_id)) reasons.push("episode outcome evidence does not include the trusted observation");
		if (completed && !refIds.has(completed.event_id)) reasons.push("episode outcome evidence does not include action.completed");
	}

	// 8b. Replayable evidence must be real, self-consistent, and auditable, not a
	// mere `replayable:true` boolean or a registered action id. The Compiler
	// resolves the replay-proof artifact, re-hashes it, confirms the outcome's
	// reproducibility hash anchors it, and confirms a hash-chained
	// `replay.verified` note links it to this exact episode, run, action and
	// trusted pre-state.
	const reproducibility = episodeOutcome?.reproducibility;
	if (!reproducibility || reproducibility.replayable !== true) {
		reasons.push("episode outcome is not backed by replayable evidence");
	} else {
		if (!Number.isInteger(reproducibility.replay_count) || reproducibility.replay_count < 1) reasons.push("reproducibility.replay_count must be at least 1");
		if (typeof reproducibility.replay_hash !== "string" || reproducibility.replay_hash.length === 0) reasons.push("reproducibility.replay_hash is missing");
		const replayAction = manifest.action ? getAction(manifest.action.action_id) : null;
		const proofPath = join(root, "replay-proof.json");
		if (!existsSync(proofPath)) {
			reasons.push("replay proof artifact is missing");
		} else {
			let proof = null;
			try {
				proof = readJson(proofPath);
			} catch (error) {
				reasons.push(`replay proof artifact is unreadable: ${msg(error)}`);
			}
			if (proof) {
				const { proof_digest, ...proofCore } = proof;
				if (typeof proof_digest !== "string" || digest(proofCore) !== proof_digest) reasons.push("replay proof artifact fails self-verification");
				if (proof_digest !== reproducibility.replay_hash) reasons.push("replay proof digest does not match reproducibility.replay_hash");
				if (proof.episode_id !== episodeId) reasons.push("replay proof is not linked to this episode");
				if (proof.run_id !== run.run_id) reasons.push("replay proof is not linked to this run");
				if (proof.action_ref !== manifest.action?.action_id) reasons.push("replay proof action_ref does not match the manifest action");
				if (proof.arguments?.path !== manifest.action?.target_path) reasons.push("replay proof arguments do not match the manifest target");
				if (proof.pre_state_digest !== run.initial_state_digest) reasons.push("replay proof pre-state digest does not match the trusted observation");
				if (proof.postconditions_verified !== true) reasons.push("replay proof does not assert verified postconditions");
				if (!replayAction) reasons.push("replay proof references an action that is not registered");
				else if (proof.action_spec_digest !== actionSpecDigest(replayAction)) reasons.push("replay proof action_spec_digest does not match the registered action");

				const refs = Array.isArray(episodeOutcome.evidence_refs) ? episodeOutcome.evidence_refs : [];
				const artifactRef = refs.find((ref) => ref.ref_type === "artifact" && ref.ref_id === "replay-proof.json");
				if (!artifactRef) reasons.push("episode outcome has no replay-proof artifact ref");
				else if (artifactRef.digest !== proof_digest) reasons.push("replay-proof artifact ref digest does not match the artifact");

				const replayNotes = episodeEvents.filter(
					(event) => event.event_type === "note" && event.payload?.kind === "replay.verified" && event.payload?.run_id === run.run_id,
				);
				if (replayNotes.length !== 1) {
					reasons.push(`expected exactly one replay.verified note, found ${replayNotes.length}`);
				} else {
					const note = replayNotes[0];
					if (note.payload.proof_digest !== proof_digest) reasons.push("replay.verified note proof_digest does not match the artifact");
					if (note.payload.action_ref !== manifest.action?.action_id) reasons.push("replay.verified note action_ref does not match the manifest action");
					if (note.payload.pre_state_digest !== run.initial_state_digest) reasons.push("replay.verified note pre-state digest does not match the trusted observation");
					if (!refs.some((ref) => ref.ref_type === "event" && ref.ref_id === note.event_id)) reasons.push("episode outcome evidence does not include the replay.verified event");
				}
			}
		}
	}

	// 9. Authoritative post-state: re-read the live fixture through the boundary
	// and evaluate the manifest postconditions ourselves.
	try {
		const postPath = resolveInside(run.fixture_root, run.fixture_relative_path, { mustExist: true });
		const postState = readJson(postPath);
		if (!evaluatePredicates(postState, manifest.state.postconditions)) reasons.push("independently re-read post-state does not satisfy manifest postconditions");
	} catch (error) {
		reasons.push(`cannot independently re-read post-state: ${msg(error)}`);
	}

	return { ok: reasons.length === 0, reasons, episode, stepOutcome, episodeOutcome };
}

function loadJudgedUnsafe(root) {
	const manifest = readJson(join(root, "manifest.json"));
	const run = readJson(join(root, "run.json"));
	const report = readJson(join(root, "oracle-report.json"));
	const events = readJsonl(join(root, "events.jsonl"));
	const episodes = readJson(join(root, "episodes.json"));
	const outcomes = readJson(join(root, "outcomes.json"));

	// Independent re-validation. Never grant `active` from the projection's own
	// self-reported status.
	const verified = revalidateProjection({ root, manifest, run, report, events, episodes, outcomes });
	if (!verified.ok) {
		return {
			root,
			ok: false,
			reason: `independent re-validation failed: ${verified.reasons.join("; ")}`,
			outcomeStatus: report.status,
		};
	}
	return {
		root,
		ok: true,
		manifest,
		run,
		report,
		events,
		episode: verified.episode,
		episodeOutcome: verified.episodeOutcome,
		stepOutcome: verified.stepOutcome,
		outcomes,
	};
}

// Derive the intended rule from the registered action and the manifest state
// declarations. The Compiler never trusts a producer-authored Experience
// directly; it rebuilds the rule and checks the action primitive digest.
function deriveRule(judged) {
	const manifest = judged.manifest;
	const actionId = manifest.action.action_id;
	const action = getAction(actionId);
	if (!action) return { error: `unknown registered action: ${actionId}` };
	const relPath = manifest.action.target_path;
	if (typeof relPath !== "string" || relPath.length === 0) return { error: "action target_path is missing" };
	return {
		rule: {
			when: manifest.state.preconditions.map((predicate) => ({ path: predicate.path, op: predicate.op, value: predicate.value })),
			do: {
				tool: action.tool,
				operation: action.operation,
				action_ref: action.id,
				action_spec_digest: actionSpecDigest(action),
				arguments_template: { path: relPath },
				risk_class: action.risk_class,
			},
			expect: manifest.state.postconditions,
			scope: {
				environment_fingerprint: manifest.environment.environment_fingerprint,
				domain: manifest.environment.domain,
				permissions: manifest.environment.permissions,
				task_types: manifest.task_types,
			},
		},
	};
}

export function compile({ projectionDirs, outputDir }) {
	const judged = projectionDirs.map((dir) => loadJudged(resolve(dir)));
	const sources = [];
	const rejected = [];
	const accepted = [];
	for (const item of judged) {
		if (item.ok) accepted.push(item);
		else rejected.push({ root: item.root, reason: item.reason, outcome_status: item.outcomeStatus });
	}

	const gateReasons = [];
	if (rejected.length > 0) gateReasons.push("some projections are not successful verified live runs");

	// Independence must come from distinct trusted run records and episodes, not
	// names. A copied run.json or a duplicated episode_id is not independent.
	const runIds = new Set();
	const episodeIds = new Set();
	const groups = new Set();
	const nonces = new Set();
	let duplicateRun = false;
	let duplicateEpisode = false;
	for (const item of accepted) {
		if (runIds.has(item.run.run_id)) duplicateRun = true;
		runIds.add(item.run.run_id);
		if (episodeIds.has(item.episode.episode_id)) duplicateEpisode = true;
		episodeIds.add(item.episode.episode_id);
		groups.add(item.run.independence_group);
		nonces.add(item.run.reset_nonce);
	}
	const independentCount = Math.min(runIds.size, groups.size);
	if (independentCount < 2) gateReasons.push("requires at least two independent successful live episodes");
	if (duplicateRun) gateReasons.push("duplicate trusted run records: evidence is not independent");
	if (duplicateEpisode) gateReasons.push("duplicate episode ids: evidence is not independent");

	// Rule consistency + registered-action replayability.
	const rules = [];
	for (const item of accepted) {
		const derived = deriveRule(item);
		if (derived.error) {
			gateReasons.push(derived.error);
			continue;
		}
		const rule = derived.rule;
		if (!rule.do.action_ref || !getAction(rule.do.action_ref)) {
			gateReasons.push("do.action_ref does not resolve to a registered action primitive");
		} else if (rule.do.action_spec_digest !== actionSpecDigest(getAction(rule.do.action_ref))) {
			gateReasons.push("do.action_spec_digest does not match the registered action primitive");
		}
		rules.push({ root: item.root, rule, judged: item });
	}
	const conflicts = [];
	for (let index = 1; index < rules.length; index += 1) {
		if (stable(rules[index].rule) !== stable(rules[0].rule)) {
			conflicts.push(`run ${index + 1} has a scope, precondition, action, or postcondition conflict`);
		}
	}
	if (conflicts.length > 0) gateReasons.push("scope, precondition, action, or postcondition conflict prevents activation");

	const active = gateReasons.length === 0 && rules.length >= 2;
	const first = rules[0];
	const successOutcomes = accepted.map((item) => item.episodeOutcome);
	const experience = {
		schema_version: SCHEMA_VERSION,
		experience_id: `experience-fixture-${newId()}`,
		status: active ? "active" : "candidate",
		when: first ? first.rule.when.map((predicate) => ({
			...predicate,
			verified_by: accepted.map((item) => item.episodeOutcome.outcome_id),
		})) : [],
		do: first ? first.rule.do : {},
		expect: first ? first.rule.expect : [],
		scope: first ? { ...first.rule.scope, mode: "live" } : {},
		support: {
			success_outcome_ids: successOutcomes.map((outcome) => outcome.outcome_id),
			failure_outcome_ids: [],
			unknown_outcome_ids: [],
			independent_episode_count: independentCount,
			success_count: successOutcomes.length,
			failure_count: 0,
			unknown_count: 0,
		},
		provenance: {
			compiled_by: "aegis-fixture-compiler",
			compiler_version: COMPILER_VERSION,
			source_outcome_ids: accepted.flatMap((item) => item.outcomes.map((outcome) => outcome.outcome_id)),
			source_episode_ids: accepted.map((item) => item.episode.episode_id),
			source_run_ids: [...runIds],
			source_kind: ["live"],
			compiled_at: isoNow(),
		},
		validation: {
			last_validated_at: isoNow(),
			replay_hash: digest({
				runs: [...runIds].sort(),
				expect: first?.rule.expect || [],
				replay_proofs: accepted.map((item) => item.episodeOutcome.reproducibility.replay_hash).sort(),
			}),
			conflicts,
		},
		revision: 1,
		created_at: isoNow(),
		updated_at: isoNow(),
	};

	const report = {
		schema_version: SCHEMA_VERSION,
		compiler_version: COMPILER_VERSION,
		output_dir: outputDir,
		counts: {
			projections: projectionDirs.length,
			accepted: accepted.length,
			rejected: rejected.length,
			experiences: 1,
		},
		experience_status: experience.status,
		independence: {
			run_ids: [...runIds],
			groups: [...groups],
			reset_nonces: [...nonces],
			distinct_run_count: independentCount,
		},
		gate: {
			status: experience.status,
			reasons: gateReasons,
			replay_only: false,
			live_evidence_only: true,
		},
		sources: accepted.map((item) => ({
			root: item.root,
			run_id: item.run.run_id,
			independence_group: item.run.independence_group,
			reset_nonce: item.run.reset_nonce,
			experiment_id: item.manifest.experiment_id,
			episode_id: item.episode.episode_id,
			episode_outcome_id: item.episodeOutcome.outcome_id,
			initial_state_digest: item.run.initial_state_digest,
		})),
		rejected,
		replay: {
			verified_proofs: accepted.length,
			proof_digests: accepted.map((item) => item.episodeOutcome.reproducibility.replay_hash),
		},
		warnings: [
			"Evidence is live current-environment evidence; replayability is an isolated re-execution of the exact registered primitive from the trusted observed pre-state, not a re-run of free text.",
		],
	};

	if (outputDir) {
		writeJson(join(outputDir, "experiences.json"), [experience]);
		writeJson(join(outputDir, "report.json"), report);
	}
	return { experience, report };
}
