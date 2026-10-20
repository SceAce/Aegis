// Policy tests for the human-authorized remote CTF platform adapter.
// No browser, network, credentials, or target access is used here.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
	createRemotePlatformGate,
	evaluatePlatformSuccess,
	resolveDownloadPath,
	sanitizeDownloadName,
	validatePlatformUrl,
} from "../orchestration/remote-platform.mjs";

const ORIGIN = "https://ctf.example";
function clockGate(options = {}) {
	let now = 0;
	const gate = createRemotePlatformGate({ origins: [ORIGIN], now: () => now, minIntervalMs: 0, ...options });
	return {
		gate,
		advance: (ms) => {
			now += ms;
			return now;
		},
		at: () => now,
	};
}
function action(gate, kind = "navigation", extra = {}) {
	return gate.admit({ kind, origin: ORIGIN, ...extra });
}

test("per-minute and five-minute windows are enforced before the platform call", () => {
	const { gate, advance } = clockGate({ perMinute: 2, perFiveMinutes: 8, minIntervalMs: 0 });
	assert.equal(action(gate).ok, true);
	advance(1000);
	assert.equal(action(gate).ok, true);
	advance(1000);
	const third = action(gate);
	assert.equal(third.ok, false);
	assert.equal(third.reason, "minute_limit");
	advance(58_001);
	assert.equal(action(gate).ok, true, "the first action has left the one-minute window");

	const five = clockGate({ perMinute: 100, perFiveMinutes: 8, minIntervalMs: 0 });
	for (let i = 0; i < 8; i += 1) {
		assert.equal(action(five.gate).ok, true, `action ${i + 1}`);
		five.advance(1000);
	}
	const ninth = action(five.gate);
	assert.equal(ninth.ok, false);
	assert.equal(ninth.reason, "five_minute_limit");
});

test("minimum interval and serialized actions are enforced", () => {
	const { gate, advance } = clockGate({ perMinute: 10, minIntervalMs: 30_000 });
	assert.equal(action(gate).ok, true);
	advance(29_999);
	const blocked = action(gate);
	assert.equal(blocked.ok, false);
	assert.equal(blocked.reason, "min_interval");
	advance(1);
	assert.equal(action(gate).ok, true);
});

test("autoRemote accepts only an http(s) platform URL without embedded credentials", () => {
	assert.deepEqual(validatePlatformUrl("https://ctf.example/login"), {
		ok: true,
		url: "https://ctf.example/login",
		origin: "https://ctf.example",
	});
	assert.equal(validatePlatformUrl("https://user:pass@ctf.example/login").reason, "credentials_in_url_forbidden");
	assert.equal(validatePlatformUrl("file:///tmp/login").reason, "unsupported_protocol");
	assert.equal(validatePlatformUrl("not a url").reason, "invalid_url");
	assert.equal(validatePlatformUrl("").reason, "url_required");
});

test("origin allowlist is exact and protocol/port sensitive", () => {
	const gate = createRemotePlatformGate({ origins: [ORIGIN], now: () => 0, minIntervalMs: 0 });
	assert.equal(gate.originAllowed(ORIGIN), true);
	assert.equal(gate.originAllowed(`${ORIGIN}/challenge/1`), true);
	assert.equal(gate.originAllowed("http://ctf.example"), false);
	assert.equal(gate.originAllowed("https://ctf.example:8443"), false);
	assert.equal(gate.originAllowed("https://sub.ctf.example"), false);
	assert.equal(gate.originAllowed("https://ctf.example.evil.test"), false);
	assert.equal(gate.originAllowed("file:///tmp/platform"), false);
	const denied = gate.admit({ kind: "login", origin: "https://evil.example" });
	assert.equal(denied.ok, false);
	assert.equal(denied.reason, "origin_not_allowed");
});

test("submit and checker are one-shot; replay is refused", () => {
	const { gate, advance } = clockGate({ perMinute: 10, minIntervalMs: 0 });
	const first = action(gate, "submit", { key: "challenge-1" });
	assert.equal(first.ok, true);
	const duplicate = action(gate, "submit", { key: "challenge-1" });
	assert.equal(duplicate.ok, false);
	assert.equal(duplicate.reason, "duplicate_action");
	const replay = action(gate, "navigation", { replay: true });
	assert.equal(replay.ok, false);
	assert.equal(replay.reason, "replay_forbidden");
	const missingKey = action(gate, "checker");
	assert.equal(missingKey.ok, false);
	assert.equal(missingKey.reason, "action_key_required");
	advance(1000);
	assert.equal(action(gate, "checker", { key: "challenge-1" }).ok, true);
});

