import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAegisTuiDataSource } from "../observation/tui/data-source.mjs";
import { AegisInspector, openAegisTui } from "../observation/tui/session.ts";

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
		if (options.dim) parts.push("\x1b[2m");
		if (options.underline) parts.push("\x1b[4m");
		if (options.italic) parts.push("\x1b[3m");
		return `${parts.join("")}${value}\x1b[22m\x1b[23m\x1b[24m\x1b[39m\x1b[49m`;
	},
};

const keybindings = {
	matches(data, id) {
		return id === "app.aegis.inspect.refresh" && data === "F5";
	},
	getKeys() {
		return ["F5"];
	},
};

function task(id, order, overrides = {}) {
	return {
		task_id: id,
		order,
		depends_on: order > 1 ? [`task-${order - 1}`] : [],
		target_ref: "input.json",
		task_type: "verify",
		goal: {
			goal_id: `goal-${id}`,
			description: `验证输入 ${id} 并等待独立验收`,
			success_criteria: ["input is valid"],
		},
		stages: [],
		task_budget: { model_requests: 2, tool_calls: 4, wall_time_ms: 30_000 },
		...overrides,
	};
}

const tasks = Array.from({ length: 8 }, (_, index) => task(`task-${index + 1}`, index + 1));
const manifest = {
	campaign_id: "campaign-render-中文-123456789",
	revision: 7,
	objective: {
		description: "检查中文宽度和终端布局",
		success_criteria: ["input is valid"],
	},
	budget: { model_requests: 4, tool_calls: 8, wall_time_ms: 60_000 },
	tasks,
};

const hintEvent = {
	event_type: "proposal.submitted",
	episode_id: "ep-task-1",
	sequence: 0,
	event_id: "evt-ui-hint",
	event_digest: "sha256:render-fixture-hint",
	occurred_at: "2026-01-01T00:00:00.000Z",
	source: { kind: "llm", actor_id: "test", source_id: "test" },
	payload: {
		proposal_id: "p-hint",
		kind: "hint",
		text: "Check schema",
		task_id: "task-1",
	},
};

function makeRead(overrides = {}) {
	return {
		manifest: structuredClone(manifest),
		events: [],
		integrityOk: true,
		taskId: "task-1",
		episodeId: "ep-task-1",
		sessionId: "s-render",
		...overrides,
	};
}

function makeTui(rows = 24) {
	return {
		requestRender() {},
		terminal: { rows, columns: 80 },
	};
}

function makeInspector(read = makeRead(), rows = 24) {
	const tui = makeTui(rows);
	const source = createAegisTuiDataSource(() => read);
	let done = 0;
	const inspector = new AegisInspector(tui, theme, keybindings, source, () => {
		done += 1;
	});
	return { inspector, tui, read, getDone: () => done };
}

