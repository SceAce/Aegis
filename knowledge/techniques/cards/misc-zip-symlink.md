# ZIP 符号链接/zip slip 读取目标文件

- id: misc-zip-symlink
- category: web
- status: verified
- environment: macos
- when: http, zip, upload
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/misc/archive/zip.md

## When
上传的 zip 被服务端解压并读取包内文件；应用跟随符号链接或允许 ../ 路径。

## Do
1. 确认上传后服务端会解压并 cat/读取 zip 内条目（非 zip 上传的报错可暴露这一点）。
2. 构造 symlink 条目：external_attr=0o120777，内容为目标绝对路径（如 /proc/self/environ、/flag）。
3. 或用 zip slip 的 ../ 条目写到可读/可执行目录；不要覆盖关键系统文件。
4. 上传后请求读取条目，检查响应里的目标文件内容；失败时换目标路径或确认解压器是否保留 symlink。

## Expect
响应包含目标文件内容（如进程环境变量或 flag），而不是仅回显上传内容。

## Pitfalls
解压器可能禁用 symlink/路径穿越；目标路径需存在且可读；不要把 zip slip 写成破坏性写入。
