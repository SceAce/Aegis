# C6 限定工程审查：通过有限真实任务 pilot 工程门槛

状态：**限定工程复验通过，可推进有限真实任务 pilot**；真实 provider/任务效果尚未实测。
最新独立复验以 DS 交回 `d1a81c8` 为起点，并完成一项 SDK 收尾错误的小修复，见第8节。
第1–7节保留历史基线与失败证据，不能据其旧状态覆盖最新限定结论。
初轮审查基线 `7b7e92d` / `feat/c6-agent-product`，开始工作树干净；内嵌 Pi `42a3497d0` 干净。
初轮按用户要求复核 DS 交付并补其他测试；第8节记录本次产品小修复。均未运行真实模型/外部目标。
正常 SDK/faux + 本地 Broker 效果已成立；以下历史缺陷与修复记录用于追溯原 C6 冻结承诺。
本报告不增加性能/缓存/并行/容器/任意任务理解门槛，C1-C5 保持原验收范围。

## 1. 初轮实际验证（7b7e92d）

- DS 十个提交存在（4798d82 至 7b7e92d），修改范围为 Aegis-owned 代码/测试/文档/类型配置。
- 原 **11 个 C6 suite 独立运行均 exit 0**，逐 argv/exit/log：ignored
  `Pi_Agent_base/runtime/dev/c6-external/baseline.json`。这些绿色结果保留，不等于所有 required 已实现。
- 新 `tests/aegis-c6-external-boundaries.mjs`：**21 Node tests / 2 pass / 19 fail，exit 1**。
  正常 real SDK/faux 两任务真实效果通过；SHA256/UUID 控制通过。其余为当前边界行为失败，
  坏源 status 的异常由 harness 捕获后明确断言，最终不存在 import/syntax/harness 启动失败。
- 样本输入来自测试父进程的可信配置/Manifest、真实临时文件、真实 SDK/faux requests，
  helper 在独立 child 中执行，避免真实 SDK provider 注册和环境变量污染其他用例。
- **SHA-256 abc 标准向量通过、a/b 摘要不同、UUID 不同**。本环境未观察到 crypto 全零桩。
  DS 的环境归因没有可支持证据，不能据此弱化 digest/body-tamper 原断言。
- Biome DS 修改范围 exit 0，**9 warnings**；新两个测试文件 Biome exit 0，无 warning。
  warning 不是本轮正确性新增门槛，但报告不能写“仅既有 info”。
- Campaign tsc 本次 **exit 1 / 214 条诊断**，其中修改的 Campaign 文件 **18 条**：
  c6-entry 13、c6-learning 1、c6-tool-ledger 1、campaign-mode 1、provider-config 2。
  包含 4 个新增 SDK import resolution 诊断，其他为签名/JSDoc/返回字段错误。
  不支持“196/新增0”的最终报告；旧库基线仍可记录后置，新签名诊断须修。
- static-results.json/biome.log/tsc.log 保存精确命令与输出。本轮没有重跑 DS mutation、25 回归，
  没有将历史结果冒充独立复跑。测试/审查变更 diff check exit 0。

命令（仓库根目录）：

```bash
node --test Pi_Agent_base/tests/aegis-c6-external-boundaries.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c6-product-chain.mjs
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json
```

完整新反例输出为 ignored `runtime/dev/c6-external/final-boundaries.log`。
最初 18 tests 的 red.log 为迭代证据（4 pass/14 fail）；测试完善后最终 21/2/19。
context 最初只测试极小 10 chars，后来改为 1000，避免零请求预算之外的特殊边界掩盖乘倍问题；
restart 最初仅断言不重复任务，后来追加实际累计 consumption，避免终态阻止 dispatch 掩盖余额归零。

## 2. 初轮问题（修复后状态以第4节为准）

