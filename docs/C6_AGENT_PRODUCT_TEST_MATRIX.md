# C6 模型 Agent 与经验闭环 — 测试矩阵

当前状态：**changes_required**，外部新增 `aegis-c6-external-boundaries.mjs` 为21 tests/2 pass/19 fail。
见 `C6_EXTERNAL_REVIEW.md` / `C6_REPAIR_DS_PROMPT.md`；以下DS原矩阵保留为历史声明，
不能把其pass标签代替实际P5/P6/P7等产品证据。case 编号与 `C6_AGENT_PRODUCT_TASK.md` §4 的 C6-P1–P8 对齐，
另加 SDK-L1–L8（并入 C6-A）与离线 provider case。
expected 来自契约与独立标准，不由被测聚合器生成。

验证层级标记：`real-sdk+faux`、`local-files`、`local-subprocess`、`isolated-replay`、
`loopback-http`、`offline-substitute`。

## 产品 required 门（C6-P*）

| case_id | requirement | 入口 | 预期行为 | 证据 | 脚本 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| C6-P1 | 产品链 | `c6-entry run` | clean CLI + 真实 SDK/faux 驱动首族两静态/一动态 Task；模型决策对应实际效果；合法提案 dispatch；无 caller runtime/beforeRun；Oracle/report/观察一致 | 事件链、真实文件、provider 请求计数 | `aegis-c6-product-chain.mjs` | pass exit 0 |
| C6-P2 | 安全/轮换 | `c6-entry run/rotate` | initial/rotated Session 同 gate/writer；新对象/context、同 Episode/授权/RAM；direct write/bash/edit/foreign/越权/伪造成功拒绝；创建/bind/预算拒绝无假完成 | 对象身份、context、拒绝事件、账本 | `aegis-c6-rotation-reject.mjs` | pass exit 0 |
| C6-P3 | 账本/输入 | `c6-entry run` | 自动 SDK 多请求与 tool loop 受调用前预算门；0/1/耗尽/失败/跨 Task 守恒；总输入估算超限显式处理；usage 来源与 unknown | 账本数值、provider 请求、`tool_call` 计数 | `aegis-c6-ledger-input.mjs` | pass exit 0 (6 node tests) |
| C6-P4 | 持久/恢复 | `c6-entry pause/cancel`, SIGKILL | 完整 stream verifyChain；effect 前/后故障；typed pause/cancel 不复活；IPC barrier 后 SIGKILL 恢复无重复效果；SIGTERM/订阅/registry/listener 清理可重启 | 事件链、子进程、真实产物 | `aegis-c6-durability-recovery.mjs` | pass exit 0 |
| C6-P5 | 学习/复用 | `c6-entry run`, `measure` | 真实独立 Episode，真实 reset/replay→显式 Compiler；第三 Task direct 零规划请求、habit 只补参数、异常退场；单 proof/foreign/篡改/版本变化不执行；删派生可重建 | proof、Compiler 输入、route 计数、store 重建 | `aegis-c6-learning-reuse.mjs` | pass exit 0 |
| C6-P6 | provider 接口 | `c6-entry run` + seam 替身 | 正常显式配置经 SDK create seam 传入正确 model/endpoint/隔离来源；未知/缺/非法拒绝；provider 错误/usage 缺失可诊断；无真实凭据打印 | create seam 参数记录、拒绝原因 | `aegis-c6-provider.mjs` | pass exit 0 |
| C6-P7 | 服务/测量 | `c6-entry observe`/`measure` | observe 实际 HTTP 可访问、无写路由、source bytes 不变；占端口仍完成、signal 后可重绑；runner 保留全部 attempt/失败/unknown、配置版本与实测/估算区别 | HTTP、bytes、measure 导出 | `aegis-c6-service-measure.mjs` | pass exit 0 |
| C6-P8 | 第二任务族/复现 | `c6-entry run` | 受控 patch + registered local tests，外部只读标准判定；首族 scope 不适用拒绝；runbook 可复制 | patch 产物、外部标准、CLI 复现 | `aegis-c6-code-repair.mjs` | pass exit 0 |

