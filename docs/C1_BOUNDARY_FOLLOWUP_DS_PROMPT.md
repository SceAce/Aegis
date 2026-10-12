# 主 DS 提示词：最小修复 F14，然后推进 C2

历史任务已完成并通过限定外部验收，见 `C1_F14_EXTERNAL_ACCEPTANCE.md`。当前请执行
`C2_SESSION_ROTATION_DS_PROMPT.md`；下文仅保留当时任务范围，不重复启动 C1。

用户已确认阶段推进规则：冻结验收范围，不把所有边界/优化都当阻塞。先阅读
`Pi_Agent_base/AGENTS.md`、开发规范 §3.1、测试规范、Git 规范，以及
`docs/C1_BOUNDARY_FOLLOWUP_TASK.md`，按更新后的范围执行；旧任务书扩大要求不再适用。

当前只修 F14：

1. Stage 缺整个 provenance/null 或独立性证明时不能因为 oracle.source 存在而完成任务。
2. 内部 foreign Stage ID 不能被外层 routing ID/canonicalization 改写成当前 Stage 成功。

复用共同 resolver/projection，做最小修复，验证两条完成路径和真实 EventLog 产品对照。
先保存 red，修复后运行：

```bash
node --test --test-name-pattern='^(CONTROL|F14)' Pi_Agent_base/tests/aegis-campaign-c1-boundary-review.mjs
```

保留原有已通过的 17 个 Campaign 回归，按实际 diff 运行相关格式、类型及 offline/faux 检查。
F15 非阻塞，可顺手小修；不为它单独延迟交付。F16 缓存优化后置，不重构调度器，不要求
prefix 读取次数测试通过。混合套件可保留失败，准确报告 required/deferred，不能删除断言
或伪称全量绿。后置项记录责任阶段、运行限制和重新评估条件，不假定会自动修好。

复用现有报告，只更新 F14 证据、F15/F16 处理、测试结果和 Git commits；不重建整套长文档，
不扩大审计、固定 mutation 数量或反复重跑无关回归。新问题只有复现当前假成功、越权、重复
副作用、错误账本等核心损害才可成为新增阻塞，须说明为何不能后置。

按 Git 规范分任务本地提交，不 push、不重写历史、不改 Pi/凭据/模型/lockfile、不跑真实网络。
内部验证后交回一次限定的 F14 外部复核，不自行宣称外部通过；通过即进入用户已同意的 C2，
不因 F15/F16 重开 C1。已有外部确认后不重复请示同一阶段授权。
