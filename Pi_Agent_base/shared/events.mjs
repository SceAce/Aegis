// Aegis runtime Event log: single-writer, append-only, hash-chained, replayable.
//
// This is the authoritative coordination source for the runtime:
// `Event -> Episode -> Outcome -> Experience`. It never rewrites history and
// never decides task success. Rejected/duplicate writes are reported, not
// silently dropped.
//
// Honest durability boundary: `appendFile` alone only hands bytes to the OS; a
// process crash or power loss can still lose them. This log therefore opens the
// file once, writes the row, and calls `fsync` on the file descriptor before it
// reports `{ok:true}`. Only after that fsync does a caller receive permission to
// run a side effect. If fsync is unavailable or fails, the write is reported as
// NOT durable and the log is marked unhealthy (fail-closed), never silently
// treated as flushed. Directory-entry durability (fsync of the parent dir after
// first creation) is performed once when the file is created; a crash between
// create and that dirsync can lose the whole new file, which is why a fresh
// log's first append also dir-syncs before reporting ok.
//
// Writes are serialized inside one EventLog instance and across processes by
// an adjacent `<log>.lock` file. Before every append the writer revalidates the
// current file tail and adopts any rows committed by another writer, so two Pi
// sessions sharing one campaign log cannot fork the hash chain. A stale lock is
// recoverable only when its owner is demonstrably gone (same host) or the lock
// is older than the stale threshold.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * Random, unique event/correlation id.
 *
 * `crypto.randomUUID` is used directly: it is backed by real entropy in every
 * supported Node runtime, and no sandbox we target stubs it. A defensive
 * random-bytes/constant-detection fallback was removed because it added
 * unsupported complexity without changing behaviour that matters here; if an
 * environment ever stubbed `randomUUID`, the event chain's duplicate-id check
 * would surface it rather than silently accept a weak id.
 */
export function eventId() {
	return randomUUID();
}

// Legacy observer events keep schema 1.0. New runtime events (proposal,
// handoff, prompt, outcome, experience decisions) are additive and use 1.1.
// `append` refuses an unknown event type unless the caller passes an explicit
// schema_version, so a new type can never silently masquerade as 1.0.
export const LEGACY_SCHEMA_VERSION = "1.0";
export const RUNTIME_SCHEMA_VERSION = "1.1";

/**
 * Schema major versions this reader/writer understands. A row carrying any
 * other major version (e.g. `2.0`) is refused, never guessed at: MEMORY_SCHEMA
 * §2.1 requires readers to reject an unknown major version.
 */
export const KNOWN_SCHEMA_VERSIONS = Object.freeze(new Set([LEGACY_SCHEMA_VERSION, RUNTIME_SCHEMA_VERSION]));

/** True when a schema_version string's major is known to this build. */
export function isKnownSchemaVersion(version) {
	if (typeof version !== "string") return false;
	if (KNOWN_SCHEMA_VERSIONS.has(version)) return true;
	// Accept only a same-major patch/minor (e.g. 1.2) of a known major.
	const major = version.split(".")[0];
	return [...KNOWN_SCHEMA_VERSIONS].some((known) => known.split(".")[0] === major);
}

/**
 * Source kinds. MEMORY_SCHEMA §3.2 enumerates agent/environment/observer/
 * oracle/replay/human. This runtime adds `runtime` and `llm` as an EXPLICIT,
 * documented compatibility extension (never a silent 1.0 value): `runtime` is
 * the trusted projection writer and `llm` is an untrusted model proposal. A
 * kind outside this table is refused at the append boundary.
 */
export const SOURCE_KINDS = Object.freeze(
	new Set(["agent", "environment", "observer", "oracle", "replay", "human", "runtime", "llm"]),
);

export function isKnownSourceKind(kind) {
	return typeof kind === "string" && SOURCE_KINDS.has(kind);
}

