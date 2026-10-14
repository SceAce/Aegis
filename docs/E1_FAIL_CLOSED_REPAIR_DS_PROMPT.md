# DS 提示词：E1 Fail-Closed Repair

下面正文可直接发给新的 DS 会话。你负责编码、测试、审查和本地提交，不只返回方案。

你在 `/Users/scemac/My_github/Aegis` 的 `feat/c6-agent-product` 分支工作。先记录实际 `HEAD`、工作树和当前测试基线；不要 reset、checkout、stash、push 或覆盖用户改动。

## 必读文件

1. `docs/E1_FAIL_CLOSED_REPAIR_TASK.md`：本轮唯一任务书、契约、矩阵和 DoD。
2. `docs/AGENT_DEVELOPMENT_STANDARD.md`、`docs/AGENT_TESTING_STANDARD.md`、`docs/GIT_STANDARD.md`。
3. `Pi_Agent_base/AGENTS.md`、`docs/E1_OBSERVABLE_PLANNING_EXTERNAL_REVIEW.md` 最新 B/C 结果。
4. `Pi_Agent_base/memory/runtime/board.mjs`、`memory/campaign/projection.mjs`、`e1-plan-contract.mjs`、`e1-observation.mjs` 及其直接调用者。
5. `Pi_Agent_base/tests/aegis-e1-observation-repair.mjs`、`aegis-e1-external-review.mjs` 和真实 planning helper。

## 本轮必须修复

### A. Outcome 事实绑定 fail closed

修复 `campaignOutcomeAsRecorded()` 及其索引调用：Campaign、task、episode、stage、source 等必需绑定缺失、foreign 或错配时必须降级为 Hint，并保留明确原因。不能使用 `outer ?? inner` 补齐缺失字段，不能把没有 `campaign.task.started` 的结果当成当前 Task 的 Fact。现有证据、trusted source、status、unknown、transport 和 supersede 规则继续复用。

### B. Plan replay 身份链 fail closed

修复 `applyPlanSubmitted()`/`applyPlanAdmitted()`：admitted 必须引用先前同 Campaign 的 submitted；`plan_id`、`planning_task_id`、digest 必须一致；声明 digest 必须等于 `planDigest(submitted.plan)`。孤立、错配、篡改事件必须 rejected/hold，不能创建动态 Task、reservation 或预算 mutation。合法重复事件必须幂等。

## 工作顺序

1. 先写 red 测试并在旧代码上运行，确认失败原因真实对应上述两个漏洞。
2. 再实现最小纯校验/索引修复；所有校验在任何 queue/budget/plan mutation 前完成。
3. 为每组关键 guard 做一次行为 mutation，确认测试会失败；恢复原代码。
4. 运行完整 E1、C6、回归、受影响、Biome、Campaign tsc。
5. 阅读 staged diff 和所有直接调用点，确认 live、durable、replay 语义一致。

## 禁止的“修复”

- 不得删除或弱化既有测试、过滤 `rejected`、吞掉错误、把 unknown 改成 success；
- 不得只改 HTML/API 显示；权威 reducer 和 board projection 必须先正确；
- 不得用新 provider、假 Oracle、手写成功事件或 fixture 常量掩盖产品路径问题；
- 不得用 normalized task definitions 代替候选 plan digest；
- 不得为方便通过类型检查而关闭 `checkJs`、排除文件、加入 `@ts-ignore` 或大面积 `any`；
- 不得修改 Pi 核心、auth/config/lockfile、添加依赖或启动真实 provider/CTF。

## 最终回交格式

请只在完成实现和验证后交回，包含：

1. 两个根因和最终 fail-closed 设计；
2. 修改文件及 live/durable/replay 调用点；
3. red -> green 测试、行为 mutation 结果；
4. E1/C6/回归/受影响/Biome/tsc 的真实 argv、exit 和日志目录；
5. 正常链、坏 Outcome、孤立/错 digest plan、重启前缀的关键数值；
6. commit、HEAD、工作树状态和未实测限制。

如果任何 FC-O/FC-P 核心负例仍红，状态必须为 `changes_required`，不要声称内部通过。不要启动真实 CTF。
