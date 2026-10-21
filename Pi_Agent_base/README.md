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

- 安装/预检：仓库根 `./install.sh`。全新克隆用 `./install.sh --all` 一键完成：clone `SceAce/pi` 的 `feat/aegis-shell-layout` 分支（`setTopBar`/`setSidebar` 只存在于该分支，clone 默认分支会导致每次 session 启动抛错）→ npm install → hydrate model data → 构建 bundle → 离线冒烟。默认无参数只做检查（不联网、不写 `~/.Aegis` 之外的路径、不触碰 `~/.pi`）；`--clone-pi`、`--install-deps`、`--build-bundle`、`--smoke` 均为显式动作，可用 `--pi-remote`/`--pi-ref` 覆盖来源。
- Campaign CLI：`campaign/c6-entry.mjs`，支持 `run/status/pause/resume/cancel/export/observe/rotate/measure`。
- 受限 pilot 准备和状态：`campaign/e1-max-pilot.mjs`。真实调用仍必须由用户显式执行。
- Aegis Pi TUI 启动：`./run-aegis.sh`（源码入口，默认 `AEGIS_TUI_SHELL=1`：保留 Pi 原生 chat/editor，显示 Aegis 顶栏和右侧上下文 rail）。私有配置与运行数据默认存放在 `~/.Aegis/`：`agent/`（Pi settings、models、auth、MCP 配置）、`sessions/`（Pi 会话）、`server/`（Pi server 状态）、`runtime/`（EventLog、RAM、投影和产物）。可用 `AEGIS_HOME` 更换根目录，用 `AEGIS_PI_AGENT_DIR`、`AEGIS_PI_SESSION_DIR`、`AEGIS_PI_SERVER_DIR`、`AEGIS_EVENT_LOG`、`AEGIS_RAM_DIR` 单独覆盖；Manifest 使用 `AEGIS_MANIFEST_FILE` 或 `AEGIS_CAMPAIGN_MANIFEST` 指向你的 Campaign 文件。启动不自动迁移仓库里的旧配置，也不自动访问模型/工具网络。`./run-aegis.sh --model <provider/model>` 可指定模型；凭据放在 `~/.Aegis/agent/` 的 Pi auth 配置或环境变量中，不要提交。

  面板操作：`F6` 打开只读 Inspector；`F7` 直达 Task Graph，`F8` 直达 Board，`F9` 直达 Evidence。Inspector 内也可用 `1/2/3` 切换视图，`↑/↓` 选择、`Enter` 详情、`PgUp/PgDn` 分页、`F5` 刷新、`Esc` 返回对话。也可输入 `/aegis ui` 打开。Pi 原生快捷键用 `/hotkeys` 查看。

  MCP 配置放在 `~/.Aegis/agent/mcp.json`（与 Pi 的 `~/.pi/agent/mcp.json` 格式相同）；启动后用 `/mcp` 查看连接与 exposure，修改配置后 `/reload` 或重启。工具按 server 分组，默认用 `codemode` 或 `deferred`；只有明确选出的高频只读工具才用 `direct`。接入记录应先写明 server 身份/版本、传输方式、工具清单、读写与外网范围、认证来源、数据边界、超时/预算和验证命令；生成配置时默认 `enabled: false`，核对无凭据泄漏和权限范围后再启用。Pi 的 MCP exposure 和 server 声明的 `readOnlyHint` 都不是 Aegis work permit；实际调用仍须满足当前 Campaign 的工具 allowlist 与预算。不要把所有工具设为 `direct`，也不要在仓库或提交中保存 token。

  CTF 工具发现清单位于 `~/.Aegis/tools/ctf/tool-inventory.json`。如需让 CTF venv 的 CLI 出现在 Pi 子进程 PATH，显式设置 `AEGIS_CTF_VENV=/path/to/venv`；未设置时启动器不修改 PATH。PATH 可见只表示 CLI 可被本机 shell 找到，不表示它已成为模型可调用的 Aegis action 或 MCP server。要执行工具，仍需按任务固定 argv、约束工作区/目标、配置独立检查，并由当前 work permit 授权。
