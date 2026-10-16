// Aegis C4 — read-only report/export entry.
//
// CLI:
//   node report-entry.mjs --manifest <manifest.json> --events <events.jsonl>
//     [--artifacts <artifacts.json>] [--out <dir>] [--runtime <runtime.json>]
//
// It reads the immutable Manifest and the committed EventLog, generates the four
// acceptance artifacts, validates the bundle, and writes them ONLY to `--out`.
// The source files are opened read-only and never written. No Worker/Broker/
// Oracle/session/model/network call is made.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "../campaign/manifest.mjs";
import { digest } from "../shared/contracts.mjs";
import { parseJsonl, verifyChain } from "../shared/events.mjs";
import { DEFAULT_LIMITS, generateCampaignArtifacts, validateAcceptanceBundle } from "./report-export.mjs";

export const REPORT_ENTRY_VERSION = "1.0.0";

function readSourceDigest(path) {
	return digest(readFileSync(path, "utf8"));
}

/**
 * Run the export. Returns `{ok, reasons, digests, outDir, integrity}`.
 *
 * @param {{manifestPath: string, eventsPath: string, artifactsPath?: string|null,
 *   runtimePath?: string|null, outDir: string, limits?: any}} args
 */
export async function runReportExport(
	{
		manifestPath,
		eventsPath,
		artifactsPath = null,
		runtimePath = null,
		outDir,
		limits = DEFAULT_LIMITS,
	} = /** @type {any} */ ({}),
) {
	const reasons = [];
	if (!manifestPath || !existsSync(manifestPath)) reasons.push(`manifest not found: ${String(manifestPath)}`);
	if (!eventsPath || !existsSync(eventsPath)) reasons.push(`events not found: ${String(eventsPath)}`);
	if (!outDir || typeof outDir !== "string") reasons.push("outDir is required");
	for (const path of [artifactsPath, runtimePath]) {
		if (path && !existsSync(path)) reasons.push(`optional source not found: ${path}`);
	}
	if (reasons.length > 0) return { ok: false, reasons };
	limits = { ...DEFAULT_LIMITS, ...limits };

	// Reject aliases before any output is opened: post-write digest checks are
	// too late when --out or an existing symlink/hardlink points at an input.
	const inputs = [manifestPath, eventsPath, artifactsPath, runtimePath].filter(Boolean);
	const destinations = [
		"campaign-report.json",
		"campaign-report.md",
		"acceptance-bundle.json",
		"reviewer-prompt.md",
	].map((name) => join(outDir, name));
	for (const destination of destinations) {
		if (inputs.some((input) => resolve(input) === resolve(destination)))
			reasons.push("output path aliases a source file");
		let outputStat;
		try {
			outputStat = lstatSync(destination);
		} catch {
			/* absent output */
		}
		if (outputStat?.isSymbolicLink()) reasons.push("output file must not be a symlink");
		if (
			outputStat &&
			inputs.some((input) => {
				const sourceStat = statSync(input);
				return (
					realpathSync(input) === realpathSync(destination) ||
					(sourceStat.dev === outputStat.dev && sourceStat.ino === outputStat.ino)
				);
			})
		)
			reasons.push("output file aliases source inode");
	}
	if (reasons.length) return { ok: false, reasons };

	// Record source digests BEFORE reading so we can prove the export did not
	// mutate them.
	const sourceDigestsBefore = {
		manifest: readSourceDigest(manifestPath),
		events: readSourceDigest(eventsPath),
	};

	const loaded = await loadManifest(manifestPath);
	if (!loaded.ok)
		return {
			ok: false,
			reasons: [`manifest invalid: ${loaded.reasons.join("; ")}`],
			integrity: { event_chain_ok: null },
		};

	const raw = readFileSync(eventsPath, "utf8");
	const { rows, errors } = parseJsonl(raw);
	if (errors.length > 0) {
		return {
			ok: false,
			reasons: [`event log has unparseable lines: ${errors.slice(0, 3).join("; ")}`],
			integrity: { event_chain_ok: false },
		};
	}
	const chain = verifyChain(rows);
	if (!chain.ok)
		return { ok: false, reasons: chain.errors, integrity: { event_chain_ok: false }, verdict_hint: "inconclusive" };
	let artifacts = {};
	if (artifactsPath) {
		if (!existsSync(artifactsPath)) return { ok: false, reasons: [`artifacts index not found: ${artifactsPath}`] };
		try {
			artifacts = JSON.parse(readFileSync(artifactsPath, "utf8"));
		} catch (error) {
			return { ok: false, reasons: [`artifacts index is not valid JSON: ${String(error)}`] };
		}
	}
	let runtimeDigests = {};
	if (runtimePath) {
		if (!existsSync(runtimePath)) return { ok: false, reasons: [`runtime digests not found: ${runtimePath}`] };
		try {
			runtimeDigests = JSON.parse(readFileSync(runtimePath, "utf8"));
		} catch (error) {
			return { ok: false, reasons: [`runtime digests are not valid JSON: ${String(error)}`] };
		}
	}

	for (const [label, value] of [
		["artifacts", artifacts],
		["runtime", runtimeDigests],
	]) {
		if (!value || typeof value !== "object" || Array.isArray(value))
			return { ok: false, reasons: [`${label} input must be an object`] };
	}
	const generated = generateCampaignArtifacts({
		manifest: loaded.manifest,
		events: rows,
		artifacts,
		runtimeDigests,
		limits,
		generatedAt: new Date().toISOString(),
	});
	// Use the same redacted, digest-covered report and Markdown as the pure API.
	generated.markdown += renderReviewerPromptNote(generated);

	const validation = validateAcceptanceBundle(generated.bundle, { report: generated.report, limits });
	if (!validation.ok) {
		const integrityFailed = !chain.ok;
		return {
			ok: false,
			reasons: validation.reasons,
			integrity: generated.report.integrity,
			verdict_hint: integrityFailed ? "inconclusive" : "needs_more_evidence",
		};
	}

	if (
		Buffer.byteLength(`${JSON.stringify(generated.report, null, 2)}\n`, "utf8") > limits.max_report_bytes ||
		Buffer.byteLength(generated.markdown, "utf8") > limits.max_report_bytes
	) {
		return { ok: false, reasons: [`report size exceeds max_report_bytes ${limits.max_report_bytes}`] };
	}

	// Write ONLY to outDir.
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "campaign-report.json"), `${JSON.stringify(generated.report, null, 2)}\n`, "utf8");
	writeFileSync(join(outDir, "campaign-report.md"), generated.markdown, "utf8");
	writeFileSync(join(outDir, "acceptance-bundle.json"), `${JSON.stringify(generated.bundle, null, 2)}\n`, "utf8");
	writeFileSync(join(outDir, "reviewer-prompt.md"), generated.reviewerPrompt, "utf8");

	// Prove the source was not mutated.
	const sourceDigestsAfter = {
		manifest: readSourceDigest(manifestPath),
		events: readSourceDigest(eventsPath),
	};
	const sourceUnchanged =
		sourceDigestsBefore.manifest === sourceDigestsAfter.manifest &&
		sourceDigestsBefore.events === sourceDigestsAfter.events;

	return {
		ok: sourceUnchanged,
		reasons: sourceUnchanged ? [] : ["source files changed during export (read-only violation)"],
		outDir,
		digests: generated.digests,
		source_digests: { before: sourceDigestsBefore, after: sourceDigestsAfter },
		integrity: generated.report.integrity,
		limits,
		byte_sizes: artifactByteSizes(outDir),
	};
}

