#!/usr/bin/env node
// Batch B offline smoke test: action contracts, workspace ELF identification,
// registered scripts, authorization, learning router, experience compiler and
// verified data-use contributions.
//
// Offline by construction: no network, no model/provider, only local temp dirs.
// Every assertion reads the RECORDS the modules return; nothing trusts a
// self-reported status string without the corresponding evidence.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digest, sha256Hex } from "../shared/contracts.mjs";
import {
	ActionRegistry,
	bindProposal,
	checkVerification,
	contractDigest,
	createActionBroker,
	defineContract,
	implementationDigest,
	matchPermit,
	validateContract,
} from "../execution/action-contract.mjs";
import { createAuthorization, authorizeAction, describeAuthorization } from "../execution/authorization.mjs";
import {
	isElfObservationCurrent,
	parseElfHeader,
	syntheticElfHeader,
	identifyElfContract,
	workspaceObservationContracts,
} from "../execution/workspace-info-actions.mjs";
import { buildArgv, createScriptContract, createScriptRegistry, executableDigest } from "../execution/script-registry.mjs";
import { routeLearning } from "../memory/learning-router.mjs";
import { compileExperience } from "../memory/experience-compiler.mjs";
import { contributionPayload, dataUsefulness, recordStageContribution } from "../memory/contribution.mjs";