| ID / 严重度 | 复现与当前影响 | 位置 / 违反需求 |
| --- | --- | --- |
| C6-X1 / P1 | limit=1 仍能同时 admit 两个请求；同 reservation commit 两次计2；超过 wall-time 仍 admit request/tool | c6-tool-ledger.mjs remaining/admitRequest/commitRequest/admitTool；C6-P3 调用前预算与幂等 |
| C6-X2 / P0 | 两任务 real SDK 产生4次 provider 请求，ledger只计2；Task request allocation=1 实际发4次并完成；Task tool allocation=1 一条模型决策含3 action，3个 Broker intent 真实落盘 | c6-model-worker.mjs 只包整次 prompt、未调用 admitTool；c6-entry 未把真实使用接 Task ledger；C6-B/P3 |
| C6-X3 / P1 | max_total_input_chars=1000 仍发请求。入口乘以 manifest.model_requests 作为累计 limit；Worker 只估名字长度，无实际 history/schema，每次 context max 未执行 | c6-entry.mjs createToolLedger；c6-model-worker.mjs estimateInputChars；C6-P3 总输入门 |
| C6-X4 / P1 | run real requests=4；measure 新建空 ledger 输出0/attempts空；同完成日志重新 run，ledger consumption又为0；runtime ledger事件只打印，没有 committed request/attempt记录 | c6-entry.mjs ledger/onEvent/buildMeasurement；C6-P3/P7 跨重启预算、真实测量与报告 |
| C6-X5 / P1 | inherited AEGIS_EVENT_LOG 指 decoy，SDK向 decoy写37条而Campaign文件仅动作/调度记录；episode.task_id=外部测试标签而非实际task；SDK先创建后 bindHostEventLog；RAM选第一个episode | c6-entry.mjs SDK创建顺序/router/ramProvider/sessionController；c6-sdk-runtime.mjs；C6-P1/P2 Task/Episode/单writer |
| C6-X6 / P1 | runner 声称 work-a/work-b，但实际日志仍在原config work_dir，两个声明目录无events；seed/initial_state只是结果字段，未初始化实际目标 | c6-runner.mjs runEntry参数与attempt准备；C6-E/P7 独立运行/初态/测量真实性 |
| C6-X7 / P1 | 合法 loopback local-openai 配置被 recognized-but-unimplemented 拒绝；代码只有faux实际创建路径，create seam替身也未验证本地模型启动参数 | provider-config.mjs KNOWN_PROVIDERS/resolveProviderConfig、c6-entry 非faux分支；C6-D/P6 代码交付，非要求真实请求 |
| C6-X8 / P1 | Campaign proof的when为声明字符串、expect在Host归一化时丢失、run_id为空；无product replay配置/调用、无reset证据；compile只存派生JSON、入口不写experience.compiled权威note；router缓存旧bridge且不提供verified current state；habit落回完整planning | c6-learning.mjs、c6-entry.mjs、host-oracle.mjs、structured-data-adapter.mjs；C6-C/P5 编译→真实复用未完成 |
| C6-X9 / P1 | observe实际CLI打印URL后exit0，入口finally关闭listener；signal handler无移除，停止用void不等待durable结果 | c6-entry.mjs observe/signal/finally；C6-A/P7 常驻服务与退出 |
| C6-X10 / P0 | 模型patch写 process.exit(0); export const answer=0; 外部test应assert answer=42，但未执行断言即exit0，Task实际completed；未知declared criterion也被一条passing test赋success | registered-test.mjs exit-only判定、code-repair-adapter.mjs judge全stage成功；C6-F/P8 外部可信判定 |
| C6-X11 / P1 | provider工具只有proposal/handoff/decision，无目标读取/观察；prompt未包含准确target/criteria、catalog只列action名字，未给参数schema；faux预知字段/值生成正确动作，真实模型没有observe入口 | c6-sdk-runtime.mjs tools、c6-model-worker.mjs buildPrompt；C6-B/P1 observe→决策→效果 |
| C6-X12 / P2（当前必修） | 已完成日志篡改后status装配拒绝，但catch访问null sdkRuntime.dispose，TypeError覆盖原结构化完整性拒绝 | c6-entry.mjs assembly catch；既有非执行命令错误语义与清理 |

初轮19个失败按上述12组集中处理；修复后的剩余项见第4节。X10 明确真实假成功，X2 明确预算越界，
不能因 offline、promote_experience:false 或尚未真实实验就归为非阻塞。
X7/X8/X9/X11 已在 C6 总任务中冻结，不能缩成“不影响现有fixture”或移交E2来声称完成。

### 经验工程目标不能留给 E2

C6-P5 明确要求真实reset/replay、Compiler active、第三Task direct零规划、habit参数绑定、退场和重建。
`aegis-c6-learning-reuse.mjs` 实際只：

- 接受 compiled.active 或 candidate（二者任一即可）；
- 手写 exp-demo active note，when是字符串、do为空；
- 允许direct/habit/hint/deliberate/paused任一路由，因此没有证明direct/habit；
- 未调用配置的 replayCommittedOutcome，没有真正隔离Replay证据。