export const EVENT_TYPE_SCHEMA = Object.freeze({
	"session.started": LEGACY_SCHEMA_VERSION,
	"session.shutdown": LEGACY_SCHEMA_VERSION,
	"episode.started": LEGACY_SCHEMA_VERSION,
	"episode.closed": LEGACY_SCHEMA_VERSION,
	"agent.started": LEGACY_SCHEMA_VERSION,
	"agent.ended": LEGACY_SCHEMA_VERSION,
	"agent.settled": LEGACY_SCHEMA_VERSION,
	"turn.started": LEGACY_SCHEMA_VERSION,
	"turn.ended": LEGACY_SCHEMA_VERSION,
	"message.completed": LEGACY_SCHEMA_VERSION,
	"action.requested": LEGACY_SCHEMA_VERSION,
	"action.completed": LEGACY_SCHEMA_VERSION,
	"prompt.received": RUNTIME_SCHEMA_VERSION,
	"episode.paused": RUNTIME_SCHEMA_VERSION,
	"proposal.submitted": RUNTIME_SCHEMA_VERSION,
	"proposal.rejected": RUNTIME_SCHEMA_VERSION,
	"observation.captured": RUNTIME_SCHEMA_VERSION,
	"outcome.recorded": RUNTIME_SCHEMA_VERSION,
	"experience.decision": RUNTIME_SCHEMA_VERSION,
	"handoff.requested": RUNTIME_SCHEMA_VERSION,
	"handoff.rejected": RUNTIME_SCHEMA_VERSION,
	"handoff.completed": RUNTIME_SCHEMA_VERSION,
	"runtime.note": RUNTIME_SCHEMA_VERSION,
	"node.added": RUNTIME_SCHEMA_VERSION,
	// Additive runtime extension: a trusted environment change marks related
	// Fact/Refuted bindings stale (never deletes history). See MEMORY_SCHEMA_NOTES.
	"environment.changed": RUNTIME_SCHEMA_VERSION,
	// Additive runtime extension: audit that a provider-bound request was projected
	// from committed Events (RAM digest + state revision). Creates no board node and
	// does not change RuntimeState, so it cannot recurse into later RAM.
	"request.projected": RUNTIME_SCHEMA_VERSION,
});

/** Schema version for an event type, or null when the type is unknown. */
export function schemaForEventType(eventType) {
	return EVENT_TYPE_SCHEMA[eventType] ?? null;
}

export function stable(value) {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function sha256Hex(text) {
	return createHash("sha256").update(text).digest("hex");
}

export function digest(value) {
	return `sha256:${sha256Hex(stable(value))}`;
}

/** Recompute an event's digest from every field except `event_digest`. */
export function eventDigest(event) {
	const { event_digest: _ignored, ...rest } = event;
	return digest(rest);
}

export function parseJsonl(text) {
	const rows = [];
	const errors = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			rows.push(JSON.parse(line));
		} catch (error) {
			errors.push(`line ${i + 1} is not valid JSON: ${String(error)}`);
		}
	}
	return { rows, errors };
}

/**
 * Verify the append-only chain of a parsed event list.
 *
 * Checks: each `event_digest` matches its content, each `prev_event_digest`
 * points at the previous event, per-episode `sequence` increases from 0, and
 * `event_id` is unique. Returns `{ ok, errors, lastDigest, sequences }`.
 */
export function verifyChain(rows) {
	const errors = [];
	const sequences = new Map();
	const ids = new Set();
	let lastDigest;
	for (let i = 0; i < rows.length; i += 1) {
		const event = rows[i];
		if (!event || typeof event !== "object") {
			errors.push(`event[${i}] is not an object`);
			continue;
		}
		if (typeof event.event_id !== "string" || event.event_id.length === 0) {
			errors.push(`event[${i}] missing event_id`);
		} else if (ids.has(event.event_id)) {
			errors.push(`event[${i}] duplicate event_id ${event.event_id}`);
		} else {
			ids.add(event.event_id);
		}
		const expected = eventDigest(event);
		if (event.event_digest !== expected) {
			errors.push(`event[${i}] (${event.event_type}) digest mismatch`);
		}
		// Unknown event types and unknown major schema versions are refused at the
		// read boundary, so a replay cannot silently act on a version it does not
		// understand.
		if (schemaForEventType(event.event_type) === null) {
			errors.push(`event[${i}] unknown event_type ${String(event.event_type)}`);
		}
		if (!isKnownSchemaVersion(event.schema_version)) {
			errors.push(`event[${i}] unknown schema_version ${String(event.schema_version)}`);
		}
		if (!isKnownSourceKind(event.source?.kind)) {
			errors.push(`event[${i}] unknown source.kind ${String(event.source?.kind)}`);
		}
		if (lastDigest === undefined) {
			if (event.prev_event_digest !== undefined && event.prev_event_digest !== null) {
				errors.push(`event[${i}] is first but carries prev_event_digest`);
			}
		} else if (event.prev_event_digest !== lastDigest) {
			errors.push(`event[${i}] prev_event_digest does not link to the previous event`);
		}
		if (event.episode_id) {
			const next = sequences.get(event.episode_id) ?? 0;
			if (event.sequence !== next) {
				errors.push(`event[${i}] episode ${event.episode_id} sequence ${event.sequence} != expected ${next}`);
			}
			sequences.set(event.episode_id, next + 1);
		} else if (event.sequence !== null && event.sequence !== undefined) {
			errors.push(`event[${i}] has no episode_id but sequence ${event.sequence}`);
		}
		lastDigest = event.event_digest;
	}
	return { ok: errors.length === 0, errors, lastDigest, sequences, ids };
}