const failures = [];
function test(name, fn) {
	try {
		const result = fn();
		if (result && typeof result.then === "function") throw new Error("async test must be awaited in the runner");
		console.log(`ok   ${name}`);
	} catch (error) {
		failures.push({ name, error });
		console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
async function testAsync(name, fn) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures.push({ name, error });
		console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const root = mkdtempSync(join(tmpdir(), "aegis-batch-b-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// 1. ActionContract engine
// ---------------------------------------------------------------------------

function sampleContract(overrides = {}) {
	return defineContract({
		id: "demo.ping",
		version: 1,
		tool: "aegis_demo",
		operation: "ping",
		risk_class: "observe",
		parameters: { target: { type: "string", required: true } },
		recognition: { predicates: [{ path: "ready", op: "eq", value: true }] },
		procedure: { kind: "function", run: ({ arguments: args }) => ({ ok: true, observed: { target: args.target, pong: true } }) },
		verification: { predicates: [{ path: "pong", op: "eq", value: true }] },
		scope: { environment_fingerprint: "local", domain: "demo", permissions: ["read-only-observation"] },
		authorization: { target_kinds: ["workspace_file"] },
		stop_policy: { max_attempts: 1, retry: "none", timeout_ms: 1000 },
		...overrides,
	});
}

test("valid contract passes static review", () => {
	const contract = sampleContract();
	assert.equal(validateContract(contract).ok, true, validateContract(contract).reasons.join("; "));
});

test("missing verification is refused", () => {
	const contract = sampleContract();
	delete contract.verification;
	const review = validateContract(contract);
	assert.equal(review.ok, false);
	assert.ok(review.reasons.some((reason) => reason.includes("verification")));
});

test("wildcard scope is refused", () => {
	const review = validateContract(sampleContract({ scope: { environment_fingerprint: "*", domain: "demo", permissions: ["read-only-observation"] } }));
	assert.equal(review.ok, false);
	assert.ok(review.reasons.some((reason) => reason.includes("environment_fingerprint")));
});

test("scope permissions cannot be empty or wildcard", () => {
	assert.equal(validateContract(sampleContract({ scope: { environment_fingerprint: "local", domain: "demo", permissions: [] } })).ok, false);
	assert.equal(validateContract(sampleContract({ scope: { environment_fingerprint: "local", domain: "demo", permissions: ["any"] } })).ok, false);
});

test("implementation digest changes when the function body changes", () => {
	const base = sampleContract();
	const a = defineContract({ ...base, implementation_digest: undefined, procedure: { kind: "function", run: () => ({ ok: true }) } });
	const b = defineContract({ ...base, implementation_digest: undefined, procedure: { kind: "function", run: () => ({ ok: true, extra: 1 }) } });
	assert.equal(a.implementation_digest === b.implementation_digest, false);
	assert.equal(contractDigest(a) === contractDigest(b), false);
});

test("duplicate contract ids are refused", () => {
	const registry = new ActionRegistry([sampleContract()]);
	assert.throws(() => registry.register(sampleContract()), /duplicate contract id/);
});

test("invalid contract is refused at registration", () => {
	const registry = new ActionRegistry();
	assert.throws(() => registry.register(sampleContract({ id: "" })), /refusing invalid contract/);
});

test("registry describe() exposes no executable code", () => {
	const registry = new ActionRegistry([sampleContract()]);
	const described = registry.describe();
	assert.equal(described.length, 1);
	assert.equal(described[0].id, "demo.ping");
	assert.equal(Object.hasOwn(described[0], "procedure"), false);
});

await testAsync("broker refuses an unknown action", async () => {
	const broker = createActionBroker({ registry: new ActionRegistry([sampleContract()]) });
	const result = await broker.invoke({ action_ref: "does.not.exist", arguments: {}, permit: { ok: true } });
	assert.equal(result.status, "rejected");
	assert.match(result.reason, /unknown action/);
});

function permitFor(contract, args, overrides = {}) {
	return {
		ok: true,
		mode: "auto",
		action_ref: contract.id,
		version: contract.version,
		implementation_digest: contract.implementation_digest,
		arguments_digest: digest(args),
		...overrides,
	};
}

await testAsync("broker blocks execution on no permit", async () => {
	const contract = sampleContract();
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const result = await broker.invoke({ action_ref: contract.id, arguments: { target: "x" }, state: { ready: true } });
	assert.equal(result.status, "rejected");
	assert.match(result.reason, /permit/);
});

await testAsync("broker blocks execution on arguments mismatch (parameter swap)", async () => {
	const contract = sampleContract();
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const permit = permitFor(contract, { target: "A" });
	const result = await broker.invoke({ action_ref: contract.id, arguments: { target: "B" }, permit, state: { ready: true } });
	assert.equal(result.status, "rejected");
	assert.match(result.reason, /arguments_digest/);
});

await testAsync("broker blocks execution on implementation digest mismatch", async () => {
	const contract = sampleContract();
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const permit = permitFor(contract, { target: "A" }, { implementation_digest: "sha256:deadbeef" });
	const result = await broker.invoke({ action_ref: contract.id, arguments: { target: "A" }, permit, state: { ready: true } });
	assert.equal(result.status, "rejected");
	assert.match(result.reason, /implementation_digest/);
});

await testAsync("broker refuses invalid arguments against the data-only schema", async () => {
	const contract = sampleContract();
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const permit = permitFor(contract, { wrong: 1 });
	const result = await broker.invoke({ action_ref: contract.id, arguments: { wrong: 1 }, permit, state: { ready: true } });
	assert.equal(result.status, "rejected");
	assert.match(result.reason, /invalid arguments/);
});

await testAsync("broker fails recognition without executing", async () => {
	let ran = false;
	const contract = sampleContract({ procedure: { kind: "function", run: () => { ran = true; return { ok: true }; } } });
	// Recompute the digest so the permit matches the overridden procedure.
	contract.implementation_digest = implementationDigest(contract.procedure);
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const permit = permitFor(contract, { target: "A" });
	const result = await broker.invoke({ action_ref: contract.id, arguments: { target: "A" }, permit, state: { ready: false } });
	assert.equal(result.status, "rejected");
	assert.match(result.reason, /recognition/);
	assert.equal(ran, false, "procedure must not run when recognition fails");
});

await testAsync("broker returns unknown, not success, when verification fails", async () => {
	const contract = sampleContract();
	contract.verification = { predicates: [{ path: "pong", op: "eq", value: false }] };
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const permit = permitFor(contract, { target: "A" });
	const result = await broker.invoke({ action_ref: contract.id, arguments: { target: "A" }, permit, state: { ready: true } });
	assert.equal(result.status, "unknown");
	assert.equal(result.ok, false);
	assert.equal(result.failure_mode, "insufficient_evidence");
	assert.equal(result.transport.tool_ok, true, "the transport fact (the procedure ran) is preserved even when verification fails");
});

await testAsync("broker returns success only when verification passes", async () => {
	const contract = sampleContract();
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const permit = permitFor(contract, { target: "A" });
	const result = await broker.invoke({ action_ref: contract.id, arguments: { target: "A" }, permit, state: { ready: true } });
	assert.equal(result.status, "success");
	assert.equal(result.verification.ok, true);
	assert.equal(result.attempts, 1);
});

test("bindProposal never parses prose into code", () => {
	const registry = new ActionRegistry([sampleContract()]);
	const bound = bindProposal({ do: "please ping the local host and tell me if it works", scope: { environment_fingerprint: "local", domain: "demo" } }, { registry });
	assert.equal(bound.executable, false);
	assert.equal(bound.status, "candidate");
	assert.ok(bound.gaps.some((gap) => gap.field === "do"));
});

test("bindProposal maps an explicit registered action with structured when", () => {
	const registry = new ActionRegistry([sampleContract()]);
	const bound = bindProposal(
		{
			action_ref: "demo.ping",
			when: [{ path: "ready", op: "eq", value: true }],
			arguments_template: { target: null },
			scope: { environment_fingerprint: "local", domain: "demo" },
		},
		{ registry },
	);
	assert.equal(bound.executable, true);
	assert.equal(bound.status, "bound");
	assert.equal(bound.action_ref, "demo.ping");
	assert.deepEqual(bound.gaps, []);
});

test("bindProposal exposes a gap for an unknown checker instead of guessing", () => {
	const registry = new ActionRegistry([sampleContract()]);
	const bound = bindProposal(
		{ action_ref: "demo.ping", when: [{ path: "ready", op: "eq", value: true }], arguments_template: { target: null }, scope: { environment_fingerprint: "local", domain: "demo" }, verification_checker: "magic" },
		{ registry, knownCheckers: ["basic"] },
	);
	assert.equal(bound.executable, false);
	assert.ok(bound.gaps.some((gap) => gap.field === "verification_checker"));
});

test("matchPermit requires id, version, digest and arguments", () => {
	const contract = sampleContract();
	const args = { target: "A" };
	assert.equal(matchPermit(permitFor(contract, args), contract, args).ok, true);
	assert.equal(matchPermit(permitFor(contract, args, { version: 2 }), contract, args).ok, false);
	assert.equal(matchPermit(permitFor(contract, args, { action_ref: "other" }), contract, args).ok, false);
});

// ---------------------------------------------------------------------------
// 2. Workspace ELF identification
// ---------------------------------------------------------------------------

test("ELF header is parsed from real bytes with no guessing", () => {
	const header = syntheticElfHeader({ bits: 32, endianness: "big", machine_id: 0x28, type_id: 2 });
	const parsed = parseElfHeader(header);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.bits, 32);
	assert.equal(parsed.endianness, "big");
	assert.equal(parsed.machine, "arm");
	assert.equal(parsed.file_type, "executable");
});

test("a 32-bit and a 64-bit header never report the same bitness", () => {
	assert.equal(parseElfHeader(syntheticElfHeader({ bits: 32 })).bits, 32);
	assert.equal(parseElfHeader(syntheticElfHeader({ bits: 64 })).bits, 64);
});

test("truncated, non-ELF and short input is unknown, never a guess", () => {
	assert.equal(parseElfHeader(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1])).reason, "truncated");
	assert.equal(parseElfHeader(Buffer.from("this is not an elf file at all")).reason, "not_elf");
	assert.equal(parseElfHeader(Buffer.alloc(3)).reason, "truncated");
	assert.equal(parseElfHeader("string not buffer").reason, "not_a_buffer");
});

await testAsync("identify_elf verifies a real ELF file and records its digest", async () => {
	const workspace = join(root, "ws1");
	mkdirSync(workspace, { recursive: true });
	const elf = Buffer.concat([syntheticElfHeader({ bits: 64, endianness: "little", machine_id: 0x3e, type_id: 3 }), Buffer.alloc(32, 7)]);
	writeFileSync(join(workspace, "lib.so"), elf);
	const broker = createActionBroker({ registry: new ActionRegistry(workspaceObservationContracts()) });
	const args = { path: "lib.so" };
	const permit = permitFor(identifyElfContract, args);
	const result = await broker.invoke({ action_ref: "workspace.identify_elf", arguments: args, permit, context: { workspaceRoot: workspace, step_id: "s1", action_event_id: "evt_1" } });
	assert.equal(result.status, "success");
	assert.equal(result.observation.value.bits, 64);
	assert.equal(result.observation.value.machine, "x86_64");
	assert.equal(result.observation.value.format, "ELF");
	assert.equal(result.observation.verified, true);
	assert.equal(result.observation.value.file_digest, digest(elf.toString("hex")));
	assert.equal(result.step_outcome.status, "success");
	assert.equal(result.step_outcome.level, "step");
	assert.equal(result.step_outcome.criterion.criterion_id, "workspace.identify_elf:lib.so");
	assert.ok(result.step_outcome.evidence_refs.some((ref) => ref.ref_type === "artifact" && ref.digest === digest(elf.toString("hex"))));
	assert.ok(result.step_outcome.evidence_refs.some((ref) => ref.ref_id === "evt_1"));
});

await testAsync("identify_elf rejects an out-of-workspace path (no escape)", async () => {
	const workspace = join(root, "ws2");
	mkdirSync(workspace, { recursive: true });
	const broker = createActionBroker({ registry: new ActionRegistry(workspaceObservationContracts()) });
	const args = { path: "../../etc/passwd" };
	const permit = permitFor(identifyElfContract, args);
	const result = await broker.invoke({ action_ref: "workspace.identify_elf", arguments: args, permit, context: { workspaceRoot: workspace } });
	assert.equal(result.status, "rejected");
	const args2 = { path: "/etc/passwd" };
	const result2 = await broker.invoke({ action_ref: "workspace.identify_elf", arguments: args2, permit: permitFor(identifyElfContract, args2), context: { workspaceRoot: workspace } });
	assert.equal(result2.status, "rejected");
});

await testAsync("identify_elf keeps a non-ELF target as unknown, not failure", async () => {
	const workspace = join(root, "ws3");
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(workspace, "notes.txt"), "just some text, definitely not an executable");
	const broker = createActionBroker({ registry: new ActionRegistry(workspaceObservationContracts()) });
	const args = { path: "notes.txt" };
	const permit = permitFor(identifyElfContract, args);
	const result = await broker.invoke({ action_ref: "workspace.identify_elf", arguments: args, permit, context: { workspaceRoot: workspace, action_event_id: "evt_txt" } });
	assert.equal(result.status, "unknown");
	assert.equal(result.failure_mode, "insufficient_evidence");
	assert.equal(result.observation.value.format, "not_elf");
	assert.equal(result.step_outcome.status, "unknown");
	assert.equal(result.observation.verified, false);
});

await testAsync("identify_elf refuses a missing file at recognition", async () => {
	const workspace = join(root, "ws4");
	mkdirSync(workspace, { recursive: true });
	const broker = createActionBroker({ registry: new ActionRegistry(workspaceObservationContracts()) });
	const args = { path: "nope.bin" };
	const result = await broker.invoke({ action_ref: "workspace.identify_elf", arguments: args, permit: permitFor(identifyElfContract, args), context: { workspaceRoot: workspace } });
	assert.equal(result.status, "rejected");
});

