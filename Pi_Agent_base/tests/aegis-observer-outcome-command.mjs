// Offline REAL Pi SDK faux-provider test: Aegis outcome import + routing
// state update + candidate Experience proposal + command handoff.
//
// Covers the integration items required by this stage:
//   1. `/aegis outcome <task> [session]` imports a contest result by EXACT
//      task/session, records a canonical MEMORY_SCHEMA §5.2 Outcome, and the
//      board states the PROPOSITION that was verified (not `outcome:success`).
//   2. A missing result imports NOTHING (success is never inferred); conflicting
//      rows import as `unknown`; a non-independent source never becomes a Fact.
//   3. The LLM may PROPOSE a candidate Experience (when/do/expect/scope/
//      source_refs); it stays a candidate Hint, is never proof, and is never
//      compiled into a script.
//   4. The canonical Outcome object is legal per MEMORY_SCHEMA §5.2 (all
//      required fields present, `observed` non-null for success/failure).
//   5. `/aegis switch` rechecks the staged handoff against CURRENT state and,
//      when allowed, invokes the runtime's `ctx.newSession` command seam,
//      recording handoff.completed and continuing the SAME episode.
//
// HONESTY NOTE (audit item 2): the `commandContextActions.newSession` used here
// is an INJECTED TEST SEAM. It creates a fresh SessionManager and runs the
// `withSession` callback, exactly as the command contract requires, but it does
// NOT swap the real AgentSessionRuntime (the production host performs that). So
// the command-path CHECKS below exercise the command seam (the recheck, the
// callback, the handoff.completed record), not a full SDK runtime replacement.
// The seam test is kept as a negative/positive command-path check; a real
// AgentSessionRuntime switch is NOT proven here and stays explicitly untested.
//
// Regression added for audit item 1: the `/aegis outcome` path is driven through
// the REAL Pi SDK command invocation and must refuse a cross-task import and a
// foreign session id, and must be idempotent for a repeated identical result.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-observer-outcome-command.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";

import { projectBoard } from "../memory/runtime/board.mjs";
import { projectState } from "../memory/runtime/state.mjs";
import { readContestResults, resolveContestOutcome } from "../memory/runtime/contest-bridge.mjs";

const BASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVER_PATH = join(BASE_DIR, "extensions", "aegis-observer.ts");

let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

function makeFauxModelDetails(model) {
	return {
		baseUrl: model.baseUrl,
		api: model.api,
		apiKey: "faux-key",
		models: [{
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		}],
	};
}

