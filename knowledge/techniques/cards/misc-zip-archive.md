# 压缩包：伪加密、已知明文与嵌套

- id: misc-zip-archive
- category: misc
- status: verified
- environment: macos
- when: archive, zip
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/archive/zip.md

## When
zip/rar 需要密码，或提示里有明文片段/CRC/目录异常。

## Do
1. 先看 zipinfo/7z l 的加密标志与压缩方法；伪加密可改标志位。
2. 已知明文（图片头、固定文件）用 bkcrack 做明文攻击。
3. 检查注释、额外字段、嵌套压缩包和 CRC 不匹配。
4. 解出后验证文件类型与内容。

## Expect
解压得到可读文件/下一层线索，CRC 与内容一致。

## Pitfalls
AES zip 不能用传统明文攻击；伪加密改错会损坏结构。