await testAsync("a changed target makes the old observation stale", async () => {
	const workspace = join(root, "ws5");
	mkdirSync(workspace, { recursive: true });
	const target = join(workspace, "prog");
	writeFileSync(target, syntheticElfHeader({ bits: 64, machine_id: 0x3e, type_id: 2 }));
	const broker = createActionBroker({ registry: new ActionRegistry(workspaceObservationContracts()) });
	const args = { path: "prog" };
	const result = await broker.invoke({ action_ref: "workspace.identify_elf", arguments: args, permit: permitFor(identifyElfContract, args), context: { workspaceRoot: workspace } });
	assert.equal(result.status, "success");
	assert.equal(isElfObservationCurrent(result.observation, workspace).current, true);
	writeFileSync(target, syntheticElfHeader({ bits: 32, machine_id: 0x28, type_id: 2 }));
	const stale = isElfObservationCurrent(result.observation, workspace);
	assert.equal(stale.current, false);
	assert.match(stale.reason, /changed/);
});

// ---------------------------------------------------------------------------
// 3. Registered script actions
// ---------------------------------------------------------------------------

let scriptDir = null;
function makeScript(name, body) {
	scriptDir = scriptDir ?? join(root, "bin");
	mkdirSync(scriptDir, { recursive: true });
	const path = join(scriptDir, name);
	writeFileSync(path, body, { mode: 0o755 });
	return path;
}

// A self-contained interpreter registration: the interpreter is `process.execPath`
// (pinned by digest) and the SCRIPT body is pinned separately by `script_digest`.
function interpreterRegistration({ id, body, timeout_ms = 5000, verify, parameters = {}, argvExtra = [] }) {
	const script = makeScript(`${id}.js`, body);
	return {
		schema_version: "1.0",
		id,
		version: 1,
		executable: process.execPath,
		executable_digest: executableDigest(process.execPath),
		script_path: script,
		script_digest: executableDigest(script),
		argv_template: [script, ...argvExtra],
		allowed_root: root,
		cwd: root,
		parameters,
		timeout_ms,
		verify,
	};
}

test("no script configuration means unconfigured, never self-registered", () => {
	const registry = createScriptRegistry();
	assert.equal(registry.configured, false);
	assert.equal(registry.get("anything", 1), null);
});

test("a shell interpreter is refused at registration", () => {
	assert.throws(
		() =>
			createScriptRegistry({
				scripts: [
					{ schema_version: "1.0", id: "bad", version: 1, executable: "/bin/sh", executable_digest: `sha256:${"0".repeat(64)}`, argv_template: ["-c", "echo hi"], allowed_root: root, cwd: root, parameters: {}, verify: () => ({ ok: true }) },
				],
			}),
		/shell interpreter/,
	);
});

test("an eval/shell token in the argv template is refused", () => {
	const executable = makeScript("ok-tool", "#!/bin/true\n");
	assert.throws(
		() =>
			createScriptRegistry({
				scripts: [{ schema_version: "1.0", id: "evalish", version: 1, executable, executable_digest: executableDigest(executable), argv_template: ["-e", "{x}"], allowed_root: root, cwd: root, parameters: { x: { type: "string" } }, verify: () => ({ ok: true }) }],
			}),
		/forbidden eval\/shell token/,
	);
});

test("argv is built only from registered parameters", () => {
	const executable = makeScript("argv-tool", "#!/bin/true\n");
	const registration = {
		schema_version: "1.0",
		id: "argv",
		version: 1,
		executable,
		executable_digest: executableDigest(executable),
		argv_template: ["inspect", "--path", "{path}"],
		allowed_root: root,
		cwd: root,
		parameters: { path: { type: "string", required: true } },
		verify: () => ({ ok: true }),
	};
	assert.equal(buildArgv(registration, { path: "a/b" }).ok, true);
	assert.deepEqual(buildArgv(registration, { path: "a/b" }).argv, ["inspect", "--path", "a/b"]);
	assert.equal(buildArgv(registration, { path: "a/b", evil: "rm -rf /" }).ok, false);
	assert.equal(buildArgv(registration, {}).ok, false);
});

await testAsync("a registered script runs with no shell and is oracle-verified", async () => {
	const registration = interpreterRegistration({
		id: "emit",
		body: 'console.log("VALUE=42");\n',
		verify: ({ observed }) => ({ ok: /VALUE=42/.test(observed.stdout_excerpt), reason: "stdout carries the expected value", expected: "VALUE=42", observed: observed.stdout_excerpt.trim() }),
	});
	const registry = createScriptRegistry({ scripts: [registration] });
	assert.equal(registry.configured, true);
	const contract = createScriptContract(registration);
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const result = await broker.invoke({ action_ref: contract.id, arguments: {}, permit: permitFor(contract, {}), context: { workspaceRoot: root, action_event_id: "evt_script" } });
	assert.equal(result.status, "success", JSON.stringify(result.verification));
	assert.equal(result.transport.exit_code, 0);
	assert.equal(result.attempts, 1);
	assert.equal(result.observation.value.attempts, 1);
	assert.equal(result.observation.value.retry_allowed, false);
});

await testAsync("an oracle that rejects the post-state yields unknown, not success", async () => {
	const registration = interpreterRegistration({
		id: "nope",
		body: 'console.log("VALUE=0");\n',
		verify: ({ observed }) => ({ ok: /VALUE=42/.test(observed.stdout_excerpt), reason: "expected VALUE=42" }),
	});
	const contract = createScriptContract(registration);
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const result = await broker.invoke({ action_ref: contract.id, arguments: {}, permit: permitFor(contract, {}), context: { workspaceRoot: root } });
	assert.equal(result.status, "unknown");
	assert.equal(result.transport.tool_ok, true, "the process exit was 0; the transport fact is preserved");
	assert.equal(result.failure_mode, "insufficient_evidence");
});

await testAsync("a non-zero exit is preserved as transport, and the oracle still decides", async () => {
	const registration = interpreterRegistration({
		id: "fails",
		body: "process.exit(3);\n",
		verify: () => ({ ok: false, reason: "postcondition not met" }),
	});
	const contract = createScriptContract(registration);
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const result = await broker.invoke({ action_ref: contract.id, arguments: {}, permit: permitFor(contract, {}), context: { workspaceRoot: root } });
	assert.equal(result.status, "unknown");
	assert.equal(result.transport.exit_code, 3, "the non-zero exit code is preserved as a transport fact");
	assert.equal(result.transport.tool_ok, false, "a non-zero exit is not a transport success");
});

await testAsync("a script whose postcondition holds despite a non-zero exit is verified", async () => {
	// The process exits non-zero, but the real post-state file was written, so the
	// registered oracle can still confirm success. Exit code is NOT the verdict.
	const outPath = join(root, "marker.txt");
	const registration = interpreterRegistration({
		id: "partial",
		body: `require("node:fs").writeFileSync(${JSON.stringify(outPath)}, "done"); process.exit(2);\n`,
		verify: () => ({ ok: existsSync(outPath), reason: "marker file exists", observed: outPath }),
	});
	const contract = createScriptContract(registration);
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const result = await broker.invoke({ action_ref: contract.id, arguments: {}, permit: permitFor(contract, {}), context: { workspaceRoot: root } });
	assert.equal(result.status, "success");
	assert.equal(result.transport.exit_code, 2);
	assert.equal(result.transport.tool_ok, false);
});

await testAsync("a timeout is NOT retried and is distinguished from other signals", async () => {
	const registration = interpreterRegistration({
		id: "slow",
		body: 'setTimeout(() => console.log("done"), 5000);\n',
		timeout_ms: 150,
		verify: () => ({ ok: true }),
	});
	const contract = createScriptContract(registration);
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const result = await broker.invoke({ action_ref: contract.id, arguments: {}, permit: permitFor(contract, {}), context: { workspaceRoot: root } });
	assert.equal(result.status, "unknown");
	assert.equal(result.failure_mode, "timeout");
	assert.equal(result.retry_allowed, false);
	assert.equal(result.attempts, 1);
	assert.equal(result.observation.value.timed_out, true);
});

