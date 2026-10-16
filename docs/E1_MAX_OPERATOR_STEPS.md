# E1 max / dsv4.1flash：操作者步骤

模型已由用户选定：max 中转站，`deepseek-v4.1-flash`。
直接复用 `Pi_Agent_base/config/agent/` 的现有 Pi 配置：`settings.json` 当前选择
`relay/deepseek-v4.1-flash`，`models.json` 给出 `https://ai.max66.xyz/v1` /
OpenAI-compatible Chat Completions，`auth.json` 已有 relay 凭据。
`pi-config` 使用 Pi 的 ModelRuntime 和只读 AuthStorage；无需再次输入 key。
真实调用由用户终端执行；本会话只做离线验证与配置检查。

第一步试跑一个数据字段任务（最多4次provider请求）；成功后可跑代表性单文件修复
（最多8次）。二者合计最多12次，输出上限4096 tokens/request，不自动重试。
学习关闭、动态扩展关闭，目录是可丢弃副本；这两项是连通/代表性任务，后续再选用户
项目的真实bug。请求上限不是金额上限，实际费用看max账单。

## 1. 生成运行包（不请求模型）

当前工作区的默认包已在2026-10-14由用户完成smoke和code，两项各3次请求、均已验收；
证据见第7节。不要覆盖此包。下面prepare命令用于尚未生成包的工作区，既有包用status查看。

在macOS Terminal的zsh中执行；后续命令保持在同一个终端：

```bash
cd /Users/scemac/My_github/Aegis
node Pi_Agent_base/campaign/e1-max-pilot.mjs prepare
```

会输出`prepared: true`、所选provider/model、Pi配置目录和两份config路径。默认目录：
`Pi_Agent_base/runtime/pilot/e1-max-first/`（ignored）。
源码初态、冻结测试、Manifest、预算、输入digest都已生成；不会改用户原项目、Pi配置或auth。
若提示目录已存在，先执行第4步查看旧attempt，不删除或换目录覆盖未决记录。

## 2. 核对自动选择的模型

prepare输出应包含 `kind: pi-config`、`provider_id: relay`、
`model: deepseek-v4.1-flash`、`max_output_tokens: 4096`。
prepare只读取选择信息，不读取凭据、不发送模型请求。run才通过Pi读取已有凭据；
缺模型或凭据会在Host启动前拒绝，没有faux fallback。
Pi目录还可在prepare时用 `--pi-agent-dir <绝对目录>` 明确选择。
预算和工具授权仍来自Aegis运行包；Pi模型参数/endpoint/compat/鉴权来自Pi，输出上限
取Pi模型上限与4096中较小者。代码Oracle子进程不继承provider密钥；workspace仍非OS sandbox。
若此前已用旧env方式prepare，不覆盖既有attempt；先查看旧status并交回，再确定迁移方式。

## 3. 执行第一个真实请求任务

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/campaign/e1-max-pilot.mjs run --run-real
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
node Pi_Agent_base/campaign/e1-max-pilot.mjs status
```

不调用模型、无需密钥，基于events重建状态。将这段摘要JSON交回即可，不要提交密钥、
auth文件或完整私有会话。失败时可补充终端脱敏错误。
产物根为`Pi_Agent_base/runtime/pilot/e1-max-first/`：

- `smoke/run-summary.json`：本次执行摘要。
- `smoke/run/events.jsonl`：权威事件流，保持原样。
- `smoke/measure/measurement.json`：现有计量，未知金额仍null。
- `smoke/workspace/dataset.json`：真实效果。

## 5. 连通成功后，执行代表性代码修复（可选第二步）

2026-10-14首个真实smoke已由用户运行并核验：3次请求、Task completed、Oracle success、
pending/unresolved=0、事件链完整，dataset为Ada/pending。另一个终端在请求进行中查看
status曾看到running、2 consumed+1 pending；退出后再次查看与run结果一致，属于运行中快照。
该次事件也暴露C6的aegis_read被Campaign门禁拒绝：模型仍可按明确字段值完成数据任务，
所以此结果证明连通、写入、Oracle和结算，不证明模型读取过文件。现已补上C6读取工具的
明确放行，保留当前Task/真实路径检查；随后代码pilot已使用修复版本通过，见第7节。

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/campaign/e1-max-pilot.mjs run --task code --run-real
node Pi_Agent_base/campaign/e1-max-pilot.mjs status --task code
```

