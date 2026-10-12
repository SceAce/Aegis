# 给主 DS：C2 最小收尾，仅 E1/E2

历史任务已完成。产品基线 `8e34c0f` 已通过限定外部验收，见
`C2_EXTERNAL_ACCEPTANCE.md`。不要重复执行该修复或自行启动 C3。

C2 外部限定复核见 `docs/C2_EXTERNAL_REVIEW.md`，产品基线 702c63c。
原产品套件和相关回归通过，但两个当前核心目标有反例。只修 E1/E2，
不要重开 C1、F16，不扩展 C3/C4，不再新建整套长文档。

先读 Pi_Agent_base/AGENTS.md、开发规范 §3.1、测试/Git 规范、C2 任务书、最新外部复核。
全文读 supervisor/handoff-host/Observer 的相关生命周期和真实 SDK rebind 调用顺序。
记录分支/HEAD/status，复用现有 C2 WORK_PLAN/TEST_MATRIX/IMPLEMENTATION_REPORT，先保存 red。

E1：预算门只读传入旧账本，已 committed 的轮换没进下一次准入；max(累计 usage,
当前 Episode generation) 还会漏掉新 charge。limit=2/used=1 时第二个 distinct request
必须在 newSession 前拒绝；used=7/limit=8 后一次轮换应为 8；Host 重建、相同请求重放
不漏扣也不双扣。采用受信任 committed usage/预算所有者，不只修返回数值，保留合法对照。

E2：SDK 未取消就当 verified，但未核对 completion；Observer session_start 在 Host rebind
成功前就发完成，真实 SDK rebind 抛错后仍 completion=1。把完成决策落实到受信任 Host
create/bind/必要持久化成功之后，核对 request/Episode/new Session 和唯一性；
失败不写假 completion、保留可解释 staged/recovery 状态，不盲重发 Task 副作用。
复用现有日志/handoff/Observer，可最小调整 Aegis 自有相关接线，不改 embedded Pi。

运行 red/green：

```bash
node --test Pi_Agent_base/tests/aegis-c2-supervisor-boundaries.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c2-budget-sdk.mjs
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts Pi_Agent_base/tests/aegis-c2-budget-sdk.mjs bind-failure
```

再跑原 C2 SDK 套件、受影响 handoff/Observer 与 Campaign 相关回归和 Biome/类型检查。
新断言保留，旧合法用例/幂等/取消不削弱。若调整 completion 所有者，旧测试需按契约
改正时记录依据，不保留“session_start 即成功”的错误假设。检查取实际 exit；
旧 tsc 导入错误如实记录，不为它做无关重构。按风险做少量 mutation，不设配额。

入口限制诚实报告：当前 supervisor 为 Host 可调用入口，不将测试直接调用它称为
Campaign 已自动接线。只明确本次预算/完成的可信所有者，不再造调度框架。

显式路径暂存、review、本地分任务 commit，不 push、不改写历史；日志 ignored。
不改 Pi/凭据/模型/lockfile、不跑真实模型/网络/目标，不自动调用验收模型。
完成后更新现有报告的 E1/E2 结果、required/deferred、真实 SDK 证据、commits/status，
标 internally_verified / awaiting_external_review，交回一次限定两项验收，不进入 C3。