## SDK-L*（C6-A 生命周期，并入 required）

| case_id | requirement | 预期行为 | 脚本 | 状态 |
| --- | --- | --- | --- | --- |
| SDK-L1 | 自动启动两任务+动态 | clean temp 用实际 CLI 启动；真实 SDK/faux + 原 Broker 效果；归属匹配；无 caller runtime/beforeRun | `aegis-c6-sdk-lifecycle.mjs` | pass exit 0 |
| SDK-L2 | 自动轮换 | 小阈值触发 Host 自动轮换一次；真新 AgentSession/context；同 Episode/授权/RAM；completion/账本各一次；轮换后 direct write 无效果 | `aegis-c6-sdk-lifecycle.mjs` | pass exit 0 |
| SDK-L3 | 跨 Task/重启账本 | 旧轮换耗用保留；耗尽拒绝创建；0/1 边界合法控制；pending/未 settled 拒绝；创建/bind 失败无 completion 可重启 | `aegis-c6-sdk-lifecycle.mjs` | pass exit 0 |
| SDK-L4 | 完整链/清理 | 首启→rotation→actions→退出整链 verifyChain；registry/订阅/Session/listener 清理；重启无第二 writer | `aegis-c6-sdk-lifecycle.mjs` | pass exit 0 |
| SDK-L5 | 常驻 observe | HTTP 可访问、与导出一致、无写路由；source bytes 不变；占端口仍完成；SIGTERM 后可重绑 | `aegis-c6-service-measure.mjs` | pass exit 0 |
| SDK-L6 | 控制/恢复 | typed pause/cancel + restart 不复活；IPC barrier 后 SIGKILL 恢复核对产物无重复 | `aegis-c6-durability-recovery.mjs` | pass exit 0 |
| SDK-L7 | 拒绝路径 | 未知/缺 provider、未审查 extension、错误 grant/预算/paths 启动拒绝且无 SDK 创建/效果；临时 in-memory auth；合法配置通过 | `aegis-c6-provider.mjs` | pass exit 0 |
| SDK-L8 | 可复制命令 | documented commands 从干净目录可复制；source resolver、配置生成、目录、退出码、生命周期、控制/恢复、导出 | `aegis-c6-runbook.mjs` | pass exit 0 (SDK-L8; runner + runbook) |

## 离线 provider case（C6-D）

| case_id | 预期行为 | 脚本 | 状态 |
| --- | --- | --- | --- |
| C6-D1 | faux 默认经 create seam 传正确 provider/model/baseUrl | `aegis-c6-provider.mjs` | pass exit 0 |
| C6-D2 | 未知 provider kind 拒绝，无 create | 同上 | pass |
| C6-D3 | 缺 model / 非 loopback base_url 拒绝 | 同上 | pass |
| C6-D4 | credential_ref 只引用来源，不打印值 | 同上 | pass |
| C6-D5 | provider 错误/usage 缺失可诊断，计 unknown | 同上 | pass（usage_sources 标 unknown/estimated） |

## 回归清单（显式）

C5 四原 suite + `c5-external-boundaries`：
`aegis-c5-integration.mjs`、`aegis-c5-export-observation.mjs`、`aegis-c5-runbook.mjs`、
`aegis-c5-session-sdk.mjs`（source resolver）、`aegis-c5-external-boundaries.mjs`。

受影响回归：C2 `supervisor-boundaries`/`budget-sdk`/`session-rotation`，
C3 `host-fixture`/`gate-sdk`/`durability-recovery`/`external-boundaries`，
C4 `report-export`/`external-boundaries`，C4a `observation-http`/`external-boundaries`，
Observer `runtime-handoff`/`failclosed-pi`/`outcome-command`/`verify-first-pi`/`data-use-pi`，
learning `learning-bridge-e`/`learning-commands-pi`，fixture `fixture-pi-orchestrator`，
C1 `eventlog-durability`/`integration-recovery`。

每命令逐条捕获真实 exit、stdout/stderr、ignored log 路径（`runtime/dev/c6-<stage>/`）。
不把管道尾部成功当检查成功。

