# Aegis 工程规则

适用于本目录的 Aegis 自有代码、测试和配置。继承 [根入口](../AGENTS.md) 与固定规则；更深目录的 AGENTS.md 提供模块细节。

## 开始工作

- 依据 [目录职责](README.md) 定位模块，只加载将要修改的模块规则和实际调用点。
- 本目录顶层只放工程入口与公共工具配置，业务实现放职责目录；阶段编号不决定代码位置。
- Node ESM 使用 .mjs，Pi 扩展使用 TypeScript，复用现有工具链；公共接口保留明确 JSDoc/类型。
- 正式模块不依赖 fixtures/；公共 EventLog/契约工具归 shared/。跨层已有接口需一起核对，不因换目录新增另一套权威逻辑。

## 工程边界

- pi/ 是独立嵌套仓库；修改它需要当前授权，并单独加载其规则。仅使用 SDK 时按需核对实际 API/文档，不改其源码。
- **pi 已冻结（2026-10-21）**：基线为 `upstream main 16f5f0af4` + Aegis 的 shell-slot 提交 `2ba451d99`，tag `aegis-base-20261021`（fork `SceAce/pi`）。此后不再跟随官方 pi 同步，Aegis 以该版本为开发基础。需要再次同步必须由用户明确决定，并同时重跑受影响测试；不要因为"顺手更新"而移动该基线。
- config/、runtime/、tmp/ 是私有配置或产物目录，不放正式源码，不纳入主仓库；不读取凭据来判断是否应纳管。
- run-pi.sh 的隔离目录与现有资源策略需保留，不能隐式回落到用户默认配置。
- 调整位置时同步静态/动态 import、子进程入口、资源根路径、tsconfig 和当前操作文档；历史路径查询用 [迁移表](../docs/MODULE_PATH_MAP.json)。

## 验证

- 测试命令与产物规则见 [tests/AGENTS.md](tests/AGENTS.md)，按受影响功能选择，不默认全目录通跑。
- 改目录或模块依赖后运行：`node Pi_Agent_base/tests/aegis-module-layout.mjs`（仓库根）。
- 格式使用 aegis-biome.json；类型使用两份现有 tsconfig，保持实际覆盖与诊断基线，不缩减配置伪绿。
- 完整规范仅在相关任务中读取：[开发](../docs/AGENT_DEVELOPMENT_STANDARD.md)、[测试](../docs/AGENT_TESTING_STANDARD.md)、[Git](../docs/GIT_STANDARD.md)。这些链接不是全量必读清单。
