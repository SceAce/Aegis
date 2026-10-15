# E1 契约闭合实现外部审查（2026-10-15）

**结论：`changes_required`。保留已修复部分，不能按“E1 契约闭合 / S0–S4 完成”验收。**
DS 最后保留 `changes_required` 是正确的，但未闭合范围明显大于交付报告 §8 所列事项。
当前仍有可信输入、累计分配、Host 命令、工具生命周期、有效判定和恢复权威的断点。
这些是原任务要求，不能由实现者自行改列为阶段外工作。

本轮独立复跑 required **68 个唯一脚本全部 exit 0**；新增审查脚本 **30 项：1 pass / 29 fail，exit 1**。
正常真实 SDK/faux 对照仍是 **8 次请求 / 3 次 Broker 效果**。
29 条失败断言按根因归并如下，不表示 29 个互不相关的缺陷。

## 1. 审查身份、准则与范围

| 项目 | 本轮记录 |
| --- | --- |
| DS 起点 | `852cc5e` |
| 被审查交付 | `7940112793e02fe9eb0d002aa488e5ac9812c855` |
| 最后产品提交 | `0d315e0`；其后的 `7940112` 是报告/AGENTS 提交，不构成产品代码遗漏 |
| 提交范围 | 起点之后 9 个产品/测试相关提交，加 1 个交付文档提交 |
| 审查分支 | `audit/e1-contract-closure-20261015` |
| 内嵌 Pi | `42a3497d03ad17e308a2299fa824727894f2c0ec`，检查 clean |
| 冻结依据 | `SYS-20261015-01` / B01–B14；`E1-CC-1.0` 任务书、测试矩阵、required 清单 |
| 本轮产物 | 本报告和 `tests/aegis-e1-contract-closure-review.mjs`；未修改产品实现、基线或既有测试断言 |
| 用户既有修改 | `docs/E1_CONTRACT_CLOSURE_DS_PROMPT.md`，未触碰、未纳入审查提交 |

固定准则仍是：Host/Manifest 授权；事件审计源与业务接受分开；Broker 在效果边界重验；
独立 Oracle 精确判定；Task/Campaign 双侧预算；相同输入的执行、恢复、Board/RAM/观察/学习语义一致。
checkpoint、图板、报告不能成为权威输入。没有修改这些准则来迁就当前实现。

审查阅读了 DS 的完整产品变更及关联入口：planning contract/compiler、Manifest、
projection、Scheduler/Host、C6 entry/model worker/request lifecycle/tool ledger、
Board、artifact index、Outcome resolver、learning bridge、E1 view、Observer/supervisor 调用点，
以及新增 closure 测试和 fixture 迁移。未逐行复审全仓历史实现，也不重开已限定接受的 C1–C6 全部能力。
未调用真实 provider/付费目标，未读取真实凭据、修改 Pi core、安装依赖或改变 lockfile。

## 2. 可以确认保留的成果

- Manifest 已有内嵌 planning contract 和摘要；普通新 admission 的重编译比较，比起点更严格。
- 动态 Task 的 `task_budget` 已接入 provider 限额；原 HA-02 的请求越额反例已修复。
- 第一批有效计划固定、第二个不同 ID 的计划被拒；原 HA-03 的 68→128 反例已修复。
- 工具和 Host 对正常候选共享 submitted 去重；正常链只有一条 submitted。
- 原 completion/history 审计原断言未改，本轮分别 12/12、4/4；缺规划身份的恢复拒绝有效。
- 将 artifact index 提取到中立模块并保留 re-export，避免了 Board/Campaign 的直接循环依赖。
- C6 request 三事实、provider error/aborted 门、Broker/Oracle 分工应继续保留。

上述成果分别成立，尚不能推导出所有消费者、重试、累计额度和恢复契约都已闭合。

## 3. 当前阻塞发现

路径均相对 `Pi_Agent_base/`。P1 表示影响当前正确性/权威/预算的优先修复项；
P2 表示同样属于本轮交付要求、但影响更局部的项。是否阻塞同时依据原 CC/B 条款，
不因优先级标签或测试数量自行扩大阶段目标。

### R01 · P1 · 可信 Manifest helper 没有接入真实新 run / resume，计划绑定未验证

