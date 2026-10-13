# 给主 DS：实施 C5 整体集成

C1-C4a 本轮审查交付已完成，最新 `docs/C4A_EXTERNAL_REVIEW.md`。下一轮只做 C5 离线总装。
完整读 Agent 入口、开发规范 §3.1、测试/Git 规范、`docs/C5_INTEGRATION_TASK.md`，
并读既有 C1-C4a 验收限制与实际 Host/SDK/Broker/Oracle/报告/观察模块。SDK 核对真实 API。

在干净起点建 feat/c5-integration，先冻结一个可复制入口、配置白名单、single writer/
Task-Episode-Session映射/预算基线与required场景，不造第二框架。有工具才分子Agent，否则串行。

目标：用户用一套明确命令/可信配置，运行 Manifest → scheduler → registered Broker →
本地效果 → independent Oracle → delayed/recovery/结果；接真实 SDK+faux 的安全轮换、
pause/resume/cancel/restart、C4报告与 optional C4a只读观察，不手工拼多个factory。
UI失败不阻塞执行，source/报告/观察同源，writer与账本只有明确所有者。
轮换后的新Session也加载Campaign gate，未决副作用不重发、失败无假完成、预算不双扣。

按任务书正常+动态、SDK轮换、delayed、控制、真实子进程中断恢复、授权/审计、导出/观察
和操作复现8项required验证。临时文件/subprocess/EventLog是真的，provider faux、不调用真实网络。
expected来自契约，先red再实现，相关回归一次完成；required/deferred分别报告。
F16 cache/旧类型基线/性能/并行/容器/远程平台/界面美化不追加门槛。

不改Pi核心/真实凭据/模型设置/lockfile，不新增未授权依赖、不触发真实模型/目标/网络，
不自动调用验收模型。真实能力对照需之后用户给具体任务/授权/预算，不因集成绿自动开展。

明确路径暂存、review、本地里程碑commit，不push/重写历史。维护简洁plan/matrix/report和
用户runbook，给实际命令/exit/ignored log/效果证据/commits/status/限制，不新增长审计链。
完成 internally_verified / awaiting_external_review，交一次限定C5验收，不自动进入训练/能力实验。
