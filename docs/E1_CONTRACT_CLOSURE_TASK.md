# E1 跨模块契约闭合任务书

版本：`E1-CC-1.0`；日期：2026-10-15；状态：**planned，产品仍 changes_required**。
本文件交给主 DS 实现产品与测试。本文、测试矩阵和 required 清单是计划，不是实现或验收证明。

## 1. 目标、依据与边界

交付一个完整的 E1 自动规划/执行闭环：可信 Host 固定输入，模型提交候选，全图整批准入，
独立规划验收与 durable ready 后执行；每个请求受正确的 Task/Campaign 限额；
执行、恢复、Board/RAM、观察和学习入口对同一输入作相同的有效性判断。
不能只修审计脚本触发的几条分支。

固定依据依次为：用户本轮要求；
`SYSTEM_ARCHITECTURE_BASELINE_AUDIT_20261015.md` 的 `SYS-20261015-01` / B01–B14；
其引用的原架构/契约；开发、测试、Git 规范。
本任务把缺失的接口定义具体化，不更改上述准则。历史 A/B/C/FC 任务作为背景，
本次按一项整体集成任务实施，不再每修一段便宣称 E1 完成。

| 固定项目 | 内容 |
| --- | --- |
| 规划起点 | 主仓库 `3e42555245b6a9eeb2f267d4e3828e85ad4099df`；产品审计起点 `4bf9513`，tree `044f4f1c126fe4aee8870f529becf5d806a09d0b` |
| 内嵌 SDK 参考 | Pi `42a3497d03ad17e308a2299fa824727894f2c0ec`；DS 开始时重新记录实际 HEAD/dirty，不修改 |
| 已知证据 | completion：3 pass / 9 fail；history：1 pass / 3 fail；这是历史实跑结果，本轮规划未复跑 |
| 冻结方法 | 保留上述 Git 对象、原规范和独立审计断言；本任务用 CC 编号映射 B 准则和测试。没有配置服务器保护/hook，不宣称文件技术上不可改 |
| 成功口径 | required 全部完成、无当前阻塞、主 DS 读完整 diff 后，最多标 `internally_verified / awaiting_external_review` |

当前必须闭合：HI01 Task 预算；HI02 一次有效计划和累计分配；HI03 有效判定消费者一致；
HI04 live/replay 同一准入规则。HI05 根目标精确绑定是同一接口的小修，一并完成，
不把它描述为已证明的跨 Campaign 越权。

不包含：Pi core、真实凭据/模型设置、既有私有 attempts、依赖/lockfile、通用 shell、
多文件/CTF、新 Worker、分布式租约、增量重规划、自动恢复缺失 ready、学习效果实验、UI 全功能重做。
允许只为当前闭合新增小型纯 helper、字段与 Aegis 调用点适配；不建立第二个调度/事件/证据框架。

## 2. 必须保持的职责

| 模块 | 负责 | 边界 |
| --- | --- | --- |
| Manifest / Host | 固定授权、模板和规则；接受命令；单写与持久化 | 模型不能提供可信上下文或调用方“已准入”证明 |
| Plan compiler / reducer | 纯校验、确定性编译、按物理提交顺序转移 | live 和 replay 共用；先验证整批，再改变任何定义/预算 |
| Scheduler | 从已接受状态选择 Task；保持单活动 Task/Episode | admission 不等于 activation；completed 标签不等于有效依赖 |
| C6 ledger / lifecycle | 每请求联合准入、逐侧责任、联合结算、恢复 | 不用分配账本或 synthetic cost 替代真实请求账本 |
| Broker / Oracle | 效果前重验授权；独立产生精确绑定的判定 | 保留 durable intent、未知效果停止、独立证据门 |
| Board / RAM / UI / learning | 消费共同的有效判定与定义 | 不从 raw admitted/started/status 自行补造权威 |

## 3. 需求编号

| 编号 | 必须交付的行为 | 原准则 |
| --- | --- | --- |
| CC01 | 新 E1 run 的可信 planning contract 随不可变 Manifest 固定、持久、可恢复 | B01/B02/B03 |
| CC02 | 唯一 ExecutableTask 预算/身份/判据适配，缺失与冲突明确拒绝 | B02/B06 |
| CC03 | 同一纯编译和转移规则服务 live/replay；候选、身份、定义、预算精确绑定 | B02/B03/B05 |
| CC04 | Host 短事务串行化；命令的 durable、accepted、activated 分开 | B03/B05/B07 |
| CC05 | E1 一次有效计划；重复幂等；后续冲突不能覆盖先前合法批次 | B05 |
| CC06 | 三维累计分配、请求/工具责任、时间门、Session/重启不重置正确限额 | B06/B07/B11 |
| CC07 | 完整独立 Oracle 与 durable completion/ready 门不被削弱 | B04/B07/B08 |
| CC08 | 共同有效判定，拒绝不进 Fact；修正/unknown/环境失效一致 | B08/B09/B10 |
| CC09 | C6 RAM、Observer、supervisor、learning、status/export 同上下文接线 | B10/B12/B14 |
| CC10 | 真实产品与新进程恢复、故障前缀、required 回归和诚实交付 | B03/B04/B11/B13/B14 |

## 4. 可信上下文：确定采用 Manifest 内嵌方案

### 4.1 创建与存储

在 `buildPlanningManifest` 创建**新 run**时，从 Host 选择的 base Manifest 与
planning config 生成 `manifest.planning_contract`。先校验，调用既有
`persistImmutableManifest(manifest, dir)` 并核对 digest，再创建执行 runtime；
持久化失败不得发第一个 provider 请求。
不新增 sidecar 权威源，不在 resume 时用当前 config 补写旧 Manifest。

该 helper 当前的 writeFile 成功不等于 fsync。E1 创建边界须确认 canonical 文件及父目录
落盘后才能宣称 durable（复用现有文件持久化 helper，或最小补齐此 helper，不另建存储层）。
首次、已存在同内容和并发同内容三个成功分支均须满足这个确认；不能复用未确认 durable 的文件。
只把 ENOENT 当不存在，权限/读取/fsync 错误原样失败；半写或不同内容的 canonical 文件不能
覆盖或删除后冒充新 run。失败残留只供诊断，恢复按下述完整副本和日志绑定规则 hold。
固定目录采用 `work_dir/manifests/` 的既有 content-address 文件名；新 run 唯一 E1 Manifest
写入后，首条 accepted started 及后续本节所列 envelope 带同一 revision/digest。
resume 由该可信日志绑定在固定目录定位原 canonical 副本，不按 mtime 选“最新文件”。
空日志的新 run 可用 Host 当前输入，已有日志却无唯一有效绑定或副本缺失则只读 hold；
禁止用当前 config 在已有日志上重新初始化。不要只从未校验的候选 payload 选择 Manifest。
builder 不得用 Math.max 自动扩大 base 的 task_count、depth/fan-out、总预算或授权；
规划所需额度/策略不足须明确拒绝创建，由 Host 在新 run 显式选择合法 Manifest。

