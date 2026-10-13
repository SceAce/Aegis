# C6 模型 Agent 与经验闭环 — 实现报告

状态：**internally_verified / awaiting_external_review**（C6 限定工程验收）。
分支 `feat/c6-agent-product`，起点 `d3dc28f`（父仓库）/ 内嵌 Pi `42a3497d0`。
本报告是工程交付，不宣称特定模型能力、context 收益或学习效果成立。

## 1. 实际文件与 owner（主 DS 全部所有；无可用子 Agent，串行执行）

新增产品代码（`Pi_Agent_base/memory/campaign/`）：

| 文件 | 作用 |
| --- | --- |
| `c6-entry.mjs` | C6 产品入口：自动创建 SDK runtime、绑定 Host、驱动模型 Worker、学习、观察、测量、报告、控制 |
| `c6-sdk-runtime.mjs` | 真实 Pi SDK runtime 创建（隔离凭据、allowlist ResourceLoader、共享 gate、Observer、rebind/dispose） |
| `c6-model-worker.mjs` | 模型结构化决策 Worker + 决策工具 + 模型 plan |
| `c6-tool-ledger.mjs` | 调用前请求/工具预算门与总输入估算、usage 来源 |
| `c6-learning.mjs` | Campaign 证据接 learning bridge/router/compiler/store、route-before-model、重建 |
| `c6-runner.mjs` | 有界 attempt runner（单次/清单），逐 attempt 测量 |
| `provider-config.mjs` | provider/model/endpoint 显式解析与拒绝、credential_ref 描述 |
| `structured-data-adapter.mjs` | 首个任务族：结构化数据修复/转换 + 独立 Oracle judge + Manifest |
| `code-repair-adapter.mjs` | 第二任务族：受控代码补丁 + 外部只读测试 Oracle + Manifest |
| `registered-test.mjs` | 外部只读测试的真实子进程运行器 |

修改的共享模块（主 DS 管理）：
`campaign-config.mjs`（1.1 白名单与解析）、`campaign-mode.mjs`（control/proposal 工具放行）、
`broker-worker.mjs`（`setPlan`、action pin）、`scheduler.mjs`（`proposeDynamicTask`、outcome action pin）、
`host.mjs`（`proposeDynamicTask` 暴露）、`host-oracle.mjs`（action pin/when/expect/run_id/每 Episode 独立组）、
`c3-entry.mjs`（`extraContracts`/`judgeFactory` seam）、
`memory/runtime/evidence-resolver.mjs`（索引 Campaign oracle 结果/episode/effect artifact）、
`index.mjs`（C6 导出）。

测试：`aegis-c6-product-chain.mjs`、`aegis-c6-sdk-lifecycle.mjs`、`aegis-c6-rotation-reject.mjs`、
`aegis-c6-ledger-input.mjs`、`aegis-c6-durability-recovery.mjs`、`aegis-c6-learning-reuse.mjs`、
`aegis-c6-provider.mjs`、`aegis-c6-service-measure.mjs`、`aegis-c6-code-repair.mjs`、
`aegis-c6-runner.mjs`、`aegis-c6-runbook.mjs`。

## 2. API / 配置

产品 CLI（`c6-entry.mjs`）：

```bash
node --import Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/memory/campaign/c6-entry.mjs --config <cfg> run|status|pause|resume|cancel|rotate|export|observe|measure \
  [--observe] [--export] [--out <dir>] [--port <n>]
```

退出码：0 成功；1 运行/控制/导出失败；2 用法/配置错误。

配置 `campaign-config-1.1` 新增键：`provider`、`context`、`learning`、`task_family`、`measure`、
`registered_test`；1.0 文档保持原行为。`learning.promote_experience` 必须为 `false`。