“实验后置”仅后置收益、样本/分组/真实provider调用。C6 仍须完成上述代码与离线产品测试。
修复不能复制手写 active 或降低 Compiler 门；跨独立日志证据需明确定义作用域和trusted import。
不同任务的不同字段后置条件未必能编成同一规则，正例应由明确同方法、相容条件的独立场景构造。

### 修复代码 Oracle 的边界

进程exit0只证明transport。最小修复应让可信Host能够确认预定断言已执行且结果满足声明criterion，
缺结果/提前退出/timeout为unknown；不能仅要求另一个可由目标模块打印的PASSED行就宣称可信。
固定test身份/标准不被模型写入，执行前后校验；不新增OS sandbox为全阶段硬门槛。
未知criteria保守unknown，不把“通用test通过”映射到任意性质。补test正文/依赖变化的实际反例。

## 3. 原测试/报告与实际覆盖不一致

- C6-P4 只有pause/cancel/status，复用旧Scheduler恢复有价值，但没有C6 SDK/ledger接线的
  real child IPC barrier→kill/restart证据，不可宣称C6调用前预算/跨restart已闭合。
- SDK生命周期测试断言一整个Campaign仅1个Pi Episode，实际无关标签导致，不能证明每个真实Task绑定。
  gate检查用新建helper，不是轮换Session真正tool_call；“no callback needed”用typeof函数断言。
- observe测试在入口返回后重新创建server，证明C4a模块但不证明C6常驻入口。
- provider合法控制允许 ok 或 reasons数组，未实现provider被拒绝的mutation只证明该拒绝存在，
  不证明C6-D完成。
- Runner只检查manifest记seed/initial_state和条目数，未检查实际日志/目标初态。
- report称仅既有info，实际9 warnings；matrix SDK-L2/L3/L4仍not_run却总称全pass。
- 类型本次214、修改Campaign18条。修新增签名/API解析问题，旧库诊断按配置如实记录，不能归入“旧196”。

## 4. 修复后复验追加结果

复验基线 `35b053a`，开始干净、未修改产品实现。全部14个C6脚本（含旧外部21例、学习闭环、恢复）
独立复跑exit0；原21边界已闭环。随后只针对修复调用路径补测：

| 剩余项 | 新复现 / 判定 | 关联原要求 |
| --- | --- | --- |
| X2续请求 / P0 | Task model_requests=1，先连续调用aegis_read，实际4次provider调用；message_end事后commit和decision terminate不构成通用调用前门 | C6-P3，各工具/continuation调用前预算 |
| X10 harness / P0 | 合法answer=42配标准node:assert/strict的assert.equal测试，返回assert.equal is not a function；改Error.prepareStackTrace为伪造check.mjs调用帧后，answer=0并提前退出却ok=true/complete=true | C6-P8，正常验收+提前退出无假成功 |
| X5新观察 / P1 | grant里的allowed.txt是指向workspace外文件的symlink，aegis_read返回外部测试样本；lexical路径检查不验证真实位置 | C6-B观察授权，不要求抵抗并发OS替换 |
| X6初始化 / P1 | attempt.initial_state=fresh，但没有applyInitialState时仍执行并报告成功，实际目标保持prior-result；日志目录隔离已修，初态仍仅metadata | 原runner真实初态/结果真实性 |
| X8复用证明 / P1 | task-003在phase1已completed，phase3零请求没有新Broker intent或trusted outcome；新增3个check块失败，不能据无dispatch称direct复用 | 原C6-P5第三Task真实动作、habit/退场 |

精确结果：
- 外部suite追加read-budget后 **22 tests / 21 pass / 1 fail**，exit1。
- 学习闭环保留原检查并追加“复用任务编译前未完成”和phase3新的intent/outcome：**3个新增check块失败**，exit1。
- 新 `aegis-c6-recheck-boundaries.mjs` **5 tests / 1 pass / 4 fail**，exit1；授权普通文件读取控制通过。
- Campaign tsc仍exit1，**196条旧诊断、Campaign文件0条**；此次新增类型修复已成立。
- Biome对DS本轮26个修改代码/测试文件check exit0，无warning；补充测试修改范围亦通过。
- `runtime/dev/c6-recheck/results.json` 保存原14suite argv/exit/log；external-final2.log、
  learning-strengthened.log、followup.log 保存新失败；未复跑DS mutation/全回归冒充独立证据。

补测命令：

```bash
node --test Pi_Agent_base/tests/aegis-c6-recheck-boundaries.mjs
node --test Pi_Agent_base/tests/aegis-c6-external-boundaries.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c6-learning-closure.mjs
```

