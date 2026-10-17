// Read-only pilot analysis. No model statement or process exit becomes success.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const read = (path, fallback) => {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
};
const sum = (rows, field) => rows.reduce((n, row) => n + (Number(row[field]) || 0), 0);
const hash = (s) => createHash("sha256").update(s).digest("hex");
export function reportCtfPilot(root) {
	const attempts = [];
	for (const task of readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory())) {
		const runRoot = join(root, task.name, "runs");
		if (!existsSync(runRoot)) continue;
		for (const entry of readdirSync(runRoot, { withFileTypes: true }).filter((x) => x.isDirectory())) {
			const dir = join(runRoot, entry.name);
			const persistedResult = read(join(dir, "result.json"), null);
			const experiment = read(join(dir, "experiment.json"), {});
			const result = persistedResult ?? { ...experiment, task: task.name, attempt_id: entry.name, requests: null };
			const assistants = read(join(dir, "assistant.json"), []);
			const requests = read(join(dir, "requests.json"), []);
			const operations = read(join(dir, "operations.json"), []);
			const events = existsSync(join(dir, "events.jsonl"))
				? readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse)
				: [];
			const codes = operations.map((op) => hash(op.code));
			const seen = new Set();
			const duplicateCode = codes.reduce((n, code) => {
				const duplicate = seen.has(code);
				seen.add(code);
				return n + Number(duplicate);
			}, 0);
			const actualUsage = assistants
				.filter((m) => m.stopReason !== "error" && m.stopReason !== "aborted")
				.map((m) => m.usage)
				.filter(Boolean);
			const last = assistants.at(-1);
			const harnessBudget =
				result.stop === "budget" || /pilot_budget_exhausted/.test(result.error ?? last?.errorMessage ?? "");
			const outcome = !persistedResult
				? "debug_incomplete"
				: result.verified_success
					? "success"
					: harnessBudget
						? "request_limit"
						: last?.stopReason === "error"
							? "provider_error"
							: last?.stopReason === "length"
								? "output_limit"
								: result.stop === "wall_time"
									? "time_limit"
									: result.stop === "budget"
										? "request_limit"
										: result.error
											? "harness_error"
											: "unsolved";
			const turns = assistants.map((m) => ({
				stop_reason: m.stopReason,
				error: m.errorMessage ?? null,
				tool_names: (m.content ?? []).filter((p) => p.type === "toolCall").map((p) => p.name),
			}));
			attempts.push({
				task: result.task,
				mode: result.mode,
				attempt_id: result.attempt_id,
				verified_success: result.verified_success === true,
				has_result: persistedResult !== null,
				provider_error: outcome === "provider_error",
				outcome,
				provider_error_code: last?.stopReason === "error" && /11140/.test(last.errorMessage ?? "") ? "11140" : null,
				verified_at_ms: result.verified_at_ms,
				elapsed_ms: result.elapsed_ms,
				requests: result.requests,
				tool_calls: result.tool_calls,
				cli_calls: result.cli_calls,
				proposals: result.proposal_count,
				knowledge_queries: result.knowledge_queries,
				knowledge_visible_requests: result.knowledge_visible_requests,
				board_visible_requests: requests.filter((r) =>
					["facts", "refuted", "tools", "proposals", "artifacts", "decisions"].some(
						(s) => r.ram.sections[s]?.shown > 0,
					),
				).length,
				board_proposals_visible_requests: requests.filter((r) => r.ram.sections.proposals?.shown > 0).length,
				cli_transport_errors: operations.filter((op) => op.exit_code !== 0).length,
				cli_timeouts: operations.filter((op) => op.timed_out).length,
				exact_repeated_cli_code: duplicateCode,
				usage: {
					input: actualUsage.length ? sum(actualUsage, "input") : null,
					output: actualUsage.length ? sum(actualUsage, "output") : null,
					cacheRead: actualUsage.length ? sum(actualUsage, "cacheRead") : null,
					cacheWrite: actualUsage.length ? sum(actualUsage, "cacheWrite") : null,
					totalTokens: actualUsage.length ? sum(actualUsage, "totalTokens") : null,
					source: actualUsage.length ? "provider_reported" : "unknown",
				},
				input_chars_peak: Math.max(0, ...requests.map((r) => r.input_chars)),
				input_chars_total: sum(requests, "input_chars"),
				stop: result.stop,
				last_model_stop: last?.stopReason ?? null,
				error: result.error,
				chain_ok: result.chain_ok,
				turns,
				recorded_policy: events
					.filter((e) => e.event_type === "request.projected")
					.map((e) => e.payload.context_policy),
				output_dir: dir,
			});
		}
	}
	const report = {
		generated_at: new Date().toISOString(),
		attempts,
		totals: {
			attempts: attempts.length,
			attempts_with_result: attempts.filter((a) => a.has_result).length,
			incomplete_attempts: attempts.filter((a) => !a.has_result).length,
			budget_stops: attempts.filter((a) => a.outcome === "request_limit").length,
			verified_success: attempts.filter((a) => a.verified_success).length,
			provider_errors: attempts.filter((a) => a.outcome === "provider_error").length,
			effect_comparison_valid: false,
			effect_comparison_reason: attempts.length ? "paired_conditions_not_verified" : "no_attempts",
			requests: sum(attempts, "requests"),
			tool_calls: sum(attempts, "tool_calls"),
			elapsed_ms_sum: sum(attempts, "elapsed_ms"),
		},
		limitations: [
			"Original public CTF tasks may be in model training data; no claim of unseen-task generalization.",
			"Small pilot, not a statistical efficacy study. Group prompts state feature availability; tool schemas otherwise match.",
			"single long session; this tests board/RAM feedback, not the additional effect of session rotation.",
			"No independent latency control; endpoint variability and output truncation can dominate solving time.",
			"Exact repeated code is a diagnostic, not a proven count of useless repeated exploration.",
			"Task answers are checked independently; model claimed success and transport success are not task verdicts.",
		],
	};
	writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
	const lines = [
		"# Aegis board / seed CTF pilot",
		"",
		"Each result is an independent original-task attempt; success uses a private exact answer check.",
		"",
		"| Task | Attempt | Mode | Outcome | Seconds | Requests | CLI | Proposals | Seed-visible requests | Model stop |",
		"|---|---|---|---|---:|---:|---:|---:|---:|---|",
	];
	for (const a of attempts)
		lines.push(
			`| ${a.task} | ${a.attempt_id} | ${a.mode} | ${a.outcome} | ${(a.elapsed_ms / 1000).toFixed(1)} | ${a.requests} | ${a.cli_calls} | ${a.proposals} | ${a.knowledge_visible_requests} | ${a.last_model_stop} |`,
		);
	lines.push(
		"",
		"Limitations:",
		"",
		...report.limitations.map((x) => `- ${x}`),
		"",
		"No failed/timeout attempt is discarded. Compare success first; faster failure is not solving-time improvement.",
	);
	writeFileSync(join(root, "REPORT.md"), `${lines.join("\n")}\n`);
	return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const r = reportCtfPilot(resolve(process.argv[2]));
	console.log(
		JSON.stringify(
			{
				totals: r.totals,
				attempts: r.attempts.map((a) => ({
					task: a.task,
					mode: a.mode,
					success: a.verified_success,
					seconds: Math.round(a.elapsed_ms / 1000),
					requests: a.requests,
					proposals: a.proposals,
					seed_visible: a.knowledge_visible_requests,
					stop: a.last_model_stop,
				})),
			},
			null,
			2,
		),
	);
}
