# C6 模型 Agent 与经验闭环 — 实现报告

**本轮修复复验：internally_verified / awaiting_external_review**。外部复验（`C6_EXTERNAL_REVIEW.md` 第4节，
基线 `35b053a`）认定的五组遗漏已在 `23d754e` 上修复并本地提交，见第 11 节。
原14suite/21外部例通过、Campaign新增类型0条已认可；本轮外部边界套件 **22/22 pass**、
聚焦复验 **13/13 pass**、学习闭环全绿。以下为DS修复交付记录，不代表外部接受。

历史状态：**internally_verified / awaiting_external_review** → 限定工程审查 **changes_required** →
本轮修复后 **internally_verified / awaiting_external_review**（C6 限定修复）。
SHA256/UUID 控制在本次复核正常（撤回旧“全零桩”归因）。
active/replay/direct/habit 属 C6-P5 工程目标，已完成代码与离线产品证据（第 7b、11 节），未移交 E2。
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
  （如某本地 OpenAI 兼容 endpoint）未实测**。`local-openai` 的创建/参数传递已实现并用离线段验证，
  但未向该 endpoint 发过真实请求。
- 不读取真实凭据、不请求真实模型/外部目标。
- **环境更正（撤回旧归因）**：旧报告称本环境把 `crypto.createHash`/`randomUUID` 桩为全零。
  本次复核未复现该恒定性：`createHash("sha256").update("abc")` 返回标准向量
  `ba7816bf…`，`a`/`b` 摘要不同，`randomUUID()` 每次不同。旧“全零桩”判断无稳定证据，
  已**撤回**；digest/body-tamper 完整性断言按正常环境执行（见第 7b 节）。
- workspace 不是 OS sandbox；loopback 观察不隔离本地恶意进程。

## 7b. 审查问题 X1–X12 修复对应表

背景：外部审查提交 `1512434` 新增 `tests/aegis-c6-external-boundaries.mjs` 为 21 tests / 2 pass /
19 fail（正常 red）。本轮修复后 **21/21 pass, exit 0**。red 基线在
`runtime/dev/c6-repair/red-baseline.log`，final 在 `runtime/dev/c6-repair/` 各 `req-*.out`。

| ID | 修复 |
| --- | --- |
| X1 | 预算 `admitRequest`/`admitTool` 原子预留，`remaining = limit − consumed − reserved`；同 reservation commit 幂等；wall-time 按实时钟门控 |
| X2 | 模型 Worker 按 `message_end` 计每次 provider 请求；task 额度按 `task_budget` 建**每任务账本**；决策工具在额度不足时 `terminate` 阻止自动续请求；每 Broker action 经 `admitTool` 受限 |
| X3 | `context.max_total_input_chars` 作为**每请求窗口**（含 ROM/tool schema/RAM/history/输出预留），不再乘请求预算；累计 input 另计 |
| X4 | 每次 commit 经 Host writer 持久 `runtime.note kind=c6.request`；`measure`/restart 从 committed 源重建累计账本；`buildMeasurement` 收集 attempt/request 记录 |
| X5 | 入口在创建 SDK 前把 Observer 的 log/RAM/handoff/Task/ROM 环境**取自可信 config**（覆盖继承 decoy）；`setTaskBinding` 每任务绑定；RAM/episode 按当前 Task；退出恢复 env |
| X6 | runner 为每 attempt 物化独立 config（`work_dir`/seed），真实在其中运行；拒绝重复 id/path |
| X7 | `local-openai` 标为 implemented；入口经 SDK 注册 loopback baseUrl 模型与隔离凭据；未实测 endpoint 列明 |
| X8 | outcome 记录真实 `pre_state`/`arguments`；结构化 `when(path/op/verified_by)`/`expect`/`run_id`；新增可信隔离 Replay adapter；每次 replay 后**刷新 bridge**；active 编译经同一 writer 写 `experience.compiled`；新增相容独立 manifest 使 Compiler 达 active；route-before-model 用已验证 currentState ref → 第三 Task direct 零规划请求 |
| X9 | `observe` CLI 常驻到 SIGTERM/SIGINT，signal drain await durable 后关闭；bind 失败不阻断 run |
| X10 | 注册测试经 Host harness 运行：校验 test digest、按**调用帧归因** process.exit、要求**完整**结果；提前退出/缺结果/timeout=unknown；未注册 criterion=unknown |
| X11 | 新增授权只读 `aegis_read` 工具；prompt 含真实 target、criterion 与 action 参数 schema |
| X12 | assembly 失败路径对 `sdkRuntime` 做 null-safe dispose，坏源保留结构化拒绝，`status` 不报 completed |

