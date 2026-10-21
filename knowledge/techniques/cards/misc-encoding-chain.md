# 编码链识别与逐层解码

- id: misc-encoding-chain
- category: misc
- curation: reviewed
- environment: any
- triggers: text, encoding
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/encode/computer.md
- evidence-ref: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/encode/communication.md
- reviewed-by: human

## When
文本由 base64/hex/url/morse/进制/压缩等一层或多层编码叠加。

## Do
1. 先看字符集和长度特征判断编码类型；用 file/魔数确认是否压缩/图片。
2. 逐层解码并保留每层输入输出，避免一次性猜错。
3. 出现乱码时试另一种编码/字符集；URL 编码注意二次编码。
4. 最终检查 flag 格式或文件类型。

## Expect
逐层可逆，最终得到可读文本/合法文件。

## Limits
base64 可能缺 padding；十六进制大小写混用。
