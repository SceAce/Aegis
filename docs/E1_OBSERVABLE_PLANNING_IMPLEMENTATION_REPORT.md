# E1 可观察规划 — 实现报告

状态：**internally_verified / awaiting_external_review**（DS 内部工程验证；不含真实模型能力
或真实 CTF 结论）。本轮完成白板内容展示、父子树与依赖 DAG、LLM 结构化规划、Host 整图准入、
Scheduler 按依赖执行与重启重建。依据 `docs/E1_OBSERVABLE_PLANNING_TASK.md`、
`docs/E1_OBSERVABLE_PLANNING_TEST_MATRIX.md`、`docs/DS_MASTER_PROMPT.md`。
起点 `4e1823c`（父仓库）/ 内嵌 Pi `42a3497d0`（干净）。

## 1. 精确契约与 live/durable/replay 调用点

### 1.1 三个事实（沿用 C6）与新增计划事实

- 每侧预算责任 / 请求联合结清 / 规划终止：C6 的 `c6-request-lifecycle.mjs` 继续权威。
- 新增“计划事实”：一个候选计划只有在**整图合法**且**一次 durable 批量准入**后，才具备
  可执行定义；批量准入与“计划完成门”是两个不同 durable 状态。

### 1.2 计划 JSON（`aegis-plan-1.0`）

| 层级 | 字段 | 来源/缺失行为 |
| --- | --- | --- |
| 外壳 | `version`, `plan_id`, `root_goal_ref`, `tasks[]` | 模型提案；`plan_id`/`root_goal_ref` 必填 |
| 单 Task | `proposed_task_id`, `parent_task_id`, `depends_on[]`, `goal.description`, `goal.success_criteria` | `depends_on` 缺失即拒绝（新批次）；空数组允许 |
| 执行/验收 | `task_type`, `target_ref`, `required_capabilities`, `expected_evidence`, `stop_condition`, `priority`, `budget_reservation` | 引用 Host 预授权模板/能力；不能定义新 Oracle |
| 绑定（Host 生成） | `template_ref`、`oracle_ref`、`scope`、`stage`、`plan_id`、`task_digest` | 业务 Oracle/criteria 来自可信模板，不继承规划 Task 判据 |

`parent_task_id`（拆分来源）与 `depends_on`（执行前置）分别校验、分别渲染。

### 1.3 live / durable / replay

| 阶段 | 位置 |
| --- | --- |
| live 规划 | `c6-model-worker.mjs` `createPlanSubmitTool`（同 C6 provider gate/final flush）；规划 Task 允许无业务动作返回计划 |
| durable 准入 | `scheduler.mjs` `admitPlan` → 单条 `campaign.plan.admitted`（含完整规范化定义与 depends_on）；`completePlanningTask` → 独立 `campaign.plan.ready` |
| reducer | `projection.mjs` `applyPlanSubmitted`/`applyPlanAdmitted`/`campaign.plan.ready`；应用前完成全部校验，不暴露合法前缀 |
| 调度 | `scheduler.mjs` 从 projection 取 `ready` 且依赖满足的 Task；依赖不满足不调用 provider |
| replay/UI | `e1-observation.mjs`/`e1-task-graph.mjs` 从 Manifest + EventLog 重建白板、树、DAG、计划、请求 |

新增事件词汇：`campaign.plan.submitted|admitted|blocked|rejected|ready`（`event-contract.mjs`，
按 kind 限定来源：submitted 允许 llm，admitted/blocked/rejected 为 runtime/human，ready 为 oracle/human）。

## 2. 真实链证据（真实 SDK + faux + 真实 EventLog）

命令：`node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-e1-planning-chain.mjs`

初始 Manifest 只含根目标容器与一个 Host 规划 Task（`task-plan`），无业务树。

- 模型通过 `aegis_submit_plan` 提交**三个**动态 Task（`dyn-a`,`dyn-b`,`dyn-c`），**输入数组故意乱序**
  （`[dyn-c, dyn-a, dyn-b]`），Host 按 id 建图；`dyn-c` 有两个前置 `["dyn-a","dyn-b"]`。
- `campaign.plan.admitted`（1 条批量记录，含 `plan_tasks` 与 depends_on）后，`campaign.plan.ready`
  独立释放执行门，子 Task 才按依赖进入 `ready`。
- 实际 dot 顺序：`dyn-a` 完成 → `dyn-b` 完成 → `dyn-c` 启动（`E1-PLAN: the diamond successor
  started after both prerequisites completed`）。
- Broker 产生 **3** 次真实效果，`dataset.json` 变为 `{name:"Ada", status:"active"}`；每个 Task
  恰好 start 一次；DAG 中 `dyn-c` 的两个前置都保留。
- 三个业务 Task 最终 `completed`；committed stream `verifyChain` 通过。

