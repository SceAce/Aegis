# C6：模型 Agent 与经验闭环代码交付

状态：**planned / 下一轮总开发任务**。用户确认将原 R1-R6 中的代码工作合并为 C6，
真实模型试运行、效果对照、迁移评估和日常试用另设实验任务。
本轮更新任务规划，不启动实现或实验。C1-C5 的既有验收范围保持，当前基线见
[C5_EXTERNAL_REVIEW.md](C5_EXTERNAL_REVIEW.md)。总路线见 [AEGIS_PRODUCT_ROADMAP.md](AEGIS_PRODUCT_ROADMAP.md)。

## 1. 冻结交付

交付一个 Aegis-owned 产品入口与可信配置：

```text
用户目标 / Manifest / 注册工具与 Oracle / 预算
  → Host 创建 SDK runtime、绑定当前 Task/Episode、生成有界 RAM
  → Router：direct / habit / hint / deliberate
  → 模型提出结构化 Claim / Action / 动态任务
  → Host 准入、原 Broker 执行、独立 Oracle 判定
  → 已提交证据 / Replay / Compiler / 经验派生存储
  → 安全 Session 轮换、控制与恢复
  → 常驻只读观察、报告及实验可用测量
```

开发验证使用真实 Pi SDK + faux、真实临时文件/注册本地子进程/loopback HTTP。
实现已有 SDK 支持的用户指定 provider/本地 endpoint 配置与启动接口，使用离线替身验证；
不读取真实凭据、不实际请求真实模型或外部目标。
代码完成表示该运行链和接口通过工程验证，不表示特定模型的任务能力、上下文收益或学习效果成立。

复用现有 Node ESM/TS、Scheduler、Host、Broker、Observer、Oracle、Compiler、Router、
learning bridge、Replay、C4/C4a，禁止新增第二套等价框架。
原 SDK_LAUNCHER_TASK.md 的生命周期/测试要求纳入 C6-A，原单独 launcher 限制只适用于该子任务，
不能用“只实现 faux launcher”缩减 C6 的模型 Worker、provider 接口与经验交付。

## 2. 公共契约（编码前由主 DS 冻结）

| 边界 | 必须行为 |
| --- | --- |
| 配置与模式 | 统一 CLI/配置白名单；offline faux 为开发默认；实际 provider 必须显式选取 SDK 已支持配置与私有凭据来源，缺失/未知配置拒绝；无自动回落用户默认 auth/models/扩展 |
| Task/Episode/Session | 当前绑定由 Host committed 状态提供；Session 更换不增加独立 Episode；下一 Task 不能沿用无关 SDK 标签；生命周期事件在首个 SDK 回调前有 writer |
| 模型与工具 | 模型提出数据参数/refs，不提供可执行文本、授权或 Oracle；Host/执行包装层重验最终参数、注册 version/digest、grant 与相关状态；direct tools 不绕 Broker |
| 预算与上下文 | 每次真实 SDK provider 请求（含自动 tool loop/继续）与工具调用在调用前准入/预留，提交实际使用；明确初始 Session/轮换费用、失败/中断语义，跨 Task/restart 不重置或双扣；总输入含 ROM/tools/RAM/history/输出预留 |
| 计量可信度 | 可取得的 usage 按来源记录；字符/估算/后端 token 分开；不可观测写 null/unknown；未校准 tokenizer 不宣称精确 token 或金额硬门，requests/tools/Session 硬限额成立 |
| 轮换与恢复 | idle/settled/committed 且无未决效果、预算允许才执行声明策略；真新对象/上下文、有界 RAM，失败无假 completion；SIGTERM drain、SIGKILL reconciliation，无非幂等盲重发 |
| 经验与证据 | 使用原 proof 门；可信隔离 reset/replay、完整可解析证据和明确 scope；显式 Host 学习 policy/proof IDs 才调用编译，保持 promote_experience:false 默认；模型不能晋升 active |
| 跨运行复用 | 冻结源 stream/Manifest/action/adapter digest 与可信导入校验；不能只复制 Outcome ID 或 active JSON；所需 canonical rule/编译参数和证据可保留、重建 |
| 路由与退场 | Host 在模型规划之前 route；direct 无规划请求，habit 仅补缺参数再重验；candidate 不当 hint；冲突/变化/unknown 保留原因，补观测/探索仍受授权与预算 |
| 观察与报告 | run 完成/失败正确清理；observe 可常驻到显式关闭/signal且无写路由，UI 故障不阻止执行；report/view 同源，记录实际经验选择/动作/Outcome 与成本，不伪造贡献或收益 |
| 第二任务族 | 用显式注册 adapter/Oracle 接同一链；独立验收输入只读，模型不能修改测试来制造成功；不因此承诺任意工程/陪学任务 |

