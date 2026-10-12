# Aegis C1 Closure 契约与修复基线

状态：**上一轮 C1 修复基线；C1 尚未通过外部验收**。

最新七组跨模块发现见 `C1_CLOSURE_EXTERNAL_AUDIT.md`。当前执行与精确契约见 `C1_INTEGRATION_CLOSURE_TASK.md`，测试见 `C1_INTEGRATION_TEST_SPEC.md`。这些文档澄清缓存前缀追尾、append全局顺序、durable失败处理、完整Outcome引用和真实动态分发；不要把历史全绿当成当前外部通过。

本文件承接 C1 实现报告和独立审计发现。它不是重新实现 C1 的任务书，也不是允许进入 C2 的证明。主 DS 一次接收总任务，但必须先生成本文件要求的测试，再拆分小任务、实现、集成和审查。

## 1. 当前判定

已运行并通过的测试只能说明已有测试脚本通过。当前状态固定为：

```text
C0 Closure: internally verified, awaiting external review
C1-A event contract: conditional
C1-B projection: conditional
C1-C ownership/checkpoint: not accepted
C1-D scheduler: not accepted
C1-E recovery: not accepted as durable/exactly-once proof
C2: blocked
```

C1 当前不得宣称：

- durable checkpoint 已接入调度器；
- 任意外部副作用 exactly-once；
- 动态任务 admission 已由产品链路执行；
- 所有 `runtime.note` 来源都可以驱动 Campaign 状态；
- checkpoint 恢复已经验证了真实 EventLog durability。

## 2. 必须保持的边界

本轮只处理 C1-A 到 C1-E 的收尾和审计缺口：

- `Pi_Agent_base/memory/campaign/` 的 C1 模块；
- C1 相关测试、helper、测试配置和开发报告；
- 必要的 Aegis-owned 文档。

本轮不得实现：

- C2 真实 Pi Host-level Session 轮换；
- C3 真实 Broker/Oracle adapter；
- C4/C4a Web UI、Pi `/aegis board`、`/aegis tasks`、`/aegis dashboard`；
- 真实 CTF、渗透目标、远程网络、凭据访问；
- 分布式多主机 ownership。

不要修改嵌入 Pi 核心、auth、model settings、lockfile、旧 Python 删除状态。除非发现 C1 无法复用现有 EventLog 契约，否则不要修改 `memory/runtime/events.mjs`；若需要修改，必须列出兼容影响、回归范围和原因。

## 3. C1 统一契约

### 3.1 Event source 与 event kind

`runtime.note` 是通用事件外壳，不等于任何 source 都有权改变 Campaign 状态。事件验证必须同时检查：

1. `payload.kind` 属于冻结的 `campaign.*` 列表；
2. `payload.campaign_id` 匹配当前 Campaign；
3. source.kind 对当前 kind 有权限；
4. Task/Episode/Proposal/Outcome/criterion/evidence 的绑定完整；
5. `expected_revision` 与当前事件投影一致；
6. command/proposal/outcome id 的幂等规则通过。

来源规则固定如下：

| kind | 允许来源 | 语义 |
|---|---|---|
| `campaign.proposal.submitted` | `llm`、`agent`、`human` | 只记录提案，不改变队列授权或状态 |
| `campaign.proposal.blocked` / `rejected` | `runtime`、`human` | 记录准入判断 |
| `campaign.proposal.admitted` | `runtime`、`human` | 只有引用已验证的 proposal 和 dynamic-policy decision 时才改变队列 |
| `campaign.task.started` / `paused` / `resumed` / `cancelled` | `runtime`、`human` | 调度控制，不能由模型自报驱动 |
| `campaign.task.completed` | `runtime` | 只能引用已经提交且有效的 Task Oracle success |
| `campaign.task.failed` | `runtime` | 调度/执行故障；不等于 Oracle task failure |
| `campaign.task.unknown` | `runtime`、`oracle`、`human` | 保留未知，不等于失败 |
| `campaign.oracle.result` | `oracle`、明确注册的平台结果源、`human` | 结构化 Outcome，必须完整绑定和有证据 |
| `campaign.budget.*` | `runtime` | 由单写者根据账本产生，不能由模型自报 |
| `campaign.reconciliation.*` | `runtime`、`oracle`、`human` | 恢复/核对状态 |
| `campaign.handoff.*` | `runtime`、`human` | C2之前只保留契约，不执行真实 Session |
| `campaign.campaign.stopped` | `runtime`、`human` | 停止原因和预算/取消状态 |

