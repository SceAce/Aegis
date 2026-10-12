# C1 最后收尾：只修 F14，F15 非阻塞、F16 后置

状态：**F14 待修；完成限定验证后进入 C2**。

本文件按用户确认的阶段推进规则更新，覆盖此前“F14-F16 全部修复、混合套件全绿才放行”要求。
历史复现证据仍见 `C1_BOUNDARY_EXTERNAL_REVIEW.md`；后置不等于已修复。
开发规范 §3.1 适用于实现者、审计者及后续阶段，不再逐轮扩大 C1 验收门槛。

## 1. 冻结范围

| 项目 | 当前处理 | 限制 / 后续责任 |
| --- | --- | --- |
| F14：缺独立 provenance、foreign Stage ID 被重标后假完成 | C1 唯一剩余阻塞，做最小准入修复 | 当前 completed 可信性不能交给 Session 轮换代修 |
| F15：hydration 修改传入 reservation | 非阻塞，可顺手做局部复制修复 | 未修时恢复使用新读取/独立副本，不复用已消费的 priorState；C2 恢复集成时复核 |
| F16：cache 被接受后仍全量重放 | 后置，不重构 Scheduler 缓存路径 | 只声明全量重放得到的正确性；C2 需要恢复接线时复核，缓存加速按后续优化安排 |

F16 原 P1 阻塞定位撤销；prefix payload 读取次数测试属于缓存实现/优化诊断，不是 C1 核心正确性门槛。
F15 若后续出现正常可达路径预算错误/重复副作用证据，再按该影响重新评估；不能仅凭旧标签重开 C1。
不假定任何后置项会自动解决，责任阶段须显式检查。

## 2. F14 实现与验证

必读：本文件、`AGENT_DEVELOPMENT_STANDARD.md` §3.1、`AGENT_TESTING_STANDARD.md`、
`GIT_STANDARD.md`、`C1_BOUNDARY_EXTERNAL_REVIEW.md` 的 F14 证据及相关源码/调用者。
旧任务书仅作契约背景，与本次范围冲突时以本文件及用户当前决定为准。

修改限于共同 Stage resolver / projection 的必要准入检查和相关测试：

- provenance 缺失/null 或缺 independent=true 不得因 oracle.source 存在而获得独立判定权；
- Outcome 内部显式 Stage 绑定与当前 Stage 冲突时拒绝，不能通过 canonicalization 覆盖成合法；
- 普通 completed/reconciliation 使用同一检查，保留合法完整正例与 worker 不重跑；
- 只审查受影响绑定路径，不借此重写全部 resolver、Scheduler 或扩展后续能力。

仓库根运行：

```bash
node --test --test-name-pattern='^(CONTROL|F14)' Pi_Agent_base/tests/aegis-campaign-c1-boundary-review.mjs
node --test Pi_Agent_base/tests/aegis-campaign-c1-external-boundaries.mjs
node --test Pi_Agent_base/tests/aegis-campaign-c1-final-audit3-adversarial.mjs
```

阶段 required 清单为：原来已通过的 17 个 Campaign 脚本 + 上述 F14/CONTROL 聚焦组。
原 17 个列表可从审计基线 `7656e99` 的 tests/aegis-campaign-*.mjs 清单核对，
包括 external-boundaries，不包括后来新增的混合 boundary-review 全量结果。
按实际 diff 选择相关 offline/Pi-faux 回归和针对性 Biome/tsc；不重复无关大范围扫描。
既有 tsc 10 个导入诊断如实列明，不能称命令通过，也不因原基线错误无限延迟本次小修。
mutation 如确需验证准入门，仅做针对性少量检查，不设置固定配额。

混合脚本全量与 F15/F16 诊断可以另跑，保留原断言和真实失败结果，不要求全绿，不跳过伪绿。
F14 的断言必须通过；required 清单出现新回归必须处理或解释其与既有基线的关系。

## 3. 精简交付与推进

复用现有 C1_BOUNDARY 报告：更新 F14 结果、必要测试矩阵行、非阻塞/后置记录、实际命令/exit/log
和 Git commits 即可，不新建一整套长计划/报告。纠正 red 计数 21=2+19，环境归因没有证据就记 unknown。

遵守 Git 规范，明确路径暂存、本地任务提交，不 push、不改写历史、不改无关内容。
不修改 Pi 核心、凭据/模型/lockfile，不跑真实模型或目标网络。

DS 内部验证后如实标 internally_verified / awaiting_external_review。外部复核仅检查 F14 和
受影响回归；通过后进入用户已同意的 C2，不因 F15/F16 再开 C1 修复轮次。
主 DS 不冒充外部验收通过；已有外部确认后无需为进入 C2 重复请求同一授权。
C2 启动时按 `C2_SESSION_ROTATION_TASK.md` 形成自身契约/测试范围，不提前实现 C3-C4a。
