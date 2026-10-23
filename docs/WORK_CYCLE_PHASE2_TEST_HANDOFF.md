# Work-cycle 第二阶段：补测与限定复验任务

状态：**交给 DS 的测试任务；当前独立结论仍为 changes_required。** 本文件只细化已有第二阶段验收，不新增开发规范、不扩大产品能力。本轮 DS 负责测试、证据和文档；产品修复沿原实现任务另行处理，不在本测试委派中修改业务代码。

## 1. 依据与工作范围

按根 `AGENTS.md` 加载 [固定规则](DEVELOPMENT_RULES.md)，遵守 [开发规范](AGENT_DEVELOPMENT_STANDARD.md)、[测试规范](AGENT_TESTING_STANDARD.md)、[Git 规范](GIT_STANDARD.md)、`Pi_Agent_base/tests/AGENTS.md` 及实际目标路径规则。需求来自 [第二阶段任务书](WORK_CYCLE_PHASE2_IMPLEMENTATION_TASK.md) §3/§6、[工作控制接口](STRUCTURED_RAM_AND_WORK_CONTROL.md)。证据追加到 [现有矩阵](WORK_CYCLE_TEST_MATRIX.md) 与 [实现报告](WORK_CYCLE_IMPLEMENTATION_REPORT.md)，保留旧结果与作者/执行轮次。

起始工作树预计为 `feat/work-cycle-session-handoff`、HEAD `d84b692`，存在 DS 第二阶段未提交改动；嵌套 Pi 基线 `2ba451d99`。先记录真实 status/HEAD、文件所有权与测试输入版本；不得 reset、清理或覆盖既有工作。`Pi_Agent_base/UI/` 禁止读取、修改、暂存、删除。不得暂存、提交或 push；不改 Pi 核心、依赖、凭据与生产配置。

允许修改：本任务相关正式测试、必要隔离 fixture/helper 和本任务文档/已有矩阵报告。不得改产品实现、放宽契约、修改正确预期、skip/expected-failure 伪绿。测出失败保留 red；测试设计错误可按契约说明后修正。

## 2. 是否需要真实环境

**机制验收不需要真实模型、网络目标、用户私有 Session 或人工 Session ID。** 使用真实 Pi SDK、真实 C6 Host/Supervisor、faux provider、临时 workspace/知识目录，实际创建/绑定 Session、执行本地 fixture action、记录 committed EventLog 与账本。

faux 决定模型回复，不代替被测 gate、检索、轮换或预算算法。禁用真实网络/搜索，隔离默认凭据与用户配置；设置并恢复相关环境变量，测试顺序明确，finally 释放 Session 和临时文件。禁止直接注入“通过”事件、patch `getContextUsage()` 或用 reducer 输出生成 expected。

真实模型解题、阈值校准、学习收益与普通入口人工体验属于后续独立实验，不纳入本次通过条件。将来进行手动实验，Session ID 只是证据索引，还需关联 task/config/事件与实际结果，不能单凭 ID 证明机制正确。

## 3. 当前已观察证据与接手文件

独立审查已复跑 pure/RAM/phase2 三脚本、五项 SDK/C6 聚焦脚本、module-layout 和 diff check，通过。required 68、完整 14 回归、Biome/类型差异仍区分 DS 交付证据与独立复跑，不改写为本轮已运行。

审查脚本与日志在 ignored `Pi_Agent_base/runtime/dev/p2-independent-review/`。可参考但不能作为唯一可迁移测试：

- `replace-consumed-sdk.mjs`：exit 1，合法替换消费 Intent 导致轮次 1→0。
- `zero-budget-recovery.mjs`：exit 1，第二次仍 Session budget=0，却 completion=1、rotation_attempts=[]，Task completed。
- `rotation-continuation-gate.mjs`：exit 0，轮换 continuation 尝试直接 bash，文件未生成。

当前另有未跟踪草稿 `Pi_Agent_base/tests/aegis-work-cycle-missing-evidence-sdk.mjs`，由当前验收会话写入，**不是 DS 已交付或已接受测试**。最后一次完整执行（终端输出，尚未形成正式持久日志）：

```sh
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-work-cycle-missing-evidence-sdk.mjs
```

