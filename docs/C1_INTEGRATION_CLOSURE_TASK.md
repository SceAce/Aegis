# C1 跨模块收尾任务与契约

状态：**当前主 DS 实现任务；C1 changes required；C2 blocked**。

## 1. 任务来源与本轮范围

用户采用一次总委派，由主 DS 分解小任务或分发给子 DS，先共同生成测试，再实现，最后主 DS审查。继续使用常见Agent工程规范：`AGENTS.md`入口、契约先行、测试先行、小步变更、明确文件所有权、静态检查、差异审查、可复现交付。无需更换框架或重新建设Agent调度工具。

必读：

- `C1_CLOSURE_EXTERNAL_AUDIT.md`：最新独立复现，七组C1EXT问题。
- `C1_INTEGRATION_TEST_SPEC.md`：本轮共同测试输入、期望和脚本要求。
- `AGENT_DEVELOPMENT_STANDARD.md`、`AGENT_TESTING_STANDARD.md`、`DS_ORCHESTRATION_WORKFLOW.md`：开发/测试/分工规范。
- `CAMPAIGN_CONTRACT_BASELINE.md`、`CAMPAIGN_ARCHITECTURE.md`、`ARCHITECTURE_DECISIONS.md`：已确认架构。
- `MEMORY_SCHEMA.md`、`MEMORY_SCHEMA_NOTES.md`：数据与信任边界。
- `C1_CLOSURE_BASELINE.md`：上一轮契约；与本轮更明确的恢复和输入契约一起使用。
- `../Pi_Agent_base/AGENTS.md`和内嵌`pi/AGENTS.md`：工作区/SDK规则。

保留已通过的C0和C1局部修复。只补齐C1产品调用链，不推倒重写，不重建第二套Scheduler/Resolver/Hash实现。

允许修改Campaign模块、相关tests/helpers、Campaign类型配置、计划和审查文档。必要的旧库接入由主DS分析真实签名、调用影响和回归后处理；不能降低其证据门。不得改Pi核心、auth/models/settings、lockfile，不恢复删除的旧Python/根AGENTS，不提交Git，不调用真实模型/目标网络。

本轮不实现C2/C3/C4/C4a。可以使用真实Node子进程、真实EventLog、临时文件效果与synthetic Worker/Oracle验证C1。Synthetic Oracle是显式测试依赖，不以此宣称真实CTF Oracle已实现。

## 2. 开发协议

### 编码前

主DS完整读当前C1模块与测试，记录当前文件摘要、真实HEAD、Node和检查基线。Untracked文件不能靠`git diff`判断修改；保存私有内容快照/摘要用于最终diff，不能以缺commit为由提交代码。

先创建：

```text
docs/C1_INTEGRATION_WORK_PLAN.md
docs/C1_INTEGRATION_TEST_MATRIX.md
```

计划含任务图、allowed files、owner、输入/输出、拒绝语义、共享接口、case IDs、停止条件。矩阵含：需求->用例->脚本->入口->证据->red/green实际结果。

优先冻结六个跨模块接口：

1. verified committed stream（顺序、物理tail、stream offset、健康状态）；
2. proposal索引与完整Task定义；
3. Outcome resolver及Task/Episode/criterion/scope绑定；
4. consumed/reserved账本与dispatch许可；
5. Campaign控制状态与reconciliation结果；
6. checkpoint snapshot + replay tail。

接口尽量复用已有实现。没有字段语义时先写接口例子与测试，不让各子DS自己猜。

### 测试、实现、审查

- 主DS/测试子DS按TEST_SPEC共同生成脚本和独立expected；在当前代码上先跑red，保存失败原因。
- 正例要真正完整；负例只改变待测字段。不能从被测聚合器输出构造expected。
- 子DS实现只改指定文件；改变共享契约/fixtures/export由主DS集成。
- 聚焦test通过后主DS阅读最终代码与调用者，再合并；同文件依赖任务串行。
- 没有子Agent工具就串行分角色执行，如实报告，不能虚构子报告。
- 单位测试、函数调用计数和字符串不能替代真实Scheduler入口效果。最终必须有完整本地Campaign测试。
- 主DS先审冻结测试的expected，再审实现，最后在集成结果上加组合反例与有限mutation。

