# 结构化 RAM 与通用候选等待

本文说明 RAM v3 及通用工作控制接口；实际验证和已知限制记录在 `RAM_ABC_IMPLEMENTATION.md`。适用于文档、代码、数据处理及其他任务，不限定 CTF。普通 shell 命令和输出不做猜测性业务语义解析。

## 责任与数据

- Observer 从已提交事件机械收集工具输入、返回、transport 和引用，不调用模型总结，不读隐式推理。
- RAM 是当前 Episode 的 JSON 派生投影，不能直接写权威状态、选择路线、授予权限或认定成功。
- 模型用 `aegis_propose` 显式提交 Claim/Intent；提案保持未验证。独立 Oracle 和现有 authority 决定 Fact/Outcome。
- Runtime 的候选等待属于工作流控制。`waiting_external` 不属于 Outcome 状态，也不表示任务成功。
- 有效 Experience 继续走既有 Compiler/Router 门。候选结果与候选 Experience 是不同对象。

## RAM v3

`buildRamProjection` 返回 `text`、`data`、预算与各节统计；`text` 可以直接 JSON.parse，`buildRam` 保持返回文本。

| 字段 | 含义 |
| --- | --- |
| version / episode_id / state_revision | 投影格式、所属 Episode、已提交状态版本 |
| task | 总目标、当前请求、Task、状态、授权/预算摘要 |
| pending | 未完成、unknown、unresolved 行动责任 |
| workflow | 已提交工作控制的有界展示；不是新的权限来源 |
| sections.facts / refuted | 当前有效的独立判断 |
| sections.tools | 成对动作、实际参数和响应片段、transport；trust=observed |
| sections.proposals | 显式模型提案；trust=unverified；候选保留 when/do/expect |
| sections.knowledge | 有选择时出现：本地知识引用及来源/行号；未验证、无行动策略 |
| sections.artifacts / decisions | 一般产物与历史经验选择 |
| refs | 本快照的局部引用表；别名对应完整来源身份，不以短 ID 冒充原 ID |
| meta | 完整 JSON 字符数、字符预算、遗漏和核心 overflow |

普通工具观察没有 `business_status`、HTTP 状态推断或“已找到正确路线”字段。shell 输出中的 Login Success、BUILD SUCCEEDED、支付完成、测试通过等文本都保持原始数据；不能单靠它们改变控制或结果状态。

默认预算为 4,000 UTF-16 字符，计入全部 JSON/引用/元信息，不等同 provider token 数。候选选择保护任务与未决责任，优先保留类别覆盖、最近观察与被合法显式提案引用的较早观察，再用余量展开细节。无法容纳核心时明确 core overflow；实际请求仍受原有总输入 gate 约束。

文本片段先脱敏，再机械采样 head/middle/tail。偏移单位为脱敏文本的 UTF-16 code units；不声称是原始字节 offset。采样缺口与截断必须可见，不承诺任意稀疏信息都能落入片段。原工具结果仍正常进入当前 Session continuation。缺失输出为 null，不把 digest 宣称为可读全文引用。

注入仍是每请求一份临时 user 尾部 JSON，固定 system/ROM/tools 不随 RAM 更新，快照不累积进 Session 历史。没有更改为永久增量消息协议。

本地知识文件统一位于 ignored `knowledge/`；自动召回、LLM 自主选择工具、图板关联与调用时机见 [知识库运行接口](KNOWLEDGE_RUNTIME.md)。

## 显式提案

`aegis_propose` 的 source_refs 接受当前 Episode 的已提交 event/node/action 身份；引用只建立关联，不证明提案正确。foreign、future、缺失、摘要不符和失效引用被拒绝。

可选 `replace_event_id` 只能替换当前 Episode 中已被接受且仍有效的模型 Hint/Intent，不能替换 Fact/Outcome。原事件保留，当前视图退出旧提案。普通助手正文不会自动调用这个接口或形成提案节点。

## 可信任务契约

交互运行可通过 `AEGIS_TASK_CONTRACT_FILE` 指定本地 JSON。字段由人类/Host 配置，不能来自模型提案。首次进入 Episode 时绑定已提交事件；恢复不能借可变文件扩大策略。Campaign 使用当前被接受任务定义中的目标与 criteria，并保留其原有计费、授权和请求结清门。

通用配置示例：

```json
{
  "target_ref": "report.md",
  "criteria": ["report reviewed"],
  "allowed_tools": ["read", "write", "edit", "bash"],
  "max_tool_calls": 40,
  "max_identical_calls": 2,
  "wall_time_ms": 600000
}
```

次数是示例，必须按任务配置，不是全局固定“两次”。计数按真实工具调用和完整参数摘要进行；不能从任意 shell 脚本中可靠得知其内部请求数量或识别“爆破”。要求严格动作/请求级约束的场景应使用已有注册工具/适配器与授权门。未配置契约时不臆造目标或阈值，候选提交明确拒绝 unconfigured。

## 候选提交与等待

模型显式调用：

```json
{
  "target_ref": "report.md",
  "criterion_id": "report reviewed",
  "evidence_event_ids": ["实际已提交的当前 Episode 动作结果事件 ID"]
}
```

工具名为 `aegis_submit_candidate`。Runtime 解析真实成对动作结果，核对目标/criterion/当前身份，确认持久化后进入 waiting_external。它提交的是引用所指结果的待验收候选，不验证其业务正确性；不扫描输出文本或答案格式。重复同候选不会二次改变状态；被复核过的相同候选不能靠新 ID 自动重新提交。

等待期间阻止新的探索与 Broker 效果，重启不解除等待，也不自动重发旧动作。模型同批其他工具结果按真实已发生效果保留，不能回滚已发生副作用或假称完全未执行。任何允许的最小验证都必须来自可信契约中的明确只读工具及完整参数绑定，不能把自由 bash 当作可证明只读的工具。

交互命令：

- `/aegis work-status`：查看有界的工作控制状态。
- `/aegis work-verify {"tool_name":"read","args":{"path":"report.md"}}`：交互模式中，不调用模型，只执行契约精确登记的只读验证；仍保持等待。
- `/aegis work-resume <原因>`：用户显式要求继续。
- `/aegis work-reject <原因>`：用户否定该候选后继续。

`work-verify` 只支持已登记的本地 read 参数与 workspace 内真实路径，并记录真实 intent/result；Campaign 命令没有 provider-request 绑定的工具计费上下文，因此该命令在 Campaign 中明确返回 unsupported，不另开绕过原 ledger 的执行通道。Campaign 的 Host CLI `resume` 可以显式恢复候选等待，继续原任务；原队列与本次工作流状态分别展示。

新建 Campaign 运行使用既有 durable tool-charge 协议，候选工具也必须完成原 request 结清、charge 与 finish。旧 legacy 账本的执行恢复明确返回 `migration_required`，保留历史消费和只读 status；本轮不自动迁移或改写旧事件。

恢复保留原预算消费、未决责任和事件来源。pending/unknown 副作用或未结清请求/工具先核对，不能用恢复命令重发。平台/人类认可的最终 Outcome 仍走现有独立结果录入，不由 resume 生成。
