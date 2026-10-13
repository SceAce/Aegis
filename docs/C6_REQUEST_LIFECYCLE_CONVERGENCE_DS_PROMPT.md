# 给主 DS：C6 核心请求生命周期收敛

本文是可直接用于新 DS 会话的完整任务提示词，是任务要求，不是已完成的验证报告。

## 1. 你的任务与最终目标

你是 Aegis 项目的主 DS。本轮需要实际修改代码、补测试、完成集成检查、自审和本地 Git 提交，不能只返回分析、计划或审计报告。

工作目录：`/Users/scemac/My_github/Aegis`。
已知产品代码 HEAD：`17e1728`；已知分支：`feat/c6-agent-product`。开始时核对实际 HEAD、分支、工作树和内嵌 Pi 状态；提示词可能已有后续文档提交，以实际状态为准。保留用户和其他任务已有改动。

本轮交付单位是**一次 provider 请求从准入、调用、结算、异常收尾到重启恢复的完整生命周期**。四项审查缺陷是切入点，不能将任务理解成分别给四个断言打补丁。

最终工程目标只有三个：

1. **成功可信**：只有满足完整结算条件的请求，才允许其模型决策进入现有 Broker 执行链。
2. **失败可恢复**：请求已可能发生但结果或记账不确定时，停止后续 dispatch，保留预算责任、请求关联和恢复所需信息。
3. **重启语义一致**：从权威事件重建后，请求归属、预算责任、未决状态和允许继续执行的条件不发生变化。

这是进入有限真实任务试运行前的一次工程收敛。完成本轮工程复验后，下一阶段是用户另行授权的真实任务 pilot。不要自行调用真实 provider，也不要为了追求系统完美追加基础设施阶段。

## 2. 先理解 Aegis，再开始实现

Aegis 的目标是：给定目标、目录、授权、验收条件和预算，模型观察并提交结构化决策，Host 准入，Broker 执行，Oracle 独立验证；可信独立经历经 Replay/Compiler 形成 `when/do/expect/scope` 经验，在新任务中受条件约束地复用。

继续保留这些原则：

- `Event → Episode → Outcome → Experience`；事件记录是权威源，Board、checkpoint、measurement、report、经验 store 是相应派生物。
- Observation、Claim、Action、Outcome 分开；模型文本、工具退出码、decision buffer 和 `prompt()` 返回不能证明任务成功或请求结算成功。
- 模型提交数据形式的决策，不获得 Runtime、Broker 或 Oracle 的权限。
- 短 Session 轮换不增加独立 Episode，不重置授权、预算或未决效果。
- 运行期仍为单活动 Task/Episode；workspace 不等于 OS sandbox。
- 工程正确性与真实模型任务能力、经验收益分别验收。

完整阅读适用的 `AGENTS.md` 和它要求的规范。重点核对：

- `Pi_Agent_base/AGENTS.md`
- `docs/AGENT_DEVELOPMENT_STANDARD.md`，尤其 §3.1
- `docs/AGENT_TESTING_STANDARD.md`
- `docs/GIT_STANDARD.md`
- `docs/DS_ORCHESTRATION_WORKFLOW.md`
- `THINK.md`、`docs/ARCHITECTURE_DECISIONS.md`
- `docs/MEMORY_SCHEMA.md`、`docs/MEMORY_SCHEMA_NOTES.md`
- `docs/CAMPAIGN_ARCHITECTURE.md`、`docs/CAMPAIGN_CONTRACT_BASELINE.md`
- `docs/C6_AGENT_PRODUCT_TASK.md`、`docs/AEGIS_PRODUCT_ROADMAP.md`
- 当前 C6 plan、test matrix、implementation report、runbook、external review
- `docs/C6_PROVIDER_GATE_PLAN.md`、`docs/C6_PROVIDER_GATE_REDESIGN_DS_PROMPT.md`

旧提示词用于了解背景，当前用户任务及本文的明确要求优先。历史 `internally_verified` 声明不代表本轮已经通过；当前起始判定是 `changes_required`。

阅读实际产品实现及直接调用点，至少包括：

- `Pi_Agent_base/memory/campaign/c6-model-worker.mjs`
- `Pi_Agent_base/memory/campaign/c6-tool-ledger.mjs`
- `Pi_Agent_base/memory/campaign/c6-entry.mjs`
- `c6-sdk-runtime.mjs`、Composite Worker、Broker Worker、Host 的相关接线
- 现有请求账本、恢复、产品链和边界测试

