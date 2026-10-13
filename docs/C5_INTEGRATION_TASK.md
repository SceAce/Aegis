# C5：单一入口与完整 Campaign 集成

状态：下一轮待委派，当前仅布置。C1-C4a 已按冻结范围交付，最新记录见 `C4A_EXTERNAL_REVIEW.md`。
不重开已完成阶段，F16/旧类型诊断后置；本阶段只处理实际集成所需接线。

## 冻结交付

给用户一个可复制的 Aegis-owned 入口与配置例子：

```text
显式 Manifest/可信 registrations/Oracle/SDK配置
→ 单一 Host + EventLog owner
→ 静态/动态 Task → Broker → 本地效果 → Oracle/delayed
→ 安全 Session 轮换/账本 → pause/cancel/restart
→ 只读报告导出 + optional loopback observation
```

复用 C1 scheduler、C2 supervisor、C3 assembly、C4 export、C4a server/命令。
CLI 不再要求用户手工拼多个 factory，但不创建第二调度框架/通用插件平台。
支持一套确定性本地 fixture 和一套已注册本地 script 配置；实际模型/远程目标先不启用。
真实 SDK 用 faux，执行真实临时文件/本地注册 subprocess，单活动 Task/Episode。

## 必需接线

- 启动校验 Manifest、实际 adapter 是否存在、授权求交、paths/目录与私有产物，未配置能力显式拒绝。
- runtime resource loader 中加载同一个 Campaign tool gate（含轮换后的新 Session），
  Aegis model action 经既有 Broker/单 writer 记录，不旁路 direct tools。
- 同一 writer 的生命周期跨 Observer/scheduler/rotate/export 明确，不重复打开写链；
  暂停/取消/退出释放资源，未决效果先 reconcile，不盲重发。
- 统一 Task/Episode/Session 绑定和预算基线覆盖位置，实际记录不 double-charge、不跨任务漏计；
  synthetic fixture cost 标记，token/金额无观测为 unknown。
- 安全轮换由 Host 在 idle/settled/committed 边界按现有 policy 发起，真正新对象/context，
  失败无假完成，bounded RAM 保留状态，Session 不是独立 Episode。
- observation 可选/失败不影响执行；print/无浏览器模式有可读输出；端口关闭。
  报告在适当停止/完成边界只读导出，不改 source，不自动调用验收模型。
- restart 用持久 Manifest/committed stream 恢复；summary/report/checkpoint 不授予授权或成功。

## required 产品场景（少量组合，一次阶段验收）

| 场景 | 观测结果 |
| --- | --- |
| 正常 | 单入口启动两任务+受限动态任务，真实 Broker effects、Oracle 结果、依赖释放、报告和观察面一致 |
| SDK轮换 | 真实 SDK/faux provider 通过完整 Host 执行入口在安全边界换一次 Session，跨任务账本与上下文连续 |
| delayed/unknown | 初始未知不提前放依赖，迟到证据推进无 Worker re-effect；报告/UI显示一致 |
| pause/resume/cancel | 不新 dispatch、durable 控制，restart 不隐式复活已暂停/取消任务 |
| crash/restart | 在真实 intent/effect/result 边界用 IPC/barrier kill/restart，未确认非幂等效果核对，不重复副作用 |
| auth/audit | direct tools/越权/未注册/变化 digest 拒绝，写前日志失败无 effect，effect后失败停止 |
| export/observation | 产物同源、秘密不泄漏、源只读，UI关闭/坏源有诊断不成为执行依赖 |
| 操作复现 | 文档列完整命令/配置/目录/退出码/恢复，清理临时目录后用户可重跑，不靠旧派生物 |

只补必要集成反例与回归，不加性能/并行/远程平台/容器/样式门槛。
已有依赖缺陷只有当前可达核心损害才重新处理，其他留 deferred 与条件。
不要求全目录 wildcard 绿色，required/deferred 清单固定；无固定 mutation 配额。

## 真实能力试验边界

本任务不调用真实付费模型、不访问外部目标/网络、不读真实凭据、不做 CTF/攻击实验。
先完成离线整体装配；之后由用户选择具体任务、授权、预算、provider/target 再启动能力对照。
旧架构 C5 的真实 capability 部分保留为用户启动项，不将“全部集成绿”误当真实实验授权。

## 开发与交付

先读开发规范 §3.1、测试/Git 规范、现有任务/验收及实际 SDK文档/API。记录父 repo/Pi HEAD/dirty。
新分支 `feat/c5-integration`；冻结简洁计划、入口参数、owners/预算/事件契约与测试矩阵，
内部小任务自主完成，shared入口/Observer/exports主DS统一管理，无子Agent就串行如实报告。
明确路径暂存/review、本地里程碑 commit，不 push/rewrite，不改 Pi核心/凭据/模型/lockfile。
交付简洁 C5 plan/matrix/implementation report、可复制 runbook 和实际 exit/log/效果/commits/status。
内部通过后 `internally_verified / awaiting_external_review`，一次限定 C5 验收，不自动实验或训练。
