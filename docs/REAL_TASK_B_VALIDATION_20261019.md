# 真实任务 B 路径验证（2026-10-19）

状态：**B 路径（真实工具 + 独立判定 + Outcome 入账）已在本机真实 provider 上跑通；5 个真实任务尝试均未解出，唯一成功的是 1 个明确标注的链路控制任务。** 本文记录实际运行、发现和它对 A 路径的约束，不宣称模型能力或学习效果。

## 1. 目的与范围

用户同意“先用 B 验证，再处理 A”：保留真实工具面（Observer + 本地 Python CLI），把独立判定写成 committed Outcome，让 Board/RAM/学习消费同一事件日志；用它暴露真实任务下的问题，再决定 Campaign（A）需要补什么。

本轮使用公开 DUCTF 题目，固定仓库与 commit；题目包、运行产物和答案只放在仓库外私有目录：

```text
~/Tmp/aegis-real-20261019/
  tasks/<id>/{handout,evaluation,provenance.json,README.md}
  tasks/<id>/runs/<attempt>/...
  RESULTS.json
```

`evaluation/expected.bin` 权限 600；`handout/` 已扫描确认不含答案（控制任务除外，见下）。

## 2. 任务包

| 任务 | 类别 / 难度 | 固定来源 | 角色 |
| --- | --- | --- | --- |
| `ductf-2023-apbq-rsa-i` | crypto / easy | `Challenges_2023_Public@b48f83d` | 校准（公开题，10-17 已解过一次，存在记忆污染） |
| `ductf-2024-pressing-buttons` | rev / medium | `Challenges_2024_Public@f2797a3` | 主任务（IPA 静态分析，Python 可解） |
| `ductf-2024-aes` | crypto / hard | `Challenges_2024_Public@f2797a3` | 主任务（`cbkap.sage` + `output.sage`） |
| `ductf-2024-my-array-generator` | crypto / easy | `Challenges_2024_Public@f2797a3` | **chain-control**：公开 handout 自带 key，只用于验证 success → Outcome → Fact，不算能力证据 |

每个任务包记录 `repository/commit/source_path/字节数/sha256/expected_sha256`，`handout/` 与 `evaluation/` 分离。

## 3. 运行方式与预算

- 模型：`relay/deepseek-v4.1-flash`（真实 provider，`~/.Aegis/agent` 只读凭据）。
- 工具：`cli`（Python 3 标准库，工作区内，20 秒/次，禁 subprocess/网络/外部路径）、`aegis_propose`、`aegis_knowledge`。
- 每次尝试独立 workspace / EventLog / RAM / Session；`AEGIS_TASK_ID` 绑定题目 id（跨 attempt 稳定），attempt id 只命名运行目录。
- 预算：6–14 模型请求、120–330 秒；输出上限 8192（模型支持 16384）。
- 判定：`candidate.txt` 或最终 assistant 文本与私有 expected flag 逐字节相等；不相等不产生 Fact。

## 4. 结果（7 次完成 + 1 次 harness 崩溃）

| 任务 | 角色 | 请求 | 工具 | 停止 | 判定 | Outcome | Board Fact |
| --- | --- | ---: | ---: | --- | --- | --- | ---: |
| apbq-rsa-i a1 | 校准 | 2 | 1 | settled | 未解出 | unknown | 0 |
| apbq-rsa-i a2 | 校准 | 4 | 4 | output_limit | 未解出 | unknown | 0 |
| pressing-buttons a1 | 主任务 | 10 | 10 | settled（wall 边界，已修） | 未解出 | unknown | 0 |
| pressing-buttons a2 | 主任务 | 14 | 16 | budget | 未解出 | unknown | 0 |
| aes a1 | 主任务 | 6 | 5 | output_limit | 未解出 | unknown | 0 |
| my-array-generator ctrl-a2 | 控制 | 1 | 1 | independent_exact_flag | 成功 | success | 1 |
| my-array-generator ctrl-a3 | 控制 | 1 | 1 | independent_exact_flag | 成功 | success | 1 |
| my-array-generator ctrl-a1 | 控制 | 1 | 1 | （崩溃，未写 result） | 成功 | 未写入 | — |

合计 39 次真实模型请求、约 46 万总 token、约 11 分钟模型墙钟。真实任务尝试 5 次，成功 0 次；控制任务 3 次，成功 3 次。

控制任务的成功路径已核对：事件日志中有 1 条 `outcome.recorded`，source=`oracle`、independent=true、2 个 evidence ref、criterion/observed 完整；Board 从 0 个 Fact 变为 1 个 Fact。未解出的尝试只产生 Hint，不产生 Fact/Refuted。

## 5. 本轮对 harness 的修改

`Pi_Agent_base/fixtures/ctf-board-pilot.mjs`：

