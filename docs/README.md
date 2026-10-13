# Aegis 设计文档

这里保存完整版的设计、验证方案和历史决策。旧 demo 的实现代码已经移除，
本地归档分支为 `archive/demo-20260927`。当前工作区不应再从已删除的 demo
路径恢复代码；新的实现以本文档和 `docs/MEMORY_SCHEMA.md` 为准。

## 当前入口

架构讨论从 [`ARCHITECTURE_DECISIONS.md`](ARCHITECTURE_DECISIONS.md) 开始：
它区分已定契约、实现修正建议与待确认方案，对应 `THINK.md` §9。
草案尚未成为正式契约，不能被实现代码当作用户已经批准的决定。

当前状态：**C1-C5 按记录范围交付，下一轮 C6 统一代码交付**。最新证据 [`C5_EXTERNAL_REVIEW.md`](C5_EXTERNAL_REVIEW.md)，操作说明 [`C5_INTEGRATION_RUNBOOK.md`](C5_INTEGRATION_RUNBOOK.md)，入口 [`DS_MASTER_PROMPT.md`](DS_MASTER_PROMPT.md)。总任务书 [`C6_AGENT_PRODUCT_TASK.md`](C6_AGENT_PRODUCT_TASK.md)，完整提示词 [`C6_AGENT_PRODUCT_DS_PROMPT.md`](C6_AGENT_PRODUCT_DS_PROMPT.md)。

用户确认原 R1-R6 的代码统一归入 C6：SDK/模型 Worker/预算/经验闭环/provider 配置接口/
运行与测量支撑/第二任务族 adapter。主 DS 自主完成内部里程碑，只交一次工程验收；
实际模型 pilot、效果对照与日常试用以后单独处理。划分见
[`AEGIS_PRODUCT_ROADMAP.md`](AEGIS_PRODUCT_ROADMAP.md)。F16/旧类型基线后置。

开发依据：

- [`AGENT_DEVELOPMENT_STANDARD.md`](AGENT_DEVELOPMENT_STANDARD.md)：仓库规范、输入/证据/副作用边界、检查和完成标准；§3.1 为用户确认的阶段范围冻结、阻塞/后置分类与推进规则，适用于后续所有阶段。
- [`AGENT_TESTING_STANDARD.md`](AGENT_TESTING_STANDARD.md)：测试先行、正负例/边界/归属/恢复矩阵、可执行脚本要求、有限 mutation 和结果报告。
- [`GIT_STANDARD.md`](GIT_STANDARD.md)：任务分支、逐路径暂存、本地提交、历史保护和主仓库纳管边界；已替代历史“不做 Git 提交”限制。
- [`DS_ORCHESTRATION_WORKFLOW.md`](DS_ORCHESTRATION_WORKFLOW.md)：主 DS/子 DS分工、文件所有权、任务图、审查和自主推进边界。
- [`CAMPAIGN_CONTRACT_BASELINE.md`](CAMPAIGN_CONTRACT_BASELINE.md)：共享接口契约、C0集中收尾清单、C1事件与预算约束。
- [`C1_CLOSURE_BASELINE.md`](C1_CLOSURE_BASELINE.md)：当前 C1 审计缺口、来源权限、动态准入、队列、预算、checkpoint、ownership 和 recovery 的修复契约。
- [`C1_CLOSURE_TASK.md`](C1_CLOSURE_TASK.md)：上一轮C1收尾任务，作为历史依据。
- [`C1_CLOSURE_EXTERNAL_AUDIT.md`](C1_CLOSURE_EXTERNAL_AUDIT.md)：最新七组已复现产品跨模块发现及独立运行证据。
- [`C1_INTEGRATION_CLOSURE_TASK.md`](C1_INTEGRATION_CLOSURE_TASK.md)：当前共享契约、主DS分任务、接线门和停止条件。
- [`C1_INTEGRATION_TEST_SPEC.md`](C1_INTEGRATION_TEST_SPEC.md)：本轮多维case与Scheduler+真实EventLog端到端测试要求。
- [`C1_FINAL_EXTERNAL_AUDIT.md`](C1_FINAL_EXTERNAL_AUDIT.md)：F1-F6完成报告之后的历史独立复核，指出F7-F9。
- [`C1_FINAL_EXTERNAL_AUDIT_3.md`](C1_FINAL_EXTERNAL_AUDIT_3.md)：F10-F13 历史外部 red 基线及真实 Scheduler/EventLog 对照。
- [`C1_BOUNDARY_EXTERNAL_REVIEW.md`](C1_BOUNDARY_EXTERNAL_REVIEW.md)：F10-F13 交付后的历史复核，包含 F14-F16、12 个新增用例与报告一致性检查。
- [`C1_F14_EXTERNAL_ACCEPTANCE.md`](C1_F14_EXTERNAL_ACCEPTANCE.md)：最新 C1 限定外部通过记录及 C2 阶段移交。
- [`../Pi_Agent_base/AGENTS.md`](../Pi_Agent_base/AGENTS.md)：Aegis-owned代码的Agent自动发现入口，不恢复已删除根目录AGENTS。

