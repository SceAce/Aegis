# 二进制静态分诊（先看全局）

- id: rev-static-triage
- category: reverse
- curation: reviewed
- environment: any
- triggers: binary, unfamiliar
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/introduction.md
- reviewed-by: human

## When
拿到未知二进制/固件片段；先判断格式、架构、语言、保护、入口和输入面。

## Do
1. file/checksec，确认 ELF/Mach-O/PE、架构、位数、保护。
2. strings 找提示、flag 格式、错误信息、库/语言特征；readelf/otool 看段与导入。
3. 定位 main/输入读取/比较逻辑；先画数据流，不急着逐指令读。
4. 判断是否加壳/混淆/自修改，再决定动态或符号执行。

## Expect
能说明输入从哪进、在哪比较、成功路径大致在哪。

## Limits
strings 可能被混淆；静态结论要用动态断点验证。
