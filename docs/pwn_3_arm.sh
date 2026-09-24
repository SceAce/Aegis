#!/usr/bin/env bash
# pwn_3_arm.sh A|B —— 布置经验实验的其中一组，并打印启动命令。
#
# 设计：两组的**提示词完全相同**（TASK.md 里写的是"如果 EXPERIENCE.md 存在就读它"），
# 唯一的差别是那个文件在不在。同时两组都带 AEGIS_NO_MEMORY=1，让项目自己的
# 经验列（atlas 稀疏激活）退出，避免它和文件里的经验混在一起分不清来源。
#
#   A 组 = 有经验：文件就位
#   B 组 = 无经验：文件移走
#
# ROM、TOOLS、guard 规则、MEMORY.md —— 两组完全一致。
#
# 注意：本脚本住在 docs/（agent 读不到）。它由**人**在自己的 shell 里跑。

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MODE="${1:-}"
EXP="manual/pwn_3/EXPERIENCE.md"
STASH="/tmp/aegis_pwn_3_EXPERIENCE.md"
UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uvcache}"
export UV_CACHE_DIR

case "$MODE" in
  A)
    if [ -f "$STASH" ]; then mv "$STASH" "$EXP"; fi
    [ -f "$EXP" ] || { echo "缺少 $EXP" >&2; exit 1; }
    echo "A 组（有经验）：EXPERIENCE.md 已就位"
    ;;
  B)
    if [ -f "$EXP" ]; then mv "$EXP" "$STASH"; fi
    [ -f "$EXP" ] && { echo "无法移走 $EXP" >&2; exit 1; }
    echo "B 组（无经验）：EXPERIENCE.md 已移走"
    ;;
  *)
    echo "用法: $0 A|B" >&2
    exit 2
    ;;
esac

# 必须走远端。容器是 QEMU 模拟，慢 5-10 倍、缺工具（没有 one_gadget / ropper /
# radare2），而且 glibc 版本不同 —— 换过去等于换掉整个实验世界。
#
# 不能只靠给 start 传 AEGIS_CHANNEL=remote：pick() 在首选通道不可用时**会静默回退**，
# 于是 start 把题目推到容器，而启动命令又强制 remote 跑 —— 两边通道不一致，
# 远端根本没有题目文件。唯一的办法是在这里显式检查，让它硬失败。
if ! uv run aegis env --probe 2>/dev/null | grep -q 'OK remote'; then
  echo "远端不可达 —— 不要开跑。" >&2
  echo "容器是另一个世界（QEMU + 不同 glibc），换过去这一轮数据就废了。" >&2
  echo >&2
  uv run aegis env --probe 2>&1 | sed -n '1,6p' >&2
  exit 1
fi
export AEGIS_CHANNEL=remote

# 重新起表：elapsed 从这里算，所以打印完立刻启动 agent，别停。
uv run aegis start pwn_3

echo
echo "--- 本次自变量快照（务必留证）---"
echo "EXPERIENCE.md 存在: $([ -f "$EXP" ] && echo YES || echo NO)"
echo "题目二进制: $(shasum -a 256 test/pwn_3/pwn | cut -c1-16)…"
echo "项目经验列: 已用 --no-experience 关闭（两组相同）"
echo
echo "--- 启动（下面这条原样执行）---"
cat <<'CMD'
AEGIS_NO_MEMORY=1 AEGIS_CHANNEL=remote AEGIS_CHALLENGE=pwn_3 \
  /Users/scemac/My_github/pi/pi-test.sh --approve \
  --provider deepseek --model deepseek-flash \
  "读 manual/pwn_3/TASK.md 并照做。"
CMD
