# C1 外部边界修复任务：F10–F13

状态：**C1 changes_required；C2 blocked**。
依据：`C1_FINAL_EXTERNAL_AUDIT_3.md`，已提交的正常失败测试
`Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs`（21 用例，2 pass / 19 fail）。
用户要求先审计并补测试，发现问题则完善文档交给 DS 修复；本轮修复由 DS 执行。

## 1. 必读与边界

完整阅读：

- 本任务书、`C1_FINAL_EXTERNAL_AUDIT_3.md`、`C1_FINAL_AUDIT_FIX_TASK.md`；
- `AGENT_DEVELOPMENT_STANDARD.md`、`AGENT_TESTING_STANDARD.md`、`GIT_STANDARD.md`；
- `DS_ORCHESTRATION_WORKFLOW.md`、`CAMPAIGN_CONTRACT_BASELINE.md`；
- `C1_INTEGRATION_TEST_SPEC.md`、`C1_CLOSURE_BASELINE.md`；
- `Pi_Agent_base/AGENTS.md` 与所有实际修改的完整源码/相关测试。

复用当前 EventLog、resolver、聚合与 Scheduler，保持 F7 单一完成门；不新建平行框架。
不修改嵌入 Pi、凭据、models/settings、lockfile，不运行真实模型/目标/网络。
不恢复已删除 Python demo 或根 AGENTS。C2/C3/C4a 不进入本任务。

## 2. 任务图与所有权

| 任务 | 内容 | 主要文件 | 依赖 |
| --- | --- | --- | --- |
| B-BASE | 记录 Git 与失败基线，冻结修复契约/测试矩阵 | docs、tests | 无 |
| B-SCOPE | F10 当前 scope 缺失 fail-closed | outcome-resolver、相关投影 | B-BASE |
| B-STAGE | F11 完整 Stage 接纳与完成门接线 | outcome-resolver、projection、aggregate 必要处 | B-SCOPE |
| B-RESTORE | F12 归属/幂等恢复 | projection、scheduler、必要 checkpoint schema | B-BASE |
| B-CACHE | F13 完整摘要/writer/prefix 验证与实际恢复 | scheduler、projection、ownership 必要处 | B-STAGE、B-RESTORE |
| B-E2E | 真实 EventLog/子进程恢复、mutation、回归 | tests/helpers、docs | 上述 |
| B-REVIEW | 全文 diff/调用链审查、提交和报告 | docs、共享接线 | B-E2E |

主 DS拥有共享模块、公共接口、runner/config、文档和最终集成。
同一 projection/scheduler 文件的子任务串行或由主 DS统一编辑；没有子 Agent 工具则串行切换角色。
routine 命名/已知缺陷修复不重复请示；改变授权或证据门须停止相关工作并报告。

## 3. 冻结契约

### F10：可信 scope

- scope 来自 committed Task definition / 可信 Host 环境，不能从待判定 Outcome 推测。
- 当前 scope 缺失、Outcome scope 缺失、双方都缺失，均不能产生可信成功。
- foreign scope 拒绝；匹配 scope 与键顺序不同但语义相同的 scope 接受。
- 静态/动态 Task、直接 resolver、projection、checkpoint 恢复使用同一解析语义。
- `{}` 等显式值按既定契约处理，不以 truthy 判断替代 scope 类型/存在性校验。

### F11：Stage 完整绑定

在可信 Host source 边界后，Stage 仍须绑定当前 Task、非空匹配 Episode、Stage/criterion、
可信 scope、独立判定来源与可解析非空 evidence。success 的 observed 也必须按现行 Outcome
契约检查，不能只凭 status/source 成功。

保持 unknown/missing/invalid/foreign/冲突/合法 supersede 的含义；无证据不是 failure。
非法 correction 不得通过旧 success 偷过完成门；合法最新 unknown 仍阻断 required Stage。
普通 completed 与 reconciliation 通过同一个完整门；失败不重跑 worker。
对相邻缺失/错误类型/foreign 字段一次检查，保留合法正例和 optional Stage 语义。

### F12：恢复与幂等

- writer 和 hydration 均保留 episode_id，以及实际参与判定的 attempt/session/归属状态。
- command/outcome 去重跨 prefix+tail 保持，重复 budget consumed 不双扣、重复 Stage 不双计。
- 恢复使用独立反序列化状态，不依赖原对象共享引用；不要 mutate 调用方 checkpoint。
- 缓存缺少必要字段/版本不支持时安全 fallback 到权威 EventLog，不能猜 current Episode。
- full replay 与 cache+tail 对 foreign 绑定、unknown、账本、动态任务、结果索引和控制态语义一致。