### 测试修正（依据契约，不降低门）

- `aegis-c6-ledger-input.mjs`：输入超过窗口现返回专用 `context_window_exceeded`（窗口门与累计预算分离）；
  原断言 `budget_exhausted` 与契约不符，修正标签并保留“不 prompt”核心断言。
- `aegis-c6-sdk-lifecycle.mjs`：原“整个 Campaign 仅 1 个 Episode”断言与 X5 修正后的**每 Task 一个 Episode**
  契约冲突（原断言因无关标签才成立）；改为断言每真实 Task 一个 Episode 且轮换不新增。
- `tests/helpers/c6-audit-child.mjs`：原从 `context.tools` 读工具，但真实 Pi SDK 把工具放在**前导 system
  消息 `toolsAdded`**，契约上不存在 `context.tools`；改为读取正确位置，保留 X11 全部实质断言。

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

## 11. 复验剩余五组的修复轮（本次，交回前一轮）

外部复验（`C6_EXTERNAL_REVIEW.md` §4）在 `35b053a` 认定五组遗漏。本轮在 `23d754e` 上修复并提交：
`a02e93f`（registered-test 可信完成协议）、`c31bed0`（runner 实际初态）、
`d1e0efa`（学习真复用/真实前态）、`2d8532e`（provider 调用前门 + 当前 Task grant）、
`dacb511`（聚焦测试与 runner）。

| 组 | 修复要点 | 证据 |
| --- | --- | --- |
| 1 provider 通用请求门 | 在 `agent.streamFunction`（真实 provider 边界，首请求/tool loop/续请求均经过）统一准入；每次请求检查窗口、wall-time、Task+Campaign 请求额度，**预留先 durable 后调用 provider**；预留失败不调用 provider；commit 失败停止后续 dispatch 并保留 reconciliation；从 committed 源重建 consumed+pending | 额度 1 时实际 provider 请求 **1** 次（原来 4 次）；R4/R5/R6 |
| 2 registered-test | 最小可信 Host 完成协议：import 解析/抛错才写完成记录；提前 exit 无记录=unknown；记录带随机 nonce；不改 assert、不读 stack、不特判 process.exit | 合法 `node:assert/strict` 通过、正常错误 failure、伪造帧/提前退出 unknown；R1/R8/R9、C6-X10 |
| 3 aegis_read | 用 `resolveInside`（realpath）校验真实目标位置，拒绝 symlink 越界；读取 grant 为**当前 Task** 目标而非整个 Manifest 并集 | R2（symlink 拒绝、不返回外部内容）、R7（当前 Task 隔离）、控制普通文件可读 |
| 4 runner 真实初态 | `initial_state` 不再只是 metadata：有声明必须有可信 `applyInitialState`，否则拒绝该 attempt；记录**实际应用的初态**；初始化异常只影响该 attempt | R3（无 initializer 拒绝）、R10（真实初态记录 + 失败隔离）、C6-X6（独立 work_dir） |
| 5 学习复用 | 训练为两个独立 campaign、各自真实 reset；复用是编译前真正未执行的 `task-003`；前态取自 broker 记录的**真实 pre_state**（非声明），`verified_by` 指向实际证据；编译参数模板仅取支持 episode 一致的实参；router 用含刚提交 currentState 的最新 resolver | closure 全绿：NEW Broker intent、NEW effect、NEW Oracle success、零规划请求；mutation 捕获声明前态/跳过 replay/不派模板 |

### 11.1 本轮 exact argv / exit / private logs

日志目录 `Pi_Agent_base/runtime/dev/c6-recheck-2/`（ignored）。