## 有限 mutation（关键门）

| mutation | case | 预期 |
| --- | --- | --- |
| 删除调用前预算门 | C6-P3 | FAIL |
| 删除 gate 的 direct 拒绝 | C6-P2 | FAIL |
| 让 candidate 当 hint | C6-P5 | FAIL |
| 让 Session 增加独立 Episode | C6-P2/P5 | FAIL |
| foreign/篡改 proof 通过 | C6-P5 | FAIL |
| 未知 provider 自动回落 faux | C6-P6 | FAIL |

失败仍绿说明测试盲区，先补测试再交付。


## C6 修复轮新增：外部边界与真实恢复

审查新增 `aegis-c6-external-boundaries.mjs`（21 node tests）为正常 red 基线
（修复前 2 pass / 19 fail，exit 1）。修复后全部通过；本表记录 X1-X12 与证据。

| case_id | requirement | 预期行为 | 脚本 | 状态 |
| --- | --- | --- | --- | --- |
| C6-X1 | 调用前预算 | pending reservation 扣 remaining；同 reservation commit 幂等；wall-time 耗尽拒绝 | `aegis-c6-external-boundaries.mjs`（C6-X1 ×3） | pass exit 0 |
| C6-X2 | 真实请求/工具账本 | 计每次 provider 请求；task request=1 拒绝自动续请求且不推进依赖；task tool=1 限制 Broker intent | 同上（C6-X2 ×3） | pass |
| C6-X3 | 每请求总输入门 | `max_total_input_chars` 为每请求窗口，不乘请求预算 | 同上（C6-X3） | pass |
| C6-X4 | 持久账本/测量 | measure 从 committed 重建；restart 保留累计 consumption | 同上（C6-X4 ×2） | pass |
| C6-X5 | writer/真实绑定 | 继承 decoy AEGIS_EVENT_LOG 不生效；RAM/episode 绑定当前 Task | 同上（C6-X5 ×2） | pass |
| C6-X6 | runner 隔离 | 各 attempt 在自己 work_dir 产生 committed 源 | 同上（C6-X6） | pass |
| C6-X7 | provider 接口 | loopback `local-openai` 被实现（非 hard-refuse） | 同上（C6-X7） | pass |
| C6-X8 | 学习证据 | outcome 带结构化 when(path/op/verified_by)/expect/run_id | 同上（C6-X8） | pass |
| C6-X9 | 常驻 observe | observe CLI listener 常驻到 SIGTERM，直接访问其 URL | 同上（C6-X9） | pass |
| C6-X10 | 代码 Oracle 假成功 | process.exit(0) 提前退出为 unknown；未注册 criterion unknown | 同上（C6-X10 ×2） | pass |
| C6-X11 | 观察路径 | provider 收到授权读取工具、target、criterion 与参数 schema | 同上（C6-X11） | pass |
| C6-X12 | 坏源/清理 | 坏源 status 结构化非成功，不被 null dispose TypeError 覆盖 | 同上（CONTROL corrupted） | pass |

补充产品证据（复用任务书 C6-P5/P4）：

| case_id | 预期行为 | 脚本 | 状态 |
| --- | --- | --- | --- |
| C6-P5 closure | 两独立相容 Episode 真实隔离 Replay → Compiler active → 第三 Task direct 零规划请求并产生真实 Oracle 判定的效果 → 删派生重建 | `aegis-c6-learning-closure.mjs` | pass exit 0 |
| C6-P4 recovery | 真实 child 经 durable intent / 真实 effect 后 SIGKILL，重启 reconcile 无重复 effect，stream verifyChain | `aegis-c6-recovery.mjs` | pass exit 0 |

### 有限 mutation（本次复跑，行为 FAIL 证明）

| mutation | 预期 | 实际 |
| --- | --- | --- |
| remaining 忽略 pending reservation | C6-X1 FAIL | FAIL ✓ |
| decision tool 不再标记 budget 终止 | C6-X2 follow-up FAIL | FAIL ✓ |
| runner 忽略 per-attempt config | C6-X6 FAIL | FAIL ✓ |
| compile 前跳过真实 replay | closure FAIL | FAIL ✓ |
| process.exit 归因设为恒真 | C6-X10 FAIL | FAIL ✓ |

