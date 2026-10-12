# Overnight Batch C — Verify-First Actions Wired Into the Observer

Status: **implemented and green**, with the honest limits listed below. This is
NOT a claim that the whole Aegis framework is done.

Scope delivered: two model-facing tools (`aegis_observe`, `aegis_execute`) on the
existing Observer, a small adapter that wires the reviewed Batch-B libraries into
the Observer's single EventLog, the contest launcher/env switch, a task-scoped
stage-activity view in the daily report, and two new independent tests. No
existing file, event writer, board/state/RAM/handoff, config or auth was
rewritten. No network, no real model/credential, no git commit.

## Files

New:
- `Pi_Agent_base/memory/runtime/action-runtime.mjs` — the thin adapter/resolver.
- `Pi_Agent_base/tests/aegis-observe-actions.mjs` — offline positive/negative tests.
- `Pi_Agent_base/tests/aegis-observer-verify-first-pi.mjs` — REAL Pi faux-provider
  multi-turn test.
- `docs/OVERNIGHT_C_REPORT.md`, `docs/OVERNIGHT_C_PENDING.md` (this file, below).

Edited (in-scope only):
- `Pi_Agent_base/extensions/aegis-observer.ts` — registers the two tools; records
  `action.requested` intent + `fsync` **before** any effect; records
  `observation.captured` / `outcome.recorded` with `source.kind:"oracle"` **only
  because the registered Verification re-read the real artifact/post-state**;
  records honest `runtime.note` rejections.
- `Pi_Agent_base/contest/run.sh` — exposes `aegis_observe,aegis_execute` in
  `--tools`; adds `AEGIS_ACTION_MODE` (`auto`/`normal`, default `normal`) and
  `AEGIS_WORKSPACE`.
- `Pi_Agent_base/contest/daily.mjs` — read-only runtime stage-activity section
  built from the task-scoped EventLogs.

## Test entry points

```
# offline adapter: 31 assertions
node Pi_Agent_base/tests/aegis-observe-actions.mjs
# -> aegis-observe-actions ok

# REAL Pi faux-provider multi-turn: 21 assertions
cd Pi_Agent_base
node --import ./pi/packages/coding-agent/src/experimental/source-resolver.ts \
  tests/aegis-observer-verify-first-pi.mjs
# -> aegis-observer-verify-first-pi ok
```

Regression set re-run green: `aegis-runtime-core-smoke`,
`aegis-runtime-effective-board`, `aegis-observer-contest-pi`,
`aegis-observer-failclosed-pi`, `aegis-observer-outcome-command`,
`aegis-observer-runtime-handoff`, `observer-smoke`, `contest-launcher-smoke`,
`contest-pipeline-smoke`, `contest-smoke`, `aegis-contest-pi-integration`,
`fixture-pi-integration`, `fixture-direct-smoke`, `live-oracle-smoke`,
`replay-oracle-smoke`. (The Batch-B smoke and the three DS-owned libraries are
read-only for Batch C and were not modified.)

## What the integration actually does

### `aegis_observe` (registered read-only action)
The model names a **registered** action id (`workspace.identify_elf`) and a
workspace-relative path. `action-runtime.mjs` runs the reviewed contract via the
Batch-B broker (`authorizeAction` → recognition → procedure → registered
verification). The procedure parses the REAL file bytes (`parseElfHeader`);
missing / truncated / non-ELF / out-of-workspace / symlink-escaping targets are
rejected or returned `unknown`, never guessed. On success the Observer appends
`observation.captured` and a step `outcome.recorded`. The `source.kind:"oracle"`
+ `verified:true` is set **only** when the registered verification re-read the
real artifact (a header re-parse agreement), so the board creates a trusted
`Fact`. That `Fact` is visible in the next provider-bound request's RAM.

