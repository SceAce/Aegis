# C6 模型 Agent 与经验闭环 — 工作计划

状态：`internally_verified / awaiting_external_review`（C6-A–F + 两轮审查修复；交一次限定复验）。
第一轮修复 `C6_REPAIR_DS_PROMPT.md`（X1–X12）后外部复验仍认定五组遗漏（`C6_EXTERNAL_REVIEW.md` §4）。
本轮按 `C6_RECHECK_REPAIR_DS_PROMPT.md` 在 `23d754e` 上修复五组：通用 provider 调用前门、
registered-test 可信完成、aegis_read 真实路径/当前 Task grant、runner 实际初态、学习真复用/真实前态。
外部边界套件 **22/22 pass**、聚焦复验 **13/13 pass**、学习闭环全绿、14 原 C6 脚本 exit 0。
分支 `feat/c6-agent-product`，起点 `d3dc28f`（父仓库）/ 内嵌 Pi `42a3497d0`。
依据：`C6_AGENT_PRODUCT_TASK.md`、`AGENT_DEVELOPMENT_STANDARD.md` §3.1、`AGENT_TESTING_STANDARD.md`、
`GIT_STANDARD.md`、`DS_ORCHESTRATION_WORKFLOW.md`。

## 1. BASE 基线（已记录）

记录于 ignored `Pi_Agent_base/runtime/dev/c6-base/baseline.json`。

| 项目 | 实测 |
| --- | --- |
| 父仓库 HEAD / 分支 | `d3dc28f` / `feat/c5-integration`（开始工作树干净） |
| 任务分支 | `feat/c6-agent-product` |
| 内嵌 Pi HEAD | `42a3497d0`（干净；父仓库 gitignore，不入 gitlink） |
| Node / npm | v26.10.0 / 11.19.1 |
| C5 四 suite + external-boundaries | 全部真实 exit 0（本次复跑） |
| C5 session-sdk（source resolver + faux） | exit 0，14 check 块 |
| Campaign tsc | exit 1，74 条既有诊断（与 C5_EXTERNAL_REVIEW 一致） |

## 2. 复用与禁止

复用：`scheduler.mjs`、`host.mjs`、`broker-worker.mjs`、`host-oracle.mjs`、
`campaign-mode.mjs`、`c3-entry.mjs`（assembly）、`c5-entry.mjs`、`campaign-config.mjs`、
`projection.mjs`、`observation-server.mjs`、`report-entry.mjs`、`report-export.mjs`、
`session-supervisor.mjs`、`handoff-host.mjs`、`events.mjs`、`ram.mjs`、`board.mjs`、`state.mjs`、
`learning-bridge.mjs`、`learning-router.mjs`、`workflow-engine.mjs`、`experience-compiler.mjs`、
`learning-store.mjs`、`script-registry.mjs`、`action-contract.mjs`。

禁止：第二套 Scheduler/Broker/Oracle/证据/学习框架；改内嵌 Pi 核心；改用户 auth/models/
settings/lockfile；真实 provider/外部目标调用；自动验收模型。

## 3. 冻结的公共契约（编码前）

### 3.1 CLI 与配置白名单

新增产品入口 `memory/campaign/c6-entry.mjs`，子命令：
`run | status | pause | resume | cancel | export | observe | rotate | measure`。

配置 `campaign-config-1.1`，在 1.0 基础上新增顶层键（其余仍拒绝）：
- `schema_version: "campaign-config-1.1"`（1.0 仍接受，映射到 faux 默认）
- `provider`: 对象 `{ kind: "faux" | "local-openai" | ... , model, base_url?, credential_ref? }`
  - `kind` 必须属于已注册 provider 白名单；未知/缺配置拒绝。
  - `faux` 为开发默认；`local-*` 只接受 loopback `base_url`。
  - `credential_ref` 只允许引用环境变量名/文件路径形式，永不打印值。
- `context`: `{ max_total_input_chars, output_reserve_chars, strategy: "bounded_ram"|"full_history" }`
- `learning`: `{ policy: "off"|"shadow"|"explicit", promote_experience: false, environment: {...} }`
- `task_family`: `"fixture-state" | "structured-data-repair" | "code-repair"`（显式，无自动推断）
- `measure`: `{ out_dir, attempts_manifest? }`

### 3.2 资源所有权

| 资源 | Owner |
| --- | --- |
| EventLog writer | Host（`bindHostEventLog` 借用给 Observer，退出时解绑） |
| Campaign gate | Host 创建，同一对象注入所有 Session 的 ResourceLoader |
| SDK runtime | C6-A launcher 创建/替换/dispose |
| 预算账本 | Host（唯一 charge owner，读写 committed 事件） |
| Session 生成 | Host（经 `session-supervisor`） |
| 经验 store | 派生，可重建（`learning-store`） |