test("downloads are allowed only from the platform, bounded, and path-safe", () => {
	const { gate } = clockGate({
		downloads: { maxFileBytes: 10, maxTotalBytes: 15, maxFiles: 2 },
	});
	const root = join("/tmp", "aegis-download-test");
	const first = gate.authorizeDownload({
		url: `${ORIGIN}/files/a.zip`,
		filename: "../../../a.zip",
		bytes: 5,
		root,
	});
	assert.equal(first.ok, true);
	assert.equal(first.filename, "a.zip");
	assert.equal(first.path, join(root, "a.zip"));
	const second = gate.authorizeDownload({
		url: `${ORIGIN}/files/b.zip`,
		filename: "b.zip",
		bytes: 10,
		root,
	});
	assert.equal(second.ok, true);
	const third = gate.authorizeDownload({
		url: `${ORIGIN}/files/c.zip`,
		filename: "c.zip",
		bytes: 1,
		root,
	});
	assert.equal(third.ok, false);
	assert.equal(third.reason, "file_count_limit");
	const tooLarge = gate.authorizeDownload({
		url: `${ORIGIN}/files/d.zip`,
		filename: "d.zip",
		bytes: 11,
		root,
	});
	assert.equal(tooLarge.ok, false);
	assert.equal(tooLarge.reason, "file_size_limit");
	const totalGate = clockGate({ downloads: { maxFileBytes: 20, maxTotalBytes: 15, maxFiles: 10 } }).gate;
	assert.equal(totalGate.authorizeDownload({ url: `${ORIGIN}/a`, filename: "a", bytes: 10, root }).ok, true);
	assert.equal(
		totalGate.authorizeDownload({ url: `${ORIGIN}/b`, filename: "b", bytes: 10, root }).reason,
		"total_size_limit",
	);
	const foreign = gate.authorizeDownload({
		url: "https://evil.example/a.zip",
		filename: "a.zip",
		bytes: 1,
		root,
	});
	assert.equal(foreign.ok, false);
	assert.equal(foreign.reason, "origin_not_allowed");
	assert.equal(sanitizeDownloadName(".."), "download");
});

test("download path resolution rejects escape attempts", () => {
	const root = join("/tmp", "aegis-download-root");
	assert.equal(resolveDownloadPath(root, "normal.txt").path, join(root, "normal.txt"));
	assert.equal(resolveDownloadPath(root, "../outside.txt").path, join(root, "outside.txt"));
	assert.equal(resolveDownloadPath(root, ".").filename, "download");
	// A name that sanitizes to a path still cannot escape the root.
	assert.equal(resolveDownloadPath(root, "..").path, join(root, "download"));
});

test("platform success requires solved transition and correlated acceptance", () => {
	const base = {
		origin: `${ORIGIN}/challenge/1`,
		origins: [ORIGIN],
		challengeId: "challenge-1",
		beforeStatus: "open",
		afterStatus: "solved",
		accepted: true,
		responseChallengeId: "challenge-1",
	};
	const good = evaluatePlatformSuccess(base);
	assert.equal(good.ok, true);
	assert.equal(good.evidence.before_status, "open");
	assert.equal(good.evidence.after_status, "solved");
	assert.equal(evaluatePlatformSuccess({ ...base, accepted: false }).reason, "submission_not_accepted");
	assert.equal(evaluatePlatformSuccess({ ...base, afterStatus: "open" }).reason, "solved_status_not_observed");
	assert.equal(evaluatePlatformSuccess({ ...base, beforeStatus: "solved" }).reason, "already_solved");
	assert.equal(evaluatePlatformSuccess({ ...base, beforeStatus: "unknown" }).reason, "before_status_required");
	assert.equal(evaluatePlatformSuccess({ ...base, responseChallengeId: "other" }).reason, "challenge_mismatch");
	assert.equal(
		evaluatePlatformSuccess({ ...base, origin: "https://evil.example/challenge/1" }).reason,
		"origin_not_allowed",
	);
});
