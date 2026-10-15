# Aegis 首轮 Web CTF 工具接入计划

日期：2026-10-16。状态：工具与接线调查完成；下列接口是待实现契约，不表示产品已支持 Web CTF。
用户选择 BUUCTF 或 CTFshow 靶机；具体题目和实例地址尚未提供。

## 1. 本轮目标与现状

目标是让 Aegis 在一道指定的 Web 题上完成请求、读取真实反馈、继续分析和提出 flag 候选，
再用平台结果核验实际效果。首次试验记录架构问题的实际影响，不以先修完全部历史问题为前提。
依据继续采用 SYS-20261015-01 与 E1-CC-1.0，不修改既有架构基线或旧审查断言。

调查基于分支 `fix/e1-single-authority`、HEAD `dabbfeb` 加现有 Opus 未提交修改。
本次调查未运行真实模型或靶机请求，未修改产品实现、用户提示词或 Opus 文件。

已确认的接线位置：

| 位置 | 现状 | 接入要求 |
| --- | --- | --- |
| `memory/campaign/c6-sdk-runtime.mjs` | 支持 `extraTools`，Session 创建及轮换时注册 | 使用真实 SDK 自定义工具，保留同一 gate |
| `memory/campaign/c6-model-worker.mjs` | read、decision、submit 工具及 request/toolCall 绑定 | 新工具参与既有 provider gate、双侧工具收费和当前 Task 绑定 |
| `memory/campaign/c6-entry.mjs` | 目前为 fixture/data/code family；Composite 在模型结束后执行 decision | 新 Web family 需要交互反馈模式，响应进入下一次真实模型请求 |
| `memory/campaign/c3-entry.mjs` | 组装时 `allowNetwork: false`，工具限 workspace/script | 网络授权由冻结靶机契约显式注入，旧 family 行为保持原契约 |
| `memory/campaign/broker-worker.mjs` | grant/target/evidence 逻辑面向文件路径 | Web target 使用明确资源类型，不能把 URL 交给文件 `resolve()` |
| `memory/campaign/campaign-config.mjs`、`manifest.mjs`、`registries.mjs` | family、profile、adapter、Oracle 由可信代码校验 | 显式登记 Web 能力及独立结果来源，配置和模型不能自行登记实现 |
| `contest/run.sh` | 旧赛事实验入口，工具/恢复契约不同 | 不能用旧 launcher 的 bash 权限冒充当前 E1 产品接入 |

本机存在 `node`、`curl`、`python3` 和 `docker` 命令；未检查 Docker daemon、Python 包、
浏览器安装或任何外部工具服务。命令存在不表示它已成为 Aegis 工具。

## 2. 工具清单与用户需提供的信息

首版使用内置 HTTP 客户端，无须购买或安装 Burp/MCP。下面名称均为计划中的模型接口。

| 接口 | 用途 | 实现来源 |
| --- | --- | --- |
| `aegis_http_request` | 方法、路径、重复 header、请求体、会话；返回响应与证据引用 | Node HTTP/HTTPS 适配器，通过现有 Broker |
| `aegis_response_read` | 分页读取已保存的响应正文/附件，支持文本或 base64 | 私有 artifact store，按当前 Task/授权核验引用 |
| `aegis_transform` | URL、base64、hex 编解码及摘要等明确的数据变换 | 已登记的确定性本地函数，按实际题目收窄操作集 |
| `aegis_flag_candidate` | 保存候选及其证据引用，供用户取出提交 | Claim/候选，不产生 trusted success |

HTTP 会话由工具层管理，无须单独把 cookie CRUD 暴露给模型。原始响应按任务保存在 ignored
运行目录，模型可读取与解题相关的内容；公开报告只输出有界摘要与引用。

用户需要提供：

1. 平台、题号或题名、题目说明，以及启动后的准确 URL（含协议和端口）。
2. 靶机是否有到期时间、是否必须通过用户已有 VPN/代理访问；有则提供连接方式说明。
3. 题目附件的本地路径（如果有）。平台登录和实例启动由用户完成即可。
4. 如果已有工具服务，提供名称及 CLI/HTTP/MCP 调用接口；没有不影响内置方案。

候选扩展按具体题目确定：浏览器用于必须执行 JavaScript 的页面；Burp 的可调用接口可提供
原始请求与交互能力。GUI 安装本身不等于存在自动化 API。MCP 服务还需要服务地址或启动命令、
transport、tool schema 和认证引用方式；本轮 Codex 能调用某工具，不会自动使 Aegis 能调用。

