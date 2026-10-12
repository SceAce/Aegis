# C1 F7–F9 修复后的外部复核：仍需修复

状态：**C1 changes_required / C2 blocked**。
审计对象：基线 `abd7ced` 的产品实现、DS 的 F7–F9 交付与第一批补充测试 `ab4a988`。
本轮只修改测试与开发/审计/委派文档，不修改产品实现。

本文件替换本会话早先尚未提交的“external_verified / C2 unblocked”草稿。
第一批补充测试全绿不足以确认信任绑定与恢复完整性；更深入复核已得到以下行为反例。
不把 DS 自测、历史 mutation 报告或新测试数量当作外部通过证明。

## 1. 实际运行结果

原有 15 个 `aegis-campaign-*.mjs` 脚本全部 exit 0；第一批新增
`aegis-campaign-c1-final-audit3-adversarial.mjs` exit 0，包含 **19 个自定义 ok 块**，
此前本会话说“18 个”计数有误。它不是 19 个 Node 测试文件。

最新 `aegis-campaign-c1-external-boundaries.mjs` 使用 `node:test`：
**21 个用例，2 pass / 19 fail，exit 1**。失败均为行为断言，非 import/syntax 错误。
两个合法正例分别证明纯投影与真实 Scheduler + EventLog 可以完成，避免“全部拒绝”伪绿。

另已独立运行：

- 8 个 offline 脚本 exit 0：workflow-evidence-d、workflow-engine-d、runtime-core-smoke、
  runtime-effective-board、memory-runtime-batch-b-smoke、memory-runtime-learning-evidence-smoke、
  observer-smoke、learning-bridge-e（文件名含相应 aegis 前缀）。
- 4 个真实 Pi SDK/faux 脚本 exit 0：observer-data-use-pi、observer-verify-first-pi、
  observer-outcome-command、observer-failclosed-pi，使用 source-resolver 入口。
- Campaign 模块及本轮两份测试 Biome check exit 0。
- `tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json` exit 1：
  `memory/fixture/contracts.mjs` 2 个、`memory/runtime/events.mjs` 8 个既有类型错误；
  不能把“Campaign 文件没有诊断”写成整个命令通过。DS 仓库报告已记录 exit 1，
  与聊天摘要“tsc 0 errors”不同。

逐命令、真实退出码和日志：
`Pi_Agent_base/runtime/dev/c1-external-review/results.json`，
最新边界套件日志为同目录 `aegis-campaign-c1-external-boundaries.log`。
日志目录 ignored，不入主仓库。可执行测试与本文件入库即可重现。

复现命令（仓库根）：

```bash
node --test Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs
```

## 2. F10 / P1：缺失当前 Task scope 被当作不校验

位置：`memory/campaign/outcome-resolver.mjs`，`resolveTaskOutcome` scope 分支。

`currentTaskScope()` 返回 null 后，resolver 的 `if (scope !== null)` 跳过整个校验。
这与注释“either side missing fail-closed”和 F9 交付声明冲突。

实测：当前 Task scope 为 null、Outcome scope 为 prod，resolver 返回 `ok:true`。
Task 与两级 Outcome scope 全部为 null 时，投影仍可进入 `completed`。

期望：缺失可信当前作用域不能解释为 wildcard；拒绝或 unknown，并记录原因。
如果可信环境可推导 scope，必须显式解析并落到 definition，不能从待验证 Outcome 猜测。
用例：F10 两个测试。

## 3. F11 / P0：Stage 证据仍可绕过绑定与完整性校验，错误完成 Task

位置：`projection.mjs` 的 Stage `campaign.oracle.result` 分支、
`completeTaskIfVerified`，以及 `outcome-resolver.mjs` 的 `resolveTaskFromOutcomes`。

共用完成门已经真实存在，这是 F7 的有效进展。但它调用的 Stage 聚合只组合 status/criterion，
不验证当前 Task scope。Stage 入口仅在双方 Episode 都非空时比较；成功 evidence 用
`.some()` 检查，使空数组通过；没有完整独立 provenance 检查。

保持 Task-level Oracle 为合法完整 success，分别仅改变 Stage 的一个字段：

| 输入变更 | 实际 | 期望 |
| --- | --- | --- |
| scope 改成 foreign | completed | 不完成 |
| scope=null | completed | 不完成 |
| episode_id=null | completed | 不完成 |
| evidence_refs=[] | completed | 不完成 |
| provenance.independent=false | completed | 不完成 |

以上每种均分别复现普通 completed 与 reconciliation 两条路径，10 个正常失败测试。

