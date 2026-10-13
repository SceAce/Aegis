# C6 Provider Gate 重规划与冻结契约（PG-0 → PG-6）

状态：`internally_verified / awaiting_external_review`（本轮 PG-0…PG-6 完成）。依据
`docs/C6_PROVIDER_GATE_REDESIGN_DS_PROMPT.md`、`docs/C6_EXTERNAL_REVIEW.md` §5–6、
`docs/C6_RECHECK_REPAIR_DS_PROMPT.md`。产品修复基线 `22d075c`，red 测试 `85b1d1d`。
主 DS 无可用子 Agent 能力，TEST → IMPLEMENT → REVIEW 串行执行并如实记录。

> 后续收敛（见 `C6_AGENT_PRODUCT_IMPLEMENTATION_REPORT.md` §14）：请求生命周期统一到
> `c6-request-lifecycle.mjs`；本文 §4 的 durable 字段列表已扩展 `provider_started`、
> `provider_status`、`stop_reason`、`commit_status`、`failure_reason`；`reconciliation_required`
> 表示未决而非取消；重建要求 committed 含两侧 reservation 且与原 reserved 一致。

## 0. BASE：实际环境（PG-0 实测）

| 项目 | 实测 |
| --- | --- |
| 父仓库 HEAD / 分支 | `89cb4aa` / `feat/c6-agent-product` |
| 工作树 | 干净提交 + 2 处保留改动：`Pi_Agent_base/tests/aegis-c6-recheck-boundaries.mjs`（+146，用户/审查新增 red）、`docs/C6_PROVIDER_GATE_REDESIGN_DS_PROMPT.md`（untracked，本任务提示词） |
| 内嵌 Pi HEAD | `42a3497d0`（约定，不入 gitlink） |
| 聚焦 red 基线 | `node --test Pi_Agent_base/tests/aegis-c6-recheck-boundaries.mjs` → **20 tests / 13 pass / 7 fail, exit 1** |
| 失败用例 | R12、R13、R14、R12b、R13b、R13c、R14b |

已认可、不得重开：registered-test 可信完成、runner 真实初态、learning 真复用/真实 pre-state、
aegis_read 真实路径/当前 Task grant、external-boundaries 22/22、learning closure 全绿、原 14 个 C6 脚本 exit 0。

## 1. Provider request 状态机（冻结）

每个真实 provider request 有稳定 `request_id`（Host/gate 生成，模型不可提供），关联：

```text
campaign_id, task_id, episode_id, session_id, request_id,
task_reservation_id, campaign_reservation_id,
input_chars_estimated, coverage, source, phase, provider_status, reconciliation
```

合法转移：

```text
created
  -> admitted            (两层 in-memory reservation 均成功)
  -> reserved_durable    (durable runtime.note phase=reserved 确认 ok)
  -> provider_started    (真实 streamFunction 调用)
  -> provider_finished   (message_end / 合成失败消息)
  -> committed_in_memory (两层 ledger commitRequest)
  -> committed_durable   (durable runtime.note phase=committed 确认 ok)
  -> settled
异常：
created -> rejected                    (任一层额度/窗口拒绝，无 provider call)
created -> reservation_persist_failed  (durable reserved 失败，无 provider call)
reserved_durable -> provider_error     (provider 抛错，进入 committed/reconcile 记账)
provider_started -> reconciliation_required (无 message_end / commit 不确定)
```

硬规则（逐条对应本文件与提示词）：

1. `rejected` 不产生 provider call。
2. 未获得全部需要的 in-memory reservation，不写 durable reservation、不调用 provider。
3. durable reservation 失败，不调用 provider。
4. provider 已调用后，consumption 不得被释放成“未发生”。
5. provider 结果提交（in-memory 或 durable）失败，停止后续 provider dispatch 与 Broker effect，保留 pending/reconciliation。
6. 同一 reservation 重复 commit 幂等，不双扣。
7. provider 已调用但无可确认 message end → reconciliation/unknown，不盲目重发。
8. 最后一个请求也走完整 `commit -> durable commit -> settle`，不依赖下一次 `streamFunction` flush。
9. `prompt()` 返回 / decision buffer 有内容 / transport exit 0 均不能替代 `committed_durable`。