关键公共 API：`runC6FromConfig`、`createCampaignSdkRuntime`、`createModelWorker`、
`createToolLedger`、`buildCampaignLearningBridge`、`routeBeforeModel`、`compileExperienceFromProofs`、
`runBoundedAttempts`、`resolveProviderConfig`、`createStructuredDataAdapter`/`createDataRepairJudge`、
`createCodeRepairAdapter`/`createCodeRepairJudge`、`runRegisteredTest`。全部有 JSDoc 与失败语义。

## 3. required 工程验收（C6-P1–P8 + SDK-L1–L8）

逐命令真实 exit（日志 `Pi_Agent_base/runtime/dev/c6-base/req-<name>.out`）：

| case | 脚本 | exit |
| --- | --- | --- |
| C6-P1 product chain | `aegis-c6-product-chain.mjs` | 0 |
| C6-P2 rotation/reject | `aegis-c6-rotation-reject.mjs` | 0 |
| C6-P3 ledger/input | `aegis-c6-ledger-input.mjs` | 0（6 node tests） |
| C6-P4 durability/recovery | `aegis-c6-durability-recovery.mjs` | 0 |
| C6-P5 learning/reuse | `aegis-c6-learning-reuse.mjs` | 0 |
| C6-P6 provider | `aegis-c6-provider.mjs` | 0 |
| C6-P7 service/measure | `aegis-c6-service-measure.mjs` | 0 |
| C6-P8 code repair | `aegis-c6-code-repair.mjs` | 0 |
| SDK-L1–L4 lifecycle | `aegis-c6-sdk-lifecycle.mjs` | 0 |
| SDK-L5 observe | `aegis-c6-service-measure.mjs` | 0 |
| SDK-L6 control/recovery | `aegis-c6-durability-recovery.mjs` | 0 |
| SDK-L7 refuse | `aegis-c6-provider.mjs` | 0 |
| SDK-L8 runbook | `aegis-c6-runbook.mjs` | 0 |
| C6-E runner | `aegis-c6-runner.mjs` | 0 |

关键实测证据（非字符串/ok 断言）：

- **作用/对象**：`SDK-L2` 断言轮换后 `runtime.session()` 是**新对象**（`new_object:true`）、同 Episode、
  账本一次 charge（`session_charges.delta===1`）、相同 gate 加载；`c6 code repair` 断言真实文件内容与
  外部测试退出码。
- **provider 请求**：`C6-P3` 断言请求/工具在**调用前**被门（`pending_reservations` 在 commit 前存在），
  0/1/耗尽边界精确，输入估算超限**不 prompt**。
- **完整链**：所有 C6 suite 断言 `verifyChain(events).ok`。
- **账本**：usage `model_requests`=measured、`input_chars`=estimated、`tokens`/`currency`=unknown；
  measure 导出 `backend_tokens`/`backend_currency` 为 `null`。
- **学习重建**：删除派生 store 后由 committed `experience.compiled` 记录重建，结构比对一致。
- **经验引用**：bridge 解析真实 Campaign outcome（带 action pin）与真实 episode；`candidate` 不路由。

## 4. 回归（显式清单，全部真实 exit 0）

C5 四原 suite + external-boundaries；C2 `session-rotation`/`supervisor-boundaries`/`budget-sdk`；
C3 `host-fixture`/`gate-sdk`/`durability-recovery`/`external-boundaries`；
C4 `report-export`/`external-boundaries`；C4a `observation-http`/`external-boundaries`；
Observer `runtime-handoff`/`failclosed-pi`/`outcome-command`/`verify-first-pi`/`data-use-pi`；
learning `learning-bridge-e`/`learning-commands-pi`；fixture `fixture-orchestrator`；
C1 `eventlog-durability`/`integration-recovery`。共 25 个脚本 exit 0
（日志 `runtime/dev/c6-base/reg-*.out`）。

## 5. 有限 mutation（行为 red 验证）

