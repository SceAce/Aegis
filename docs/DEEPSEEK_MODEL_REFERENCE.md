# DeepSeek 模型参考

Aegis 的默认手动入口仍然是中转配置 `maxapi/deepseek-v4.1-flash`。本地 Aegis `Pi_Agent_base/config/agent/models.json` 另外保留了一份非敏感的官方 DeepSeek 模型元数据，来源是本机全局 Pi 配置的模型目录。

## 官方配置

```text
provider: deepseek
model: deepseek-flash
name: DeepSeek V4.1 Flash
api: openai-completions
base URL: https://api.deepseek.com
input: text, image
reasoning: true
context window: 1,000,000
```

Aegis 没有复制全局 Pi 的 `auth.json`，也不会把 API key 写入仓库。全局 Pi 的凭据仍由用户本地配置管理；真实请求前，必须确认该凭据确实属于你有权使用的官方 DeepSeek 账户。模型元数据中的价格和窗口是配置参考，不是实际账单或运行时保证。

## 手动切换

`run-ram-test.sh` 的默认行为不变：

```bash
cd /path/to/ctf-task
/Users/scemac/My_github/Aegis/run-ram-test.sh \
  --task-id ctf-task-001 \
  --provider maxapi \
  --model deepseek-v4.1-flash
```

使用官方 DeepSeek provider 时，显式指定全局 Pi agent 配置目录：

```bash
cd /path/to/ctf-task
/Users/scemac/My_github/Aegis/run-ram-test.sh \
  --task-id ctf-task-official-001 \
  --provider deepseek \
  --model deepseek-flash \
  --pi-agent-dir "$HOME/.pi/agent"
```

该命令会读取：

```text
$HOME/.pi/agent/models.json
$HOME/.pi/agent/auth.json
```

会话、server 状态和 Aegis EventLog 仍写入当前 Aegis attempt 目录，不写入全局 Pi session 目录。`--pi-agent-dir` 是显式授权边界；不指定时不会自动读取全局 Pi 凭据。

查看当前支持的参数：

```bash
/Users/scemac/My_github/Aegis/run-ram-test.sh --help
```

可用 `--thinking off|minimal|low|medium|high|max` 调整推理级别。官方模型的本地 Pi 配置会决定实际 endpoint、兼容参数和认证方式，Aegis 不在启动脚本中读取或打印 key。

## C6 配置

C6 产品入口仍通过可信 `campaign.config.json` 的 `provider` 选择模型。使用全局 Pi 配置的形状是：

```json
{
  "provider": {
    "kind": "pi-config",
    "provider_id": "deepseek",
    "model": "deepseek-flash",
    "agent_dir": "/Users/your-user/.pi/agent",
    "max_output_tokens": 4096
  }
}
```

`agent_dir` 应使用绝对路径。它只作为本地配置/认证的引用，不应提交到远程仓库或写入公开报告中的私密路径信息。`pi-config` 会检查模型存在且本地有可用凭据；检查失败时 fail-closed，不回退到 `maxapi` 或 faux。

## 边界

- “官方 DeepSeek”只表示 endpoint/provider 元数据来自官方 API 配置；不等于本次调用已完成，也不等于账号权限有效。
- `maxapi`/`relay` 是中转 provider，与 `deepseek/deepseek-flash` 分开记录，实验数据不能混组比较。
- provider、model、endpoint、thinking level 发生变化时，应创建新的 task/attempt，不要把不同模型的事件流合并。
- 真实 provider 测试需要用户显式执行；离线测试使用 faux provider，不接触真实凭据或真实网络。