另外按代码核对，request persistence仍为message_end回调里sink.append不等待、catch丢错误，
尚无调用前durable预留；补修必须保证持久准入、写故障停止，不能只把事后计数做准。
学习when所用pre_state来自task.initial_state声明、verified_by指向post-state artifact，
并非真实执行前观测；正例还需证明独立任务真实reset与前态，不能给声明标签赋验证身份。
这些是原X2/X4/X8要求的遗漏，复验不另加性能/容器等目标。

## 5. 22d075c 最终聚焦复验：五组修复认可，请求门仍有三处遗漏

起点22d075c，工作树干净、分支feat/c6-agent-product；本次未修改产品代码、不调用真实provider。

**已认可的结果**：

- 全部15个C6脚本独立运行exit0，其中external-boundaries为22/22，recheck为13/13。
- registered-test正常assert模块/真实错误/提前exit/伪造帧用例通过，symlink与当前Task grant用例通过。
- runner缺initializer明确拒绝，真实初始化与失败隔离通过。
- 学习训练两次真实前态/独立reset与Replay→active→未调度的task-003，确实有NEW intent/effect/Oracle success，
  provider规划请求0；不同声明值未替代实际pre_state。此前终态任务无dispatch的测试漏洞已经修正。
- Biome对14个DS修改代码/测试文件exit0，无warnings；tsc exit1仍196条旧诊断，Campaign文件0条。
- 不重复DS mutation或26个回归声明为本次独立运行。原15suite exact argv/exit/log见
  ignored `runtime/dev/c6-final-review/results.json`，静态检查见static-results.json。

**仅针对新provider gate同一路径补3项断言**，保留原13例，最终16 tests/13 pass/3 fail，exit1：

| case / 严重度 | 直接复现 | 根因与原C6承诺 |
| --- | --- | --- |
| C6-R12 / P0 | 最后一次请求commit回调返回ok:false，模型有有效决策、无下一请求；worker.run仍ok:true，可进入CompositeWorker的Broker执行 | gate.pendingCommit只在下一次streamFunction前等待，成功返回前不flush；原X2/X4 effect前durable与审计故障停止 |
| C6-R13 / P1 | Campaign ledger请求余额0、Task ledger余额5，provider仍被调用4次 | installProviderGate仅activeLedger.admitRequest，Campaign ledger只在message_end无reservation地事后commit；原Task+Campaign envelope调用前准入 |
| C6-R14 / P1 | window=2000，实际llmContext.messages含10000字符，provider仍被调用1次 | gate不使用llmContext，只重算cached prompt/catalog/RAM；historyCharsProvider默认0且entry未传；原每请求总输入含实际history/tools |

代码位置为c6-model-worker.mjs的installProviderGate、message_end与run尾部，及c6-entry.mjs ledger接线。
没有新增OS sandbox、真实计费、性能或实验门槛；它们在原已承诺的调用前预算/窗口/持久故障范围。
同SDK内部边界的受控测试不依赖网络，provider是否被调用由计数明确观测；正常/其他失败原13例全部保留。

执行：

```bash
node --test Pi_Agent_base/tests/aegis-c6-recheck-boundaries.mjs
```

完整失败：ignored `runtime/dev/c6-final-review/final-guards.log`，退出统计remaining-results.json。
会话恢复后在85b1d1d再次运行同一suite，仍为16例/13通过/3失败，实际exit1；
记录见ignored `runtime/dev/c6-session-resume/recheck.log`及results.json。此次仅补齐修复提示词与
阶段入口，未修改产品代码、未重跑其余suite或静态检查冒充新证据。
修复应在run返回/每provider准入前统一处理，不能删断言或只保护有下一请求的分支。
Task/Campaign reservation必须同一个实际request身份、失败时保守处理pending与已发生成本；
先检查/预留再durable记录，避免拒绝前写null reservation给重启伪造状态。
实际provider transcript/schema按SDK格式计量，估计仍明确标注，窗口限制不只针对初始prompt。

## 6. 收敛处理与下一步

请求门三项（R12/R13/R14）已由主 DS 在 `feat/c6-agent-product` 完成重规划与修复
（规划/契约/状态机/覆盖表见 [C6_PROVIDER_GATE_PLAN.md](C6_PROVIDER_GATE_PLAN.md)）：

- 聚焦套件由 20 tests / 13 pass / 7 fail 转为 **23 tests / 23 pass, exit 0**（保留全部 red，新增 R14c/R15/R16）；
- `aegis-c6-external-boundaries` 仍 **22/22 pass, exit 0**；15 个 C6 脚本与 26 个受影响回归 exit 0；
- Campaign tsc 仍 **196 条旧诊断、修改文件 0 条**；Biome 修改范围 exit 0。

