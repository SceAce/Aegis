# C1 边界修复复核收尾：F14–F16

状态：**changes_required / C2 blocked**。
最新外部复核：`C1_BOUNDARY_EXTERNAL_REVIEW.md`，产品基线 `7656e99`。
本任务是 F11/F12/F13 已授权要求的残余收尾，不另起架构阶段。

## 1. 必读与流程

完整读最新外部复核、本任务书、`C1_EXTERNAL_BOUNDARY_FIX_TASK.md`、
`AGENT_DEVELOPMENT_STANDARD.md`、`AGENT_TESTING_STANDARD.md`、`GIT_STANDARD.md`、
`CAMPAIGN_CONTRACT_BASELINE.md`、`Pi_Agent_base/AGENTS.md`。
全文读实际修改模块/调用者/测试；新代码以文档契约为准，不从实现输出倒推 expected。

先记录分支/HEAD/status，运行新反例保存 red。当前独立测试为 12 用例、2 pass/10 fail。
先更新 `C1_BOUNDARY_WORK_PLAN.md`、`C1_BOUNDARY_TEST_MATRIX.md`，冻结每个任务的
字段、允许文件、正负断言及恢复语义。主 DS统一管理共享 projection/scheduler 文件。
有子 Agent 能力则限定文件委派，无则串行切换角色，不编造独立验收。

## 2. F14：Stage 归属与独立来源

主要文件：`memory/campaign/outcome-resolver.mjs`、`projection.mjs`、必要公共测试。

- provenance 缺失、null、错误类型、independent 缺失/false，不得因为 oracle.source 存在
  而视为已证明独立；保持 unknown/invalid 的明确原因。
- 当前声明 Stage 与 Outcome 内部 step_id/stage_id/provenance 中已有的归属不能矛盾。
  外壳 routing id 不能重标一个明确 foreign 的 Outcome；规范化只能规范合法输入，不能
  覆盖冲突字段以通过准入。字段 fallback 沿用已有契约，但任何已有显式冲突都要拒绝。
- Task/Episode/criterion/source/evidence 同类内外冲突集中审查，复用共同 resolver。
- 保留完整合法正例、optional Stage、legal supersede/unknown；两条完成门共用验证。
- 新套件包含真实 EventLog + Scheduler 的两个负测和一个合法对照；必须都通过且 worker=0。

## 3. F15：缓存输入独立性

主要文件：`projection.mjs` 的 hydration、恢复索引、预算与提案可变对象。

- 恢复的可变状态与调用方 priorState 分离：不只 clone Outcomes，也包括会被账本/动态
  接纳/后续投影修改的 reservation、budget_consumed、定义、依赖、proposals/outcomes。
- prefix + tail 应用后 priorState deepEqual 原副本；再次用同一 priorState 运行应得到相同
  语义状态，不重复扣预留，不依赖“每次测试都手动 clone”掩盖函数本身改输入。
- 补跨调用重复恢复与 full replay 结果一致断言；正例断言 tail 确实生效。

## 4. F16：恢复投影真正驱动调度

主要文件：`scheduler.mjs`、必要 projection/checkpoint 接口与 tests/helpers。

- 有效 checkpoint 先验证，再应用 tail；后续 reconcile、dispatch、控制、输出、persist
  使用该恢复投影和新 committed tail，不在每一步重新从静态任务归约整条旧日志。
- 只有无效/缺失 cache 才按明确 fallback full replay；日志链检查和权威前缀验证保留。
- used_checkpoint 必须指实际恢复路径。一次 prefix 归约用于权威验证可以，不能以此
  作为循环、snapshot、checkpoint 始终全量归约的理由。
- 新测试的透明 Proxy 只统计 prefix payload 读取，不改变数据；允许一次验证归约。
  不要修改测试掩盖重复调用，不把测试改成只断言 used_checkpoint。
- 补真实 write→read→resume、改变状态的 tail、新 dispatch、重复 command/outcome、
  cancel/pause、stranded reconciliation、坏/陈旧 cache fallback 与删除 cache 重建。
- 比较完整语义状态与 full replay，包括 Episode、账本、去重和结果绑定；现有
  projectionSnapshot 仍漏部分恢复字段，不只靠该 helper 的相等就宣称所有字段等价。

## 5. 报告更正

保留原报告作为历史证据，在更新版明确更正：

- 原 red 实际为 21 tests / **2 pass / 19 fail**，不是 3 pass；脚本/测试/ok 块分别计数。
- 不再把 hash 显示异常推断为 crypto stub、Git ref placeholder 或环境篡改。
  当前标准 SHA256 向量、不同输入摘要与 HEAD 对象检查通过。若别的环境仍异常，附
  精确命令/版本/原始结果，无法证明记 unknown。
- tsc exit 1 与“Campaign 文件无新增诊断”分别报告，不写整个检查通过。
- 未独立复跑的 mutation/产品路径不声明已验证。

## 6. 检查、Git 与交付

仓库根运行：

```bash
node --test Pi_Agent_base/tests/aegis-campaign-c1-boundary-review.mjs
node --test Pi_Agent_base/tests/aegis-campaign-*.mjs
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json Pi_Agent_base/memory/campaign Pi_Agent_base/tests/aegis-campaign-c1-boundary-review.mjs
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json
```

再运行原 8 offline + 4 SDK/faux allowlist，source-resolver 入口不变，保存实际 exit/log。
在隔离副本对缺 provenance、foreign Stage 绑定、共享 reservation、丢弃恢复 state 做有限
mutation，必须被行为断言捕获，不以 import/syntax 错误冒充。

按 GIT_STANDARD 逐任务提交：明确路径暂存并审查 diff，不 amend/rebase/reset、不 push，
不混入无关修改。不修改 embedded Pi/凭据/模型设置/lockfiles，不跑真实模型/目标/网络。
测试正常失败基线不得 skip/expected-failure/弱化。

更新现有五份 `C1_BOUNDARY_*` 计划/矩阵/实现报告（含 JSON）/review，增加 F14-F16
对应证据、commits、工作树、red/green、实际缓存路径与遗留限制。
内部全绿后仅写 internally_verified / awaiting_external_review，完成即停止交回验收。
不实现 C2，不自行标外部通过。
