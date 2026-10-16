# Aegis 代码入口

Aegis 使用 Node ESM（`.mjs`）和 Pi TypeScript 扩展。模块按职责放置，阶段编号不是目录归属依据。

| 目录 | 职责 |
| --- | --- |
| `memory/` | Episode 记忆状态、Board、RAM、证据解析、经验学习与编译 |
| `campaign/` | Campaign Manifest、计划与任务图、准入、队列、Host/Scheduler、请求/预算生命周期、产品入口及 SDK 组装 |
| `execution/` | 行动契约、权限、Broker、脚本注册和工作区工具；`adapters/` 放具体任务执行适配器 |
| `session/` | 会话监督、交接检查和实际 Session 替换 |
| `orchestration/` | 协调行动执行和学习的工作流 |
| `verification/` | 独立 Oracle、结果解析与聚合、注册测试、live/replay 验证入口 |
| `observation/` | 只读观测命令、HTTP 视图、报告和导出 |
| `shared/` | 追加事件日志与完整性校验；多模块共用的契约、摘要、规范化、文件和路径辅助函数 |
| `fixtures/` | 受限实验 Host、Oracle、Compiler/Router、演示与显式 real-model 实验入口 |
| `extensions/` | Pi 扩展接入：Observer、Contest、Fixture 工具 |
| `contest/` | 任务卡、Contest 运行、结果导入 |
| `agent/` | 固定 ROM 指令 |
| `tests/` | 单元/集成/故障恢复/审计用例，`helpers/` 放辅助子进程和运行器 |

`pi/` 是独立的内嵌 Pi 仓库。`config/` 保存私有配置、凭据与会话；`runtime/` 保存运行产物，`tmp/` 保存临时文件。这些目录不属于 Aegis 主仓库源码。

## 主要入口

- Campaign CLI：`campaign/c6-entry.mjs`，支持 `run/status/pause/resume/cancel/export/observe/rotate/measure`。
- 受限 pilot 准备和状态：`campaign/e1-max-pilot.mjs`。真实调用仍必须由用户显式执行。
- Pi 隔离启动：`./run-pi.sh`。
- Fixture 离线演示：`node Pi_Agent_base/fixtures/demo.mjs`（从仓库根运行）。
- 纯模块可直接使用 Node；需要 Pi SDK 的命令使用现有 source resolver：

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/campaign/c6-entry.mjs --config <config> status
```

## 放置规则

新增代码先确定职责，再选目录。`memory/` 只接收记忆、证据和经验相关模块；调度、SDK、Broker、授权、HTTP、报告和会话管理分别归入上表目录。共用辅助函数放 `shared/`，正式模块不能依赖 `fixtures/`。新业务 adapter 放 `execution/adapters/`，不要继续增加阶段专用目录或在 `runtime/` 放源码。

当前迁移保持函数和持久化契约，只改变源码位置。旧 `memory/campaign/`、`memory/runtime/`、`memory/fixture/` 已移除；不保留旧路径转发模块。旧审计报告按其基线记录历史路径，映射见 [目录迁移说明](../docs/MODULE_LAYOUT_REFACTOR.md)。使用绝对源码路径的外部 replay adapter 配置需要按新位置更新；本次不改写用户私有配置或历史运行记录。

开发从 [根 AGENTS.md](../AGENTS.md) 加载固定规则，再读本目录 [工程规则](AGENTS.md) 和目标模块目录的 `AGENTS.md`。完整设计与历史材料见 [docs](../docs/README.md)，按需读取；规则层级见 [说明](../docs/AGENT_RULES_LAYOUT.md)。目录迁移不代表既有 E1/RAM 审计缺陷已经修复。
