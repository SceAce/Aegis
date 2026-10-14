# E1 Fail-Closed Repair 开发规范

本规范只适用于 `E1_FAIL_CLOSED_REPAIR_TASK.md`，并补充仓库通用开发规范。若与用户当前明确指令冲突，以用户指令为准；若与已冻结 Campaign/EventLog 契约冲突，以契约为准。

## 1. 变更边界

- 允许修改 Aegis-owned 的 Board、Campaign projection、E1 observation、相关测试和必要文档。
- 不修改嵌入 Pi、凭据、真实模型配置、lockfile，不加依赖。
- 不把本轮发现扩展成 UI、性能、类型债或 CTF 工具建设。
- 每个修改必须能对应任务书中的一个契约或测试 ID。

## 2. 先契约、后代码

编码前必须写清：

- 事件输入和身份字段；
- trusted source 和权限；
- 缺失、foreign、错配、unknown、invalid 的输出；
- mutation 前后不变量；
- 幂等键、canonical digest 和恢复行为。

实现前先添加旧代码应失败的 red case。若测试在旧代码上不失败，先检查测试是否真的经过产品入口，而不是降低断言。

## 3. Fail-closed 规则

### 3.1 事实投影

- 可信度、结构完整、引用存在、当前有效是独立检查；
- source.kind 是必要条件，不是充分条件；
- 缺少任何 Campaign/Task/Episode/Stage 绑定不能生成 Fact；
- `outer ?? inner` 只能用于展示候选字段，不能用于可信事实绑定；
- `unknown`、timeout、tool error、foreign、无证据只能成为 Hint；
- Hint 必须保留原事件身份和可诊断 reason。

### 3.2 计划 replay

- reducer 按事件追加顺序处理，不从 UI/report 反推事实；
- 全部身份/digest/shape 校验通过后才允许 mutation；
- 任何批次非法都不得应用合法前缀；
- 同 id 同 digest 重复是幂等；同 id 不同内容是拒绝；
- admitted 不得脱离 submitted 存在；ready 不得脱离 admitted 和规划完成存在；
- rejection 不得改变 queue、budget、dynamic definitions 或 execution gate。

## 4. 测试规范

测试至少分四层：

1. 纯函数契约：字段矩阵、digest、reason；
2. reducer 集成：真实 EventLog 事件顺序、rejected、无部分 mutation；
3. 真实 SDK + faux 产品链：Host、Scheduler、Oracle、Board、view 同源；
4. 恢复/重启：从截断 durable 前缀启动新进程，确认 provider/effect/动态任务状态。

每个失败测试都要断言行为结果，而不是只断言返回值。例如计划 replay 必须同时检查 `rejected`、动态 Task 数、预算、ready hold 和 Broker effect。

## 5. Mutation 规范

只做与本轮风险直接相关的 mutation：

- 删除一个 Outcome 必填绑定 guard；
- 删除 submitted/digest canonical guard。

每个 mutation 必须：

- 运行真实行为测试；
- 因假 Fact、假准入或假任务而失败；
- 不是因为语法、import 或命令错误失败；
- 立即恢复源码并重新运行聚焦测试。

## 6. 代码规范

- 使用现有 ESM、digest、EventLog、resolver、projection 和 Board；不复制第二套真相逻辑。
- 纯验证函数不读写文件、不调用 provider；边界适配器负责 I/O。
- 返回结构化 `{ok, reason/reasons}`，不要抛出可由外部输入触发的 TypeError。
- 不用 truthy/default 让缺失身份变成合法身份；明确区分 `null`、缺失和空数组。
- 公共函数补 JSDoc，保持字段可空性和 reason 语义可读。
- 不为通过 tsc 关闭检查或大面积增加 `any`。

## 7. Git 与报告规范

- 按路径暂存，提交分成产品、测试、文档等可审查单元；不改历史、不 push。
- 提交前检查 `git diff --check`、staged diff、直接调用点和工作树。
- 报告真实命令/退出码/日志路径；区分 pass、fail、blocked、not run。
- 报告必须写明 fixture、真实 SDK+faux、真实本地进程和真实网络的验证层级。
- 不把内部测试通过写成真实模型或 CTF 能力通过。

## 8. 交付门

只有以下条件全部成立，才可交回 `internally_verified / awaiting_external_review`：

- FC-O-01..08、FC-P-01..07、FC-I-01..02 通过；
- 正常 E1/C6/回归/受影响清单通过；
- 两个 mutation killed；
- 修改文件无新增 tsc 诊断，Biome 通过；
- 工作树 clean、commit 可定位；
- 未测真实 provider/CTF 等限制已列出。

否则必须交回 `changes_required`，并指出具体失败的 requirement/case。
