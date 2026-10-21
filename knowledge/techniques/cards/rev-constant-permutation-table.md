# 常量表 / 置换表反推

- id: rev-constant-permutation-table
- category: reverse
- status: verified
- environment: macos
- when: binary, constant_table
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/introduction.md

## When
二进制里有连续的 0..n-1 小组（置换）、S-box 或常量数组，可能编码了字节/索引。

## Do
1. 在 __const/.rodata/__TEXT 中找连续且每 n 个一组、元素恰为 0..n-1 的序列。
2. 对每组计算字典序/Lehmer 排名得到索引；索引可能取模或加常数映射到字节。
3. 用可打印字符/常见 flag 格式过滤候选。
4. 把候选重新编码回置换表，确认与原表一致。

## Expect
候选字节重编码后与原常量表逐项一致，且文本可读。

## Pitfalls
表可能有头部/对齐填充；先确认分组起点再排名。
