# docs/ —— 人类专用（agent 读不到）

这个目录和 `manual/` 的分工是**权限边界**，不是整理癖。

| 目录 | 谁能读 | 装什么 |
|---|---|---|
| `manual/<题>/` | **agent** | 注入给它的三份文档：`TASK.md` / `MEMORY.md` / `EXPERIENCE.md` |
| `docs/`（本目录） | **只有人** | 设计文档、实验方案、run log、操作脚本 |
| `tests/` | **只有人** | 回归测试与冻结的 fixture |
| `rom/`、`ram/` | agent（由 `aegis ram` 注入） | ROM 与执行环境清单 |
| `runs/`、`.aegis/` | 都不给 | 历史 WP / 记忆库本体 |

## 为什么必须分开

`aegis/guard.py` 的 `design_docs` 规则 + 扩展的 `isForbidden` 都会拒绝 agent 读
`docs/`、`tests/` 和四个根目录设计文档。理由不是洁癖，是**实验有效性**：

- 读 `docs/pwn_3_EXPERIMENT.md` → 知道自己在哪一组、期望解法是什么
- 读 `tests/fixtures/roleflip_cells.json` → 拿到 pwn_1/pwn_2 的经验格子，绕过 A/B 设计
- 读 `docs/*_RUNLOG.md` → 看到历史结果

> **实测教训**：上一轮 pwn_3，模型在第 20、21 次工具调用读了当时的
> `manual/pwn_3/EXPERIMENT.md`，里面写着二进制原始 hint 的原文 ——
> 于是花在 `.rodata` 里的 patch 白做了，transcript 里 `tcache dup` 出现 **89 次**。
> **泄漏口不是 `runs/`，是当时没人管的 `manual/`。**

所以现在的规则是：**agent 注入的文件放 `manual/<题>/`，其余一律进 `docs/`。**

## 文件

| 文件 | 内容 |
|---|---|
| `DEMO.md` | demo 完整说明：目标 / 四步闭环 / 实现原理 / 代码地图 / 已做未做 / 修复优先级 |
| `HANDOFF.md` | 早期交接文档（经验利用，给实现 Agent） |
| `WP_FORMAT.md` | WP 规范 v2（机器可解析，供 compile 确定性解析） |
| `pwn_1_HOWTO.md` | pwn_1 轮次的人工操作步骤 |
| `pwn_1_RUNLOG.md` | pwn_1 轮次的完整记录 |
| `pwn_3_EXPERIMENT.md` | pwn_3 实验方案：两组对照、前置修复、隔离清单、判读规则 |
| `pwn_3_RUNLOG.md` | pwn_3 实验记录（结果区待填） |
| `pwn_3_arm.sh` | 布置 A/B 组并打印启动命令 |

## 开一轮之前

```bash
cd /Users/scemac/My_github/Aegis
bash docs/pwn_3_arm.sh A          # 或 B
# 然后原样执行它打印的那条 pi 命令
```

两组的**提示词完全相同** —— `TASK.md` 里写的是"如果 `EXPERIENCE.md` 存在，也先读它"，
所以自变量只是**那个文件在不在**，不是措辞差异。
