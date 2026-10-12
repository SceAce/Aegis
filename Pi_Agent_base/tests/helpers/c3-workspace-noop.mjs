#!/usr/bin/env node
// Aegis C3 workspace-adapter helper script: a NO-OP that exits 0.
//
// Used to prove the Oracle does NOT treat a zero exit code as success: the
// registered post-condition (`verify`) re-reads the real state file and fails
// when the value was not actually set.
process.stdout.write(`${JSON.stringify({ ok: true, noop: true })}\n`);
process.exit(0);