## C6 复验剩余五组修复轮（基线 23d754e，本轮交付）

对应 `C6_EXTERNAL_REVIEW.md` §4 / `C6_RECHECK_REPAIR_DS_PROMPT.md` 五组。
日志 `runtime/dev/c6-recheck-2/`（ignored）。

| case_id | requirement | 入口 | 预期行为 | 脚本 | 状态 |
| --- | --- | --- | --- | --- | --- |
| C6-RB | 通用 provider 请求门 | `runC6FromConfig` | 额度 1 时连续 read 续请求只发 1 次 provider 请求；每请求调用前+durable 准入 | `aegis-c6-external-boundaries.mjs`（C6-X2 read-budget）、`aegis-c6-recheck-boundaries.mjs` R4 | pass |
| C6-RD | 持久预留/commit | `createModelWorker` | 预留不可持久化不调用 provider；commit 失败停止后续 dispatch 且保留 reconciliation | `aegis-c6-recheck-boundaries.mjs` R5/R6 | pass |
| C6-RT | registered-test 可信完成 | `runRegisteredTest` | 合法 assert/strict 通过；正常错误 failure；提前 exit/伪造帧 unknown；记录带 nonce | `aegis-c6-recheck-boundaries.mjs` R1/R8/R9、`aegis-c6-external-boundaries.mjs` C6-X10 | pass |
| C6-RG | 当前 Task 读取 grant | `createObservationTool` | symlink 越界拒绝且不返回外部内容；当前 Task 外的 workspace 文件拒绝；普通授权文件可读 | `aegis-c6-recheck-boundaries.mjs` R2/R7（控制例） | pass |
| C6-RI | runner 实际初态 | `runBoundedAttempts` | 无 initializer 拒绝；记录实际应用初态；初始化异常隔离 | `aegis-c6-recheck-boundaries.mjs` R3/R10、`aegis-c6-runner.mjs`、`aegis-c6-external-boundaries.mjs` C6-X6 | pass |
| C6-RL | 学习真复用/真实前态 | `c6-entry` learning | 编译前 task-003 未执行；新 intent/effect/Oracle success；零规划请求；前态取真实观测非声明 | `aegis-c6-learning-closure.mjs` | pass |
| C6-RH | habit/退场 | `createModelWorker` router | habit 固定方法、仅请求缺参数；paused/refuse 带原因不静默转规划 | `aegis-c6-recheck-boundaries.mjs` R11、router 既有测试 | pass |

### 本轮有限 mutation（关键 guard，行为 FAIL 证明）

| mutation | 预期 FAIL case | 实际 |
| --- | --- | --- |
| provider gate 不再拒绝超额度请求 | R4 | FAIL ✓ |
| registered-test 缺记录仍视为完成 | R1/R9 | FAIL ✓ |
| aegis_read 退回 lexical 路径检查 | R2/R7 | FAIL ✓ |
| runner 忽略缺 initializer | R3/R10 | FAIL ✓ |
| proof `when` 改用声明 initial_state | closure 前态/direct | FAIL ✓（2 失败） |
| compile 前跳过真实 replay | closure replay/reset | FAIL ✓（2 失败） |
| 不派生 arguments template | closure direct 零规划 | FAIL ✓ |

## C6 Provider Gate 重规划修复轮（基线 89cb4aa，本轮交付）

对应 `C6_PROVIDER_GATE_REDESIGN_DS_PROMPT.md` 的 R12/R13/R14；规划与契约见
`docs/C6_PROVIDER_GATE_PLAN.md`。日志 `Pi_Agent_base/runtime/dev/c6-gate/`（ignored）。