### F13：完整持久投影与实际接线

- 明确一套完整 state snapshot：定义、Episode/当前绑定、Stage/Task Outcomes、proposals、
  账本、控制、恢复/去重所需字段与必要诊断。状态摘要覆盖其所有语义字段。
- 不把包含 tail 的 snapshot 原样用于 state-only digest；显式说明排除的流位置/非语义字段。
- 实际 `persistCheckpoint` 用该契约持久化，不能只有测试 helper 的临时 priorState 完整。
- 先验证 checkpoint 对应 prefix 的内容/state digest，再应用 tail；不能把更新后的 tail
  state 与旧 prefix state digest 比较。
- 证明 scheduler 后续读取恢复 state，而非设置 used_checkpoint 后仍始终 full replay。
  任一 cache 被删/损坏/过时则由 EventLog重建，不改变授权、完成或副作用次数。

## 4. 测试矩阵与 red/green

主 DS先创建 `C1_BOUNDARY_WORK_PLAN.md` 与 `C1_BOUNDARY_TEST_MATRIX.md`，逐行记录：
requirement、case、入口、输入来源、expected、脚本、命令、exit、log、验证层级。

保留外部边界套件全部断言；新增以下产品入口覆盖：

- 缺/foreign scope、缺 Episode/observed/evidence、非独立 Stage 两条完成路径；
- 动态 Task committed scope 在重启后持续检查；
- 真实 Scheduler writer 写出的 checkpoint 经文件序列化/重新读取，foreign Episode
  在 cache+tail 与 full replay 同样拒绝；
- 重复 outcome/command 跨真实 checkpoint 不双计/双扣；
- prefix checkpoint + 改变状态的合法 tail 真正被使用，最终完整 snapshot 等于 full replay；
- 同 IDs 改 status/criterion/evidence/observed/scope 会改变实际 scheduler state digest；
- 真实子进程在 intent/result/checkpoint 边界退出后重启，worker effect 不重发、unknown 保留；
- 删除 checkpoint 后只凭 immutable Manifest + committed EventLog 得到相同语义状态。

检查所有 malformed 输入不会意外 TypeError；错误诊断需具体，不能只断言 non-ok。
已有错误预期可修正但必须记录契约依据，不得将失败测试 skip/预期失败/改弱。

有限 mutation 在隔离副本进行，至少覆盖：null scope 跳过、Stage scope/证据 gate 删除、
恢复 episode 字段删除、去重恢复删除、state digest 只含 IDs。各次必须由行为断言杀死，
syntax/import 错误不算。每次记录 mutation→case→实际退出码。

## 5. 检查入口

仓库根：

```bash
node --test Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs
node --test Pi_Agent_base/tests/aegis-campaign-*.mjs
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json Pi_Agent_base/memory/campaign Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs Pi_Agent_base/tests/aegis-campaign-c1-final-audit3-adversarial.mjs
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json
```

另运行 `C1_FINAL_AUDIT_IMPLEMENTATION_REPORT.json` 中显式列出的 8 offline + 4 Pi/faux
回归；faux 使用 source-resolver。主 runner 必须捕获每个实际 exit，不经管道掩盖。
类型检查基线为 10 个旧导入错误，必须列明，不能把命令 exit 1 写成通过；不通过关闭
checkJs/排除本次修改掩盖新增错误。纯 JSDoc 旧错误可在明确兼容影响后单独修复，不作重构。

## 6. Git 与交付

遵守 GIT_STANDARD：开始记录当前任务分支/HEAD/status，明确路径暂存；每个完成任务单元
提交，不 amend/rebase/reset 历史，不 push。审核阶段留下的 red 提交是合法审计基线，
修复实现应使测试转绿，不删除该证据。未提交文档不等于交付。

输出：

```text
C1_BOUNDARY_WORK_PLAN.md
C1_BOUNDARY_TEST_MATRIX.md
C1_BOUNDARY_IMPLEMENTATION_REPORT.md
C1_BOUNDARY_IMPLEMENTATION_REPORT.json
C1_BOUNDARY_REVIEW_REPORT.md
```

报告给出 F10-F13 闭环映射、实际 diff/路径、命令/exit/log、red/green、mutation、
真实 EventLog/缓存/子进程产品证据、分支与 commits、遗留问题和未验证范围。
全部阻塞发现闭环后写 `internally_verified / awaiting_external_review`，否则 changes_required。
完成即停止，交回本会话验收；不能自行标外部通过或启动 C2。