细节、mutation 与 exact argv/exit/log 见 `docs/C6_PROVIDER_GATE_PLAN.md` 实施结果节与
`Pi_Agent_base/runtime/dev/c6-gate/`（ignored）。DS 不自行宣布 external acceptance。

F16、旧库类型清库、复杂检索/任意经验组合、多Worker/容器、真实模型pilot/效果/迁移仍后置。
DS 完成后交当前会话复验；只有冻结工程目标通过，才讨论真实环境实验具体模型、授权与预算。

## 7. 93d4617 架构组合复验：两组核心不变量未闭合

本轮依据用户要求独立核对整体执行链并补测试，初始工作树干净，分支
`feat/c6-agent-product`。产品基线 `93d4617`，内嵌 Pi 为
`42a3497d03ad17e308a2299fa824727894f2c0ec`、工作树干净。
本轮只增加审计测试、扩展测试子进程和更新本报告，产品实现保持该基线。
真实 SDK/faux、本地临时目录、真实 Host/Broker/Oracle/EventLog；未进行真实 provider pilot。

### 7.1 整体设计与已经成立的行为

Aegis 的主链是目标/授权/预算 → 模型观察与数据决策 → Host/Broker 执行 → 独立
Oracle → 可信 Episode → Replay/Compiler → 条件经验。事件是权威源，报告、账本投影
和经验存储由事件重建。模型决策和请求结算不直接构成任务成功。

DS 统一请求生命周期模块的方向成立。原四项缺陷的聚焦检查已经通过：内存失败不会被
durable success 掩盖，provider 无 completion 会保留未决记录，Task pending 按归属隔离，
部分 committed 不被接受为联合提交。已有产品链和学习闭环继续通过；本轮新增正常控制
也证明真实 SDK 提交决策后有真实文件修改、Broker effect、Oracle completed，重启不重复
provider/effect 且保留累计消费。授权边界、可信验收、独立 Replay 和第三任务复用的已有
验收不重开。

剩余根因是三个状态仍被混用：**每侧是否已记账、请求是否已联合结清、模型规划是否正常结束**。
共享文件不自动保证这些状态一致。预算责任守恒与执行许可必须分别从这些事实推导。
实际接线中，entry/rebuild 引用了共享 lifecycle 模块，live Worker 的 finalizeRequest 和
provider 结束分类仍在本地定义；“live gate、持久化、重建已经共用同一成功规则”尚未成立。
导入结构本身不另列阻塞项，修复以以下可复现行为及其不变量为准。

### 7.2 当前阻塞：恢复不能清空预算责任或未决状态

位置：`c6-request-lifecycle.mjs:196`、`:239`，由 `c6-entry.mjs` 在启动时直接使用。

`reconciliation_required` 的某侧状态为 committed 时，reducer 将 reservation 放入
settled set，从 pending 中移除，但没有把已发生责任加入该侧 consumed。
如果两侧都 committed，最后按 pending 数量推导 unresolved，结果也变成0。

由实际 Worker 产生、writer 接口故障注入得到的序列：

```text
provider calls = 1
Task/Campaign live consumed = 1/1
durable committed append -> {ok:false}
durable fallback -> reserved + reconciliation_required
commit_status = {task:committed, campaign:committed}

rebuild -> Campaign consumed=0, byTask empty
           Task/Campaign pending=0/0, unresolved=0, diagnostics=[]
```

单侧成功变体也失败：原预算5，已经发生一请求，成功侧重建后 remaining=5，正确责任应使
remaining=4。故障侧的 pending 留住了，成功侧的消费却被退掉了。

产品恢复反例进一步使用真实 EventLog：仅在 durable writer 的 committed 操作注入失败，
随后实际 append/fsync fallback reconciliation，并立即 SIGKILL。两个 Task 相互独立，
第二个仍 queued，避免终态/依赖阻断掩盖错误。重启从同一配置、同一完整事件链执行：

```text
provider calls after restart = 2       (应为0)
Broker effects after restart = 1       (应为0)
dataset.status = active                (应保持pending)
reconciliation = {unresolved_requests:0, diagnostics:[], blocked:false}
Campaign consumed = 2                 (丢失重启前已发生的1次)
```