## 3. 七组修复契约

### INT-ORDER：权威顺序与全局位置（C1EXT-04）

EventLog验证过的append顺序是唯一reduce顺序，不按per-Episode sequence或UUID排序。Episode sequence可重置/null，不是Campaign全局索引。

明确区分：

- stream offset：在该日志内的稳定位置，用于checkpoint和tail replay；
- event.sequence：Episode局部序号；
- last committed tail：物理日志末尾，包含被投影拒绝的已提交记录；
- last applied event：最后成功改变投影的记录，仅诊断用途。

哈希链坏或未知major按现EventLog拒绝，不能跳过后继续副作用。合法链中已提交但不合法的command保留拒绝诊断，其存在不能让checkpoint tail倒退。

Projection初始化、增量reduce与全量replay用同一状态机，必须保存dedup/索引/预算/控制状态，不能只有queue列表便声称完整恢复。

### INT-OUTCOME：完整可信判断与依赖（C1EXT-01）

来源权限表是必要条件，不是完整判定。`campaign.oracle.result`必须引用当前stream中可解析的`outcome.recorded`或等价已明确登记的可信Outcome记录。复用C0接纳/聚合与现有resolver，禁止第二套只看`status`的成功逻辑。

核对Campaign、Task、当前Episode、level、criterion ID/expected、相关scope、Oracle身份、observed和evidence；源身份由Host固定，模型payload无法自报取得权限。

`task.completed.outcome_id`必须指向当前有效的匹配Task结果，同时全部required stages/criteria通过。不能查询“历史上有过success”作为完成许可。拒绝foreign、缺字段、假/不可解析refs、superseded、stale、conflicting判断。

正例的synthetic可信证据在临时artifact实际存在，有内容digest和索引；Fixture明确synthetic。无裁判判定、transport失败、证据缺失保持unknown，不能误当failure或Refuted。

Delayed unknown不是自动重试执行：允许同attempt追加合法更正/核对判定，更新有效证据和相关依赖；不能为回填结果重新运行Worker。保留终态执行禁止重发与当前判断可追加的区别。

### INT-COMMIT：所有写入结果与故障闭环（C1EXT-02）

统一使用一个受信任durable提交边界，复用真实EventLog `{ok,event,durable,error}`契约。全部append结果都检查：started、预算、Outcome及result引用、completion、unknown、reconciliation、控制、stop。

- effect之前失败：Worker调用数=0。
- effect可能发生后失败：返回明确非正常状态，停止新dispatch，pending effect交给恢复；不能返回空reasons的ok。
- `{ok:true,durable:false}`、throw、fsync失败分别覆盖，不以Promise结束为持久成功。
- 磁盘不可写时不伪造degraded/reconciliation durable事件；可报告内存故障/诊断，重启依赖已提交intent判断未决。
- 若只有completion写失败但完整可信result已提交，恢复可补生命周期；不再次Worker执行。
- 所有退出路径try/finally清理持有的资源；pause持锁与否有明确策略；不能释放其他owner。
- `run()`重入必须单飞或拒绝；同PID多个Scheduler实例owner token不能仅用PID相同即视为同一个实例。

辅助checkpoint写失败不等同权威日志失败，可降级全量replay并诊断，不必为了缓存失败阻止合法执行。不得以“尽力写报告成功”冒充权威事件持久化成功。

### INT-DYNAMIC：真正的提交、准入和分发（C1EXT-05）

投影建立submitted索引，包含proposal ID、canonical digest、提交event ref与原始结构化proposal。Admitted仅引用先前同Campaign submitted，inline副本必须摘要一致；decision由可信Host对当时权威state revalidate。

