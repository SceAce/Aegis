// Offline tests for the batch-C verify-first action runtime adapter.
//
// These tests exercise `execution/action-runtime.mjs` directly (no Pi, no
// model, no network) and assert the negative branches the task requires:
//   * missing / foreign / non-ELF data refs are rejected
//   * param/version (digest) swap is refused and needs re-verification
//   * a symlink escape is refused
//   * normal mode without an explicit approval does NOT effect
//   * a timeout is not retried (attempts:1)
//   * an exit-0 run whose registered post-condition Oracle rejects is NOT a
//     success (a zero exit code alone is never a task verdict)
//   * a registered script whose Oracle reads the real JSON post-state IS a
//     verified success
//   * the model can never name an arbitrary executable
//
// Run:
//   node Pi_Agent_base/tests/aegis-observe-actions.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createObserveActionRuntime, observeEventPayloads, createRefResolver, inspectScriptRegistration } from "../execution/action-runtime.mjs";
import { executableDigest } from "../execution/script-registry.mjs";
import { syntheticElfHeader } from "../execution/workspace-info-actions.mjs";

let failures = 0;
function check(name, condition, detail) {
	if (condition) console.log(`ok - ${name}`);
	else {
		failures += 1;
		console.error(`not ok - ${name}${detail === undefined ? "" : `: ${detail}`}`);
	}
}

function autoRuntime(workspaceRoot, scripts = []) {
	return createObserveActionRuntime({
		workspaceRoot,
		scriptRegistrationConfig: { scripts },
		authorizationConfig: { mode: "auto", workspaceRoot, allowedTools: ["aegis_workspace", "aegis_script"], allowNetwork: false, approved: true },
	});
}

/** A script registration whose post-condition Oracle reads a JSON artifact. */
function jsonOracleRegistration({ workspaceRoot, id, scriptPath, executable, execDigest, scriptDigest, verify, argvTemplate, parameters, timeoutMs = 5000, expect = "stage.json written with ok:true" }) {
	return {
		schema_version: "1.0",
		id,
		version: 1,
		executable,
		executable_digest: execDigest,
		script_path: scriptPath,
		script_digest: scriptDigest,
		argv_template: argvTemplate,
		allowed_root: workspaceRoot,
		cwd: workspaceRoot,
		parameters,
		verify,
		expect,
		risk_class: "medium",
		timeout_ms: timeoutMs,
	};
}