完整性验证仍通过。这是语义重建错误。故障注入是 worker/writer 已承诺处理的失败接口；
没有伪造预期输出或直接编辑权威记录。此例不宣称真实 EventLog 的永久 fsync 故障会自行恢复：
永久写故障仍停止，只有 reserved 可用时的保守重建正例继续通过。

分类：**current_blocker / P0**。违反原任务书的恢复责任守恒与未决时禁止新 dispatch，
不是新增基础设施需求。对应 AR-02-task/campaign、AR-03、AR-04、AR-10，共5个失败。

### 7.3 当前阻塞：aborted 被当作正常结束，已有决策仍执行

位置：`c6-model-worker.mjs:1003`、`:1120`。

目前分类是 `stopReason === error ? error : ok`，SDK 的 aborted 被落入 ok。
真实 Pi agent-loop 对 error/aborted 都会结束运行并跳过该响应的 tool calls；Aegis 在
prompt 返回后却继续使用前一次工具调用留下的 decision buffer。

真实 SDK/faux 产品反例：第一请求调用 `aegis_task_decision` 缓冲合法动作，第二请求
返回 SDK 支持的 aborted 响应。不是直接设置 Worker 返回值或直接调用 Broker。

```text
provider calls = 2
durable second committed.provider_status = ok
Broker effects = 1
dataset.name = Ada                     (初态??；应保持??)
task-001 = completed                   (规划中止不应完成/执行)
```

同样流程第二响应为 error 的控制通过：provider2、Broker0、文件不变、Task unknown、
消费仍为2。正常结束的控制也通过，因此测试没有通过拒绝一切请求来满足负例。

分类：**current_blocker / P0**。中止/取消后继续执行真实写入，直接影响用户可停止性。
对应 AR-09-aborted_followup。该用例通过 faux 发出真实 SDK aborted 消息，未将 OS 信号
中止/远程服务取消的全部行为冒充已经测试。

### 7.4 新增覆盖矩阵与独立结果

脚本：`Pi_Agent_base/tests/aegis-c6-architecture-review.mjs`。
helper：`Pi_Agent_base/tests/helpers/c6-lifecycle-child.mjs`，保留原 restart 场景并增补新场景。

| 用例 | 层级 / 输入来源 | 契约与实际证据 | 结果 |
| --- | --- | --- | --- |
| AR-01 | integration / live worker records | 正常两侧消费、剩余预算、Task归属、无未决 | pass |
| AR-02-task/campaign | recovery / memory commit fault + live records | 两侧 consumed+pending 的责任重建不变，remaining=4 | fail ×2 |
| AR-03 | recovery / durable fault + live fallback | 已记账不等于联合结清；未决保留，预算不退 | fail |
| AR-04 | integration / rebuilt guard+ledger | 无 pending 但联合未结清时，独立下一 Task provider0 | fail |
| AR-05 | recovery / throwing durable writer | 原 reserved 保守重建，预算不退、未决可见 | pass |
| AR-06 | recovery / duplicate events + explicit full settlement | reconciliation→合法 committed 后只计一次，无悬挂 | pass |
| AR-07 | recovery / provider throw without completion | 两侧 hold+未决保留，责任不退 | pass |
| AR-08 | product+recovery / real SDK faux | 正常决策→真实effect→Oracle完成；重启provider0/effect0，消费2 | pass |
| AR-09-error_followup | product / SDK error response | 已缓冲决策不执行，文件不变，消费2 | pass |
| AR-09-aborted_followup | product / SDK aborted response | 已缓冲决策不执行，文件不变，中止不能完成 | fail |
| AR-10 | product+recovery / writer fault+real durable log+SIGKILL | fallback未决不消失，重启独立任务provider0/effect0 | fail |

独立结果（2026-10-14）：

- 原17个 C6脚本有效结果全部 exit0，包括 focused23/23、external22/22、DS convergence19/19、
  原真实 restart、product-chain、learning-closure；受影响26个回归有效结果全部 exit0。
- 初次受限执行：C6两脚本、回归四脚本因本机监听 `127.0.0.1 listen EPERM` 失败。
  仅这些脚本在允许本机监听后复跑，全部 exit0；初次失败日志及 argv/exit 保留，不将环境失败
  当作产品失败，也不将初次整批 exit1 改写为0。
- 新增架构脚本 **12 tests / 6 pass / 6 fail，exit1**；失败是行为断言，不是 import/语法失败。
- 扩展helper后独立复跑原 lifecycle-restart，exit0/all checks passed。
- Biome 检查 DS修改的产品/测试与本轮测试，共8个文件，exit0。
- Campaign tsc exit1，196条历史诊断；逐条与DS最终基线完全相同，Campaign诊断0。
- 本轮没有产品修复，故没有 green 或新的 mutation 结果；DS的历史mutation不是本轮独立证据。

