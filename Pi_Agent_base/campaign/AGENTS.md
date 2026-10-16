# Campaign 模块规则

适用于 campaign/。负责冻结 Manifest、规划/准入、任务图与队列、Host/Scheduler、预算与请求生命周期，以及产品入口/SDK 组装。

- 将行动和适配器放 execution/，判断放 verification/，观测放 observation/，记忆放 memory/；入口负责组装，不复制模块权威规则。
- 运行的授权、预算、规划上下文和执行协议绑定冻结输入；可编辑配置不能静默扩大或降级语义。
- live、durable、replay、status 使用一致的准入与结清规则；checkpoint 是缓存，不能替代已提交源。
- 每侧消费责任、联合请求结清和模型/规划终止是不同事实，不能以 committed 标签或 pending=0 互相替代。
- 动态任务由 Host 校验完整计划、身份、依赖和累计分配后准入。模型提案、工具完成或历史完成标签不直接授予子任务执行许可。
- 在实际请求/工具/效果边界检查最新权威状态；未决责任保留 hold，不靠恢复自动重发不明副作用。
- 控制命令、ownership、幂等与崩溃恢复必须保留实际事件证据，拒绝不能伪装 Oracle failure。

按需依据：[Campaign 契约](../../docs/CAMPAIGN_CONTRACT_BASELINE.md)、[架构](../../docs/CAMPAIGN_ARCHITECTURE.md)；改规划/权威接口时另查 [E1 契约](../../docs/E1_CONTRACT_CLOSURE_TASK.md) 对应章节。先核对当前代码与用户范围，历史阶段许可不授予新实验。

验证选择：aegis-campaign-contracts-c0、aegis-campaign-c1-integration-contracts、aegis-campaign-c1-integration-e2e；请求门选 aegis-c6-lifecycle-convergence、aegis-c6-lifecycle-restart、aegis-c6-architecture-review；规划选 aegis-e1-planning-gate-audit、aegis-e1-authority-invariants、aegis-e1-single-authority-review；入口变更选 aegis-c6-runbook、aegis-c6-provider。启动见 [测试规则](../tests/AGENTS.md)。
