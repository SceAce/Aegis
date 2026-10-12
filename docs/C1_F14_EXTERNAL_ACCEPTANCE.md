# C1 F14 限定外部验收

状态：**C1 externally_accepted（冻结范围内）；C2 approved_to_start**。
产品基线：`53accb2`，分支 `audit/c1-external-boundaries`，复核开始工作树干净。
依据：用户确认的开发规范 §3.1，以及 `C1_BOUNDARY_FOLLOWUP_TASK.md` 的范围收敛。
本次没有修改产品或测试，没有重开 C1 其他边界审计。

## 验证结论

- `1458635` 的 F14 修复：Stage 独立 provenance 必须存在且 independent=true；
  受信任事件来源检查不再从 oracle.source 替代独立来源；内部显式 Stage ID 不匹配时拒绝。
  projection 的普通完成和 reconciliation 仍共用该 resolver 与完成门。
- F14/CONTROL 聚焦组独立运行 **10 tests / 10 pass / 0 fail，exit 0**，
  含两个合法控制及真实 Scheduler + EventLog 的反例，不重跑 stranded worker。
- 按审计基线 `7656e99` 确认的 required 17 个 Campaign 脚本全部 exit 0。
- 两个受影响产品文件 Biome check exit 0。
- `c354f61` 的 F15 局部复制修复已核对；完整混合套件 **12 tests / 11 pass / 1 fail**，
  F15 通过，唯一失败 F16 按用户决定后置。
- Campaign tsc exit 1，仍为 fixture/contracts 2 个、runtime/events 8 个既有导入诊断，
  不声称整条类型命令通过；该基线不新增为本次阶段阻塞。

本次只运行限定检查和 required 回归；DS 报告中的 8 offline/4 faux 与 mutation
没有在本次重复执行，不把历史结果称为本次独立复跑。

## 精确命令与证据

```bash
node --test --test-name-pattern='^(CONTROL|F14)' Pi_Agent_base/tests/aegis-campaign-c1-boundary-review.mjs
node --test Pi_Agent_base/tests/aegis-campaign-c1-boundary-review.mjs
./Pi_Agent_base/pi/node_modules/.bin/biome check --config-path=Pi_Agent_base/aegis-biome.json Pi_Agent_base/memory/campaign/outcome-resolver.mjs Pi_Agent_base/memory/campaign/projection.mjs
./Pi_Agent_base/pi/node_modules/.bin/tsc -p Pi_Agent_base/tsconfig.aegis-campaign.json
```

17 个 required Campaign 文件由 `git ls-tree -r --name-only 7656e99 -- Pi_Agent_base/tests`
选出当时 `aegis-campaign-*.mjs`，逐文件运行 `node --test <path>`，不将后来新增的混合诊断
全量结果混入 required。所有具体 argv、exit、日志引用保存在 ignored
`Pi_Agent_base/runtime/dev/c1-f14-external/results.json` 与同目录日志。

## 阶段移交

C1 在本次冻结范围内通过外部验收，不表示全仓库完美或所有后置诊断通过。
F16 保留为缓存优化/接线限制，不以 used_checkpoint 布尔值夸大增量恢复能力；
C2 只有实际依赖该恢复机制时才处理必要接线，不承担无关缓存性能重构。
F15 已有局部修复证据，不扩大为新的清理任务。

当前下一任务为 `C2_SESSION_ROTATION_TASK.md`，完整提示词为 `C2_SESSION_ROTATION_DS_PROMPT.md`。
用户已同意 C2，无需重复请求阶段授权。C2 尚未实现/验收；按自身冻结目标推进，
继续保持原有真实模型/网络/凭据/Pi 核心边界。C3-C4a 不在本次授权实施范围。
