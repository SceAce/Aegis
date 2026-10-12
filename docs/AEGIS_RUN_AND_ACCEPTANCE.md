# Aegis — short run instructions, learning API, acceptance checklist

Companion to `OVERNIGHT_E_TASK.md`, `OVERNIGHT_E_PENDING.md`, `OVERNIGHT_F_REPORT.md`, `OVERNIGHT_G_REPORT.md`, `PI_OBSERVER.md`,
and `Pi_Agent_base/contest/README.md`. Keep `runtime/` and `config/` **private**;
they may contain task text, flags, or credentials.

---

## 1. Run the product entry point

The observer is loaded explicitly by `run-pi.sh` (no home-directory extension
needed). The ledger is append-only at `runtime/events.jsonl`.

```bash
# one absolute path, works from any external cwd
cd /any/task/dir
/abs/path/Pi_Agent_base/run-pi.sh
```

Contest launcher (one absolute path, external cwd):

```bash
cd /srv/contest/task-007
AEGIS_CONTEST_TASK_ID=task-007 /abs/path/Pi_Agent_base/contest/run.sh --hint
```

Deterministic daily review (read-only; writes JSON + Markdown + CSV):

```bash
node /abs/path/Pi_Agent_base/contest/daily.mjs --deterministic --format both \
  --outdir /abs/path/Pi_Agent_base/runtime/contest/reports
```

`--off` (default) registers tools only; `--hint`/`--auto` change the **approval /
hint card** path, not Pi's global sandbox. Normal bash still has OS privileges —
this is **not** a sandbox, and `AEGIS_ACTION_MODE=auto` is a user-granted default
path, not a verification result.

## 2. Controlled learning commands (`/aegis ...`)

These are **human / trusted-Host** commands. The model cannot drive them, and the
proof writer is the trusted Runtime/Oracle.

| command | effect | never does |
| --- | --- | --- |
| `/aegis learn <json>` | binds a `{when, do, scope, arguments_template}` proposal via the reviewed binder; records `experience.candidate` | never activates; prose in `when`/`do` is a **gap**, never eval'd |
| `/aegis compile --proof <id> --proof <id> [--templates <json>] [--id <name>]` | imports **only** the named committed proof outcome ids; on success writes an **active** Experience + the derived store | with 0 or 1 proof it stays `candidate` |
| `/aegis route [--state <json>] [--state-ref <json>]` | routes the active Experience: `direct` / `habit` / `hint` / `deliberate` | `paused` is a **binding state**, not a 5th level; a candidate is never hinted; no verified state ⇒ never direct |
| `/aegis bind --<param> <value> --state <json> --state-ref <json>` | fills the reported **missing** params and **re-checks** to direct | refuses unexpected params / mismatched binding |
| `/aegis run --args <json> [--target <path>] --state <json> --state-ref <json>` | executes the confirmed **direct** Experience through the real broker (0 model calls) and the Oracle re-checks; records a durable `action.requested` (final args + pinned version/digest + authorization), the standard step `outcome.recorded` under the trusted oracle source, and `action.completed` | never runs when the route is not direct / not authorized; fails closed (no broker call) when the audit log is unavailable |
| `/aegis replay --outcome <id>` | commits a genuine isolated replay **through the configured adapter** | with no configured adapter: refuses, fabricates nothing, never re-runs the original target |

### Configuration (environment, set by the human/launcher only)

| variable | meaning | default |
| --- | --- | --- |
| `AEGIS_EVENT_LOG` | committed event JSONL | `runtime/events.jsonl` |
| `AEGIS_EXPERIENCE_DIR` | derived experience store | `<event-dir>/experiences` |
| `AEGIS_SCRIPT_CONFIG` | **human-registered** script source (`.mjs` may carry a real `verify()`; `.json` cannot) | unconfigured |
| `AEGIS_REPLAY_ADAPTER` | module path exporting `replayAdapter` (`{id, isolated:true, replay}`) | unconfigured ⇒ replay refused |
| `AEGIS_ACTION_MODE` | `normal` (default) or `auto` | `normal` |
| `AEGIS_ENVIRONMENT_FINGERPRINT`, `AEGIS_DOMAIN` | scope of the current environment | `local-workspace`, null |
| `AEGIS_WORKSPACE` / `AEGIS_CONTEST_WORKSPACE` | task workspace root | cwd |