1. **Outcome 入账**：独立判定后通过 `appendContestOutcome` 写入同一 committed EventLog；成功记 success，未解出记 unknown（预算/超时/provider 故障不证明题目不可解）；Evidence 只含 digest 和匹配来源。
2. **题目绑定稳定**：`AEGIS_TASK_ID` 改用题目 id（`AEGIS_ATTEMPT_ID` 单独记录），跨 attempt 的 Board/RAM 可按同一任务聚合。
3. **停止分类**：`length` → `output_limit`；`settled` 但已耗尽墙钟 → `wall_time`（消除边界竞态）；provider 错误单独标识。
4. **成功读取安全化**：匹配可能来自 assistant 文本，`candidate.txt` 不存在时不再崩溃（该 bug 由 ctrl-a1 暴露）；criterion 明确“candidate.txt 或最终 assistant 文本”。
5. **输出上限可配**：默认 8192，可用 `AEGIS_PILOT_MAX_OUTPUT` 覆盖；provider/model 可用 `AEGIS_PILOT_PROVIDER`/`AEGIS_PILOT_MODEL` 指定。

新增 `Pi_Agent_base/tests/aegis-ctf-pilot-outcome.mjs`（5 例）：assistant/file 匹配来源、unknown 不是 failure、wall/output/provider 停止原因、Outcome 不携带 flag。`aegis-ctf-pilot-cli`、`aegis-ctf-board-report`、`aegis-module-layout` 均通过。

## 6. 真实任务暴露的问题

1. **输出上限是主要停止原因**：3/7 次 `output_limit`；high thinking 下模型把 8192 全部用于推理，正文为空。需要把 `max_output_tokens`/thinking 级别写进冻结运行配置，而不是 harness 常量。
2. **CLI 20 秒上限挡住重计算**：RSA i 尝试做纯 Python 格/LLL 计算时超时；这是工具能力边界，不是模型错误。
3. **墙钟停止的边界竞态**（已修）：180.1 秒的尝试曾被记成 `settled`。
4. **成功路径的隐含假设**（已修）：模型可能只在正文给出 flag，不写 `candidate.txt`。
5. **费用不可核对**：usage token 有记录，但 relay 的 cost 恒为 0；预算账本不能等于账单，必须记 `unknown` 或接后端 usage。
6. **公开题污染**：apbq-rsa-i 在 10-17 已解过；控制任务自带答案。真实任务成功率为 0 不能解释为模型不会做题，也不能用控制任务冒充能力证据。
7. **B 没有请求/工具账本**：本轮只证明“真实工具 + 独立判定 + Board/RAM”闭环；请求计费、工具幂等、预算守恒仍是 A 的职责。

## 7. 对 A 路径的结论

B 已经能产出可信的真实任务证据，这些证据对 A 的直接约束：

1. **任务包原语**：A 需要同样的 `handout / evaluation(checker) / provenance / attempt` 结构，并冻结题目、初始状态、预算和停止条件。
2. **Oracle 注册**：flag 精确比对要成为可注册的 Oracle 适配器（如 `ctf.flag-exact.v1`），证据 ref 指向 attempt artifact；不能让模型自带 checker。
3. **动作能力**：B 的 Python CLI 已足够覆盖 crypto/rev 的静态分析，但不能运行二进制或做长计算。A 的第一个任务族应先复用“Python CLI + 工作区读写”这一受审动作，而不是直接开放通用 shell。
4. **停止与计量语义**：`output_limit / wall_time / budget / provider_error / settled` 必须进入 Campaign 的请求账本和 Outcome failure_mode；`max_output_tokens` 与 thinking 级别属于冻结配置。
5. **结果导入产品化**：B 目前靠 harness 在运行后追加 Outcome；A 应把“独立判定 → Outcome”做成产品路径，而不是 fixture 专属。
6. **成本字段**：Campaign 账本记的是字符/请求，不是钱；真实实验前要决定接后端 usage 还是统一 `unknown`。
7. **一条真实任务的迁移顺序**：建议把 `pressing-buttons`（已证明模型能推进到置换表解析）作为第一个搬进 Campaign 的任务；它不需要 shell，只需 Python CLI 动作 + flag Oracle，能直接检验 A 的账本、许可和恢复是否在真实任务上成立。

## 8. 不宣称

- 不宣称模型在真实 CTF 上的能力或成功率（5 次尝试全部未解出，且题目公开、存在记忆污染）。
- 不宣称学习/经验复用有效果（本轮没有 active Experience，也没有编译/路由对照）。
- 不宣称 B 的证据等于 Campaign 证据（没有请求/工具账本、没有自动轮换、没有预算守恒验证）。
- 不宣称控制任务的 3 次成功是能力证据：它的 handout 自带答案，只用于验证链路。

## 9. 证据位置

- 私有运行根：`~/Tmp/aegis-real-20261019/`（题目包、attempt 日志、`RESULTS.json`、本报告的数据来源）。
- 汇总：`RESULTS.json`；逐 attempt：`tasks/<id>/runs/<attempt>/{result.json,events.jsonl,requests.json,operations.json,assistant.json}`。
- 仓库内可复核代码：`Pi_Agent_base/fixtures/ctf-board-pilot.mjs`、`Pi_Agent_base/tests/aegis-ctf-pilot-outcome.mjs`。