公共新事件/字段使用现有版本化机制，不私造持久状态名称。旧 source.kind 信任仍限定可信本地 writer，
不宣称签名认证或 OS sandbox。新公共 API 有 JSDoc/类型、明确失败语义。

## 3. 内部任务图（一次总委派、自主推进）

| 任务 | 代码范围与产物 | 依赖 |
| --- | --- | --- |
| C6-A SDK/Host 生命周期 | 自动 runtime/resource loader/bind/rebind/dispose，Task/Episode 绑定，shared gate/writer，阈值轮换、常驻服务、typed 控制与退出；纳入 SDK-L1-L8 | BASE |
| C6-B 模型 Worker/计量 | observe→模型结构化决策→Broker→Oracle→有限继续；模型动态提案，实际请求/tool ledger 与总上下文门；首个数据修复/转换任务族和可信 Oracle | A 的稳定接口 |
| C6-C Campaign 学习 | 实际 action/data/artifact/Outcome 接入现 learning bridge；真实隔离 Replay、显式编译/派生重建、跨运行 proof、route-before-model、direct/habit/退场与贡献 refs | B |
| C6-D provider 启动接口 | SDK 已支持 provider/local endpoint 的显式配置、私有凭据引用、启动诊断、计量适配；用 faux/注入 SDK 边界替身测试，无真实模型请求 | A/B；可独立编写配置测试 |
| C6-E 实验支撑代码 | 可固定 run/model/经验/上下文策略、输入/seed/版本和输出测量；有界逐 attempt 导出、失败/unknown/usage 来源；复用 report，提供单次/有限清单 runner | B/C/D |
| C6-F 第二任务族/交付 | 临时副本小型代码修复任务的受控 read/patch/registered test adapter、只读外部验收标准；faux 产品验证通用接入；完整 runbook、集成与自审 | A-E |

BASE：记录 parent/Pi HEAD/dirty、实际代码/测试基线；建立一份 C6 plan/matrix，
先冻结接口、任务/Oracle 生成器与正负样本，再实现。首个任务族默认结构化数据修复/转换，
第二任务族默认小型代码工程，不在 C6 同时新增开放式课程辅导或任意 shell。
模型生成的补丁是经过受控 patch adapter 验证的数据，不自动注册它生成的脚本或 test/Oracle。

主 DS 拥有共享 Host/entry/Observer/EventLog/config/resolver/index/report/runner。
有子 Agent 能力才分不相交文件，否则串行如实执行；开发并行不增加运行时活动 Task 数量。
每个小任务先测试/实现/审查/集成、本地里程碑提交，完成后继续依赖任务，不逐小任务请示。

## 4. required 工程验收（不包含效果实验）

| case_id | 必须观测的结果与证据 |
| --- | --- |
| C6-P1 产品链 | clean CLI + 真实 SDK/faux 驱动首个任务族两静态/一动态 Task；模型决策与实际效果对应，合法提案真正 dispatch；无 caller runtime/beforeRun；独立 Oracle/报告/观察一致 |
| C6-P2 安全/轮换 | initial/rotated Session 同一 gate/writer；真新对象/上下文、同当前 Episode/授权/RAM；direct write/bash/edit/foreign refs/越权/伪造成功拒绝；创建/bind/pending/预算拒绝无假完成 |
| C6-P3 账本/输入 | 自动 SDK 内部多请求与工具循环也受调用前预算门；0/1/耗尽、失败、跨 Task/restart 守恒；总输入估算超限显式处理，必需约束不丢；usage 来源与 unknown 正确 |
| C6-P4 持久/恢复 | 完整 stream verifyChain；真实 append/fsync 故障在 effect 前无执行，effect 后停止新 dispatch；typed pause/cancel 不复活；IPC barrier 后 SIGKILL 恢复核对产物无重复效果；SIGTERM/订阅/registry/listener 清理可重启 |
| C6-P5 学习/复用 | Campaign 真实独立 Episode、真实 reset/replay/证据→显式 Compiler；第三 Task direct 零规划请求、habit 只补参数、异常退场；单 proof/foreign/篡改/版本变化不执行；删派生存储可重建跨运行所需数据 |
| C6-P6 provider 接口 | 正常显式配置经 SDK 创建 seam 传入正确 model/endpoint/隔离来源；未知/缺配置/非法来源启动拒绝；provider 错误/usage 缺失可诊断，无真实凭据打印/请求；记录尚未实际验证的 provider |
| C6-P7 服务/测量 | 常驻 observe 实际 HTTP 可访问、无写路由、source bytes 不变；占用端口执行仍完成、signal 后可重绑；单次/有限清单 runner 保留全部 attempt/失败/unknown、配置版本和实测/估算区别，不生成假收益结论 |
| C6-P8 第二任务族/复现 | 同一产品链实际受控 patch + registered local tests，由外部只读标准判定；首族 scope 不适用时拒绝；clean layout runbook 可复制 CLI/控制/恢复/报告，两任务族无需另造 Host |

