# C2：真实 Host 级 Pi Session 轮换

状态：**approved_to_start**。前置 C1 已按冻结范围通过限定外部验收，见
`C1_F14_EXTERNAL_ACCEPTANCE.md`（产品基线 `53accb2`）。用户已同意进入 C2，不重复请求授权。
本任务书冻结 C2 核心目标和验收范围；实际 SDK API、文件名/签名由主 DS读真实源码后确定。

## 1. 核心交付与边界

依据 `CAMPAIGN_ARCHITECTURE.md` §3.3 / Phase C2、`CAMPAIGN_CONTRACT_BASELINE.md`：

- Host/scheduler 拥有 Session 生命周期，Observer 仍收集事件，Runtime 仍拥有状态。
- 通过真实 Pi SDK 创建新的 Session/Runtime 和新 context，不能只换随机 ID 或改标签。
- 在安全 idle/settled 边界自动轮换；模型可请求，不能强制绕过安全状态或预算。
- 保留 campaign/task/episode、目标、授权、当前 Stage、累计预算、有效事实、unknown 与
  pending recovery 信息；新 Session 只接收来自 committed state 的有界 RAM，不整段复制 transcript。
- settle → checkpoint → new Session → bind → completion，成功绑定后才记录一次 handoff.completed。
- 失败、取消、未决副作用不能产生假完成、重跑未确认效果、丢状态或重置预算。

只做完成这些行为所需的 supervisor 与现有 scheduler/handoff/observer 接线，不建立平行框架。
不实现 C3 Broker/Oracle adapters、C4/C4a UI、真实竞赛能力评估或全仓库清理。
不修改 embedded Pi 核心、凭据/模型设置、lockfiles，不新增未授权依赖，不触发真实模型/网络。
测试采用真实 Pi SDK + faux provider，不用模型实际调用替代生命周期验证。

## 2. 开始方式

必读开发规范 §3.1、测试规范、Git 规范、`Pi_Agent_base/AGENTS.md`、本任务书及架构相关章节。
完整读取实际使用的 Pi SDK 文档、例子、类型与当前内嵌 Pi API；记录其 HEAD/dirty 状态。
复用 `memory/runtime/handoff.mjs`、`handoff-host.mjs` 和已有测试，不凭记忆编造 Session API。

先更新一份简洁 C2 工作计划/测试矩阵，冻结输入输出、失败原因、安全边界、真实 session id
与 Episode 映射、幂等键及预算归属，再实现。命名和例行实现选择无需请示。
不自行增加默认两 Session 限额、强制无 pending Oracle 等未确认产品限制。

## 3. 冻结 required 验收

| 项目 | 必须观测的结果 |
| --- | --- |
| 正常真实 SDK 轮换 | Host/scheduler 入口创建新对象、新 context、真实 SDK Session ID；绑定生效后 handoff.completed 一次 |
| 连续性 | Episode 不变，不新增独立证据；身份/授权/Stage/事实/unknown/pending 信息保留；累计预算不归零，Session 使用按既定预算记账 |
| 安全边界与预算 | 在途副作用、未 settled/committed 或余额不足时不创建/绑定新 Session；允许边界有正例 |
| 失败与取消 | 创建/绑定/必要持久化失败或轮换期间取消，无假 completion；保留可解释恢复状态，资源按真实 SDK 能力释放 |
| 幂等与恢复 | 同一 handoff 请求重放或 interrupted handoff 恢复不重复 completion/记账，不盲目重发 Task 副作用 |
| 相关回归 | C1 required 与受影响 handoff/runtime/SDK-faux 路径保持正确；静态检查报告真实 exit 和旧基线 |

每项用正常、负例和必要恢复证据验证。至少一个真实 SDK + faux 用例必须走产品 Host/scheduler
入口，观测对象/context/provider 请求或消息边界；只测 factory helper 或返回文本不足。
产品入口确需临时本地文件/进程时按现有 harness 复用，不要求与目标无关的故障全组合。
Pi/faux 启动入口：

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/<实际C2测试文件>.mjs
```

按修改范围运行聚焦测试、必要回归、Biome/类型检查。有限 mutation 只验证关键门，不设数量配额。
已有 tsc 10 个导入诊断如实记录，不写命令通过，也不因此提前做无关类型重构。

## 4. 接收的限制与范围纪律

- F15 局部恢复复制已修且用例通过，不作为 C2 必须重新清理的任务。
- F16 后置：当前可使用权威 EventLog 全量重放，不夸大增量 cache 使用能力。
  C2 如实际依赖恢复状态，完成必要接线即可；缓存加速/读取次数不是本阶段门槛。
- 后置测试保留断言，required/deferred 分别报告，不 skip 伪绿、不声称全部测试通过。
- 新发现只有已复现当前可达核心损害或使上述目标无法成立才新增为阻塞，说明为何不能后置。
  性能偏好、未来能力或“更完美”不能再扩大阶段验收；不要重开已验收 C1。

## 5. Git 与交付

在当前干净提交上建 `feat/c2-session-rotation` 或等价任务分支，记录起始 HEAD/status。
显式路径暂存、审查、分任务本地提交，不 push、不重写历史，不混入其他工作。
无子 Agent 能力则串行切换角色并如实报告；自审不等于外部验收。

只需维护简洁 C2 工作计划/测试矩阵，以及包含实现、自审与命令证据的交付报告；
例如 `C2_SESSION_ROTATION_WORK_PLAN.md`、`C2_SESSION_ROTATION_TEST_MATRIX.md`、
`C2_SESSION_ROTATION_IMPLEMENTATION_REPORT.md`。复用它们，不为每个小修新建整套长报告。
日志放 ignored runtime/dev/，交付附分支/commits/status、required/deferred 结果与限制。

核心 required 通过后标 internally_verified / awaiting_external_review，交回一次限定 C2 验收。
不自行标外部通过，不自动调用验收模型，不进入 C3-C4a。
