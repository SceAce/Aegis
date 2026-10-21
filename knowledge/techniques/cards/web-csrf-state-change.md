# CSRF：利用已认证会话

- id: web-csrf-state-change
- category: web
- curation: reviewed
- environment: any
- triggers: http, csrf
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/web/csrf.md
- reviewed-by: human

## When
状态变更请求只靠 cookie 认证，缺少 CSRF token 或 SameSite 防护。

## Do
1. 找状态变更端点（改密、加管理员、转账），确认参数可预测。
2. 检查 token/Referer/Origin/SameSite 校验；尝试去掉 token 或复用。
3. 构造跨站表单/请求，在已登录会话中触发。
4. 从服务端状态变化确认效果（而不是只看响应码）。

## Expect
服务端状态真的改变；重复触发不会产生未预期副作用。

## Limits
SameSite=Lax 会拦跨站 POST；JSON 端点可能需要 text/plain 或 form 编码。