日志根：`Pi_Agent_base/runtime/dev/c6-architecture-review-20261014/`（ignored）。
`c6-combined-results.json`、`regress-combined-results.json` 分别保留原始结果、监听复跑与
每脚本最终有效结果；所有批次的 results.json 包含 exact argv/exit/log。
补测见 `architecture-final.log`，原helper兼容性见 `original-restart-final.log`，
静态见 `biome-final.log`、`tsc.log`。公开样例只使用构造的临时数据，不含真实凭据。

新检查的精确命令（仓库根目录）：

```bash
node --test Pi_Agent_base/tests/aegis-c6-architecture-review.mjs
node Pi_Agent_base/tests/aegis-c6-lifecycle-restart.mjs
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json Pi_Agent_base/memory/campaign/c6-entry.mjs Pi_Agent_base/memory/campaign/c6-model-worker.mjs Pi_Agent_base/memory/campaign/c6-request-lifecycle.mjs Pi_Agent_base/memory/campaign/index.mjs Pi_Agent_base/tests/aegis-c6-lifecycle-convergence.mjs Pi_Agent_base/tests/aegis-c6-lifecycle-restart.mjs Pi_Agent_base/tests/helpers/c6-lifecycle-child.mjs Pi_Agent_base/tests/aegis-c6-architecture-review.mjs
```

### 7.5 有界收敛与 pilot 判定

当前保持 **changes_required**。下一步只要求闭合上述两组，不追加一个无边界架构重写阶段：

1. reducer 明确区分每侧预算责任与请求联合结清。reconciliation 中确认的消费按侧幂等恢复，
   未确认的责任继续保留hold；两侧已记账但无合法联合 durable settlement 仍为未决。
   后续合法完整 committed 不再双计；request/Task/Campaign关联保持一致。
2. 按真实 SDK stopReason 定义正常/错误/中止，不把“除error外都算ok”当成功规则。
   aborted保留已发生请求的费用，拒绝buffered decision进入Broker，并在结果/事件中保留中止事实。
   不需新增自动退款/重试/人工结算平台。
3. 保留新增12例，修成green。对这两个规则做有限行为mutation，跑受影响required回归与
   类型/静态基线；不降低原断言，也不因通过数量自行宣布external acceptance。

退出门槛是两组实际反例消失，正常控制继续有真实effect与可信验收，预算责任重建一致，
中止/未决不能触发dispatch。通过后可进入**有限真实任务pilot**，实测模型能否观察、规划、
完成任务以及经验收益。不存在“先做更多架构才能试”的额外要求。

不阻塞该有限pilot的事项：196条既有类型诊断、保守初始context pre-check、token估算精度、
UI/格式偏好、F16、OS sandbox、多Worker、自动结算平台与复杂经验组合。它们保持既有
边界和后置记录；真实provider计费、流式故障、模型效果属于pilot的测量目标。
有限pilot具体选择模型/endpoint、现有任务家族的小目录、授权、预算、独立Oracle和停止条件；
本次审查通过不应被扩大为任意目标/任意代码可安全无人值守生产运行。

## 8. d1a81c8 三个事实分离复验与 SDK 收尾补修

日期：2026-10-14。起始分支 `feat/c6-agent-product`，HEAD `d1a81c8`，工作树干净；
内嵌 Pi `42a3497d03ad17e308a2299fa824727894f2c0ec` 干净。
DS 的 `6d3f334`、`ca823c1`、`d1a81c8` 三次本地提交与报告一致。

### 8.1 认可原两组修复

逐文件检查本轮 diff、真实 SDK 结束路径、live Worker、入口持久化与重建、Composite→Broker。
reconciliation 现在按侧恢复 consumed，并独立计算联合 unresolved；Task seed 继续按归属隔离。
error/aborted 的 provider 结束路径保留类别、消费与失败返回。原第7节两组反例实际复跑全部消失：

- 单侧成功重建 remaining=4；两侧成功但缺联合 durable commit 仍 unresolved=1。
- 真实 EventLog+SIGKILL 后独立 queued Task provider=0、Broker effect=0、责任=1、链完整。
- 真实 SDK aborted/error follow-up provider=2、消费=2、Broker effect=0、文件不变、Task unknown。
- 正常控制仍有真实文件 effect、Oracle completed，重启不重复 provider/effect。

