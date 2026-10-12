# Fixture direct 原型独立审计记录

状态：2026-10-10 初审。先修本文件 P0，再判断原型是否满足用户“Pi 为底座、经验改变行动”的要求。

## 已验证

- `node Pi_Agent_base/tests/fixture-direct-smoke.mjs` 与原有三个 memory smoke 均通过。
- `node Pi_Agent_base/memory/fixture/demo.mjs --json` 输出两个 success、active、第三次 direct success。
- 该演示是 **Node 离线 fixture**，没有调用 Pi。`pi_integration_verified: false` 是诚实的。

## P0：不修复不能认定为闭环

1. `Pi_Agent_base/memory/fixture/host.mjs` 中 `action.requested` 先写内存数组，真实 `events.jsonl` 在 `executeAction()` 之后才 `writeJsonl`。崩溃或写盘失败时会发生“动作已执行、没有持久意图”。修正为落盘确认先于副作用；写失败不能执行，追加顺序可验证。不得把“函数里先调用 emit”误认为持久化。
2. 没有经验的对照组 `runFixtureTask` 也会自动调用同一个 `fixture.unlock`；只有 route 标签不同。不能据此声称经验让 Agent 选择了新的行动或减少规划。需要模型/真实 Pi 或明确外部规划者参与无经验分支；比较实际 model/tool 调用与正确率；否则报告严格称“Router/Host 机制演示”，非“学习效果证明”。
3. 演示目前没有接 Pi Agent。用户要求以 Pi 为底座的可运行原型，不应将 Node-only demo 当作最终交付。最小接法：Pi SDK 或扩展只暴露受控 fixture 操作（禁止普通 `bash/edit/write` 绕过），至少有一条由 Pi 发起的受控行动事件可由 Aegis Host/Oracle 检查；离线 tests 可用 faux provider，不需要付费调用模型。实接中转真实模型需另行明确次数与预算。
4. `compiler.mjs` 基本只信任 projection 的 `oracle-report.status` 和 `Outcome` 引用是否存在，没有核查 `episode_outcome.status === success`、主体 episode_id、行动与可信 `run.json`/原始事件各字段的交叉关联及已验证的运行前提。输入 JSON 可伪造不一致但依旧 active。应重新校验来源或复核可信源，发现矛盾转 candidate/invalid，添加伪造/拼接证据的负测。
5. `router.mjs` 对输入 `active` Experience 仅检查 action_ref 是否注册、目标状态是否符合，其 `action_spec_digest`、动作/参数与 manifest 指定的 target/operation/authorization 是否一致均未检查。`when=[]` 会被 `every` 判真，伪造/改写 active 规则可能直接执行。要校验规则来源和不变量，未知/空条件不得 direct。Host 执行前复核最终动作、参数和资源状态。

## P1：可限缩但必须如实声明

- Node `crypto` 的 SHA-256 在本机正常工作；当前 `contracts.mjs` 写了整个纯 JS SHA-256，并声称“沙箱会把 crypto 全置零”。本机未观察到该事实，和用户避免无依据的预防性补丁的约束不一致。ID 改用 `Math.random()` 也比 `randomUUID()` 更弱。建议回退 `node:crypto`、删除无证据替代实现，并跑一次 SHA/事件链负测。
- `resolveInside` 基于 `realpathSync()` 后使用路径读写，不能抵御并发 symlink 替换；现阶段仅允许独立受控临时目录，禁止声称是通用沙箱。
- `host.mjs` 对 `task.fixture_relative_path` 的初始化直接 `join` + `writeJson`，原语端虽做路径检查，但初始化阶段仍可能越界。对所有实际访问使用同一根目录边界，拒绝不合法路径。
- `oracle.mjs` 的 `failure_mode` 在 success Outcome 也会作为值 `undefined` 写入对象；状态为 invalid/unknown 时 `observed=null` 等约束与 `MEMORY_SCHEMA.md` 逐项核对。保持 schema 1.0 的 Outcome 合法性，别自己加新的持久状态名。

## 验收建议

先完成一个确定性的 Node fixture 演示，且上述 P0 #1/#4/#5 有负测；再接入 Pi 受控工具并增加一条离线 Pi faux-provider 或模拟扩展调用的集成测试。测试时判断两个不同的问题：

1. 证据链和 direct 的安全正确性（确定性、无需模型）；
2. 与无经验 Agent 比较的行为提升（需要真实或受控仿真 Pi 规划，不能用 route 标志替代）。

所有修复交给 Pi 的便宜模型编码。审计者只写审计文档、运行测试和 review，不亲自改实现。

## 复审记录（2026-10-10）

以下描述当前 fixture 原型的实测结果，不回写上面的初审问题清单。

- Pi 实现了 `memory/fixture/` 的受限动作、Host、Oracle、Compiler、Router、route-before-model Orchestrator，以及 Aegis-owned 的单工具 Pi 扩展。
- P0 #1：Host 在动作副作用前确认 `action.requested` 已追加并 fsync；日志写入失败的负测通过。Oracle 追加判定事件，不再覆写事件源，重复判定明确拒绝。
- P0 #3：通过 Pi SDK 的 faux provider 驱动真实 Pi tool loop，且仅启用受限 fixture 工具；越界参数被拒绝。Orchestrator 有经验时先执行 Host+Oracle，0 次 Pi 请求；无经验时再启动 Pi。
- P0 #4/#5：Compiler 补充跨文件、事件和 Outcome 的一致性检查；Router 和 Host 补充空条件、动作标识/摘要、最终参数和授权复核；现有伪造/混用负测通过。冲突 `refuse` 分支不会启动模型或执行动作。
- 另修一项关键语义缺口：Oracle 从可信前态在全新临时 fixture 里再次执行注册动作，生成 `replay-proof.json` 与 `replay.verified` 事件；只有成功时 Outcome 才标记 `replayable=true`。Compiler 验证两次独立成功对应的 artifact、event 和 Outcome 引用后才给 fixture-only `active`。缺失/篡改 proof 后必须仍为 candidate。
- 本机复跑 `fixture-direct-smoke.mjs`、`fixture-pi-integration.mjs`、`fixture-pi-orchestrator.mjs`、`observer-smoke.mjs`、`live-oracle-smoke.mjs`、`replay-oracle-smoke.mjs`、`compile-live-experience-smoke.mjs` 及离线 2+1 演示，全部通过；Pi 内嵌仓库仍是干净工作树。
- 自愿限额的真实模型 smoke 已跑两次（含重放修复后）：`relay/deepseek-v4.1-flash`，同一受限 fixture，direct 为 0 次 provider 请求、Oracle success；无经验为 2 次请求、1 次受限工具调用、Oracle success。最新报告：`/var/folders/c9/g1mcsn_14gd3683wc810pkfw0000gn/T/aegis-replay-review-KM60k2/real-model-ab-report.json`。`cost=0` 为当前模型元数据的估算，**不能推断实际免费**。

**剩余边界**：这只是受限 JSON fixture 的纵向原型，不是通用沙箱、长期图板或小模型架构。数据仍由同一 Host 与 Oracle 写入且本机可改文件；哈希链能检测非配套篡改，不是针对具有写权限攻击者的签名。两次同种 fixture 重放是工程独立性门槛，不构成跨任务泛化或置信度保证。无经验模型得到明确工具名和路径提示，单次 A/B 只能证明接线与调用节约，不能证明模型经过经验后更会规划。可选 runner 的请求上限通过处理模型响应后计数，不等于严格的预付费硬上限。旧 `live-oracle.mjs` 等原型仍保留独立逻辑；此次新增的 fixture 专用路径没有把它们变成通用后端。
