# C3 实际审查、补充测试与本轮修复

状态：**C3 accepted_with_recorded_limits（冻结范围内）**。
审查基线 `2bafe84`，分支 `feat/c3-execution`，开始工作树干净。
用户本轮授权直接补测试、修复当前核心问题并规划下一轮；以下产品修复由本审查会话完成，
不是第二个独立实现团队的证明。结论来自原测试、独立预期的新反例、实际调用链和修复后回归。
C1/C2 不重开，F16/界面/无关类型清理后置。

## 1. 基线与新 red 证据

DS 提交 c59f355、5e36958、7808397、c28332a、2bafe84 均存在。
原五个 C3 套件独立运行 exit 0，但原 gate 测试只是手动调用 helper，并非真实 Pi tool_call。
新增最初 8 个边界用例：3 pass / 5 fail（行为断言）；追加 declared criterion 用例又复现
一个错误完成。red 日志：ignored `runtime/dev/c3-external/red.log`、`criteria-red.log`。

## 2. 本轮必须修复且已修复

| 编号 | 实际问题 / 影响 | 修复与验证 |
| --- | --- | --- |
| C3-X1 | Worker 只检查 workspace，未求交 Manifest/Task target 与能力；workspace 内未授权文件可被写；拒绝动作仍返回 transport-ok，可能借已有文件完成任务 | Host 绑定可信 Manifest；执行前检查准确 Task target、Campaign target/capabilities、network、实际 resource 参数，并在 awaited intent 后重查；拒绝停止该任务，不把拒绝 artifact 当成功证据。合法/越权/缺能力/已有文件反例通过 |
| C3-X2 | action.completed 落盘失败返回 Worker false，但 scheduler 对普通 Worker 失败处理为 ok，随后可执行独立 Task | Worker 区分 audit_degraded；Scheduler 写 durable audit stop，返回 non-ok，保留 unknown。not-ok/durable:false/throw 三种结果故障均只执行一次，后续 run 保持 stopped |
| C3-X4 | restart artifact index 从任意 source 的 outcome refs 建立，LLM 自报引用被登记为证据 | 仅接纳可信 runtime action 记录及 oracle/human 结果索引，LLM refs 不进入恢复索引；真实 restart 回归保留 |
| C3-X6 | fixture TaskOracle 依据 task_type/ID 猜 expected，可能给声明不符的 criterion 成功 | 本地确定性 checker 仅识别登记的 boolean criterion，按 declared value 判定，未注册 criterion unknown；false criterion 与实际 true 反例不再完成 |
| C3-GATE | direct tool DENY 测试只靠测试作者 if 判断，没有 SDK hook | gate 提供真实 inline extension factory，加载后在 tool_call block；真实 SDK/faux + Host.run 证明 bash/write/edit 无效果，退出 Campaign 后普通 write 仍工作 |

没有创建第二套 Broker、Oracle、hash 或持久 schema。共享 Scheduler 只增加对显式 audit
故障的停止处理，既有普通 Worker unknown/reconciliation 行为保持。

## 3. 产品入口补齐

- `assembleCampaignHost` 重新验证 Manifest，拒绝与 grant 不符的 workspaceRoot。
- 接收可信 `scriptRegistrationConfig`，复用 script-registry，把脚本能力放入同一 Broker；
  新测试由 assembly 入口运行真实 pinned Node subprocess，而非测试手工绕过产品组装。
- CLI 增加 `resume`，未知参数拒绝；pause/cancel/resume 检查 durable 结果。
  `start` 不隐式取消 paused 状态，恢复需显式 resume。
- SDK Host 在 resource loader 中加载 `gate.extensionFactory`；它与 Host.run 的 gate
  使用同一对象，标准 Pi 模式不受影响。新 Session resource loader 也须重新加载同一 gate。

CLI：

```bash
node Pi_Agent_base/memory/campaign/c3-entry.mjs <workDir> start|pause|resume|cancel [workspaceRoot]
```

CLI 默认仍为 offline fixture。自定义 Manifest/plan/Oracle/script/SessionController 使用
可信 programmatic assembly 参数；不宣称 CLI 自动加载任意人类脚本、平台判定或付费模型。

## 4. 最终证据

- 新 `aegis-c3-external-boundaries.mjs` **14 node:test 用例全部通过**，包含真实 CLI pause/start/resume 子进程对照。
- 新 `aegis-c3-gate-sdk.mjs` 真实 Pi SDK/faux gate 产品测试 exit 0。
- 原五个 C3 fixture/workspace/durability/gate/session 套件全部 exit 0。
- 原 17 个 required Campaign 脚本，以及混合 boundary-review 的 F14/F15/CONTROL 聚焦组通过；
  F16 不混进本轮 required，不伪称完整混合脚本绿色。
- C2 session/budget/supervisor、handoff、verify-first/outcome/failclosed/data-use、Observer smoke、
  observe-actions、runtime-core、workflow-live-script 受影响回归通过。
- Biome 修改文件 exit 0。
- Campaign tsc exit 1，仍 **65 个既有导入诊断**，本次 Campaign 新/改文件无诊断；没有关闭
  checkJs、排除修改文件或降低规则，不把命令非零写成通过。
- 两次隔离 mutation：去掉 grantCheck、绕过 audit stop，新增测试分别 exit 1，因行为断言被杀死，
  不是 import/syntax 错误。主树未变异，不复跑 DS 历史 mutation 冒充独立证据。

精确 argv/exit/log：`Pi_Agent_base/runtime/dev/c3-external/results.json`，mutation 摘要为
同目录 `mutations.json`。该目录 ignored。SDK 使用实际 source-resolver 与 faux，无真实
模型/网络/目标；EventLog、本地临时文件、注册脚本子进程与 SIGKILL 恢复为真实执行层。

## 5. 可后置限制与下阶段归属

| 项目 | 当前结论 / 责任 |
| --- | --- |
| F16 cache 效率 | deferred，不重开 C1-C3 |
| 65 个类型导入诊断 | 已记录基线，不为全库清零阻塞 C4；修改这些库时再针对性治理 |
| CLI 默认 fixture / 可信扩展 assembly | 工作入口已验证；统一用户配置/SDK runtime 自动装配留 C5，不以任意平台支持卡 C3 |
| session Controller 由 Host 注入 | 实际 SDK call-through 已验证，跨 Task 完整运行策略在 C5 集成验证；不宣称 fixture CLI 自动换 Session |
| Host in-memory counters/status | 不作最终 truth；C4 report 从 committed 事件重建实际计数，避免把未更新 counters 当零测量 |
| 多 criteria / generic task evaluator | 默认本地 checker 可保守 unknown；额外 checker须可信登记。C3 不承诺理解任意文本 criterion |
| workspace OS sandbox / arbitrary network containment | 不声称；trusted scripts、显式 grant、network=false 声明不是 OS 强隔离 |
| git/hash 输出异常归因 | 当前 repo 提交可读取；报告如显示受限记录 unavailable，不据此声称 Git 损坏、时间伪造或 crypto stub |

这些限制不损害本轮已冻结的本地执行闭环，不另开产品阻塞项；新范围上线时显式复核。
本会话直接实现后的复核不伪装异模型独立验收，但足以完成用户授权的本轮审查与修复。
下一轮为 **C4 确定性报告与验收包**，任务/提示词见 `C4_REPORT_TASK.md`、`C4_REPORT_DS_PROMPT.md`。
只规划、布置 C4，本次不实现 C4 或 UI。
