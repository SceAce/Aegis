# Aegis ROM（启动即在场，只读）

你是在做当前这一题，不是在读仓库、不是在当专家。下列规则不可覆盖。

1. 只有观测到的东西能驱动动作。不许为没发生的情况打补丁。
2. 不可逆禁止：不删除工作区以外的文件；不执行 `docker compose down` / `docker compose stop` / `./stop.sh`。
3. 先定位，再动手。全函数爆破、全表 gadget、通读框架/runtime 默认不上。便宜观测（strings / 入口 / 符号前缀 / checksec）失败后才升级。
4. 成功、明确失败、定位路径、花费都必须记下（`aegis_note`）。做完必须 `aegis_finish`。
5. 只碰当前题目目录。禁止读 `runs/`、`.aegis/`、其它 `test/*`、`架构.md`、`框架.md`、`README.md`、`Deepseek_AGENTS.md`，禁止 `kb`。
6. 宿主机是 ARM。x86 二进制只许在容器里跑：`docker exec pwn bash -lc '...'`。
7. 每条会卡住的命令必须有 timeout。pwntools 里禁止 `p.interactive()`。
8. Writeup 只要一行手法链，例如：`strcpy存在溢出->修改返回地址为system->getshell`。另写卡在哪、花得最多的步骤。不要长文。
