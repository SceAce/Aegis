# 交给主 DS 的提示词：C1 F10–F13 收尾

你是 Aegis 主 DS。本次任务是修复外部审计已复现的 C1 边界问题，按任务图自行拆小任务、
先测试、再实现、再集成和审查。完成后停止等待外部验收，不进入 C2。

先完整阅读：

```text
Pi_Agent_base/AGENTS.md
docs/AGENT_DEVELOPMENT_STANDARD.md
docs/AGENT_TESTING_STANDARD.md
docs/GIT_STANDARD.md
docs/DS_ORCHESTRATION_WORKFLOW.md
docs/CAMPAIGN_CONTRACT_BASELINE.md
docs/C1_FINAL_EXTERNAL_AUDIT_3.md
docs/C1_EXTERNAL_BOUNDARY_FIX_TASK.md
docs/C1_FINAL_AUDIT_FIX_TASK.md
docs/C1_INTEGRATION_TEST_SPEC.md
docs/C1_CLOSURE_BASELINE.md
```

再完整读取实际修改模块及其调用者、测试和 helpers；不要只读旧报告或函数片段。
有子 Agent 工具则按文件所有权委派；无工具则串行切换测试/实现/审查角色，如实报告。

先记录 `git status --short`、分支、HEAD，创建修复分支或继续已明确的任务分支。
当前实现已由 Git 纳管；历史文档“不做提交”已被当前用户要求覆盖，遵守 GIT_STANDARD。
只逐路径暂存本任务文件，审查 staged diff，按任务单元本地 commit；不 push、不改写历史。

首先运行并保存 red 证据：

```bash
node --test Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs
```

审计基线为 21 用例：2 个合法正例通过、19 个行为反例失败。当前仓库可能已有其他改动，
以你的实际结果为准，不把 import/syntax 错误当已复现逻辑缺陷。不删/skip/改弱外部断言。

必须修复：

1. F10：当前 Task scope 缺失时 resolver 跳过校验，甚至双 null scope 能 completed。
2. F11：Stage foreign/missing scope、missing Episode、空 evidence、非独立 provenance
   仍通过两条完成门；真实 Scheduler + EventLog 也能复现 foreign scope 假完成。
3. F12：checkpoint hydration 丢失 Episode、Outcome/command 去重，foreign Episode
   在 cache+tail 被接受，重复命令双扣账。
4. F13：实际 writer 不存 Episode，projection digest 不含完整 Stage 内容；修正 prefix
   验证与 tail 应用顺序，证明 scheduler 真用恢复 state，而非布尔 used_checkpoint 表演。

保持单一完整完成门与既定 Outcome/unknown/supersede/权限语义，复用共同 resolver/聚合；
不要再造一套框架或只补一个 if。相邻绑定/类型/证据缺失一次检查，保留合法正例。
先生成 `C1_BOUNDARY_WORK_PLAN.md`、`C1_BOUNDARY_TEST_MATRIX.md`，冻结契约/owners/expected。
按任务书执行 B-BASE → B-SCOPE/B-STAGE/B-RESTORE → B-CACHE → B-E2E → B-REVIEW。

补真实 EventLog、实际 checkpoint writer/read/hydration、动态 Task scope、prefix+tail
vs full replay、真实子进程重启用例和隔离 mutation。测试要看 state/refs/账本/效果次数，
不只看 text、调用计数或一个 helper 返回 ok。完整运行 Campaign、Biome、tsc、8 offline
和 4 Pi/faux 回归；Pi/faux 用 source-resolver。tsc 当前有 10 个旧导入错误，报告实际
exit，不写“0 errors”掩盖命令失败。原始日志留 ignored runtime/dev/，报告只给有界引用。

不修改 embedded Pi、凭据/模型设置/lockfile；不触发真实模型/网络/目标，不恢复旧 demo。
不宣称外部副作用 exactly-once；不自动调用验收模型，不进入 C2/C3/C4a。

交付任务书指定的五份 C1_BOUNDARY 报告，列明 F10-F13 闭环、实际 checks/exit/log、
red/green、mutation、真实产品路径、分支/commits/工作树、遗留与未测。
内部通过后只写 `internally_verified / awaiting_external_review`。完成即停止，将材料
交用户带回当前会话外部验收；有 P0/P1 未解就如实写 changes_required。