脚本数量按职责组织，不每个断言造文件。expected 来自契约与独立标准，不能由被测聚合器生成；
有限 mutation 验证关键门，行为 red 与 import/syntax failure 分开。faux 机制验证不是能力实验。
实际 HTTP/本地子进程/隔离重放/Oracle 正负探针都是 required 工程测试，不因“实验后置”跳过。

回归显式列 C5 四原 suite+external-boundaries、受影响 C2/C3/C4/C4a/Observer/learning/fixture。
SDK 使用 source resolver；日志逐命令 argv/exit 放 ignored runtime/dev/c6/。
Biome 修改范围；类型配置覆盖 C6 代码与实际 import graph，记录各配置真实基线（Campaign 现 74，
learning 配置不同）。修复新增诊断，不关闭 checkJs/排除本次文件，不扩大为全库清零。

## 5. 实验支撑与独立实验的分界

C6-E 仅交付复用现有运行/报告接口的配置与测量能力，不建设通用 benchmark 平台。
允许选择 no-memory/bounded-raw/active 策略，使用可信离线错误/过期 fixture 验证拒绝，
以及长/短 Session 模式；实验期间冻结版本/记录 seed/初态的接口应可用。
具体数据集/比例、样本量、随机顺序、最小有用差异、统计方法、provider/费用由后续实验任务冻结。

C6 不运行真实 provider pilot、不校准某个实际小模型、不执行 A/B/C/D 收益试验、
不评估第二任务族泛化或用户日常节省。后续独立实验按先模型运行、再经验与上下文对照、
再第二任务族/日常试用展开；失败或无收益有独立报告与问题反馈。

## 6. Git、边界与最终交付

实施时使用 `feat/c6-agent-product`，只改 Aegis-owned 路径；不改 Pi 核心、用户凭据/模型设置、
lockfile，不恢复旧 demo，不安装未授权依赖，不 push/rewrite，不自动调用验收模型。
新增 provider 配置代码与私有引用接口不等于修改用户现有配置。
如实际 SDK seam 无法实现，记录真实签名、最小 Host 调整与受阻项，其余独立任务继续；
不以假对象/随机标签/弱化门槛造通过。

F16、性能/样式、复杂检索、多 Worker、容器/远程平台、权重训练保持 deferred。
当前可达核心损害才新增 blocker；跨模块接线需要的最小修复可自主完成，不无条件重开旧验收。

维护 `C6_AGENT_PRODUCT_WORK_PLAN.md`、`C6_AGENT_PRODUCT_TEST_MATRIX.md`、
`C6_AGENT_PRODUCT_IMPLEMENTATION_REPORT.md`、`C6_AGENT_PRODUCT_RUNBOOK.md`，小修复复用。
逐路径暂存并读 staged diff，按 A-F 里程碑本地提交，注明 Agent 协助，不留大批代码未提交。
最终列文件/owners、API/配置、required/deferred、实际命令/exit/log、对象/context/效果/链/账本/
学习重建证据、provider 未实测限制、commits/status。
完成 `internally_verified / awaiting_external_review`，交一次 C6 限定工程验收；
工程接受后再单独启动实验，不以测试通过宣称经验提升。