`agent`、`observer`、`environment` 不能因为“不是 llm”就自动获得全部状态写权限。模型消息被 Observer 记录后，仍是 Claim/Proposal，不能伪造 Oracle result。

### 3.2 Dynamic proposal admission

`campaign.proposal.admitted` 不能单独创建任务。必须有同一 Campaign 中的可解析准入依据：

```text
proposal.submitted
  -> dynamic-policy.validate/admit
  -> admission decision + checks
  -> one durable admitted event
  -> projection creates task and reservation
```

Projection 或 Host 必须重新确认：

- proposal id 未重复；
- parent task 存在且不处于非法状态；
- parent stage 属于 parent task；
- task type 在 Manifest 动态策略内；
- target/capability/Oracle/adapter 在既有授权范围内；
- depth 由 parent chain 计算，不接受模型自报值；
- fan-out、Campaign 总 task_count、预算 reservation 未超限；
- task 定义有完整目标、criteria、scope、Oracle、stop condition；
- admission decision 没有增加授权、目标、网络、凭据、adapter 或总预算。

只包含一个“可信 runtime admitted”字符串而没有完整引用的事件，必须被拒绝或只记录为异常。

### 3.3 Queue transition

Projection 必须使用既定转移表，非法转换不改变状态：

```text
queued -> ready | cancelled | failed
ready -> running | paused | cancelled | failed
running -> waiting_oracle | completed | failed | unknown | paused | cancelled
waiting_oracle -> completed | unknown | failed | paused | cancelled
paused -> ready | cancelled | failed | unknown
completed/failed/unknown/cancelled -> no direct transition
```

特别要求：

- `task.started` 只能从 `ready`，或经过重新验证的 `queued` 转到 `running`；
- `task.resumed` 必须重新检查依赖和预算，不能无条件设置为 `ready`；
- terminal task 不能被旧 command 重新启动；
- failure/unknown/cancelled 不能被另一个标签静默覆盖；
- 一个 Campaign 最多一个 `running` Task；
- 依赖只有在可信 Task Oracle success 且绑定正确时才满足。

### 3.4 Budget ledger

预算有三类值：

```text
limit
reserved_outstanding
consumed
released
```

剩余可分配预算：

```text
remaining = limit - reserved_outstanding - consumed
```

要求：

- 每次 dispatch 前重新读取 projection ledger；
- reservation/consumed/released 必须受单写者和幂等 command 控制；
- consumed 不能超过对应 reservation，除非是明确的 Host policy 且有审计原因；
- static task allocation 和 dynamic reservation 使用同一 ledger；
- cancel/terminal/release 的数额按实际持有量 clamp；
- 重启后预算从事件源重建，不能归零；
- Scheduler 不能只依赖注入的 `budgetExhausted()` 回调来证明预算控制；
- `task_count`、wall-time、model requests、tool calls 的限制都要参与准入/dispatch；
- token/dollar 不可测时使用 `unknown`，不能伪造零值。

### 3.5 Checkpoint 必须接入 Scheduler

C1-C 的 `readCheckpoint/writeCheckpoint` 不是独立工具测试就算完成。Scheduler 必须真正执行：

```text
acquire ownership
  -> read/validate checkpoint if present
  -> otherwise rebuild from committed events
  -> apply new event durably
  -> project queue/ledger
  -> write checkpoint bound to current event tail
  -> dispatch only when required durable boundary is met
```

Checkpoint 必须绑定并验证 Campaign/Manifest、schema/projection版本、已验证stream全局位置与digest、运行state revision、完整snapshot和payload digest。Episode的sequence不是Campaign全局顺序。

精确匹配tail的缓存可校验后使用；缓存是日志合法前缀时，验证prefix/snapshot后允许reduce tail。Foreign、超前、篡改、不支持版本或无法证明prefix有效时全量重建。不得仅read返回ok就声称used_checkpoint。

安全生命周期/控制边界写checkpoint，具体频率由主DS记录；写失败有诊断且fallback，不能伪造成功。checkpoint是派生缓存，不得比EventLog真相优先，也不要求每个metadata事件都刷缓存。

