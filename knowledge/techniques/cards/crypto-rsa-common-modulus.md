# RSA 共模攻击（同一 n，多组 e）

- id: crypto-rsa-common-modulus
- category: crypto
- status: verified
- environment: macos
- when: rsa, same_modulus
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/asymmetric/rsa/rsa_module_attack.md#共模攻击

## When
两组或多组密文使用同一个 n，但 e 不同（e1,e2 通常互素）；明文相同或相关。

## Do
1. 确认 n 相同且 gcd(e1,e2)=1；若 gcd>1，先约分或换一对。
2. 用扩展欧几里得求 a,b 使 a*e1+b*e2=1。
3. m = c1^a * c2^b mod n；负指数用模逆（pow(c,-1,n)）。
4. 把 m 转 bytes，检查可打印/结构（JSON、flag 格式、padding）。

## Expect
m 重新用 e1/e2 加密分别得到 c1/c2；明文结构合理。

## Pitfalls
gcd(e1,e2)!=1 时不能直接套；负指数必须先求逆；明文可能带 PKCS#1 填充。
