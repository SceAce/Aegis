# E：最终接线和开发规范（C2完成，D3/D4仅改resolver/engine与own tests）

用户授权今晚补全已议定架构，Supervisor仅审计、你DS编码。背景看THINK当前架构/已回答部分、ARCHITECTURE_DECISIONS前60行、OVERNIGHT_TASK、C2_REPORT、D_REPORT/D_AUDIT。C2已完成实际信息Action→图板→RAM→绑定data→脚本Oracle→阶段贡献，D3/D4正在加固仅evidence-resolver/workflow-engine，禁止修改这两个文件及theirtests。允许修改Observer/contest launcher/daily/new learning adapter和own realPi tests+docs；Pi/auth/models/settings/原userdeletions不可修改，no commit/network/model tests。

目标：实际产品入口可调用已测Compiler/Router/Skill库，同时满足现行证据门。没有Proof/映射不可active，留显式candidate/gaps，不为演示伪造隔离记录。

1. 先修代码规范：监督者read-only biome对Observer/contest找到4errors+11warnings。使用嵌入Pi biome config或Aegis-owned小config约定，不扩散格式化Pi core/legacyfixture/不相关文件；由你执行formatter/import organization和semanticunused cleanup，修noNonNullAssertion/noany/notneededcasts；聚焦修改owned extensions与新增runtime。运行read-only check与实际tests，不能禁用关键规则装通过。如果checkJs/tsc需要小本地配置可新增限定owned TS范围，不改Pi tsconfig。报告格式检查和类型检查是否真的完成，不用“smoke能加载”冒充。
2. 增加薄library-to-Observer learning adapter，以Observer唯一writer和已提交Event/effectiveBoard构造productionResolver；当前C2 createEventRefResolver/data索引与D evidenceResolver如shape不同，应明确映射而非私下造record/依赖模型提案。新候选来自aegis_propose with when/do/expect，可结构化action_ref/args/predicate/checkers等增量接口，text不eval。绑定缺gap返回候选待验证，不直接hint。
3. 受控 `/aegis learn`/`compile`/`route`/`bind`/`run`（名称可统一subcommands），让人类或可信Host操作工作流，而非模型自己写active。只从明确任务runtime已记录规范proof IDs导入，成功后写experience版本事件或既有runtime.note并projection。结果candidate不写伪active。stageUseful只是正向关联，不替代Replay与独立门。
4. 可配置可信已审阅隔离adapter模块(无配置=未配置/不重跑)，代码由人类配置explicitpath，不LLMexec字符串；replay adapter必须fresh local temp实际before/after+transport/impl/args，原target和remote/nonidempotent不会自动重跑。models只能提出验证请求/已有动作，proof writer是可信Runtime/Oracle。
5. route调用规范active Experience+当前有效已验证条件/target scope/authorization，fourmodes direct/habit/hint/deliberate。direct零模型规划、final params+data+授权+Oracle，habitLLM仅补参数后重新Gate。paused是绑定状态，不擅自第5推理等级。newcandidate不能hint。冲突/不匹配/unknown返回具体差异，false和unknown不混。
6. product-level真实Pi faux验证：可控多Episode学习与同方法Replay记录通过实际adapter得到active，第三task route→confirmeddirect→actualregistered broker executes→Oracle；缺Proof/replay adapter只candidate+nogapsclaim；没有同一EventLog/当前有效来源不能编译。若一般workflowscope/params尚无法满足门，不伪造，写必要人的选择进docs/OVERNIGHT_E_PENDING.md并保留可用candidate/route接口，不删架构。
7. 当前比赛launcher一条绝对路径在外部cwd工作，保留Observer/contest和全部自有tools，auto/normal仅注册工具还是全局Pi需如实写，普通bash仍有OSprivileges不是sandbox。无auth/config改动。自动handoffhelper可只追加薄SDKHost opt-in，不重写PiUI；没接入口则THINK待决不假自动。
8. 更新短运行说明/API与完整验收清单，daily能引用learningdecision/outcome/data contributions/交接，不自动因果/晋升；privacy所有runtime/reports私有、卡/registry版本明确。

按顺序normcleanup→薄adapter接口→actualtests→docs，不要创造新的学习术语或删现有模块。D libs还在写期间可先规范extensions，不跑其inflighttests当final。需要确定policy写E_PENDING，Supervisor统一THINK。最终列已实现/未接入/未验证，不宣称整个理论有效。
