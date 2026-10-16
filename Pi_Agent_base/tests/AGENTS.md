# 测试规则与启动方式

适用于 tests/，helpers/ 另有规则。按本次变更选择现有测试，保留有意义的独立预期。

- 正负例、边界、身份/权限、幂等、崩溃恢复按风险选取；验证用户可观察效果和真实接线，不只检查 helper 返回 ok。
- expected 不从被测聚合器生成；不修改断言迎合缺陷，不以 skip/expected failure 隐藏既有失败。
- SDK 集成使用真实 Pi SDK + faux provider，不继承真实凭据或调用真实目标。测试产物放临时目录或 ignored runtime/dev/。
- 用具体 barrier/故障点检查写前意图、部分提交、未知效果和重启；不靠 sleep 猜测因果顺序。
- 精确报告脚本数、用例数、退出码和基线差异。旧审计 red 是缺陷证据，required 清单按当前任务选择，不能自动扩大阶段门槛。

以下命令从仓库根运行：

纯 Node：

    node Pi_Agent_base/tests/<name>.mjs

SDK：

    node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/<name>.mjs

多脚本（自动选择 resolver，并保存真实退出码）：

    node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs Pi_Agent_base/runtime/dev/<task> <name> [<name> ...]

静态检查：按变更路径使用 aegis-biome.json；类型配置是 tsconfig.aegis.json 和 tsconfig.aegis-campaign.json，比较已有诊断基线；目录/依赖变更运行 aegis-module-layout.mjs。

详细矩阵与验收方法按需见 [测试规范](../../docs/AGENT_TESTING_STANDARD.md)。执行聚焦检查后，只有新改动、失败或未解疑点才扩大/重复验证。