核对内嵌 Pi 的真实 SDK 类型和事件路径：`streamFunction`、`llmContext`、`message_end`、合成错误消息、`prompt()` 的返回/异常、自动 continuation、订阅和清理。可以只读上游源码，不能修改 Pi 核心。不能凭记忆编造 API，不能仅凭替身行为推断 SDK 行为。

在代码改动前，用简短说明回答：当前哪些位置决定“请求成功”？这些位置如何发生分歧？你的修改怎样让运行时、持久化和重建遵守同一套规则？随后继续实施，不停在说明阶段等待批准。

## 3. 已知证据与必须解决的问题

上一轮独立复验记录：focused `23/23`，external boundaries `22/22`，原 15 个 C6 suite 与 26 个回归均无失败，Biome 修改范围通过。Campaign tsc 为 exit 1，196 条历史诊断，修改文件没有新增诊断。

这些结果保留为历史证据；它们没有覆盖下面的组合失败。不要冒充本轮运行结果，也不要重开已经接受的 C1–C5 或已认可的五组修复。

### A. 内存 commit 失败被 durable success 掩盖

`c6-model-worker.mjs` 已计算 `commitFailed`，但存在 `persistRequest` 时，后续主要依据 durable 回调成功决定放行。

已复现：`commitRequest() → {ok:false}`、`persistRequest() → {ok:true}`，Worker 仍返回 `ok:true` 和可执行 decision。

需要覆盖 Task 失败、Campaign 失败以及提交抛异常。任一需要的内存提交失败都不是完整 committed；不得写出表示联合结算成功的记录，不得让 durable append 成功覆盖失败。

### B. provider error 未进入可恢复的 reconciliation

已复现：真实 provider 边界被调用后抛错，返回 `transport_failure`，durable 仅有 `reserved`，内存仍有 pending；提前 return 绕过后续统一 flush 和 wrapper 恢复。

要根据真实请求阶段处理异常，保留 transport 根因及 accounting/reconciliation 状态。不能只改 failure_mode 字符串，也不能取消已经可能发生的请求占用。

### C. Task pending 恢复没有按 Task 隔离

`c6-entry.mjs` 生成一个全局 `taskBaseReserved`，各 Task ledger 重用同一 pending 集合。Task A 的 pending 因而进入 Task B 的账本。

Task 的 consumed、pending、用于幂等恢复的 request/reservation 身份必须保持 Task 归属；Campaign 聚合当前 Campaign 的合法请求。不能只在显示 remaining 时过滤，内部 pending 和后续提交也必须正确。

### D. 部分 committed event 被当成联合提交

重建目前接受只有一个 reservation id 的 committed record，并可能删除整个 request pending。

双层请求完整提交必须含非空 `request_id`、`task_reservation_id`、`campaign_reservation_id`，且它们与原请求的 Campaign/Task/两侧 reservation 关联一致。单 ledger 模式两侧 id 可以相同，但语义必须明确。

部分、错配或冲突记录不能结算整个请求，也不能释放另一侧占用；应保留 invalid/reconciliation 诊断及已经知道的预算责任。重复合法事件不得重复计费。

### 与上述问题直接关联的语义冲突

`summarizeRequestLedger()` 目前将 `reconciliation_required` 与 `released/rejected` 一样处理，删除 pending。**reconciliation 表示未决，不表示取消。** 必须一起纠正，否则给 provider error 补事件会在重启后错误释放预算。

入口的持久化白名单还必须实际保存恢复所需字段；不能 Worker 返回了完整 reconciliation，入口却只写下几个 id。以上属于同一个生命周期问题，不是另开全仓审计。

## 4. 实现必须统一的契约

### 4.1 一个请求身份与一套状态规则

每个请求由受信任 Host/gate 生成稳定身份，绑定当前 Campaign/Task，以及已有 Episode/Session 上下文和两侧 reservation。模型不能提供或改变该身份。

正常路径继续采用既有契约：

```text
created
  → 两层内存准入成功
  → durable reserved 确认成功
  → provider_started
  → 可确认的 provider_finished
  → 两层内存 commit 成功
  → 合法 durable committed 确认成功
  → settled
  → 允许结构化决策进入既有 Broker 准入
```

