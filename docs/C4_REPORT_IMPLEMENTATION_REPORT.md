# C4 Report — Implementation Report

Current status: **accepted_with_recorded_limits after this session's authorized C4 review/fixes**. See `C4_EXTERNAL_REVIEW.md` for new red/green evidence and limitations. The original DS delivery below is retained as history; review and fixes were performed in the current user-directed session, not by a fabricated independent team.
Phase: C4 (deterministic read-only Campaign report + bounded acceptance bundle).
Scope frozen in `C4_REPORT_TASK.md` / `C4_REPORT_DS_PROMPT.md`, plan/matrix in
`C4_REPORT_WORK_PLAN.md` / `C4_REPORT_TEST_MATRIX.md`. C1/C2/C3 are not reopened;
F16 and the legacy type baseline stay deferred. No UI, no C5, no real
model/network/target.

Branch: `feat/c4-report` (created from `feat/c3-execution` @ `f611ec0`).

## 0. Baseline and Git note

- Start: branch `feat/c3-execution`, worktree clean, last commit `f611ec0`.
- Commits on `feat/c4-report`:
  - `234be1c` feat: deterministic read-only Campaign report export and validator (C4-A/B)
  - `5696b0e` test: C4 required export/rebuild/privacy/validator suites (C4-C/D)
  - (this commit) docs: C4 report implementation report
- Earlier DS environment claim: IDs/SHA256 reportedly displayed zeros. Current
  review verified the standard SHA256 abc vector and distinct a/b hashes; no
  evidence establishes a crypto stub or Git masking. The new tests verify actual
  digest change as well as equality. Record unavailable output honestly instead
  of treating an unverified environment inference as a permanent test waiver.

## 1. Delivered entry

| file | role |
| --- | --- |
| `memory/campaign/report-export.mjs` | `buildReportInputs`, `generateCampaignArtifacts`, `validateAcceptanceBundle`, `countCommitted`, `reconstructArtifactIndex`, `deriveIntegrity`, `DEFAULT_LIMITS` |
| `memory/campaign/report-entry.mjs` | read-only CLI `runReportExport` + `parseArgs` |
| `memory/campaign/report.mjs` | (shared) value-redaction hardening + reviewer-flag key rename |

Reused unchanged: `projectQueueFromEvents` (C1 projection), `resolveStageOutcome`/
`resolveTaskOutcome` (C1 resolver), `aggregateStage`/`aggregateTask`/
`aggregateCampaign`/`effectiveOutcomes`/`independenceOf` (C0 aggregate) and the
C0 `report.mjs` writer. No second judgment path or Oracle was created.

### Product command

```bash
node Pi_Agent_base/memory/campaign/report-entry.mjs \
  --manifest <manifest.json> --events <events.jsonl> \
  [--artifacts <artifacts.json>] [--runtime <runtime.json>] --out <dir>
```

Writes exactly four artifacts to `--out`: `campaign-report.json`,
`campaign-report.md`, `acceptance-bundle.json`, `reviewer-prompt.md`. It opens the
source read-only, never runs Worker/Broker/Oracle/session/model/network, and
prints the report/bundle digests plus the before/after source digests.

## 2. Required results (actual commands, exit codes)

| case | command | exit | evidence |
| --- | --- | --- | --- |
| C4-1/2a/2b/2c/4/6/7a | `node Pi_Agent_base/tests/aegis-c4-report-export.mjs` | 0 | 8 tests / 8 pass |
| C4-3 | `node Pi_Agent_base/tests/aegis-c4-report-rebuild.mjs` | 0 | 2 tests / 2 pass |
| C4-5 | `node Pi_Agent_base/tests/aegis-c4-report-privacy.mjs` | 0 | 4 tests / 4 pass |
| C4-7b | `node Pi_Agent_base/tests/aegis-c4-report-validator.mjs` | 0 | 5 tests / 5 pass |

Logs captured under ignored `/tmp/c4-*.log` during this run.

### Regression (C4-8)

| suite | exit |
| --- | --- |
| aegis-campaign-contracts-c0.mjs (report C0 contract) | 0 |
| aegis-campaign-fixture-c0.mjs | 0 |
| aegis-campaign-closure-c0.mjs | 0 |
| aegis-campaign-c1-integration-scheduler.mjs | 0 |
| aegis-campaign-c1-event-projection.mjs | 0 |
| aegis-campaign-c1-integration-e2e.mjs | 0 |
| aegis-c3-host-fixture.mjs | 0 |
| aegis-c3-durability-recovery.mjs | 0 |
| aegis-c3-workspace-adapter.mjs | 0 |
| aegis-c3-external-boundaries.mjs | 0 |
| aegis-c2-supervisor-boundaries.mjs (resolver) | 0 |

