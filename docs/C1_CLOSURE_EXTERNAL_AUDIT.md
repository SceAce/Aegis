# C1 Closure 独立验收记录

状态：**C1未通过外部验收，C2不启动**。本记录依据当前工作区代码与独立运行结果；不是对DS交付报告的转述。未修改产品代码或DS自审报告。

## 1. 已独立运行

- 9组Campaign测试均exit 0（204个ok测试块；不等于204个独立assert）。
- Biome：Campaign模块、C1测试和helpers检查，0 errors/0 warnings。
- Campaign tsc：exit 1，错误位于导入的fixture/contracts及runtime/events，10个；无Campaign文件错误。不声称整个tsc通过。
- 8组offline回归均exit 0。
- 4组真实Pi SDK+faux回归均exit 0，均使用source resolver。

Offline：workflow-evidence-d、workflow-engine-d、runtime-core-smoke、runtime-effective-board、memory-runtime-batch-b-smoke、memory-runtime-learning-evidence-smoke、observer-smoke、learning-bridge-e。

Pi/faux：observer-data-use-pi、observer-verify-first-pi、observer-outcome-command、observer-failclosed-pi。

本轮没有独立重跑DS的10组mutation或15次race稳定性循环；它们仍是DS报告证据，不写成外部已复核。

真实HEAD：`972acd9dd33e61e9498199ca5654f345d481e988`。Campaign文件未跟踪，但这不意味着仓库没有有效commit身份。DS环境若得到全零值，应标为“该环境返回占位值”，附原始命令结果；不能作为当前仓库实际HEAD，也不要求为了审计提交代码。

## 2. 已确认进步

- per-kind来源表拒绝agent/observer/environment伪造Oracle或completion；
- 一部分非法queue transitions与终态restart被拒绝；
- admission重新调用dynamic-policy，减少了裸admitted事件绕过准入；
- Scheduler已加入checkpoint读写调用，报告明确synthetic与real EventLog区别；
- EventLog fsync失败前Worker不执行、SIGKILL后链重开通过；
- ownership新增claim文件防止多个dead-owner reclaimer同时赢；
- Biome的4个warning已经修复。

这些实现保留，不要求推倒重写。

## 3. 阻塞发现（按跨模块责任集中收尾）

### C1EXT-01 / P0：Oracle来源表没有完成Outcome绑定

位置：`projection.mjs` 的 `campaign.oracle.result` / `campaign.task.completed`。

oracle.result仅检查task存在、outcome id和status枚举；未核对当前Episode、criterion.expected、scope、evidence、有效Outcome引用。completed依据任何历史success标记，而非指定当前有效的完整Task Outcome。

最小反例：先start当前Task，再给oracle来源的success（foreign Episode、wrong criterion、无evidence），随后runtime completed。实测状态=completed，rejected=[]。

修复依据：C1_CLOSURE_BASELINE §§3.1/3.3，CAMPAIGN_CONTRACT_BASELINE §3.5。必须复用C0接纳/聚合和可信resolver，不能在C1另造只看status的弱判断。正例要完整绑定；foreign/missing/superseded/conflicting refs不让Task完成或满足依赖。

### C1EXT-02 / P0：worker后续持久化失败仍返回ok

位置：`scheduler.mjs::dispatchOne`、`appendStopped`、`reconcileStrandedRunning`。

只有started.append返回值被检查。consumed、oracle.result、completed、unknown、reconciliation及stop的append结果都未检查。

反例：started写成功；Worker执行；之后全部append返回{ok:false}。实测run返回ok=true、reasons=[]，task仍running。不能把“副作用已可能发生、审计失败”当正常内部通过。

修复：统一durable提交边界，检查每次append；intent之后写失败进入degraded/reconciliation、停止新dispatch并返回明确故障。尽力诊断不能制造durable事件。用try/finally清理owner，注入throw/非durable/fsync失败三个分支；后续任务Worker调用数必须为0。

### C1EXT-03 / P1：checkpoint虽被读写，恢复校验/使用未实现

位置：`scheduler.mjs`读取checkpoint时只传manifest_digest/revision；`ownership.mjs::readCheckpoint`只在调用者传expected_tail时检查tail。

反例：使用writeCheckpoint生成合法payload digest但tail为FOREIGN/sequence=999的checkpoint，再调用Scheduler。实测used_checkpoint=true。

Scheduler不读取checkpoint.queue/campaign_state进行恢复，而仍全量replay，因此used_checkpoint字段也不是“用了缓存恢复”的证据。CKP-12测试直接调用readCheckpoint传tail，不测试Scheduler；CKP-15仅full replay并检查completed，没有比较checkpoint+tail。

另外projection_digest使用自写64-bit滚动hash并命名`sha256:local-*`，非SHA256；违背复用现有canonical/hash要求，且读checkpoint没有校验projection_digest与实际queue/ledger。

修复：先确定checkpoint是校验后的恢复缓存还是只输出快照。按当前契约实现真实恢复；传入真实committed stream尾/位置，检查schema/projection版本、payload和projection digest，使用现SHA256。写入时机与声明一致；坏cache重建。Checkpoint是派生缓存，不能把checkpoint提交变成授权或真值源，也不要求无必要地在每个metadata事件后重写。

