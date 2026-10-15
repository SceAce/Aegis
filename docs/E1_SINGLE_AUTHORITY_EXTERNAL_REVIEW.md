# E1 Single Authority 独立复审

日期：2026-10-16。结论：**changes_required**。

审查对象是 `fix/e1-single-authority` 上相对于 `ba0947147a482c27ff9fa185c8cc432239c116ff`
的 Opus 未提交实现及测试。它确实修复了前轮多处问题，但“所有消费者使用同一权威结果”
尚未成立：请求结清、工具计费、工具执行、完成/激活/依赖、Broker 效果仍有语义断点。
新增独立脚本 13 项中正常主链对照通过，12 项边界失败，按根因归并为下述 6 组当前阻塞、
2 组当前非阻塞产品问题；另有 1 个验证辅助脚本问题。失败数量不等于独立缺陷数量。

本轮只修改自己的审计测试并新增本报告，没有修补产品实现，没有覆盖旧报告。
Opus 实现继续保持未提交；用户已有 `E1_CONTRACT_CLOSURE_DS_PROMPT.md` 修改保持原样。

## 1. 固定依据与判定方法

- 整体架构固定为 [SYS-20261015-01 / B01–B14](SYSTEM_ARCHITECTURE_BASELINE_AUDIT_20261015.md)，
  没有以重构代码或新增测试反向改写准则。
- 具体接口固定为 [E1-CC-1.0](E1_CONTRACT_CLOSURE_TASK.md)：§4 冻结上下文、§5.3 执行许可、
  §6 Host 命令与幂等、§7 双侧预算和固定工具协议、§8 共同结果有效性。
- 保留 C6 三事实：每侧消费责任、request 联合结清、planning termination 相互独立。
  `committed` 标签、`pending=0`、工具 `finished` 或历史 `completed` 均不能替代完整事实。
- 依 [开发规范 §3.1](AGENT_DEVELOPMENT_STANDARD.md)，只有当前可达、破坏当前核心承诺的反例
  作为阻塞；拒绝过严、只读可用性和辅助脚本问题单列，不用测试失败数决定阶段结论。

检查贯穿 Manifest/config → 产品入口 → SDK request/tool → Host → projection →
Scheduler/Broker → Oracle → Board/RAM/Observer/rotation/rebuild。
主要接缝使用真实 SDK + faux 正常流取得前缀，再做受控事件变换；重算事件摘要链，
并验证正对照。Broker 用真实 `createBrokerWorker` 和 Composite，adapter 使用计数替身。
没有调用真实 provider、目标或付费服务。

## 2. 已认可的修复

以下改善有代码及本轮回归支持，不建议回退或另起一套架构：

1. Host 自己调用 `compilePlanAdmission`，live/replay 共用计划编译器；调用者传入的
   admission 不再具有授权效力。计划/候选/charge/finish 共用短序列器并写后重放确认。
2. allocation 累计、预算安全整数、动态 Task 完整摘要、预算别名冲突检查得到加强。
3. 新运行在请求前持久化 Manifest，补齐 file/dir fsync；已存在同内容分支也补齐确认，
   非 ENOENT 读取错误被拒绝。
4. artifact 按物理前缀索引，后来的 artifact 不能追溯使先前 claim 合法。
   accepted start、Outcome 绑定、合法 supersedes 和环境失效已有实质收敛。
5. Board 的 Campaign start/admission/correction 不再独立扫描原日志重新判定。
   Observer/supervisor 已增加 Manifest 上下文传递。
6. read/submit 收费、真实 provider request 与 toolCall 绑定、`await pendingCommit`、
   SDK `executionMode: "sequential"` 已接入。接线存在不等于下面所有边界已闭合。

正常 SDK/faux 对照为 **8 requests / 3 Broker effects / unresolved=0**；正常主链没有被
新增反例的拒绝预期替代。

## 3. 当前阻塞

### R-S01：新的 request 索引弱化了已接受的 C6 联合结清规则

位置：[authority.mjs](../Pi_Agent_base/memory/campaign/authority.mjs) `indexRequestRecord:244`、
`evaluateToolCharge` 的 request 检查；[scheduler.mjs](../Pi_Agent_base/memory/campaign/scheduler.mjs)
工具 charge 命令。依据 B07、E1 §7.2。

