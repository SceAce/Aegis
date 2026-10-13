# C6 限定工程审查：changes_required

状态：**changes_required；暂不进入实际环境实验**。
最新修复基线 `22d075c` 的复验见第5节；初轮及35b053a复验保留为历史证据。
五组修复原有用例与真实第三任务复用均已通过，provider gate仍有3个同路径遗漏，状态保持changes_required。
审查基线 `7b7e92d` / `feat/c6-agent-product`，开始工作树干净；内嵌 Pi `42a3497d0` 干净。
本轮按用户要求复核 DS 交付并补其他测试，未修改产品代码、未运行真实模型/外部目标。
正常 SDK/faux + 本地 Broker 效果已成立，但以下缺陷和缺失接线违反原 C6 冻结承诺。
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
