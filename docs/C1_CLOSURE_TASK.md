# C1 Closure 主 DS 实施任务

本文件保留上一轮 C1 Closure 任务的历史依据。最新独立验收仍发现跨模块缺口，当前执行入口为 `C1_INTEGRATION_CLOSURE_TASK.md` 与 `C1_INTEGRATION_TEST_SPEC.md`，总提示词为 `DS_MASTER_PROMPT.md`。保留已有效修复，完成七组 C1EXT 问题后停止，等待外部验收，不进入 C2。

## 1. 必须阅读

```text
docs/C1_CLOSURE_BASELINE.md
docs/DS_MASTER_PROMPT.md
docs/AGENT_DEVELOPMENT_STANDARD.md
docs/AGENT_TESTING_STANDARD.md
docs/DS_ORCHESTRATION_WORKFLOW.md
docs/CAMPAIGN_CONTRACT_BASELINE.md
docs/CAMPAIGN_ARCHITECTURE.md
docs/ARCHITECTURE_DECISIONS.md
docs/MEMORY_SCHEMA.md
docs/MEMORY_SCHEMA_NOTES.md
Pi_Agent_base/AGENTS.md
Pi_Agent_base/pi/AGENTS.md
```

## 2. 主 DS 执行方式

本轮允许一次总委派。主 DS不能一次改完所有文件后再自测，必须：

1. 先检查当前代码和报告，记录真实基线；
2. 先生成/审查 C1 Closure 测试矩阵和可运行脚本；
3. 拆为互不重叠的小任务；
4. 使用实际可用的子 DS能力；当前 harness 没有子 Agent 工具时，串行切换测试作者/实现者/审查者角色；
5. 每个小任务聚焦测试、实现、主 DS复查后再集成；
6. 最终主 DS阅读全部C1代码、测试和调用点，不能只接受测试报告；
7. 修复完成后停止，不实现 C2。

## 3. 推荐小任务图

```text
C1C-BASE       基线、契约、文件所有权和测试矩阵
C1C-TEST       先写来源/准入/账本/checkpoint/recovery负测
C1C-SOURCE     event kind/source权限和Outcome绑定
C1C-ADMISSION 真实 proposal submitted -> policy -> admitted -> projection
C1C-QUEUE      合法状态转移、terminal、resume/依赖
C1C-BUDGET     Scheduler实时账本、consumed/reserved/released、边界停止
C1C-CHECKPOINT Scheduler接入checkpoint、tail digest、恢复重建
C1C-OWNERSHIP  原子ownership reclaim/release race
C1C-RECOVERY   真实EventLog durability和synthetic sink区分
C1C-INTEGRATE  warning、回归、有限mutation、报告修正、主DS审查
```

共享 `index.mjs`、测试矩阵、fixtures、scheduler/projection公共接口由主 DS 集成，不让多个小任务覆盖写。

## 4. 交付硬条件

没有以下证据，不得标 C1 internally_verified：

- 来源按 event kind 限制；agent/observer/environment 不能伪造 Oracle/完成；
- admitted proposal不能绕过 dynamic-policy；真实 admission链测试通过；
- Scheduler每次 dispatch使用真实 projection ledger；预算超限停止；
- Queue非法状态转移被拒绝；
- Scheduler实际读写 checkpoint，且checkpoint绑定并校验当前EventLog tail；
- ownership reclaim和release不会造成两个owner或删除新锁；
- recovery测试区分synthetic file sink和真实EventLog fsync；
- Biome没有warning，或报告明确列出warning且不能写clean；
- baseline没有全零Git commit占位值；
- C0/C1聚焦测试、相关回归和mutation结果真实可复现；
- 主 DS审查报告列出剩余风险；
- 明确不宣称外部副作用 exactly-once、真实 Pi Session、Broker、Oracle、Web UI或C2。

## 5. 停止条件

若必须修改用户已确认的数据模型、权限边界、Outcome/Experience证据门、Pi核心或增加真实外部依赖，停止该小任务并记录 blocker；不要自行降低声明。常规代码、测试、接口接入和文档修正可在现有授权内自主完成。