复现 SA-01：取真实 dyn-a request 的 committed 前缀，只把结清状态改为
`{task:"committed", campaign:"failed"}`。原 C6 `summarizeRequestLedger` 正确给出
`unresolved=1`，但真实 Host `chargeTool` 仍 `ok=true`，charge 被 projection 接受。
相同健康请求的 charge 正对照成功。

新索引只记 phase/task/provider_status，未沿用原联合结清校验，丢掉 reservation、
provider_started、双侧 commit_status 等必要事实。共同 authority 因此可以把 C6 仍保留的
未决责任变成工具执行许可。此测试证明 Host/replay 接口接受了不合法结清前缀；不声称
本轮已经观察到 SDK 正常 live 路径在部分 commit 后实际执行工具体。

修复约束：把既有 side-aware request reducer 的联合结清结论纳入 authority，保留逐侧消费
和 unresolved；不能复制一个弱版 `committed` 解释，更不能通过放宽旧 C6 reducer 消除分歧。

### R-S02：entry/status/recovery 账本仍有独立的原始日志解释和可变协议选择

位置：[c6-request-lifecycle.mjs](../Pi_Agent_base/memory/campaign/c6-request-lifecycle.mjs)
`summarizeRequestLedger:172`、协议选择 `:338`、`chargesFromEvents:416`；
[c6-entry.mjs](../Pi_Agent_base/memory/campaign/c6-entry.mjs) `:602`、`:1253` 等调用点。
依据 B03/B06/B07/B10、E1 §7.2。

- SA-02：真实前缀中追加 context_digest 不匹配的 charge，authority 明确拒绝；entry 使用的
  ledger rebuild 仍计入，工具数为 **2**，authority 为 **1**。
- SA-03：legacy request 的工具消费为 **3**；追加任意 LLM 来源的最小 `{kind:"c6.tool"}`
  后，rebuild 自动切 durable 协议，把已确认消费变成 **0**。

调用者没有把 accepted `tool_charges` 传入，fallback 只验少量形状/source/version。
协议又由“日志里出现过某类记录”决定，mixed 只增加 diagnostics，没有形成执行 hold。
这是预算状态错误，不能以“context-free 诊断视图”解释当前产品入口的调用。

修复约束：协议取自运行的冻结契约；legacy 流继续按其固定协议。live/rebuild/status
只使用同一 accepted charge 集合与 request 状态；E1 混入 legacy 记录时保留责任并 hold。
上下文不足应显式不可执行，不能用弱扫描结果当权威消费。

### R-S03：收费幂等没有闭合工具执行幂等

位置：[c6-model-worker.mjs](../Pi_Agent_base/memory/campaign/c6-model-worker.mjs)
decision `:486–528`；[scheduler.mjs](../Pi_Agent_base/memory/campaign/scheduler.mjs)
charge duplicate 返回分支。依据 B04/B06、E1 §7.2。

SA-04 通过真实 Host charge/finish 和真实 decision tool，以相同 request、toolCallId、
参数调用两次。第一次正确 buffer 1 个 action；第二次 charge 正确去重且原记录
`finished=true`，但 tool 只看 `ok`，再次把 action 入队。实际为 **1 charge / 2 buffered actions**。
本用例直接证明重复入队，没有把计数替身说成已经产生了重复文件写入。

read/submit 也只检查 charge 的 `ok`，存在同类结果复用缺口；它们的重复工具体行为本轮
未分别做直接效果测量，后续修复需覆盖全部工具。

修复约束：工具执行适配器区分“首次已收费可执行”“同绑定同参数且有结果可复用”
“已收费但无可复用结果”。后者返回 duplicate_in_flight/unknown 并 hold；不能因
`duplicate=true` 或 `finished=true` 再入体。live cache 绑定完整身份和参数，恢复后没有
可验证 committed tool-result 时不能重读、重交或重放动作。

### R-S04：共同 permit 只检查到 Composite，没有到达每个实际 Broker 效果

位置：[c6-entry.mjs](../Pi_Agent_base/memory/campaign/c6-entry.mjs)
`createCompositeWorker:201`、`:238`、接线 `:1268`；
[broker-worker.mjs](../Pi_Agent_base/memory/campaign/broker-worker.mjs) `runStep:168`、
`await intent` 后的 `broker.invoke:208`。依据 B04、E1 §5.3/§8.1。

Composite 在 model 完成后检查一次，随即把整批交给 BrokerWorker。BrokerWorker 每步的
旧 grant 重验仍然存在，但没有最新 authority/time/dependency permit。