| case_id | requirement | 入口 | 预期行为 | 脚本 | 状态 |
| --- | --- | --- | --- | --- | --- |
| C6-R12 | 末次 durable commit | `createModelWorker.run` | 末次 commit ok:false → 不返回决策，accounting_failure + reconciliation | `aegis-c6-recheck-boundaries.mjs` R12 | pass |
| C6-R12b | 不进入 Broker | `createCompositeWorker` | accounting failure → brokerWorker.run 0 次 | 同上 R12b | pass |
| C6-R13 | Campaign+Task 联合准入 | `installProviderGate` | campaign=0/task>0 或反之 → provider 0 次 | 同上 R13 | pass |
| C6-R13b | 拒绝前不写 null-id reserved | 同上 | campaign 拒绝 → `persistRequest` 0 次 | 同上 R13b | pass |
| C6-R13c | 各一 reservation/commit | 同上 | provider 1；两层 provider 前 pending 1，后 consumed 1 | 同上 R13c | pass |
| C6-R14 | 实际 transcript 窗口 | `measureProviderInput` | 大 messages 超窗 → provider 0 次 | 同上 R14 | pass |
| C6-R14b | tool schema+result 计窗 | 同上 | 超窗 → provider 0 次 | 同上 R14b | pass |
| C6-R14c | tool schema 单独计窗 | 同上 | 小 message + 大 schema → provider 0 次 | 同上 R14c（新增） | pass |
| C6-R15 | continuation 窗口 | 同上 | 首请求合法、续请求超窗 → provider 1 次 | 同上 R15（新增） | pass |
| C6-R16 | durable payload 重建 | `summarizeRequestLedger` | 重建 consumed/byTask/pending；null-id committed 不合法 | 同上 R16（新增） | pass |

### 本轮 mutation（关键 guard，行为 FAIL）

| mutation | 目标 case | 实际 |
| --- | --- | --- |
| 删除 final pendingCommit flush | R12/R12b | FAIL ✓ |
| accounting failure 改 ok:true | R12/R12b | FAIL ✓ |
| 仅 Task admission | R13/R13b/R13c | FAIL ✓ |
| null-id mirror commit | R13c | FAIL ✓ |
| 缓存 prompt estimate | R14/R14b | FAIL ✓ |
| 不读 llmContext.tools | R14c | FAIL ✓ |
| 仅首请求窗口 | R15 | FAIL ✓ |
| pending 不计入 remaining | C6-X1 | FAIL ✓ |
| 重复 commit 非幂等 | C6-X1 duplicate | FAIL ✓ |

## C6 请求生命周期收敛轮（本轮，基线 `17e1728`）

新增脚本：`aegis-c6-lifecycle-convergence.mjs`（18 例，`node --test`）、
`aegis-c6-lifecycle-restart.mjs`（真实子进程 SIGKILL + 重启，非 node:test）。
expected 来自冻结契约（联合成功定义、单侧 reservation 不合法、reconciliation 未决），
不由实现返回值倒推。red 基线在 `runtime/dev/c6-lifecycle-run1/red-baseline.log` 与
`restart-red-baseline.log`。

