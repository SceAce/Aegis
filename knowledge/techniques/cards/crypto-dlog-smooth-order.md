# 离散对数：小/光滑阶

- id: crypto-dlog-smooth-order
- category: crypto
- curation: reviewed
- environment: any
- triggers: dlog, smooth_order
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/asymmetric/discrete-log/discrete-log.md
- reviewed-by: human

## When
g^x=h 的群阶光滑或很小；可分解为小素数幂。

## Do
1. 分解群阶；对每个小因子用 BSGS/Pohlig-Hellman 求 x mod p_i^k。
2. CRT 合并各余数得到 x；验证 g^x=h。
3. 阶未知时先从 g 的幂/因子推断。

## Expect
g^x 等于 h；x 在合理范围内。

## Limits
大素数因子无法分解时方法不成立；注意群是模 p 还是椭圆曲线。