在最终实现中，让 live lifecycle 和 replay 共用请求关联校验、合法状态与结算判断，或通过足够明确的共享契约和测试保证一致。可以提取必要的小型纯函数/状态模块；不要求某个类名或新框架，避免维护两份互相矛盾的规则。

只有明确成功的返回满足成功契约。`undefined/null`、未知状态、缺字段、Promise 创建和事件回调触发都不能自动成为成功；兼容现有 API 时明确其实际返回契约，并测试调用点。

### 4.2 调用前与调用后严格区分

- 调用前：任一层额度不足、窗口拒绝或 durable reservation 未确认，provider 必须 0 次；只补偿确定未 dispatch 的占用。
- 调用后：结果、内存提交或 durable 提交不确定，停止当前链的后续 provider/Broker dispatch；不得退款成“从未发生”，不得换 request id 自动重试。
- 已有可信结束信息的 provider 失败可以按明确失败结果记账；没有可靠结束信息时保留 unknown/reconciliation。SDK 合成 `message_end` 或零 usage 不能独自证明请求未发生或已正常结算。
- 准入的幂等只代表不重复预留，不代表允许对未决请求再次调用 provider。
- 同一 ledger object 只预留/提交一次；两个 ledger 各自只操作自己的 reservation。

### 4.3 成功放行与失败收尾

成功放行同时依赖两层内存 commit、合法 durable commit 和无 outstanding 未决请求。末次请求也必须等待结算，不依赖 NEXT continuation。

所有退出路径均经过确定的收尾：已发起的提交必须被等待/处理，订阅必须清理，provider gate 必须正确恢复。拒绝、transport error、accounting error、缺 message_end 和正常完成都要覆盖。

失败返回保留已发生 provider 次数、原始失败类别和可用 reconciliation；不给出可执行决策，不推进依赖任务。Composite/Broker 的已有阻断接线必须实际生效。

### 4.4 durable reconciliation 与持久化失败

可写时持久化关联完整的 reconciliation，至少能回答：哪个 Campaign/Task/request，哪两侧 reservation，provider 是否已开始/结束，两层 commit 哪项成功/失败/未知，失败原因、输入估算、预算占用与恢复状态。沿用既有 writer 和 `runtime.note`/`c6.request`，扩展必要 payload 字段，不建立第二条权威日志。

reconciliation append 失败时，不可能保证成功写入一个新事件。此时必须停止并保留错误，利用先前已确认 durable 的 reserved 记录，在重启时保守重建未决请求；不能伪称 reconciliation 已持久化，也不能因新事件缺失释放占用。

如果内存一侧已 consumed、另一侧仍 pending，不回滚已经发生的事实，不重复扣另一份费用。恢复检查的核心是每侧 `consumed + pending` 代表的预算责任和未决语义一致；不要求未持久化的瞬时内存结构在重启后原样出现。持久记录有足够信息时，应恢复具体状态。

无确认的结算/释放记录时，剩余 reserved 不能自动视为安全可重发。恢复必须把未决状态接到当前运行停止/阻断路径，仅在 report 中显示 unknown 不够。复用现有 reconciliation 能力，不新增自动退款或复杂人工结算平台。

### 4.5 重建、隔离与兼容

- 按完整请求关联重建，不能只凭某个 reservation id 出现在全局 Set 中就认定联合请求完成。
- Task ledger 只注入该 Task 的 consumed/pending/committed 身份；Campaign ledger 保留其聚合责任。
- 重复 reserved、committed、reconciliation 与重复重建不新增占用或计费；冲突记录保留诊断并停止受影响路径。
- 对已有日志中的不完整记录采取保守 invalid/reconciliation 语义，不删日志、不伪造缺失身份、不猜成完整成功。
- checkpoint、report、measurement 不能覆盖权威请求状态，也不能为了旧测试统计绿色而弱化恢复规则。

### 4.6 实际输入窗口

继续由 provider-bound 实际 `llmContext` 测量给出最终窗口准入，首请求和 continuation 使用同一规则，覆盖真实 messages/system/tool schema/tool results 与输出预留，避免重复计量。

旧 cached prompt/ROM/RAM 估算是已知非阻塞项。若保留，说明其保守用途；它不能成为第二套权威窗口规则。若直接相关、改动很小，可删除重复判断或修正误拒绝。不扩展为 tokenizer、费用预测或精确上下文平台；未观测 backend token/currency 继续标 unknown。

