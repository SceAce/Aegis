# E1 max / dsv4.1flash：操作者步骤

模型已由用户选定：max 中转站，`deepseek-v4.1-flash`。
沿已有模型元数据使用 `https://ai.max66.xyz/v1` / OpenAI-compatible Chat Completions。
新增 `remote-openai` 显式接线，真实调用由用户终端执行；本会话只做离线验证。

第一步试跑一个数据字段任务（最多4次provider请求）；成功后可跑代表性单文件修复
（最多8次）。二者合计最多12次，输出上限4096 tokens/request，不自动重试。
学习关闭、动态扩展关闭，目录是可丢弃副本；这两项是连通/代表性任务，后续再选用户
项目的真实bug。请求上限不是金额上限，实际费用看max账单。

## 1. 生成运行包（不请求模型）

在macOS Terminal的zsh中执行；后续命令保持在同一个终端：

```bash
cd /Users/scemac/My_github/Aegis
node Pi_Agent_base/memory/campaign/e1-max-pilot.mjs prepare
```

会输出`prepared: true`和两份config路径。默认目录：
`Pi_Agent_base/runtime/pilot/e1-max-first/`（ignored）。
源码初态、冻结测试、Manifest、预算、输入digest都已生成；不会改用户原项目、Pi配置或auth。
若提示目录已存在，先执行第4步查看旧attempt，不删除或换目录覆盖未决记录。

## 2. 在当前终端注入max密钥

```zsh
read -r -s 'AEGIS_MAX_API_KEY?请输入 max API Key（输入隐藏）：'
echo
export AEGIS_MAX_API_KEY
```

按提示粘贴自己的max key并回车。值不写入配置或命令历史，不需要发到聊天。
这条路径不读取已有`auth.json`；SDK内存凭据仅供该运行使用。
代码Oracle子进程使用最小环境，不继承provider密钥；workspace仍非OS sandbox。

## 3. 执行第一个真实请求任务

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/memory/campaign/e1-max-pilot.mjs run --run-real
```

这是开始计费的命令。模型应读取`dataset.json`，通过注册动作把`name`从`??`改成`Ada`，
由Oracle重读文件验收。正常工具循环通常为数次请求，硬上限4；多余continuation也占额度。
窗口设置50000字符（含4000字符输出预留），是估算，不是精确token计量。

末尾会输出JSON，并写`smoke/run-summary.json`、现有report与measure。
以这些字段共同判断成功：

```json
{
  "chain_ok": true,
  "task_states": { "task-001": "completed" },
  "pending_requests": 0,
  "unresolved_requests": 0,
  "ledger_diagnostics": [],
  "projection_diagnostics": [],
  "oracle_status": "success",
  "artifact": { "name": "Ada", "status": "pending" }
}
```

`model_requests`必须在4以内。工具返回ok、模型说完成或CLI exit0不单独代表验收成功。
若失败，保留本次目录，先看下面的只读状态；不手工改JSONL/清hold/换ID重试。
401/403通常先核对密钥/模型权限；404核对endpoint/model；400保留脱敏错误信息以定位
兼容参数；unknown/reconciliation先停止后续真实任务并交回状态。

任务时间预算180秒按调用边界检查，不会强制截断已在等待的远程请求。持续无响应可用
Ctrl-C结束进程并保留原attempt；之后先只读检查未决和产物，不自动重发。

## 4. 只读查看与交回

```bash
node Pi_Agent_base/memory/campaign/e1-max-pilot.mjs status
```

不调用模型、无需密钥，基于events重建状态。将这段摘要JSON交回即可，不要提交密钥、
auth文件或完整私有会话。失败时可补充终端脱敏错误。
产物根为`Pi_Agent_base/runtime/pilot/e1-max-first/`：

- `smoke/run-summary.json`：本次执行摘要。
- `smoke/run/events.jsonl`：权威事件流，保持原样。
- `smoke/measure/measurement.json`：现有计量，未知金额仍null。
- `smoke/workspace/dataset.json`：真实效果。

## 5. 连通成功后，执行代表性代码修复（可选第二步）

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/memory/campaign/e1-max-pilot.mjs run --task code --run-real
node Pi_Agent_base/memory/campaign/e1-max-pilot.mjs status --task code
```

命令会先检查smoke已完成且无未决。模型修复`solution.mjs`的`normalizeName`：去掉首尾
空白、合并内部空白、对非字符串返回null；Host执行冻结断言，模型不能改测试。
最多8次provider请求，正常完成时Task completed、Oracle success、无未决/诊断。
本次代表性任务只证明该运行链和行为，不计为用户项目bug修复成果。

完成后清除当前shell密钥：

```bash
unset AEGIS_MAX_API_KEY
```

## 6. 本轮已验证与限制

实现调用同一C6 Worker/Broker/Oracle/request gate，未绕过三个事实分离。远程HTTPS
必须显式配置env凭据引用，缺值在启动前拒绝；local保持loopback约束。
离线测试拦截真实SDK生成的HTTP，验证URL/model/Bearer、max_tokens、工具循环、实际
文件效果、Oracle、已完成重启零新增请求、prepare零请求，以及代码验收不继承凭据。
真实max流式兼容、模型行为和费用仍由本步骤实测；没有把离线替身称为真实max通过。

本轮检查：新增真实SDK/截获HTTP与操作者CLI测试通过，12个相关脚本全部exit0；
Biome修改范围exit0；Campaign tsc仍exit1、196条历史诊断，与修改前逐字相同。
日志在ignored `Pi_Agent_base/runtime/dev/e1-max-final/`、`e1-max-final-cli/`及
`e1-max-tsc-before.log`/`e1-max-tsc-final.log`。未执行真实max调用。
