# Pi Observer and Test Start

## Why the observer comes first

Before testing learning, Aegis needs a reliable raw trajectory. Without an
observer, a result in the Pi transcript cannot be distinguished from a tool
return value, a model claim, or a real task outcome. The observer is therefore a
prerequisite for the first memory experiment.

The current detector is
[`Pi_Agent_base/extensions/aegis-observer.ts`](../Pi_Agent_base/extensions/aegis-observer.ts).
It is loaded explicitly by [`run-pi.sh`](../Pi_Agent_base/run-pi.sh), so it does
not depend on a home-directory Pi extension.

## Captured Pi hooks

| Pi hook | Event emitted | What is recorded |
| --- | --- | --- |
| `session_start` | `session.started` | Session id, start reason, cwd |
| `before_agent_start` | `episode.started` | Prompt digest and bounded excerpt, cwd, source kind |
| `agent_start` | `agent.started` | Low-level agent run boundary |
| `turn_start` / `turn_end` | `turn.started` / `turn.ended` | Turn index, Pi activity outcome, tool-result count |
| `tool_call` | `action.requested` | Tool name, call id, input keys, digest, safe summary |
| `tool_result` | `action.completed` | Error flag, content digest and bounded redacted excerpt |
| `message_end` | `message.completed` | Role, content types, digest, bounded redacted excerpt |
| `agent_end` / `agent_settled` | `agent.ended` / `agent.settled` | Run completion and final-settlement boundary |
| `session_shutdown` | `session.shutdown` and pending `episode.closed` | Shutdown reason and unfinished-episode marker |

The detector writes append-only JSONL to:

```text
Pi_Agent_base/runtime/events.jsonl
Pi_Agent_base/runtime/ram/<episode_id>.md
```

Runtime files are ignored by `Pi_Agent_base/.gitignore`. The event log is the
raw source; no Experience is compiled by this extension.

## What the detector does not decide

The following fields remain unknown until a replay harness or oracle supplies
them:

| Field | Why Pi cannot decide it alone | First implementation |
| --- | --- | --- |
| Episode `goal.success_criteria` | A prompt is not a formal criterion | Test fixture supplies explicit criteria |
| Outcome `status` | Tool completion is not task completion | Deterministic oracle or human review |
| `failure_mode` | A timeout may hide success or a precondition error | Oracle inspects state and transport evidence |
| Environment fingerprint | Pi knows cwd, not the target's complete world | Environment probe writes a separate observation |
| Authorization scope | The model prompt is not an enforcement policy | Test runner declares allowed tools/targets |
| Experience `scope` and independence | A single Pi session cannot establish transfer | Replay runner groups independent Episodes |
| `repro_hash` | Pi does not know which state snapshot is replayable | Replay runner hashes the fixture and artifacts |

These are intentional unknowns. The detector must not guess them from prose.

## ROM and RAM

ROM is now available at
[`Pi_Agent_base/agent/ROM.md`](../Pi_Agent_base/agent/ROM.md). It contains only
stable behavioral constraints: claim/fact separation, observation before action,
transport versus outcome, uncertainty preservation, and authorization safety.

RAM is generated per Episode by the observer. It records the current episode id,
goal summary, cwd, observed tool/action counts, and the fact that no oracle has
yet judged the outcome. It does not contain long-term experiences. Experience
retrieval and compilation must be added after the raw event and oracle loop has
been validated.

## First replay and Oracle experiment

The first deterministic replay runner is
[`Pi_Agent_base/memory/replay-oracle.mjs`](../Pi_Agent_base/memory/replay-oracle.mjs).
It uses the fixture in
[`docs/examples/memory-teacher-trace.json`](examples/memory-teacher-trace.json),
executes the allowlisted `fixture.unlock(door)` action, and checks
`door.locked == false` with a deterministic state Oracle. It does not call Pi,
an LLM, or the network.

Run its local smoke test first:

```bash
node Pi_Agent_base/tests/replay-oracle-smoke.mjs
```

Then create the first replay experiment:

```bash
node Pi_Agent_base/memory/replay-oracle.mjs \
  --fixture docs/examples/memory-teacher-trace.json \
  --output Pi_Agent_base/runtime/experiments/unlock-v1 \
  --repeat 1
```

The output directory contains `events.jsonl`, `episodes.json`,
`outcomes.json`, `experiences.json`, and `report.json`. With one successful
teacher replay, the compiled Experience must remain `candidate`. The fixture's
missing-state case is preserved as `unknown`; it is not counted as a failure.

To exercise the evidence count gate, replay the fixture twice in independent
replay groups (each run starts from a fresh fixture state):

```bash
node Pi_Agent_base/memory/replay-oracle.mjs \
  --fixture docs/examples/memory-teacher-trace.json \
  --output Pi_Agent_base/runtime/experiments/unlock-v1-repeat2 \
  --repeat 2
```

This still remains `candidate` because both runs are replay-only. The optional
`--allow-replay-only-active` flag exists only to test the lifecycle transition;
it must not be interpreted as evidence of live-environment transfer:

```bash
node Pi_Agent_base/memory/replay-oracle.mjs \
  --fixture docs/examples/memory-teacher-trace.json \
  --output Pi_Agent_base/runtime/experiments/unlock-v1-gate \
  --repeat 2 \
  --allow-replay-only-active
```

The first real learning experiment must add at least one live/current-environment
Episode and an independently rerunnable Oracle before an Experience can guide
Pi. The smoke prompts that return `PI_RELAY_SMOKE_OK` and `PI_READ_SMOKE_OK` are
transport and observer checks, not learning evidence.