3 cases：2 pass / 1 fail，exit 1。

| 草稿 case | 当前观察 | 限制 |
| --- | --- | --- |
| unavailable | 缺知识目录→实际 review unavailable/hold→创建本地 seed→同 trigger review ready→新 Intent→实际 effect，账本平衡，pass | DS 仍须审查断言、复跑并保存日志 |
| no_match | 可读空目录的实际 review 返回 `ready`+空 selected，断言要求 `no_match`，fail | 已有契约要求显式 no_match；不能把 expected 改成 ready 来通过 |
| context | faux 文本增加历史，SDK usage 约 89%（64k window），Host 自动轮换一次；未复核 hold/trigger/双计数跨 Session 保留，副作用尝试被拒，知识检索/review 可继续，pass | 草稿覆盖只读知识检索，**尚未证明授权 workspace read 工具可用**；不宣称 P2-07 全覆盖 |

DS 先审查/收敛该草稿，允许按职责拆分，保留已有正确断言；不复制成多套测试框架。草稿曾修正两个测试自身问题：跨次读日志的对象不能用 indexOf 比较顺序，应按同一数组/事件 ID；旧 transcript 不重播不等于 RAM 禁止引用有界摘要，不能用摘要包含旧 marker 就判完整重播。保留精确的 Session/message/长度与引用断言。

## 4. 必须完成的补测与回归

### TEST-06A：检索不可用后同 trigger 恢复（P2-06）

1. 通过真实 C6 工具/Broker actions 形成 stall；知识根指向临时不存在目录，启用本地检索且禁用网络。
2. 模型实际调用 `aegis_work_review`。断言 selection/review 同 Episode、因果顺序、trigger 关联与 `unavailable` 状态；不得出现选中知识或可信成功声明。
3. 截取该已提交前缀：gate 保持 hold；一次真实副作用尝试被拒，实际文件/计数不变，不能只看 helper allowed=false。
4. 在明确已收到失败结果的边界创建可命中 seed；同 trigger 再调用 review，必须实际读到内容，生成新合法 selection/review，进入等待新 Intent。
5. 有效新 Intent 引用恢复 review 后，effect 可以执行；失败 review 不被误消费，旧 trigger/双计数与一次消费正确。不同真实 review 调用账本各结清；内容幂等不冒充调用免计费。

### TEST-06B：空命中（P2-06）

使用可读的空目录（也可加一个不相关 seed 负例），与 missing/unreadable 目录分开。真实工具返回、`knowledge.selected`、`work.review` 必须表达 `no_match`、空 selected、缺少知识支持；不能在这一边界报告命中成功。review 仍是未验证规划信息，后续合格 Intent 可开启一次尝试，不能永久卡死或自动成为 Fact。

当前 `selectKnowledge` 的一般返回约定与 review 契约可能不同；本测试要求 **review 产品边界**满足既有显式状态契约。记录实际字段和影响，交实现者修正，不在测试任务擅自全局更改检索 API。

### TEST-07：携带未完成 hold 的 context 自动轮换（P2-07）

1. 同 Task/Episode 中，实际 actions 触发 stall，**轮换前没有可用 review 或消费 Intent**。避免 complete checkpoint 或 request threshold 抢先成为轮换理由。
2. 用 faux 的合法回复内容增加真实 Session 历史，选择足够窗口使实际 SDK usage 在 threshold 与窗口上限之间（如 85%–95%），不 patch API、不伪造 usage/settled 事件。Host 从实际记录读用量并自动调用 Supervisor，不能手动 rotate 冒充。
3. 记录 source Session 对象/id/file、usage、实际边界理由、handoff request/完成的关联。真实 replacement 对象/id/file 变化，旧 context 高水位不连锁触发第二次轮换。
4. 捕获新 Session **第一个实际 provider-bound 请求**。RAM 保留 task/auth/budget、同 trigger/证据、相同双计数/消费关系，gate 仍 held；新消息无旧 assistant transcript，允许有界 RAM 摘要。
5. 新 Session 发起真实 effect 尝试，确认 gate 拒绝且无对应实际副作用；随后分别验证：授权范围内的 workspace read、知识检索、work review 可用。每条路径都要捕获真实工具结果和所读值/检索来源，不能用工具出现在列表上替代执行成功。
6. 新 scoped Intent 合法消费 carried review 后，原 Task 可继续至 fixture Oracle；未决责任、工具记账和 Session 使用无重置/重复。

