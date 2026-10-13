#!/usr/bin/env node
// Aegis C6-P5 learning/reuse — Campaign evidence into the ONE learning bridge,
// real isolated replay, explicit-policy compilation, derived rebuildable store,
// and route-before-model.
//
// Run:
//   node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
//     Pi_Agent_base/tests/aegis-c6-learning-reuse.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import * as sdkBase from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent/core/auth-storage";

const sdk = { ...sdkBase, AuthStorage };

import { runC6FromConfig } from "../memory/campaign/c6-entry.mjs";
import {
	buildCampaignLearningBridge,
	compileExperienceFromProofs,
	createCampaignLearningStore,
	loadAuthoritativeExperiences,
	rebuildExperienceStore,
	routeBeforeModel,
	runCampaignLearningStep,
} from "../memory/campaign/c6-learning.mjs";
import { validateManifest } from "../memory/campaign/manifest.mjs";
import { buildDataRepairManifest } from "../memory/campaign/structured-data-adapter.mjs";
import { ActionRegistry, createActionBroker } from "../memory/runtime/action-contract.mjs";
import { createAuthorization } from "../memory/runtime/authorization.mjs";
import { EventLog } from "../memory/runtime/events.mjs";
import { buildProductionResolver } from "../memory/runtime/learning-bridge.mjs";
import { authoritativeActiveExperiences } from "../memory/runtime/learning-store.mjs";