## 5. 先冻结测试，再实现；测完整行为

复用当前 C6 plan/matrix/report/runbook，各加一个本轮收敛段即可。记录需求、case、入口、独立 expected、exact command、exit、私有 log 和当前结果。不要再制造多套平行计划和长审计链。

先补已复现缺陷的行为 red，在尚未修改的产品实现上执行。新增接口尚不存在导致的 import/syntax failure，不算证明测试能捕获逻辑错误。控制测试和已正确边界不需要强行变红。

下表是本轮 required 行为范围，可用多个 case 或参数化覆盖，不以测试数量作为目标：

| 场景 | 必须观测的行为 |
| --- | --- |
| 合法请求，两个 ledger；另有同对象控制 | 请求放行，预算各只计一次，有效 durable commit，Broker 真正执行合法动作，Oracle 检查产物 |
| Task 或 Campaign 内存 commit 失败，durable writer 可成功 | 返回失败、完整 reconciliation；无联合成功记录，无后续 provider/Broker effect；含返回 false 与 throw 路径 |
| durable final commit 失败 | 包括有缓存决策、无 NEXT 请求；不放行，保留预算责任；原有 continuation 失败停止仍成立 |
| provider 已调用后抛错，无可靠 message_end | 调用次数真实为 1；未决占用保留；持久 reconciliation；无后续 dispatch，清理完成 |
| SDK 将错误转为合成消息 | 根据真实 dispatch/结束证据分类，不将合成消息或缺 usage 当作成功；拒绝前的合成错误不计真实请求 |
| prompt 返回但最后请求仍 outstanding | 即使 decision buffer 有内容也不得成功或执行 Broker |
| provider error 后 reconciliation append 再失败 | 返回持久化失败事实；reserved 源仍可恢复未决占用；重启不自动重发、不释放预算 |
| 调用前 joint admission/reserved append 失败 | provider 0 次，合法补偿，不产生正常 null-id reservation；保留现有正负例 |
| A 有 pending，B 无 pending，及 A/B 均有各自 pending | 经实际 Task ledger 创建接线恢复后，各 Task 仅有自己的占用；Campaign 正确聚合，余额写出具体数值 |
| 双层 request 只有 Task 或 Campaign 一侧 committed | 不能结算整个请求，另一侧占用不被释放，invalid/reconciliation 可见；完整匹配提交为正控制 |
| request/Task/Campaign/reservation 关联错配及重复事件 | 错配不能结算其他请求；重复合法事件不双计；重复恢复保持语义 |
| reserved-only 或 reserved + reconciliation 后重启 | 未决请求保持预算责任，实际产品恢复路径阻止盲目重发与 Broker dispatch |
| 首次合法与 continuation 超窗 | 最终准入仍按实际输入；现有合法、超窗和 schema 覆盖断言保留 |

测试不能只检查 `ok:false` 或 reason 字符串。按场景同时观测：provider counter、Broker counter/真实文件效果、两层 snapshot、durable payload/事件链、只读重建结果及清理。

用受控 ledger/provider/writer 注入失败可以，但它们不能自行生成产品期望结果。至少保留并补足：

1. 真实 Pi SDK + faux 的合法产品链，实际产物由独立 Oracle 判定；防止“全部拒绝”实现也通过。
2. 经真实 Composite 路径的记账/transport 失败，无 Broker effect，而非只直接调用 Worker。
3. 使用实际 entry persistence 和 Task ledger 创建接线的恢复验证，防止 helper 正确而入口仍传全局 pending。
4. 一个针对当前请求生命周期的真实子进程中断/重启用例：保留 durable reserved，在结算完成前终止，重启证明预算责任与阻断。可扩展已有恢复 harness；不要全部用数组重放或 throw 冒充进程恢复。

确认 SDK runner 的 source resolver 是否实际加载；故障测试、日志或 teardown 错误必须如实报告。测试不能读取真实凭据或隐式调用真实 provider。

## 6. 推荐执行顺序与范围控制

按依赖自主推进：

