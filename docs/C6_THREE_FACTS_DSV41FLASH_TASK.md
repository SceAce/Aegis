# 给 dsv4.1flash：C6 请求生命周期的三个事实与有限修复

本文是可直接交给新 dsv4.1flash 会话的实施任务书。需要实际代码、验证和本地提交；本文本身不是产品已修复或已经通过的报告。

## 1. 目标与授权

你负责在 `/Users/scemac/My_github/Aegis` 完成一次有限工程修复，让 Aegis 的运行、权威事件和恢复一致表达三个事实：

1. Task/Campaign 每侧的预算责任：已消费、仍预留或已确定未调用而释放。
2. 请求的联合结清：是否有合法、关联完整的 durable settlement。
3. 当前模型规划的结束结果：正常结束、错误、中止或未知。

本轮目标是修复这三个事实混用造成的两组已复现阻塞，完成后交回限定复验，随后进入有限真实任务 pilot。不是重新设计整个 Agent，不是继续扫描所有 warning。

用户已同意这三个事实，并授权必要实现、测试和本地 Git 提交。按已有范围自主推进，不停在计划、等待普通实现选择批准或仅返回报告。真实 provider/任务 pilot 在工程复验后另行执行，本轮不调用真实模型或目标。

## 2. 基线与阅读入口

已知分支 `feat/c6-agent-product`；产品基线 `93d4617`；独立补测提交 `290313f`。本任务书之后可能有文档提交，开始记录实际 HEAD、分支和工作树，保留已有改动。内嵌 Pi 已知 HEAD 为 `42a3497d03ad17e308a2299fa824727894f2c0ec`，核对实际值及 dirty 状态。

遵守 `Pi_Agent_base/AGENTS.md` 的适用要求。重点阅读：

- `docs/AGENT_DEVELOPMENT_STANDARD.md` §3.1、`AGENT_TESTING_STANDARD.md`、`GIT_STANDARD.md`。
- `docs/C6_AGENT_PRODUCT_TASK.md`：整体冻结范围和可信验收主链。
- `docs/C6_EXTERNAL_REVIEW.md` §7：当前两组反例、已有12例与有限退出门槛。
- `docs/C6_AGENT_LIFECYCLE_OPEN_SOURCE_RESEARCH.md`：Pi/Codex/DeepSeek Harness 的源码证据及适用边界。
- 旧任务书 `docs/C6_REQUEST_LIFECYCLE_CONVERGENCE_DS_PROMPT.md` §4、§7：原契约及显式回归清单。历史基线/缺陷状态以当前审查和本文为准，不重新执行旧修复轮。
- 当前 C6 test matrix、implementation report、runbook；保留历史证据，追加本轮段落。

完整阅读直接修改文件及必要调用点，至少包括 `c6-request-lifecycle.mjs`、`c6-model-worker.mjs`、`c6-entry.mjs`、`c6-tool-ledger.mjs`、真实 SDK 的结束路径、Composite→Broker 放行路径、`aegis-c6-architecture-review.mjs` 和恢复 helper。路径主要位于 `Pi_Agent_base/memory/campaign/` 和 `Pi_Agent_base/tests/`，用实际搜索确认文件名。

只读核对内嵌 Pi 的 `packages/agent/src/agent-loop.ts`、`agent.ts` 和 `packages/ai/src/types.ts`。本轮不需要升级 Pi；内嵌 agent-loop 与本次调研版本相同。不能依靠替身推断真实 SDK 语义。

## 3. 三个事实的精确契约

### 3.1 每侧预算责任

对每个 request，分别推导 Task 与 Campaign 的记账事实；请求身份与两侧 reservation 身份始终关联。

- 一侧被合法 durable reconciliation 确认 committed：恢复该侧 consumed 和已记账 reservation 身份，不能只从 pending 中删除。
- 一侧失败或未知且请求可能发生：保留该侧 hold；没有证据不能释放。
- 完整合法 committed：将还未确认的侧收敛为 consumed；已经确认的侧不再增加一遍。
- 无结束/结算事件而只有 reserved：保持保守 hold，不能解释为未 dispatch，也不能换 request id 自动重试。
- 仅调用前确定未 dispatch 的合法 release 才能释放责任。取消不能撤销已经发生的模型请求。

