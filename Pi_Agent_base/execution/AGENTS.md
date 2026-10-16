# 执行模块规则

适用于 execution/；adapters/ 另有细化规则。负责行动契约、参数绑定、授权、Broker、注册脚本与工具执行。

- Broker 是实际行动出口；模型只能提交 data-only 参数，不得注册可执行代码、checker 或授权。
- 通用 bash/powershell 的命令与输出在所有领域均保持不透明观察数据；不得猜测解析为业务状态、目标成功、权限或控制结论。结构化语义必须来自已登记适配器/独立判断。
- 使用真实 workspace/target 解析和注册契约检查最终参数，不能以工具列表、路径字符串前缀或 UI 许可代替授权。
- 副作用之前确认 durable intent；实际 invoke 之前重查当前许可、参数、注册实现和资源状态。跨 await 或多步骤不能复用过期许可。
- 收费幂等与执行幂等分别处理；重复 charge 不代表可再次执行。已执行/未知结果保持可恢复责任。
- 保留 transport 和 observed 证据，成功由独立 Oracle 判定；执行异常或拒绝不能伪造成验证成功/方法失败。
- 脚本须通过已有 registry 绑定实现与解释器；新增通用 shell、网络能力或依赖先核对当前用户授权。

按需依据：[开发规范的副作用边界](../../docs/AGENT_DEVELOPMENT_STANDARD.md)及本次动作的已确认契约；涉及共享结果时读取 [验证规则](../verification/AGENTS.md)。

验证入口：memory-runtime-batch-b-smoke、aegis-observe-actions、aegis-workflow-live-script-d、aegis-c3-external-boundaries；逐步 Broker 许可及重复工具检查见 aegis-e1-single-authority-review。启动见 [测试规则](../tests/AGENTS.md)。