- SA-07：无失效对照产生 2 次 invoke；在 intent 持久化等待期间推进可信时钟至 deadline，
  authority 已拒绝，实际仍 **2 effects**，预期 **0**。
- SA-08：第一步完成后写入合法前置事实失效，authority 返回 dependency_invalidated，
  第二步仍执行，实际 **2 effects**，预期 **1**。

两项使用真实 BrokerWorker 的步骤循环、intent await 和 Composite，替身仅位于 adapter
效果出口。没有依赖固定 sleep，也没有替换 authority 的判断结果。

修复约束：在每一步 durable intent 之后、实际 invoke 之前取得最新状态并检查共同 permit，
覆盖 model 和 direct 路径。不能缓存整批许可。拒绝作为 hold/运行失败，保留已发生效果和
审计事实，不伪造 Oracle failure，也不自动重试。

### R-S05：完成、激活、依赖没有使用同一个有效判定聚合

位置：[projection.mjs](../Pi_Agent_base/memory/campaign/projection.mjs)
`isSatisfied:309`、`campaign.plan.ready:824`、`applyOracleResult:983`、
`completeTaskIfVerified:1140`。依据 B08/B09/B10、E1 §6.3/§8.1。

- SA-06：dyn-c 已 ready；追加合法的 dyn-a 同 stage/criterion failure，使用新的 outcome_id，
  没有 supersedes。它被接受并标为 effective，但旧 success 仍满足“存在任一 success”，
  dyn-c 仍 **ready**，预期 **queued**。无 supersedes 的矛盾应保守 unknown/invalid 并诊断。
- SA-10：在真实 dyn-a completion 之前插入合法 environment.changed，确认其 effective
  judgments 已为 0，再追加原 completion。该**新增** completion 未被拒绝，任务变为
  `state=completed / effective_status=invalidated`。
- SA-11：planning 已完成但 ready 尚未写入时，先使 planning 判定失效，再追加原 ready。
  planning 明确为 invalidated，动态 children 却解除 awaiting_plan_ready，dyn-a/dyn-b 变 ready。

SA-10 检查的是失效之后的新完成转移，不要求删除失效之前合法 completed 的历史。
SA-11 则直接证明同一 projection 一边宣布规划依据失效，一边授予子任务执行资格。

根因有三处：依赖只检查 stage 存在 effective success，没有完整 criterion/conflict 聚合；
completion 从历史 stage_outcomes 和 task_outcome_status 重新聚合；ready 又只看历史
completed/status。把它们放在同一文件中没有消除不同有效性定义。

修复约束：先计算按 Campaign/Task/Episode/Stage/criterion/subject/scope 绑定的当前
判定集合，处理 supersedes、环境失效和未消解冲突，再由同一聚合结果驱动完成、ready、
依赖和消费者 Fact。保留历史完成，独立表达当前有效性；已启动子任务在后续请求/效果边界停止，
已完成效果不回滚、不自动重跑。

### R-S06：可编辑 config 可以关闭冻结运行的 E1 工具协议

位置：[c6-entry.mjs](../Pi_Agent_base/memory/campaign/c6-entry.mjs)
planning context 分支 `:306`、`durableTools:664`、request 记录 `:1176`。
依据 B01/B06/B07、E1 §4.2/§7.2。

SA-12 在真实合法 ready 前缀上保留不可变 Manifest、绑定和事件，只把隔离 config 的
`planning.enabled` 改为 false。通过真实产品入口 + SDK/faux 恢复，结果 `ok=true`，
**4 次 provider 请求、2 次实际 read 工具体、0 条新增 c6.tool charge**；新增 request
也没有固定 durable tool_accounting。预期为 planning_context_conflict 和零新请求/效果。
测试最后恢复隔离 fixture 的 config/events，没有改真实用户配置。

入口只在 config 说 enabled 时验证 planning authority，durableTools 也由同一可变字段
决定，因而通过了 Manifest digest 对比却改变执行/收费语义。这比视图显示差异更严重。

修复约束：先从运行绑定定位冻结 Manifest，执行协议由它决定；当前 config 只能核对，
不能关闭或降级。任何与冻结安全语义冲突的 config，在建立 SDK 执行入口之前拒绝。

## 4. 当前非阻塞问题

### R-S07：规划完成后的 exact admission retry 被错误拒绝

