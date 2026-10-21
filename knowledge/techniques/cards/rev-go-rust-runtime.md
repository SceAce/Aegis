# Go / Rust 二进制逆向

- id: rev-go-rust-runtime
- category: reverse
- status: verified
- environment: macos
- when: binary, go_binary
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/language/go/introduction.md
- source: https://github.com/ctf-wiki/ctf-wiki/blob/e225ddfcd420a7f54a5940f47336ebdf8c29b875/docs/zh/docs/reverse/language/rust/introduction.md

## When
二进制含 Go/Rust 运行时特征（gopclntab、panic 字符串、mangled symbols）。

## Do
1. Go：用 go tool nm/objdump 或 GoReSym 恢复符号；strings 找 main.* 与错误信息。
2. Rust：找 panic/格式化字符串和 mangled 符号；关注 main 与自定义 crate 名。
3. 从字符串/符号定位输入解析、比较和加密函数。
4. 动态断点验证关键分支。

## Expect
定位到输入处理和判定函数，并解释成功条件。

## Pitfalls
strip 后符号可能只剩 pclntab；Rust 泛型会生成大量重复代码。
