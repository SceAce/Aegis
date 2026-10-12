# Aegis 可运行原型：Pi 编码任务书

给 Pi 编码 Agent 的执行任务。用户已批准：**首个实验用受限 JSON fixture，先实现 direct 路径**。不要把此任务扩展成完整通用框架。

## 背景及边界

- 当前源码位置：`Pi_Agent_base/memory/*.mjs`、`Pi_Agent_base/extensions/aegis-observer.ts`、`Pi_Agent_base/tests/*.mjs`。
- Pi fork 在 `Pi_Agent_base/pi/`，上游已同步；**不要修改这个内嵌 Pi 仓库**。
- 旧 Python demo 已有意移除；**不要恢复**已删除的 `aegis/`、`tests/`、`manual/` 等旧路径。
- `docs/MEMORY_SCHEMA.md` 是现行数据契约；`THINK.md` 与 `docs/ARCHITECTURE_DECISIONS.md` 提供长期目标，但后者仍是待确认草案，不可将所有建议实现为 MVP。
- 只改本原型必要文件。当前 Aegis 根工作区有大量用户已有的删除/修改，**不得覆盖、恢复、暂存、提交**它们。
- 现有模型中转的 `config/agent/auth.json` 是敏感文件；不要打开、复制、打印或改动凭据。不要调用真实模型来运行自动化测试，测试必须离线确定性。
- 主语言使用 TypeScript/Node（与现有 Pi 集成一致），必要时使用 Python；若新增 Python 依赖或虚拟环境使用 `uv`，不要使用系统 pip。当前原型无需 C。避免重复脚本和无用的通用抽象。

## 本次要交付什么

一个**真实可运行的完整 fixture 闭环**：

1. 至少两次有真正独立重置、独立记录的 live/current-environment 受限 JSON 任务。环境初始状态必须从可信 runner 对真实文件进行观测/哈希，不能仅把可由模型写入的 `manifest.initial_snapshot` 当成已验证前提；不能通过复制输出、改 independence_group 名称冒充独立证据。
2. 有明确、可重复的受限动作原语（例如 `fixture.unlock`），参数、目标与后置条件具体可执行。**不能从 Experience 的自由文本执行 shell/JS，不能仅记录 `edit` 与 path 后就声称可执行**。
3. Oracle 独立检查执行前提和执行后状态，区分任务成功、执行运输成功、失败和 `unknown`；源事件与派生事件都能核对，引用可解析。真实文件访问严格限定在测试生成的临时目录内。避免 symlink/path traversal 逃逸。
4. Compiler 仅依据验证过的独立 live 证据与可重放动作晋升 **fixture-only** 作用域 Experience。`active` 不是一次成功或两个任意 JSON 就能得到。原 `replay-oracle` 的 `--allow-replay-only-active` 只作为原有测试开关，不能充当本次 live 闭环的晋升依据。
5. Router 在**第三次新任务**检查 `active`、scope、当前已验证前提、动作白名单、冲突；命中时 Host 直接走已有动作原语（direct），并再次由 Oracle 验证，不请求模型重新规划；不匹配或冲突时拒绝直接执行，保留可解释原因和最终状态。
6. 一个命令或短脚本可在干净临时目录里离线运行完整 2+1 演示，并生成可审计报告，明确标记第 3 次任务是否真的命中 Experience 和执行了何种动作；没有经验对照组要走同一个授权/执行/验证边界，报告其行为差异。尽量复用现有 Event/Episode/Outcome/Experience 契约而不是并行发明另一套名字。
7. 有直接运行的离线 tests：正向晋升与命中、不匹配前提或 scope、两份复制证据不独立、缺失/篡改前态或源事件、动作执行失败与后态未知、不得越界读写。测试应保证失败时不会报告 `success`/`active`，且验收不依赖 Agent 自述。

## 首版范围与诚实声明

- 首选单进程、一个 JSON fixture、一种明确的动作原语，能复用就复用现有脚本。没有必要本次做 Pi 内部改造、通用黑板、工作区沙箱、多会话、小模型支持、代码修复任务族、habit/hint 或长期任意经验组合。
- 最低价值是 **Pi/Host 通过 Aegis 的 direct 经验实现下一次行为变化**。如实现了纯 Node 确定性 Host 但尚未接入 Pi，请在报告中明确说明“fixture direct 演示通过，Pi 集成未验证”，不能声称 Pi 的完整闭环已工作。
- 工具限制/路径检查是该 fixture 的真实边界，不对一般 bash、MCP、第三方扩展声明已安全隔离。不要把 cwd 当 sandbox。
- 原本测试和旧报告的契约应保持可运行。如需改变 `docs/MEMORY_SCHEMA.md` 的字段/晋升规则，先写清楚最小必要的兼容说明与测试，不要偷偷修改旧输出。

## 开发规范与验收

- 阅读实际修改文件和现有 smoke test 全文；先写一个简明设计与文件清单，然后编码，不要大范围重构。
- 不吞写入错误；动作意图在执行前必须有可检查记录。失败/unknown 不能被计入成功；不确定时停止自动重试。
- 禁止依赖可由 Agent 自己改写的结果文本为 Oracle 判断成功；对 producer 与 verifier 保持分工。
- 新增/修改测试要运行；运行现有三个 memory smoke tests；执行一次完整 2+1 演示。测试使用本地临时目录、无真实模型调用、无外部业务系统副作用。
- 输出具体运行命令、测试结果、报告路径及已知未完成的边界。未经明确指示不提交 Git。
