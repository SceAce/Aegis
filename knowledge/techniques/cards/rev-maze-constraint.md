# 迷宫/约束类逆向

- id: rev-maze-constraint
- category: reverse
- status: verified
- environment: macos
- when: binary, maze, constraint
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/maze/maze.md

## When
程序走格子/状态机，输入决定移动；成功路径由地图或约束决定。

## Do
1. 从数据段/初始化代码提取地图、转移和墙。
2. BFS/DFS 搜索可行路径；把输入字符映射到方向。
3. 复杂校验用 angr/z3 做符号执行，约束到目标状态。
4. 用真实输入跑程序验证到达终点。

## Expect
输入使程序到达成功状态/输出 flag。

## Pitfalls
地图可能动态生成；符号执行要注意路径爆炸。
