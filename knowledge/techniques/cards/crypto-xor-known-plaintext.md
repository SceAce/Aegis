# 重复密钥 XOR 与已知明文

- id: crypto-xor-known-plaintext
- category: crypto
- curation: reviewed
- environment: any
- triggers: xor, repeating_key
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/attack-summary/bit-attack.md
- reviewed-by: human

## When
密文由明文与短密钥循环异或；明文是自然语言、JSON、文件头或已知格式。

## Do
1. 用已知明文/文件头 crib 推密钥片段；滑动 crib 找最长匹配。
2. 用汉明距离或重合指数估计密钥长度，再按列做单字节频率分析。
3. 恢复候选密钥后解密，检查可打印率、词频和格式。
4. 把结果与文件魔数/JSON 结构交叉验证。

## Expect
解密文本可读且 crib 位置一致；再加密回原密文。

## Limits
密钥长度估计会误判；短文本频率分析不可靠，优先用 crib。