位置：`scheduler.mjs:338`、`:367`、`:435`。依据 E1 §6.1/§6.2。SA-05 以完整正常流
调用相同 `admitPlan`，本应返回原 transition_event_id、duplicate 且不写新事件，实际先被
“planning task 必须 running”拒绝。新命令的执行条件与历史幂等查询混在一起。

应先验证完整既有身份/编译定义，再返回原 accepted 结果；这不授予新执行许可。
目前为拒绝过严，不扩大权限或产生效果，故不单独阻塞正常主链；在暴露通用重试客户端前修复。

### R-S08：只读 status 不能在可编辑 Manifest 改变后展示冻结运行

位置：`c6-entry.mjs:401–443`。依据 E1 §4.2/B14。SA-09 只改隔离配置引用的可编辑
Manifest budget，保留冻结副本和日志；status 正确没有追加事件，却返回
planning_context_conflict，无法展示旧运行。这里执行拒绝有依据，只读拒绝不符合契约。

status/export 应使用被绑定的冻结副本并显示当前 config 差异；执行仍拒绝冲突。
本轮直接验证 status，其他只读命令共用前置分支属于源码可见影响。保留原配置即可读，
故列为当前非阻塞可用性问题；不能因此宣称 §4.2 已全闭合。

### R-S09：新 run-required.sh 失败时可能以 exit 0 结束

[run-required.sh](../Pi_Agent_base/tests/helpers/run-required.sh) 统计 fail 后最后执行 echo，
没有 `exit` 传播失败；注释声称“68 plus review”，实际只有 required JSON 清单。
本项为源码审查结论，本轮没有用它作为验收入口，也没有为了演示再次运行整套失败流程。
应让失败/缺 results 都退出非零，并准确列出执行清单。当前独立证据使用既有
`c6-suite-runner.mjs` 捕获各脚本退出码，未受到此辅助脚本影响。

## 5. 对 Opus 测试说明的独立核实

Opus 对两条旧 Codex 断言的异议成立，本轮已纠正自己的测试，不把它们报成实现缺陷：

- XR-13 原预期 3 只算 decision。§7.2 同时要求 submit_plan 收费，正常流应为 4；
  修改为 4，并额外断言其中恰有 1 条 submit_plan charge。
- XR-22 原检查 dyn-b，但它不依赖 dyn-a。改为 dyn-b 完成后检查真实依赖 dyn-c，
  先断言 dyn-c 确实依赖 dyn-a 且 ready，再断言失效后 queued。

纠正后原审查 **30/30**。这两项是旧审查断言错误，不是“实现绕过了审查”。

已检查 fixture 迁移的主要理由：缺 planning contract 的 stub Host 不能继续假定调用者
admission 已获授权；charge 需要真实 provider/request 前置事实；evidence 要有完整 digest。
recovery 不再跨工作目录复制前缀也有依据，因为 workspace 是 Manifest 身份的一部分。
这些迁移不能替代额外的负例：本轮反例保留合法前置条件和行为断言，仍暴露当前接缝缺陷。

## 6. 独立验证及证据

本轮证据根目录（ignored，不提交日志）：
`Pi_Agent_base/runtime/dev/e1-contract-closure/single-authority-review/`。
`input-identity.json` 记录分支、HEAD 和 Opus 输入文件 SHA-256；最终核对全部相同。
内嵌 Pi 为 `42a3497d03ad17e308a2299fa824727894f2c0ec`，工作树 clean。

| 检查 | 本轮实际结果 | 证据 |
| --- | --- | --- |
| required 清单 | 68 个唯一脚本最终均 exit 0，无遗漏 | `summary.json`、`required-groups.json`、`required/*/results.json` |
| listener 环境限制 | 初跑 8 项因沙箱不允许本地监听失败；获准放行后 8 项均 exit 0，未修改用例 | `listener-rerun/results.json` 和各 log |
| Opus invariants | 8/8，exit 0 | `initial/aegis-e1-authority-invariants.log` |
| closure 四脚本 | 19/11/11/10，共 **51** 项通过 | `initial/results.json` 及 `required/closure/` |
| 旧独立审查 | 初跑 28/30；纠正 XR-13/22 后 30/30，exit 0 | `initial/`、`final-formatted/aegis-e1-contract-closure-review.log` |
| 新独立边界 | 13 项，1 pass / 12 fail，无 skip/cancel，exit 1 | `final-formatted/aegis-e1-single-authority-review.log` |
| Campaign tsc | exit 1，194 diagnostics，与旧基线全文相同 | `tsc-campaign.txt`、`type-comparison.json` |
| Batch-E tsc | exit 1，186 diagnostics，与旧基线全文相同 | `tsc-batch-e.txt`、`type-comparison.json` |
| Biome | 28 个相关实现/测试文件，exit 0 | `biome-result.json`、`biome.log` |
| git diff --check | exit 0 | `diff-check-result.json` |

