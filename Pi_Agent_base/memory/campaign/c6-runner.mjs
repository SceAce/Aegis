// Aegis C6-E — bounded run/measurement support.
//
// Reuses the SAME product entry (`runC6FromConfig`) for a single run or a bounded
// list of attempts. It fixes the config/version/seed/initial state per attempt,
// runs each attempt in its OWN work directory, and exports per-attempt
// measurements. It keeps EVERY attempt (including failures/unknown) and never
// invents a gain or a statistic. It is NOT a general benchmark platform.
//
// A real efficacy experiment is a later, separately-authorized task: this module
// only provides the deterministic, auditable per-attempt plumbing.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const C6_RUNNER_VERSION = "1.0.0";

/**
 * Run a bounded attempt list. Each attempt names its own work_dir and optional
 * seed/initial-state override. Attempts are run SEQUENTIALLY; a failure does not
 * abort the list (its measurement is recorded with ok:false).
 *
 * @param {{
 *   runEntry: (args: any) => Promise<any>,
 *   configPath: string,
 *   attempts: Array<{id?: string, work_dir?: string, seed?: any, initial_state?: any, scenario?: string, observe?: boolean, export?: boolean}>,
 *   baseDir: string,
 *   sdk?: any,
 *   createSeam?: Function|null,
 *   fauxProviderFactory?: Function|null,
 *   print?: (text: string) => void,
 * }} args
 */
export async function runBoundedAttempts(
	{
		runEntry,
		configPath,
		attempts = [],
		baseDir,
		sdk = null,
		createSeam = null,
		fauxProviderFactory = null,
		print = null,
	} = /** @type {any} */ ({}),
) {
	if (typeof runEntry !== "function") throw new Error("runBoundedAttempts requires runEntry");
	if (!Array.isArray(attempts) || attempts.length === 0)
		return { ok: false, reason: "no attempts were named", attempts: [] };
	mkdirSync(baseDir, { recursive: true });
	const results = [];
	for (const [index, attempt] of attempts.entries()) {
		const id = attempt.id ?? `attempt-${index + 1}`;
		const attemptDir = attempt.work_dir ?? join(baseDir, id);
		mkdirSync(attemptDir, { recursive: true });
		let outcome = null;
		let error = null;
		try {
			outcome = await runEntry({
				configPath,
				scenario: attempt.scenario ?? "run",
				observe: attempt.observe === true,
				export: attempt.export === true,
				sdk,
				createSeam,
				fauxProviderFactory,
				print,
			});
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
		results.push({
			attempt_id: id,
			seed: attempt.seed ?? null,
			initial_state: attempt.initial_state ?? null,
			work_dir: attemptDir,
			ok: outcome?.ok === true && error === null,
			error,
			reasons: outcome?.reasons ?? [],
			task_states: outcome?.task_states ?? null,
			ledger: outcome?.ledger?.consumed ?? null,
			usage_sources: outcome?.ledger?.usage_sources ?? null,
			// Unobservable backend usage stays unknown/null, never 0.
			backend_tokens: null,
			backend_currency: null,
		});
	}
	const manifest = {
		schema_version: "1.0",
		runner_version: C6_RUNNER_VERSION,
		attempts: results,
		completed: results.filter((r) => r.ok).length,
		failed: results.filter((r) => !r.ok).length,
		unknown: results.filter((r) => r.task_states && Object.values(r.task_states).some((s) => s === "unknown")).length,
	};
	writeFileSync(join(baseDir, "runner-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return { ok: true, base_dir: baseDir, manifest, attempts: results };
}

/** Read a runner manifest (for a report/exporter). */
export function readRunnerManifest(baseDir) {
	try {
		return JSON.parse(readFileSync(join(baseDir, "runner-manifest.json"), "utf8"));
	} catch {
		return null;
	}
}
