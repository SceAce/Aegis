// Aegis C6-E — bounded run/measurement support.
//
// Reuses the SAME product entry (`runC6FromConfig`) for a single run or a bounded
// list of attempts. It fixes the config/version/seed/initial state per attempt,
// runs each attempt in its OWN work directory, and exports per-attempt
// measurements. It keeps EVERY attempt (including failures/unknown) and never
// invents a gain or a statistic. It is NOT a general benchmark platform.
//
// Initial state: an attempt's `initial_state` is NOT metadata. The runner only
// runs an attempt that declares an initial state when a TRUSTED task-family
// initializer (`applyInitialState`) is supplied; the initializer must actually
// apply the reset and report the APPLIED state. Without an initializer the
// runner refuses the attempt (ok:false) and does NOT execute it, so a shared old
// workspace can never be mistaken for a correctly initialized run. An initializer
// that throws is kept as THAT attempt's failure and never masks other attempts.
//
// A real efficacy experiment is a later, separately-authorized task: this module
// only provides the deterministic, auditable per-attempt plumbing.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const C6_RUNNER_VERSION = "3.0.0";

/**
 * Run a bounded attempt list. Each attempt gets its OWN materialized config with
 * its own `work_dir`, so the product entry actually runs (and commits) in the
 * attempt's directory rather than the base config's. Attempts are run
 * SEQUENTIALLY; a failure does not abort the list (its measurement is recorded
 * with ok:false). Duplicate attempt ids/paths are refused.
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
 *   applyInitialState?: ((attempt: any, initial: any) => ({ok?: boolean, applied?: any, reason?: string}|void))|null,
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
		applyInitialState = null,
	} = /** @type {any} */ ({}),
) {
	if (typeof runEntry !== "function") throw new Error("runBoundedAttempts requires runEntry");
	if (!Array.isArray(attempts) || attempts.length === 0)
		return { ok: false, reason: "no attempts were named", attempts: [] };
	mkdirSync(baseDir, { recursive: true });
	const baseConfig = JSON.parse(readFileSync(configPath, "utf8"));
	const seenIds = new Set();
	const seenDirs = new Set();
	const results = [];
	for (const [index, attempt] of attempts.entries()) {
		const id = attempt.id ?? `attempt-${index + 1}`;
		const attemptDir = attempt.work_dir ?? join(baseDir, id);
		// X6: refuse a duplicate attempt id or work_dir so two attempts cannot
		// silently share (and reuse) the same committed state.
		if (seenIds.has(id)) {
			results.push({ attempt_id: id, ok: false, error: `duplicate attempt id: ${id}` });
			continue;
		}
		if (seenDirs.has(attemptDir)) {
			results.push({ attempt_id: id, ok: false, error: `duplicate attempt work_dir: ${attemptDir}` });
			continue;
		}
		seenIds.add(id);
		seenDirs.add(attemptDir);

		// Apply the initial state BEFORE materializing/running the attempt. The
		// initializer is trusted Host code; without one, a declared initial state
		// cannot be applied and the attempt is refused (never silently accepted as
		// a run over whatever the shared workspace already contained).
		let appliedInitialState = null;
		let initError = null;
		const declaresInitialState = attempt.initial_state !== undefined && attempt.initial_state !== null;
		if (declaresInitialState) {
			if (typeof applyInitialState !== "function") {
				results.push({
					attempt_id: id,
					seed: attempt.seed ?? null,
					initial_state: attempt.initial_state,
					applied_initial_state: null,
					work_dir: attemptDir,
					config_path: null,
					event_log: null,
					ok: false,
					error: "no trusted initializer was supplied for the declared initial_state; refusing to run",
					reasons: ["initial_state_not_applicable"],
					task_states: null,
					ledger: null,
					usage_sources: null,
					backend_tokens: null,
					backend_currency: null,
				});
				continue;
			}
			try {
				const applied = applyInitialState(attempt, attempt.initial_state);
				if (applied && applied.ok === false) {
					initError = applied.reason ?? "the trusted initializer refused the initial state";
				} else {
					// Record the ACTUAL applied state the initializer observed, not the
					// requested declaration.
					appliedInitialState = applied && Object.hasOwn(applied, "applied") ? applied.applied : attempt.initial_state;
				}
			} catch (caught) {
				initError = caught instanceof Error ? caught.message : String(caught);
			}
			if (initError !== null) {
				results.push({
					attempt_id: id,
					seed: attempt.seed ?? null,
					initial_state: attempt.initial_state,
					applied_initial_state: null,
					work_dir: attemptDir,
					config_path: null,
					event_log: null,
					ok: false,
					error: `initial state was not applied: ${initError}`,
					reasons: ["initial_state_failed"],
					task_states: null,
					ledger: null,
					usage_sources: null,
					backend_tokens: null,
					backend_currency: null,
				});
				continue;
			}
		}

		mkdirSync(attemptDir, { recursive: true });
		// Materialize a per-attempt config so the product entry really runs in this
		// attempt's work_dir (and writes its own committed source there).
		const attemptConfigPath = join(attemptDir, "campaign.config.json");
		writeFileSync(
			attemptConfigPath,
			`${JSON.stringify({ ...baseConfig, work_dir: attemptDir, seed: attempt.seed ?? baseConfig.seed ?? null }, null, 2)}\n`,
			"utf8",
		);
		let outcome = null;
		let error = null;
		try {
			outcome = await runEntry({
				configPath: attemptConfigPath,
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
			applied_initial_state: appliedInitialState,
			initial_state_applied: declaresInitialState ? appliedInitialState !== null : null,
			work_dir: attemptDir,
			config_path: attemptConfigPath,
			event_log: join(attemptDir, "events.jsonl"),
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
