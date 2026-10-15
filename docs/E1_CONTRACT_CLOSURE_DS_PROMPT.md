# 交给 DS 的完整执行提示词

以下正文可直接作为一次完整任务发送给 DS。仓库内的任务书、矩阵、required 清单均为
`E1-CC-1.0`，当前是 **planned**，没有因文档写完而通过工程验收。

---

你是本轮 E1 契约闭合的主 DS，对实现、测试、集成与最终自审负责。请直接完成代码和测试，
不要只输出另一份方案，也不要每完成一个 helper 或阶段就要求用户再次批准。
本次是一项整体任务，按 S0–S4 依赖推进，最后交付可供独立复核的完整结果。

用户已要求：既有整体架构与准则固定；不能仅针对几个 bug 局部打补丁。应以整体链路为基线，
明确接口和边界，使真实执行、恢复、Board/RAM、观察与学习对相同输入给出一致的有效性判断。
架构层次和已有三事实、Broker、Oracle、Compiler 门必须保留。

## 1. 先读固定依据，记录实际起点

在仓库 `/Users/scemac/My_github/Aegis` 执行。先读：

1. `Pi_Agent_base/AGENTS.md`，其适用开发规范、测试规范和 `docs/GIT_STANDARD.md`。
2. `docs/SYSTEM_ARCHITECTURE_BASELINE_AUDIT_20261015.md`，以 `SYS-20261015-01` / B01–B14 为固定准则。
3. `docs/E1_HISTORY_AUDIT_20261015.md`、`docs/PROJECT_COMPLETION_AUDIT_20261015.md`。
4. **主任务书** `docs/E1_CONTRACT_CLOSURE_TASK.md` 全文。
5. **测试矩阵** `docs/E1_CONTRACT_CLOSURE_TEST_MATRIX.md` 全文，66组及每组全部子例。
6. **检查清单** `docs/E1_CONTRACT_CLOSURE_REQUIRED_CHECKS.json`，68个唯一required脚本。

历史 A/B/C/FC 提示词只作实现背景，本次授权范围与退出条件以本任务书为准，不再把它拆成
“只完成某一旧修复、等用户重新授权下一修复”。已有开发/测试/Git规范继续适用。
有真实子Agent能力时才按文件不相交原则委派；否则串行切换测试/实现/审查角色，不能编造委派结果。

开始保存主仓库 status/branch/HEAD 与嵌入 Pi HEAD/dirty、Node/本地工具版本。
规划时产品未改，主仓库起点是 `3e42555245b6a9eeb2f267d4e3828e85ad4099df`；
接手时还会有本轮纯文档提交。以实际 Git 为准，不 reset 到该 hash，也不清理用户已有改动。
继续当前任务分支或创建明确的 `fix/e1-contract-closure` 分支；遵守 Git 规范提交可审查里程碑。

## 2. 已确定的设计，不留给实现阶段重新发明

必须按主任务书实现以下契约，并记录实际函数名/文件/公共适配映射：

- 新 E1 的完整可信 planning_contract 内嵌不可变 Manifest，完整 scope/模板/根目标/策略/工具计费协议可恢复；
  先持久化、fsync和校验再请求。不能扩大 base envelope，不能从模型或 raw admitted 反推可信上下文。
- 原 candidate planDigest 算法不变；执行 Task 用唯一 task_budget，动态三维必须齐全，静态缺维归0，
  两预算别名冲突拒绝。task_digest 覆盖完整最终定义，不用 Campaign 总额作为缺失 Task 额度的回退。
- live/replay 共用纯 compile/evaluate，全图验证、prefix身份和完整 normalized 定义精确绑定。
  同批后位节点引用允许，未来事件定义不追认；整批失败零权威 mutation。
- Host 命令区分 buffered、record_durable、transition_accepted、activated，返回确切 event/prefix。
  record_candidate 成功只接受候选；admit_plan 成功必须有 accepted admission；工具与Host共享去重。
- 最新prefix→决定→append/fsync→replay接受在同一短序列器，不能跨长provider/Oracle等待或嵌套锁死。
  按物理提交顺序选择第一个合法整批计划；后续不同计划/冲突不覆盖它，完全重复不重复扣额。
- allocation_total、scheduler synthetic reservation/consumed、实际request/tool责任分账。
  每个真实provider请求同时受Task/Campaign门，三事实保持独立；分配释放不抹历史累计分配。
