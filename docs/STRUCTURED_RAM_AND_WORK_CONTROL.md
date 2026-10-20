# 结构化 RAM 与通用候选等待

本文说明 RAM v4 working-set（寄存器视图）及通用工作控制接口；实际验证和已知限制记录在 `RAM_ABC_IMPLEMENTATION.md`。适用于文档、代码、数据处理及其他任务，不限定 CTF。普通 shell 命令和输出不做猜测性业务语义解析。

## 责任与数据

- Observer 从已提交事件机械收集工具输入、返回、transport 和引用，不调用模型总结，不读隐式推理。
- RAM 是当前 Episode 的 JSON 派生投影，不能直接写权威状态、选择路线、授予权限或认定成功。每个 turn 结束时 Observer 会写入一个有界 `runtime.note kind=round.checkpoint` Artifact；它保存本轮模型摘要/工具观察并明确标记为未验证。Board/EventLog 保留历史，RAM 只带本轮任务/子目标、规则、当前事实与相关 claim、知识参考、未决责任和最近少量工具观察。
- 模型用 `aegis_propose` 显式提交 Claim/Intent；提案保持未验证。独立 Oracle 和现有 authority 决定 Fact/Outcome。
- Runtime 的候选等待属于工作流控制。`waiting_external` 不属于 Outcome 状态，也不表示任务成功。
- 有效 Experience 继续走既有 Compiler/Router 门。候选结果与候选 Experience 是不同对象。

## RAM v4 working set（寄存器视图）

`buildRamProjection` 返回 `text`、`data`、预算、`sections` 统计和 `registers` 摘要；`text` 可以直接 JSON.parse，`data` 与 `text` 同源，`buildRam` 保持返回文本。模型看到的是按本轮子目标选择的小寄存器；Board/EventLog 仍是唯一权威历史和详情来源。

| 字段 | 含义 |
| --- | --- |
| version / episode_id / state_revision | 投影格式、所属 Episode、已提交状态版本 |
| task | **总目标 `total_goal` 始终在场**；可选 `subgoal`（最新有效 Intent，含 text/scope/ref）、Task、状态、授权/预算摘要 |
| legend | 固定的信任类别说明，防止 facts/claims/references/rules 混淆 |
| rules | 规则寄存器：工具纪律/active Experience（宪法/ROM 始终在 system 前缀，不重复注入）；`trust=rule`、`not_authorization=true`，只能来自规则来源，不能由 Claim/Reference 升级 |
| facts | 当前目标相关的有效 Fact/Refuted 工作集，`trust=verified`；Fact 与 Refuted 各自按目标相关性/新近性排序后交错选择，共享最多 6 条；保留 criterion/observed/evidence 身份，未选项留在 Board 并计入 omitted |
| claims | 与当前子目标相关的最新 1–3 条模型 Claim/Intent，`trust=unverified`、`scope` 与子目标一致；不按时间衰减，子目标切换后旧 claim 退出 |
| references | 知识卡（最多 4 张，支持综合/跨方向考点）与外部 seed；`verified=false`、`action_policy=none`；不等于事实或规则 |
| recent / referenced | 最近一次工具观察（actual input/response/transport）与合法提案显式引用的较早观察；`trust=observed` |
| artifacts / checkpoints / decisions | 一般产物、**最近一条** round checkpoint、最近经验选择；均非 Fact/规则；旧 checkpoint 留在 EventLog，不进入当前寄存器 |
| pending | 未完成、unknown、unresolved 行动责任 |
| sections | 兼容视图：仅 `total/shown/omitted` 统计；完整旧节内容不再重复进入模型 JSON，详情仍在 EventLog/Board |
| refs | 本快照的引用表；Episode 级稳定别名对应完整来源身份（可引用，不是短 ID 冒充原 ID）；`request.projected` 记录 alias epoch/count |
| meta | 完整 JSON 字符数、字符预算、遗漏、register/budget drops 与核心 overflow |

`refs` 的别名由 Observer 在当前进程内按 Episode 维护稳定注册表：同一 canonical node/event/action 在后续请求中保持同一 `rN`，不会因选择顺序变化而改指向；`source_refs` 同时接受裸别名和 `{ref_type, ref_id:"rN"}`，但别名只建立未验证关联，不授予事实或执行权。`request.projected` 和 proposal 拒绝记录 `ram_alias_epoch/count`，用于判断工具执行时使用的别名快照。别名不是 Proof，也不能替代 canonical event ID。

