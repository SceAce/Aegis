# Aegis contest MVP — data & daily review

This directory is the **source-only, offline-safe** contest entry for the
P0/P1 slice described in `docs/CONTEST_MVP.md`. It is deliberately small: the
goal is trustworthy metadata + independent outcomes + a deterministic daily
review, not an automatic-learning system.

Nothing here:
- edits the Pi fork (`Pi_Agent_base/pi/`),
- reads `auth.json` or any credential file,
- calls a real model or any contest network in tests,
- promotes a card to `verified`, auto-writes experiences, or infers success
  from the model's own claims, `agent_settled`, or an exit code.

## Files

| file | purpose |
| --- | --- |
| `run.sh` | isolated launcher (defaults `--off`, opt-in `--hint`); persists a real Pi session |
| `cards.sample.json` | example cards (one `verified`, one `candidate`); **not** contest-valid by itself |
| `result.mjs` | manual, independent result capture (`success`/`failure`/`unknown`) |
| `daily.mjs` | read-only, deterministic daily report (JSON + Markdown + CSV) |

Runtime data (git-ignored, never commit):

```
Pi_Agent_base/runtime/contest/decisions.jsonl   # extension metadata (task/session linking)
Pi_Agent_base/runtime/contest/results.jsonl     # independent outcomes
Pi_Agent_base/runtime/contest/reports/          # daily reports
Pi_Agent_base/config/sessions/                  # raw Pi session JSONL (may contain flags/task text)
```

> Sessions and decisions may contain flags, answer text, or credentials. Keep
> `runtime/` and `config/` private; do not copy them into `docs/` or a public
> repo. The metadata log never stores raw tool output or credential material.

## 1. Launch a contest task (one new session per task)

Run the launcher from any **external** task directory; the launcher uses that
directory as the workspace by default. One line, absolute launcher path plus an
anonymous task id:

```bash
cd /srv/contest/task-007
AEGIS_CONTEST_TASK_ID=task-007 /abs/path/Pi_Agent_base/contest/run.sh --hint
```

Set `AEGIS_CONTEST_WORKSPACE=<dir>` to override the default. Optional metadata
knobs select deterministic hint cards:

```bash
AEGIS_CONTEST_WORKSPACE=/srv/contest/task-007 \
AEGIS_CONTEST_TASK_ID=task-007 \
AEGIS_CONTEST_TASK_CATEGORY=<category> \
AEGIS_CONTEST_ENV=linux \
AEGIS_CONTEST_OBSERVATIONS=task_started \
AEGIS_CONTEST_CARDS=/abs/path/Pi_Agent_base/contest/cards.sample.json \
/abs/path/Pi_Agent_base/contest/run.sh --hint
```

- `--off` (default) records only, never injects.
- `--hint` injects up to 2 **verified** cards that match the deterministic
  `scope` + `when` conditions. `candidate` cards are **never** auto-injected.
- Each task must use a **new session**; do not switch `off`/`hint` mid-task.
- The launcher loads **only** the `aegis-contest` extension and appends the
  existing `agent/ROM.md` via `--append-system-prompt`, so ROM principles reach
  every request as a prompt section. The legacy `aegis-observer` extension is
  **not** loaded: its `before_agent_start` returned a full `systemPrompt`, which
  forced Pi to bypass section assembly and let hint sections be dropped.
- `AEGIS_CONTEST_WORKSPACE` is optional. When unset, the caller's current
  directory (`pwd -P`, captured before any `cd`) is the workspace. The whole
  Aegis checkout root, its descendants, and any ancestor that exposes it (for
  example `$HOME` or `/`) are refused; the agent is `cd`-ed into the workspace
  before Pi starts. The cwd is **not** an OS sandbox.

`--help` lists all env knobs. The launcher isolates Pi state under
`Pi_Agent_base/config` via `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`,
and `PI_SERVER_DIR`; it does not touch `$HOME/.pi`. It accepts **no Pi
passthrough flags at all** (not even after `--`) and clears inherited `PI_*`
experiment state, so `off` and `hint` always share the same
model/provider/tools/resources/session/extension set (`--no-extensions`,
`--no-mcp`, `--no-approve`, `--no-context-files`, `--no-skills`,
`--no-prompt-templates`, `--no-themes`, plus a pinned
`--tools read,bash,edit,write,aegis_propose,aegis_switch_session` and BOTH
`-e aegis-observer` and `-e aegis-contest` extensions).
The launcher sets `PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1` to disable Pi's
automatic update / version / model-catalog network checks; provider calls for
the pinned relay model are still made.

**Per-task isolation.** Runtime state is scoped to the task id at
`<CONTEST_DIR>/tasks/<task_id>/` (`events.jsonl`, `ram/`, `ram/handoff.json`),
exported as `AEGIS_EVENT_LOG`, `AEGIS_RAM_DIR`, and `AEGIS_HANDOFF_FILE`. Two
tasks therefore never share an event log, RAM, or handoff file, so they cannot
cross handoff or episodes. The task id is validated to be a single path segment
(a task id containing a path separator is refused), and the resolved task dir
must stay under `CONTEST_DIR`.