```text
核对基线和真实 SDK 语义
  → 简短记录状态/关联/恢复契约及本轮矩阵
  → 已知缺陷行为 red
  → 统一 live 请求结算与全部退出收尾
  → durable payload、replay、Task 隔离与幂等恢复接线
  → Composite、真实 SDK/faux、实际 entry/进程恢复组合验证
  → 自审、有限 mutation、required 回归和静态检查
  → 更新交付证据并本地提交
```

允许局部调整顺序和接口，不要求机械按文件拆任务。先看完整生命周期再改，避免一边改 Worker 一边让入口继续丢字段或让 replay 继续退款。

主要修改范围为上述 Aegis-owned Worker、ledger、entry 及必要直接接线、测试、C6 文档。若提取请求状态纯模块，纳入实际 Campaign 类型检查。

已有 Host、Scheduler、Broker、Oracle、EventLog、学习模块继续复用。只有证明存在与本轮不变量直接相关的当前可达缺陷，才修改它们的必要接线。

不实现：第二套预算/事务/调度平台、多 Worker、容器/远程环境、任意 shell、OS sandbox、F16/缓存/向量检索、精确计费、全仓历史类型清理、真实模型能力或学习收益实验。

新发现只有具备当前可达复现，并破坏假成功/授权/预算/重复效果/权威恢复等本轮核心承诺，才能列为新 blocker。说明违反的契约后做必要修复。风格、推测性防御、未来功能、性能 warning 列 non_blocking/deferred，不能无限扩大验收。

自主完成正常实现、测试、接口选择和本地提交，不为 helper、命名、内部阶段反复请求许可。有真实的新增依赖、Pi 核心改动、扩大授权或降低证据门需求时，只停止受影响部分，说明最小问题，其余独立工作继续。

有实际可用的子 Agent 能力且适合本轮时，可按不重叠文件/只读审查分工；没有就串行 TEST → IMPLEMENT → REVIEW，如实记录。不要为本任务构建委派平台，不把同模型自审称外部验收。

## 7. Required 检查与显式回归清单

原 focused 和 external boundaries 必须保留并运行；本轮新增用例另行列明，不能仅报告历史 23/23。

```bash
node --test Pi_Agent_base/tests/aegis-c6-recheck-boundaries.mjs
node --test Pi_Agent_base/tests/aegis-c6-external-boundaries.mjs
```