**位置：** `memory/campaign/c6-entry.mjs:263`、`:276`；
`memory/campaign/event-contract.mjs:157`；`memory/campaign/projection.mjs:961`、`:1060`。
**原要求：** CC01/CC03，任务书 §4、§5.2；B01–B03。

真实入口仍加载当前 config 指定的 Manifest，并从当前 `config.planning` 取模板构建上下文。
生产 run 没有调用 `persistImmutableManifest`；搜索到的调用只有 fixture/测试。
正常 SDK run 没有 `work_dir/manifests/`（XR-01）。已有文件副本 helper 不等于产品已经冻结输入。
resume 没有按首条可信 started 的绑定定位 canonical 副本，也没有对安全配置变化返回
`planning_context_conflict`。

plan envelope 适配没有读取 binding version、Manifest revision/digest、context digest，
submitted/admitted 未核对实际 accepted planning Episode。
XR-02 分别改变 admission 的 `manifest_digest`、`context_digest`、`manifest_revision`、`episode_id`，
重新生成合法 hash chain 后，四种输入仍各接受 3 个动态 Task。
摘要可以重算，不代表这些业务绑定已经有效。

**相关代码确认，尚未注入磁盘故障：**
`manifest.mjs:653` 和 `:674` 的已存在/并发同内容成功分支只 fsync 文件，未 fsync 父目录；
首次目录 fsync 失败留下的文件，下次可能被该分支宣称 `synced:true`。
最外层读取 catch 也把所有错误当不存在，不仅是 ENOENT。与 §4.1 的三个成功分支要求不符。

**修复方向：** 把创建、持久确认、日志绑定、恢复加载和配置冲突检查接入同一 run 入口；
由 accepted started 派生 planning binding，让共同转移函数逐条验证全部适用 envelope。
不能靠增加一个未调用 helper 或只核对 `planning_task_id` 完成此项。

### R02 · P1 · 重放的重编译没有使用真实 prefix 累计分配

**位置：** `memory/campaign/projection.mjs:1038`；`memory/campaign/e1-planning.mjs:324`。
**原要求：** CC03/CC05/CC06，§5.2、§7.1；B05/B06。

`recompilePlanDefinitions` 只从 Manifest 建 existing IDs，传入的 derived budget 固定为三维 0；
没有该 prefix 已接受定义、静态分配与累计账本。admission 应用后只是增加预算，
末尾计算 `allocation_total=reserved+consumed+released` 并不能替代准入检查。

XR-03 用正常候选及实际 accepted definitions 构造内部一致的超额批次：
Campaign 请求额度 100、planning 固定分配 8、三个子任务各 33，**总分配 107，仍接受全部 3 个任务**。
这证明原 68→68 测试只挡住第二计划，未证明单计划的累计 envelope。

live `admitCandidatePlan` 仍只使用 `projection.budget.reserved`；普通 proposal 重放
`projection.mjs:1263` 只加 reserved+consumed，漏 released。后者本轮为代码确认，未另跑释放后 proposal 序列。

**修复方向：** live/replay 编译都使用最新 prefix 的 accepted definitions 与 gross allocation，
在整批转移之前检查三维安全加法及 envelope；重复原批次按原前缀比对，不再次计入额度。

### R03 · P1 · Host 仍相信调用方 admission，重复命令没有正确业务返回

**位置：** `memory/campaign/scheduler.mjs:361`、`:436`、`:458`；
`memory/campaign/projection.mjs:1091`；`memory/campaign/c6-entry.mjs:1073`。
**原要求：** CC03–CC05，§6.1–6.2；B03/B05/B07。

Host API 仍要求调用方提供 `admission`，直接写其 status/normalized/budget，没有在最新 prefix 自行编译。
EventLog 只串行 append，`run` 的 singleflight 也没有覆盖独立 Host 命令的读—决策—提交事务。

同 id+digest 的 replay 在完整定义和绑定比较之前直接成功：
XR-04 将重复 admission 的 target 改成 `forbidden.txt`，该记录未被拒绝。
这是冲突记录被当成幂等，**本例没有证明它已覆盖首批定义或造成越权效果**。

XR-05 重送完整相同 admission，Host 返回 `admitted` 并指向新记录，而非 `duplicate` 引用原 admission。
Host 只检查结果中该计划是否已经 admitted，无法证明本次 event 被接受。
`commandResult` 的 `transition_accepted` 只看 `status==='admitted'`，`activated` 固定 false。
XR-06 的 A→同 ID 冲突 A′→原 A 经真实 `admitCandidatePlan` 重送，最后因自己的动态 Task ID
“already exists”被拒，未实现原 A 始终 duplicate 的约定。

