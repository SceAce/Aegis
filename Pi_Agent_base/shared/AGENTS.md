# 共享基础规则

适用于 shared/。只放跨模块复用的 EventLog、完整性校验、规范化/摘要、契约及文件/路径工具。

- 共享层不导入 campaign/、memory/、execution/、observation/ 或 fixtures/ 的业务规则，不处理某阶段专属策略。
- 复用统一 canonical/hash 和安全路径实现；不增加另一套等价摘要/证据身份逻辑。
- EventLog 的顺序、来源、schema、hash chain 和 durable append 是跨模块契约，修改前核对所有实际消费者与恢复路径。
- 同一 EventLog 路径的跨进程写入必须经过 `<log>.lock` 串行化；每次 append 前重新校准 on-disk 链尾，不绕过 EventLog 直接追加 JSONL。
- rename、wx、fsync、目录同步的承诺分别验证；调用结束不自动等于持久成功。
- 不把路径检查称为操作系统沙箱。通用函数调整不能静默改变授权范围或持久格式。

验证入口：aegis-runtime-core-smoke、aegis-campaign-c1-eventlog-durability、aegis-campaign-c1-integration-recovery、fixture-direct-smoke；按受影响消费者补充。启动见 [测试规则](../tests/AGENTS.md)。
