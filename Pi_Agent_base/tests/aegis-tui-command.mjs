import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import aegisObserver from "../extensions/aegis-observer.ts";

const TOKEN_INDEX = {
	accent: 111,
	border: 240,
	borderAccent: 177,
	borderMuted: 238,
	success: 114,
	error: 203,
	warning: 215,
	muted: 245,
	dim: 242,
	text: 252,
	selectedBg: 24,
	userMessageBg: 24,
	userMessageText: 252,
	customMessageBg: 54,
	customMessageLabel: 177,
	toolPendingBg: 236,
	toolSuccessBg: 22,
	toolErrorBg: 52,
	toolTitle: 252,
	toolOutput: 245,
	mdLink: 111,
};
const theme = {
	fg(token, value) {
		return `\x1b[38;5;${TOKEN_INDEX[token] ?? 252}m${value}\x1b[39m`;
	},
	bg(token, value) {
		return `\x1b[48;5;${TOKEN_INDEX[token] ?? 236}m${value}\x1b[49m`;
	},
	style(value, options = {}) {
		const parts = [];
		if (options.fg) parts.push(`\x1b[38;5;${TOKEN_INDEX[options.fg] ?? 252}m`);
		if (options.bg) parts.push(`\x1b[48;5;${TOKEN_INDEX[options.bg] ?? 236}m`);
		if (options.bold) parts.push("\x1b[1m");
		return `${parts.join("")}${value}\x1b[22m\x1b[39m\x1b[49m`;
	},
};
const keybindings = { matches: () => false, getKeys: () => ["F5"] };
const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} };

