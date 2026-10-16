# Contest 规则

适用于 contest/。负责提示卡、运行入口、结果导入与只读日常统计。

- Contest 配置和工具边界与 Campaign 主产品不同；不能用旧 launcher 的权限证明 Campaign 能力。
- platform/独立 Oracle/有证据的人审才可给出对应可信 Outcome；agent_settled、模型文本和 tool exit 不算独立成功。
- 结果须保留 Task/Session/Episode 归属及证据引用；重复导入不制造新独立样本。
- 导出记录有界且脱敏，统计不得把 unknown 填为成功或已测量 0。
- 真实模型/目标实验单独依据当前授权，不默认运行真实 launcher。

按需说明：[README](README.md)。验证入口：contest-smoke、contest-pipeline-smoke、contest-launcher-smoke、aegis-contest-pi-integration、aegis-observer-contest-pi。SDK 启动见 [测试规则](../tests/AGENTS.md)。
