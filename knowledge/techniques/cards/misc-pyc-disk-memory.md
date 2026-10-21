# pyc、磁盘镜像与内存取证

- id: misc-pyc-disk-memory
- category: misc
- curation: reviewed
- environment: any
- triggers: pyc
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/other/pyc.md
- evidence-ref: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/disk-memory/introduction.md
- reviewed-by: human

## When
给出 pyc/磁盘镜像/内存 dump，需要恢复源码或进程数据。

## Do
1. pyc：确认 magic 与 Python 版本，用对应 decompyle/uncompyle 或手工反汇编。
2. 磁盘：mmls/tsk_recover 找分区与删除文件；看文件系统日志。
3. 内存：volatility 先 imageinfo，再按插件找进程/网络/凭据/文件。
4. 恢复结果检查完整性与可读性。

## Expect
恢复出源码/文件/进程数据，且版本与镜像一致。

## Limits
pyc magic 不匹配时要换工具；内存镜像要先用正确 profile。