一条durable admitted记录同时承载准入和reservation，保存完整Task定义：goal/criterion、stage声明或显式stage mapping、scope、target、capabilities、继承的Oracle/adapter、stop condition、父链、预算和稳定语义身份。

不靠修改初始ownedTasks数组把任务塞进Scheduler。Scheduler通过已验证Task投影解析静态/动态Task，重启从Manifest+committed stream恢复动态定义；若定义丢失返回明确错误，不能静默break返回ok。

验证parent Task/Stage、深度、扇出、总数、权限、adapter和预算；换随机ID重复同任务不双预留。不同参数/真实新阶段任务允许按声明策略生成，不粗暴封闭动态扩展核心能力。

仅有`proposal/admission`两个inline对象不等于引用可解析。submitted/admitted计数、dispatch、效果、unknown均从事件/产物统计，不写常量summary。

### INT-BUDGET：gate与扣账一致（C1EXT-06）

本轮保守默认：dispatch必须由该Task已持久预留的各维额度支撑，不能默借Campaign剩余额度。若需重新分配，可由Host在既有授权/Task上限内先提交reservation，再执行；没有分配记录就blocked。零allocation不默认无限，也不默认可用全部余额。

Consumed不能超过held。reject事件不得部分改变账本。Reserved/consumed/released每维有限safe integer；未知/负/小数/NaN拒绝，不normalize为0掩盖非法输入。

完成/取消按声明策略释放unused reservation；pending effect的保留额度在reconcile确认前不能随意释放。Static+dynamic共用账本，重复命令/恢复不双扣。

成功、失败、unknown执行都需保存已知耗用；成本不可测时unknown，不因Worker返回error就认定成本0。C1可以使用显式synthetic固定cost作为测试策略，但必须标记、不称实际wall-time或Token测量。总时间/Session真实测量后续Host接线，当前已知维度硬限制仍要成立。

预计cost与实际effect-before-account崩溃由durable intent/reservation和reconcile处理，不保证外部exactly-once或精确成本。

### INT-RECOVERY：控制状态、核对和结果补全（C1EXT-07）

Campaign pause/resume/cancel/stop必须是Host类型化命令并durable记录，由projection恢复。新Scheduler不能每次默认running忽略cancel事件；run不暗中resume。

新增必要campaign payload.kind须主DS列出字段、来源、迁移和测试；沿用`runtime.note` schema1.1，不新增顶层类型。允许为本轮控制恢复登记必要的kind，但不把“任意campaign.*”全部当有效命令。

Cancelled不重新dispatch；paused需显式resume；budget-stopped恢复仍要验证额度，不能resume增加预算。在effect in flight取消/暂停只阻止新dispatch，处理已发intent的drain/reconcile。SIGTERM、安全退出、SIGKILL验证边界不同。

未决intent经注入的synthetic `oracle.reconcile`读取真实临时产物，结果区分：

- 已完成且验证通过：提交完整Outcome，补全生命周期，Worker不重跑；
- 确认未发生：记录核对结果，依动作只读/幂等/非幂等与停止策略决定下一步；非幂等不盲重发；
- unknown/delayed：留pending验证，预算与停止状态保留；
- 结果已durable但completion没durable：从有效result补completion，不再执行。

核对接口这轮是fake adapter，非C3真实工具执行；测试不得仅确认出现字符串`reconciliation.requested`就称核对完成。

### INT-CHECKPOINT：真实缓存恢复与摘要（C1EXT-03）

明确checkpoint缓存结构必须涵盖继续reduce所需state、Task定义、proposal/Outcome/dedup索引、budget、control、pending/recovery和state revision。复用现Node SHA256/canonical helper，禁止自造hash或给非SHA256值加sha256前缀。

Checkpoint位置使用verified stream offset+对应event digest，不用Episode sequence。包含Manifest canonical digest、schema/projection版本、snapshot digest和payload digest，分别定义覆盖字段。区分Manifest revision与运行state revision；旧`expected_revision`若指运行state，不得永远比较固定Manifest版本。

两种恢复：