- 工具用主任务书的 c6.tool/durable-charge-v1 协议，双侧原子durable charge在工具前；
  绑定实际request/SDK调用/单位/参数摘要。decision按action收费，read/submit各1，别重复收wrapper；
  新协议不能再把request中的旧tool_calls聚合值计第二遍。缺ledger、未知结果或持久化失败不能默认放行。
- 工具绑定由真实assistant message的toolCall映射到原provider请求，execute显式await该请求commit，
  E1工具按SDK executionMode=sequential原顺序执行；不靠异步subscribe自动等待，不持Host锁等commit。
  decision共享proposal只有至少一个单位获准才入buffer，原索引和完整共享参数摘要不丢。
  finished不代替可验证持久tool-result；重启同键重复execute无结果则hold，不重执行；
  正常ready恢复不重执行旧planning工具，无需补历史结果cache。direct复用不伪造SDK调用或请求。
- 时间从accepted started的可信时间锚计算；跨Session/暂停/重启不重置，now<双deadline才放行；
  回拨/坏锚hold，不把请求timestamp当耗时，不声称即时取消在途操作。
- 保留独立完整Oracle、planning正常结束、请求责任结清、Task完成与durable ready门；
  缺ready、工具未结清、error/aborted等不能因已有合法候选而激活。
- 共同authority输出包含accepted definitions/starts/outcomes、effective judgments和拒绝；
  Board/RAM/Observer/supervisor/learning/readonly等全部接同一Manifest与有效集。
  unknown/合法修正/环境失效传播到当前依赖；非法修正不退旧Fact，未来证据不追认过去。
- E1本轮明确完整committed源重放，不信不完整checkpoint；tail-only无完整源返回full_replay_required。
  旧E1无可信contract只读hold；非E1原合法路径保留。不得过滤坏JSONL后继续执行。

这些是必须实现的语义契约。内部helper命名可自主调整；若证实其中某项与固定架构/真实SDK
存在实质冲突，保存最小输入、调用链、冲突条款及候选最小替代，停止受影响切片并记录current_blocker，
继续不依赖它的工作。不能静默改规则、改旧expected或以测试全绿掩盖冲突。

## 3. 执行顺序与阶段出口

**S0 冻结与 red：** 先确认矩阵expected和真实入口，创建四个可运行测试脚本及必要fixtures/helpers。
先运行旧独立审计/相关基线，保存实际行为red与正常对照。新接口不存在导致import失败不算行为red。
记录两个tsconfig的本次实际诊断，历史194/186只是参考。本轮新矩阵规划时没有运行，不能引用为已通过。

**S1 可信执行契约：** Manifest contract、不可变持久与恢复来源、ExecutableTask适配、纯编译/转移。
先把身份、摘要、预算形状、模板/根目标、整图合法性和安全加法做成可验证接口。

**S2 准入/预算/恢复：** Host序列化与结果语义、一次有效计划、累计allocation、真实请求/工具/时间门、
durable ready与E1完整重放。实际SDK/faux正例、预算1反例和真实新进程恢复必须成立。

**S3 有效判定与所有消费者：** 提取或复用既有纯resolver，不再创造一个更弱的Board判断。
用rg列全projectBoard/Outcome/accepted-definition消费者，记录入口→上下文→输出→case，
逐个核验RAM、两处Observer rebuild、supervisor、两个learning路径、status/export/HTTP等实际产出。
如提取artifact index，保持中立依赖和现有re-export，不能产生Board↔Campaign/c3循环。

**S4 集成/自审/交付：** 68脚本、所有修改路径的格式/类型检查、真实子进程barrier故障、有限mutation，
回填全部矩阵子例与接口/调用点映射，逐文件阅读全文diff和新文件全文，再提交和交付报告。
S1/S2/S3共享文件串行集成；阶段局部通过不能代替最终整体门。

## 4. 必须保留的独立结果和测试纪律

以下不是建议，不能修改独立completion/history审计assertions/expected来迁就实现：

- 正常完整产品链：provider=8、Broker effects=3，实际结果 `{name:"Ada",status:"active"}`。
- 合法ready前缀新进程恢复：6新请求、3新效果；缺双方planning身份的同前缀：0新请求、0新效果。
- HA-02：三动态Task的合法额度各1仍须准入；每Task实际请求≤1、效果0。不能全部拒绝来过关。
- HA-03：不能多个有效计划/越额分配；任务书示例allocation首次68、重复仍68，不能第二批变128。
- HA-04：foreign-root保留候选、拒绝准入；planning请求2、动态定义0、效果0。
- 被权威拒绝的scope/criterion/evidence/admission不能经Board成为Fact，再进RAM或当前依赖。
- 原C6每侧消费、联合未决、planning终止三事实/SDK tool-result持久化/Host ready写故障回归继续通过。

