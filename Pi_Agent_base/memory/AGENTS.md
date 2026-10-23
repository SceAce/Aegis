# 记忆模块规则

适用于 memory/。负责 Episode 记忆状态、Board、RAM、证据解析、Experience 存储/路由/编译与学习接线。

- 调度/SDK/预算归 campaign/；执行授权与 Broker 归 execution/；会话替换归 session/；Oracle 归 verification/；EventLog 归 shared/。本目录不新增这些子系统。
- 通用 bash/powershell 的命令与输出在所有领域均保持不透明观察数据；不得猜测解析为业务状态、目标成功、权限或控制结论。结构化语义必须来自已登记适配器/独立判断。
- 保持 Observation、Claim、Intent、Artifact 和可信 Outcome 的区别；普通工具完成不能自动产生 Fact 或 active Experience。
- 历史可审计，当前 RAM/经验使用 effective 视图；保持 Task/Episode/scope 归属、引用与失效/更正语义。
- RAM 是按请求重建的有界投影：保留任务/权限/未决责任，明确遗漏或截断，保留可追溯身份和值。
- 经验是有证据的条件规则，模型提议不能直接激活。Session 轮换、更正或重报不增加独立 Episode。
- 涉及 Campaign 判断时复用 campaign 权威上下文，不从弱日志扫描制造另一套结果定义。

按需依据：[MEMORY_SCHEMA](../../docs/MEMORY_SCHEMA.md)、[字段补充](../../docs/MEMORY_SCHEMA_NOTES.md)。只读与本次变更有关的对象/章节。

验证入口（仓库根；启动方式见 [测试规则](../tests/AGENTS.md)）：

- Board/状态：aegis-runtime-core-smoke、aegis-runtime-effective-board。
- RAM：aegis-ram-reaudit、aegis-ram-reaudit-sdk、aegis-ram-cache-payload。
- Work-cycle：aegis-work-cycle、aegis-work-cycle-ram、aegis-work-cycle-phase2、aegis-work-cycle-sdk；C6 Host 链路见 aegis-work-cycle-host-rotation / -checkpoint-campaign / -recovery / -policy；启动门与 bootstrap review 见 aegis-work-cycle-bootstrap-intent；投影缓存见 aegis-work-cycle-checkpoint-tail（SDK 启动见测试规则）。
- 学习：memory-runtime-learning-evidence-smoke、aegis-learning-bridge-e；Campaign 学习接线加 aegis-c6-learning-closure、aegis-c6-learning-reuse。

审计脚本可能包含尚未修复的行为失败；按任务记录核对基线，不将其输出固化为正确预期。