- 预构建 Pi bundle 隔离启动：`./run-pi.sh`（要求 bundle 与 Pi 源码一致；默认也使用 `~/.Aegis/`，可用 `AEGIS_HOME` 或 `AEGIS_PI_*_DIR` 覆盖）。
- 实验启动：仓库根 `./run-experiment.sh <label>`（如 `ram-001`）。只需一个标签，其余参数自动推导到 `$AEGIS_HOME/experiments/<label>/`：`workspace/`（会话 cwd）、`runtime/`（EventLog、RAM、投影、经验）、`sessions/`、`server/`，并写 `run.json` 记录解析后的路径与 repo revision；**凭据不隔离**：agent 目录（`auth.json`/`models.json`/`settings.json`）默认共用 `$AEGIS_HOME/agent`，否则每次实验都会以未认证状态启动；需要 hermetic 运行时用 `--isolate-agent`。已有同名实验默认拒绝启动（避免把不同 Episode 混进同一日志），续跑用 `--resume`；`--dry-run` 只打印将导出的环境，`--list` 列出已有实验。
- 手动任务启动：仓库根 `./run-ram-test.sh`；默认使用 `maxapi/deepseek-v4.1-flash`，可显式切换到官方 DeepSeek 配置，见 [模型配置](../docs/DEEPSEEK_MODEL_REFERENCE.md)。
- 本地知识库：根目录 ignored `knowledge/`；自动候选召回和 `aegis_knowledge` 模型选择接入 Board/RAM，迁移与调用时机见 [知识库接口](../docs/KNOWLEDGE_RUNTIME.md)。
- Fixture 离线演示：`node Pi_Agent_base/fixtures/demo.mjs`（从仓库根运行）。
- 纯模块可直接使用 Node；需要 Pi SDK 的命令使用现有 source resolver：

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/campaign/c6-entry.mjs --config <config> status
```

## 工作记忆与候选等待

当前 RAM 使用 v3 结构化 JSON：Observer 机械投影、模型显式提案、Runtime 控制和独立结果判断分别负责。通用 bash/powershell 在所有领域只提供不透明命令/输出观察，不猜测业务语义。候选结果提交和等待外部复核的操作见 [接口说明](../docs/STRUCTURED_RAM_AND_WORK_CONTROL.md)，本次验证见 [实现记录](../docs/RAM_ABC_IMPLEMENTATION.md)。

## 放置规则

新增代码先确定职责，再选目录。`memory/` 只接收记忆、证据和经验相关模块；调度、SDK、Broker、授权、HTTP、报告和会话管理分别归入上表目录。共用辅助函数放 `shared/`，正式模块不能依赖 `fixtures/`。新业务 adapter 放 `execution/adapters/`，不要继续增加阶段专用目录或在 `runtime/` 放源码。

当前迁移保持函数和持久化契约，只改变源码位置。旧 `memory/campaign/`、`memory/runtime/`、`memory/fixture/` 已移除；不保留旧路径转发模块。旧审计报告按其基线记录历史路径，映射见 [目录迁移说明](../docs/MODULE_LAYOUT_REFACTOR.md)。使用绝对源码路径的外部 replay adapter 配置需要按新位置更新；本次不改写用户私有配置或历史运行记录。

开发从 [根 AGENTS.md](../AGENTS.md) 加载固定规则，再读本目录 [工程规则](AGENTS.md) 和目标模块目录的 `AGENTS.md`。完整设计与历史材料见 [docs](../docs/README.md)，按需读取；规则层级见 [说明](../docs/AGENT_RULES_LAYOUT.md)。目录迁移不代表既有 E1/RAM 审计缺陷已经修复。
