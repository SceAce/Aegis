# Aegis 入口能力清单（ENTRY-01）

状态：2026-10-19 按当前代码核对。本文只登记**可用入口与真实能力边界**，不是验收报告；
"已实现"不等于"真实效果已验证"。命令与路径以仓库根为基准。

## 1. 结论

Aegis 目前有两条能力面不同的主路径，**没有一条同时具备"真实工具 + Campaign 账本/Oracle"**：

| 能力面 | 路径 | 具备 | 不具备 |
| --- | --- | --- | --- |
| 真实工具面 | `run-aegis.sh`、`run-pi.sh`、`contest/run.sh` | Pi 原生 `read/bash/edit/write`、Observer 的 Board/RAM/知识/artifact read、人工学习命令 | Campaign Scheduler、请求/工具账本、独立 Oracle、自动轮换的执行责任 |
| 受控执行面 | `campaign/c6-entry.mjs` | 冻结 Manifest、Scheduler/Host/Broker、双侧请求账本、工具账本、执行 permit、独立判定、Board/RAM、学习路由、Session 轮换、报告导出 | 通用 shell、grep、多文件编辑；模型只有 3 个工具；可用动作仅已登记适配器 |

选择入口时按"要真实工具"还是"要可信记账/独立判定"决定，不能把两条路径的证据互相代替。

## 2. 入口矩阵

图例：`默认` = 不设置额外开关时的行为；`已实现` = 代码与离线测试存在；`真实` = 有真实 provider/目标运行证据。

| 入口 | 模型工具 | 可执行动作 | 账本/预算 | Oracle/独立判定 | Board/RAM/知识 | 学习/轮换 | 真实证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `run-aegis.sh` | Pi 默认工具集（未固定 allowlist）+ Observer 7 个工具 | Pi 原生工具 + 已登记脚本（`aegis_execute`） | 无 Campaign 账本 | 无（Observer 只记录，不判任务） | 全部（含知识、artifact read、handoff） | 人工 `/aegis learn/compile/route/bind/run/replay`；`/aegis switch`；`/aegis checkFlag` 人类确认 | 无独立运行记录；组件有离线测试；Firefox DevTools MCP 已配置；`autoRemote` 有登录 bootstrap 和 policy core，平台 adapter/checker 未接线 |
| `run-pi.sh` | 同 `run-aegis.sh`（bundle 入口） | 同上 | 同上 | 同上 | 同上 | 同上 | 需要已构建 bundle，bundle 旧于源码时拒绝启动 |
| `contest/run.sh` | 固定 `read,bash,edit,write,aegis_propose,aegis_switch_session,aegis_observe,aegis_execute,aegis_submit_candidate` | Pi 原生工具 + 已登记脚本 | 任务级 runtime 目录 + `decisions.jsonl` 元数据；无请求/工具账本 | 无自动 Oracle；`aegis_observe` 只做登记观察 | Board/RAM/知识（同一 Observer） | 人工命令；无自动轮换 | 2026-10-17 CTF pilot：9 attempt，provider 403/502，有效对照 0 |
| `campaign/c6-entry.mjs` | `aegis_read`、`aegis_task_decision`、`aegis_submit_plan` | 任务族适配器：`fixture`、`structured-data-repair`（`data.record.set`）、`code-repair`（`code.file.write`）；`script_config_path` 的人工登记脚本 | 双侧请求账本 + 每 Task 工具账本 + 执行 permit + 预算释放 | Host Oracle：注册测试（code-repair）或 plan-ready；Manifest 只能引用 `fixture.oracle.v1` | Board/RAM（`bounded_ram` 或 `full_history`）；无知识工具 | `learning.policy=off/shadow/explicit` 的路由与编译；`session.session_count` 轮换；`pause/resume/cancel/rotate` 命令 | 2026-10-14 单文件 toy 任务真实 provider 3 请求、独立测试 success；无真实任务族/目标 |
| `campaign/e1-max-pilot.mjs` | 同 `c6-entry.mjs` | 同 `c6-entry.mjs` | 同 `c6-entry.mjs` | 同 `c6-entry.mjs` | 同 `c6-entry.mjs` | 同 `c6-entry.mjs` | `prepare/status` 不调用 provider；run 走 `c6-entry` |
| `fixtures/ctf-board-pilot.mjs` | Observer 工具 + 受限 Python CLI（审计 guard） | Python 标准库 CLI + 文件读写（非 OS sandbox） | 无 Campaign 账本；记录 RAM/context digest | 私有答案精确比对；判定以 Outcome 写入同一 EventLog | Board/RAM + board/seed 开关 | 无 | 2026-10-17 真实模型 pilot；2026-10-19 B 验证（7 次完成 + 1 次 harness bug，控制任务 3/3 成功、真实任务 0/5，见 `REAL_TASK_B_VALIDATION_20261019.md`） |
| `fixtures/real-model-ab.mjs` | 单个受限 fixture 工具 | 无（fixture 动作） | 无 Campaign 账本 | Oracle 复验 fixture | 有界经历/Compiler/Router 对照 | 无 | 需显式 `--run-real`；无真实运行报告 |
| `observation/observation-server.mjs` | 无 | 无（只读路由） | 只读投影 | 显示已有 Outcome，不判定 | 同一 committed 投影 | 无 | loopback 测试；无真实长期监看记录 |
| `login-relay.mjs` | 无 | 只写 `$AEGIS_HOME/agent/{models,auth,settings}.json` | 无 | 无 | 无 | 无 | 离线 smoke；拒绝符号链接/越界目录 |

