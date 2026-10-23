# 交给 DS 的第二阶段补测提示词

复制以下完整内容给测试 DS：

```text
请负责 Aegis work-cycle 第二阶段的补测与限定复验准备。本次只编写/完善测试、运行隔离测试、整理证据和文档，不修改产品实现。测出失败保留真实 red，交回原实现任务修复，不通过放宽断言或改契约制造通过。

主任务：docs/WORK_CYCLE_PHASE2_TEST_HANDOFF.md
需求依据：docs/WORK_CYCLE_PHASE2_IMPLEMENTATION_TASK.md 与 docs/STRUCTURED_RAM_AND_WORK_CONTROL.md
结果更新：docs/WORK_CYCLE_TEST_MATRIX.md、docs/WORK_CYCLE_IMPLEMENTATION_REPORT.md

先按根 AGENTS.md 加载固定规则，遵守开发规范、测试规范、Git 规范及目标路径 AGENTS.md。记录实际分支/HEAD/status、嵌套 Pi 状态和文件所有权。预计当前分支 feat/work-cycle-session-handoff、HEAD d84b692，第二阶段实现仍未提交。保留既有改动，不 reset/clean/stash/整文件覆盖。

禁止读取或触碰 Pi_Agent_base/UI/。不改 Pi 核心/依赖/生产配置/凭据，不调用真实模型、网络或目标。不暂存、不提交、不 push。无需用户提供真实 Session ID：真实 Pi SDK + C6 Host/Supervisor + faux provider + 临时文件系统即可验证这些机制。

请先审查当前验收会话留下的未跟踪测试草稿：
Pi_Agent_base/tests/aegis-work-cycle-missing-evidence-sdk.mjs
它不是已验收实现。最后一次完整执行为 3 cases / 2 pass / 1 fail / exit 1：unavailable 恢复通过、context carry 通过其已有断言、no_match 实际 ready 而失败。context 草稿尚缺授权 workspace read 的实际成功证据。参考现有 SDK/Host 测试收敛或拆分，不另造测试框架，不覆盖其他 Agent 工作。

依次完成：

1. TEST-06A：真实 C6 actions 形成 stall；缺失知识目录使实际 aegis_work_review 返回 unavailable、记录 selection/review 且保留 hold；真实 effect 被拒；明确失败边界后创建可命中 seed，同 trigger 真实检索恢复为 ready，新合法 Intent 后 effect 可执行。校验因果 refs、双计数、消费、调用 charge/finish。

2. TEST-06B：可读空目录实际检索，review 的工具返回、selection、review 事件明确 no_match，空 selected，不报告知识命中或可信成功；后续合法 Intent 仍能继续。当前产品实际 ready+[]，保留 red 交实现者修正，不把 expected 改成 ready。

3. TEST-07：同 Task/Episode 在未 review 的 hold 下，通过 faux 回复内容积累真实 SDK context usage 到阈值以上且窗口上限以下；Host 自动轮换，而非手动调用 rotate 或伪造 usage 事件。捕获实际 Session 对象/id/file 和新 Session 首个 provider-bound RAM，确认同 trigger/双计数/消费与授权预算连续，旧 transcript 不重播，旧高水位不重复换。新 Session effect 真正被拒，授权 workspace read、知识检索、review 分别实际可用，合法 Intent 后原 Task 可继续。不能用知识查询代替 workspace read；若发现阻断保留失败。

4. REG-R1：真实 SDK 重现 review R→Intent B 消费→action 一次→Intent C 引用 R 并 replace B；预期累计4、轮次1、消费仍绑定原B，普通计划替换不移动历史窗口。当前该组合已独立复现 fail。补正式回归与少量 prefix/replay 验证。

5. REG-R2：真实 C6 Run1 Session预算0拒绝轮换；Run2同源恢复仍额度0，不能出现 handoff.completed 或在拒绝边界下继续下一单元 effect。再做明确纠正额度后的正例，必须观测真实 Host/Supervisor/newSession，不能仅数 completion 行就声称恢复成功。当前0→0恢复已独立复现 fail：completion=1、rotation_attempts=[]、Task completed。

6. TEST-09：request threshold 与 complete 同一安全边界，只执行一次真实轮换，两个理由可见，Session消费一次。补原not_run这一组合即可，不扩成全组合。

原独立反例在 ignored Pi_Agent_base/runtime/dev/p2-independent-review/ 可参考；文件缺失时按任务文档序列重建，正式测试不得依赖私有产物。所有输入真实经过产品工具/gate；不mock被测算法、不patch getContextUsage、不注入“已通过”事件。expected来自任务契约。faux决定模型响应，但实际检索、文件效果、Host/预算/轮换都须真实执行。

先审查草稿并固化矩阵，再写/运行用例。任何测试设计错误需说明契约依据后修正，不能保留错误失败，也不能削弱正确预期。确保环境隔离/恢复、finally清理、没有真实凭据/网络；保存真实command/exit/log。用name pattern诊断时单独标记，完整交付需跑显式清单并保留非零退出码。

测试交付允许红灯：标 tested / changes_required 并列出缺陷与可执行复现。不要在本测试委派擅自修产品。原实现者修复R1/R2/no_match及补测新发现后，再沿原第二阶段授权处理和回归。当前验收清单限定在任务文档§5，不把缓存/真实解题率/普通入口自动化/新UI加入硬门。

最终报告：每项case的预期/实际/command/exit/log与关键refs、实际Session变化和文件效果、账本数字；已通过/失败/blocked/not_run分开；测试草稿如何收敛；当前离通过还差哪些明确事项；修改文件、分支/HEAD/status，确认UI和产品代码未触碰。更新已有矩阵/报告，保留历史自测与独立changes_required，不自行宣称外部验收通过。
```