```text
PlanningContract {
  version: "e1-planning-contract-1.0",
  planning_task_id: string,             // 当前固定为 task-plan
  planning_criterion: "plan_ready",
  root_goal_ref: "campaign-root",       // 精确字符串，归属还须绑定 Campaign/revision/digest
  plan_policy: "single_admitted_plan",
  tool_accounting: "durable-charge-v1",
  templates: TrustedTemplate[],         // 按 template_ref 排序，非 alias Map
  digest: SHA256                       // 本对象去掉 digest 后，既有 canonical digest
}
TrustedTemplate {
  template_ref, task_type, oracle_ref: string,
  required_capabilities: string[],
  success_criteria: string[],
  scope: 完整当前 scope                // 含 environment_fingerprint，不能只保存展示字段
}
```

授权 targets/capabilities、Campaign budget、静态 Task、root required criteria、dynamic policy、
adapter 身份继续取同一 Manifest，不复制成另一份可独立变化的权限。
模板能力、scope permissions、task types、Oracle 必须落在既有授权/注册表内；
空/不可用 scope 或 criteria 的执行模板拒绝启动。模板集合须能覆盖全部 root required criteria。
template_ref 唯一；task_type 别名若映射到不同模板则拒绝，不允许 Map 后写覆盖。
集合型模板数组去重排序，criteria 文本精确比较；规范化规则先于 digest，持久后不重排。
未知 contract major 拒绝执行，兼容的同 major 扩展按显式解析规则处理，未知字段不得扩大权限。

`context_digest` 指上述 planning contract digest；`manifest_digest` 指既有
`canonicalManifestDigest(完整 Manifest)`。contract 不内嵌 manifest_digest，避免自引用。
每个适用的 plan submitted/admitted/blocked/rejected/ready Host envelope 带
`binding_version: "e1-plan-binding-1.0"`、`manifest_revision`、`manifest_digest`、`context_digest`。
摘要仅证明关联与完整性，可信性仍来自固定 Host writer/Manifest 来源，不是模型自报摘要。

### 4.2 读取、恢复与兼容

产品只从已有可信 run 路径加载不可变 Manifest，不接受模型提供的路径、模板或恢复上下文。
恢复先校验日志链与基础 envelope/source，再按首条 Host started 的绑定定位副本；
加载后校验 Manifest/schema/digest，并用它重新验证该 started 的 Task/Episode。
任一步失败都不能把“用于定位的字段”当成已通过业务校验的权威。
同 Campaign/revision 的完整内容 digest 不同即拒绝执行；不能创建同名“新冻结副本”覆盖旧对象。
源文件与不可变副本不符时停止执行并诊断。run/resume 当前 planning config 的安全字段
若不同于已固定 contract，则 `planning_context_conflict`，零新请求/效果；status/export 仍可用
原可信副本只读显示，不按新 config 重释历史。展示/端口等无关配置不参与这种比较。

非 E1 静态 Campaign 保持既有合法兼容行为。旧 E1 若没有完整的可信 contract/binding，
明确 `legacy_context_unavailable`：保留事件/候选/诊断供只读查看，不准入/激活/继续执行。
本轮不迁移已运行的私有 attempts，也不从 admitted.plan_tasks 反推“可信模板”。
旧测试的合法 fixture 可经新产品 builder/Host 生成相同语义的新格式；须在报告逐处列出迁移，
保留正常行为与负例断言。独立 completion/history 审计文件的 assertions/expectations 不修改。
禁止以“兼容旧事件”为由保留缺身份或未验证定义的可执行通道。

已确认的 fixture 迁移点：`tests/helpers/c6-e1-planning-child.mjs` 正常候选有三个同父子任务，
而其 `buildDataRepairManifest` 原 base 的 max_fan_out=2；旧 planning builder 暗中扩到6才放行。
DS 必须在该**测试 Host 初始化、冻结前**显式选择 max_fan_out=4 的合法测试授权；正常场景
保留原 budget.task_count/policy.max_task_count=4。仅原 illegal_plan 的 fourth-child 场景，
显式设这两个总数上限为5，以容纳 planning+四子而实际校验 forbidden.txt 的越权；请求/工具/时间
总预算、各 Task 额度和 forbidden target 保持，不能让额外的任务总数/fan-out 错误替代原负例。
另留原上限2时三子批次 rejected 的反例，证明产品不自动放宽；该fixture变更是撤掉旧builder
隐式12/6扩容后的显式测试授权，不是允许运行中扩大Manifest，也不删除原越权反例。
其他旧 fixture 如有同类依赖，逐处记录原值、新值和原测试语义，不能泛化为扩大所有测试权限/预算。

## 5. 接口与规范化定义

以下是必须实现的语义接口；内部 helper 名可调整，公共适配由主 DS 统一维护并记录映射。
每个接口用 JSDoc/TS 定义输入、可空字段、枚举和完整返回，不用 truthy/空对象默认成功。

### 5.1 上下文与执行 Task

```text
loadPlanningAuthority({ manifest })
  -> { ok, context, templates, manifest_digest, context_digest, reasons[] }
normalizeExecutableTask({ definition, origin: static|plan|proposal, authority })
  -> { ok, task: ExecutableTask|null, reasons[] }
ExecutableTask {
  task_id, campaign_id, origin,
  plan_id: string|null, planning_task_id: string|null,
  parent_task_id: string|null, parent_stage_id: string|null,
  depends_on: string[], order: safe positive integer,
  target_ref, task_type, template_ref: string|null,
  goal, stages[], required_capabilities[], oracle_ref, scope, initial_state,
  expected_evidence[], stop_condition: string|null, priority: integer,
  rationale: string|null, source,          // 保留既有来源/候选语义，不作为写权证明
  task_budget: {wall_time_ms, model_requests, tool_calls},
  budget_reservation: 同值预算|null,      // 保留动态声明/历史展示，不能另有消费含义
  definition_version: "e1-executable-task-1.0"|既有静态版本,
  task_digest
}
```