test("Aegis source launcher forwards --help using isolated state paths", () => {
	const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const temporary = mkdtempSync(join(tmpdir(), "aegis-runner-test-"));
	try {
		const result = spawnSync("bash", [join(repoRoot, "Pi_Agent_base/run-aegis.sh"), "--help"], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 30_000,
			env: {
				...process.env,
				AEGIS_PI_AGENT_DIR: join(temporary, "agent"),
				AEGIS_PI_SESSION_DIR: join(temporary, "sessions"),
				AEGIS_PI_SERVER_DIR: join(temporary, "server"),
				AEGIS_EVENT_LOG: join(temporary, "runtime", "events.jsonl"),
				AEGIS_RAM_DIR: join(temporary, "runtime", "ram"),
			},
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Usage:/);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("Aegis shell registers top bar/sidebar and does not open the Inspector overlay", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "aegis-shell-start-"));
	writeFileSync(
		join(temporary, "manifest.json"),
		JSON.stringify({
			campaign_id: "campaign-shell-start",
			revision: 1,
			objective: { description: "shell fixture", success_criteria: [] },
			tasks: [],
		}),
	);
	const saved = new Map();
	const env = {
		AEGIS_EVENT_LOG: join(temporary, "events.jsonl"),
		AEGIS_MANIFEST_FILE: join(temporary, "manifest.json"),
		AEGIS_ROM_FILE: join(resolve(dirname(fileURLToPath(import.meta.url)), "../agent/ROM.md")),
		AEGIS_RAM_DIR: join(temporary, "ram"),
		AEGIS_HANDOFF_FILE: join(temporary, "handoff.json"),
		AEGIS_TASK_ID: "task-shell-start",
		AEGIS_TUI_SHELL: "1",
		AEGIS_TUI_AUTOSTART: "1",
	};
	for (const [key, value] of Object.entries(env)) {
		saved.set(key, process.env[key]);
		process.env[key] = value;
	}
	const handlers = new Map();
	const calls = { topBar: 0, sidebar: 0, header: 0, custom: 0 };
	const api = {
		on: (event, handler) => handlers.set(event, handler),
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => ["read"],
		events: { on: () => () => {} },
	};
	const context = {
		mode: "tui",
		hasUI: true,
		cwd: temporary,
		sessionManager: { getSessionId: () => "session-shell-start" },
		ui: {
			notify() {},
			custom: async () => {
				calls.custom += 1;
			},
			setTopBar: () => {
				calls.topBar += 1;
			},
			setSidebar: () => {
				calls.sidebar += 1;
			},
			setHeader: () => {
				calls.header += 1;
			},
		},
	};
	try {
		aegisObserver(api);
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
		assert.equal(calls.topBar, 1);
		assert.equal(calls.sidebar, 1);
		assert.equal(calls.header, 1);
		assert.equal(calls.custom, 0);
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("Observer stays in the chat/input screen when no Campaign Manifest is configured", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "aegis-tui-no-manifest-"));
	const saved = new Map();
	const env = {
		AEGIS_EVENT_LOG: join(temporary, "events.jsonl"),
		AEGIS_MANIFEST_FILE: join(temporary, "missing-manifest.json"),
		AEGIS_ROM_FILE: join(resolve(dirname(fileURLToPath(import.meta.url)), "../agent/ROM.md")),
		AEGIS_RAM_DIR: join(temporary, "ram"),
		AEGIS_HANDOFF_FILE: join(temporary, "handoff.json"),
		AEGIS_TASK_ID: "task-no-manifest",
		AEGIS_TUI_AUTOSTART: "1",
	};
	for (const [key, value] of Object.entries(env)) {
		saved.set(key, process.env[key]);
		process.env[key] = value;
	}
	const handlers = new Map();
	let customCalls = 0;
	const api = {
		on: (event, handler) => handlers.set(event, handler),
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => ["read"],
		events: { on: () => () => {} },
	};
	const context = {
		mode: "tui",
		hasUI: true,
		cwd: temporary,
		sessionManager: { getSessionId: () => "session-no-manifest" },
		ui: {
			notify() {},
			custom: async () => {
				customCalls += 1;
			},
		},
	};
	try {
		aegisObserver(api);
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
		assert.equal(customCalls, 0);
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("Observer autostarts the full-screen Inspector on a corrupt log without modifying it", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "aegis-tui-start-"));
	const eventLog = join(temporary, "events.jsonl");
	const corruptBytes = '{"event_id":"bad","event_type":"unknown"}\\n';
	writeFileSync(eventLog, corruptBytes);
	writeFileSync(
		join(temporary, "manifest.json"),
		JSON.stringify({
			campaign_id: "campaign-tui-start",
			revision: 1,
			objective: { description: "startup fixture", success_criteria: [] },
			tasks: [],
		}),
	);
	const saved = new Map();
	const env = {
		AEGIS_EVENT_LOG: eventLog,
		AEGIS_MANIFEST_FILE: join(temporary, "manifest.json"),
		AEGIS_ROM_FILE: join(resolve(dirname(fileURLToPath(import.meta.url)), "../agent/ROM.md")),
		AEGIS_RAM_DIR: join(temporary, "ram"),
		AEGIS_HANDOFF_FILE: join(temporary, "handoff.json"),
		AEGIS_TASK_ID: "task-corrupt-start",
		AEGIS_TUI_AUTOSTART: "1",
	};
	for (const [key, value] of Object.entries(env)) {
		saved.set(key, process.env[key]);
		process.env[key] = value;
	}
	const handlers = new Map();
	const api = {
		on: (event, handler) => handlers.set(event, handler),
		registerTool() {},
		registerCommand() {},
		getActiveTools: () => ["read"],
		events: { on: () => () => {} },
	};
	const notifications = [];
	let rendered = "";
	let overlayOptions;
	const context = {
		mode: "tui",
		hasUI: true,
		cwd: temporary,
		sessionManager: { getSessionId: () => "session-corrupt" },
		ui: {
			notify: (message) => notifications.push(message),
			custom: async (factory, options) => {
				overlayOptions = options;
				await new Promise((done) => {
					const component = factory(tui, theme, keybindings, done);
					rendered = component.render(80).join("\n");
					component.handleInput("\u001b");
					component.dispose();
				});
			},
		},
	};
	try {
		aegisObserver(api);
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
		assert.equal(overlayOptions?.overlay, true);
		assert.equal(overlayOptions?.overlayOptions?.width, "100%");
		assert.match(rendered, /AEGIS INSPECT/);
		assert.match(rendered, /UNAVAILABLE/);
		assert.match(rendered, /UNKNOWN/);
		assert.equal(notifications.length, 0);
		assert.equal(readFileSync(eventLog, "utf8"), corruptBytes);
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(temporary, { recursive: true, force: true });
	}
});