Campaign 层的统一设计与实现任务书分别见：

- [`CAMPAIGN_ARCHITECTURE.md`](CAMPAIGN_ARCHITECTURE.md)：把 Campaign Manifest、任务队列、长任务调度、Host 级 Session 轮换、Broker、Oracle、汇总报告和故障恢复接到现有 `Event -> Episode -> Outcome -> Experience` 链路上。
- [`CAMPAIGN_IMPLEMENTATION_TASK.md`](CAMPAIGN_IMPLEMENTATION_TASK.md)：交给 PI+dsv4.1flash 的分阶段实现提示词、测试要求、故障矩阵和最终报告格式。

这两份文档当前是设计/任务书，不表示代码已经实现；只有 C0-C4 和真实 Pi Host-level Session 测试全部通过，才能宣称 Campaign 能力完成。

| 文件或目录 | 用途 |
| --- | --- |
| [`ARCHITECTURE_DECISIONS.md`](ARCHITECTURE_DECISIONS.md) | 已定部分、THINK §9 推荐答案、实施顺序与 Pi 同步记录（待确认草案） |
| [`PROTOTYPE_TASK.md`](PROTOTYPE_TASK.md) | 用户批准的受限 JSON fixture + direct 原型任务与验收边界 |
| [`PROTOTYPE_DESIGN.md`](PROTOTYPE_DESIGN.md) | 原型模块、Pi 适配、重放证据和非目标 |
| [`PROTOTYPE_AUDIT.md`](PROTOTYPE_AUDIT.md) | 代码初审、修复核验、真实模型 smoke 与剩余限制 |
| [`../Pi_Agent_base/memory/fixture/README.md`](../Pi_Agent_base/memory/fixture/README.md) | 原型运行及离线测试命令 |
| [`MEMORY_SCHEMA.md`](MEMORY_SCHEMA.md) | Event / Episode / Outcome / Experience 的现行数据契约、状态迁移和学习验证方案 |
| [`PI_OBSERVER.md`](PI_OBSERVER.md) | Pi 检测器、ROM/RAM 边界、字段不确定性和测试启动顺序 |
| [`examples/memory-teacher-trace.json`](examples/memory-teacher-trace.json) | 最小教师轨迹回放 fixture，包含 success 和 unknown 两类结果 |
| [`../Pi_Agent_base/tests/observer-smoke.mjs`](../Pi_Agent_base/tests/observer-smoke.mjs) | 不调用模型的 observer hook、脱敏和 ROM/RAM 注入 smoke test |
| [`../Pi_Agent_base/tests/login-relay-smoke.mjs`](../Pi_Agent_base/tests/login-relay-smoke.mjs) | 不调用网络的中转配置、密钥权限、模型替换和目录隔离测试 |
| [`../Pi_Agent_base/memory/replay-oracle.mjs`](../Pi_Agent_base/memory/replay-oracle.mjs) | 确定性教师轨迹回放、Oracle 判定和 Experience evidence gate |
| [`../Pi_Agent_base/memory/live-oracle.mjs`](../Pi_Agent_base/memory/live-oracle.mjs) | 将 live Pi 事件交给独立 JSON 状态 Oracle，投影 Outcome / Episode / Experience |
| [`../Pi_Agent_base/tests/replay-oracle-smoke.mjs`](../Pi_Agent_base/tests/replay-oracle-smoke.mjs) | 回放、Outcome、unknown 保留和 candidate/active gate smoke test |
| [`../Pi_Agent_base/tests/live-oracle-smoke.mjs`](../Pi_Agent_base/tests/live-oracle-smoke.mjs) | live Oracle 的 success / failure / unknown 和事件链 smoke test |
| [`../架构.md`](../架构.md) | 完整系统规格：边界、控制循环、验证器、成长机制和安全约束 |
| [`../框架.md`](../框架.md) | 设计依据、实验结果和领域落地分析 |
| [`9-28类人的概念.md`](9-28类人的概念.md) | 类人 Agent 的先验结构、学习循环和工程优先级 |
| [`9-28待解决问题.md`](9-28待解决问题.md) | 当前未决问题和需要实验确认的边界 |
| [`WP_FORMAT.md`](WP_FORMAT.md) | 历史 WP 格式；现行 WP 使用方式见下文 |
| [`../Pi_Agent_base/run-pi.sh`](../Pi_Agent_base/run-pi.sh) | Pi 的隔离运行入口 |
| [`../Pi_Agent_base/login-relay.mjs`](../Pi_Agent_base/login-relay.mjs) | 在隔离目录中配置中转端点、凭据和默认实际模型 |

