// Aegis Campaign C1-C — single-writer ownership and checkpoint cache.
//
// One Campaign has ONE private runtime directory and ONE live writer. The lock is
// a small JSON file created atomically with `wx`; it records the owner id and the
// owning OS PID. A second live writer is always refused.
//
// Reclamation is deliberately conservative and SINGLE-HOST:
//   * a lock whose recorded PID is not alive may be reclaimed;
//   * a lock whose PID IS alive is NEVER preempted by lease expiry alone (a slow
//     but live writer still owns the Campaign);
//   * when liveness cannot be established (no pid recorded, or an error) we FAIL
//     CLOSED and refuse, rather than risk two writers.
//
// This is NOT a distributed lease. It is honest single-host ownership for the
// first implementation. The checkpoint is a DELETABLE derived cache: it binds the
// Manifest digest, the last committed event digest and the revision, and is
// ignored/rebuilt whenever it is corrupt, foreign, ahead, or missing.

import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

import { digest } from "../shared/contracts.mjs";

export const OWNERSHIP_SCHEMA_VERSION = "1.0";
export const CHECKPOINT_SCHEMA_VERSION = "1.0";
export const PROJECTION_VERSION = "1.0.0";

/** The private runtime directory for one Campaign under a base directory. */
export function campaignRuntimeDir(baseDir, campaignId) {
	if (typeof baseDir !== "string" || typeof campaignId !== "string") {
		throw new TypeError("campaignRuntimeDir requires (baseDir, campaignId) strings");
	}
	return join(baseDir, campaignId);
}

function lockPath(baseDir, campaignId) {
	// The single-writer lock is a DIRECTORY: `mkdir` is atomic on POSIX, so exactly
	// one process can create it. The owner record lives inside as `owner.json`.
	return join(campaignRuntimeDir(baseDir, campaignId), "owner.lock");
}

function lockRecordPath(baseDir, campaignId) {
	return join(lockPath(baseDir, campaignId), "owner.json");
}

function checkpointPath(baseDir, campaignId) {
	return join(campaignRuntimeDir(baseDir, campaignId), "checkpoint.json");
}

/** True when a PID is alive. `process.kill(pid, 0)` is the portable probe. */
export function defaultIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but we may not signal it -> alive.
		return error && error.code === "EPERM";
	}
}

