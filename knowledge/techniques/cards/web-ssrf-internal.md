# SSRF：让服务端访问内部资源

- id: web-ssrf-internal
- category: web
- status: verified
- environment: macos
- when: http, ssrf
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/web/ssrf.md

## When
URL/图片/回调参数由服务端发起请求；可指定 host、端口、scheme。

## Do
1. 先确认请求由服务端发出（DNS/HTTP 回调或时间差异）。
2. 测 localhost/内网段/云元数据地址；试 file://、gopher://、dict://。
3. 绕过 allowlist：十进制/八进制 IP、短域名、DNS rebinding、重定向。
4. 用返回内容或带外通道确认读到的内部响应。

## Expect
拿到只在内网可达的响应/元数据，或用带外请求证明服务端访问。

## Pitfalls
云元数据可能要求特定 header；gopher 能构造多协议请求但要按目标协议编码。
