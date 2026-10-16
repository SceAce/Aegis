# Aegis 模块职责与目录迁移

本次由用户授权整理模块位置。起点：`03726ec54c3cf906d3f2fbfc72196f0692ee348d`；分支：`refactor/module-boundaries`。

## 范围与契约

只移动 Aegis-owned 文件并修正引用、模块相对路径、检查配置和当前运行文档。函数签名、导出名、事件格式、持久文件格式、预算/授权/Oracle 规则保持原样；C6/E1 阶段前缀本轮保留。旧源码路径不保留转发壳。历史审计和交付报告保留当时路径，通过本表及 [`MODULE_PATH_MAP.json`](MODULE_PATH_MAP.json) 的逐文件映射查找现址。内嵌 Pi、用户 config、既有私有运行目录不迁移、不修改。

| 目录 | 责任 | 主要来源 |
| --- | --- | --- |
| `memory/` | Board、RAM、Episode 记忆状态、证据解析、经验学习与编译 | `memory/runtime/` 中的记忆模块；`campaign/c6-learning.mjs`；保留 `compile-live-experience.mjs` |
| `campaign/` | Manifest、计划、队列、Host/Scheduler、预算、请求生命周期、产品入口与 SDK 组装 | 原 `memory/campaign/` 的任务运行模块 |
| `execution/` | 行动契约、授权、Broker、脚本注册、执行适配器 | 原 runtime 行动模块、Campaign Broker 和 `execution/adapters/` |
| `session/` | Session 监督、交接与实际会话替换 | 原 runtime 的 handoff/host/supervisor |
| `orchestration/` | 跨执行与学习模块的工作流协调 | 原 runtime 的 workflow-engine |
| `verification/` | 独立 Oracle、结果解析/聚合、注册测试和离线回放验证 | 原 Campaign 的 aggregate/resolver/Oracle/test；原 memory 的 live/replay Oracle |
| `observation/` | 只读观测、HTTP 页面、报告与导出 | 原 Campaign 的 observation/report/E1 view |
| `fixtures/` | 受限实验 Host、Oracle、Router、Compiler 和演示入口 | 原 `memory/fixture/`，不含公共 contracts |
| `shared/` | 共用追加事件日志及完整性校验；规范化/摘要、文件、路径与契约辅助函数 | 原 runtime/events、fixture/contracts；保持实现不变 |
| `contest/` | Contest 运行和结果导入 | 原 contest；原 runtime/contest-bridge 改名为 outcome-bridge |

`runtime/` 是私有运行产物目录，不能放源码。`memory/` 不再容纳 Campaign、行动执行或会话管理子系统。共享工具属于 `shared/`，正式代码不依赖 `fixtures/`。对已经存在的跨层调用，仅修正引用，不在本轮重写依赖注入或拆分函数。

## 实施依赖与检查矩阵

串行执行：固定迁移映射和基线 → 物理移动 → 更新所有代码/测试引用及相对根路径 → 更新当前文档和开发约束 → 检查/对照 → 审查提交。

| 要求 | 验证 | 预期 |
| --- | --- | --- |
| 文件完整且职责归位 | 迁移映射核对、所有相对模块路径解析、源码语法检查 | 没有漏文件、悬空引用或旧位置转发壳 |
| 逻辑保持 | esbuild 解析并规范化迁移前后源码，应用显式路径映射/8 处资源路径修正，忽略注释与静态模块声明排序 | 没有额外函数逻辑或测试断言变更 |
| 产品入口和实际 SDK 资源定位 | C6 runbook/provider、Session handoff/rotation、RAM cache payload | 原先通过的检查继续通过 |
| 执行/验证/观测/Fixture/学习接线 | 显式 E1 required 清单、补充记忆/工作流/Fixture/Contest 检查 | 与独立保存的起点基线比较 |
| 已知反例保留 | single-authority、RAM reaudit 及 SDK、CTF RAM review | 失败内容和数量保持，不把旧缺陷改成正确预期 |
| 类型覆盖不缩减 | 两个 tsconfig 前后 diagnostics 对照 | 路径归一化后不增加错误 |
| 风格与 Git | 修改范围 Biome、diff --check、显式暂存并审查 | 不降低规则，不纳入 config/runtime/Pi |

已有审计基线：single-authority 1 pass/12 fail；RAM reaudit 2 pass/9 fail；RAM SDK 2 pass/3 fail。原有执行/计费/记忆缺陷由既有报告跟踪，本次目录迁移不宣称修复。新结构下的绝对 replay adapter 路径需由使用者在迁移后显式更新；不改写既有私有配置或试验记录。