## 2. Task/Campaign 联合 reservation 契约

每次真实 request 必须同时满足 `Campaign remaining > cost AND Task remaining > cost`。

接口（`c6-tool-ledger.mjs`，新增，保留旧 API）：

```js
// 稳定外部 request id；ledger 只 reserve/commit 一次。
admitRequest({ inputChars, kind, request_id })
  -> { ok:true, reservation_id, request_id } | { ok:false, failure_mode, reason }

// 精确按 reservation_id commit；无 reservation_id 不再作为正常记账路径。
commitRequest({ reservation_id, usage, inputChars })
  -> { ok:true|false, record_id, duplicate?:true, reconciliation?:object }

// 只读视图
snapshot() -> { consumed, reserved, remaining, pending_reservations, request_records, ... }
```

联合准入由 `c6-model-worker.mjs` 的 gate 协调两个 ledger（campaign `ledger` + task `activeLedger`）：

```text
measure actual llmContext window
-> campaignLedger.admitRequest({request_id})   若失败：rejected（provider 0）
-> taskLedger.admitRequest({request_id})       若失败：补偿 campaign reservation（cancel），rejected（provider 0）
-> persistRequest({phase:"reserved", request_id, campaign_reservation_id, task_reservation_id})
   若失败：补偿两层 in-memory reservation，reservation_persist_failed（provider 0）
-> provider call
-> 两层 commitRequest(reservation_id)
-> persistRequest({phase:"committed", ...})
-> settled（await durable）；失败 -> accounting_failure + reconciliation，停止
```

- 同一 ledger object（campaign === task，单 ledger 模式）：只 reserve 一次、commit 一次。
- 两个 ledger：一个 request id、一个 task reservation、一个 campaign reservation、一条 durable linked record、provider call 一次、各 commit 一次。
- 补偿语义：仅当 provider **尚未发生** 时允许释放 in-memory reservation；provider 发生之后只 commit/reconcile，不释放。
- `cancelReservation({reservation_id})` 新增：把 pending hold 释放回 remaining，仅在 provider 前使用，并记录 `phase:"released"`。

identity 规则：

| 字段 | 生成者 | 语义 |
| --- | --- | --- |
| `request_id` | gate（`req-<task>-<n>-<clock>`） | 一次 provider request；两层 reservation 共享 |
| `task_reservation_id` | task ledger | task 账本唯一键 |
| `campaign_reservation_id` | campaign ledger | campaign 账本唯一键（单 ledger 时与 task 相同） |
| `session_id` | Host/entry | 当前 SDK session 标识（不可得时 null） |

## 3. R14：真实 transcript 窗口覆盖表

gate 位于 `agent.streamFunction(model, llmContext, options)`。真实 `TranscriptContext =
{ messages }`，其中 system prompt 与 **tool schema 在 leading system message 的 `toolsAdded`**，
没有顶层 `llmContext.tools`。测量函数必须同时兼容两者（真实 SDK 用 `messages[*].toolsAdded`；
部分受控测试传顶层 `tools`）。

`measureProviderInput({ llmContext, promptMetadata, outputReserveChars }) -> { chars, coverage, source, details }`

| 覆盖项 | 来源 | 计入 | 说明 |
| --- | --- | --- | --- |
| system/user/assistant/toolResult 内容 | `messages[*].content`（string 或 content 数组，text/thinking/toolCall/图片占位） | 是 | 逐消息序列化字符数 |
| 消息 role/结构开销 | 每条消息固定少量字符 | 是 | 避免低估 |
| tool schema（name/description/parameters） | `messages[*].toolsAdded` + 顶层 `llmContext.tools` | 是 | `JSON.stringify` 计数 |
| ROM/RAM/system 约束 | 已在 leading system message 的 `content` 中 | 不重复 | 若调用方另传 `promptMetadata` 未包含于 transcript 才加 |
| output reserve | 配置 `context.output_reserve_chars` | 是 | 输出预留 |
| backend tokens/currency | 后端 | 否 | 始终 `null/unknown`，字符估算标 `estimated` |

