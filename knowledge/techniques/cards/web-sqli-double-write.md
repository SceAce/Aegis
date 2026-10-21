# SQLi 关键词过滤：重叠双写绕过

- id: web-sqli-double-write
- category: web
- status: verified
- environment: macos
- when: http, sqli, keyword_filter
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/web/sqli.md

## When
输入进入 SQL，但 WAF/过滤器把 or、and、union、select、from、where、information_schema 等关键词**单次全局删除或替换一次**。

## Do
1. 逐个确认哪些关键词被删/替换，以及是否只处理一次（单次全局替换，不递归）。
2. 把关键词写成重叠形式，让删除后仍留下原词：union→uniunionon，select→seselectlect，from→frfromom，information_schema→infoorrmation_schema。
3. 注意 where→wwherehere（两个 where 重叠），不能写 wherewhere（两个都会被删）。
4. 先用布尔/错误差异确认 payload 生效，再用 UNION 探列数与回显位。

## Expect
过滤后的字符串仍包含原关键词；同一 payload 的布尔/错误响应稳定。

## Pitfalls
不同过滤器的替换次数/顺序不同；先小步验证，不要一次批量试几十个变体。
