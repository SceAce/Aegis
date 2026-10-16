// First safe information action: identify a workspace file as ELF and report its
// architecture and bitness by parsing the actual file bytes.
//
// Honest boundary:
//   * only a strict, local workspace target is accepted; the path is resolved
//     with the same `resolveInside` boundary the fixture uses, so absolute
//     paths, `..` and symlink escapes are refused (action_rejected);
//   * the header is parsed directly from the real bytes (no shell, no network,
//     no `readelf` subprocess). A missing / truncated / non-ELF / out-of-bounds
//     target is `unknown` or `rejected`; the bitness is NEVER predicted;
//   * a verified observation records the file digest and a target fingerprint,
//     so a later target change makes the old observation stale and drops it from
//     the current view instead of silently reusing it.
//
// The module returns `observation.captured` / `outcome.recorded` payloads for
// the Observer's ONE EventLog. It does not write them.

import { existsSync, readFileSync, statSync } from "node:fs";
import { digest } from "../shared/contracts.mjs";
import { resolveInside } from "../shared/contracts.mjs";
import { defineContract, newOutcomeId } from "./action-contract.mjs";

export const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
export const MAX_ELF_FILE_BYTES = 64 * 1024 * 1024;
export const ELF_MACHINES = {
	0x00: "none",
	0x02: "sparc",
	0x03: "x86",
	0x08: "mips",
	0x14: "powerpc",
	0x15: "powerpc64",
	0x16: "powerpc64",
	0x28: "arm",
	0x2a: "superh",
	0x32: "ia64",
	0x3e: "x86_64",
	0xb7: "aarch64",
	0xf3: "riscv",
};

export const ELF_FILE_TYPES = {
	0: "none",
	1: "relocatable",
	2: "executable",
	3: "shared",
	4: "core",
};

