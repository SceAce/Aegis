# LCG 参数恢复与预测

- id: crypto-lcg-recover
- category: crypto
- curation: reviewed
- environment: any
- triggers: lcg
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/streamcipher/lcg/intro.md
- reviewed-by: human

## When
输出满足 x_{i+1} = (a*x_i + c) mod m；参数或高位/低位可能部分未知。

## Do
1. 先由连续差分的 gcd 恢复 m（或题目已给 m）。
2. 用三组连续值解线性方程求 a,c；模不互素时多取几组。
3. 输出被截断时，把已知位当作约束，枚举未知低位/高位。
4. 恢复后预测下一输出，并检查与已知序列一致。

## Expect
重放已知序列完全一致，预测值与下一组观测一致。

## Limits
模数未知且差分 gcd 不唯一时不要武断；截断位数决定枚举成本。