原18个 C6 与26个回归在当前代码独立复跑全部 exit0。初次受限执行的 external C6-X9 因
本机 `listen EPERM` 失败；单独 listener 探针确认权限原因，获准本机监听后 required 全部通过。
沙箱失败不算产品失败或 pass；没有用 DS 历史日志替换当前复跑结果。
DS 私有 results 的18/26数量与退出码、red 日志、5项 mutation 日志已核对；本会话没有把
DS 的5项 mutation 宣称成独立复跑。

### 8.2 发现并直接修复的同一终止接线盲区

`d1a81c8` 的规划分类仍放在 `if (gate.outstanding)` 内。provider response 已结清之后，
真实 SDK 保存工具结果或收尾失败，可合成 assistant error；此时没有新 reservation，规划错误
被忽略，先前的 decision 仍进入 Broker。这是第三个事实与 request outstanding 继续混用。

新增 AR-11 只让真实 SDK `SessionManager.appendMessage(toolResult)` 抛一次错误，其余仍为
真实 SDK/faux、Worker、Broker、Oracle、EventLog，不直接伪造 Worker/Broker 返回值。

| 同一输入 | `d1a81c8` red | 本次补修 green |
| --- | --- | --- |
| SDK 工具结果保存失败 | SDK 合成 error，provider1，已消费1 | 同左 |
| 请求账务 | 一条合法 committed、unresolved0 | 同左，合成 error 不增加或改写 provider 账务 |
| 规划/动作 | Broker effect1、文件 name=Ada、Task completed | planning_error、Broker effect0、文件 name=??、Task unknown |

补修：所有 assistant message_end 都更新规划状态，实际有 outstanding 的响应才做请求记账；
raw prompt throw 也阻断动作；最终未知状态不继承先前 normal；分类器只接受当前 SDK 的显式
正常枚举，其余保持 unknown。复用现有 Scheduler 的 unknown/reconciliation 事件持久化规划失败，
不把已结清请求重新变成 pending，不新增平台或改 Pi。

新增聚焦用例 LC-B8-error/aborted/prompt_throw、LC-B9，以及 LC-T1 的未知值断言。
旧产品上的 AR-11 和最初4个聚焦断言实际为行为 red，日志完整保留。最终架构13/13、
convergence26/26；原 AR-08/09/10 和生命周期恢复继续通过。

### 8.3 最终独立验证与证据

| 检查 | 本会话最终结果 |
| --- | --- |
| explicit required | 18个 C6 + 26个回归，共44个脚本，0 failed |
| architecture-review | 13/13，含真实 SDK 收尾失败与正常/中止/硬重启控制 |
| lifecycle-convergence | 26/26 |
| recheck / external | 23/23、22/22 |
| lifecycle-restart | all checks passed |
| Biome | 8个相关代码/测试文件，exit0 |
| Campaign tsc | exit1，196条历史诊断，与本会话补修前逐条相同；修改文件0条 |
| 本会话有限 mutation | 隔离副本正常控制pass；终止更新依赖 reservation、unknown沿用normal，2/2因行为断言失败 |

日志根：ignored `Pi_Agent_base/runtime/dev/c6-three-facts-external-20261014/`。
`required/results.json` 是补修前44个脚本复跑；`final-required/results.json` 是最终44个脚本，
均包含 exact argv/exit/log。`late-sdk-red.log`、`termination-red.log` 是新增行为失败；
`external-mutations.json` 与对应日志是隔离 mutation；`static-results.json`、`tsc-final.log`、
`biome-final.log` 是本次静态/类型结果。未使用真实凭据或调用真实 provider。

### 8.4 限定出口

DS 原两组修复认可，本会话发现的同一规划终止遗漏已补齐。当前冻结工程门槛通过，
可以推进现有任务家族、小目录、有限预算、独立 Oracle 的真实任务 pilot。
真实 provider 流式故障/计费/模型效果仍由 pilot 测量；既有196条类型诊断、保守pre-check、
精确token估算、F16、OS sandbox、多Worker不重开此轮工程范围。

本次证明 SDK error/aborted 后不执行。不要据此声称 SIGTERM 能立即撤销正在运行的 Task：
当前 Host/Scheduler 的持久控制在 Task 调度边界生效，SIGTERM 为 drain，活动 Task 可能继续
完成；强制退出后的 unknown 恢复另由 SIGKILL 用例证明。有限 pilot 按这个停止语义运行，
不把“收到了控制事件”当作所有 provider/工具已即时取消。真实 pilot 本轮未启动。
