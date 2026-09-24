# RUN-002 实验记录：pwn_3（跨题经验迁移）

> 方案见 `manual/pwn_3/EXPERIMENT.md`。结果区跑完填。
> 这是**用来回答"经验有没有提升"**的一轮 —— RUN-001 回答不了（自证 + 可认名 + 计时坏）。

---

## 0. 一句话

用 pwn_1/pwn_2 编译出的经验去解**没见过的** pwn_3，和**清空经验**的对照组比，
看 `wall_s` 与 `verified` 有没有差别。两组除经验列外全部相同。

---

## 1. 与 RUN-001 的关键区别

| 项 | RUN-001 (pwn_1) | RUN-002 (pwn_3) |
|---|---|---|
| 是否跨题 | ❌ 同题重跑 → **自证** | ✅ 跨题 → 真迁移 |
| 题目可认名 | ❌ `Baby Heap in 2017` → 回忆公开 WP | ✅ 无可识别题名 |
| 对照组 | ❌ 无 | ✅ `AEGIS_NO_MEMORY=1` |
| n | 1 | 目标 ≥3/组，交错 |

---

## 2. 环境快照

| 项 | 值 |
|---|---|
| 日期 | 2026-09-23 起 |
| 通道 | `ssh:100.110.69.75`（强制 `AEGIS_CHANNEL=remote`） |
| 远端 OS / glibc | Ubuntu 26.04.1 LTS / 原生 2.43 |
| **目标世界** | **2.27**（pwn_3 由 GCC 7.5.0 / Ubuntu 18.04 编译，自带该假设） |
| 二进制 | `test/pwn_3/pwn`，原始 commit `b9396e2`，**patch 后 `717a873` + `70d6454`** |
| sha256（原始） | `14b7a16478ee8794949b2c74f1ee4aecd2f5f17629bec838f461bd2979833af4` |
| **sha256（patch 后）** | **`9eb5909d3fc3e6e24dbf3d4866a54d91cbe75e532fa2daccbada7b6256fe7317`** |
| 大小 | 10216 B（patch 前后不变） |
| 保护 | PIE / Full RELRO / Canary / NX / stripped |
| 模型 | deepseek-flash |
| 知识块 | `manual/pwn_3/HEAP_KB.md`（与 pwn_1 **字节级相同**，只改了路径） |
| 提示词 | `manual/pwn_3/TASK.md`（两组**逐字相同**） |
| 经验（A 组） | `manual/pwn_3/EXPERIENCE.md`（独立文件，不走项目记忆系统） |

### 二进制 patch 记录

| 项 | 值 |
|---|---|
| 改动 | **624 字节，全部在 `.rodata`** |
| 清掉 | `Tcache dup`（手法 hint）、`https://ctf.show/`、`CTFshow`、7 行 ASCII logo（视觉拼出平台名） |
| 未动 | `.interp` / `.dynamic` / ELF 头 / 程序头 / 节头 / 重定位 —— 同长度原地覆盖为空格 |
| 远端实测 | `NEEDED: libc.so.6` 不变；`INTERP: /lib64/ld-linux-x86-64.so.2` 不变；大小 10216 不变；运行正常 |
| 还原 | `git checkout b9396e2 -- test/pwn_3/pwn` |

### pwn_3 自身属性（已实测）

```
菜单: 0) Create user  1) Edit user name  2) Delete user
      3) Send admin a message  4) exit
导入: malloc / free / strdup / read / scanf / puts / printf
```

**原始二进制自带 hint**（`* Hint : Tcache dup` + 平台网址），已 patch 清除（见上）。
所以本轮**不存在**"题目自带手法提示"这个污染源 —— 模型必须自己判断该用什么手法。

---

## 3. 变量控制

| 变量 | A 组（有经验） | B 组（无经验） |
|---|---|---|
| 题目 | pwn_3 | pwn_3 |
| 提示词 | `manual/pwn_3/TASK.md` | **同一个文件，逐字相同** |
| 知识块 | `manual/pwn_3/HEAP_KB.md` | 同一个 |
| **`EXPERIENCE.md`** | **存在** | **移走**（`arm.sh B`） |
| 项目经验列 | `AEGIS_NO_MEMORY=1`（关） | `AEGIS_NO_MEMORY=1`（关） |
| ROM / 工具 / guard | 全同 | 全同 |

自变量**只有一个**：`manual/pwn_3/EXPERIENCE.md` 在不在。
`TASK.md` 里写的是"**如果**该文件存在，也先读它"，所以连提示词都不用改。

### 跑前必留证（自变量快照）

```bash
# 经验文件在不在（A=YES / B=NO）
ls -l manual/pwn_3/EXPERIENCE.md 2>&1

# 项目经验列必须已关闭：应只看到 ROM 和 RAM 两个标题
uv run aegis ram --no-experience | grep '^# '
```

**若 A 组 `EXPERIENCE.md` 不存在，或两组都能看到 `# 经验` 段 → 本轮无效**，不要解读。

**A 组跑前 `EXPERIENCE.md` 的条目数（抄录）：**

```
（待填：ON 10 / OFF 20 / problems 25 / habits 40，如实测有出入以实测为准）
```