## 3. 各入口细节

### 3.1 `run-aegis.sh`（源码主入口）

- 启动：`./Pi_Agent_base/run-aegis.sh [--model provider/model]`；默认 `AEGIS_TUI_SHELL=1`，`AEGIS_TUI_AUTOSTART=0`。
- 加载：Pi 源码 `pi/packages/coding-agent/src/cli.ts` + `extensions/aegis-observer.ts`，**不固定 `--tools`**，因此模型拿到 Pi 默认工具集。
- 状态：`$AEGIS_HOME`（默认 `~/.Aegis/`）下的 agent/sessions/server/runtime；不读写 `$HOME/.pi`。
- Observer 提供：`aegis_artifact_read`、`aegis_observe`、`aegis_execute`、`aegis_knowledge`、`aegis_remote_request`、`aegis_propose`、`aegis_switch_session`、`aegis_submit_candidate`；`/aegis` 人工命令（ui/status/board/ram/switch/close/autoRemote/checkFlag/outcome/learn/compile/route/bind/run/replay）。
- 只读界面：默认顶栏 + 右侧 rail + composer 提示；`F6`/`F7`/`F8`/`F9` 打开只读 Inspector（graph/board/evidence）。
- 学习提示：若经验库中存在 active procedure，`context_with_system` 在 RAM `rules` 寄存器中携带只读 procedure hint（`trust=rule`、`not_authorization=true`）；它不执行动作、不授予权限，也不替代当前观测。
- 边界：没有 Campaign Scheduler、请求/工具账本、独立 Oracle；工具退出码和模型文本不构成任务结果。

### 3.2 `run-pi.sh`（bundle 入口）

- 与 `run-aegis.sh` 同样的 Observer 能力，但运行已构建 bundle；任何 `pi/packages` 源文件比 bundle 新时拒绝启动。
- 不含未构建的 Pi 源码改动（例如 `app.aegis.inspect.refresh` 只在源码运行时可配置）。

### 3.3 `contest/run.sh`（比赛入口）

- 固定工具 allowlist（见矩阵），加载 `aegis-observer` + `aegis-contest`；`off` 只记录，`hint` 最多注入 2 张低信任卡片。
- 每个 task 独立 `runtime/contest/tasks/<task>/`，写 `decisions.jsonl`；`--help` 列出全部开关。
- 明确不是 sandbox；`AEGIS_ACTION_MODE=normal|auto` 只改变登记动作的审批路径，不是结果验证。
- 现有真实证据只有 2026-10-17 CTF pilot；provider 故障导致正式对照为 0，不能据此推断模型能力或学习收益。

### 3.4 `campaign/c6-entry.mjs`（Campaign 产品入口）