## Configure a relay model

[`login-relay.mjs`](../Pi_Agent_base/login-relay.mjs) writes a compatible
provider, its credential, and the default model only below
`Pi_Agent_base/config/agent/`. It does not read or write `$HOME/.pi`, and this
configuration change does not require rebuilding Pi.

For an OpenAI-compatible relay, configure it with:

```bash
cd /Users/scemac/My_github/Aegis
PI_RELAY_API_KEY='replace-with-the-real-key' \
  ./Pi_Agent_base/login-relay.mjs \
  --provider relay \
  --base-url https://relay.example/v1 \
  --model actual-model-id
```

The default API adapter is `openai-completions`. Use `--api openai-responses`
or `--api anthropic-messages` only when the relay implements that protocol. The
default model metadata is a 128000-token context window, 16384 maximum output
tokens, text input, and reasoning disabled. Override these values when the
actual model contract differs:

```bash
PI_RELAY_API_KEY='replace-with-the-real-key' \
  ./Pi_Agent_base/login-relay.mjs \
  --provider relay \
  --base-url https://relay.example/v1 \
  --model actual-model-id \
  --reasoning true \
  --input text,image \
  --context-window 200000 \
  --max-tokens 32000
```

Prefer `PI_RELAY_API_KEY` or the script's hidden interactive prompt over
`--api-key`, because command arguments can appear in shell history and process
listings. The key is stored only in the ignored `auth.json` with mode `0600`.
The script preserves unrelated providers and settings while replacing the
selected provider's endpoint and model.

Inspect the redacted configuration or remove it with:

```bash
./Pi_Agent_base/login-relay.mjs --show --provider relay
./Pi_Agent_base/login-relay.mjs --logout --provider relay
```

After configuration, Pi uses the selected relay by default:

```bash
./Pi_Agent_base/run-pi.sh --no-session
```

For the first real connectivity check, use a deterministic response and keep
the session disabled:

```bash
./Pi_Agent_base/run-pi.sh --no-session --mode text -p \
  "Return exactly: PI_RELAY_SMOKE_OK"
```

## Test sequence

### 1. Static and detector smoke test

Run this before any model call:

```bash
cd /Users/scemac/My_github/Aegis
node Pi_Agent_base/tests/observer-smoke.mjs
node Pi_Agent_base/tests/login-relay-smoke.mjs
node Pi_Agent_base/tests/live-oracle-smoke.mjs
```

This invokes the extension with a mocked Pi event stream. It checks hook
coverage, Event ordering, ROM/RAM injection, digest generation, and secret
redaction. The relay test configures and removes a provider in a temporary
directory, checks credential permissions and replacement behavior, and does not
require an API key or a network request.

### 2. Pi launcher smoke test

```bash
./Pi_Agent_base/run-pi.sh --help
```

The launcher must report Pi help and create mutable state only under
`Pi_Agent_base/config/` and `Pi_Agent_base/runtime/`. If Pi source is newer than
the bundle, it stops and asks for `npm run build:offline`.

### 3. Teacher replay fixture

Use [`memory-teacher-trace.json`](examples/memory-teacher-trace.json) as the
first replay input. The replay runner should:

1. create a `teacher_replay` Episode with explicit success criteria;
2. execute each recorded action against a deterministic fixture environment;
3. emit step and episode Outcomes through an oracle;
4. preserve the fixture's `unknown` result as unknown;
5. compile only a candidate Experience because the fixture has one independent
   successful Episode.

### 4. First live Pi run

Start with a reversible, deterministic task whose goal can be checked without
an LLM judge. Keep `--no-session` for an initial behavior smoke test, or use a
named session when the transcript itself is part of the fixture. Save the
resulting `runtime/events.jsonl` and inspect event counts before implementing
Experience retrieval.

Do not begin with a long CTF run. A long run can demonstrate that logging works,
but it cannot tell us whether a missing field, an incorrect boundary, or a bad
oracle caused a learning result to be wrong.

### 5. Live Oracle projection

The observer deliberately records transport and claims only. After a live run,
the experiment directory must contain a `manifest.json` that declares the state
file, verified preconditions, postconditions, and allowed mutation tools. Run
the deterministic live adapter after Pi exits:

```bash
node Pi_Agent_base/memory/live-oracle.mjs \
  --experiment Pi_Agent_base/runtime/experiments/<live-run> \
  --output Pi_Agent_base/runtime/experiments/<live-run>/oracle-v1
```

The adapter reads the state file itself, validates the raw event hash chain,
adds Oracle observations and `outcome.recorded` events to the derived event
stream, and writes `episodes.json`, `outcomes.json`, `experiences.json`, and
`report.json`. It never uses the agent's final message as a task result.

Live evidence is scoped as `mode: live`. A single successful live Episode
produces a `candidate` Experience; activation still requires the normal
independent Episode and replayability gates.

## A/B test start order

After the detector and replay parser pass, run the learning comparison in this
order:

1. **A:** no Experience projection, raw detector only;
2. **B:** raw Episode replay supplied for diagnosis;
3. **C:** compiled active Experience supplied to the agent;
4. **D:** stale or deliberately wrong Experience to test suspension and negative transfer.

The first acceptance gate is not higher success rate. It is complete provenance:
every action has a result, every terminal claim has an oracle or `unknown`, and
the same Event log can rebuild the Episode projection.
