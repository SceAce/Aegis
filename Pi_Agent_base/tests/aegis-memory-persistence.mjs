// Persistence contract coverage using the existing compiler/store/router only.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAuthoritativeExperiences, rebuildExperienceStore } from "../memory/c6-learning.mjs";
import { compileExperience } from "../memory/experience-compiler.mjs";
import { routeLearning } from "../memory/learning-router.mjs";
import { authoritativeActiveExperiences, createLearningStore } from "../memory/learning-store.mjs";

const scope = {
	environment_fingerprint: "local-v1",
	domain: "persistence-test",
	permissions: ["read"],
	task_types: ["inspect"],
};
const contract = {
	id: "inspect",
	version: 1,
	implementation_digest: "sha256:reviewed-implementation",
	parameters: { target: { type: "string", required: true } },
};
const registry = { get: (id) => (id === "inspect" ? contract : null) };
const doSpec = {
	action_ref: "inspect",
	action_version: 1,
	implementation_digest: contract.implementation_digest,
	arguments_template: { target: "sample" },
};

function fixture() {
	const records = new Map();
	const proofs = [];
	for (const suffix of ["a", "b"]) {
		const episode = {
			episode_id: `episode-${suffix}`,
			run_id: `run-${suffix}`,
			independence_group: `group-${suffix}`,
			isolation_ref: `reset-${suffix}`,
			scope,
			source_kind: "live",
		};
		const outcome = {
			outcome_id: `outcome-${suffix}`,
			episode_id: episode.episode_id,
			status: "success",
			preconditions_verified: true,
			observed: { found: true },
			criterion: { expected: true },
			expect: [{ path: "found", op: "eq", value: true }],
			oracle: {
				oracle_id: "independent-check",
				independence_group: episode.independence_group,
				isolation_ref: episode.isolation_ref,
			},
			evidence_refs: [{ ref_type: "artifact", ref_id: `artifact-${suffix}` }],
		};
		records.set(`episode:${episode.episode_id}`, episode);
		records.set(`outcome:${outcome.outcome_id}`, outcome);
		records.set(`artifact:artifact-${suffix}`, { found: true });
		records.set(`replay:replay:${episode.episode_id}:${outcome.outcome_id}`, {
			episode_id: episode.episode_id,
			replayable: true,
			replay_count: 1,
			replay_hash: "same-content-is-legal",
		});
		proofs.push({
			outcome_id: outcome.outcome_id,
			do: doSpec,
			scope,
			when: [{ path: "ready", op: "eq", value: true, verified_by: [`artifact-${suffix}`] }],
		});
	}
	records.set("action:inspect", { action_ref: "inspect", version: 1 });
	const resolveSupport = ({ kind, ref }) => {
		const record = records.get(`${kind}:${ref.ref_id}`);
		return record ? { ok: true, record } : { ok: false, reason: "not in current effective evidence" };
	};
	return { records, resolveSupport, proofs };
}

function note(record) {
	return {
		event_type: "runtime.note",
		source: { kind: "runtime" },
		recorded_at: "2030-01-01T00:00:00Z",
		payload: {
			kind: "experience.compiled",
			active: record.active,
			experience_id: record.experience_id,
			revision: record.revision,
			source_outcome_ids: record.source_outcome_ids,
			content_digest: record.content_digest,
			experience: record.experience,
		},
	};
}
function decision(experiences, resolveSupport, environment = scope) {
	return routeLearning({
		experiences,
		resolveSupport,
		environment,
		registry,
		currentState: { ready: true },
		task: { arguments: { target: "sample" } },
	});
}