### 3.3 Task/Episode/Session 映射

- 当前 Task 来自 committed projection 的 `ready` 队首；SDK session 绑定该 Task 的
  `task_id`/`attempt`/Episode（`ep-<task_id>`）。
- Session 更换保留同一 Episode；不增加独立 Episode。
- 下一 Task 需显式 bind，不沿用前一 Task 的 SDK 标签。

### 3.4 预算基线

- 维度：`wall_time_ms`、`model_requests`、`tool_calls`、`session_count`，以及新增
  `input_chars`（估算门）。
- 每次 provider 请求（含自动 tool loop）与工具调用前预留 `model_requests`/`tool_calls`。
- 不可观测的 token/金额写 `null`/`unknown`；faux 估算标注 `estimated`。
- 跨 Task/restart 从 committed 事件累加，不重置、不双扣。

### 3.5 证据引用与跨运行导入

- proof/Manifest/action/adapter digest 有明确 scope（campaign/task/episode）。
- 跨运行导入校验源 stream chain、Manifest digest、adapter digest、action version/digest。
- 只复制 Outcome ID 或 active JSON 不作数。

### 3.6 学习 policy

- 默认 `promote_experience: false`。
- 只有 Host 显式 `learning.policy` + 明确 `proof_ids` 才调用 Compiler。
- 模型不能晋升 active；`candidate` 不当 hint。

### 3.7 服务生命周期与退出

- 执行模式完成/失败/暂停/取消后有界 cleanup。
- observe 模式 loopback listener 常驻到显式关闭/SIGTERM。
- SIGTERM drain；SIGKILL 恢复先 reconcile；未决非幂等动作不盲重发。
- 退出码：0 成功；1 运行/控制/导出失败；2 用法/配置错误。

## 4. 任务图与依赖

| 任务 | 文件范围 | 依赖 | 里程碑提交 |
| --- | --- | --- | --- |
| C6-A SDK/Host 生命周期 | `c6-entry.mjs`、`c6-sdk-runtime.mjs`、`campaign-config.mjs`、`index.mjs` | BASE | `feat: C6-A` |
| C6-B 模型 Worker/计量 | `c6-model-worker.mjs`、`c6-tool-ledger.mjs`、`structured-data-adapter.mjs` | A | `feat: C6-B` |
| C6-C Campaign 学习 | `c6-learning.mjs`（接 bridge/router/compiler/store） | B | `feat: C6-C` |
| C6-D provider 接口 | `provider-config.mjs` | A/B | `feat: C6-D` |
| C6-E 测量/运行支撑 | `c6-measure.mjs`、`c6-runner.mjs` | B/C/D | `feat: C6-E` |
| C6-F 第二任务族/交付 | `code-repair-adapter.mjs`、runbook | A-E | `feat: C6-F` |

主 DS 拥有共享 Host/entry/Observer/EventLog/config/resolver/index/report/runner 与全部文档。
无子 Agent 能力，串行执行并如实记录。

## 5. 测试矩阵与 required 门

见 `C6_AGENT_PRODUCT_TEST_MATRIX.md`。required 门为 C6-P1–P8 对应脚本；
冻结范围内无未解阻塞。

## 6. 范围冻结（§3.1）

- `current_blocker`：当前可达假成功、授权越界、重复副作用、预算错误、权威数据损坏。
- `non_blocking`：真实模型能力、token 精确性（未校准）、UI 样式。
- `deferred`：F16 缓存优化、多 Worker、容器/远程、任意经验组合、权重训练、
  真实模型 pilot、效果对照、迁移与日常试用。

## 7. 未实测限制（列明）

- 只通过 faux provider 与 SDK create seam 替身验证 provider 参数传递；
  具体真实 provider（如某本地 OpenAI 兼容 endpoint）未实测。
- 不读取真实凭据、不请求真实模型。

## 8. C6 请求生命周期收敛轮（本轮，基线 `17e1728`）

状态：`internally_verified / awaiting_external_review`（DS 内部工程验证，非外部审查）。
本轮把交付单位定为“一次 provider 请求从准入、调用、结算、异常收尾到重启恢复的完整生命周期”；
四项已复现缺陷是切入点，不是四个独立补丁。

### 8.1 根因与统一契约