在本轮直接涉及的 request 数量和输入占用维度，恢复前后的 `consumed + pending` 责任不得无证据减少。输入占用使用既有权威估算字段；token/currency 缺失仍为 unknown，不把这些数量变成“精确费用”。工具额度继续来自现有可信准入记录，不通过 usage 或结束状态臆造。

按 request/side 身份保证幂等，Task 只恢复自身责任，Campaign 聚合；同一 ledger object 模式继续只提交一次。不得通过多保留一份 hold 和一份 consumed 来掩盖错误。

### 3.2 请求联合结清

联合结清是独立事实，不能从 pending 数量推导。

- 两侧内存已经 consumed，但 durable committed 失败、只有 reconciliation：仍为未决。
- 无 pending 但未联合结清：`unresolved=1`，恢复 guard 实际阻断后续 provider/Broker。
- 后续合法完整 committed 才能结束这一未决请求，预算不重复累计。
- committed 必须通过既有 request/Task/Campaign/reservation 关联验证；reconciliation 确认某侧 consumed 也必须属于该 request/side。
- 不能把 phase 名称、`usage` 字段存在、某 reservation 出现在全局 Set 或某次 append Promise 创建当作联合成功。

账务结清允许记录 provider error/aborted 的已发生请求；结清的失败请求不产生规划执行许可。不要为了拒绝动作而把所有已知错误重新改成无限 pending。

### 3.3 规划结束结果与执行许可

Pi 的 error 和 aborted 都是硬退出，`message_end`、`agent_end` 或 `prompt()` 返回都不单独证明正常完成。Aegis 必须保留终止类别，禁止将“不是 error”映射为正常。

区分单次 provider 响应与整个规划：`toolUse` 可继续下一请求；不能因某次响应成功就宣布整个规划完成。根据实际 SDK 的 stopReason、现有工具终止机制和最终循环结果定义正常结束。核对 length/deferred/pending 等既有状态的实际可达语义；未知或缺失终止证据不自动成为正常成功。不要为未来未接入能力新增阻塞项，也不能把已有合法正常控制全部拒绝。

Worker 允许返回可执行 decision 的必要条件是：规划按已定义语义正常结束、当前规划的已准入请求都联合结清、没有 outstanding/恢复阻断、在执行边界没有有效取消，且 decision 通过现有结构/授权门。Task 完成仍由独立 Oracle 决定。

error/aborted 后不返回可执行 decision，即使 buffer 中已有前一个请求提交的合法动作；已发生请求仍计费。未知/记账失败按现有规则停止后续 dispatch；已结清的中止结果与既有 Task/Campaign 取消策略接线，不另造永久封禁平台。

异步结算/检查点等待结束后，动作 dispatch 前仍检查已有取消状态。已启动的副作用不能被取消操作自动回滚，恢复也不能盲重试。

### 3.4 必须成立的数值例子

每侧原 request 额度5，发生一个输入占用100的请求，以下均按同一 request 身份恢复：

| durable 事实 | Task consumed/pending | Campaign consumed/pending | unresolved | 后续 dispatch |
| --- | --- | --- | --- | --- |
| 只有 reserved，结果未知 | 0/1 | 0/1 | 1 | 阻断 |
| reconciliation：Task committed，Campaign failed/unknown | 1/0 | 0/1 | 1 | 阻断 |
| reconciliation：Task failed/unknown，Campaign committed | 0/1 | 1/0 | 1 | 阻断 |
| reconciliation：两侧 committed，但缺联合 durable commit | 1/0 | 1/0 | 1 | 阻断 |
| 前一行后再有合法完整 committed，含重复事件 | 1/0 | 1/0 | 0 | 再依据规划结果判断 |
| 正常完整 committed | 1/0 | 1/0 | 0 | 正常规划可放行 |
| 完整记账，但 SDK aborted/error | 1/0 | 1/0 | 0 | 该规划的 decision 不放行 |