静态 Task 的可选预算按既有 Manifest 规则逐维明确归零；0 表示该维没有额度，
不得回退到 Campaign 总额。动态 plan/proposal 三维预算必须齐全、非负 safe integer。
输入出现 task_budget 与 budget_reservation 时必须逐维相等；缺维、冲突、NaN/Infinity、
字符串、负数、小数、unsafe integer 都拒绝，不逐维拼凑。
消费者只读已接受的 ExecutableTask.task_budget，禁止再解释 raw proposal 或预算别名。
普通 dynamic proposal 路径继续使用原准入策略，接同一执行适配，不顺手关闭该能力。
原始 plan/proposal 继续要求完整 budget_reservation，task_budget 可不传、由可信编译产生；
若也传入，必须是完整相等预算。static 的 budget_reservation 缺省/null 表示无别名，不能据此
否定自身合法的 task_budget；若提供非 null 别名，也必须完整且与已解析预算一致。
返回的规范 Task 再次规范化须保持同值，不把自身的 null 兼容字段判成冲突。
parent_stage_id 若存在，必须归属已接受/同批可信 parent；计划未开放该字段时仍拒绝模型越权添加。
静态非适用字段给明确 null/[]/既有默认；动态 expected_evidence/stop_condition/priority 沿原
候选契约校验，不能为了共用 shape 删掉。其他原已识别字段须逐项记录保留/拒绝策略并纳入摘要，
不得规范化时丢失可执行语义；未知具有执行意义的字段拒绝，不能忽略后继续授权。

新的 plan 定义摘要覆盖**全部最终规范化字段**（含 order、scope、两份等值预算和身份），
只排除 task_digest；先完成编译再算摘要，明确 version。
旧 candidate `planDigest` 算法保持：version/plan_id/root_goal_ref/tasks，数组原序精确保留；
对象键序不影响摘要。不得把 candidate 摘要换成 normalized 摘要。
重编译比较完整定义的 canonical 内容与摘要，重新 hash 自报定义不能代替可信编译。

### 5.2 全图编译与转移

```text
compileCandidatePlan({ plan, authority, prefixState, planningBinding })
  -> { status: admitted|blocked|rejected, reasons[], checks[],
       candidate_digest, normalized_tasks|null, reserved_budget|null }
evaluatePlanTransition({ state, event, authority, prefixEvidence })
  -> { accepted, duplicate, next_state, reasons[] }  // 纯函数，失败不部分修改
```

`planningBinding` 必须由已接受的 planning Task started 取得实际 Campaign/Task/Episode，
不由工具参数传入；Session 不代替 Episode。submitted 与 admitted 都必须包含 planning_task_id，
envelope episode_id 必须与该 Task 的实际已接受 Episode 一致。不要为缺失值补 `task-plan`。

整批规则：

1. 校验版本、必填类型、文本/数组既有限额、safe integer 和安全加法；先验证再遍历或求和。
2. envelope Campaign/revision/Manifest/context 精确匹配；外层 plan_id、candidate.plan_id、
   admitted.plan_id 三者相等；root_goal_ref 精确匹配 fixed context。
3. prior submitted 的 digest 等于按原算法重算的 candidate digest；admitted 必须引用此前
   已接受的 submitted。同 id 的另一内容是冲突，不能覆盖/复活旧状态。
4. 使用该 prefix 已接受定义，重跑既有 parent/dependency DAG、引用、自环、双环、
   target/capability/模板/Oracle/scope、criteria subset、root 全覆盖、深度/扇出/总数约束。
   parent 默认值只在原候选契约允许时归 planning Task；parent 不自动变 depends_on。
   可引用同批次任意数组位置的节点，整图无环且实际执行按依赖排序；不可引用以后事件才
   准入的定义。同批次及此前 accepted 定义以外的引用拒绝；Stage ID 在整个 Campaign 唯一。
5. 检查本任务 §7 的累计 allocation 与一次有效计划；不能拿循环外旧 snapshot。
6. 对 admitted 携带的完整 plan_tasks、reserved_budget 与可信重编译结果逐字段比较。
   改 target、criterion、scope、Oracle、依赖、父级、预算、task id、order、增删节点、
   不明可执行字段或摘要任何一项，均整批拒绝。
7. 任一失败：允许增加有界诊断/候选历史；不得增加任何动态定义、allocation、执行许可。
   不提交合法子集。重复校验必须先比完整 identity/content，不能见同 digest 就提前成功。

纯函数不得读磁盘、当前可变 config 或 Date.now 来判断计划合法性。
实现可复用 `validatePlanGraph` 并收敛其上下文参数，不复制一套较弱 replay validator。

### 5.3 执行许可与失败结构

```text
inspectExecutionPermit({authorityState, task_id, episode_id, now, operation})
  -> {ok, prefix, deadlines, reasons[]}
operation: provider_request|tool_unit|broker_effect
Reason: {code: string, field: string|null, event_id: string|null, message: string}
```

这是已有执行门的共同纯检查适配，不是独立授权服务。Host 先取得最新权威 prefix/可信时钟，
检查 active Task/Episode、控制状态、有效前置依赖、适用 plan-ready 与时间门，再按 operation
应用已有 provider reservation、tool charge 或 Broker grant/intent 检查。
已通过的旧 prefix permit 不能缓存到未来效果边界；Broker 真正产生效果前须再取得当前状态检查。
不得为实现此接口绕过原 Broker/Oracle 或把观测 projection 当 writer。

新接口 reasons 采用上述结构；旧公共接口的字符串 reasons 可保留兼容，但附结构化 details，
适配映射写报告。失败所有输出字段显式给 null/false，不提供半成品 normalized_tasks。
最少稳定 code：planning_context_conflict、legacy_context_unavailable、invalid_task_budget、
invalid_plan_binding、plan_identity_conflict、plan_already_admitted、allocation_exceeded、
budget_exhausted、clock_regressed、dependency_invalidated、durability_unconfirmed、
duplicate_in_flight、full_replay_required；可新增更精确子码，不依赖英文消息文本分支。
结构/身份错误 rejected、合法但额度/策略不允许 blocked、持久确认不明 incomplete；
环、未知引用、重复身份、深度/扇出/任务总数硬上限均按原基线 rejected；完整合法结构请求
未授权 target/capability/Oracle 或预算不足为 blocked。多类错误并存时 rejected 优先，
reasons 保留各项独立原因；不能把硬结构限制统一报成 blocked。
执行门失败为 hold/budget_exhausted 等运行结果，不能伪造为独立Oracle failure或任务成功。

