# C 集成独立审计：进行中

以下来自实际Observer/tool/test代码，非架构变更建议。

1. 新aegis_observe/execute intent payload.action_id用eventId()，completed却用intent.event_id；两者不相等，pending永远残留。必须用Pi toolCallId或一个内部明确actionId贯穿requested/completed/data/outcome/evidence，record实际最终args/ref/transport，完整动作链可解析。
2. tool_result钩子也对自有动作生成completed，可能重复/陌生action。须单一路径统一配对，own tool内记规范记录，hook只附transport或避免重复；记录parentToolCallId。
3. 新工具跳过generic guard，若已auditUnavailable但log重开healthy，不能偷偷恢复副作用；每个effect前所有必要意图/admission持久化成功。验证后append失败不能返回已安全verified/recorded，数据仅实际生成但未记录须显式degraded。
4. Info/script step Outcome需要schema_version=1.0合法字段，unknown.observed=null、合法failure_mode、episode_id；不能用source=oracle直接绕过Ref/criterion gate，尤其observation需证据与版本。
5. 真Pi流水线当前script bitness是硬编码"64"，无data_ref参数、无最终绑定证明；虽然能运行，不证明用的指定已验证数据。需要data_bindings参数/受控resolve，从有效同Episode的verified data取path value，额外模型args冲突/改写不执行。
6. Replay/stale data须读已提交Event或私有artifact摘要重建；初稿resolver仅Map非真实用、artifact ref不存在私有内容。需要真实data observation ID/digest/path/version，可恢复后重建。目标文件变化已确认后旧data不进Fact/RAM，不仅保持helper存在。路径检查工作目录不是沙箱，边界如实写。
7. Scripts argv path参数(例如out)没有资源参数标注时可能指向任意外部路径；至少可将人类注册声明的path参数类型/方向加入契约并在effect前验证。模型不能改target/cwd/executable/script/oracle注册。普通模式环境APPROVED不等于每次用户批准记录，必须记录授权来源和作用域。
8. B2贡献API只在真正Action.completed+data exact ref+可信step Outcome存在后调用；obtained/used/advance分别记录。不能为了"三个阶段"自造3个success或依赖LLM自述。pipeline test动态从ELFtool result.data_ref取bits，再使用注册脚本+真实JSON后态检查并verify_use。
9. Pipeline回归要assert pending_actions为空、samePrompt nextTurn data新RAM可见、正常handoff不被错pending阻塞。当前tests单独prompt能看到数据，不证明每轮路径。
10. Compiler/Router目前是已测库，不声称接进生产Skill。若接入，真实Event resolver+注册action/version/checker，缺Replay证明保持candidate；独立隔离reset proof可复用fixture adapter，不能用库测试Map样例当比赛active证据。

审计者不写实现，由DS完成修复。C写范围与B2不冲突：Observer/action-runtime/launcher/daily/new tests，B2已结束后可使用其接口，但核心证据门修改仍须单独注明。
