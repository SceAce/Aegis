# AES 模式误用（ECB / CBC）

- id: crypto-aes-mode-misuse
- category: crypto
- curation: reviewed
- environment: any
- triggers: aes, ecb
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/blockcipher/aes.md
- evidence-ref: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/crypto/blockcipher/mode/cbc.md
- reviewed-by: human

## When
ECB 出现重复块；CBC 有可控 IV/明文且无认证；或存在 padding oracle。

## Do
1. ECB：找相同密文块，重排/拼接块，观察明文结构或权限字段。
2. CBC 位翻转：改 C_{i-1} 的字节，精确翻转 P_i 的对应字节（保留后续块损坏）。
3. CBC IV 可控时翻转首块；有 padding oracle 时按字节恢复明文。
4. 每次改动后只提交一次，记录服务端响应差异。

## Expect
目标字段按预期改变（如 role=admin），且 MAC/认证未被触发。

## Limits
有 AEAD/MAC 时位翻转会失败；padding oracle 探测要控制请求量。
