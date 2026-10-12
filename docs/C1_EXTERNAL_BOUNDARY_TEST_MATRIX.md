# C1 外部边界审计测试矩阵

状态：**red 基线；C1 changes_required / C2 blocked**。
脚本：`Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs`。
命令：`node --test Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs`。
总计：21 个 node:test 用例，2 pass / 19 fail，exit 1。
源码输入：受信任 synthetic fixture + 显式 committed-event 测试行；产品组为真实本地 EventLog。
失败都是正常行为断言失败；无 skip/todo/expected-failure。

| 需求 / 用例名称前缀 | 数量 | 层级与入口 | 独立 expected / evidence | 实际 |
| --- | --- | --- | --- | --- |
| CONTROL | 1 | projection / 两个完成事件 | 合法完整 Stage/Task success 两条门都 completed | pass |
| F10 missing current scope | 1 | resolveTaskOutcome | null 当前 scope 不得跳过，ok=false | fail：ok=true |
| F10 both scopes missing | 1 | projection | 双 null scope 不得 completed | fail：completed |
| F11 foreign/missing scope | 4 | projection / normal、reconciliation 各两种 | Stage 不能跨环境或缺 scope，state!=completed | fail ×4 |
| F11 missing episode | 2 | projection / 两条门 | Stage 缺 Episode 不得 completed | fail ×2 |
| F11 empty evidence | 2 | projection / 两条门 | Stage 空证据不支持成功，state!=completed | fail ×2 |
| F11 non-independent provenance | 2 | projection / 两条门 | 非独立判定不能支持完成 | fail ×2 |
| F12 preserve current episode | 1 | recovery / JSON clone priorState + reducer | 恢复 Episode=原 Episode | fail：null |
| F12 foreign episode | 1 | recovery / 同事件 full vs prefix+tail | 两条路径都不接纳 foreign task Oracle success | fail：恢复接受 success |
| F12 outcome dedup | 1 | recovery / prefix+tail | Stage outcome 1 条，等于 full | fail：2 条 |
| F12 command dedup | 1 | recovery / prefix+tail | model_requests consumed=1，等于 full | fail：2 |
| F13 actual checkpoint episode | 1 | scheduler.run → injected checkpoint writer | 实际 queue 记录原 Episode | fail：字段缺失 |
| F13 actual state digest | 1 | scheduler.run → injected checkpoint writer | 固定 IDs 改 Stage observed 导致 digest 改变 | fail：digest 相同 |
| F11-PRODUCT matching scope | 1 | scheduler + real EventLog append/fsync/replay | completed 且 worker reruns=0 | pass |
| F11-PRODUCT foreign scope | 1 | scheduler + real EventLog append/fsync/replay | 不 completed 且 worker reruns=0 | fail：completed |

最后两例只将 EventLog 与 Scheduler 视为真实执行层，Oracle/Outcomes/artifact 索引是
synthetic fixture，不声称真实平台验证或真实独立 Episode。临时目录由 finally 清理。

原始证据：`Pi_Agent_base/runtime/dev/c1-external-review/aegis-campaign-c1-external-boundaries.log`。
其他独立回归与精确命令见同目录 `results.json`；总体结论在 `C1_FINAL_EXTERNAL_AUDIT_3.md`。

本矩阵是审计结果；修复 DS 仍需按任务书创建覆盖实际 checkpoint 文件、动态 scope、
kill/restart 与有限 mutation 的 `C1_BOUNDARY_TEST_MATRIX.md`。不能把上述纯 reducer case
自动算成真实 Scheduler 已修复。