| case_id | requirement | 入口 | 预期行为 | 脚本 | 状态 |
| --- | --- | --- | --- | --- | --- |
| LC-A1 | Task 内存 commit 失败 | `createModelWorker` | `ok:false`/accounting_failure；durable 无 committed；Task pending 保留；Campaign 已提交侧只计一次 | convergence | pass |
| LC-A2 | Campaign 内存 commit 失败 | 同上 | 同上（Campaign pending 保留、Task 已提交侧计一次） | convergence | pass |
| LC-A3 | commit 抛异常 | 同上 | 同上（异常归为失败，不归为成功） | convergence | pass |
| LC-B1 | provider 抛错、无 completion | 同上 | provider 真实 1 次；两层 pending 保留；durable reconciliation_required；无 committed；gate 还原 | convergence | pass |
| LC-B2 | SDK 合成 error message | 同上 | 分类 provider_error；committed 标 `provider_status=error`；各计一次；不返回决策 | convergence | pass |
| LC-B3 | 拒绝前合成错误 | 同上 | provider 0 次；不写任何 reserved/committed；不计费 | convergence | pass |
| LC-B4 | 未决 provider 错误 + Composite | `createCompositeWorker` | Broker effect 0 次 | convergence | pass |
| LC-B5 | reserved + reconciliation 重启 | summarize + seed + `createModelWorker` | 未决保持；provider 0 次；guard 拒绝 dispatch | convergence | pass |
| LC-B6 | reconciliation append 再失败 | `createModelWorker` | 返回持久化失败事实；reserved 源仍保留两层 pending；不释放预算 | convergence | pass |
| LC-C1 | 每 Task 只注入自身 pending/committed | `summarizeRequestLedger` + `reservedSeedForTask` | A/B 各自 pending；C committed 不泄漏；Campaign 聚合 A+B | convergence | pass |
| LC-C2 | 重建后每 Task 只计自身 hold | `createToolLedger` | remaining 各减 1；pending 只有自身 | convergence | pass |
| LC-D1 | 仅 Task 侧 committed | `summarizeRequestLedger` | 不结算；两侧 pending 保留；invalid_committed 诊断 | convergence | pass |
| LC-D2 | 仅 Campaign 侧 committed | 同上 | 同上 | convergence | pass |
| LC-D3 | reservation 错配 | 同上 | 不结算；pending 保留；task_reservation_mismatch 诊断 | convergence | pass |
| LC-D4 | 重复合法 committed | 同上 | 只计一次（model_requests/tool_calls/input_chars） | convergence | pass |
| LC-D5 | reconciliation_required | 同上 | 保持 pending/unresolved，不释放 | convergence | pass |
| LC-D6 | committed 后 released | 同上 | 已发生计费不被抹除；release_after_settlement 诊断 | convergence | pass |
| LC-D7 | 调用前合法 release | 同上 | 取消 hold、不计费 | convergence | pass |
| LC-R1 | SIGKILL 后保留 durable reserved | 真实子进程 + 产品入口 | reserved 含 request/两侧 reservation；无 committed | restart | pass |
| LC-R2 | reserved-only 重启 | 产品入口 | provider 0 次；预算 hold 保留；reconciliation/unresolved 可见；Broker effect 0；stream verify | restart | pass |
| LC-R3 | provider 错误结算一次 | 产品入口 | committed(provider_status=error)；consumed=1；task unknown；Broker 0 | restart | pass |
| LC-R4 | unknown task 重启不自动重试 | 产品入口 | provider 0 次；Broker effect 0 | restart | pass |

### 本轮 red → green

| 阶段 | 命令 | 结果 |
| --- | --- | --- |
| red（HEAD `17e1728`） | `node --test …/aegis-c6-lifecycle-convergence.mjs` | 18 tests / **1 pass / 17 fail**, exit 1 |
| green（本轮） | 同上 | **18 pass / 0 fail**, exit 0 |
| red（重启） | `node --import <resolver> …/aegis-c6-lifecycle-restart.mjs` | **2 fail**（guard 缺失、provider_status 未标） |
| green（重启） | 同上 | **all checks passed** |

### 本轮有限 mutation（行为 FAIL 证明）

| mutation | 目标 case | 实际 |
| --- | --- | --- |
| 忽略 Campaign 侧内存 commit 失败 | LC-A2 | FAIL ✓ |
| 无 completion 仍放行（outstanding 当成功） | LC-B4 | FAIL ✓ |
| provider error 不保留未决（release） | LC-B1 | FAIL ✓ |
| reconciliation_required 当 release | LC-D5 | FAIL ✓ |
| `reservedSeedForTask` 退回全局 pending | LC-C1 | FAIL ✓ |
| 部分 reservation id 被当完整 commit | LC-D1 | FAIL ✓ |
| 去除重复 committed 幂等 | LC-D4 | FAIL ✓ |

日志：`Pi_Agent_base/runtime/dev/c6-lifecycle-run1/mutations.log`（7/7 killed），
`final2/results.json`（17 C6 脚本 0 failed），`final-regress2/results.json`（26 回归 0 failed），
`tsc-before.log`/`tsc-final.log`（196 → 196，modified files 0），`biome-final.log`（exit 0）。
