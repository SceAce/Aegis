# C4 Report — Work Plan and Frozen Contract

Status: **frozen before implementation; C4-A..D completed, internally verified, awaiting one C4 external review**. Scope follows `C4_REPORT_TASK.md`,
`C4_REPORT_DS_PROMPT.md` and `CAMPAIGN_ARCHITECTURE.md` §3.7. This plan does not
reopen C1/C2/C3 and does not implement C4a UI, C5 or any real target/network/model.

Branch: `feat/c4-report` (created from `feat/c3-execution` @ `f611ec0`).
Baseline: worktree clean, last commit `f611ec0`.
Environment note: this sandbox's `git` masks commit object ids (`rev-parse`) to
all-zero; reports cite the `git log --oneline` id and state that limitation.

## 1. Problem and deliverable

C0 has a deterministic `report.mjs` (report/bundle/markdown/prompt/verdict) but
there is no product entry that rebuilds it from a REAL immutable Manifest +
verified committed EventLog + bounded trusted evidence. C4 delivers a runnable,
read-only export that writes:

```text
campaign-report.json
campaign-report.md
acceptance-bundle.json
reviewer-prompt.md
```

and a local structural validator. It never runs Worker/Broker/Oracle, never
contacts a model or the network, and never mutates the authoritative source.

## 2. Frozen interfaces (C4-A)

### `Pi_Agent_base/memory/campaign/report-export.mjs`

- `buildReportInputs({ manifest, manifestDigest, events, artifacts, runtimeDigests })`
  → `{ projection, taskAggregates, stageAggregates, outcomes, counts, sessions,
  integrity, faults, missingEvidence, conflicts, unsupportedClaims }`.
  Pure; reuses `projectQueueFromEvents`, `resolveTaskFromOutcomes`,
  `aggregateCampaign`. Counts come from DEDUPLICATED committed events.
- `generateCampaignArtifacts({ manifest, events, artifacts, runtimeDigests, limits })`
  → `{ report, markdown, bundle, reviewerPrompt, digests }`. Reuses
  `buildCampaignReport`, `buildAcceptanceBundle`, `renderCampaignReportMarkdown`,
  `renderReviewerPrompt`.
- `validateAcceptanceBundle(bundle, { report, limits })` → `{ ok, reasons }`.
  Structural: required fields, ref/digest presence, report_digest coverage,
  bound limits, no secret patterns.
- `writeCampaignArtifacts(outDir, generated)` → writes the four files; the source
  is opened read-only.
- `DEFAULT_LIMITS` — entry/byte bounds.

### `Pi_Agent_base/memory/campaign/report-entry.mjs`

CLI: `node report-entry.mjs --manifest <path> --events <jsonl> [--artifacts <json>]
--out <dir>`. Read-only; prints the four digests; exit non-zero on validation
failure or integrity failure.

## 3. Frozen digest / field contract

- `report_digest` excludes only `report_digest`; every semantic/evidence field is
  covered. Non-semantic fields (`generated_at`, output paths) are EXCLUDED from
  the digest and rendered separately.
- `bundle_digest` excludes only `bundle_digest` and therefore COVERS
  `report_digest`.
- Field whitelist: the report/bundle contain only the whitelisted structured
  fields defined by `report.mjs`; no raw tool transcript, no credentials/flags/
  Bearer/private keys.
- Unknown/unobservable values are `null`/`"unknown"`, never `0`.

## 4. Frozen invariants

- **C4-READONLY**: export opens the Manifest/events read-only and never writes to
  them (byte-identical before/after; verified by digest).
- **C4-NOEXEC**: no Worker/Broker/Oracle/session/model/network call is made.
- **C4-COMMITTED**: action/session/budget counts derive from deduplicated
  committed events; Host in-memory counters, `summary.json` and checkpoints are
  never success/authorization truth. A repeated command id is counted once.
- **C4-SESSION-NEQ-EPISODE**: Session count and independent-Episode count are
  reported separately; Session generations never inflate evidence.
- **C4-REBUILD**: deleting derived artifacts and re-running over the same source
  yields identical semantic/report/bundle digests.
- **C4-INTEGRITY**: a corrupt event chain yields an explicit integrity
  failure/inconclusive, never a guessed success.

## 5. Out of scope (deferred)

| item | owner phase | reason |
| --- | --- | --- |
| C4a WebUI / Pi view commands | C4a | later phase |
| F16 cache incrementality | F16 | performance; deferred |
| legacy 65 tsc import diagnostics | when those libs change | recorded baseline |
| statistical/causal claims | — | never made |
| real model/network/target | later | requires authorization |

## 6. Milestones

1. **C4-A** contract + report inputs from committed events. Commit.
2. **C4-B** artifact generation + validator + read-only writer. Commit.
3. **C4-C** CLI entry + privacy/bounds + counts. Commit.
4. **C4-D** products tests, rebuild determinism, regressions, report. Commit.

## 7. Proof levels

- Real `memory/runtime/events.mjs` EventLog (verifyChain) as the committed source.
- Real C3 fixture run to produce authentic events + Manifest.
- Synthetic/`unknown` values labelled explicitly; no real target.
- Rebuild proof by hashing the source before/after and re-generating artifacts.
