#!/usr/bin/env node
//
// Offline deterministic tests for the fixture direct vertical slice.
//
// Run:  node Pi_Agent_base/tests/fixture-direct-smoke.mjs
//
// No model calls, no network, no external services. Every experiment runs in a
// fresh temp directory. Failure of any assertion exits non-zero; success prints
// "fixture direct smoke ok".
//
// These tests assert behavior from records on disk (Oracle reports, Compiler
// gates, Router decisions, host event logs), never from an agent self-report.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureTask, makeTask } from "../fixtures/host.mjs";
import { judgeRun, replayIsolatedOutcome, validateRunRecord } from "../fixtures/oracle.mjs";
import { compile } from "../fixtures/compiler.mjs";
import { route } from "../fixtures/router.mjs";
import { digest, readJson, readJsonl, validateEventLog } from "../shared/contracts.mjs";

const roots = [];
function temp(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

function assert(condition, message) {
	if (!condition) throw new Error(`ASSERT: ${message}`);
}

function assertEqual(actual, expected, message) {
	if (actual !== expected) throw new Error(`ASSERT: ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Run a live task + judge it. Returns the judged bundle.
function live(root, options = {}) {
	runFixtureTask({ root, ...options });
	return judgeRun(root);
}

// Produce two independent successful live episodes and compile them.
function activeExperience(base) {
	const firstRoot = join(base, "ind-1");
	const secondRoot = join(base, "ind-2");
	const first = live(firstRoot);
	const second = live(secondRoot);
	assertEqual(first.status, "success", "episode 1 oracle");
	assertEqual(second.status, "success", "episode 2 oracle");
	const compiled = compile({ projectionDirs: [firstRoot, secondRoot], outputDir: join(base, "compiled") });
	return { firstRoot, secondRoot, compiled };
}

function runTests() {
	// 1. Positive promotion and direct hit ---------------------------------
	{
		const base = temp("aegis-fx-positive-");
		const { compiled } = activeExperience(base);
		assertEqual(compiled.experience.status, "active", "two independent live successes must activate");
		assert(compiled.experience.support.independent_episode_count >= 2, "independent episode count >= 2");
		assertEqual(compiled.experience.do.action_ref, "fixture.unlock", "action_ref is the registered primitive");

		// Third fresh task: router must hit and host must record route=direct.
		const thirdRoot = join(base, "third");
		let decision = null;
		const run = runFixtureTask({
			root: thirdRoot,
			router: ({ manifest, fixtureRoot }) => {
				decision = route({ experiences: [compiled.experience], manifest, fixtureRoot });
				return decision;
			},
		});
		assertEqual(decision.route, "direct", "router must go direct on a verified match");
		assertEqual(run.request.payload.route, "direct", "host must execute through the direct route");
		assertEqual(run.request.payload.experience_id, compiled.experience.experience_id, "host must reference the matched experience");
		assertEqual(run.request.payload.action_ref, "fixture.unlock", "host must run the registered primitive");
		const judged = judgeRun(thirdRoot);
		assertEqual(judged.status, "success", "third task oracle must verify success");
	}

	// 2. Non-independent evidence cannot activate --------------------------
	{
		const base = temp("aegis-fx-nonindep-");
		const root = join(base, "only");
		live(root);
		// Compiling the same run directory twice must not activate.
		const compiled = compile({ projectionDirs: [root, root], outputDir: join(base, "compiled") });
		assertEqual(compiled.experience.status, "candidate", "duplicated run must stay candidate");
		assert(
			compiled.report.gate.reasons.some((reason) => /independent/.test(reason)),
			"non-independence must be reported",
		);
	}

	// 3. Scope mismatch prevents activation --------------------------------
	{
		const base = temp("aegis-fx-scope-");
		const a = join(base, "a");
		const b = join(base, "b");
		live(a);
		live(b, { task: makeTask({ domain: "other-domain" }) });
		const compiled = compile({ projectionDirs: [a, b], outputDir: join(base, "compiled") });
		assertEqual(compiled.experience.status, "candidate", "scope conflict must stay candidate");
		assert(
			compiled.report.gate.reasons.some((reason) => /conflict/.test(reason)),
			"scope conflict must be reported",
		);
	}

	// 4. Router refuses on current precondition mismatch -------------------
	{
		const base = temp("aegis-fx-precond-");
		const { compiled } = activeExperience(base);
		const root = join(base, "mismatch");
		let decision = null;
		runFixtureTask({
			root,
			task: makeTask({ initialState: { target: "door", locked: false, version: 1 } }),
			router: ({ manifest, fixtureRoot }) => {
				decision = route({ experiences: [compiled.experience], manifest, fixtureRoot });
				return decision;
			},
		});
		assertEqual(decision.route, "deliberate", "router must refuse when live preconditions differ");
		assert(
			decision.checks.some((check) => check.name === "current_preconditions_verified" && !check.ok),
			"router must report the failed precondition check",
		);
	}

	// 5. Router refuses on scope mismatch ---------------------------------
	{
		const base = temp("aegis-fx-routescope-");
		const { compiled } = activeExperience(base);
		const root = join(base, "other");
		let decision = null;
		runFixtureTask({
			root,
			task: makeTask({ environment_fingerprint: "different-env" }),
			router: ({ manifest, fixtureRoot }) => {
				decision = route({ experiences: [compiled.experience], manifest, fixtureRoot });
				return decision;
			},
		});
		assertEqual(decision.route, "deliberate", "router must refuse on scope mismatch");
		assert(
			decision.checks.some((check) => check.name === "environment_fingerprint" && !check.ok),
			"router must report the failed scope check",
		);
	}

	// 6. Conflicting active experiences are refused ------------------------
	{
		const base = temp("aegis-fx-conflict-");
		const { compiled } = activeExperience(base);
		const clone = { ...compiled.experience, experience_id: "experience-fixture-clone" };
		const root = join(base, "conflict");
		let decision = null;
		runFixtureTask({
			root,
			router: ({ manifest, fixtureRoot }) => {
				decision = route({ experiences: [compiled.experience, clone], manifest, fixtureRoot });
				return decision;
			},
		});
		assertEqual(decision.route, "refuse", "two matching active experiences must be a conflict");
	}

	// 7. Tampered run record -> invalid, never success ---------------------
	{
		const base = temp("aegis-fx-tamper-");
		const root = join(base, "tampered");
		runFixtureTask({ root, simulate: { tamperRunState: true } });
		const judged = judgeRun(root);
		assertEqual(judged.status, "invalid", "tampered run record must be invalid");
		assert(judged.status !== "success", "tampered run cannot be success");
	}

	// 8. Missing trusted snapshot -> invalid -------------------------------
	{
		const base = temp("aegis-fx-nosnap-");
		const root = join(base, "missing-snapshot");
		runFixtureTask({ root });
		rmSync(join(root, "trusted-initial-state.json"), { force: true });
		const judged = judgeRun(root);
		assertEqual(judged.status, "invalid", "missing trusted snapshot must be invalid");
	}

	// 9. Tampered source event -> invalid ----------------------------------
	{
		const base = temp("aegis-fx-events-");
		const root = join(base, "bad-event");
		runFixtureTask({ root });
		const eventPath = join(root, "events.jsonl");
		const rows = readJsonl(eventPath);
		const observation = rows.find((event) => event.event_type === "observation.captured");
		observation.payload.value = { ...observation.payload.value, locked: false };
		writeFileSync(eventPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
		let threw = false;
		try {
			validateEventLog(readJsonl(eventPath));
		} catch {
			threw = true;
		}
		assert(threw, "a mutated event payload must break the hash chain");
		// The oracle must not report success on a broken chain.
		let judged;
		try {
			judged = judgeRun(root);
		} catch {
			judged = { status: "invalid" };
		}
		assert(judged.status !== "success", "broken event chain cannot be success");
	}

	// 10. Action transport failure -> unknown/failure, never success -------
	{
		const base = temp("aegis-fx-skip-");
		const root = join(base, "skipped");
		runFixtureTask({ root, simulate: { skipAction: true } });
		const judged = judgeRun(root);
		assert(judged.status === "unknown" || judged.status === "failure", "transport timeout must not be success");
		assertEqual(judged.status, "unknown", "timeout with insufficient evidence is unknown");
		assertEqual(judged.stepOutcome.failure_mode, "timeout", "timeout failure mode");
	}

	// 11. Post-state missing -> unknown ------------------------------------
	{
		const base = temp("aegis-fx-nopost-");
		const root = join(base, "removed");
		runFixtureTask({ root, simulate: { removePostState: true } });
		const judged = judgeRun(root);
		assertEqual(judged.status, "unknown", "missing post-state must be unknown");
		assertEqual(judged.stepOutcome.failure_mode, "insufficient_evidence", "insufficient evidence mode");
	}

	// 12. Unmet precondition -> invalid, never success ---------------------
	{
		const base = temp("aegis-fx-unmet-");
		const root = join(base, "unmet");
		runFixtureTask({ root, task: makeTask({ initialState: { target: "door", locked: false, version: 1 } }) });
		const judged = judgeRun(root);
		assertEqual(judged.status, "invalid", "unmet declared precondition must be invalid");
	}

	// 13. Path traversal + symlink escape are rejected --------------------
	{
		const base = temp("aegis-fx-escape-");
		// Direct action argument traversal.
		const root = join(base, "traversal");
		const run = runFixtureTask({ root, args: { path: "../escape.json" } });
		assertEqual(run.transport.failure_mode, "action_rejected", "traversal must be rejected by the primitive");
		const judged = judgeRun(root);
		assert(judged.status !== "success", "traversal cannot be success");

		// Symlink escape: a link inside the fixture root pointing outside.
		const symlinkRoot = join(base, "symlink");
		const outsideTarget = join(base, "outside-secret.json");
		writeFileSync(outsideTarget, JSON.stringify({ target: "door", locked: true, version: 1 }), "utf8");
		const symRun = runFixtureTask({ root: symlinkRoot, args: { path: "escape.json" }, simulate: { seedSymlinkEscape: outsideTarget } });
		assertEqual(symRun.transport.tool_ok, false, "symlink escape must not succeed");
		assertEqual(symRun.transport.failure_mode, "action_rejected", "symlink escape is rejected");
	}

	// 14. Compiler does not activate on a failed episode -------------------
	{
		const base = temp("aegis-fx-failgatem-");
		const okRoot = join(base, "ok");
		const failRoot = join(base, "fail");
		live(okRoot);
		runFixtureTask({ root: failRoot, simulate: { skipAction: true } });
		judgeRun(failRoot);
		const compiled = compile({ projectionDirs: [okRoot, failRoot], outputDir: join(base, "compiled") });
		assertEqual(compiled.experience.status, "candidate", "a failed episode must block activation");
		assert(compiled.report.gate.reasons.length > 0, "gate must explain the block");
	}

	// 15. Outcome events are recorded and reference-resolvable ------------
	{
		const base = temp("aegis-fx-outcome-");
		const root = join(base, "outcomes");
		live(root);
		const events = readJsonl(join(root, "events.jsonl"));
		validateEventLog(events);
		const recorded = events.filter((event) => event.event_type === "outcome.recorded");
		assertEqual(recorded.length, 2, "step + episode outcomes must be recorded");
		const outcomes = readJson(join(root, "outcomes.json"));
		assertEqual(outcomes.length, 2, "outcomes projection must have both levels");
		const episodeOutcome = outcomes.find((outcome) => outcome.level === "episode");
		assert(episodeOutcome.evidence_refs.length > 0, "episode outcome must carry evidence refs");
		const eventIds = new Set(events.map((event) => event.event_id));
		for (const ref of episodeOutcome.evidence_refs) {
			if (ref.ref_type === "event") assert(eventIds.has(ref.ref_id), `evidence ref ${ref.ref_id} must resolve`);
		}
	}

	// 16. validateRunRecord accepts a clean run and rejects a tampered one --
	{
		const base = temp("aegis-fx-runrec-");
		const root = join(base, "clean");
		runFixtureTask({ root });
		assert(validateRunRecord(root).ok, "clean run record must validate");
		const tamperedRoot = join(base, "tampered");
		runFixtureTask({ root: tamperedRoot, simulate: { tamperRunState: true } });
		assert(!validateRunRecord(tamperedRoot).ok, "tampered run record must fail validation");
	}

	// 17. A missing projection is rejected, not thrown ---------------------
	{
		const base = temp("aegis-fx-noproj-");
		const okRoot = join(base, "ok");
		const missingRoot = join(base, "missing");
		live(okRoot);
		// missingRoot never ran: no manifest/run/oracle-report at all.
		const compiled = compile({ projectionDirs: [okRoot, missingRoot], outputDir: join(base, "compiled") });
		assertEqual(compiled.experience.status, "candidate", "missing projection must not activate");
		assertEqual(compiled.report.rejected.length, 1, "the missing projection must be reported as rejected");
	}

	// 18. Router refusal is fail-closed: the action must not execute --------
	{
		const base = temp("aegis-fx-refuseblock-");
		const { compiled } = activeExperience(base);
		const clone = { ...compiled.experience, experience_id: "experience-fixture-clone" };
		const root = join(base, "refused");
		let decision = null;
		const run = runFixtureTask({
			root,
			router: ({ manifest, fixtureRoot }) => {
				decision = route({ experiences: [compiled.experience, clone], manifest, fixtureRoot });
				return decision;
			},
		});
		assertEqual(decision.route, "refuse", "two matching active experiences must be a conflict");
		assertEqual(run.request.payload.blocked, "refused", "refusal must be recorded as blocked");
		assertEqual(run.transport.tool_ok, false, "refusal must not execute the action");
		assertEqual(run.transport.failure_mode, "refused", "refusal failure mode must be recorded");
		const refusedState = readJson(run.fixturePath);
		assertEqual(refusedState.locked, true, "refusal must leave the fixture unchanged");
		const refusedJudged = judgeRun(root);
		assert(refusedJudged.status !== "success", "a refused run cannot be success");
	}

	// 19. An action outside the task whitelist is fail-closed ---------------
	{
		const base = temp("aegis-fx-unauthblock-");
		const root = join(base, "unauthorized");
		const run = runFixtureTask({ root, task: makeTask({ allowed_actions: ["fixture.somewhere_else"] }) });
		assertEqual(run.request.payload.blocked, "unauthorized", "unauthorized action must be recorded as blocked");
		assertEqual(run.transport.tool_ok, false, "unauthorized action must not execute");
		assertEqual(run.transport.failure_mode, "unauthorized", "unauthorized failure mode must be recorded");
		const state = readJson(run.fixturePath);
		assertEqual(state.locked, true, "unauthorized action must leave the fixture unchanged");
		const judged = judgeRun(root);
		assert(judged.status !== "success", "an unauthorized run cannot be success");
	}

	// 20. A direct router decision cannot bypass the task whitelist ---------
	{
		const base = temp("aegis-fx-directunauth-");
		const root = join(base, "direct-unauthorized");
		const run = runFixtureTask({
			root,
			task: makeTask({ allowed_actions: ["fixture.somewhere_else"] }),
			router: () => ({
				route: "direct",
				routerDecision: "direct",
				experience: { experience_id: "forged" },
				actionId: "fixture.unlock",
				arguments: { path: "door.json" },
				checks: [],
			}),
		});
		assertEqual(run.request.payload.blocked, "unauthorized", "direct hit outside the whitelist must be blocked");
		assertEqual(run.transport.tool_ok, false, "whitelist bypass attempt must not execute");
		const bypassState = readJson(run.fixturePath);
		assertEqual(bypassState.locked, true, "whitelist bypass must leave the fixture unchanged");
		const bypassJudged = judgeRun(root);
		assert(bypassJudged.status !== "success", "whitelist bypass cannot be success");
	}

	// 21. Host persists action.requested (and its chain) before the Oracle runs --
	{
		const base = temp("aegis-fx-persist-");
		const root = join(base, "persisted");
		const run = runFixtureTask({ root });
		const onDisk = readJsonl(join(root, "events.jsonl"));
		validateEventLog(onDisk);
		const requested = onDisk.find((event) => event.event_type === "action.requested");
		assert(requested, "action.requested must already be on disk after the run");
		const completed = onDisk.find((event) => event.event_type === "action.completed");
		assert(completed, "action.completed must be on disk after the run");
		assertEqual(completed.payload.action_id, requested.payload.action_id, "completion must reference the persisted request");
		assert(requested.sequence < completed.sequence, "requested must precede completed in the persisted stream");
		assertEqual(run.request.payload.action_ref, "fixture.unlock", "host request references the registered primitive");
	}

	// 22. task.fixture_relative_path traversal/absolute fails closed -----------
	{
		const base = temp("aegis-fx-taskpath-");
		const traversalRoot = join(base, "traversal");
		const traversalTarget = join(traversalRoot, "escaped.json");
		let traversalThrew = false;
		try {
			runFixtureTask({ root: traversalRoot, task: makeTask({ fixture_relative_path: "../escaped.json" }) });
		} catch {
			traversalThrew = true;
		}
		assert(traversalThrew, "traversal in task.fixture_relative_path must be rejected");
		assert(!existsSync(traversalTarget), "traversal must not write outside the fixture root");

		const absoluteRoot = join(base, "absolute");
		const absoluteTarget = join(base, "absolute-escaped.json");
		let absoluteThrew = false;
		try {
			runFixtureTask({ root: absoluteRoot, task: makeTask({ fixture_relative_path: absoluteTarget }) });
		} catch {
			absoluteThrew = true;
		}
		assert(absoluteThrew, "absolute task.fixture_relative_path must be rejected");
		assert(!existsSync(absoluteTarget), "absolute path must not be written");
	}

	// 23. A failed intent write is fail-closed: no mutation executes -----------
	{
		const base = temp("aegis-fx-writefail-");
		const root = join(base, "writefail");
		// Force the event append to fail before the action can run.
		mkdirSync(join(root, "events.jsonl"), { recursive: true });
		let threw = false;
		try {
			runFixtureTask({ root });
		} catch {
			threw = true;
		}
		assert(threw, "a failed intent write must abort the run");
		const fixture = readJson(join(root, "fixture", "door.json"));
		assertEqual(fixture.locked, true, "mutation must not run when intent cannot be persisted");
	}

	// 24. Tampered/forged outcome status cannot activate ---------------------
	{
		const base = temp("aegis-fx-outcometamper-");

		// (a) A real success whose episode outcome was rewritten to failure.
		const goodRoot = join(base, "good");
		live(goodRoot);
		const goodOutcomes = readJson(join(goodRoot, "outcomes.json"));
		for (const outcome of goodOutcomes) if (outcome.level === "episode") outcome.status = "failure";
		writeFileSync(join(goodRoot, "outcomes.json"), `${JSON.stringify(goodOutcomes, null, 2)}\n`, "utf8");

		// (b) A failed episode whose outcome projections and report were forged to
		// look successful. The independent post-state re-read must still reject it.
		const forgedRoot = join(base, "forged");
		runFixtureTask({ root: forgedRoot, simulate: { skipAction: true } });
		judgeRun(forgedRoot);
		const forgedOutcomes = readJson(join(forgedRoot, "outcomes.json"));
		for (const outcome of forgedOutcomes) {
			outcome.status = "success";
			delete outcome.failure_mode;
		}
		writeFileSync(join(forgedRoot, "outcomes.json"), `${JSON.stringify(forgedOutcomes, null, 2)}\n`, "utf8");
		const forgedReport = readJson(join(forgedRoot, "oracle-report.json"));
		forgedReport.status = "success";
		forgedReport.failure_mode = null;
		forgedReport.checks.postconditions_verified = true;
		writeFileSync(join(forgedRoot, "oracle-report.json"), `${JSON.stringify(forgedReport, null, 2)}\n`, "utf8");

		const compiled = compile({ projectionDirs: [goodRoot, forgedRoot], outputDir: join(base, "compiled") });
		assertEqual(compiled.experience.status, "candidate", "tampered outcome status must not activate");
		assertEqual(compiled.report.rejected.length, 2, "both tampered projections must be rejected");
		assert(
			compiled.report.rejected.every((item) => /re-validation/.test(item.reason)),
			"rejections must cite independent re-validation",
		);
	}

	// 25. Cloned/copied run JSON and cross-source swaps are rejected ---------
	{
		const base = temp("aegis-fx-clone-");
		const a = join(base, "a");
		const b = join(base, "b");
		live(a);
		live(b);

		// Copy run.json from a into b: same run_id, wrong experiment directory.
		const clonedRoot = join(base, "cloned");
		live(clonedRoot);
		writeFileSync(join(clonedRoot, "run.json"), readFileSync(join(b, "run.json")), "utf8");
		const cloned = compile({ projectionDirs: [a, clonedRoot], outputDir: join(base, "compiled-clone") });
		assertEqual(cloned.experience.status, "candidate", "cloned run.json must not activate");
		assert(cloned.report.rejected.length >= 1, "the cloned projection must be rejected");

		// Cross-source swap: b keeps its run.json but receives a's event log.
		const swappedRoot = join(base, "swapped");
		live(swappedRoot);
		writeFileSync(join(swappedRoot, "events.jsonl"), readFileSync(join(a, "events.jsonl")), "utf8");
		const swapped = compile({ projectionDirs: [a, swappedRoot], outputDir: join(base, "compiled-swap") });
		assertEqual(swapped.experience.status, "candidate", "a swapped event log must not activate");
		assert(swapped.report.rejected.length >= 1, "the swapped projection must be rejected");
	}

	// 26. Duplicated/tampered episode ids cannot activate --------------------
	{
		const base = temp("aegis-fx-epid-");
		const a = join(base, "a");
		const b = join(base, "b");
		live(a);
		live(b);
		const aEpisode = readJson(join(a, "episodes.json"))[0];
		const bEpisode = readJson(join(b, "episodes.json"))[0];
		bEpisode.episode_id = aEpisode.episode_id;
		writeFileSync(join(b, "episodes.json"), `${JSON.stringify([bEpisode], null, 2)}\n`, "utf8");
		const bOutcomes = readJson(join(b, "outcomes.json"));
		for (const outcome of bOutcomes) outcome.episode_id = aEpisode.episode_id;
		writeFileSync(join(b, "outcomes.json"), `${JSON.stringify(bOutcomes, null, 2)}\n`, "utf8");
		const compiled = compile({ projectionDirs: [a, b], outputDir: join(base, "compiled") });
		assertEqual(compiled.experience.status, "candidate", "tampered episode ids must not activate");
	}

	// 27. Forged/rewritten active experiences never route direct -------------
	{
		const base = temp("aegis-fx-forgedroute-");
		const { compiled } = activeExperience(base);
		const real = compiled.experience;
		const variants = [
			{ name: "empty-when", experience: { ...real, when: [] } },
			{ name: "empty-expect", experience: { ...real, expect: [] } },
			{ name: "unverified-when", experience: { ...real, when: real.when.map((predicate) => ({ ...predicate, verified_by: [] })) } },
			{ name: "bogus-spec", experience: { ...real, do: { ...real.do, action_spec_digest: "sha256:forged" } } },
			{ name: "replay-scope", experience: { ...real, scope: { ...real.scope, mode: "replay" } } },
			{ name: "wrong-target", experience: { ...real, do: { ...real.do, arguments_template: { path: "../escape.json" } } } },
			{ name: "forged-source", experience: { ...real, provenance: { ...real.provenance, source_kind: ["replay"] }, support: { ...real.support, success_outcome_ids: [] } } },
		];
		for (const variant of variants) {
			const root = join(base, `route-${variant.name}`);
			let decision = null;
			runFixtureTask({
				root,
				router: ({ manifest, fixtureRoot }) => {
					decision = route({ experiences: [variant.experience], manifest, fixtureRoot });
					return decision;
				},
			});
			assert(decision.route !== "direct", `forged experience '${variant.name}' must not route direct`);
			assertEqual(decision.routerDecision, "no_match", `forged experience '${variant.name}' must be no_match`);
		}
	}

	// 28. Forged direct decisions fail closed before execution --------------
	{
		const base = temp("aegis-fx-forgeddirect-");
		const { compiled } = activeExperience(base);
		const real = compiled.experience;

		const cases = [
			{ name: "forged-spec", experience: { ...real, do: { ...real.do, action_spec_digest: "sha256:forged" } }, args: { path: "door.json" } },
			{ name: "forged-target", experience: { ...real, do: { ...real.do, arguments_template: { path: "other.json" } } }, args: { path: "other.json" } },
			{ name: "traversal-args", experience: real, args: { path: "../escape.json" } },
		];
		for (const testCase of cases) {
			const root = join(base, `direct-${testCase.name}`);
			const run = runFixtureTask({
				root,
				router: () => ({
					route: "direct",
					routerDecision: "direct",
					experience: testCase.experience,
					actionId: "fixture.unlock",
					arguments: testCase.args,
					checks: [],
				}),
			});
			assertEqual(run.request.payload.blocked, "forged_direct_decision", `${testCase.name} must be blocked as forged`);
			assertEqual(run.transport.tool_ok, false, `${testCase.name} must not execute`);
			assertEqual(run.transport.failure_mode, "forged_direct_decision", `${testCase.name} failure mode`);
			assertEqual(readJson(run.fixturePath).locked, true, `${testCase.name} must leave the fixture locked`);
			const judged = judgeRun(root);
			assert(judged.status !== "success", `${testCase.name} cannot be success`);
		}
	}

	// 29. A repeated judgment is refused: append-only outcomes, no chain corruption --
	{
		const base = temp("aegis-fx-rejudge-");
		const root = join(base, "rejudge");
		live(root);
		const eventPath = join(root, "events.jsonl");
		const beforeText = readFileSync(eventPath, "utf8");
		const proofPath = join(root, "replay-proof.json");
		const beforeProof = readFileSync(proofPath, "utf8");
		const beforeEvents = readJsonl(eventPath);
		validateEventLog(beforeEvents);
		assertEqual(beforeEvents.filter((event) => event.event_type === "outcome.recorded").length, 2, "first judgment appends exactly two outcome events");

		let threw = false;
		try {
			judgeRun(root);
		} catch {
			threw = true;
		}
		assert(threw, "a repeated judgment must fail clearly instead of duplicating outcomes");

		const afterText = readFileSync(eventPath, "utf8");
		assertEqual(afterText, beforeText, "a refused re-judgment must not change the append-only event log");
		assertEqual(readFileSync(proofPath, "utf8"), beforeProof, "a refused re-judgment must not rewrite the replay proof");
		const afterEvents = readJsonl(eventPath);
		validateEventLog(afterEvents);
		assertEqual(
			afterEvents.filter((event) => event.event_type === "outcome.recorded").length,
			2,
			"a refused re-judgment must not duplicate outcome events",
		);
	}

	// 30. Compiler requires real, linked replayable evidence -----------------
	{
		const base = temp("aegis-fx-replay-");
		const { firstRoot, compiled } = activeExperience(base);
		assertEqual(compiled.experience.status, "active", "replayable successes must activate");

		// Successes carry genuine, isolated replayable evidence linked to the run.
		const firstOutcome = readJson(join(firstRoot, "outcomes.json")).find((outcome) => outcome.level === "episode");
		assertEqual(firstOutcome.reproducibility.replayable, true, "a success must record replayable=true");
		assert(firstOutcome.reproducibility.replay_count >= 1, "replay_count must be >= 1");
		assert(typeof firstOutcome.reproducibility.replay_hash === "string" && firstOutcome.reproducibility.replay_hash.length > 0, "replay_hash must be recorded");
		assert(existsSync(join(firstRoot, "replay-proof.json")), "replay proof artifact must exist");
		const firstEvents = readJsonl(join(firstRoot, "events.jsonl"));
		const replayNotes = firstEvents.filter((event) => event.event_type === "note" && event.payload?.kind === "replay.verified");
		assertEqual(replayNotes.length, 1, "exactly one replay.verified note must be chained into the event log");
		assertEqual(replayNotes[0].payload.proof_digest, firstOutcome.reproducibility.replay_hash, "the event and outcome must agree on the proof digest");
		const liveFixtureBefore = readJson(join(firstRoot, "fixture", "door.json"));
		assertEqual(liveFixtureBefore.locked, false, "the original fixture keeps its own post-action state");

		// (a) Missing replay artifact -> rejected, candidate.
		{
			const missRoot = join(base, "missing-proof");
			live(missRoot);
			rmSync(join(missRoot, "replay-proof.json"), { force: true });
			const missCompiled = compile({ projectionDirs: [firstRoot, missRoot], outputDir: join(base, "compiled-missing") });
			assertEqual(missCompiled.experience.status, "candidate", "a success without a replay proof must not activate");
			assert(
				missCompiled.report.rejected.some((item) => /replay proof artifact is missing/.test(item.reason)),
				"the missing replay proof must be reported",
			);
			assert(missCompiled.report.replay.proof_digests.length < 2, "the non-replayable success must not be counted");
		}

		// (b) Tampered replay artifact (fails self-verification) -> candidate.
		{
			const tamperRoot = join(base, "tampered-proof");
			live(tamperRoot);
			const proofPath = join(tamperRoot, "replay-proof.json");
			const proof = readJson(proofPath);
			proof.postconditions_verified = false;
			writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
			const tamperCompiled = compile({ projectionDirs: [firstRoot, tamperRoot], outputDir: join(base, "compiled-tamper") });
			assertEqual(tamperCompiled.experience.status, "candidate", "a tampered replay proof must not activate");
			assert(
				tamperCompiled.report.rejected.some((item) => /replay proof artifact fails self-verification|replay proof digest does not match/.test(item.reason)),
				"the tampered replay proof must be reported",
			);
		}

		// (c) Tampered replay.verified note (hash chain + linkage broken) -> candidate.
		{
			const noteRoot = join(base, "tampered-note");
			live(noteRoot);
			const eventPath = join(noteRoot, "events.jsonl");
			const rows = readJsonl(eventPath);
			const note = rows.find((event) => event.event_type === "note" && event.payload?.kind === "replay.verified");
			assert(note, "a replay.verified note must be recorded for a replayable success");
			note.payload.proof_digest = "sha256:tampered";
			writeFileSync(eventPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
			const noteCompiled = compile({ projectionDirs: [firstRoot, noteRoot], outputDir: join(base, "compiled-note") });
			assertEqual(noteCompiled.experience.status, "candidate", "a tampered replay note must not activate");
			assert(noteCompiled.report.rejected.length >= 1, "the tampered-note projection must be rejected");
		}

		// (d) The rerunnable check itself can genuinely fail: feeding the replay a
		// trusted pre-state that does not satisfy the registered action's
		// preconditions must yield no proof and no replayability.
		{
			const run = runFixtureTask({ root: join(base, "replay-negative-control") });
			const manifest = readJson(join(run.root, "manifest.json"));
			const badState = { target: "door", locked: false, version: 1 };
			const badRun = { ...run.run, initial_state: badState, initial_state_digest: digest(badState) };
			const negative = replayIsolatedOutcome({ manifest, run: badRun, requested: run.request, episodeId: run.episodeId });
			assertEqual(negative.ok, false, "an unreproducible pre-state must fail the isolated replay");
			assert(!negative.proof, "a failed replay must not produce a proof");
			assert(negative.reasons.length > 0, "a failed replay must explain why");
		}
	}
}

try {
	runTests();
	console.log("fixture direct smoke ok");
} catch (error) {
	console.error(`fixture direct smoke FAILED: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
}
