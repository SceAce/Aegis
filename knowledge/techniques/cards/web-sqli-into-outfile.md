# SQLi 文件写入：INTO OUTFILE / load_file

- id: web-sqli-into-outfile
- category: web
- status: verified
- environment: macos
- when: http, sqli, file_privilege
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/web/sqli.md

## When
SQL 注入可用，且数据库用户有 FILE 权限、secure_file_priv 允许目标目录。

## Do
1. 先用 load_file('/etc/passwd') 或报错确认文件读权限；确认可写 Web 目录。
2. 用 UNION SELECT ... INTO OUTFILE '/path/x.php' 写入一个只执行固定查询的查询器（不要写破坏性内容）。
3. 如果引号被过滤，用 0x... 十六进制或 CHAR() 构造路径/内容。
4. 访问写入的文件读回结果，确认查询器可执行；记录文件路径与权限。

## Expect
目标路径出现新文件，访问后能返回 SQL 查询结果。

## Pitfalls
secure_file_priv 限制目录；FILE 权限可能没有；写入前确认目标目录可写且不会覆盖现有文件。
