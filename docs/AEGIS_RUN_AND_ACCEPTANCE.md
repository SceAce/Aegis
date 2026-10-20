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
| `/aegis autoRemote` | 人类输入平台 URL；打开专用 Firefox profile 登录页，人类手动登录；不接收/保存账号密码或 cookie | 当前只做登录 bootstrap；尚未发现题目、下载附件、提交或自动 checker |
| `/aegis checkFlag` | 人类显式确认当前打开任务 flag 正确；不接收/保存 flag 值，使用现有 human Outcome bridge 写入，重复执行幂等 | 不从模型文本/自然语言推断成功；不新增 Outcome schema；不替代独立 platform checker |
| `/aegis learn <json>` | binds a `{when, do, scope, arguments_template}` proposal via the reviewed binder; records `experience.candidate` | never activates; prose in `when`/`do` is a **gap**, never eval'd |
| `/aegis compile --proof <id> --proof <id> [--templates <json>] [--candidate <candidate_event_id>] [--id <name>]` | imports **only** the named committed proof outcome ids; on success writes an **active** Experience + the derived store. With `--candidate`, the named committed candidate supplies a reviewed procedure (`do.kind=procedure`) and the rule is hint/habit-only, never direct | with 0 or 1 proof it stays `candidate`; a missing/tampered procedure candidate or digest stays `candidate` |
| `/aegis route [--state <json>] [--state-ref <json>]` | routes the active Experience: `direct` / `habit` / `hint` / `deliberate` | `paused` is a **binding state**, not a 5th level; a candidate is never hinted; no verified state ⇒ never direct |
| `/aegis bind --<param> <value> --state <json> --state-ref <json>` | fills the reported **missing** params and **re-checks** to direct | refuses unexpected params / mismatched binding |
| `/aegis run --args <json> [--target <path>] --state <json> --state-ref <json>` | executes the confirmed **direct** Experience through the real broker (0 model calls) and the Oracle re-checks; records a durable `action.requested` (final args + pinned version/digest + authorization), the standard step `outcome.recorded` under the trusted oracle source, and `action.completed` | never runs when the route is not direct / not authorized; fails closed (no broker call) when the audit log is unavailable |
| `/aegis replay --outcome <id>` | commits a genuine isolated replay **through the configured adapter** | with no configured adapter: refuses, fabricates nothing, never re-runs the original target |

`/aegis checkFlag` 的集成验收在 `tests/aegis-observer-outcome-command.mjs`：人类命令写入 human/independent/effective Fact；不接收或保存 flag 值；重复执行不重复 Outcome；带 flag 参数被拒绝；实际 Board 命题可见。它不替代 platform checker，也不从模型文本推断成功。

### Remote platform policy（当前实现边界）

新增 `orchestration/remote-platform.mjs` 作为浏览器/平台 adapter 共用的硬门；它不执行网络、不读取凭据、不写 Outcome：

- 精确 origin allowlist；
- 滑动窗口：60 秒最多 2 次、300 秒最多 8 次、最小间隔 30 秒；
- submit/checker 一次性 key，重复或 replay 直接拒绝；
- 附件下载 allowlist、单文件/总量/数量上限、路径净化与 quarantine root；
- 平台成功必须同时满足：同一 challenge、提交前非 solved、提交后有结构化 accepted、状态变为 solved；只有文本或只有状态都不算成功。

Cookie/API 当前接线：

- `remote-cookie.mjs` 从专用 Firefox profile 的 `cookies.sqlite` 读取当前 origin 的 live cookies；值只存在进程内存，不打印、不写 EventLog/RAM。
- `/aegis autoRemote` 第二次执行确认人类已登录后附着 `remote-http.mjs` client。
- 工具 `aegis_remote_request` 只开放平台 GET，经 origin/rate gate；不暴露 Cookie，不提供 POST/flag 提交绕过路径。
- `aegis-remote-cookie-http.mjs` 覆盖 cookie 过滤、Cookie 注入、origin、rate、跨域重定向和重复 POST 拒绝。

`/aegis autoRemote` 已接成**两步人类登录 bootstrap**：第一次接收平台 URL 并打开专用 Firefox；人类手动登录后再次执行命令，从专用 profile 读取 cookie 到进程内存，并附着受控 GET API client（`aegis_remote_request`，不暴露 cookie 值）。账号密码/cookie 原文不进入 RAM/EventLog；题目发现、附件下载、POST 提交和 checker 尚未接线，不能把该命令当作完整自动比赛入口。浏览器选型仍按“干净 Firefox/Playwright MCP，Zen 专用 profile 仅作备选”设计。

聚焦测试：

```bash
node Pi_Agent_base/tests/aegis-remote-platform-policy.mjs
node Pi_Agent_base/tests/aegis-remote-cookie-http.mjs
```

覆盖 rate、origin、replay、下载边界、路径逃逸、成功判定、cookie broker 和受控 GET HTTP；真实平台/凭据测试尚未运行，不能据此声称 `autoRemote` 已验收。

### Firefox DevTools MCP（已配置；autoRemote 登录 bootstrap 已接入）

Aegis 的全局 MCP 配置位于 `$AEGIS_HOME/agent/mcp.json`；当前默认 `$HOME/.Aegis/agent/mcp.json` 已加入：

- server: `firefox-devtools`
- package: `@mozilla/firefox-devtools-mcp@0.10.6`
- binary: `/Applications/Firefox.app/Contents/MacOS/firefox`
- profile: `$HOME/.Aegis/browser/firefox-profile`（独立干净 profile）
- tools: `pages snapshot input network console screenshot downloads utilities`
- 明确不启用 `script`（不开放任意 JS evaluate）、`management`、`webextension`、`prefs`、`privileged`、`launch`
- log: `$HOME/.Aegis/runtime/browser/firefox-mcp.log`

验证命令（不启动模型/不访问平台）：

```bash
PI_CODING_AGENT_DIR="$HOME/.Aegis/agent" PI_OFFLINE=1 \
  node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  ./Pi_Agent_base/pi/packages/coding-agent/src/cli.ts mcp list
```

当前验证结果：`firefox-devtools: connected, 31 tools (direct, global)`。

限制：MCP 工具本身不会自动执行 Aegis 的 rate/origin/download policy；`/aegis autoRemote` 已有两步登录、Cookie broker 和 GET API client，但平台 adapter、题目发现、附件下载接线、POST 提交和 checker/Outcome 尚未实现。启用 MCP 不等于完整 autoRemote 已可用。

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
