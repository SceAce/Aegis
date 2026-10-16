# Thinking

[carin](https://github.com/oritera/Cairn)的思路是，不断通过脚本调用模型，或者Agent，每次都把成果和猜测写入图板，这个一个非常好的思路，但是会很慢。

现在需要解决的一点问题，模型的准确性，执行路径的正确拟合。应该怎么提高模型的准确性呢？

我的想法:通过某些`神秘的手段`把codex与deepseek harness联系起来，这从理论来说是完全可以做到的，因为二者都是开源软件。当两者联系起来了之后，`但是怎么确保两者里面至少有一条路是正确的呢？`
        1:穷举法，分发大量子Agent去试错。但是老铁的Token也在如奶油般化开
        2:成长性，我认为当前的框架应该具备自我成长性，拟人化。

人类最强大的就是依照已有的知识进行延伸验证。虽然在人类历史上消耗了大量的时间，但是依照已有的网络资源，以及自我训练的数据训练速度，应该是可以无限缩小这个时间的。而在竞赛，或者其他不能进行大量验证的，只能依照知识库，或者高性能工具进行验证，并且这个时间不能长。以防止没必要的时间消耗。

需要注意的是，模型的优势是写出的代码准确率会高很多，但是会为了防止一些未发生的意外情况而选择打上巨量的补丁，不允许AI进行未雨绸缪从而写一大堆预防用的代码和操作，这会浪费大量的时间，只需要确保它不会进行非工作区的文件删除操作即可

我想提高模型尽量往正确的地方走，思考。那么我的框架应该如何？如果说像“专家”一样，通过大量论文和Wp作为知识库，大概率无法正确的被使用，有没有相应的论文？

我的想法还有，它可以陪我一起学习，比如我在学习一个技法，看一个课程的时候，它能陪我一起看，如果能给我讲解就更好了。

# 框架

两份文档，分工明确：

- [`架构.md`](./架构.md) —— **规格：造什么**（561 行）
  一页纸 → 数据模型与四条宪法 → 控制循环 → 五子系统 → 成长与刹车 → 路径拟合
  → 记忆与遗忘 → 场景参数化 → 度量 → 安全边界 → 落地顺序 → 缺陷登记

- [`框架.md`](./框架.md) —— **证据：为什么**（452 行）
  理论依据（ICLR'26 重采样定理、跨模型错误相关性 ρ、经验库四条实证、训练四条实证）
  → 能给什么保证 → Codex↔DSH 接线 → 领域落地（固件 + 车机）→ 开放问题

**证据与实测数字只在 `框架.md` 维护一次**，`架构.md` 只引用不复制。

# 进度

26-9-22

模型grok，暂时在测试基于pi的deepseekv4.1针对CTF pwn-heap题的记忆库的训练，仅仅是一个小demo，用于验证idea的可行性

目前的demo具备的能力：简易的记忆能力，经验使用能力。

26-9-23

模型dsv4.1flash，依旧测试记忆和经验对模型的提升作用，优化了提取的部分，但是依旧存在一些问题，经验对模型的提升作用貌似并不大，原本800+秒出题，现几乎相差无几。但是似乎消耗在一些临时测试，比如测试calloc的时代性。莫非是数据量不够？或者我的算法不够强？需要注意的是貌似模型开始堆屎山，开始叠加。我应该规范模型写代码和文档的格式，不允许屎山堆叠。我似乎需要找到一个合适的格式用于存储知识库或者经验，技巧。

26-9-24

由于环境问题，未能有推进，但是我意识到一个问题：关于记忆和经验，貌似是我们通过学习某种手法，突然发现在某个题可以这么打，满足某个条件。[那么我们只需要分析题目的时候点亮对应的条件就可以触发调用这个手法？]。这个是打题，那如果是做其他的呢？尝试？比如遇到一个完全没有见过的东西，我们会先去找这个东西的概念，这个里面有没有我们熟悉的东西，日常生活中，好像很多事都是根据已有的事情或者经验进行逻辑的正推和反推，不断拓展。

26-9-25

我认为需要先搭建好一个完整的环境，所以我决定先把主要的几个部分完成。那么开始架构的实现，架构的规划：

引入Observer机制，Observer会监视所有worker整个流程的事件，将对应的数据写入对应的问题，这些对应的数据后面提到：其中公共黑板由Observer维护，由它写入，删除。

我认为单独的裁判没有存在的必要，因为单独的裁判的边界不好判定，尤其是日常生活中，所以我认为这个应该由两个部分组成，

1:用户的需求输入；2:下一个阶段的目标。当然必须尽量精简，最好是几个字就能清晰的描述。
关于记忆和经验，首先记忆的收集不再由LLM大模型写入，由Observer 查询每个worker的json日志，取关键的字段组成记忆，由于记忆是清晰的所以记忆可以具体化，同时可以使用遗忘机制防止记忆越积越长导致幻觉。但是记忆不能驱动行动，不能对行动造成影响。而经验由记忆提纯出来，纯粹的驱动行为。

26-9-26

按上面的规划动了手，分三块：

**Observer 原生进 pi。** 单独建了 `vendor/pi/`（浅克隆，33M）作为我们的 pi 修改版，
Observer 写成**内置扩展**而不是外部日志解析 —— 因为原生能挂到 `tool_call`/`tool_result`
每个缝上、能在执行前拒绝，而且能写**我们自己拥有的**事件 schema（解析 pi 的内部 JSONL
等于依赖一个带 migration 的格式，上一轮世界模型解析反了就是这么来的）。

**分层重构。** 原来的平铺 21 个模块按职责分成
`core / observer / blackboard / policy / channel / knowledge / storage / cli`，
依赖单向。删掉了 `migrate.py`、`activate_legacy.py`，以及 store 里那段
"从散文反解结构"的兜底 —— 那正是要删的那类东西。

**三个已议定的部分落地。**

1. **成果标准取代独立裁判**：标准 =（用户需求，下一阶段目标）两段**可逐字核对**的短标记，
   由**外部**给出，生产者不许写自己的标准；核对是机械字面匹配。
2. **记忆**：Observer 从事件流机械抽取，**不调 LLM**；具体、**不驱动行动**（有测试断言它进不了行为路径）。
3. **经验**：由记忆机械计数提纯，是唯一允许影响行为的东西。

**实测印证了"不能看 ok"**：拿 24 份历史会话日志跑了一遍（零 token），
958 次动作里 `ok=True` 有 931 次，但真正 `uid=0(root)` 的只有 **2/19 轮**。
所以 `ok` 降级为纯运维字段，判成功改用黑板上的标准 ——
即"父 agent 依据黑板上的用户需求或阶段任务判断"，而不是工具退出码。

回归：离线测试 61/61；重构前后真实数据结果逐项一致（24 会话 → 1917 事件 → 958 记忆 → 824 经验行）。

26-9-26（续）—— 把没写完的三块补上

1. **编译改成机械的。** 原来让 LLM 从 WP 散文里抽结构，那正是假阳性的来源，也和
   "记忆不由模型写"直接冲突。现在是算术：事件流 → 记忆 → 计数。不生成，就编不出来。
   原来放在 `_sanitize` 里的证据纪律（关保护打通的不许当成功）搬到了
   `pipeline.sync(evidence=...)`：不可信的轮次照样入库可审计，但结果被中和，不算成功。

2. **遗忘。** 旧会话压实成计数、容量设界、条件被否证即丢弃 ——
   按**证据**而不是按**时间**（安全知识不因时间久了变假，因目标变了变假）。
   每次丢弃先写审计行再改库：静默丢失会让"从没观测到"和"观测到又删了"没法区分。

3. **经验驱动行为。** 指引要有成功记录；**禁令**要同时满足零成功、≥2 次失败、
   且条件非空并被当前世界满足。最后一条很要紧 —— 拿一条含糊记录把能用的手法毙掉，
   正是 `guard.py` 自己警告过的那种贵错。

顺带修了一个真实数据暴露的问题：条件原本是"观测到的东西的并集"，于是一轮里先探容器
（glibc 2.44）再探远端（2.27），就得到 `hooks_alive AND hooks_dead` 加两个 glibc 版本 ——
一个从没存在过的世界，会拿错误的经验去匹配目标。现在后量的覆盖矛盾的：551 条条件记录，0 条自相矛盾。

26-10-2
我认为有必要查询一下 LLM+Agent 之间的具体实现关系，因为我需要思考怎么让我获取到的文本/知识/经验注入到LLM/Agent 里面，目前的想法是通过 ROM 也就是类似于 Agents.md 这种 markdown 文件来约束或者说是唤醒 LLM+Agent 的记忆。但是我认为这貌似有点不够耦合，也就是说，还是像给 AI 玩角色扮演，控制的精度等都不会够。我希望更加集成。

26-10-6~26-10-7

经验的本质是什么？-> 经验说白了，也就是一些文本，一些激活函数
经验怎么提取？-> 通过路由过滤，机械提取
怎么正确的使用经验？-> 类人，激活

# 当前的架构 26-10-7~26-10-8订

Aegis 不是重新训练一个 LLM，也不是单纯给模型增加一组 Markdown 知识。
Aegis 是位于 LLM 与工具执行环境之间的**可验证 Agent 控制系统**：

```text
LLM：理解任务、提出假设、规划行动、请求工具
Agent：维护状态、组织循环、处理工具结果、决定是否继续
Aegis：管理证据、控制可用行动、验证结果、编译可复用经验
```

项目要实现的成长不是“让模型记住更多文本”，而是让 Agent 在后续任务中：

- 更早识别当前环境与已知经验的关系；
- 减少已经验证过的路径上的重复探索；
- 在经验不适用时不强行套用；
- 让每次成功或失败都能被外部验证并留下可追溯依据；
- 将可靠经验转换为下一次可执行的行为能力。

因此，核心目标是：

```text
现场猜测
  -> 观测与验证
  -> 条件化经验
  -> 受控的再次执行
```

理想化：不断精进。
非理想化：**可能会不断质疑自己而不敢尝试!**

## 2. LLM、Agent 与 Aegis 的边界

LLM 本身主要完成：

```text
输入上下文 + 工具定义 -> 文本或工具调用
```

LLM 不会自动读取外部 Experience，也不会自动可靠地“想起”一条存储在磁盘上的经验。
如果没有检索、工具或训练过程，模型参数并不知道 Aegis 的经验库存在。

Agent 负责把 LLM 放进一个持续循环：

```text
任务 -> LLM 请求 -> 工具调用 -> 工具结果 -> 下一轮请求 -> 结束
```

Aegis **负责控制这个循环中的`证据和行动边界`**，不是试图**控制`模型的内部思考过程`**。
可控的对象包括：

1. LLM 能看到的上下文和工具定义；
2. 当前允许使用的工具和参数范围；
3. 工具调用是否满足前置条件和授权范围；
4. 工具执行后是否需要继续、暂停或转交验证；
5. 哪些结果可以写入长期记忆；
6. 哪些经验可以重新参与后续决策。

认为需要补充的点:在 被Aegis 检索的情况下，参数记忆(Model Weights)优先级低于外部记忆(Experience Store)；在正常情况下，参数记忆优先级大于外部记忆;

我认为需要引入：Provenance .它的作用有且只有一个：这条经验到底是从哪里来的？它类似于一个场景。
一条 experience 应该如下结构：

```bash
Experience
├── Content         # 内容
├── Preconditions   # 前提条件
├── Evidence        # 证据
├── Provenance      # 出处
├── Confidence      # 信心
├── Validation History # 验证历史
├── Failure History # 失败史
├── Usage History   # 使用记录
└── scope           # 适用范围
```

## 3. Event 到行为能力的完整链路

```text
Event
  -> Episode
  -> Outcome
  -> Experience
  -> Router
  -> Skill / Policy
  -> Tool Guard
  -> 工具执行
  -> Oracle
  -> 新 Outcome
```

各对象的职责必须保持分离：

| 对象 | 含义 | 是否直接驱动行动 |
| --- | --- | --- |
| `Event` | Pi 和环境产生的原始事件 | 否 |
| `Episode` | 一次有目标、有范围、有生命周期的尝试 | 否 |
| `Outcome` | Oracle 对结果的外部判断 | 否 |
| `Experience` | 从多个验证结果编译出的条件规则 | 间接 |
| `Skill` | Experience 的可执行投影 | 是 |
| `Policy` / `Guard` | 工具执行前的硬约束 | 是 |

`Event`、`Episode` 和 `Outcome` 是证据链；`Experience` 是知识规则；`Skill` 和
`Policy` 才是运行时控制层。不能把一条经验记录直接当成可执行能力。

## 4. 当前采用的控制手段

控制不应依赖单一的 ROM 文件，而应分为不同强度的层级：

```text
ROM / Prompt       -> 语义约束，告诉 LLM 应遵守什么原则
上下文投影          -> 请求级信息，只提供当前需要的内容
工具 Schema         -> 限制工具名称、参数类型和调用格式
Experience Router   -> 判断哪条经验是否适用
Skill 执行器        -> 执行经过验证的步骤和检查
Tool Guard          -> 在真正产生副作用前拒绝非法调用
Sandbox / 权限      -> 限制文件、进程和环境边界
Oracle              -> 独立判断结果是否成立
```

控制目标不是让 LLM 的每一个内部想法都正确，而是保证：

```text
未经验证的判断不能成为事实；
未经授权的行动不能产生副作用；
不适用的经验不能自动执行；
执行结果不能由 Agent 自己宣布为成功。
```

## 5. ROM、RAM、Experience 和 Skill 的关系

### ROM：稳定原则

ROM 类似 `AGENTS.md`，适合保存永远成立的系统约束：

- 观测、声明、行动和结果必须分离；
- 工具成功不等于任务成功；
- 证据不足时保留 `unknown`；
- 只能在授权范围内操作；
- 先观察环境，再进行非探索性行动。

ROM 应保持短小、稳定、常驻。它不适合承载大量具体任务经验。

### RAM：当前工作状态

RAM 保存当前 Episode 的临时状态，例如：

- 当前目标和 Episode ID；
- 当前环境摘要；
- 已观察到的事实；
- 当前工具调用和未完成步骤；
- 当前候选经验及其匹配结果。

RAM 会随 Episode 变化，不是长期知识库，也不应直接替代 Outcome。

### Experience：经过验证的条件规则

Experience 应表达：

```text
当条件 C 在范围 S 内成立时，动作 A 有较高概率满足后置条件 P。
```

它必须包含条件、动作、预期结果、适用范围、证据和来源，且只能由编译器在
Oracle 证据门槛后生成或晋升。

### Skill：可执行能力

Skill 是 Experience 面向运行时的投影。它需要额外包含：

- 参数绑定方式；
- 前置条件检查；
- 有序执行步骤；
- 中途失败处理；
- 后置条件验证；
- 允许的工具和副作用范围。

当前的 `locked=true -> locked=false` 经验仍然只是候选规则，尚未成为 Skill，
所以它目前不能自动改变 Pi 的行为。

### 关于RAM注入LLM的问题

正常来说，我们提供的是 markdown 格式的文档，但是注入到 LLM 里面这样显然是低效的，所以我们应该规定一个机构化的 json 字段来处理一下字段，这部分我认为脚本自动化应该可以完成的很好，不过处理用的算法需要研究完善一下.

关于当前 RAM 不是实时工作记忆的问题：
我们参考了 carin 的实现思路，我认为可以多次调用 LLM，频繁的开启多个会话来达到尽量将 RAM 的注入 LLM 的效果。

## 6. Experience 如何进入 Agent

推荐使用 `Experience Router`，而不是把完整的历史记录或 Markdown 经验库直接塞进 Prompt。

```text
当前任务与环境
  -> Router 检索候选 Experience
  -> 检查 when / scope / 权限 / 参数
  -> 选择执行模式
```

执行模式分为三类：

| 模式 | 条件 | 行为 |
| --- | --- | --- |
| `hint` | 匹配不确定 | 给 LLM 一个很短的提示，由 LLM 继续规划 |
| `skill` | 经验匹配但仍需参数或判断 | 暴露受控 Skill，由 LLM 调用 |
| `direct` | 低风险、参数完整、步骤确定 | Router 直接调用 Skill，完成后交给 Oracle |

语义检索或 embedding 只能用于找候选，不能单独触发动作。最终是否匹配必须由
结构化条件、作用域、权限和当前状态共同决定。

## 7. Pi 中的运行时集成点

Pi 已经提供了实现上述控制层的接口：

- `before_agent_start`：任务开始时进行经验路由和初始上下文构建；
- `registerTool`：把 Skill 注册为模型可调用的工具；
- `setActiveTools`：只暴露当前任务可能需要的工具；
- `tool_call`：在工具执行前检查、拒绝或处理调用；
- `tool_result`：记录执行结果并更新当前工作状态；
- `turn_end` / `prepareNextTurn`：每轮结束后重新评估是否继续；
- `transformContext`：在请求边界注入最小必要的动态信息。

当前 Aegis 主要使用了事件记录和 `before_agent_start` 的 ROM/RAM 注入。
Router、Skill Registry、Tool Guard 和运行时 Experience 投影仍是下一阶段工作。

## 8. 当前实现与目标实现

```text
当前：
Pi -> Observer -> Event log -> Oracle -> Outcome -> candidate Experience

目标：
Pi -> Observer -> Router -> Skill / Hint -> Tool Guard -> Tool
                 ^                              |
                 |                              v
          Experience store <- Oracle <- Outcome <-
```

当前系统已经能够证明“事件可以被记录、结果可以被独立判断、候选经验可以被编译”。
当前系统还不能证明“经验已经改变了 Agent 的行为”，因为运行时检索、Skill 执行和
Tool Guard 尚未接入。

# 9. 待回答的架构问题

本节用于在继续实现 Router、Skill Registry、Tool Guard 和运行时状态之前，逐项确定
系统契约。每个问题都应记录最终决定、选择理由和暂不解决的边界。未决定的问题不应
被实现代码自行猜测。

### 9.1 控制权与执行边界

1. **Aegis 是否必须成为所有有副作用动作的唯一入口？**

   如果 Pi 仍能绕过 Aegis 直接调用 `bash`、文件写入或其他底层工具，Experience、
   Policy 和 Guard 只能影响模型建议，不能保证实际执行。需要决定：

   - 所有副作用工具是否必须经过统一的 `Action Broker`；
   - 观察类工具是否允许直接执行；
   - Aegis、Router、Skill、Guard、Sandbox 之间的最终控制顺序；
   - Aegis 故障时副作用动作是否必须 fail-closed。

回答：  我认为 Aegis 就应该是所有副作用动作的唯一入口，LLM 仅仅负责决策，不能执行行为。
        那么怎么实现呢？我认为可以引入 git，通过 git 进行管理，一步一 commit，同时 Aegis 故障操作时需要 fail-closed，同时报告给日志。由于Aegis 的交流核心在于共享板上，所以下次 LLM 调用的时候会有一个小的提示：xxx操作->fail-closed->尽量少用。这部分会加载到 RAM 里面，作为 tools-hint。观察类工具允许直接执行，因为这些不会造成危害。Aegis、Router、Skill、Guard、Sandbox 之间的最终控制顺序；Sandbox 的权限是最高的，在 workspace 里面是所有权限都有的，并且此时 Sandbox == workspace,但是在 Sandbox 外面，几乎无权限，如果需要权限需要向 Aegis 发送提权请求，由人类确定是否提供这个权限。请求合适依旧是 json，包含字段：原因，需要执行的操作，危险程度。并且Aegis提供给人类的请求格式也是这个，不过被拼接成了自然语言。

1. **Experience 的“优先级高于模型参数记忆”具体作用在哪一层？**

   需要区分“提供上下文”和“获得执行权”：Experience 可以被注入 Prompt、改变可用
   工具、触发 Skill，还是可以直接执行低风险动作？哪些能力永远只能由 ROM、授权或
   Tool Guard 决定，不能被 Experience 覆盖？

回答：  需求区分一个规则：在 Sandbox 里面 也就是 workspace里面是没有危险操作的，因为可复原。只有在 Sandbox 外面才是危险操作
        可以针对 LLM 引入一个"偷懒"机制，因为人类在知道这部分具体操作方式，会尽量简便，而这个时候经验是能够驱动行动的，此时基本都是简短的验证，而且很少会写脚本，或者代码来验证，因为写代码是非常耗费时间的事情。

>       “偷懒” 机制(弱思考模式)：当已有经验足以覆盖当前状态时，Agent优先复用已验证的行动路径，只检查少量决定性条件
>遇到异常，冲突或未知状态时，再恢复完整推理.经验命中之后不能仍然要求 LLM 阅读全部历史，复述原理，重新生成完整方案，这不符合"偷懒".经验命中后不重新设计和生成实现；优先调用已有工具、结构化动作模板或已经编译好的 Skill。

   等级          条件                              行为
  ━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   direct        精确匹配、动作确定、可快速验证    不调用 LLM 规划，直接执行
  ────────────  ────────────────────────────────  ───────────────────────────────
   habit         经验匹配，但需要绑定少量参数      LLM 只补参数，不重新设计路径
  ────────────  ────────────────────────────────  ───────────────────────────────
   hint          部分匹配或存在少量未知            告诉 LLM 推荐路径和待确认差异
  ────────────  ────────────────────────────────  ───────────────────────────────
   deliberate    无经验、冲突、异常或验证失败      恢复完整分析和探索

经验可以逐渐拆成三个可组合部分：
Recognition：我是否见过这个场景？
Procedure：在这个场景中通常怎样行动？
Verification：怎样低成本确认行动有效？
不同领域只需要替换观测谓词和动作原语：
代码工程：
repository_revision + test_state
> apply_known_fix
> run_targeted_test
>CTF:
>libc_version + mitigation_state
> apply_technique
> verify_primitive
>日常任务：
>document_type + user_preference
> apply_workflow
> inspect_result

Router、状态机和证据逻辑可以保持不变。
后续还可以支持经验组合：
Experience A: REFt
Experience B: ille
Experience C: # 1 *
Experience D: | iI
这比存储一条很长的自然语言经验更容易迁移。

"偷懒"机制(弱思考机制):采取少量，关键的状态，尽量原子化，通过 Router 召回 Experience，检查 active / scope / precondition / conflict 从而计算最小推理等级，让 direct, habit 复用已有的行动，并且做快速的 oracle 验证成功则结束，如果异常就退出捷径并且启动完整推理逻辑。同时，针对 LLM 不允许其进行爆破这类操作，因为性价比很低.

### 9.2 Action、Capability 与竞态

1. **是否引入结构化的 `Action` / `Capability` 对象？**

   当前链路描述了 Skill 和 Tool Guard，但尚未定义一次动作请求的完整生命周期。需要
   决定 `Action` 至少是否包含：

   ```text
   action_id    # 动作ID
   episode_id   # 剧集 ID
   attempt_id   # 尝试 ID
   state_revision   # 状态修订版
   world_snapshot_id # 工作快照ID
   experience_id # 经验 ID
   risk_class   # 风险等级
   idempotency_key # 幂等性——Key
   ```

   还需要决定 Capability 是否是一次性的、是否有过期时间、是否绑定具体工具和参数。

   我认为：Capability 不是一次性的，但是有沉淀时间，同时应该绑定工具，特殊的需要绑定参数，同时我认为应该尽量原子化 capability 也就是说，执行一些小的操作，观察类的的，低危害的操作。

2. **如何处理“检查前置条件后、真正执行前”的环境变化？**

   是否采用以下流程：

   ```text
   prepare -> snapshot -> policy check -> capability grant -> commit -> verify
   ```

    如果 `commit` 前后环境版本不一致，动作应重试、降级为 `unknown`，还是直接拒绝？
    回答： 如果 `commit` 前后环境版本不一致，动作应重试一次、降级为 `toBrDetermined`，如果重试失败，提交日志的时候需要提到环境或者其他地方的差异点

### 9.3 多会话、多 Worker 与 RuntimeState

1. **多个 LLM 会话能否同时修改同一个 Episode 的状态？**

   需要决定是否引入：

   ```text
   worker_id
   attempt_id
   parent_attempt_id
   lease_id
   causation_id
   state_revision
   ```

   Worker 是否只能提交 Event、Claim 和 Action 请求，而不能直接写 RuntimeState、
   Experience 或 Policy？同一 Episode 是否只允许一个有效写入租约？

    回答：不能多个 LLM 同时修改同一个 Episode ，引入锁机制，当有 LLM 正在修改的时候，上锁，锁上需要有这个 LLM 相关的信息，其他需要写入的 LLM 可以写入 BUF,我们引入缓冲区的概念，以队列的形式一个个写入。

2. **Pi 崩溃或动作结果丢失时，状态如何恢复？**

   回答：采用“事件日志优先、Oracle 恢复、默认 `unknown`、按动作类型决定是否重试”的规则。

   - Action 已发出但没有收到 Tool Result；--> 标记为 `unknown`，由 Oracle 检查后置条件；能够确认结果则补写 Outcome，不能确认则停止自动重试。
   - Tool 已执行但 Pi 在写 Event 前崩溃；--> 标记为 `unknown`，由 Oracle 检查真实环境状态；恢复日志后补写恢复 Event 和 Outcome，无法确认是否执行成功时停止自动重试。
   - Event 已写入但 SQLite 投影尚未更新；--> 以 JSONL 事件日志为事实源，重放日志并重建 SQLite 投影，不把 SQLite 中暂时缺失的数据视为动作失败。
   - 同一 Action 因超时被重复提交；--> 执行器通过 `idempotency_key` 识别重复请求；只有只读或已确认幂等的动作可以自动重试，非幂等动作必须先由 Oracle 检查状态。
   - 事件日志写入失败但工具已经产生副作用；--> 暂停该 Episode 的后续副作用动作；恢复日志系统后由 Oracle 核对环境，并补写恢复 Event 和 Outcome。

   统一重试规则：

   - 结果不确定时一律记录为 `unknown`，不能推测成功或失败；
   - 只读动作可以自动重试；
   - 可自动重试的副作用动作必须具有 `idempotency_key`，并且执行器必须确认它是幂等动作；
   - 非幂等动作禁止自动重试，必须先由 Oracle 检查真实状态；
   - 不可逆动作状态不明时停止，并请求人工确认。

### 9.4 RuntimeState、RAM 与长期对象

1. **RuntimeState 的真实来源是什么？**

   需要决定 RAM 是否只是 RuntimeState 的文本投影，以及哪些字段只能从事件投影得到。
   至少需要划分：

   ```text
    1. runtime_state_id     状态对象 ID
    2. episode_id           所属 Episode
    3. state_revision       状态版本，用于并发检查
    4. lifecycle            running / waiting / verifying / stopped
    5. goal                 当前目标和成功条件
    6. authorization        工具、目标、预算和副作用边界
    7. world_snapshot       当前环境快照及 fingerprint
    8. verified_facts       Oracle 已确认的当前事实
    9. claims               LLM/Worker 提出的待验证判断
    10. action_state        当前、等待中及已完成的 Action
    11. experience_state    候选、匹配、选中或拒绝的 Experience
    12. control_state       Policy、预算、锁、停止和恢复状态

   ```

   是否允许 LLM 直接修改 RuntimeState？如果允许，哪些字段必须经过 Observer 或
   Oracle 确认？

   回答：不允许LLM 直接修改 RuntimeState,应该由Aegis 自主收集整理写入，LLM 只能提交 claims 和 Action，Observer 作为观测者，更新动作和环境观测，Oracle 写入 verified_facts,Router 更新 experience_state,Aegis Runtime 更新版本，锁，预算和生命周期。goal 与 authorization只能由用户和上级调度器修改

2. **是否将“知识”“经验”“偏好/授权”分成独立存储类型？**

   当前 Experience 主要表达“在条件 C 下执行动作 A”。还需要决定以下内容是否独立：

   - 已验证但不直接指导动作的事实知识；
   - 用户偏好、项目约束和授权范围；
   - 经验的使用说明或自然语言解释；
   - 当前任务临时生成的假设。

### 9.5 Experience 生命周期与版本

1. **Experience 的版本、晋升、暂停和退役规则是什么？**

   是否采用：

   ```text
   candidate -> active -> suspended -> active
                       \-> retired
   ```

   需要明确：

- `candidate` 至少需要几次独立成功；
- 哪些冲突会触发 `suspended`；
- 环境变化是否自动暂停经验；
- `retired` 是否不可恢复；
- 修正经验时是覆盖原记录，还是生成新版本；
- 旧版本是否继续用于历史回放。

1. **Experience 的结构化执行部分允许表达什么？**

   `Content` 可以是自然语言，但 `precondition`、`action`、`postcondition` 是否必须
   使用结构化谓词和受限 DSL？是否禁止 Experience 携带任意脚本、任意命令或可执行
   字符串？Skill 的参数绑定、重试、停止和回滚规则由谁定义？

2. **Experience 冲突时如何选择？**

   当多条经验同时匹配但动作或后置条件冲突时，优先级是否按以下因素排序：

   ```text
   安全与授权
   > 当前 Oracle 事实
   > scope 的具体程度
   > 证据等级
   > 独立验证次数
   > 最近验证时间
   > 模型参数记忆
   ```

   如果无法确定哪条经验更可靠，是选择 `hint`、进入 `explore`，还是直接拒绝执行？

### 9.6 Scope、快照与有效期

 1. **Experience 的 Scope 需要包含哪些维度？**

   除环境指纹、运行时版本和目标类型外，是否还必须包含：

   ```text
   target_identity
   repository_revision
   tool_versions
   adapter_version
   permission_scope
   user_or_project_scope
   valid_from / valid_until
   ```

   哪些字段必须精确匹配，哪些字段允许范围匹配？环境指纹变化后，经验应自动暂停、
   降级为 Hint，还是允许继续使用并等待重新验证？

 1. **WorldSnapshot 的采集边界是什么？**

   需要决定何时采集 Episode、Action 前和 Action 后的快照，以及 fingerprint 是否包含
   文件版本、权限、工具版本、进程状态和外部服务状态。还需要区分“环境变化导致经验
   不适用”和“经验本身被证明错误”。

### 9.7 Outcome、延迟验证与安全结果

 1. **Outcome 是否需要支持长期挂起的验证？**

   日常任务的正确性可能数小时或数月后才能确认。需要决定是否增加 `pending` 状态，
   或使用可追加验证记录的 Outcome 生命周期。长期未验证的 Outcome 能否支持 Experience
   晋升？

 1. **任务成功、安全成功、质量和成本是否分开记录？**

   例如一个动作完成了任务，但同时修改了未经授权的文件。需要决定是否拆分：

   ```text
   task_outcome
   safety_outcome
   quality_outcome
   cost_outcome
   ```

   Experience 的晋升需要所有维度通过，还是允许只依据其中一部分？

### 9.8 经验使用的因果归因与实验

 1. **如何证明 Experience 真正改变了 Agent 的行为？**

   是否记录以下运行时事件：

   ```text
   experience_considered
   experience_matched
   experience_rejected
   experience_selected
   skill_started
   skill_completed
   experience_contributed
   experience_contradicted
   ```

   “使用过经验”是否足以计为贡献，还是必须与无经验基线进行对照？正式实验是否至少
   比较 `无经验`、`Hint`、`Skill` 和 `Direct` 四种条件？

 1. **经验收益的主要评价指标是什么？**

   除任务成功率外，是否统一记录：首次成功时间、工具调用数、Token、延迟、误触发率、
   负迁移率、重复探索次数和环境变化后的恢复时间？哪些指标是 Experience 晋升的硬门槛？

### 9.9 可信度、注入与 Provenance

 1. **外部文本和工具输出的默认信任等级是什么？**

   WP、论文、网页、工具输出和历史 Event 是否一律只能产生 `Claim` 或候选数据，不能
   直接成为系统指令？`Provenance` 只表示来源，还是同时携带信任等级？

 1. **Experience 写入前需要哪些不可绕过的检查？**

   是否要求 schema 校验、来源完整、Oracle 证据、授权检查和敏感信息扫描全部通过？
   经验内容能否覆盖 ROM、安全策略、用户授权或 Tool Guard？

### 9.10 可重放、审计与隐私

 1. **为了可重放，一次 Episode 必须保存哪些运行环境信息？**

   是否保存以下摘要或哈希：

   ```text
   model_provider / model_version
   Pi commit / build_id
   prompt_digest
   ROM_digest / RAM_digest
   tool_schema_digest
   adapter_version
   oracle_version
   ```

   缺少其中一项时，Episode 是不能重放、只能审计，还是仍可作为部分证据？

 1. **原始事件、投影和敏感数据的保留边界是什么？**

   需要决定：

- 原始 JSONL 是否永不删除；
- 遗忘只作用于投影还是也允许删除脱敏后的 Artifact；
- 凭据、个人数据和外部项目数据如何脱敏；
- 多进程写入如何保证顺序和 hash chain；
- SQLite 损坏时如何从事件源重建；
- schema migration 如何保证旧事件仍可解释。

### 9.11 故障恢复与停止条件

 1. **Agent 在什么条件下必须停止、进入 explore 或请求人工？**

   需要为 `observe -> plan -> execute -> verify -> recover` 定义最大尝试次数、最大
   反思轮数、最大 Token、最大时间和重复动作上限。遇到 `unknown` 时，是重新观测、
   进入有限预算的 `explore`，还是直接暂停？

 1. **如何避免 Agent 因为反复质疑而不行动？**

   是否允许低风险动作在明确授权下直接执行？哪些风险等级必须等待 Experience、Skill
   或人工确认？同一条件下重复得到 `unknown` 时，何时停止继续验证？

### 9.12 规范模型的最终命名

 1. **内部规范模型是否采用六层链路？**

   当前对外使用：

   ```text
   Event -> Episode -> Outcome -> Experience
   ```

   另一种更细的内部模型是：

   ```text
   Event -> Episode -> Claim -> Verdict -> Rule -> Policy
   ```

   需要最终决定是否保留前者作为公共 API，同时将后者映射为：

   ```text
   Outcome = Verdict 的领域投影
   Experience = Rule 的长期规则投影
   Policy = Experience 的当前任务投影
   ```

   该命名决定会影响 Schema、Router、Compiler、SQLite projection 和后续 API，需在编码
   前固定。

## 10. Batch A 交付后仍需人决定的问题（26-10-12，尚未决策）

> 本节只记录 Batch A（effective board / 逐请求 RAM / 真实 Runtime 交接）落地后
> 暴露出的、需要人裁决的点。已实现的部分按下面“临时处理”运行，未改动的架构一律不动。

### 10.1 `environment.changed` 的 scope 粒度与判定来源

**背景**：Batch A 已实现“可信 `environment.changed` 把同 scope 的 Fact 标为 stale
（不删除）”。但当前只在事件的 `scope` 与 Fact 节点的 `scope` **精确相等**时才生效；
空 scope 不标记任何节点（fail-closed）。真实环境变更（内核、网络、依赖版本）的 scope
应该是什么粒度，尚未决定。

**选项**：

1. scope = `(task_category, environment)` 二元组；
2. scope = 显式 `environment_fingerprint`（可复现摘要）；
3. scope 为空表示“全局失效”，可标记所有 Fact 为 stale。

**建议**：采用 (1)+(2)：稳定作用域用二元组，可复现实验用 fingerprint；空 scope
保持 fail-closed，不自动全局失效，避免一条未标 scope 的事件清空全部已验证事实。

**临时处理**：Batch A 只做精确 scope 匹配；`llm` 来源的 `environment.changed` 一律
不生效；空 scope 不标记任何节点。

### 10.2 `Outcome.supersedes` 的 subject 判定是否纳入 scope

**背景**：Batch A 的 supersede 有效性判定使用 subject = `(criterion_id, expected,
task_id)`，scope/fingerprint 单独做 `scope_mismatch` 校验。是否需要把 scope 并入
subject（即 scope 不同直接视为不同 subject，而非单独的错误原因）尚未决定。

**选项**：

1. 保持现有分离（subject 与 scope 各自校验、各自给出原因）；
2. 把 scope 并入 subject，scope 不同等同 “不同命题”。

**建议**：保持 (1)。分离后审计能区分“命题变了”与“环境变了”，对 10.1 的决策更友好。

**临时处理**：维持现状，`invalid_supersedes` 分别产出 `subject_mismatch` /
`scope_mismatch`。

### 10.3 自动交接的执行归属（Host helper 是否接入 Pi host）

**背景**：Batch A 让 Observer 在 `agent_settled` 记录 `handoff_ready`，真正执行由薄
Host helper `memory/runtime/handoff-host.mjs` 的 `applyStagedHandoff` 调用真实
`runtime.newSession`。Pi 核心未改动（遵守边界）。是否把该 helper 接进 Pi 的
print/interactive host，尚未决定。

**选项**：

1. 维持薄 helper，由上层 host 在 settle 后显式调用（当前测试即如此）；
2. 在 Pi host 里内置一个 settle 后自动调用点；
3. 只保留手动 `/aegis switch`，不做自动。

**建议**：短期 (1)；自动交接属于“恢复策略”，应与 9.11 的停止/恢复条件一起决策，
不要单独在 host 里硬编码。

**临时处理**：Observer 只发 `handoff_ready` 信号，不自行 `newSession`；真实执行与
验证由 host/测试调用 helper 完成。

### 10.4 `request.projected` 的写入量与投影压缩

**背景**：Batch A 对**每个** provider 请求写一行 `request.projected`（含 RAM
digest、state version）。长会话下事件量会显著增长，是否需要采样或把投影单独归档，
尚未决定。

**选项**：

1. 全量写入（审计优先）；
2. 仅记录 digest 变化的请求；
3. 投影写入独立文件/表，不与主链混排。

**建议**：短期 (1)，因为 hash chain 的可重放性优先；(3) 属于 Batch C 的 projection
压缩议题。

**临时处理**：全量写入，但该事件不创建 board node、不 bump RuntimeState，因此不会
污染投影。

### 10.5 手动与自动交接的并发

**背景**：若 host 在 settle 后立即自动 `applyStagedHandoff`，同时用户执行
`/aegis switch`，两者可能竞争同一个 staged handoff 文件。

**选项**：

1. 依赖 `handoffAlreadyCompleted` 幂等 + rename 原子性（当前实现）；
2. 增加显式文件锁 / 单飞（single-flight）标志；
3. host 串行化两者（先手动后自动，或反之）。

**建议**：短期 (1)，并让 host 串行化 (3)；是否要独立锁留待真实并发证据出现再定，
不要提前引入锁复杂度。

**临时处理**：完成记录以“提交到事件日志的 `handoff.completed`（按 request_id 去重）”
为唯一真相；staged 文件 rename 为 `.applied.json` 只是辅助信号，失败也不假成功。

# 实际CTF测试

发现如下问题：1:RAM 会改变 system prompt 的缓存前置，极大的降低缓存命中
              2:RAM 信息不全，没有“哪个参数成功、哪个字段失败、返回了什么”
              3:在找到正确的路径之后还是会为了让 oracle 验证而去把其他的方向也进行验证，从而耗费大量的时间，整体时间额外的消耗大概在 50%
