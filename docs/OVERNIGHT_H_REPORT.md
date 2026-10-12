# Overnight H — `/aegis run` audit-unavailable negative test + closing docs

Scope: close the one run-specific integration gap that `OVERNIGHT_G_REPORT.md`
§4 item 2 left honest ("A run-specific integration negative (broken log +
would-be active experience) is not added; the guard is code-reviewed, not
separately executed"). This batch adds that negative as a real Pi/faux test and
records the acceptance evidence.

Only Aegis-owned test/doc files were added:
`Pi_Agent_base/tests/aegis-observer-run-audit-failclosed-pi.mjs` and this report.
No Pi core, runtime implementation, auth, models/settings, lock file, or
previously-deleted file was touched. No Git commit, no network, no real model,
no credentials.

---

## 1. New test — `aegis-observer-run-audit-failclosed-pi.mjs`

A REAL Pi session (faux provider) drives the actual `/aegis run` command. The
test is deliberately **side-effect based**, not a "the command returned text X"
assertion.

### How the audit is made unavailable (honestly)

The task allowed "EventLog cannot be opened **or** append/fsync fails". This test
uses the *readable-but-unappendable* case so that the active Experience still
loads and the route is genuinely `direct` — that is what makes the negative
non-vacuous:

1. Seed a committed EventLog with two real registered-script executions
   (through the real broker + Oracle) and their genuine isolated replays, then
   compile the active Experience through the **exact library** `/aegis compile`
   calls and append the authoritative `experience.compiled` runtime note.
2. Copy the committed log and the derived Experience store.
3. `chmod 0o444` the copied log. `EventLog.open()` still reads + verifies the
   chain (so `log.replay()` returns the committed rows and the active Experience
   resolves), but the first `append` cannot open the append handle → `EACCES`.
   The fault is injected purely with file permissions; no runtime code or hook
   is modified.

### Key assertions (all real, all pass; the run prints 13 `ok` checks)

| # | Assertion | What it proves |
| --- | --- | --- |
| 1 | Two seeded runs execute the registered script and the Oracle confirms success | the trusted proof writer is real |
| 2 | Both seeded runs replay through the real isolated adapter | the compile's `replay_proof` gate can be met |
| 3 | The active Experience compiles from two independent replayed proofs | the seeded state is genuinely active |
| 4 | **Positive control**: `learningCommands.run` (exactly what `/aegis run` calls *after* its guard) over the SAME engine/broker/registration writes the script's `.ran` sentinel + post-state | the negative is not "the action/route/args were wrong" |
| 5 | The blocked log opens + verifies and its rows load, but a durable append returns `{ok:false}` | the construction is an honest append/fsync failure |
| 6 | Over the byte-identical blocked copy + active store, the SAME task/state routes `direct` | the only thing that can stop the run is the audit boundary |
| 7 | After the real `/aegis run`: the registered script did **NOT** spawn (no `.ran` sentinel) | the broker/script was not executed (process-level proof) |
| 8 | After the real `/aegis run`: the post-state file does **NOT** exist | no side effect landed |
| 9 | The blocked log is byte-identical before/after | no append was even possible |
| 10 | The refused run fabricated **no new** `action.requested`/`action.completed`/`outcome.recorded`/`experience.run` row (counts compared to the pre-run baseline) | no fake success evidence |

The registered script writes the `${out}.ran` sentinel **before** it reads any
input, so the sentinel proves the OS process was actually spawned; its absence
proves the script never ran, not merely that it failed.

### Exact command and result

```bash
cd /Users/scemac/My_github/Aegis/Pi_Agent_base
node --import ./pi/packages/coding-agent/src/experimental/source-resolver.ts \
  tests/aegis-observer-run-audit-failclosed-pi.mjs
```

Result: `aegis-observer-run-audit-failclosed-pi ok` (13/13 checks). The observer
prints the expected fail-closed lines (`event log could not be opened … EACCES`
and `Aegis run: audit log is unavailable; side-effecting run refused`), but the
checks assert the side effects above, not those strings.