| 缺陷 | 根因 | 统一后的规则 |
| --- | --- | --- |
| A 内存 commit 失败被 durable success 掩盖 | 先算 `commitFailed`，但存在 durable writer 时以 durable 成功决定放行 | 联合成功 = **两层内存 commit + durable commit + 无 outstanding**；任一内存提交失败即写 `reconciliation_required`，不得写 joint-success，durable 成功不得覆盖 |
| B provider error 未进入可恢复 reconciliation | `prompt()` 抛错时提前 return，绕过统一收尾 | `catch` 不再提前返回；provider 已启动但无 completion 时保留 hold、写 reconciliation、阻断后续 dispatch |
| C Task pending 未按 Task 隔离 | 入口生成一个全局 `taskBaseReserved`，各 Task 复用 | 每个 Task ledger 只注入自身 pending/committed 身份；Campaign ledger 保留聚合责任 |
| D 部分 committed 被当联合提交 | `summarizeRequestLedger` 接受单侧 reservation id 并删除 pending | committed 必须含 request + 两侧 reservation 且与原 reserved 一致；`reconciliation_required` 表示未决，不表示释放 |

共享契约落在新纯模块 `Pi_Agent_base/memory/campaign/c6-request-lifecycle.mjs`
（`validateReservation`/`validateCommittedRecord`/`summarizeRequestLedger`/`reservedSeedForTask`），
由 live gate、`c6-entry.mjs` 持久化与 restart/measure 共用，避免两套互相矛盾的规则。

### 8.2 状态与收尾

```text
created -> admitted -> reserved_durable -> provider_started
        -> provider_finished -> committed_in_memory -> committed_durable -> settled
拒绝（调用前）：rejected / reservation_persist_failed            provider 0
未确认结束：provider_started -> reconciliation_required          保留 hold，阻断后续
provider 错误（有可信结束）：committed(provider_status=error)    计费一次，返回失败
```

关键不变量：

- 调用前拒绝只补偿“确定未 dispatch”的占用；调用后不确定不退款、不换 request id 重试。
- 重启遇到未决 reserved/reconciliation 或 invalid/conflicting 重建记录时，走运行停止/阻断路径
  （`reconciliationGuard` + 每请求 pending 检查），仅在 report 显示 unknown 不算。
- Task ledger 只操作自身 reservation；同一 ledger object 只 reserve/commit 一次。
- `checkpoint`/`report`/`measurement` 不覆盖权威请求状态。

### 8.3 本轮范围

允许修改：`c6-request-lifecycle.mjs`（新）、`c6-model-worker.mjs`、`c6-entry.mjs`、
`index.mjs`、`tsconfig.aegis-campaign.json`、两个新测试脚本与一个 child harness、C6 文档。
不允许：第二套预算/事务/调度平台、改 Pi 核心/凭据/lockfile、真实 provider/目标、
全仓历史类型清理、把任务扩大为历史 warning 清理。

required 检查与真实结果见 `C6_AGENT_PRODUCT_TEST_MATRIX.md` / `C6_AGENT_PRODUCT_IMPLEMENTATION_REPORT.md`
本轮收敛段；私有日志 `Pi_Agent_base/runtime/dev/c6-lifecycle-run1/`（ignored）。

## 9. C6 三个事实分离轮（本轮，基线 `93d4617` / 补测 `290313f`）

状态：`internally_verified / awaiting_external_review`（DS 内部验证，交限定复验；
非外部接受、非真实 pilot）。依据 `docs/C6_THREE_FACTS_DSV41FLASH_TASK.md`、
`C6_EXTERNAL_REVIEW.md` §7、`C6_AGENT_LIFECYCLE_OPEN_SOURCE_RESEARCH.md`。

本轮将三个事实分开表示与推导，修复独立审查两组阻塞：

1. **每侧预算责任**：`summarizeRequestLedger` 改为 side-aware；durable reconciliation 确认的一侧
   按身份恢复 consumed（幂等）；未知侧保留 hold；输入占用沿既有权威估算字段。
2. **请求联合结清**：`unresolved` 独立于 pending；只有合法完整 `committed` 才结清；
   两侧已记账但无联合 settlement 仍为未决，恢复 guard 实际阻断。
3. **规划结束结果**：`classifyStopReason` 保留 Pi 的 error/aborted 硬退出；
   aborted/error 不返回可执行 decision，已发生请求仍计费。

允许范围：`c6-request-lifecycle.mjs`、`c6-model-worker.mjs`、`c6-entry.mjs`、`index.mjs`、
直接接线与测试、C6 文档。禁止：第二套预算/事务/调度平台、改 Pi 核心/凭据/lockfile、
真实 provider/目标、全仓历史类型清理、自动退款/人工结算平台。

required：18 个 C6 脚本 0 failed（旧15 + lifecycle-convergence + lifecycle-restart +
architecture-review）、26 个回归 0 failed；tsc 196→196（修改文件 0）；Biome exit 0。
日志 `Pi_Agent_base/runtime/dev/c6-three-facts-run1/`（ignored）。