// In-process Host ownership seam. An SDK Observer may borrow the Host's exact
// writer, never create a competing append chain. Removal restores standalone Pi.
/** @type {Map<string, EventLog>} */
const hostLogs = new Map();
/** @param {string} path */
const hostLogKey = (path) => resolve(path);
/** @param {string} path @returns {EventLog|null} */
export function hostEventLog(path) {
	return hostLogs.get(hostLogKey(path)) ?? null;
}
/** @param {string} path @param {EventLog} log @returns {() => void} */
export function bindHostEventLog(path, log) {
	path = hostLogKey(path);
	if (hostLogs.has(path) && hostLogs.get(path) !== log) throw new Error("EventLog already owned by another Host");
	hostLogs.set(path, log);
	return () => {
		if (hostLogs.get(path) === log) hostLogs.delete(path);
	};
}

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 30_000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export class EventLog {
	/**
	 * @param {string} path append-only JSONL path
	 * @param {{onError?: (message: string) => void}} [options]
	 */
	constructor(path, options = {}) {
		this.path = path;
		this.rows = [];
		this.sequences = new Map();
		this.ids = new Set();
		this.lastDigest = undefined;
		this.healthy = false;
		this.opened = false;
		this.auditError = null;
		this.queue = Promise.resolve();
		// Last observed on-disk size/mtime. Used under the write lock to detect
		// rows committed by a different EventLog instance/process and reload them
		// before choosing the next prev_event_digest and episode sequence.
		this.diskSize = 0;
		this.diskMtimeMs = 0;
		this.diskExists = false;
		this.onError = typeof options.onError === "function" ? options.onError : null;
		// Open file descriptor reused for every durable append. `null` means the
		// log has not been opened for writing yet or was closed on failure.
		this.handle = null;
		// Whether the parent directory entry has been fsynced at least once.
		this.dirSynced = false;
		// Optional fsync hook override (tests inject a failure to prove
		// fail-closed behavior without relying on a real disk fault).
		this.fsyncHook = typeof options.sync === "function" ? options.sync : null;
		// Optional directory-fsync hook override (tests inject a failure to prove the
		// partial-durability path records the row exactly once and never reuses its
		// sequence). Defaults to the real directory fsync.
		this.dirSyncHook = typeof options.dirSync === "function" ? options.dirSync : null;
	}

	/** Load and verify an existing log. A corrupt log refuses further writes. */
	async open() {
		this.opened = true;
		try {
			return await this.withFileLock(async () => {
				const disk = await this.statLog();
				if (disk === null) {
					this.healthy = true;
					this.diskSize = 0;
					this.diskMtimeMs = 0;
					this.diskExists = false;
					return { ok: true, created: true };
				}
				const text = await readFile(this.path, "utf8");
				return this.adoptLogText(text, disk.size, disk.mtimeMs);
			});
		} catch (error) {
			this.healthy = false;
			this.auditError = `event log could not be opened at ${this.path}: ${String(error)}`;
			this.report(this.auditError);
			return { ok: false, error: this.auditError };
		}
	}

	/**
	 * Serialize a read/append operation against every other EventLog instance
	 * using an adjacent exclusive lock file. The lock is held only for the
	 * operation, never for the lifetime of the instance, so a crashed session
	 * cannot permanently block the campaign log.
	 */
	async withFileLock(fn) {
		const lock = await this.acquireFileLock();
		try {
			return await fn();
		} finally {
			await this.releaseFileLock(lock);
		}
	}

	async acquireFileLock() {
		const lockPath = `${this.path}.lock`;
		await mkdir(dirname(this.path), { recursive: true });
		const token = randomUUID();
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			let created = false;
			try {
				const handle = await open(lockPath, "wx");
				created = true;
				try {
					await handle.write(
						JSON.stringify({ token, pid: process.pid, host: hostname(), at: Date.now() }),
						null,
						"utf8",
					);
				} finally {
					await handle.close().catch(() => undefined);
				}
				return { lockPath, token };
			} catch (error) {
				// If this attempt created the lock but failed before returning it,
				// remove our own orphan; never remove an EEXIST holder's file.
				if (created) await unlink(lockPath).catch(() => undefined);
				if (error?.code !== "EEXIST") {
					throw new Error(`event log lock could not be created at ${lockPath}: ${String(error)}`);
				}
				if (await this.breakStaleFileLock(lockPath)) continue;
				if (Date.now() >= deadline) {
					throw new Error(`timed out waiting for event log lock at ${lockPath}`);
				}
				await sleep(LOCK_RETRY_MS);
			}
		}
	}

	async breakStaleFileLock(lockPath) {
		let owner = null;
		let mtimeMs = 0;
		try {
			const [raw, info] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
			mtimeMs = info.mtimeMs;
			try {
				owner = JSON.parse(raw);
			} catch {
				// A writer may have created the lock but not written its owner record yet.
			}
		} catch (error) {
			// The holder released while we were inspecting it; retry immediately.
			return error?.code === "ENOENT";
		}
		const ownerAt = Number(owner?.at);
		const age = Date.now() - (Number.isFinite(ownerAt) ? ownerAt : mtimeMs);
		const sameHost = owner?.host === hostname();
		let alive = null;
		if (sameHost && Number.isInteger(owner?.pid)) {
			try {
				process.kill(owner.pid, 0);
				alive = true;
			} catch (error) {
				// EPERM means the process exists but belongs to another user.
				alive = error?.code === "EPERM";
			}
		}
		// Never steal a lock whose owner is alive on this host, even if a slow
		// fsync takes longer than the fallback age threshold. For a remote/unknown
		// owner, age is the only liveness signal available.
		const stale = sameHost ? alive === false : age > LOCK_STALE_MS;
		if (stale) {
			try {
				await unlink(lockPath);
				return true;
			} catch (error) {
				return error?.code === "ENOENT";
			}
		}
		return false;
	}

	async releaseFileLock(lock) {
		try {
			const owner = JSON.parse(await readFile(lock.lockPath, "utf8"));
			// Never unlink a lock that a stale-recovery competitor now owns.
			if (owner?.token === lock.token) await unlink(lock.lockPath);
		} catch {
			// Already released or replaced; nothing to do.
		}
	}

	async statLog() {
		try {
			const info = await stat(this.path);
			return { size: info.size, mtimeMs: info.mtimeMs };
		} catch (error) {
			if (error?.code === "ENOENT") return null;
			throw error;
		}
	}

	/**
	 * Adopt a verified on-disk snapshot. Called under the file lock during open
	 * and whenever an append observes that another writer changed the file.
	 */
	adoptLogText(text, size, mtimeMs) {
		const { rows, errors: parseErrors } = parseJsonl(text);
		const verification = verifyChain(rows);
		if (!verification.ok) {
			this.healthy = false;
			this.auditError = `event log chain is corrupt at ${this.path}: ${[...parseErrors, ...verification.errors].slice(0, 5).join("; ")}`;
			this.report(this.auditError);
			return { ok: false, error: this.auditError };
		}
		if (parseErrors.length > 0) {
			// Trailing partial line: treat as corruption so we never append after it.
			this.healthy = false;
			this.auditError = `event log has unparseable lines at ${this.path}: ${parseErrors.slice(0, 3).join("; ")}`;
			this.report(this.auditError);
			return { ok: false, error: this.auditError };
		}
		this.rows = rows;
		this.sequences = verification.sequences;
		this.ids = verification.ids;
		this.lastDigest = verification.lastDigest;
		this.diskSize = size;
		this.diskMtimeMs = mtimeMs;
		this.diskExists = true;
		this.healthy = true;
		return { ok: true, recovered: rows.length };
	}

	/**
	 * Re-read the log if another writer appended since our last observation.
	 * The caller must hold the file lock. A changed-but-corrupt tail is fatal,
	 * never silently appended over.
	 */
	async refreshFromDisk() {
		const disk = await this.statLog();
		if (disk === null) {
			// A never-created log is still valid: the first append creates it while
			// holding this lock. Once a file has existed, disappearance is corruption
			// and must not be papered over by starting a new chain.
			if (!this.diskExists && this.diskSize === 0) return { ok: true };
			this.healthy = false;
			this.auditError = `event log disappeared at ${this.path}`;
			this.report(this.auditError);
			return { ok: false, error: this.auditError };
		}
		if (disk.size === this.diskSize && disk.mtimeMs === this.diskMtimeMs) return { ok: true };
		const text = await readFile(this.path, "utf8");
		return this.adoptLogText(text, disk.size, disk.mtimeMs);
	}

	/**
	 * Open (creating if needed) the append handle. Returns the FileHandle or an
	 * error string. The handle is cached until a write/fsync failure closes it.
	 */
	async openHandle() {
		if (this.handle) return { ok: true, handle: this.handle };
		try {
			await mkdir(dirname(this.path), { recursive: true });
			const existed = await readFile(this.path, "utf8").then(
				() => true,
				(error) => !(error && error.code === "ENOENT"),
			);
			const handle = await open(this.path, "a");
			this.handle = handle;
			this.dirSynced = existed;
			return { ok: true, handle };
		} catch (error) {
			this.handle = null;
			return { ok: false, error: `event log could not be opened at ${this.path}: ${String(error)}` };
		}
	}

	/** fsync the parent directory so a newly created log file survives a crash. */
	async ensureDirDurable() {
		if (this.dirSynced) return { ok: true };
		let dirHandle;
		try {
			dirHandle = await open(dirname(this.path), "r");
			if (this.dirSyncHook) await this.dirSyncHook(dirHandle);
			else await dirHandle.sync();
			this.dirSynced = true;
			return { ok: true };
		} catch (error) {
			// Directory fsync is not supported on every platform/filesystem. That is a
			// weaker guarantee for the very first append only; report it explicitly so
			// callers are not told a durability level that was not achieved.
			return {
				ok: false,
				error: `event log directory could not be fsynced at ${dirname(this.path)}: ${String(error)}`,
			};
		} finally {
			if (dirHandle) await dirHandle.close().catch(() => undefined);
		}
	}

	/** fsync the open file descriptor; a failure is fatal (fail-closed). */
	async syncFile(handle) {
		if (this.fsyncHook) await this.fsyncHook(handle);
		else await handle.sync();
	}

	report(message) {
		if (this.onError) this.onError(message);
	}

	/**
	 * Append one event. Returns `{ok:true, event}` or `{ok:false, error}`.
	 * `source` should carry `{actor_id, kind, adapter, version}`; `kind` is the
	 * trust label the board reducer uses to gate fact writes.
	 */
	async append({
		event_type,
		episode_id = null,
		payload = {},
		source = { actor_id: "pi", kind: "runtime", adapter: "aegis-runtime", version: "0.1.0" },
		evidence_refs = [],
		causation_id,
		schema_version,
		occurred_at,
	} = {}) {
		if (typeof event_type !== "string" || event_type.length === 0) {
			return { ok: false, error: "event_type is required" };
		}
		// Known event types only. An event type outside the registered table is
		// refused even if a schema_version is supplied: compatibility must be a
		// deliberate table entry, not an ad-hoc string. (An explicit
		// schema_version can only select the major of a KNOWN type.)
		const knownSchema = schemaForEventType(event_type);
		if (knownSchema === null) {
			return {
				ok: false,
				error: `unknown event_type "${event_type}"; register it in EVENT_TYPE_SCHEMA with an explicit schema_version before writing`,
			};
		}
		if (schema_version !== undefined && !isKnownSchemaVersion(schema_version)) {
			return { ok: false, error: `unknown schema_version "${schema_version}"; this build cannot write it` };
		}
		if (source && !isKnownSourceKind(source.kind)) {
			return {
				ok: false,
				error: `unknown source.kind "${String(source?.kind)}"; register it explicitly before writing`,
			};
		}
		const effectiveSchema = schema_version ?? knownSchema;
		const run = this.queue.then(async () => {
			if (!this.healthy) {
				return { ok: false, error: this.auditError || "event log is not healthy" };
			}
			try {
				return await this.withFileLock(async () => {
					// Another process may have committed rows after we opened. Adopt
					// that tail BEFORE choosing the event's prev digest/sequence.
					const refreshed = await this.refreshFromDisk();
					if (!refreshed.ok) return refreshed;
					const now = new Date().toISOString();
					const event = {
						schema_version: effectiveSchema,
						event_id: eventId(),
						event_type,
						episode_id: episode_id || null,
						sequence: episode_id ? (this.sequences.get(episode_id) ?? 0) : null,
						occurred_at: occurred_at || now,
						recorded_at: now,
						source,
						payload,
						correlation_id: episode_id || "session",
						...(causation_id ? { causation_id } : {}),
						evidence_refs,
						...(this.lastDigest ? { prev_event_digest: this.lastDigest } : {}),
					};
					event.event_digest = eventDigest(event);
					// Durable write: create/open the handle, append the row, fsync the file,
					// and (for a newly created log) fsync the parent directory. Only then is
					// the caller allowed to treat the audit row as persisted.
					const opened = await this.openHandle();
					if (!opened.ok) {
						this.auditError = opened.error;
						this.healthy = false;
						this.report(this.auditError);
						return { ok: false, error: this.auditError };
					}
					try {
						await opened.handle.write(`${JSON.stringify(event)}\n`, null, "utf8");
						await this.syncFile(opened.handle);
					} catch (error) {
						this.auditError = `event log write/fsync failed at ${this.path}: ${String(error)}`;
						this.healthy = false;
						try {
							await opened.handle.close();
						} catch {
							// ignore
						}
						this.handle = null;
						this.report(this.auditError);
						return { ok: false, error: this.auditError };
					}
					// Refresh the on-disk size/mtime used by the next writer. If stat
					// fails, keep the old values: the next append will notice a size
					// mismatch and re-read the tail rather than reusing this digest.
					try {
						const disk = await this.statLog();
						if (disk) {
							this.diskSize = disk.size;
							this.diskMtimeMs = disk.mtimeMs;
							this.diskExists = true;
						}
					} catch {
						// A stat failure must not turn a committed row into a retryable
						// failure; the next refresh will re-read the file.
					}
					// First creation: fsync the directory entry so the file itself survives.
					if (!this.dirSynced) {
						const dir = await this.ensureDirDurable();
						if (!dir.ok) {
							// The row IS written and file-synced, but the new directory entry is
							// not durable. Do NOT return before recording the row in-memory: a
							// retry would otherwise reuse this event's sequence/prev_digest and
							// append a second row that corrupts the on-disk chain. Record the
							// event, then fail closed so no caller treats it as durable, and no
							// further append is attempted on this log.
							this.rows.push(event);
							this.ids.add(event.event_id);
							if (event.episode_id)
								this.sequences.set(event.episode_id, (this.sequences.get(event.episode_id) ?? 0) + 1);
							this.lastDigest = event.event_digest;
							this.auditError = dir.error;
							this.healthy = false;
							this.report(this.auditError);
							return { ok: false, error: this.auditError, event, durable: false };
						}
					}
					this.rows.push(event);
					this.ids.add(event.event_id);
					if (event.episode_id) this.sequences.set(event.episode_id, (this.sequences.get(event.episode_id) ?? 0) + 1);
					this.lastDigest = event.event_digest;
					return { ok: true, event, durable: true };
				});
			} catch (error) {
				this.auditError = `event log append failed at ${this.path}: ${String(error)}`;
				this.healthy = false;
				this.report(this.auditError);
				return { ok: false, error: this.auditError };
			}
		});
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Deterministic replay snapshot. */
	replay() {
		return this.rows.slice();
	}

	isAuditAvailable() {
		return this.healthy;
	}

	lastFailure() {
		return this.auditError;
	}

	/**
	 * Close the append handle. The audit guarantee only holds while the log is
	 * open; close is best-effort bookkeeping, not a durability operation.
	 */
	async close() {
		if (!this.handle) return;
		try {
			await this.handle.close();
		} catch {
			// ignore close failure
		}
		this.handle = null;
	}
}
