# vendor/ —— 我们的 pi 修改版

## 这是什么

`vendor/pi/` 是 [pi](../../../pi)（`earendil-works/pi` monorepo）的**浅克隆分支**，
用来把 Aegis 的 Observer 以**原生扩展**的形式装进去。

它有自己的 `.git`，在 Aegis 的 `.gitignore` 里（`vendor/pi/`）—— 原因见下面「为什么不做成 patch」。

```bash
# 重建（约 33M，浅克隆，不需要 node_modules 就能读源码）
git clone --depth 1 file://$HOME/My_github/pi vendor/pi

# 要构建/类型检查时（281M）
cd vendor/pi && npm install --ignore-scripts
```

## 构建（跑起来要用它）

启动器 `scripts/aegis-pi.sh` **优先用构建产物**，没有才回落到 tsx 源码。原因是实测差距很大：

| 路径 | 启动 (`--help`) |
|---|---|
| 构建产物 `dist/bundle/cli.js`（`node` 直接跑） | **0.33–0.73s** |
| 源码（tsx 实时转译整个 monorepo） | **1.70–1.79s** |

tsx 每次启动都要转译，TUI 的卡顿主要来自这里。构建一次：

```bash
cd vendor/pi
npm run build:offline      # 约几分钟；用 offline 变体避开联网的模型数据生成
```

产出的入口是 `packages/coding-agent/dist/bundle/cli.js`（也就是 `package.json` 里的
`bin.pi`）。**注意它是分块的**：`cli.js` 本身搜不到 `aegis-observer`，要连 `dist/bundle/chunks/`
一起搜 —— 只搜 `cli.js` 会得到假阴性，然后误以为构建没带上 Observer。

启动器因此带一个**陈旧构建守卫**：构建产物里找不到 observer 就拒绝启动，并提示要么重建、
要么 `AEGIS_PI_SOURCE=1` 走源码。**宁可拒绝启动，也不要静默跑一个没有 Observer 的 pi** ——
那会让整条记忆链收到 0 个事件，而结果看起来像「经验没用」。

`dist/` 在 fork 里是 gitignore 的，所以构建产物不进版本库。

## 怎么验证改动

pi 的 AGENTS.md 要求改完跑 `npm run check`。整仓 check 很慢，实测**够用的最小集**是：

```bash
cd vendor/pi
node_modules/.bin/biome check packages/coding-agent/src/extensions/observer/index.ts \
                             packages/coding-agent/src/extensions/index.ts
node_modules/.bin/tsgo --noEmit -p packages/coding-agent/tsconfig.build.json
```

两个都干净。省钱办法：把主仓的 `node_modules` 软链过来即可，不必真装 281M ——
注意 `node_modules/` 这条 gitignore 规则**不匹配符号链接**，链完 `git status` 会看到
`?? node_modules`。

**但软链不要删**：启动器依赖它提供运行时依赖和构建工具（`tsgo` / `shx` / `biome`）。
之前这里写着「验证完记得删掉」，构建之后就作废了。

## 为什么要 fork 而不是用外部扩展

Observer 需要三样东西，外部日志解析都拿不到：

1. **看得全** —— `tool_call` / `tool_result` / turn / agent 每个缝都能挂，
   而且能在调用**执行前**拒绝它。会话文件只记录已经发生的事。
2. **自己的事件格式** —— 解析 pi 的会话 JSONL 等于依赖一个带 migration 的内部格式。
   上一轮"世界模型解析反了"就是这么来的。Observer 现在写**我们自己拥有的** schema。
3. **调试信息** —— 时长、拒绝原因、增量，会话文件里没有。

## 我们改了什么

只加了一个文件，改了一个文件：

| 文件 | 改动 |
|---|---|
| `packages/coding-agent/src/extensions/observer/index.ts` | **新增**：Observer 扩展 |
| `packages/coding-agent/src/extensions/index.ts` | 注册为内置扩展（`aegis-observer`，常开） |

上游代码没有其它改动。升级时只需要重新 clone，再把这两处接回去。

## Observer 做什么

职责划分是刻意的：

```
Observer（这里，TypeScript）  = 眼睛和手。抓事件、维护公共黑板、拒绝坏调用。
记忆 / 经验（Python）          = 对事件流做算术。
```

三条硬约束：

1. **Observer 是黑板的唯一写入者。** Agent 只能"提议"（声明任务、认领、报告、
   下判决），写入必须经过 Observer。所以被观察的东西改不了黑板。
2. **事件落到两个地方**：每会话一个 JSONL（`<state>/observer/events-<id>.jsonl`，
   Python 侧消费），外加一条 `appendEntry` 进会话日志（给人看）。
   自定义 entry **不进模型上下文** —— 这是记录，不是提示词。
3. **版本不匹配就报错**，不猜。`EVENT_SCHEMA` / `BOARD_SCHEMA` 各自带版本号。

## 任务协议（父/子 agent）

阶段会被拆成很多子任务，子 agent 之间**只能靠黑板通信**。协议：

```
need     用户写需求（external，不由生产者写）
declare  父 agent 把阶段拆成任务（可带 parent）
claim    子 agent 认领
report   子 agent 回报结果与信息
verdict  父 agent 下判决：ok / reason
```

**父亲判断成功的依据是「黑板上的用户需求或阶段任务是否被满足」**，
不是"工具退出码是不是 0"。`verdict` 必须指名它判的是哪个任务，这样判决可追溯。

## 状态文件

| 路径 | 内容 |
|---|---|
| `<state>/blackboard.json` | 公共黑板（原子写：tmp + rename；损坏则改名保留） |
| `<state>/observer/events-<session>.jsonl` | 事件流，一行一个事件 |

`<state>` = `$AEGIS_STATE_DIR`，否则 `<cwd>/.aegis`。

## 命令

```
/aegis-observer        看黑板摘要 + 事件流位置
aegis_board(action=...)  agent 用的黑板工具
```