## 6. Host 命令、幂等和状态机

### 6.1 命令接口

```text
recordPlanCandidate({ plan })
admitPlan({ plan, planningTaskId })
  -> PlanCommandResult {
       command: record_candidate|admit_plan,
       ok, status: submitted|admitted|duplicate|blocked|rejected|incomplete,
       buffered, record_durable, transition_accepted, activated,
       plan_id, plan_digest, active_plan_id: string|null,
       submitted_event_id: string|null, transition_event_id: string|null,
       committed_prefix: {offset,event_id,event_digest}|null, reasons[]
     }
```

record_durable 表示**本次所需记录**已确认持久；transition_accepted 表示对应业务转移
经同一 reducer 接受；activated 仅表示 durable ready 已生效。
admit_plan 的 admitted/duplicate 的 ok=true 必须对应 accepted admission；普通 rejected/blocked 的记录
即使 durable，ok 仍为 false。tool 的 submitted 成功只承诺候选已持久且被接受，activated=false。
record_candidate 的 duplicate 对应此前 accepted submitted，不暗示 admission 成功。
重复命令没有新记录时 record_durable=true 只能引用已有的确切 durable event，不能伪造新 ID。
incomplete 或不可确认的 append 一律 ok=false；reason 精确到 submitted/admitted/ready 写边界。

工具 recordPlanCandidate 与 Host admitPlan 使用同一去重规则和 writer；tool 持久过相同候选时
Host 复用此前 submitted，不无条件再写一条。直接 Host API 若缺 submitted，可在同一短事务
内写 submitted 再继续。调用方 admission/normalized 仅可作诊断，不能授权，Host 必须自己重算；
旧接口适配不得继续相信传入的 admitted 结论。

### 6.2 串行性与候选选择

在现有 Host ownership 内，把“读最新权威 prefix → 决定 → append/fsync → replay 确认接受”
作为短临界区；所有改变计划、定义、分配、ready 的 Host 命令用同一序列器。
单写 EventLog 只串行 append，不自动保护读后决策；仅 run.singleflight 也不足。
临界区不跨越 provider/Oracle/Worker 的长等待；嵌套 Host 回调复用内部执行上下文，
不二次获取已持有锁造成死锁，不允许模型传入绕锁 token。

按已持久候选的物理 offset 处理；buffer 的次序不能覆盖 durable 次序。
第一个合法整批 admission 固定 active_plan_id；它不是“第一条提交”。
拒绝候选后允许同次 planning 的另一个不同 id 合法候选；同 id 改内容始终冲突。
已有 accepted plan 后：相同 id+candidate+完整编译定义+绑定为 duplicate；
不同 id 或任意不同内容为 rejected(`plan_already_admitted`/`plan_identity_conflict`)。
后者保留诊断，不把原计划改 rejected/blocked，不覆盖 active_plan_id、预算或 ready 状态。
完全重复须与原 admission 前缀的可信编译结果比对，并核对当前已接受定义仍等于原批次；
可重放该前缀或显式排除自身批次后重编译，不能让自身 Task ID/已扣 allocation 导致假冲突，
也不能再加一次预算。当前依赖/时间/ready 是否允许执行仍另查，duplicate 不产生新执行许可。
同 ID 的冲突提交不污染原绑定：若 A 已合法准入，A→冲突 A'→原 A 的最后一次是 duplicate，
原 A 始终有效；若原 A 未准入，A' 不能替换其候选内容，用不同 ID 提交合法候选。
Scheduler 最终使用 active_plan_id，不使用循环最后一次命令结果。
但是任何 provider error/aborted、持久化故障或未结清请求仍独立阻断激活，不能被合法候选掩盖。

### 6.3 批次生命周期与恢复前缀

| 已提交/已接受事实 | 动态定义 | 新子 Task 可执行？ | 恢复要求 |
| --- | --- | --- | --- |
| 只有 buffer 或 submitted | 无 | 否 | 保留候选；不补造 admission |
| admission event 写失败/完整事件被 reducer 拒绝 | 无 | 否 | incomplete/rejected 可见；零子请求/效果 |
| admission accepted | 整批 queued，awaiting_plan_ready=true | 否 | 不能从“有定义”推导 ready |
| 请求逐侧 consumed，但联合未结清 | 保持 queued | 否 | 保留已确认消费和未决责任 |
| settlement 正常，但 termination unknown/error/aborted | 保持 queued | 否 | 不执行 buffered decision |
| termination 正常+联合结清+独立完整规划 Outcome+Task completed durable | 保持 queued | 否 | 缺 ready 仍 hold，本轮不自动补写 |
| 同一 batch 的合法 ready durable 且被接受 | 该批次按依赖变 ready | 是 | 有效 ready prefix 新进程可继续，消费不重置 |
| 任何 gate/source/identity/证据不匹配 | 不产生相应转移 | 否 | 重放拒绝，其他视图不能重新授权 |

ready 继续由现有独立 Oracle/Host 门写，引用确切 planning Outcome、plan id/digest/绑定；
保留 accepted A 的所有请求、SDK tool-result 持久化与 Host ready 写故障规则。
不得把“pending=0”“最后一条 admitted”“source=runtime”“Task completed”单独作为 ready 证明。

## 7. 预算：单位、账本和边界

### 7.1 三种账目分开

| 账目 | 定义 / 唯一来源 | 不允许的混用 |
| --- | --- | --- |
| allocation_total[d] | 所有静态 Task 明确预算 + 历次有效动态定义的预算；本轮 E1 不循环再分配 | 不是 reserved，也不加一次实际 consumed；完成/取消/释放不删历史分配 |
| scheduler reservation ledger | 既有 Task reservation→synthetic consumed/released 转移，保留旧兼容接口 | synthetic dispatch cost 不算实际模型请求，不作为真实预算测量 |
| request/tool responsibility | C6 请求 reducer 与实际工具门；按 Task/Campaign 各侧重建 consumed、pending、unresolved | allocation 或 Task 完成不能结清一个未决 provider 请求 |

每维 d∈wall_time_ms/model_requests/tool_calls：
`allocation_after = allocation_total + candidate_sum <= manifest.budget[d]`，
逐步安全加法；不能只验每个 Task，也不能拿只剩 reserved 的值验下一批。
E1 暂不授权 reallocation；cancel 释放 outstanding，不给新计划复用 allocation。
普通动态 proposal 保持既有策略，同时不得绕过该累计 envelope；不在本轮实现新的再分配功能。

