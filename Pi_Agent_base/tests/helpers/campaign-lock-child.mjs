#!/usr/bin/env node
// Cross-process lock contention child.
//
// Usage: node campaign-lock-child.mjs <baseDir> <campaignId> <ownerId> <holdMs>
//
// Acquires the Campaign ownership lock, holds it for `holdMs`, then releases it.
// Prints exactly one line: `acquired <ownerId>` or `refused <ownerId> <reason>`.
// Used by aegis-campaign-c1-ownership.mjs to prove a single writer across real
// OS processes.

import { acquireCampaignOwnership, releaseCampaignOwnership } from "../../campaign/ownership.mjs";

const [baseDir, campaignId, ownerId, holdMsRaw] = process.argv.slice(2);
const holdMs = Number(holdMsRaw) || 100;

const acquired = acquireCampaignOwnership(baseDir, campaignId, { ownerId });
if (!acquired.ok) {
	process.stdout.write(`refused ${ownerId} ${acquired.reason}\n`);
	process.exit(0);
}
process.stdout.write(`acquired ${ownerId}\n`);
await new Promise((resolve) => setTimeout(resolve, holdMs));
releaseCampaignOwnership(baseDir, campaignId, { ownerId });
process.exit(0);
