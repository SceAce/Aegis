import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AegisBlank, AegisComposerBar, AegisSidebar, AegisTopBar } from "../observation/tui/shell.ts";

const manifest = {
	campaign_id: "campaign-shell",
	revision: 1,
	objective: { description: "Inspect shell", success_criteria: ["criterion"] },
	tasks: [
		{
			task_id: "task-shell",
			order: 1,
			depends_on: [],
			target_ref: "input.json",
			task_type: "verify",
			goal: { goal_id: "g-shell", description: "Check shell", success_criteria: ["criterion"] },
			stages: [],
		},
	],
};
const events = [
	{
		event_type: "action.completed",
		episode_id: "ep-task-shell",
		sequence: 0,
		event_id: "evt-shell",
		event_digest: "sha256:shell-test",
		recorded_at: "2026-01-01T00:00:00.000Z",
		source: { kind: "runtime" },
		payload: { tool_name: "read", task_id: "task-shell", transport: "ok" },
	},
];
const theme = {
	fg(_token, value) {
		return value;
	},
	bg(_token, value) {
		return value;
	},
	style(value) {
		return value;
	},
};
const tui = { terminal: { rows: 40, columns: 120 }, requestRender() {} };
const read = () => ({
	manifest,
	events,
	integrityOk: true,
	taskId: "task-shell",
	episodeId: "ep-task-shell",
	sessionId: "session-shell",
});

test("Aegis top bar is exactly one line and stays inside the width", () => {
	const bar = new AegisTopBar(tui, theme, read);
	for (const width of [80, 100, 120, 160]) {
		const lines = bar.render(width);
		assert.equal(lines.length, 1);
		assert.equal(visibleWidth(lines[0]), width);
		assert.match(lines[0], /AEGIS/);
		assert.match(lines[0], /task-shell/);
	}
});

test("Aegis sidebar fills the transcript height and exposes inspect/trust context", () => {
	const sidebar = new AegisSidebar(tui, theme, read);
	const lines = sidebar.render(32);
	assert.equal(lines.length, 34);
	for (const line of lines) assert.equal(visibleWidth(line), 32);
	const view = lines.join("\n");
	assert.match(view, /CONTEXT/);
	assert.match(view, /INSPECT/);
	assert.match(view, /TRUST/);
	assert.match(view, /action.completed/);
});

test("missing manifest is visible in shell chrome and blank header is empty", () => {
	const missing = new AegisTopBar(tui, theme, () => ({
		manifest: null,
		events: [],
		integrityOk: false,
		taskId: null,
		episodeId: null,
		sessionId: null,
	}));
	const line = missing.render(120)[0];
	assert.match(line, /NO MANIFEST/);
	const sidebar = new AegisSidebar(tui, theme, () => ({
		manifest: null,
		events: [],
		integrityOk: false,
		taskId: null,
		episodeId: null,
		sessionId: null,
	}));
	assert.match(sidebar.render(32).join("\n"), /NO MANIFEST/);
	assert.deepEqual(new AegisBlank().render(120), []);
});

test("Aegis composer label keeps the input identity visible", () => {
	const bar = new AegisComposerBar(theme);
	for (const width of [80, 120]) {
		const lines = bar.render(width);
		assert.equal(lines.length, 1);
		assert.equal(visibleWidth(lines[0]), width);
		assert.match(lines[0], /INPUT/);
	}
});

test("shell components never mutate the committed source", () => {
	const committed = {
		manifest,
		events,
		integrityOk: true,
		taskId: "task-shell",
		episodeId: "ep-task-shell",
		sessionId: "s",
	};
	const before = JSON.stringify(committed);
	const bar = new AegisTopBar(tui, theme, () => committed);
	const sidebar = new AegisSidebar(tui, theme, () => committed);
	bar.render(120);
	sidebar.render(32);
	assert.equal(JSON.stringify(committed), before);
});