要求：首请求与 continuation 同一函数同一门；超窗在 provider call 前 `context_window_exceeded`；
request record 保存 `input_chars`、`coverage`、`source`；不声称精确 tokenizer。

## 4. durable event 字段（runtime.note / payload.kind=c6.request，schema 1.1）

```json
{
  "phase": "reserved | committed | rejected | released | reconciliation_required",
  "campaign_id": "campaign-...",
  "task_id": "task-001",
  "episode_id": "ep-task-001",
  "session_id": "sess-...|null",
  "request_id": "req-task-001-1-...",
  "task_reservation_id": "res-...",
  "campaign_reservation_id": "res-...",
  "input_chars": 1234,
  "coverage": ["messages", "tools", "output_reserve"],
  "source": "estimated",
  "usage": { ... } | null,
  "usage_source": "estimated|unknown",
  "failure_reason": null | "durable_append_failed",
  "provider_started": true
}
```

规则：`rejected` / `released` 不得写成 `reservation_id:null` 的正常 reserved；committed 事件必须含
非空 request/task/campaign reservation id；重启从 `reserved`（无匹配 committed）重建 pending，
从 `committed` 重建 consumed。

## 5. accounting failure / reconciliation 语义

`worker.run()` 返回（非成功）：

```js
{
  ok: false,
  failure_mode: "accounting_failure" | "budget_exhausted" | "context_window_exceeded"
              | "reservation_persist_failed" | "reconciliation_required" | "provider_error",
  detail: string,
  provider_requests: number,        // 真实已发生数量，不归零
  reconciliation: {
    category, request_id, task_id, campaign_id,
    task_reservation_id, campaign_reservation_id,
    provider_started: boolean,
    commit_error: string|null,
    pending: {campaign, task}, consumed: {campaign, task}
  }
}
```

根因区分：provider error（transport）≠ commit error（accounting）≠ window/budget refusal。
provider 已发生但 commit 失败 → 不释放 consumption、不重试、不进入 Broker。

## 6. 任务依赖图与文件 ownership（全部主 DS，串行）

| 阶段 | 范围 | 依赖 |
| --- | --- | --- |
| PG-0 | 本文件 + 基线/契约 | BASE |
| PG-1 | `aegis-c6-recheck-boundaries.mjs` 及必要 helper：补正例/恢复/联合账本/Broker-boundary/transcript | PG-0 |
| PG-2 | `c6-tool-ledger.mjs`：request_id、cancel、幂等、联合可表达、pending/rebuild | PG-0 |
| PG-3 | `c6-model-worker.mjs`：measureProviderInput、联合 admission、durable reserved、final flush、accounting stop | PG-2 |
| PG-4 | `c6-entry.mjs`：persistRequest 写 request/task/campaign id 与 phase；rebuild；不再产生 null-id | PG-3 |
| PG-5 | Composite/Broker 接线测试 | PG-4 |
| PG-6 | 全量审查、回归、Biome、tsc、mutation、文档 | PG-5 |

禁止：第二套 Scheduler/Broker/Oracle/预算框架；改 Pi 核心/auth/models/lockfile；真实 provider/目标/费用。

## 7. 测试矩阵（required）

