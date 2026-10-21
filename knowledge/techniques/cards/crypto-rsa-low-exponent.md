# RSA 低加密指数（m^e < n）

- id: crypto-rsa-low-exponent
- category: crypto
- status: verified
- environment: macos
- when: rsa, small_e
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/asymmetric/rsa/rsa_e_attack.md#低加密指数攻击

## When
e 很小（常见 3），且明文短、没有填充，c = m^e 未发生模回绕。

## Do
1. 先算 c 的整数 e 次根；能开尽就直接得 m。
2. 开不尽则试 m = iroot(c + k*n, e)，k 从小范围枚举。
3. 多接收方/多密文时先 CRT 合并再开根（Håstad）。
4. 把 m 转 bytes 并检查结构；若带固定 padding，改用 Coppersmith。

## Expect
m^e == c（或 CRT 合并后的值）；明文可解析。

## Pitfalls
有 padding 时不能直接开根；k 的枚举要有上限，否则是盲目爆破。
