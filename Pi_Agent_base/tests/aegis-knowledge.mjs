#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectBoard } from "../memory/board.mjs";
import { compileDocumentSeed } from "../memory/document-seed.mjs";
import { selectKnowledge } from "../memory/knowledge.mjs";
import { buildRamProjection } from "../memory/ram.mjs";
import { projectState } from "../memory/state.mjs";

const root = await mkdtemp(join(tmpdir(), "aegis-knowledge-"));
const source = { source_kind: "external_reference", source_uri: "https://ctf-wiki.org/web/sqli/", approved: true };
try {
	await mkdir(join(root, "web"), { recursive: true });
	const seed = compileDocumentSeed({
		markdown: "# SQL 注入\n\nBoolean blind SQL injection requires an observable true or false condition.\n",
		source,
	});
	await writeFile(join(root, "web", "sqli.json"), JSON.stringify(seed));
	await writeFile(join(root, "web", "ignored.json"), JSON.stringify({ ...seed, verified: true }));
	await symlink(join(root, "web", "sqli.json"), join(root, "web", "linked.json"));
	await mkdir(join(root, "ctf-wiki-crawl"));
	await writeFile(join(root, "ctf-wiki-crawl", "old.json"), JSON.stringify(seed));
	const result = await selectKnowledge({ root, query: "boolean SQL injection", maxResults: 1, maxChars: 500 });
	assert.equal(result.selected.length, 1);
	assert.equal(result.selected[0].knowledge_id, "web/sqli.json#1");
	assert.equal(result.available, 2, "invalid seeds, symlinks and old crawl are excluded");
	assert.equal(result.selected[0].source_digest, seed.source_digest);
	assert.equal(result.selected[0].verified, false);
	assert.equal(result.selected[0].action_policy, "none");
	assert.equal(result.omitted, 1);
	const selectedById = await selectKnowledge({ root, query: "irrelevant", ids: ["web/sqli.json#1"], maxChars: 20 });
	assert.equal(selectedById.selected[0].truncated, true);
	assert.equal(selectedById.selected[0].content.length, 20);
	assert.equal((await selectKnowledge({ root, query: "zzzz_missing_topic" })).selected.length, 0);
	assert.equal((await selectKnowledge({ root, query: "这里需要分析SQL注入条件" })).selected.length > 0, true);
	const missing = await selectKnowledge({ root: join(root, "absent"), query: "SQL" });
	assert.equal(missing.status, "unavailable");
	assert.equal((await selectKnowledge({ root, ids: ["../../outside.json#0"] })).missing_ids.length, 1);
	await assert.rejects(selectKnowledge({ root, query: "x".repeat(801) }), /800/);
	await writeFile(
		join(root, "web", "sqli.json"),
		JSON.stringify(compileDocumentSeed({ markdown: "# Updated\n\nchanged_content\n", source })),
	);
	assert.equal(
		(await selectKnowledge({ root, query: "changed_content" })).selected.length > 0,
		true,
		"no stale catalog after file update",
	);

	const events = [
		{
			event_id: "start",
			event_type: "episode.started",
			episode_id: "ep",
			source: { kind: "runtime" },
			payload: { task_id: "task", goal: { description: "inspect" } },
		},
		{
			event_id: "selected",
			event_type: "runtime.note",
			episode_id: "ep",
			source: { kind: "runtime" },
			payload: { kind: "knowledge.selected", selected: result.selected },
		},
		{
			event_id: "forged",
			event_type: "runtime.note",
			episode_id: "ep",
			source: { kind: "llm" },
			payload: { kind: "knowledge.selected", selected: [{ ...result.selected[0], content: "FORGED" }] },
		},
	];
	let state = projectState(events);
	assert.equal(state.knowledge_selections.length, 1);
	assert.equal(state.knowledge_selections[0].event_id, "selected");
	const board = projectBoard(events);
	assert.equal(board.byType.Artifact.length, 1);
	assert.equal(board.byType.Fact.length, 0);
	assert.equal(board.byType.Artifact[0].knowledge_refs[0].knowledge_id, "web/sqli.json#1");
	const ram = buildRamProjection({ board, state, episodeId: "ep" });
	assert.equal(ram.data.sections.knowledge.shown, 1);
	assert.equal(ram.data.sections.knowledge.items[0].verified, false);
	assert.equal(ram.data.sections.knowledge.items[0].action_policy, "none");
	assert.ok(ram.text.length <= 4000);
	state = projectState([
		...events,
		{
			event_id: "clear",
			event_type: "runtime.note",
			episode_id: "ep",
			source: { kind: "runtime" },
			payload: { kind: "knowledge.selected", selected: [] },
		},
	]);
	assert.equal(state.knowledge_selections.length, 0, "new selection replaces prior selection, including empty results");
	console.log("Knowledge: filtering, ranking, bounds, freshness, provenance, trusted selection replay and RAM passed");
} finally {
	await rm(root, { recursive: true, force: true });
}