| case | 输入来源 | 预期 | 证据 |
| --- | --- | --- | --- |
| R12 | synthetic_fixture | 末次 commit `{ok:false}` → `ok:false` / `accounting_failure` | 返回值 |
| R12b | synthetic_fixture | 同上 → composite 不调用 brokerWorker.run | broker effect count = 0 |
| R13 | synthetic_fixture | campaign=0、task>0 → provider call 0 | streamFunction count |
| R13b | synthetic_fixture | campaign 拒绝 → 不写任何 reserved（尤其 null-id） | persisted 记录数 |
| R13c | synthetic_fixture | campaign=1、task=2 → provider 1；两层各 pending 1；各 consumed 1 | ledger snapshot |
| R14 | synthetic_fixture | 大 user message 超窗 → provider call 0 | streamFunction count |
| R14b | synthetic_fixture | 大 tool schema + tool-result 超窗 → provider call 0 | streamFunction count |
| R4（旧） | synthetic_fixture | task 额度 1 → provider call 1 | 保留 |
| R5（旧） | synthetic_fixture | reserved 失败 → provider 0 | 保留 |
| R6（旧） | synthetic_fixture | commit 失败停止 NEXT | 保留 |
| X1/X4（旧） | synthetic_fixture | pending 扣减、duplicate commit 幂等、restart 重建 | 保留 |
| PG-CON | real-sdk+faux | 合法 transcript 通过且进入 Broker；最终 commit 成功 | provider/effect count |

新增测试的 expected 来自本契约，不由实现返回值倒推；旧代码需为 FAIL（red）。

## 8. 当前 blocker / deferred

- **current_blocker**：R12 final flush；R13 campaign+task 联合准入；R14 真实 transcript；
  null-id reserved/事后 mirror；accounting failure 停止与 reconciliation。
- **non_blocking**：无。
- **deferred**：真实 provider pilot、真实计费/token 精确性、OS sandbox、真实目标、
  F16 缓存、多 Worker/容器、收益/迁移/日常实验。

## 9. 未实测限制

- 只经 faux provider 与受控 `streamFunction` 替身验证；真实 provider 计费/失败模式未实测。
- `measureProviderInput` 是字符估算，非精确 tokenizer；backend token 仍 unknown/null。
- workspace 不是 OS sandbox。

---

# 实施结果（PG-1…PG-6）

## A. R12/R13/R14 实现对应表

| 要求 | 实现位置 | 实际行为 | 验证 |
| --- | --- | --- | --- |
| R12 末次 durable commit | `c6-model-worker.mjs` `run()` 尾部 `finalCommit` | `prompt()` 返回后 await `gate.pendingCommit`；失败→`ok:false`/`accounting_failure`/reconciliation，不返回 decision | R12、R12b |
| R12b 不进入 Broker | `createCompositeWorker` 已有 `if (!planned.ok) return planned` | accounting failure 时 `brokerWorker.run` 调用 0 次 | R12b |
| R13 联合准入 | `installProviderGate` 中 campaign→task 两次 `admitRequest`，同一 `request_id` | 任一层拒绝 provider call 0；task 拒绝时补偿 campaign hold | R13、R13b、R13c、C6-X2 |
| R13b 无 null-id reserved | 仅两层 in-memory admission 成功后才 `persistRequest({phase:"reserved",...})` | campaign=0 时 `persistRequest` 调用 0 次 | R13b |
| R13c 各一 reservation/commit | `outstanding` 携带两个 reservation id；`message_end` 各自 commit | campaign/task 各 pending 1、各 consumed 1；provider 1 | R13c |
| R14 真实 transcript | `measureProviderInput({llmContext})` | 每请求按实际 `messages`+tools+reserve 计窗；首请求与 continuation 同一门 | R14、R14b、R14c、R15 |
| 持久层可重建 | `summarizeRequestLedger(events)`（exported） | `reserved` 无 id 忽略；`committed` 无 id 不合法；pending 仍占额度 | R16 |

## B. request 状态机（实际）

```text
created -> (window/budget refusal) rejected            provider 0
created -> admitted(campaign) -> (task refusal) released(补偿) provider 0
admitted -> reserved_durable (persistRequest ok)       provider 0 之前
reserved_durable -> provider_started
provider_started -> provider_finished (message_end)
provider_finished -> committed_in_memory(campaign+task) -> committed_durable -> settled
provider_started -> (commit ok:false/throw) accounting_failure + reconciliation -> Broker 0
```

## C. durable event 字段样例（真实产品运行，faux）

