# 开发规则的分层与按需加载

根 AGENTS.md 是开发入口，固定规则与模块规则是约束，任务书/报告是按需参考的任务证据。它们分别维护，不再把多轮 Session 的历史记录累积到自动加载入口。

## 层级

```text
AGENTS.md                            全仓引导、固定原则和加载顺序
└── docs/DEVELOPMENT_RULES.md         根入口加载的稳定开发原则

Pi_Agent_base/AGENTS.md               Aegis 工程共用约束
├── memory/AGENTS.md                  Board/RAM、证据与经验
├── campaign/AGENTS.md                规划、任务与请求生命周期
├── execution/AGENTS.md               行动、授权与 Broker
│   └── adapters/AGENTS.md            执行适配器的细化约束
├── session/AGENTS.md                 会话监督与交接
├── orchestration/AGENTS.md           跨执行与学习的工作流
├── verification/AGENTS.md            Oracle、结果解析与聚合
├── observation/AGENTS.md             只读视图、HTTP、报告
├── shared/AGENTS.md                  EventLog 与共用辅助工具
├── fixtures/AGENTS.md                受限实验与演示
├── extensions/AGENTS.md              Pi 接线
├── contest/AGENTS.md                 Contest 与结果导入
├── agent/AGENTS.md                   固定 ROM 资源
└── tests/AGENTS.md                   测试原则和启动方式
    └── helpers/AGENTS.md             辅助子进程与运行器

docs/AGENTS.md                       文档与证据维护
└── archive/AGENTS.md                 归档内容不作为现行指令
```

统一使用大小写一致的 `AGENTS.md`，不并存 `Agents.md` 等变体。只有存在独立职责或额外约束的目录才新增文件；不为每个文件夹重复一份全局规则。

## 一次任务如何读取

例如修改 `Pi_Agent_base/memory/ram.mjs`：

1. 根 `AGENTS.md` → `docs/DEVELOPMENT_RULES.md`。
2. `Pi_Agent_base/AGENTS.md` → `Pi_Agent_base/memory/AGENTS.md`。
3. 按本次需求读取 RAM 对应的数据契约、实现片段、调用点和相关测试。
4. 需要改动 Session 或扩展时，再读取相应目录规则；需要修改测试/文档时读取它们自己的规则。

链接是定位依据，不意味着递归加载链接中的全部文档。工具可能自动发现祖先规则，也可能需要手动读取；开发者应确认目标路径沿途的规则已经加载，不依赖某一种客户端的自动加载行为。

祖先规则与子目录规则累积适用。子目录负责细化本模块，不扩大当前用户授权，不削弱固定信任、证据或工作区边界。当前用户指令改变旧约定时，更新冲突的现行文本；历史报告只保留为证据。

## 文件应当写什么

| 文件类别 | 应放内容 | 不应放内容 |
| --- | --- | --- |
| 根 AGENTS.md | 固定原则、加载顺序、规则维护方式 | 阶段状态、提交基线、长测试清单、全量历史必读列表 |
| 固定规则 | 跨任务稳定的正确性、工作区、验证和交付原则 | 特定任务许可、模型选择、实验预算或操作记录 |
| 工程 AGENTS.md | 技术栈、源码/产物边界、公共检查入口 | 每个模块的完整实现说明、历次验收结论 |
| 模块 AGENTS.md | 职责、输入/信任/持久边界、依赖要求、按需契约、聚焦检查 | 临时 TODO、失败数量、当前阶段执行命令或历史流水账 |
| 任务书/审计报告 | 本次范围、基线、复现、命令和真实结果 | 将旧任务授权转为新任务的默认许可 |

详细开发、测试和 Git 规范继续保留，按任务需要读取。模块规则表达应遵循的契约，不代表当前实现已经满足全部规则；实际状态以对应基线的代码与验证证据为准。

## 历史入口处理

原 `Pi_Agent_base/AGENTS.md` 的历史文本保存在 `archive/AGENTS_LEGACY_BEFORE_HIERARCHY.md`，正文保持原样，顶部补充归档说明。它不在默认加载链中，不再作为当前开发规则、任务许可或阶段状态入口。

当前用户要求已经替代历史“不恢复根 AGENTS.md”的禁令；现行开发规范和文档索引已同步。嵌套 Pi 的文件与规则保持原样，使用 SDK 时按需核对接口；修改 Pi 自身需要当前授权及其子仓库规则。

本次只调整规则与文档，不改变产品行为。验证范围为相对链接、引用的现有脚本名、规则文件覆盖、归档原文一致性和 Git 差异检查。
