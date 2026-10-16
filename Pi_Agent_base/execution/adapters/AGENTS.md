# 执行适配器规则

继承 [执行规则](../AGENTS.md)。本目录只实现受信任注册任务族的执行与状态读取适配。

- 复用父层 ActionContract、授权、路径解析与 Broker；adapter 不另开模型直达的效果出口。
- 限定输入、目标类型、资源与能力；文件路径和 URL 不混用，缺字段不扩大 grant。
- 输出原始 transport、observed 和可追溯 artifact 引用；保留未知，独立判定仍交 verification/。
- replay/reset 在隔离工作区运行并保存真实重放证据，不能以声明 replayable 代替隔离执行。
- 与 Manifest builder/Oracle 同文件的现有接口需一并核对；新增判断逻辑优先归 verification/，跨模块拆分先明确接口。

验证按任务族选择：aegis-c3-workspace-adapter、aegis-c6-code-repair、aegis-c6-product-chain、aegis-c6-learning-closure、aegis-c6-learning-reuse。变更已有 adapter 路径时同步可执行配置示例，不改写私有历史运行。