function writeFileAtomic(path, text) {
	const dir = join(path, "..");
	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const fd = openSync(tmp, "w");
	try {
		writeSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

function writeLockRecord(baseDir, campaignId, record) {
	writeFileAtomic(lockRecordPath(baseDir, campaignId), `${JSON.stringify(record)}\n`);
}

function readLockRecord(baseDir, campaignId) {
	const path = lockRecordPath(baseDir, campaignId);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined; // present but corrupt
	}
}

/**
 * Try to acquire the single-writer lock for a Campaign.
 *
 * @returns {{ok: boolean, ownerId: string, path: string, reason?: string, reclaimed?: boolean, tombstone?: string}}
 */
export function acquireCampaignOwnership(baseDir, campaignId, options = {}) {
	const ownerId = options.ownerId ?? String(process.pid);
	const pid = options.pid ?? process.pid;
	const isAlive = typeof options.isAlive === "function" ? options.isAlive : defaultIsAlive;
	const path = lockPath(baseDir, campaignId);
	mkdirSync(campaignRuntimeDir(baseDir, campaignId), { recursive: true });

	const record = { schema_version: OWNERSHIP_SCHEMA_VERSION, campaign_id: campaignId, owner_id: ownerId, pid };

	// Fast path: atomically create the lock DIRECTORY.
	try {
		mkdirSync(path);
	} catch (error) {
		if (!error || error.code !== "EEXIST") {
			return { ok: false, ownerId, path, reason: `could not create owner lock: ${String(error)}` };
		}
		return reclaimOrRefuse({ baseDir, campaignId, ownerId, isAlive, record, path });
	}
	try {
		writeLockRecord(baseDir, campaignId, record);
	} catch (error) {
		try {
			unlinkSync(lockRecordPath(baseDir, campaignId));
			rmdirSync(path);
		} catch {
			// ignore
		}
		return { ok: false, ownerId, path, reason: `could not write owner record: ${String(error)}` };
	}
	return { ok: true, ownerId, path };
}

/**
 * The lock exists. Inspect the owner and reclaim ONLY when it is provably dead,
 * using an atomic rename so two concurrent reclaimers cannot both win.
 */
function reclaimOrRefuse({ baseDir, campaignId, ownerId, isAlive, record, path }) {
	const existing = readLockRecord(baseDir, campaignId);
	if (existing === undefined) {
		return { ok: false, ownerId, path, reason: "owner lock record is corrupt; refusing to reclaim" };
	}
	if (existing && existing.owner_id === ownerId) {
		return { ok: true, ownerId, path }; // idempotent re-acquire by the same owner
	}
	if (existing?.campaign_id && existing.campaign_id !== campaignId) {
		return { ok: false, ownerId, path, reason: `owner lock belongs to campaign ${existing.campaign_id}` };
	}
	const existingPid = existing?.pid;
	if (!Number.isInteger(existingPid) || isAlive(existingPid) !== false) {
		return {
			ok: false,
			ownerId,
			path,
			reason: `campaign is owned by ${String(existing?.owner_id)} (pid ${String(existingPid)}); a live/indeterminate owner is never preempted`,
		};
	}
	// Atomic reclaim: rename the stale lock dir to a UNIQUE tombstone. Exactly one
	// concurrent reclaimer can rename it; the others get ENOENT and fail closed.
	// Atomic reclaim via a single claim file. Only the process that CREATES the
	// claim (`wx`) may rename the stale lock and recreate it; every other racer
	// fails closed. This prevents two reclaimers from both renaming/recreating.
	const claimPath = `${path}.reclaim`;
	let claimFd;
	try {
		claimFd = openSync(claimPath, "wx");
	} catch (error) {
		return { ok: false, ownerId, path, reason: `another reclaimer holds the claim: ${String(error)}` };
	}
	try {
		writeSync(claimFd, `${ownerId}\n`);
	} finally {
		closeSync(claimFd);
	}
	try {
		// Re-read after winning the claim: another racer may have replaced the lock
		// between our inspection and the claim. If the owner is now live, stop.
		const current = readLockRecord(baseDir, campaignId);
		const currentPid = current?.pid;
		if (!Number.isInteger(currentPid) || isAlive(currentPid) !== false) {
			return {
				ok: false,
				ownerId,
				path,
				reason: `lock owner changed to a live/indeterminate owner ${String(current?.owner_id)}; not reclaiming`,
			};
		}
		const tombstone = `${path}.stale-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		try {
			renameSync(path, tombstone);
		} catch (error) {
			return { ok: false, ownerId, path, reason: `lost the reclaim race: ${String(error)}` };
		}
		try {
			mkdirSync(path);
		} catch (error) {
			return { ok: false, ownerId, path, reason: `reclaimed but could not recreate the lock: ${String(error)}` };
		}
		writeLockRecord(baseDir, campaignId, record);
		return { ok: true, ownerId, path, reclaimed: true, tombstone };
	} finally {
		try {
			unlinkSync(claimPath);
		} catch {
			// ignore
		}
	}
}

/** Release the lock only if `ownerId` still owns it. Never deletes a newer owner's lock. */
export function releaseCampaignOwnership(baseDir, campaignId, options = {}) {
	const ownerId = options.ownerId ?? String(process.pid);
	const path = lockPath(baseDir, campaignId);
	if (!existsSync(path)) return { ok: true, released: false };
	const existing = readLockRecord(baseDir, campaignId);
	if (existing === undefined) return { ok: false, reason: "owner lock record is corrupt; refusing to delete" };
	if (existing?.owner_id !== ownerId)
		return { ok: false, reason: `lock is owned by ${existing?.owner_id}, not ${ownerId}` };
	try {
		unlinkSync(lockRecordPath(baseDir, campaignId));
		rmdirSync(path);
	} catch (error) {
		return { ok: false, reason: `could not release lock: ${String(error)}` };
	}
	return { ok: true, released: true };
}

/**
 * Atomically write a checkpoint (temp + rename + fsync of the file). The
 * checkpoint is a derived cache; callers must treat a failed write as "no new
 * checkpoint", never as a corruption of the event log.
 *
 * The stored record carries a `payload_digest` covering every field except
 * itself, so a half-written/tampered checkpoint is detectable on read.
 */
export function writeCheckpoint(baseDir, campaignId, checkpoint) {
	const path = checkpointPath(baseDir, campaignId);
	const body = { ...checkpoint, schema_version: CHECKPOINT_SCHEMA_VERSION, projection_version: PROJECTION_VERSION };
	body.payload_digest = digest(withoutPayloadDigest(body));
	try {
		writeFileAtomic(path, `${JSON.stringify(body)}\n`);
	} catch (error) {
		return { ok: false, path, reason: `could not write checkpoint: ${String(error)}` };
	}
	return { ok: true, path, digest: body.payload_digest };
}

/**
 * Read and VALIDATE a checkpoint against the current authority.
 *
 * A checkpoint is usable only when ALL hold: it parses; its payload digest
 * matches; it belongs to this campaign; its `manifest_digest` matches the
 * caller's trusted manifest digest; its `revision` is not ahead of the caller's
 * revision; and (when the caller supplies it) its `last_event_digest` matches
 * the CURRENT committed event tail. Otherwise the caller must rebuild from the
 * event log.
 */
export function readCheckpoint(baseDir, campaignId, options = {}) {
	const path = checkpointPath(baseDir, campaignId);
	if (!existsSync(path)) return { ok: false, reason: "no checkpoint" };
	let checkpoint;
	try {
		checkpoint = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { ok: false, reason: `checkpoint is not valid JSON: ${String(error)}` };
	}
	if (!checkpoint || typeof checkpoint !== "object") return { ok: false, reason: "checkpoint is not an object" };
	// Payload integrity: a tampered/half-written record is rejected.
	if (typeof checkpoint.payload_digest !== "string") {
		return { ok: false, reason: "checkpoint has no payload_digest" };
	}
	if (checkpoint.payload_digest !== digest(withoutPayloadDigest(checkpoint))) {
		return { ok: false, reason: "checkpoint payload_digest mismatch (tampered or half-written)" };
	}
	if (checkpoint.campaign_id !== campaignId)
		return { ok: false, reason: `checkpoint belongs to ${checkpoint.campaign_id}` };
	if (options.manifest_digest !== undefined && checkpoint.manifest_digest !== options.manifest_digest) {
		return {
			ok: false,
			reason: `checkpoint manifest_digest ${checkpoint.manifest_digest} != ${options.manifest_digest}`,
		};
	}
	if (options.revision !== undefined) {
		if (!Number.isInteger(checkpoint.revision)) return { ok: false, reason: "checkpoint has no integer revision" };
		if (checkpoint.revision > options.revision) {
			return { ok: false, reason: `checkpoint revision ${checkpoint.revision} is ahead of ${options.revision}` };
		}
	}
	// Stream-offset binding: the checkpoint must describe the SAME physical
	// committed offset the caller currently holds.
	if (options.expected_stream_offset !== undefined && checkpoint.stream_offset !== options.expected_stream_offset) {
		return {
			ok: false,
			reason: `checkpoint stream_offset ${String(checkpoint.stream_offset)} != current ${String(options.expected_stream_offset)}`,
		};
	}
	// Tail binding: the checkpoint must describe the SAME committed event tail the
	// caller currently holds. A mismatch means the checkpoint is stale/ahead and
	// must not be used directly.
	if (options.expected_tail_digest !== undefined && checkpoint.last_event_digest !== options.expected_tail_digest) {
		return {
			ok: false,
			reason: `checkpoint last_event_digest ${String(checkpoint.last_event_digest)} != current event tail ${String(options.expected_tail_digest)}`,
		};
	}
	if (
		options.expected_tail_sequence !== undefined &&
		checkpoint.last_event_sequence !== options.expected_tail_sequence
	) {
		return {
			ok: false,
			reason: `checkpoint last_event_sequence ${String(checkpoint.last_event_sequence)} != current ${String(options.expected_tail_sequence)}`,
		};
	}
	return { ok: true, checkpoint, path };
}

/** Remove the payload digest before recomputing it. */
export function withoutPayloadDigest(value) {
	const clone = { ...value };
	delete clone.payload_digest;
	return clone;
}

/** Best-effort directory/file stats used by tests and diagnostics. */
export function checkpointExists(baseDir, campaignId) {
	const path = checkpointPath(baseDir, campaignId);
	if (!existsSync(path)) return false;
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