### 3.6 Ownership

当前只承诺 single-host ownership，不能写成 distributed lease 或 exactly-once lock。

自动 reclaim 必须真正原子：

- 不能两个进程同时读到 dead owner 后都覆盖同一个 lock 并都成功；
- 复用当前lock directory和reclaim claim基础，验证真正竞争；目录mkdir、rename各自原子不等于整个reclaim流程自动互斥；
- Reclaim必须先对已核对dead-owner获得单独的独占claim，再核对owner generation并替换；不能多个stale-read进程各rename新owner目录；
- owner 活着时不能以过期时间抢占；
- PID 无法判断时 fail-closed；
- release 必须核对 owner id/pid/token，不得删除新 owner 的锁；
- 进程恢复后必须重新 acquire，不能沿用旧 owner 继续写。

### 3.7 Recovery 与 exactly-once 措辞

C1 只能证明 Scheduler 的 at-least-once recovery discipline 和“不在未知结果时盲目重发”。在没有真实 Action Broker/外部执行器 idempotency/reconciliation 的情况下，不得宣称外部副作用 exactly-once。

测试必须区分：

| 边界 | 预期 |
|---|---|
| durable intent 之前退出 | Worker未调用 |
| durable intent之后、result之前退出 | Action可能已执行；进入 unknown/reconciliation；不盲重试 |
| result之后、checkpoint之前退出 | 从EventLog恢复，不重复提交相同已完成动作 |
| EventLog append/fsync失败 | 副作用不执行或进入明确不确定状态 |
| checkpoint失败 | 事件仍是权威源；下次重建；不报告checkpoint成功 |

Recovery child harness 必须使用真实的 append/fsync/atomic边界，不能用 `writeFileSync` 拼接 JSONL 就宣称 durable EventLog。它可以作为控制流测试，但必须标 `synthetic file sink`。

## 4. 必须增加/修改的测试

### 4.1 Event source

- `agent` 的 `campaign.oracle.result: success` 被拒绝；
- `observer` 的 `campaign.task.completed` 被拒绝；
- `environment` 不能改变 Task/Outcome 状态；
- `llm/agent` proposal 可以记录，但不能 admitted；
- runtime admitted 缺少 proposal decision/evidence/reference 被拒绝；
- oracle result foreign task/episode/criterion/scope/evidence 被拒绝。

### 4.2 Dynamic admission

真实测试链：

```text
submitted -> admitTaskProposal -> admitted -> project
```

同时覆盖：

- 新 target/capability/adapter/network/credentials；
- parent stage foreign；
- depth伪造；
- duplicate semantic task；
- fan-out/count/remaining budget；
- admitted event replay/重复；
- accepted proposal 以新 random task id 重放不能重复效果。

### 4.3 Queue

- terminal task 不能重启；
- paused resume重新检查依赖/预算；
- invalid transition不改状态；
- task.completed没有有效 Oracle不能完成；
- task.failed不能被普通 completed label覆盖；
- one running task。

### 4.4 Budget

- dispatch读取ledger并在limit边界停止；
- consumed超过reservation被拒绝；
- static+dynamic allocation同账本；
- cancel/release不负数、不双释放；
- checkpoint恢复后余额一致；
- 重复command不双扣。

### 4.5 Checkpoint/ownership/recovery

- Scheduler真实调用 `readCheckpoint/writeCheckpoint`；
- checkpoint tail digest mismatch重建；
- checkpoint write failure；
- dead-owner reclaim双进程race；
- owner live不能抢占；
- release race不能删除新 owner；
- real EventLog append/fsync failure before dispatch；
- synthetic file sink和真实 EventLog 测试分开报告；
- 不再使用“side effects exactly once”作为无Broker的总体结论。

## 5. Warning 与报告修正

- 修复所有 Biome warnings 后才写 `Biome clean`；否则如实写 `exit 0 with N warnings`。
- Work plan 的 baseline 必须是实际 commit hash；没有 commit 就写 `working tree baseline; no valid commit identity`，不允许全零占位值。
- 报告区分：测试通过、产品语义已接入、真实 durability已证明、外部副作用已验证。
- 重新运行原有 C0、C1、Aegis 离线和 Pi/faux regression；记录真实退出码。
- C1 内部状态在本轮修复前保持 `not accepted`，不进入 C2。