| mutation | 结果 |
| --- | --- |
| 移除调用前 `model_requests` 预算门 | `aegis-c6-ledger-input` FAIL（1/6 fail）✓ 捕获 |
| 移除 gate 的 direct write/bash/edit 拒绝 | `aegis-c6-rotation-reject` FAIL（3 个断言）✓ 捕获 |
| 强制 `new_object=false` | `aegis-c6-sdk-lifecycle` FAIL ✓ 捕获 |
| 放行 recognized-unimplemented provider | `aegis-c6-provider` FAIL ✓ 捕获 |

均因行为断言失败，非 import/syntax 错误。

## 6. 检查

- **Biome**：所有修改/C6 文件 `biome check --config-path=aegis-biome.json` exit 0（仅少量既有 info）。
- **类型**：`tsc -p tsconfig.aegis-campaign.json` — C6-owned 文件**新增诊断 0**。
  include list 扩展后总诊断 196（原始 include 74）。差额来自既有 `memory/runtime/contribution.mjs`
  与 `handoff-host.mjs`（C2/D 代码）因学习桥/证据解析使实际 import graph 扩展而被 tsc 纳入；
  均非本任务引入，按范围冻结不重写无关 D 代码。记录见
  `runtime/dev/c6-base/tsc-baseline-notes.txt`。未关闭 `checkJs`、未排除本次代码、未降规则。

## 7. 未实测限制（列明）

- 只经 faux provider 与 SDK create seam 替身验证 provider 参数传递；**具体真实 provider
  （如某本地 OpenAI 兼容 endpoint）未实测**。
- 不读取真实凭据、不请求真实模型/外部目标。
- **运行环境限制**：本沙箱把 `crypto.createHash`/`randomUUID` 桩为全零（`sha256:000…`）。
  因此基于 digest 的篡改检测在本环境不可判定；C6 测试改用不依赖 hash 值的**结构门**
  （source_outcome_ids 不匹配不权威、foreign episode 不解析）证明独立性。真实环境可恢复 digest 强度。
- Compiler 达到 `active` 需要 Campaign outcome 携带 pre_state/arguments/run_id 与已提交 isolated replay
  记录；C6 已提供 run_id/when/expect/每 Episode 独立组与 resolver 索引，显式编译路径与派生重建已落地，
  但把首族的每个 proof 条件全部闭合以稳定产出 active 属 E2 实验阶段的对照工作。这是 `non_blocking`
  （默认 `promote_experience:false`，不影响产品链、安全、预算与恢复），责任阶段 E2，重新评估条件：
  运行前冻结的编译集/留出集需要 active 经验时。
- workspace 不是 OS sandbox；loopback 观察不隔离本地恶意进程。

## 8. F16 / deferred（范围冻结 §3.1）

F16 缓存优化、多 Worker、容器/远程平台、任意经验组合、权重训练、真实模型 pilot、context 校准、
经验效果对照、迁移与日常试用保持 deferred。本任务不新增第二套 Scheduler/Broker/Oracle/证据/学习框架。

## 9. 工作树与提交

分支 `feat/c6-agent-product`。提交（`git log d3dc28f..HEAD`）：

```text
4798d82 docs: freeze C6 plan, contract and test matrix (BASE)
e904e8d feat: C6-A/B automatic SDK runtime, model worker and ledger
e9da0ed feat: C6-A safe Session rotation and SDK lifecycle tests
bd2ac95 feat: C6-B structured data repair family, dynamic task admission, oracle
8fcc2b8 feat: C6-C Campaign learning bridge, explicit compile and route-before-model
1a1f469 feat: C6-D provider interface and C6-E service/measure tests
c774190 feat: C6-E runner and C6-F second code-repair task family
932372c test: C6-P2/P3/P4 refusal, ledger/input and durability suites
```

最终文档提交随后追加。未 push、未改写历史；未改内嵌 Pi 核心/用户凭据/模型设置/lockfile。

## 10. 结论

C6 实现与工程测试完成，标 **internally_verified / awaiting_external_review**，交回一次 C6 限定工程验收。
工程通过不等于学习收益成立；真实模型 pilot、经验效果对照、迁移与日常试用另立实验任务。
