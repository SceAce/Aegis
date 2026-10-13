# C4a 限定审查与本轮修复

状态：**accepted_with_recorded_limits（冻结范围内）**。
基线 `2296e27`，分支 `feat/c4a-observation`，开始工作树干净。
本轮沿用用户审查/补测/直接修复授权，当前会话同时做修复与检查，不伪造第二团队验收。
不重开 C1-C4、F16、类型清库、界面样式或性能门槛。

## 实际发现与修复

原四个 HTTP/XSS/command/SDK suite 独立通过。新增 8 个冻结范围反例在旧代码全部失败：

| 项目 | 原问题 | 修复 |
| --- | --- | --- |
| lifecycle 显示 | HTML 表格从 evidence task 读不存在的 lifecycle 字段，completed 列空白 | 按 Task ID 合并同源 lifecycle 投影，明确显示 evidence 和 lifecycle |
| 半行日志 | parseJsonl 丢掉 malformed 尾行，生成有效前缀的 success，再标 integrity=false | HTTP/命令在 parse/chain 失败时生成 unavailable/integrity_failure，无实时成功数据 |
| 动作信任 | action 列表接纳 LLM completion，和 C4 可信计数不一致 | 列表仅取 runtime/oracle/human，坏链不提取动作 |
| 字节界限 | formatted JSON 超过 compact JSON 预检；HTML 没有限制 | JSON 按实际格式化 UTF-8 bytes，HTML 同一上限，超限返回明确有界提示 |
| page_size | query 能绕过 Host max_tasks（仍低于 max_page_size） | page limit 同时受 max_tasks/max_page_size 约束 |
| 动态任务 | proposals 只有 ID/digest，看不到 blocked 状态、父链与原因 | 由提交记录补父任务/拟议任务，由可信决定事件显示 admitted/blocked/rejected reason |
| 可用预算 | remaining 不含 committed outstanding reservations | C4 投影传递 reserved，观察端扣除 limit-used-reserved |
| loopback | 配置允许 host=0.0.0.0，突破本阶段单机观察范围 | 明确拒绝非 loopback；IPv6 URL 正确括号 |

页面现在同时显示预算/Session、动态提案、动作、Outcome、更新时间与 committed offset，
复用已脱敏 view，所有自由文本经 HTML escaping。HTTP 无写路由，不读 query 指定任意文件。
去掉未返回的 current cache 状态，不声称“提供最后好快照”；坏源显示 unavailable。
healthz 区分 listener 活着与 source integrity 是否可用。

## 验证

- 新 `aegis-c4a-external-boundaries.mjs` **8/8 node:test 用例通过**（实际 HTTP、真实 EventLog）。
- 原 HTTP 10、XSS 4、command 4 用例通过；原真实 SDK/faux command suite 全部检查通过。
  原报告“22 cases”不能等同 22 个 Node tests；统计层级分开，以实际日志为准。
- C4 export/rebuild/privacy/validator/external-boundaries、C3 fixture/workspace/external-boundaries、
  Observer outcome/verify-first 受影响回归 exit 0。
- Biome 修改范围 exit 0。Campaign tsc exit 1，仍 65 个旧 import 诊断，修改文件无诊断。
- 日志/逐命令 argv/exit：ignored `Pi_Agent_base/runtime/dev/c4a-external/`，baseline.json、red.log、
  results.json。没有真实模型/外部网络/目标调用；HTTP 为 loopback，本地效果为临时 fixture。
- 未重新执行 DS mutation，不把其历史证据当本次独立复跑；红绿行为反例已证明当前修复。

## 限制与移交

loopback 不隔离本地恶意进程，不能声称 OS sandbox。服务按请求全量重建视图，F16 后置。
HTML/JSON 超过限制明确降级，不提供无限分页/虚拟滚动；UI 美化与通用远程共享均后置。
错误边界不返回原始 exception/path 内容；已配置 optional metadata 仍为可信 Host 输入，
不把它当任意文件系统浏览器。摘要打印环境归因没有独立证据，不声称 hash masking/stub。

程序式 server 入口与 Pi 命令已验收；统一 Campaign 启动/关闭、SDK Session 配置和 live view
接线留到 **C5 整体集成**。这属于后续部署装配，不回头增加 C4a 门槛。
下一任务书/提示词：`C5_INTEGRATION_TASK.md`、`C5_INTEGRATION_DS_PROMPT.md`。
本轮只布置文档，不实现 C5，不启动真实模型/目标/能力实验。