async function main() {
	const base = mkdtempSync(join(tmpdir(), "aegis-observe-actions-"));
	const outside = mkdtempSync(join(tmpdir(), "aegis-outside-"));
	const workspaceRoot = join(base, "workspace");
	mkdirSync(workspaceRoot, { recursive: true });

	// --- 1. Real ELF observation (64-bit little-endian, machine 0x3e x86-64) ---
	const elfPath = join(workspaceRoot, "target.bin");
	writeFileSync(elfPath, syntheticElfHeader({ bits: 64, machine_id: 0x3e }));
	const runtime = autoRuntime(workspaceRoot);
	const elf = await runtime.run({ action_ref: "workspace.identify_elf", arguments: { path: "target.bin" }, episodeId: "ep1", actionEventId: "act1" });
	check("ELF observation succeeds and is verified", elf.status === "success" && elf.verification?.ok === true, `${elf.status} ${elf.failure_mode ?? ""}`);
	check("ELF bitness is read from the real header, not guessed", elf.observation?.value?.bits === 64 && elf.observation?.value?.machine_id === 62, JSON.stringify(elf.observation?.value));
	const payloads = observeEventPayloads(elf, { episodeId: "ep1" });
	check("a verified observation yields observation.captured + outcome.recorded", payloads.map((p) => p.event_type).join(",") === "observation.captured,outcome.recorded");
	check("the observation is marked verified", payloads[0].payload.verified === true && payloads[0].payload.refuted === false);
	check("the step outcome is a success with a criterion", payloads[1].payload.status === "success" && Boolean(payloads[1].payload.criterion));
	check("the outcome carries the action + artifact evidence refs", (payloads[1].payload.evidence_refs ?? []).some((r) => r.ref_type === "action") && (payloads[1].payload.evidence_refs ?? []).some((r) => r.ref_type === "artifact"));

	// --- 2. Non-ELF / missing / foreign refs ---
	const notElf = join(workspaceRoot, "notes.txt");
	writeFileSync(notElf, "this is not an ELF file");
	const notElfRun = await runtime.run({ action_ref: "workspace.identify_elf", arguments: { path: "notes.txt" }, episodeId: "ep1" });
	check("a non-ELF target is refused (never guessed)", notElfRun.status !== "success", JSON.stringify({ status: notElfRun.status, reason: notElfRun.reason }));
	const missingRun = await runtime.run({ action_ref: "workspace.identify_elf", arguments: { path: "nope.bin" }, episodeId: "ep1" });
	check("a missing target is refused", missingRun.status !== "success");
	const foreignRun = await runtime.run({ action_ref: "workspace.identify_elf", arguments: { path: "../escape.bin" }, episodeId: "ep1" });
	check("a path escaping the workspace is refused", foreignRun.status !== "success");

	// --- 3. Data-ref resolver: missing + digest mismatch ---
	const resolveRef = createRefResolver({ observations: new Map([["obs1", { content_digest: "sha256:abc" }]]) });
	check("resolver finds a known ref", resolveRef({ kind: "data", ref: { ref_id: "obs1" } }).ok === true);
	check("resolver rejects a missing ref", resolveRef({ kind: "data", ref: { ref_id: "ghost" } }).ok === false);
	check("resolver rejects a digest mismatch (stale/foreign data)", resolveRef({ kind: "data", ref: { ref_id: "obs1", digest: "sha256:def" } }).ok === false);
	check("resolver rejects an unsupported ref kind", resolveRef({ kind: "magic", ref: { ref_id: "obs1" } }).ok === false);

	// --- 4. Symlink escape ---
	const secret = join(outside, "secret.bin");
	writeFileSync(secret, syntheticElfHeader({ bits: 64, machine_id: 0x3e }));
	symlinkSync(secret, join(workspaceRoot, "link-out.bin"));
	const symlinkRun = await runtime.run({ action_ref: "workspace.identify_elf", arguments: { path: "link-out.bin" }, episodeId: "ep1" });
	check("a symlink escaping the workspace is refused", symlinkRun.status !== "success", JSON.stringify({ status: symlinkRun.status, reason: symlinkRun.reason }));

	// --- 5. Registered script whose Oracle reads the JSON post-state ---
	const scriptPath = join(workspaceRoot, "write-stage.mjs");
	writeFileSync(
		scriptPath,
		[
			'import { writeFileSync } from "node:fs";',
			"const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (i % 2 === 0 ? [...acc, [v.replace(/^--/, \"\"), a[i + 1]]] : acc), []));",
			'const ok = args.mode === "good";',
			'writeFileSync(args.out, JSON.stringify({ ok, stage: Number(args.stage), bits: args.bits }));',
			"process.exit(0);",
			"",
		].join("\n"),
	);
	const nodeExe = process.execPath;
	const nodeDigest = executableDigest(nodeExe);
	const scriptDigest = executableDigest(scriptPath);
	const stageParameters = { out: { type: "string", direction: "out" }, stage: { type: "number" }, bits: { type: "string" }, mode: { type: "string" } };
	// Oracle: read the REAL JSON post-state and decide success from its content.
	const goodVerify = ({ observed, context, registration }) => {
		const outIdx = observed.argv.indexOf("--out");
		const outPath = observed.argv[outIdx + 1];
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(outPath, "utf8"));
		} catch (error) {
			return { ok: false, reason: `stage file unreadable: ${String(error)}` };
		}
		if (parsed.ok !== true) return { ok: false, reason: "stage file did not report ok:true" };
		return { ok: true, reason: "post-state JSON reports the expected stage", expected: { ok: true }, observed: parsed };
	};
	const registration = jsonOracleRegistration({
		workspaceRoot,
		id: "write-stage",
		scriptPath,
		executable: nodeExe,
		execDigest: nodeDigest,
		scriptDigest,
		verify: goodVerify,
		argvTemplate: [scriptPath, "--out", "{out}", "--stage", "{stage}", "--bits", "{bits}", "--mode", "{mode}"],
		parameters: stageParameters,
	});
	const configured = autoRuntime(workspaceRoot, [registration]);
	const stageOut = join(workspaceRoot, "stage.json");
	const goodRun = await configured.run({
		action_ref: "script.write-stage",
		arguments: { out: stageOut, stage: 1, bits: "64", mode: "good" },
		episodeId: "ep1",
		actionEventId: "act-script-1",
	});
	check("a registered script with an Oracle-reading post-state is a verified success", goodRun.status === "success" && goodRun.verification?.ok === true, JSON.stringify({ status: goodRun.status, reason: goodRun.reason ?? goodRun.verification?.reason }));
	check("the script actually wrote the JSON post-state", JSON.parse(readFileSync(stageOut, "utf8")).stage === 1);
	const goodPayloads = observeEventPayloads(goodRun, { episodeId: "ep1" });
	check("the verified script yields a verified observation + success outcome", goodPayloads[0].payload.verified === true && goodPayloads[1].payload.status === "success");

	// --- 6. Exit 0 but Oracle REJECTS -> not a success ---
	writeFileSync(stageOut, "");
	const badRun = await configured.run({
		action_ref: "script.write-stage",
		arguments: { out: stageOut, stage: 2, bits: "64", mode: "bad" },
		episodeId: "ep1",
		actionEventId: "act-script-2",
	});
	check("exit 0 with a failing post-condition Oracle is NOT a success", badRun.status !== "success", JSON.stringify({ status: badRun.status, failure: badRun.failure_mode }));
	check("the zero exit code is kept as transport, not conflated with the verdict", badRun.transport?.exit_code === 0 || badRun.step_outcome?.transport?.exit_code === 0, JSON.stringify(badRun.transport ?? badRun.step_outcome?.transport));
	const badPayloads = observeEventPayloads(badRun, { episodeId: "ep1" });
	check("the failing post-condition yields NO verified observation", badPayloads[0]?.payload?.verified !== true);

	// --- 7. Param/version (digest) swap: mutate the script body ---
	const originalScriptBody = readFileSync(scriptPath, "utf8");
	writeFileSync(scriptPath, `${originalScriptBody}\n// tampered\n`);
	const swapped = inspectScriptRegistration(registration);
	check("a changed script body is detected as a pin mismatch", swapped.ok === false && /changed|re-verification/i.test(swapped.reason), swapped.reason);
	const afterSwap = autoRuntime(workspaceRoot, [registration]);
	// Re-register with the OLD digest but the NEW body: recognition must refuse.
	const swapRun = await afterSwap.run({ action_ref: "script.write-stage", arguments: { out: stageOut, stage: 3, bits: "64", mode: "good" }, episodeId: "ep1", actionEventId: "act-script-3" });
	check("running a script whose body changed since registration is refused", swapRun.status !== "success", JSON.stringify({ status: swapRun.status, reason: swapRun.reason }));
	// restore the exact original body so its pinned digest matches again
	writeFileSync(scriptPath, originalScriptBody);

	// --- 8. Timeout: not retried ---
	const sleepPath = join(workspaceRoot, "sleep.mjs");
	writeFileSync(sleepPath, 'setTimeout(() => process.exit(0), 5000);\n');
	const sleepRegistration = jsonOracleRegistration({
		workspaceRoot,
		id: "slow",
		scriptPath: sleepPath,
		executable: nodeExe,
		execDigest: nodeDigest,
		scriptDigest: executableDigest(sleepPath),
		verify: () => ({ ok: true, reason: "unreachable on timeout" }),
		argvTemplate: [sleepPath],
		parameters: {},
		timeoutMs: 250,
	});
	const slowRuntime = autoRuntime(workspaceRoot, [sleepRegistration]);
	const slowRun = await slowRuntime.run({ action_ref: "script.slow", arguments: {}, episodeId: "ep1", actionEventId: "act-slow" });
	check("a timed-out script is recorded as a timeout failure", slowRun.failure_mode === "timeout" || slowRun.transport?.failure_mode === "timeout", JSON.stringify({ status: slowRun.status, failure: slowRun.failure_mode, transport: slowRun.transport }));
	const slowTransport = slowRun.transport ?? slowRun.step_outcome?.transport ?? {};
	// A timeout is `unknown` per MEMORY_SCHEMA, so the Outcome's `observed` is null
	// (never a made-up failure value); the honest attempt/stop-policy facts live on
	// the transport record. attempts:1 + retry_allowed:false proves no silent retry.
	check(
		"a timed-out script is NOT retried (attempts:1)",
		slowRun.step_outcome?.observed === null && slowTransport.attempts === 1 && slowTransport.retry_allowed === false,
		JSON.stringify({ observed: slowRun.step_outcome?.observed, transport_attempts: slowTransport.attempts, retry_allowed: slowTransport.retry_allowed, transport: slowTransport }),
	);

	// --- 9. normal mode without approval does NOT effect ---
	const normalRuntime = createObserveActionRuntime({
		workspaceRoot,
		scriptRegistrationConfig: { scripts: [registration] },
		authorizationConfig: { mode: "normal", workspaceRoot, allowedTools: ["aegis_workspace", "aegis_script"], allowNetwork: false, approved: false },
	});
	const before = readFileSync(stageOut, "utf8");
	const pendingRun = await normalRuntime.run({ action_ref: "script.write-stage", arguments: { out: stageOut, stage: 9, bits: "64", mode: "good" }, episodeId: "ep1", actionEventId: "act-pending", approved: false });
	check("normal mode without approval does not authorize a side effect", pendingRun.status === "rejected", JSON.stringify({ status: pendingRun.status, reason: pendingRun.reason }));
	check("normal mode without approval did NOT write the post-state", readFileSync(stageOut, "utf8") === before);
	// with explicit approval it proceeds
	const approvedRun = await normalRuntime.run({ action_ref: "script.write-stage", arguments: { out: stageOut, stage: 9, bits: "64", mode: "good" }, episodeId: "ep1", actionEventId: "act-approved", approved: true });
	check("normal mode WITH an explicit approval runs the registered script", approvedRun.status === "success" && approvedRun.verification?.ok === true, JSON.stringify({ status: approvedRun.status, reason: approvedRun.reason ?? approvedRun.verification?.reason }));

	// --- 10. Unconfigured scripts + model cannot name an arbitrary executable ---
	const unconfigured = autoRuntime(workspaceRoot, []);
	const unconfiguredRun = await unconfigured.run({ action_ref: "script.anything", arguments: {}, episodeId: "ep1" });
	check("an unconfigured script runtime refuses (not_registered)", unconfiguredRun.status === "rejected" && /unknown action/.test(unconfiguredRun.reason), unconfiguredRun.reason);
	check("the catalog says scripts are not configured", unconfigured.catalog().scripts_configured === false);
	const execAttempt = await unconfigured.run({ action_ref: "/bin/rm", arguments: { path: "-rf" }, episodeId: "ep1" });
	check("an arbitrary executable path can never be named as an action", execAttempt.status === "rejected");

	// --- 11. Model-only action exposure ---
	const exposure = await configured.run({ action_ref: "workspace.something_else", arguments: {}, episodeId: "ep1" });
	check("an unknown/unexposed action id is rejected", exposure.status === "rejected");

	// --- 12. Resource (path) params are bounded inside the workspace BEFORE any effect ---
	const outsideOut = join(outside, "escape-stage.json");
	const escapeRun = await configured.run({ action_ref: "script.write-stage", arguments: { out: outsideOut, stage: 5, bits: "64", mode: "good" }, episodeId: "ep1", actionEventId: "act-escape" });
	const escapeReason = `${escapeRun.reason ?? ""} ${escapeRun.detail ?? ""} ${escapeRun.step_outcome?.failure_mode ?? ""} ${escapeRun.failure_mode ?? ""}`;
	check("an `out` path param OUTSIDE the workspace is refused before the effect", escapeRun.status !== "success" && escapeRun.step_outcome?.failure_mode === "action_rejected", JSON.stringify({ status: escapeRun.status, reason: escapeReason }));
	check("the outside workspace file was never written", (() => { try { readFileSync(outsideOut, "utf8"); return false; } catch { return true; } })());
	const dotDot = await configured.run({ action_ref: "script.write-stage", arguments: { out: "../escape.json", stage: 5, bits: "64", mode: "good" }, episodeId: "ep1", actionEventId: "act-dotdot" });
	check("an `out` path param using `..` is refused before the effect", dotDot.status !== "success" && dotDot.step_outcome?.failure_mode === "action_rejected", JSON.stringify({ status: dotDot.status, failure: dotDot.step_outcome?.failure_mode }));

	// --- 13. Data bindings: exact verified field, same-episode, current target ---
	// Build a real verified-observation data ref from the ELF run and resolve it
	// through the EVENT resolver (workspaceRoot re-checks the target fingerprint).
	const bindRuntime = autoRuntime(workspaceRoot, [registration]);
	const bindElf = await bindRuntime.run({ action_ref: "workspace.identify_elf", arguments: { path: "target.bin" }, episodeId: "ep1", actionEventId: "act-bind-elf" });
	const obsEvent = { event_id: "obs-elf-1", event_type: "observation.captured", episode_id: "ep1", payload: { ...bindElf.observation, verified: true, episode_id: "ep1" }, source: { kind: "oracle" }, evidence_refs: [{ ref_type: "artifact", ref_id: "target.bin", digest: bindElf.observation?.value?.file_digest }] };
	const elfOutcome = { event_id: "out-elf-1", event_type: "outcome.recorded", episode_id: "ep1", payload: { ...bindElf.step_outcome, evidence_refs: [{ ref_type: "data", ref_id: "obs-elf-1", digest: bindElf.observation?.value?.file_digest }] }, source: { kind: "oracle" } };
	const events = [
		{ event_id: "req-elf", event_type: "action.requested", episode_id: "ep1", payload: { action_id: "act-bind-elf", tool_name: "aegis_observe" }, source: { kind: "runtime" } },
		obsEvent,
		elfOutcome,
	];
	const eventResolver = bindRuntime.buildEventResolver({ events });
	const dataRef = { ref_type: "data", ref_id: "obs-elf-1", digest: bindElf.observation?.value?.file_digest };
	const boundStageOut = join(workspaceRoot, "stage-bound.json");
	const boundRun = await bindRuntime.run({
		action_ref: "script.write-stage",
		arguments: { out: boundStageOut, stage: 7, mode: "good" },
		data_bindings: { bits: { ref_type: "data", ref_id: "obs-elf-1", field: "bits", digest: bindElf.observation?.value?.file_digest } },
		episodeId: "ep1",
		actionEventId: "act-bound",
		resolver: eventResolver,
	});
	check("a data_binding resolves the exact verified observed field into the final args", boundRun.status === "success" && boundRun.final_arguments?.bits === "64", JSON.stringify({ status: boundRun.status, final: boundRun.final_arguments, reason: boundRun.reason }));
	check("the bound ref is logged as a real use_ref (not a hardcoded bitness)", (boundRun.use_refs ?? []).some((r) => r.ref_id === "obs-elf-1"));
	check("the stage Outcome names the bound data ref", (boundRun.step_outcome?.evidence_refs ?? []).some((r) => r.ref_type === "data" && r.ref_id === "obs-elf-1"));
	// contradicting explicit argument
	const contradict = await bindRuntime.run({ action_ref: "script.write-stage", arguments: { out: boundStageOut, stage: 8, bits: "32", mode: "good" }, data_bindings: { bits: { ref_type: "data", ref_id: "obs-elf-1", field: "bits" } }, episodeId: "ep1", actionEventId: "act-contradict", resolver: eventResolver });
	check("a binding that CONTRADICTS an explicit argument is refused", contradict.status === "rejected" && /contradicts/.test(contradict.reason ?? ""), JSON.stringify({ status: contradict.status, reason: contradict.reason }));
	// foreign / missing ref
	const foreignRef = await bindRuntime.run({ action_ref: "script.write-stage", arguments: { out: boundStageOut, stage: 8 }, data_bindings: { bits: { ref_type: "data", ref_id: "ghost", field: "bits" } }, episodeId: "ep1", actionEventId: "act-foreign", resolver: eventResolver });
	check("a FOREIGN/missing data ref is refused", foreignRef.status === "rejected" && /no data record|did not resolve/.test(foreignRef.reason ?? ""), JSON.stringify({ status: foreignRef.status, reason: foreignRef.reason }));
	// wrong field
	const badField = await bindRuntime.run({ action_ref: "script.write-stage", arguments: { out: boundStageOut, stage: 8 }, data_bindings: { bits: { ref_type: "data", ref_id: "obs-elf-1", field: "nope" } }, episodeId: "ep1", actionEventId: "act-field", resolver: eventResolver });
	check("binding a field the observation does not contain is refused", badField.status === "rejected" && /missing from the resolved data/.test(badField.reason ?? ""), JSON.stringify({ status: badField.status, reason: badField.reason }));
	// STALE ref: the target changed since the observation.
	const staleObservation = { event_id: "obs-stale", event_type: "observation.captured", episode_id: "ep1", payload: { ...bindElf.observation, value: { ...bindElf.observation.value, file_digest: "sha256:stale" }, verified: true, episode_id: "ep1" }, source: { kind: "oracle" }, evidence_refs: [{ ref_type: "artifact", ref_id: "target.bin", digest: "sha256:stale" }] };
	const staleResolver = bindRuntime.buildEventResolver({ events: [...events, staleObservation] });
	const stale = await bindRuntime.run({ action_ref: "script.write-stage", arguments: { out: boundStageOut, stage: 8 }, data_bindings: { bits: { ref_type: "data", ref_id: "obs-stale", field: "bits" } }, episodeId: "ep1", actionEventId: "act-stale", resolver: staleResolver });
	check("a STALE data ref (target changed) is refused, not silently reused", stale.status === "rejected" && /changed|stale/.test(stale.reason ?? ""), JSON.stringify({ status: stale.status, reason: stale.reason }));
	// CROSS-EPISODE ref
	const crossEpisode = { event_id: "obs-ep2", event_type: "observation.captured", episode_id: "ep2", payload: { ...bindElf.observation, verified: true, episode_id: "ep2" }, source: { kind: "oracle" }, evidence_refs: [{ ref_type: "artifact", ref_id: "target.bin", digest: bindElf.observation?.value?.file_digest }] };
	const crossResolver = bindRuntime.buildEventResolver({ events: [...events, crossEpisode] });
	const cross = await bindRuntime.run({ action_ref: "script.write-stage", arguments: { out: boundStageOut, stage: 8 }, data_bindings: { bits: { ref_type: "data", ref_id: "obs-ep2", field: "bits" } }, episodeId: "ep1", actionEventId: "act-cross", resolver: crossResolver });
	check("a CROSS-EPISODE data ref is refused before the effect", cross.status === "rejected" && /different episode/.test(cross.reason ?? ""), JSON.stringify({ status: cross.status, reason: cross.reason }));
	// unverified observation
	const unverifiedObservation = { event_id: "obs-unverified", event_type: "observation.captured", episode_id: "ep1", payload: { ...bindElf.observation, verified: false, episode_id: "ep1" }, source: { kind: "runtime" }, evidence_refs: [{ ref_type: "artifact", ref_id: "target.bin", digest: bindElf.observation?.value?.file_digest }] };
	const unverifiedResolver = bindRuntime.buildEventResolver({ events: [...events, unverifiedObservation] });
	const unverified = await bindRuntime.run({ action_ref: "script.write-stage", arguments: { out: boundStageOut, stage: 8 }, data_bindings: { bits: { ref_type: "data", ref_id: "obs-unverified", field: "bits" } }, episodeId: "ep1", actionEventId: "act-unverified", resolver: unverifiedResolver });
	check("an UNVERIFIED data ref is refused", unverified.status === "rejected" && /not a same-episode verified observation/.test(unverified.reason ?? ""), JSON.stringify({ status: unverified.status, reason: unverified.reason }));

	console.log("");
	rmSync(base, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	if (failures > 0) {
		console.error(`aegis-observe-actions FAILED (${failures} check${failures === 1 ? "" : "s"})`);
		process.exitCode = 1;
		return;
	}
	console.log("aegis-observe-actions ok");
}

main().catch((error) => {
	console.error(`aegis-observe-actions: ${error instanceof Error ? error.stack || error.message : String(error)}`);
	process.exitCode = 1;
});