以上 request 责任均为每侧1，remaining 均为4。已消费侧恢复 input consumed=100，未知侧保持 input hold=100，不重复占用；若权威记录使用现有保守估算则按实际契约恢复。最后一行的 unresolved=0 指请求账务结清，不代表错误任务可自动重试或完成。

## 4. DSH 中采用的原则与改动边界

采用三个已有工程原则：

1. 执行前等待持久化检查点，持久化结果决定是否允许下游调用。
2. 调用/工具可能已发生但结果缺失时，保存 unknown；恢复补齐中断事实，不补造成功。
3. durable event 保存事实；用量投影和运行结果分别推导，统一异常收尾。

复用 Aegis 现有 EventLog、provider gate、reconciliation 和 Broker。核对 EventLog 实际 append/fsync 保证；不要因为 DSH 使用 flush，就机械新增一个名为 flush 的空接口。Aegis 已经存在的 durable-before-dispatch 和副作用恢复机制继续保留。

可在现有纯 lifecycle 模块提取小型终止分类、按侧记账/结清推导或执行许可 helper，并让实际 live/replay 调用。函数名/内部状态结构由你选择；必须给出 JSDoc、调用点和真实行为证据。导入同一个文件不是一致性的证明，不能把大段 live 规则留在 Worker 后声称已经统一。

继续兼容现有完整日志；旧记录缺字段时保持现有保守 unknown/invalid 语义。不得改写历史日志或猜测补齐身份。原则上不需要引入新的事件类型或整体 schema 迁移；若扩展少量字段，说明来源、缺失语义及入口白名单是否保留它。

主要 allowed scope：Aegis-owned lifecycle、Worker、entry、必要 ledger/直接接线及其测试、C6 文档。不要修改 Pi 核心、凭据、模型配置、lockfile，新增依赖，或启动真实 provider。

不扩展为自动退款/重试、人工结算平台、分布式事务、多 Worker、OS sandbox、F16、精确 token 计费或全仓类型清理。DSH 的工具未知恢复是依据，不要求重写已经接受的 Broker/EventLog 系统。

## 5. 两组已知 red 与必须验证的完整链

已有独立补测：`node --test Pi_Agent_base/tests/aegis-c6-architecture-review.mjs`。上一轮是12 tests、6 pass、6 fail；这是历史结果，先在当前未改产品上实际复跑，保存本轮 red 和 tsc 基线。

第一组：AR-02-task/campaign、AR-03、AR-04、AR-10。成功侧消费被重建为0；两侧均记账但 durable commit 缺失时 unresolved 变0；真实 EventLog+SIGKILL 后独立 queued Task 重新调用 provider 并产生 Broker effect。

第二组：AR-09-aborted_followup。真实 SDK 第一请求缓冲 decision，第二请求 aborted，Aegis 仍修改文件并把 Task 标 completed。error 对照及正常对照已经存在。

保留现有12例及原生命周期用例断言。补测只为本次状态分离仍有的具体盲区，优先增强已有用例：

- 单侧/双侧消费恢复的 exact consumed、pending、remaining 和 input 占用，不只测总数或返回字符串。
- 重复 reconciliation、后续完整 committed、重复恢复不双计，也不重新打开已合法结清的请求。
- 对真实 SDK aborted 的 durable provider/stop_reason 和 Worker 结果保留中止事实，Broker effect=0、真实文件不变、消费仍为已发生次数。
- 真实入口创建 Task ledger、恢复 guard、只读 measure/report 采用一致结果；不能只修 reducer helper。
- 现有真实 EventLog+SIGKILL 场景保留：恢复后独立任务 provider=0、Broker effect=0、预算责任保留、链完整。
- 正常产品控制继续有真实文件 effect、可信 Oracle completed，恢复不重复 provider/effect。防止“拒绝所有请求”满足负例。

输入来自真实 live Worker、SDK/faux 和真实事件链；失败注入 ledger/writer 可以，但它们不能直接生成预期结果。不要新建仅镜像实现的测试体系。已有 red 不需再通过 import/syntax error 造一次 red。

