# PHP 常见陷阱：类型混淆与反序列化

- id: web-php-type-juggle
- category: web
- status: verified
- environment: macos
- when: php, type_juggle
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/web/php/php.md

## When
源码可见或可推断；出现 == 比较、preg_replace /e、unserialize、文件包含/包装器。

## Do
1. 找松散比较（0e、数组、null）和 hash 比较，构造满足条件的输入。
2. unserialize：找 POP 链（__destruct/__wakeup/__toString），控制属性触发危险调用。
3. 文件包含：用 php://filter 读源码，或日志/临时文件包含。
4. 包装器：data://、php://input、phar:// 视配置而定。

## Expect
用最小输入触发目标分支（读源码/写文件/绕过比较），并有可重复的响应。

## Pitfalls
PHP 8 收紧了部分比较和 /e；phar 需要能上传文件并触发文件操作。
