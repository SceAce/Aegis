#!/usr/bin/env node
// Dead-owner reclaim race child.
//
// Usage: node campaign-reclaim-child.mjs <baseDir> <campaignId> <ownerId>
//
// Waits (briefly) for a shared barrier file, then attempts to reclaim a
// dead-owner lock. Prints exactly one line: `acquired <ownerId>` or
// `refused <ownerId> <reason>`. Used to prove the reclaim is atomic.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { acquireCampaignOwnership } from "../../campaign/ownership.mjs";

const [baseDir, campaignId, ownerId] = process.argv.slice(2);
const barrier = join(baseDir, "barrier");

// Busy-wait for the barrier to appear so all children race together.
const deadline = Date.now() + 3000;
while (!existsSync(barrier) && Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 5));
}

const acquired = acquireCampaignOwnership(baseDir, campaignId, { ownerId });
if (acquired.ok) {
	process.stdout.write(`acquired ${ownerId}\n`);
	// Hold the lock until the process exits so a live owner can never be
	// reclaimed by a competitor during the race.
	await new Promise((resolve) => setTimeout(resolve, 250));
} else {
	process.stdout.write(`refused ${ownerId} ${acquired.reason}\n`);
}
process.exit(0);