## 6. 实施与验证顺序

在现有 test matrix/report 追加一段，先写清三个事实的输入来源、关联身份、缺失行为和上表案例，然后自主实施：

```text
核对当前基线与 SDK 语义
 → 实际 red、改前 tsc
 → 按侧责任与独立联合结清的恢复
 → 终止分类与 decision 执行许可接线
 → 入口持久化/重建和真实 SDK/恢复组合验证
 → 针对两组规则的有限 mutation
 → 一次 required 回归、静态/类型检查
 → 自审、更新有界证据、本地提交并交回
```

可以调整局部顺序，保证最终端到端一致。不得分别加两个 if 后只跑旧绿色检查。

聚焦检查至少实际运行：

```bash
node --test Pi_Agent_base/tests/aegis-c6-architecture-review.mjs
node Pi_Agent_base/tests/aegis-c6-lifecycle-convergence.mjs
node Pi_Agent_base/tests/aegis-c6-lifecycle-restart.mjs
node --test Pi_Agent_base/tests/aegis-c6-recheck-boundaries.mjs
node --test Pi_Agent_base/tests/aegis-c6-external-boundaries.mjs
```

SDK 集成继续使用仓库实际 source resolver 和 faux。required 最终清单为旧任务书 §7 的15个 C6脚本，加 lifecycle-convergence、lifecycle-restart、architecture-review，共18个，以及原26个受影响回归。复用现有 `tests/helpers/c6-suite-runner.mjs`，显式传真实名称；architecture-review 启动子进程所需 resolver 已在 helper 中，核对实际 argv，不盲目给所有脚本挂 resolver。

Biome 针对本次修改代码/测试；Campaign tsc 使用 `Pi_Agent_base/tsconfig.aegis-campaign.json`。改前/改后诊断逐条对比，不凑196这个历史数字，不新增相关诊断，不关闭 checkJs、排除新模块或用 ts-ignore/blanket any 掩盖。

有限 mutation 只针对本轮关键规则：丢掉成功侧 consumed；以 pending=0 判无未决；把 aborted 当正常；reconciliation→committed 重复计费。数量按必要覆盖选择，不重做旧7项竞赛。每项须导致相关行为断言失败，语法/import失败不算；mutant 仍绿则补有依据的断言。使用隔离副本或在有界路径还原，不能 reset/clean 用户工作树。

私有日志放 ignored `Pi_Agent_base/runtime/dev/c6-three-facts-<run-id>/`；记录 exact argv、exit、结果和 log 引用。监听权限或环境失败保留原始证据，必要时在获许可环境重跑；不能改写总 exit、禁用断言或把未运行当通过。

相关检查通过后停止扩大测试；只有新修改、真实失败或当前核心不变量反例才追加。风格偏好、旧 warning、未来能力单独记录 non_blocking/deferred。

## 7. Git、交回内容与退出门槛

在现有任务分支按可审查单元本地提交，逐路径暂存并阅读 staged diff；提交正文注明 Agent 协助。不 push、不改写历史，不清理已有工作树，不制造伪作者/时间。开始和结束核对内嵌 Pi 状态。

交回一个简洁、可核验的结果：

1. 最终三个事实的表示、推导位置及 live/durable/replay 实际调用点。
2. 上表关键案例的具体数值，以及正常/aborted/重启的 provider、Broker、文件和 Oracle 证据。
3. 本轮 red→green、mutation、18个 C6与26个回归、Biome、tsc 的真实结果和日志引用；失败/未运行如实标记。
4. 实际修改文件、提交、分支、HEAD、工作树和未实测限制。

状态可标 `internally_verified / awaiting_external_review`，但不能自行宣布外部接受或已经授权真实 pilot。

退出门槛就是两组反例消失，恢复责任守恒、未决实际阻断、中止实际阻断、正常 effect/Oracle 控制成立，required 检查完成。满足后交回限定复验，不追加无限架构阶段。196条历史诊断、保守 pre-check、token估算精度、UI、F16和后置基础设施不阻塞这个出口。
