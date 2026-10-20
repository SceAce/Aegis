// Trusted cookie broker for the dedicated Firefox profile.
//
// The model never receives cookie names/values. The autoRemote adapter reads
// this module only when it needs a Cookie header for an allowlisted platform
// request. The database is copied to a private temp file so Firefox locks and
// WAL state cannot block the read.

import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_HEADER = 16 * 1024;

function parentDomains(hostname) {
	const parts = String(hostname).toLowerCase().split(".").filter(Boolean);
	const out = [];
	for (let i = 0; i < parts.length; i += 1) {
		const suffix = parts.slice(i).join(".");
		out.push(suffix, `.${suffix}`);
	}
	return [...new Set(out)];
}

async function copyDatabase(profilePath) {
	const candidates = [
		join(profilePath, "cookies.sqlite"),
		join(profilePath, "firefox_devtools_mcp_profile", "cookies.sqlite"),
		join(profilePath, "firefox_devtools_mcp_profile", "cookies.sqlite-wal"),
		join(profilePath, "cookies.sqlite-wal"),
		join(profilePath, "firefox_devtools_mcp_profile", "cookies.sqlite-shm"),
		join(profilePath, "cookies.sqlite-shm"),
	];
	const source = candidates[0];
	await stat(source);
	const dir = await mkdtemp(join(tmpdir(), "aegis-cookies-"));
	const target = join(dir, "cookies.sqlite");
	await copyFile(source, target);
	for (const suffix of ["-wal", "-shm"]) {
		const side = `${source}${suffix}`;
		try {
			await copyFile(side, `${target}${suffix}`);
		} catch {
			// A missing WAL/SHM file is normal.
		}
	}
	return { dir, target };
}

/**
 * Read a bounded Cookie header for an exact http(s) origin.
 * Returns only the header and count; no name/value is logged or included in errors.
 */
export async function readFirefoxCookieHeader({ profilePath, origin, now = Date.now() } = {}) {
	if (typeof profilePath !== "string" || !profilePath) return { ok: false, reason: "profile_required" };
	let url;
	try {
		url = new URL(origin);
	} catch {
		return { ok: false, reason: "invalid_origin" };
	}
	if (!["http:", "https:"].includes(url.protocol)) return { ok: false, reason: "unsupported_protocol" };
	const source = join(profilePath, "cookies.sqlite");
	try {
		await stat(source);
	} catch {
		return { ok: false, reason: "cookie_database_missing" };
	}
	let temp;
	try {
		temp = await copyDatabase(profilePath);
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(temp.target, { readOnly: true });
		const hosts = parentDomains(url.hostname);
		const placeholders = hosts.map(() => "?").join(",");
		const rows = db
			.prepare(`SELECT host, name, value, path, expiry, isSecure FROM moz_cookies WHERE host IN (${placeholders})`)
			.all(...hosts);
		db.close();
		const secure = url.protocol === "https:";
		const pathname = url.pathname || "/";
		const selected = [];
		for (const row of rows) {
			if (!row || typeof row.name !== "string" || typeof row.value !== "string") continue;
			if (row.isSecure === 1 && !secure) continue;
			if (Number.isFinite(row.expiry) && row.expiry > 0 && row.expiry * 1000 <= now) continue;
			const cookiePath = typeof row.path === "string" && row.path.startsWith("/") ? row.path : "/";
			if (cookiePath !== "/" && !pathname.startsWith(cookiePath)) continue;
			selected.push(`${row.name}=${row.value}`);
		}
		selected.sort();
		let header = selected.join("; ");
		let truncated = false;
		if (header.length > MAX_HEADER) {
			header = header.slice(0, MAX_HEADER);
			truncated = true;
		}
		return {
			ok: true,
			cookieHeader: header,
			count: selected.length,
			truncated,
		};
	} catch (error) {
		return {
			ok: false,
			reason: `cookie_read_failed:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
		};
	} finally {
		if (temp) await rm(temp.dir, { recursive: true, force: true }).catch(() => undefined);
	}
}