### C1EXT-04 / P1：projection仍以Episode sequence重排权威日志

位置：`projection.mjs` ordered.sort。

注释声称数组append order是primary key，但实际先比较event.sequence，然后index。跨Episode sequence会重置；无Episode的sequence=null也不能当global顺序。

反例：append顺序先budget.reserved(sequence=5)，后budget.consumed(sequence=0)。实测consumed被排到前面拒绝，consumed=0，last_digest也落回早一条记录。

修复：直接按验证过的committed stream顺序reduce。需要全局位置时使用stream offset/明确global索引，不使用per-Episode sequence。Checkpoint tail是最后committed记录，不能只取最后“成功应用”事件。加跨Episode/null sequence且保持因果的测试。

### C1EXT-05 / P1：动态任务准入并未真正进入Scheduler执行

位置：`projection.mjs::applyAdmitted`、`scheduler.mjs` 的owned.find、recovery helper。

- submitted目前是no-op，没有建可解析proposal索引；admitted接受inline proposal/admission即可，没有要求先前submitted且内容一致。无submitted记录实测仍创建任务。
- admitted行丢失goal、criteria、capabilities、Oracle、stop condition等完整Task定义。
- Scheduler仅查初始ownedTasks；已admitted动态任务在projection为ready，却不在ownedTasks中，Scheduler直接break并返回ok。
- END-01 helper把动态任务预置进ownedTasks，summary.dynamic_admitted写死为1，不是动态分发证据。

修复：提交提案索引/digest/ID绑定；重验证decision；durable admitted记录完整可恢复任务定义；Scheduler从可信任务投影取动态任务；进程重启后不依赖另一个mutable初始数组。端到端测试必须真实提交/准入/分发，计数由committed事件与效果得出，移除常量summary。

### C1EXT-06 / P1：预算gate和consumption契约不一致

位置：`scheduler.mjs::isBudgetExhausted`和`projection.mjs::budget.consumed`。

Gate允许ownReservation+Campaign remaining资助dispatch，但未先把remaining预留给当前Task。Consumption又只允许不超过当前reservation。

反例：当前Task reservation=0，Campaign有余量，默认budgetAccount=1。Worker被调用，consumed事件被拒绝，最终Scheduler仍ok=true、consumed=0。

修复：要么严格在task allocation内dispatch，要么先提交授权范围内reservation，再dispatch；不能先执行后账本拒绝。每维整数/负值/超限统一验证；failed/unknown执行也需记录已耗用预算，不能因Worker失败完全漏记。C1的固定fake cost标synthetic，不能声称测量了真实wall-time/token。加余额具体数字、两个独立ready任务、失败效果已发生的测试。

### C1EXT-07 / P1：pause/cancel/stop/reconciliation状态不跨进程恢复

位置：Scheduler campaignState初始running；projection campaign.campaign.stopped为no-op。

反例：cancel后run写入stopped；用同一event stream新建Scheduler再run，Worker仍被调用。实测calls_after_restart=1、campaign_state=running。

stranded task启动恢复只写reconciliation.requested，从未调用oracle.reconcile或应用新判定；未知任务不盲重发是对的，但永久停留pending不等于完成恢复流程。结果已落盘、completion未落盘也没有从可信result补全生命周期。

修复：Campaign控制状态来自事件投影，checkpoint只缓存；恢复尊重取消/暂停和explicit resume。fake Oracle reconcile接口足以验证，不需要进入C3真实adapter。两种未决分支（效果存在/效果不存在）和delayed返回需真实读取状态并提交判定，禁止重复效果。

## 4. 测试与报告需要对应修正

- SRC正例当前是source=oracle加浅status，不是完整Outcome；补完整正例和foreign/missing字段负例。
- ADM测试必须删掉submitted仍失败，而不是只检查inline对象存在。
- CKP-12/15必须走Scheduler，真实断言“cache+tail vs full replay”，而非名称声称覆盖。
- real EventLog child当前手写append，不经过完整Scheduler。已有EventLog库验证有价值，补Scheduler+真实EventLog效果后写失败恢复集成。
- ownership wrong owner id测试不等于release race；不重复跑同一弱断言冒充竞争覆盖。还应核对同PID默认ownerId对多个Scheduler实例的所有权语义和in-flight run重入边界。
- 9套全绿保留，但204是ok块数，不能写204 assertions。mutation说明哪些真实行为被杀掉，不能用测试名覆盖未接线路径。
- WORK_PLAN仍status=in progress且任务未勾选，应与最终交付同步；HEAD修正为真实仓库身份并记录untracked源码摘要。

## 5. 本轮结论

C1已有局部修复，不是全盘失败；C0测试稳定，既有Runtime回归保持通过。但上述产品跨模块缺口阻塞C2。

下一轮以这7组责任为集中收尾单元，按测试先行/不重叠任务/主DS审查流程执行。尤其要有一条Scheduler+真实EventLog+动态任务+预算+checkpoint+cancel/restart+reconciliation的完整本地synthetic Campaign，来验证各已测试组件在一起仍成立。

状态：`C1 closure external review: changes required; C2 blocked`。