entry 仍在候选循环外只取一次 projection，返回最后命令结果，而不是按 active plan 作最终决策；
这部分是代码确认，未在本轮新增完整多候选 SDK 序列。

**修复方向：** Host 自己执行同一编译/转移，在共同短序列器内读最新状态、决定、持久、重放确认；
逐事件确认 accepted/duplicate，保存并返回原确切 durable identity；调度使用 active_plan_id。

### R04 · P1 · ExecutableTask 没有形成严格的唯一规范，正常定义摘要也不覆盖最终内容

**位置：** `memory/campaign/e1-planning-contract.mjs:309`；
`memory/campaign/e1-plan-contract.mjs:444`、`:486`；`memory/campaign/projection.mjs:1353`。
**原要求：** CC02/CC03，§5.1；B02/B06。

XR-16：完整 task_budget 配仅含 model_requests 的 budget_reservation，normalize 仍 ok；
缺失别名维度被 continue 忽略，未按契约拒绝。
XR-19：候选 task_budget 与 budget_reservation 冲突，compiler 构造 definition 时丢弃前者，仍 admitted。

XR-17 对正常产品 admission 重新计算 `digest(完整最终定义去掉 task_digest)`，**与自带摘要不同**：
normalize 先按默认 order 算 hash，compiler 后改 order。
proposal 也在 normalize/hash 之后追加 admission_ref/execution_adapter，摘要未覆盖最终语义。
两个调用点还在 normalize 失败后构造 fallback definition，未守住失败不产可执行半成品的约定。

**修复方向：** 原输入中两个预算别名都先完整校验；统一保留/拒绝所有执行字段；
所有编译字段确定之后计算一次最终摘要；失败显式拒绝；验证再次规范化保持同值。

### R05 · P1 · 工具收费缺可信绑定、事务原子性与冲突拒绝

**位置：** `memory/campaign/scheduler.mjs:585`、`:598`、`:615`；
`memory/campaign/projection.mjs:256`、`:421`；`memory/campaign/c6-entry.mjs:556`、`:973`。
**原要求：** CC04/CC06/CC07，§5.3、§7.2；B01–B04/B06/B07。

charge API 只要求 request/tool/unit ID 非空，不证明 actual active Task/Episode、请求已发出且属于该绑定。
缺 Task/缺额度不会明确拒绝；Campaign 0 额度分支也被 `campaignLimit>0` 跳过。
replay 的 c6.tool 在 Campaign envelope/source 校验之前单独处理，未核对 source、Manifest/context、
实际 started/request、单位和完整去重内容。

- XR-08：不存在的 provider request、未 accepted started 的 Task，仍成功持久收费。
- XR-09：真实 EventLog/fsync 上并发两条 charge，Task/Campaign 工具限额都为 1，
  **两条均 ok，重放收费 2**。append 串行无法保护此前的余额读取。
- XR-10：同去重键改 arguments_digest，仍返回 duplicate ok。
- XR-11：`source.kind=llm` 的 c6.tool 被重放进账。
- XR-12：无此前 charge 的 finish 被 reducer 拒绝，`finishTool` 却仍返回 ok，因为没有确认业务接受。

上述 Host 工具测试是隔离 API 边界探针；XR-08 故意缺绑定，XR-09/10 也未构造完整 SDK request/start。
它们证明当前 API/reducer 接受和并发缺陷，**不能称已复现真实 SDK 并发重复 Broker 效果**。
修复时既要让非法绑定拒绝，也须补合法 accepted start/实际 request 下的并发对照，不能靠统一拒绝掩盖事务问题。
Campaign 0 的代码问题不单独宣称合法 Manifest 主路径越额，本轮不以 Task 分配大于 Campaign 的非法 fixture 作为证据。

entry 的 `requestBindingRef` 在 reserved 时只记最后 request，未建立 assistant toolCall→原 request 映射；
缺真实 SDK ID 还会合成 ID。SDK 工具 execute 没有等待对应 pendingCommit，未设置实际支持的 sequential 模式。
下一 provider dispatch/最终 flush **已有** pendingCommit 等待，不能把它描述成完全没有持久化门。