```json
{"kind":"c6.request","phase":"reserved","campaign_id":"campaign-c6-data","task_id":"task-001",
 "request_id":"req-task-001-1-1791906887923",
 "task_reservation_id":"res-task-task-001-0-1791906887924-0",
 "campaign_reservation_id":"res-campaign-campaign-c6-data-0-1791906887924-0",
 "input_chars":5305,"coverage":["messages","tools","output_reserve"],"input_source":"estimated"}
{"kind":"c6.request","phase":"committed","campaign_id":"campaign-c6-data","task_id":"task-001",
 "request_id":"req-task-001-1-1791906887923",
 "task_reservation_id":"res-task-task-001-0-1791906887924-0",
 "campaign_reservation_id":"res-campaign-campaign-c6-data-0-1791906887924-0",
 "input_chars":5305,"coverage":["messages","tools","output_reserve"],"input_source":"estimated",
 "tool_calls":0,"usage":{...},"usage_source":"estimated"}
```

## D. 具体数值

| 场景 | campaign consumed | task consumed | pending | provider calls | Broker effects |
| --- | --- | --- | --- | --- | --- |
| 正常两任务 | 4 | 各 2 | 0 | 4 | 2 |
| R13（campaign=0,task=5） | 0 | 0 | 0 | 0 | 0 |
| R13c（campaign=1,task=2） | 1 | 1 | provider 前 1/1，后 0 | 1 | — |
| R12/R12b（末次 commit ok:false） | 保留已发生 | 同上 | — | 1 | 0 |
| restart 二次运行 | 4（不重复计费） | — | 0 | 0（任务已完成） | — |
| rebuild（`summarizeRequestLedger`） | 4 | 4（全任务） | 0 | — | — |

## E. transcript/window coverage 与 provider call

| 输入 | window=2000 时 call |
| --- | --- |
| 小 messages+tools（首请求合法） | 1 |
| 大 user message 10000 | 0 |
| 大 tool schema 单独（小 message） | 0 |
| 大 tool-result 18000 | 0 |
| 首请求小、continuation 5000 | 1（仅首请求） |
| 合法两任务真实链 | 4（每任务 2） |

## F. mutation → case → 实际 FAIL

| mutation | 目标 case | 实际 |
| --- | --- | --- |
| 删除 final `pendingCommit` flush（commitOk=true） | R12/R12b | FAIL ✓ |
| accounting failure 改 ok:true | R12/R12b | FAIL ✓ |
| 仅保留 Task admission | R13/R13b/R13c | FAIL ✓ |
| campaign 用 null-id mirror commit | R13c | FAIL ✓ |
| gate 改回缓存 prompt estimate | R14/R14b | FAIL ✓ |
| 不读 `llmContext.tools` | R14c（新增） | FAIL ✓ |
| 仅首请求检查窗口 | R15（新增） | FAIL ✓ |
| 去掉 pending 在 remaining 扣除 | C6-X1 | FAIL ✓ |
| 重复 commit 非幂等 | C6-X1 duplicate | FAIL ✓ |

## G. exact commands / exit / log

```bash
node --test Pi_Agent_base/tests/aegis-c6-recheck-boundaries.mjs          # 23 tests / 23 pass, exit 0
node --test Pi_Agent_base/tests/aegis-c6-external-boundaries.mjs         # 22 tests / 22 pass, exit 0
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs <out> <15 C6 scripts>   # 15 scripts, 0 failed
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs <out> <26 regressions>  # 26 scripts, 0 failed
tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json                        # 196 legacy diagnostics, 0 in changed files
biome check Pi_Agent_base/memory/campaign Pi_Agent_base/tests/aegis-c6-*.mjs  # exit 0
```

日志：`Pi_Agent_base/runtime/dev/c6-gate/`（ignored）：`final/results.json`、`regress2/results.json`、
`tsc3.log`、各 suite `*.log`。

## H. 未实测限制

- 仅 faux provider + 受控 `streamFunction` 替身；真实 provider 计费/失败模式未实测。
- `measureProviderInput` 是字符估算，非精确 tokenizer；backend token/currency 仍 unknown/null。
- workspace 不是 OS sandbox。
- 未启动真实 provider pilot；真实环境模型/任务/预算/凭据/授权/回滚由用户单独确定。
