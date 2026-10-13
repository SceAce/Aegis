# C5 限定审查、补测与本轮修复

状态：**accepted_with_recorded_limits（离线配置入口 + caller-provided SDK 集成范围）**。
审查起点 `81a9a3a`，分支 `feat/c5-integration`。原会话起点工作树干净；续接会话时保留并
复核原会话的五个修改文件及一个新增测试，完成剩余检查和文档。用户已授权直接补测、
修复当前核心问题并规划下一轮。本审查会话也参与实现，不冒充另一团队独立验收。
不重开 C1-C4a，不扩大为真实模型/外部目标能力实验。

## 实际基线与修复

原四个 C5 suite 独立运行 exit 0，但新增最初七个边界用例为 1 pass / 6 fail。
SDK 增加完整写链断言后，在隔离 `81a9a3a` 上有两个行为失败：轮换后 Campaign 写链分叉，
Host 返回后的 standalone SDK 活动仍断链。旧代码 red 证据保留于私有日志。

| 项目 | 已复现旧行为 | 本轮修复与证据 |
| --- | --- | --- |
| C5-X1，只读命令 | export/observe 会调用 host.run 执行新任务 | status/export/observe 仅投影 committed stream，不 dispatch；fresh export 因无日志失败，observe 不产生 action.requested |
| C5-X2，UI 与退出 | optional server bind 失败阻止执行；beforeRun 异常不关闭 sink | bind 失败诊断后继续 Host；finally 释放所有权、关闭服务/sink、解除 writer 注册；异常后可重新运行 |
| C5-X3，配置/预算 | session 错类型、未知字段、负数被默认值吞掉；预算缺省 null 可无限轮换 | 嵌套白名单/类型、安全整数账本；缺省预算从配置/Manifest 构造，禁止扩大限额；host/kind 错类型明确拒绝 |
| C5-X4，坏源状态 | readEventsSafe 丢 malformed 行且不验证链，可能显示 completed | 装配/状态解析与链错误非成功返回，不展示 completed |
| SDK 单 writer | Host sink 与 Observer 各一实例，轮换后 Host 用旧尾摘要追加 | Host 注册同一 EventLog，Observer 借用且不关闭 Host writer；退出后解除注册并从磁盘重新打开 standalone 状态；两处完整链断言通过 |
| C5-X5，跨 Episode 预算 | controller 仅统计当前 Episode，换任务可漏计旧轮换 | Host consumption 统计全部 committed rotations；supervisor 的基础账本加其他 Episode 增量，耗尽前拒绝 newSession |
| C5-X6，CLI | --port 已解析但未接线，缺值/非法数字被接受 | port override 接入服务；缺参数、负数/小数/尾随字符/超范围明确拒绝；未知 programmatic scenario 拒绝 |

未增加第二套 Broker、Scheduler、持久 schema 或 hash 算法。共享 writer 注册只适用于同进程
显式 Host 生命周期，不宣称能协调另一个 OS 进程或任意并发 standalone Observer。
Campaign 调度所有权继续复用既有机制。

## 测试与证据

续接后的最终检查（逐命令真实 exit）保存于 ignored
`Pi_Agent_base/runtime/dev/c5-external/resume-results.json`：

| 检查 | 实际结果 |
| --- | --- |
| 原 C5 integration | 7/7 node:test，exit 0 |
| 原 C5 export-observation | 2/2 node:test，exit 0 |
| 原 C5 runbook | 1/1 node:test，exit 0 |
| C5 session-sdk | 14 个自定义 check 块通过，exit 0；不是 14 个 Node tests |
| 新 C5 external-boundaries | 10/10 node:test，exit 0 |
| 受影响回归 | 16 个脚本 exit 0，清单见下文 |
| Biome 六个修改/新增产品测试文件 | exit 0；0 errors/0 warnings，EventLog 有一条先存 noUselessTernary info |
| Campaign tsc | exit 1，74 条既有诊断；C5 修改文件无新增诊断，未关闭 checkJs/排除代码 |
| git diff --check | exit 0 |
| 更新后的 runbook 实际示例 | clean temp setup + run --export、status、export、observe --port 0，均 exit 0 |

16 个回归脚本：C3 host-fixture/external-boundaries/durability-recovery/gate-sdk，
C4 report-export/external-boundaries，C4a observation-http/external-boundaries，
C1 eventlog-durability/integration-recovery，C2 supervisor-boundaries/budget-sdk，
Observer runtime-handoff/failclosed-pi/outcome-command/verify-first-pi。
共 21 个测试脚本本次 exit 0；类型检查单独报告非零，不称全仓库全绿。

典型命令（仓库根目录）：

```bash
node --test Pi_Agent_base/tests/aegis-c5-external-boundaries.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c5-session-sdk.mjs
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json
```

完整 argv/exit/log 在 resume-results.json；runbook 新示例的实际执行记录在
resume-demo-results.json。原会话 red.log 为最初 1/6；
old-sdk-chain-red.log 为隔离旧版本两处链失败。续接新增配置反例先在未补全的实现上失败
（observation.host 数字被接受），见 resume-config-red.log；修复后同组通过。
这些旧代码 red 不在续接阶段重复执行，不冒充新的独立 mutation。
新测试 fresh export 的初始成功预期按只读契约纠正为失败，不通过先执行任务造成功。

测试层级为真实 EventLog、真实临时文件/本地子进程、SIGKILL 恢复、真实 Pi SDK + faux，
HTTP 仅 loopback；没有付费模型或外部目标调用。内嵌 Pi HEAD `42a3497d0`，续接核对工作树干净，
未修改 Pi 核心、凭据、模型设置或 lockfile。

## 接收范围与剩余限制

入口仍为：

```bash
node Pi_Agent_base/memory/campaign/c5-entry.mjs --config campaign.config.json run|status|pause|resume|cancel|export|observe [--export] [--observe]
```

- run 附带 --export/--observe 是显式执行请求；单独 status/export/observe 不执行。
  没有源日志的 export 非零，不自动运行来生成源。
- observation 生命周期为一次 entry 调用，结束即关闭；返回 URL 不代表后台服务存活。
  原 export-observation 测试在 entry 后另外开 server 证明同源，不能当作 entry 持续服务证据。
- SDK runtime 仍由 caller 提供；现有 SDK 测试通过 trusted beforeRun seam 调用 Host 轮换。
  CLI 没有自动创建 SDK、驱动模型 Worker或执行 session.max_requests_per_session 自动轮换。
  Pi Episode 与实际调度 Task 的通用自动绑定仍待下一部署任务验证。
- Session 账本输入是**不含该日志后续 committed rotations 的基础消耗**；controller 加缺失增量。
  不把 budget_after 再当基础反复叠加。初始 Session/外部 runtime 的成本不声称已完整观测。
- workspace 不是 OS sandbox，loopback 不隔离本地恶意进程；单 writer 注册不提供跨进程并发 SDK 保证。
- F16、74 条旧类型诊断、容器/远程/多 Worker、UI 样式仍 deferred。后续运行方式改变使风险可达时复核。

以上限制明确收敛接受范围，不把已通过集成称为完整自动 SDK 产品或真实能力效果证明。
下一轮只布置 **离线 SDK launcher**：`SDK_LAUNCHER_TASK.md` 与 `SDK_LAUNCHER_DS_PROMPT.md`。
本轮不实现 launcher、不自动启动真实能力实验；实验需之后明确任务、provider、授权、预算与对照。
