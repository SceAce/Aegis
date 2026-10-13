// Aegis C5 — single Campaign integration entry.
//
// One command runs the whole offline loop from a trusted config file:
//
//   config -> validated Manifest -> one Host + EventLog owner
//     -> static/dynamic Task -> Broker -> local effect -> Oracle/delayed
//     -> safe Session rotation (C2) + Host-owned ledger
//     -> pause/cancel/restart
//     -> optional read-only report export (C4) + optional loopback observation (C4a)
//
// It reuses C1 scheduler, C2 supervisor, C3 assembly, C4 export and C4a server.
// It creates NO second scheduler/plugin framework. It never contacts a real
// model/network/target and never auto-invokes an acceptance reviewer.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { committedRotations, createSessionSupervisor } from "../runtime/session-supervisor.mjs";
import { artifactIndexFromEvents, assembleCampaignHost } from "./c3-entry.mjs";
import { loadCampaignConfig } from "./campaign-config.mjs";
import { createObservationServer } from "./observation-server.mjs";
import { projectQueueFromEvents } from "./projection.mjs";
import { runReportExport } from "./report-entry.mjs";

export const C5_ENTRY_VERSION = "1.0.0";

const SUBCOMMANDS = ["run", "status", "pause", "resume", "cancel", "export", "observe"];

/**
 * Build a C2 session controller adapter over the accepted supervisor. The Host
 * calls this; it charges exactly one Session generation per committed rotation.
 *
 * @param {{config: any, runtime: any}} args
 */
export function createHostSessionController({ config, runtime }) {
	const budgetLedger = config.session.budget_ledger;
	const taskId = config.label ?? "campaign-task";
	// The supervisor's taskId is only used to resolve an open episode when no
	// handoff is staged; the Campaign Task/Episode binding is owned by the Host.
	const makeSupervisor = () =>
		createSessionSupervisor({
			eventLogPath: join(config.work_dir, "events.jsonl"),
			handoffPath: config.session.handoff_path,
			runtime,
			taskId,
			budget: budgetLedger,
		});
	return {
		committedRotations: () => {
			const events = readEventsSafe(join(config.work_dir, "events.jsonl"));
			return committedRotations(events, config.session.episode_id ?? null) || committedRotations(events, taskId);
		},
		canRotate: () => makeSupervisor().canRotate(),
		rotate: (options) => makeSupervisor().rotate(options),
		recoverInterrupted: () => makeSupervisor().recoverInterrupted(),
	};
}

