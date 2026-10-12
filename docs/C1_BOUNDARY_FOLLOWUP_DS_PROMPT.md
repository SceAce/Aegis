# 主 DS 提示词：C1 F14–F16 残余收尾

你是 Aegis 主 DS，继续当前 Git 管理的 C1 修复，不进入 C2。
先完整阅读并执行：

```text
Pi_Agent_base/AGENTS.md
docs/AGENT_DEVELOPMENT_STANDARD.md
docs/AGENT_TESTING_STANDARD.md
docs/GIT_STANDARD.md
docs/CAMPAIGN_CONTRACT_BASELINE.md
docs/C1_BOUNDARY_EXTERNAL_REVIEW.md
docs/C1_BOUNDARY_FOLLOWUP_TASK.md
docs/C1_EXTERNAL_BOUNDARY_FIX_TASK.md
```

最新外部复核基线为 7656e99：原 F10-F13 的 21 测试已通过，但新增复核 12 用例为
2 pass / 10 fail。先真实运行 red，记录分支/HEAD/status/命令/exit/log，然后更新工作计划
与共同测试矩阵。保留全部外部断言，不 skip、不 expected-failure、不仅断言布尔值。

只完成以下已授权残余要求：

1. F14：Stage 整个 provenance 缺失/null 仍被当可信；内部 foreign step_id 被外层 routing
   id 覆盖后假完成。完整校验独立 provenance 与内外归属冲突，两条完成门一致；真实
   EventLog+Scheduler 的合法对照/两个反例均须通过且 worker 不重跑。
2. F15：恢复仅 clone Outcomes，reservation 仍共享，tail 会修改调用方 checkpoint。
   隔离可变恢复状态；同一 priorState 重复恢复结果相同且输入不变、与 full replay 一致。
3. F16：startup 接受 cache+tail 后，reconcile/loop/status/checkpoint 又从头 full project。
   恢复投影必须驱动后续流程，坏 cache fallback 保留。used_checkpoint 不能只是布尔表演。

全文审查 resolver/projection/scheduler 与关联调用者；共享文件按依赖串行，不再造平行
框架。有子 Agent 则限定文件分工，无则串行切换角色并如实报告。新增真实缓存文件恢复、
改变状态 tail、动态/去重/控制/stranded 场景；测试比较完整状态，补有限隔离 mutation。

纠正旧报告：red 是 21=2 pass+19 fail；不要推断 crypto stub/hash 过滤/Git placeholder，
当前标准向量和 HEAD 对象检查正常。tsc 当前 exit 1（10 个旧依赖诊断）必须如实报告。

完整运行新复核、全部 Campaign、Biome、tsc、8 offline+4 SDK/faux 回归（正确 resolver）。
原始日志 ignored，报告只含有界引用。逐任务明确路径暂存、审查并本地 commit，不 push、
不改写历史，不改 Pi/凭据/模型/lockfiles、不跑真实模型或目标网络。

更新五份 C1_BOUNDARY 交付文件，报告 F14-F16 闭环、red/green、实际缓存接线、mutation、
分支/commits/status 和未验证范围。内部通过后只写
internally_verified / awaiting_external_review，停止交回当前会话外部验收；C2 不启动。