---

## 2. `--import` requirement for real Pi tests (restated)

Every real-Pi/faux test imports the Pi SDK TypeScript sources directly, so it
**must** be run with the source resolver:

```
node --import ./pi/packages/coding-agent/src/experimental/source-resolver.ts <test.mjs>
```

Running `node <test.mjs>` without the resolver does not load the Pi
`@earendil-works/pi-coding-agent` sources correctly and is **not** a valid run.
This applies to the new test and to every real-Pi test below.

---

## 3. Format / types

- `./pi/node_modules/.bin/biome check --config-path=aegis-biome.json extensions/`
  → **0 errors, 0 warnings** (exit 0, "Checked 3 files … No fixes applied").
- The new test file is also biome-clean:
  `biome check --config-path=aegis-biome.json extensions/ tests/aegis-observer-run-audit-failclosed-pi.mjs`
  → exit 0, "Checked 4 files … No fixes applied".
- `./pi/node_modules/.bin/tsc -p tsconfig.aegis.json` → **exit 1** (NOT "tsc
  passes"). It reports **188 errors**, all in the **imported legacy/untyped
  runtime graph** that the three owned modules import:
  `experience-compiler.mjs` 44, `workflow-engine.mjs` 34,
  `action-contract.mjs` 29, `authorization.mjs` 25, `learning-router.mjs` 24,
  `evidence-resolver.mjs` 13, `events.mjs` 8, `contribution.mjs` 7,
  `board.mjs` 2, `fixture/contracts.mjs` 2.
  There are **0 errors in the owned modules** (`learning-bridge.mjs`,
  `learning-commands.mjs`, `learning-store.mjs`). The non-zero exit is the
  pre-existing baseline documented in `OVERNIGHT_E_PENDING.md` §3 / F §P2.4 /
  G §3; it is **not** claimed as a pass.

---

## 4. Affected regression re-run (all green)

Run with the `--import` source resolver:

| Test | Result |
| --- | --- |
| `tests/aegis-observer-run-audit-failclosed-pi.mjs` (NEW) | ok (13/13) |
| `tests/aegis-learning-commands-pi.mjs` (positive `/aegis run` + audit boundary) | ok |
| `tests/aegis-observer-failclosed-pi.mjs` (generic audit fail-closed) | ok |
| `tests/aegis-observer-data-use-pi.mjs` (real `aegis_execute` Outcome) | ok |
| `tests/aegis-observer-verify-first-pi.mjs` (normal + `AEGIS_ACTION_APPROVED=1`) | ok |

The positive `/aegis run` path (`aegis-learning-commands-pi`) was re-run to show
the audit guard is the *only* difference between the green run and this new
refusal: same command, same registered action, same active Experience, same
arguments — writable log executes, read-only log does not.

---

## 5. Files added / changed

- **added** `Pi_Agent_base/tests/aegis-observer-run-audit-failclosed-pi.mjs`
- **added** `docs/OVERNIGHT_H_REPORT.md` (this file)

No runtime/extension file changed. No Pi core, auth, models/settings, lock file,
or previously-deleted file changed. Nothing committed.

---

## 6. Still open (honest)

1. **`tsc` whole-program exit 1 is unresolved and is not claimed otherwise.**
   The 188 errors are the pre-existing imported legacy runtime graph. Only the
   three owned modules are error-free.
2. The remaining product decisions from `OVERNIGHT_E_PENDING.md` §4 (replay
   adapter provisioning/attestation, event-source signing, approval granularity,
   generalisation policy, auto-handoff entry point) are unchanged and remain
   human/product calls.
3. The G §4 item 1 gap (real execute/run Outcome must resolve its artifact/data
   evidence refs before it can become `active`) is unchanged; this batch only
   closes the G §4 item 2 run-specific audit negative.
