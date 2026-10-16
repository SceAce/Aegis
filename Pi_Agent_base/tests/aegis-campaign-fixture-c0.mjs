#!/usr/bin/env node
// Aegis Campaign C0 fixture + rebuild determinism test.
//
// Proves the C0 requirement that derived artifacts are REBUILDABLE from the
// committed immutable inputs: delete the derived report/bundle files, regenerate
// them from the same manifest + outcomes, and require byte-identical digests.
//
// Also proves the fixture is honest: it is offline, the `unknown` case is
// preserved as unknown (never a failure), and the emitted report/bundle contain
// no secret-looking material.
//
// Run:
//   node Pi_Agent_base/tests/aegis-campaign-fixture-c0.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	aggregateCampaign,
	aggregateStage,
	aggregateTask,
	buildAcceptanceBundle,
	buildCampaignReport,
	buildFixtureCampaign,
	canonicalManifestDigest,
	fixtureOutcomes,
	persistFixtureCampaign,
	renderCampaignReportMarkdown,
	renderReviewerPrompt,
} from "../campaign/index.mjs";

const failures = [];
function check(name, condition, detail) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures.push(name);
		console.log(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

const root = mkdtempSync(join(tmpdir(), "aegis-campaign-fixture-c0-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Deterministic campaign aggregation from the fixture's Outcomes.
// ---------------------------------------------------------------------------

function aggregateFixture(fixture) {
	const outcomes = fixtureOutcomes({ fixture });
	const taskAggregates = [];
	const stageAggregates = [];
	for (const task of fixture.manifest.tasks) {
		const stages = task.stages.map((stage) => {
			const stageOutcomes = outcomes.filter((o) => o.provenance?.stage_id === stage.stage_id);
			const aggregate = aggregateStage({
				stage: {
					stage_id: stage.stage_id,
					task_id: task.task_id,
					required: stage.required,
					criterion_ids: stage.criteria,
				},
				outcomes: stageOutcomes,
			});
			stageAggregates.push(aggregate);
			return aggregate;
		});
		const taskOracleOutcome =
			outcomes.find(
				(o) => o.provenance?.task_id === task.task_id && o.level === "episode" && !o.provenance?.stage_id,
			) ?? null;
		// A TaskOracle must be bound to this task; pass the full committed Outcome
		// (never a stripped `{status}`) and the trusted episode id, so aggregation
		// can verify the binding rather than trusting a bare status string.
		const taskOracle = taskOracleOutcome
			? {
					outcome_id: taskOracleOutcome.outcome_id,
					status: taskOracleOutcome.status,
					task_id: task.task_id,
					episode_id: taskOracleOutcome.episode_id,
					criterion: taskOracleOutcome.criterion,
					provenance: taskOracleOutcome.provenance,
				}
			: null;
		const aggregate = aggregateTask({
			task,
			stages,
			taskOracle,
			episodeId: taskOracleOutcome?.episode_id ?? null,
		});
		taskAggregates.push(aggregate);
	}
	return { outcomes, taskAggregates, stageAggregates };
}

function buildArtifacts(fixture) {
	const { outcomes, taskAggregates, stageAggregates } = aggregateFixture(fixture);
	const aggregate = aggregateCampaign({ manifest: fixture.manifest, taskAggregates });
	const report = buildCampaignReport({
		manifest: fixture.manifest,
		manifestDigest: canonicalManifestDigest(fixture.manifest),
		campaignAggregate: aggregate,
		taskAggregates,
		stageAggregates,
		outcomes,
		integrity: { event_chain_ok: true, checkpoint_ok: null, last_committed_digest: "sha256:fixture" },
	});
	const bundle = buildAcceptanceBundle({
		report,
		runtimeDigests: { pi_build_id: "fixture", model: "deterministic-no-model", oracle: "fixture.oracle.v1" },
	});
	return { report, bundle, markdown: renderCampaignReportMarkdown(report), prompt: renderReviewerPrompt(bundle) };
}

// ---------------------------------------------------------------------------
// 1. Fixture honesty
// ---------------------------------------------------------------------------

const fixture = buildFixtureCampaign();
check("fixture manifest validates", (await import("../campaign/manifest.mjs")).validateManifest(fixture.manifest).ok);
check(
	"fixture is offline (network disabled, no credentials)",
	fixture.manifest.authorization.network === "disabled" && fixture.manifest.authorization.credentials === "none",
);
check("fixture declares workspace is not a sandbox", fixture.manifest.authorization.workspace_is_sandbox === false);

const first = buildArtifacts(fixture);
const unknownTask = first.report.tasks.find((task) => task.status === "unknown");
check("fixture preserves the unknown task as unknown", Boolean(unknownTask));
check(
	"fixture does not record an unknown as a failure",
	first.report.tasks.every((task) => !(task.status === "unknown" && task.reasons.some((r) => /fail/i.test(r)))),
);
check(
	"fixture has at least one successful task",
	first.report.tasks.some((task) => task.status === "success"),
);

// The unknown stage must carry no independent success/failure evidence.
const unknownStage = first.report.stages.find((stage) => stage.status === "unknown");
check("fixture has an unknown stage", Boolean(unknownStage));

// P1-12: the fixture never claims replayability it cannot prove, and it is
// explicitly fixture-only (not usable for Experience promotion / learning claims).
const fixtureOutcomeList = fixtureOutcomes({ fixture });
check(
	"fixture Outcomes are never replayable=true without a real replay proof",
	fixtureOutcomeList.every(
		(outcome) =>
			outcome.reproducibility?.replayable !== true ||
			(outcome.reproducibility?.replay_hash && outcome.reproducibility?.replay_count > 0),
	),
);
check(
	"fixture Outcomes are marked fixture_only",
	fixtureOutcomeList.every((outcome) => outcome.provenance?.fixture_only === true),
);
check(
	"fixture Outcomes share a single independence group (not multiple evidence)",
	new Set(fixtureOutcomeList.map((outcome) => outcome.provenance?.group)).size === 1,
);

// ---------------------------------------------------------------------------
// 2. Rebuild determinism: delete derived files and rebuild identical digests
// ---------------------------------------------------------------------------

const workDir = join(root, "rebuild");
const persisted = await persistFixtureCampaign(fixture, workDir);
check("fixture manifest persists immutably", persisted.ok === true, (persisted.reasons ?? []).join("; "));

const derivedPath = join(workDir, "campaign-report.json");
writeFileSync(derivedPath, JSON.stringify(first.report, null, 2));
check("derived report file exists", existsSync(derivedPath));

// Delete the derived file, then rebuild from the committed manifest + outcomes.
rmSync(derivedPath);
check("derived report file deleted", !existsSync(derivedPath));

const storedManifest = JSON.parse(readFileSync(persisted.path, "utf8"));
check(
	"stored manifest digest equals original",
	canonicalManifestDigest(storedManifest) === canonicalManifestDigest(fixture.manifest),
);

const rebuiltFixture = { ...fixture, manifest: storedManifest };
const second = buildArtifacts(rebuiltFixture);
check(
	"rebuilt report digest is identical",
	first.report.report_digest === second.report.report_digest,
	`${first.report.report_digest} vs ${second.report.report_digest}`,
);
check("rebuilt bundle digest is identical", first.bundle.bundle_digest === second.bundle.bundle_digest);
check("rebuilt markdown is identical", first.markdown === second.markdown);

// ---------------------------------------------------------------------------
// 3. No secrets in any output
// ---------------------------------------------------------------------------

const serialized = JSON.stringify({
	report: first.report,
	bundle: first.bundle,
	markdown: first.markdown,
	prompt: first.prompt,
});
check("no API key material in outputs", !/API[_-]?KEY/i.test(serialized));
check("no flag material in outputs", !/FLAG\{|CTF\{/.test(serialized));
check("no private key material in outputs", !/BEGIN [A-Z ]*PRIVATE KEY/.test(serialized));

// ---------------------------------------------------------------------------
// 4. The bundle is read-only for the reviewer
// ---------------------------------------------------------------------------

check("bundle does not auto-invoke the reviewer", first.bundle.external_reviewer.invoked_by_aegis === false);
check("bundle states the reviewer may not mutate state", first.bundle.external_reviewer.may_mutate_state === false);

console.log("");
if (failures.length > 0) {
	console.log(`campaign fixture C0: ${failures.length} failure(s)`);
	for (const name of failures) console.log(`  - ${name}`);
	process.exit(1);
}
console.log("campaign fixture C0: all assertions passed");
