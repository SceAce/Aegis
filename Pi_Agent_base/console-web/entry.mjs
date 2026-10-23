#!/usr/bin/env node
// Aegis Web Console — process entry.
//
//   ./run-experiment-web.sh --port 7800
//
// Local single-user tool: binds loopback, serves the Pocket-derived web app and
// a thin HTTP/SSE adapter in front of the EXISTING Experiment Host. Each active
// experiment runs in its own Host child process (see server.mjs).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { startWebConsole, WEB_SERVER_VERSION } from "./server.mjs";

function parse(argv) {
	const args = {
		home: process.env.AEGIS_HOME ?? join(homedir(), ".Aegis"),
		port: Number(process.env.AEGIS_WEBUI_PORT ?? 7800),
		hostname: process.env.AEGIS_WEBUI_HOST ?? "127.0.0.1",
		workspaceRoots: [],
		agentDir: process.env.AEGIS_PI_AGENT_DIR ?? null,
		quiet: false,
		open: null, // null = decide (TTY and not disabled), true = force, false = never
		noOpen: process.env.AEGIS_WEBUI_NO_OPEN === "1",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const take = () => argv[++index] ?? "";
		switch (arg) {
			case "--home":
				args.home = take();
				break;
			case "--port":
				args.port = Number(take());
				break;
			case "--host":
				args.hostname = take();
				break;
			case "--workspace-root":
				args.workspaceRoots.push(take());
				break;
			case "--agent-dir":
				args.agentDir = take();
				break;
			case "--quiet":
				args.quiet = true;
				break;
			case "--open":
				args.open = true;
				break;
			case "--no-open":
				args.noOpen = true;
				args.open = false;
				break;
			case "-h":
			case "--help":
				args.help = true;
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	return args;
}

/**
 * Open a URL in the operator's default browser.
 *
 * Never fatal: a missing opener (headless box, remote shell) only prints a hint.
 * `AEGIS_WEBUI_OPEN_CMD` overrides the command (tests and custom launchers);
 * `--no-open` / `AEGIS_WEBUI_NO_OPEN=1` skip it entirely.
 */
function openInBrowser(url) {
	const override = process.env.AEGIS_WEBUI_OPEN_CMD;
	const [command, args] =
		override !== undefined && override !== ""
			? [override, [url]]
			: process.platform === "darwin"
				? ["open", [url]]
				: process.platform === "win32"
					? ["cmd", ["/c", "start", "", url]]
					: ["xdg-open", [url]];
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.on("error", () => {
			process.stderr.write(`aegis-web: could not open a browser (${command}); open the URL above instead\n`);
		});
		child.unref();
		return command;
	} catch (error) {
		process.stderr.write(`aegis-web: could not open a browser (${String(error)}); open the URL above instead\n`);
		return null;
	}
}

async function main(argv) {
	const args = parse(argv);
	if (args.help) {
		process.stdout.write(
			[
				"Aegis Web Console",
				"",
				"Usage: ./run-experiment-web.sh [--home DIR] [--port N] [--host 127.0.0.1]",
				"                              [--agent-dir DIR] [--workspace-root DIR]...",
				"                              [--open|--no-open] [--quiet]",
				"",
				"Serves a local-only web UI in front of the existing Experiment Host.",
				"Each active experiment gets its OWN Host child process (the only writer).",
				"",
				"Requirements: the embedded Pi checkout, and Pi_Agent_base/UI/Aegis-pocket",
				"with its vendored browser modules installed from its lockfile:",
				"  ./install.sh --install-web-deps",
				"The command-line entries (run-experiment.sh, --cli) do not need the UI.",
				"",
				"Behaviour:",
				"  the ready block prints the URL; the default browser is opened",
				"  automatically when this is an interactive terminal (--open forces it,",
				"  --no-open or AEGIS_WEBUI_NO_OPEN=1 disables it).",
				"  Ctrl-C stops the server AND its Host child processes (running tasks are",
				"  shut down; an effect with an unknown result keeps its responsibility).",
				"  Closing a browser tab does not stop any task.",
				"",
				"Environment:",
				"  AEGIS_HOME                  state root (experiments, knowledge, agent)",
				"  AEGIS_WEBUI_PORT            default 7800",
				"  AEGIS_WEBUI_HOST            default 127.0.0.1 (never expose publicly)",
				"  AEGIS_WEBUI_WORKSPACE_ROOTS extra ':'-separated roots a new task may use",
				"  AEGIS_PI_AGENT_DIR          Pi agent config/auth used by Host children",
				"",
			].join("\n"),
		);
		return 0;
	}
	if (!isAbsolute(args.home)) args.home = resolve(args.home);
	if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535)
		throw new Error("--port must be an integer between 0 and 65535");
	if (args.hostname !== "127.0.0.1" && args.hostname !== "localhost" && args.hostname !== "::1")
		throw new Error("the Aegis Web Console only binds loopback (127.0.0.1/localhost/::1)");
	const extraRoots = (process.env.AEGIS_WEBUI_WORKSPACE_ROOTS ?? "")
		.split(":")
		.map((value) => value.trim())
		.filter(Boolean);
	if (!existsSync(args.home)) {
		process.stderr.write(`aegis-web: AEGIS_HOME does not exist: ${args.home}\n`);
		return 2;
	}
	const consoleServer = await startWebConsole({
		home: args.home,
		port: args.port,
		hostname: args.hostname,
		workspaceRoots: [...args.workspaceRoots, ...extraRoots],
		agentDir: undefined,
		defaultAgentDir: args.agentDir,
		log: args.quiet ? () => {} : (line) => process.stderr.write(`${line}\n`),
	});
	const interactive = process.stdout.isTTY === true;
	const shouldOpen = args.open === true || (args.open === null && !args.noOpen && interactive);
	const openedWith = shouldOpen ? openInBrowser(consoleServer.origin) : null;
	const browserNote = openedWith
		? `opened with ${openedWith}`
		: shouldOpen
			? "could not be opened; use the URL above"
			: args.noOpen
				? "not opened (--no-open)"
				: "not opened (no interactive terminal; use --open to force)";
	process.stdout.write(`Aegis Web Console ${WEB_SERVER_VERSION}\n`);
	process.stdout.write(`  url       ${consoleServer.origin}\n`);
	process.stdout.write(`  home      ${consoleServer.home}\n`);
	process.stdout.write(`  browser   ${browserNote}\n`);
	process.stdout.write(
		[
			"",
			"  Each active task runs in its own Experiment Host process (the only writer).",
			"  Closing a browser tab does NOT stop a task; use Stop Host in the UI.",
			"  Ctrl-C here stops the server AND its Host processes (unknown results keep",
			"  their responsibility).",
			"",
		].join("\n"),
	);
	const stop = async () => {
		await consoleServer.close();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	return new Promise(() => {});
}

main(process.argv.slice(2)).then(
	(code) => {
		if (typeof code === "number") process.exit(code);
	},
	(error) => {
		process.stderr.write(`aegis-web: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	},
);