**修复方向：** 先在真实 assistant message_end 绑定实际工具批次/请求；execute 等待对应 settlement，
再进入与计划共享的短事务，校验最新授权/时间/余额；replay 用同规则核对身份和完整去重内容。

### R06 · P1 · 收费事件未进入实际 C6 重建账本，工具完成责任也未接入执行门

**位置：** `memory/campaign/c6-request-lifecycle.mjs:171`；
`memory/campaign/c6-model-worker.mjs:400`、`:435`；`memory/campaign/scheduler.mjs:685`。
**原要求：** CC06/CC07/CC09，§7.2；B03/B06/B07/B10。

XR-13：正常真实 SDK 链已有 3 条 durable charged，
`summarizeRequestLedger(normal.events).consumed.tool_calls` 却为 **0**。
它继续只解释旧 c6.request 中的工具聚合，不消费新 c6.tool。
entry 的恢复种子、measure 和 E1 view 仍使用该 reducer，形成两套不一致的预算事实。
Host 独立 tool charge map 仍能挡住部分超额，**不能据此断言所有工具限额都已失效**。

XR-14：同一正常链 **3 charged / 0 finished**，仍完成后续请求和 3 次 Broker 效果。
产品中 `finishTool` 只有定义/Host 转发，没有实际工具调用者；unfinished/finish 失败未成为 continuation/effect/ready 的共同 hold。
read/submit 没接收费，request 也未固定同一 tool_accounting 协议；尚无可靠的旧聚合/新 charge 选择与混协议 hold。

代码还显示：收费 duplicate ok 会继续把同一动作写入 buffer，没有复用结果/duplicate_in_flight 门；
`arguments_digest` 实际保存 `JSON.stringify` 的完整参数而非 hash，含 action arguments/proposal，
违背“不复制原始敏感参数”和 canonical 摘要要求。这两点本轮为源码确认，未新增 SDK 重复执行/敏感数据注入测试。

**修复方向：** 保留原 provider 三事实，接通同一固定协议下的双侧工具账、真实 finished/SDK result 持久门、
执行去重与全部允许工具；实际参数先 canonical hash，日志只保存摘要和有界引用。
再做 charge 前后、工具体前后、finished 与 SDK writer 前后的真实 SIGKILL/barrier 测试。

### R07 · P1 · authority 仅共享 Outcome ID，Board 仍独立解释原始身份和修正

**位置：** `memory/campaign/projection.mjs:360`、`:564`；
`memory/runtime/board.mjs:643`、`:669`、`:793`、`:449`。
**原要求：** CC08/CC09，§8.1；B02/B03/B08–B10。

输出没有 accepted_starts、完整 accepted Outcome binding 与 effective_judgments，只有 Outcome/动态定义 ID 和拒绝项。
Board 仍扫描所有 raw admitted/started 建身份，修正仍对全部 normalizedEvents 独立执行。
因此“降级被拒 Outcome 为 Hint”不能保证它无法影响其他 Fact。

- XR-20：已完成 Task 后追加一条 reducer 明确拒绝的 terminal restart，Board 用其 foreign Episode 覆盖索引，原合法 Fact 消失。
- XR-21：independent=false 的 unknown 修正被 authority 拒绝，却仍让 Board 退役原合法 Fact。
- XR-25：同 outcome_id 改 observed 内容，projection 提前按 ID 幂等，未拒绝冲突记录。
- XR-26：criterion 要求 name=Ada，observed 改为 name=attacker、status 仍 success，Board 仍给 Fact。
- XR-27：同绑定合法 unknown 修正没有 success evidence，projection 接受，Board 因强制 evidence 拒绝退役，旧 Fact 仍有效。

XR-25 的主断言先检查冲突拒绝，故本轮不能把其后未执行的第二 Fact 断言冒称独立通过/失败。
XR-26 证明已知数据判据的矛盾值能成为 Fact，不要求解析任意自然语言判据。

**修复方向：** 输出带 event_id/offset/完整绑定的 accepted/effective 判定；
Campaign Board 从该集合适配身份、Fact 和修正，停止用 raw 记录和 ID 白名单另算权威。
所有修正/冲突/unknown 都必须同时核对旧结果、当前结果和消费者视图。

