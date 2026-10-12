# Aegis 比赛前数据质量审计

状态：比赛前复核清单。此文档只记录问题与验证要求，不把提示/卡片当真实 Experience。

## 已通过（2026-10-11 00:05）

- `Pi_Agent_base/contest/run.sh` 已从源代码启动 Pi，显式 `relay/deepseek-v4.1-flash`，在普通路径持久化 session；默认 off。
- 离线 `contest-smoke.mjs`、`contest-pipeline-smoke.mjs` 通过。
- `aegis-contest-pi-integration.mjs` 通过：真实 Pi SDK+faux provider 的模型请求中只有 hint 组有提示，之后 off 能删除提示；contest MetaLog 写失败时不向全新请求注入提示。
- 成功/失败的人工/平台结果必须附非敏感证据引用；日报从扩展元数据而不是猜测会话 JSONL 计算工具次数，Pi session 仅交叉核对。

## 上赛场前仍需解决的 P0

1. **隐私与工作目录**：目前 session 和 runtime/contest 目录为 `0755`，既有 Pi JSONL 文件可能为 `0644`；会话可能含 flag、题目文件和工具输出。比赛启动入口必须设置 `umask 077`、创建专属 0700 私有目录，并检查/拒绝或清楚警告既有不安全权限；不要把 Aegis 仓库根目录直接当比赛工作目录。运行 cwd 应当是用户明确提供的外部题目工作目录，并拒绝包含 `Pi_Agent_base/config` 的仓库根目录。注意 `cwd` 不是 OS 沙箱，外部高风险题目宜在容器/低权限账户中运行。
2. **失败后旧提示未移除**：当前 `before_agent_start` 写 decision 日志失败时直接 return，若先前在同一会话注入过 `aegis_hints`，下一请求可能仍携带旧 section。即使元数据日志失败，必须删除旧 `aegis_hints`，stderr/通知人类该会话 A/B 数据失效；负测应覆盖“先成功注入、再日志失败”的同会话链路。
3. **竞赛组别不能由结果记录改写**：`daily.mjs` 对报告行使用 `result.group ?? session.modes`；手填结果可以把真实 off/hint 改组，也把同题多个 session 的结果传播给所有 session。必须以启动/注入 metadata 为实际组别，手填的 group/card 只用于对照核验，不一致显示 `group_mismatch`/`card_mismatch`，题目多个会话/补录结果明确输出 `unknown` 或单独行，不把一个结果复制成两个独立成功。按任务统计 unique task_id，另报 session 数。
4. **每日复盘的行动证据**：至少提供每任务的第一次工具调用（工具名、相对时间、错误标记）、按实验组拆分的调用次数和结果来源，保留每次注入的卡 id/revision 与是否手动选中；判断“有没有改变首次决策”需要人工复核，不可由模型自述推导。无法取得 token/耗时时标缺失，不得填零装作真实指标。
5. **命中卡的可信性**：`parseCard` 容许 `verified` 但 `source_refs=[]`，而 `observations` 来自可随意输入的 env 字符串；文档必须解释“外部人工确认的标签”与由工具检验的观测不同。没有经过本题核对的卡不能暗示就是 Outcome/active Experience；样例卡不允许当正式赛前规则。最好把卡文件 digest/修订写入决策元数据，以便赛后重放当时可见的信息。
6. **固定实验条件**：源代码 launcher 仅拦了部分长参数，短别名（如 `-ne`, `-e`, `-nt`, `-t`）、`--` 之后的 Pi 选项及环境变量 `PI_*` 均可改变资源/工具/模型；为了比赛数据可解释，应采用显式 allowlist（或不透传 Pi 选项，只允许任务消息路径），并对两组采用完全一样的 `--no-context-files` / `--no-approve` / `--no-mcp` / 工具集。不要为了比较牺牲真实解题所需的 read/bash/edit/write。
7. **原 Observer 是尽力记录**：`aegis-observer.ts` 仍会吞事件写失败，重启后 digest 链未续。Pi 会话 JSONL 可供人工审计，但不可宣称 Observer 的事件链/动作持久化已经可靠。比赛首日可以先固定“Pi JSONL + contest metadata + 人工结果”三种源，Observer 数据留作辅助；赛后先列出记录丢失比例，再决定是否修这个旧原型。

## 当日复盘必须回答的五个问题

1. 今天有哪些题是 off、有哪几题是 hint？每题提示卡的来源、当前前提和注入证据是什么？有没有无意中切换组？
2. 第一次关键动作是否因提示而改变？有多少次多余探索/重复错误；反例何处表明提示失效？如不能判断，标注 unknown。
3. 平台/人工是否独立确认成功或失败？何处只有模型自述？结果冲突、缺失和无证据的记录有多少？
4. 采集链是否可靠（提示日志缺行、Pi session 缺失、observer 链断裂、调用/结果未配对、保密权限）？不可靠的题剔除对照，但保留错误用于修系统。
5. 明天最小要改的一条机制是什么？是匹配、证据、环境判断、行动接口还是模型理解？每条调整引用具体 task_id，先写候选，先验不自动升级。
