# 交给 DS 的第二阶段提示词

复制下面完整内容给实现 DS。本文件是委派提示词，不是新的开发规范或验收结果。

```text
请继续 Aegis work-cycle 第二阶段开发。目标是修复已复现的核心边界，并在同一 C6 Task/Episode 内接通完整的复核、知识检索、Host 自动轮换与恢复路径。

本次主任务书：
docs/WORK_CYCLE_PHASE2_IMPLEMENTATION_TASK.md

现有接口契约：
docs/STRUCTURED_RAM_AND_WORK_CONTROL.md
其中“后续实现契约：工作单元、复核消费与 Host 自动轮换”已经用户认可，不需要为这些已决定的方向重复询问。

请先按根 AGENTS.md 读取固定开发规则，并遵守开发规范、测试规范、Git 规范及目标目录沿途 AGENTS.md。核对现有契约、实际调用点与内嵌 Pi SDK 签名。任务书只细化本次实现，不替代规范。

一、基线与保护

1. 当前预计分支 feat/work-cycle-session-handoff，基于 d84b692 存在第一阶段未提交交付。先核对真实 HEAD/status/diff、嵌套 Pi HEAD/dirty，逐项确认所有权并保留既有改动。不要重置、清理或覆盖整文件来回到旧提交。
2. Pi_Agent_base/UI/ 是用户独立工作，禁止读取、修改、暂存、删除或重置。
3. 本轮只做 Aegis-owned 代码、测试和文档；不改 Pi 核心、不升级依赖、不调用真实模型/网络/目标。
4. 未另行授权前，不暂存、不提交、不 push。交付完整可审查 diff 和真实测试证据。

二、按 P0–P6 完成，不止修三个局部 bug

P0：先把任务书 F1/F2/F3 的序列构造成正式回归，在当前交付上记录行为 red。ignored runtime/dev/work-cycle-independent-audit/ 有审查脚本与日志可参考；文件缺失时按任务书序列重建，不依赖私有文件才能验收。在现有 T0/矩阵补充接口、迁移、策略与测试计划。

P1：工作单元绑定有效 Intent 事件 ID + scope，与 Board effective/replacement 一致。checkpoint 只绑定当前单元，旧 complete 不影响新 Intent。分开保留最近可信进展以来的累计尝试和当前复核轮次尝试。按因果前缀派生 review 消费，一条 review 只解除对应的一次 trigger；旧 review 再引用不清零，普通换 scope、换 Session 都不清累计历史。复用 EventLog/Board/proposal gate，不造新权威表。

P2：接好 checkpoint/review 的既有 Campaign admit/charge/finish，包括内容复用调用；区分真实调用幂等和内容幂等。额度耗尽/绑定失效/durable 失败必须保持正确责任。补齐 ready/no_match/disabled/unavailable 的真实工具路径，unavailable 保持 hold，但资源恢复后可重试，不能被失败幂等记录永久卡死。

P3：复核 hold 与 Session 安全分开。实际 settled、审计健康、请求/工具结清、预算允许且无 pending/unknown 副作用时，可以携带未完成 review 交接；新 Session 仍保持同 trigger/计数/消费状态并阻断 effect。仅 review_required 不自动轮换；context 压力、当前单元完成或明确交接请求才构成理由。沿现有 Supervisor，不在 Observer agent_end 中直接创建 Session。

P4：先在 C6 Host 接通显式启用的自动策略和同 Task 非终态继续。配置路径由你核对现有结构后冻结；复用候选 3/8/4/85% 作为初始测试参数，公开未校准，不自动变成全局生产默认。策略绑定当前运行，恢复不靠可变 env 清门；每个完成边界只自动换一次，不重复使用旧 Session context 高水位。多个轮换理由只换一次，续请求沿原预算/授权。

必须检查 C6 的真实 Broker 最终执行边界：已缓冲计划、批量后续动作、Experience direct route 都要读取最新 work-cycle gate。被复核阻断时保留可继续状态，不能伪造 Oracle failure 或盲目重发。不能只在 Task 结束后的 onTaskSettled 换 Session；必须证明同一个难题在多个 Session 中继续。

P5：让知识/Experience selection、Intent 声明采用、实际 action 显式引用、独立结果形成可解析关系。没有引用证据就记 unknown，不按时间邻近推断 used/useful。知识与模型摘要不升级为 Fact/Outcome/权限或 active Experience，独立证据门不变。RAM 继续有界并优先保留任务/授权/预算/未决责任。

P6：完成任务书 required 矩阵和交付，更新现有 T0、WORK_CYCLE_TEST_MATRIX.md、WORK_CYCLE_IMPLEMENTATION_REPORT.md，保留第一阶段自测与独立 changes_required 历史。不要为每个小修另造报告体系。

三、必须证明的产品结果

- F1/F2/F3 red→green，覆盖旧 review 再引用、同 scope 新 Intent、旧 checkpoint、预算 0 和失败结清。
- 真实 C6 产品入口 + 真实 Pi SDK + faux，在同 Task/Episode 中经过至少两次不同 trigger 的复核和两次真实自动 Session 轮换。
- 新 Session 对象/context/file/id 真实变化；原 Episode/目标/权限/累计预算/hold/引用连续，无全 transcript 重放。
- 携带 review hold 的交接有正例，pending/unknown effect 或未结清账本拒绝交接有负例。
- 一次新增链路中断恢复，旧 review 不再消费、工具/Session 不双记、动作不盲目重发。
- Broker 批量动作在阈值后的下一 effect 被最新 gate 阻断；Experience 不能绕过。
- 同完成依据不空转换 Session，旧 context 不连锁触发；waiting_external/暂停/取消/终态不自动恢复探索。

手动调用 supervisor.rotate() 的测试不能冒充 Host 自动化；两个不同静态 Task 各换一次不能冒充同难题跨 Session。普通 run-aegis/run-experiment/run-pi 本阶段保留人工 /aegis switch，清楚报告支持差异。

四、推进与检查

沿任务书顺序，局部测试通过就继续依赖任务；不要停在计划或局部修复。routine 字段/函数命名与现有 additive payload 接线由主 DS 冻结后自主实施。只在需要扩大授权、改 Pi/依赖、改 Outcome/Episode/独立证据语义等未授权决定时暂停相关工作，其余独立任务继续。

先聚焦，再跑受影响 C6/ledger/Broker/C2/Observer/RAM SDK 回归，最后按现有 required 清单运行一次；新 required 用例另列显式清单。Biome、类型差异、module-layout 按改动范围执行并报告真实退出码。不因缓存优化、真实 solve-rate 未测或无关历史失败无限扩大当前验收。

最终交付：改动文件/调用链；接口与旧日志兼容；策略启用方式；每项真实命令/exit/log；两轮自动化与一次恢复的事件和账本证据；按入口列实际支持；blocker/non_blocking/deferred；分支/HEAD/status 和 UI 未触碰确认。标 internally_verified / awaiting_external_review 后交回。没有受控真实实验，不能声称解题率或学习收益已经提升。
```