await testAsync("a changed script body is refused until a new version and re-verification", async () => {
	const registration = interpreterRegistration({ id: "mutable", body: 'console.log("VALUE=42");\n', verify: () => ({ ok: true }) });
	const contract = createScriptContract(registration);
	writeFileSync(registration.script_path, 'console.log("VALUE=99");\n');
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const result = await broker.invoke({ action_ref: contract.id, arguments: {}, permit: permitFor(contract, {}), context: { workspaceRoot: root } });
	assert.equal(result.status, "rejected");
	assert.match(result.reason, /changed/);
});

await testAsync("the reviewed contract digest pins the script body separately from the interpreter", async () => {
	const a = createScriptContract(interpreterRegistration({ id: "pin_a", body: 'console.log("A");\n', verify: () => ({ ok: true }) }));
	const b = createScriptContract(interpreterRegistration({ id: "pin_b", body: 'console.log("B");\n', verify: () => ({ ok: true }) }));
	assert.equal(a.procedure.executable, b.procedure.executable, "the interpreter is the same");
	assert.equal(a.procedure.executable_digest, b.procedure.executable_digest);
	assert.equal(a.procedure.script_digest === b.procedure.script_digest, false, "the script bodies differ");
	assert.equal(a.implementation_digest === b.implementation_digest, false, "the pinned implementation digest must change with the script");
});

await testAsync("a changed interpreter is also refused", async () => {
	const registration = interpreterRegistration({ id: "interp", body: 'console.log("VALUE=42");\n', verify: () => ({ ok: true }) });
	const contract = createScriptContract(registration);
	contract.procedure.executable_digest = `sha256:${"0".repeat(64)}`;
	contract.implementation_digest = implementationDigest(contract.procedure);
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const result = await broker.invoke({ action_ref: contract.id, arguments: {}, permit: permitFor(contract, {}), context: { workspaceRoot: root } });
	assert.equal(result.status, "rejected");
	assert.match(result.reason, /changed/);
});

await testAsync("an interpreter registration without a pinned script is refused", async () => {
	assert.throws(
		() =>
			createScriptContract({
				schema_version: "1.0",
				id: "unpinned",
				version: 1,
				executable: process.execPath,
				executable_digest: executableDigest(process.execPath),
				argv_template: ["-e", "console.log(1)"],
				allowed_root: root,
				cwd: root,
				parameters: {},
				verify: () => ({ ok: true }),
			}),
		/an absolute script_path|script_digest|forbidden eval/,
	);
});

await testAsync("a script targeting an out-of-root cwd is refused at registration", async () => {
	const executable = process.execPath;
	assert.throws(
		() =>
			createScriptContract({
				schema_version: "1.0",
				id: "escape",
				version: 1,
				executable,
				executable_digest: executableDigest(executable),
				argv_template: [],
				allowed_root: root,
				cwd: "/",
				parameters: {},
				verify: () => ({ ok: true }),
			}),
		/cwd must be inside allowed_root/,
	);
});

// ---------------------------------------------------------------------------
// 4. Authorization
// ---------------------------------------------------------------------------

test("invalid authorization mode is refused", () => {
	assert.throws(() => createAuthorization({ mode: "unlimited" }), /mode/);
});

test("normal mode stays pending approval without a human", () => {
	const authorization = createAuthorization({ mode: "normal", workspaceRoot: root, target: root, allowedTools: ["aegis_workspace"] });
	const decision = authorizeAction(authorization, { tool: "aegis_workspace", action_ref: "workspace.identify_elf", target_path: join(root, "x"), arguments: { path: "x" } });
	assert.equal(decision.status, "pending_approval");
	assert.equal(decision.ok, false);
	assert.equal(decision.is_verification, false);
	assert.equal(decision.permit, undefined);
});

test("auto mode authorizes inside the workspace and returns a permit, not a verification", () => {
	const authorization = createAuthorization({ mode: "auto", workspaceRoot: root, target: root, allowedTools: ["aegis_workspace"] });
	const decision = authorizeAction(authorization, { tool: "aegis_workspace", action_ref: "workspace.identify_elf", target_path: join(root, "x"), arguments: { path: "x" } });
	assert.equal(decision.status, "authorized");
	assert.equal(decision.ok, true);
	assert.equal(decision.is_verification, false);
	assert.equal(decision.permit.ok, true);
	assert.equal(decision.workspace_is_sandbox, false);
});

test("auto mode refuses an out-of-workspace target", () => {
	const authorization = createAuthorization({ mode: "auto", workspaceRoot: root, allowedTools: ["aegis_workspace"] });
	const decision = authorizeAction(authorization, { tool: "aegis_workspace", target_path: "/etc/passwd", arguments: {} });
	assert.equal(decision.status, "rejected");
});

test("auto mode refuses network without explicit allow_network", () => {
	const authorization = createAuthorization({ mode: "auto", workspaceRoot: root, allowedTools: ["aegis_script"], network: false });
	const decision = authorizeAction(authorization, { tool: "aegis_script", target: "any", network: true, arguments: {} });
	assert.equal(decision.status, "rejected");
	assert.match(decision.reasons.join(" "), /network/);
});

test("auto mode refuses an unauthorized tool", () => {
	const authorization = createAuthorization({ mode: "auto", workspaceRoot: root, allowedTools: ["aegis_workspace"] });
	const decision = authorizeAction(authorization, { tool: "aegis_script", target_path: join(root, "x"), arguments: {} });
	assert.equal(decision.status, "rejected");
});

test("authorization never claims the workspace is a sandbox", () => {
	const described = describeAuthorization(createAuthorization({ mode: "auto", workspaceRoot: root, allowedTools: ["aegis_workspace"] }));
	assert.equal(described.workspace_is_sandbox, false);
});

await testAsync("broker re-derives authorization and ignores a forged permit", async () => {
	const contract = sampleContract();
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	// A hand-built permit that would pass the permit re-check on its own.
	const forged = permitFor(contract, { target: "A" });
	// The supplied authorization, however, does NOT authorize this tool.
	const authorization = createAuthorization({ mode: "auto", workspaceRoot: root, target: root, allowedTools: ["some_other_tool"] });
	const result = await broker.invoke({
		action_ref: contract.id,
		arguments: { target: "A" },
		permit: forged,
		authorization,
		context: { workspaceRoot: root, target_path: join(root, "x") },
		state: { ready: true },
	});
	assert.equal(result.status, "rejected");
	assert.match(result.reason, /authorization/);
});

await testAsync("broker runs when the re-derived authorization grants the permit", async () => {
	const contract = sampleContract();
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const authorization = createAuthorization({ mode: "auto", workspaceRoot: root, target: root, allowedTools: [contract.tool] });
	const result = await broker.invoke({
		action_ref: contract.id,
		arguments: { target: "A" },
		authorization,
		context: { workspaceRoot: root, target_path: join(root, "x") },
		state: { ready: true },
	});
	assert.equal(result.status, "success", JSON.stringify(result));
	assert.equal(result.authorization.status, "authorized");
	assert.equal(result.authorization.is_verification, false);
});

await testAsync("a re-derived permit pins the full reviewed contract, including the checker source", async () => {
	const contract = sampleContract();
	const authorization = createAuthorization({ mode: "auto", workspaceRoot: root, target: root, allowedTools: [contract.tool] });
	const decision = authorizeAction(authorization, { action_ref: contract.id, tool: contract.tool, contract, arguments: { target: "A" }, target_path: join(root, "x") });
	assert.equal(decision.status, "authorized");
	assert.equal(typeof decision.permit.contract_digest, "string");
	assert.equal(decision.permit.contract_digest, contractDigest(contract));
	// The permit is valid for the reviewed contract as-is...
	assert.equal(matchPermit(decision.permit, contract, { target: "A" }).ok, true);
	// ...but changing ONLY the verification checker source (not the procedure)
	// invalidates the outstanding permit and forces re-verification.
	contract.verification = { check: () => ({ ok: true, reason: "silently weakened" }) };
	const after = matchPermit(decision.permit, contract, { target: "A" });
	assert.equal(after.ok, false);
	assert.match(after.reasons.join(" "), /contract_digest/);
});

