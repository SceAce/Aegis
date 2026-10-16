# 实验 Fixture 规则

适用于 fixtures/。保留受限、可重复的 Host/Oracle/Compiler/Router 与演示，不作为生产模块依赖。

- 默认完全离线、显式工作区和有限动作；输入来自本地 fixture，输出注明 synthetic/fixture-only 的证据范围。
- 实验也遵守意图持久化、执行边界与独立 Oracle；不能把工具退出码或模型文本当正确结果。
- 两个独立 Episode 需要独立重置与真实证据，重复报告或 Session 不算新样本。
- real-model-ab 等真实调用入口必须显式用户授权并执行原有 gate；普通开发检查不启动它们。
- 公共工具放 shared/，正式模块不导入本目录；实验数据写私有 runtime/ 或临时目录。

按需操作说明：[README](README.md)。验证入口：fixture-direct-smoke、fixture-pi-integration、fixture-pi-orchestrator；SDK 启动见 [测试规则](../tests/AGENTS.md)。