数值基准：Campaign requests=100、planning allocation=8、三子任务各20，
第一次 admission 后 allocation=68；即使 planning 只实际请求2次，仍是68，不能算62或70。
第二个同样批次不准入；同计划重送仍68，不能变128。
Campaign=20、planning=8 时，子总额12可准入，13为 blocked，释放 planning reservation 后仍如此。

### 7.2 实际请求和工具

每次真实 provider 请求（包括 SDK tool loop continuation/轮换 continuation）在 dispatch 前，
Task 与 Campaign 各自满足 `consumed + outstanding + 1 <= limit`。
两侧通过且 request reservation 已 durable 才允许调用；一侧拒绝时只取消**尚未发出**的内存预留。
发出后 commit/reconciliation 继续服从现有三事实 reducer，不丢失部分消费、不拿新 request_id 重发。
Task=1 的正常两请求工具循环只能发第1请求，不能执行第2请求后的 buffered 写入；
审计 HA-02 必须保持 broker_effects=0，不能以“第一请求已经产生决策”绕过。

所有 C6 可达工具的预算接线列出清单（decision/read/submit 及 SDK 实际允许工具），
在读取、写入候选或 buffer 前受 Task 与 Campaign tool_calls 上限，缺 active Task/ledger
不能默认 ok。Broker effect 计数不是 tool_calls 计数。单位保留既有 decision 中每个
Broker action 消费1的语义：read、submit_plan 及其他允许 SDK 工具每次1；
decision 有 N 个 action 时逐 action 各1，不再重复收 wrapper 费；无 action 的 decision 收1。
一个 wrapper 多 action 可逐个拒绝超额项，保持既有行为；这不授权 plan 整批部分准入。
decision 中 propose_task 等共享载荷不得绕过收费：无 action 时归 call 单位；有 action 时
完整共享载荷纳入每个 action 单位的参数摘要，至少一个单位成功 charge 后才可 buffer 一次。
全部单位被拒绝时，actions 与 proposal 都不得入 buffer；原索引不能因过滤拒绝项而重编号。
报告同时标 `sdk_tool_invocations` 与 `tool_budget_units`，不把两个不同单位混为实测调用数。
工具返回错误但已获准调用仍收该额度；参数/schema 提前拒绝且未入工具体可不收。

确定采用既有 C6 ledger/committed EventLog 内的原子双侧 charge，不复用 provider 的
committed 作为工具收费时点，不另建持久账本：

```text
chargeTool({request_id, tool_call_id, unit_id, tool_name, arguments_digest, taskBinding})
  -> Promise<{ok, duplicate, charged, record_durable, event_id: string|null, reasons[] }>
runtime.note payload {
  kind: "c6.tool", version: "e1-tool-charge-1.0", phase: "charged"|"finished",
  campaign_id, task_id, request_id, tool_call_id, unit_id, tool_name, arguments_digest,
  manifest_revision, manifest_digest, context_digest,
  units: 1, charge_event_id: null|event_id
}
```

tool_call_id 用实际 SDK 调用 ID；request_id 绑定实际产生本次 tool call 的 provider 请求，
不能用下一 continuation 的 ID；unit_id 为该调用下的 `action:<原索引>` 或 `call`。
去重键为 Campaign/Task/Episode/request_id/tool_call_id/unit_id；相同 SDK ID 出现在不同
provider 请求时不是同一次收费。arguments_digest 覆盖经schema校验的本单位完整参数，
decision 单位含 action_ref/arguments/criterion_id；日志不复制原始敏感参数。
Host 绑定实际 accepted Task/Episode，不信模型自报；request 必须属于该绑定且确实已发出。
source 为已绑定 runtime writer，envelope 继续使用 schema1.1/runtime.note，不新增顶层事件类型。
两侧最新余额/时间/前置事实都过门后，使用 §6 同一 Host 序列器短事务
append/fsync 一条 charged，重放同时各扣1，
确认后才允许对应工具体/动作入 buffer；失败无工具执行，不能只改内存一侧后继续。
finished 仅标本次工具体已返回（错误也可返回），引用同身份 charge；不代表 Oracle 成功或
Broker 效果完成，不退费。crash 在 charge 后、工具开始前也可能收费，因此数值标为
durable charged units，不能谎称每单位都实测执行。中断未 finished 的 charge 不自动重放工具，
保守 hold 并保留收费；未完成收费或 finished 持久化故障也阻断后续效果/continuation/ready，
不能只看 provider 已结清。本轮不新增自动工具 reconciliation。
同去重键同绑定/同工具/同参数摘要/同单位为去重收费；工具执行去重另须已完成结果可复用，
无可用结果时 duplicate_in_flight/unknown，不能因为“不再收费”就重复执行。
finished 本身不是持久工具结果：live 去重只能复用本次进程持有的同绑定结果；重启后若要
重新接收同一去重键的 execute，却没有可验证的原 SDK tool-result committed 引用及内容摘要，
则对这次重复 hold，不重读/重交计划/重放动作。
可在 finished 增加可空 result_ref/result_digest；只接受既有可信存储，摘要缺内容不能复用。
这是重复执行的结果复用门，不要求给所有历史 finished 补结果 cache：正常 ready-prefix 恢复
无需重执行 planning 工具，继续按原 durable ready/责任门执行新子 Task；不能因此把正常6/3对照
也冻结。未 finished、finished 写失败或 SDK writer 故障仍是阻断后续执行的独立事实。
不同 unit_id 是新调用，仍逐次过门。冲突、foreign source/binding、无此前 charge 的 finished
不改变账目。live/rebuild/status 使用同一 reducer。