子目标由模型驱动：当路径变化时，模型调用现有 `aegis_propose kind=intent` 并用 `scope` 指定短标签；RAM 取最新有效非 action Intent 作为 `task.subgoal`，只展示同一 scope 的 claims。总目标始终在 `task.total_goal`，不因切换子目标而丢失。模型应在该子目标的 claim 上使用相同 scope；没有匹配 scope 时不把他目标 claim 当作当前指导。

判断选择是一个小型工作集，不是 Board 的事实副本：Fact 与 Refuted 分别按总目标、当前请求和当前子目标的词项相关性排序，同分时优先较新节点，再交错选择，共享最多 6 条。超出条数上限或字符预算的判断仍保留在 Board；RAM 的 `meta.omitted.facts` 和 `sections.facts/refuted` 明确报告未展示数量。预算不足时先缩短文案，再按既有可丢弃顺序压缩。知识卡不限制为一张，RAM 最多带 4 张当前选择，模型可用 `aegis_knowledge` 继续细化。压缩不使用 LLM 总结，不猜测业务成功。

默认预算为 8,000 UTF-16 字符，计入完整 JSON/引用/元信息，不等同 provider token 数。所有内容仍是 RuntimeState 的有限投影：不能直接写权威状态、选择路线、授予权限或认定成功。无法容纳核心时明确 core overflow；实际请求仍受原有总输入 gate 约束。

文本片段先脱敏，再机械采样 head/middle/tail。偏移单位为脱敏文本的 UTF-16 code units；不声称是原始字节 offset。采样缺口与截断必须可见，不承诺任意稀疏信息都能落入片段。原工具结果仍正常进入当前 Session continuation。缺失输出为 null，不把 digest 宣称为可读全文引用。对任何窗口化/分段读取，模型必须使用重叠窗口或已知长度并核对重建值，不能凭记忆补/丢边界字符（ROM 规则 7）。

注入仍是每请求一份临时 user 尾部 JSON，固定 system/ROM/tools 不随 RAM 更新，快照不累积进 Session 历史。没有更改为永久增量消息协议。`request.projected` 同时记录 `ram_sections` 统计和 `ram_registers`（子目标、各寄存器数量与 omission），供日志分析；UI 可后续读取同一投影，不需要第二套状态。

本地知识文件统一位于 ignored `knowledge/`；自动召回、LLM 自主选择工具、图板关联与调用时机见 [知识库运行接口](KNOWLEDGE_RUNTIME.md)。轮次 checkpoint 与 RAM 历史压缩的接线见 [图板/seed 先导结果](BOARD_SEED_CTF_PILOT_RESULT.md)。

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

- `/aegis autoRemote`：两步登录 bootstrap。第一次接收平台 URL 并打开专用 Firefox 登录页；人类手动登录后再次执行该命令，从专用 Firefox profile 读取 cookie 到当前进程内存，附着受控 HTTP client。不接收/保存账号密码或 cookie 原文；`aegis_remote_request` 仅开放平台 GET API，Cookie 由本地 broker 注入且不返回模型；`POST`/flag 提交仍由后续 adapter/checker 所有。
- `/aegis checkFlag`：人类显式确认当前打开任务的 flag 正确；不接收/保存 flag 值，使用现有 `resultToOutcome` human source 记录 Outcome，重复执行幂等；要求 open episode 和健康审计。
- `/aegis work-status`：查看有界的工作控制状态。
- `/aegis work-verify {"tool_name":"read","args":{"path":"report.md"}}`：交互模式中，不调用模型，只执行契约精确登记的只读验证；仍保持等待。
- `/aegis work-resume <原因>`：用户显式要求继续。
- `/aegis work-reject <原因>`：用户否定该候选后继续。

`work-verify` 只支持已登记的本地 read 参数与 workspace 内真实路径，并记录真实 intent/result；Campaign 命令没有 provider-request 绑定的工具计费上下文，因此该命令在 Campaign 中明确返回 unsupported，不另开绕过原 ledger 的执行通道。Campaign 的 Host CLI `resume` 可以显式恢复候选等待，继续原任务；原队列与本次工作流状态分别展示。

新建 Campaign 运行使用既有 durable tool-charge 协议，候选工具也必须完成原 request 结清、charge 与 finish。旧 legacy 账本的执行恢复明确返回 `migration_required`，保留历史消费和只读 status；本轮不自动迁移或改写旧事件。

恢复保留原预算消费、未决责任和事件来源。pending/unknown 副作用或未结清请求/工具先核对，不能用恢复命令重发。平台/人类认可的最终 Outcome 仍走现有独立结果录入，不由 resume 生成。`/aegis checkFlag` 是其中的人类确认入口：它只表达“人已确认正确”，不解析自然语言、不接收 flag 值，仍经过现有 human Outcome 门。
