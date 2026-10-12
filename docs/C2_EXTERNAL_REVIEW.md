# C2 限定外部验收：两项核心修复待完成

状态：**C2 changes_required**。当前产品基线 `702c63c`，分支 `feat/c2-session-rotation`，
开始时工作树干净。本次只检查 C2 冻结的 Session 生命周期、安全预算和成功确认；
不重开 C1，不把 F16/C3/C4 等后置项纳入阻塞。本次未修改产品代码。

## 已确认

- 原真实 Pi SDK + faux 产品套件 `aegis-c2-session-rotation.mjs` 独立运行 exit 0；
  新对象、Session ID/File、provider context 边界及 Episode 延续有真实验证。
- 原 `aegis-observer-runtime-handoff.mjs` SDK 回归 exit 0。
- Campaign event-projection、integration-scheduler、eventlog-durability 回归 exit 0。
- 原修改范围 Biome exit 0。其余 DS regression/mutation 声明本次未重复执行，不冒充独立证实。

上述实现有有效进展，但预算与绑定失败反例违反任务书已冻结核心目标，需最小修复。

## C2-E1：轮换预算没有用于后续准入，累计使用可能漏扣

位置：`memory/runtime/session-supervisor.mjs` 的 budgetAllowsSession、canRotate、rotate 和
committedSessionGeneration。预算门只用调用方传入的 budget；已经 committed 的轮换仅参与
返回 budget_after，不进入下一次门。`max(oldConsumed, currentEpisodeGeneration)` 也不等于
在已有跨 Episode/Campaign 消耗上增加一次 Session 使用。

实测：

1. limit.session_count=2，初始 consumed=1。首次轮换返回 remaining=0；
   新 distinct request 使用同一可信账本/重建 supervisor，仍创建第二个 Session。
2. 初始 cumulative consumed=7，limit=8，首次当前 Episode 轮换之后返回 consumed=7，
   应为 8，当前 Episode generation 不能替代 Campaign 已有累计消耗。
3. 上述第 1 条用真实 Pi SDK + Observer + Faux 再次复现，非单纯返回对象或 helper 自洽。

新增 `aegis-c2-supervisor-boundaries.mjs` 有合法对照（一次轮换成功、相同请求重放不再创建）
及两个预算反例；`aegis-c2-budget-sdk.mjs` 为真实 SDK 预算反例。
期望：在创建 Session 前按 committed usage/受信任持久账本校验，成功轮换计费一次，
新请求/Host 重建不能沿用旧余额，初始累计消耗不是零时仍正确。不要只改返回数值。

## C2-E2：SDK 返回被当作已验证成功；completion 早于 Host 绑定成功

位置：supervisor.rotate 调用 applyStagedHandoff 后直接接受 applied；
`handoff-host.mjs` 将 newSession 未取消当作 applied/verified；Observer session_start
写 handoff.completed，时机早于 Host 整体 rebind/continuation 成功。

实测：

- controlled runtime 已执行 newSession 并返回 cancelled=false，但未写任何 committed
  completion，supervisor 仍返回 applied=true。它没有核对 completion 的 request、Episode、
  to_session 和唯一性，与其 work plan 的“verifies completion landed exactly once”不一致。
- 真实 SDK 的 Host rebind 回调先 bindExtensions、随后抛错，rotate 返回 applied=false，
  但 EventLog 已存在一个 handoff.completed。任务书明确要求绑定成功后才 completion，
  该路径是当前可达失败，不是后续适配器或缓存优化。

新增离线 normal-return/no-completion 反例，以及真实 SDK `bind-failure` 模式。
期望：受信任 Host 确认 create/bind/必要持久化成功后才完成；失败保留可解释的 staged/
recovery 状态。不能靠 SDK 传输成功或某个早发事件认定轮换已完成，不能在 rebind 失败后
盲目再跑 Task 副作用。不要求任意外部副作用 exactly-once。

## 复现与当前结果

```bash
node --test Pi_Agent_base/tests/aegis-c2-supervisor-boundaries.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c2-budget-sdk.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c2-budget-sdk.mjs bind-failure
```

| 检查 | 结果 |
| --- | --- |
| 新边界 suite | 4 tests：1 pass / 3 fail，exit 1，均行为断言 |
| 真实 SDK 第二次预算拒绝 | exit 1，实际再次 applied=true |
| 真实 SDK bind failure | exit 1，实际 completion=1，应为 0 |

Oracle/provider 采用 faux，日志与 SDK 真实；离线 boundary runtime 明确为 synthetic，
不将 stub 等同真实 SDK。临时目录由 finally/test cleanup 清理，无真实网络、模型或凭据。
精确 argv/exit/log：ignored `Pi_Agent_base/runtime/dev/c2-external-review/results.json`。

## 限制与后续

修复仅 C2-E1/E2，不追加性能/缓存/UI/Broker 清单。F16 继续后置；旧类型导入诊断按基线报告。
C2 代码目前只有 supervisor entry 和测试调用，未在现有 Campaign dispatch loop 中调用；
报告需区分“Host 可调用入口”与已自动调度接线，不将无接线称为自动轮换。当前不为此
另开框架重构；修 E1/E2 时明确受信任 Host 调用与预算/完成所有者。

当前修复提示词：`C2_SESSION_ROTATION_FIX_PROMPT.md`。复用现有 C2 计划/矩阵/实现报告，
更新两项证据与 Git 提交即可。内部通过后交回只检查两项与受影响回归的验收，
不重开已通过范围，不进入 C3。