真实 SDK 接线固定如下：provider gate 生成 request_id；对应真实 assistant message_end
到达时，在清除 outstanding 前将该 message 的 toolCall ID/name/原参数与此 request 绑定，
保留到该批工具结束。合成 error 或无实际请求的 message 不能建此表；工具不能读取已清空的
outstanding 或“下一个 request”猜身份。工具 execute 使用 SDK 传入的真实 toolCallId 查询绑定，
在 SDK/schema 校验后对实际完整参数生成单位摘要；同 message 的重复 toolCall ID 在任何工具
入体前拒绝整批，不允许 Map 后写覆盖；不同 request 的同名 ID 仍是不同调用。
先 await 对应 pendingCommit 成功，再进入短 charge 事务；不得持 Host 锁等待该 commit。
本轮 E1 工具使用实际 SDK 支持的 executionMode:"sequential"，按 assistant 原工具数组顺序执行，
避免并发不同候选争用同一计划名额；Host 仍须防护独立 API 并发。不能假定 subscribe 的异步
回调被 SDK await，必须在工具 execute/下一 dispatch/最终 flush 三处显式等待必要持久化。
新 E1 工具缺绑定或该请求 provider/settlement 不合法，一律拒绝入体；finished/SDK tool-result
持久化未确认时不发下一请求、不把 buffered 内容交 Broker。SDK writer 故障仍按原 C6/A 门处理。
Router 的 direct 复用没有 SDK tool invocation，不伪造 request_id/工具费；其真实动作继续经过
当前依赖/时间/Broker grant/intent 门，单独报告 Broker effects，不能借此把模型工具伪装成 direct。

新 E1 contract 固定 tool_accounting，全部 request 记录带同值；旧 tool_calls 聚合字段
可保留作诊断但不再入收费账；不能与 c6.tool 双计。旧非 E1 流保持原计费解释，按 run 的
固定协议选择，禁止逐事件切换来漏扣。新 E1 中混入 legacy 收费记录则诊断并 hold。
createToolLedger 可增异步 Host 适配；等待 charge/fsync 不能塞进当前同步回调后不 await。
此项是当前预算接线所需补齐，不改原 provider 三事实、Broker durable intent 或激活门。

### 7.3 wall_time_ms

该维既是静态/动态分配的毫秒上限，也是实际新请求/工具的时间准入门；不是累计所有请求
duration 相加，不承诺超时瞬间取消已在途请求/效果。
产品 Campaign 时间从第一条**accepted task.started** 的可信 recorded_at 起算，
每 Task 从其第一条 accepted started 起算；排队不计 Task 时间，暂停/Session 轮换/进程退出
不重置已启动对象的 deadline。所有新请求/工具要求 now<Campaign deadline 且 now<Task deadline。
启动事件与有效时间锚缺失/非法时不准 dispatch，不拿当前时间补造历史。
同进程用单调 elapsed 避免系统时钟回拨放宽；跨进程用持久时间锚计算，
now 早于最近可信时间/锚时诊断 `clock_regressed` 并 hold。只承诺正常 Host 时钟前提，
不声称抵抗恶意修改系统时间。测试使用注入时钟验证 deadline-1/deadline/deadline+1。
既有 c6.request.payload.wall_time_ms 是时间戳，不能直接当耗时累计。
时间锚与 deadline 计算亦须安全整数/安全加法；溢出或无法转换为既有时间格式时 hold，
不 wrap、不 clamp 成更长可用时间。测试时钟从 Host 注入，不由候选或事件自报 now 决定。

### 7.4 显示与失败

报告明确 allocation、scheduler synthetic cost、actual requests/tools、pending/unresolved
与 elapsed/deadline 的各自含义；保留既有字段并加明确标签，不把历史 synthetic 数值重命名为 measured。
成本/token/backend usage 未测得仍 unknown。0 不是 unlimited。
预算解析无效为 rejected；结构合法但当前额度不足为 blocked；达到实际门则 budget_exhausted，
保留已发生消费和候选；仅该 Task 耗尽不伪称 Campaign 全额耗尽。

## 8. 统一有效判定与消费者接线

### 8.1 共享输出接口

在现有 Campaign projection/resolver 上提供同一纯语义输出，禁止新增弱 resolver。

```text
projectQueueFromEvents({manifest, campaign_id, tasks, events, artifacts, revision, ...})
  -> 原字段 + authority {
       manifest_digest, context_digest|null, physical_tail,
       accepted_definitions[], accepted_starts[],
       accepted_outcomes[], effective_judgments[], rejections[]
     }
AcceptedOutcome {
  event_id, offset, outcome_id,
  campaign_id, task_id, episode_id, stage_id|null,
  criterion, scope, subject, status: success|failure|unknown|invalid,
  source, evidence_refs[], supersedes|null,
  effective, ineffective_reason|null
}
projectBoard(events, {manifest}) -> 原 Board shape + 同源拒绝诊断
```

1. 每条 Outcome 在**当时 prefix**上，用已有 resolveStageOutcome/resolveTaskOutcome
   验 Task、实际 accepted Episode、Stage/criterion、subject、scope、外内来源与可解析证据。
   rejected admission/start 不能建立身份。未来定义、未来 started、未来 evidence 不追认旧事件。
2. 原 `artifactIndexFromEvents` 若为共同依赖，从 c3-entry 提取到纯 artifact-index helper 并保留
   re-export；不能让 Board→Campaign projection→c3-entry→Board 形成循环。
   事件产生的 artifact 按物理 prefix 逐条加入，带 origin_event_id/offset 和 digest；
   同 ref 后续改 digest 不覆盖旧时点证据。既有 trusted file/registry fixture 可明确注入其
   可信索引，报告来源；不得把模型 refs 或任意未来全量索引当该时点可信证据。
3. accepted_outcomes 包括合法 unknown；不因 unknown 缺 success evidence 就整条扔掉。
   绑定错误与合法 invalid 判定区分。失败无权修改先前 accepted definitions/预算。
4. supersedes 必须指此前已接受、同 Campaign/Task/Episode/Stage/criterion/subject/scope
   的判断。缺失、foreign、forward、自环/环、LLM 修正保留诊断，不退役旧 Fact。
   合法 unknown 修正退役原有效 Fact，但不生成新 Fact、不增加独立证据数。
5. effective judgments、Fact、历史各保留。success 且 observed 满足 criterion 才能 Fact；
   普通 failure 是失败判断，不自动 Refuted；Refuted 仍需原规范规定的具体证伪对象。
   trusted environment.changed 仅使适用范围的事实失效，不改原记录，不借此重发动作。
6. 从同一 effective set 计算 required Stage/Task 判据及依赖；一项 required 缺失/unknown
   不能成功。无合法 supersedes 的不同内容冲突不能按最后写入任意选 success，保守 unknown/invalid 并诊断。
   相同 outcome_id 同内容幂等；同 id 不同内容拒绝且不覆盖。
7. 历史 completed 事件保留；新增 `effective_status`/`dependency_satisfied` 区分过去完成与
   当前判定。合法修正/环境失效后，未启动依赖不再 ready；已完成子任务历史不抹去、不自动重跑，
   副作用不可撤回。若失效涉及当前活动 Task 的前置事实，在后续请求/效果边界保守停止并诊断。
   不能只删 Board Fact，却让新的依赖执行继续认为已满足。