坏计划（一个节点引用未授权 target）：`campaign.plan.blocked`，无动态 Task，Broker effect=0，
文件未被修改，合法兄弟节点也不执行（整图拒绝）。

重启：完成后再次 run，Broker effect=0、文件保持修复、`dyn-c` 仍 `completed`（不重复执行）。

UI/API：`buildE1View` 从同一 EventLog 重建 `task_graph`（≥4 节点，`dyn-c.depends_on` 长度 2）与
白板节点内容。

## 3. 拒绝 / 未决 / 不完整准入

- 形状/权限/结构非法 → `campaign.plan.rejected`/`blocked`，无子 Task 效果（整图）。
- 批量 append 失败 → `status:"incomplete"`，reducer 不应用部分批次，未决保留（复用 C6 guard）。
- 依赖未满足 → 后继不 ready，不调用 provider、不产生效果（`E1-PLAN: an unsatisfied prerequisite
  blocks the successor provider/effect`）。
- 规划 aborted/error/commit 失败 → 由 C6 三事实阻断，不激活计划（C6 suite 覆盖）。

## 4. red / green / mutation

- red（实现前）：`aegis-e1-planning-product.mjs` 依赖丢失/无准入门等断言在旧代码上失败；
  当前实现后全绿。
- focused：`aegis-e1-plan-contract` **12/12**、`aegis-e1-planning-product` **7/7**、
  `aegis-e1-observation-view` **7/7**、`aegis-e1-planning-chain` all checks。
- mutation（行为 FAIL，`runtime/dev/e1-observable-run1/mutations.log`，5/5 killed）：
  | mutation | 目标 |
  | --- | --- |
  | 清空存储的 depends_on | 后继等待全部前置 |
  | 忽略 plan-ready 门 | 批量准入 vs 计划完成门分离 |
  | 跳过 target 授权 | 整图拒绝 |
  | 用 parentage 冒充 dependency | 树/DAG 分离 |
  | 计划提交即根目标完成 | 计划候选 ≠ 根目标完成 |

## 5. required 逐脚本结果（`runtime/dev/e1-observable-run1/`）

| 批次 | 命令 | 结果 |
| --- | --- | --- |
| 18 C6 | `c6-suite-runner …/c6 <18 names>` | 18 scripts, 0 failed |
| 26 回归 | `c6-suite-runner …/regress <26 names>` | 26 scripts, 0 failed |
| 8 附加受影响 | `c6-suite-runner …/affected <8 names>` | 8 scripts, 0 failed |
| 4 E1 focused | `c6-suite-runner …/e1 <4 names>` | 4 scripts, 0 failed |
| tsc | `tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json` | exit 1, 196 → 196，修改文件 0，诊断集合逐条相同 |
| Biome | `biome check <19 modified paths>` | exit 0 |

私有日志（ignored）：`c6/results.json`、`regress/results.json`、`affected/results.json`、
`e1/results.json`、`tsc-before.log`、`tsc-after.log`、`biome.log`、`mutations.log`、`baseline.txt`。

## 6. 零请求 prepare 与双终端命令

`observe`/`status`/`export`/`measure` 为零 provider 请求的只读路径（`READ_ONLY` 不创建 SDK runtime）。

```bash
# 终端 A：先启动只读观察（新包尚未 run 时也能显示目标/not_started）
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/memory/campaign/c6-entry.mjs --config <config> observe --port 0

# 终端 B：离线 demo 用 faux（配置 provider.kind="faux"）；真实 pack 由用户另行确认后运行
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/memory/campaign/c6-entry.mjs --config <config> run --export
```

开启规划：config 增加 `"planning": { "enabled": true, "templates": [ {template_ref, task_type,
oracle_ref, required_capabilities, scope} ] }`，Manifest 只含根目标与 `task-plan`。页面字段：
根目标/任务树/依赖 DAG/计划/请求（consumed/pending/unresolved）/白板六类节点内容与证据。

本轮**未运行真实 provider/CTF**；faux 仅证明工程接线。

## 7. 文件、分支、提交、工作树、未实测限制

分支 `feat/c6-agent-product`；内嵌 Pi `42a3497d0` 干净。本轮提交：
`e568d7f`（E1 契约/图/观测纯模块）、`458e467`（批量准入/依赖调度/规划 Manifest）、
`24cb506`（规划工具与观测接线）、`d92ae85`（E1 测试）。

未实测限制：
- 真实模型拆分质量、真实 provider 计费/流式故障、CTF 靶场适配未测；faux 不构成 LLM 解题能力证据。
- 树/DAG 默认 SVG-less HTML 列表与 JSON API；未做像素级视觉验收。
- `Planning` 目前一次有效计划；增量重规划后置。父子不自动聚合业务成果（成功来自冻结业务验收）。