1. checkpoint精确匹配已验证tail：校验后取缓存状态；
2. checkpoint为日志的已验证前缀：验证该位置digest和snapshot，再reduce tail；若无法证明前缀或缓存有效则全量replay。

不是所有“checkpoint落后”都必然不能用；合法前缀可以追尾。Foreign/超前/篡改/坏链/不支持版本不可直接使用。Snapshot可从prefix重建校验；正确性优先，C1不承诺缓存性能收益。

`used_checkpoint`只有确实使用其状态恢复时true。别把read返回ok等同used，更不能从checkpoint控制状态覆盖事件控制状态。Tail是最后committed记录，而非最后applied事件。

写快照的边界在计划中明确，至少安全暂停/停止/已提交生命周期/恢复检查点；不是每个metadata自动重写。检查失败与写失败有诊断且fallback，不能改变event truth。

## 4. 主 DS 任务图和文件所有权

| 任务 | 内容 | 主要文件 | 依赖 |
|---|---|---|---|
| INT-BASE | 真实基线、接口、共同测试矩阵 | plan/matrix、私有源码快照 | 无 |
| INT-TEST | 先写七组反例及完整产品入口脚本 | tests、独立expected/证据fixture | BASE |
| INT-ORDER | stream顺序、offset、增量reduce基础 | projection/event-contract | TEST |
| INT-OUTCOME | C0接纳/resolver接到C1 | projection及共享Outcome适配 | ORDER |
| INT-DYNAMIC | submitted索引、完整动态Task、dispatcher取定义 | projection/dynamic-policy/scheduler | ORDER |
| INT-BUDGET | reserve-before-effect、账本、故障cost | projection/scheduler | ORDER |
| INT-COMMIT | 统一durable提交、错误停止、单飞/owner清理 | scheduler/ownership接线 | ORDER |
| INT-RECOVERY | control state、reconcile与可信result补全 | projection/scheduler | OUTCOME、COMMIT、BUDGET |
| INT-CHECKPOINT | 全state缓存、prefix+tail恢复、SHA256 | ownership/scheduler/projection接口 | 上述state稳定 |
| INT-E2E | 真Scheduler+EventLog完整本地Campaign | product/recovery测试与helpers | 上述全部 |
| INT-REVIEW | 主DS全代码审查、mutation、回归、报告 | docs、runner | E2E |

projection/scheduler属于共享文件，不许不同子DS同时覆盖；主DS可串行分段任务或统一集成。可并行编写互不重叠测试/证据输入，测试公共helper由主DS维护。无需每项再次询问用户，未授权架构变更才停对应任务。

## 5. 完成与停止门

每项有正例、负例、组合例，旧代码red->新代码green，主DS读final diff与调用点。全部七组问题有真正Scheduler路径证据，无未解P0/P1才允许标内部verified。

最终必需：完整本地Campaign、真实EventLog、真实子进程故障/重启、预算守恒、动态任务实际执行、取消不复活、可信结果完整归属、checkpoint prefix+tail/full replay等价。

由用户回当前会话外部验收，**即使内部测试全绿，也不自动进入C2**。无法实现不能改文档删需求或改测试假装通过，交付blocked事实。

交付：`C1_INTEGRATION_WORK_PLAN.md`、`C1_INTEGRATION_TEST_MATRIX.md`、`C1_INTEGRATION_REVIEW_REPORT.md`、`C1_INTEGRATION_IMPLEMENTATION_REPORT.{md,json}`。保留旧审计/DS报告作为历史，不重写成“已接受”。运行logs落ignored私有目录。

记录准确HEAD和本轮实际文件摘要；全零/取不到值写environment unavailable及原stdout，不推断repo无commit。测试块/断言数分别报告。类型检查覆盖Campaign，import基线错误列出，Biome warnings=0才clean。

最终状态只能是 `internally_verified / awaiting_external_review` 或真实 `changes_required / blocked`；C2未实现、无真实目标网络/凭据、无自动验收模型调用、无外部exactly-once声明。