Campaign Board 从上述 accepted/effective 输出适配节点和修正关系，去掉 raw admitted/started
建索引及 weaker success 判定。公共 `projectBoard(events,{manifest})` 自己按同一事件流得到
Campaign authority；内部可复用同次计算，不能接受未核对输入绑定的任意外部 accepted map。
若抽取已有有效性 helper，放无 I/O 的中立模块，Campaign 与 Board 共用，不互相递归投影。
没有 Manifest 的通用 Board 对普通非 Campaign outcome 保持原语义；遇到 Campaign judgment
缺上下文仅给 Artifact/diagnostic，绝不 fallback 成 verified Fact。

### 8.2 必查调用点清单

| 路径 | 处理要求 |
| --- | --- |
| c6-entry RAM provider / buildE1View / task graph | 同一 Manifest 与 accepted definitions；状态标签不再 scan raw admitted 决定 |
| c6-entry learning bridge / c6-learning | 显式带 Manifest/context；不再 projectBoard(events) 丢上下文 |
| runtime/learning-bridge buildProductionResolver | Campaign 分支使用同源 Board；保留独立 evidence/provenance/replay/Compiler 门 |
| extensions/aegis-observer.ts 的 rebuild/verify | 初始化与请求时重建都传 Host 固定上下文；缺上下文只读降级，不静默信 raw campaign outcome |
| runtime/session-supervisor / handoff | 同源 Board/effective judgment，轮换不产生新 Episode 证据 |
| c6-entry readonly export/status/measure、report-entry、observation-view/server | 同一投影；拒绝原因有界可见，显示不授予权限 |

主 DS 用 rg 形成实际调用点表（入口→参数→输出→测试），包含所有 projectBoard/Outcome 消费者，
注明非 Campaign 分支为何可保留。不能只改传 manifest 的两处便认定全接线。
本轮证明“被拒 Outcome 不供 RAM/当前依赖/证据选择使用”；不凭该证明声称已复现或修复
所有错误 Experience active 晋升，更不把工程一致性当学习收益实证。

## 9. checkpoint、故障与恢复决定

本轮 **E1 一律从完整 committed 源重放**。检测 planning_contract、plan kinds 或 model_plan
定义时，不以 priorState/checkpoint 的 plans/ready/definition 字段恢复权威；used_checkpoint=false，
原因 `e1_full_replay_required`。缓存可保留用于诊断，不能在读取失败时改成可执行默认值。
不在本轮补 F16 加速。普通静态路径原安全 checkpoint 行为保持。
若调用者只提供 tail+不完整 priorState，没有完整源，则返回 `full_replay_required` 且不 dispatch，
不得假装已经 full replay。删除/篡改 checkpoint/report/store 后结论仍由原 Manifest+EventLog 重建。

链校验/JSONL 解析失败禁止继续执行；不把坏行滤掉后当正常 committed prefix。
可观察已验证 prefix 与诊断，但不伪称整个流完整。append/fsync 失败仍按现有 EventLog unhealthy
行为停止后续效果；不自行截断、修链、重写 rejected 记录或释放未知责任。
恢复与活运行应用相同接受规则，按**物理行序**，不是 per-Episode sequence 排序。
SIGTERM 仍为 Task-boundary drain，不能宣传为立即取消；SIGKILL 测试要真实子进程与 barrier/IPC。

## 10. 实施任务图、文件归属和阶段出口

主 DS 是集成责任人。默认串行；有真实子 Agent 能力时可分配互不相交文件的测试工作，
共享文件由主 DS 管理。不创建调度平台，不用虚构“独立审查”代替自己读 diff。

| 切片 | 输入/依赖 | 实现范围（相对 Pi_Agent_base） | 阶段出口 |
| --- | --- | --- | --- |
| S0 冻结与 red | 本任务、基线、当前 Git | tests 新脚本/fixtures、docs 结果记录；不先修产品 | 保存旧 CA/HA 行为失败、正常对照、类型基线；确认 matrix expected |
| S1 可信执行契约 | S0 | manifest.mjs、e1-planning.mjs、e1-plan-contract.mjs、campaign-config.mjs、e1-max-pilot 新 run 构建、必要纯 helper | CC01/02/03 纯接口、Manifest 不变性、旧兼容边界与 unsafe 输入测试 |
| S2 准入/预算/恢复 | S1 | projection.mjs、scheduler.mjs、host.mjs、c3-entry.mjs、c6-entry.mjs、c6-model-worker.mjs、c6-tool-ledger.mjs；event-contract/dynamic-policy 适配 | CA06–12、HA02–04、请求/工具门、一次有效计划、故障前缀通过 |
| S3 有效判定接线 | S1/S2 authority shape | outcome-resolver/aggregate、runtime/board、必要中立 helper、c6-learning、runtime learning/supervisor、extensions/aegis-observer.ts、E1/readonly/report 调用点 | CA02–05、修正/unknown/依赖、RAM/learning/Observer/无 Manifest 降级一致 |
| S4 集成与交付 | S1–S3 | tests/共享 helper/类型 include/docs 状态与报告 | required+静态检查+真实子进程+有限 mutation；逐项 traceability、完整 diff 自审 |

各阶段可提交 reviewable milestone；阶段绿只说明该切片，最终出口仍是整个 E1 集成门。
共享 `projection/e1-planning/c6-entry/board` 不并行覆盖。其余文件如必须改，先在报告说明
具体调用链、CC 编号与测试；实现选择可自主作出，不把例行 helper 命名交回用户决策。
如需改架构准则、权限、SDK core、真实实验或原独立 expected，记录差异与阻塞，不能偷改过关。

## 11. 测试执行与所需证据

详细 case 在 `E1_CONTRACT_CLOSURE_TEST_MATRIX.md`；required 在
`E1_CONTRACT_CLOSURE_REQUIRED_CHECKS.json`。旧清单四组59脚本 + FC/B/C 3脚本 +
独立审计2脚本 + 本任务4脚本，共 **68 个唯一脚本**；脚本数不是 case 数。
新脚本命名固定为 contract、admission、judgments、recovery 四个 `aegis-e1-closure-*`。
不使用全目录 glob；matrix 子例是冻结要求，脚本组织不等于允许遗漏。

在仓库根执行；DS 必须换一个新的 ignored evidence 目录，不能覆盖历史日志：

