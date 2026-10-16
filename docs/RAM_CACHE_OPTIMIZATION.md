# RAM 请求前缀缓存修复

用户授权：先建立 Git 存档，再优先修复 RAM 导致的缓存前缀变化。
基线 `0a90a9a55e49db7398367e5190cce0d7a354f6fd`，annotated tag
`archive/pre-ram-cache-20261016`；实现分支 `fix/ram-prompt-cache`。
内嵌 Pi `42a3497d03ad17e308a2299fa824727894f2c0ec`，本轮未修改。

## 变更契约

- ROM、工具定义、固定规则保持原有 system sections，RAM 不再进入 system。
- `context_with_system` 每个请求从 committed EventLog 构建当前 RAM，在完整工具结果之后
  添加一个临时 `custom` 消息。Pi 将它转换为普通 `user` 上下文消息。
- 每个请求只有一个有界 RAM 快照，下一次重建替换；快照不进入 session state/JSONL，
  因此不会每轮累积完整 RAM。真实工具结果仍正常传给 continuation。
- 移除旧会话中 Observer 自己的 `aegis_ram` section（仅请求副本，不改历史文件），保留 ROM、
  工具和其他扩展的 sections。重启、重投影/重试不能使旧 RAM 复活。
- `request.projected` 保留 RAM digest、字符数、Board digest、state version，新增
  `ram_transport: ephemeral-user-tail-v1`。审计事件不产生 Board 节点或 State version。
- RAM 内容、权限和持久化策略沿用现有契约；不新增权限、账本或自动验收。

此实现保留每轮新鲜状态，同时让缓存匹配在 transcript 的尾部发生分歧。
它不是永久追加 RAM 增量；上轮临时 RAM 本身不会成为下轮缓存前缀，历史消息可以继续复用。
动态工具、其他扩展修改 system、压缩和轮换依然可能改变缓存边界。

## 验证

证据根（ignored）：`Pi_Agent_base/runtime/dev/ram-cache-20261016/`。

| 检查 | 最终结果 |
| --- | --- |
| `aegis-ram-cache-payload.mjs` | exit 0；真实 SDK/OpenAI 序列化 + 全 HTTP 拦截，10 请求、8 个真实本地 read |
| archived Observer 同一 payload harness | exit 0；复现旧 system RAM 变化 |
| E1 contract-closure required | 68 唯一脚本最终均 exit 0；初跑 C2 rotation 夹具失败，修正后单独复跑通过 |
| focused | 16 脚本初跑中 handoff 夹具失败；修正后 final-focused 7 脚本均 exit 0 |
| `aegis-ctf-ram-review.mjs` | exit 1；5 pass/1 fail，CR-01 与 CR-05 通过；CR-02 原有输入/响应细节缺失仍失败 |
| Biome 修改范围 | exit 0，3 个既有 warning、2 个 info，未关闭规则 |
| Campaign tsc | exit 1，194 diagnostics；此配置不检查 Observer TS 文件 |
| Batch-E tsc | exit 1，186 diagnostics；此配置不检查 Observer TS 文件 |

测试迁移：旧 `system.aegis_ram` 检查改为读取 provider 实际收到的普通 user RAM 消息。
两个 faux handoff/rotation dispatcher 原先假设最后一条 user 消息永远是人的指令，现跳过
Runtime RAM 再匹配人的指令；副作用、轮换对象、Episode、权限、预算和结果断言保持。
独立 CR-02 未改弱/skip。旧测试文件按现有 Biome 格式整理。

精确命令与 exit 位于 `required/results.json`、`focused/results.json`、
`final-focused/results.json`；`required-final-results.json` 合并初跑通过与修复后的受影响复跑，
不是宣称初跑 68/68 全绿。payload before/after 命令和结果见 `payload-results.json`。

可复现的聚焦命令：

```bash
node --import ./Pi_Agent_base/pi/packages/coding-agent/src/experimental/source-resolver.ts \
  Pi_Agent_base/tests/aegis-ram-cache-payload.mjs
node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs \
  Pi_Agent_base/runtime/dev/ram-cache-repeat \
  observer-smoke aegis-observer-contest-pi aegis-observer-verify-first-pi \
  aegis-observer-runtime-handoff aegis-c2-session-rotation \
  aegis-observer-failclosed-pi aegis-observer-run-audit-failclosed-pi
```

## 离线前后对照的实际含义

同一 SDK、ROM、8 个 read 和两次 prompt，仅替换 Observer。
实际序列化的 `{tools,messages}` 相邻请求公共前缀（字符，不是 tokenizer/token 命中）：

| 请求对 | 原存档 system RAM | 新临时 user 尾部 RAM |
| --- | ---: | ---: |
| 1→2 | 4346 | 3959 |
| 3→4 | 4346 | 4449 |
| 6→7 | 4346 | 5184 |
| 8→9 | 4346 | 5674 |
| 9→10 | 6911 | 5919 |

旧实现 RAM 更新时分歧停留在 system，历史增加无法延长缓存前缀；新实现前缀随历史增长。
旧实现最后一对 RAM 刚好不变，所以该请求对旧公共前缀更长；不能说每个请求都提升。
新请求多一个消息包裹，本夹具每个请求增加约 50 个 JSON 字符，不宣称输入体积整体变小。

本轮没有实际 provider 缓存统计或延迟：`actual_cache_hit_rate` 与
`actual_provider_latency_ms` 都为 null。工程证明是序列化稳定性和历史可复用性，
不是实测加速百分比。之前两个真实 session 的 provider 分别为 relay/maxapi，
output 也有明显差异；因此原先“主要是缓存导致全部延迟”的判断只是待真实对照验证的归因。

## 用户实测

扩展为动态加载的 TypeScript，改动不要求重建 Pi 核心。退出并重启原来加载 Aegis Observer
的入口，或使用 `/reload` 后开启新 session；仅 `--session-dir` 本身不保证加载扩展。
推荐新 session 做对照，旧 session 的来源、工具和上下文可能已不同。

若使用仓库入口，可在目标工作目录运行：

```bash
/Users/scemac/My_github/Aegis/Pi_Agent_base/run-pi.sh
```

该入口仍执行既有 bundle freshness 检查；若提示 Pi 源码较新，则按原提示处理，
本轮未升级/构建/修改内嵌 Pi。已经存在的私有 attempts、auth/config/session 不被本轮改写。

固定同一 provider/model/thinking level、同一工具和相同任务输入，观察多轮 continuation：
`cacheRead` 是否随历史增长、未缓存 input 是否下降，并记录总时长/请求时长/output tokens。
命中占比口径为 `sum(cacheRead) / sum(input + cacheRead + cacheWrite)`；
`reasoning` 已包含于 output，不重复加。缓存统计依赖 provider，不能从离线 payload 推导真实 token 命中。

完成运行后比较新 session JSONL 即可，不需要重新访问旧靶机或复跑旧付费样本。