/** Parse an ELF header directly from a Buffer. Never guesses on bad input. */
export function parseElfHeader(buffer) {
	if (!Buffer.isBuffer(buffer)) return { ok: false, reason: "not_a_buffer", detail: "input is not a Buffer" };
	if (buffer.length > MAX_ELF_FILE_BYTES) return { ok: false, reason: "too_large", detail: `target is ${buffer.length} bytes, over the ${MAX_ELF_FILE_BYTES} byte limit` };
	if (buffer.length < 16) return { ok: false, reason: "truncated", detail: `only ${buffer.length} bytes available; need at least 16` };
	for (let index = 0; index < ELF_MAGIC.length; index += 1) {
		if (buffer[index] !== ELF_MAGIC[index]) return { ok: false, reason: "not_elf", detail: "ELF magic does not match" };
	}
	const eiClass = buffer[4];
	const eiData = buffer[5];
	if (eiClass !== 1 && eiClass !== 2) return { ok: false, reason: "not_elf", detail: `unknown ELF class ${eiClass}` };
	if (eiData !== 1 && eiData !== 2) return { ok: false, reason: "not_elf", detail: `unknown ELF data encoding ${eiData}` };
	const minHeader = eiClass === 1 ? 52 : 64;
	if (buffer.length < minHeader) {
		return { ok: false, reason: "truncated", detail: `ELF${eiClass === 1 ? "32" : "64"} header needs ${minHeader} bytes, only ${buffer.length} available` };
	}
	const little = eiData === 1;
	const readU16 = (offset) => (little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
	const eType = readU16(16);
	const eMachine = readU16(18);
	const header = buffer.subarray(0, minHeader);
	return {
		ok: true,
		format: "ELF",
		bits: eiClass === 1 ? 32 : 64,
		endianness: little ? "little" : "big",
		machine: ELF_MACHINES[eMachine] ?? `unknown(0x${eMachine.toString(16)})`,
		machine_id: eMachine,
		file_type: ELF_FILE_TYPES[eType] ?? `unknown(${eType})`,
		type_id: eType,
		os_abi: buffer[7],
		header_bytes: minHeader,
		header_hex: header.toString("hex"),
		header_digest: digest(header.toString("hex")),
	};
}

/**
 * Build a synthetic, in-memory ELF target description from raw header
 * attributes. The header is always built from the EXPLICIT fields; nothing is
 * inferred or guessed.
 */
export function syntheticElfHeader({ bits = 64, endianness = "little", machine_id = 0x3e, type_id = 2, os_abi = 0 } = {}) {
	const little = endianness === "little";
	const size = bits === 32 ? 52 : 64;
	const buffer = Buffer.alloc(size);
	buffer[0] = 0x7f;
	buffer[1] = 0x45;
	buffer[2] = 0x4c;
	buffer[3] = 0x46;
	buffer[4] = bits === 32 ? 1 : 2;
	buffer[5] = little ? 1 : 2;
	buffer[6] = 1;
	buffer[7] = os_abi;
	if (little) {
		buffer.writeUInt16LE(type_id, 16);
		buffer.writeUInt16LE(machine_id, 18);
	} else {
		buffer.writeUInt16BE(type_id, 16);
		buffer.writeUInt16BE(machine_id, 18);
	}
	return buffer;
}

/**
 * Normalize a parsed header into an observation value, with the fingerprint and
 * file digest supplied by the caller (pure variant; performs no file IO).
 */
export function normalizeElfHeader(buffer, { subject = null, target_fingerprint: fingerprint = null, file_digest: fileDigest = null } = {}) {
	const parsed = parseElfHeader(buffer);
	if (!parsed.ok) {
		return { ok: false, reason: parsed.reason, detail: parsed.detail, format: parsed.reason === "not_elf" ? "not_elf" : "unknown" };
	}
	return {
		ok: true,
		subject,
		value: {
			format: parsed.format,
			bits: parsed.bits,
			endianness: parsed.endianness,
			machine: parsed.machine,
			machine_id: parsed.machine_id,
			file_type: parsed.file_type,
			type_id: parsed.type_id,
			os_abi: parsed.os_abi,
			header_bytes: parsed.header_bytes,
			header_digest: parsed.header_digest,
			file_digest: fileDigest ?? parsed.header_digest,
			size_bytes: buffer.length,
			target_fingerprint: fingerprint,
		},
	};
}

/** Stable fingerprint of the current target revision (content + size + mtime). */
export function targetFingerprint({ fileDigest, sizeBytes, mtimeMs }) {
	return digest({ file_digest: fileDigest, size_bytes: sizeBytes, mtime_ms: Math.round(mtimeMs) });
}

function readWorkspaceFile(workspaceRoot, path) {
	const absolute = resolveInside(workspaceRoot, path, { mustExist: true });
	if (!existsSync(absolute)) throw new Error(`file does not exist: ${path}`);
	const stats = statSync(absolute);
	if (!stats.isFile()) throw new Error(`target is not a regular file: ${path}`);
	if (stats.size > MAX_ELF_FILE_BYTES) throw new Error(`file is too large to identify: ${stats.size} bytes`);
	const buffer = readFileSync(absolute);
	return { absolute, stats, buffer };
}

function buildValue(parsed, { fileDigest, sizeBytes, mtimeMs }) {
	return {
		format: parsed.format,
		bits: parsed.bits,
		endianness: parsed.endianness,
		machine: parsed.machine,
		machine_id: parsed.machine_id,
		file_type: parsed.file_type,
		type_id: parsed.type_id,
		os_abi: parsed.os_abi,
		header_bytes: parsed.header_bytes,
		header_digest: parsed.header_digest,
		file_digest: fileDigest,
		size_bytes: sizeBytes,
		target_fingerprint: targetFingerprint({ fileDigest, sizeBytes, mtimeMs }),
	};
}

/**
 * Read-only workspace ELF identification contract.
 *
 * Recognition: the target resolves inside the workspace and is a regular file.
 * Procedure: parse the real header from bytes.
 * Verification: re-read the file and confirm the content digest is unchanged and
 * a fresh parse agrees with the recorded value.
 */
export const identifyElfContract = defineContract({
	id: "workspace.identify_elf",
	version: 1,
	tool: "aegis_workspace",
	operation: "identify_elf",
	description: "Identify a local workspace file's ELF format, bitness, endianness and machine by parsing its real header bytes. Read-only; no network.",
	risk_class: "observe",
	network: false,
	parameters: {
		path: { type: "string", required: true, description: "Workspace-relative path to the file to identify." },
	},
	recognition: {
		check: ({ workspaceRoot, path, arguments: args }) => {
			if (typeof workspaceRoot !== "string" || !workspaceRoot) return { ok: false, reason: "no workspace root is configured" };
			const target = path ?? args?.path;
			if (typeof target !== "string" || !target) return { ok: false, reason: "path is required" };
			try {
				const absolute = resolveInside(workspaceRoot, target, { mustExist: true });
				if (!statSync(absolute).isFile()) return { ok: false, reason: "target is not a regular file" };
				return { ok: true, target: absolute };
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : String(error) };
			}
		},
	},
	procedure: {
		kind: "function",
		run: ({ arguments: args, context }) => {
			const started = Date.now();
			let read;
			try {
				read = readWorkspaceFile(context.workspaceRoot, args.path);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// Out-of-bounds / missing is a rejection by recognition in the broker;
				// this path covers races and unreadable-but-present files.
				return { ok: false, failure_mode: "tool_error", detail: message, error: message, duration_ms: Date.now() - started };
			}
			const fileDigest = digest(read.buffer.toString("hex"));
			const parsed = parseElfHeader(read.buffer);
			if (!parsed.ok) {
				// A non-ELF file is a definite OBSERVATION (we positively determined it
				// is not ELF) but not a task success; a truncated/too-large one is
				// unknown. Both stay `unknown` at the goal level; the observation records
				// which it was.
				return {
					ok: false,
					failure_mode: "insufficient_evidence",
					detail: parsed.reason,
					timed_out: false,
					duration_ms: Date.now() - started,
					observed: { format: parsed.reason === "not_elf" ? "not_elf" : "unknown", reason: parsed.reason, file_digest: fileDigest, size_bytes: read.buffer.length, target_fingerprint: targetFingerprint({ fileDigest, sizeBytes: read.buffer.length, mtimeMs: read.stats.mtimeMs }) },
				};
			}
			return {
				ok: true,
				duration_ms: Date.now() - started,
				observed: {
					...buildValue(parsed, { fileDigest, sizeBytes: read.buffer.length, mtimeMs: read.stats.mtimeMs }),
					absolute_path: read.absolute,
				},
			};
		},
	},
	verification: {
		check: ({ observed, context }) => {
			if (!observed || typeof observed !== "object") return { ok: false, reason: "no parsed header to verify" };
			if (observed.format !== "ELF") return { ok: false, reason: `observed format is ${observed.format}` };
			let read;
			try {
				read = readWorkspaceFile(context.workspaceRoot, context.arguments?.path ?? observed.path);
			} catch (error) {
				return { ok: false, reason: `verification re-read failed: ${error instanceof Error ? error.message : String(error)}` };
			}
			const freshDigest = digest(read.buffer.toString("hex"));
			if (freshDigest !== observed.file_digest) {
				return { ok: false, reason: "target changed between parse and verification", expected: observed.file_digest, observed: freshDigest };
			}
			const reparsed = parseElfHeader(read.buffer);
			if (!reparsed.ok) return { ok: false, reason: `verification re-parse failed: ${reparsed.reason}` };
			const matches =
				reparsed.bits === observed.bits &&
				reparsed.endianness === observed.endianness &&
				reparsed.machine_id === observed.machine_id &&
				reparsed.type_id === observed.type_id;
			return {
				ok: matches,
				reason: matches ? "header re-parse agrees with the observation" : "header re-parse disagrees with the observation",
				expected: { bits: observed.bits, machine_id: observed.machine_id, type_id: observed.type_id },
				observed: { bits: reparsed.bits, machine_id: reparsed.machine_id, type_id: reparsed.type_id },
			};
		},
	},
	scope: {
		environment_fingerprint: "local-workspace",
		domain: "file.identity",
		permissions: ["read-only-observation"],
		task_types: ["identify"],
	},
	authorization: {
		target_kinds: ["workspace_file"],
		allowed_actions: ["workspace.identify_elf"],
	},
	stop_policy: { max_attempts: 1, retry: "none", timeout_ms: 5000 },

	/** Build the normalized observation and a full step Outcome for the EventLog. */
	build: ({ observed, context, transport, verification, status, failure_mode }) => {
		const now = new Date().toISOString();
		const actionRef = context.action_event_id ?? `action:${identifyElfContract.id}@${identifyElfContract.version}`;
		const path = context.arguments?.path ?? observed?.absolute_path ?? null;
		const value = observed ?? null;
		const observation = {
			observation_kind: "file_identity",
			subject: path,
			predicate: "elf",
			value,
			source: "workspace_reader",
			verified: status === "success" && verification.ok === true,
			target_fingerprint: value?.target_fingerprint ?? null,
			// A precise, per-target scope so a later trusted `environment.changed`
			// for THIS path can mark the old Fact stale without clearing the graph.
			scope: path,
			action_ref: actionRef,
			observed_at: now,
		};
		const evidenceRefs = [];
		if (value?.file_digest) evidenceRefs.push({ ref_type: "artifact", ref_id: path, digest: value.file_digest });
		if (context.action_event_id) evidenceRefs.push({ ref_type: "action", ref_id: context.action_event_id });
		const criterion = {
			criterion_id: `workspace.identify_elf:${path ?? "unknown"}`,
			description: `workspace file ${path ?? "(unknown)"} is a valid ELF whose header parses consistently`,
			expected: { format: "ELF", header_consistent: true },
		};
		// MEMORY_SCHEMA §5.4: the Outcome OBJECT keeps `schema_version: "1.0"` so a
		// §5.2 consumer never sees an unknown version; the additive runtime fields
		// live alongside the required ones. `observed` may be null only for an
		// `unknown`/`invalid` judgement (a bare transport result is not an
		// observation); success/failure keep the real observed value.
		const stepOutcome = {
			schema_version: "1.0",
			outcome_id: newOutcomeId("out_step"),
			level: "step",
			episode_id: context.episode_id ?? null,
			step_id: context.step_id ?? `step_${identifyElfContract.id}`,
			scope: path,
			criterion,
			status,
			observed: status === "success" || status === "failure" ? value : null,
			oracle: { oracle_id: "aegis-elf-oracle", method: "direct_parse_with_recheck", version: "1.0", independence_group: context.independence_group ?? null },
			evidence_refs: evidenceRefs,
			transport,
			failure_mode: status === "success" ? null : failure_mode || "insufficient_evidence",
			preconditions_verified: true,
			// This is an OBSERVATION recheck, not an independent action replay. It is
			// replayable only in the read-only sense that the source bytes can be
			// re-read and re-parsed; replay_count stays 0 when unverified. Never claim
			// replay_count=1 merely because a registered primitive ran once.
			reproducibility: {
				replayable: status === "success",
				replay_kind: "observation_recheck",
				replay_hash: status === "success" ? value?.file_digest ?? null : null,
				replay_count: 0,
				checked_at: now,
			},
			assessed_at: now,
			action_ref: actionRef,
			action_version: identifyElfContract.version,
			implementation_digest: identifyElfContract.implementation_digest,
		};
		return { observation, step_outcome: stepOutcome };
	},
});

/**
 * True while a recorded ELF observation still matches the current file. A changed
 * file (new digest/fingerprint) makes the old observation stale, so it must not
 * enter the current RAM/fact view.
 */
export function isElfObservationCurrent(observation, workspaceRoot) {
	const value = observation?.value ?? null;
	if (!value || value.format !== "ELF") return { current: false, reason: "observation is not a successful ELF observation" };
	const path = observation.subject;
	try {
		const read = readWorkspaceFile(workspaceRoot, path);
		const fileDigest = digest(read.buffer.toString("hex"));
		if (fileDigest !== value.file_digest) return { current: false, reason: "file content changed", expected: value.file_digest, observed: fileDigest };
		const fingerprint = targetFingerprint({ fileDigest, sizeBytes: read.buffer.length, mtimeMs: read.stats.mtimeMs });
		if (fingerprint !== value.target_fingerprint) return { current: false, reason: "target fingerprint changed", expected: value.target_fingerprint, observed: fingerprint };
		return { current: true, reason: "observation matches the current target revision", fingerprint };
	} catch (error) {
		return { current: false, reason: `cannot re-read target: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Registry containing the workspace observation action(s). */
export function workspaceObservationContracts() {
	return [identifyElfContract];
}
