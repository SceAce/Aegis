#!/usr/bin/env node
// Concurrent EventLog writer used by aegis-eventlog-concurrency.mjs.
// Usage: node eventlog-concurrent-child.mjs <logPath> <prefix> <count>
// Every child opens the SAME campaign log before writing. The EventLog lock and
// tail refresh must keep the hash chain and per-episode sequence valid.

import { EventLog } from "../../shared/events.mjs";

const [logPath, prefix, rawCount] = process.argv.slice(2);
const count = Number(rawCount);
if (!logPath || !prefix || !Number.isInteger(count) || count < 1) {
	process.stderr.write("usage: eventlog-concurrent-child.mjs <logPath> <prefix> <count>\n");
	process.exit(2);
}

const log = new EventLog(logPath);
const opened = await log.open();
if (!opened.ok) {
	process.stderr.write(`open failed: ${opened.error}\n`);
	process.exit(3);
}
for (let index = 0; index < count; index += 1) {
	const result = await log.append({
		event_type: "runtime.note",
		episode_id: "episode-concurrent",
		payload: { kind: "concurrent-writer", prefix, index },
	});
	if (!result.ok) {
		process.stderr.write(`append failed: ${result.error}\n`);
		process.exit(4);
	}
}
await log.close();
