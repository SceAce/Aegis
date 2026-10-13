# C4 限定审查、补测与本轮修复

状态：**accepted_with_recorded_limits（冻结范围内）**。
审查起点 `dc6415b`，分支 `feat/c4-report`，工作树开始干净。用户延续的审查/修复授权下，
本会话直接修复当前 C4 核心问题；不把自己的修复后检查包装成第二团队独立验收。
C1-C3 不重开，F16/旧类型基线/UI/整体能力实验后置。

## 基线与修复

原 4 个 C4 脚本、共 19 用例独立运行通过，但新 11 用例为 1 pass / 10 fail。
当前算法标准 SHA256 abc 向量通过，a/b 摘要不同；无证据证明 crypto 被替换为全零。
原报告的环境归因不采信，改用实际标准向量及语义变化的摘要断言。

| 项目 | 已复现的核心问题 | 本轮修复 |
| --- | --- | --- |
| X1 只读边界 | --out 文件名或已有 symlink 可覆盖 Manifest/EventLog，事后摘要检查已经太迟 | 写前检查输出/全部输入的路径、realpath、inode；拒绝输出 symlink/输入 hardlink 别名，保持源字节 |
| X2 权威完整性 | 坏链标记 integrity=false，但纯生成器仍归约其成功结果；CLI 可能成功写出 | CLI 坏链非零返回 inconclusive、不写；纯 API 保留完整性诊断但不把无效行用于成功判定 |
| X3 隐私 | 后附 lifecycle/counts/refs 未经过 redactSecrets，机密可绕过原 report 脱敏 | 全部追加语义字段统一脱敏后计算摘要，JSON/MD/bundle/prompt 不泄漏样本；credentials policy 仍白名单 |
| X4 计数与来源 | 拒绝 action 被计 executed，模型自报 completion/handoff 可涨可信统计 | 区分 completed/executed/rejected，按可信 source/event ID/action/request 去重；模型 claims 不计 |
| X5 validator | outcomes 错类型会 throw；正确重哈希后缺 integrity 仍通过；report body 改变但旧 digest 未查 | malformed 返回结构失败，必需字段、ID+digest refs、report body/bundle digest/引用一致性都校验 |
| X6 实际界限 | max_report_bytes/per-outcome refs/faults 未用，bundle 用字符数不是写入 UTF-8 bytes | 验证实际格式化 JSON/report/MD bytes、引用/任务/结果/fault 数量；超限明确拒绝、不静默删证据 |

可信重建索引只接受 runtime action 记录与 oracle/human Outcome 引用，supplied 索引不能覆盖
已有 committed digest。报告与 bundle 补全 control/lifecycle/动态提案摘要、Outcome 归属，
报告公开合成预算标记与缺测量 null，Session 轮换数量不声称独立 Episode 数量。
CLI 与纯 API 共用最终已脱敏 report 与 digest，不重复覆盖 integrity 或丢 committed-count MD。

## 测试诚实性与结果

- 新 `aegis-c4-external-boundaries.mjs` 最终 **13 tests / 13 pass**，含合法摘要变化对照、
  输入路径/symlink/hardlink、坏链、追加字段秘密、非可信计数、validator 与 UTF-8/ref/report bounds。
- 原 C4 **19/19** 通过。旧 rejected 测试预期曾把 rejected completion=executed，
  按契约显式纠正为 completed=1/rejected=1/executed=0；不是删断言获得绿灯。
- 原 cancel 测试有恒真断言/手写链不可信，改成真实 EventLog durable cancel，断言 report 与
  bundle 都为 cancelled 且 chain=true，保持历史已成功 task 的 evidence 与 lifecycle 区别。
- C0 report/contracts/fixture/closure，C3 fixture/workspace/durability/external-boundaries 与
  session-entry，C2 supervisor、C1 scheduler/projection 受影响回归 exit 0。
- Biome 修改路径 exit 0。Campaign tsc exit 1，仍 65 个 legacy 导入诊断，C4 修改文件无诊断。
- 一次隔离 mutation 删除坏链门，新 X2 测试因行为 AssertionError 非零，主树未变异。

精确命令/exit/log 在 ignored `Pi_Agent_base/runtime/dev/c4-external/`：
`baseline.json`、`red.log`、`results.json`、`results2.json`、`results-final.json`、`tsc.log`。
原语义摘要变化不等检查现可真实执行，不把“全零环境”当无法验证理由。

## 使用和限制

入口不变：

```bash
node Pi_Agent_base/memory/campaign/report-entry.mjs --manifest <m.json> --events <events.jsonl> [--artifacts <a.json>] [--runtime <r.json>] --out <dir>
```

- 超限现在明确拒绝导出，尚不提供分页 UI；拒绝是受支持的有界策略，不静默丢关键结果。
- 源文件与输出不得别名；不宣称抵抗恶意进程同时替换目录的 OS sandbox。
- committed Oracle 证据证明历史判定，artifact index 不是强制实时重读所有文件的扫描器；
  未来完整 artifact 打包和缺失字节评估在 C5，不把摘要声明当任意实际文件可用性证明。
- 当前局部 report 更完整，但通用平台、复杂贡献/统计、分页美化不纳入本次门槛。
- Session 报告区分 observed Session IDs 与 committed rotations，预算 rotation count 标明来源，
  不把初始/外部 runtime 费用或独立 Episode 计数编造成已测值。

本轮 C4 收尾结束，下一轮 C4a 只读观察面，见 `C4A_OBSERVATION_TASK.md` 与
`C4A_OBSERVATION_DS_PROMPT.md`。C5 整体集成后再由用户启动真实能力实验，不在本次授权中执行。