### R08 · P1 · 环境失效只影响 Board，未撤回未启动依赖的执行许可

**位置：** `memory/campaign/projection.mjs:321`、`:548`、`:952`。
**原要求：** CC07/CC08，§5.3、§8.1 第 5–7 项；B04/B08–B10。

依赖仍只看历史 `state==='completed'`，没有共同 effective_status/dependency_satisfied。
XR-22 在 dyn-a 刚完成、dyn-b 尚未开始的真实 prefix 追加同 scope 可信 environment.changed：
Board 已撤下 dyn-a 的 Fact，**dyn-b 仍 ready**。链、正常前缀和 Board 失效对照均已验证。

当前活动 Task 的下一请求/效果也没有共同 inspectExecutionPermit 去重验失效前置事实。
保留 completed 历史是正确的，但它不能继续充当当前依赖满足的唯一依据。

**修复方向：** 从共同 effective judgments 计算当前依赖；失效后阻止未启动子任务及后续请求/效果，
保留既有完成/动作历史，不回滚副作用、不自动重跑。

### R09 · P1 · Outcome 未严格按当时证据 prefix 与实际 accepted Episode 验证

**位置：** `memory/campaign/artifact-index.mjs:18`；`memory/runtime/board.mjs:650`；
`memory/campaign/projection.mjs:577`；`tests/helpers/e1-closure-helpers.mjs:105`。
**原要求：** CC03/CC07/CC08，§8.1 第 1–2 项；B02/B03/B08/B10。

调用者先用全量日志生成 artifact Map 再交 projection；Map 没有 origin_event_id/offset，
后出现的同 ref 会覆盖此前 digest。Oracle Outcome 自身写出的 evidence refs 也直接加入索引。
此后逐行 reducer 无法证明证据当时已可解析。
XR-23 把早期 Outcome 换成新的未有先前产物的 ref，并在未来追加 artifact，重放仍接受早期 Outcome。
**该例同时暴露 Outcome 自报 ref 被登记的问题，不能说已隔离证明“仅未来 artifact”这一种来源。**
源码的全量索引调用足以确认 prefix 约束未落实。

XR-24 删除 dyn-a 的实际 started、保留其他真实事件并重建合法链，Task Oracle 仍在 accepted_outcomes；
代码用 `item.episode_id ?? envelope.episode_id` 从被验证事件自报 Episode 填补权威。
Stage 分支在同样缺 started 时拒绝，Task 分支不应更弱。

**修复方向：** 逐物理 prefix 登记实际可信证据及来源，不从待验证声明自行补证；
Task/Stage 都只绑定已接受 started。可信 registry/file fixture 与事件产生证据明确区分。

### R10 · P1 · E1 仍接受 priorState/checkpoint 权威，不只是少一个错误码

**位置：** `memory/campaign/projection.mjs:98`、`:170`；
`memory/campaign/scheduler.mjs:763`。
**原要求：** CC03/CC10，§9；B03/B10/B11。

XR-15 传入此前正常投影作为 priorState.queue/budget/control，events=[]：
projection **ok=true，恢复出 4 个 completed Task**，而非 full_replay_required。
Scheduler 仍有 checkpoint 初始化/尾部恢复路径，并用缓存状态本身计算 prefix digest；
没有按 E1 标志禁用权威缓存。

因此交付报告“E1 不用 checkpoint 的 plan 权威，仅未返回精确 code”的表述不成立。
本例直接验证 projection；本轮未新增伪造磁盘 checkpoint→真实 SDK dispatch 的完整进程攻击试验，
不把该后续效果当作已复现。

**修复方向：** E1 完整 committed 源重放，used_checkpoint=false；tail+prior 不足以恢复时明确失败，
不能导入 cache 的定义、ready、outcomes 或完成状态。普通静态路径保持其已有兼容契约。

### R11 · P1/P2 · 已列“后续”的时间/消费者接线仍属本轮；builder 拒绝也未完成

**位置：** `memory/campaign/c6-tool-ledger.mjs:61`、`:79`；
`memory/campaign/e1-planning.mjs:58`；`memory/campaign/e1-planning-contract.mjs:155`；
`extensions/aegis-observer.ts:327`、`:341`；`memory/runtime/session-supervisor.mjs:102`。
**原要求：** CC01/CC06/CC09，§4、§7.3、§8.2；B01/B06/B10/B11。