await testAsync("broker refuses an expired re-derived permit", async () => {
	const contract = sampleContract();
	const broker = createActionBroker({ registry: new ActionRegistry([contract]) });
	const authorization = createAuthorization({ mode: "auto", workspaceRoot: root, target: root, allowedTools: [contract.tool] });
	const result = await broker.invoke({
		action_ref: contract.id,
		arguments: { target: "A" },
		authorization,
		context: { workspaceRoot: root, target_path: join(root, "x"), expires_at: new Date(Date.now() - 1000).toISOString() },
		state: { ready: true },
	});
	assert.equal(result.status, "rejected");
	assert.match(result.reason, /expired/);
});

// ---------------------------------------------------------------------------
// 5. Learning router
// ---------------------------------------------------------------------------

function registryWithDemo() {
	return new ActionRegistry([sampleContract()]);
}

// A trusted support resolver for the router tests. It synthesises REAL records
// for the standard `out_<n>` / `ep_<n>` / `grp_<n>` / `iso_<n>` support ids so
// that the router's "resolved support" gate can be exercised. A test that wants
// unresolved support supplies its own resolver via `environmentOver({ resolveSupport })`.
function demoSupportResolver({ kind, ref }) {
	const id = ref.ref_id ?? ref.ref_id;
	const match = /^(out|ep|grp|iso)_(\d+)$/.exec(id);
	if (!match) {
		if (kind === "replay") {
			const m = /^replay:(ep_\d+):(out_\d+)$/.exec(id);
			if (m) return { ok: true, record: { replayable: true, replay_count: 1, replay_hash: `h_${m[2]}`, episode_id: m[1] } };
		}
		return { ok: false, reason: `no demo record for ${kind}:${id}` };
	}
	const index = match[2];
	if (kind === "replay") return { ok: true, record: { replayable: true, replay_count: 1, replay_hash: `h_${index}`, episode_id: `ep_${index}` } };
	if (kind === "outcome") {
		return { ok: true, record: { outcome_id: id, status: "success", episode_id: `ep_${index}`, preconditions_verified: true, oracle: { oracle_id: "demo", method: "post_check", independence_group: `grp_${index}`, isolation_ref: `iso_${index}` } } };
	}
	if (kind === "episode") return { ok: true, record: { episode_id: id, independence_group: `grp_${index}`, isolation_ref: `iso_${index}` } };
	return { ok: false, reason: `unexpected kind ${kind}` };
}

function makeExperience({ status = "active", scopeOver = {}, whenOver, id = "exp_1", template = { target: null }, action_ref = "demo.ping", action_version = 1, implDigest = null, successCount = 2, failureIds = [], counterexamples = [], verified_counterexample = false, supportOver = {} } = {}) {
	const registry = registryWithDemo();
	const contract = registry.get(action_ref);
	return {
		experience_id: id,
		status,
		scope: { environment_fingerprint: "local", domain: "demo", permissions: ["read-only-observation"], task_types: ["identify"], ...scopeOver },
		when: whenOver ?? [{ path: "ready", op: "eq", value: true, verified_by: ["out_ref_1"] }],
		do: { action_ref, action_version, implementation_digest: implDigest ?? contract.implementation_digest, arguments_template: template },
		support: {
			success_outcome_ids: Array.from({ length: successCount }, (_, index) => `out_${index}`),
			run_ids: Array.from({ length: successCount }, (_, index) => `run_${index}`),
			episode_ids: Array.from({ length: successCount }, (_, index) => `ep_${index}`),
			independence_groups: Array.from({ length: successCount }, (_, index) => `grp_${index}`),
			isolation_refs: Array.from({ length: successCount }, (_, index) => `iso_${index}`),
			replay_hashes: Array.from({ length: successCount }, () => `hash_same`),
			failure_outcome_ids: failureIds,
			verified_counterexample,
			...supportOver,
		},
		validation: { counterexamples },
	};
}

// `environmentOver()` now carries a trusted support resolver: the router may only
// take direct/habit/hint when the claimed support resolves to real records.
function environmentOver(over = {}) {
	return { environment_fingerprint: "local", domain: "demo", permissions: ["read-only-observation"], task_types: ["identify"], resolveSupport: demoSupportResolver, ...over };
}

