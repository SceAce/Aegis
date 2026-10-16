# 独立验证规则

适用于 verification/。负责 Oracle、Outcome 解析与聚合、注册测试和离线 live/replay 验证入口。

- 判断绑定 Campaign/Task/Episode/Stage/criterion/subject/scope 与可解析证据；来源标签或 digest 本身不能证明真实结果。
- 独立读取实际产物/状态，transport exit 0 或模型声明不能代替结果验证。
- success/failure/unknown/invalid 保持不同含义；所需 criterion/stage 不完整时不能靠局部 success 完成任务。
- 处理合法 supersedes、当前证据 prefix、环境失效和未消解冲突，消费者使用同一有效判断语义。
- 注册测试绑定受审实现、参数和隔离环境，不能让模型提交任意 checker/命令作为可信 Oracle。
- 离线重放的证据范围与真实独立 Episode 分开，不夸大学习或真实目标效果。

按需依据：[MEMORY_SCHEMA](../../docs/MEMORY_SCHEMA.md) 的 Outcome/证据章节及当前任务契约。

验证入口：aegis-campaign-contracts-c0、aegis-campaign-c1-external-boundaries、aegis-e1-closure-judgments、aegis-e1-single-authority-review；CLI 变更加 live-oracle-smoke、replay-oracle-smoke。启动见 [测试规则](../tests/AGENTS.md)。
