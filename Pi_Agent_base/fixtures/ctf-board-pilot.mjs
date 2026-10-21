// Bounded user-invoked real-model CTF pilot. Uses the real Observer and SDK.
// CLI computations run in a separate Python process with an audit guard. This
// bounds ordinary file/process/network use; it is NOT an OS security sandbox.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendContestOutcome } from "../contest/outcome-bridge.mjs";
import { projectBoard } from "../memory/board.mjs";
import { EventLog, verifyChain } from "../shared/events.mjs";

const BASE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AEGIS_HOME = resolve(process.env.AEGIS_HOME || join(process.env.HOME || BASE, ".Aegis"));
const AGENT_DIR = resolve(process.env.AEGIS_PI_AGENT_DIR || join(AEGIS_HOME, "agent"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const text = (message) =>
	typeof message?.content === "string"
		? message.content
		: (message?.content ?? []).map((part) => part.text ?? "").join("\n");
const PYTHON = "/opt/homebrew/bin/python3";
const PY_BOOTSTRAP = `import sys,os,json,sysconfig
root=os.path.realpath(sys.argv[1])
source=sys.stdin.read()
stdlib=os.path.realpath(sysconfig.get_path('stdlib'))
def within(path,base):
 return path==base or path.startswith(base+os.sep)
def audit(event,args):
 if event=='open':
  path=args[0]
  if isinstance(path,int):return
  path=os.path.realpath(os.fsdecode(path))
  mode=args[1] or '';flags=args[2] or 0
  writing=any(c in str(mode) for c in 'wax+') or (flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC))
  if not within(path,root) and not (not writing and within(path,stdlib)):raise PermissionError('outside pilot workspace')
 if event.startswith(('socket.','subprocess.','ctypes.')) or event in ('os.system','os.exec','os.posix_spawn','os.fork','os.remove','os.rmdir','os.rename','os.symlink','os.link'):
  raise PermissionError('operation outside pilot CLI scope')
sys.addaudithook(audit)
os.chdir(root)
exec(compile(source,'<pilot-cli>','exec'),{'__name__':'__main__'})
`;

export function expectedFlag(taskDir) {
	const raw = readFileSync(join(taskDir, "evaluation", "expected.bin"));
	const match = raw.toString("utf8").match(/DUCTF\{[^}\r\n]+\}/);
	if (!match) throw new Error("independent expected flag is missing");
	return match[0];
}

export function checkCandidate(workspace, expected, output = "") {
	let candidate = "";
	try {
		candidate = readFileSync(join(workspace, "candidate.txt"), "utf8").trim();
	} catch {}
	return candidate === expected || output.includes(expected);
}

export function pythonCli(workspace, code, signal, timeoutMs = 20000) {
	return new Promise((done) => {
		const child = spawn(PYTHON, ["-I", "-S", "-c", PY_BOOTSTRAP, workspace], {
			cwd: workspace,
			detached: true,
			env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", LANG: "en_US.UTF-8", PYTHONDONTWRITEBYTECODE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "",
			stderr = "",
			timedOut = false;
		const kill = () => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		const onAbort = () => kill();
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (b) => {
			if (stdout.length < 32000) stdout += b.toString();
		});
		child.stderr.on("data", (b) => {
			if (stderr.length < 12000) stderr += b.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			done({ stdout, stderr: error.message, exit_code: null, timed_out: timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			done({ stdout, stderr, exit_code: code, timed_out: timedOut });
		});
		child.stdin.end(code);
	});
}

/**
 * Build the canonical Outcome row for one bounded attempt. Pure: no IO, no
 * clock unless `assessedAt` is supplied. The expected flag is never included;
 * only digests and the matched source.
 *
 * A verified match may come from `candidate.txt` OR from the assistant's final
 * text (the same independent check), so the row records which one matched.
 */
export function buildPilotOutcomeRow({
	verified,
	candidateText = "",
	expected,
	taskId,
	sessionId = null,
	attemptId,
	stop,
	requests = 0,
	toolCalls = 0,
	providerError = false,
	elapsedMs = 0,
	expectedSha256 = null,
	resultDigest = null,
	assessedAt = null,
}) {
	const matchedIn = verified ? (candidateText === expected ? "candidate.txt" : "assistant_output") : null;
	const evidence = verified
		? `independent exact flag match in ${matchedIn}; expected_sha256=${expectedSha256}; matched_sha256=${hash(candidateText || expected)}`
		: `no independent exact flag match; stop=${stop}; requests=${requests}; tool_calls=${toolCalls}; provider_error=${providerError}`;
	return {
		task_id: taskId,
		session_id: sessionId,
		attempt_id: attemptId,
		result: verified ? "success" : "unknown",
		source: "oracle",
		independent: true,
		evidence,
		criterion: {
			criterion_id: "ctf-flag-exact",
			description: "the recovered flag equals the private expected flag",
			expected: "candidate.txt or the final assistant text equals the private expected flag",
		},
		observed: verified
			? { matched: true, matched_in: matchedIn, matched_sha256: hash(candidateText || expected) }
			: { matched: false, stop, requests, tool_calls: toolCalls },
		transport: { tool_ok: providerError !== true, timed_out: stop === "wall_time", duration_ms: elapsedMs },
		failure_mode: verified
			? null
			: providerError
				? "provider_error"
				: stop === "wall_time"
					? "timeout"
					: stop === "budget"
						? "budget_exhausted"
						: stop === "output_limit"
							? "output_limit"
							: "no_verified_candidate",
		preconditions_verified: false,
		evidence_refs: [{ ref_type: "artifact", ref_id: `attempt:${attemptId}`, digest: resultDigest }],
		assessed_at: assessedAt ?? new Date().toISOString(),
	};
}

/** Explicit user invocation only; no credentials or external answer in tool context. */
export async function runCtfPilot({
	taskDir,
	mode,
	attemptId,
	maxRequests = 14,
	maxTools = 30,
	wallMs = 240000,
	provider = "maxapi",
	modelId = "deepseek-v4.1-flash",
	maxOutputTokens = 8192,
	taskBinding = null,
}) {
	if (!["A", "B", "C", "D"].includes(mode)) throw new Error("mode must be A/B/C/D");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(attemptId)) throw new Error("invalid attempt id");
	const boardEnabled = ["B", "D"].includes(mode),
		knowledgeEnabled = ["C", "D"].includes(mode);
	const provenance = JSON.parse(readFileSync(join(taskDir, "provenance.json"), "utf8"));
	// The Episode is bound to the CHALLENGE id (stable across attempts); the
	// attempt id only names the run directory and the private evidence.
	const taskId = typeof taskBinding === "string" && taskBinding ? taskBinding : provenance.id;
	const dir = join(resolve(taskDir), "runs", attemptId);
	if (existsSync(dir)) throw new Error("attempt already exists");
	const workspace = join(dir, "workspace");
	for (const name of ["workspace", "agent", "sessions", "ram", "projections"])
		mkdirSync(join(dir, name), { recursive: true });
	for (const name of readdirSync(join(taskDir, "handout")))
		copyFileSync(join(taskDir, "handout", name), join(workspace, name));
	const expected = expectedFlag(taskDir);
	const environment = {
		AEGIS_EVENT_LOG: join(dir, "events.jsonl"),
		AEGIS_TASK_ID: taskId,
		AEGIS_ATTEMPT_ID: attemptId,
		AEGIS_RAM_DIR: join(dir, "ram"),
		AEGIS_PROJECTION_DIR: join(dir, "projections"),
		AEGIS_EXPERIENCE_DIR: join(dir, "experiences"),
		AEGIS_HANDOFF_FILE: join(dir, "handoff.json"),
		AEGIS_ROM_FILE: join(BASE, "agent", "ROM.md"),
		AEGIS_WORKSPACE: workspace,
		AEGIS_BOARD_FEEDBACK: boardEnabled ? "on" : "off",
		AEGIS_KNOWLEDGE_ENABLED: knowledgeEnabled ? "on" : "off",
		AEGIS_KNOWLEDGE_DIR: resolve(AEGIS_HOME, "knowledge"),
		AEGIS_RAM_SEED_FILE: "",
		AEGIS_TASK_CONTRACT_FILE: "",
		AEGIS_MANIFEST_FILE: "",
		AEGIS_SCRIPT_CONFIG: "",
		AEGIS_REPLAY_ADAPTER: "",
	};
	const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
	Object.assign(process.env, environment);
	const start = Date.now();
	let session,
		sessionId = null,
		requests = 0,
		toolCalls = 0,
		verified = false,
		verifiedAt = null,
		stop = "settled",
		error = null;
	const providerRequests = [],
		operations = [],
		usage = [];
	const modelConfigDir = AGENT_DIR;
	const metadata = {
		task: provenance.id,
		category: provenance.category ?? null,
		difficulty: provenance.difficulty ?? null,
		task_binding: `AEGIS_TASK_ID=${taskId}`,
		mode,
		board_enabled: boardEnabled,
		knowledge_enabled: knowledgeEnabled,
		attempt_id: attemptId,
		provider,
		model: modelId,
		max_output_tokens: maxOutputTokens,
		max_requests: maxRequests,
		max_tool_calls: maxTools,
		wall_ms: wallMs,
		started_at: new Date(start).toISOString(),
		session_policy: "single session; no rotation; identical CLI and proposal tools",
		isolation: "Python process audit guard, not OS sandbox",
		input_sha256: Object.fromEntries(
			readdirSync(join(taskDir, "handout")).map((n) => [n, hash(readFileSync(join(taskDir, "handout", n)))]),
		),
	};
	writeFileSync(join(dir, "experiment.json"), JSON.stringify(metadata, null, 2));
	try {
		const { Type } = await import("@earendil-works/pi-ai");
		const {
			createAgentSessionFromServices,
			createAgentSessionServices,
			ModelRuntime,
			SessionManager,
			SettingsManager,
		} = await import("@earendil-works/pi-coding-agent");
		const { ReadOnlyAuthStorage } = await import("@earendil-works/pi-coding-agent/core/auth-storage");
		const modelRuntime = await ModelRuntime.create({
			credentials: new ReadOnlyAuthStorage(join(modelConfigDir, "auth.json")),
			modelsPath: join(modelConfigDir, "models.json"),
			modelsStorePath: join(dir, "models-store.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		if (modelRuntime.getError()) throw new Error("selected model config invalid");
		const configured = modelRuntime.getModel(provider, modelId);
		if (!configured || !(await modelRuntime.getAuth(configured)))
			throw new Error("selected model or credential unavailable");
		const model = { ...configured, maxTokens: Math.min(configured.maxTokens, maxOutputTokens) };
		const cli = {
			name: "cli",
			label: "Local Python CLI",
			description:
				"Execute bounded Python 3 standard-library code in the task workspace. Use pathlib to read inputs and write scripts/results. No network, subprocess, package installation or files outside this workspace. Each call starts a fresh interpreter, so save reusable work to files. Maximum 20 seconds per call. Save the recovered flag alone to candidate.txt.",
			parameters: Type.Object({ code: Type.String({ maxLength: 20000 }) }),
			async execute(id, params, signal) {
				const began = Date.now();
				const result = await pythonCli(workspace, params.code, signal);
				operations.push({ tool_call_id: id, code: params.code, ...result, duration_ms: Date.now() - began });
				writeFileSync(join(dir, "operations.json"), JSON.stringify(operations, null, 2));
				if (checkCandidate(workspace, expected, result.stdout)) {
					verified = true;
					verifiedAt ??= Date.now() - start;
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								...result,
								stdout: result.stdout.slice(0, 14000),
								stderr: result.stderr.slice(0, 4000),
							}),
						},
					],
					details: { exit_code: result.exit_code, timed_out: result.timed_out },
					...(verified ? { terminate: true } : {}),
				};
			},
		};
		const services = await createAgentSessionServices({
			cwd: workspace,
			agentDir: join(dir, "agent"),
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noContextFiles: true,
				noPromptTemplates: true,
				noThemes: true,
				additionalExtensionPaths: [join(BASE, "extensions", "aegis-observer.ts")],
				extensionFactories: [
					(pi) => {
						pi.on("tool_call", () => {
							if (Date.now() - start > wallMs || toolCalls >= maxTools || verified)
								return {
									block: true,
									terminate: true,
									reason: "pilot budget exhausted or independently verified candidate obtained",
								};
							toolCalls++;
						});
					},
				],
			},
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(workspace, join(dir, "sessions")),
			model,
			thinkingLevel: "high",
			tools: ["cli", "aegis_propose", "aegis_knowledge"],
			customTools: [cli],
		});
		if (services.diagnostics?.extensions?.errors?.length) throw new Error("Observer extension failed to load");
		session = created.session;
		sessionId = session.sessionId ?? null;
		await session.bindExtensions({ mode: "print" });
		const original = session.agent.streamFunction;
		session.agent.streamFunction = async (selectedModel, context, options) => {
			if (verified) throw new Error("pilot_candidate_verified");
			if (requests >= maxRequests || Date.now() - start > wallMs) {
				stop = "budget";
				throw new Error("pilot_budget_exhausted");
			}
			requests++;
			const rams = context.messages.filter(
				(m) => ["user", "custom"].includes(m.role) && text(m).startsWith("<aegis_ram>"),
			);
			if (rams.length !== 1) throw new Error("pilot_expected_one_actual_RAM");
			const ram = JSON.parse(
				text(rams[0])
					.replace(/^<aegis_ram>\n/, "")
					.replace(/\n<\/aegis_ram>$/, ""),
			);
			if (
				!boardEnabled &&
				["facts", "refuted", "tools", "proposals", "artifacts", "decisions", "checkpoints"].some(
					(s) => ram.sections[s]?.shown > 0,
				)
			)
				throw new Error("board_off_payload_contaminated");
			if (!knowledgeEnabled && (ram.sections.knowledge?.shown || ram.sections.external_reference?.shown))
				throw new Error("seed_off_payload_contaminated");
			providerRequests.push({
				request: requests,
				elapsed_ms: Date.now() - start,
				input_chars: JSON.stringify(context).length,
				ram,
				payload_digest: hash(JSON.stringify(context)),
			});
			writeFileSync(join(dir, "requests.json"), JSON.stringify(providerRequests, null, 2));
			console.log(
				JSON.stringify({ attempt: attemptId, request: requests, elapsed_ms: Date.now() - start, tools: toolCalls }),
			);
			return original(selectedModel, context, options);
		};
		session.subscribe((event) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				if (event.message.usage) usage.push(event.message.usage);
				writeFileSync(
					join(dir, "assistant.json"),
					JSON.stringify(
						session.messages.filter((m) => m.role === "assistant"),
						null,
						2,
					),
				);
				if (checkCandidate(workspace, expected, text(event.message))) {
					verified = true;
					verifiedAt ??= Date.now() - start;
				}
			}
		});
		const prompt = `Solve the supplied local CTF ${metadata.category ?? "challenge"} challenge (${metadata.difficulty ?? "unknown"}). Inspect the handout files, derive a reproducible solution, and save the recovered flag alone to candidate.txt. You may use the local Python CLI (standard library only); it can read the handout bytes but cannot run other programs or use the network. Do not search the internet or other directories. Do not fabricate a result. Record concise meaningful hypotheses/progress with aegis_propose rather than every thought. Knowledge retrieval is ${knowledgeEnabled ? "available: decide which reference is relevant from the actual task observations" : "unavailable for this run"}. Board feedback is ${boardEnabled ? "available in RAM" : "disabled; ordinary tool history remains"}. Files: ${readdirSync(workspace).join(", ")}. ${metadata.task.includes("three-line") ? "The original plaintext is English text containing the flag." : "The flag format is DUCTF{...}."}`;
		writeFileSync(join(dir, "prompt.txt"), prompt);
		const timer = setTimeout(
			() => {
				stop = "wall_time";
				void session.abort();
			},
			Math.max(1, wallMs - (Date.now() - start)),
		);
		try {
			await session.prompt(prompt);
		} finally {
			clearTimeout(timer);
		}
		verified ||= checkCandidate(workspace, expected, session.getLastAssistantText() ?? "");
		if (verified) verifiedAt ??= Date.now() - start;
	} catch (e) {
		error = e.message;
	} finally {
		await session?.dispose();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	let events = [];
	try {
		events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	} catch {}
	const board = projectBoard(events);
	let lastModelStop = null,
		providerError = false;
	try {
		const messages = JSON.parse(readFileSync(join(dir, "assistant.json"), "utf8"));
		lastModelStop = messages.at(-1)?.stopReason ?? null;
		providerError =
			lastModelStop === "error" &&
			!/pilot_(budget_exhausted|candidate_verified)/.test(messages.at(-1)?.errorMessage ?? error ?? "");
	} catch {}
	// A model output-length stop is not "settled": it is a bounded stop whose
	// missing answer must be visible as such (the pilot used the same category).
	if (!verified && stop === "settled" && lastModelStop === "length") stop = "output_limit";
	// The wall timer can race a prompt that resolves at the same millisecond.
	// Classify a settled run that already consumed the whole wall budget as a
	// wall stop, so a budget/stop report never hides the limit that ended it.
	if (!verified && stop === "settled" && Date.now() - start >= wallMs) stop = "wall_time";
	const result = {
		...metadata,
		verified_success: verified,
		verified_at_ms: verifiedAt,
		elapsed_ms: Date.now() - start,
		requests,
		tool_calls: toolCalls,
		cli_calls: operations.length,
		stop: verified ? "independent_exact_flag" : stop,
		error,
		last_model_stop: lastModelStop,
		provider_error: providerError,
		actual_models:
			session?.messages?.filter((m) => m.role === "assistant").map((m) => ({ provider: m.provider, model: m.model })) ??
			[],
		chain_ok: verifyChain(events).ok,
		graph_counts: Object.fromEntries(Object.entries(board.byType).map(([k, v]) => [k, v.length])),
		proposal_count: events.filter((e) => e.event_type === "proposal.submitted").length,
		knowledge_queries: events
			.filter((e) => e.payload?.kind === "knowledge.selected")
			.map((e) => ({
				mode: e.payload.mode,
				query: e.payload.query,
				selected: e.payload.selected?.map((s) => ({ id: s.knowledge_id, topic: s.topic, section: s.section })),
			})),
		knowledge_visible_requests: providerRequests.filter((r) => r.ram.sections.knowledge?.shown > 0).length,
		usage,
		expected_flag_sha256: hash(expected),
		output_dir: dir,
	};
	// Route-B closure: the independent check is a host-side oracle, so record the
	// Outcome in the SAME committed EventLog the Board/RAM read. A bounded attempt
	// that produced no match is `unknown` (not a task failure): budget/timeout/
	// provider stops do not prove the challenge is unsolvable.
	const outcomeRow = buildPilotOutcomeRow({
		verified,
		candidateText: existsSync(join(workspace, "candidate.txt"))
			? readFileSync(join(workspace, "candidate.txt"), "utf8").trim()
			: "",
		expected,
		taskId,
		sessionId,
		attemptId,
		stop: result.stop,
		requests,
		toolCalls,
		providerError,
		elapsedMs: result.elapsed_ms,
		expectedSha256: result.expected_flag_sha256,
		resultDigest: `sha256:${hash(JSON.stringify(result))}`,
		assessedAt: new Date().toISOString(),
	});
	let recorded = { ok: false, reason: "no episode to bind the outcome to" };
	const episodeId =
		events.find((event) => event.event_type === "episode.started" && event.episode_id)?.episode_id ?? null;
	if (episodeId) {
		const log = new EventLog(environment.AEGIS_EVENT_LOG);
		const opened = await log.open();
		if (opened?.ok === false) recorded = { ok: false, reason: opened.error ?? "event log open failed" };
		else {
			try {
				recorded = await appendContestOutcome(log, outcomeRow, { episodeId });
			} catch (appendError) {
				recorded = { ok: false, reason: String(appendError) };
			}
			await log.close();
		}
	}
	result.outcome = {
		recorded: recorded.ok === true,
		reason: recorded.ok === true ? null : (recorded.reason ?? null),
		outcome_id: recorded.ok === true ? (recorded.outcome?.outcome_id ?? null) : null,
		status: recorded.ok === true ? (recorded.outcome?.status ?? null) : null,
		episode_id: episodeId,
		session_id: sessionId,
	};
	try {
		const after = projectBoard(
			readFileSync(environment.AEGIS_EVENT_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
		);
		result.graph_counts_after_outcome = Object.fromEntries(Object.entries(after.byType).map(([k, v]) => [k, v.length]));
		result.fact_count_after_outcome = (after.currentByType?.Fact ?? []).length;
		result.refuted_count_after_outcome = (after.currentByType?.Refuted ?? []).length;
	} catch (boardError) {
		result.graph_counts_after_outcome = { error: String(boardError) };
	}
	writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
	console.log(
		JSON.stringify({
			attempt: attemptId,
			verified_success: verified,
			elapsed_ms: result.elapsed_ms,
			requests,
			tool_calls: toolCalls,
			stop: result.stop,
			error,
			outcome: result.outcome,
			facts: result.fact_count_after_outcome ?? null,
		}),
	);
	return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [taskDir, mode, attemptId, requests = "14", seconds = "240"] = process.argv.slice(2);
	if (!taskDir || !mode || !attemptId)
		throw new Error("Usage: ctf-board-pilot.mjs TASK_DIR A|B|C|D ATTEMPT_ID [MAX_REQUESTS] [SECONDS]");
	await runCtfPilot({
		taskDir,
		mode,
		attemptId,
		maxRequests: Number(requests),
		wallMs: Number(seconds) * 1000,
		provider: process.env.AEGIS_PILOT_PROVIDER || "maxapi",
		modelId: process.env.AEGIS_PILOT_MODEL || "deepseek-v4.1-flash",
		maxOutputTokens: Number(process.env.AEGIS_PILOT_MAX_OUTPUT || 8192),
	});
}