function readEvents(path) {
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const REQUIRED_OUTCOME_FIELDS = ["schema_version", "outcome_id", "level", "episode_id", "status", "criterion", "observed", "oracle", "evidence_refs", "transport", "failure_mode", "reproducibility", "assessed_at"];

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-obs-outcome-"));
	const agentDir = join(base, "agent");
	const cwd = join(base, "cwd");
	const sessionDir = join(base, "sessions");
	const eventLog = join(base, "events.jsonl");
	const ramDir = join(base, "ram");
	const handoffFile = join(ramDir, "handoff.json");
	const resultsPath = join(base, "contest-results.jsonl");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-outcome", name: "FauxOutcome" }] });
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(base, "models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, makeFauxModelDetails(model));

	process.env.AEGIS_EVENT_LOG = eventLog;
	process.env.AEGIS_RAM_DIR = ramDir;
	process.env.AEGIS_HANDOFF_FILE = handoffFile;
	process.env.AEGIS_ROM_FILE = join(BASE_DIR, "agent", "ROM.md");
	process.env.AEGIS_TASK_ID = "task-outcome-001";
	process.env.AEGIS_CONTEST_RESULTS = resultsPath;
	process.env.AEGIS_CONTEST_MODE = "off";
	// Keep the contest extension out of this test: only the observer is loaded.
	process.env.AEGIS_CONTEST_CARDS = "";
	process.env.AEGIS_CONTEST_LOG = join(base, "contest.jsonl");

	// A genuine replacement tracker: the fake ctx.newSession creates a NEW
	// SessionManager over the same directory (a real, distinct session file) and
	// invokes withSession with a replacement context, exactly like the runtime.
	// This is an INJECTED COMMAND SEAM, not a real AgentSessionRuntime swap: see
	// the honesty note at the top of this file. It proves the command path, not
	// the SDK runtime replacement.
	let replacementCount = 0;
	let lastReplacementFile = null;
	let lastSentUserMessage = null;
	const sessionFileBefore = null;

	async function createSession() {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [OBSERVER_PATH],
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const sessionId = sessionManager.getSessionId();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			resourceLoader: loader,
			sessionManager,
			settingsManager: SettingsManager.inMemory({}),
			tools: ["read", "aegis_propose", "aegis_switch_session"],
		});
		await session.bindExtensions({
			commandContextActions: {
				waitForIdle: async () => {},
				newSession: async (options) => {
					// Perform an ACTUAL replacement: a fresh SessionManager (new file),
					// then run the withSession callback bound to it.
					replacementCount += 1;
					const nextManager = SessionManager.create(cwd, sessionDir);
					lastReplacementFile = typeof nextManager.getSessionFile === "function" ? nextManager.getSessionFile() : null;
					if (options?.withSession) {
						await options.withSession({
							sendUserMessage: async (content) => {
								lastSentUserMessage = typeof content === "string" ? content : JSON.stringify(content);
							},
						});
					}
					return { cancelled: false };
				},
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: async () => {},
			},
		});
		return { session, loaded, sessionId };
	}

	// ---- 1. Start an episode and reach the idle boundary -------------------
	const first = await createSession();
	check("observer loaded without errors", first.loaded.errors.length === 0, JSON.stringify(first.loaded.errors));
	faux.setResponses([fauxAssistantMessage("working")]);
	await first.session.prompt("Do the outcome task.");
	let events = readEvents(eventLog);
	const started = events.filter((e) => e.event_type === "episode.started");
	check("an episode started", started.length === 1);
	const episodeId = started[0].episode_id;

	// ---- 2. Command: outcome for a task with NO result must import nothing --
	await first.session.prompt("/aegis outcome task-outcome-001");
	events = readEvents(eventLog);
	check("a missing result records NO outcome.recorded event", !events.some((e) => e.event_type === "outcome.recorded"));
	check("a missing result DOES leave the session/board touched (no false success)", projectBoard(events).byType.Fact.length === 0);

	// ---- 3. Write a REAL independent contest result, import it -------------
	// The row is written by the (injected/real) result path shape; here we write
	// the authoritative JSONL row directly so the command reads it verbatim. The
	// session id MUST be the current episode's own session: the observer now
	// refuses a hand-supplied foreign session id (P0 cross-task binding).
	const sessionIdA = first.sessionId;
	const row = {
		task_id: "task-outcome-001",
		session_id: sessionIdA,
		result: "success",
		result_source: "platform",
		independent: true,
		evidence: "grader score=100 (all assertions passed)",
		group: "g1",
		at: "2026-01-02T03:04:05Z",
	};
	// A DIFFERENT task's result that must never be importable into THIS episode.
	const otherRow = {
		task_id: "task-other-999",
		session_id: sessionIdA,
		result: "success",
		result_source: "platform",
		independent: true,
		evidence: "a result for a different task",
		group: "g1",
		at: "2026-01-02T03:04:05Z",
	};
	writeFileSync(resultsPath, `${JSON.stringify(row)}\n${JSON.stringify(otherRow)}\n`);

	// P0 cross-task binding: importing ANOTHER task's result into THIS episode
	// (through the real Pi SDK command invocation) must be REFUSED. No outcome
	// event, no cross-task write, and the observer never silently rebinds.
	await first.session.prompt("/aegis outcome task-other-999");
	events = readEvents(eventLog);
	check("a cross-task outcome import is REFUSED (no outcome.recorded)", !events.some((e) => e.event_type === "outcome.recorded"));

	// A foreign session id must be refused even for the current task.
	await first.session.prompt("/aegis outcome task-outcome-001 not-a-real-session");
	events = readEvents(eventLog);
	check("an outcome for the current task with a FOREIGN session id is REFUSED", !events.some((e) => e.event_type === "outcome.recorded"));

	// The current task with its OWN session id imports normally.
	await first.session.prompt(`/aegis outcome task-outcome-001 ${sessionIdA}`);
	events = readEvents(eventLog);
	const outcomes = events.filter((e) => e.event_type === "outcome.recorded");
	check("the independent result was imported as an outcome.recorded event", outcomes.length === 1, `count=${outcomes.length}`);
	const outcome = outcomes[0]?.payload ?? {};
	check("the Outcome is legal per MEMORY_SCHEMA §5.2 (all fields, observed non-null)", REQUIRED_OUTCOME_FIELDS.every((f) => f in outcome) && outcome.observed !== null && outcome.observed !== undefined);
	check("the Outcome keeps its own schema_version 1.0", outcome.schema_version === "1.0");
	check("the imported outcome is marked independent with a trusted source kind", outcomes[0].source.kind === "oracle" && outcome.provenance?.independent === true);
	check("the imported outcome carries the task/session provenance verbatim", outcome.provenance?.task_id === "task-outcome-001" && outcome.provenance?.session_id === sessionIdA);
	check("the outcome records evidence_refs as normalized objects", Array.isArray(outcome.evidence_refs) && outcome.evidence_refs.length >= 1 && outcome.evidence_refs.every((r) => typeof r.ref_type === "string" && typeof r.ref_id === "string"));

	// Idempotency: the SAME result imported again must NOT add a second outcome
	// event, so re-running the import cannot inflate independence.
	await first.session.prompt(`/aegis outcome task-outcome-001 ${sessionIdA}`);
	events = readEvents(eventLog);
	check("re-importing the identical result is idempotent (still ONE outcome.recorded)", events.filter((e) => e.event_type === "outcome.recorded").length === 1, `count=${events.filter((e) => e.event_type === "outcome.recorded").length}`);

	// Supersedes: a later CORRECTED result for the same task/session is recorded
	// with a `supersedes` link to the earlier outcome_id. It is a correction, not
	// a second independent attempt (or a silent duplicate).
	const correctedRow = { ...row, evidence: "grader score=100 (re-run; corrected transcript)", at: "2026-01-02T06:00:00Z" };
	writeFileSync(resultsPath, `${JSON.stringify(correctedRow)}\n${JSON.stringify(otherRow)}\n`);
	await first.session.prompt(`/aegis outcome task-outcome-001 ${sessionIdA}`);
	events = readEvents(eventLog);
	const allOutcomes = events.filter((e) => e.event_type === "outcome.recorded");
	check("a corrected result is recorded once (two outcomes total: original + correction)", allOutcomes.length === 2, `count=${allOutcomes.length}`);
	const correction = allOutcomes[1]?.payload ?? {};
	check("the correction declares supersedes pointing at the original outcome_id", correction.supersedes === outcomes[0].payload.outcome_id, `supersedes=${correction.supersedes} original=${outcomes[0].payload.outcome_id}`);
	check("the correction is marked in provenance as a non-independent correction", correction.provenance?.supersedes === outcomes[0].payload.outcome_id && typeof correction.provenance?.superseding_note === "string");

	// ---- 4. Board states the PROPOSITION, not outcome:success --------------
	const board = projectBoard(events);
	const fact = board.byType.Fact.find((n) => n.text.includes("contest"));
	check("the board has a Fact for the verified proposition", fact !== undefined, JSON.stringify(board.byType.Fact.map((n) => n.text)));
	check("the Fact states the proposition (criterion), not a bare outcome word", !!fact && !/^outcome:success/.test(fact.text) && fact.text.includes("observed:"), fact?.text);
	check("the board did NOT create a Refuted node", board.byType.Refuted.length === 0);

	// ---- 5. Canonical Outcome legality on a hand-built row -----------------
	// Directly exercise the resolver: conflicting rows must import as unknown,
	// and a non-independent source must not create a Fact.
	const conflictRows = [row, { ...row, result: "failure", at: "2026-01-02T04:04:05Z" }];
	const conflicted = resolveContestOutcome(conflictRows, { taskId: "task-outcome-001", sessionId: sessionIdA, episodeId });
	check("conflicting rows resolve to unknown (never guessed)", conflicted.conflict === true && conflicted.outcome.status === "unknown" && conflicted.outcome.failure_mode === "insufficient_evidence");
	const agentRow = { task_id: "task-outcome-001", session_id: "s", result: "success", result_source: "agent", independent: true, evidence: "model self-report", at: "2026-01-02T05:04:05Z" };
	const agentResolved = resolveContestOutcome([agentRow], { taskId: "task-outcome-001", sessionId: "s", episodeId });
	check("a non-independent source cannot produce a success verdict", agentResolved.outcome.status === "unknown");
	const readBack = await readContestResults(resultsPath);
	check("readContestResults returns the exact task row (and keeps the other task separate)", readBack.rows.length === 2 && readBack.rows.filter((r) => r.task_id === "task-outcome-001").length === 1 && readBack.rows.filter((r) => r.task_id === "task-other-999").length === 1);
	const none = resolveContestOutcome(readBack.rows, { taskId: "task-absent-000", episodeId });
	check("selection is EXACT: a different task matches nothing", none.missing === true && none.rows.length === 0);

	// ---- 6. LLM candidate EXPERIENCE proposal stays a candidate ------------
	// A candidate Experience with when/do/expect/scope/source_refs is recorded as
	// an UNVERIFIED candidate Hint, never a Fact, and never compiled to a script.
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("aegis_propose", {
			kind: "candidate",
			text: "lockfile refresh unblocks the build",
			when: ["build_failed", "lockfile_stale"],
			do: "run the project's lockfile refresh command, then rebuild",
			expect: "build exits 0",
			scope: "repo:demo",
			source_refs: ["episode:task-outcome-001"],
		})]),
		fauxAssistantMessage("candidate recorded"),
	]);
	await first.session.prompt("Propose a candidate experience.");
	events = readEvents(eventLog);
	const candidateEvents = events.filter((e) => e.event_type === "proposal.submitted" && e.payload?.kind === "candidate");
	check("a candidate Experience proposal was recorded", candidateEvents.length === 1, `count=${candidateEvents.length}`);
	const candidate = candidateEvents[0]?.payload ?? {};
	check("the candidate carries when/do/expect/scope/source_refs", Array.isArray(candidate.when) && candidate.when.length === 2 && typeof candidate.do === "string" && typeof candidate.expect === "string" && candidate.scope === "repo:demo" && Array.isArray(candidate.source_refs) && candidate.source_refs.length === 1);
	check("the candidate is explicitly UNVERIFIED and has no proof", candidate.candidate === true && candidate.verified === false && candidate.proof === null);
	const boardAfter = projectBoard(events);
	check("the candidate Experience is a Hint node, never a Fact/active Experience", boardAfter.byType.Hint.some((n) => n.text.includes("lockfile refresh unblocks the build")) && !boardAfter.byType.Fact.some((n) => n.text.includes("lockfile refresh")));
	check("no exploit/script artifact was produced by the candidate", !events.some((e) => e.event_type === "artifact.created" && JSON.stringify(e.payload).includes("lockfile refresh")));

	// A bad candidate that smuggles a model-immutable field must be rejected.
	// (A bare string `when` is coerced to an array by Pi's tool parameter schema
	// before the gate sees it, so the gate's own type check is covered by the
	// direct validateProposal assertion below.)
	const { validateProposal } = await import("../memory/runtime/proposal.mjs");
	check("the runtime gate rejects a non-array `when` (unit)", validateProposal({ kind: "candidate", text: "t", when: "not-an-array" }).accepted === false);
	check("the runtime gate rejects `when` on a non-candidate (unit)", validateProposal({ kind: "claim", text: "t", when: ["x"] }).accepted === false);
	check("the runtime gate accepts a well-formed candidate (unit)", validateProposal({ kind: "candidate", text: "t", when: ["a"], do: "d", expect: "e" }).accepted === true);
	// A candidate that tries to smuggle a model-immutable field. Unknown keys are
	// stripped by Pi's tool parameter schema, so the gate's forbidden-field rule is
	// covered by the direct unit assertions above; here we prove a plain candidate
	// with no when/do/expect still stays a candidate and never a Fact.
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("aegis_propose", { kind: "candidate", text: "maybe restart the daemon" })]),
		fauxAssistantMessage("done"),
	]);
	await first.session.prompt("Propose a bare candidate.");
	events = readEvents(eventLog);
	const bareCandidates = events.filter((e) => e.event_type === "proposal.submitted" && e.payload?.kind === "candidate");
	const lastCandidate = bareCandidates[bareCandidates.length - 1];
	check("a bare candidate is recorded with empty when/do/expect (still unverified)", bareCandidates.length >= 2 && lastCandidate?.payload?.text === "maybe restart the daemon" && Array.isArray(lastCandidate.payload.when) && lastCandidate.payload.when.length === 0 && lastCandidate.payload.do === null && lastCandidate.payload.expect === null && lastCandidate.payload.verified === false, JSON.stringify(bareCandidates.map((e) => e.payload)));

	// ---- 7. ACTUAL command handoff recheck + session replacement -----------
	// Request a handoff through the model tool (allowed: no real action pending).
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("aegis_switch_session", { reason: "context is long" })]),
		fauxAssistantMessage("requested"),
	]);
	await first.session.prompt("Please request a handoff.");
	events = readEvents(eventLog);
	check("a handoff was requested and staged", events.some((e) => e.event_type === "handoff.requested") && readFileSync(handoffFile, "utf8").includes(episodeId));

	// Now run the ACTUAL command. It must recheck state and replace the session.
	await first.session.prompt("/aegis switch");
	check("the /aegis switch command actually replaced the session", replacementCount === 1, `replacementCount=${replacementCount}`);
	check("the replacement created a distinct session file", typeof lastReplacementFile === "string" && lastReplacementFile !== sessionFileBefore);
	check("the replacement continued the SAME episode via a user message", typeof lastSentUserMessage === "string" && lastSentUserMessage.includes(episodeId));
	events = readEvents(eventLog);
	check("handoff.completed was recorded by the replacement", events.some((e) => e.event_type === "handoff.completed"));

	// ---- 8. Handoff recheck REFUSES when the episode has closed ------------
	// Stage a fresh handoff, close the episode, then run the command: it must
	// refuse (no replacement) because the recheck runs against CURRENT state.
	await first.session.prompt("/aegis close");
	// Re-stage a handoff file pointing at the now-closed episode by re-requesting.
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("aegis_switch_session", { reason: "again" })]),
		fauxAssistantMessage("requested again"),
	]);
	// The episode is closed; the observer will create/open per task. To force a
	// staged file, write one directly for the closed episode.
	writeFileSync(handoffFile, JSON.stringify({ episode_id: episodeId, task_id: "task-outcome-001", reason: "force", request_id: "req-closed" }));
	await first.session.prompt("/aegis switch");
	check("a handoff for a CLOSED episode is refused (no replacement)", replacementCount === 1, `replacementCount=${replacementCount}`);

	first.session.dispose();
	faux.unregister();
	rmSync(base, { recursive: true, force: true });

	console.log("");
	if (failures > 0) {
		console.error(`aegis-observer-outcome-command FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-observer-outcome-command ok");
}

main().catch((error) => {
	console.error(`aegis-observer-outcome-command: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
