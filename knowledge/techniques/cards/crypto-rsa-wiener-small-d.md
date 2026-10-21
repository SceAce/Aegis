# RSA 小私钥 d 与连分数

- id: crypto-rsa-wiener-small-d
- category: crypto
- status: verified
- environment: macos
- when: rsa, small_d
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/asymmetric/rsa/d_attacks/rsa_d_attack.md
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/asymmetric/rsa/d_attacks/rsa_extending_wiener.md

## When
d 明显偏小（约 < N^(1/4)），或 e/N 的连分数收敛中出现可疑的 k/d。

## Do
1. 对 e/N 做连分数展开，枚举收敛 k/d。
2. 对每个候选用 phi=(e*d-1)/k 求整数 phi，检查是否为偶数。
3. 由 phi 和 N 解 p+q、p*q 分解 N；解出 p,q 后解密。
4. d 稍大时用 extended Wiener（多组 e_i 或已知部分位）。

## Expect
p*q=N，phi 与 d 自洽，解密明文可读。

## Pitfalls
k=0 或 phi 非整数要跳过；d 超过界时连分数不够。