产品证据另用真实 EventLog 的 append/fsync/replay 接 `createCampaignScheduler`：
预置 durable intent，Oracle reconcile 提供匹配 Task result 与 foreign Stage scope。
结果仍 completed，worker reruns=0。匹配 scope 的同入口正例通过。
Worker/Oracle 和 artifact 索引是 synthetic fixture；真实部分为本地 Scheduler/EventLog，
没有真实模型、目标或平台 Oracle。

期望：保留单一完成门，复用/完善共同 Outcome 接纳逻辑，对 Stage 的 Task/Episode/
criterion/scope/provenance/evidence 先校验再聚合。空证据和缺失绑定不能进入可信成功。
用例：F11 十个投影反例 + 两个 F11-PRODUCT 对照。

## 4. F12 / P1：checkpoint hydration 丢失 Episode 和幂等记录

位置：`projection.mjs` 的 priorState 初始化、appliedCommands/appliedOutcomes 初始化。

恢复行没有把 `row.episode_id` 赋回 item，两个去重 Set 也从空集合重新开始。

实测：

- prefix 在 started 后 checkpoint，恢复后 episode_id=null；
- full replay 拒绝 foreign Episode Task result，cache+tail 却接受为 success；
- prefix 包含一个 Stage outcome，tail 重复同 outcome_id，恢复后 stage_outcomes 为 2 条，
  full replay 为 1 条；
- prefix 已消费 command_id=charge-once，tail 重复命令，恢复后 requests consumed=2，
  full replay 为 1。

这些测试使用 JSON 可序列化的 priorState clone，直接调用真实 cache+tail reducer，
不依靠共享引用或第二次 full replay 伪装缓存恢复。

期望：恢复保留真实 Episode、Outcome/command 去重语义和必要归属信息；重复恢复不双扣账。
用例：F12 四个测试。

## 5. F13 / P1：Scheduler 实际 checkpoint 与 projection digest 没完成 F8

位置：`scheduler.mjs` 的 `projectionDigest`、`persistCheckpoint`、启动缓存验证。

实测通过真实 scheduler.run 的注入 checkpoint writer 捕获实际写入 record：

- queue 行不包含 episode_id；即使 reducer 修复恢复赋值，实际 writer 仍无法提供它。
- 固定 outcome/task/event IDs，仅改变 Stage observed，checkpoint stage_outcomes 内容变化，
  但 projection_digest 完全相同。摘要只覆盖少量任务状态与账本，未覆盖完整 Stage 内容，
  也没有覆盖完整 definition/outcomes/proposals 等语义状态。

这是 F8 明确要求的 projection digest 接线遗漏，不是公共导出风格问题。
另外启动代码将应用 tail 后的摘要与 prefix 的摘要比较；有效 tail 改变状态时会退回
full replay。后续执行又经常重新 `project()`，因此 `used_checkpoint` 的含义也需在产品测试
明确，不应以布尔值宣称缓存实际驱动恢复。

期望：snapshot/checkpoint/state digest 共用明确完整语义；prefix 应先与 prefix state 校验，
再 reduce tail；恢复与 full replay 等价，并证明 scheduler 实际使用恢复后的状态。
用例：F13 两个直接 scheduler writer 测试；tail 使用证明由修复 DS 补齐。

## 6. 限制与非发现

- 这轮没有修改产品实现；19 个失败用例是修复 red 基线，不能 skip 或改成 expected failure。
- 未复跑 DS 的三次 mutation，不能声明其 mutation 证据已独立确认。新的确定反例不需
  mutation 才成立；修复后 DS 应在隔离副本做有限 guard mutation。
- `canonicalStageOutcome/currentTaskScope` 可从所属模块导入；index 未重新导出本身
  不构成必须修复的产品缺陷，不以扩公共 API 作为 C2 入口条件。
- `projectionSnapshot` 缺少 Episode、去重与 reconciliation 诊断等内容需要随恢复契约复核；
  不应写测试强制这些遗漏持续存在。第一批补充测试已取消锁定遗漏的断言。
- Git 对象库检查通过。此前 hash 过滤/时间伪造等说法无充分证据，撤回。

## 7. 后续

只委派 `C1_EXTERNAL_BOUNDARY_FIX_TASK.md`，提示词为 `C1_EXTERNAL_BOUNDARY_DS_PROMPT.md`。
修复后交回外部验收，状态只能先写 internally_verified / awaiting_external_review。
C2 仍 blocked；`C2_SESSION_ROTATION_TASK.md` 仅为暂缓草稿，不能用它启动实现。
