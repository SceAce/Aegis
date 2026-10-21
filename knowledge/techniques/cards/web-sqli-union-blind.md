# SQL 注入：联合查询与盲注

- id: web-sqli-union-blind
- category: web
- curation: reviewed
- environment: any
- triggers: http, sqli
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/web/sqli.md
- reviewed-by: human

## When
输入进入 SQL 且回显/报错/布尔/时间差异可控；参数可能是数字或字符串。

## Do
1. 先用单引号、注释、算术表达式确认注入点和数据库类型。
2. 联合查询：ORDER BY 或 UNION SELECT 探列数与回显位。
3. 无回显时用布尔/时间盲注逐字符取 information_schema/表/列/值。
4. 用十六进制或 CHAR() 绕过引号过滤；记录每个字符的判定条件。

## Expect
按同一 payload 稳定得到库名/表名/目标值，且与页面差异一致。

## Limits
WAF 会改写关键字；盲注速率要有上限，别把时间盲注写成爆破。