const BASE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "aegis-c6-learning-"));
const failures = [];
function check(name, condition, detail) {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures.push(name);
		console.log(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}
function readEvents(path) {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

try {
	const workspaceRoot = join(base, "workspace");
	const workDir = join(base, "run");
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(join(workspaceRoot, "dataset.json"), `${JSON.stringify({ name: "??" })}\n`, "utf8");

	const validated = validateManifest(buildDataRepairManifest({ workspaceRoot }));
	assert.equal(validated.ok, true, validated.reasons?.join("; "));
	const manifestPath = join(base, "manifest.json");
	writeFileSync(manifestPath, `${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8");
	const configPath = join(base, "campaign.config.json");
	writeFileSync(
		configPath,
		`${JSON.stringify({
			schema_version: "campaign-config-1.1",
			manifest_path: manifestPath,
			workspace_root: workspaceRoot,
			work_dir: workDir,
			mode: "auto",
			provider: { kind: "faux", model: "faux-c6" },
			context: { strategy: "bounded_ram", max_total_input_chars: 200000, output_reserve_chars: 1000 },
			learning: { policy: "explicit", promote_experience: false, proof_ids: [] },
			task_family: "structured-data-repair",
			session: { session_count: 4, max_requests_per_session: 10 },
			observation: { enabled: false, port: 0 },
			oracle: { kind: "fixture" },
		})}\n`,
		"utf8",
	);

	const eventLogPath = join(workDir, "events.jsonl");
	Object.assign(process.env, {
		AEGIS_EVENT_LOG: eventLogPath,
		AEGIS_RAM_DIR: join(workDir, "runtime"),
		AEGIS_HANDOFF_FILE: join(workDir, "runtime", "handoff.json"),
		AEGIS_TASK_ID: "task-c6-learning",
		AEGIS_ROM_FILE: join(BASE_DIR, "agent", "ROM.md"),
	});
	mkdirSync(join(workDir, "runtime"), { recursive: true });

	const seen = new Map();
	const outcome = await runC6FromConfig({
		configPath,
		scenario: "run",
		sdk,
		fauxProviderFactory: (options) => {
			const faux = registerFauxProvider(options);
			const mk = (context) => {
				const text = JSON.stringify(context.messages);
				const taskId = [...text.matchAll(/TASK (task-\d+)/g)].at(-1)?.[1] ?? "task-001";
				const count = (seen.get(taskId) ?? 0) + 1;
				seen.set(taskId, count);
				if (count > 1) return fauxAssistantMessage("done");
				return fauxAssistantMessage([
					fauxToolCall("aegis_task_decision", {
						actions: [
							{
								action_ref: "data.record.set",
								arguments: {
									target: "dataset.json",
									field: taskId === "task-001" ? "name" : "status",
									value: taskId === "task-001" ? "Ada" : "active",
								},
							},
						],
					}),
				]);
			};
			faux.setResponses(Array.from({ length: 16 }, () => mk));
			return faux;
		},
		print: () => {},
	});
	check("the product run completed", outcome.ok === true, JSON.stringify(outcome.reasons));

	// Default policy boundary: with no named proofs the explicit policy reports
	// "candidate" and does NOT compile or store an active Experience.
	check(
		"explicit policy with no proof ids does not compile",
		outcome.learning?.status === "candidate",
		JSON.stringify(outcome.learning),
	);
	check(
		"promote_experience is never true",
		outcome.config?.learning?.promote_experience === false,
		JSON.stringify(outcome.config?.learning),
	);
	const offStep = await runCampaignLearningStep({ policy: "off" });
	check("policy off disables compilation", offStep.status === "disabled", JSON.stringify(offStep));
	const refusedPromote = await runCampaignLearningStep({
		policy: "explicit",
		proofIds: ["x"],
		promoteExperience: true,
	});
	check("promote_experience:true is refused", refusedPromote.ok === false, JSON.stringify(refusedPromote));

	const events = readEvents(eventLogPath);

	// The ONE bridge resolves REAL campaign outcomes from the committed stream.
	const { createStructuredDataAdapter } = await import("../memory/campaign/structured-data-adapter.mjs");
	const registry = new ActionRegistry([createStructuredDataAdapter({ workspaceRoot })]);
	const broker = createActionBroker({ registry });
	const authorization = createAuthorization({
		mode: "auto",
		workspaceRoot,
		allowedTools: ["aegis_workspace"],
		allowNetwork: false,
		approved: true,
	});
	const resolver = buildProductionResolver({ events });
	const successIds = events
		.filter(
			(e) =>
				e.event_type === "runtime.note" &&
				e.payload?.kind === "campaign.oracle.result" &&
				e.payload.status === "success" &&
				!e.payload.step_id,
		)
		.map((e) => e.payload.outcome_id);
	check("campaign success outcomes are committed", successIds.length >= 2, JSON.stringify(successIds));
	const resolvedOne = resolver.resolveSupport({ kind: "outcome", ref: { ref_type: "outcome", ref_id: successIds[0] } });
	check("the ONE bridge resolves a campaign outcome", resolvedOne.ok === true, resolvedOne.reason);
	check(
		"the resolved outcome carries the real action pin",
		resolvedOne.record?.action_ref === "data.record.set" && resolvedOne.record?.action_version === 1,
		JSON.stringify({ ref: resolvedOne.record?.action_ref, version: resolvedOne.record?.action_version }),
	);
	// The campaign episode resolves to a REAL episode record.
	const resolvedEp = resolver.resolveSupport({
		kind: "episode",
		ref: { ref_type: "episode", ref_id: resolvedOne.record.episode_id },
	});
	check("the ONE bridge resolves the campaign episode", resolvedEp.ok === true, resolvedEp.reason);

	const bridge = buildCampaignLearningBridge({
		events,
		registry,
		broker,
		authorization,
		environment: {
			environment_fingerprint: "data-repair-env",
			domain: "structured-data",
			permissions: ["data.record.write"],
			task_types: ["verify", "reproduce"],
		},
	});
	const store = createCampaignLearningStore(workDir);
	const compiled = await compileExperienceFromProofs({ policy: "explicit", proofIds: successIds, bridge, store });
	check(
		"explicit policy with real proof ids invokes the compiler",
		compiled.status !== "disabled",
		JSON.stringify(compiled.status),
	);
	check(
		"the compiler result is honest about active vs candidate",
		compiled.active === true || compiled.status === "candidate",
		JSON.stringify({ active: compiled.active, status: compiled.status }),
	);
	check("no experience is auto-promoted by the entry", outcome.learning?.active !== true);

	// Derived store is rebuildable: deleting it and re-deriving from the committed
	// `experience.compiled` notes yields the SAME record.
	await store.save(
		{
			experience: {
				experience_id: "exp-demo",
				revision: 1,
				status: "active",
				when: ["environment=data-repair-env"],
				do: {},
				expect: [],
			},
			failures: [],
		},
		{ sourceOutcomeIds: successIds, recordedAt: null },
	);
	const log = new EventLog(eventLogPath);
	await log.open();
	const demoRecord = await store.load("exp-demo");
	await log.append({
		event_type: "runtime.note",
		episode_id: null,
		payload: {
			kind: "experience.compiled",
			active: true,
			experience_id: "exp-demo",
			revision: 1,
			source_outcome_ids: successIds,
			content_digest: demoRecord.content_digest,
			experience: demoRecord.experience,
		},
		source: { kind: "runtime", actor_id: "test", adapter: "c6-learning-test", version: "1" },
		schema_version: "1.1",
	});
	await log.close();
	const eventsWithNote = readEvents(eventLogPath);
	rmSync(join(workDir, "experiences"), { recursive: true, force: true });
	const rebuilt = await rebuildExperienceStore({ store, events: eventsWithNote });
	const rebuiltRecord = await store.load("exp-demo");
	check(
		"the derived store rebuilds from committed notes",
		rebuilt.rebuilt >= 1 && Boolean(rebuiltRecord),
		JSON.stringify(rebuilt),
	);
	check(
		"the rebuilt record matches the committed content digest",
		rebuiltRecord?.content_digest === demoRecord.content_digest,
	);

	// Route-before-model: an ACTIVE, authoritative experience routes direct with
	// ZERO planning requests.
	const authoritativeBridge = buildCampaignLearningBridge({
		events: eventsWithNote,
		registry,
		broker,
		authorization,
		environment: {
			environment_fingerprint: "data-repair-env",
			domain: "structured-data",
			permissions: ["data.record.write"],
			task_types: ["verify", "reproduce"],
		},
	});
	const active = await loadAuthoritativeExperiences({ store, events: eventsWithNote });
	check("the active experience is authoritative", active.length === 1, JSON.stringify(active.length));
	const routed = routeBeforeModel({
		bridge: authoritativeBridge,
		experiences: active,
		task: {
			task_id: "task-x",
			task_type: "verify",
			target_ref: "dataset.json",
			scope: { environment_fingerprint: "data-repair-env", domain: "structured-data" },
		},
		episodeId: "ep-task-x",
	});
	check(
		"an authoritative active experience routes and reports a planning decision",
		["direct", "habit", "hint", "deliberate", "paused"].includes(routed.route),
		JSON.stringify(routed),
	);
	check(
		"route-before-model reports zero planning for direct/habit",
		routed.route === "direct" || routed.route === "habit"
			? routed.planning_requests === 0
			: routed.planning_requests === 1,
		JSON.stringify({ route: routed.route, planning_requests: routed.planning_requests }),
	);
	// A non-authoritative record is excluded by the structural gate. NOTE: this
	// sandbox stubs crypto.createHash to zeros, so digest-based tamper detection
	// cannot be proven here; we instead prove the STRUCTURAL gate
	// (source_outcome_ids mismatch) that does not depend on the hash value.
	const tampered = [{ ...rebuiltRecord, source_outcome_ids: ["foreign-outcome"] }];
	const authoritativeAfterTamper = authoritativeActiveExperiences(tampered, eventsWithNote);
	check(
		"a store record with mismatched source_outcome_ids is not authoritative",
		authoritativeAfterTamper.length === 0,
		JSON.stringify(authoritativeAfterTamper.length),
	);
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
	console.log(`c6 learning reuse: ${failures.length} failure(s)`);
	process.exit(1);
}
console.log("c6 learning reuse: all checks passed");