**Authoritative sources.** A contest result is judged from the Pi session JSONL,
the `aegis-contest` metadata log, and the externally recorded result only. The
observer IS loaded by the launcher and is the single writer of the per-task
event log; the contest extension only EMITS its injection decision on the shared
Pi event bus, which the observer records as `experience.decision`. Do not treat
the observer board as independent contest evidence — it records what the agent
was shown, not what succeeded. A contest result is imported at the idle boundary
via `/aegis outcome <task_id> [session_id]`, which reads the results file by
EXACT task/session and refuses to guess success.

Permissions: the launcher sets `umask 077` so **new** runtime/session state is
owner-only. Pre-existing group/world-accessible state is reported as a warning
and is **not** chmod-ed. The workspace `cwd` is **not** an OS sandbox; run
untrusted or high-risk tasks in a container / low-privilege account.

## 2. Record the independent result

Outcomes come from a platform score or an explicit human decision — never from
the agent.

```bash
node contest/result.mjs add \
  --task-id task-007 \
  --session-id <pi-session-id> \
  --result success|failure|unknown \
  --source platform|human \
  --group off|hint \
  --card <card-id>@<revision> \
  --evidence "short, non-sensitive summary"

node contest/result.mjs list
```

- `--result` defaults to `unknown` (missing is never "success").
- Values that look like flags/credentials are **refused**.
- Rows are marked `independent: true`.

## 3. Generate the daily review (read-only)

```bash
node contest/daily.mjs                 # latest day in the logs
node contest/daily.mjs --date 2026-10-10
node contest/daily.mjs --date 2026-10-10 --deterministic
```

Outputs to `runtime/contest/reports/<date>.report.{json,md}` and
`<date>.rows.csv`. The report:
- joins task_id/session_id, dedups, and lists group, injection/card, tool counts,
  independent result + source;
- derives the **group from recorded `session_start`/`injection_decision`
  metadata only** — a hand-filled `result.group` is never allowed to rewrite it;
  mismatches are flagged as `group_mismatch` / `card_mismatch`;
- reports per-task first tool action (name, error flag, ms offset from session
  start) and tool calls split by experiment group;
- counts **unique tasks** separately from the number of sessions, and never
  copies one result across two sessions of a multi-session task as two
  independent successes (ambiguous/multi-session results stay `unknown`);
- lists concrete checkable anomalies: missing independent result, mixed
  match/non-match in one session, missing linked session file, group switch,
  multi-session task, ambiguous result session, unparseable log lines;
- suggests next-day adjustments as **candidates only** (never auto-written);
- states its own limitations (unknown defaults, approximate tool counts, no
  causal/statistical claim, difficulty not comparable).

`--deterministic` omits `generated_at` so output is byte-stable for diffing.

## Offline tests

```bash
# extension hooks (mutation of systemPromptOptions.sections, candidate gating,
# prompt-section removal, secret-free metadata)
node Pi_Agent_base/tests/contest-smoke.mjs

# result capture + daily report (determinism, read-only, secret refusal)
node Pi_Agent_base/tests/contest-pipeline-smoke.mjs

# launcher cases (default/override workspace, checkout rejection, no Pi
# passthrough; positive launches use a fake Pi source in a temp layout)
node Pi_Agent_base/tests/contest-launcher-smoke.mjs

# real Pi SDK + faux provider (same ROM loading + aegis-contest extension as
# the launcher; ROM principles present in BOTH off/hint, matched hints only in
# hint, stale-hint removal, fail-closed logging including same-session hint ->
# broken log)
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-contest-pi-integration.mjs

# launcher starts and --help works
Pi_Agent_base/contest/run.sh --help
```

## Honest limitations

- Cards in `cards.sample.json` are illustrative; a card becomes usable for a
  real contest run only after a **human reviews that specific card**. A card's
  `verified` status is an externally-confirmed label, not proof for this task;
  tool-checkable `observations` are different from human labels. The card-file
  `sha256` digest and per-card `id@revision` are recorded in the decision
  metadata so a later replay can see what was visible at the time.
- Matching needs deterministic, externally-supplied `task_category`,
  `environment`, and `observations`; unknown conditions match nothing.
- Tool counts come from the extension metadata log (authoritative); Pi session
  JSONL is a best-effort cross-check that only raises `count_mismatch`.
- The workspace `cwd` is not a sandbox and the narrow `AEGIS_CONTEST_GUARD`
  delete check is not a security boundary.
- With only a few tasks, results are exploratory, not statistically valid.
- This MVP does **not** implement stop/restart recovery, automatic retrieval,
  case/failure compilation, or the full `Episode/Outcome/Experience` promotion
  gate (P2).