function assertFrame(inspector, tui, width, rows) {
	tui.terminal.rows = rows;
	const lines = inspector.render(width);
	assert.equal(lines.length, rows, `height mismatch at ${width}×${rows}`);
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${line}`);
	const widths = new Set(lines.map((line) => visibleWidth(line)));
	assert.deepEqual([...widths], [width], `every terminal line must be exactly ${width} cells`);
	return lines;
}

test("non-TUI mode does not create a component or read committed state", async () => {
	let customCalls = 0;
	let reads = 0;
	let notices = 0;
	await openAegisTui(
		{
			mode: "print",
			ui: {
				notify: () => {
					notices += 1;
				},
				custom: () => {
					customCalls += 1;
				},
			},
		},
		() => {
			reads += 1;
			return makeRead();
		},
	);
	assert.equal(customCalls, 0);
	assert.equal(reads, 0);
	assert.equal(notices, 1);
});

test("overlay is full-screen and closes through Pi's completion without writes", async () => {
	const read = makeRead();
	const before = JSON.stringify(read);
	let optionsSeen;
	let doneCalls = 0;
	const tui = makeTui(24);
	const ctx = {
		mode: "tui",
		ui: {
			notify() {},
			custom: async (factory, options) => {
				optionsSeen = options;
				await new Promise((resolve) => {
					const component = factory(tui, theme, keybindings, () => {
						doneCalls += 1;
						resolve(undefined);
					});
					component.render(80);
					component.handleInput("\u001b");
					component.dispose();
				});
			},
		},
	};
	await openAegisTui(ctx, () => read);
	assert.equal(optionsSeen?.overlay, true);
	assert.deepEqual(optionsSeen?.overlayOptions, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
	});
	assert.equal(doneCalls, 1);
	assert.equal(JSON.stringify(read), before);
});

test("graph and board and evidence render at 80, 100, 120, and 160 columns", () => {
	const { inspector, tui } = makeInspector();
	for (const [width, rows] of [
		[80, 24],
		[100, 30],
		[120, 40],
		[160, 50],
	]) {
		const lines = assertFrame(inspector, tui, width, rows);
		assert.match(lines.join("\n"), /AEGIS INSPECT/);
		assert.match(lines.join("\n"), /Graph/);
		assert.match(lines.join("\n"), /Esc 返回对话输入/);
		assert.match(lines.join("\n"), /read-only/);
	}
	tui.terminal.rows = 24;
	inspector.handleInput("2");
	const board = assertFrame(inspector, tui, 80, 24);
	assert.match(board.join("\n"), /Board/);
	inspector.handleInput("3");
	const evidence = assertFrame(inspector, tui, 80, 24);
	assert.match(evidence.join("\n"), /EVIDENCE/);
	assert.match(evidence.join("\n"), /TRANSPORT/);
	assert.match(evidence.join("\n"), /TRUST BOUNDARY/);
});

test("wide layout has master/detail/aside; 80 columns uses single-pane detail and back", () => {
	const { inspector, tui } = makeInspector();
	assertFrame(inspector, tui, 120, 40);
	const wide = inspector.render(120).join("\n");
	assert.match(wide, /TRUST BOUNDARY/);
	assert.match(wide, /COUNTS/);
	tui.terminal.rows = 24;
	const narrow = assertFrame(inspector, tui, 80, 24).join("\n");
	assert.doesNotMatch(narrow, /COUNTS/);
	inspector.handleInput("\r");
	const detail = assertFrame(inspector, tui, 80, 24).join("\n");
	assert.match(detail, /Backspace 返回列表/);
	inspector.handleInput("\u007f");
	const list = assertFrame(inspector, tui, 80, 24).join("\n");
	assert.doesNotMatch(list, /Backspace 返回列表/);
});

test("kitty mouse click selects a row and opens the narrow-screen detail", () => {
	const { inspector, tui } = makeInspector();
	tui.terminal.rows = 24;
	inspector.render(80);
	const result = inspector.handleMouse({
		type: "click",
		button: "left",
		x: 6,
		y: 4,
		screenX: 6,
		screenY: 4,
		width: 80,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
	});
	assert.equal(result?.handled, true);
	const view = inspector.render(80).join("\n");
	assert.match(view, /Backspace 返回列表/);
});

test("selection, paging, refresh, and tab changes stay bounded", () => {
	const { inspector, tui, getDone } = makeInspector();
	tui.terminal.rows = 24;
	const first = assertFrame(inspector, tui, 80, 24).join("\n");
	assert.match(first, /1–6\/8/);
	inspector.handleInput("\u001b[B");
	const selected = inspector.render(80).join("\n");
	assert.match(selected, /task-2/);
	inspector.handleInput("\u001b[6~");
	const paged = assertFrame(inspector, tui, 80, 24).join("\n");
	assert.match(paged, /7–8\/8/);
	inspector.handleInput("\u001b[5~");
	const back = assertFrame(inspector, tui, 80, 24).join("\n");
	assert.match(back, /1–6\/8/);
	inspector.handleInput("F5");
	assertFrame(inspector, tui, 80, 24);
	inspector.handleInput("\u001b");
	assert.equal(getDone(), 1);
});

test("missing manifest is diagnosed and the input-return path is visible", () => {
	const { inspector, tui } = makeInspector({
		manifest: null,
		events: [],
		integrityOk: false,
		taskId: null,
		episodeId: null,
		sessionId: null,
	});
	tui.terminal.rows = 24;
	const view = assertFrame(inspector, tui, 80, 24).join("\n");
	assert.match(view, /NO CAMPAIGN MANIFEST/);
	assert.match(view, /Campaign Manifest is not configured or invalid/);
	assert.match(view, /Esc 返回对话输入/);
});

test("integrity unavailable is visible and never rendered as success", () => {
	const { inspector, tui } = makeInspector(makeRead({ integrityOk: false }));
	tui.terminal.rows = 24;
	const view = assertFrame(inspector, tui, 80, 24).join("\n");
	assert.match(view, /UNAVAILABLE/);
	assert.doesNotMatch(view, /COMMITTED/);
	inspector.handleInput("3");
	const evidence = assertFrame(inspector, tui, 80, 24).join("\n");
	assert.match(evidence, /UNKNOWN/);
});

test("CJK/emoji and long unbroken content survive every width", () => {
	const long = "中文目标🙂" + "A".repeat(80);
	const read = makeRead({
		manifest: {
			...structuredClone(manifest),
			tasks: [
				task("task-中文-very-long-id-" + "x".repeat(40), 1, {
					goal: { goal_id: "g", description: long, success_criteria: [long] },
				}),
			],
		},
		taskId: "task-中文-very-long-id-" + "x".repeat(40),
	});
	const { inspector, tui } = makeInspector(read);
	for (const [width, rows] of [
		[80, 24],
		[120, 40],
	])
		assertFrame(inspector, tui, width, rows);
	inspector.handleInput("\r");
	assertFrame(inspector, tui, 80, 24);
});

test("source failure renders a bounded read error and keeps Esc available", () => {
	const source = createAegisTuiDataSource(() => {
		throw new Error("projection unavailable");
	});
	let done = 0;
	const tui = makeTui(24);
	const inspector = new AegisInspector(tui, theme, keybindings, source, () => {
		done += 1;
	});
	const view = assertFrame(inspector, tui, 80, 24).join("\n");
	assert.match(view, /READ ERROR/);
	assert.match(view, /Esc/);
	inspector.handleInput("\u001b");
	assert.equal(done, 1);
});

test("board rows group by actual board types and preserve trust labels", () => {
	const read = makeRead({ events: [hintEvent] });
	const { inspector, tui } = makeInspector(read);
	tui.terminal.rows = 24;
	inspector.handleInput("2");
	const view = assertFrame(inspector, tui, 80, 24).join("\n");
	assert.match(view, /PROPOSALS/);
	assert.match(view, /UNVERIFIED/);
	assert.match(view, /Check schema/);
});
