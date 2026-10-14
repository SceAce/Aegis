# E1 短任务 A：接通规划验收与执行许可

剩余工程按三个短任务推进，交给新的 DS 会话。本会话只完成 A，不把 B/C 混成另一次
完整 E1 重建。产品缺陷基线 `c9ed6b4`；审计测试提交 `00c6d2e`，新会话从当前 HEAD 继续。

## 1. 范围与阅读

目标：规划未正常结束、请求未结清或独立规划验收未通过时，子任务在 live/replay/restart
中都不能执行；正常计划仍能完成规划 Task 并按原依赖执行三个业务 Task。

阅读 `Pi_Agent_base/AGENTS.md`、开发/测试/Git 规范，以及：

- `E1_OBSERVABLE_PLANNING_EXTERNAL_REVIEW.md` 第 1、2、6 节；
- `E1_OBSERVABLE_PLANNING_TASK.md` 第 4.4、4.5 节（现有冻结契约）；
- `Pi_Agent_base/tests/aegis-e1-external-review.mjs` 与其真实 SDK/faux helper；
- 下列直接修改文件及关联调用点，改动前完整读文件。

历史 C1–C6 长报告按需查契约，不重新遍历全部历史审查、不重开已接受的请求记账。
先将拟采用的状态顺序、证据来源和对应测试写入现有外部审查报告的一个短修复附录，
无需新增长篇计划书或重复矩阵。按契约解决常规实现选择后继续，不逐步请用户确认。

## 2. 已复现的问题与代码起点

真实产品链目前是 `admitted → ready(outcome=null) → task-plan unknown → children execute`。
缺失最后 assistant.stopReason 时，候选仍被执行；从 task-plan unknown 且尚无子任务开始的
真实耐久前缀重启，provider=6、Broker effect=3。只到 admitted 的重启对照则为 0/0。

主要调用链：

- `c6-model-worker.mjs`：final flush 后 unknown 保护只覆盖 decisions，漏掉 plans；
- `c6-entry.mjs`：`createCompositeWorker`、`onPlanSubmitted`，硬编码 planningSettled=true；
- `e1-planning.mjs`：`admitCandidatePlan`、未接入产品的 `evaluatePlanReady`；
- `scheduler.mjs`：`completePlanningTask` 只写 ready；复用既有 Oracle/Outcome/completed 链；
- `projection.mjs`：ready 直接清除 activation hold，未绑定合法规划完成证据。

这些是排查入口，不要求按行号打补丁。先弄清谁生成终止事实、谁验收、谁持久化、谁放行。

## 3. 必须成立的最终行为

1. 候选记录、请求结清、规划正常结束、整图准入、规划验收完成、子任务执行许可分别可追溯。
   保留 C6 每侧预算责任/联合结清/规划终止三个独立事实。候选可以保留，不能据此放行。
2. unknown/error/aborted、commit/durable failure 均不得释放候选给 Broker 或后续子任务。
   Worker 的显式 plans 结果也受相同保护；Host 使用真实已验证事实，不能用常量 true
   或模型自述代替。已发生请求保持原消费/未决语义，不退款、不另起 request 重试。
3. 正常路径为：正常终止且请求结清 → 完整 durable admission → Host 独立 plan_ready
   检查 → 合法、证据可解析的规划 Outcome → planning Task durable completed → 子任务激活。
   复用 Scheduler 既有判定/完成机制，不从 null outcome、函数名或 oracle 来源标签推导成功。
4. 规划检查绑定 Campaign/Task/Episode、plan id/digest、完整批次、终止及结清事实。
   检查不要求子任务先执行或 ready；父子关系仍只表示拆分来源，depends_on 才是业务依赖。
5. reducer/restart 对缺证据、错配身份、unknown/failure Outcome、缺 completed 的 ready
   保持 hold 并给诊断。先全部验证再变更；不允许用 null plan id 释放所有批次。
   耐久步骤中断不得造成缺门放行；恢复不得重新运行已结束的规划或重复业务效果。
6. 准入/规划验收失败必须由 Composite/entry 向上传达。保留 stopped/unknown 等具体状态，
   不把“调度循环退出”包装成规划成功，也不破坏旧非规划配置行为。

若现有 plan id/digest 冲突妨碍此链，允许统一其定义与调用点作为必要前置修复；候选仍须
durable 保留。不得靠吞掉 rejected、伪造 Oracle success 或删除候选事件转绿。

## 4. 有限验证与交付

先复跑现有外部验收确认 red，日志留在 ignored runtime/dev。重点转绿 ER-02/03/05/08/17，
保留 ER-01/04/15/16 正常效果、依赖和 admitted-prefix 控制。新增必要反例：error/aborted
计划、无合法 Outcome/错配身份的 ready，以及完成门耐久写失败/关键前缀恢复。
必须走真实 SDK+faux、Host、Broker、Oracle、EventLog，不用合成成功事件替代产品链。

```sh
node Pi_Agent_base/tests/aegis-e1-external-review.mjs
```

该完整脚本当前 17 项 / 4 pass / 13 fail。A 完成后 B/C 用例可以仍 fail，逐项报告，
不 skip、不 expected-failure、不降低 meaningful assertions。ER-14 的纯形状健壮性可后续处理。
允许依据冻结契约修正错误 fixture，但说明依据并保留正常效果/预算/顺序/证据断言。

最终一次复跑原 E1 4、C6 18、回归 26、受影响 8 脚本（采用现有实际清单，不用 wildcard
或空列表冒充通过），修改范围 Biome，以及 Campaign tsc 改前/改后逐条诊断比较。
原有 196 条类型诊断不要求清零；不能关闭 checkJs、排除新代码或吞掉退出码。
对终止门、独立验收门各做一个针对性 mutation，须因行为断言失败，而非 syntax/import。

按 Git 规范明确路径暂存、阅读 staged diff、本地提交，不 push。仅更新现有审查报告短附录，
写清实际命令/退出码/日志与未修 B/C。最终回复控制在 800 汉字以内：行为、关键数值、
测试结果、commit、工作树、剩余项。详细日志入文件，不在聊天粘贴整段源码/日志。

不改 Pi 核心、凭据、用户模型配置、lockfile，不加依赖，不跑付费 provider/真实靶场。
不新增 shell/攻击工具、UI 重做、多 Worker、增量重规划或退款平台。

## 5. 后续交接（本会话不执行）

- B：从同一冻结契约生成真实 planner 输入与 Host 模板判据约束，修 ER-06/07/13；
  包括模型可用信息与结构化坏输入收口，不预置任务树。
- C：共用可信 artifact/Outcome 边界还原观察/白板，修 ER-09/10/11/12；
  保留原事件身份与证据，正常流零 rejected，网页与权威 replay 终态一致。
- A 交付仅表示规划执行门修复，整体 E1/CTF 尚未通过。B/C 完成后再做一次整体验收，
  然后由用户启动小型真实规划试跑及选定题目的最小 CTF 工具适配。