首轮不依赖通用终端、任意模型脚本执行、平台账号自动登录或全套扫描器。
若选题确实需要浏览器、脚本计算或回连能力，再明确增加对应契约与测试。

## 3. 待实现的接口与执行语义

### 3.1 请求接口

`aegis_http_request` 输入：

```text
target_id: string                  # 冻结配置中的靶机标识
method: string                     # 冻结契约允许的 HTTP 方法
path_query: string                 # 保留题目所需的原始转义与参数顺序
headers: Array<[string, string]>    # 支持重复字段；逐项校验
body: {encoding: "utf8"|"base64", data: string} | null
session_id: string | null          # null 创建当前运行内的会话
```

`target_id` 由 Host 映射到冻结的精确 origin；模型不能通过 Host/header、绝对 URL、重定向、
代理环境变量或服务端提供的链接扩大授权。URL 的授权解析与实际发送路径分开，避免把正常
CTF 转义参数悄悄规范化。首版重定向手动处理：返回 Location，不自动请求下一站。
协议范围不包含 CRLF 注入、请求走私或任意 raw socket；需要时另立传输契约。

输出至少包含：

```text
transport_status: received | rejected | unknown
status_code: integer | null
headers: Array<[string, string]>
body_preview: string
body_ref: string | null
body_digest: string | null
bytes_received: integer
truncated: boolean
session_id: string | null
action_ref / action_id / evidence_refs
error_code: string | null
```

HTTP 4xx/5xx 也是有价值的已收到响应，不等于工具传输失败，更不等于任务失败。
HTTP 200、页面出现 flag 格式、工具 ok 均不直接产生题目成功判断。

工具统一为 sequential；每次调用对应一个受计量单元，实际网络尝试数另行记录。
超时、请求/响应大小、速率、总请求数、预算和运行时长上限在运行包中冻结。
响应预览与完整产物分开；明确字节计量是否为压缩前/后，并限制解压后大小。

Cookie 按运行、实例、session 及标准 Domain/Path/Secure/expiry 规则管理；恢复到同一实例时
校验持久化身份，重置或新实例不能隐式继承旧会话。cookie 状态与响应一起保留可核验摘要。

### 3.2 同步工具反馈与现有 Worker 的关系

Web 探索要求单次请求在模型工具循环内完成并返回响应。当前 decision 是延迟批处理，不能
仅新增一个 action 名称就宣称完成接入。实现前必须为 Web family 明确以下行为扩展：

1. 工具绑定真实 provider request，确认联合结清并完成既有双侧收费。
2. 通过 Host 单 writer 确认 durable intent；await 之后再检查当前执行许可和靶机授权。
3. 调用同一个 Action Broker 和已登记 HTTP adapter，接收真实响应。
4. 提交响应/产物/动作结果及必要会话状态；确认后返回 SDK tool-result，供下一请求读取。
5. 同一操作不再进入 Composite 的延迟 decision buffer，避免执行两次。

这项扩展只适用于明确登记的交互工具。已接受的旧 C6 批处理路径及 aborted 保证不能被
悄悄改写：交互工具发生过的效果必须如实保留，后续模型 aborted 不会使它们消失。
不能另建平行 Broker、预算账本或 authority；复用边界的必要改动逐项进入契约矩阵。

重复调用按完整 Campaign/Task/Episode/request/toolCall/unit/参数身份处理；有已提交且可核验
结果则复用。无结果但请求可能已发送时保留 unknown/hold，不以新调用 ID 自动重发。
GET 也可能改变靶机状态，不把方法名称当作安全重试证明。

### 3.3 产物、数据变换与验收

`aegis_response_read({ref, offset, limit, encoding})` 只接受已登记且授权可读的产物引用，
使用字节 offset，返回实际范围、digest、是否还有内容；foreign/missing/corrupt ref 明确拒绝。
跨 Task 使用需要显式准入的证据传递，不能全运行目录通读。

`aegis_transform({operation, input, input_encoding})` 只调用已登记函数，不执行模型给出的
脚本或 shell。无效编码、非 UTF-8 文本、输出过大分别给出明确结果，不静默替换字节。