P1 时间门：仍以进程内 ledger 的 `startedAt=clock()` 计算 elapsed，没有持久 accepted started 锚、
重启 deadline、clock_regressed、临界点/溢出验证。DS 已承认，本轮源码确认，未新增真实跨进程时钟试验。
这在当前恢复功能中会重新给已启动对象计时，不能自行留到新的产品阶段。

P2 builder：XR-18 的 base 只有 requests=4/tools=4/wall=1000/task_count=0，
builder 仍 ok，却生成 planning 8/24/120000。移除 Math.max 不等于已拒绝不足 base。
它还把 dynamic enabled 固定 true，并用配置模板集合替换 allowed_task_types；
contract builder 未完整核对模板 capability、scope permissions 与 Oracle 是否属于 Manifest 授权/注册表。
后续 validateManifest 可能挡住部分非法 run；XR-18 只证明创建接口违反拒绝契约，**未证明该非法 base 已发 provider 请求**。

P2 消费者：Observer rebuild/verify 和 supervisor 仍 `projectBoard(events)` 不传 Manifest，
entry 的部分 handoff 路径也如此。缺 context 的安全降级比误信更好，但无法替代 §8.2 要求的
真实 E1 输入接线和等价核验。learning/E1 view 的传参改进应保留；当前尚未证明错误 Experience active 晋升。

**修复方向：** 仍在原 E1 任务内完成持久时间锚、builder 的拒绝/授权核验和消费者上下文传递。
分布式时钟安全、增量再分配、学习效果实验等原后置项继续后置，不借此扩展本轮范围。

### R12 · P1 · 新 closure 测试的关键操作与标题/需求不一致，不能据全绿证明闭合

**原要求：** CC10、§11–12；测试规范 §7/§9/§10；B03/B13/B14。

| 测试位置 | 声称覆盖 | 实际测试体与缺口 |
| --- | --- | --- |
| `tests/aegis-e1-closure-contract.mjs:101` | 不足 base 被拒绝 | `:117` 断言 built.ok=true，expected 与任务书相反 |
| `tests/aegis-e1-closure-admission.mjs:44` | 重复相同计划幂等 | 仅投影正常日志，没有重复命令/admission |
| `tests/aegis-e1-closure-judgments.mjs:121` | unknown 修正退役 Fact | 没有构造 unknown/supersedes，只删除 Task outcome 后检查 Stage 历史 Fact 存在 |
| `tests/aegis-e1-closure-judgments.mjs:140` | 同 Outcome ID 内容冲突拒绝 | 没有构造冲突，只检查正常 Task 的 success/ref |
| `tests/aegis-e1-closure-recovery.mjs:77` | E1 full replay/checkpoint | 两次 full replay，未提供 checkpoint/priorState |
| `tests/aegis-e1-closure-recovery.mjs:93` | tail-only 必须失败 | events=[]、不传 priorState，只检查没有动态计划 |
| `tests/aegis-e1-closure-recovery.mjs:101` | 产品不滤坏 JSONL | 在测试自身循环 JSON.parse 计数，没有调用产品读取/恢复入口 |

这是可检查的覆盖/expected 错位，不推断作者主观意图。
`readEventsSafe` 确实仍会过滤坏 JSON/失败返回[]；但 EventLog.open 已校验源并拒坏日志，
不能据测试空洞进一步断言正常执行一定绕过 EventLog 校验。

原 completion/history 断言未改；C-IDENTITY-01 从“submitted>=2”改为“===1”符合共享 writer 契约，
显式 fan-out fixture 迁移已由任务书授权。两者不算削弱旧负例，应与上述新测试缺口区分。

**修复方向：** 逐 case 核对触发操作、真实入口、expected、下游效果和持久前缀；
尤其不能用正常 replay、JSON.parse 或 helper 返回值替代指定故障/并发/恢复路径。
保留本轮 red 回归，补合法对照和缺失矩阵，再做有限高价值 mutation。

## 4. 独立验证记录

原始日志在 ignored 的 `Pi_Agent_base/runtime/dev/e1-contract-closure/`，
可复跑代码与本报告纳入 Git。所有 exit code 均直接捕获，不用管道尾部替代。