/** A short deterministic note appended to the markdown (no digests duplicated). */
function renderReviewerPromptNote(generated) {
	return [
		"### Reviewer hand-off",
		"",
		"A bounded acceptance bundle and reviewer prompt were generated next to this",
		"report. Aegis does NOT invoke any reviewer automatically.",
		"",
		`- report_digest: \`${generated.report.report_digest}\``,
		`- bundle_digest: \`${generated.bundle.bundle_digest}\``,
		"",
	].join("\n");
}

function artifactByteSizes(outDir) {
	const sizes = {};
	for (const name of ["campaign-report.json", "campaign-report.md", "acceptance-bundle.json", "reviewer-prompt.md"]) {
		const path = join(outDir, name);
		sizes[name] = existsSync(path) ? statSync(path).size : null;
	}
	return sizes;
}

/** CLI parser. Unknown flags are rejected. */
export function parseArgs(argv) {
	const args = { manifestPath: null, eventsPath: null, artifactsPath: null, runtimePath: null, outDir: null };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const next = argv[i + 1];
		switch (flag) {
			case "--manifest":
				args.manifestPath = next;
				i += 1;
				break;
			case "--events":
				args.eventsPath = next;
				i += 1;
				break;
			case "--artifacts":
				args.artifactsPath = next;
				i += 1;
				break;
			case "--runtime":
				args.runtimePath = next;
				i += 1;
				break;
			case "--out":
				args.outDir = next;
				i += 1;
				break;
			default:
				return { ok: false, reason: `unknown argument: ${flag}` };
		}
	}
	if (!args.manifestPath) return { ok: false, reason: "--manifest is required" };
	if (!args.eventsPath) return { ok: false, reason: "--events is required" };
	if (!args.outDir) return { ok: false, reason: "--out is required" };
	return { ok: true, args };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	const parsed = parseArgs(process.argv.slice(2));
	if (!parsed.ok) {
		process.stderr.write(`report-entry: ${parsed.reason}\n`);
		process.exit(2);
	}
	const outcome = await runReportExport(parsed.args);
	process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
	process.exit(outcome.ok ? 0 : 1);
}