`aegis_flag_candidate({candidate, evidence_refs})` 仅产生待验证候选。最终由用户提交到平台，
可信结果导入要绑定平台、题目、实例、Campaign、Task、Episode 与 criterion。
未提交保持 unknown；平台不接受只表示该候选失败，不必直接终结所有探索。
旧 `contest/result.mjs` 的 task/session 结果格式不能未经映射直接变为 Campaign Outcome。

## 4. 任务依赖与实现顺序

| 步骤 | 范围 | 依赖与交付 |
| --- | --- | --- |
| W0 | 选择具体题目；登记原始实现身份与已知失败；冻结交互工具契约 | 用户题目与调用方式；具体配置/schema、接口表、测试矩阵 |
| W1 | HTTP/session/响应产物和数据变换 adapter | W0；本地可控 HTTP 服务的正负测试，无真实靶机 |
| W2 | Web family、网络授权、Broker 与 SDK 同步工具反馈 | W1；真实 SDK + faux，证明响应实际进入 continuation |
| W3 | 候选、独立人审结果映射、准备/状态/导出入口 | W2；可复现运行包、冻结输入和外部对账说明 |
| W4 | 用户操作真实模型与 BUUCTF/CTFshow 实例 | W3；正常运行，再按明确时间点中断恢复、重置实例 |

实现保持现有 Node ESM/JSDoc/Biome；不改内嵌 Pi、真实配置、凭据、依赖及 lockfile。
共享 entry/manifest 文件有 Opus 未提交内容，新增接线需按具体 diff 保留；本地提交不得把
Opus 的既有修改一并纳入。若需隔离工作区，先保留并校验当前输入身份。

## 5. 必需测试矩阵

以下均为计划，状态 `not_run`；不能把本文件当作测试通过证据。

| 编号 | 层级 | 预期行为与独立证据 |
| --- | --- | --- |
| WT-01 | adapter | GET/POST、query、重复 header、二进制 body 与服务端实收字节一致 |
| WT-02 | adapter | cookie 设置、隔离、路径、过期与恢复；服务端观察到的 Cookie 符合规则 |
| WT-03 | adapter | 302 不自动请求下一地址；foreign target/header/proxy 不能额外产生请求 |
| WT-04 | adapter | 404/500 返回真实响应；连接失败/超时与可能已发送状态区分；无自动重试 |
| WT-05 | artifact | 大响应分页、截断、压缩上限、二进制读回；字节与摘要一致 |
| WT-06 | product | 真实 SDK + faux 先调用 HTTP，再依据响应中的随机内容发起下一步，证明反馈可见 |
| WT-07 | product | 正常单次调用仅一个 charge/intent/网络尝试/结果；重复调用不产生第二次效果 |
| WT-08 | fault | intent 持久化失败零请求；收费/结果确认失败停止后续效果；保留真实消费 |
| WT-09 | recovery | 真实子进程在发送前、发送后结果前、结果提交后退出；分别无效果、unknown、不重发 |
| WT-10 | product | 超时/取消/依赖或实例失效发生在 await 期间；网络出口读取最新 permit |
| WT-11 | outcome | 候选不等于 success；foreign 平台结果不能完成当前题；合法独立结果可正确导入 |
| WT-12 | integration | 新 Session 保留工具/gate/状态；旧 family 回归与类型诊断不恶化 |

阶段检查按受影响接口选择显式清单，真实 SDK 使用 source resolver 和 faux provider；
本地监听受沙箱限制时按实际审批流程运行。保存原始退出码，不使用可能吞失败的辅助 runner。

## 6. 实际试验与后续判断

选题先确认能以 HTTP 和有限数据变换交互；不预先把解题步骤或标准 flag 写进模型输入。
用户启动题目并手动提交候选；首次正常链之后，再单独记录中断恢复及实例重置试验。
外部观测尽量使用独立 HTTP 代理/出口计数与模型用量；共享平台未必提供服务端日志，不能
假设能够获得。额外观测代理存在时先核实它没有改变请求/会话语义。

每次结果区分工具接入不足、模型解题错误、架构一致性问题、靶机/平台故障。
预算和运行时间由测试侧另设上限；Aegis 自身状态与外部观测分别保留。
题目到期/重置产生新环境身份，不手改旧日志继续冒用原实例。

前轮 R-S01–R-S09 保留原证据和实际状态。本轮不批量修复，也不因一次解题成功宣布消失；
若具体问题进入这次工具链，记录触发、影响和是否需要最小接线修复，再按试验结果排优先级。