```bash
node --test Pi_Agent_base/tests/aegis-c6-external-boundaries.mjs        # 22 tests / 22 pass / 0 fail, exit 0
node --test Pi_Agent_base/tests/aegis-c6-recheck-boundaries.mjs        # 13 tests / 13 pass / 0 fail, exit 0
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-c6-learning-closure.mjs                    # all checks passed, exit 0
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs <out> <14 C6 scripts + recheck>   # 15 scripts, 0 failed
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs <out> <26 affected regressions>    # 26 scripts, 0 failed
```

- `final/results.json`：15 个 C6 脚本 argv/exit/log（含 `aegis-c6-recheck-boundaries`）。
- `final-regress/results.json`：26 个受影响回归 argv/exit/log。
- `tsc3.log`：`tsc -p tsconfig.aegis-campaign.json` exit 1，**196 条既有诊断、修改文件 0 条**。
- `biome.log`/`biome2.log`：修改范围 `biome check` exit 0。
- mutation 记录见 `docs/C6_AGENT_PRODUCT_TEST_MATRIX.md` §修复轮 mutation。

### 11.2 未实测限制（本轮）

gate 的 durable 预留/commit 用 faux + 注入的持久回调与失败回调验证，未对接真实 provider 计费；
registered-test 的完成协议不是 OS sandbox，不声称抵抗任意敌对进程直接改写结果文件；
runner 的可信 initializer 由调用方（Host/fixture）提供，本任务不建设通用 benchmark 平台。

## 12. 本轮 commits 与工作树

工作树干净。相对 `23d754e`：

```text
a02e93f fix: C6 registered-test minimal trusted Host completion protocol
c31bed0 fix: C6 runner refuses unapplicable initial_state, records actual reset
d1e0efa fix: C6 learning reuse proves a real third task with real pre-state
2d8532e fix: C6 provider-bound pre-call budget gate and current-task read grant
dacb511 test: C6 recheck boundaries for gate, test trust, grant and reset
```

未 push、未改写历史；未改内嵌 Pi 核心/用户凭据/模型设置/lockfile；未调用真实 provider/目标。


## 13. Provider Gate 重规划修复轮（本轮，基线 89cb4aa）

外部复验 §5–6 认定请求门三处遗漏（R12/R13/R14），并明确这是架构收敛而非三个孤立断言。
本轮按 `docs/C6_PROVIDER_GATE_PLAN.md`（状态机/联合 reservation/identity/持久顺序/reconciliation/
transcript 覆盖表/测试矩阵）实现并自审。

| 组 | 实现 | 证据 |
| --- | --- | --- |
| R12 末次 durable commit | `run()` 尾部 await `gate.pendingCommit`；失败→`ok:false`/`accounting_failure`/reconciliation，且不返回决策 | R12/R12b；Broker effect 0 |
| R13 Campaign+Task 联合准入 | gate 同 `request_id` 先 campaign 后 task `admitRequest`，task 拒绝补偿 campaign；两层成功后一条 durable reservation 记录两个 id；message_end 各 commit 各 reservation | R13/R13b/R13c；campaign=0→provider 0 |
| R14 实际 transcript | `measureProviderInput` 按 `llmContext.messages`(system/user/assistant/toolResult)+`messages[*].toolsAdded`/顶层 tools + output reserve 计窗；首请求与续请求同一门 | R14/R14b/R14c/R15 |
| 持久/重建 | `persistRequest` 写 request_id + task/campaign reservation id + coverage/source；`summarizeRequestLedger` 从 committed 源重建 consumed/pending，null-id 不合法 | R16；restart 不重复计费 |

数字：正常两任务 campaign consumed=4、任务各 2、pending 0；restart 第二次仍 4；rebuild 与运行一致。
聚焦套件 **23/23**、external **22/22**、15 C6 脚本 exit 0、26 回归 exit 0；tsc 196 旧/0 新；Biome exit 0。
mutation 9 项全部行为 FAIL。exact argv/exit/log 见 `docs/C6_PROVIDER_GATE_PLAN.md` 与
`runtime/dev/c6-gate/`。未运行真实 provider pilot；真实环境参数由用户单独确定。

### commits（本轮）

```text
637aeaa fix: C6 ledger joint reservations with stable request ids
c9959ec fix: C6 provider gate joint admission, actual transcript window, final flush
294ebc5 test: extend C6 provider gate recheck boundaries
```

状态：**internally_verified / awaiting_external_review**。
