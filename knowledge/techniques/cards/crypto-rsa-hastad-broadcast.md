# RSA 广播攻击（同明文，多模数，小 e）

- id: crypto-rsa-hastad-broadcast
- category: crypto
- status: verified
- environment: macos
- when: rsa, same_message, small_e
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/asymmetric/rsa/rsa_e_attack.md#低加密指数广播攻击

## When
同一明文用不同 n_i、同一小 e 加密给多个接收方。

## Do
1. 确认各组 e 相同、n_i 两两互素。
2. 对 c_i 做 CRT 得到 C = m^e mod prod(n_i)。
3. 若 prod(n_i) > m^e，直接整数开 e 次根得到 m。
4. 若已知线性 padding，用 Coppersmith 求小根而不是硬开根。

## Expect
开根结果的 e 次方等于 CRT 合并值；明文结构合理。

## Pitfalls
n_i 不互素时先 gcd 分解；e 大于接收方数量时普通 CRT 不够。
