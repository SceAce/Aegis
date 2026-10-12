# 主 DS 拆分、委派、测试与审查流程

状态：用户确认一次总委派、主 DS自行拆小任务，以及开发规范 §3.1 的阶段范围冻结规则。C1/C2 已验收；下一路线见 `CAMPAIGN_NEXT_PHASES.md`，C3 任务书/提示词已准备。本轮为验收与规划，未启动 C3 实现；委派后内部 C3-A/B/C/D 自主推进并分任务提交，仅交一次阶段验收。F16 后置，不重开阶段。Git 管理遵守 `GIT_STANDARD.md`。

## 1. 一次总委派的含义

用户只需发一次总提示词。主DS负责完整执行授权范围：先共同生成测试矩阵和脚本，再逐小任务实现、审查、集成和交付。正常的小任务无需逐次让用户批准。

任务分发支持两种方式：

- 当前PI环境已提供子Agent工具：使用该能力，给每个子DS准确任务和文件范围。
- 没有可调用子Agent能力：主DS按同样任务图串行执行，显式切换测试/实现/审查步骤，不编造“子DS已完成”。不为本任务新建Agent管理平台。

开发阶段可并行不相交文件；Campaign运行期仍单活动Task/Episode。不要让子DS并行修改同一Episode/同一文件，也不要把开发子会话数当实验独立Episode数。

## 2. 角色与输出

| 角色 | 输入 | 必须输出 | 禁止 |
|---|---|---|---|
| 主DS/协调 | 全部规范、架构、当前代码、外部发现 | 契约表、任务图、共同测试矩阵、集成结果、最终审查 | 只转发子DS报告、不读最终代码 |
| 测试DS | 冻结契约、接口、case种子 | 可执行脚本、独立expected、旧代码失败证据 | 从实现返回值生成正确答案、改弱冻结断言 |
| 实现DS | 单任务接口、文件所有权、测试 | 最小实现、聚焦测试、残余问题、实际diff | 改权限/证据门、跨范围改共享接口 |
| 审查DS（可选） | diff、契约、不变量 | 按严重度发现、精确复现、范围 | 把同模型自审说成独立真值 |
| 主DS最终审查 | 集成后的全部代码与证据 | traceability、跨模块反例、审计结论 | 以测试块数量替代覆盖与验证 |

## 3. 计划文件

主DS在编码之前创建/更新以下Aegis-owned文档：

```text
docs/CAMPAIGN_WORK_PLAN.md       # 本轮任务图、公共接口、顺序、范围
docs/CAMPAIGN_TEST_MATRIX.md     # case到需求/脚本/结果映射
docs/CAMPAIGN_REVIEW_REPORT.md   # 主DS审查与外部待验收结论
```

当前文档维护可以使用Markdown，未生成则不要声称已经有矩阵。原始stdout/stderr、调度记录、子会话材料落 ignored runtime/dev/<run-id>/，不把密钥写docs。

任务状态：planned -> tests_ready -> implementing -> reviewing -> integrated -> internally_verified。外部验收前标awaiting_external_review，不写 externally_accepted。

阶段开始冻结核心目标与 required 清单。发现标 current_blocker / non_blocking / deferred，写影响、责任阶段和重新评估条件；实现者和审计者都不能因新增优化项反复重开阶段。小修复复用现有计划/报告，只更新变化与证据，不机械新建全套文档。

## 4. 小任务模板

每个任务至少包含：

```text
task_id / phase
problem与用户可见行为
requirements / invariant_ids
input/output types与failure semantics
allowed_files
forbidden_files
upstream/downstream dependencies
shared interfaces不能修改的部分
mandatory test case ids与exact commands
expected outputs/artifacts
reviewer与integration owner
stop conditions
```

子DS可在范围内拆更小步骤，但不能再次无限扩张Agent树。主DS控制开发子任务数和上下文大小，不把整monorepo或完整历史塞给每个子会话。

## 5. 文件所有权和集成

- 共享契约、index导出、lint/type配置、主runner、通用fixtures与docs归主DS。
- 两个子任务需要同一文件时按依赖串行执行或由主DS集成，不能靠最后写入覆盖。
- 开始和完成记录git status；只看本轮实际diff与新增文件，不恢复/清理旧删除状态。
- 当前 Aegis-owned 实现已基线入库。新增未跟踪文件仍须全文审查；不能把“diff为空”当无改动。主 DS在任务分支按明确路径提交测试、实现和报告，不混入无关改动。
- 子DS完成后主DS检查allowed files、接口变更、测试修改、注释声明、运行效果，然后重新跑集成检查。
- 子DS返回“PASS”没有对应命令和log不算证据；主DS至少独立运行相关phase runner。

## 6. 本轮任务图

### C0 Closure