SDK 脚本使用实际 source resolver，例如：

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c6-product-chain.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c6-learning-closure.mjs
```

原 15 个 C6 suite（加上本轮新增脚本后总数可能增加，报告准确总数）：

```text
aegis-c6-code-repair
aegis-c6-durability-recovery
aegis-c6-external-boundaries
aegis-c6-learning-closure
aegis-c6-learning-reuse
aegis-c6-ledger-input
aegis-c6-product-chain
aegis-c6-provider
aegis-c6-recovery
aegis-c6-rotation-reject
aegis-c6-runbook
aegis-c6-runner
aegis-c6-sdk-lifecycle
aegis-c6-service-measure
aegis-c6-recheck-boundaries
```

原 26 个受影响回归：

```text
aegis-c5-integration
aegis-c5-export-observation
aegis-c5-runbook
aegis-c5-session-sdk
aegis-c5-external-boundaries
aegis-c2-supervisor-boundaries
aegis-c2-budget-sdk
aegis-c2-session-rotation
aegis-c3-host-fixture
aegis-c3-gate-sdk
aegis-c3-durability-recovery
aegis-c3-external-boundaries
aegis-c4-report-export
aegis-c4-external-boundaries
aegis-c4a-observation-http
aegis-c4a-external-boundaries
aegis-observer-runtime-handoff
aegis-observer-failclosed-pi
aegis-observer-outcome-command
aegis-observer-verify-first-pi
aegis-observer-data-use-pi
aegis-learning-bridge-e
aegis-learning-commands-pi
fixture-pi-orchestrator
aegis-campaign-c1-eventlog-durability
aegis-campaign-c1-integration-recovery
```

复用 `Pi_Agent_base/tests/helpers/c6-suite-runner.mjs` 或等价直接执行，脚本名称对应 `Pi_Agent_base/tests/<name>.mjs`。调用 runner 时传入上述真实名称；其 resolver 判断是否满足新增测试也要核对。私有日志放 ignored `Pi_Agent_base/runtime/dev/c6-lifecycle-<run-id>/`。最终记录展开后的 exact argv、真实 exit 和 log，不能把模板命令或历史结果当执行证据。

静态检查：

```bash
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json <本轮实际修改的代码和测试路径>
```

先核对本地工具路径，不安装未授权依赖。类型检查改前/改后均保存诊断，比较实际路径和诊断内容。历史 196 条是参考基线，不是必须凑出的数字；修改/新增文件不得新增诊断，不关闭 checkJs、不排除新模块、不用 blanket any/ts-ignore 降低检查，也不要求无关旧库全部清零。

有限 mutation 针对本轮规则：忽略一侧 memory commit failure、缺结束仍放行、provider error 不保留未决状态、reconciliation 当 release、全局 Task pending、部分 id 被当完整 commit、重复 event 再计费。可以合并具有相同检测目标的 mutation，不设置数量竞赛。每项记录具体变更、杀死它的 case 和真实行为 FAIL；import/syntax failure 不算。mutant 仍绿先补行为断言，不修改 expected 掩盖盲区。

聚焦验证通过后完成一次 required 回归；只有后续代码变动、失败或具体未解风险才扩大/重复检查，不无限扫描全仓。

## 8. Git、文档与真实环境边界

遵守本地 Git 规范，在明确任务分支上逐路径暂存、阅读完整 staged diff，按可审查单元提交。既有任务分支可继续使用；不 push、不改写历史、不 reset/clean/stash 用户工作树，不混入其他任务改动。提交正文如实注明 Agent 协助。

不修改 `Pi_Agent_base/pi/` 核心、真实 `config/`、auth/models/settings 或 lockfile，不读取真实凭据，不调用真实 provider/API/外部目标。runtime 原始日志、测试产物和私有材料留 ignored；公开报告只写有界证据、准确结果和引用。

更新现有 C6 plan/matrix/report/runbook 的当前结论和本轮证据，纠正与新实现不一致的字段/注释。保留历史报告的验证范围，不把过去通过改写为没有发生，也不能让旧 `internally_verified` 标题冒充当前状态。旧审查证据保留；新增证据说明是 DS 内部验证，不冒充外部审查。

真实 pilot 的 runbook 只需给出已有入口可用的步骤、必填的模型/endpoint/目录/授权/预算/Oracle/停止条件以及尚未实测限制。复用现有接口，不写入真实配置、不开始实验、不新增复杂实验框架。模型选择和实际实验预算由用户下一阶段确定。

## 9. 完成条件与交回格式

在下列条件全部成立前，保持 `changes_required`：

- 四项已复现缺陷及直接关联的 reconciliation 恢复语义已闭合。
- live、durable、replay 使用一致的请求结算/未决规则；实际 entry 和 Task 接线得到验证。
- 正常产品链仍可执行并获得独立 Oracle 判定；错误链没有新增 provider/Broker dispatch。
- 已知缺陷有行为 red → green，关键 mutation 被行为测试捕获。
- focused、新增生命周期验证、原 15 C6 suite、26 回归、Biome 和类型基线检查均有实际结果；没有被隐藏的 required 失败或未运行项。
- 最终 diff 和相关调用点已自审，未留下本轮范围内的当前 blocker。

达到条件后可报告 `internally_verified / awaiting_external_review`，它只代表本轮内部工程验证完成，不代表用户已接受或真实模型能力已验证。任何 required 检查未完成，要明确原因、剩余动作和真实状态，不能提前标记 internally_verified。

最终报告聚焦以下材料，复用现有文档，避免以报告篇幅替代结果：

1. 根因与最终设计：成功/未决/释放各由什么条件决定，哪些逻辑得到统一。
2. 四项缺陷及 reconciliation 语义的实现位置、测试和具体结果。
3. 正常链与失败链的 provider/Broker counter、真实效果、两层预算数值和脱敏 durable payload；重启后状态及阻断证据。
4. red → green、mutation → case → 实际 FAIL、全部 required 检查的 exact argv/exit/log。
5. 类型诊断真实基线/差异，修改文件、新接口、分支、commit 和准确工作树状态。
6. 当前非阻塞/后置项及限制；下一阶段有限真实任务 pilot 所需输入，不声称已启动或已经有效。

本轮应持续执行到上述工程交付完成，正常中间阶段不向用户停工要确认。达到退出条件后交回一次限定工程复验，不自行启动真实环境，也不再追加无关基础设施工作。