### `aegis_execute` (human-registered script action)
The model supplies only a registered action id and data-only arguments. The
executable, argv template, pinned executable/script digests, cwd and the
post-condition Oracle all come from a **trusted local registration module**
(`AEGIS_SCRIPT_CONFIG`), which the model cannot set. There is no shell, no
`-e`/`-c`/`--eval`, no network unless `AEGIS_ALLOW_NETWORK=1`. The Observer
re-hashes the registered files and records a **pre-effect registration admission
note** (`environment.observed`, `pins_match`), then records `action.requested`
and `fsync`s before spawning the process. Success requires the **registered
Oracle to read the real post-state** (the JSON artifact), not merely exit code 0.
A zero exit with a failing Oracle is recorded as `unknown` with `exit_code:0`
preserved as transport. Rejected/unknown branches (unregistered action,
arbitrary executable id, no approval, changed digest, timeout) all record an
honest `runtime.note` and never a success.

### Modes and authorization
`AEGIS_ACTION_MODE=normal` (default): a side-effecting script action does not
effect without an explicit human approval (`AEGIS_ACTION_APPROVED=1`), which the
model cannot set; the refusal is recorded. `auto` is a user-granted default path
— **it is not a verification result**. Authorization answers "may this run", not
"did it work"; the workspace bounds targets but is **not an OS sandbox**.

## Required behaviour coverage

| Requirement | Where |
| --- | --- |
| Freeze/intent before effect | `aegis-observer.ts` intent-then-effect; asserted by event order in the Pi test |
| ELF format/bitness/machine recognition (≥1 case) | `workspace-info-actions.mjs`; Pi test asserts `bits=64`, `machine=x86_64` |
| Human-registered script + param template + version digest | `script-registry.mjs` via the trusted config module |
| Post-registration state checker | pre-effect `environment.observed` admission note (`pins_match`) |
| Post-state Oracle reads JSON, not exit code | offline test + Pi test (exit 0 + Oracle reject ⇒ `unknown`) |
| Stale/foreign/missing data refs | `createRefResolver` digest check; offline test |
| Param/version swap | changed script body ⇒ refusal; offline test |
| Symlink escape | `resolveInside`/`insideRoot`; both tests |
| No authorization | normal-mode pending-approval; both tests |
| Timeout error branch | `attempts:1`, no retry; offline test |
| Trusted TEST-registered impls only in tests | registration is a local module/env path the model never controls |
| auto ≠ fact verification | auto grants permission; success still requires the Oracle |

## Honest remaining issues (exact)

1. **`resolveRef` is not yet called by the B2 contribution/compiler APIs.**
   `action-runtime.mjs` exposes `createRefResolver` / `buildRefResolver` and the
   Observer records `data.use.bound` association notes, but the actual
   `recordStageContribution` / `compileExperience` wiring is intentionally left
   to the DS-owned libraries. So `obtain` is real; an `advance` contribution is
   not yet automatically produced by this integration. No success is inferred.

2. **Script registrations are only as strong as the trusted config module.**
   A `.json` registration cannot carry a real `verify()` function, so it will be
   refused (fail-safe) by `validateScriptRegistration`. Only a `.mjs`/`.js`
   module (or an in-process object) with a real Oracle is usable. This is by
   design but means the operator must ship reviewable code, not just data.

3. **The workspace is not an OS sandbox.** Authorization bounds targets and the
   registered script runs with the user's own privileges; a registered script
   still has whatever filesystem/network access the process has. The auth
   contract is not a containment boundary.

4. **`aegis_observe` currently exposes exactly one action**
   (`workspace.identify_elf`). Adding more read-only actions is a matter of
   adding reviewed contracts to the registry; the exposure allowlist in the
   adapter is explicit.

5. **Contest launcher network/model remain as in Batch A/B.** The launcher still
   uses the relay provider configured by the operator; Batch C did not add or
   validate any real model/credential path.

6. **Daily stage-activity is advisory and read-only.** It surfaces observed
   event counts and the effective Fact/Refuted view per task from the
   task-scoped EventLog. It is not a causal/usefulness proof and never promotes.