| 检查 | 本轮实际结果 | 证据 |
| --- | --- | --- |
| required 中 4 个 closure + completion/history | 6 scripts / 0 failed，runner exit 0 | `independent-rerun/results.json` |
| required 其余 62 | 初跑 54 pass、8 非零，runner exit 1 | `independent-rerun-rest/results.json` |
| 上述 8 个本地监听脚本沙箱外重跑 | 8 scripts / 0 failed，runner exit 0 | `independent-rerun-listeners/results.json` |
| required 最终去重核对 | 68/68 exit 0，missing=[]，failed=[] | `independent-review-summary.json` |
| 新增审查脚本最终版 | 30 tests / 1 pass / 29 fail / 0 skip，exit 1；均为目标行为断言失败 | `independent-review-final.log` |
| 正常真实 SDK/faux / Broker 对照 | 8 requests / 3 effects，数据 name=Ada/status=active，链通过 | `external-review/run-ZPvccB/normal_plan/` |
| Campaign tsc | exit 1；194 条，与 DS 起点诊断逐条相同，新增/移除均 0 | `independent-tsc-campaign.txt` |
| Batch-E tsc | exit 1；186 条，与 DS 起点诊断逐条相同，新增/移除均 0 | `independent-tsc-batch-e.txt` |
| 新审查脚本 Biome | exit 0 | 命令如下 |
| git diff --check | exit 0 | 本轮审查路径及既有工作树检查 |

8 个监听脚本初跑包含 EPERM/监听就绪失败；经必要权限复跑后全部通过，**不列为产品回归**。
类型为“基线未恶化”，不能把非零退出称为 tsc pass。
本轮未重跑 DS mutation，不将其历史 mutation 证据列作独立复验。

关键命令（仓库根目录）：

```bash
node --test Pi_Agent_base/tests/aegis-e1-contract-closure-review.mjs
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/e1-contract-closure/independent-rerun aegis-e1-closure-contract aegis-e1-closure-admission aegis-e1-closure-judgments aegis-e1-closure-recovery aegis-completion-audit aegis-e1-history-audit
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json --pretty false
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis.json --pretty false
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json Pi_Agent_base/tests/aegis-e1-contract-closure-review.mjs
git diff --check
```

其余 62 项通过 required JSON 按名称排除上列 6 项交给同一 runner；完整实际命令/日志在各 results.json。
监听重跑保留原失败证据，不覆盖其结果。最终 summary 合并三份清单并核对 required 唯一集合。

新回归层级：XR-00/01/13/14 基于真实 SDK/faux 的正常产品流；
XR-02/03/04/20–27 为真实流的变更后纯重放/Board；
XR-05/06 是隔离 Host/准入 API；XR-08–12 用真实 EventLog 或独立 reducer 检查工具接口；
XR-15/16/18/19 为纯接口；XR-17 检查真实编译产物摘要。
所有变更后事件流的序号/hash chain 均在目标断言前验证，未用 import、语法、链损坏冒充行为 red。

## 5. 修复顺序与验收决定

继续原 E1 任务，冻结架构与既有断言保持；无需另建调度、存储或证据框架。

1. **可信运行输入与执行定义**：先闭合 R01/R04/R11 的创建授权、固定副本/恢复绑定、严格规范化和最终摘要。
2. **唯一转移与 Host 短事务**：R02/R03，最新 prefix 整批编译、累计分配、一次有效计划、精确重复身份；同一序列器供工具使用。
3. **工具完整责任链与时间门**：R05/R06/R11，真实 SDK 请求绑定、settlement 等待、所有工具收费、finished/结果去重、统一重建账、持久 deadline。
4. **共同有效判定与消费者**：R07–R09/R11，accepted started/prefix evidence/effective judgments 同源，依赖与效果边界重验，补齐 RAM/Observer/supervisor/learning/status 接线。
5. **恢复与集成验收**：R10/R12，E1 完整源重放、真实故障屏障、逐矩阵行为核验、68 项回归及本轮 red→green；按风险补有限 mutation。

每个切片可提交可审查里程碑，但不把该切片绿灯改称 E1 完成。
下一轮重点核验这些已证明的断点和受影响路径；原后置性能/能力不反复扩大为门槛。
在当前阻塞闭合前，不接受自动规划/执行整体能力，也不建议用付费实验替代工程验证。
本报告是限定版本的外部实现审查，不承诺全仓零缺陷或已证明学习收益。
