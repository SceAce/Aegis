# CBC padding oracle

- id: crypto-aes-padding-oracle
- category: crypto
- status: verified
- environment: macos
- when: aes, cbc, padding_oracle
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/blockcipher/mode/cbc.md

## When
CBC + PKCS#7，且服务端对 padding 是否合法给出可区分信号（错误/状态/时间）。

## Do
1. 构造两块：前一块可控 IV/C，后一块是目标密文。
2. 从末字节开始翻转前块字节，枚举 0..255，找到使 padding 合法的值。
3. 逐字节恢复中间值，再与前一块异或得到明文；记录每次查询。
4. 控制请求量，避免把 oracle 探测写成高并发爆破。

## Expect
恢复出的明文重新加密/校验一致；padding 始终合法。

## Pitfalls
有 MAC/AEAD 时不可用；错误信号可能是统一状态码或时间差。
