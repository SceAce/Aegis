# 工作流协调规则

适用于 orchestration/。只协调执行、证据、学习和编译接口，不承担第二套执行器或权威日志。

- 复用 execution/ 的 Broker 与 final 参数授权、memory/ 的证据 resolver/学习门以及调用方提供的可信 sink。
- 模型不能传入 resolver、checker、函数、可执行命令或 grant 来影响可信判断。
- 区分 route、execute、verify、compile：匹配经验不等于成功，执行完成不等于可信 Outcome，提交候选不等于激活。
- 动态代码执行、经验执行脚本、直接副作用不放在协调层。

验证入口：aegis-workflow-engine-d、aegis-workflow-evidence-d、aegis-workflow-live-script-d；跨学习入口加 aegis-learning-bridge-e。启动见 [测试规则](../tests/AGENTS.md)。