```bash
node --input-type=module <<'NODE'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const manifest = JSON.parse(readFileSync('docs/E1_CONTRACT_CLOSURE_REQUIRED_CHECKS.json', 'utf8'));
const root = 'Pi_Agent_base/runtime/dev/e1-contract-closure';
mkdirSync(root, { recursive: true });
const out = mkdtempSync(`${root}/run-`);
const summary = [];
for (const [group, names] of Object.entries(manifest.groups)) {
  const result = spawnSync(process.execPath, [
    'Pi_Agent_base/tests/helpers/c6-suite-runner.mjs', `${out}/${group}`, ...names,
  ], { stdio: 'inherit' });
  summary.push({ group, exit: result.status, signal: result.signal, error: result.error?.message ?? null });
}
writeFileSync(`${out}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(out);
process.exitCode = summary.some(row => row.exit !== 0) ? 1 : 0;
NODE
```

S0 只运行旧审计与有关基线；新接口 import 失败不算充分 red，必须有旧实现上实际行为失败。
新接口出现后用少量有限 mutation 验证边界断言会捕获错实现。
产品正例真实 SDK+faux、真实 EventLog/Broker/文件/Oracle；负例可对正例流单点变更并重新校验链，
但不手造正 Oracle 作为产品成功证明。子进程恢复要有正常 ready 对照。

静态检查使用本地已有工具，不自动下载依赖：

```text
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json <逐个修改的代码/测试路径>
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json --pretty false
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis.json --pretty false
git diff --check
```

新纯 helper 加入适当 type include，检查所有改动文件的覆盖；不关闭检查或用 any/ignore 隐藏新增问题。
开始/结束逐条比较诊断身份/位置/内容，解释本次变动，不能只比数量。
历史 Campaign 194（Campaign 模块0）/Batch-E186、exit1 是参考，DS 应保存本次实际基线；
要求本次新增/修改路径无新增类型诊断、既有诊断不恶化，不能把历史 exit1 写 pass。
依赖缺失为 blocked，保留错误与可继续做的工作，不付费/联网实验代替离线工程验收。

## 12. 开发、自审、交付规范

1. 开始记录 status/branch/HEAD、Pi HEAD/dirty；按 AGENTS.md 入口读取适用规范与实际 SDK 签名。
   不清理用户改动，不改 private config/attempts/Pi core，不升级依赖。
2. 先确认矩阵、实现测试，再写产品；expected 来源是 CC/B 契约，不能调用被测编译器生成预期答案。
3. 公共接口显式类型；纯函数不改输入；失败整批不部分 mutate；I/O 放边界；复用现有 hash/schema。
   不写“错误则 catch 后假成功”的降级；显示降级有诊断，执行门失败则保守停止。
4. 主 DS 最后逐个阅读全部最终 diff、新文件全文、预算/身份/Outcome 真实调用点和测试改动；
   对 rejection→Board→RAM、duplicate→allocation、ready→restart、correction→dependency 四条链专门自审。
5. 新建 `docs/E1_CONTRACT_CLOSURE_IMPLEMENTATION_REPORT.md`，按矩阵回填实际结果/证据；
   至少含接口落点表、调用点表、fixture 迁移、red→green、argv/exit/log、类型差异、限制和问题责任人。
6. 同步 README/当前阶段入口/AGENTS 最新状态摘要，不改写原架构或旧审计历史；链接本轮报告，
   仍注明 pending external review。不要把最旧文档的局部通过恢复为全项目完成。
7. 在任务分支逐路径 stage，读 cached stat/diff/check，按 Git 规范提交，正文注明 DS/Agent 协助范围；
   不 push、不重写历史。交付 branch/commit/status、测试证据与未解决事项。

当前阻塞未清、required 未跑/失败、没有产品正例、恢复仅为同进程模拟、有效性消费者未接全，
均不得标 internally_verified。同模型测试/自审不叫 external acceptance。

## 13. 已知限制、依赖与后续计划

| 项目/依赖 | 本轮处理 | 责任阶段 / 重新评估条件 |
| --- | --- | --- |
| 本地 Node、嵌入 Pi/source resolver、现有依赖 | DS 记录版本与可用性；零真实 provider/目标调用 | 环境缺失如实 blocked；不得冒充工程通过 |
| 可信 Host、本地不可变 run 包/日志 | 继续既有单机信任前提；不防恶意本机进程伪写完整可信源 | 更换导入/多租户信任边界时单独设计认证 |
| checkpoint 计划字段不完整 | E1 明确 full replay，测试删除/篡改不授权 | F16 优化时再冻结完整 cache schema/真实 hit 测试 |
| completed 但无 ready | hold，保留原事件与已消费账 | 后续单独设计有授权的 gate reconciliation；本轮不自动补写 |
| SIGTERM Task-boundary drain | 保留并标真实语义 | 需要即时取消时另设 active-request/effect cancellation 契约 |
| Observer / learning 接线 | 作为当前同源消费边界验证；未证明所有 Experience 晋升错误已发生 | 若证明拒绝结果可达 active shortcut，则按当前阻塞处理并复现 |
| UI 无轮询/暂停过滤/分页/截断继续读取 | 记录为非阻塞交互欠项，拒绝诊断需在现有有界视图可见 | 观察交互阶段，不因交互偏好拖延本轮闭合 |
| 其他 adapter/checkpoint 异常未全面证明 | 测本轮修改可达边界，报告不宣称全仓安全认证 | 新 adapter/恢复方式上线前重新核对 |
| 历史状态文档不同步 | S4 更新当前入口和引用，不覆盖旧证据 | 后续阶段持续按最新 commit/报告判定 |
| 全仓类型债、增量重规划、多 Worker、多文件/CTF | 明确 deferred；不为清零而扩大当前范围 | 各自能力阶段需独立契约、工具/Oracle 及验收 |
| E2/E3 学习收益/迁移 | 工程闭合不证明效果，不启动实验 | 外部限定复验后，用户操作有界 E1 pilot，再安排有对照 E2 |

后续顺序：DS 完成 S0–S4 → 有限外部集成复验 → 用户自行执行一个明确 scope/budget/Oracle 的
真实 E1 规划任务 → 依据真实失败/收益安排 E2/E3 或工具适配。
后置项只有出现破坏当前准则的可达证据才重开本轮门槛；新发现记具体输入、B/CC、效果和测试，
不能隐藏，也不能仅凭想象无限扩张任务。