## 3. Learning library API (`memory/runtime/`)

- `learning-bridge.mjs` — `createLearningBridge({events, board, state, scope,
  registry, broker, authorization, replayAdapter, environment, sink, clock})`
  → `{bindCandidate, compileFromOutcomeIds, proofsFromOutcomeIds, route,
  bindHabit, executeDirect, invokeExploratory, replayOutcome, recordContribution,
  associateFeedback, usefulness, assess}`; also `buildProductionResolver`,
  `loadReplayAdapter`, `mapResolveRefToSupport`.
- `learning-commands.mjs` — Pi-free command logic: `learn`, `compile`, `route`,
  `bind`, `run`, `replay`, `describe`, `parseFlags`, `lastFlag`, `parseJsonArg`.
- `learning-store.mjs` — `createLearningStore({dir})` → `{save, load, loadActive,
  loadAll}`. **Derived/rebuildable**: the authoritative record is the append-only
  `runtime.note`; only `status:"active"` is loadable for routing.

Correctness invariants (enforced by tests, not just by convention):
`text` is never eval'd; a missing binding is a **candidate**, never a hint;
nothing goes active without a resolver-confirmed proof; a candidate is excluded
from the hint surface.

## 4. Acceptance checklist

Format / types
- [ ] `pi/node_modules/.bin/biome check --config-path=aegis-biome.json extensions/` → 0 errors, 0 warnings
- [ ] `./pi/node_modules/.bin/tsc -p tsconfig.aegis.json` → 0 errors **in the owned modules** (whole-repo tsc still exits 1 from ~195 pre-existing legacy errors — see `OVERNIGHT_E_PENDING.md` §3)

Library + product tests (all must print `ok`)
- [ ] `node tests/aegis-learning-bridge-e.mjs` (derived-store tamper/stale gate + `adapterPath` really executes)
- [ ] `node --import ./pi/packages/coding-agent/src/experimental/source-resolver.ts tests/aegis-learning-commands-pi.mjs` (real `/aegis run` audit boundary, `not_copied`, invalid `--templates`)
- [ ] `node --import ./pi/packages/coding-agent/src/experimental/source-resolver.ts tests/aegis-observer-data-use-pi.mjs` (real `aegis_execute` Outcome → compile regression)
- [ ] `node --import ./pi/packages/coding-agent/src/experimental/source-resolver.ts tests/aegis-observer-verify-first-pi.mjs` (normal + `AEGIS_ACTION_APPROVED=1`)
- [ ] `node tests/aegis-workflow-evidence-d.mjs`, `tests/aegis-workflow-engine-d.mjs`, `tests/aegis-runtime-core-smoke.mjs`, `tests/aegis-runtime-effective-board.mjs`, `tests/memory-runtime-batch-b-smoke.mjs`, `tests/memory-runtime-learning-evidence-smoke.mjs`, `tests/observer-smoke.mjs`
- [ ] Pi-integration: `tests/aegis-observer-data-use-pi.mjs`, `aegis-observer-outcome-command.mjs`, `aegis-observer-failclosed-pi.mjs`

Evidence gate (must hold)
- [ ] nothing becomes `active` without Proof/mapping; 0/1 proof ⇒ `candidate`
- [ ] no isolation/replay record is fabricated when no adapter is configured
- [ ] replay uses a fresh local temp with real before/after; the original/remote/
      non-idempotent target is never auto-re-run
- [ ] `route` conflict / mismatch / unknown returns a concrete difference

Launcher / daily
- [ ] one absolute launcher path works from an external cwd; missing task id errors
- [ ] `daily.mjs --deterministic` writes JSON + MD + CSV and makes **no** causal /
      promotion claim; `--off`/`normal` vs `--hint`/`auto` is documented honestly

Daily review may cite a learning **decision**, an **outcome**, **data
contributions**, and a **handoff** — it never asserts automatic causality or
promotion.
