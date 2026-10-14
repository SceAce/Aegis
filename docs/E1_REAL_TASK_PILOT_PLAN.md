# E1：真实模型与真实任务 pilot 规划

状态：**规划完成 / 模型、任务来源和费用预算待选 / 未启动真实调用**。
日期：2026-10-14。工程基线 `32b0e96`，分支 `feat/c6-agent-product`；证据见
[C6_EXTERNAL_REVIEW.md 第8节](C6_EXTERNAL_REVIEW.md#8-d1a81c8-三个事实分离复验与-sdk-收尾补修)。
本文件规划工程验收之后的 E1 实验。当前仅修改文档，具体运行须有用户选定的
provider、任务目录、授权和预算。

执行补充（2026-10-14）：用户已选max中转站的dsv4.1flash，并自行执行。
已补`remote-openai`接线和零请求prepare/只读status辅助入口；具体命令见
[E1_MAX_OPERATOR_STEPS.md](E1_MAX_OPERATOR_STEPS.md)。以下启动条件表保留规划形成时
的基线；remote seam现经离线SDK/截获HTTP验证，尚未真实调用max。

## 1. 目的与实验顺序

Aegis 的核心目标是把观测和验证变成可复用的条件化经验，减少后续重复探索，
并在不适用时退出捷径。进入真实环境首先取得可靠的无经验基线：

1. 指定模型能否理解需求、读取实际输入、提交合法动作，并完成独立验收的工作？
2. 真实 SDK/provider 的请求、停止类别、预算和产物能否与 Aegis 记录对应？
3. 连续 Task、Session 轮换和已完成任务重启，能否保持进度与责任、避免重复效果？
4. 失败来自模型能力、输入信息、工具、provider、Oracle 还是工程实现？

E1 交回实际可用范围与逐次运行证据。经验收益、长短上下文对照在 E2 冻结，少量
pilot 样本只用于试运行决策，不用于泛化或统计收益结论。

## 2. 当前启动条件

| 项目 | 源码现状 | E1 处理 |
| --- | --- | --- |
| 产品入口 | `c6-entry.mjs` + 真实 Pi SDK/source resolver | 复用同一 Worker/Broker/Oracle/事件流 |
| provider | `faux`、`local-openai` 已接线；`openai`/`anthropic` 明确拒绝，其他 kind 未注册 | 本地服务沿现有路径尝试；远程按选定 SDK API 补最小接线 |
| endpoint | local 仅 loopback `http:` | 不把远程地址伪装成 local，不新增不透明代理绕过配置 |
| 凭据 | local 实际使用 `env:NAME`；`file:` 只解析引用，未在该路径读取密钥 | 采用明确的环境变量引用、隔离 AuthStorage，不自动加载默认 auth |
| 模型描述 | local 固定128000 context、16384 maxTokens、reasoning=false、cost=0 | 准备时核对实际服务兼容性；这些值不证明真实窗口或免费 |
| 测量 | requests/input/usage已有；顶层 backend tokens/currency仍null | 复用已有记录，收费以 provider 独立账单为准，缺失保持unknown |
| 任务族 | structured-data-repair / code-repair等 | 默认小型代码修复；数据修复用于连通和轮换 |
| 环境 | macOS受监督workspace，非OS sandbox | 用无生产数据、无凭据的可丢弃副本；代码Oracle会执行模型补丁 |

工程门槛通过不等于所选远程 provider 已接入。选择远程模型后只实现选定 seam，
不重开旧 C6 修复或一次接入全部 provider。SDK 的 `allowModelNetwork:false` 要按
实际用途解释，不凭字段名推断能否进行推理；连通以真正的服务请求为证据。

## 3. 工具与工作方式

| 调用方 | 现有工具/动作 | 作用与首轮范围 |
| --- | --- | --- |
| 模型 | `aegis_read({path})` | 读取当前Task授权目标；不会自动获得测试、其他文件或整个项目的read grant |
| 模型 | `aegis_task_decision({actions})` | 提交注册动作与数据参数，记录decision，此时没有执行效果 |
| Broker | `code.file.write({target,content})` | 替换指定现有源码文件全文；每任务一个目标文件、一份候选补丁 |
| Broker | `data.record.set({target,field,value})` | 设置JSON对象顶层字符串字段，连通和轮换使用 |
| Host/Oracle | registered test / data judge | 读取真实产物、执行冻结验收，模型不能给自己判success |
| 操作者 | status/export/measure/observe | 查看committed进度、证据和测量，CLI exit不单独证明任务成功 |
| Host | 预算门、轮换、恢复 | 继续使用现有边界，模型不修改授权、Oracle或生命周期账务 |

首轮关闭动态任务扩展，轮换由Host在安全边界触发。已有其他工具机制保留。
patch在规划结束和请求结算之后才执行；现有代码入口没有提供通用的“模型运行测试、
看失败反馈后反复修补”循环，首轮按一次规划→候选patch→Oracle验收记录。
失败不会靠重复启动自动得到新尝试；实际需要新的观测/注册测试反馈时再做小扩展。

## 4. 任务包与任务说明的写法

每次独立attempt用自己的workspace、work_dir、Manifest/Campaign ID，记录实际初态
digest；恢复同一次attempt保持原目录和事件流，不能换目录绕过未决状态。

```text
Pi_Agent_base/runtime/pilot/e1-<run-id>/   # 私有ignored产物
  task-01/
    workspace/solution.mjs               # 真实小模块副本
    workspace/check.mjs                  # Host验收，不在模型写grant中
    manifest.json                        # 目标、验收、授权、预算
    campaign.config.json                 # provider引用与策略
    run/events.jsonl                     # 权威事件流
    measure/measurement.json             # 现有测量
    operator-note.md                     # 冻结摘要、命令/exit、账单与干预
```

测试沿现有registered runner放在workspace；“独立验收”指来源和写授权独立，
不声称OS层隔离。冻结测试digest，模型只获得源码目标。
代码Oracle会在子进程执行目标模块。准备时核对子进程继承的环境变量，在不含真实API
密钥的验收子进程环境运行；当前`spawnSync`继承env，必要时只补该边界的小修。

当前buildPrompt读取`task.goal.description`、target、stage criteria和action catalog；
SDK禁用workspace context files。写工作区AGENTS.md不会自动传入任务要求，需求应写进
goal.description，身份/授权/预算放可信字段由Host校验。

推荐模型可见任务模板（示例，未选作实际任务）：

```text
目标：修复solution.mjs中的normalizeName行为，保留导出接口。
需求：字符串首尾空白应被去除；内部连续空白变为一个空格；空串返回空串。
      非字符串返回null，不得抛异常。
公开例子：" Ada   Lovelace " -> "Ada Lovelace"；null -> null。
允许修改：solution.mjs。先读取当前文件再提出补丁。
约束：保持其他导出行为；不新增依赖、网络调用或模块导入时的副作用。
提交：调用aegis_task_decision，提出code.file.write，参数target和content。
验收：Host冻结测试检查实际文件；提交动作后结束规划，不自行宣布验收通过。
```

实际任务优先提取用户小型真实bug/维护需求，保持所需信息在当前read范围。
说明给完整可实现的语义和少量例子；冻结测试覆盖正常、边界与既有行为，不给参考补丁，
不事后修改需求/测试使某次结果通过。代码criterion使用已有`external test passes`，
具体语义由check.mjs断言表达。写文件成功仍须Oracle可信完成和Task结果才能算完成。

## 5. 推荐首轮清单

默认建议：**一个模型、learning off、bounded_ram、串行执行**，任务场景由用户确定。

| 步骤 | 实际运行 | 目的与进入下一步的条件 |
| --- | --- | --- |
| E1-0准备 | 无真实推理；冻结provider/任务/Oracle，验证坏初态，核对配置/env | 任务初态确实失败、测试可完成、说明足够，运行包和总预算可审查 |
| E1-1连通 | 1个简单数据字段任务，真实模型读文件并提交动作 | 请求、两侧账务、decision、真实效果、Oracle对应；至少一条正常真实链 |
| E1-2主样本 | 4个不同小型代码任务，独立目录/初态 | 语义修复、边界修复、输入处理、保留行为；保留全部attempt，至少两个不同任务验收成功才称该范围初步可用 |
| E1-3连续性 | 1个Campaign含2个数据Task，低阈值轮换；完成后重启 | 真新Session、不丢进度/预算；完成后重启provider/effect增量0 |
| E1交回 | status/export/measure + 人工核对diff/账单 | 全部结果、归因、可用范围、继续/调整/暂停建议 |

合计6个Campaign、7个Task；完成后重启不是新能力样本。连续数据任务的要求应相容，
第二Task不抹掉第一Task已验收状态。阈值按provider请求计，轮换仍在Task安全边界，
不承诺活跃Task内立即轮换。模型答错被Oracle判failure是有效负结果。
零假成功、越权、重复effect和预算责任丢失是工程条件，任务成功率是能力结果。
追加尝试单独编号，不能用手工修补、换模型、删除失败或扩大预算覆盖原结果。

## 6. 建议预算、命令与停止

以下为待用户确定的建议默认值：

| 范围 | provider请求上限 | 工具额度 | 时间安排 |
| --- | --- | --- | --- |
| 连通1Task | Campaign/Task各4 | 各8 | 180秒，外部看护 |
| 每个代码Task | Campaign/Task各8 | 各16 | 各180秒，独立记录 |
| 连续2Task | Campaign12 / 每Task6 | Campaign24 / 每Task12 | Campaign360秒 |
| 全首轮 | 最多48（各Campaign限额总和） | 最多96（同口径求和） | 操作窗口约30分钟 |

请求含SDK自动continuation；一次aegis_read往往需要下一次请求，不把额度1作为正常
工具循环预算。工具数按当前gate实际计数口径，不把96解释成96次写文件或全部read次数。
多个Campaign没有现成全局费用账本，总量由冻结清单额度总和及串行操作控制。
费用由用户选择，收费服务优先设provider账户/项目硬额度；requests/字符窗口不能替代
金额上限，SDK cost=0或usage缺失不表示免费。

context初值可用bounded_ram、24000字符窗口、4000输出预留，准备时按实际模型窗口
核对。字符预留不等于SDK maxTokens，也不是精确token门。Manifest、Campaign和Task
预算均须填写和校验，不直接沿用fixture的100请求等默认值。

复用Runbook CLI（规划阶段未执行）：

```bash
# 仓库根目录；config由已冻结运行包提供。
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/memory/campaign/c6-entry.mjs \
  --config <本次配置绝对路径> run --export
```

首轮逐包串行便于失败后检查。runBoundedAttempts的initial_state只有可信initializer
才真正reset，seed元数据也不保证后端确定性，暂不增加另一套实验平台。

- 额度/窗口耗尽：记录拒绝和用量，结束attempt，不临时加额度。
- provider/SDK/记账未决：停止后续dispatch，保留原stream/hold，不自动退款或换ID重试。
- Oracle失败保留failure；测试不完整/超时等保留unknown，不转completed。
- SIGTERM为Task边界drain，当前Task可能完成；时间预算为调用边界检查，不是正在等待的
  provider请求的强制定时器，准备时核对endpoint超时和外部看护。
- 持续挂起可由操作者强制停止，保留unknown/未决并核对产物。未决不会因重启解除，
  不从另一执行进程并发写pause/cancel来假设已验证的单写控制保证。

真实故障自然出现就记录；首轮不额外花费故意断流请求。特定provider的故障测量另列
后续有界场景，已通过的离线真实SDK/事件流恢复测试不重复扩大。

## 7. 测量、归因与下一阶段

复用events/report/measurement，补有界operator note，每次记录版本/模型/endpoint类型、
config/Manifest/初态/Oracle digest、Task和Oracle结果、实际diff与测试完成情况、命令/exit；
每侧consumed/reserved、联合unresolved、规划停止类别、请求与工具数、累计/峰值输入字符、
墙钟时长、实际usage来源、独立账单、route/轮换、人工干预与拒绝详情。缺测量保持unknown。

结果使用success/failure/unknown/blocked，归因区分provider接入、模型/需求、工具不足、
Oracle harness和产品实现。连通失败不说明经验算法无效。仅可达假成功、越权、重复效果、
预算错误或权威记录损坏重开工程门；普通warning、历史类型诊断和性能偏好不扩大E1。

E1可用后，E2固定模型/工具/Oracle/预算/初态，先比较无经验与有证据门的active经验，
分离训练和未运行的留出变体，记录direct/habit/hint/deliberate实际路由、重复探索和成本，
加入条件变化样本验证退出捷径。再固定经验策略比较短Session+图板和长Session。
样本量据E1费用/变异决定；两次Session不是两次独立经历。
数据任务经验/replay基础明确，代码修复成功不自动证明经验泛化。CTF、跨文件工程和
陪学需要相应工具/Oracle时再适配，单文件pilot不代表这些场景已可用。

## 8. 工作分配与待选输入

| 工作 | 执行方/交付 |
| --- | --- |
| 选provider、任务与预算 | 用户给模型名、endpoint类型、任务来源/副本、费用与时间；密钥仅私有注入 |
| 运行包、测试与小接线 | 当前会话直接完成，交具体文件、配置、命令和准备检查证据 |
| 若选定接线需要较大工程 | 写有界任务交dsv4.1flash：仅该SDK provider seam，离线替身/相关回归/本地提交，不代用户跑付费实验 |
| 真实执行、归因与交回 | 既定授权和费用内串行执行，保留全部attempt，复核实际结果后决定下一步 |

最少待选输入：**首轮任务场景；provider/model与endpoint类型；总费用和运行时间；
具体任务副本及验收需求**。当前不新建通用工具平台或任意shell，不重派生命周期架构修复。