- 子命令：`run`（默认）、`status`、`pause`、`resume`、`cancel`、`export`、`observe`、`rotate`、`measure`；必须提供 `--config`。
- 配置要点（`campaign/campaign-config.mjs`）：`workspace_root`、`manifest_path`、`provider`（`faux` 默认 / `pi-config` 真实 / `remote-openai` 仅识别未实现）、`mode=auto|normal`、`context.strategy=bounded_ram|full_history`、`learning.policy=off|shadow|explicit`、`task_family=fixture-state|structured-data-repair|code-repair`、`registered_test`、`session.session_count`、`observation.enabled`。
- 模型工具只有 3 个；效果必须走已登记动作契约。`code-repair` 只允许整文件替换，测试文件由 Host 注册且模型不可写。
- Oracle：`fixture.oracle.v1` 是唯一可被 Manifest 引用的 id；code-repair 用注册测试判定，规划门用 plan-ready 判定。`verification/live-oracle.mjs` 存在但未注册到 Manifest。
- 学习：`route-before-model`；只有具 proof 的 Experience 能 active；`direct` 走真实 Broker。
- 边界：模型不能注册动作/checker/授权；`status` 只读；未知结果保留 hold，不自动重发。
- 真实证据：2026-10-14 `runtime/pilot/e1-max-first/{smoke,code}` 一次 toy code-repair（3 请求，独立测试 success，usage 为估算、费用 unknown）。没有真实任务族/真实目标的 Campaign 端到端记录。

### 3.5 `campaign/e1-max-pilot.mjs`

- `prepare`/`status` 不调用 provider；`run` 复用 `runC6FromConfig`。
- 生成的是单文件 code-repair 任务包（`solution.mjs` + `check.mjs`），用于验证链路，不代表任务族能力。

### 3.6 实验 fixture

- `fixtures/ctf-board-pilot.mjs`：真实模型 + Observer + 受限 Python CLI；支持 board/seed 开关；独立判定后通过 `appendContestOutcome` 写入同一 committed EventLog（success → Board Fact，未解出 → unknown/Hint）。2026-10-19 的 B 验证与结果见 `REAL_TASK_B_VALIDATION_20261019.md`；10-17 先导见 `BOARD_SEED_CTF_PILOT_RESULT.md`。
- `fixtures/real-model-ab.mjs`：`--run-real` 才调用 provider；对比 direct 与 deliberate；不是 Campaign 路径。

### 3.7 只读面与凭据工具

- `observation/observation-server.mjs`：只读 loopback HTTP，与 TUI/报告共享同一 committed 投影；无写路由。
- `login-relay.mjs`：只写 `$AEGIS_HOME/agent/`，`umask 077`，拒绝符号链接或越界目录；不启动任务。

## 4. 共同边界

- 模型输出是提案；工具退出码、transport 成功和文本都不是结果。结果只来自独立判定。
- hint/seed/candidate 不是 Fact 或 active Experience。
- 工作区不是 OS sandbox；`AEGIS_ACTION_MODE=auto` 是用户授权默认路径，不是验证结果。
- 凭据只读引用，不打印、不提交；私有产物留在 ignored `runtime/`。

## 5. 当前缺口

1. **能力层**：Campaign 路径缺通用 shell/grep/多文件编辑；真实任务族只有 `code-repair`/`structured-data-repair` 两个玩具族。
2. **Oracle 注册**：Manifest 只能引用 `fixture.oracle.v1`；真实题目（flag/独立 checker）没有注册入口。
3. **入口分裂**：真实工具面没有账本/Oracle；受控执行面没有真实工具。选择与收敛方案见 [整体计划](AEGIS_COMPLETION_MASTER_PLAN.md) §11。
4. **真实证据**：Campaign 路径只有 2026-10-14 的 toy 任务；真实 provider 另在 2026-10-17 的 CTF pilot 与 2026-10-19 的 B 验证中跑过（见 `REAL_TASK_B_VALIDATION_20261019.md`）。B 验证证明了“真实工具 → 独立 Outcome → Board Fact”的闭环，但 5 个真实任务尝试 0 成功、成功样本只是控制任务；没有请求/工具账本与预算守恒。

## 6. 验证入口

```bash
# 源码 TUI / Observer
node Pi_Agent_base/tests/observer-smoke.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-tui-command.mjs

# 比赛入口
node Pi_Agent_base/tests/contest-launcher-smoke.mjs
node Pi_Agent_base/tests/contest-pipeline-smoke.mjs

# Campaign 产品入口
node Pi_Agent_base/tests/aegis-c6-runbook.mjs
node Pi_Agent_base/tests/aegis-c6-product-chain.mjs
node Pi_Agent_base/tests/aegis-c6-provider.mjs

# 只读观察
node Pi_Agent_base/tests/aegis-c4a-observation-http.mjs
node Pi_Agent_base/tests/aegis-c4a-observation-command.mjs
```

required 清单与当前红/后置见 [Campaign 测试矩阵](CAMPAIGN_TEST_MATRIX.md)。
