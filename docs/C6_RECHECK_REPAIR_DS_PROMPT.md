# 给主 DS：C6 请求门三项限定修复

以下正文可直接转交 DS。

```text
你是 Aegis 项目的主 DS，负责 C6 最后一轮复验中请求门的三项限定修复。

工作目录：/Users/scemac/My_github/Aegis
任务分支：feat/c6-agent-product
产品修复交付基线：22d075c
新增 red 测试及审查提交：85b1d1d
开始时核对实际 HEAD、分支和工作树；本提示词及阶段入口可能有后续文档提交，
以实际 HEAD 为准，保留用户和其他任务已有改动。

这是一次总修复任务：自主实现、测试、自审和本地提交，完成后交回限定工程复验。
不逐个 helper、内部里程碑或 commit 请求用户批准。

一、阅读依据与范围

完整阅读：
- Pi_Agent_base/AGENTS.md
- docs/AGENT_DEVELOPMENT_STANDARD.md，尤其 §3.1
- docs/AGENT_TESTING_STANDARD.md
- docs/GIT_STANDARD.md
- docs/DS_ORCHESTRATION_WORKFLOW.md
- docs/C6_AGENT_PRODUCT_TASK.md
- docs/C6_EXTERNAL_REVIEW.md，当前结论以第5、6节为准
- docs/C6_RECHECK_REPAIR_DS_PROMPT.md
- 当前 C6 plan/matrix/implementation report/runbook
- c6-model-worker.mjs、c6-entry.mjs、c6-tool-ledger.mjs 及真实相关调用点

涉及 SDK 时完整阅读相关 SDK/extension 文档、例子和真实类型，核对 provider-bound
streamFunction、llmContext、message_end 与 prompt 完成的真实语义，不凭记忆编造 API。

已有五组修复已获限定认可：原15个 C6 脚本独立通过，原外部边界22/22、
recheck既有13/13；合法验收/提前退出、真实路径/当前Task grant、runner初态、
真实reset/Replay/active/第三Task NEW动作与结果/零规划请求均有证据。
这些结果保留，不再次整体委派五组修复或旧X1-X12，不重开C1-C5。

当前仅剩同一请求门的 C6-R12/R13/R14。它们违反原调用前预算、持久故障停止和
每请求输入窗口要求，仍属当前阻塞；C6状态保持changes_required。
不新增缓存、并行、容器、通用benchmark、真实计费或学习收益门槛。

二、修复 C6-R12：最后一次 durable commit 必须在决策放行前确认

直接复现：
最后一次provider请求完成，persistRequest(committed)返回ok:false；
没有下一次请求，decisionBuffer已有合法动作，worker.run却返回ok:true。
现有代码仅在NEXT streamFunction入口等待gate.pendingCommit，末次未flush。

要求：
- prompt结束后、任何可执行决策成功返回前，确认最后一次权威请求提交结果。
- 持久回调返回非成功或throw均停止，返回accounting_failure与reconciliation。
- 记账失败时不把缓存决策交给CompositeWorker执行Broker效果，不推进依赖任务。
- transport、预算拒绝及异常退出路径保留真正根因，正确恢复provider wrapper和订阅。
- 保留已发生请求的consumed/pending语义，不假称请求没发生或重启后可免费重发。
- 不用catch吞错、不等待的append或仅保护“还有下一请求”的分支制造通过。
- 保留R6（NEXT请求停止），同时让R12（无NEXT、已有决策）通过；
  补相关产品接线证据，确认失败后没有新增Broker效果。

三、修复 C6-R13：Task和Campaign联合调用前准入

直接复现：
Campaign请求额度0，Task额度5，实际provider仍被调用4次。
原因是provider gate只向activeLedger准入，Campaign只在message_end事后mirror。

要求：
- 每次真实provider调用前同时执行Task和Campaign额度/wall-time准入，
  consumed及pending均计入余额。任一层拒绝，provider调用次数为0。
- 两层ledger为同一对象时只预留/计费一次；不同对象时各自恰好一次。
- 同一实际request须有稳定身份，关联两层reservation与durable记录，
  committed后从权威源可重建两层consumed/pending，避免漏扣或重复计费。
- 先校验/预留，再持久确认，最后调用provider；当前先写reserved而尚无
  reservation_id的顺序要修正，不给重启留下null reservation伪记录。
- 联合预留中途拒绝、持久失败或provider可能已发生时，清晰处理预留与停止状态；
  不能释放可能已发生的费用并静默继续。提交保持幂等。
- 保留工具及Broker动作已有额度规则，不借机重建预算框架。
- 覆盖Campaign余额0/耗尽/pending、Task耗尽及合法联合准入，
  用真实provider调用计数和重建数值证明，不只断言reason文字。

四、修复 C6-R14：每请求窗口计算实际provider输入

直接复现：
max_total_input_chars=2000，实际llmContext.messages含10000字符，provider仍调用1次。
当前gate重算cached prompt/catalog/RAM，未使用实际llmContext；
historyCharsProvider默认为0，入口也未传入实际history。

要求：
- 在每次provider-bound调用处按SDK真实格式计算当前transcript/system/tools/schema，
  包括真实history、tool results、RAM/ROM及输出预留。
- 首请求和自动tool loop/continuation均受同一窗口限制，超限前不调用provider。
- 初始prompt的廉价预检可以保留，但不能替代实际请求边界的检查。
- 明确定义字符估算的覆盖项，避免实际已包含的内容重复计量；
  字符估算与可观测token分开报告，不可测token保持unknown。
- 窗口不是累计输入成本，不乘请求次数；不能静默丢弃必要约束让请求装得下。
- 保留R14大messages反例，补合法输入及实际tool schema/tool-result续请求覆盖。

五、测试与检查

现有正常red测试必须保留：
node --test Pi_Agent_base/tests/aegis-c6-recheck-boundaries.mjs

审查提交85b1d1d及本次会话恢复复跑结果均为：
16 tests / 13 pass / 3 fail，exit1；失败恰为R12/R13/R14。
历史证据：Pi_Agent_base/runtime/dev/c6-final-review/final-guards.log、remaining-results.json。
恢复复跑：Pi_Agent_base/runtime/dev/c6-session-resume/recheck.log、results.json。
这些目录ignored，不提交原始日志。

不能删除/skip/标expected-failure或降低预期制造绿色；fixture如确与契约冲突，
说明具体依据后调整，仍须覆盖原行为缺陷。
先focused修复，再全部15个C6脚本与受影响显式回归；保留原有效正负断言。
使用真实SDK+faux与受控失败回调，依据实际请求数、权威记录、pending重建、
Broker效果及清理结果判断。SDK测试使用source resolver。
逐条保存exact argv、真实exit和私有日志，不以管道尾部成功掩盖失败。
有限mutation仅按本轮关键guard选择，行为FAIL与import/syntax错误分开。

Biome检查修改范围。Campaign类型检查继续覆盖本次修改；
本次复验基线为tsc exit1、196条既有诊断、Campaign0条。
修新增诊断，不用any/@ts-ignore、关闭checkJs、排除修改文件或降规则吞错误；
不要求无关旧库全清零。
复用现有C6计划、矩阵、报告及runbook，仅更新三项修复/证据/限制。

六、所有权与Git

只改相关Aegis-owned文件，主DS统一管理共享Worker/SDK/ledger/Host接口。
有子Agent能力才分派不相交文件，否则串行并如实记录。
逐路径暂存、阅读staged diff、按可审查单元本地提交，正文注明Agent协助。
不push、不改写历史、不清理无关改动。
不改Pi核心、用户auth/models/settings或lockfile，不安装未授权依赖，
不读取真实凭据、不调用真实provider/API/外部目标或验收模型。

必要且不改变既定契约的修复自主完成；如确需扩大授权、降低证据门或修改Pi核心，
停止受影响部分并说明真实blocker与最小方案，其他独立工作继续。

七、交付

交回R12/R13/R14对应表、exact argv/exit/private logs、旧red→新green、
实际provider调用数、联合reservation/commit/restart数值、末次记账失败无Broker效果、
实际transcript窗口检查及正常请求、相关回归/静态检查、commits和准确工作树状态。
将状态标为internally_verified / awaiting_external_review，或实际changes_required / blocked。
不自行宣布外部通过。

本轮冻结工程目标通过后，再由用户单独确定真实环境模型、任务范围与预算。
F16、真实模型pilot、上下文校准、收益对照、迁移/日常试用等后置项保持后置。
```
