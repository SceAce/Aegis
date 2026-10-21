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
	// A long, unique latin token still recalls even though a body hit alone scores 2.
	assert.equal(
		(await selectKnowledge({ root, query: "changed_content" })).selected[0].score >= 0,
		true,
		"score is exposed for audits",
	);
	// Task-wrapper Chinese bigrams are not evidence: "题目" must not recall a section
	// just because the section heading ends with the same two characters.
	const wrapperOnly = await selectKnowledge({ root, query: "这是题目" });
	assert.equal(wrapperOnly.selected.length, 0, "wrapper words alone must not recall anything");

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
	assert.equal(ram.data.references.find((row) => row.kind === "knowledge").verified, false);
	assert.equal(ram.data.references.find((row) => row.kind === "knowledge").action_policy, "none");
	assert.ok(ram.text.length <= 8000);
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

// Direction filter: a request that names its domain must not recall other domains.
{
	const root = await mkdtemp(join(tmpdir(), "aegis-knowledge-direction-"));
	try {
		await mkdir(join(root, "web"), { recursive: true });
		await mkdir(join(root, "pwn"), { recursive: true });
		const source = (uri) => ({ source_uri: uri, source_kind: "external_reference", approved: true });
		await writeFile(
			join(root, "web", "upload.json"),
			JSON.stringify(
				compileDocumentSeed({
					markdown: "# Web\n\nweb 文件上传绕过与 flag 读取\n",
					source: source("https://example.test/web/upload"),
				}),
			),
		);
		await writeFile(
			join(root, "pwn", "kernel.json"),
			JSON.stringify(
				compileDocumentSeed({
					markdown: "# 内核 pwn\n\npwn 内核里搜索 flag\n",
					source: source("https://example.test/pwn/kernel"),
				}),
			),
		);

		const web = await selectKnowledge({ root, query: "这是 CTF web 题目，解出 flag" });
		assert.ok(web.selected.length > 0, "web task recalls web material");
		assert.equal(
			web.selected.every((row) => row.knowledge_id.split("/")[0] === "web"),
			true,
			`a web task must not surface pwn rows: ${web.selected.map((row) => row.knowledge_id).join(",")}`,
		);

		const pwn = await selectKnowledge({ root, query: "内核 pwn 里搜索 flag" });
		assert.equal(
			pwn.selected.every((row) => row.knowledge_id.split("/")[0] === "pwn"),
			true,
			"a pwn task must not surface web rows",
		);

		// A bare generic word is not evidence of relevance. Zero recall is a valid,
		// documented outcome (KNOW-01): better nothing than four wrong sections.
		const vague = await selectKnowledge({ root, query: "flag" });
		assert.equal(vague.selected.length, 0, "a single generic word recalls nothing");

		// Without a direction word but with a specific term, recall still works.
		const specific = await selectKnowledge({ root, query: "上传绕过" });
		assert.ok(specific.selected.length > 0, "a specific term recalls without a direction hint");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
console.log("Knowledge direction filter passed");
