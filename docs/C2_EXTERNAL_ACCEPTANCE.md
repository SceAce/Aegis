# C2 E1/E2 限定外部验收通过

状态：**C2 externally_accepted（冻结范围及已声明 Host 入口内）**。
产品基线：`8e34c0f`，修复提交 `8d70a0b`，分支 `feat/c2-session-rotation`。
开始时工作树干净。本次不修改产品/测试，只复核 E1/E2 与受影响回归。
C1 保持已验收，F16 继续后置，不增加缓存、性能、UI 或 C3 门槛。

## 1. E1：已提交轮换参与后续预算门

代码准入在 newSession 前计入该 Episode committed rotations，使用
base_consumed + committed_rotations，不再用 max(base, generation) 遗漏增量。
外部边界测试独立 **4/4 通过**，覆盖合法完成及请求重用、余额耗尽后新请求拒绝、
初始累计 usage=7 后轮换记为 8，以及缺 committed completion 不返回成功。
真实 Pi SDK + Observer/faux 的预算场景 exit 0，验证下一次请求不创建新 Session。

预算契约的使用限制：传入 ledger 是不含本 Episode 后续轮换增量的基础消耗，
不是可随意重复叠加的 budget_after；后续接入 Campaign 账本需明确基线覆盖位置/归属，
不能把基础账本与派生用量混用。本次只验证当前 Host 入口约定，不宣称 Campaign 全自动记账。

## 2. E2：绑定成功后完成确认

Observer 不再在 session_start 写完成，改由新 Session 的 post-bind before_agent_start
单一 writer 写入；helper 与 supervisor 在 SDK 成功返回后读取 committed completion 确认。
真实 SDK 的 bind-failure 场景 exit 0：Host rebind 抛错，不再留下 handoff.completed。
原 C2 与手动 /aegis switch 相关 SDK 回归通过，成功、取消、重放行为未回退。

该结论证明已冻结的 bind-failure 与缺完成记录反例闭环，不代表所有未来 Host 扩展、
任意 continuation 副作用或跨进程外部效果 exactly-once 已完成验证。

## 3. 本次独立运行清单

全部以下命令实际 exit 0，逐命令 argv、exit 和完整日志保存于 ignored
`Pi_Agent_base/runtime/dev/c2-e12-external/results.json` 与同目录日志。
SDK 命令均使用 source-resolver，真实 Pi SDK + faux provider，不调用真实模型/网络。

| 检查 | 结果 |
| --- | --- |
| aegis-c2-supervisor-boundaries.mjs | 4 tests / 4 pass / 0 fail |
| aegis-c2-budget-sdk.mjs | 真实预算拒绝通过 |
| aegis-c2-budget-sdk.mjs bind-failure | 真实 bind failure 无假完成 |
| aegis-c2-session-rotation.mjs | 原 C2 产品套件 exit 0 |
| aegis-observer-runtime-handoff.mjs | Host helper 与 /aegis switch 回归 exit 0 |
| aegis-observer-outcome-command.mjs | exit 0 |
| aegis-observer-failclosed-pi.mjs | exit 0 |
| aegis-observer-data-use-pi.mjs | exit 0 |
| observer-smoke.mjs | exit 0 |
| aegis-campaign-c1-event-projection.mjs | exit 0 |
| aegis-campaign-c1-integration-scheduler.mjs | exit 0 |
| aegis-campaign-c1-eventlog-durability.mjs | exit 0 |
| Biome：supervisor / handoff-host / Observer | exit 0 |

本次未重复全量类型检查或 DS mutation；已知 Campaign tsc 10 个旧导入诊断仍作为基线限制，
不宣称整库类型检查通过，不为其重开阶段。

## 4. 移交与未实现范围

C2 通过限定外部验收，结束 E1/E2 修复轮次。当前能力为 **Host 可调用的真实 Session 轮换入口**；
现有 Campaign dispatch loop 未自动调用它，不把测试直接调用入口称为生产调度自动接线。
后续真实 Campaign 执行集成应处理必要调用与账本归属，按所在阶段冻结目标执行。

F16 cache 优化继续后置。C3 Broker/Oracle adapters、C4/C4a UI、真实目标/网络/模型、
分布式 ownership 均未在本次验收中实现或放行。当前 C2 任务结束，不自动实施 C3。
下一阶段以用户后续范围和既定架构为依据；不能把这些未实现能力当成重开 C2 的理由。