旧合法测试输入可通过真实产品builder/Host升级contract/绑定并补上下文接线，在报告逐处列出；
保留原正常行为和负例语义，不去掉负例故障字段、不skip、不改为expected-failure、不扩大预算掩盖失败。
fixtures不是产品验收；真实SDK/faux+本地Broker/Oracle/文件的产品正例不可缺。
主任务书§4.2已明确planning-child fixture迁移：测试Host冻结前fan-out显式4，正常总数4，
仅原四子illegal_plan总数显式5以实测原target越权；三维预算不变，原fan-out2有拒绝对照。
不能保留产品Math.max暗扩，也不能让原target负例变成只测硬结构上限。

每组子例的expected独立于被测函数。计数/有效集合/预算/实际文件才是断言，不能只assert返回ok。
测试有限mutation必须因行为断言失败；import/syntax异常不算捕获。不要把纯前缀恢复宣称SIGKILL。
日志逐命令保存argv、stdout/stderr、真实exit，禁止管道末端成功遮住失败；重跑保留首次失败原因。
不要运行真实模型/目标、使用付费凭据、安装依赖或运行整个Pi monorepo e2e集合。

## 5. 精确检查入口与可修改范围

required运行命令见主任务书§11，读取新JSON的 `.groups`，不是旧清单本身的顶层数组。
使用已有 `tests/helpers/c6-suite-runner.mjs`，它按需要选择source resolver。四个新脚本名固定：

```text
aegis-e1-closure-contract
aegis-e1-closure-admission
aegis-e1-closure-judgments
aegis-e1-closure-recovery
```

静态检查使用已有本地工具：

```text
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json <逐个修改的代码/测试路径>
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json --pretty false
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis.json --pretty false
git diff --check
```

新helper加入type覆盖，不关闭检查或以any/ignore隐藏新增错误。比较诊断身份/位置/内容，
修改路径不得新增/恶化，旧非零exit如实保留；不能把类型债记成全绿。
本地HTTP若因环境权限受限，按实际工具规则申请必要执行权限或如实blocked，不改测试假装通过。

允许修改主任务书§10列出的Aegis-owned模块、必要小型纯helper、调用点适配、测试/fixture、
显式type include与当前状态文档。其他可达调用点需要改时，在报告解释CC/调用链/测试。
禁止修改Pi core、真实config/auth/私有attempts、依赖和lockfile、冻结架构或原独立审计预期。
不新增通用shell/CTF、多Worker、增量重规划、分布式租约、自动补ready或学习效果实验。
所有runtime原始证据放ignored目录，不提交凭据、目标数据或无限原始transcript。

## 6. 最终交付，不允许只有“测试通过”一句

创建 `docs/E1_CONTRACT_CLOSURE_IMPLEMENTATION_REPORT.md`，至少包含：

1. 实际branch/起止commit、文件清单、Pi HEAD/dirty、接口与版本落点。
2. B/CC→66组全部子例→真实入口/脚本→expected/actual/exit/log的完整追踪索引。
3. 68required脚本逐项结果、原缺陷red→green、正常链与正反恢复对照。
4. 工具收费单位/协议、allocation/synthetic/actual账分离、时间锚、部分责任和持久化故障的实际证据。
5. 所有消费者调用点表、拒绝不再提升的实际输出、fixture升级与旧独立断言保持证明。
6. 类型诊断前后逐项差异、Biome/diff、有限mutation和真实子进程边界证据。
7. 主DS全文自审发现/修复、current_blocker/non_blocking/deferred、限制、责任阶段和重新评估条件。
8. 真实实现与任务书若有差异逐项说明；同步当前README/AGENTS/阶段入口，保留原审计历史。

按Git规范明确路径stage，阅读cached stat/diff/check，本地提交可审查单元，正文注明DS/Agent协助范围。
不push、不重写历史、不清理用户文件。交付commit与真实剩余status，不能把产品代码停留在未跟踪状态。

若全部当前阻塞闭合且所需检查完成，状态仅为 **internally_verified / awaiting_external_review**。
required失败/blocked/not_run、消费者漏接、无产品正例、恢复仅同进程模拟，都必须 **changes_required**，
如实列出，不自封externally_accepted。后置项按主任务书§13归档，不假称已完成。

请现在开始S0，并持续推进到S4完整交付；最终简明报告结果和证据入口，不用“是否继续”结束。
