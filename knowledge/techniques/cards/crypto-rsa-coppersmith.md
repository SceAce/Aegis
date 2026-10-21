# RSA Coppersmith：已知高位/小根

- id: crypto-rsa-coppersmith
- category: crypto
- curation: reviewed
- environment: any
- triggers: rsa, partial_plaintext
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/asymmetric/rsa/rsa_coppersmith_attack.md
- reviewed-by: human

## When
已知明文高位、相关消息、p 的高位，或可写成模 N/模 p 的小根多项式。

## Do
1. 把已知信息写成首一多项式 f(x)=0 (mod N 或 mod p)，未知量为小根。
2. 按界选择格：小根 |x| < N^(1/e)（或 p 的对应界），构造 Coppersmith 格。
3. LLL/格约化后取短向量恢复根；Sage 的 small_roots 可直接做。
4. 把根代回原式验证，并检查明文结构。

## Expect
根满足多项式且解密结果结构合理；对 p 高位场景能分解 N。

## Limits
界不满足时不会成立；多项式必须首一；纯 Python 做大格很慢。