test("router takes the direct path with 0 LLM when everything matches", () => {
	const route = routeLearning({ experiences: [makeExperience()], task: { arguments: { target: "A" } }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.equal(route.route, "direct");
	assert.equal(route.action_ref, "demo.ping");
	assert.deepEqual(route.arguments, { target: "A" });
});

test("router never takes direct when when-predicates are unmet (hint instead)", () => {
	const route = routeLearning({ experiences: [makeExperience()], task: { arguments: { target: "A" } }, environment: environmentOver(), currentState: { ready: false }, registry: registryWithDemo() });
	assert.equal(route.route, "hint");
	assert.equal(route.experience.status, "active");
});

test("router uses habit when only parameters are missing", () => {
	const route = routeLearning({ experiences: [makeExperience()], task: { arguments: {} }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.equal(route.route, "habit");
	assert.deepEqual(route.missing_parameters, ["target"]);
	assert.equal(route.action_ref, "demo.ping");
});

test("router never uses a candidate as a hint", () => {
	const route = routeLearning({ experiences: [makeExperience({ status: "candidate" })], task: { arguments: { target: "A" } }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.equal(route.route, "deliberate");
});

test("router pauses when the registered implementation digest no longer matches (code changed)", () => {
	const route = routeLearning({ experiences: [makeExperience({ implDigest: "sha256:stale" })], task: { arguments: { target: "A" } }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.notEqual(route.route, "direct");
	assert.notEqual(route.route, "habit");
	assert.equal(route.route, "paused", "a changed implementation invalidates the verification; the binding is suspended, never silently reused");
	assert.equal(route.recoverable, true);
});

test("router pauses on an environment fingerprint change", () => {
	const route = routeLearning({ experiences: [makeExperience()], task: { arguments: { target: "A" } }, environment: environmentOver({ environment_fingerprint: "cloud" }), currentState: { ready: true }, registry: registryWithDemo() });
	assert.equal(route.route, "paused");
	assert.equal(route.recoverable, true);
});

test("router pauses on a verified counterexample and does not retire permanently", () => {
	const route = routeLearning({ experiences: [makeExperience({ counterexamples: ["out_bad"], failureIds: ["out_bad"], verified_counterexample: true })], task: { arguments: { target: "A" } }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.equal(route.route, "paused");
	assert.equal(route.recoverable, true);
});

test("router refuses on conflict between differing matching rules", () => {
	const left = makeExperience({ id: "exp_left", template: { target: "A" } });
	const right = makeExperience({ id: "exp_right", template: { target: "B" } });
	const route = routeLearning({ experiences: [left, right], task: { arguments: {} }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.equal(route.route, "refuse");
	assert.equal(route.router_decision, "conflict");
});

test("router is deliberate with no matching scope", () => {
	const route = routeLearning({ experiences: [makeExperience({ scopeOver: { domain: "other" } })], task: { arguments: { target: "A" } }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.equal(route.route, "deliberate");
});

test("router does not treat an unknown when-value as a match", () => {
	const route = routeLearning({ experiences: [makeExperience()], task: { arguments: { target: "A" } }, environment: environmentOver(), currentState: {}, registry: registryWithDemo() });
	assert.equal(route.route, "hint");
	assert.notEqual(route.route, "direct");
});

test("router does not treat an absent field as a verified neq", () => {
	// currentState has NO `mode` field, so `mode neq 'x'` is UNKNOWN, not a match.
	const when = [{ path: "mode", op: "neq", value: "x", verified_by: ["out_ref_1"] }];
	const route = routeLearning({ experiences: [makeExperience({ whenOver: when })], task: { arguments: { target: "A" } }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.notEqual(route.route, "direct");
	const candidate = route.candidates[0];
	assert.equal(candidate.when.known, false);
	assert.equal(candidate.when.ok, false);
});

test("router does not go direct when action_version is unpinned", () => {
	const experience = makeExperience();
	delete experience.do.action_version;
	const route = routeLearning({ experiences: [experience], task: { arguments: { target: "A" } }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.notEqual(route.route, "direct");
	assert.equal(route.candidates[0].binding_ok, false);
	assert.equal(route.route, "paused");
});

test("router does not go direct when implementation_digest is unpinned", () => {
	const experience = makeExperience();
	delete experience.do.implementation_digest;
	const route = routeLearning({ experiences: [experience], task: { arguments: { target: "A" } }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.notEqual(route.route, "direct");
	assert.equal(route.route, "paused");
});

test("router does not go direct on an extra/unknown argument", () => {
	const route = routeLearning({ experiences: [makeExperience()], task: { arguments: { target: "A", surprise: true } }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.notEqual(route.route, "direct");
	assert.equal(route.route, "deliberate");
});

test("router does not go direct on a wrong-typed argument", () => {
	const route = routeLearning({ experiences: [makeExperience()], task: { arguments: { target: 17 } }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.notEqual(route.route, "direct");
	assert.equal(route.route, "deliberate");
});

test("router goes habitual, not direct, when a required argument is missing", () => {
	const route = routeLearning({ experiences: [makeExperience()], task: { arguments: {} }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.equal(route.route, "habit");
	assert.deepEqual(route.missing_parameters, ["target"]);
});

test("router refuses to go direct when a template literal conflicts with the task argument", () => {
	const route = routeLearning({ experiences: [makeExperience({ template: { target: "fixed" } })], task: { arguments: { target: "A" } }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.notEqual(route.route, "direct");
});

test("router does not accept a count-only support as independent", () => {
	// Two outcome ids but ONE run/episode/group/nonce/hash: a single proof, not two.
	const supportOver = { run_ids: ["run_1"], episode_ids: ["ep_1"], independence_groups: ["grp_1"], reset_nonces: ["nonce_1"], replay_hashes: ["hash_1"] };
	const route = routeLearning({ experiences: [makeExperience({ supportOver })], task: { arguments: { target: "A" } }, environment: environmentOver(), currentState: { ready: true }, registry: registryWithDemo() });
	assert.notEqual(route.route, "direct");
	const independent = route.candidates[0].reliability.find((check) => check.name === "independent_support");
	assert.equal(independent.ok, false);
});

// ---------------------------------------------------------------------------
// 6. Experience compiler
//
// B2 hardening: the compiler now REQUIRES a trusted resolver that returns the
// REAL Outcome/Episode/action/replay records. The old tests supplied fabricated
// `reproducibility.replayable/replay_hash/replay_count` and a digest-only
// artifact resolver; those are no longer accepted as proof. Each `proof()` below
// registers its real records in COMPILER_STORE so the resolver can confirm them.
// ---------------------------------------------------------------------------

const COMPILER_STORE = { outcomes: new Map(), episodes: new Map(), replays: new Map(), artifacts: new Map() };

function registerReplay(episode, outcomeId, replay) {
	COMPILER_STORE.replays.set(`replay:${episode}:${outcomeId}`, replay);
}

function proof({ run = "run_1", episode = "ep_1", group = "grp_1", nonce = "n_1", hash = "h_1", scope, when, doSpec, status = "success", evidenceRefs, outcomeId = `out_${episode}`, replayable = true, replayCount = 1, expect, isolation } = {}) {
	const registry = registryWithDemo();
	const contract = registry.get("demo.ping");
	const scopeValue = scope ?? { environment_fingerprint: "local", domain: "demo", permissions: ["read-only-observation"], task_types: ["identify"] };
	const isolationRef = isolation ?? `iso_${episode}`;
	const refs = evidenceRefs ?? [{ ref_type: "artifact", ref_id: "readme.txt", digest: digest("readme") }];
	// Register the REAL records the resolver will return.
	COMPILER_STORE.episodes.set(episode, { episode_id: episode, run_id: run, independence_group: group, isolation_ref: isolationRef, source_kind: "live", scope: scopeValue });
	COMPILER_STORE.outcomes.set(outcomeId, {
		outcome_id: outcomeId,
		status,
		episode_id: episode,
		run_id: run,
		observed: status === "success" ? { ok: true } : null,
		preconditions_verified: status === "success",
		criterion: { criterion_id: "demo.criterion", expected: { pong: true } },
		expect: expect ?? [{ path: "pong", op: "eq", value: true }],
		evidence_refs: refs,
		oracle: { oracle_id: "demo-oracle", method: "post_check", independence_group: group, isolation_ref: isolationRef },
	});
	for (const ref of refs) {
		const key = `${ref.ref_type ?? ref.type}:${ref.ref_id ?? ref.id}`;
		COMPILER_STORE.artifacts.set(key, ref.digest ?? null);
	}
	registerReplay(episode, outcomeId, { replayable, replay_count: replayCount, replay_hash: hash, episode_id: episode, isolation_ref: isolationRef });
	return {
		run_id: run,
		episode_id: episode,
		outcome_id: outcomeId,
		scope: scopeValue,
		when: when ?? [{ path: "ready", op: "eq", value: true, verified_by: [`${episode}_ref`] }],
		do: doSpec ?? { action_ref: "demo.ping", action_version: 1, implementation_digest: contract.implementation_digest, arguments_template: { target: null } },
	};
}

function compileEnv(registry = registryWithDemo()) {
	return { environment_fingerprint: "local", domain: "demo", permissions: ["read-only-observation"], task_types: ["identify"], registry };
}

// The trusted support resolver for compiler tests. It confirms the registered
// REAL Outcome/Episode/action/replay records and matches artifact digests.
function supportResolver({ kind, ref }) {
	if (kind === "outcome") return COMPILER_STORE.outcomes.has(ref.ref_id) ? { ok: true, record: COMPILER_STORE.outcomes.get(ref.ref_id) } : { ok: false, reason: "no such outcome", content_digest: undefined };
	if (kind === "episode") return COMPILER_STORE.episodes.has(ref.ref_id) ? { ok: true, record: COMPILER_STORE.episodes.get(ref.ref_id) } : { ok: false, reason: "no such episode" };
	if (kind === "replay") return COMPILER_STORE.replays.has(ref.ref_id) ? { ok: true, record: COMPILER_STORE.replays.get(ref.ref_id) } : { ok: false, reason: "no such replay" };
	if (kind === "action") {
		// The action execution must confirm the pinned version. Use the first proof's
		// contract version (the compiler checks it against the registered one).
		const contract = registryWithDemo().get(ref.ref_id) ?? null;
		if (!contract) return { ok: false, reason: "no such action" };
		return { ok: true, record: { action_ref: ref.ref_id, version: contract.version, status: "completed", episode_id: ref.episode_id ?? null } };
	}
	const key = `${ref.ref_type ?? ref.type}:${ref.ref_id ?? ref.id}`;
	// A ref that is NOT registered resolves only when it is a real artifact with
	// a matching digest — otherwise it is a dangling reference.
	if (COMPILER_STORE.artifacts.has(key)) {
		const stored = COMPILER_STORE.artifacts.get(key);
		if (ref.digest && stored !== ref.digest) return { ok: false, reason: "content digest mismatch" };
		return { ok: true, record: { ref: key }, content_digest: stored ?? undefined };
	}
	return { ok: false, reason: "no such ref" };
}

function compile(proofs, environment = compileEnv(), extra = {}) {
	return compileExperience({ proofs, environment, resolveSupport: supportResolver, ...extra });
}

test("compiler activates only with two independent RESOLVED replayable proofs", () => {
	const result = compile([proof({ episode: "ep_1", group: "grp_1", hash: "h_1" }), proof({ episode: "ep_2", group: "grp_2", hash: "h_2" })]);
	assert.equal(result.status, "active", JSON.stringify(result.failures));
	assert.equal(result.experience.support.success_outcome_ids.length, 2);
	assert.equal(result.experience.when.length, 1);
	// Full MEMORY_SCHEMA §6.2 fields are present, not a reduced shape.
	assert.ok(result.experience.expect.length > 0, "expect postconditions are required");
	assert.equal(result.experience.provenance.compiled_by, "aegis-experience-compiler");
	assert.equal(typeof result.experience.provenance.compiler_version, "string");
	assert.equal(result.experience.revision, 1);
	assert.equal(typeof result.experience.created_at, "string");
	assert.equal(typeof result.experience.updated_at, "string");
});

test("compiler stays candidate with a single proof", () => {
	const result = compile([proof()]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("min_proofs"));
});

test("compiler does not count two proofs from the same episode/group/isolation", () => {
	const result = compile([proof({ episode: "ep_1", group: "grp_1", hash: "h_1" }), proof({ episode: "ep_1", group: "grp_1", hash: "h_2" })]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("independence"));
});

test("compiler rejects an unknown-status proof", () => {
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1" }), proof({ episode: "e2", group: "g2", hash: "h2", status: "unknown" })]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("proof_success"));
});

test("compiler rejects a failed proof even if replay hashes differ", () => {
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1" }), proof({ episode: "e2", group: "g2", hash: "h2", status: "failure" })]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("proof_success"));
});

test("compiler rejects an argument swap across proofs", () => {
	const contract = registryWithDemo().get("demo.ping");
	const left = proof({ episode: "e1", group: "g1", hash: "h1" });
	const right = proof({ episode: "e2", group: "g2", hash: "h2", doSpec: { action_ref: "demo.ping", action_version: 1, implementation_digest: contract.implementation_digest, arguments_template: { target: "other" } } });
	const result = compile([left, right]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("same_action"));
});

test("compiler rejects a stale implementation digest", () => {
	const doSpec = { action_ref: "demo.ping", action_version: 1, implementation_digest: "sha256:stale", arguments_template: { target: null } };
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1", doSpec }), proof({ episode: "e2", group: "g2", hash: "h2", doSpec })]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("implementation_digest"));
});

test("compiler rejects an unpinned action version", () => {
	const doSpec = { action_ref: "demo.ping", implementation_digest: registryWithDemo().get("demo.ping").implementation_digest, arguments_template: { target: null } };
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1", doSpec }), proof({ episode: "e2", group: "g2", hash: "h2", doSpec })]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("action_version"));
});

test("compiler rejects an unpinned implementation digest", () => {
	const doSpec = { action_ref: "demo.ping", action_version: 1, arguments_template: { target: null } };
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1", doSpec }), proof({ episode: "e2", group: "g2", hash: "h2", doSpec })]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("implementation_digest"));
});

test("compiler rejects an unresolved evidence ref (a digest string is not a record)", () => {
	// A ref whose record is NOT registered anywhere: the resolver refuses it, so
	// the ref stays dangling even though it carries a digest string.
	const bad = { ref_type: "artifact", ref_id: "missing", digest: digest("missing") };
	const proofs = [proof({ episode: "e1", group: "g1", hash: "h1", evidenceRefs: [bad] }), proof({ episode: "e2", group: "g2", hash: "h2", evidenceRefs: [bad] })];
	const rejectMissing = ({ kind, ref }) => (kind === "artifact" && ref.ref_id === "missing" ? { ok: false, reason: "no such record" } : supportResolver({ kind, ref }));
	const result = compileExperience({ proofs, environment: compileEnv(), resolveSupport: rejectMissing });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("evidence_refs"));
});

test("compiler will not activate without a trusted resolver", () => {
	const proofs = [proof({ episode: "e1", group: "g1", hash: "h1" }), proof({ episode: "e2", group: "g2", hash: "h2" })];
	const result = compileExperience({ proofs, environment: compileEnv() });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("proof_resolvable"));
	assert.ok(result.experience.failure_rules.includes("evidence_resolver"));
});

test("compiler rejects a proof artifact whose real content digest differs from the ref", () => {
	// The resolver returns a mismatching content digest for the registered ref.
	const liar = ({ kind, ref }) => (kind === "artifact" ? { ok: true, record: {}, content_digest: digest("tampered") } : supportResolver({ kind, ref }));
	const proofs = [proof({ episode: "e1", group: "g1", hash: "h1" }), proof({ episode: "e2", group: "g2", hash: "h2" })];
	const result = compileExperience({ proofs, environment: compileEnv(), resolveSupport: liar });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("evidence_refs"));
});

test("compiler rejects a proof from a different environment", () => {
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1" }), proof({ episode: "e2", group: "g2", hash: "h2" })], { ...compileEnv(), environment_fingerprint: "elsewhere" });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("scope_current"));
});

test("compiler rejects an unverified when-predicate", () => {
	const when = [{ path: "ready", op: "eq", value: true }];
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1", when }), proof({ episode: "e2", group: "g2", hash: "h2", when })]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("when_verified"));
});

test("compiler rejects a wildcard when-value", () => {
	const when = [{ path: "ready", op: "eq", value: "any", verified_by: ["r1"] }];
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1", when }), proof({ episode: "e2", group: "g2", hash: "h2", when })]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("when_not_wildcard"));
});

test("compiler rejects a when predicate that does not hold in every episode (no fictitious world)", () => {
	// Episode e1 proves `ready==true`; e2 proves `armed==true`. The union would be
	// a world where both hold, which no episode ever verified. It must stay candidate.
	const whenA = [{ path: "ready", op: "eq", value: true, verified_by: ["a"] }];
	const whenB = [{ path: "armed", op: "eq", value: true, verified_by: ["b"] }];
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1", when: whenA }), proof({ episode: "e2", group: "g2", hash: "h2", when: whenB })]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("when_not_common"));
	assert.equal(result.experience.when.length, 0);
});

test("compiler requires verified expect postconditions from every episode", () => {
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1", expect: [] }), proof({ episode: "e2", group: "g2", hash: "h2", expect: [] })]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("expect_present"));
});

test("compiler refuses a copied already-active do-clause", () => {
	const existing = [{ status: "active", do: { action_ref: "demo.ping", action_version: 1, arguments_template: { target: null } } }];
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1" }), proof({ episode: "e2", group: "g2", hash: "h2" })], compileEnv(), { existingExperiences: existing });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("not_copied"));
});

test("compiler does NOT require distinct replay hashes (identical results are fine)", () => {
	const result = compile([proof({ episode: "e1", group: "g1", hash: "same", isolation: "iso_1" }), proof({ episode: "e2", group: "g2", hash: "same", isolation: "iso_2" })]);
	assert.equal(result.status, "active", JSON.stringify(result.failures));
});

test("compiler rejects a proof whose resolved replay_count is 0", () => {
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1", replayCount: 0 }), proof({ episode: "e2", group: "g2", hash: "h2" })]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("replay_proof"));
});

test("compiler rejects a non-replayable proof", () => {
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1", replayable: false }), proof({ episode: "e2", group: "g2", hash: "h2" })]);
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("replay_proof"));
});

test("compiler will not count a superseded outcome", () => {
	const result = compile([proof({ episode: "e1", group: "g1", hash: "h1", outcomeId: "out_old" }), proof({ episode: "e2", group: "g2", hash: "h2" })], compileEnv(), { supersededOutcomeIds: ["out_old"] });
	assert.equal(result.status, "candidate");
	assert.ok(result.experience.failure_rules.includes("superseded_not_counted"));
});

test("compiler records supersedes without double counting", () => {
	const result = compile(
		[proof({ episode: "e1", group: "g1", hash: "h1", outcomeId: "out_new" }), proof({ episode: "e2", group: "g2", hash: "h2" })],
		compileEnv(),
		{ supersedes: { superseding_outcome_id: "out_new", superseded_experience_id: "exp_old" } },
	);
	assert.equal(result.status, "active", JSON.stringify(result.failures));
	assert.equal(result.experience.validation.superseded, "exp_old");
});

// ---------------------------------------------------------------------------
// 7. Contribution / data use stage
//
// B2 hardening: a stage is verified only when a trusted resolver returns the
// REAL data record (same episode), the REAL completed action whose final bound
// arguments reference the data, and a REAL trusted stage Outcome naming BOTH.
// The old `data_obtained:true` boolean and a caller-supplied `status:"success"`
// outcome are no longer proof.
// ---------------------------------------------------------------------------

const dataRef = { ref_type: "data", ref_id: "dataset_1", digest: digest("rows") };
const actionRef = { ref_type: "action", ref_id: "evt_run_1" };

function contributionStore(over = {}) {
	return {
		data: { dataset_1: { episode_id: "ep_1", digest: digest("rows") } },
		action: { evt_run_1: { status: "completed", episode_id: "ep_1", bound_arguments: [dataRef] } },
		outcome: { out_1: { outcome_id: "out_1", episode_id: "ep_1", status: "success", oracle: { oracle_id: "demo", method: "post_check" }, evidence_refs: [dataRef, actionRef] } },
		...over,
	};
}
function contributionResolver(store) {
	return ({ kind, ref }) => {
		const bucket = kind === "action" ? store.action : kind === "outcome" ? store.outcome : store.data;
		const record = bucket[ref.ref_id];
		if (!record) return { ok: false, reason: `no ${kind}` };
		if (kind === "data") return { ok: true, record, content_digest: record.digest ?? undefined };
		return { ok: true, record };
	};
}
function contributionInput(store, over = {}) {
	return { episode_id: "ep_1", dataRef, actionRef, useRefs: [dataRef], stage: "use", resolveSupport: contributionResolver(store), outcome: { outcome_id: "out_1" }, ...over };
}

test("a self-report with no action ref is only self_reported", () => {
	const record = recordStageContribution(contributionInput(contributionStore(), { actionRef: null, self_reported: true }));
	assert.equal(record.status, "self_reported");
	assert.equal(record.stage_useful, false);
	assert.equal(record.causal, false);
	assert.equal(record.association_only, true);
});

test("a use claim with no trusted resolver is unknown, never verified", () => {
	const record = recordStageContribution(contributionInput(contributionStore(), { resolveSupport: null }));
	assert.equal(record.status, "unknown");
});

test("an unverified outcome leaves the stage unknown", () => {
	const store = contributionStore({ outcome: { out_1: { outcome_id: "out_1", episode_id: "ep_1", status: "unknown", evidence_refs: [dataRef, actionRef] } } });
	const record = recordStageContribution(contributionInput(store));
	assert.equal(record.status, "unknown");
});

test("a stage outcome must be an independent oracle/human judgment", () => {
	const store = contributionStore({ outcome: { out_1: { outcome_id: "out_1", episode_id: "ep_1", status: "success", evidence_refs: [dataRef, actionRef] } } });
	const record = recordStageContribution(contributionInput(store));
	assert.equal(record.status, "unknown");
});

test("a verified outcome must reference BOTH data and action", () => {
	const store = contributionStore({ outcome: { out_1: { outcome_id: "out_1", episode_id: "ep_1", status: "success", oracle: { oracle_id: "demo", method: "post_check" }, evidence_refs: [actionRef] } } });
	const record = recordStageContribution(contributionInput(store));
	assert.equal(record.status, "unknown");
	assert.ok(record.reasons.some((reason) => reason.field === "outcome"));
});

test("a stage outcome from a different episode is unknown", () => {
	const store = contributionStore({ outcome: { out_1: { outcome_id: "out_1", episode_id: "ep_9", status: "success", oracle: { oracle_id: "demo", method: "post_check" }, evidence_refs: [dataRef, actionRef] } } });
	const record = recordStageContribution(contributionInput(store));
	assert.equal(record.status, "unknown");
});

test("an action that never completed cannot verify a use stage", () => {
	const store = contributionStore({ action: { evt_run_1: { status: "pending", episode_id: "ep_1", bound_arguments: [dataRef] } } });
	const record = recordStageContribution(contributionInput(store));
	assert.equal(record.status, "unknown");
});

test("an action whose final bound arguments do not reference the data cannot verify a use stage", () => {
	const store = contributionStore({ action: { evt_run_1: { status: "completed", episode_id: "ep_1", bound_arguments: [] } } });
	const record = recordStageContribution(contributionInput(store));
	assert.equal(record.status, "unknown");
});

test("a superseded stage outcome cannot verify a stage", () => {
	const record = recordStageContribution(contributionInput(contributionStore(), { supersededOutcomeIds: ["out_1"] }));
	assert.equal(record.status, "unknown");
});

test("a properly resolved verified outcome is verified_use, still association-only", () => {
	const record = recordStageContribution(contributionInput(contributionStore()));
	assert.equal(record.status, "verified_use");
	assert.equal(record.stage_useful, true);
	assert.equal(record.data_obtained, true);
	assert.equal(record.action_completed, true);
	assert.equal(record.action_uses_data, true);
	assert.equal(record.association_only, true);
	assert.equal(record.causal, false, "a verified use stage is an association, never a causal claim");
});

test("contribution payload targets runtime.note, not a new event schema", () => {
	const record = recordStageContribution(contributionInput(contributionStore()));
	const payload = contributionPayload(record);
	assert.equal(payload.event_type, "runtime.note");
	assert.equal(payload.kind, "contribution.recorded");
	assert.equal(payload.causal, false);
});

test("data usefulness requires all three stages independently verified", () => {
	// Each stage resolves its own data ref, completed action and trusted outcome.
	const stageStore = (dataId, actionId, outcomeId) => ({
		data: { [dataId]: { episode_id: "ep_1", digest: digest(dataId) } },
		action: { [actionId]: { status: "completed", episode_id: "ep_1", bound_arguments: [{ ref_type: "data", ref_id: dataId, digest: digest(dataId) }] } },
		outcome: { [outcomeId]: { outcome_id: outcomeId, episode_id: "ep_1", status: "success", oracle: { oracle_id: "demo", method: "post_check" }, evidence_refs: [{ ref_type: "data", ref_id: dataId, digest: digest(dataId) }, { ref_type: "action", ref_id: actionId }] } },
	});
	const verified = (stage, dataId, actionId) => {
		const store = stageStore(dataId, actionId, `out_${stage}`);
		return recordStageContribution({ episode_id: "ep_1", dataRef: { ref_type: "data", ref_id: dataId, digest: digest(dataId) }, actionRef: { ref_type: "action", ref_id: actionId }, useRefs: [{ ref_type: "data", ref_id: dataId }], stage, resolveSupport: contributionResolver(store), outcome: { outcome_id: `out_${stage}` } });
	};
	const obtain = verified("obtain", "raw", "act_obtain");
	const use = verified("use", "dataset_1", "evt_run_1");
	const partial = dataUsefulness([obtain, use]);
	assert.equal(partial.fully_useful, false);
	assert.equal(partial.first_gap_stage, "advance");
	const advance = verified("advance", "out_data", "act_advance");
	assert.equal(dataUsefulness([obtain, use, advance]).fully_useful, true);
});

// ---------------------------------------------------------------------------

console.log("");
if (failures.length > 0) {
	console.error(`${failures.length} batch-B test(s) failed`);
	process.exit(1);
}
console.log(`ok batch-b memory runtime: ${sha256Hex("batch-b").slice(0, 8)} all assertions passed`);
