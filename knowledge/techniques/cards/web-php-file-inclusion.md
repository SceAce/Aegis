# PHP 文件包含与包装器

- id: web-php-file-inclusion
- category: web
- curation: reviewed
- environment: any
- triggers: php, file_include
- evidence: document
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/web/php/php.md
- reviewed-by: human

## When
include/require 参数可控；可尝试读源码、日志或临时文件。

## Do
1. 用 php://filter/convert.base64-encode 读目标源码，确认包含点。
2. 尝试日志/会话/上传临时文件包含；路径用相对/绝对/截断变体。
3. data://、php://input、phar:// 视 allow_url_include 与配置。
4. 读出内容后检查是否是源码/配置/下一层线索。

## Expect
包含成功并返回可读源码/配置，而不是仅报错。

## Limits
allow_url_include 常关闭；phar 需要能上传并触发文件操作。
