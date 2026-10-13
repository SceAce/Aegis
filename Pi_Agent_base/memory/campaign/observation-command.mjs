// Aegis C4a — Pi view commands over the same committed projection.
//
// `/aegis tasks`, `/aegis dashboard` and `/aegis url` print a bounded summary
// and the loopback URL. They read the SAME observation view as the HTTP page and
// the C4 report. They never mutate state and never auto-open a browser; when no
// UI is available the URL is still printed.
//
// The paths come from the launcher environment (never the model):
//   AEGIS_CAMPAIGN_MANIFEST  absolute path to the validated Campaign Manifest
//   AEGIS_EVENT_LOG          committed EventLog path
//   AEGIS_OBSERVATION_URL    an already-running observation URL (optional)

import { existsSync, readFileSync } from "node:fs";
import { parseJsonl, verifyChain } from "../runtime/events.mjs";
import { loadManifest } from "./manifest.mjs";
import { unavailableView } from "./observation-server.mjs";
import { buildObservationView, summarizeObservationView } from "./observation-view.mjs";

export const OBSERVATION_COMMAND_VERSION = "1.0.0";

/**
 * Resolve the observation configuration from the environment. A path is used
 * verbatim; it is never derived from model text or a query parameter.
 */
export function observationConfigFromEnv(env = process.env) {
	return {
		manifestPath: env.AEGIS_CAMPAIGN_MANIFEST || null,
		eventsPath: env.AEGIS_EVENT_LOG || null,
		observationUrl: env.AEGIS_OBSERVATION_URL || null,
	};
}

/**
 * Run one Pi view subcommand. Returns `{ok, text, url}`. `text` is always a
 * readable string (with the URL) so a no-TUI environment still gets output.
 *
 * @param {{subcommand: string, manifestPath?: string|null, eventsPath?: string|null,
 *   observationUrl?: string|null, limits?: any}} args
 */
export async function runObservationCommand(
	{ subcommand, manifestPath = null, eventsPath = null, observationUrl = null, limits } = /** @type {any} */ ({}),
) {
	const url = observationUrl ?? null;
	if (subcommand === "url" || subcommand === "dashboard") {
		if (!manifestPath || !eventsPath) {
			return {
				ok: true,
				url,
				text: url
					? `Aegis observation URL: ${url}`
					: "Aegis observation: no Campaign configured (set AEGIS_CAMPAIGN_MANIFEST and AEGIS_EVENT_LOG)",
			};
		}
	}
	if (!manifestPath || !existsSync(manifestPath)) {
		return { ok: false, url, text: "Aegis observation: Campaign Manifest is not configured or not found" };
	}
	if (!eventsPath || !existsSync(eventsPath)) {
		return { ok: false, url, text: "Aegis observation: committed EventLog is not configured or not found" };
	}
	const loaded = await loadManifest(manifestPath);
	if (!loaded.ok) return { ok: false, url, text: `Aegis observation: manifest invalid: ${loaded.reasons.join("; ")}` };
	const { rows, errors } = parseJsonl(readFileSync(eventsPath, "utf8"));
	const chainOk = errors.length === 0 && verifyChain(rows).ok;
	if (!chainOk) {
		const view = unavailableView("event chain integrity failed");
		view.integrity.status = "integrity_failure";
		return { ok: false, url, text: summarizeObservationView(view), view };
	}
	const view = buildObservationView({
		manifest: loaded.manifest,
		events: rows,
		limits,
		generatedAt: new Date().toISOString(),
	});
	if (!chainOk) {
		view.integrity = { ...view.integrity, event_chain_ok: false, stale: true, status: "integrity_failure" };
	}
	const summary = summarizeObservationView(view);
	const lines = [`Aegis ${subcommand}:`, summary];
	if (url) lines.push(`board: ${url}`);
	else lines.push("board: start the observation server to view this in a browser");
	return { ok: chainOk, url, text: lines.join("\n"), view };
}