命令会先检查smoke已完成且无未决。模型修复`solution.mjs`的`normalizeName`：去掉首尾
空白、合并内部空白、对非字符串返回null；Host执行冻结断言，模型不能改测试。
最多8次provider请求，正常完成时Task completed、Oracle success、无未决/诊断。
本次代表性任务只证明该运行链和行为，不计为用户项目bug修复成果。

## 6. 本轮已验证与限制

实现调用同一C6 Worker/Broker/Oracle/request gate，未绕过三个事实分离。`pi-config`
明确引用Pi目录与provider/model；只读原auth，不修改models/settings/auth或原catalog缓存。
原 `remote-openai` env方式仍支持。离线测试拦截真实SDK生成的HTTP，验证URL/model/
Bearer、Pi自定义headers/compat、4096输出上限、工具循环、实际文件效果、Oracle、
已完成重启零新增请求、缺模型/缺凭据拒绝、prepare/status无需凭据，以及Oracle环境隔离。
离线接线证据与真实运行分开：真实max在本次两项正常链上的工具调用与终止已通过，
见第7节；真实断流/取消尚未实测，费用仍以max账单为准。

初次remote接线已通过12个相关脚本。本次Pi配置复用补充有red→green证据；9个相关
脚本全部exit0，Biome修改范围exit0；Campaign tsc仍exit1、196条历史诊断，与修改前
逐字相同。当前真实Pi配置经SDK加载，credential_ready=true、network_calls=0。
本次日志在ignored `Pi_Agent_base/runtime/dev/e1-pi-final/`、`e1-pi-red.log`及
`e1-pi-tsc-before.log`/`e1-pi-tsc-after.log`。Pi复用开发检查未执行真实max调用；
后续首个真实smoke由用户执行，结果见第5节及私有pilot目录。

读取接线补测要求真实SDK continuation收到文件初态，已捕获旧门禁版本的失败并修复；
另外通过独立status子进程核对run退出后的逐字段结果。针对性检查日志位于
`Pi_Agent_base/runtime/dev/e1-read-final/`，red/green为`e1-read-red.log`/`e1-read-green.log`。
本次8个相关脚本exit0，Biome修改范围exit0，Campaign类型基线仍196条、逐字相同。

## 7. 用户真实执行结果与独立核验（2026-10-14）

源码基线`ac3220c`，模型`relay/deepseek-v4.1-flash`，learning off。用户按第3、5节
命令执行，完成后分别运行独立status；两项状态均与各自run-summary一致。

| 项目 | smoke | code |
| --- | --- | --- |
| 实际provider请求 | 3（上限4） | 3（上限8） |
| Task / Oracle | completed / success | completed / success |
| pending / unresolved | 0 / 0 | 0 / 0 |
| 请求终止 | 3个ok | 3个ok |
| 账本/投影诊断 | 空 | 空 |
| 实际效果 | dataset.name=Ada，status=pending | normalizeName修复落盘 |

code的40条权威事件链校验通过。aegis_read返回原始`return value.trim()`源码，
随后tool-result消息记录了同一内容；Broker仅执行一次`code.file.write`，before_digest
对应冻结初态，after_digest对应当前产物。模型补丁为字符串trim并合并内部空白，
非字符串返回null。三个reserved/committed请求配对，无未决；Stage和Task Oracle均success。

独立核验以`node --input-type=module`运行本地核验脚本，exit0，新增provider请求0：
重新校验Manifest/config/冻结测试digest，检查事件链、读结果、写入前后digest与请求记录，
然后以空环境调用现有`runRegisteredTest`，携带原`expectedTestDigest`。结果complete=true、
ok=true、failed=0、exit_code=0，冻结文件的七条顶层断言完成；不将runner未报告的断言计数
补写成测量值。私有证据在`code/operator-verification.json`、两项`run-summary.json`及
`run/events.jsonl`，原attempt保留不改。仅记录证据的文档更新不重跑产品回归。

两项合计6次真实请求。SDK中的cost=0不代表免费，backend_currency仍null。
已证明此模型下的正常“读取→决策→写入→冻结Oracle→持久化重建”代码链；代码样本是
预设代表性任务，尚不是用户项目bug，也不证明多文件、通用shell、测试反馈修复循环、
真实故障恢复或经验收益。下一步选一个符合现有单文件工具范围的真实项目需求，冻结
副本、验收和预算，再准备新的运行包；不要反复重跑已完成样本当作新能力证据。