51 是本轮实际运行数量：contract 现为 19 项，不能照抄旧 DS 报告的 18/50。
类型检查是**基线未恶化**，不能称类型检查通过。

复现新边界和纠正后的旧审查：

```bash
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs \
  Pi_Agent_base/runtime/dev/e1-contract-closure/single-authority-review/reproduce \
  aegis-e1-single-authority-review aegis-e1-contract-closure-review
```

runner 自动为需要真实 SDK 的新脚本加 source resolver。当前预期总 exit 1；失败是待修复
回归证据，不是 expected-failure 或 skip。完整 required 分组的精确命令保存在
`required-groups.json`，本地 listener 放行的实际命令保存在其 results.json。

类型检查精确命令：

```bash
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json --pretty false
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis.json --pretty false
```

最终边界运行生成的有界诊断位于
`Pi_Agent_base/runtime/dev/e1-contract-closure/single-authority-boundaries/run-VMIjLN/`：
`partial-commit.json`、`conflict.json`、`broker-{none,intent,between}.json`、
`stale-completion.json`、`stale-planning.json`、`disabled-planning.json`。
SA-02/03/04/05/09 的数值/原因在最终测试失败日志中。

审计夹具自检：初版新脚本的内存 sink 缺 schema_version，曾导致合法 charge 正对照失败；
修正该夹具后才取得上述结果，没有把该次前置错误计为产品缺陷。

## 7. 修复顺序与验收范围

1. **先冻结运行身份与协议入口**：修 R-S06，并使只读路径按冻结副本工作（R-S08）。
   所有后续消费者共享同一份已定位、已核验的 Manifest/context。
2. **收敛 request/charge 状态**：修 R-S01/R-S02，继续复用既有 C6 三事实语义，
   明确 accepted charges、固定协议、mixed/unfinished/持久故障的 hold。先取得 live/rebuild/status
   同前缀一致性，再修改工具执行门。
3. **收敛有效判断聚合**：修 R-S05，让完整 required criteria、冲突、修正与失效先产生
   一个当前聚合，完成/plan-ready/依赖/Fact 消费它。保留历史状态与当前状态的区别。
4. **接通实际执行边界**：修 R-S03/R-S04，逐工具落实结果复用门，逐 Broker step 在 intent
   await 后重新检查最新许可；覆盖 direct 路径。R-S07 的 exact retry 同时与执行许可分离。
5. **集成验证**：新增边界转绿、旧 30 项和 invariants 保持绿、受影响 C6/closure 回归，
   再按 frozen required 清单收尾；保持两个类型基线，修正辅助 runner。报告逐 consumer 接线
   和剩余限制，不以汇总绿色代替实际效果/恢复证据。

以上约束已有架构，不要求新增权限服务、重写 Pi、另建账本或新增自动 reconciliation。
每个修复都需同时验证正常对照、拒绝后的消费/状态和零新增效果，避免“全部拒绝”伪修复。

## 8. 未确认范围与诚实限制

- `c6-entry` 通过 raw find 选择首条 runtime start，尚未在入口证明它就是 accepted binding；
  已有日志但无 start 的分支也值得核验 legacy_context_unavailable。本轮没有给这两点新增
  直接行为反例，不把它们计入已确认阻塞；修 R-S06 时应连同缺失/foreign/被拒 start 核实。
- Board/RAM/Observer/rotation 的已有回归通过，相关接线已审；本轮没有把所有新增 E1
  拒绝场景逐一经过每个 consumer 的完整产品进程。不能据此声称逐 consumer 验证完成。
- 没有新增工具 charge 专属 SIGKILL barrier 或 mutation 实验。required 内原有恢复测试
  通过，不等于覆盖新收费边界的每个 crash 点；不得照抄旧交付声明作本轮新证据。
- F16 缓存优化、真实 provider/目标、真实学习收益与跨任务泛化继续后置，不因本轮审查
  重开已接受的其他阶段。工程验收尚未通过，也没有启动付费试验。

本轮审计交付仅包含新边界脚本、XR-13/22 的有据纠正和本报告；产品修改由后续实现者处理。