async function withStore(fn) {
	const dir = await mkdtemp(join(tmpdir(), "aegis-persistence-"));
	try {
		await fn(dir, createLearningStore({ dir }));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("candidate survives new store instance, never becomes active or routed", async () => {
	await withStore(async (dir, store) => {
		const compiled = compileExperience({ experienceId: "candidate-reference" });
		assert.equal(compiled.status, "candidate");
		assert.equal((await store.save(compiled)).ok, true);
		const reopened = createLearningStore({ dir });
		const candidate = await reopened.load("candidate-reference");
		assert.equal(candidate.status, "candidate");
		assert.deepEqual(candidate.experience.when, []);
		assert.equal(candidate.experience.do, null);
		assert.deepEqual(await reopened.loadActive(), []);
		assert.equal((await reopened.loadAll()).length, 1);
		assert.equal(decision([candidate.experience], fixture().resolveSupport).route, "deliberate");
	});
});

test("evidence-gated active reloads scoped/direct, foreign and changed scopes never reuse", async () => {
	await withStore(async (dir, store) => {
		const { proofs, resolveSupport } = fixture();
		const compiled = compileExperience({
			proofs,
			resolveSupport,
			environment: { ...scope, registry },
			experienceId: "verified-inspect",
		});
		assert.equal(compiled.status, "active", JSON.stringify(compiled.failures));
		const saved = await store.save(compiled, { sourceOutcomeIds: ["outcome-a", "outcome-b"] });
		const events = [note(saved.record)];
		const reopened = createLearningStore({ dir });
		const experiences = await loadAuthoritativeExperiences({ store: reopened, events });
		assert.equal(experiences.length, 1);
		assert.deepEqual(experiences[0].do.arguments_template, { target: "sample" });
		assert.deepEqual(experiences[0].expect, [{ path: "found", op: "eq", value: true }]);
		assert.equal(decision(experiences, resolveSupport).route, "direct");
		assert.equal(decision(experiences, resolveSupport, { ...scope, domain: "foreign-project" }).route, "deliberate");
		assert.equal(
			decision(experiences, resolveSupport, { ...scope, environment_fingerprint: "changed-v2" }).route,
			"paused",
		);
		assert.deepEqual(authoritativeActiveExperiences(await reopened.loadActive(), []), []);
		const staleNotes = [note({ ...saved.record, revision: 2 })];
		assert.deepEqual(authoritativeActiveExperiences(await reopened.loadActive(), staleNotes), []);
	});
});

test("superseded/unknown effective support cannot route after reload; deleted projection rebuilds", async () => {
	await withStore(async (dir, store) => {
		const { proofs, resolveSupport, records } = fixture();
		const compiled = compileExperience({ proofs, resolveSupport, environment: { ...scope, registry } });
		const saved = await store.save(compiled, { sourceOutcomeIds: ["outcome-a", "outcome-b"] });
		const events = [note(saved.record)];
		await rm(dir, { recursive: true });
		const reopened = createLearningStore({ dir });
		assert.deepEqual(await reopened.loadActive(), []);
		assert.deepEqual(await rebuildExperienceStore({ store: reopened, events }), { ok: true, rebuilt: 1 });
		const experiences = await loadAuthoritativeExperiences({ store: reopened, events });
		assert.equal(decision(experiences, resolveSupport).route, "direct");
		records.delete("outcome:outcome-a"); // Effective resolver excludes superseded outcome.
		assert.equal(decision(experiences, resolveSupport).route, "paused");
		records.set("outcome:outcome-a", { outcome_id: "outcome-a", status: "unknown" });
		assert.equal(decision(experiences, resolveSupport).route, "paused");
	});
});

test("corrupt/missing index and corrupt/tampered bodies fail closed for action reuse", async () => {
	await withStore(async (dir, store) => {
		const { proofs, resolveSupport } = fixture();
		const compiled = compileExperience({ proofs, resolveSupport, environment: { ...scope, registry } });
		const saved = await store.save(compiled, { sourceOutcomeIds: ["outcome-a", "outcome-b"] });
		const events = [note(saved.record)];
		const recordPath = store.experiencePath(compiled.experience.experience_id);
		await writeFile(recordPath, "{broken");
		let reopened = createLearningStore({ dir });
		assert.equal(await reopened.load(compiled.experience.experience_id), null);
		assert.equal(
			decision(await loadAuthoritativeExperiences({ store: reopened, events }), resolveSupport).route,
			"deliberate",
		);
		await writeFile(
			recordPath,
			JSON.stringify({
				...saved.record,
				experience: { ...saved.record.experience, do: { ...doSpec, arguments_template: { target: "tampered" } } },
			}),
		);
		assert.deepEqual(await loadAuthoritativeExperiences({ store: reopened, events }), []);
		await writeFile(recordPath, JSON.stringify(saved.record));
		const index = await readFile(store.indexPath(), "utf8");
		await writeFile(store.indexPath(), "{broken");
		reopened = createLearningStore({ dir });
		assert.deepEqual(await loadAuthoritativeExperiences({ store: reopened, events }), []);
		await rm(store.indexPath());
		assert.deepEqual(await loadAuthoritativeExperiences({ store: reopened, events }), []);
		await writeFile(store.indexPath(), index);
		assert.equal((await loadAuthoritativeExperiences({ store: reopened, events })).length, 1);
	});
});

test("persistence write failure throws before any action reuse", async () => {
	await withStore(async (dir) => {
		const path = join(dir, "blocked");
		await writeFile(path, "not a directory");
		const store = createLearningStore({ dir: path });
		await assert.rejects(store.save(compileExperience({ experienceId: "cannot-save" })));
		assert.deepEqual(await store.loadActive(), []);
	});
});
