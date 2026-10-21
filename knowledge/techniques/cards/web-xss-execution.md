# XSS：上下文相关的执行

- id: web-xss-execution
- category: web
- status: verified
- environment: macos
- when: http, xss
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/web/xss.md

## When
用户输入回显到 HTML/属性/JS/URL；可能有 CSP、HttpOnly、存储型入口。

## Do
1. 先判断上下文：HTML 文本、属性值、script 字符串、URL。
2. 按上下文闭合标签/引号，避免被转义；先弹窗/写 DOM 验证执行。
3. 检查 CSP 与 cookie 标志；存储型要确认持久化和触发页面。
4. 用浏览器或 headless 实际执行验证，而不是只看源码。

## Expect
在真实渲染环境中执行到目标 JS（弹窗/请求回调），且不是仅字符串反射。

## Pitfalls
CSP 会阻止 inline；HttpOnly 下改打 CSRF/账户操作而不是偷 cookie。