若 workspace read 被分类门阻断，应保留该行为 red 并定位；不为了通过而把 read 测试替换成只读知识查询。缺陷范围只限该已承诺路径，不引入新工具权限。

### REG-R1：替换已消费 Intent（P2-01/02/03）

真实 SDK：A stall→review R→B 引用并消费 R→一次 action→C 引用 R 且 `replace_event_id=B`。预期累计 4、轮次 1，consumption 仍指向原 B；C 可作为当前有效单元，但不改变已发生历史。重复合法替换不能在阈值前无限续轮。补少量纯函数 prefix/replay 对照。禁止误用旧 action_count=1 断言，新契约需要分别验证两个计数。

### REG-R2：预算拒绝后的恢复（P2-08/11）

- Run 1 以 Session 额度 0 触发真实轮换拒绝，保留 boundary/staged request，无 completion。
- Run 2 沿同 committed 源、额度仍为 0：必须保持拒绝，不得因初始新进程 Session 绑定或首次 prompt 自动补写被拒 request 的 completion；不得在该未获准交接边界下自动执行下一单元 effect。
- 正例：隔离 fixture 中模拟 owner 明确纠正额度，在既有总授权上限内走真实 Host/Supervisor 恢复；不能只观察一条 completion 就推断成功。捕获实际 Supervisor/newSession 调用、对象/id/file、正确 request/identity、一次预算消费、无重复动作/charge。
- 禁止用修改 staged JSON、换随机 ID、清日志或放宽预算检查消除失败。

### TEST-09：多理由同刻合并（P2-09，原 not_run 补齐）

在既有 fixture 中令 request threshold 与当前单元 complete 同一实际安全边界满足，确认一次 Host/Supervisor 轮换、一个 replacement、一条完成和一次 Session 消费，并可见两个理由。无需扩展成全部理由组合。

## 5. 交付与“距离通过”的有限清单

| 项目 | 当前结论 | 转为通过需要 |
| --- | --- | --- |
| R1 review 消费被替换移动 | 已复现，current_blocker | 实现者修复；REG-R1 真正 red→green，旧正确断言不削弱 |
| R2 零额度恢复绕过拒绝 | 已复现，current_blocker | 实现者修复；REG-R2 拒绝正负例与实际 Supervisor 证据 |
| no_match 状态 | 新补测已 fail，契约不一致 | 实现者修正 review 状态表达或由 owner 明确变更契约；不得由测试作者偷偷改预期 |
| unavailable 恢复 / context carry | 草稿相应 case 通过，原缺测部分已补 | DS 审查并完成上述真实 effect/read/账本断言、复跑日志 |
| 多理由合并 | 原 not_run | 一个实际合并产品用例 |
| 相关回归/文档 | 待最终修复树验证 | 聚焦与受影响 SDK/C6/C2/ledger/RAM 回归通过；更新原矩阵/报告；按既有阶段要求跑 required/静态差异 |

DS 测试交付允许仍有 red，应写 `tested / changes_required` 并逐项说明；**测试任务完成不等于产品通过**。实现者在原第二阶段授权下修复后，按这份有限清单做限定复验，标 `internally_verified / awaiting_external_review`，最终独立验收决定是否通过。不把缓存、真实解题率未测、普通入口自动 Host、新 UI 或无关历史失败加入本次硬门。

正式脚本用真实 source resolver，至少保存一次完整运行结果；可按 name pattern 单独诊断，但不能把过滤后的通过当作完整三项/全矩阵通过。runner 显式清单包含新增脚本、真实传播非零退出码。只改测试无需每轮重跑整个 required；最终产品修复交付按原任务门运行。

每个 case 记录：需求 ID、输入来源、步骤、独立预期、实际 command/exit、日志、关键 event/request/Session 引用、真实文件效果、charge/finish 数字、限制。日志放新 ignored runtime/dev 子目录；不复制巨大 padding、凭据、完整私有 transcript 到公开报告。补充 Biome/语法/模块路径检查，报告真实失败，不安装新工具。
