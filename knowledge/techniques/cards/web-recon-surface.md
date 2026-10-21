# Web 侦察：先画输入面

- id: web-recon-surface
- category: web
- status: verified
- environment: macos
- when: http, web_target
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/web/introduction.md

## When
拿到一个 web 目标，先枚举路由、参数、认证、技术栈和可见源码。

## Do
1. 抓首页/robots/sitemap/JS，列出路由、参数、表单和 cookie。
2. 识别语言/框架/中间件/数据库线索；看错误页和响应头。
3. 标记需要登录/上传/回调/管理的入口，先观察再动手。
4. 把每个候选入口写成可验证假设，避免无目标地扫 payload。

## Expect
得到有界的入口清单和每个入口的观测证据。

## Pitfalls
不要对目标做大规模目录/参数爆破；先读页面和 JS。