---

## 4. 执行命令

用 `arm.sh` 布置每一组（它会摆好文件、重新起表、打印启动命令）：

```bash
cd /Users/scemac/My_github/Aegis

./manual/pwn_3/arm.sh A     # 有经验：EXPERIENCE.md 就位
./manual/pwn_3/arm.sh B     # 无经验：EXPERIENCE.md 移走
```

它打印的启动命令两组**完全相同**：

```bash
AEGIS_NO_MEMORY=1 AEGIS_CHANNEL=remote AEGIS_CHALLENGE=pwn_3 \
  /Users/scemac/My_github/pi/pi-test.sh --approve \
  --provider deepseek --model deepseek-flash \
  "读 manual/pwn_3/TASK.md 并照做。"
```

**两组交错跑（A B A B A B）**，不要先跑完 3 次 A 再跑 3 次 B。

---

## 5. 隔离状态（已实测）

| 污染源 | 结果 |
|---|---|
| `cat runs/<pwn_1 的 WP>` | ✅ REFUSED (memory_peek) |
| `cat .aegis/atlas.json` | ✅ REFUSED (memory_peek) |
| `ls ~/Tmp/aegis/pwn_1/` | ✅ REFUSED (other_challenge) |
| `cat ~/Tmp/aegis/pwn_1/exp.py` | ✅ REFUSED (other_challenge) |
| `ls test/pwn_2/` | ✅ REFUSED (other_challenge) |
| `ls ~/Tmp/aegis/`（父目录） | ⚠️ 允许，但只暴露目录名 |

**注意**：远端 `~/Tmp/aegis/pwn_1/` 里仍躺着**已解出的 `exp*.py`**，
`pwn_2/` 也在。guard 拦得住，但若要更干净，在远端手工删：
`ssh hack@100.110.69.75 'rm -rf ~/Tmp/aegis/pwn_1 ~/Tmp/aegis/pwn_2'`

本地 `test/pwn_1`、`test/pwn_2` **必须保留提交态**（否则 git 恢复会失败），靠 guard 隔离。

---

## 6. 结果（待填）

### 6.1 主表

| 轮次 | 组 | `wall_s` | `elapsed_s` | verified | 激活 cells | 备注 |
|---|---|---|---|---|---|---|
| 1 | A | | | | | |
| 2 | B | | | | | |
| 3 | A | | | | | |
| 4 | B | | | | | |
| 5 | A | | | | | |
| 6 | B | | | | | |

- `wall_s` = agent 首条消息 → finish（**主指标**，从 transcript 取）
- `elapsed_s` = WP 里的框架值（含启动空档，仅参考）

### 6.2 汇总

| 组 | `wall_s` 中位数 | verified 分布 | 卡点性质 |
|---|---|---|---|
| A（有经验） | | | |
| B（无经验） | | | |

### 6.3 手法链（各组）

```

```

### 6.4 工具调用分布

| 组 | `aegis_pwn` | `aegis_shell` | REFUSED | 其它 |
|---|---|---|---|---|
| A | | | | |
| B | | | | |

### 6.5 编译产物（每组）

| 组 | cells（ON/OFF） | problems | habits | error |
|---|---|---|---|---|
| A | | | | |
| B | | | | |

**特别看：本轮成功链有没有进 ON**（RUN-001 的缺陷 2 是否复发）。

---

## 7. 判读（规则在 `EXPERIMENT.md` §9 已先写死）

- A 组 `wall_s` 中位数 **<** B 组，且两组都通 → **经验促进成立**
- 两组重叠（差异 < 组内离散度）→ **无证据**
- A 更慢 → 查"验证成本"假设，并比卡点性质
- **A 组激活 0 条 → 本轮无效**

### 结论（跑完填）

```

```

---

## 8. 已知会影响判读的因素（先记下，避免事后找理由）

1. **`t0` 计时未修** → 必须用 `wall_s`，不能用 `elapsed_s` 下结论。
   （RUN-001 实测虚高 38%，两组的空档长度还会不同。）
2. **远端原生 glibc 2.43，目标 2.27** → 换 libc 的耗时两组都要花，属共同成本。
3. **经验文件是"机制层条目"而非"解题过程"** → A 组拿到的是带条件的做法清单，
   不是一条可直接套用的链；这正是不给答案的代价，也是本实验想测的东西。
4. **A 组可能压根没读 `EXPERIENCE.md`** → 若某轮 A 很快，先确认 transcript 里
   真的读了这个文件、且真的引用了其中条目，否则那轮不算 A 组。
5. **题目本身可被平台识别**：`CTFshow` / URL / ASCII logo 已在二进制层面清除（§2），
   但 `Type : Heap_Exploitation` 与 `入门` 仍在（通用，不构成手法或平台泄漏）。
   若某轮异常快，仍要查它是否回忆出了这道 ctf.show 题的公开解。
6. **RUN-001 记录的编译缺陷（只产出 OFF、散文解析失败）未修** → 它们不再阻塞本实验
   （经验走独立文件），但会让 `finish` 后的编译继续丢正记忆，值得并行修。
