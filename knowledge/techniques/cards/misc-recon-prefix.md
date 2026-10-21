# 未知文件：前缀与嵌套

- id: misc-recon-prefix
- category: misc
- curation: reviewed
- environment: any
- triggers: misc, unknown_file
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/recon.md
- evidence-ref: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/prefix.md
- reviewed-by: human

## When
附件类型不明（unknown file type），或文件头/magic bytes 被改、嵌套多层 archive/压缩。

## Do
1. file/xxd 看 magic bytes 与结构；binwalk/foremost 做 carve，找嵌套 archive。
2. 比对真实文件头，修复/拼接；检查尾部附加数据。
3. 逐层解包/解码，保留每层输入输出。
4. 验证最终文件可打开/文本可读。

## Expect
恢复出合法文件/可读文本，并解释前缀修复点。

## Limits
不要一次改多个字节；保留原始副本。