Static:
- Biome on all C4 files + the shared `report.mjs`/`index.mjs`: **exit 0**.
- `tsc -p tsconfig.aegis-campaign.json`: **exit 1, 65 errors, 0 in C4 files** —
  identical to the C3 baseline (2 fixture/contracts + 29 action-contract +
  25 authorization + 8 events + 1 script-registry, all legacy imports). Reported
  as-is; not zeroed by weakening checks.

## 3. What the cases prove

- **C4-1**: real C3 fixture run → four artifacts; task/stage statuses agree
  between JSON and Markdown; each success Outcome carries resolvable evidence
  refs; the reviewer prompt names the four verdicts.
- **C4-2a**: a delayed Oracle leaves the task `unknown` (never success); the
  lifecycle-vs-evidence view shows it.
- **C4-2b**: a rejected action is counted as rejected; a cancelled control event
  does not become success.
- **C4-2c**: a corrupt event chain is an explicit `event_chain_ok=false` /
  non-zero exit, never a guessed success.
- **C4-3**: after deleting derived artifacts (checkpoint/runtime/summary/report)
  a re-export from the same Manifest+events reproduces the same semantic/report/
  bundle digests; `generated_at`/paths are excluded from the digest.
- **C4-4**: the bundle carries `report_digest` verbatim and its `bundle_digest`
  is computed over the body that INCLUDES `report_digest`.
- **C4-5**: real secret samples (flag/ctf/Bearer/private key + api_key/password
  assignments) never appear in the public artifacts; the credentials policy shows
  only `none`/`manifest_policy` (anything else `[redacted]`); an oversized bundle
  is refused with explicit `exceeds max_outcomes`/`max_bundle_bytes` reasons.
- **C4-6**: counts equal the deduplicated committed set and the committed ledger;
  a repeated action id is counted once; Session generations and Episodes are
  separate fields; the independent-Episode count is `null` (not asserted).
- **C4-7a**: source bytes are byte-identical before/after; generation takes only
  manifest/events/artifacts (no execution hook).
- **C4-7b**: the validator rejects a missing field, a ref with neither id nor
  digest, and a `report_digest` contradiction; `validateReviewerVerdict` accepts
  only the four verdicts.

## 4. Truth, counts and provenance (explicit)

- Source of truth: immutable Manifest + verified committed EventLog + trusted
  bounded evidence. `summary.json`, checkpoints and Host in-memory counters are
  NEVER read as success/authorization truth.
- The evidence index is reconstructed from **trusted** records only
  (`action.completed` with `source.kind=runtime`, and `oracle`/`human` Outcome
  results). An `llm`/`agent` self-reported ref is never indexed (C3-X4 carried
  forward).
- Budget uses the committed ledger; unknown/unobservable values (tokens/amounts,
  independent-Episode count, unsupplied runtime/model/Oracle digests) are
  `null`/`"unknown"` and listed under `unsupported_claims`.

## 5. Honest limitations

- Superseded environment limitation: the current review demonstrates real digest
  distinctness on semantic changes. Historical equality-only checks do not alone
  prove the hash algorithm; see the actual vector/change evidence in the review.
- The report is a derived artifact; deleting it and regenerating is the intended
  workflow. No statistical/causal claim is made (`statistical_claim: null`).
- CLI defaults to explicit paths; it does not auto-discover Manifests or
  platform Oracles (deferred to C5 integration).

## 6. Deferred (not a C4 gate)

| item | owner | note |
| --- | --- | --- |
| C4a WebUI / Pi view commands | C4a | later phase |
| F16 checkpoint cache incrementality | F16 | performance; deferred |
| legacy 65 tsc import diagnostics | when those libs change | recorded baseline |
| statistical/causal claims | — | never made |
| real model/network/target | later | requires authorization |

## 7. External review request (C4 only)

Review ONLY the read-only export, its committed-truth counts, digest coverage,
privacy/bounds and validator within the frozen scope above. Do not reopen
C1/C2/C3, and do not extend into C4a/C5 or real-target experiments. C4 status:
**internally_verified / awaiting_external_review**.