## WP 的现行用法

WP 可以直接作为教师轨迹，帮助 Agent 跳过从零搜索阶段。回放时仍必须：

1. 在当前环境中重新执行动作，而不是把 WP 的文字当成事实；
2. 为每个关键后置条件运行独立 oracle；
3. 将轨迹标记为 `source_kind: teacher_replay`；
4. 将未确认的结果保存为 `unknown`；
5. 只有满足证据门槛的多个独立 Episode 才能编译为 `active` Experience。

因此，WP 能减少探索成本，但不能绕过结果验证，也不能单独产生生产规则。

## Pi 隔离约束

Pi fork 位于 `Pi_Agent_base/pi/`，启动时必须使用：

```text
PI_CODING_AGENT_DIR=/Users/scemac/My_github/Aegis/Pi_Agent_base/config/agent
PI_CODING_AGENT_SESSION_DIR=/Users/scemac/My_github/Aegis/Pi_Agent_base/config/sessions
PI_SERVER_DIR=/Users/scemac/My_github/Aegis/Pi_Agent_base/config/server
```

请使用 `Pi_Agent_base/run-pi.sh`。它会运行已构建 bundle，并在源码比 bundle
更新时拒绝启动；二开 Pi 源码后先执行：

```bash
cd /Users/scemac/My_github/Aegis/Pi_Agent_base/pi
npm run build:offline
```

配置、session、server socket 和 debug 状态都属于 `Pi_Agent_base/config/`，
不得回落到 `$HOME/.pi` 或 Aegis 根目录的 `.pi`。

## 记录边界

- `Event` 是追加审计源，不直接驱动行动。
- `Episode` 是有目标、有授权范围、有边界的完整尝试。
- `Outcome` 由 oracle 判定，工具退出码只是 transport 字段。
- `Experience` 是经过证据门槛的条件规则，只有 `active` 且 scope 匹配时才能影响行动。

详细字段、不变量、回放对照组和指标以 [`MEMORY_SCHEMA.md`](MEMORY_SCHEMA.md) 为准。