function readEventsSafe(path) {
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Run a full Campaign from a trusted config.
 *
 * @param {{configPath: string, scenario?: string, observe?: boolean, export?: boolean,
 *   outDir?: string|null, runtime?: any, print?: (text: string) => void}} args
 */
export async function runCampaignFromConfig(
	{
		configPath,
		scenario = "run",
		observe = false,
		export: doExport = false,
		outDir = null,
		runtime = null,
		print = null,
	} = /** @type {any} */ ({}),
) {
	const out = typeof print === "function" ? print : (text) => process.stdout.write(`${text}\n`);
	const loaded = loadCampaignConfig({ configPath });
	if (!loaded.ok) return { ok: false, reasons: loaded.reasons, stage: "config" };
	const { config, manifest } = loaded;
	mkdirSync(config.work_dir, { recursive: true });
	config.session.handoff_path = config.session.handoff_path ?? join(config.work_dir, "runtime", "handoff.json");
	mkdirSync(dirname(config.session.handoff_path), { recursive: true });

	// Trusted script registration: only from the config's explicit path.
	let scriptRegistrationConfig = null;
	if (config.script_config_path) {
		try {
			if (config.script_config_path.endsWith(".json")) {
				scriptRegistrationConfig = JSON.parse(readFileSync(config.script_config_path, "utf8"));
			} else {
				const mod = await import(config.script_config_path);
				scriptRegistrationConfig = mod.scripts ? { scripts: mod.scripts } : (mod.default ?? { scripts: [] });
			}
		} catch (error) {
			return { ok: false, reasons: [`script_config_path unreadable: ${String(error)}`], stage: "config" };
		}
	}

	// ONE Host + ONE EventLog owner.
	const sessionController = runtime ? createHostSessionController({ config, runtime }) : null;
	const assembled = await assembleCampaignHost({
		manifest,
		workspaceRoot: config.workspace_root,
		workDir: config.work_dir,
		eventLogPath: join(config.work_dir, "events.jsonl"),
		mode: config.mode,
		scriptRegistrationConfig,
		sessionController,
	});
	const { host, sink, gate } = assembled;

	// Optional observation server (read-only; failure never blocks execution).
	let server = null;
	const baseUrl = null;
	void baseUrl;
	if (observe || config.observation.enabled) {
		server = createObservationServer({
			manifestPath: config.manifest_path,
			eventsPath: join(config.work_dir, "events.jsonl"),
			host: config.observation.host,
			port: config.observation.port,
		});
		await server.listen();
		out(`observation board: ${server.url}`);
	}

	let controlResult = null;
	let runResult = null;
	try {
		if (scenario === "pause") {
			controlResult = await host.pause("cli_pause");
			if (controlResult.ok) runResult = await host.run();
		} else if (scenario === "resume") {
			controlResult = await host.resume("cli_resume");
			if (controlResult.ok) runResult = await host.run();
		} else if (scenario === "cancel") {
			controlResult = await host.cancel("cli_cancel");
			if (controlResult.ok) runResult = await host.run();
		} else if (scenario === "status") {
			// Read-only: project the committed stream WITHOUT dispatching.
			const events = readEventsSafe(join(config.work_dir, "events.jsonl"));
			const projection = projectQueueFromEvents({
				campaign_id: manifest.campaign_id,
				tasks: manifest.tasks ?? [],
				events,
				revision: manifest.revision ?? 0,
				manifest,
				artifacts: Object.fromEntries(artifactIndexFromEvents(events)),
			});
			runResult = { ok: projection.ok, status: { projection, campaign_state: projection.control?.state ?? "unknown" } };
		} else {
			// run / observe / export all run the loop once then report.
			runResult = await host.run();
		}
	} finally {
		// Release the single writer before any optional export/observation read.
		host.releaseOwnership();
	}

	// Optional read-only export at the stop/complete boundary.
	let exportResult = null;
	if (doExport || scenario === "export") {
		const target = outDir ?? join(config.work_dir, "report");
		exportResult = await runReportExport({
			manifestPath: config.manifest_path,
			eventsPath: join(config.work_dir, "events.jsonl"),
			outDir: target,
		});
		out(`report exported: ${target} (ok=${exportResult.ok})`);
	}

	const status = runResult?.status ?? host.status();
	const summary = status.projection;
	const taskStates = Object.fromEntries((summary?.tasks ?? []).map((t) => [t.task_id, t.state]));
	const observationUrl = server ? server.url : null;
	out(
		`campaign ${manifest.campaign_id}: ${status.campaign_state} | tasks ${JSON.stringify(taskStates)} | budget ${JSON.stringify(
			status.budget?.consumed ?? null,
		)}`,
	);

	if (server) await server.close();
	if (sink.close) await sink.close();

	return {
		ok: (runResult?.ok ?? true) && (controlResult?.ok ?? true) && (exportResult?.ok ?? true),
		reasons: runResult?.reasons ?? [],
		campaign_id: manifest.campaign_id,
		observation_url: observationUrl,
		task_states: taskStates,
		gate,
		export_dir: exportResult?.outDir ?? null,
		config,
	};
}

/** CLI parser. Unknown flags are rejected. */
export function parseArgs(argv) {
	const args = { configPath: null, subcommand: null, observe: false, export: false, outDir: null, port: null };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === "--config") {
			args.configPath = argv[i + 1];
			i += 1;
		} else if (token === "--observe") {
			args.observe = true;
		} else if (token === "--export") {
			args.export = true;
		} else if (token === "--out") {
			args.outDir = argv[i + 1];
			i += 1;
		} else if (token === "--port") {
			args.port = Number.parseInt(argv[i + 1] ?? "", 10);
			i += 1;
		} else if (!token.startsWith("--") && !args.subcommand) {
			args.subcommand = token;
		} else {
			return { ok: false, reason: `unknown argument: ${token}` };
		}
	}
	if (!args.configPath) return { ok: false, reason: "--config is required" };
	const sub = args.subcommand ?? "run";
	if (!SUBCOMMANDS.includes(sub)) return { ok: false, reason: `subcommand must be one of ${SUBCOMMANDS.join(", ")}` };
	args.subcommand = sub;
	return { ok: true, args };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	const parsed = parseArgs(process.argv.slice(2));
	if (!parsed.ok) {
		process.stderr.write(`c5-entry: ${parsed.reason}\n`);
		process.exit(2);
	}
	const outcome = await runCampaignFromConfig({
		configPath: parsed.args.configPath,
		scenario: parsed.args.subcommand,
		observe: parsed.args.observe,
		export: parsed.args.export,
		outDir: parsed.args.outDir,
	});
	if (!outcome.ok) {
		for (const reason of outcome.reasons ?? []) process.stderr.write(`c5-entry: ${reason}\n`);
	}
	process.exit(outcome.ok ? 0 : 1);
}