## 验证结果

最终迁移 84 个文件（映射表共 85 条，`compile-live-experience.mjs` 保持原址），`memory/` 由 85 个文件收敛为 14 个记忆相关模块。内嵌 Pi HEAD：`42a3497d03ad17e308a2299fa824727894f2c0ec`，前后工作树干净。没有修改私有 config 或已存在的试验记录，也没有真实 provider/目标调用。

在 ignored 私有目录使用 `git archive 03726ec` 导出旧源码，与新源码独立执行同一清单；SDK 使用同一只读 Pi 源码与现有依赖。旧副本隔离输出和临时目录，不复用旧产物。91 个脚本由 required 清单 68 项及补充 23 项组成，逐脚本使用现有 `c6-suite-runner.mjs` 保存真实退出码，外层 runner 不依赖已知有退出码缺陷的 `run-required.sh`。

| 检查 | 起点 | 最终 | 证据 |
| --- | --- | --- | --- |
| 原 required 68 个唯一脚本 | 68 exit 0 | 68 exit 0 | `suite-results-{before,after}.json`、`suites-{before,after}/` |
| 补充 23 脚本（记忆/Fixture/工作流/Contest/隐私/审计） | 19 exit 0 / 4 exit 1 | 19 exit 0 / 4 exit 1 | 同上；完整清单 `suite-names.json` |
| `node Pi_Agent_base/tests/aegis-module-layout.mjs` | 新增检查 | exit 0；222 文件、743 个相对模块引用 | 解析源码但不执行产品/扩展；检查缺失模块、生产→Fixture 依赖、旧目录重建、类型配置路径 |
| 源码解析规范化对照 | 222 源码/测试文件 | exit 0；差异 0 | `source-comparison.json`；路径映射及 8 个资源定位修正之外无逻辑差异 |
| `tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json` | exit 1；194 diagnostics | exit 1；194 diagnostics | `tsc-campaign-{before,after}.log`，路径归一化后内容/重复数量一致 |
| `tsc -p Pi_Agent_base/tsconfig.aegis.json` | exit 1；186 diagnostics | exit 1；186 diagnostics | `tsc-batch-{before,after}.log`，路径归一化后内容/重复数量一致 |
| Biome 全 Aegis 源码/测试及两份 tsconfig | exit 1；84 errors / 47 warnings / 13 infos | exit 1；83 errors / 47 warnings / 13 infos | `biome-{before,after}.json`；按迁移后文件/category/severity 对照无新增诊断；新增检查单独 exit 0 |
| `git diff --check`、`git diff --cached --check` | — | exit 0 | 最终暂存审查；不降低规则或改写基线 |

所有私有证据位于 `Pi_Agent_base/runtime/dev/module-layout/`。类型及全范围 Biome 的非零退出仍为非零，不宣称全仓库静态检查通过。只处理迁移产生的 import 排序与格式诊断，不顺便清理旧代码。

保留的 4 个失败脚本在前后均为同一行为断言失败：

- `aegis-e1-single-authority-review`：1 pass / 12 fail；
- `aegis-ram-reaudit`：2 pass / 9 fail；
- `aegis-ram-reaudit-sdk`：2 pass / 3 fail；
- `aegis-ctf-ram-review`：5 pass / 1 fail。

没有把这些失败改为 skip/expected failure，也没有修改断言为当前缺陷行为。首轮迁移测试曾暴露 4 个 `join()` 旧源码路径遗漏，补齐后全部恢复为起点结果；实际 SDK Observer/ROM、pilot 根路径、Fixture 实验根路径也已按新深度修正。已通过的 runbook、provider、learning closure、report、handoff/rotation、恢复测试覆盖这些入口。没有运行显式 real-model 实验入口。

常用复验命令（从仓库根执行）：

```bash
node Pi_Agent_base/tests/aegis-module-layout.mjs
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs \
  Pi_Agent_base/runtime/dev/module-layout/recheck \
  aegis-c6-runbook aegis-c6-provider aegis-c6-learning-closure \
  aegis-c4-report-export aegis-observer-runtime-handoff \
  fixture-direct-smoke observer-smoke replay-oracle-smoke live-oracle-smoke
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis.json
```

本轮为内部迁移验证，未宣称独立外部验收。现有跨层调用仍可能形成循环依赖；本次只让文件职责可见，不重写接口/依赖注入。历史审计问题继续由原报告跟踪。
