// Aegis Web Console — workspace file listing/reading for the file panel.
//
// The workspace is NOT an OS sandbox, but this module does not become a way
// around it:
//   * the root is fixed by the caller (the experiment's workspace);
//   * every requested path is resolved with `realpath` and must stay inside the
//     real root, so `..`, encoded separators and symlink escapes are refused;
//   * absolute paths, device files, sockets and FIFOs are refused;
//   * listings are bounded and report truncation.
//
// Read-only. Nothing here writes, executes or follows an external link.

import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const FILE_LIMITS = Object.freeze({
	entries: 400,
	readBytes: 512 * 1024,
	depth: 6,
});

export class WorkspacePathError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "WorkspacePathError";
		this.code = code;
	}
}

function inside(root, target) {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a browser-supplied relative path inside the workspace root.
 *
 * @param {string} root
 * @param {string} requested
 * @param {{allowMissing?: boolean}} [options]
 */
export async function resolveWorkspacePath(root, requested = "", options = {}) {
	if (typeof root !== "string" || !root) throw new WorkspacePathError("no_workspace", "no workspace configured");
	if (typeof requested !== "string") throw new WorkspacePathError("invalid_path", "path must be a string");
	if (requested.length > 1024) throw new WorkspacePathError("invalid_path", "path is too long");
	if (requested.includes("\0")) throw new WorkspacePathError("invalid_path", "path contains a null byte");
	if (isAbsolute(requested)) throw new WorkspacePathError("absolute_path", "absolute paths are not served");
	const normalized = requested.replaceAll("\\", "/").replace(/^\/+/, "");
	if (normalized.split("/").some((part) => part === ".."))
		throw new WorkspacePathError("path_escape", "'..' segments are not allowed");
	let realRoot;
	try {
		realRoot = await realpath(root);
	} catch {
		throw new WorkspacePathError("no_workspace", "the workspace does not exist");
	}
	const candidate = resolve(join(realRoot, normalized));
	let real;
	try {
		real = await realpath(candidate);
	} catch {
		if (options.allowMissing) return { root: realRoot, path: candidate, relative: normalized };
		throw new WorkspacePathError("not_found", "no such file");
	}
	if (!inside(realRoot, real)) throw new WorkspacePathError("path_escape", "path escapes the workspace");
	return { root: realRoot, path: real, relative: relative(realRoot, real).split(sep).join("/") };
}

function describeKind(stats) {
	if (stats.isDirectory()) return "directory";
	if (stats.isFile()) return "file";
	if (stats.isSymbolicLink()) return "symlink";
	return "other";
}

/**
 * Bounded directory listing. Entries outside the workspace (symlinks) are
 * reported as `outside` and never followed.
 *
 * @param {string} root
 * @param {string} requested
 */
export async function listWorkspace(root, requested = "") {
	const resolved = await resolveWorkspacePath(root, requested);
	const info = await stat(resolved.path);
	if (!info.isDirectory()) throw new WorkspacePathError("not_a_directory", "not a directory");
	let entries;
	try {
		entries = await readdir(resolved.path, { withFileTypes: true });
	} catch (error) {
		throw new WorkspacePathError("unreadable", `directory is not readable: ${String(error)}`);
	}
	entries.sort((a, b) => {
		if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	const rows = [];
	let truncated = false;
	for (const entry of entries) {
		if (entry.name === "." || entry.name === "..") continue;
		if (rows.length >= FILE_LIMITS.entries) {
			truncated = true;
			break;
		}
		const childPromise = (async () => {
			const child = resolve(join(resolved.path, entry.name));
			let real = null;
			try {
				real = await realpath(child);
			} catch {
				return null;
			}
			if (!inside(resolved.root, real)) return { name: entry.name, kind: "outside", size: null, modified_at: null };
			let stats = null;
			try {
				stats = await stat(real);
			} catch {
				return null;
			}
			return {
				name: entry.name,
				kind: describeKind(stats),
				size: stats.isFile() ? stats.size : null,
				modified_at: stats.mtime?.toISOString?.() ?? null,
			};
		})();
		const row = await childPromise;
		if (row) rows.push(row);
	}
	return {
		path: resolved.relative,
		entries: rows,
		truncated,
		limit: FILE_LIMITS.entries,
	};
}

/** Read a bounded UTF-8 slice of a workspace file. Binary content is flagged. */
export async function readWorkspaceFile(root, requested, { maxBytes = FILE_LIMITS.readBytes } = {}) {
	const resolved = await resolveWorkspacePath(root, requested);
	const info = await stat(resolved.path);
	if (!info.isFile()) throw new WorkspacePathError("not_a_file", "not a regular file");
	const size = info.size;
	const take = Math.min(size, Math.max(1, Math.min(maxBytes, FILE_LIMITS.readBytes)));
	const buffer = Buffer.alloc(take);
	const handle = await open(resolved.path, "r");
	try {
		await handle.read(buffer, 0, take, 0);
	} finally {
		await handle.close();
	}
	const binary = buffer.includes(0);
	return {
		path: resolved.relative,
		size,
		truncated: size > take,
		bytes_shown: take,
		binary,
		encoding: binary ? "binary" : "utf8",
		text: binary ? null : buffer.toString("utf8"),
		modified_at: info.mtime?.toISOString?.() ?? null,
	};
}