1. BASE：确认现有基线与共享契约，整理当前外部发现；记录未知行为，不立即加补丁。
2. TEST：按测试规范共同生成矩阵与可运行脚本；审查expected，优先复现已知缺陷。
3. ID/MAN：ID格式、Stage唯一、版本入口、Manifest类型/持久化一致。
4. DYN：parent/depth/count/dedup/预算接口与纯helper幂等。
5. OUT：可信Outcome准入、complete criteria/stages、supersedes三视图、独立性和data-use链接。
6. REP：白名单报告、枚举credentials、refs和digest、限额与fixture声明。
7. INTEGRATE：公共接口/fixtures调整，类型与格式检查，focused tests+组合负测+有限mutation+回归。
8. REVIEW：主DS全文审查上述最终模块与调用者，收尾发现。无未解P0/P1且mandatory suites通过才内部C0 closure。

如果OUT牵涉REP/fixture接口，两任务串行，或主DS在接口冻结后分派不同文件。不得四个子DS各改同一个测试文件。

### C1 分批

- C1-A 事件payload/command接口：复用runtime.note/schema1.1，冻结campaign.kind枚举、来源、expected_revision、command id、成功结果关联；不写循环。
- C1-B 纯事件投影与预算账本：静态队列+动态admission、single-active规则、dependency结果、reservation/consumption/release、terminal与unknown semantics。
- C1-C 所有权与checkpoint：per-Campaign目录、一个实际writer、同进程/多进程争用、atomic派生快照、恢复验证。单机ownership优先，过期lease不能允许两个活writer。
- C1-D scheduler：接A/B/C，注入fake worker/Oracle/clock，durable-before-dispatch，pause/resume/cancel、预算停止；不接真实Pi/Broker。
- C1-E 恢复与集成：真实子进程kill/restart、事件边界故障、重复admission、unknown reconciliation、依赖不提前dispatch、端到端两个任务+动态任务+延迟判定。
- C1-REVIEW：主DS检查cross-boundary并重跑required suites，记录C1能证明/不能证明内容。

先A接口再B，再C/D；E可提前写脚本但不能在A-D缺实现时把测试缺失说成通过。

## 7. 审查清单

每个任务主DS必须检查：

1. 输入来自哪里？谁固定source/authorization/registry？
2. 有没有把缺失值当wildcard、把truthy/bogus当success？
3. corrector能否跨Task/Episode/scope污染？unknown保留了吗？
4. 多个必需criterion/stage是否完整，冲突是否可见？
5. 幂等/重复/恢复是否产生第二次reservation或效果？
6. 审计持久化是否真的先于副作用，失败时进程/文件是什么？
7. checkpoint/UI/report是否能伪造状态，重建是否只读权威源？
8. Session次数/Outcome次数是否错误增加独立Episode？
9. 脱敏是否有恢复原值或复制未知字段，证据refs是否可追溯？
10. 测试是否复现原bug、expected是否独立、例子是否全部synthetic？
11. 注释、报告、schema与真实行为是否一致？
12. 有没有未授权新功能、重复框架、未用配置、空catch、为了通过而禁用检查？

发现按P0/P1/P2记录，附文件位置、触发输入、期望/实际、影响、case id、修复状态；同一问题的相邻维度一次检查，避免修一处漏同类调用点。

## 8. 自主推进和停止

主DS可按既定授权自主推进本轮C1跨模块收尾小任务，不为每个helper/命名询问用户。编码前共同生成测试，按当前任务图依赖集成。

以下停止受影响任务并记录：必须改变数据模型/晋升门/授权范围、修改Pi核心、需要新依赖/真实模型调用、无法实现单writer/durable语义而准备降低声明。其余不受影响任务继续，不把“等用户”当全部停工理由。

C1/C2 限定外部复核已通过，历史任务图和修复提示词只作背景，不重复启动。F16 后置，不要求缓存诊断全绿；后续阶段只有实际恢复依赖时做必要接线。下一阶段按用户范围执行，C2 通过不自动授权 C3-C4a。新阻塞须有当前可达核心损害证据，不能把外部审计变成无限范围扫描。

## 9. 最终交付

主DS提供：

- 实际文件清单与各task owner；
- shared contract的实际版本/关键选择；
- `requirement -> case -> script -> result`矩阵；
- exact commands、exit codes、phase runner结果与blocked环境原因；
- 旧代码red、新代码green与mutation结果；
- 主DS审查发现、冻结范围内的当前阻塞闭环、非阻塞/后置项及责任阶段；
- 权威输入到projection/report的rebuild证据；
- synthetic/faux/真实本地子进程各自验证范围；
- 未实现的C2/Pi真实Session、C3/Broker与Oracle、C4a/UI等范围；
- 无自动验收模型调用、无真实目标网络；
- 本地任务分支、commit id、准确工作树状态与验证日志引用；
- 状态：internally_verified / awaiting_external_review，仍有阻塞发现则 changes_required。

最终报告不是主DS自动验收自身。用户把材料交回当前会话完成独立复核。
